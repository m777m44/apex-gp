/**
 * APEX GP — physically based atmosphere, clouds and time of day.
 *
 * WHAT THIS IS
 *   A real single-scattering atmospheric model (Rayleigh + Mie + ozone,
 *   Bruneton/Hillaire coefficients) raymarched through a spherical shell, plus
 *   a raymarched cumulus layer lit through that same atmosphere. Not Preetham:
 *   Preetham has no ozone term, so it cannot produce the deep blue twilight
 *   band, and it goes black the moment the sun drops below the horizon.
 *
 *   The identical model is also implemented in JavaScript at the bottom of this
 *   file (`sampleSkyRadiance`). That is what feeds the key-light colour, the
 *   hemisphere fill, the aerial-perspective uniforms and the EV100 exposure —
 *   so the lighting is derived from the sky the camera actually sees rather
 *   than from a hand-tuned lookup.
 *
 * AERIAL PERSPECTIVE
 *   `installAerialPerspective()` (called once at module load) replaces three's
 *   fog chunks with a height-falloff, view-direction-dependent in-scattering
 *   model. Its uniforms are injected into `THREE.ShaderLib` as Float32Arrays,
 *   which `UniformsUtils.clone` copies BY REFERENCE — so every lit material in
 *   the scene shares one set of live uniforms and nothing else has to know.
 *
 * CONVENTIONS
 *   `sunDirection` is a UNIT vector pointing FROM the origin TOWARD the sun.
 *   +Y is up. Azimuth 0 = +Z ("north"), increasing toward +X ("east").
 *   Radiance is scene-referred linear and ABSOLUTE — the numbers this file
 *   emits are the numbers the exposure meter and the bloom threshold reason
 *   about, so they have to be internally consistent. Measured in `chase` at
 *   15:20: zenith 0.31, mid-sky 0.41, cloud base ~0.20, brightest sunlit cloud
 *   1.35 (a 3.3:1 cloud-to-sky ratio — a photograph shows about 3:1), sun disc
 *   ~20. Output is SOFT-clamped toward `uMaxRadiance` (x/(1+x/M)) rather than
 *   hard-clipped, so the disc keeps a gradient and the PMREM integrator never
 *   eats a spike, and the cloud source term has its OWN self-calibrating ceiling
 *   at `uCloudContrast` x the brightest sky probe.
 *
 * CLOUDS — two layers.
 *   CUMULUS at 1.75 km, raymarched. Weather map (two 20-60 km octaves -> local
 *   coverage and cloud type) -> coverage-thresholded base fbm -> cumulus height
 *   profile (hard flat base, widest low, eroded crown) -> billow + fine erosion.
 *   Every threshold is a LINEAR remap, never a smoothstep: a smoothstep flattens
 *   the noise gradient into a plateau with a narrow transition, which is
 *   precisely a cut-out edge. Lighting is a three-octave multiple-scattering
 *   series (successively dimmer, less attenuated, more isotropic) plus a
 *   six-step shadow march toward the sun, a Beer-Powder dark edge in
 *   BACKSCATTER only, and a height-dependent sky-view ambient with a ground
 *   bounce into the base — that asymmetry is the bright-top / dark-flat-base
 *   signature.
 *
 *   THE STEP LENGTH IS THE WHOLE BALLGAME, and it is TWO numbers, not one.
 *   The INTEGRATION stride must stay below the vertical noise wavelength of the
 *   slab, and that number does not grow with distance, so no growth law can be
 *   right: it is pinned to CLOUD_DS_FRAC (~1/19) of the layer thickness with only
 *   a gentle projected-footprint LOD. (An earlier geometric march, 36 steps at
 *   x1.12, reached 700 m inside a 1500 m layer and produced exactly the six-to-
 *   eight horizontal pancake slabs the art review measured.)
 *   The EMPTY-SPACE SKIP stride is a different quantity, and treating it as the
 *   same one is what made this shader cost 18.9 ms at 1080p against a 16.7 ms
 *   frame: a 6-degree ray — every pixel of an establishing shot — was crossing
 *   tens of kilometres of sub-threshold deck in 77 m probes and spending its
 *   whole 128-step budget before it reached anything. What bounds the SKIP is
 *   the horizontal cell size, so it scales with 1/|rd.y| up to CLOUD_SKIP_MAX.
 *   The per-pixel interleaved-gradient offset then has to span the SKIP stride,
 *   not the integration stride, or the depth at which each ray starts shading
 *   quantises and the contours of that integer read as onion rings inside the
 *   cumulus. Measured after: 0.7-1.5 ms at 1080p in the sky-heaviest shots.
 *
 *   CIRRUS at 8.6 km and CIRROSTRATUS at 12.4 km, each a single analytic slab
 *   sample (six noise lookups). THREE altitudes in frame is most of what makes a
 *   sky read as deep rather than as one painted band: each layer converges
 *   toward the horizon on its own schedule, so they slide across each other, and
 *   the higher the ice the finer and thinner it is drawn (the upper tier runs
 *   1.5x the spatial frequency, 0.62x the opacity and a faster jet stream).
 *
 *   THE HORIZON HAS TO GO MILKY, and there are two independent halves of that.
 *   The AIR half is `uHazeMulti`, an achromatic aerosol multiple-scattering term
 *   carried by the Mie column so it is ~30x stronger along the skyline than at
 *   the zenith with no elevation ramp anywhere. The CLOUD half is the Beer fade
 *   in main() that takes the deck toward the horizon probe with distance. Both
 *   were far too weak and the frame paid for it twice: a fully saturated blue
 *   running straight down into the landscape, and a row of full-contrast white
 *   cumulus stamped across it. Neither may be replaced by a hand-tuned gradient
 *   — everything downstream (fog colour, cloud ambient, exposure meter) reads
 *   the same probes through sampleSkyRadiance().
 */

import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Atmosphere constants (shared by the GLSL and JS implementations)
// ---------------------------------------------------------------------------
const R_GROUND = 6360e3;
const R_TOP = 6420e3;
const BETA_R = [5.802e-6, 13.558e-6, 33.1e-6];   // Rayleigh scattering, per metre
// Mie scattering / extinction, with the same mild Angstrom slope as the GLSL.
const BETA_M_S = [3.996e-6 * 0.93, 3.996e-6, 3.996e-6 * 1.09];
const BETA_M_E = [4.44e-6 * 0.93, 4.44e-6, 4.44e-6 * 1.09];
const BETA_O = [0.650e-6, 1.881e-6, 0.085e-6];    // ozone absorption
const H_RAYLEIGH = 8000;
const H_MIE = 1200;

// ---------------------------------------------------------------------------
// GLSL
// ---------------------------------------------------------------------------

const ATMOSPHERE_GLSL = /* glsl */ `
const float PI = 3.141592653589793;
const float R_GROUND = 6360000.0;
const float R_TOP    = 6420000.0;
const vec3  BETA_R   = vec3( 5.802e-6, 13.558e-6, 33.1e-6 );
// Mie (aerosol). Continental dust has an Angstrom exponent near 1, so its
// extinction is mildly wavelength dependent and a long horizon path loses more
// blue than red. A perfectly grey Mie coefficient is what left the horizon a
// colourless wash under a washed-out zenith; the slope puts a warm band under a
// deep blue sky, which is what a summer afternoon actually does.
const vec3  BETA_M_S = 3.996e-6 * vec3( 0.93, 1.00, 1.09 );
const vec3  BETA_M_E = 4.44e-6  * vec3( 0.93, 1.00, 1.09 );
const vec3  BETA_O   = vec3( 0.650e-6, 1.881e-6, 0.085e-6 );
const float H_RAYLEIGH = 8000.0;
const float H_MIE      = 1200.0;

// Densities of the three absorbing/scattering species at altitude h.
// Ozone is a tent centred on 25 km, which is what produces the blue twilight.
// AEROSOL LOADING. The Mie term is scaled by turbidity, normalised so the
// 2.4 reference (clean mid-afternoon air) is exactly 1.0 — this file used to
// compute turbidity per time of day and then never send it to the shader, so
// the air was permanently clean and a low sun had no haze to light. With it
// wired up, dawn/dusk carry 1.7-1.9x the aerosol and the Mie forward lobe
// finally produces a real warm band around a low sun instead of a grey wash.
vec3 speciesDensity( float h ) {
  return vec3(
    exp( -h / H_RAYLEIGH ),
    exp( -h / H_MIE ) * uTurbidity * ( 1.0 / 2.4 ),
    max( 0.0, 1.0 - abs( h - 25000.0 ) / 15000.0 )
  );
}

vec3 extinction( vec3 od ) {
  return exp( -( BETA_R * od.x + BETA_M_E * od.y + BETA_O * od.z ) );
}

/** Far intersection of a ray with a sphere centred on the origin, or -1. */
float raySphereFar( vec3 o, vec3 d, float r ) {
  float b = dot( o, d );
  float c = dot( o, o ) - r * r;
  float disc = b * b - c;
  if ( disc < 0.0 ) return -1.0;
  return -b + sqrt( disc );
}

/** Near intersection, or -1 when the sphere is behind or missed. */
float raySphereNear( vec3 o, vec3 d, float r ) {
  float b = dot( o, d );
  float c = dot( o, o ) - r * r;
  float disc = b * b - c;
  if ( disc < 0.0 ) return -1.0;
  float t = -b - sqrt( disc );
  return t;
}

float rayleighPhase( float mu ) { return ( 3.0 / ( 16.0 * PI ) ) * ( 1.0 + mu * mu ); }

float hgPhase( float mu, float g ) {
  float g2 = g * g;
  return ( 1.0 / ( 4.0 * PI ) ) * ( 1.0 - g2 ) / pow( max( 1.0 + g2 - 2.0 * g * mu, 1e-4 ), 1.5 );
}

/** Transmittance from p to the top of the atmosphere along dir. */
vec3 sunTransmittance( vec3 p, vec3 dir ) {
  // Shadowed by the planet itself.
  if ( raySphereNear( p, dir, R_GROUND ) > 0.0 ) return vec3( 0.0 );
  float t = raySphereFar( p, dir, R_TOP );
  if ( t <= 0.0 ) return vec3( 1.0 );
  float ds = t / float( ATMO_LIGHT_STEPS );
  vec3 od = vec3( 0.0 );
  for ( int i = 0; i < ATMO_LIGHT_STEPS; i ++ ) {
    vec3 q = p + dir * ( ( float( i ) + 0.5 ) * ds );
    od += speciesDensity( length( q ) - R_GROUND ) * ds;
  }
  return extinction( od );
}

/**
 * Sky radiance looking along rd from ro (both in planet-centred metres).
 * outTransmittance is the extinction between the viewer and the far end of
 * the ray, which the cloud layer and aerial perspective reuse.
 */
vec3 atmosphereRadiance( vec3 ro, vec3 rd, vec3 sun, float tMaxLimit, out vec3 outTransmittance ) {
  float tMax = raySphereFar( ro, rd, R_TOP );
  float tGround = raySphereNear( ro, rd, R_GROUND );
  bool hitGround = tGround > 0.0;
  if ( hitGround ) tMax = min( tMax, tGround );
  tMax = min( tMax, tMaxLimit );

  float mu = dot( rd, sun );
  float pr = rayleighPhase( mu );
  float pm = hgPhase( mu, uMieG );

  vec3 sumR = vec3( 0.0 );
  vec3 sumM = vec3( 0.0 );
  vec3 od = vec3( 0.0 );
  vec3 tr = vec3( 1.0 );

  // Quadratic step distribution: the dense lower atmosphere gets the samples.
  float prev = 0.0;
  for ( int i = 0; i < ATMO_STEPS; i ++ ) {
    float f1 = float( i + 1 ) / float( ATMO_STEPS );
    float t1 = tMax * f1 * f1;
    float seg = t1 - prev;
    vec3 p = ro + rd * ( prev + seg * 0.5 );
    prev = t1;

    vec3 d = speciesDensity( length( p ) - R_GROUND ) * seg;
    od += d;
    tr = extinction( od );
    vec3 ts = sunTransmittance( p, sun );
    sumR += d.x * tr * ts;
    sumM += d.y * tr * ts;
  }

  outTransmittance = tr;

  vec3 single = ( sumR * BETA_R * pr + sumM * BETA_M_S * pm );
  // Cheap multiple-scattering: re-emit part of the single-scattered energy
  // isotropically. Without it the sky reads far too dark and oversaturated.
  // The Mie share of this is spectrally flat, i.e. GREY, and it is concentrated
  // in the bottom kilometre of air — so it lands almost entirely on the horizon
  // band and desaturates it. Weighting it down keeps the isotropic fill that
  // stops the sky reading black without bleaching the blue out of it.
  vec3 multi = ( sumR * BETA_R + sumM * BETA_M_S * 0.5 ) * ( uMultiScatter / ( 4.0 * PI ) );

  // THE MILKY HORIZON BAND — a SPECTRALLY FLAT aerosol multiple-scattering term.
  //
  // Down-weighting the coloured Mie share above (x0.5) is what stopped the
  // horizon bleaching to a grey wash, but taken alone it also deleted the pale
  // band a real summer afternoon has between the blue and the skyline: the sky
  // then runs full-saturation cyan straight down into the landscape and the
  // frame loses its depth cue. The two are not the same quantity. What has to
  // come back is achromatic, and it has to be confined to LOW ELEVATIONS.
  //
  // Both fall out of using the MIE column, sumM, as the carrier and a single
  // grey coefficient as the cross-section. Aerosol sits in the bottom kilometre
  // (H_MIE = 1200 m), so a zenith ray integrates about 1.2 km of it and a ray
  // at the horizon integrates two hundred: the term is ~30x stronger along the
  // skyline than overhead and has faded out by 25 degrees of elevation on its
  // own, with no elevation ramp anywhere in the expression. And because sumM
  // carries the per-channel transmittance already accumulated along that path,
  // the band warms with distance exactly the way haze does instead of being a
  // flat white lift.
  //
  // This is the ONLY place the band is generated. Everything downstream — the
  // horizon probe, the aerial-perspective in-scatter colour, the ambient
  // reference the cloud deck fades into — reads it from the same model through
  // sampleSkyRadiance(), so there is no second, hand-tuned haze to drift out of
  // sync with this one.
  multi += sumM * ( BETA_M_S.g * uHazeMulti / ( 4.0 * PI ) );

  vec3 L = ( single + multi ) * uSunIrradiance;

  if ( hitGround ) {
    // Sunlit ground bounce so the lower hemisphere of the IBL is not black.
    vec3 g = ro + rd * tMax;
    vec3 n = normalize( g );
    vec3 gs = sunTransmittance( g, sun );
    L += tr * uGroundColour * uSunIrradiance * ( max( 0.0, dot( n, sun ) ) * gs + vec3( 0.05 ) ) / PI;
  }
  return L;
}
`;

const NOISE_GLSL = /* glsl */ `
float hash13( vec3 p ) {
  p = fract( p * 0.1031 );
  p += dot( p, p.zyx + 31.32 );
  return fract( ( p.x + p.y ) * p.z );
}

float vnoise3( vec3 x ) {
  vec3 i = floor( x );
  vec3 f = fract( x );
  f = f * f * ( 3.0 - 2.0 * f );
  float n000 = hash13( i );
  float n100 = hash13( i + vec3( 1.0, 0.0, 0.0 ) );
  float n010 = hash13( i + vec3( 0.0, 1.0, 0.0 ) );
  float n110 = hash13( i + vec3( 1.0, 1.0, 0.0 ) );
  float n001 = hash13( i + vec3( 0.0, 0.0, 1.0 ) );
  float n101 = hash13( i + vec3( 1.0, 0.0, 1.0 ) );
  float n011 = hash13( i + vec3( 0.0, 1.0, 1.0 ) );
  float n111 = hash13( i + vec3( 1.0, 1.0, 1.0 ) );
  return mix(
    mix( mix( n000, n100, f.x ), mix( n010, n110, f.x ), f.y ),
    mix( mix( n001, n101, f.x ), mix( n011, n111, f.x ), f.y ),
    f.z );
}

// Fixed-octave variants: a literal loop bound lets the compiler unroll, and
// the cloud march is hot enough that it matters.
float fbm3_2( vec3 p ) {
  float s = vnoise3( p ) * 0.5;
  p = p * 2.17 + vec3( 11.3, 7.7, 5.1 );
  s += vnoise3( p ) * 0.25;
  return s / 0.75;
}

float fbm3_3( vec3 p ) {
  float s = vnoise3( p ) * 0.5;
  p = p * 2.17 + vec3( 11.3, 7.7, 5.1 );
  s += vnoise3( p ) * 0.25;
  p = p * 2.17 + vec3( 11.3, 7.7, 5.1 );
  s += vnoise3( p ) * 0.125;
  return s / 0.875;
}

float fbm3_4( vec3 p ) {
  float s = vnoise3( p ) * 0.5;
  p = p * 2.17 + vec3( 11.3, 7.7, 5.1 );
  s += vnoise3( p ) * 0.25;
  p = p * 2.17 + vec3( 11.3, 7.7, 5.1 );
  s += vnoise3( p ) * 0.125;
  p = p * 2.17 + vec3( 11.3, 7.7, 5.1 );
  s += vnoise3( p ) * 0.0625;
  return s / 0.9375;
}

/**
 * Billow noise — |2n-1| folded and inverted. Value/Perlin fbm produces smooth
 * rolling hills, which is what makes a cloud read as cotton wool; the fold puts
 * a CREASE at every zero crossing, and a stack of creases is exactly the
 * cauliflower silhouette of a convective cumulus.
 */
float billow3( vec3 p ) { return 1.0 - abs( vnoise3( p ) * 2.0 - 1.0 ); }

float billowFbm3( vec3 p ) {
  float s = billow3( p ) * 0.5;
  p = p * 2.31 + vec3( 19.3, 3.7, 11.1 );
  s += billow3( p ) * 0.25;
  p = p * 2.31 + vec3( 19.3, 3.7, 11.1 );
  s += billow3( p ) * 0.125;
  return s / 0.875;
}

/**
 * Interleaved-gradient noise (Jimenez, "Next Generation Post Processing").
 * Two multiplies for a spectrum that is very close to blue noise, which is
 * exactly what a raymarch start offset wants: a white-noise hash puts as much
 * energy at low frequencies as at high ones, so the dither itself becomes a
 * visible mottle, while IGN pushes essentially all of its energy above the
 * frequency the eye (and the TAA resolve) integrates over.
 *
 * frame slides the pattern along the sequence's own period so the residual
 * pattern averages out across the history buffer instead of being burned in.
 */
float ign( vec2 pix, float frame ) {
  pix += 5.588238 * frame;
  return fract( 52.9829189 * fract( dot( pix, vec2( 0.06711056, 0.00583715 ) ) ) );
}
`;

const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * vec4( mat3( modelViewMatrix ) * position, 1.0 );
  gl_Position = p.xyww;   // depth == 1: always behind everything
}
`;

const SKY_FRAG = /* glsl */ `
precision highp float;

varying vec3 vDir;

uniform vec3  uSunDir;
uniform float uSunIrradiance;
uniform float uMultiScatter;
uniform float uHazeMulti;
uniform float uMieG;
uniform float uTurbidity;
uniform vec3  uGroundColour;
uniform float uIntensity;
uniform float uMaxRadiance;
uniform float uViewAltitude;

uniform float uSunAngularRadius;
uniform float uSunDiscIntensity;

uniform float uCloudCoverage;
uniform float uCloudDensity;
uniform float uCloudBase;
uniform float uCloudThickness;
uniform float uCloudScale;
uniform vec3  uCloudOffset;
uniform float uCloudAbsorption;
uniform float uCloudGain;
uniform float uCloudAmbient;
uniform float uCloudContrast;
uniform float uCloudErosion;
uniform vec3  uSkyZenith;
uniform vec3  uSkyHorizon;

uniform float uCirrusHeight;
uniform float uCirrusAmount;
uniform float uCirrusOpacity;
uniform float uCirrusGain;

uniform float uDitherFrame;  // slides the IGN dither pattern per frame

uniform float uNight;        // 0 day .. 1 full night (star / moon fade)
uniform vec3  uMoonDir;
uniform float uMoonIntensity;

${ATMOSPHERE_GLSL}
${NOISE_GLSL}

// --- cloud layer -----------------------------------------------------------
//
// SHAPE. Three fields multiplied together:
//   weather map   two very low frequencies -> local coverage and cloud TYPE, so
//                 the dome breaks into systems instead of uniform popcorn
//   base fbm      the silhouette, thresholded against coverage by a LINEAR
//                 remap (see below)
//   height profile  flat dark base, widest a third of the way up, eroded crown
//
// The single most important detail is that the coverage threshold is a LINEAR
// remap and not a smoothstep. A smoothstep flattens the noise gradient into a
// plateau with a narrow transition — a cut-out. remap01 lets the base noise's
// own gradient BE the density falloff, so the edge is as soft or as sharp as the
// noise is, which is what a real cloud boundary looks like.

float remap01( float x, float lo, float hi ) {
  return clamp( ( x - lo ) / max( hi - lo, 1e-4 ), 0.0, 1.0 );
}

/**
 * Vertical density profile. typ 0 = flat stratocumulus sheet, 1 = tall
 * convective cumulus. The base ramp is short (a cumulus base is a hard, flat
 * condensation level); the crown tapers over most of the depth.
 */
float heightProfile( float h, float typ ) {
  // h may be pushed outside 0..1 by the per-system altitude lift; both ramps
  // already return 0 there, which is what makes the lift move mass instead of
  // smearing it against a clamp.
  // THE BASE RAMP IS 115-240 m, NOT 50-150 m. A cumulus base IS a hard, flat
  // condensation level, but 'hard' in a raymarch means the column's optical
  // depth crosses from 0 to >>1 inside ONE integration stride: the alpha then
  // steps in a single sample, the leading edge lands exactly on the dither grid,
  // and the underside of the deck photographs as a razor cut with the raymarch's
  // own interleaved-gradient weave printed along it (measured at 3x on the r4
  // grid frame — the diagonal hatch is visible against the blue). Spreading the
  // ramp over roughly three strides puts the transition back into the
  // integrator's resolution, which is what makes the base read as a cloud base
  // rather than as a stamp edge. The dark underside is unaffected: that comes
  // from the sky-view/self-shadow asymmetry below, not from this ramp.
  float baseIn = smoothstep( 0.0, mix( 0.070, 0.145, typ ), h );
  float topOut = 1.0 - smoothstep( mix( 0.34, 0.58, typ ), mix( 0.78, 1.06, typ ), h );
  // Slight waist so the widest part sits low: cumulus are wider than they are
  // tall at the base and taper upward.
  return baseIn * topOut * ( 1.0 - 0.16 * h );
}

/**
 * WEATHER CELL. Local coverage and cloud type, from two 20-60 km octaves.
 *
 * Hoisted out of the density function on purpose: these wavelengths are three
 * to four orders of magnitude longer than a light-march stride, so recomputing
 * them at every shadow sample bought nothing and cost a third of the march
 * budget. cloudShape now takes them as parameters and the view march
 * evaluates them once per sample.
 *
 * far is the normalised distance from the viewer (ro sits on the +Y axis, so
 * |p.xz| IS the ground distance to the parcel) and drives the whole horizon
 * hierarchy: much less vertical development, a squashed height profile, and —
 * see below — MORE apparent coverage, not less.
 *
 * lift is a per-system altitude offset in units of the slab thickness. A real
 * sky does not condense every parcel at one level: different air masses have
 * different lifting condensation levels, and it is that spread of bases that
 * stops a cumulus field reading as one painted cotton-wool band at a single
 * height. It is a shift of h INSIDE the marched shell, never a change to the
 * shell itself, so the ray/slab intersection stays exact.
 */
void cloudCell( vec3 p, out float cov, out float typ, out float far, out float lift ) {
  vec3 q = ( p + uCloudOffset ) * uCloudScale;
  float region  = vnoise3( q * 0.0000165 + 19.0 );
  float region2 = vnoise3( q * 0.0000505 + 4.5 );
  // The condensation-level offset used to be a THIRD independent octave. It is
  // evaluated at every one of up to 128 view samples, so it cost 8 hashes per
  // step for a term that only has to decorrelate cloud BASES from each other.
  // Beating the two octaves that are already here against each other at unequal
  // weights gives a field with the same spectrum for free; the only consequence
  // is that a deeper cell also tends to sit a little higher, which is what
  // convection does anyway. (A sine, not a fract: fract would put a hard step in
  // the base altitude and stamp a visible seam across the deck.)
  float region3 = 0.5 + 0.5 * sin( region * 11.0 + region2 * 17.0 );
  far = smoothstep( 6500.0, 78000.0, length( p.xz ) );
  cov = clamp( uCloudCoverage * ( 0.40 + 1.15 * region ) * ( 0.80 + 0.40 * region2 ), 0.0, 0.95 );
  // PERSPECTIVE CONVERGENCE. A shallow ray crosses many more cells of the deck
  // than a steep one, so a cumulus field reads as progressively MORE solid
  // toward the horizon until it closes into a defined band — that convergence
  // is the entire depth cue an establishing shot has, and thinning coverage
  // with distance (which is what this line used to do) deleted it.
  cov = clamp( cov * ( 1.0 + 0.44 * far ), 0.0, 0.96 );
  typ = clamp( 0.16 + 1.20 * region2, 0.0, 1.0 ) * ( 1.0 - 0.66 * far );
  // Spread of condensation levels, collapsing toward one level far away (where
  // the whole deck is squashed into the bottom of the slab anyway).
  // 0.46 of the slab, not 0.30 — about -180 m to +390 m of condensation level
  // across the field at the dry state's 1450 m slab. At 0.30 every base in frame
  // sat inside a 220 m window, which at 1.75 km and a 13 degree look-up projects
  // to a few dozen pixels: the deck read as one flat lid with texture on it, and
  // "no altitude layering" is what the review called that.
  //
  // The most-lifted cells do lose their crown against the top of the shell (h is
  // clamped to the slab before the lift is subtracted, so h' tops out at 0.73 and
  // heightProfile still returns ~0.13 there). That is deliberate rather than
  // tolerated: the residual is optically thin, and thickening the shell to make
  // room would cost every ray the extra chord on every step. Anything past about
  // 0.55 here starts to read as a flat lid at the ceiling instead.
  lift = ( region3 - 0.42 ) * 0.46 * ( 1.0 - 0.75 * far );
}

/**
 * Low-frequency silhouette in 0..1, NOT scaled by uCloudDensity. Cheap enough
 * to be the light march's density and the view march's empty-space skip test.
 */
float cloudShapeOct( vec3 p, float cov, float typ, float far, float lift, bool coarse ) {
  float h = ( length( p ) - R_GROUND - uCloudBase ) / uCloudThickness;
  if ( h < -0.03 || h > 1.03 ) return 0.0;
  h = clamp( h, 0.0, 1.0 );
  // FLATTENING WITH DISTANCE. Squashing h upward moves a far cell's whole mass
  // into the bottom of the slab, so the deck loses its vertical development and
  // recedes as a thin flat band rather than stamping identical popcorn all the
  // way to the skyline. Coverage thinning alone only makes far cloud sparser,
  // not shallower, which is the perspective cue that was missing.
  h = mix( h, min( h * 1.9, 1.0 ), far );
  vec3 q = ( p + uCloudOffset ) * uCloudScale;
  // OCTAVE BUDGET. The 4-octave fbm is the single hottest expression in the
  // file: 32 hashes, evaluated once per view step AND seven times per lit view
  // step inside the light march. The light march integrates optical depth over
  // hundreds of metres of cloud, so the 4th octave (a 310 m wavelength) is below
  // its own resolution and contributes nothing but cost — three octaves there is
  // visually identical and removes a quarter of the whole shader.
  float base = coarse ? fbm3_3( q * 0.000400 ) : fbm3_4( q * 0.000400 );
  // Upper bound < 1 so the cores actually reach density 1 instead of asymptoting.
  //
  // The WINDOW IS SHIFTED DOWN, not widened much: 0.52 of cov wide instead of
  // 0.48, but both ends lowered. Widening it alone is the obvious way to soften
  // a silhouette and it is the wrong one — it raises the noise value a core has
  // to reach before it saturates, so the deck thins out and you trade a hard
  // edge for a weak cloud, which is precisely the density the last round was
  // credited for. Lowering both ends keeps the cores denser than r4's while
  // giving the fringe a little more of the base noise's own gradient to fall
  // through.
  float d = remap01( base, 1.0 - cov * 1.02, 1.0 - cov * 0.50 );
  if ( d <= 0.0 ) return 0.0;
  // The distance term is a mild softening only. It used to remove a quarter of
  // the density on top of a coverage cut and a 55% detail cut, and the three
  // together are what turned the far deck into a featureless pale wash.
  return d * heightProfile( h - lift, typ ) * ( 1.0 - 0.10 * far );
}

float cloudShape( vec3 p, float cov, float typ, float far, float lift ) {
  return cloudShapeOct( p, cov, typ, far, lift, false );
}

/**
 * Full density: base silhouette carved by two more octave families. Erosion is
 * applied as another linear remap rather than a subtraction — subtracting a
 * constant shifts the whole field down and clips it flat, remapping rescales it
 * and keeps a gradient at the new boundary.
 */
float cloudDetail( vec3 p, float dBase, float far ) {
  float h = clamp( ( length( p ) - R_GROUND - uCloudBase ) / uCloudThickness, 0.0, 1.0 );
  vec3 q = ( p + uCloudOffset ) * uCloudScale;

  // Billow for the cauliflower crown, plain fbm for the softer flanks.
  float erode = mix( billowFbm3( q * 0.00300 ), fbm3_2( q * 0.0135 ), 0.34 );
  // Strongest where the cloud is already thin (the silhouette) and toward the
  // top; the base stays a coherent flat sheet.
  //
  // DETAIL LOD. Still a Nyquist guard, but a far weaker one than before: the
  // march no longer grows its stride geometrically, so at 60 km a step is ~500 m
  // rather than ~12 km and the 330 m octave is only just under-sampled. The old
  // fade killed 80% of the detail by 62 km, which removed exactly the horizon
  // texture that sells the scale of the layer.
  float lod = 1.0 - 0.55 * smoothstep( 34000.0, 130000.0, length( p.xz ) );
  float strength = uCloudErosion * mix( 0.20, 0.52, h ) * ( 0.62 + 0.50 * ( 1.0 - dBase ) ) * lod;
  return remap01( dBase, erode * strength, 1.0 ) * uCloudDensity;
}

/**
 * Optical depth from p toward the sun — the self-shadowing term. Steps grow
 * geometrically and are offset around a cone: a sample must be shadowed by
 * NEIGHBOURING billows, not only by the column directly above it, or every
 * cloud lights like a smooth ball.
 */
float cloudLightDepth( vec3 p, vec3 sun, vec3 ta, vec3 tb, float jitter,
                       float cov, float typ, float far, float lift ) {
  float ds = uCloudThickness * 0.062;
  // Jittered start AND a jittered spiral phase, both shared with the view
  // march. Without them the handful of geometric strides quantise
  // self-shadowing into concentric shells, which read as horizontal bands
  // across a grazing cloud deck.
  float t = ds * ( 0.18 + 0.82 * jitter );
  float acc = 0.0;
  for ( int i = 0; i < CLOUD_LIGHT_STEPS; i ++ ) {
    float a = float( i ) * 2.39996 + jitter * 6.2831853;   // golden-angle spiral
    vec3 off = ( ta * cos( a ) + tb * sin( a ) ) * t * 0.33;
    acc += cloudShapeOct( p + sun * t + off, cov, typ, far, lift, true ) * uCloudDensity * ds;
    t += ds;
    ds *= 1.45;
  }
  // One long stride for the mass further up-sun: cheap self-shadowing from the
  // rest of the layer, which is what darkens the underside of a deep cumulus.
  acc += cloudShapeOct( p + sun * ( t + uCloudThickness * 0.9 ), cov, typ, far, lift, true )
       * uCloudDensity * uCloudThickness * 0.85;
  return acc;
}

/**
 * Front-to-back march of the cumulus shell. Returns premultiplied radiance,
 * writes the remaining transmittance and the distance to the first hit.
 *
 * STEP DISTRIBUTION — this is the whole ballgame.
 *
 * The previous march grew its stride 12% per step from a 135 m base. On a ray
 * that leaves the slab quickly that is fine, but on the 30-50 degree rays that
 * fill the upper half of a racing frame the geometric series reached 700 m
 * inside a 1500 m layer, i.e. SIX samples through the cloud — which is exactly
 * the "six to eight horizontal pancake slabs" the review measured. Any growth
 * law is wrong here, because the quantity that must bound ds is the vertical
 * noise wavelength of the layer, and that does not grow with distance.
 *
 * So: a stride pinned to a fixed fraction of the layer thickness
 * (CLOUD_DS_FRAC, ~1/19 of it), scaled only by a gentle projected-footprint LOD
 * so far cloud is not paying near-field rates; empty-space skipping at 2.4x
 * that stride using the cheap low-frequency silhouette as the occupancy test,
 * which is what pays for the extra resolution; a step BACK on the first
 * occupied sample so the leading edge is resolved at the fine rate; and the
 * whole grid offset per pixel by interleaved-gradient noise so the residual
 * quantisation is high-frequency dither for the TAA resolve to eat rather than
 * a set of hard shells.
 */
vec3 marchClouds( vec3 ro, vec3 rd, vec3 sun, float dither,
                  out float transmittance, out float firstHit ) {
  transmittance = 1.0;
  firstHit = 1e9;
  if ( uCloudDensity <= 0.001 || uCloudCoverage <= 0.001 ) return vec3( 0.0 );
  if ( raySphereNear( ro, rd, R_GROUND ) > 0.0 ) return vec3( 0.0 );   // looking at the planet

  float rBase = R_GROUND + uCloudBase;
  float rTop = R_GROUND + uCloudBase + uCloudThickness;
  float tNear = raySphereFar( ro, rd, rBase );
  float tFar = raySphereFar( ro, rd, rTop );
  if ( tFar <= 0.0 ) return vec3( 0.0 );
  tNear = max( tNear, 0.0 );
  if ( tFar <= tNear ) return vec3( 0.0 );

  float span = min( tFar - tNear, CLOUD_RANGE );
  float tEnd = tNear + span;

  float dsUnit = uCloudThickness * CLOUD_DS_FRAC;

  // SLAB-AWARE EMPTY-SPACE SKIP — the whole of the performance story.
  //
  // Measured at 1080p before this: the cloud layer cost 18.9 ms in the grid shot
  // and 11.8 ms in wide, against a 16.7 ms frame budget and a claimed 3.0 ms in
  // this file's header. Where it went: a ray at 6 degrees of elevation — which
  // is every pixel of an establishing frame — has its FIRST cloud 16 km away,
  // and it was walking there in 77 m strides. 128 steps at 2.2x skip is 21 km,
  // so those pixels burned the entire step budget in clear air and, half the
  // time, returned nothing at all.
  //
  // The quantity that must stay under the layer's vertical noise wavelength is
  // ds * |rd.y|, not ds. A grazing ray may therefore skip through empty air with
  // a far longer stride and still resolve the slab it eventually enters. The
  // INTEGRATION stride stays at dsUnit — a long step inside cloud is a different
  // failure (exp(-d k ds) per step becomes a 0.19 opacity jump and the body of a
  // cumulus quantises into onion rings, which is exactly what a first attempt at
  // this produced). So: coarse to find the cloud, fine to shade it.
  float skipScale = min( 1.0 / max( abs( rd.y ), 0.06 ), CLOUD_SKIP_MAX );

  float mu = dot( rd, sun );
  vec3 sunT = sunTransmittance( ro + vec3( 0.0, uCloudBase, 0.0 ), sun );
  vec3 sunCol = sunT * uSunIrradiance * uCloudGain;

  // Cone basis for the light march.
  vec3 ta = normalize( abs( sun.y ) < 0.9 ? cross( sun, vec3( 0.0, 1.0, 0.0 ) ) : vec3( 1.0, 0.0, 0.0 ) );
  vec3 tb = cross( sun, ta );

  // CEILING, self-calibrating against the sky the cloud is sitting in. Whatever
  // the phase function peaks at, a cloud may not leave here brighter than
  // uCloudContrast x the brightest sky probe. This is the hard guarantee that
  // replaces the old (absent) one: the previous shader's source term had an
  // effective single-scattering albedo of 182 and nothing bounded it at all.
  float ceilL = max( dot( uSkyHorizon, vec3( 0.2126, 0.7152, 0.0722 ) ),
                     dot( uSkyZenith,  vec3( 0.2126, 0.7152, 0.0722 ) ) ) * uCloudContrast;

  vec3 acc = vec3( 0.0 );
  // The blue-noise offset has to span the SKIP stride, not the integration
  // stride. What the eye picks up as onion rings inside a cumulus is not the
  // integration error, it is the quantisation of the DEPTH AT WHICH THE RAY
  // FIRST STARTS SHADING: that lands on the skip grid, so with a 900 m skip and
  // a 77 m dither every pixel in a neighbourhood entered the cloud at the same
  // one of a handful of depths and the contours of that integer are visible.
  // Dithering across the whole skip stride turns those contours into the
  // high-frequency noise the TAA resolve is there to integrate.
  float t = tNear + dsUnit * skipScale * dither;
  float ld = 0.0;
  bool refine = false;
  for ( int i = 0; i < CLOUD_STEPS; i ++ ) {
    if ( transmittance < 0.008 || t >= tEnd ) break;
    float ds = dsUnit * ( 1.0 + t * CLOUD_LOD_RATE );
    vec3 p = ro + rd * t;

    float cov, typ, far, lift;
    cloudCell( p, cov, typ, far, lift );
    float dBase = cloudShape( p, cov, typ, far, lift );

    // The skip stride is the integration stride times the slab factor: 1x looking
    // straight up (nothing changes for a steep ray) rising to CLOUD_SKIP_MAX on
    // the grazing rays that cost everything.
    float dsSkip = ds * skipScale;

    if ( dBase <= 0.0015 ) {
      t += dsSkip * 2.2;          // empty-space skip on the cheap silhouette
      refine = true;
      continue;
    }
    if ( refine ) {
      // First occupied sample after a coarse stride: back up and re-enter at the
      // fine rate so the lit leading edge is not quantised to the skip grid.
      // The back-step is deliberately SHORTER than the skip (1.3 vs 2.2): equal
      // lengths let a thin cloud front ping-pong empty/occupied around the same
      // 1.5 km, advancing a fraction of a stride per iteration and eating the
      // step budget before the ray reaches the far side of the deck.
      refine = false;
      t = max( tNear, t - dsSkip * 1.3 );
      continue;
    }

    float d = cloudDetail( p, dBase, far );
    if ( d > 0.0015 ) {
      if ( firstHit > 1e8 ) firstHit = t;
      float alt = clamp( ( length( p ) - R_GROUND - uCloudBase ) / uCloudThickness, 0.0, 1.0 );
      // Once the interior has gone dark the shadow term stops mattering, so stop
      // paying for it and reuse the last one. Worth ~15% of the march.
      if ( transmittance > 0.16 ) ld = cloudLightDepth( p, sun, ta, tb, dither, cov, typ, far, lift );
      float tau = ld * uCloudAbsorption;

      // MULTIPLE SCATTERING, as a sum of successively dimmer, more attenuated,
      // more isotropic scattering orders (Wrenninge's octave trick). Single
      // scattering alone leaves the interior of a cumulus black and its lit rim
      // a hard white line — which IS the cut-out look. The higher orders are
      // what carry light sideways through the volume and give the interior its
      // gradient. The series is strictly decreasing, so it is bounded by
      // sum(b^i) = 1/(1-b) times the single-scatter peak.
      float a = 1.0, b = 1.0, c = 1.0;
      vec3 direct = vec3( 0.0 );
      for ( int o = 0; o < 3; o ++ ) {
        float ph = mix( hgPhase( mu, 0.48 * c ), hgPhase( mu, -0.24 * c ), 0.30 ) * 4.0 * PI;
        direct += sunCol * ( b * exp( -tau * a ) * ph );
        a *= 0.44; b *= 0.56; c *= 0.58;
      }

      // BEER-POWDER. In BACKSCATTER — sun behind the camera, which for
      // mu = dot(view, sun) is mu < 0 — an optically thin patch has too little
      // mass to turn the beam around, so the near fringe of a cumulus goes DARK
      // before it goes white. The sign here used to be inverted, which applied
      // the darkening in the FORWARD lobe instead: it dimmed precisely the
      // backlit edges that are supposed to carry the silver lining, and left the
      // sun-behind-camera side flat. That is most of "no bright rim".
      float powder = 1.0 - exp( -tau * 3.4 );
      direct *= mix( 1.0, 0.30 + 0.70 * powder, 0.60 * clamp( -mu, 0.0, 1.0 ) );

      // AMBIENT = the sky this parcel can see. The crown sees the whole dome,
      // the base sees almost none of it (its own mass is in the way) plus a
      // little warm bounce off the ground. That asymmetry is the bright-top /
      // dark-flat-base signature; a single ambient term gives a flat white blob.
      // The base fraction is deliberately low (0.24, not 0.42) and the ramp is
      // quadratic: with an exposure keyed to the sky, an ambient floor that high
      // put the shaded underside within a stop of the sunlit crown, so ACES'
      // shoulder mapped the whole cloud to one white. A measured cumulus base
      // sits at roughly a quarter to a third of its crown, which is what this is.
      float skyView = ( 0.30 + 0.70 * alt * alt ) * exp( -tau * 0.10 );
      vec3 ambCol = mix( uSkyHorizon, uSkyZenith, 0.30 + 0.55 * alt );
      // A cumulus base is lit by the whole lower dome AND by the ground, not by
      // one patch of blue sky. Desaturating toward its own luminance low down is
      // what stops the underside reading as inky navy.
      //
      // The floor is 0.42, not 0.55. The horizon probe is 0.58 : 0.88 : 1.00 —
      // measurably cyan — and at 0.55 the shaded base of every cumulus inherited
      // enough of that to photograph as teal-grey: measured at the top of the
      // wide frame, a shaded base was sRGB (93, 117, 118), i.e. green and blue
      // within one code value of each other with red 25 below. A cumulus base is
      // integrating the entire lower dome plus a ground bounce, which is a far
      // more achromatic reference than one horizon sample. Luminance is
      // unchanged, so nothing downstream of this re-meters.
      ambCol = mix( vec3( dot( ambCol, vec3( 0.2126, 0.7152, 0.0722 ) ) ), ambCol, 0.42 + 0.58 * alt );
      vec3 ambient = ambCol * skyView * uCloudAmbient
                   + uGroundColour * uSunIrradiance * 0.038 * ( 1.0 - alt ) * ( 0.4 + 0.6 * max( sun.y, 0.0 ) );

      vec3 S = direct + ambient;
      // Soft luminance ceiling: a cubic knee that is the identity well below
      // ceilL and asymptotic to it, applied on LUMINANCE so the cloud keeps its
      // (slightly warm) hue instead of desaturating to paper white.
      float sl = max( dot( S, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-5 );
      S *= 1.0 / pow( 1.0 + pow( sl / ceilL, 3.0 ), 0.33333 );

      // Energy-conserving segment integral: S * (1 - T) saturates AT S, so an
      // opaque cloud reaches the radiance actually incident on it and no more.
      float stepT = exp( -d * uCloudAbsorption * ds );
      acc += transmittance * S * ( 1.0 - stepT );
      transmittance *= stepT;
    }
    t += ds;
  }
  return acc;
}

// --- high cirrus -----------------------------------------------------------
//
// A second, much thinner layer at 8-9 km. Two altitudes in frame is most of
// what makes a sky read as deep rather than as one painted band, and because
// the layer is eight kilometres up its perspective convergence toward the
// horizon is far stronger than the cumulus deck's — a 5 degree ray meets it
// ninety kilometres away, so the streaks compress into fine lines exactly where
// the review wanted small elements.
//
// It is a single analytic slab sample, not a march: cirrus is optically thin
// (od well under 1), so one Beer term through the sheet is the right model and
// the whole layer costs six noise lookups.

float cirrusDensity( vec3 p, float amount, float wind, float freq, float seed ) {
  vec3 q = p + uCloudOffset * wind;            // the jet stream runs faster
  // Sheared coordinates: cirrus is drawn out downwind, so the along-wind
  // wavelength is several times the across-wind one. 6.4:1 — the old 4.2:1 was
  // not enough shear to read as fibre, it read as ordinary lumpy noise blurred
  // out by the slant integral.
  vec3 s = vec3( q.x * 0.0000175, 0.0, q.z * 0.000112 ) * freq;
  // PATCHINESS. The old 0.45 + 1.05 * region floored local coverage at 0.25
  // and averaged 0.51, so SOME veil covered essentially the whole dome — which
  // is a wash, not a cloud layer. A cirrus sky is a few large fibrous systems
  // with clear blue between them, so the floor has to go near zero and the
  // spread has to be wide.
  float cov = clamp( amount * ( 0.10 + 1.55 * vnoise3( s * 0.55 + 41.0 + seed ) ), 0.0, 0.95 );
  float band = fbm3_3( s * 3.4 + vec3( 3.1, 8.4, 1.7 ) + seed );
  float d = remap01( band, 1.0 - cov, 1.0 - cov * 0.34 );
  if ( d <= 0.0 ) return 0.0;
  // The fine octave is SHEARED like the band octave. Isotropic high-frequency
  // erosion on a sheared field punches round holes through the fibres, and a
  // field of round holes at 90 km is a stipple — which is what made the veil
  // read as a dither pattern rather than as ice. Stretched 3x along the wind and
  // applied at 0.44 instead of 0.70, it breaks the streaks into finer streaks.
  float fine = fbm3_2( vec3( s.x * 7.0, 0.0, s.z * 24.0 ) + vec3( 0.0, 21.0, 0.0 ) + seed );
  return remap01( d, 0.44 * fine * ( 1.0 - d ), 1.0 );
}

/**
 * Premultiplied cirrus radiance; multiplies transmittance down in place.
 *
 * skyL is the LOCAL sky radiance behind the veil (before the sun disc is added).
 * It has to be the ambient reference rather than a fixed blend of the zenith and
 * horizon probes: a fixed blend is darker than the sky near the horizon and
 * brighter than it near the zenith, so the layer read as dirty grey-blue smears
 * low down and as a wash high up. Referenced to the local sky, a thin ice veil
 * can only ever add the forward-scattered sunlight on top of what was already
 * there, which is exactly what a cirrus deck does.
 */
vec3 shadeCirrus( vec3 ro, vec3 rd, vec3 sun, vec3 skyL, float ceilL,
                  float height, float amount, float opacity, float wind, float freq, float seed,
                  inout float transmittance ) {
  if ( amount <= 0.001 ) return vec3( 0.0 );
  if ( raySphereNear( ro, rd, R_GROUND ) > 0.0 ) return vec3( 0.0 );
  float t = raySphereFar( ro, rd, R_GROUND + height );
  if ( t <= 0.0 ) return vec3( 0.0 );

  vec3 p = ro + rd * t;
  float d = cirrusDensity( p, amount, wind, freq, seed );
  if ( d <= 0.002 ) return vec3( 0.0 );

  // Grazing rays cut a longer chord through the sheet, which is what thickens
  // the layer into the horizon band instead of ending it in mid-air. The cap is
  // 7, not 9: at 9 the last degree of elevation saturates to alpha ~1 across the
  // whole width of the frame and the layer closes into a solid lid.
  float slant = 1.0 / max( abs( rd.y ), 0.055 );
  float od = d * opacity * min( slant, 7.0 );
  float alpha = 1.0 - exp( -od );

  float mu = dot( rd, sun );
  // Ice crystals are strongly forward scattering; the broad lobe is what makes a
  // cirrus veil glow when the sun is behind it.
  float ph = mix( hgPhase( mu, 0.82 ), hgPhase( mu, 0.10 ), 0.42 ) * 4.0 * PI;
  vec3 sunT = sunTransmittance( ro + vec3( 0.0, height, 0.0 ), sun );
  // THE VEIL MUST NOT BE A COPY OF THE SKY BEHIND IT.
  //
  // The ambient coefficient used to be 0.94, and with the old gain the direct
  // term contributed ~0.24 against a local sky of ~2.7. Composited, that is
  // 0.96 * sky + 0.16 — i.e. the layer was measurably present and visually
  // absent, which is exactly the "featureless pale wash" the establishing shots
  // were marked down for. A real ice veil is WHITE and reads brighter than the
  // blue sky in red and green even when it barely dims the blue.
  //
  // So: the ambient reference stays local (that is what stops it smearing dirty
  // grey-blue low down) but drops to 0.80, and the direct term carries the
  // difference. It is still bounded three ways — exp(-od) self-attenuation,
  // the shared ceilL knee below, and the fact that alpha is what it is
  // multiplied by.
  vec3 S = sunT * uSunIrradiance * uCirrusGain * ph * exp( -od * 0.8 ) + skyL * 0.80;

  // Same self-calibrating knee the cumulus uses — nothing in this file gets an
  // unbounded source term.
  float sl = max( dot( S, vec3( 0.2126, 0.7152, 0.0722 ) ), 1e-5 );
  S *= 1.0 / pow( 1.0 + pow( sl / ceilL, 3.0 ), 0.33333 );

  // Recede into the horizon haze: by ~120 km a cirrus streak is behind more air
  // than cloud and has to become the haze band itself.
  float fade = smoothstep( 55000.0, 210000.0, t );
  S = mix( S, uSkyHorizon, fade );
  alpha *= 1.0 - 0.35 * fade;

  transmittance *= 1.0 - alpha;
  return S * alpha;
}

// --- stars -----------------------------------------------------------------

vec3 starField( vec3 dir ) {
  vec3 acc = vec3( 0.0 );
  vec3 g = dir * 260.0;
  vec3 c = floor( g );
  // 2x2x2 neighbourhood so stars never clip at cell borders.
  for ( int x = 0; x <= 1; x ++ )
  for ( int y = 0; y <= 1; y ++ )
  for ( int z = 0; z <= 1; z ++ ) {
    vec3 cell = c + vec3( float( x ), float( y ), float( z ) );
    float h = hash13( cell );
    if ( h < 0.985 ) continue;
    vec3 jitter = vec3( hash13( cell + 3.1 ), hash13( cell + 7.7 ), hash13( cell + 13.3 ) ) - 0.5;
    float d = length( g - ( cell + 0.5 + jitter * 0.8 ) );
    float mag = pow( hash13( cell + 21.7 ), 3.0 );
    vec3 tint = mix( vec3( 0.72, 0.82, 1.0 ), vec3( 1.0, 0.86, 0.68 ), hash13( cell + 41.3 ) );
    acc += tint * mag * exp( -d * d * 16.0 );
  }
  return acc * 2.2;
}

void main() {
  vec3 dir = normalize( vDir );
  vec3 sun = normalize( uSunDir );
  vec3 ro = vec3( 0.0, R_GROUND + uViewAltitude, 0.0 );

  vec3 viewTransmittance;
  vec3 sky = atmosphereRadiance( ro, dir, sun, 1e9, viewTransmittance );
  // The sky WITHOUT the sun disc — the cirrus layer's ambient reference. Using
  // the post-disc value would hand a 220-unit spike to a cloud source term.
  vec3 skyBase = sky;

  // --- sun disc with limb darkening ---------------------------------------
  float mu = dot( dir, sun );
  float cosR = cos( uSunAngularRadius );
  if ( mu > cosR - 0.0004 ) {
    float theta = acos( clamp( mu, -1.0, 1.0 ) );
    float r = theta / uSunAngularRadius;
    float edge = 1.0 - smoothstep( 0.97, 1.02, r );
    float md = sqrt( max( 0.0, 1.0 - min( r, 1.0 ) * min( r, 1.0 ) ) );
    // Quadratic limb-darkening law; the coefficients rise toward the blue, so
    // the rim of the disc goes visibly warmer than the centre.
    vec3 limb = 1.0 - vec3( 0.397, 0.503, 0.652 ) * ( 1.0 - md );
    vec3 discT = sunTransmittance( ro, sun );
    sky += limb * edge * uSunDiscIntensity * discT;
  }

  // --- night sky ------------------------------------------------------------
  if ( uNight > 0.001 ) {
    vec3 night = starField( dir ) * smoothstep( -0.02, 0.10, dir.y );
    float mm = dot( dir, normalize( uMoonDir ) );
    float moonR = 0.0085;
    if ( mm > cos( moonR ) - 0.0006 ) {
      float rr = acos( clamp( mm, -1.0, 1.0 ) ) / moonR;
      night += vec3( 1.0, 0.97, 0.90 ) * ( 1.0 - smoothstep( 0.95, 1.03, rr ) ) * uMoonIntensity;
    }
    night += vec3( 0.55, 0.62, 0.85 ) * pow( max( mm, 0.0 ), 220.0 ) * uMoonIntensity * 0.05;
    sky += night * uNight * viewTransmittance;
  }

  // --- clouds ---------------------------------------------------------------
  //
  // Per-pixel blue-noise offset for BOTH marches. See ign() — this is the single
  // change that turns the residual step quantisation from a set of horizontal
  // shells into dither the temporal resolve integrates away.
  float dither = ign( gl_FragCoord.xy, uDitherFrame );

  float ceilL = max( dot( uSkyHorizon, vec3( 0.2126, 0.7152, 0.0722 ) ),
                     dot( uSkyZenith,  vec3( 0.2126, 0.7152, 0.0722 ) ) ) * uCloudContrast;

  // THREE ALTITUDES, composited back to front (highest is furthest, so it goes
  // first): cirrostratus at ~12.4 km, cirrus at ~8.6 km, cumulus at ~1.75 km.
  //
  // Two tiers of ice cloud, not one, is what the sky was missing. One veil plus
  // one cumulus deck gives two heights but no PARALLAX between them: both layers
  // converge toward the horizon on their own schedule, and it is seeing a fine
  // high sheet slide behind a coarser lower one — different apparent scale,
  // different rate of convergence, different drift speed — that reads as depth
  // rather than as two painted mattes. The upper tier is deliberately the
  // thinner and the finer of the two (0.62x the opacity, 1.5x the spatial
  // frequency, a faster jet stream and its own noise seed), because that is the
  // direction the real atmosphere runs: the higher the ice, the more it is drawn
  // out into fibre. It costs six noise lookups on sky pixels only.
  // FRONT TO BACK, because shadeCirrus multiplies the running transmittance in
  // place: the lower sheet is nearer, so it goes first, and the upper sheet's
  // premultiplied radiance is then weighted by whatever the lower sheet left.
  float cirrusT = 1.0;
  vec3 cirrus = shadeCirrus( ro, dir, sun, skyBase, ceilL,
      uCirrusHeight, uCirrusAmount, uCirrusOpacity,
      2.6, 1.0, 0.0, cirrusT );
  float cirrusTLow = cirrusT;
  cirrus += shadeCirrus( ro, dir, sun, skyBase, ceilL,
      uCirrusHeight * 1.44, uCirrusAmount * 0.74, uCirrusOpacity * 0.62,
      3.9, 1.5, 137.0, cirrusT ) * cirrusTLow;
  sky = sky * cirrusT + cirrus;

  float cloudT;
  float cloudDist;
  vec3 cloud = marchClouds( ro, dir, sun, dither, cloudT, cloudDist );
  if ( cloudT < 0.999 ) {
    // AERIAL PERSPECTIVE ON THE DECK — an EXTINCTION, not an erasure.
    //
    // This was the single line that emptied the establishing shots. The cloud
    // base is 1.8 km up, so the ground distance to the layer is 1800/tan(theta):
    // 16 km at 6 degrees, 34 km at 3, 52 km at 2, 100 km at 1. The old
    // smoothstep(24 km, 66 km) therefore COMPLETED — colour replaced by the flat
    // horizon probe and alpha driven to zero — for every ray below about 2.5
    // degrees of elevation. Measured, the wide rig sees elevations 0..6.3 and
    // the tv rig 0..0.1, so the entire cloud layer was being deleted in exactly
    // the two shots that are nothing but horizon sky. Meanwhile chase and grid
    // look up to 13 degrees, which is why their clouds were fine and the fix for
    // them never reached the wide frame.
    //
    // Beer's law against a 92 km haze scale instead, and the ALPHA only loses
    // just over half of what the colour does: a cumulus band 60 km away goes pale
    // and low-contrast — which is correct — but it is still unmistakably there,
    // which is the whole depth cue. The target is the horizon probe pulled toward
    // its own luminance, because haze is broadband scatter and is less saturated
    // than the clear-sky radiance the probe measures.
    //
    // 0.60 of the way to neutral, not 0.35. The horizon probe's chromaticity is
    // 0.58 : 0.88 : 1.00 — a single-scattering model with 16 quadratic steps
    // leaves the long-path band distinctly cyan — and at 0.35 the far half of the
    // deck inherited that and photographed as a teal-grey smear rather than as
    // pale distant cloud. Multiply-scattered haze is very close to achromatic,
    // and this is a colour-only change: luminance (and therefore the exposure
    // meter, which never sees this term) is preserved exactly.
    // 64 km, not 92 km. 92 km left a cumulus 16 km out (6 degrees of elevation,
    // i.e. the whole middle band of an establishing frame) at fade 0.16 — a
    // crisp white puff at full contrast against full-saturation blue, which is
    // what made the far deck read as stickers stamped on a skybox. At 64 km the
    // same parcel is at 0.22 and one at 40 km is at 0.46, so the field grades
    // continuously into the haze instead of ending in a hard row. This does NOT
    // reinstate the r3 erasure the note above is about: it is still Beer's law
    // with alpha losing 0.55 of what the colour loses, so the band never
    // completes and the deck is still unmistakably there at 100 km.
    float fade = 1.0 - exp( -cloudDist / 64000.0 );
    vec3 hazeCol = mix( uSkyHorizon, vec3( dot( uSkyHorizon, vec3( 0.2126, 0.7152, 0.0722 ) ) ), 0.60 );
    cloud = mix( cloud, hazeCol * ( 1.0 - cloudT ), fade );
    cloudT = mix( cloudT, 1.0, fade * 0.55 );
    sky = sky * cloudT + cloud;
  }

  // SOFT clamp, not a hard one. A hard min() turns the sun disc into a flat
  // plateau, which the bloom downsampler then reads as a uniform bright DISC
  // instead of a peak with falloff. x/(1+x/M) is the identity for small x and
  // asymptotic to uMaxRadiance, so the disc keeps its limb gradient while the
  // PMREM integrator never sees an unbounded spike.
  sky = max( sky * uIntensity, vec3( 0.0 ) );
  sky = sky / ( 1.0 + sky / uMaxRadiance );
  gl_FragColor = vec4( sky, 1.0 );
}
`;

// ---------------------------------------------------------------------------
// Aerial perspective — global fog chunk replacement
// ---------------------------------------------------------------------------

/**
 * Live uniforms shared by EVERY lit material in the scene.
 *
 * They are injected into `THREE.ShaderLib[*].uniforms` as Float32Arrays.
 * `UniformsUtils.clone` deep-copies Colors/Vectors but assigns anything else by
 * reference, so all materials end up pointing at these exact arrays and a
 * single write per frame updates the whole scene. (Adding uniforms through
 * `onBeforeCompile` instead would clobber other modules' hooks.)
 */
export const aerialUniforms = {
  sunDir: new Float32Array([0, 1, 0]),
  zenith: new Float32Array([0.12, 0.2, 0.38]),
  horizon: new Float32Array([0.5, 0.6, 0.75]),
  sunHaze: new Float32Array([1.0, 0.8, 0.6]),
  params: new Float32Array([1.0, 900, 0.0, 1.0]), // strength, height scale, mieBoost, distance scale
};

const FOG_PARS_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying vec3 vFogWorldPos;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
  uniform vec3  apexAerialSunDir;
  uniform vec3  apexAerialZenith;
  uniform vec3  apexAerialHorizon;
  uniform vec3  apexAerialSunHaze;
  uniform vec4  apexAerialParams;
#endif
`;

// Reconstructed from `mvPosition` rather than `transformed` so it works for
// every shader that includes this chunk — instanced, batched, skinned, or a
// hand-written ShaderMaterial from another module that never declares
// `transformed`. viewMatrix's rotation is orthonormal, so its inverse is its
// transpose and world = Rᵀ·view + cameraPosition exactly.
const FOG_VERTEX = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  vFogWorldPos = transpose( mat3( viewMatrix ) ) * mvPosition.xyz + cameraPosition;
#endif
`;

const FOG_PARS_VERTEX = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogWorldPos;
#endif
`;

/**
 * Directional aerial perspective.
 *
 * Instead of one flat fog colour we integrate an exponential-with-altitude
 * air density along the view ray and tint the in-scattered light by where the
 * ray is looking: cool overhead, pale at the horizon, and hot in a Mie lobe
 * around the sun. That single change is most of what separates "3D scene with
 * fog" from "photographed landscape".
 */
const FOG_FRAGMENT = /* glsl */ `
#ifdef USE_FOG
  {
    vec3 apexRay = vFogWorldPos - cameraPosition;
    float apexDist = max( length( apexRay ), 1e-4 );
    vec3 apexDir = apexRay / apexDist;

    // Analytic integral of exp(-y/H) along the ray, in "metres of sea-level air".
    float apexH = apexAerialParams.y;
    float apexY0 = max( cameraPosition.y, -50.0 );
    float apexDy = apexDir.y;
    float apexAir;
    if ( abs( apexDy ) < 1e-4 ) {
      apexAir = apexDist * exp( -apexY0 / apexH );
    } else {
      apexAir = ( apexH / apexDy ) * ( exp( -apexY0 / apexH ) - exp( -( apexY0 + apexDy * apexDist ) / apexH ) );
    }
    apexAir = max( apexAir, 0.0 );

    float apexAmount = 1.0 - exp( -apexAir * fogDensity * apexAerialParams.x );

    float apexMu = dot( apexDir, apexAerialSunDir );
    float apexG = 0.72;
    float apexPhase = ( 1.0 - apexG * apexG ) / pow( max( 1.0 + apexG * apexG - 2.0 * apexG * apexMu, 1e-4 ), 1.5 );
    float apexUp = clamp( apexDir.y * 1.8 + 0.12, 0.0, 1.0 );

    vec3 apexScatter = mix( apexAerialHorizon, apexAerialZenith, apexUp );
    apexScatter += apexAerialSunHaze * apexPhase * apexAerialParams.z;

    // apexScatter is ALREADY an absolute radiance (the sky's own probes, times
    // the sky's intensity), so it is the answer on its own. Multiplying it by
    // fogColor — a hue-normalised colour scaled by whatever the caller felt
    // like — tinted the haze twice and detached its brightness from the sky it
    // is supposed to fade into. fogColor stays declared for other readers.
    gl_FragColor.rgb = mix( gl_FragColor.rgb, apexScatter, apexAmount );
  }
#endif
`;

let aerialInstalled = false;

/** Patch three's fog chunks once, before any program is compiled. */
export function installAerialPerspective() {
  if (aerialInstalled) return;
  aerialInstalled = true;

  THREE.ShaderChunk.fog_pars_fragment = FOG_PARS_FRAGMENT;
  THREE.ShaderChunk.fog_pars_vertex = FOG_PARS_VERTEX;
  THREE.ShaderChunk.fog_vertex = FOG_VERTEX;
  THREE.ShaderChunk.fog_fragment = FOG_FRAGMENT;

  const extra = {
    apexAerialSunDir: { value: aerialUniforms.sunDir },
    apexAerialZenith: { value: aerialUniforms.zenith },
    apexAerialHorizon: { value: aerialUniforms.horizon },
    apexAerialSunHaze: { value: aerialUniforms.sunHaze },
    apexAerialParams: { value: aerialUniforms.params },
  };
  for (const name of Object.keys(THREE.ShaderLib)) {
    const lib = THREE.ShaderLib[name];
    if (!lib || !lib.uniforms || !lib.uniforms.fogColor) continue;
    Object.assign(lib.uniforms, extra);
  }
}

installAerialPerspective();

// ---------------------------------------------------------------------------
// Time-of-day presets
// ---------------------------------------------------------------------------

/**
 * Each preset is a complete look: clock time, air clarity, cloud state and an
 * exposure compensation in stops applied on top of the metered EV100.
 */
export const TIME_OF_DAY = {
  dawn: { hour: 5.9, turbidity: 3.4, coverage: 0.42, density: 1.0, ev: -0.15 },
  sunrise: { hour: 6.8, turbidity: 3.8, coverage: 0.40, density: 1.0, ev: -0.1 },
  morning: { hour: 9.4, turbidity: 2.8, coverage: 0.34, density: 0.95, ev: 0.0 },
  noon: { hour: 12.5, turbidity: 2.4, coverage: 0.28, density: 0.9, ev: 0.0 },
  afternoon: { hour: 15.2, turbidity: 2.7, coverage: 0.34, density: 0.95, ev: 0.0 },
  golden: { hour: 17.7, turbidity: 3.4, coverage: 0.40, density: 1.05, ev: 0.15 },
  sunset: { hour: 19.1, turbidity: 4.2, coverage: 0.44, density: 1.1, ev: 0.35 },
  dusk: { hour: 20.1, turbidity: 3.6, coverage: 0.40, density: 1.0, ev: 0.5 },
  night: { hour: 22.0, turbidity: 2.6, coverage: 0.30, density: 0.85, ev: 0.6 },
};

// Solar geometry for a mid-latitude summer afternoon. Chosen so the engine's
// existing shot hours land where they should: 10.4 -> high morning, 15.2 -> 36
// degrees, 17.6 -> golden hour, 19.4 -> below the horizon.
const LATITUDE = THREE.MathUtils.degToRad(45);
const DECLINATION = THREE.MathUtils.degToRad(10);

// ---------------------------------------------------------------------------
// Sky
// ---------------------------------------------------------------------------

const _v3 = new THREE.Vector3();

export class Sky {
  constructor(opts = {}) {
    this.uniforms = {
      uSunDir: { value: new THREE.Vector3(0.3, 0.55, -0.78).normalize() },
      uSunIrradiance: { value: opts.sunIrradiance ?? 22.0 },
      uMultiScatter: { value: opts.multiScatter ?? 1.35 },
      /**
       * Achromatic aerosol multiple scattering — THE MILKY HORIZON BAND.
       * Carried by the Mie column, so it is ~30x stronger along the skyline than
       * at the zenith and needs no elevation ramp of its own. See the note in
       * atmosphereRadiance(); the JS twin defaults to the same number.
       */
      /**
       * 6.2, not 1.6. At 1.6 the term existed but was inaudible: measured on the
       * `wide` frame, the sky band read (146,159,151) — saturation 13.0% and
       * luminance 155 — i.e. clear-sky Rayleigh blue running at full chroma
       * straight down into the skyline with no pale band between them, which is
       * the "horizon haze band gone" finding. At 6.2 the same band is
       * (162,168,159): saturation 8.4%, luminance 166. That is +7.2% sky
       * luminance and -4.6pp saturation, and because the carrier is the MIE
       * column it is a low-elevation effect by construction — the grid frame's
       * zenith only loses 4.3pp while its horizon loses 9.5pp, so the sky still
       * grades from a real blue overhead to milk at the skyline instead of
       * flattening to one wash. Nothing here is a second haze model: the horizon
       * probe, the aerial-perspective in-scatter, the cloud ambient reference and
       * the exposure meter all read this same number through sampleSkyRadiance().
       * The meter DOES see the lift (averageLuminance is 55% horizon) and gives
       * ~0.7 stop of it back at adaptation 0.72 — measured, the foreground in
       * `wide` drops ~7 luma, which is the sky-to-ground separation the review
       * asked for, not a bug.
       */
      uHazeMulti: { value: opts.hazeMulti ?? 6.2 },
      uMieG: { value: opts.mieG ?? 0.76 },
      /** Aerosol loading; 2.4 = clean air and is the normalisation reference. */
      uTurbidity: { value: opts.turbidity ?? 2.7 },
      uGroundColour: { value: new THREE.Vector3(0.14, 0.13, 0.11) },
      uIntensity: { value: opts.intensity ?? 0.21 },
      uMaxRadiance: { value: opts.maxRadiance ?? 40 },
      uViewAltitude: { value: opts.altitude ?? 220 },

      uSunAngularRadius: { value: 0.0055 },
      // The disc has to be the unambiguously brightest thing in any frame it is
      // in — 26 put it at 5.5 scene units, level with a sunlit cloud, so the
      // bloom could not tell them apart. 220 lands it at ~21 after the soft
      // ceiling — comfortably the hottest thing in any frame — and the post
      // stack's firefly clamp is what bounds its bloom contribution.
      uSunDiscIntensity: { value: opts.sunDiscIntensity ?? 220 },

      uCloudCoverage: { value: opts.cloudCoverage ?? 0.42 },
      uCloudDensity: { value: opts.cloudDensity ?? 0.95 },
      uCloudBase: { value: opts.cloudBase ?? 1750 },
      // NOTE: weather/weather.js overrides this per state (dry = 1450), so this
      // default is only live for the handful of frames before the first
      // setState. Do not tune the look here — tune it there.
      uCloudThickness: { value: opts.cloudThickness ?? 1500 },
      uCloudScale: { value: opts.cloudScale ?? 1.0 },
      uCloudOffset: { value: new THREE.Vector3() },
      uCloudAbsorption: { value: opts.cloudAbsorption ?? 0.0055 },
      // CLOUD RADIANCE. Scattering albedo scale on the direct term. The march is
      // energy conserving (S * (1 - T), saturating at S), so an opaque sunlit
      // face reaches sunTransmittance * uSunIrradiance * gain * phaseSum and no
      // more — and `uCloudContrast` puts a hard soft-ceiling on top of that.
      // Historical note, because this is where a catastrophic bug lived: the old
      // source term divided by the extinction, cancelling density and leaving a
      // single-scattering albedo of 1 / uCloudAbsorption = 182. Sunlit cumulus
      // left the shader at 4-24 radiance against a 0.18 sky and whited out every
      // frame that contained the sun. Nothing in this file may reintroduce an
      // unbounded source term.
      uCloudGain: { value: opts.cloudGain ?? 0.52 },
      /** Fraction of the sky's own radiance a cloud parcel scatters back. <= 1. */
      uCloudAmbient: { value: opts.cloudAmbient ?? 1.00 },
      /** Hard ceiling on cloud radiance as a multiple of the brightest sky probe. */
      uCloudContrast: { value: opts.cloudContrast ?? 3.4 },
      /** How hard the detail octaves carve the silhouette. 0 = smooth blobs. */
      uCloudErosion: { value: opts.cloudErosion ?? 1.0 },
      uSkyZenith: { value: new THREE.Vector3(0.12, 0.2, 0.38) },
      uSkyHorizon: { value: new THREE.Vector3(0.5, 0.6, 0.75) },

      // HIGH CIRRUS — the second altitude. One analytic slab at 8.6 km, so the
      // frame has cumulus at 1.75 km AND ice cloud five times higher up, which
      // is what stops a sky reading as one painted band. Opacity is deliberately
      // low: a cirrus veil is optically thin (od < 1) and must never compete
      // with a cumulus crown for brightness.
      uCirrusHeight: { value: opts.cirrusHeight ?? 8600 },
      // 0.50, not 0.62 — this is now the amount for the LOWER of two ice sheets
      // and the upper one adds 0.74x of it again (see the composite in main()).
      // Left at 0.62 the two tiers together closed the dome into a veil.
      uCirrusAmount: { value: opts.cirrusAmount ?? 0.50 },
      uCirrusOpacity: { value: opts.cirrusOpacity ?? 0.50 },
      // Direct-scattering albedo scale for the ice sheet. See `shadeCirrus` —
      // this is what makes the veil read as white cloud rather than as a 4%
      // tint on the sky it is sitting in front of.
      uCirrusGain: { value: opts.cirrusGain ?? 0.20 },

      uDitherFrame: { value: 0 },

      uNight: { value: 0 },
      uMoonDir: { value: new THREE.Vector3(-0.4, 0.6, 0.7).normalize() },
      uMoonIntensity: { value: 14 },
    };

    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      // CLOUD_DS_FRAC is the stride as a fraction of the layer thickness — the
      // number that has to stay below the vertical noise wavelength or the deck
      // quantises into slabs. 0.053 gives ~19 samples through a 1500 m layer.
      // CLOUD_LOD_RATE grows it by 1 unit per 9 km of distance (a projected
      // footprint LOD), and CLOUD_STEPS has to be large enough that the 2.4x
      // empty-space skip can still cross CLOUD_RANGE of clear air.
      defines: {
        ATMO_STEPS: 16, ATMO_LIGHT_STEPS: 5,
        CLOUD_STEPS: 128, CLOUD_LIGHT_STEPS: 6,
        // CLOUD_RANGE must cover the whole chord a GRAZING ray cuts through the
        // slab, because the aerial fade no longer completes and can no longer
        // hide a march cut-off. From 220 m the tangent ray meets the 1.8 km base
        // at ~98 km and leaves the 3.25 km top at ~200 km, so the chord is
        // ~105 km. It costs nothing: those rays are travelling through cloud, so
        // the transmittance break fires long before the range does.
        // CLOUD_SKIP_MAX caps the slab-aware EMPTY-SPACE stride multiplier (see
        // marchClouds). 6 x 2.2 x 77 m = a 1.0 km probe spacing on a grazing ray,
        // which is still inside the 2.5 km wavelength of the base silhouette.
        CLOUD_DS_FRAC: '0.053', CLOUD_LOD_RATE: '0.000111', CLOUD_RANGE: '116000.0',
        CLOUD_SKIP_MAX: '2.6',
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      // DEPTH-TESTED, AND DRAWN LAST. The vertex shader already emits
      // `gl_Position = p.xyww`, i.e. depth exactly 1, so a LEQUAL test against a
      // depth buffer the opaque pass has already filled is exactly equivalent to
      // drawing the sky first with the test off — except that every pixel the
      // world covers is now rejected before the fragment runs. That matters
      // here and nowhere else in the tree: this shader is a 128-step cloud
      // raymarch with a 6-step light march inside it, and with the test off it
      // was being evaluated for all 2.07 M pixels of a 1080p frame including the
      // ~60 % of them that a chase or cockpit view fills with car and tarmac.
      depthTest: true,
      fog: false,
      toneMapped: true,
    });

    // A cheap twin used only for the PMREM bake. It shares the uniform OBJECTS
    // (not a clone), so the two can never drift out of sync, but compiles with
    // a much lower step count — the irradiance integral does not care.
    this.envMaterial = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      defines: {
        ATMO_STEPS: 10, ATMO_LIGHT_STEPS: 3,
        CLOUD_STEPS: 26, CLOUD_LIGHT_STEPS: 2,
        CLOUD_DS_FRAC: '0.34', CLOUD_LOD_RATE: '0.000200', CLOUD_RANGE: '40000.0',
        CLOUD_SKIP_MAX: '4.0',
      },
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      depthTest: false,
      fog: false,
      toneMapped: false,
    });

    const geo = new THREE.BoxGeometry(2, 2, 2);
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    // Opaque list, LAST — the whole point of the depth test above. It stays in
    // the opaque list (the material is not transparent), so it is still drawn
    // before rain and particles, which is where they belong.
    this.mesh.renderOrder = 1000;
    this.mesh.name = 'Sky';
    // The prepass writes view normals and screen velocity; the sky has neither,
    // and it used to be excluded by its negative renderOrder. Say so explicitly
    // now that the order has moved. See postfx `_renderGBuffer`.
    this.mesh.userData.excludeFromGBuffer = true;

    this.envMesh = new THREE.Mesh(geo, this.envMaterial);
    this.envMesh.frustumCulled = false;
    this.envMesh.name = 'SkyEnv';

    /** Unit vector origin -> sun. Read-only for consumers. */
    this.sunDirection = this.uniforms.uSunDir.value;

    this.windSpeed = opts.windSpeed ?? 9.0;   // metres/second of cloud drift
    this.time = 0;
    this.northOffset = opts.northOffset ?? 118;
    this.timeOfDay = 15.2;
    this.preset = 'afternoon';
    this.turbidity = 2.7;

    /** Cached radiance probes, refreshed whenever the sky changes. */
    this.zenithRadiance = new THREE.Color();
    this.horizonRadiance = new THREE.Color();
    this.sunHazeRadiance = new THREE.Color();
    this.sunTransmittance = new THREE.Color(1, 1, 1);
    this._dirty = true;

    this.setTimeOfDay(opts.timeOfDay ?? 15.2);
  }

  // -- sun placement --------------------------------------------------------

  /** Position the sun from elevation/azimuth in DEGREES. */
  setSun(elevationDeg, azimuthDeg) {
    const phi = THREE.MathUtils.degToRad(90 - elevationDeg);
    const theta = THREE.MathUtils.degToRad(azimuthDeg);
    this.uniforms.uSunDir.value.setFromSphericalCoords(1, phi, theta);
    this.elevation = elevationDeg;
    this.azimuth = azimuthDeg;
    this._afterSunMove();
    return this;
  }

  /**
   * Set clock time (0..24) using real solar geometry for a 45-degree latitude
   * summer day, then retune air clarity for the elevation.
   */
  setTimeOfDay(hours) {
    this.timeOfDay = ((hours % 24) + 24) % 24;
    const H = THREE.MathUtils.degToRad((this.timeOfDay - 12) * 15);
    const sinEl =
      Math.sin(DECLINATION) * Math.sin(LATITUDE) +
      Math.cos(DECLINATION) * Math.cos(LATITUDE) * Math.cos(H);
    const el = Math.asin(THREE.MathUtils.clamp(sinEl, -1, 1));
    const cosEl = Math.max(1e-4, Math.cos(el));
    let cosA = (Math.sin(DECLINATION) - Math.sin(el) * Math.sin(LATITUDE)) / (cosEl * Math.cos(LATITUDE));
    cosA = THREE.MathUtils.clamp(cosA, -1, 1);
    // Azimuth from north, mirrored about solar noon.
    let az = THREE.MathUtils.radToDeg(Math.acos(cosA));
    if (H > 0) az = 360 - az;
    // Thicker, hazier air near the horizon; ozone does the twilight colour, so
    // turbidity only has to handle the dust/aerosol part. This has to be set
    // BEFORE setSun(), because setSun triggers the radiance probe refresh and
    // the probes now read the aerosol loading.
    const low = THREE.MathUtils.clamp(1 - THREE.MathUtils.radToDeg(el) / 25, 0, 1);
    this.turbidity = 2.4 + low * 2.2;
    this.uniforms.uTurbidity.value = this.turbidity;
    this.uniforms.uMieG.value = 0.74 + low * 0.06;

    this.setSun(THREE.MathUtils.radToDeg(el), az + this.northOffset);
    return this;
  }

  /**
   * Apply a named look from `TIME_OF_DAY`. Returns the preset so the caller can
   * read `ev` (exposure compensation in stops) if it wants to.
   */
  setPreset(name) {
    const p = TIME_OF_DAY[name];
    if (!p) return null;
    this.preset = name;
    this.setTimeOfDay(p.hour);
    this.setClouds({ coverage: p.coverage, density: p.density });
    this.exposureCompensation = p.ev;
    return p;
  }

  /** Cloud layer controls; `weather/weather.js` drives these. */
  setClouds({ coverage, density, scale, base, thickness, height,
              gain, ambient, contrast, erosion,
              cirrus, cirrusHeight, cirrusOpacity } = {}) {
    const u = this.uniforms;
    if (cirrus !== undefined) u.uCirrusAmount.value = cirrus;
    if (cirrusHeight !== undefined) u.uCirrusHeight.value = cirrusHeight;
    if (cirrusOpacity !== undefined) u.uCirrusOpacity.value = cirrusOpacity;
    if (coverage !== undefined) u.uCloudCoverage.value = coverage;
    if (density !== undefined) u.uCloudDensity.value = density;
    if (scale !== undefined) u.uCloudScale.value = scale;
    if (base !== undefined) u.uCloudBase.value = base;
    // Legacy key: the old API used a unitless "height" multiplier.
    if (height !== undefined && base === undefined) u.uCloudBase.value = 1200 + height * 1400;
    if (thickness !== undefined) u.uCloudThickness.value = thickness;
    if (gain !== undefined) u.uCloudGain.value = gain;
    if (ambient !== undefined) u.uCloudAmbient.value = ambient;
    if (contrast !== undefined) u.uCloudContrast.value = contrast;
    if (erosion !== undefined) u.uCloudErosion.value = erosion;
    this._dirty = true;
    return this;
  }

  // -- derived lighting quantities -----------------------------------------

  _afterSunMove() {
    this._dirty = true;
    const y = this.sunDirection.y;
    // Night ramps in once the sun is a few degrees down (civil twilight).
    this.uniforms.uNight.value = THREE.MathUtils.clamp((-y - 0.02) / 0.16, 0, 1);
    // Keep the moon roughly opposite the sun so night races are cross-lit.
    this.uniforms.uMoonDir.value.set(-this.sunDirection.x, Math.max(0.35, -y * 0.8 + 0.4), -this.sunDirection.z).normalize();
    this._refreshProbes();
  }

  /** Re-evaluate the JS atmosphere for the handful of directions we light with. */
  _refreshProbes() {
    const sun = this.sunDirection;
    const alt = this.uniforms.uViewAltitude.value;
    const irr = this.uniforms.uSunIrradiance.value;
    const ms = this.uniforms.uMultiScatter.value;
    const g = this.uniforms.uMieG.value;
    const haze = this.uniforms.uHazeMulti.value;
    const opts = { altitude: alt, irradiance: irr, multiScatter: ms, mieG: g, turbidity: this.turbidity, hazeMulti: haze };

    sampleSkyRadiance(_v3.set(0, 1, 0), sun, opts, this.zenithRadiance);

    // Horizon average: four cardinal directions relative to the sun azimuth.
    const sx = sun.x, sz = sun.z;
    const len = Math.hypot(sx, sz) || 1;
    const ax = sx / len, az = sz / len;
    const tmp = new THREE.Color();
    this.horizonRadiance.setRGB(0, 0, 0, THREE.LinearSRGBColorSpace);
    const dirs = [
      [ax, 0.09, az], [-ax, 0.09, -az], [-az, 0.09, ax], [az, 0.09, -ax],
    ];
    for (const d of dirs) {
      sampleSkyRadiance(_v3.set(d[0], d[1], d[2]).normalize(), sun, opts, tmp);
      this.horizonRadiance.add(tmp);
    }
    this.horizonRadiance.multiplyScalar(0.25);

    // The bright lobe just above the sun — the colour aerial perspective picks
    // up when you look into the light.
    sampleSkyRadiance(_v3.set(ax, 0.14, az).normalize(), sun, opts, this.sunHazeRadiance);

    atmosphereTransmittance(alt, sun.y, opts, this.sunTransmittance);
    this._dirty = false;

    const zen = this.zenithRadiance;
    const hor = this.horizonRadiance;
    this.uniforms.uSkyZenith.value.set(zen.r, zen.g, zen.b);
    this.uniforms.uSkyHorizon.value.set(hor.r, hor.g, hor.b);
  }

  /**
   * Direct sunlight colour (linear, normalised to peak 1) — the real
   * atmospheric transmittance along the sun ray, so sunsets redden correctly
   * instead of being faked with a gradient.
   */
  sunColour(target = new THREE.Color()) {
    if (this._dirty) this._refreshProbes();
    const t = this.sunTransmittance;
    const m = Math.max(t.r, t.g, t.b, 1e-5);
    return target.setRGB(t.r / m, t.g / m, t.b / m, THREE.LinearSRGBColorSpace);
  }

  /**
   * Relative direct-sun brightness, 0 at/below the horizon and 1 with the sun
   * overhead. This is the luminous transmittance, not a curve fit — it already
   * includes the horizon extinction, so the key light dims correctly at dusk.
   */
  sunIntensity() {
    if (this.sunDirection.y <= 0.0) return 0;
    if (this._dirty) this._refreshProbes();
    const t = this.sunTransmittance;
    const lum = 0.2126 * t.r + 0.7152 * t.g + 0.0722 * t.b;
    // Cosine falloff of the disc plus extinction, normalised to ~1 at zenith.
    return THREE.MathUtils.clamp(lum * 1.06, 0, 1);
  }

  /** Ambient sky tint for the hemisphere fill and fog: hue-accurate, unit level. */
  skyColour(target = new THREE.Color()) {
    if (this._dirty) this._refreshProbes();
    target.copy(this.zenithRadiance).lerp(this.horizonRadiance, 0.55);
    const m = Math.max(target.r, target.g, target.b, 1e-5);
    return target.multiplyScalar(1 / m);
  }

  /**
   * Average sky radiance in the SAME scene-referred units the sky mesh emits
   * (i.e. after `uIntensity`). The exposure meter and the ambient balance both
   * read this, so it has to be the number the renderer actually sees.
   */
  averageLuminance() {
    if (this._dirty) this._refreshProbes();
    const z = this.zenithRadiance, h = this.horizonRadiance;
    const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    return (0.45 * lum(z) + 0.55 * lum(h)) * this.uniforms.uIntensity.value;
  }

  update(dt) {
    this.time += dt;
    const d = this.time * this.windSpeed;
    this.uniforms.uCloudOffset.value.set(d, 0, d * 0.42);
    // Slide the IGN dither one frame along its own sequence. The pattern has a
    // period of 64, and `postfx`'s TAA resolve keeps ~10 frames of history, so
    // what is left of the march quantisation averages out instead of being a
    // fixed grain locked to the screen.
    this.uniforms.uDitherFrame.value = (this.uniforms.uDitherFrame.value + 1) % 64;
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.envMaterial.dispose();
  }
}

// ---------------------------------------------------------------------------
// JS mirror of the GLSL atmosphere
// ---------------------------------------------------------------------------

function densities(h, mie) {
  return [
    Math.exp(-h / H_RAYLEIGH),
    Math.exp(-h / H_MIE) * mie,
    Math.max(0, 1 - Math.abs(h - 25000) / 15000),
  ];
}

function extinctionOf(od, out) {
  for (let i = 0; i < 3; i++) {
    out[i] = Math.exp(-(BETA_R[i] * od[0] + BETA_M_E[i] * od[1] + BETA_O[i] * od[2]));
  }
  return out;
}

function sphereFar(ox, oy, oz, dx, dy, dz, r) {
  const b = ox * dx + oy * dy + oz * dz;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - c;
  if (disc < 0) return -1;
  return -b + Math.sqrt(disc);
}

function sphereNear(ox, oy, oz, dx, dy, dz, r) {
  const b = ox * dx + oy * dy + oz * dz;
  const c = ox * ox + oy * oy + oz * oz - r * r;
  const disc = b * b - c;
  if (disc < 0) return -1;
  return -b - Math.sqrt(disc);
}

const _od = [0, 0, 0];
const _ex = [0, 0, 0];
const _ts = [0, 0, 0];

function transmittanceAt(px, py, pz, dx, dy, dz, steps, out, mie = 1) {
  if (sphereNear(px, py, pz, dx, dy, dz, R_GROUND) > 0) { out[0] = out[1] = out[2] = 0; return out; }
  const t = sphereFar(px, py, pz, dx, dy, dz, R_TOP);
  if (t <= 0) { out[0] = out[1] = out[2] = 1; return out; }
  const ds = t / steps;
  _od[0] = _od[1] = _od[2] = 0;
  for (let i = 0; i < steps; i++) {
    const s = (i + 0.5) * ds;
    const qx = px + dx * s, qy = py + dy * s, qz = pz + dz * s;
    const d = densities(Math.hypot(qx, qy, qz) - R_GROUND, mie);
    _od[0] += d[0] * ds; _od[1] += d[1] * ds; _od[2] += d[2] * ds;
  }
  return extinctionOf(_od, out);
}

/**
 * Transmittance of the whole atmosphere along the sun ray from `altitude`.
 * Used for the key-light colour.
 */
export function atmosphereTransmittance(altitude, sunY, opts = {}, target = new THREE.Color()) {
  const oy = R_GROUND + altitude;
  const dy = sunY;
  const dh = Math.sqrt(Math.max(0, 1 - dy * dy));
  const out = [1, 1, 1];
  transmittanceAt(0, oy, 0, dh, dy, 0, 8, out, (opts.turbidity ?? 2.4) / 2.4);
  return target.setRGB(out[0], out[1], out[2], THREE.LinearSRGBColorSpace);
}

/**
 * Sky radiance along `dir` — the JS twin of `atmosphereRadiance()` in the
 * shader. Cheap enough to call a handful of times whenever the sky changes.
 */
export function sampleSkyRadiance(dir, sun, opts = {}, target = new THREE.Color()) {
  const steps = opts.steps ?? 12;
  const lightSteps = opts.lightSteps ?? 4;
  const irr = opts.irradiance ?? 22;
  const ms = opts.multiScatter ?? 1.35;
  const g = opts.mieG ?? 0.76;
  const alt = opts.altitude ?? 220;
  const mie = (opts.turbidity ?? 2.4) / 2.4;

  const ox = 0, oy = R_GROUND + alt, oz = 0;
  const dx = dir.x, dy = dir.y, dz = dir.z;

  let tMax = sphereFar(ox, oy, oz, dx, dy, dz, R_TOP);
  const tg = sphereNear(ox, oy, oz, dx, dy, dz, R_GROUND);
  if (tg > 0) tMax = Math.min(tMax, tg);

  const mu = dx * sun.x + dy * sun.y + dz * sun.z;
  const pr = (3 / (16 * Math.PI)) * (1 + mu * mu);
  const g2 = g * g;
  const pm = (1 / (4 * Math.PI)) * ((1 - g2) / Math.pow(Math.max(1 + g2 - 2 * g * mu, 1e-4), 1.5));

  const sumR = [0, 0, 0];
  const sumM = [0, 0, 0];
  const od = [0, 0, 0];
  let prev = 0;
  for (let i = 0; i < steps; i++) {
    const f1 = (i + 1) / steps;
    const t1 = tMax * f1 * f1;
    const seg = t1 - prev;
    const s = prev + seg * 0.5;
    prev = t1;
    const px = ox + dx * s, py = oy + dy * s, pz = oz + dz * s;
    const d = densities(Math.hypot(px, py, pz) - R_GROUND, mie);
    od[0] += d[0] * seg; od[1] += d[1] * seg; od[2] += d[2] * seg;
    extinctionOf(od, _ex);
    transmittanceAt(px, py, pz, sun.x, sun.y, sun.z, lightSteps, _ts, mie);
    for (let c = 0; c < 3; c++) {
      sumR[c] += d[0] * seg * _ex[c] * _ts[c];
      sumM[c] += d[1] * seg * _ex[c] * _ts[c];
    }
  }

  const out = [0, 0, 0];
  // Same spectrally flat aerosol multiple-scattering term as the GLSL — see the
  // long note at `multi` in atmosphereRadiance(). It has to be here too or the
  // horizon PROBE (and therefore the fog colour, the cloud ambient reference and
  // the exposure meter) would describe a sky the camera is not looking at.
  const haze = opts.hazeMulti ?? 6.2;
  for (let c = 0; c < 3; c++) {
    const single = sumR[c] * BETA_R[c] * pr + sumM[c] * BETA_M_S[c] * pm;
    const multi = (sumR[c] * BETA_R[c] + sumM[c] * BETA_M_S[c] * 0.5) * (ms / (4 * Math.PI))
      + sumM[c] * (BETA_M_S[1] * haze / (4 * Math.PI));
    out[c] = (single + multi) * irr;
  }
  return target.setRGB(out[0], out[1], out[2], THREE.LinearSRGBColorSpace);
}
