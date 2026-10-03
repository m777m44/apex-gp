/**
 * APEX GP — weather, wet track, rain and spray.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS OWNS
 *
 *   1. The weather STATE MACHINE — six named states with continuous, smoothly
 *      interpolated parameters, driving the sky (cloud deck + sky radiance),
 *      the key light, the IBL intensity, the metered exposure trim and the
 *      aerial-perspective haze.
 *   2. The WATER FIELD — a real 2-D simulation of standing water over the
 *      racing surface, in (arc length x lane) space, published to the GPU as a
 *      world-projected map. Rain fills it, the sun and wind evaporate it, and
 *      cars WIPE it: that, plus the fact that low points hold water and a crown
 *      does not, is what produces a drying line and puddles that live in the
 *      actual dips of the road mesh rather than in a noise texture.
 *   3. The WET-ASPHALT SHADER — injected into `track/asphalt` (and a cheaper
 *      uniform-only version on the kerbs/lines/run-off/pit lane). Water darkens
 *      the albedo hard, collapses roughness, flattens the aggregate normal and
 *      lets the sky reflect; puddles go further and get wind ripple + rain
 *      impact rings.
 *   4. RAIN — instanced screen-space streaks. Each drop is a world-space
 *      segment `p -> p + (v_rain - v_camera) * shutter`, projected and
 *      extruded, so the streaks lengthen and rake backwards exactly as the car
 *      accelerates. Three concentric shells give near/mid/far density.
 *   5. SPRAY — the rooster tail. A CPU-integrated pool of instanced billboards
 *      emitted from the contact patches, lit with a forward-scattering phase
 *      function so a backlit plume glows the way it does on television.
 *      The same pool serves flat tarmac splash crowns.
 *   6. MIST BANKS — drifting ground-hugging sheets, plus a ground-hugging
 *      remap of the shared aerial-perspective height falloff.
 *   7. VISOR — camera-attached droplet/streak layer for cockpit and halo.
 *   8. The GRIP MODEL — wet grip, water drag and an aquaplaning hook for
 *      `physics/vehicle.js`.
 *
 * ---------------------------------------------------------------------------
 * WHY THE WATER FIELD IS IN TRACK SPACE BUT THE TEXTURE IS IN WORLD SPACE
 *
 * The simulation wants (s, lateral): "how much has the racing line been swept
 * here" is a track-space question. The shader only has a world position — the
 * road material is not mine and I cannot add a vertex attribute to it. So the
 * field is simulated in track space and SPLATTED once into a world-XZ grid,
 * with a static cell -> (sample, lane) index built at boot. Publishing is then
 * a flat copy over the ~10k cells that are actually on the road.
 *
 * ---------------------------------------------------------------------------
 * EXPOSURE DISCIPLINE
 *
 * The exposure/bloom calibration in `postfx.js` + `lighting.js` reasons about
 * ABSOLUTE scene-referred radiance (diffuse white ~1.0, bloom threshold 1.25).
 * Nothing here is allowed to break that:
 *   - an overcast deck dims `sky.uIntensity` as well as raising the cloud
 *     coverage, so the metered exposure does not simply climb to compensate
 *     for a dark ground and blow the sky out;
 *   - the wet road reflects the sky through ordinary Fresnel, so it can
 *     approach sky radiance at grazing angles but never exceed it;
 *   - rain, spray, mist and visor droplets are all authored to peak below 1.0
 *     exposed, so none of them cross the bloom threshold on their own.
 *
 * ---------------------------------------------------------------------------
 * PUBLIC API
 *
 *   new Weather({ sky, lighting, circuit, scene, camera, rig, particles,
 *                 carMaterials, trackMaterial })
 *   weather.setState(name, { immediate, transition })
 *   weather.update(dt, cars, focus)
 *   weather.wetness / weather.rain / weather.label / weather.state
 *   weather.gripAt(s, lateral)            -> 0..1  (Vehicle.surfaceProbe)
 *   weather.probe(s, lateral, speed)      -> { grip, drag, water, aquaplane }
 *   weather.waterDepthAt(s, lateral)      -> 0..1 (1 == standing water)
 *   weather.aquaplaneRisk(s, lateral, v)  -> 0..1
 *   weather.drynessAt(s, lateral)         -> 0..1
 *   weather.dryness                       -> Float32Array, per circuit sample
 *   weather.trackWetnessTexture           -> DataTexture (u = s / length)
 *   weather.wetMapTexture                 -> DataTexture (world XZ projection)
 *   WEATHER_STATES / WEATHER_ORDER
 */

import * as THREE from 'three';
import { clamp, lerp, smoothstep, makeRng, hashSeed } from '../core/rng.js';
import { assets } from '../core/assets.js';

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

/**
 * Every field is a continuously interpolated target — there is no discrete
 * switch anywhere downstream, so a transition between any two states is valid.
 *
 *  wetness       0..1 how much water the sky is putting on the road
 *  rain          0..1 precipitation rate (drives streaks, ripples, spray)
 *  windSpeed     m/s at track level
 *  cloud*        the sky's cumulus/stratus deck
 *  skyDim        multiplier on sky.uIntensity — a thick deck is a dark sky
 *  sunScale      multiplier on the key light
 *  envScale      MULTIPLIER on lighting.baseEnvironmentIntensity (the IBL's
 *                share of the illuminance) — a ratio, never an absolute
 *  fogScale      multiplier on lighting.aerialStrength — SEE THE NOTE BELOW
 *  mist          0..1 ground mist banks + how ground-hugging the haze is
 *  ev            exposure trim in stops (fed through sky.exposureCompensation)
 *  lineSwept     0..1 how established the drying line is when this state is
 *                seeded immediately (a capture has no time to accumulate laps)
 *
 * ---------------------------------------------------------------------------
 * WHY THE WET STATES HAVE fogScale < 1
 *
 * `core/engine.js` already drives `scene.fog.density` from `weather.rain`:
 *
 *     density = 0.00030 + (1 - sunUp) * 0.00035 + rain * 0.0020
 *
 * so heavy rain multiplies the fog density by 7.7x on its own, and the aerial
 * perspective integral is `1 - exp(-air * density * aerialStrength)` — the two
 * numbers MULTIPLY. Leaving fogScale above 1 on top of that took the effective
 * extinction to 10.4x dry, which measured out as a track p05 of 0.35 and a p50
 * of 0.53 at 150 m: the frame lost every black and every trace of colour, and
 * a `wide` shot was uniform milk from the kerb to the horizon. These values are
 * chosen so the PRODUCT lands where I want it — heavy rain ~3.6x the dry
 * extinction, light rain ~2.0x — which is a genuinely murky day that you can
 * still see a braking zone through.
 */
export const WEATHER_STATES = {
  dry: {
    label: 'DRY', wetness: 0.0, rain: 0.0, windSpeed: 3.5,
    cloudCoverage: 0.34, cloudDensity: 0.92, cloudBase: 1800, cloudThickness: 1450,
    deck: 0.0, deckLum: 0.36, deckBreak: 1.0,
    skyDim: 1.0, sunScale: 1.0, envScale: 1.0, fogScale: 1.0, mist: 0.0, ev: 0.0,
    lineSwept: 0.0,
  },
  lightCloud: {
    label: 'LIGHT CLOUD', wetness: 0.0, rain: 0.0, windSpeed: 5.0,
    cloudCoverage: 0.58, cloudDensity: 1.02, cloudBase: 1650, cloudThickness: 1650,
    deck: 0.30, deckLum: 0.32, deckBreak: 0.86,
    skyDim: 0.98, sunScale: 0.84, envScale: 1.00, fogScale: 1.05, mist: 0.04, ev: -0.03,
    lineSwept: 0.0,
  },
  overcast: {
    label: 'OVERCAST', wetness: 0.0, rain: 0.0, windSpeed: 6.5,
    cloudCoverage: 0.62, cloudDensity: 1.10, cloudBase: 1150, cloudThickness: 1800,
    deck: 0.97, deckLum: 0.250, deckBreak: 0.16,
    skyDim: 0.92, sunScale: 0.32, envScale: 1.12, fogScale: 1.10, mist: 0.12, ev: -0.04,
    lineSwept: 0.0,
  },
  lightRain: {
    label: 'LIGHT RAIN', wetness: 0.52, rain: 0.34, windSpeed: 8.0,
    cloudCoverage: 0.60, cloudDensity: 1.15, cloudBase: 980, cloudThickness: 1900,
    deck: 1.0, deckLum: 0.220, deckBreak: 0.05,
    skyDim: 0.88, sunScale: 0.22, envScale: 1.15, fogScale: 0.61, mist: 0.20, ev: -0.26,
    lineSwept: 0.60,
  },
  heavyRain: {
    label: 'HEAVY RAIN', wetness: 1.0, rain: 1.0, windSpeed: 10.0,
    cloudCoverage: 0.55, cloudDensity: 1.20, cloudBase: 780, cloudThickness: 2000,
    deck: 1.0, deckLum: 0.185, deckBreak: 0.0,
    skyDim: 0.82, sunScale: 0.15, envScale: 1.22, fogScale: 0.47, mist: 0.34, ev: -0.38,
    lineSwept: 0.34,
  },
  drying: {
    label: 'DRYING', wetness: 0.30, rain: 0.0, windSpeed: 7.0,
    cloudCoverage: 0.66, cloudDensity: 1.08, cloudBase: 1400, cloudThickness: 1750,
    deck: 0.62, deckLum: 0.290, deckBreak: 0.45,
    skyDim: 0.95, sunScale: 0.58, envScale: 0.96, fogScale: 1.08, mist: 0.10, ev: -0.45,
    lineSwept: 1.0,
  },
};

/** Wettest-last ordering, for UI and for "the weather is deteriorating" logic. */
export const WEATHER_ORDER = ['dry', 'lightCloud', 'overcast', 'drying', 'lightRain', 'heavyRain'];

/** Legacy names from the first cut of this module; still honoured everywhere. */
const ALIASES = {
  cloudy: 'lightCloud',
  damp: 'drying',
  wet: 'lightRain',
  storm: 'heavyRain',
  rain: 'lightRain',
};

const resolveState = (name) => (WEATHER_STATES[name] ? name : (ALIASES[name] ?? 'dry'));

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Lanes across the paved envelope in the water simulation. */
const LANES = 21;
/** Lateral half-extent of the lane grid, in half-widths. */
const LANE_SPAN = 1.10;
/** Target resolution of the published world map (per side). */
const MAP_MAX = 1024;
/** Seconds between GPU publishes of the world map. */
const MAP_PERIOD = 1 / 4;

const MAX_RAIN = 16000;
const MAX_SPRAY = 18000;
const MIST_BANKS = 72;

// Module-level scratch — nothing in the per-frame path allocates.
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _rgt = new THREE.Vector3();
const _col = new THREE.Color();
const _col2 = new THREE.Color();
const _prevCam = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Shared GLSL
// ---------------------------------------------------------------------------

const HASH_GLSL = /* glsl */ `
vec3 wHash3( float n ) {
  vec3 p = fract( vec3( n * 0.1031, n * 0.11369, n * 0.13787 ) );
  p += dot( p, p.yzx + 19.19 );
  return fract( vec3( ( p.x + p.y ) * p.z, ( p.x + p.z ) * p.y, ( p.y + p.z ) * p.x ) );
}
float wHash1( float n ) { return fract( sin( n * 127.1 ) * 43758.5453 ); }
`;

// ---------------------------------------------------------------------------
// Wet-asphalt shader fragments (injected into the track material)
// ---------------------------------------------------------------------------

const WET_DECL = /* glsl */ `
uniform sampler2D uWetMap;
uniform vec4  uWetMapXform;     // xy = world origin, z = 1/extent, w = unused
uniform float uWetGlobal;       // 0..1 TRANSITION FADE only — see note in _applyMaterials
uniform float uWetTime;
uniform float uWetRain;         // 0..1 ripple strength
uniform vec2  uWetWind;
uniform float uWetPuddle;       // 0..1 how much standing water is allowed

float wetHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }

float wetNoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  float a = wetHash( i ), b = wetHash( i + vec2( 1.0, 0.0 ) );
  float c = wetHash( i + vec2( 0.0, 1.0 ) ), d = wetHash( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
}

/**
 * Rain impact rings. Two octaves of a jittered grid of expanding, decaying
 * circular waves; returns a slope (dz/dx, dz/dy) to add to the tangent normal.
 */
vec2 wetRipple( vec2 p, float t ) {
  vec2 acc = vec2( 0.0 );
  for ( int i = 0; i < 2; i ++ ) {
    float fi = float( i );
    vec2 q = p * ( 2.3 + fi * 3.1 ) + fi * 13.7;
    vec2 c = floor( q );
    vec2 f = fract( q ) - 0.5;
    float h = wetHash( c + fi * 37.0 );
    float phase = fract( t * ( 1.25 + h * 0.6 ) + h );
    float r = length( f ) + 1e-4;
    float ring = sin( r * 46.0 - phase * 46.0 );
    float env = exp( -r * 7.5 ) * ( 1.0 - phase ) * ( 1.0 - smoothstep( 0.30, 0.50, r ) );
    acc += ( f / r ) * ring * env;
  }
  return acc;
}

/** Wind-driven capillary ripple on standing water. */
vec2 wetWindRipple( vec2 p, float t, vec2 w ) {
  float a = sin( dot( p, vec2( 5.3, 2.1 ) ) + t * 4.0 + w.x * 2.0 );
  float b = sin( dot( p, vec2( -1.9, 6.1 ) ) + t * 5.3 + w.y * 2.0 );
  float c = sin( dot( p, vec2( 8.7, -7.3 ) ) * 0.5 + t * 2.7 );
  return vec2( a * 0.55 + c * 0.25, b * 0.55 - c * 0.25 );
}
`;

/**
 * The body. Runs after `metalnessmap_fragment`, so `diffuseColor`,
 * `roughnessFactor` and (from the circuit's own patch) `apexNrmTexel` are all
 * live, and `normal_fragment_maps` has not consumed the normal yet.
 */
const WET_BODY = /* glsl */ `
  if ( uWetGlobal > 0.001 ) {
    vec2 wuv = ( vWorld.xz - uWetMapXform.xy ) * uWetMapXform.z;
    vec4 wm = texture2D( uWetMap, wuv );
    float mask = wm.a;
    float water = wm.r * mask * uWetGlobal;    // 0..1 film depth
    float basin = wm.g;                        // static low-point potential
    float rubberZone = wm.b * mask;            // braking zones + the laid racing line

    // Laid rubber is BLACKER THAN THE AGGREGATE whether it is wet or not: a
    // rubbered-in line reads as a dark band on a dry track and as the darkest
    // thing on the circuit once it is wet. Applying this outside the film branch
    // is what makes the drying line legible from both directions — a pale dry
    // strip on a dark wet track, and a dark strip on a pale dry one.
    diffuseColor.rgb *= 1.0 - 0.20 * rubberZone;
    roughnessFactor *= 1.0 - 0.13 * rubberZone;

    // Puddle shape: the basin map says WHERE water can gather, two octaves of
    // world noise give it an irregular shoreline, and the depth says whether
    // there is anything in it yet.
    float shore = wetNoise( vWorld.xz * 0.42 ) * 0.62 + wetNoise( vWorld.xz * 1.35 ) * 0.38;
    float fill = smoothstep( 0.16, 0.62, water * ( 0.55 + basin ) );
    float puddle = smoothstep( 0.40, 0.88, basin * ( 0.62 + shore * 0.76 ) ) * fill * uWetPuddle;

    // THE WORLD-SPACE FOOTPRINT OF THIS PIXEL, in metres. Every high-frequency
    // term below has to be faded out against it. This is not an optional polish
    // pass: the ripple field has a 0.19-0.43 m wavelength, so from a broadcast
    // camera 120 m away — where one pixel covers a quarter of a metre — it
    // aliases into a stationary diagonal moire that reads, very convincingly,
    // as DRY AGGREGATE. The wet track looked like grey concrete in every long
    // lens shot for exactly this reason.
    vec2 foot = fwidth( vWorld.xz );
    float footLen = length( foot );
    float sharp = 1.0 - smoothstep( 0.035, 0.30, footLen );

    // A wet surface is a thin water film over the aggregate: the film kills the
    // diffuse albedo (light that used to scatter back out is now trapped by
    // total internal reflection) far more than it changes the specular F0.
    // A tenth of a millimetre is enough — the curve saturates fast.
    // Dry asphalt is ~0.11 albedo, soaked asphalt ~0.05: a factor of ~0.55, and
    // that near-black base is what lets the reflected sky read as a reflection
    // rather than as a sheen on top of grey.
    float film = smoothstep( 0.012, 0.17, water );
    float darken = mix( 1.0, 0.55, film ) * mix( 1.0, 0.80, rubberZone * film );
    diffuseColor.rgb *= darken;
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.0295, 0.0316, 0.0352 ), puddle * 0.88 );

    // Roughness collapses: 1.0 aggregate -> ~0.11 sheen -> ~0.04 open water.
    roughnessFactor = mix( roughnessFactor, 0.155, film * 0.96 );
    roughnessFactor = mix( roughnessFactor, 0.065, puddle );

    // The aggregate normal floods flat. Full flattening at distance too — a
    // residual 8% of a normal map one pixel cannot resolve is pure aliasing.
    apexNrmTexel.xy = mix( apexNrmTexel.xy, vec2( 0.5 ),
      min( 1.0, film * mix( 1.0, 0.92, sharp ) + puddle * 0.08 ) );

    // Surface disturbance: rain rings everywhere there is a film, wind chop on
    // open water only. Both are faded against the pixel footprint.
    vec2 dist = wetRipple( vWorld.xz, uWetTime ) * ( 0.020 * uWetRain * ( film * 0.40 + puddle * 0.60 ) );
    dist += wetWindRipple( vWorld.xz, uWetTime, uWetWind ) * ( 0.007 * puddle * clamp( length( uWetWind ) * 0.09, 0.0, 1.4 ) );
    apexNrmTexel.xy += dist * sharp;

    // Standing water is dielectric; nudge the specular toward water's own F0
    // and keep it non-metallic so the Fresnel curve stays right.
    metalnessFactor = mix( metalnessFactor, 0.0, film );

    // SPECULAR ANTI-ALIASING. A 0.04-roughness lobe over a normal map that
    // still varies per pixel is a glitter generator, and at grazing angles —
    // where a wet track spends most of its screen area — one texel covers
    // metres. Widen the lobe with the world-space footprint so the highlight
    // stays a sheen instead of dissolving into salt and pepper. The ceiling is
    // lower than it was (0.42 turned distant wet tarmac matte, which is the
    // wrong answer: a distant wet road is the MOST mirror-like thing in frame).
    float aa = clamp( footLen * 0.055, 0.0, 0.20 );
    roughnessFactor = clamp( roughnessFactor + aa * ( film * 0.7 + puddle * 0.3 ), 0.03, 1.0 );
  }
`;

// ---------------------------------------------------------------------------
// Overcast stratus deck
// ---------------------------------------------------------------------------

const DECK_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * vec4( mat3( modelViewMatrix ) * position, 1.0 );
  gl_Position = p.xyww;
}
`;

/**
 * WHY THIS EXISTS.
 *
 * `sky.js` raymarches a single-scattering cumulus layer. Single scattering is
 * exactly right for a cumulus — the lit top is bright because sunlight reaches
 * it — and exactly wrong for a nimbostratus deck, where essentially everything
 * you see is light that has scattered ten times inside two kilometres of cloud
 * before leaving the base. Push that model to full coverage and Beer's law
 * takes the direct term to zero, leaving a deck DARKER than the clear sky it
 * replaced. A wet race day is the opposite: the ceiling is the brightest thing
 * in the frame by a wide margin and the ground is nearly black.
 *
 * So the deck is its own surface, composited over the sky and authored in
 * absolute radiance against the same calibration everything else uses:
 * ~0.30-0.55 scene-referred, i.e. a couple of times a diffuse mid-grey and
 * comfortably under the 1.25 bloom threshold. It is added to the PMREM scene
 * as well as the render scene, so the ambient light the world receives comes
 * from the ceiling that is actually above it.
 */
const DECK_FRAG = /* glsl */ `
precision highp float;
varying vec3 vDir;

uniform vec3  uColour;
uniform float uAmount;
uniform float uBase;
uniform vec3  uSunDir;
uniform vec2  uDrift;
uniform float uBreak;      // 0 = solid nimbostratus, 1 = broken/ragged

float dHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float dNoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( dHash( i ), dHash( i + vec2( 1.0, 0.0 ) ), f.x ),
              mix( dHash( i + vec2( 0.0, 1.0 ) ), dHash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}
float dFbm( vec2 p ) {
  float a = 0.5, s = 0.0;
  for ( int i = 0; i < 5; i ++ ) { s += dNoise( p ) * a; p = p * 2.04 + 11.3; a *= 0.5; }
  return s;
}

void main() {
  vec3 d = normalize( vDir );
  if ( d.y <= 0.002 ) { gl_FragColor = vec4( 0.0 ); return; }

  // Where this ray pierces the cloud base, in metres. The 1/y makes the
  // texture converge at the horizon exactly like a real ceiling does.
  vec2 q = ( d.xz / d.y ) * uBase * 0.0032 + uDrift;
  // Sheared along the wind: stratus is drawn out into bands, not popcorn.
  vec2 qs = vec2( q.x * 0.42, q.y * 1.5 );
  float n = dFbm( qs * 0.40 ) * 0.58 + dFbm( qs * 1.7 + 7.0 ) * 0.42;

  // Brightness across the ceiling.
  //
  // This used to run mix(0.52, 1.06, up) — DARK at the horizon. That is the
  // wrong way round and it showed: in an establishing shot, where the top of
  // frame sits only a few degrees above the horizon, the ceiling rendered as a
  // dark grey band directly above a bright hazy skyline, with the city cut into
  // it in white. A real nimbostratus base gets BRIGHTER toward the horizon — the
  // ray traverses far more of it, and far more of the scattering haze underneath
  // it, so it converges to the same pale value the distant landscape does. The
  // deck is drawn with fog off (it is at infinity), so it has to bring its own
  // horizon convergence rather than receive it from the aerial perspective.
  // 0.86 -> 1.02 rather than a full horizon lift: a long lens close to the
  // horizon sees almost nothing but the low end of this ramp, and pushing that
  // end to 1.12 measured out at tv p50 0.651 / p90 0.758 against 0.628 / 0.721
  // here — brighter than the calibration wants for a storm. Flat-with-a-slight-
  // dip is enough to kill the inversion without washing a telephoto shot out.
  float up = smoothstep( 0.0, 0.40, d.y );
  float grad = mix( 0.86, 1.02, up );

  // The bright patch where the sun sits behind the ceiling.
  float sunDot = max( dot( d, uSunDir ), 0.0 );
  float glow = pow( sunDot, 5.0 ) * 0.55 + pow( sunDot, 24.0 ) * 0.9;

  vec3 col = uColour * grad * ( 0.74 + 0.52 * n ) * ( 1.0 + glow );

  // Ragged base: broken cloud lets the sky behind show through.
  float hole = smoothstep( 0.34, 0.78, n );
  float a = uAmount * mix( 1.0, hole, uBreak );
  /**
   * THE FADE OFF THE HORIZON HAS TO BE NARROW.
   *
   * It is tempting to widen it so the ceiling melts gently into the haze — I
   * tried 0.002..0.150 and it made things much worse. Whatever this deck does
   * NOT cover, the sky's own raymarched cloud layer shows through, and at the
   * coverage and density a storm asks for, Beer's law takes that layer to nearly
   * black near the horizon (the reason this deck exists at all — see the note
   * above DECK_FRAG). A wide fade therefore paints a dark band right along the
   * skyline, with the aerial perspective simultaneously fading distant buildings
   * to a pale haze IN FRONT of it: white towers cut into a black sky, which is
   * exactly what an establishing shot showed.
   *
   * So the deck covers essentially all the way down and only releases in the
   * last fraction of a degree, where the horizon geometry has taken over anyway.
   */
  a *= smoothstep( 0.0, 0.022, d.y );

  gl_FragColor = vec4( col, clamp( a, 0.0, 1.0 ) );
}
`;

// ---------------------------------------------------------------------------
// Rain
// ---------------------------------------------------------------------------

const RAIN_VERT = /* glsl */ `
attribute vec2 aCorner;      // x = 0..1 along the streak, y = -1..1 across
attribute float aSeed;
attribute float aShell;      // 0 near, 1 mid, 2 far

uniform vec3  uCamPos;
uniform vec3  uCamVel;
uniform vec3  uWind;
uniform float uTime;
uniform float uFall;
uniform float uShutter;      // seconds of streak
uniform float uMaxStreak;    // metres, hard cap on the swept segment
uniform float uAspect;
uniform float uWidthPx;      // half width at 1 m, in NDC*metres
uniform vec3  uShellSize;    // horizontal box size per shell
uniform float uBoxHeight;
uniform float uDensity;      // 0..1 — instances above this fraction are culled

varying float vAlpha;
varying float vAcross;
varying float vAlong;

${HASH_GLSL}

void main() {
  vec3 h = wHash3( aSeed );
  float shellF = aShell;
  float S = shellF < 0.5 ? uShellSize.x : ( shellF < 1.5 ? uShellSize.y : uShellSize.z );

  // Cull by density without changing the buffer: collapse the quad.
  float keep = step( wHash1( aSeed * 3.77 ), uDensity );

  float fall = uFall * ( 0.78 + h.z * 0.44 );
  float H = uBoxHeight;

  // Horizontal: a static random offset advected by the wind, wrapped into a
  // box that follows the camera. Vertical: a sawtooth so drops recycle.
  vec2 xz = vec2( h.x, h.z ) * S + uWind.xz * uTime;
  float y = H * fract( h.y - uTime * fall / H );

  vec3 p;
  p.x = mod( xz.x - uCamPos.x + 0.5 * S, S ) - 0.5 * S + uCamPos.x;
  p.z = mod( xz.y - uCamPos.z + 0.5 * S, S ) - 0.5 * S + uCamPos.z;
  p.y = y + uCamPos.y - H * 0.34;

  // Streak = the world-space segment the drop sweeps during the shutter,
  // RELATIVE TO THE CAMERA. This is what makes rain rake backwards and
  // lengthen as the car accelerates.
  vec3 vel = vec3( uWind.x, -fall, uWind.z ) - uCamVel;
  // A 200 km/h chase camera turns an unclamped shutter smear into hyperspace.
  // Real onboard rain streaks read as 20-60 cm of travel, so clamp the SEGMENT
  // rather than the shutter: slow cameras keep a natural short streak and fast
  // ones stop growing once the drop has crossed enough screen to read as rain.
  vec3 seg = vel * uShutter;
  float segLen = length( seg );
  seg *= min( 1.0, uMaxStreak / max( segLen, 1e-4 ) );
  vec3 p1 = p + seg;

  vec4 c0 = projectionMatrix * modelViewMatrix * vec4( p, 1.0 );
  vec4 c1 = projectionMatrix * modelViewMatrix * vec4( p1, 1.0 );

  // Behind-camera guard: both endpoints must be in front.
  float valid = step( 0.05, c0.w ) * step( 0.05, c1.w ) * keep;

  vec2 s0 = c0.xy / max( c0.w, 1e-3 );
  vec2 s1 = c1.xy / max( c1.w, 1e-3 );
  vec2 d = ( s1 - s0 ) * vec2( uAspect, 1.0 );
  float L = length( d );
  vec2 dir = L > 1e-5 ? d / L : vec2( 0.0, -1.0 );
  vec2 nrm = vec2( -dir.y, dir.x );

  vec4 c = mix( c0, c1, aCorner.x );
  float dist = max( c.w, 0.3 );
  float halfW = clamp( uWidthPx / dist, 0.0007, 0.010 ) * ( shellF < 0.5 ? 1.35 : 1.0 );
  vec2 off = nrm * halfW * aCorner.y;
  off.x /= uAspect;

  // Culled / behind-camera instances are parked off screen rather than
  // collapsed to w = 0, which would rasterise as NaN on some drivers.
  gl_Position = valid > 0.5
    ? vec4( c.xy + off * c.w, c.z, c.w )
    : vec4( 4.0, 4.0, 4.0, 1.0 );

  // Fade out very close drops (they would be a smear across the lens), far
  // ones, and drops whose streak is too short to read.
  float near = smoothstep( 0.9, 3.2, dist );
  float far = 1.0 - smoothstep( 0.34 * S, 0.55 * S, dist );
  float lenFade = smoothstep( 0.004, 0.03, L );
  vAlpha = near * far * lenFade * ( 0.62 + h.z * 0.38 ) * valid;
  vAcross = aCorner.y;
  vAlong = aCorner.x;
}
`;

const RAIN_FRAG = /* glsl */ `
uniform vec3 uColour;
uniform float uOpacity;
varying float vAlpha;
varying float vAcross;
varying float vAlong;
void main() {
  float a = 1.0 - vAcross * vAcross;                       // soft across
  a *= smoothstep( 0.0, 0.16, vAlong ) * ( 1.0 - smoothstep( 0.72, 1.0, vAlong ) );
  gl_FragColor = vec4( uColour, a * vAlpha * uOpacity );
}
`;

// ---------------------------------------------------------------------------
// Spray (rooster tail + splash)
// ---------------------------------------------------------------------------

const SPRAY_VERT = /* glsl */ `
attribute vec2 aCorner;
attribute vec3 aPos;
attribute vec4 aData;        // x = radius, y = alpha, z = seed, w = flatten
uniform float uPixelClamp;
varying vec2 vUv;
varying float vAlpha;
varying float vSeed;
varying vec3 vView;
void main() {
  float r = aData.x;
  vec4 mv = modelViewMatrix * vec4( aPos, 1.0 );
  float depth = -mv.z;
  // Flat splash crowns lie on the ground; plume puffs are camera-facing.
  vec2 c = aCorner * r;
  mv.xy += c;
  mv.z += aData.w * c.y;
  gl_Position = projectionMatrix * mv;
  vUv = aCorner;
  // Fade the sprites that are ON the lens. Now that the plume is entrained and
  // travels with the car, a chase camera sits inside it, and a single 2 m puff
  // half a metre from the eye is a full-screen grey card that both hides the car
  // and pops in and out as it crosses the near plane. Real onboard footage is
  // veiled, not blindfolded.
  //
  // The window is 1.1-4.6 m rather than 0.45-2.6 m because measurement showed the
  // wet chase frames had lost every black (p05 rose from 0.07 dry to 0.39-0.45
  // wet — the darkest twentieth of the frame was mid-grey). A plume the camera is
  // inside of has no silhouette and reads as a lens smear, not as weather; the
  // drama comes from a dense plume seen ACROSS a dark, wet, reflective road.
  vAlpha = aData.y * smoothstep( 1.1, 4.6, depth );
  vSeed = aData.z;
  vView = mv.xyz;
}
`;

const SPRAY_FRAG = /* glsl */ `
uniform vec3 uSunColour;
uniform vec3 uSkyColour;
uniform vec3 uSunDirView;
uniform float uOpacity;
varying vec2 vUv;
varying float vAlpha;
varying float vSeed;
varying vec3 vView;

float sHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float sNoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  float a = sHash( i ), b = sHash( i + vec2( 1.0, 0.0 ) );
  float c = sHash( i + vec2( 0.0, 1.0 ) ), d = sHash( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
}

void main() {
  float r2 = dot( vUv, vUv );
  if ( r2 > 1.0 ) discard;

  // NO HARD EDGE ANYWHERE. The previous version thresholded the radius against
  // a noise field (smoothstep of 1.0, 0.28 against r + noise), which gives every
  // sprite a crisp, lumpy rim — and a plume built from a few hundred crisp lumpy
  // rims reads as a few hundred lumps. A rooster tail is an optically thick cloud, so
  // what is wanted is a smooth density profile that MULTIPLIES a noise field
  // rather than being clipped by it: overlapping sprites then integrate into one
  // continuous mass and no individual sprite is ever findable.
  float ang = vSeed * 6.2831;
  float ca = cos( ang ), sa = sin( ang );
  vec2 nq = vec2( vUv.x * ca - vUv.y * sa, vUv.x * sa + vUv.y * ca );
  float n = sNoise( nq * 2.1 + vSeed * 31.0 ) * 0.58 + sNoise( nq * 5.3 + vSeed * 11.0 ) * 0.42;
  float core = ( 1.0 - r2 ) * ( 1.0 - r2 );          // C1-smooth, zero slope at the rim
  float a = core * ( 0.34 + 1.32 * n );

  // Water droplets scatter strongly forward: a plume between the camera and
  // the sun lights up. uSunDirView points from the fragment toward the sun.
  vec3 vdir = normalize( -vView );
  float mu = dot( vdir, -uSunDirView );
  float g = 0.55;
  float hg = ( 1.0 - g * g ) / pow( max( 1.0 + g * g - 2.0 * g * mu, 1e-3 ), 1.5 );
  vec3 col = uSkyColour + uSunColour * ( 0.22 + 0.30 * clamp( hg, 0.0, 3.2 ) );

  // Self-shadowing: the interior of a plume is darker than its rim because the
  // ambient light has to get through the droplets in front of it. Cheap stand-in
  // — the thicker the sprite is here, the less sky reaches this point.
  col *= 1.0 - 0.30 * core;

  gl_FragColor = vec4( col, a * vAlpha * uOpacity );
}
`;

// ---------------------------------------------------------------------------
// Mist banks
// ---------------------------------------------------------------------------

const MIST_VERT = /* glsl */ `
attribute vec2 aCorner;
attribute vec4 aBank;        // xyz = anchor, w = half length
attribute vec3 aParam;       // x = height, y = seed, z = phase
uniform float uTime;
uniform vec3 uWindXZ;
varying vec2 vUv;
varying float vSeed;
varying float vDepth;
void main() {
  vec3 anchor = aBank.xyz;
  anchor.xz += uWindXZ.xz * uTime;
  // Cylindrical billboard: rotate about Y to face the camera.
  vec3 toCam = cameraPosition - anchor;
  vec2 f = normalize( vec2( toCam.x, toCam.z ) + 1e-4 );
  vec3 right = vec3( -f.y, 0.0, f.x );
  vec3 p = anchor + right * ( aCorner.x * aBank.w ) + vec3( 0.0, aCorner.y * aParam.x, 0.0 );
  vec4 mv = modelViewMatrix * vec4( p, 1.0 );
  gl_Position = projectionMatrix * mv;
  vUv = aCorner;
  vSeed = aParam.y;
  vDepth = -mv.z;
}
`;

const MIST_FRAG = /* glsl */ `
uniform vec3 uColour;
uniform float uOpacity;
uniform float uTime;
varying vec2 vUv;
varying float vSeed;
varying float vDepth;
float mHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
float mNoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( mHash( i ), mHash( i + vec2( 1.0, 0.0 ) ), f.x ),
              mix( mHash( i + vec2( 0.0, 1.0 ) ), mHash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
}
void main() {
  vec2 q = vec2( vUv.x * 3.4 + vSeed * 17.0 + uTime * 0.035, vUv.y * 1.6 + vSeed * 5.0 );
  float n = mNoise( q ) * 0.55 + mNoise( q * 2.7 ) * 0.30 + mNoise( q * 6.3 ) * 0.15;
  // EVERY EDGE OF THE QUAD MUST REACH ZERO SMOOTHLY. The old shaping multiplied
  // an inverted smoothstep over y by a bare 1 - abs(x), which is still 1.0 at
  // the bottom edge and only linear across x — so a bank showed its own straight
  // lower boundary and two straight diagonal ramps as soon as the opacity was
  // raised far enough to see it at all.
  float fadeY = smoothstep( -1.0, -0.72, vUv.y ) * ( 1.0 - smoothstep( -0.30, 1.0, vUv.y ) );
  float fadeX = 1.0 - smoothstep( 0.10, 1.0, abs( vUv.x ) );
  float body = fadeY * fadeX * fadeX;
  float a = clamp( body * ( n * 1.85 - 0.34 ), 0.0, 1.0 );
  a *= smoothstep( 25.0, 110.0, vDepth ) * ( 1.0 - smoothstep( 380.0, 820.0, vDepth ) );
  gl_FragColor = vec4( uColour, a * uOpacity );
}
`;

// ---------------------------------------------------------------------------
// Visor / windscreen droplets
// ---------------------------------------------------------------------------

const VISOR_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4( position.xy, 0.0, 1.0 );
}
`;

const VISOR_FRAG = /* glsl */ `
uniform float uTime;
uniform float uAmount;       // 0..1 how many drops are on the visor
uniform float uSpeed01;      // 0..1 car speed — drops streak upward with airflow
uniform float uAspect;
uniform vec3  uSkyColour;
uniform vec3  uSunColour;
varying vec2 vUv;

float vHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
vec2 vHash2( vec2 p ) {
  return fract( sin( vec2( dot( p, vec2( 127.1, 311.7 ) ), dot( p, vec2( 269.5, 183.3 ) ) ) ) * 43758.5453 );
}

/** One layer of beaded droplets on a jittered grid. Returns (mask, slope.x, slope.y). */
vec3 dropLayer( vec2 uv, float scale, float seed, float t, float streak ) {
  vec2 q = uv * scale + seed;
  vec2 cell = floor( q );
  vec3 best = vec3( 0.0 );
  for ( int j = -1; j <= 1; j ++ ) {
    for ( int i = -1; i <= 1; i ++ ) {
      vec2 c = cell + vec2( float( i ), float( j ) );
      vec2 r = vHash2( c + seed );
      float alive = step( 0.42, vHash( c * 1.7 + seed ) );
      // Drops crawl UP the visor: the airflow over an open cockpit drags them
      // against gravity, which is exactly what a helmet cam shows.
      float trav = fract( r.y + t * ( 0.05 + streak * 0.9 ) * ( 0.4 + r.x ) );
      vec2 pos = c + vec2( r.x, trav );
      vec2 d = q - pos;
      float rad = ( 0.13 + r.x * 0.20 ) * ( 1.0 - streak * 0.25 );
      // Stretch into a tail behind the direction of travel.
      d.y *= 1.0 / ( 1.0 + streak * 2.6 * step( 0.0, -d.y ) );
      float len = length( d );
      float m = smoothstep( rad, rad * 0.42, len ) * alive;
      if ( m > best.x ) best = vec3( m, d / max( len, 1e-4 ) );
    }
  }
  return best;
}

void main() {
  vec2 uv = vec2( vUv.x * uAspect, vUv.y );
  float t = uTime;

  vec3 a = dropLayer( uv, 11.0, 0.0, t, uSpeed01 );
  vec3 b = dropLayer( uv, 21.0, 4.7, t * 1.35, uSpeed01 );
  float m = max( a.x, b.x * 0.8 );
  vec2 slope = a.x > b.x ? a.yz : b.yz;

  // A drop is a tiny lens: bright where it gathers the sky, dark at the rim,
  // with a hot specular pip toward the light.
  float rim = smoothstep( 0.25, 0.95, m );
  float lens = smoothstep( 0.05, 0.75, m );
  float spec = pow( clamp( dot( slope, normalize( vec2( -0.55, 0.83 ) ) ), 0.0, 1.0 ), 8.0 ) * lens;

  vec3 col = uSkyColour * ( 0.55 + lens * 1.05 ) + uSunColour * spec * 0.55;
  float alpha = ( lens * 0.68 + rim * 0.22 ) * uAmount;

  // Edge of the visor aperture — keep the centre of frame readable.
  float edge = smoothstep( 0.05, 0.55, length( ( vUv - 0.5 ) * vec2( 1.25, 1.0 ) ) );
  alpha *= 0.30 + 0.70 * edge;

  gl_FragColor = vec4( col, clamp( alpha, 0.0, 0.92 ) );
}
`;

// ===========================================================================
// Weather
// ===========================================================================

export class Weather {
  constructor({
    sky, lighting, circuit, scene, camera = null, rig = null, particles = null,
    carMaterials = [], trackMaterial = null,
  } = {}) {
    this.sky = sky;
    this.lighting = lighting;
    this.circuit = circuit;
    this.scene = scene;
    this.camera = camera;
    this.rig = rig;
    this.particles = particles;
    this.carMaterials = carMaterials;
    this.trackMaterial = trackMaterial;

    this.rng = makeRng(hashSeed('weather'));
    this.time = 0;
    this.enabled = true;

    this.state = 'dry';
    /** Live, continuously interpolated parameter set. */
    this.params = { ...WEATHER_STATES.dry };
    this.target = { ...WEATHER_STATES.dry };
    this.transition = 14;             // seconds for a full state change

    this.wetness = 0;                 // sky-side: how wet the weather is making it
    this.rain = 0;
    this.windAngle = 0.65;
    this.wind = new THREE.Vector3(Math.sin(0.65), 0, Math.cos(0.65));

    /** Mean film depth over the racing surface — what the HUD and FX read. */
    this.surfaceWater = 0;
    /** Mean film depth ON the racing line — this is what "drying line" means. */
    this.lineWater = 0;

    this._skyIntensity0 = sky ? sky.uniforms.uIntensity.value : 0.21;
    this._aerialStrength0 = lighting ? lighting.aerialStrength : 0.9;
    this._aerialHeight0 = lighting ? lighting.aerialHeightScale : 850;
    this._skyWind0 = sky ? sky.windSpeed : 9;
    this._exposureBias0 = lighting ? lighting.exposureBias : 4.85;
    this._trackEnv0 = trackMaterial ? trackMaterial.envMapIntensity : 0.8;

    this._camVel = new THREE.Vector3();
    this._camPrev = new THREE.Vector3();
    this._camPrimed = false;
    this._mapAge = 1e9;
    this._sprayCarry = new Map();

    this._buildDeck();
    this._buildWaterField();
    this._buildWorldMap();
    this._patchTrackMaterial();
    this._collectSecondarySurfaces();
    this._buildRain();
    this._buildSpray();
    this._buildMist();
    this._buildVisor();

    this.setState('dry', { immediate: true });
  }

  // =========================================================================
  // Water field
  // =========================================================================

  /**
   * Simulation grid in track space: `n` arc-length samples x `LANES` lanes.
   *
   * `basin` is the honest part. For every node it measures how much of a local
   * minimum the ROAD MESH is there — the discrete Laplacian of the surface
   * height plus a penalty for slope — then normalises against the circuit's own
   * distribution so the result is scale-free. A crowned straight scores ~0
   * everywhere; a compression, an off-camber exit or the flat inside of a
   * banked corner scores high, and that is where the puddles end up.
   */
  _buildWaterField() {
    const c = this.circuit;
    const n = c ? c.samples.length : 256;
    this.n = n;
    this.lanes = LANES;

    this.water = new Float32Array(n * LANES);
    this.basin = new Float32Array(n * LANES);
    this.usage = new Float32Array(n * LANES);
    /**
     * Rubber laid down by traffic, integrated with a ~2-minute time constant.
     * This is the SLOW half of the drying line and the reason it "forms as laps
     * accumulate": `usage` is this frame's traffic and decays in a second, so on
     * its own it can only make a line that flickers. Rubber is cumulative, and
     * a rubbered-in surface is genuinely different — polished, non-porous, so
     * water sheets off it instead of soaking into the aggregate voids. It
     * therefore lowers the node's CAPACITY, which is what makes the line dry
     * first and stay dry.
     */
    this.rubber = new Float32Array(n * LANES);
    /** Distance from the racing line in tyre-widths, per node. Static. */
    this.lineDist = new Float32Array(n * LANES);
    this.laneOffset = new Float32Array(LANES);

    // Legacy per-sample view (1 = bone dry) kept for the public API.
    this.dryness = new Float32Array(n).fill(1);
    this.lineUsage = new Float32Array(n);
    this._texData = new Uint8Array(n * 4).fill(255);
    this.trackWetnessTexture = new THREE.DataTexture(this._texData, n, 1, THREE.RGBAFormat);
    this.trackWetnessTexture.wrapS = THREE.RepeatWrapping;
    this.trackWetnessTexture.needsUpdate = true;

    if (!c) return;

    const hw = c.halfWidth;
    for (let j = 0; j < LANES; j++) {
      this.laneOffset[j] = (-1 + (2 * j) / (LANES - 1)) * hw * LANE_SPAN;
    }
    this.laneStep = (this.laneOffset[LANES - 1] - this.laneOffset[0]) / (LANES - 1);

    // --- surface height at every node ---------------------------------------
    const h = new Float32Array(n * LANES);
    const p = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const s = i * c.step;
      for (let j = 0; j < LANES; j++) {
        c.pointAt(s, this.laneOffset[j], 0, p);
        h[i * LANES + j] = p.y;
      }
    }
    this.nodeHeight = h;

    // --- basin score --------------------------------------------------------
    const ds = c.step;
    const dl = Math.abs(this.laneStep) || 1;
    const raw = new Float32Array(n * LANES);
    for (let i = 0; i < n; i++) {
      const im = ((i - 1) + n) % n, ip = (i + 1) % n;
      for (let j = 0; j < LANES; j++) {
        const jm = Math.max(0, j - 1), jp = Math.min(LANES - 1, j + 1);
        const y = h[i * LANES + j];
        const yS = (h[im * LANES + j] + h[ip * LANES + j]) * 0.5;
        const yL = (h[i * LANES + jm] + h[i * LANES + jp]) * 0.5;
        // Concavity: positive when the node sits below its neighbours.
        const concav = Math.max(0, (yS + yL) * 0.5 - y);
        const gS = (h[ip * LANES + j] - h[im * LANES + j]) / (2 * ds);
        const gL = (h[i * LANES + jp] - h[i * LANES + jm]) / (2 * dl);
        const slope = Math.hypot(gS, gL);
        // Water also runs to the low side of the crown and sits against the
        // verge, so the outer lanes get a standing bonus that decays inward.
        const edge = Math.abs(this.laneOffset[j]) / (hw * LANE_SPAN);
        raw[i * LANES + j] =
          concav * 260 +
          Math.max(0, 1 - slope / 0.030) * 0.55 +
          smoothstep(0.62, 1.0, edge) * 0.45;
      }
    }

    // Normalise against the circuit's own distribution (85th percentile) so the
    // amount of puddling does not depend on how hilly this particular track is.
    const sorted = Float32Array.from(raw).sort();
    const p85 = sorted[Math.floor(sorted.length * 0.85)] || 1;
    const p35 = sorted[Math.floor(sorted.length * 0.35)] || 0;
    const span = Math.max(1e-4, p85 - p35);
    for (let k = 0; k < raw.length; k++) {
      this.basin[k] = clamp((raw[k] - p35) / span, 0, 1);
    }
    // Smooth along arc length: puddles are metres long, not one sample wide.
    const tmp = Float32Array.from(this.basin);
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < n; i++) {
        const im = ((i - 1) + n) % n, ip = (i + 1) % n;
        for (let j = 0; j < LANES; j++) {
          const jm = Math.max(0, j - 1), jp = Math.min(LANES - 1, j + 1);
          tmp[i * LANES + j] = (
            this.basin[i * LANES + j] * 2 +
            this.basin[im * LANES + j] + this.basin[ip * LANES + j] +
            this.basin[i * LANES + jm] + this.basin[i * LANES + jp]
          ) / 6;
        }
      }
      this.basin.set(tmp);
    }

    // --- braking / rubber weight -------------------------------------------
    this.brakeWeight = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const b = c.brakeProfile ? c.brakeProfile[i] : 0;
      this.brakeWeight[i] = clamp(b, 0, 1);
    }

    // --- distance from the racing line, in tyre-widths ----------------------
    // A single-seater's front track is 1.60 m and the tyre is 0.36 m wide, so
    // "one car on the line" wets a band about 2 m across. Measuring in those
    // units keeps the drying line the right physical width on any circuit.
    for (let i = 0; i < n; i++) {
      const racing = c.samples[i].racing;
      for (let j = 0; j < LANES; j++) {
        this.lineDist[i * LANES + j] = Math.abs(this.laneOffset[j] - racing) / 1.95;
      }
    }
  }

  /**
   * How deep water can stand at a node, before the weather's own ceiling.
   *
   * Basins hold water; a rubbered-in, polished racing line does not. The rubber
   * term is what turns "cars drove here" into "this strip is dry" and survives
   * long after this frame's traffic has gone.
   */
  _capacityAt(k) {
    const rubbered = 1 - 0.62 * smoothstep(0.05, 0.85, this.rubber[k]);
    return (0.34 + 0.66 * this.basin[k]) * rubbered;
  }

  // =========================================================================
  // World-projected wetness map
  // =========================================================================

  /**
   * The bridge from track space to the shader. Built once: a world-XZ grid
   * covering the circuit, with every cell that lies on the paved envelope
   * tagged with the (sample, lane) it came from. Publishing is then a flat
   * gather over ~10-20k live cells.
   */
  _buildWorldMap() {
    const c = this.circuit;
    if (!c) { this.wetMapTexture = null; return; }

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const s of c.samples) {
      if (s.position.x < minX) minX = s.position.x;
      if (s.position.x > maxX) maxX = s.position.x;
      if (s.position.z < minZ) minZ = s.position.z;
      if (s.position.z > maxZ) maxZ = s.position.z;
    }
    const pad = c.halfWidth * LANE_SPAN + 6;
    minX -= pad; maxX += pad; minZ -= pad; maxZ += pad;
    const extent = Math.max(maxX - minX, maxZ - minZ);

    const size = MAP_MAX;
    this.mapSize = size;
    this.mapOrigin = new THREE.Vector2(minX, minZ);
    this.mapExtent = extent;
    this.mapCell = extent / size;

    this._mapData = new Uint8Array(size * size * 4);
    this.wetMapTexture = new THREE.DataTexture(this._mapData, size, size, THREE.RGBAFormat);
    this.wetMapTexture.wrapS = this.wetMapTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.wetMapTexture.minFilter = THREE.LinearFilter;
    this.wetMapTexture.magFilter = THREE.LinearFilter;
    this.wetMapTexture.generateMipmaps = false;
    this.wetMapTexture.needsUpdate = true;

    // --- splat the road into the grid ---------------------------------------
    const cell = this.mapCell;
    const cellSample = new Int32Array(size * size).fill(-1);
    const cellLane = new Float32Array(size * size);
    const p = new THREE.Vector3();

    const sStep = Math.min(c.step, cell * 0.55);
    const halfSpan = c.halfWidth * LANE_SPAN;
    const latStep = Math.min(cell * 0.5, 0.55);
    const latCount = Math.ceil((halfSpan * 2) / latStep) + 1;
    const live = [];

    for (let s = 0; s < c.length; s += sStep) {
      const si = c.sampleIndex(s);
      for (let t = 0; t < latCount; t++) {
        const lat = -halfSpan + t * latStep;
        c.pointAt(s, lat, 0, p);
        const gx = Math.floor((p.x - minX) / cell);
        const gz = Math.floor((p.z - minZ) / cell);
        if (gx < 0 || gz < 0 || gx >= size || gz >= size) continue;
        const idx = gz * size + gx;
        if (cellSample[idx] === -1) live.push(idx);
        cellSample[idx] = si;
        // Lane coordinate as a float so the gather can interpolate.
        cellLane[idx] = clamp((lat - this.laneOffset[0]) / this.laneStep, 0, LANES - 1.001);
      }
    }

    this._cellSample = cellSample;
    this._cellLane = cellLane;
    this._liveCells = Int32Array.from(live);

    // Static channels: basin (G), braking/rubber (B), mask (A). A cell that was
    // never splatted stays fully zero, so the shader's `mask` kills it.
    for (let q = 0; q < this._liveCells.length; q++) {
      const idx = this._liveCells[q];
      const i = cellSample[idx];
      const lf = cellLane[idx];
      const j0 = Math.floor(lf), j1 = Math.min(LANES - 1, j0 + 1), f = lf - j0;
      const basin = lerp(this.basin[i * LANES + j0], this.basin[i * LANES + j1], f);
      const o = idx * 4;
      this._mapData[o + 1] = Math.round(basin * 255);
      this._mapData[o + 2] = Math.round(this.brakeWeight[i] * 255);
      this._mapData[o + 3] = 255;
    }
    this.wetMapTexture.needsUpdate = true;
  }

  /** Gather the live water field into the published map. */
  _publishWorldMap() {
    if (!this.wetMapTexture) return;
    const data = this._mapData;
    const cells = this._liveCells;
    const cs = this._cellSample, cl = this._cellLane;
    const w = this.water, rb = this.rubber, bw = this.brakeWeight;
    for (let q = 0; q < cells.length; q++) {
      const idx = cells[q];
      const i = cs[idx];
      const lf = cl[idx];
      const j0 = lf | 0, j1 = j0 + 1 < LANES ? j0 + 1 : j0, f = lf - j0;
      const v = w[i * LANES + j0] * (1 - f) + w[i * LANES + j1] * f;
      data[idx * 4] = v > 1 ? 255 : (v * 255) | 0;
      // B is the DARKENING channel: braking zones and the rubbered-in line are
      // the same phenomenon as far as the shader is concerned — laid rubber,
      // which is blacker than the aggregate and holds a wet sheen differently.
      const r = rb[i * LANES + j0] * (1 - f) + rb[i * LANES + j1] * f;
      const d = bw[i] * 0.80 + r * 0.60;
      data[idx * 4 + 2] = d > 1 ? 255 : (d * 255) | 0;
    }
    this.wetMapTexture.needsUpdate = true;
  }

  // =========================================================================
  // Materials
  // =========================================================================

  _patchTrackMaterial() {
    this.trackUniforms = {
      uWetMap: { value: this.wetMapTexture },
      uWetMapXform: { value: new THREE.Vector4(0, 0, 1, 0) },
      uWetGlobal: { value: 0 },
      uWetTime: { value: 0 },
      uWetRain: { value: 0 },
      uWetWind: { value: new THREE.Vector2() },
      uWetPuddle: { value: 0 },
    };
    if (this.mapOrigin) {
      this.trackUniforms.uWetMapXform.value.set(
        this.mapOrigin.x, this.mapOrigin.y, 1 / this.mapExtent, 0,
      );
    }

    const mat = this.trackMaterial;
    if (!mat || !this.wetMapTexture) return;

    const prev = mat.onBeforeCompile;
    const uniforms = this.trackUniforms;

    mat.onBeforeCompile = function (shader, renderer) {
      if (prev) prev.call(this, shader, renderer);
      Object.assign(shader.uniforms, uniforms);

      // The circuit's own patch has already rewritten `void main() {` with its
      // helper block; there is still exactly one occurrence, and it is the
      // start of main, so declaring in front of it is safe.
      shader.fragmentShader = shader.fragmentShader.replace(
        'void main() {', `${WET_DECL}\nvoid main() {`,
      );

      // Guard: the wet body writes `apexNrmTexel`, which only exists because
      // circuit.js declares it. If that ever goes away, fall back to leaving
      // the normal alone rather than failing to compile.
      const body = shader.fragmentShader.includes('apexNrmTexel')
        ? WET_BODY
        : WET_BODY.replace(/apexNrmTexel[^\n]*\n/g, '');

      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <metalnessmap_fragment>',
        `#include <metalnessmap_fragment>\n${body}`,
      );
    };
    mat.customProgramCacheKey = () => 'apex-track-asphalt-wet';
    mat.needsUpdate = true;
  }

  /**
   * Kerbs, painted lines, run-off, pit lane and concrete get a cheap uniform
   * wetness (no map, no puddles) — they are never the subject, but a dry kerb
   * next to a soaking road is the single most obvious tell that the wet look is
   * a shader trick rather than weather.
   */
  _collectSecondarySurfaces() {
    this.secondary = [];
    const reg = this._registry();
    if (!reg) return;
    const wanted = [
      ['mat:track/kerb', 0.34, 0.16],
      ['mat:track/sausage', 0.34, 0.16],
      ['mat:track/negativekerb', 0.34, 0.16],
      ['mat:track/line', 0.40, 0.14],
      ['mat:track/startline', 0.40, 0.14],
      ['mat:track/gridbox', 0.40, 0.14],
      ['mat:env/runoff', 0.30, 0.18],
      ['mat:env/pitlane', 0.30, 0.16],
      ['mat:env/pitline', 0.36, 0.16],
      ['mat:env/grass', 0.55, 0.55],
      // Large paved areas that read as part of the circuit and were being left
      // bone dry next to a soaking road — the single most obvious tell that the
      // wet look is a shader on one mesh rather than weather over a world.
      // (`mat:env/concrete` used to be in this list and does not exist; the
      // registry keys below were all verified present.)
      ['mat:env/serviceRoad', 0.32, 0.18],
      ['mat:env/verge', 0.42, 0.30],
      ['mat:env/pitbox', 0.34, 0.18],
      ['mat:env/pitwall', 0.44, 0.30],
      ['mat:env/garage', 0.52, 0.40],
      // Barriers and tyre walls go dark and glossy in the rain, and they sit
      // directly behind every car in a trackside shot.
      ['mat:env/armco', 0.58, 0.34],
      ['mat:env/tecproMat', 0.62, 0.38],
      ['mat:env/tyrewall', 0.60, 0.44],
      ['mat:env/tyrebeltMat', 0.60, 0.44],
    ];
    for (const [key, darken, rough] of wanted) {
      const m = reg.get(key);
      if (!m || !m.isMaterial) continue;
      this.secondary.push({
        mat: m, darken, rough,
        colour0: m.color ? m.color.clone() : null,
        rough0: m.roughness ?? 1,
        env0: m.envMapIntensity ?? 1,
      });
    }
  }

  _registry() { return assets.items; }

  // =========================================================================
  // Overcast deck
  // =========================================================================

  _buildDeck() {
    if (!this.scene) return;
    this.deckMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uColour: { value: new THREE.Color(0.30, 0.31, 0.335) },
        uAmount: { value: 0 },
        uBase: { value: 1100 },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uDrift: { value: new THREE.Vector2() },
        uBreak: { value: 0 },
      },
      vertexShader: DECK_VERT,
      fragmentShader: DECK_FRAG,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      fog: false,
    });
    const geo = new THREE.BoxGeometry(2, 2, 2);
    this.deckMesh = new THREE.Mesh(geo, this.deckMaterial);
    this.deckMesh.frustumCulled = false;
    // Immediately after the sky (-1000) and before all world geometry.
    this.deckMesh.renderOrder = -999;
    this.deckMesh.visible = false;
    this.deckMesh.name = 'OvercastDeck';
    this.scene.add(this.deckMesh);

    // The IBL has to see the ceiling, or the world stays lit by a blue sky
    // that is no longer there. Same material, same uniforms — they cannot
    // drift apart.
    if (this.lighting?.envScene) {
      this.deckEnvMesh = new THREE.Mesh(geo, this.deckMaterial);
      this.deckEnvMesh.frustumCulled = false;
      this.deckEnvMesh.renderOrder = -999;
      this.deckEnvMesh.name = 'OvercastDeckEnv';
      this.lighting.envScene.add(this.deckEnvMesh);
    }
  }

  _updateDeck() {
    if (!this.deckMesh) return;
    const p = this.params;
    const amount = clamp(p.deck ?? 0, 0, 1);
    this.deckMesh.visible = amount > 0.005;
    if (this.deckEnvMesh) this.deckEnvMesh.visible = this.deckMesh.visible;
    if (!this.deckMesh.visible) return;
    const u = this.deckMaterial.uniforms;
    u.uAmount.value = amount;
    u.uBase.value = p.cloudBase;
    u.uBreak.value = clamp(p.deckBreak ?? 0, 0, 1);
    u.uDrift.value.set(this.wind.x * this.time * 0.0016, this.wind.z * this.time * 0.0016);
    if (this.sky) u.uSunDir.value.copy(this.sky.sunDirection);
    // Absolute radiance. `deckLum` is authored against the same scale the sky
    // emits: the clear zenith sits near 0.19, so 0.34 reads as a bright
    // overcast ceiling without ever approaching the 1.25 bloom threshold.
    const lum = p.deckLum ?? 0.34;
    u.uColour.value.setRGB(lum * 0.98, lum * 1.0, lum * 1.06, THREE.LinearSRGBColorSpace);
  }

  // =========================================================================
  // Rain
  // =========================================================================

  _buildRain() {
    if (!this.scene) return;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('aCorner', new THREE.BufferAttribute(new Float32Array([
      0, -1, 1, -1, 1, 1, 0, 1,
    ]), 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);

    const seeds = new Float32Array(MAX_RAIN);
    const shells = new Float32Array(MAX_RAIN);
    for (let i = 0; i < MAX_RAIN; i++) {
      seeds[i] = 1 + this.rng() * 8191;
      // Weight the shells so the far curtain has the most drops: that is where
      // the screen area is.
      const r = this.rng();
      shells[i] = r < 0.26 ? 0 : (r < 0.60 ? 1 : 2);
    }
    geo.setAttribute('aSeed', new THREE.InstancedBufferAttribute(seeds, 1));
    geo.setAttribute('aShell', new THREE.InstancedBufferAttribute(shells, 1));
    geo.instanceCount = MAX_RAIN;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.rainMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uCamPos: { value: new THREE.Vector3() },
        uCamVel: { value: new THREE.Vector3() },
        uWind: { value: new THREE.Vector3() },
        uTime: { value: 0 },
        uFall: { value: 8.2 },
        uShutter: { value: 0.020 },
        uMaxStreak: { value: 0.85 },
        uAspect: { value: 16 / 9 },
        uWidthPx: { value: 0.010 },
        uShellSize: { value: new THREE.Vector3(24, 70, 190) },
        uBoxHeight: { value: 34 },
        uDensity: { value: 0 },
        uColour: { value: new THREE.Color(0.42, 0.47, 0.55) },
        uOpacity: { value: 0 },
      },
      vertexShader: RAIN_VERT,
      fragmentShader: RAIN_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
    });

    this.rainMesh = new THREE.Mesh(geo, this.rainMaterial);
    this.rainMesh.frustumCulled = false;
    this.rainMesh.renderOrder = 30;
    this.rainMesh.visible = false;
    this.rainMesh.name = 'Rain';
    this.scene.add(this.rainMesh);
  }

  // =========================================================================
  // Spray
  // =========================================================================

  _buildSpray() {
    if (!this.scene) return;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('aCorner', new THREE.BufferAttribute(new Float32Array([
      -1, -1, 1, -1, 1, 1, -1, 1,
    ]), 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);

    this._sprayPos = new Float32Array(MAX_SPRAY * 3);
    this._sprayData = new Float32Array(MAX_SPRAY * 4);
    this._sprayVel = new Float32Array(MAX_SPRAY * 3);
    this._sprayLife = new Float32Array(MAX_SPRAY);
    this._sprayMax = new Float32Array(MAX_SPRAY);
    this._sprayGrow = new Float32Array(MAX_SPRAY);
    this._spraySize0 = new Float32Array(MAX_SPRAY);
    this._sprayDrag = new Float32Array(MAX_SPRAY);
    /**
     * Per-particle gravity, m/s^2. This is not a cheat, it is the whole
     * difference between the two things a rooster tail is made of. A 1 mm
     * droplet has a terminal velocity of ~4 m/s and behaves ballistically; a
     * 50 um droplet has a terminal velocity of ~0.1 m/s and is simply carried by
     * the air. Integrating both at 7.6 m/s^2 (as this did) pins the fine veil to
     * the tarmac inside a tenth of a second, so the plume can never rise above
     * the gearbox and a chase camera looks straight over the top of it.
     */
    this._sprayGrav = new Float32Array(MAX_SPRAY);
    this._sprayAlpha0 = new Float32Array(MAX_SPRAY);
    this._sprayCursor = 0;
    this._sprayLive = 0;

    this._sprayPosAttr = new THREE.InstancedBufferAttribute(this._sprayPos, 3);
    this._sprayDataAttr = new THREE.InstancedBufferAttribute(this._sprayData, 4);
    this._sprayPosAttr.setUsage(THREE.DynamicDrawUsage);
    this._sprayDataAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aPos', this._sprayPosAttr);
    geo.setAttribute('aData', this._sprayDataAttr);
    geo.instanceCount = 0;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.sprayMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uSunColour: { value: new THREE.Color(0.9, 0.92, 0.96) },
        uSkyColour: { value: new THREE.Color(0.16, 0.18, 0.22) },
        uSunDirView: { value: new THREE.Vector3(0, 1, 0) },
        uOpacity: { value: 1 },
        uPixelClamp: { value: 1 },
      },
      vertexShader: SPRAY_VERT,
      fragmentShader: SPRAY_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
    });

    this.sprayMesh = new THREE.Mesh(geo, this.sprayMaterial);
    this.sprayMesh.frustumCulled = false;
    this.sprayMesh.renderOrder = 29;
    this.sprayMesh.name = 'Spray';
    this.sprayMesh.visible = false;
    this.scene.add(this.sprayMesh);
  }

  _spawnSpray(px, py, pz, vx, vy, vz, o) {
    const i = this._sprayCursor;
    this._sprayCursor = (i + 1) % MAX_SPRAY;
    const p3 = i * 3, d4 = i * 4;
    this._sprayPos[p3] = px; this._sprayPos[p3 + 1] = py; this._sprayPos[p3 + 2] = pz;
    this._sprayVel[p3] = vx; this._sprayVel[p3 + 1] = vy; this._sprayVel[p3 + 2] = vz;
    this._sprayLife[i] = o.life;
    this._sprayMax[i] = o.life;
    this._sprayGrow[i] = o.grow;
    this._sprayDrag[i] = o.drag;
    this._sprayGrav[i] = o.grav ?? 7.6;
    this._sprayAlpha0[i] = o.alpha;
    this._spraySize0[i] = o.size;
    this._sprayData[d4] = o.size;
    this._sprayData[d4 + 1] = 0;
    this._sprayData[d4 + 2] = o.seed;
    this._sprayData[d4 + 3] = o.flat ?? 0;
  }

  _updateSpray(dt) {
    const pos = this._sprayPos, vel = this._sprayVel, data = this._sprayData;
    const life = this._sprayLife, maxL = this._sprayMax;
    let live = 0;
    for (let i = 0; i < MAX_SPRAY; i++) {
      if (life[i] <= 0) { data[i * 4] = 0; data[i * 4 + 1] = 0; continue; }
      life[i] -= dt;
      if (life[i] <= 0) { data[i * 4] = 0; data[i * 4 + 1] = 0; continue; }
      const p3 = i * 3, d4 = i * 4;
      const k = Math.exp(-this._sprayDrag[i] * dt);
      vel[p3] *= k; vel[p3 + 2] *= k;
      // Water, not smoke: it goes up because the tyre threw it and comes
      // back down. No buoyancy anywhere in this integrator — but the fine
      // fraction falls at its own terminal velocity, not at g (see _sprayGrav).
      vel[p3 + 1] = vel[p3 + 1] * k - this._sprayGrav[i] * dt;
      // Wind pushes the plume downstream — a crosswind lays a rooster tail
      // over. The coupling is deliberately weak: at 0.55 a 12 m/s crosswind
      // carried the entire plume off the circuit in a second and a half.
      vel[p3] += this.wind.x * 0.13 * dt;
      vel[p3 + 2] += this.wind.z * 0.13 * dt;
      pos[p3] += vel[p3] * dt;
      pos[p3 + 1] += vel[p3 + 1] * dt;
      pos[p3 + 2] += vel[p3 + 2] * dt;

      const t = 1 - life[i] / maxL[i];
      // SUB-LINEAR GROWTH. Linear growth (`size += grow*dt`) means a puff is at
      // its smallest exactly where the plume is densest — right behind the tyre —
      // so newly emitted sprites never overlap and the plume's root is a string
      // of separate dots. A turbulent puff actually expands like sqrt(t): most of
      // its final size in the first tenth of a second, then it coasts. That one
      // change is most of what turns beads into a continuous mass.
      const age = maxL[i] * t;
      const s0 = this._spraySize0[i];
      const sz = s0 + this._sprayGrow[i] * Math.sqrt(age);
      data[d4] = sz;
      /**
       * MASS CONSERVATION — the reason a train of cars was building an opaque
       * white wall across two thirds of a broadcast frame.
       *
       * The puff's radius triples over its lifetime while its alpha was held
       * flat, so its integrated optical mass grew about ninefold: every plume
       * ended up thicker at 130 m behind the car than it was at the contact
       * patch. Twenty cars' worth of that tiles a whole straight in solid grey.
       *
       * A puff carries a fixed amount of water, so its column density has to go
       * as mass / area, i.e. (r0/r)^2. The exponent here is 1.35 rather than 2
       * because a real wake keeps feeding the puff for part of its life, and
       * because pure 1/r^2 dilutes the near plume faster than film shows. The
       * net effect is exactly the right one: dense and dramatic in the first
       * car length, thinning to a haze by the time it is a straight away.
       */
      const dilute = Math.pow(s0 / sz, 1.35);
      // Fade in fast, out slow: a plume has a hard leading edge and a long tail.
      data[d4 + 1] = this._sprayAlpha0[i] * dilute
        * smoothstep(0, 0.055, t) * (1 - smoothstep(0.55, 1.0, t));
      live++;
    }
    this._sprayLive = live;
    this.sprayMesh.visible = live > 0;
    this.sprayMesh.geometry.instanceCount = live > 0 ? MAX_SPRAY : 0;
    this._sprayPosAttr.needsUpdate = true;
    this._sprayDataAttr.needsUpdate = true;
  }

  /**
   * Emission. The rooster tail is not smoke: it is the water film picked up by
   * the contact patch, flung tangentially off the back of the tyre and then
   * torn apart by the wake. So the emission rate scales with (water depth x
   * speed x tyre width) and the ejection velocity with the wheel's surface
   * speed, not with the car's.
   */
  _emitCarSpray(car, dt) {
    const v = car.vehicle;
    const speed = v.speed;
    if (speed < 6) return;

    const water = this.waterDepthAt(v.trackS, v.trackLateral);
    const wet = clamp(water * 2.6, 0, 1);
    if (wet < 0.04) return;

    let lod = 1;
    if (this.camera) {
      const d = this.camera.position.distanceTo(v.position);
      if (d > 340) return;
      // Hard LOD curve. A rooster tail is a fill-rate problem, not a particle
      // problem: the two or three cars actually filling the frame need an order
      // of magnitude more particles than the seventeen that do not.
      lod = d < 45 ? 1 : d < 110 ? 0.42 : d < 210 ? 0.18 : 0.075;
    }
    /**
     * LOD COARSENS THE PLUME, IT DOES NOT SHRINK IT.
     *
     * Simply emitting a fifth of the particles for a distant car makes its
     * rooster tail a fifth as opaque, and a wide shot of the pack then shows
     * twenty cars with wisps — the exact opposite of what a wet race looks like
     * from a helicopter. Integrated opacity goes as count x area, so trading
     * count for area holds the silhouette roughly constant and only gives up
     * internal detail, which is not resolvable at that range. The exponent is
     * 0.35 rather than a full 0.5 because twenty distant cars' plumes OVERLAP,
     * and a trade that is exactly opacity-neutral per car therefore over-delivers
     * badly for the pack.
     */
    const grain = Math.min(2.3, Math.pow(lod, -0.35));

    const yaw = v.yaw;
    _fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    _rgt.set(Math.cos(yaw), 0, -Math.sin(yaw));

    const speed01 = clamp(speed / 78, 0, 1);
    let carry = this._sprayCarry.get(car) ?? 0;
    const rate = wet * speed01 * 1500 * lod * dt;
    carry += rate;
    const budget = Math.floor(carry);
    this._sprayCarry.set(car, carry - budget);
    if (budget <= 0) return;

    const rng = this.rng;
    /**
     * NEAR-WAKE ENTRAINMENT — the single thing that decides whether a rooster
     * tail exists at all.
     *
     * The obvious model is that the contact patch throws water BACKWARDS, so the
     * droplets get a large negative world-frame velocity. Measured, that model
     * produces no visible plume whatsoever at racing speed: the car is doing
     * 88 m/s, the spray is doing -20, so the closing rate is over 100 m/s and the
     * car has left its own plume behind within a couple of frames. A probe of the
     * live buffer found 11153 particles alive and only 688 of them inside 10 m of
     * a chase camera 6.5 m behind the car — the plume existed, 60 metres back,
     * pointed at nobody.
     *
     * What actually happens is that the air in the first few metres behind a
     * closed-wheel wake is dragged along at 50-90% of the car's speed, and the
     * atomised water is small enough to go wherever that air goes. So the plume
     * travels WITH the car, decelerating under drag, and the trail is what is
     * left behind as it loses the race. `carry` is that entrainment fraction:
     * near-unity for the fine veil, lower for the heavy droplets the wake cannot
     * hold onto.
     */
    const travel = speed * dt;
    const spread = 1.2 + speed01 * 3.0;

    for (let k = 0; k < budget; k++) {
      // THREE POPULATIONS, and they do different jobs.
      //   veil  (0-2/7) big, near-transparent, slow — the wall of grey that
      //         actually hides the car behind. This is the signature look.
      //   rear  (3-5/7) the rooster tail proper: thrown up and back off the rear
      //         contact patches, grows hard, this is the plume's shape.
      //   sheet (6/7)   the low, fast, fine spray torn off all four contact
      //         patches at road level.
      const roll = k % 7;
      const veil = roll < 3;
      const rear = roll >= 3 && roll < 6;
      const side = (k & 1) ? 1 : -1;

      // Spread the burst along the metre-plus of track the car covered this
      // frame. Without this every particle in a frame spawns at one point and
      // the plume comes out as a string of beads at 250 km/h.
      const jitter = travel * (k / budget);
      const axleZ = veil ? -1.5 - rng() * 3.1 : (rear ? -1.98 : (roll === 6 && (k & 2) ? 1.62 : -1.98));
      const half = veil ? (rng() - 0.5) * 3.2 : (rear ? 0.84 : 0.76) * side;

      _v.copy(v.position)
        .addScaledVector(_fwd, axleZ - jitter)
        .addScaledVector(_rgt, half + (rng() - 0.5) * 0.30);
      // The veil is a VOLUME, not a surface: it has to occupy the air the car
      // has just vacated, from the road up past the airbox, or the camera sees
      // over the top of it and the car never disappears.
      // The veil is born across the FULL HEIGHT of the wake, not on the road: an
      // F1 diffuser and rear wing generate a violent upwash that carries the
      // atomised fraction two or three metres up before it has travelled a car
      // length. Spawning it at ankle height and hoping it climbs does not work.
      _v.y += veil ? 0.12 + rng() * (1.3 + speed01 * 1.9)
        : (rear ? 0.05 + rng() * 0.16 : 0.02 + rng() * 0.07);

      const up = veil ? (1.5 + rng() * 2.6 + speed01 * 1.6)
        : rear ? (1.6 + rng() * 2.6 + speed01 * 2.6)
          : (0.35 + rng() * 0.8);
      const carry = veil ? (0.74 + rng() * 0.19)
        : rear ? (0.50 + rng() * 0.26) : (0.24 + rng() * 0.22);
      _v2.copy(_fwd).multiplyScalar(speed * carry)
        .addScaledVector(_rgt, side * (rear ? 1.0 + rng() * 2.0 : 0.4 + rng() * 1.1)
          + (rng() - 0.5) * spread);
      _v2.y = up;

      const big = rear && rng() < 0.5;
      // Sizes are LARGER at birth than they used to be and the growth is now
      // sqrt-shaped (see `_updateSpray`), so adjacent sprites overlap from the
      // instant they are born instead of a third of a second later.
      const size = (veil ? 0.85 + rng() * 1.05
        : big ? 0.34 + rng() * 0.40 : 0.14 + rng() * 0.20) * grain;
      this._spawnSpray(
        _v.x, _v.y, _v.z, _v2.x, _v2.y, _v2.z,
        {
          size,
          // grow is now metres per sqrt(second): the puff reaches size0 + grow
          // after one second and 70% of that after half a second.
          grow: (veil ? 1.30 + rng() * 1.30 : big ? 1.00 + rng() * 0.95 : 0.50 + rng() * 0.55) * grain,
          life: veil ? (1.05 + rng() * 1.15)
            : (big ? 0.62 : 0.32) + rng() * (big ? 0.70 : 0.34),
          // Low drag on the veil so it keeps drifting back and stretches into a
          // wake instead of stalling into a vertical column above the gearbox —
          // which is exactly what the old 1.05-1.65 range produced.
          drag: veil ? 0.42 + rng() * 0.34 : rear ? 1.05 + rng() * 0.75 : 2.0 + rng() * 1.4,
          // Terminal velocity, expressed as the gravity that survives drag.
          grav: veil ? 0.55 + rng() * 0.75 : big ? 4.6 + rng() * 2.0 : 6.4 + rng() * 2.4,
          // Per-sprite opacity is deliberately low and the plume is built by
          // ACCUMULATION — that is what gives it a soft, deep interior instead
          // of a stack of visible discs. The sprite profile is a smooth
          // (1-r^2)^2 times a noise field averaging ~1.0, so these read almost
          // literally as peak coverage.
          // Read as peak coverage AT BIRTH; the dilution in `_updateSpray`
          // takes it down from here as the puff expands.
          alpha: (veil ? 0.098 : big ? 0.180 : 0.100)
            * (0.55 + wet * 0.85) * (0.55 + speed01 * 0.75),
          seed: rng(),
        },
      );
    }

    // Flat splash crowns thrown sideways where the tyre displaces the film.
    const crowns = wet > 0.25 ? Math.floor(speed01 * 3.4 * lod + rng()) : 0;
    for (let k = 0; k < crowns; k++) {
      const side = rng() < 0.5 ? 1 : -1;
      const front = rng() < 0.42;
      _v.copy(v.position)
        .addScaledVector(_fwd, (front ? 1.62 : -1.98) - travel * rng())
        .addScaledVector(_rgt, side * (front ? 0.78 : 0.86));
      _v.y += 0.02;
      // Crowns are heavy water at the road: barely entrained, thrown sideways.
      _v2.copy(_rgt).multiplyScalar(side * (3.4 + rng() * 5.0))
        .addScaledVector(_fwd, speed * 0.16);
      _v2.y = 0.9 + rng() * 1.5;
      this._spawnSpray(_v.x, _v.y, _v.z, _v2.x, _v2.y, _v2.z, {
        size: 0.14 + rng() * 0.18, grow: 1.35, life: 0.26 + rng() * 0.24,
        drag: 3.4, alpha: 0.115 * wet, seed: rng(), flat: 0.85,
      });
    }
  }

  // =========================================================================
  // Mist
  // =========================================================================

  _buildMist() {
    if (!this.scene || !this.circuit) return;
    const c = this.circuit;
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('aCorner', new THREE.BufferAttribute(new Float32Array([
      -1, -1, 1, -1, 1, 1, -1, 1,
    ]), 2));
    geo.setIndex([0, 1, 2, 0, 2, 3]);

    const banks = new Float32Array(MIST_BANKS * 4);
    const param = new Float32Array(MIST_BANKS * 3);

    // Prefer the low-lying parts of the circuit: mist collects in dips.
    const order = [];
    for (let i = 0; i < c.samples.length; i += 4) order.push(i);
    order.sort((a, b) => c.samples[a].position.y - c.samples[b].position.y);

    for (let b = 0; b < MIST_BANKS; b++) {
      // Two thirds in the lowest third of the circuit, the rest spread out.
      const pick = this.rng() < 0.66
        ? order[Math.floor(this.rng() * order.length * 0.34)]
        : order[Math.floor(this.rng() * order.length)];
      const s = pick * c.step;
      const lat = (this.rng() < 0.5 ? -1 : 1) * (c.halfWidth + 40 + this.rng() * 110);
      const p = c.pointAt(s, lat, 0);
      banks[b * 4] = p.x;
      banks[b * 4 + 1] = p.y + 0.5;
      banks[b * 4 + 2] = p.z;
      banks[b * 4 + 3] = 45 + this.rng() * 85;          // half length
      param[b * 3] = 2.2 + this.rng() * 3.4;            // half height
      param[b * 3 + 1] = this.rng();
      param[b * 3 + 2] = this.rng();
    }

    geo.setAttribute('aBank', new THREE.InstancedBufferAttribute(banks, 4));
    geo.setAttribute('aParam', new THREE.InstancedBufferAttribute(param, 3));
    geo.instanceCount = MIST_BANKS;
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    this.mistMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uWindXZ: { value: new THREE.Vector3() },
        uColour: { value: new THREE.Color(0.22, 0.24, 0.27) },
        uOpacity: { value: 0 },
      },
      vertexShader: MIST_VERT,
      fragmentShader: MIST_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.NormalBlending,
      side: THREE.DoubleSide,
    });

    this.mistMesh = new THREE.Mesh(geo, this.mistMaterial);
    this.mistMesh.frustumCulled = false;
    this.mistMesh.renderOrder = 26;
    this.mistMesh.visible = false;
    this.mistMesh.name = 'MistBanks';
    this.scene.add(this.mistMesh);
  }

  // =========================================================================
  // Visor
  // =========================================================================

  _buildVisor() {
    if (!this.scene) return;
    const geo = new THREE.PlaneGeometry(2, 2);
    this.visorMaterial = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uAmount: { value: 0 },
        uSpeed01: { value: 0 },
        uAspect: { value: 16 / 9 },
        uSkyColour: { value: new THREE.Color(0.2, 0.22, 0.26) },
        uSunColour: { value: new THREE.Color(0.9, 0.92, 0.96) },
      },
      vertexShader: VISOR_VERT,
      fragmentShader: VISOR_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending,
    });
    this.visorMesh = new THREE.Mesh(geo, this.visorMaterial);
    this.visorMesh.frustumCulled = false;
    this.visorMesh.renderOrder = 40;
    this.visorMesh.visible = false;
    this.visorMesh.name = 'VisorRain';
    this.scene.add(this.visorMesh);
  }

  // =========================================================================
  // State
  // =========================================================================

  /**
   * @param {string} name one of WEATHER_STATES (legacy aliases accepted)
   * @param {{immediate?:boolean, transition?:number}} o
   */
  setState(name, { immediate = false, transition } = {}) {
    const key = resolveState(name);
    this.state = key;
    this.target = { ...WEATHER_STATES[key] };
    if (transition !== undefined) this.transition = Math.max(0.001, transition);
    if (immediate) {
      this.params = { ...this.target };
      this.wetness = this.target.wetness;
      this.rain = this.target.rain;
      this.windAngle = 0.65;
      this._seedWater(this.target.wetness);
      this._publishWorldMap();
      this._updateDeck();
      this._applySky(true);
      this._applyMaterials();
      if (this.lighting) this.lighting.refreshEnvironment();
    }
    return this;
  }

  /**
   * Jump the water field straight to the steady state of a weather condition.
   *
   * `_stepWater` is an ODE whose fixed point is `inflow / removal`, so instead
   * of filling everything to capacity and waiting several minutes of simulated
   * running for a drying line to emerge, seed the ANSWER: lay down the rubber
   * profile the state implies (`lineSwept`) and evaluate the equilibrium
   * directly. A `?weather=drying` capture then opens on a bone-dry line with
   * damp edges and standing water in the basins, which is what the state means.
   *
   * The live simulation takes over from there unchanged — this is the same
   * equation, solved rather than integrated.
   */
  _seedWater(w) {
    if (!this.circuit) return;
    const n = this.n;
    const t = this.target;
    const rain = t.rain ?? 0;
    const swept = t.lineSwept ?? 0;
    const sun = this.sky ? this.sky.sunIntensity() : 0.5;
    const evapK = 0.0045 + 0.030 * sun + 0.0025 * ((t.windSpeed ?? 5) / 10);

    for (let i = 0; i < n; i++) {
      let lineSum = 0;
      for (let j = 0; j < LANES; j++) {
        const k = i * LANES + j;
        // Traffic falls off as a Gaussian either side of the ideal line, with a
        // long tail — twenty cars do not all take the same line.
        const d = this.lineDist[k];
        const traffic = Math.exp(-d * d * 0.72) * 0.86 + Math.exp(-d * d * 0.10) * 0.14;
        this.rubber[k] = swept * traffic;
        const u = swept * traffic * 1.15;
        this.usage[k] = u;

        const b = this.basin[k];
        const cap = this._capacityAt(k) * w;
        let wat;
        if (rain > 0.02) {
          // Steady state under continuous rainfall: a swept lane settles at a
          // THINNER film, it does not go dry. That is a wet race, not a drying one.
          const inflow = rain * 0.34 * (0.62 + 0.38 * b);
          const removal = evapK * (1 - 0.60 * b) + 0.95 * u * (1 - 0.84 * b);
          wat = inflow / Math.max(removal, 1e-4);
        } else {
          // No inflow: whatever traffic has already cleared is gone for good.
          wat = cap * (1 - 0.94 * smoothstep(0.0, 0.95, u));
        }
        this.water[k] = clamp(Math.min(wat, cap), 0, 1);
        if (d < 0.5) lineSum = this.water[k];
      }
      this.dryness[i] = clamp(1 - lineSum * 1.35, 0, 1);
      this.lineUsage[i] = 0;
    }
    this._refreshSampleView();
  }

  get label() { return this.params.label ?? WEATHER_STATES[this.state].label; }

  /** Human-readable summary for the HUD. */
  get conditions() {
    return {
      label: this.label,
      state: this.state,
      wetness: this.wetness,
      rain: this.rain,
      surfaceWater: this.surfaceWater,
      lineWater: this.lineWater,
      windSpeed: this.params.windSpeed,
      drying: this.rain < 0.02 && this.surfaceWater > 0.02,
    };
  }

  // =========================================================================
  // Grip model — consumed by physics/vehicle.js
  // =========================================================================

  /** Bilinear water depth (0..1) at a track position. */
  waterDepthAt(s, lateral = 0) {
    if (!this.circuit) return this.wetness;
    const c = this.circuit;
    const fi = c.wrapS(s) / c.step;
    const i0 = Math.floor(fi) % this.n;
    const i1 = (i0 + 1) % this.n;
    const fs = fi - Math.floor(fi);
    const lf = clamp((lateral - this.laneOffset[0]) / this.laneStep, 0, LANES - 1.001);
    const j0 = lf | 0, j1 = Math.min(LANES - 1, j0 + 1), fl = lf - j0;
    const a = lerp(this.water[i0 * LANES + j0], this.water[i0 * LANES + j1], fl);
    const b = lerp(this.water[i1 * LANES + j0], this.water[i1 * LANES + j1], fl);
    return lerp(a, b, fs);
  }

  /** 1 = bone dry, 0 = standing water. */
  drynessAt(s, lateral = 0) { return clamp(1 - this.waterDepthAt(s, lateral) * 1.35, 0, 1); }

  /**
   * Longitudinal/lateral grip multiplier, 1 = dry.
   *
   * The shape matters more than the numbers: a damp but rubbered-in line is
   * only slightly slower than dry, the transition off the line is sharp (this
   * is what makes a wet race), and standing water is a cliff.
   */
  gripAt(s, lateral = 0) {
    if (!this.circuit) return 1 - this.wetness * 0.35;
    const w = this.waterDepthAt(s, lateral);
    // 0.98 damp -> 0.80 wet line -> 0.58 off-line standing water.
    const film = smoothstep(0.0, 0.28, w);
    const deep = smoothstep(0.30, 0.85, w);
    return clamp(1 - film * 0.20 - deep * 0.24, 0.50, 1);
  }

  /**
   * Aquaplaning risk 0..1. The classic Horne relation puts the onset speed at
   * roughly 9*sqrt(tyre pressure in psi) knots for a smooth surface; an F1 wet
   * at ~22 psi lands near 42 knots (~22 m/s) in genuinely standing water, and
   * far higher once the tread can still clear it. Depth is what moves it.
   */
  aquaplaneRisk(s, lateral = 0, speed = 0) {
    const w = this.waterDepthAt(s, lateral);
    const depth = smoothstep(0.34, 0.95, w);
    if (depth <= 0) return 0;
    const onset = lerp(96, 30, depth);       // m/s at which the film wins
    return clamp((speed - onset * 0.62) / (onset * 0.55), 0, 1) * depth;
  }

  /**
   * Full surface probe. `Vehicle.surfaceProbe` only reads `grip` and `drag`
   * today; the rest is there for whoever wires aquaplaning into the tyre model.
   */
  probe(s, lateral = 0, speed = 0) {
    const water = this.waterDepthAt(s, lateral);
    const aqua = this.aquaplaneRisk(s, lateral, speed);
    return {
      water,
      aquaplane: aqua,
      // Aquaplaning is a collapse, not a slide: the contact patch leaves the
      // road entirely, so it multiplies on top of the wet grip loss.
      grip: this.gripAt(s, lateral) * (1 - aqua * 0.72),
      // Water resistance: roughly quadratic in speed, linear in depth.
      drag: water * water * 0.55 + water * 0.10,
    };
  }

  // =========================================================================
  // Per-frame
  // =========================================================================

  update(dt, cars, focus) {
    if (!this.enabled || dt <= 0) return;
    this.time += dt;

    // --- parameter interpolation -------------------------------------------
    const k = 1 - Math.exp(-dt / this.transition);
    const p = this.params, t = this.target;
    for (const key of Object.keys(t)) {
      if (typeof t[key] !== 'number') { p[key] = t[key]; continue; }
      p[key] = lerp(p[key], t[key], key === 'rain' ? Math.min(1, k * 3.2) : k);
    }
    this.wetness = p.wetness;
    this.rain = p.rain;

    // Wind wanders slowly; gusts are what make rain look alive.
    this.windAngle += (Math.sin(this.time * 0.11) + Math.sin(this.time * 0.037) * 0.6) * dt * 0.06;
    const gust = 1 + Math.sin(this.time * 0.83) * 0.16 + Math.sin(this.time * 0.29) * 0.10;
    const ws = p.windSpeed * gust;
    this.wind.set(Math.sin(this.windAngle) * ws, 0, Math.cos(this.windAngle) * ws);

    this._stepWater(dt, cars);
    this._updateDeck();
    this._applySky(false);
    this._applyMaterials();
    this._updateRain(dt, focus);
    this._updateSprayField(dt, cars);
    this._updateMist(dt);
    this._updateVisor(dt, cars);

    this._mapAge += dt;
    if (this._mapAge >= MAP_PERIOD) { this._mapAge = 0; this._publishWorldMap(); }
  }

  // -- water simulation -----------------------------------------------------

  _stepWater(dt, cars) {
    if (!this.circuit) return;
    const n = this.n;
    const water = this.water, usage = this.usage, basin = this.basin;

    // Cars wipe the water they drive through. Deposit first so the pass below
    // sees this frame's traffic.
    if (cars) {
      for (const car of cars) {
        const v = car.vehicle;
        if (!v || v.speed < 3) continue;
        const i = this.circuit.sampleIndex(v.trackS);
        const lf = clamp((v.trackLateral - this.laneOffset[0]) / this.laneStep, 0, LANES - 1);
        const j0 = Math.round(lf);
        const speedF = clamp(v.speed / 55, 0, 1.15);
        // A car is ~2 m wide on a ~0.7 m lane pitch: three lanes, weighted.
        for (let dj = -2; dj <= 2; dj++) {
          const j = j0 + dj;
          if (j < 0 || j >= LANES) continue;
          const wj = Math.exp(-(dj * dj) / 1.8);
          for (let di = -2; di <= 2; di++) {
            const ii = (i + di + n) % n;
            usage[ii * LANES + j] = Math.min(2.4, usage[ii * LANES + j] + speedF * wj * 0.55);
          }
        }
      }
    }

    const rain = this.rain;
    const sun = this.sky ? this.sky.sunIntensity() : 0.5;
    const rubber = this.rubber;
    // Rubber builds where traffic runs and is scrubbed away by standing water.
    // TAU_LAY ~ 95 s of continuous traffic to saturate a lane, which at racing
    // speed is a handful of laps — the drying line arrives on the timescale a
    // driver would expect it to, not instantly and not never.
    const layK = dt / 95;
    const washK = dt / 260;

    // THE MODEL. Deposition is a source term; removal is PROPORTIONAL TO DEPTH
    // (a tyre displaces a fraction of the film it rolls over, and evaporation
    // scales with wetted area). That single choice is what makes the whole
    // thing behave: the equilibrium depth is source / removal, so in heavy rain
    // the racing line settles at a THINNER film rather than going dry, and the
    // moment the rain stops the same equation becomes an exponential decay
    // whose rate is set by how much traffic that lane sees. A drying line
    // appears on its own, and no amount of running can clear a basin.
    const inflow = rain * 0.34 * dt;
    const evapK = 0.0045 + 0.030 * sun + 0.0025 * (this.params.windSpeed / 10);
    const wipeK = 0.95;
    const usageDecay = Math.exp(-dt * 1.4);
    // The sky's own wetness target is a ceiling: a state with wetness 0 must
    // actually dry out, even where the basins would hold water forever.
    const ceiling = this.params.wetness;

    let sum = 0, lineSum = 0;
    for (let i = 0; i < n; i++) {
      const racing = this.circuit.samples[i].racing;
      const lineLane = clamp((racing - this.laneOffset[0]) / this.laneStep, 0, LANES - 1);
      const li = Math.round(lineLane);
      for (let j = 0; j < LANES; j++) {
        const kk = i * LANES + j;
        const b = basin[kk];
        let w = water[kk];
        const u = usage[kk];
        usage[kk] = u * usageDecay;

        // Slow rubber integral (see `_capacityAt`).
        const r = rubber[kk];
        rubber[kk] = clamp(r + u * layK - r * washK * (0.3 + w * 3.0), 0, 1);
        const cap = (0.34 + 0.66 * b) * (1 - 0.62 * smoothstep(0.05, 0.85, rubber[kk])) * ceiling;

        w += inflow * (0.62 + 0.38 * b);
        // A basin cannot be swept clean — the water runs straight back in.
        // That is exactly why a drying line follows the crown and never the
        // gutter, and why the puddles are the last thing to go.
        // Three removal channels: evaporation, this frame's tyres, and gravity
        // draining off a polished rubbered surface that water cannot key into.
        const removal = evapK * (1 - 0.60 * b)
          + wipeK * u * (1 - 0.84 * b)
          + 0.085 * rubber[kk] * (1 - 0.70 * b);
        w -= w * Math.min(0.95, removal * dt);
        // Drainage back toward what this weather can hold.
        if (w > cap) w -= (w - cap) * Math.min(1, dt * 0.5);
        water[kk] = w < 0 ? 0 : (w > 1 ? 1 : w);
        sum += water[kk];
      }
      lineSum += water[i * LANES + li];
      // Legacy per-sample view: dryness on the racing line.
      this.dryness[i] = clamp(1 - water[i * LANES + li] * 1.35, 0, 1);
      this.lineUsage[i] = usage[i * LANES + li];
    }
    this.surfaceWater = sum / (n * LANES);
    this.lineWater = lineSum / n;

    this._sampleViewAge = (this._sampleViewAge ?? 0) + dt;
    if (this._sampleViewAge > 0.2) { this._sampleViewAge = 0; this._refreshSampleView(); }
  }

  _refreshSampleView() {
    const d = this._texData;
    for (let i = 0; i < this.n; i++) {
      const b = Math.round(clamp(this.dryness[i], 0, 1) * 255);
      d[i * 4] = b; d[i * 4 + 1] = b; d[i * 4 + 2] = b;
    }
    this.trackWetnessTexture.needsUpdate = true;
  }

  // -- sky / lighting / exposure -------------------------------------------

  _applySky(immediate) {
    const p = this.params;
    const sky = this.sky;
    if (sky) {
      sky.setClouds({
        coverage: p.cloudCoverage,
        density: p.cloudDensity,
        base: p.cloudBase,
        thickness: p.cloudThickness,
      });
      // A thick deck is a DARK sky, not just a cloudy one. Dimming the sky's
      // own radiance alongside the key light is what stops the auto-exposure
      // from clawing the brightness back and blowing the cloud tops out.
      sky.uniforms.uIntensity.value = this._skyIntensity0 * p.skyDim;
      sky.windSpeed = this._skyWind0 * (0.7 + p.windSpeed / 9);
    }

    const lighting = this.lighting;
    if (lighting) {
      // syncToSky() rewrites sun.intensity from the sky alone, so it has to run
      // BEFORE the weather scale is applied on top of it.
      if (immediate) lighting.syncToSky();
      const sunI = sky ? sky.sunIntensity() : 0.8;
      // Same formula lighting.syncToSky() uses, scaled — lighting reads the
      // ratio back as `_weatherScale`, so the night floodlights survive.
      lighting.sun.intensity = (0.35 + 3.6 * sunI) * p.sunScale;
      // `envScale` is a RATIO (1.00 dry, 1.22 storm), not an absolute. It used
      // to go through `setEnvironmentIntensity`, which takes an absolute — so
      // `setState('dry')` at boot overwrote `lighting`'s calibrated sky/sun
      // split with a flat 1.0 and the shadows went black. See the two-field note
      // on `baseEnvironmentIntensity` in lighting.js.
      lighting.setEnvironmentScale(p.envScale);
      /**
       * EXPOSURE TRIM, in stops.
       *
       * This used to be written to `sky.exposureCompensation`, which
       * `lighting._updateExposure()` does read — but `sky.js` assigns that same
       * field from its own time-of-day profile on every update, so the weather's
       * trim was silently clobbered before it was ever consumed. Measured: a
       * sweep from ev = -0.06 to -0.75 moved the metered exposure by exactly
       * zero. Scaling `exposureBias` is algebraically the same control
       * (`e = bias / (1.2 * 2^target)`, so bias *= 2^ev shifts the result by ev
       * stops) and nothing else writes it.
       */
      lighting.exposureBias = this._exposureBias0 * Math.pow(2, p.ev);
      lighting.aerialStrength = this._aerialStrength0 * p.fogScale;
      // Mist hugs the ground: shortening the haze height scale concentrates the
      // in-scattering into the first few metres of air.
      lighting.aerialHeightScale = lerp(this._aerialHeight0, 420, p.mist);
    }
  }

  _applyMaterials() {
    const p = this.params;
    const film = clamp(this.surfaceWater * 2.2, 0, 1);
    const u = this.trackUniforms;
    if (u) {
      // uWetGlobal is a FADE, not a depth scale. It used to be
      // `surfaceWater * 3` , which meant the mean water over the whole circuit
      // multiplied every LOCAL depth: in the drying state a 0.30-deep puddle was
      // read by the shader as 0.09, and puddles and basins effectively did not
      // exist. It saturates as soon as there is any water at all, so the ONLY
      // thing that decides how wet a given square metre looks is the water field.
      u.uWetGlobal.value = clamp(Math.max(this.surfaceWater, p.wetness * 0.35) * 9, 0, 1);
      u.uWetTime.value = this.time;
      u.uWetRain.value = clamp(this.rain * 1.15, 0, 1);
      u.uWetWind.value.set(this.wind.x, this.wind.z);
      // Likewise a permission, gated locally by depth x basin inside the shader.
      u.uWetPuddle.value = clamp(Math.max(p.wetness, this.surfaceWater * 2.4) * 2.4, 0, 1);
    }
    if (this.trackMaterial) {
      /**
       * ENERGY CONSERVATION AT GRAZING INCIDENCE — capped at 1.0, not 1.35.
       *
       * The old value claimed 1.35 was "as far as this can go before wet tarmac
       * starts out-radiating the sky", which is the wrong way round: at the
       * grazing angles a wet track spends most of its screen area at, Fresnel
       * already takes the reflectance to ~1, so an envMapIntensity of 1.35 has
       * the road returning 135% of the sky that lights it. The visible result was
       * that the far half of every long-lens shot went PALER than the ceiling
       * above it — a milky wash exactly where the frame should be at its most
       * mirror-black. Water reflects all of the sky at grazing incidence and
       * never more, and the header of this file already said so.
       */
      this.trackMaterial.envMapIntensity = lerp(this._trackEnv0, 1.0, film);
    }
    for (const s of this.secondary) {
      const m = s.mat;
      m.roughness = lerp(s.rough0, s.rough0 * s.rough, film);
      if (s.colour0 && m.color) m.color.copy(s.colour0).multiplyScalar(lerp(1, s.darken, film));
      m.envMapIntensity = lerp(s.env0, s.env0 * 1.8 + 0.25, film);
    }
    for (const m of this.carMaterials) m.setWetness?.(clamp(film * 0.85 + this.rain * 0.35, 0, 1));
    // Rain lights come on with the spray, exactly as the regulations require.
    const lightOn = this.rain > 0.10 || this.surfaceWater > 0.12;
    if (lightOn !== this._rainLightOn) {
      this._rainLightOn = lightOn;
      for (const m of this.carMaterials) m.setRainLight?.(lightOn);
    }
    if (this.particles) {
      // `setWetness` is what suppresses dry smoke and dust in the rain, so it
      // still gets the true film depth.
      this.particles.setWetness?.(clamp(film, 0, 1));
      /**
       * BUT: `fx/particles.js` also runs its own spray pool from
       * `driveFromCar(car, dt, wetness)`, and `setWetness` takes that pool to
       * uOpacity 1.0. With this module now owning a full entrained rooster tail,
       * the two systems double-count, and measurement showed it was the
       * PARTICLES pool — not this one — that turned a long-lens broadcast shot
       * into an opaque white wall across two thirds of the frame (hiding the
       * spray mesh entirely left the wall untouched; damping this uniform
       * removed it).
       *
       * The division of labour: particles.js keeps the tight, bright spray at
       * the contact patches, weather.js owns the plume. This is the only place
       * this module reaches into another's internals, it is one uniform, and it
       * is applied after their own setter so nothing is fighting over it.
       */
      const pool = this.particles.spray?.material?.uniforms?.uOpacity;
      if (pool) pool.value = clamp(film * 1.6, 0, 1) * 0.30;
    }
  }

  /**
   * Absolute ambient radiance of whatever is actually above the car — the
   * atmosphere probes when the sky is open, the stratus ceiling when it is
   * not. Rain, spray and mist are all optically thick water: their radiance is
   * this number times an albedo, and authoring them any other way is how a
   * spray plume ends up brighter than the sky it is lit by.
   */
  _ambientRadiance() {
    const p = this.params;
    const open = this.sky ? this.sky.averageLuminance() : 0.25;
    const deck = (p.deck ?? 0) * (p.deckLum ?? 0);
    return Math.max(open * (1 - (p.deck ?? 0) * 0.55), deck * 0.92);
  }

  // -- rain -----------------------------------------------------------------

  _updateRain(dt, focus) {
    if (!this.rainMesh) return;
    const u = this.rainMaterial.uniforms;
    const cam = this.camera;
    const eye = cam ? cam.position : (focus ?? _v.set(0, 0, 0));

    if (cam) {
      if (!this._camPrimed) { this._camPrev.copy(eye); this._camPrimed = true; }
      _prevCam.copy(eye).sub(this._camPrev).divideScalar(Math.max(dt, 1e-4));
      // Heavy smoothing: a capture teleports the camera and an un-smoothed
      // velocity would turn one frame of rain into radial white noise.
      this._camVel.lerp(_prevCam, clamp(dt * 6, 0, 1));
      if (this._camVel.lengthSq() > 160 * 160) this._camVel.setLength(160);
      this._camPrev.copy(eye);
      u.uAspect.value = cam.aspect || 16 / 9;
    }

    const rain = this.rain;
    this.rainMesh.visible = rain > 0.015;
    if (!this.rainMesh.visible) return;

    u.uTime.value = this.time;
    u.uCamPos.value.copy(eye);
    u.uCamVel.value.copy(this._camVel);
    u.uWind.value.copy(this.wind).multiplyScalar(0.55);
    // Terminal velocity of a raindrop is 5-9 m/s; heavier rain = bigger drops.
    u.uFall.value = lerp(5.4, 9.2, rain);
    u.uShutter.value = lerp(0.014, 0.024, rain);
    u.uMaxStreak.value = lerp(0.45, 1.05, rain);
    u.uDensity.value = clamp(0.14 + rain * 0.86, 0, 1);
    u.uWidthPx.value = lerp(0.0055, 0.0115, rain);
    // Streaks are the only cue that it is RAINING rather than that the track is
    // merely wet, and the previous 0.42 ceiling lost them entirely against a
    // bright overcast deck. They still peak well below the 1.25 bloom threshold
    // because the colour below is an albedo times the ambient radiance.
    u.uOpacity.value = clamp(0.14 + rain * 0.50, 0, 0.66);

    // Rain is lit by the sky it falls through, plus a little direct sun.
    if (this.sky) {
      this.sky.skyColour(_col);
      _col.multiplyScalar(this._ambientRadiance() * 1.15);
      this.sky.sunColour(_col2);
      _col2.multiplyScalar(this.sky.sunIntensity() * this.params.sunScale * 0.16);
      u.uColour.value.copy(_col).add(_col2);
    }
  }

  // -- spray ----------------------------------------------------------------

  _updateSprayField(dt, cars) {
    if (!this.sprayMesh) return;
    if (cars && this.surfaceWater > 0.008) {
      for (const car of cars) this._emitCarSpray(car, dt);
    }
    this._updateSpray(dt);

    const u = this.sprayMaterial.uniforms;
    if (this.sky && this.camera) {
      this.sky.skyColour(_col);
      // An optically thick cloud of water droplets cannot out-radiate the sky
      // that lights it; 1.05 is the multiple-scattering bonus and nothing more.
      u.uSkyColour.value.copy(_col).multiplyScalar(this._ambientRadiance() * 1.05);
      this.sky.sunColour(_col2);
      u.uSunColour.value.copy(_col2)
        .multiplyScalar(clamp(this.sky.sunIntensity() * this.params.sunScale * 0.55, 0, 0.55));
      // Sun direction in view space, pointing FROM the fragment toward the sun.
      _v.copy(this.sky.sunDirection).transformDirection(this.camera.matrixWorldInverse);
      u.uSunDirView.value.copy(_v);
    }
    u.uOpacity.value = 1;
  }

  // -- mist -----------------------------------------------------------------

  _updateMist(dt) {
    if (!this.mistMesh) return;
    const m = clamp(this.params.mist, 0, 1);
    this.mistMesh.visible = m > 0.02;
    if (!this.mistMesh.visible) return;
    const u = this.mistMaterial.uniforms;
    u.uTime.value = this.time;
    u.uWindXZ.value.set(this.wind.x * 0.16, 0, this.wind.z * 0.16);
    // Banks have to be a readable FEATURE — a discrete sheet lying in a dip with
    // the barrier showing through it — not a global veil. At 0.15 they were below
    // the noise floor of the aerial perspective they were sitting inside, so the
    // only mist in the frame came from fog and read as a flat wash.
    u.uOpacity.value = m * 0.42;
    if (this.sky) {
      this.sky.skyColour(_col);
      u.uColour.value.copy(_col).multiplyScalar(this._ambientRadiance() * 0.85);
    }
  }

  // -- visor ----------------------------------------------------------------

  _updateVisor(dt, cars) {
    if (!this.visorMesh) return;
    const mode = this.rig?.mode;
    const inHelmet = mode === 'cockpit' || mode === 'halo';
    const amount = inHelmet ? clamp(this.rain * 1.25, 0, 1) : 0;
    this._visorAmount = lerp(this._visorAmount ?? 0, amount, clamp(dt * 2.5, 0, 1));
    this.visorMesh.visible = this._visorAmount > 0.02;
    if (!this.visorMesh.visible) return;
    const u = this.visorMaterial.uniforms;
    u.uTime.value = this.time;
    u.uAmount.value = this._visorAmount * 0.85;
    const speed = cars?.[0]?.vehicle?.speed ?? 0;
    u.uSpeed01.value = clamp(speed / 80, 0, 1);
    u.uAspect.value = this.camera?.aspect ?? 16 / 9;
    if (this.sky) {
      this.sky.skyColour(_col);
      u.uSkyColour.value.copy(_col).multiplyScalar(this._ambientRadiance() * 1.4);
      this.sky.sunColour(_col2);
      u.uSunColour.value.copy(_col2).multiplyScalar(this.sky.sunIntensity() * this.params.sunScale * 0.4);
    }
  }

  // =========================================================================

  dispose() {
    this.deckMesh?.geometry.dispose();
    this.deckMaterial?.dispose();
    this.rainMesh?.geometry.dispose();
    this.rainMaterial?.dispose();
    this.sprayMesh?.geometry.dispose();
    this.sprayMaterial?.dispose();
    this.mistMesh?.geometry.dispose();
    this.mistMaterial?.dispose();
    this.visorMesh?.geometry.dispose();
    this.visorMaterial?.dispose();
    this.trackWetnessTexture?.dispose();
    this.wetMapTexture?.dispose();
  }
}
