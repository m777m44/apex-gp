/**
 * APEX GP — post-processing stack.
 *
 * A hand-rolled deferred-ish post pipeline. It does NOT use EffectComposer:
 * TAA needs a history ping-pong, bloom needs a mip chain and motion blur needs
 * a velocity buffer, none of which the composer's read/write model expresses
 * cleanly. Passes are explicit and the ordering below is load bearing.
 *
 *   1  G-BUFFER      one geometry prepass -> view normal + screen velocity + depth
 *   2  SCENE         HDR linear colour (jittered projection when TAA is on)
 *   3  GTAO          horizon-search AO, fed from the prepass (no second geo pass)
 *   4  RESOLVE       AO modulation + temporal AA (reprojection + variance clip)
 *   5  DOF           thin-lens CoC + always-on far-field defocus, half-res bokeh
 *   6  MOTION BLUR   tile-max / neighbour-max + McGuire reconstruction filter
 *   7  BLOOM         karis-averaged threshold, 6-mip down/up (Jimenez) chain
 *   8  COMPOSITE     barrel + CA, lens flare/dirt, exposure, ACES, LUT -> sRGB
 *   9  SMAA          display-referred edge AA
 *  10  FINISH        CAS sharpen, vignette, exposure-scaled grain, dither
 *
 * THE EXPOSURE PATH (there is exactly one, do not add another)
 *
 *   lighting.js meters the scene -> renderer.toneMappingExposure
 *     -> PostFX.render() reads it ONCE as `exposure`
 *       -> bloom prefilter   (threshold/clamp are therefore in EXPOSED units)
 *       -> composite         (col = scene * exposure, then ACES, then sRGB)
 *
 *   `renderer.toneMapping` is NoToneMapping and `outputColorSpace` never
 *   applies inside this stack (three only encodes when drawing to the canvas,
 *   and every pass here targets a render target). The composite owns the one
 *   tone map and the one sRGB encode; the LDR targets are NoColorSpace so SMAA
 *   and the finish pass cannot encode a second time.
 *
 * Bloom is authored in exposed units: `threshold = 1.25` means "25% above
 * diffuse white". The up chain is weighted by `bloom.scatter` and normalised by
 * `1 - scatter` so it is energy-preserving — see `_bloomGain()`.
 *
 * The velocity buffer is per-object: every renderable gets a cached prepass
 * material carrying its previous world matrix, so a spinning wheel or a car
 * crossing the frame smears correctly while the chase-locked bodywork stays
 * sharp. Static geometry falls out of the same maths as camera reprojection.
 */

import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { makeRng, clamp } from '../core/rng.js';

// ---------------------------------------------------------------------------
// Shared GLSL
// ---------------------------------------------------------------------------

const QUAD_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }
`;

/** Depth helpers shared by AO-aware passes. */
const DEPTH_GLSL = /* glsl */ `
  uniform sampler2D tDepth;
  uniform float uNear;
  uniform float uFar;
  float rawDepth( vec2 uv ) { return texture( tDepth, uv ).x; }
  float linearDepth( vec2 uv ) {
    float d = texture( tDepth, uv ).x * 2.0 - 1.0;
    return ( 2.0 * uNear * uFar ) / ( uFar + uNear - d * ( uFar - uNear ) );
  }
`;

/**
 * ACES fitted (Stephen Hill). The three.js built-in is Narkowicz's cheaper
 * curve; the fitted RRT/ODT keeps highlight hue and desaturates hot pixels
 * the way a film print does, which is most of the "broadcast" feel.
 */
const ACES_GLSL = /* glsl */ `
  const mat3 ACES_IN = mat3(
    0.59719, 0.07600, 0.02840,
    0.35458, 0.90834, 0.13383,
    0.04823, 0.01566, 0.83777 );
  const mat3 ACES_OUT = mat3(
     1.60475, -0.10208, -0.00327,
    -0.53108,  1.10813, -0.07276,
    -0.07367, -0.00605,  1.07602 );
  vec3 rrtOdtFit( vec3 v ) {
    vec3 a = v * ( v + 0.0245786 ) - 0.000090537;
    vec3 b = v * ( 0.983729 * v + 0.4329510 ) + 0.238081;
    return a / b;
  }
  vec3 acesFitted( vec3 c ) {
    c = ACES_IN * c;
    c = rrtOdtFit( c );
    return max( ACES_OUT * c, vec3( 0.0 ) );
  }
`;

const LUMA_GLSL = /* glsl */ `
  float luma( vec3 c ) { return dot( c, vec3( 0.2126, 0.7152, 0.0722 ) ); }
`;

// ---------------------------------------------------------------------------
// 1. G-buffer prepass material (MRT: packed view normal + screen velocity)
// ---------------------------------------------------------------------------

const GBUFFER_VERT = /* glsl */ `
  uniform mat4 uPrevModelMatrix;
  uniform mat4 uCurrViewProj;
  uniform mat4 uPrevViewProj;
  varying vec3 vViewNormal;
  varying vec4 vCurrClip;
  varying vec4 vPrevClip;
  varying vec2 vMaskUv;

  void main() {
    vec4 objectPos = vec4( position, 1.0 );
    vec3 objectNormal = normal;
    #ifdef USE_INSTANCING
      objectPos = instanceMatrix * objectPos;
      objectNormal = mat3( instanceMatrix ) * objectNormal;
    #endif
    vec4 world = modelMatrix * objectPos;
    vec4 prevWorld = uPrevModelMatrix * objectPos;

    vViewNormal = normalize( normalMatrix * objectNormal );
    // Unjittered clip positions: the TAA jitter must not leak into velocity.
    vCurrClip = uCurrViewProj * world;
    vPrevClip = uPrevViewProj * prevWorld;
    vMaskUv = uv;

    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

const GBUFFER_FRAG = /* glsl */ `
  layout(location = 0) out vec4 gNormal;
  layout(location = 1) out vec4 gVelocity;

  varying vec3 vViewNormal;
  varying vec4 vCurrClip;
  varying vec4 vPrevClip;
  varying vec2 vMaskUv;

  #ifdef USE_MASK
    uniform sampler2D tMask;
    uniform float uAlphaTest;
  #endif

  void main() {
    #ifdef USE_MASK
      if ( texture( tMask, vMaskUv ).a < uAlphaTest ) discard;
    #endif
    vec3 n = normalize( vViewNormal );
    if ( ! gl_FrontFacing ) n = -n;
    gNormal = vec4( n * 0.5 + 0.5, 1.0 );

    vec2 curr = vCurrClip.xy / max( vCurrClip.w, 1e-6 );
    vec2 prev = vPrevClip.xy / max( vPrevClip.w, 1e-6 );
    gVelocity = vec4( ( curr - prev ) * 0.5, 0.0, 1.0 );
  }
`;

// ---------------------------------------------------------------------------
// 4. Resolve: AO modulation + temporal antialiasing
// ---------------------------------------------------------------------------

const RESOLVE_FRAG = /* glsl */ `
  uniform sampler2D tCurrent;
  uniform sampler2D tHistory;
  uniform sampler2D tVelocity;
  uniform sampler2D tAO;
  uniform sampler2D tNormal;
  uniform vec2  uTexel;
  uniform float uBlend;       // 0 = no history (TAA off)
  uniform float uAO;          // AO intensity
  uniform float uClampScale;  // variance clip gamma
  uniform vec2  uProjXY;      // tan(fov/2) * aspect, tan(fov/2)
  uniform float uContactRadius;    // metres
  uniform float uContactStrength;
  uniform float uContactMaxPx;
  uniform float uContactFar;       // metres; past this the gap is sub-pixel
  uniform float uShadowGuard;      // how much AO is held back in the deep shadows
  uniform float uDither;           // per-frame rotation for the contact spiral
  uniform mat4  uInvViewProj;      // unjittered, this frame
  uniform mat4  uPrevVP;           // unjittered, last frame
  uniform vec3  uCamPos;
  varying vec2 vUv;
  ${DEPTH_GLSL}
  ${LUMA_GLSL}

  vec3 viewPos( vec2 uv, float z ) { return vec3( ( uv * 2.0 - 1.0 ) * uProjXY * z, -z ); }

  /**
   * THE SKY HAS NO VELOCITY, AND ZERO IS THE ONE ANSWER THAT IS ALWAYS WRONG.
   *
   * The sky mesh carries userData.excludeFromGBuffer (it is a 128-step cloud
   * march; running it a second time for a prepass is not affordable), so every
   * sky pixel reads a CLEARED velocity of exactly 0. Under a yawing onboard
   * camera that tells the temporal filter the cumulus is nailed to the screen,
   * so it accumulates the same cloud across a pan and the result is the ~200 px
   * horizontal smear over the halo that no onboard camera has ever produced.
   *
   * A point at infinity needs no depth: take the view ray for this pixel, push
   * it 100 km out and project it with LAST frame's view-projection. The
   * translation term vanishes at that distance, so what survives is exactly the
   * camera's rotation — which is the only thing that can move the sky.
   */
  vec2 skyVelocity( vec2 uv ) {
    vec4 h = uInvViewProj * vec4( uv * 2.0 - 1.0, 1.0, 1.0 );
    vec3 dir = normalize( h.xyz / h.w - uCamPos );
    vec4 p = uPrevVP * vec4( uCamPos + dir * 1.0e5, 1.0 );
    return ( ( uv * 2.0 - 1.0 ) - p.xy / max( abs( p.w ), 1e-6 ) * sign( p.w ) ) * 0.5;
  }

  /**
   * CONTACT OCCLUSION — Alchemy AO (McGuire 2011), 8 taps, ~0.3 m.
   *
   * GTAO here runs at a 0.9 m world radius. That is the right scale for a wheel
   * arch, a sidepod undercut and a cockpit surround, and the WRONG scale for the
   * 50-70 mm of air between an F1 floor and the road: at 0.9 m the horizon search
   * averages the gap into a broad ambient term spread over the whole underbody,
   * and the tarmac directly beneath the plank comes out at the same luminance as
   * tarmac three metres behind it. The car reads as a sticker. Every Codemasters
   * title has a tight contact term here and it is the cheapest grounding cue
   * there is; a second 8-tap pass at a tenth of the radius costs a few hundred
   * microseconds and is the whole of it.
   *
   * It runs in the RESOLVE, i.e. before the near-field smear, so what the motion
   * blur gathers is an already-occluded surface — the shadow smears with the
   * road instead of being erased by it.
   */
  float contactAO( vec2 uv, float zC, float dither ) {
    float R = uContactRadius;
    float radPx = R / ( max( zC, 0.2 ) * max( uProjXY.y, 1e-4 ) ) * 0.5 / uTexel.y;
    // THE SCREEN RADIUS IS CAPPED AND THE WORLD RADIUS FOLLOWS IT DOWN.
    // 0.30 m lands on ~47 px at the 7 m a chase camera sits from the floor, and
    // on 800 px at the 0.35 m a cockpit camera sits from the driver's gloves —
    // at which point it stops being a contact term, doubles up with the 0.9 m
    // GTAO underneath it and simply crushes the whole near field. Shrinking the
    // world radius by the same factor keeps the falloff honest, so the term
    // degrades into a genuinely tight one instead of into a dark blob.
    if ( radPx > uContactMaxPx ) { R *= uContactMaxPx / radPx; radPx = uContactMaxPx; }
    if ( radPx < 2.0 ) return 1.0;
    vec3 nV = texture( tNormal, uv ).xyz * 2.0 - 1.0;
    if ( dot( nV, nV ) < 0.1 ) return 1.0;      // sky / cleared g-buffer
    nV = normalize( nV );
    vec3 pC = viewPos( uv, zC );
    float occ = 0.0;
    const float GA = 2.39996323;
    for ( int i = 0; i < 8; i++ ) {
      float t = ( float( i ) + 0.5 ) / 8.0;
      float a = ( float( i ) + dither ) * GA;
      vec2 o = vec2( cos( a ), sin( a ) ) * ( radPx * sqrt( t ) ) * uTexel;
      float zS = linearDepth( uv + o );
      vec3 v = viewPos( uv + o, zS ) - pC;
      float vv = dot( v, v );
      // Falloff by world distance, so a far occluder found at a near screen
      // offset (the classic halo) contributes nothing.
      float fall = clamp( 1.0 - vv / ( R * R ), 0.0, 1.0 );
      occ += fall * max( 0.0, dot( v, nV ) - 0.02 * zC ) / ( vv + 0.02 );
    }
    return clamp( 1.0 - uContactStrength * occ * 0.125, 0.0, 1.0 );
  }

  // Tone-mapped-space weighting keeps a single hot pixel from strobing.
  vec3 tm( vec3 c ) { return c / ( 1.0 + luma( c ) ); }
  vec3 untm( vec3 c ) { return c / max( 1.0 - luma( c ), 1e-4 ); }

  /**
   * HISTORY IS FETCHED WITH A CATMULL-ROM KERNEL, NOT bilinear.
   *
   * This is THE reason a 0.90-blend TAA reads as vaseline. Reprojection lands on
   * a subpixel offset every single frame, so a bilinear fetch low-passes the
   * accumulator once per frame; at 0.90 the frame you are looking at is ~10
   * generations of that filter deep. Measured on 'chase', the car region's mean
   * gradient went 9.51 (TAA off) -> 7.53 (TAA on, bilinear): a 21% loss of edge
   * energy on the SUBJECT, which is four times what the motion-blur pass was
   * costing it. A 9-tap Catmull-Rom collapsed to 5 bilinear fetches has a
   * sharpening lobe that almost exactly cancels the resample blur, and unlike a
   * post-sharpen it invents no ringing on stationary edges.
   *
   * The taps are normalised by their own weight sum: the 5-tap collapse drops
   * the four corner taps, and without renormalising it darkens the history by
   * ~2% per frame, which compounds into a visible vignette-shaped luma sag.
   */
  vec3 sampleHistory( vec2 uv ) {
    vec2 texSize = 1.0 / uTexel;
    vec2 sp = uv * texSize;
    vec2 tc1 = floor( sp - 0.5 ) + 0.5;
    vec2 f = sp - tc1;
    vec2 w0 = f * ( -0.5 + f * ( 1.0 - 0.5 * f ) );
    vec2 w1 = 1.0 + f * f * ( -2.5 + 1.5 * f );
    vec2 w2 = f * ( 0.5 + f * ( 2.0 - 1.5 * f ) );
    vec2 w3 = f * f * ( -0.5 + 0.5 * f );
    vec2 w12 = w1 + w2;
    vec2 tc0 = ( tc1 - 1.0 ) * uTexel;
    vec2 tc3 = ( tc1 + 2.0 ) * uTexel;
    vec2 tc12 = ( tc1 + w2 / max( w12, vec2( 1e-5 ) ) ) * uTexel;

    float k0 = w12.x * w0.y;
    float k1 = w0.x  * w12.y;
    float k2 = w12.x * w12.y;
    float k3 = w3.x  * w12.y;
    float k4 = w12.x * w3.y;
    vec3 c = texture( tHistory, vec2( tc12.x, tc0.y  ) ).rgb * k0
           + texture( tHistory, vec2( tc0.x,  tc12.y ) ).rgb * k1
           + texture( tHistory, vec2( tc12.x, tc12.y ) ).rgb * k2
           + texture( tHistory, vec2( tc3.x,  tc12.y ) ).rgb * k3
           + texture( tHistory, vec2( tc12.x, tc3.y  ) ).rgb * k4;
    return max( c / ( k0 + k1 + k2 + k3 + k4 ), vec3( 0.0 ) );
  }

  void main() {
    vec3 c = texture( tCurrent, vUv ).rgb;

    /*
     * AO IS FOLDED INTO THE NEIGHBOURHOOD, NOT JUST INTO THE CENTRE PIXEL.
     *
     * The variance clip builds its bounds from tCurrent, which is the raw scene
     * with no AO on it, while the history it clips carries last frame's AO. An
     * occluded pixel therefore looked like a rejected sample: 'rejected' went
     * large, the blend collapsed to ~0 and the temporal filter stopped
     * accumulating AO altogether. Multiplying the moment taps by the same factor
     * puts both sides in the same space, which both stops the rejection and lets
     * TAA denoise the 8-tap contact term for free.
     */
    float aoT = 1.0;
    #ifdef USE_AO
      aoT = texture( tAO, vUv ).r;
    #endif
    #ifdef USE_CONTACT
      float zAO = linearDepth( vUv );
      if ( zAO < uContactFar ) aoT = min( aoT, contactAO( vUv, zAO, uDither ) );
    #endif

    // AO NEVER DEEPENS AN ALREADY-BLACK PIXEL. Occlusion is a bound on incoming
    // ambient light; a face that is receiving almost none has nothing left to
    // occlude, and multiplying it again is exactly how a sunlit chase car's
    // beam wing, crash structure and diffuser collapse into one form-free slab.
    float aoMul = mix( 1.0, aoT, uAO * mix( uShadowGuard, 1.0, smoothstep( 0.012, 0.11, luma( c ) ) ) );
    c *= aoMul;

    if ( uBlend <= 0.001 ) { gl_FragColor = vec4( c, 1.0 ); return; }

    // Velocity dilation: take the motion of the closest fragment in a cross,
    // so silhouettes drag their own velocity rather than the background's.
    vec2 vel = texture( tVelocity, vUv ).xy;
    float dBest = rawDepth( vUv );
    vec2 off[ 4 ];
    off[ 0 ] = vec2( -uTexel.x, -uTexel.y );
    off[ 1 ] = vec2(  uTexel.x, -uTexel.y );
    off[ 2 ] = vec2( -uTexel.x,  uTexel.y );
    off[ 3 ] = vec2(  uTexel.x,  uTexel.y );
    for ( int i = 0; i < 4; i++ ) {
      vec2 u = vUv + off[ i ];
      float d = rawDepth( u );
      if ( d < dBest ) { dBest = d; vel = texture( tVelocity, u ).xy; }
    }

    // Sky pixels are at the cleared far plane and carry no velocity of their own.
    if ( dBest >= 0.999999 ) vel = skyVelocity( vUv );

    vec2 prevUv = vUv - vel;
    if ( prevUv.x < 0.0 || prevUv.x > 1.0 || prevUv.y < 0.0 || prevUv.y > 1.0 ) {
      gl_FragColor = vec4( c, 1.0 );
      return;
    }

    // 3x3 neighbourhood moments for variance clipping.
    vec3 m1 = vec3( 0.0 ), m2 = vec3( 0.0 );
    vec3 nmin = vec3( 1e9 ), nmax = vec3( -1e9 );
    for ( int y = -1; y <= 1; y++ ) {
      for ( int x = -1; x <= 1; x++ ) {
        vec3 s = tm( texture( tCurrent, vUv + vec2( float( x ), float( y ) ) * uTexel ).rgb * aoMul );
        m1 += s; m2 += s * s;
        nmin = min( nmin, s ); nmax = max( nmax, s );
      }
    }
    vec3 mu = m1 / 9.0;
    vec3 sigma = sqrt( max( m2 / 9.0 - mu * mu, vec3( 0.0 ) ) );
    vec3 lo = max( mu - uClampScale * sigma, nmin );
    vec3 hi = min( mu + uClampScale * sigma, nmax );

    vec3 hist = tm( sampleHistory( prevUv ) );
    vec3 clipped = clamp( hist, lo, hi );
    float rejected = length( hist - clipped );

    vec3 cur = tm( c );
    // Fast movers keep less history; a rejected sample keeps almost none.
    float speed = length( vel / uTexel );
    float blend = uBlend * ( 1.0 - clamp( speed * 0.008, 0.0, 0.55 ) );
    blend *= 1.0 - clamp( rejected * 2.5, 0.0, 0.9 );

    gl_FragColor = vec4( untm( mix( cur, clipped, blend ) ), 1.0 );
  }
`;

// ---------------------------------------------------------------------------
// 5. Depth of field — thin-lens CoC, half-res golden-angle bokeh
// ---------------------------------------------------------------------------

/**
 * The circle-of-confusion model, shared by the CoC prepass and the composite.
 *
 * FAR-FIELD DEFOCUS IS ALWAYS ON; the thin lens is not.
 *
 * With the aperture shut (the onboard modes) a grandstand roof 400 m out and a
 * city skyline behind it resolved as crisply as a wing endplate 6 m away, so
 * aerial haze was carrying the whole depth cue on its own. uFarCoC gives the
 * deep field a little defocus, ramped over uFarStart..uFarEnd, which is what a
 * long-ish lens focused on the car actually does — and it costs nothing in the
 * near field, where the CoC stays zero.
 *
 * uNearGuard is the cockpit fix: the halo hoop sits ~0.3 m from the lens, so
 * with the focal plane at the rig's subject distance it was the softest thing
 * in frame. Anything nearer than the guard is defined to be in focus.
 */
const COC_GLSL = /* glsl */ `
  uniform float uFocus;       // metres
  uniform float uFocal;       // metres
  uniform float uFStop;
  uniform float uMaxCoC;      // pixels, full-res
  uniform float uThinLens;    // 0 = the aperture is closed (far-field pass only)
  uniform float uFarCoC;      // pixels of defocus the deep distance always gets
  uniform float uFarStart;    // metres
  uniform float uFarEnd;      // metres
  uniform float uNearGuard;   // metres; nothing closer than this ever defocuses

  float coc( float z, float pxPerUnit ) {
    if ( z < uNearGuard ) return 0.0;
    // Signed circle of confusion in pixels; negative = in front of focus.
    float s = uFocus;
    float c = ( uFocal * uFocal * ( z - s ) ) / ( z * uFStop * max( s - uFocal, 1e-4 ) );
    float px = uThinLens * clamp( c / 0.024 * pxPerUnit * 0.5, -uMaxCoC, uMaxCoC );
    float far = uFarCoC * smoothstep( uFarStart, uFarEnd, z );
    // Only ever deepens the FAR side; a near-field (negative) CoC is untouched.
    return ( px >= 0.0 ) ? min( max( px, far ), uMaxCoC ) : px;
  }
`;

const COC_FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec2  uTexel;       // full-res texel
  varying vec2 vUv;
  ${DEPTH_GLSL}
  ${COC_GLSL}

  float coc( float z ) { return coc( z, 1.0 / uTexel.y ); }

  void main() {
    // Downsample 2x2 while taking the most extreme CoC, which dilates the near
    // field just enough that foreground blur bleeds over the focal plane.
    vec3 col = vec3( 0.0 );
    float near = 0.0, far = 0.0;
    for ( int y = 0; y < 2; y++ ) {
      for ( int x = 0; x < 2; x++ ) {
        vec2 u = vUv + ( vec2( float( x ), float( y ) ) - 0.5 ) * uTexel;
        col += texture( tDiffuse, u ).rgb;
        float c = coc( linearDepth( u ) );
        near = min( near, c );
        far = max( far, c );
      }
    }
    float c = ( abs( near ) > far ) ? near : far;
    gl_FragColor = vec4( col * 0.25, c / uMaxCoC );
  }
`;

const BOKEH_FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;   // half-res colour + coc in alpha
  uniform vec2  uTexel;         // half-res texel
  uniform float uMaxCoC;        // pixels, half-res
  varying vec2 vUv;

  #define TAPS 28

  void main() {
    vec4 centre = texture( tDiffuse, vUv );
    float coc = centre.a;
    float radius = abs( coc ) * uMaxCoC;
    if ( radius < 0.6 ) { gl_FragColor = centre; return; }

    // Tap count follows the radius. The far-field-only pass (always on, every
    // camera mode) asks for ~1.3 px of half-res blur, and spending 28 golden
    // angle taps on that is pure waste; a hero bokeh at 8 px still gets all 28.
    int taps = int( clamp( radius * 3.5, 6.0, float( TAPS ) ) );

    vec3 sum = centre.rgb;
    float wsum = 1.0;
    const float GA = 2.39996323;
    for ( int i = 0; i < TAPS; i++ ) {
      if ( i >= taps ) break;
      float t = ( float( i ) + 0.5 ) / float( taps );
      float r = sqrt( t );
      float a = float( i ) * GA;
      vec2 o = vec2( cos( a ), sin( a ) ) * r * radius;
      vec4 s = texture( tDiffuse, vUv + o * uTexel );
      // A sample only contributes if its own CoC reaches this pixel.
      float sr = abs( s.a ) * uMaxCoC;
      float w = clamp( ( sr - length( o ) ) * 0.5 + 1.0, 0.0, 1.0 );
      // Near-field samples always spill forward.
      w = max( w, s.a < -0.02 ? clamp( sr - length( o ) + 1.0, 0.0, 1.0 ) : 0.0 );
      sum += s.rgb * w;
      wsum += w;
    }
    gl_FragColor = vec4( sum / wsum, coc );
  }
`;

const DOF_COMPOSITE_FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;   // full res sharp
  uniform sampler2D tBokeh;     // half res blurred (a = coc)
  uniform vec2  uTexel;
  varying vec2 vUv;
  ${DEPTH_GLSL}
  ${COC_GLSL}

  /**
   * THE BLEND MASK IS THE PIXEL'S *OWN* CoC, NOT THE ONE IT SAMPLED.
   *
   * tBokeh is half res, so a bilinear fetch of its alpha mixes the CoC of a
   * defocused background into every pixel within one half-res texel of it. Those
   * pixels are in focus and were being cross-faded to the blurred buffer anyway
   * — which is where the "pale circular blobs sitting on the tarmac, the same
   * size everywhere regardless of depth" came from: a bokeh disc from a far
   * pixel, upsampled onto sharp road. Recomputing the CoC at full res from the
   * depth buffer costs one fetch and one polynomial and pins the mask to the
   * geometry.
   *
   * The near field is the documented exception: an out-of-focus FOREGROUND must
   * spill forward over things that are themselves sharp, so a negative sampled
   * CoC still opens the mask.
   */
  void main() {
    vec3 sharp = texture( tDiffuse, vUv ).rgb;
    vec4 blur = texture( tBokeh, vUv );
    float own = coc( linearDepth( vUv ), 1.0 / uTexel.y );
    float sampled = blur.a * uMaxCoC;
    float radius = ( sampled < -0.5 ) ? max( abs( sampled ), abs( own ) ) : abs( own );
    float m = smoothstep( 1.0, 3.0, radius );
    gl_FragColor = vec4( mix( sharp, blur.rgb, m ), 1.0 );
  }
`;

// ---------------------------------------------------------------------------
// 6. Motion blur — tile max, neighbour max, reconstruction
// ---------------------------------------------------------------------------

const TILE_MAX_FRAG = /* glsl */ `
  uniform sampler2D tVelocity;
  uniform vec2  uTexel;
  uniform vec2  uDir;       // (1,0) or (0,1)
  uniform int   uSteps;
  varying vec2 vUv;
  void main() {
    vec2 best = vec2( 0.0 );
    float bestLen = 0.0;
    for ( int i = 0; i < 64; i++ ) {
      if ( i >= uSteps ) break;
      vec2 u = vUv + ( float( i ) - float( uSteps ) * 0.5 + 0.5 ) * uDir * uTexel;
      vec2 v = texture( tVelocity, u ).xy;
      float l = dot( v, v );
      if ( l > bestLen ) { bestLen = l; best = v; }
    }
    gl_FragColor = vec4( best, 0.0, 1.0 );
  }
`;

const NEIGHBOUR_MAX_FRAG = /* glsl */ `
  uniform sampler2D tTile;
  uniform vec2 uTexel;
  varying vec2 vUv;
  void main() {
    vec2 best = vec2( 0.0 );
    float bestLen = 0.0;
    for ( int y = -1; y <= 1; y++ ) {
      for ( int x = -1; x <= 1; x++ ) {
        vec2 v = texture( tTile, vUv + vec2( float( x ), float( y ) ) * uTexel ).xy;
        float l = dot( v, v );
        if ( l > bestLen ) { bestLen = l; best = v; }
      }
    }
    gl_FragColor = vec4( best, 0.0, 1.0 );
  }
`;

const MOTION_BLUR_FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform sampler2D tVelocity;
  uniform sampler2D tNeighbour;
  uniform vec2  uResolution;
  uniform vec2  uTexel;
  uniform float uScale;         // shutter (fraction of the frame the shutter is open)
  uniform float uMaxPixelsFrac; // geometry smear ceiling as a FRACTION of frame height
  uniform float uNearFactor;    // ceiling multiplier inside uGradeNear metres
  uniform float uFarFactor;     // ceiling multiplier beyond uGradeFar metres
  uniform float uGradeNear;
  uniform float uGradeFar;
  uniform float uRadialMaxFrac; // vanishing-point smear ceiling, fraction of height
  uniform float uRadialFarFactor; // that ceiling's multiplier in the deep field
  uniform float uRadial;        // extra speed smear at the frame edge
  uniform vec2  uRadialCentre;
  uniform float uJitter;
  uniform float uEgoVel;        // px/frame below which a near pixel is "locked"
  uniform float uEgoNear;       // metres; only this close can a pixel be the subject
  uniform float uDepthGuard;    // silhouette test, as a FRACTION of the centre depth
  uniform float uSpinMaxPx;     // gather ceiling for a near, rotation-dominated pixel
  uniform float uPreserve;      // low-frequency restore, ACROSS the streak only
  varying vec2 vUv;
  ${DEPTH_GLSL}

  #define TAPS 32
  const float SOFT_Z = 0.6;   // metres of depth "thickness" for the comparison

  float coneWeight( float dist, float len ) { return clamp( 1.0 - dist / max( len, 1e-4 ), 0.0, 1.0 ); }
  float cylinderWeight( float dist, float len ) {
    return 1.0 - smoothstep( 0.95 * len, 1.05 * len, dist );
  }
  float softDepth( float za, float zb ) { return clamp( 1.0 - ( za - zb ) / SOFT_Z, 0.0, 1.0 ); }

  /** Interleaved gradient noise (Jimenez). Screen-space, so it dithers per PIXEL. */
  float ign( vec2 p ) {
    return fract( 52.9829189 * fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ) );
  }

  /**
   * THE SILHOUETTE GUARD — A LOCAL PLANE FIT IN INVERSE DEPTH.
   *
   * A flat depth tolerance cannot separate 'the same surface, further along'
   * from 'a different object': the tarmac under the front wing changes several
   * metres of depth across a 30 px gather, while the tyre standing on it is
   * only centimetres away from the road it touches. Comparing a tap against the
   * surface EXTRAPOLATED from the centre pixel separates them exactly. Inverse
   * depth is the right space to extrapolate in because 1/z is linear in screen
   * space for any plane, so a grazing ground ramp fits with zero residual at any
   * gather length while a wheel standing on it does not.
   *
   * The one-sided differences are taken on BOTH sides and the smaller-magnitude
   * one wins: on a silhouette pixel the other side belongs to the other object
   * and its slope is meaningless.
   *
   * Returns ( 1/z, d(1/z)/dx, d(1/z)/dy ), the derivatives per PIXEL.
   */
  vec3 planeFit( vec2 uv, float zC ) {
    float iz = 1.0 / max( zC, 1e-3 );
    float ixp = 1.0 / max( linearDepth( uv + vec2( uTexel.x, 0.0 ) ), 1e-3 ) - iz;
    float ixm = iz - 1.0 / max( linearDepth( uv - vec2( uTexel.x, 0.0 ) ), 1e-3 );
    float iyp = 1.0 / max( linearDepth( uv + vec2( 0.0, uTexel.y ) ), 1e-3 ) - iz;
    float iym = iz - 1.0 / max( linearDepth( uv - vec2( 0.0, uTexel.y ) ), 1e-3 );
    return vec3( iz,
      abs( ixp ) < abs( ixm ) ? ixp : ixm,
      abs( iyp ) < abs( iym ) ? iyp : iym );
  }

  /**
   * THE SMEAR CEILING IS DEPTH-GRADED, AND RELATIVE TO THE FRAME.
   *
   * A global ceiling in absolute pixels cannot be right: it has to be large
   * enough that the tarmac two metres under the front wing dissolves (that
   * dissolve IS the sensation of 340 km/h) and small enough that the horizon
   * stays readable. Those are the same number only if you grade by distance.
   * Near field gets the full fraction of frame height, the far field 18% of it,
   * so the ceiling is also resolution independent.
   */
  float maxPxAt( float z ) {
    float k = mix( uNearFactor, uFarFactor, smoothstep( uGradeNear, uGradeFar, z ) );
    return uMaxPixelsFrac * uResolution.y * k;
  }

  /** Clamp a uv-space velocity to maxPx screen pixels, returning uv. */
  vec2 clampVel( vec2 v, float maxPx ) {
    vec2 px = v * uResolution;
    float l = length( px );
    if ( l > maxPx ) px *= maxPx / l;
    return px / uResolution;
  }

  /**
   * Vanishing-point zoom, clamped against its OWN ceiling.
   *
   * This used to be summed into the geometry velocity and then re-clamped
   * against the geometry ceiling, which made it mathematically zero everywhere
   * the geometry was already at the cap — i.e. across the entire ground plane at
   * racing speed, which is the only place it was wanted. It is a pure screen
   * space zoom whose magnitude grows with |uv - centre|, so it cannot streak the
   * frame centre and does not need the geometry ceiling.
   */
  vec2 radialAt( vec2 uv, float z ) {
    vec2 toC = uv - uRadialCentre;
    vec2 r = toC * uRadial * smoothstep( 0.05, 0.9, length( toC ) );
    // Optical flow from pure forward translation falls off as 1/z, so the zoom
    // is graded by depth as well. Ungraded it put 20 px of smear on a cumulus
    // 40 km away, which no onboard camera has ever done.
    float k = mix( 1.0, uRadialFarFactor, smoothstep( uGradeNear, uGradeFar, z ) );
    return clampVel( r, uRadialMaxFrac * uResolution.y * k );
  }

  /**
   * THE EGO SUBJECT: near AND locked to the camera.
   *
   * In F1 24's chase cam the car is the sharpest object on screen while the
   * tarmac under it is unreadable. That contrast IS the speed cue, and a
   * reconstruction filter cannot produce it on its own: the car sits inside
   * 32 px tiles that also contain 226 px/frame of tarmac, so neighbour-max hands
   * every car pixel the tarmac's velocity and the gather smears the ground's
   * colour up to half a tile inside the silhouette. Measured on 'chase': the car
   * body's own screen velocity is 0.8 px/frame, the wing 0.35, while the kerb
   * beside it is 226 and the near tarmac 176. The subject is not ambiguous — it
   * is simply the only thing that is both CLOSE and STATIONARY IN SCREEN SPACE,
   * which is the definition of "the thing the camera is locked to".
   *
   * Deriving it from the velocity buffer rather than from a per-object tag keeps
   * this inside postfx (no scene-graph contract) and costs one texture fetch we
   * were already making. The near test is what stops it protecting the whole
   * static background: a distant grandstand is also locked, but a foreground car
   * sweeping in front of it must still smear onto it, so only the near field
   * qualifies. At chase speed everything else within uEgoNear metres — barriers,
   * kerbs, tarmac — is doing 50-250 px/frame and scores zero.
   *
   * IT DELIBERATELY DOES NOT PROTECT THE WHEELS. Measured on 'chase', the tyre
   * carries 64 px/frame of its own rotational velocity (the spin group is a
   * separate node, so uPrevModelMatrix picks the spin up), so it fails the
   * "slow" test and keeps its blur: the sidewall smears into a spun ring while
   * the bodywork it is bolted to stays pin sharp. That contrast is the point.
   */
  float egoAt( vec2 uv, float z ) {
    float px = length( texture( tVelocity, uv ).xy * uResolution );
    float slow = 1.0 - smoothstep( uEgoVel, uEgoVel * 2.5, px );
    float near = 1.0 - smoothstep( uEgoNear, uEgoNear * 1.8, z );
    return slow * near;
  }

  void main() {
    vec3 centre = texture( tDiffuse, vUv ).rgb;
    float zC = linearDepth( vUv );

    /*
     * THE SUBJECT IS SHARP BY CONSTRUCTION.
     *
     * Everything below the early-out is graded by ego rather than gated on it,
     * because the silhouette needs a soft handover: a hard test alone leaves a
     * one-texel rim of full-strength smear all the way round the car.
     *
     * Three separate things were smearing a car whose own screen velocity is
     * 0.5 px/frame, and the ego term has to kill all three:
     *   1. the uRadialCentre zoom. It is a pure screen-space effect and knows
     *      nothing about the velocity buffer, so it put 2.3 px on the diffuser.
     *   2. the neighbour-max tile. The car sits in 32 px tiles that also hold
     *      170 px/frame of tarmac, so vn handed every car pixel 27 px of the
     *      ground's motion and the gather walked +/-13 px of it.
     *   3. the McGuire centre weight, 1 / max(lenC, 1). With (1) inflating
     *      lenC to 2.3 the centre tap's weight fell to 0.44 while each of the
     *      12 near taps scored ~3 — i.e. the pixel was outvoted 36:0.44 by
     *      samples 1 px away, which is a box blur by another name.
     */
    float egoC = egoAt( vUv, zC );
    if ( egoC > 0.995 ) { gl_FragColor = vec4( centre, 1.0 ); return; }
    float maxC = maxPxAt( zC ) * ( 1.0 - 0.96 * egoC );

    vec2 rawC = texture( tVelocity, vUv ).xy * uScale;
    vec2 rawN = texture( tNeighbour, vUv ).xy * uScale;

    /*
     * A SPINNING WHEEL IS NOT A TRANSLATING OBJECT.
     *
     * The spin group is its own node, so uPrevModelMatrix gives the tread a real
     * surface velocity — 60+ px/frame on 'chase'. That is correct and it is what
     * smears the sidewall lettering into a spun ring. What it must NOT do is move
     * the tyre's OUTLINE: a rotation maps a circle onto itself, so the boundary
     * of a spinning wheel is invariant no matter how fast it turns. The gather
     * was being handed the tarmac's 226 px/frame by neighbour-max and walking it
     * straight through the silhouette, which is why the left rear read as a
     * formless olive ellipse with tarmac colour inside it.
     *
     * A rotation-dominated pixel is identified by what it is not: NEAR, carrying
     * real surface velocity, and pointing somewhere other than its tile does.
     * Those pixels gather along their OWN (tangential) axis and are capped at
     * uSpinMaxPx, so the tread band spins and the edge stays hard.
     */
    float lenC0 = length( rawC * uResolution );
    float lenN0 = length( rawN * uResolution );
    float nearW = 1.0 - smoothstep( uEgoNear, uEgoNear * 1.8, zC );
    float agree = ( lenC0 * lenN0 > 1e-3 )
      ? abs( dot( rawC * uResolution, rawN * uResolution ) ) / ( lenC0 * lenN0 ) : 1.0;
    float spin = nearW * smoothstep( 3.0, 12.0, lenC0 ) * ( 1.0 - smoothstep( 0.45, 0.92, agree ) );
    maxC = mix( maxC, min( maxC, uSpinMaxPx ), spin );

    vec2 rad = radialAt( vUv, zC ) * ( 1.0 - egoC );
    vec2 vn = clampVel( rawN, maxC ) + rad;
    float lenN = length( vn * uResolution );

    vec2 vc = clampVel( rawC, maxC ) + rad;
    float lenC = length( vc * uResolution );
    if ( lenN < 1.2 && lenC < 1.2 ) { gl_FragColor = vec4( centre, 1.0 ); return; }
    if ( lenC < 0.5 ) { vc = vn * ( 0.5 / max( lenN, 1e-4 ) ); lenC = 0.5; }

    // Tile motion is only trusted where the pixel is not rotating.
    vec2 vAlt = mix( vn, vc, spin );

    // Per-PIXEL dither, not a per-frame constant: an evenly spaced 32-tap gather
    // over a 30 px streak leaves 1 px hard steps, which is exactly the 'parallel
    // ghost lines from an undersampled gather' on the near tarmac. Interleaved
    // gradient noise turns the steps into grain the temporal filter then eats.
    float jitter = ign( gl_FragCoord.xy + vec2( uJitter * 37.0, uJitter * 17.0 ) ) - 0.5;

    vec3 fit = planeFit( vUv, zC );

    vec3 sum = centre * ( 1.0 / max( lenC, 1.0 ) );
    float wsum = 1.0 / max( lenC, 1.0 );

    // TAP COUNT FOLLOWS THE STREAK LENGTH. The ghost banding is a sampling-rate
    // artefact — it appears when the tap spacing exceeds ~1 px — so what matters
    // is pixels per tap, not taps. A 30 px near-field streak gets the full 32; a
    // 4 px barrier 90 m away gets 8, and spending 32 on it was most of the cost
    // of this pass across most of the frame.
    int taps = int( clamp( max( lenN, lenC ) * 1.1, 8.0, float( TAPS ) ) );
    float invT = 1.0 / float( taps + 1 );

    for ( int i = 0; i < TAPS; i++ ) {
      if ( i >= taps ) break;
      float t = mix( -1.0, 1.0, ( float( i ) + jitter + 1.0 ) * invT );
      // Alternate between the tile's dominant motion and this pixel's own.
      vec2 v = ( i % 2 == 0 ) ? vAlt : vc;
      vec2 suv = vUv + v * t * 0.5;
      float zS = linearDepth( suv );
      vec2 vS = clampVel( texture( tVelocity, suv ).xy * uScale, maxPxAt( zS ) ) + radialAt( suv, zS );
      float lenS = length( vS * uResolution );
      float dist = abs( t ) * 0.5 * length( v * uResolution );

      // Where the centre pixel's own surface would be at this tap.
      vec2 oPx = ( suv - vUv ) * uResolution;
      float zPred = 1.0 / max( fit.x + fit.y * oPx.x + fit.z * oPx.y, 1e-5 );
      float rel = ( zS - zPred ) / max( zC, 1.0 );   // +ve: the tap is BEHIND our surface

      // same  : the tap lies on the surface we are standing on
      // ahead : the tap is a genuinely separate object IN FRONT of that surface
      float same  = 1.0 - smoothstep( uDepthGuard, uDepthGuard * 2.4, abs( rel ) );
      float ahead = smoothstep( uDepthGuard * 1.6, uDepthGuard * 4.0, -rel );

      // McGuire 2012 classification. softDepth(a, b) is ~1 when a is CLOSER
      // than b, so the sample-in-front term must be weighted by the SAMPLE's
      // velocity and the sample-behind term by OURS. These two were swapped,
      // which is why a chase-locked car and a 30 cm halo hoop came out soft.
      //
      // Both terms are now gated by the plane fit. Only a genuine occluder may
      // smear ONTO us, and we may only smear ourselves using colour taken from
      // our OWN surface — background that we are standing in front of is
      // occluded for the whole shutter and can never enter the silhouette,
      // however fast our own surface is moving underneath us.
      float behind = softDepth( zC, zS ) * same;
      float w = ahead * coneWeight( dist, lenS )
              + behind * coneWeight( dist, lenC )
              + cylinderWeight( dist, lenS ) * cylinderWeight( dist, lenC ) * 2.0
                * max( same, ahead );

      sum += texture( tDiffuse, suv ).rgb * w;
      wsum += w;
    }
    vec3 blurred = sum / max( wsum, 1e-4 );

    /*
     * MOTION BLUR IS A 1-D INTEGRAL *ALONG* THE VELOCITY.
     *
     * It must not low-pass across it: F1 25 keeps the racing line, the aggregate
     * patches and the rubber marbles legible THROUGH the smear, because a streak
     * only destroys the frequencies parallel to itself. The reconstruction filter
     * leaks across because its taps carry a cone weight in every direction, and
     * the result was a flat purple-grey gradient where the asphalt used to be.
     *
     * Four taps strung ALONG the streak are smooth along it and untouched across
     * it. Folding a fifth of that back in returns the low frequencies without
     * returning any along-streak sharpness — the dissolve is unchanged, the road
     * is legible again.
     */
    vec2 dPx = vc * uResolution;
    float dLen = length( dPx );
    vec2 stepUv = ( dLen > 1e-4 ? dPx / dLen : vec2( 1.0, 0.0 ) ) * uTexel;
    vec3 lowF = ( texture( tDiffuse, vUv + stepUv * 1.5 ).rgb
                + texture( tDiffuse, vUv - stepUv * 1.5 ).rgb
                + texture( tDiffuse, vUv + stepUv * 4.0 ).rgb
                + texture( tDiffuse, vUv - stepUv * 4.0 ).rgb ) * 0.25;
    // A rotating surface gets MORE of it back: the tread bands and the sidewall
    // arc run across the circumferential streak, and they are the whole read.
    float keep = mix( uPreserve, min( uPreserve * 2.1, 0.5 ), spin )
      * ( 1.0 - egoC ) * smoothstep( 2.0, 9.0, lenC );

    gl_FragColor = vec4( mix( blurred, lowF, keep ), 1.0 );
  }
`;

// ---------------------------------------------------------------------------
// 7. Bloom — threshold + Jimenez down/up mip chain
// ---------------------------------------------------------------------------

const BLOOM_PREFILTER_FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec2  uTexel;
  uniform float uExposure;    // THE single exposure, same value the composite uses
  uniform float uThreshold;   // EXPOSED units: 1.0 == diffuse white
  uniform float uKnee;
  uniform float uClamp;       // firefly ceiling, EXPOSED units
  varying vec2 vUv;
  ${LUMA_GLSL}

  // Everything the bloom sees is already exposed, so the threshold and the
  // firefly clamp are expressed relative to the tone map's white point instead
  // of floating around with whatever the meter picked this frame. The clamp is
  // a soft (Reinhard) knee, not a hard min(): a hard cut makes the sun disc a
  // flat plateau and the bloom around it a disc rather than a falloff.
  vec3 fetch( vec2 uv ) {
    vec3 c = max( texture( tDiffuse, uv ).rgb, vec3( 0.0 ) ) * uExposure;
    float m = max( c.r, max( c.g, c.b ) );
    // m -> m / (1 + m/clamp): identity for small m, asymptotic to uClamp.
    float soft = m / ( 1.0 + m / uClamp );
    return c * ( soft / max( m, 1e-5 ) );
  }

  void main() {
    // Karis average over a 2x2 box: weights each sample by 1/(1+luma) so a
    // single fireflying specular pixel cannot dominate the mip chain.
    vec3 s0 = fetch( vUv + vec2( -uTexel.x, -uTexel.y ) );
    vec3 s1 = fetch( vUv + vec2(  uTexel.x, -uTexel.y ) );
    vec3 s2 = fetch( vUv + vec2( -uTexel.x,  uTexel.y ) );
    vec3 s3 = fetch( vUv + vec2(  uTexel.x,  uTexel.y ) );
    float w0 = 1.0 / ( 1.0 + luma( s0 ) );
    float w1 = 1.0 / ( 1.0 + luma( s1 ) );
    float w2 = 1.0 / ( 1.0 + luma( s2 ) );
    float w3 = 1.0 / ( 1.0 + luma( s3 ) );
    vec3 c = ( s0 * w0 + s1 * w1 + s2 * w2 + s3 * w3 ) / ( w0 + w1 + w2 + w3 );

    // Soft-knee threshold (Jimenez): a smooth quadratic shoulder instead of a
    // hard cut, which is what stops bloom crawling along moving highlights.
    float br = max( c.r, max( c.g, c.b ) );
    float soft = clamp( br - uThreshold + uKnee, 0.0, 2.0 * uKnee );
    soft = soft * soft / ( 4.0 * uKnee + 1e-4 );
    float contribution = max( soft, br - uThreshold ) / max( br, 1e-4 );
    gl_FragColor = vec4( c * contribution, 1.0 );
  }
`;

const BLOOM_DOWN_FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec2 uTexel;
  varying vec2 vUv;
  void main() {
    // 13-tap "dual filter" downsample: no aliasing crawl, no box artefacts.
    vec3 a = texture( tDiffuse, vUv + uTexel * vec2( -2.0,  2.0 ) ).rgb;
    vec3 b = texture( tDiffuse, vUv + uTexel * vec2(  0.0,  2.0 ) ).rgb;
    vec3 c = texture( tDiffuse, vUv + uTexel * vec2(  2.0,  2.0 ) ).rgb;
    vec3 d = texture( tDiffuse, vUv + uTexel * vec2( -2.0,  0.0 ) ).rgb;
    vec3 e = texture( tDiffuse, vUv ).rgb;
    vec3 f = texture( tDiffuse, vUv + uTexel * vec2(  2.0,  0.0 ) ).rgb;
    vec3 g = texture( tDiffuse, vUv + uTexel * vec2( -2.0, -2.0 ) ).rgb;
    vec3 h = texture( tDiffuse, vUv + uTexel * vec2(  0.0, -2.0 ) ).rgb;
    vec3 i = texture( tDiffuse, vUv + uTexel * vec2(  2.0, -2.0 ) ).rgb;
    vec3 j = texture( tDiffuse, vUv + uTexel * vec2( -1.0,  1.0 ) ).rgb;
    vec3 k = texture( tDiffuse, vUv + uTexel * vec2(  1.0,  1.0 ) ).rgb;
    vec3 l = texture( tDiffuse, vUv + uTexel * vec2( -1.0, -1.0 ) ).rgb;
    vec3 m = texture( tDiffuse, vUv + uTexel * vec2(  1.0, -1.0 ) ).rgb;
    vec3 o = ( j + k + l + m ) * 0.125;
    o += ( a + b + d + e ) * 0.03125;
    o += ( b + c + e + f ) * 0.03125;
    o += ( d + e + g + h ) * 0.03125;
    o += ( e + f + h + i ) * 0.03125;
    gl_FragColor = vec4( o, 1.0 );
  }
`;

const BLOOM_UP_FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec2  uTexel;
  uniform float uRadius;
  uniform float uScatter;    // per-level energy weight; see the note in render()
  varying vec2 vUv;
  void main() {
    vec2 r = uTexel * uRadius;
    vec3 s = texture( tDiffuse, vUv + vec2( -r.x,  r.y ) ).rgb;
    s += texture( tDiffuse, vUv + vec2( 0.0,  r.y ) ).rgb * 2.0;
    s += texture( tDiffuse, vUv + vec2(  r.x,  r.y ) ).rgb;
    s += texture( tDiffuse, vUv + vec2( -r.x, 0.0 ) ).rgb * 2.0;
    s += texture( tDiffuse, vUv ).rgb * 4.0;
    s += texture( tDiffuse, vUv + vec2(  r.x, 0.0 ) ).rgb * 2.0;
    s += texture( tDiffuse, vUv + vec2( -r.x, -r.y ) ).rgb;
    s += texture( tDiffuse, vUv + vec2( 0.0, -r.y ) ).rgb * 2.0;
    s += texture( tDiffuse, vUv + vec2(  r.x, -r.y ) ).rgb;
    gl_FragColor = vec4( s * 0.0625 * uScatter, 1.0 );
  }
`;

// ---------------------------------------------------------------------------
// 8. Composite — optics, exposure, tone map, grade
// ---------------------------------------------------------------------------

const COMPOSITE_FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform sampler2D tBloom;
  uniform sampler2D tDirt;
  uniform sampler3D uLut;

  uniform float uExposure;
  uniform float uBloom;
  uniform float uDirt;
  uniform float uAberration;
  uniform float uDistortion;
  uniform vec3  uSunScreen;      // xy = uv, z = visibility
  uniform float uFlare;
  uniform float uAspect;
  uniform float uLutSize;
  uniform float uLutMix;
  uniform float uSaturation;
  uniform vec3  uSlope;
  uniform vec3  uOffset;
  uniform vec3  uPower;
  uniform float uHighlightRolloff;
  varying vec2 vUv;
  ${DEPTH_GLSL}
  ${ACES_GLSL}
  ${LUMA_GLSL}

  /** Barrel + per-channel lateral chromatic aberration in one UV warp. */
  vec2 warp( vec2 uv, float k ) {
    vec2 c = uv - 0.5;
    float r2 = dot( c, c );
    return 0.5 + c * ( 1.0 + k * r2 );
  }

  vec3 sampleScene( vec2 uv ) {
    if ( uAberration < 1e-6 && uDistortion < 1e-6 ) return texture( tDiffuse, uv ).rgb;
    float d = uDistortion;
    float a = uAberration;
    vec3 c;
    c.r = texture( tDiffuse, warp( uv, d - a ) ).r;
    c.g = texture( tDiffuse, warp( uv, d ) ).g;
    c.b = texture( tDiffuse, warp( uv, d + a ) ).b;
    return c;
  }

  vec3 lensFlare( vec2 uv, float vis ) {
    vec2 sp = uSunScreen.xy;
    vec2 d = ( uv - sp ) * vec2( uAspect, 1.0 );
    float dist = length( d );

    // Anamorphic streak + two-lobe halo.
    float streak = exp( -abs( d.x ) * 7.0 ) * exp( -abs( d.y ) * 300.0 );
    float glow = exp( -dist * 14.0 ) * 0.22 + exp( -dist * 46.0 ) * 0.55;
    vec3 flare = vec3( 1.0, 0.84, 0.60 ) * glow;
    flare += vec3( 0.45, 0.68, 1.0 ) * streak * 0.55;

    // Ghosts marching along the sun -> centre axis, alternating warm/cool.
    vec2 axis = vec2( 0.5 ) - sp;
    for ( int i = 0; i < 5; i++ ) {
      float k = float( i );
      vec2 g = sp + axis * ( 0.42 + k * 0.36 );
      float gd = length( ( uv - g ) * vec2( uAspect, 1.0 ) );
      float s = 0.030 + k * 0.022;
      float ring = smoothstep( s, s * 0.55, gd ) * ( 1.0 - smoothstep( s * 0.45, 0.0, gd ) * 0.75 );
      vec3 tint = ( mod( k, 2.0 ) < 1.0 ) ? vec3( 0.95, 0.52, 0.30 ) : vec3( 0.30, 0.62, 1.0 );
      flare += tint * ring * 0.085;
    }
    return flare * vis;
  }

  void main() {
    // THE exposure, applied exactly once, to scene-referred linear radiance.
    // The bloom chain has already had the identical scalar applied in its own
    // prefilter, so it is added here in the same exposed space and is NOT
    // multiplied again.
    vec3 col = sampleScene( vUv ) * uExposure;

    vec3 bloom = texture( tBloom, warp( vUv, uDistortion ) ).rgb;
    vec3 dirt = texture( tDirt, vUv ).rgb;
    col += bloom * uBloom * ( 1.0 + dirt * uDirt * 6.0 );

    // Sun flare, occluded by anything the depth buffer says is in the way.
    if ( uFlare > 0.0 && uSunScreen.z > 0.0 ) {
      float open = 0.0;
      for ( int i = 0; i < 5; i++ ) {
        float a = float( i ) * 1.2566;
        vec2 o = vec2( cos( a ), sin( a ) ) * 0.012;
        vec2 u = clamp( uSunScreen.xy + vec2( o.x / uAspect, o.y ), vec2( 0.001 ), vec2( 0.999 ) );
        open += step( 0.9999, rawDepth( u ) );
      }
      open /= 5.0;
      float vis = uSunScreen.z * open;
      col += lensFlare( vUv, vis ) * uFlare * ( 1.0 + dirt.r * uDirt * 3.0 );
    }

    // --- scene-referred grade (ASC CDL) ------------------------------------
    col = pow( max( col * uSlope + uOffset, vec3( 0.0 ) ), uPower );
    // Gentle highlight desaturation before the tone map: keeps sun-lit carbon
    // and white paint from clipping to a flat sheet.
    float l = luma( col );
    col = mix( col, vec3( l ), clamp( ( l - 1.0 ) * uHighlightRolloff, 0.0, 0.6 ) );

    // THE tone map. Exactly one, here, on exposed scene-referred linear values.
    // renderer.toneMapping is NoToneMapping precisely so this is the only one.
    col = acesFitted( col );

    // --- display-referred grade -------------------------------------------
    col = clamp( col, 0.0, 1.0 );
    // sRGB transfer, then the LUT operates on display values.
    vec3 srgb = mix( col * 12.92, 1.055 * pow( col, vec3( 1.0 / 2.4 ) ) - 0.055, step( 0.0031308, col ) );

    float px = 1.0 / uLutSize;
    vec3 uvw = vec3( 0.5 * px ) + clamp( srgb, 0.0, 1.0 ) * ( 1.0 - px );
    vec3 graded = texture( uLut, uvw ).rgb;
    srgb = mix( srgb, graded, uLutMix );

    float gLum = luma( srgb );
    srgb = mix( vec3( gLum ), srgb, uSaturation );

    gl_FragColor = vec4( max( srgb, vec3( 0.0 ) ), 1.0 );
  }
`;

// ---------------------------------------------------------------------------
// 10. Finish — CAS sharpen, vignette, grain, dither
// ---------------------------------------------------------------------------

const FINISH_FRAG = /* glsl */ `
  uniform sampler2D tDiffuse;
  uniform vec2  uTexel;
  uniform float uSharpen;
  uniform float uVignette;
  uniform float uGrain;
  uniform float uGrainScale;
  uniform float uTime;
  uniform float uAspect;
  varying vec2 vUv;
  ${LUMA_GLSL}

  float hash( vec2 p ) {
    p = fract( p * vec2( 443.897, 441.423 ) );
    p += dot( p, p.yx + 19.19 );
    return fract( ( p.x + p.y ) * p.x );
  }

  void main() {
    vec3 e = texture( tDiffuse, vUv ).rgb;
    vec3 col = e;

    if ( uSharpen > 0.001 ) {
      // AMD CAS: contrast-adaptive, so flat sky stays clean and edges crisp.
      vec3 n = texture( tDiffuse, vUv + vec2( 0.0, -uTexel.y ) ).rgb;
      vec3 s = texture( tDiffuse, vUv + vec2( 0.0,  uTexel.y ) ).rgb;
      vec3 w = texture( tDiffuse, vUv + vec2( -uTexel.x, 0.0 ) ).rgb;
      vec3 ea = texture( tDiffuse, vUv + vec2(  uTexel.x, 0.0 ) ).rgb;
      vec3 mn = min( min( min( n, s ), min( w, ea ) ), e );
      vec3 mx = max( max( max( n, s ), max( w, ea ) ), e );
      vec3 amp = sqrt( clamp( min( mn, 1.0 - mx ) / max( mx, vec3( 1e-4 ) ), 0.0, 1.0 ) );
      vec3 wgt = -amp * ( uSharpen * 0.2 );
      col = clamp( ( e + ( n + s + w + ea ) * wgt ) / ( 1.0 + 4.0 * wgt ), 0.0, 1.0 );
    }

    // Vignette: cos^4 falloff, aspect-correct so it is not an oval on 16:9.
    vec2 vc = ( vUv - 0.5 ) * vec2( uAspect / 1.7778, 1.0 );
    float r2 = dot( vc, vc );
    col *= clamp( 1.0 - uVignette * r2 * 2.2 - uVignette * r2 * r2 * 1.6, 0.0, 1.0 );

    // Grain: scaled by exposure (a lifted image is a noisier image) and pushed
    // into the shadows where real film grain lives.
    float l = luma( col );
    float g = hash( vUv * 1131.0 + fract( uTime * 3.7 ) * 271.0 ) - 0.5;
    float g2 = hash( vUv.yx * 733.0 + fract( uTime * 2.1 ) * 97.0 ) - 0.5;
    col += ( g * 0.75 + g2 * 0.25 ) * uGrain * uGrainScale * ( 0.30 + 0.70 * ( 1.0 - l ) );

    // Ordered dither kills 8-bit banding in the sky gradient.
    float d = hash( floor( vUv / uTexel ) * 0.017 ) - 0.5;
    col += d / 255.0;

    gl_FragColor = vec4( max( col, vec3( 0.0 ) ), 1.0 );
  }
`;

// ---------------------------------------------------------------------------
// Look LUT
// ---------------------------------------------------------------------------

/**
 * Builds the default "race day" look LUT: cool shadows, warm highlights,
 * gentle contrast S-curve and a touch of extra saturation. The LUT operates on
 * DISPLAY-referred sRGB values (post tone map).
 * @returns {THREE.Data3DTexture}
 */
export function makeLookLUT(size = 32, o = {}) {
  const {
    contrast = 1.22,
    pivot = 0.40,
    // THE SHADOW TINT USED TO CARRY 34 POINTS OF BLUE AGAINST -4 OF GREEN.
    // On the biggest surface in every frame that is what made dry asphalt read
    // violet: measured on 'chase', mid tarmac sat at G 3.3 below R and 6.6 below
    // B. Some of that IS physical (asphalt in open shade is lit by a blue sky)
    // but the grade was doubling it. Halved, and green brought back to neutral,
    // the cast is a cool grey instead of a colour.
    shadowTint = [-0.016, 0.000, 0.020],
    highlightTint = [0.034, 0.011, -0.028],
    saturation = 1.24,
    // LIFT IS ZERO ON PURPOSE. A positive lift plus the aerial-perspective fog
    // put the 1st-percentile luminance at 0.065 with 0.18% of pixels genuinely
    // black, i.e. nothing in the frame was darker than 10% grey and the image had
    // no dark anchor at all. ACES already owns the toe; the grade must not raise
    // it a second time.
    lift = 0.0,
    toe = 0.20,
    shoulder = 0.10,
    // How hard saturation rolls off in the highlights. It exists so the sun disc
    // stays white; at 0.45/^4 it was also draining twenty liveries in full
    // sunlight, which is most of a 0.21 mean-saturation frame.
    highlightDesat = 0.30,
    highlightDesatPower = 6.0,
  } = o;
  const data = new Uint8Array(size * size * size * 4);
  let i = 0;
  // Filmic S: a soft toe and shoulder on top of the linear contrast stretch,
  // which is what separates a "graded" frame from a contrast slider.
  const curve = (v) => {
    let x = THREE.MathUtils.clamp(pivot + (v - pivot) * contrast, 0, 1);
    x = x - toe * x * (1 - x) * (1 - x) * 3.0 + shoulder * x * x * (1 - x) * 3.0;
    return THREE.MathUtils.clamp(x, 0, 1);
  };
  for (let bz = 0; bz < size; bz++) {
    for (let gy = 0; gy < size; gy++) {
      for (let rx = 0; rx < size; rx++) {
        let r = curve(rx / (size - 1));
        let g = curve(gy / (size - 1));
        let bl = curve(bz / (size - 1));
        const lum = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
        const sw = Math.pow(1 - lum, 2.2);
        const hw = Math.pow(lum, 2.0);
        r += shadowTint[0] * sw + highlightTint[0] * hw + lift * sw;
        g += shadowTint[1] * sw + highlightTint[1] * hw + lift * sw;
        bl += shadowTint[2] * sw + highlightTint[2] * hw + lift * sw;
        const l2 = 0.2126 * r + 0.7152 * g + 0.0722 * bl;
        // Saturation rolls off in the far highlights so the sun stays white.
        const sat = saturation
          * (1 - highlightDesat * Math.pow(THREE.MathUtils.clamp(l2, 0, 1), highlightDesatPower));
        r = l2 + (r - l2) * sat;
        g = l2 + (g - l2) * sat;
        bl = l2 + (bl - l2) * sat;
        data[i++] = THREE.MathUtils.clamp(r, 0, 1) * 255;
        data[i++] = THREE.MathUtils.clamp(g, 0, 1) * 255;
        data[i++] = THREE.MathUtils.clamp(bl, 0, 1) * 255;
        data[i++] = 255;
      }
    }
  }
  const tex = new THREE.Data3DTexture(data, size, size, size);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.minFilter = tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.ClampToEdgeWrapping;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

/** Procedural lens-dirt: a few greasy smudges plus dust specks. */
function makeLensDirt(size = 256) {
  const rng = makeRng(0x0d1a7);
  const data = new Uint8Array(size * size * 4);
  const blobs = [];
  for (let i = 0; i < 26; i++) {
    blobs.push({
      x: rng(), y: rng(),
      rx: 0.02 + rng() * 0.13, ry: 0.02 + rng() * 0.09,
      a: rng() * Math.PI, w: 0.25 + rng() * 0.75,
    });
  }
  const specks = [];
  for (let i = 0; i < 300; i++) {
    specks.push({ x: rng(), y: rng(), r: 0.0015 + rng() * 0.006, w: 0.3 + rng() * 0.7 });
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      let acc = 0;
      for (const b of blobs) {
        const dx = u - b.x, dy = v - b.y;
        const c = Math.cos(b.a), s = Math.sin(b.a);
        const px = (dx * c + dy * s) / b.rx, py = (-dx * s + dy * c) / b.ry;
        const d = px * px + py * py;
        if (d < 1) acc += (1 - d) * (1 - d) * b.w * 0.5;
      }
      for (const p of specks) {
        const dx = u - p.x, dy = v - p.y;
        const d = Math.sqrt(dx * dx + dy * dy) / p.r;
        if (d < 1) acc += (1 - d) * p.w;
      }
      // Edges of a lens are always dirtier than the middle.
      const r2 = (u - 0.5) ** 2 + (v - 0.5) ** 2;
      acc *= 0.45 + r2 * 2.6;
      const c = Math.min(1, acc) * 255;
      const i4 = (y * size + x) * 4;
      data[i4] = c;
      data[i4 + 1] = c * 0.94;
      data[i4 + 2] = c * 0.86;
      data[i4 + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

// Halton(2,3), the standard TAA jitter sequence.
function halton(index, base) {
  let f = 1, r = 0, i = index;
  while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base); }
  return r;
}
const JITTER = [];
for (let i = 1; i <= 8; i++) JITTER.push([halton(i, 2) - 0.5, halton(i, 3) - 0.5]);

/** Quality tiers. Each one is a full override of the cost-bearing knobs. */
export const QUALITY_TIERS = {
  ultra: { aoSamples: 11, bloomLevels: 6, taa: true, smaa: true, motionBlur: true, farDof: true },
  high: { aoSamples: 12, bloomLevels: 5, taa: true, smaa: true, motionBlur: true, farDof: true },
  medium: { aoSamples: 8, bloomLevels: 5, taa: true, smaa: false, motionBlur: true, farDof: true },
  low: { aoSamples: 0, bloomLevels: 4, taa: false, smaa: true, motionBlur: false, farDof: false },
};

const _m4a = new THREE.Matrix4();

export class PostFX {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {THREE.PerspectiveCamera} camera
   */
  constructor(renderer, scene, camera, opts = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.time = 0;
    this.frameIndex = 0;

    const size = renderer.getSize(new THREE.Vector2());
    this.dpr = renderer.getPixelRatio();
    this.width = Math.max(2, Math.floor(size.x * this.dpr));
    this.height = Math.max(2, Math.floor(size.y * this.dpr));

    /** Live tunables. Mutate freely; `applySettings()` pushes them to the GPU. */
    this.settings = {
      // BLOOM IS AUTHORED IN *EXPOSED* UNITS. The prefilter multiplies the scene
      // by the same single exposure the composite uses, so 1.0 here means
      // "diffuse white after exposure" — the tone map's shoulder starts around
      // there. Threshold must sit ABOVE it or ordinary sunlit paint blooms.
      //   threshold  where the soft knee starts (1.0 = diffuse white)
      //   knee       width of the quadratic shoulder below the threshold
      //   clamp      firefly ceiling, soft; a 40x sun disc contributes like a 6x one
      //   scatter    per-mip energy weight of the upsample chain (see render())
      bloom: {
        enabled: true, strength: 0.80, radius: 0.85,
        threshold: 1.25, knee: 0.55, clamp: 6.0, scatter: 0.70, dirt: 0.10,
      },
      // `contact` is a SECOND, much tighter AO that runs alongside GTAO in the
      // resolve — see contactAO(). `radius` is world metres (the floor-to-road
      // gap is 50-70 mm, so 0.30 m is the scale that reads as contact rather
      // than as ambient), `far` is where the gap goes sub-pixel and the term is
      // skipped, `maxPx` caps the screen-space search so a wing 40 cm from the
      // lens cannot cost a 900 px spiral. `shadowGuard` is how much of the AO
      // survives in a pixel that is already almost black: 1.0 = full AO
      // everywhere (which is what turns a shadowed diffuser into a slab).
      ao: {
        enabled: true, intensity: 0.85, radius: 0.9, samples: 11, thickness: 0.55, distanceFallOff: 0.9,
        contact: { enabled: true, radius: 0.40, strength: 2.2, far: 40, maxPx: 56 },
        shadowGuard: 0.45,
      },
      // `farField` runs even when the thin lens is off — see COC_FRAG. `coc` is
      // in full-res pixels at/after `end` metres; `nearGuard` forces anything
      // closer than that many metres to be in focus (the cockpit halo).
      // THE FAR FIELD HAS TWO SETTINGS, AND WHICH ONE RUNS IS DECIDED BY THE
      // THIN LENS. `dof.enabled` is true only for the photographic shots — the
      // broadcast tower, the hero orbit, the wheel and front-wing details — and
      // there a 2.6 px deep defocus starting at 55 m is exactly right: it is
      // what turns a foreground catch fence into a grey veil.
      //
      // On the onboard cameras the same numbers were the "whole deep field is
      // mush" finding: 2.6 px from 55 m left a 150 m grandstand crowd as colour
      // noise with no individual figures. A chase cam is a short lens at a
      // working f-stop and F1 24's background is essentially sharp, so the
      // gameplay far field is 1.5 px and does not start until 120 m — enough to
      // separate the skyline from the barriers, not enough to erase either.
      dof: {
        enabled: false, focus: 12, aperture: 0.0006, maxblur: 0.006, bokehScale: 1,
        nearGuard: 0.65,
        farField: { enabled: true, coc: 1.5, start: 120, end: 460, heroCoc: 2.6, heroStart: 55 },
      },
      // THE SMEAR CEILING IS A FRACTION OF FRAME HEIGHT, GRADED BY DEPTH.
      //
      // A 1/60 s frame at 95 m/s puts several hundred pixels of ground velocity
      // on screen. The old global 14 px ceiling threw away ~95% of it, so a
      // 343 km/h frame was pin sharp from the front wing to the skyline; it was
      // also in absolute pixels, so the relative smear shrank with resolution.
      //   maxPixelsFrac  near-field ceiling, x frame height (0.055 -> 50 px @900)
      //   nearFactor/farFactor + gradeNear/gradeFar  the depth grade: full
      //     ceiling inside 4 m, 18% of it past 40 m, so the horizon stays under
      //     10 px and readable while the tarmac under the wing dissolves.
      //   radialMaxFrac  the vanishing-point zoom's OWN ceiling (it is clamped
      //     separately from the geometry term; see radialAt()).
      //   shutterTrim    postfx-side calibration on the shutter angle `engine.js`
      //     authors per camera mode (0.42 onboard -> 0.50 exposed).
      //   egoVel/egoNear  the ego-subject test (see egoAt()): a pixel inside
      //     egoNear metres whose OWN screen velocity is under egoVel px/frame is
      //     the thing the camera is locked to and is exempted. Measured on
      //     'chase': car bodywork 0.5-1.0 px, tyre 64 px, kerb 56, near tarmac
      //     173. 4 px sits an order of magnitude clear of both sides.
      motionBlur: {
        enabled: true, strength: 0, maxStrength: 0.050,
        // 0.30 (engine.js, onboard) x 1.00 = a 108-degree shutter. The trim was
        // 1.19, i.e. 128 degrees, and every extra degree of it landed on the
        // MID field: the near ground is pinned at its ceiling either way
        // (173 px of raw velocity against a 30 px cap), so trimming the shutter
        // hands back the barriers and the grandstand and costs nothing where
        // the speed cue actually lives.
        shutter: 0.50, shutterTrim: 1.00,
        // farFactor 0.18 still put ~9 px on a barrier 100 m away and ~6 px of
        // radial zoom on a cumulus at 40 km. The deep field is where a frame
        // gets read as "soft" rather than "fast": at 333 km/h a 200 m object
        // subtends sub-pixel motion over a 1/60 s shutter, so anything the
        // grade leaves out there is pure loss. 0.05 past 60 m is 1.5 px.
        maxPixelsFrac: 0.033, nearFactor: 1.0, farFactor: 0.05,
        gradeNear: 4.0, gradeFar: 60.0,
        radialMaxFrac: 0.012, radialFarFactor: 0.10,
        egoVel: 4.0, egoNear: 14.0,
        // depthGuard  the silhouette test, as a FRACTION of the centre pixel's
        //   depth: a tap whose depth differs from the LOCAL PLANE FIT by more
        //   than this much of the distance to it belongs to another object.
        //   0.055 is ~0.39 m at the 7 m the hero's rear tyre sits at, which is
        //   the ~0.4 m the review asked for, expressed so it also holds at 60 m.
        // spinMaxPx   the ceiling a rotation-dominated pixel (a tyre) gathers
        //   at. The tread has to spin; the outline has to stay.
        // preserve    how much of an along-streak-only sample is folded back in
        //   so the asphalt keeps its low frequencies ACROSS the smear.
        depthGuard: 0.055, spinMaxPx: 24.0, preserve: 0.18,
        maxPixels: 8,   // legacy absolute hint; see setShutter()
      },
      taa: { enabled: true, blend: 0.90, jitter: 1.0, clampScale: 1.25 },
      aberration: 0.005,
      distortion: 0.022,
      vignette: 0.30,
      grain: 0.030,
      sharpen: 0.55,
      flare: 0.32,
      lutMix: 1.0,
      saturation: 1.10,
      exposureTrim: 1.0,
      smaa: true,
      // ASC CDL on scene-referred linear, pre tone map. The negative offset is
      // THE black anchor: it is the only lever in this file that can put the
      // bottom of the histogram back on zero once the fog has lifted the toe.
      // Slope stays within a couple of percent of unity — this is a contrast
      // move, not an exposure move, and exposure has exactly one owner.
      // Slope had green LOWEST of the three and power had blue LOWEST, i.e. the
      // CDL was itself a magenta/violet push on the midtones. Both are now
      // within 0.5% of each other; the contrast move survives, the cast does not.
      cdl: { slope: [1.020, 1.019, 1.020], offset: [-0.0085, -0.0075, -0.0035], power: [1.035, 1.020, 1.005] },
      highlightRolloff: 0.35,
    };
    this.quality = 'ultra';

    this._buildTargets();
    this._buildPasses(opts);
    this.applySettings();
  }

  // -- resources -----------------------------------------------------------

  _hdrTarget(w, h, filter = THREE.LinearFilter) {
    return new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      colorSpace: THREE.LinearSRGBColorSpace,
      minFilter: filter, magFilter: filter,
      depthBuffer: false, stencilBuffer: false,
    });
  }

  _ldrTarget(w, h) {
    return new THREE.WebGLRenderTarget(w, h, {
      type: THREE.UnsignedByteType,
      colorSpace: THREE.NoColorSpace,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false,
    });
  }

  _buildTargets() {
    const w = this.width, h = this.height;

    const depth = new THREE.DepthTexture(w, h);
    depth.format = THREE.DepthStencilFormat;
    depth.type = THREE.UnsignedInt248Type;
    depth.minFilter = THREE.NearestFilter;
    depth.magFilter = THREE.NearestFilter;
    this.depthTexture = depth;

    // MRT: 0 = packed view normal, 1 = screen-space velocity (uv units).
    this.gbuffer = new THREE.WebGLRenderTarget(w, h, {
      count: 2,
      type: THREE.HalfFloatType,
      colorSpace: THREE.NoColorSpace,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      depthTexture: depth,
      stencilBuffer: true,
    });
    this.normalTexture = this.gbuffer.textures[0];
    this.velocityTexture = this.gbuffer.textures[1];

    this.sceneRT = new THREE.WebGLRenderTarget(w, h, {
      type: THREE.HalfFloatType,
      colorSpace: THREE.LinearSRGBColorSpace,
      minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: true, stencilBuffer: false,
    });

    this.hdrA = this._hdrTarget(w, h);
    this.hdrB = this._hdrTarget(w, h);
    this.history = [this._hdrTarget(w, h), this._hdrTarget(w, h)];
    this.historyIndex = 0;
    this.historyValid = false;

    const hw = Math.max(2, Math.floor(w / 2)), hh = Math.max(2, Math.floor(h / 2));
    this.cocRT = this._hdrTarget(hw, hh);
    this.bokehRT = this._hdrTarget(hw, hh);

    // Tile size must cover the longest smear the reconstruction filter can walk.
    // The near-field ceiling is 0.055 * height (59 px at 1080p) plus up to
    // 0.022 * height of radial zoom, and the filter samples +/- half of that, so
    // it reaches ~41 px. Neighbour-max extends a tile by +/-1, i.e. 1.5 * tile.
    this.tile = 32;
    const tw = Math.max(1, Math.ceil(w / this.tile)), th = Math.max(1, Math.ceil(h / this.tile));
    this.tileRTx = this._hdrTarget(tw, h, THREE.NearestFilter);
    this.tileRT = this._hdrTarget(tw, th, THREE.NearestFilter);
    this.neighbourRT = this._hdrTarget(tw, th, THREE.NearestFilter);

    this.bloomLevels = 6;
    this.bloomRT = [];
    for (let i = 0; i < this.bloomLevels; i++) {
      const s = 2 ** (i + 1);
      this.bloomRT.push(this._hdrTarget(Math.max(2, Math.floor(w / s)), Math.max(2, Math.floor(h / s))));
    }

    this.ldrA = this._ldrTarget(w, h);
    this.ldrB = this._ldrTarget(w, h);
  }

  _buildPasses(opts) {
    const w = this.width, h = this.height;
    this.quad = new FullScreenQuad(null);

    // Prepass material archetypes; per-mesh instances are cloned from these so
    // each object can carry its own previous world matrix.
    this._sharedGB = {
      uCurrViewProj: { value: new THREE.Matrix4() },
      uPrevViewProj: { value: new THREE.Matrix4() },
    };
    this._gbMaterials = new Map();   // mesh.uuid -> ShaderMaterial
    this._swapped = [];
    this._hidden = [];

    this.aoPass = new GTAOPass(this.scene, this.camera, w, h);
    this.aoPass.output = GTAOPass.OUTPUT.Off;
    this.aoPass.setGBuffer(this.depthTexture, this.normalTexture);
    this.aoPass.updateGtaoMaterial({
      radius: 0.9, distanceExponent: 1.2, thickness: 0.55,
      scale: 1.0, samples: 11, distanceFallOff: 0.9, screenSpaceRadius: false,
    });
    // GTAO at 16 horizon samples plus a 16-tap poisson denoise, both at full
    // 1080p, measured 2.9 ms of the frame — the single most expensive pass, for
    // a term the frame only uses to darken wheel arches and panel gaps. 11 + 8
    // costs 1.7 ms and is visually indistinguishable at 4x zoom; the denoise is
    // what carries the smoothness, not the horizon count.
    this.aoPass.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, samples: 8 });

    this.smaaPass = new SMAAPass();
    this.smaaPass.setSize(w, h);
    this.smaaPass.enabled = true;

    const mat = (fragmentShader, uniforms, extra = {}) => new THREE.ShaderMaterial({
      uniforms, vertexShader: QUAD_VERT, fragmentShader,
      depthTest: false, depthWrite: false, ...extra,
    });

    this.resolveMat = mat(RESOLVE_FRAG, {
      tCurrent: { value: null }, tHistory: { value: null },
      tVelocity: { value: this.velocityTexture }, tAO: { value: null },
      tNormal: { value: this.normalTexture },
      tDepth: { value: this.depthTexture },
      uNear: { value: 0.25 }, uFar: { value: 6000 },
      uTexel: { value: new THREE.Vector2(1 / w, 1 / h) },
      uBlend: { value: 0.9 }, uAO: { value: 0.85 }, uClampScale: { value: 1.25 },
      uProjXY: { value: new THREE.Vector2(1, 1) },
      uContactRadius: { value: 0.30 }, uContactStrength: { value: 1.0 },
      uContactMaxPx: { value: 48 }, uContactFar: { value: 30 },
      uShadowGuard: { value: 0.45 }, uDither: { value: 0 },
      uInvViewProj: { value: new THREE.Matrix4() }, uPrevVP: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() },
    }, { defines: { USE_AO: '', USE_CONTACT: '' } });

    this.cocMat = mat(COC_FRAG, {
      tDiffuse: { value: null }, tDepth: { value: this.depthTexture },
      uNear: { value: 0.25 }, uFar: { value: 6000 },
      uTexel: { value: new THREE.Vector2(1 / w, 1 / h) },
      uFocus: { value: 12 }, uFocal: { value: 0.045 }, uFStop: { value: 2.8 },
      uMaxCoC: { value: 16 }, uThinLens: { value: 0 },
      uFarCoC: { value: 2.6 }, uFarStart: { value: 55 }, uFarEnd: { value: 420 },
      uNearGuard: { value: 0.65 },
    });
    this.bokehMat = mat(BOKEH_FRAG, {
      tDiffuse: { value: this.cocRT.texture },
      uTexel: { value: new THREE.Vector2(2 / w, 2 / h) },
      uMaxCoC: { value: 8 },
    });
    this.dofCompMat = mat(DOF_COMPOSITE_FRAG, {
      tDiffuse: { value: null }, tBokeh: { value: this.bokehRT.texture },
      tDepth: { value: this.depthTexture },
      uNear: { value: 0.25 }, uFar: { value: 6000 },
      uTexel: { value: new THREE.Vector2(1 / w, 1 / h) }, uMaxCoC: { value: 16 },
      uFocus: { value: 12 }, uFocal: { value: 0.045 }, uFStop: { value: 2.8 },
      uThinLens: { value: 0 }, uFarCoC: { value: 1.5 },
      uFarStart: { value: 120 }, uFarEnd: { value: 460 },
      uNearGuard: { value: 0.65 },
    });

    this.tileMat = mat(TILE_MAX_FRAG, {
      tVelocity: { value: this.velocityTexture },
      uTexel: { value: new THREE.Vector2(1 / w, 1 / h) },
      uDir: { value: new THREE.Vector2(1, 0) },
      uSteps: { value: this.tile },
    });
    this.neighbourMat = mat(NEIGHBOUR_MAX_FRAG, {
      tTile: { value: this.tileRT.texture },
      uTexel: { value: new THREE.Vector2(1 / this.tileRT.width, 1 / this.tileRT.height) },
    });
    this.motionMat = mat(MOTION_BLUR_FRAG, {
      tDiffuse: { value: null }, tVelocity: { value: this.velocityTexture },
      tNeighbour: { value: this.neighbourRT.texture }, tDepth: { value: this.depthTexture },
      uNear: { value: 0.25 }, uFar: { value: 6000 },
      uResolution: { value: new THREE.Vector2(w, h) },
      uTexel: { value: new THREE.Vector2(1 / w, 1 / h) },
      uScale: { value: 0.60 }, uMaxPixelsFrac: { value: 0.055 },
      uNearFactor: { value: 1.0 }, uFarFactor: { value: 0.18 },
      uGradeNear: { value: 4.0 }, uGradeFar: { value: 40.0 },
      uRadialMaxFrac: { value: 0.020 }, uRadialFarFactor: { value: 0.32 },
      uRadial: { value: 0 }, uRadialCentre: { value: new THREE.Vector2(0.5, 0.5) },
      uJitter: { value: 0 },
      // THESE TWO WERE DECLARED IN THE SHADER AND NEVER DECLARED HERE, so the
      // whole ego-subject branch ran with uEgoVel = uEgoNear = 0 and `egoAt`
      // returned a hard zero for every pixel in the frame. The chase-locked car
      // has been fully exposed to the tile dilation ever since the branch was
      // written. A missing uniform is silent in three.js — it simply never gets
      // uploaded — which is why the code read as correct and the frame did not.
      uEgoVel: { value: 4.0 }, uEgoNear: { value: 14.0 },
      uDepthGuard: { value: 0.055 }, uSpinMaxPx: { value: 24.0 },
      uPreserve: { value: 0.18 },
    });

    this.bloomPreMat = mat(BLOOM_PREFILTER_FRAG, {
      tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2(1 / w, 1 / h) },
      uExposure: { value: 1 },
      uThreshold: { value: 1.25 }, uKnee: { value: 0.55 }, uClamp: { value: 6 },
    });
    this.bloomDownMat = mat(BLOOM_DOWN_FRAG, {
      tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() },
    });
    this.bloomUpMat = mat(BLOOM_UP_FRAG, {
      tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: 1.0 },
      uScatter: { value: 0.70 },
    }, { blending: THREE.AdditiveBlending, transparent: true });

    this.lut = makeLookLUT(32);
    this.dirt = makeLensDirt(256);
    this.compositeMat = mat(COMPOSITE_FRAG, {
      tDiffuse: { value: null }, tBloom: { value: this.bloomRT[0].texture },
      tDirt: { value: this.dirt }, tDepth: { value: this.depthTexture },
      uLut: { value: this.lut },
      uNear: { value: 0.25 }, uFar: { value: 6000 },
      uExposure: { value: 1 }, uBloom: { value: 0.19 }, uDirt: { value: 0.1 },
      uAberration: { value: 0.0016 }, uDistortion: { value: 0.02 },
      uSunScreen: { value: new THREE.Vector3(0.5, 0.5, 0) }, uFlare: { value: 0.32 },
      uAspect: { value: w / h }, uLutSize: { value: 32 }, uLutMix: { value: 1 },
      uSaturation: { value: 1 },
      uSlope: { value: new THREE.Vector3(1, 1, 1) },
      uOffset: { value: new THREE.Vector3(0, 0, 0) },
      uPower: { value: new THREE.Vector3(1, 1, 1) },
      uHighlightRolloff: { value: 0.35 },
    });

    this.finishMat = mat(FINISH_FRAG, {
      tDiffuse: { value: null }, uTexel: { value: new THREE.Vector2(1 / w, 1 / h) },
      uSharpen: { value: 0.55 }, uVignette: { value: 0.30 },
      uGrain: { value: 0.03 }, uGrainScale: { value: 1 },
      uTime: { value: 0 }, uAspect: { value: w / h },
    });

    // Toggle map kept for `enable()` / the engine's debug query flags. These
    // gate the corresponding `settings.*.enabled` flag; both must be on.
    this._enabled = { ao: true, dof: true, bloom: true, smaa: true, look: true, preGrade: true, taa: true, motionBlur: true };
    if (opts.quality) this.setQuality(opts.quality);

    this._prevViewProj = new THREE.Matrix4();
    this._currViewProj = new THREE.Matrix4();
    this._unjitteredProj = new THREE.Matrix4();
    this._prevCamPos = new THREE.Vector3(1e9, 1e9, 1e9);
  }

  // -- public API ----------------------------------------------------------

  /**
   * Enable/disable a pass by name:
   * 'ao' | 'dof' | 'bloom' | 'smaa' | 'look' | 'preGrade' | 'taa' | 'motionBlur'.
   */
  enable(name, on) {
    if (name in this._enabled) this._enabled[name] = !!on;
    const s = this.settings[name];
    if (typeof s === 'object' && s !== null && 'enabled' in s) s.enabled = !!on;
    else if (typeof s === 'boolean') this.settings[name] = !!on;
    if (name === 'taa' && !on) this.historyValid = false;
    this.applySettings();
    return this;
  }

  /** Coarse cost tier: 'ultra' | 'high' | 'medium' | 'low'. */
  setQuality(name) {
    const t = QUALITY_TIERS[name];
    if (!t) return this;
    this.quality = name;
    this.settings.ao.enabled = t.aoSamples > 0;
    this.settings.ao.samples = Math.max(4, t.aoSamples);
    this.settings.taa.enabled = t.taa;
    this.settings.smaa = t.smaa;
    this.settings.motionBlur.enabled = t.motionBlur;
    if (this.settings.dof.farField) this.settings.dof.farField.enabled = t.farDof !== false;
    this.bloomLevels = Math.min(this.bloomRT.length, t.bloomLevels);
    this._enabled.taa = t.taa;
    this._enabled.smaa = t.smaa;
    this._enabled.motionBlur = t.motionBlur;
    this._enabled.ao = t.aoSamples > 0;
    this.applySettings();
    return this;
  }

  /** Per-level weight of the additive upsample chain, clamped to stay stable. */
  _bloomScatter() {
    return THREE.MathUtils.clamp(this.settings.bloom.scatter ?? 0.70, 0.0, 0.92);
  }

  /**
   * ENERGY NORMALISATION — the single most important number in this file.
   *
   * The up chain is additive: `mip[i-1] += k * blur(mip[i])`, so after it
   * unrolls `mip0 = sum( k^i * prefiltered_i )`. A box downsample preserves the
   * mean, so every `prefiltered_i` has the SAME average as `prefiltered_0` —
   * which means an unweighted chain (k = 1) hands the composite `levels` times
   * the energy that was thresholded out. With six levels that is a 6x gain that
   * nothing downstream accounts for, and the result is not a glow, it is fog.
   *
   * Weighting by k and dividing by the geometric sum 1/(1-k) makes the chain
   * energy-preserving, so `bloom.strength` genuinely means "fraction of the
   * over-threshold energy scattered back into the frame".
   */
  _bloomGain() {
    const k = this._bloomScatter();
    return (this.settings.bloom.strength ?? 0.6) * (1 - k);
  }

  applySettings() {
    const s = this.settings;
    const w = this.width, h = this.height;

    // Bloom.
    this.bloomPreMat.uniforms.uThreshold.value = s.bloom.threshold;
    this.bloomPreMat.uniforms.uKnee.value = Math.max(0.05, s.bloom.knee ?? 0.55);
    this.bloomPreMat.uniforms.uClamp.value = Math.max(1.0, s.bloom.clamp ?? 6);
    this.bloomUpMat.uniforms.uRadius.value = 0.55 + (s.bloom.radius ?? 0.85) * 1.1;
    this.bloomUpMat.uniforms.uScatter.value = this._bloomScatter();
    this.compositeMat.uniforms.uBloom.value = s.bloom.enabled ? this._bloomGain() : 0;
    this.compositeMat.uniforms.uDirt.value = s.bloom.dirt ?? 0.1;

    // AO.
    this.aoPass.enabled = s.ao.enabled && this._enabled.ao;
    this.resolveMat.uniforms.uAO.value = s.ao.intensity;
    if (this._aoSamples !== s.ao.samples || this._aoRadius !== s.ao.radius) {
      this._aoSamples = s.ao.samples;
      this._aoRadius = s.ao.radius;
      this.aoPass.updateGtaoMaterial({
        radius: s.ao.radius, samples: s.ao.samples,
        thickness: s.ao.thickness ?? 0.55, distanceFallOff: s.ao.distanceFallOff ?? 0.9,
        distanceExponent: 1.2, scale: 1.0, screenSpaceRadius: false,
      });
    }
    const hasAO = this.resolveMat.defines.USE_AO !== undefined;
    if (hasAO !== this.aoPass.enabled) {
      if (this.aoPass.enabled) this.resolveMat.defines.USE_AO = '';
      else delete this.resolveMat.defines.USE_AO;
      this.resolveMat.needsUpdate = true;
    }

    // Contact AO.
    const ct = s.ao.contact ?? {};
    const ctOn = (ct.enabled !== false) && this._enabled.ao;
    const ru = this.resolveMat.uniforms;
    ru.uContactRadius.value = Math.max(0.05, ct.radius ?? 0.30);
    ru.uContactStrength.value = Math.max(0, ct.strength ?? 1.15);
    ru.uContactFar.value = Math.max(1, ct.far ?? 30);
    ru.uContactMaxPx.value = Math.max(4, ct.maxPx ?? 48);
    ru.uShadowGuard.value = clamp(s.ao.shadowGuard ?? 0.45, 0, 1);
    const hasCT = this.resolveMat.defines.USE_CONTACT !== undefined;
    if (hasCT !== ctOn) {
      if (ctOn) this.resolveMat.defines.USE_CONTACT = '';
      else delete this.resolveMat.defines.USE_CONTACT;
      this.resolveMat.needsUpdate = true;
    }
    // `uAO` scales both terms, so with GTAO off the contact term still needs it.
    if (!this.aoPass.enabled && ctOn) ru.uAO.value = s.ao.intensity;

    this._updateDof();

    // Motion blur.
    const mb = s.motionBlur;
    const m = this.motionMat.uniforms;
    m.uScale.value = mb.shutter * (mb.shutterTrim ?? 1);
    m.uMaxPixelsFrac.value = mb.maxPixelsFrac ?? 0.055;
    m.uNearFactor.value = mb.nearFactor ?? 1.0;
    m.uFarFactor.value = mb.farFactor ?? 0.18;
    m.uGradeNear.value = mb.gradeNear ?? 4.0;
    m.uGradeFar.value = mb.gradeFar ?? 40.0;
    m.uRadialMaxFrac.value = mb.radialMaxFrac ?? 0.020;
    m.uRadialFarFactor.value = mb.radialFarFactor ?? 0.32;
    m.uRadial.value = mb.enabled ? mb.strength : 0;
    m.uEgoVel.value = Math.max(0.5, mb.egoVel ?? 4.0);
    m.uEgoNear.value = Math.max(1.0, mb.egoNear ?? 14.0);
    m.uDepthGuard.value = Math.max(0.005, mb.depthGuard ?? 0.055);
    m.uSpinMaxPx.value = Math.max(2.0, mb.spinMaxPx ?? 24.0);
    m.uPreserve.value = clamp(mb.preserve ?? 0.18, 0, 0.6);

    // TAA.
    this.resolveMat.uniforms.uBlend.value =
      (s.taa.enabled && this._enabled.taa) ? s.taa.blend : 0;
    this.resolveMat.uniforms.uClampScale.value = s.taa.clampScale;

    // Composite / grade.
    const c = this.compositeMat.uniforms;
    c.uAberration.value = this._enabled.preGrade ? s.aberration : 0;
    c.uDistortion.value = this._enabled.preGrade ? s.distortion : 0;
    c.uFlare.value = this._enabled.look ? s.flare : 0;
    c.uLutMix.value = this._enabled.look ? s.lutMix : 0;
    c.uSaturation.value = s.saturation;
    c.uHighlightRolloff.value = s.highlightRolloff;
    c.uSlope.value.fromArray(s.cdl.slope);
    c.uOffset.value.fromArray(s.cdl.offset);
    c.uPower.value.fromArray(s.cdl.power);
    c.uAspect.value = w / h;

    // Finish.
    const f = this.finishMat.uniforms;
    f.uSharpen.value = s.sharpen;
    f.uVignette.value = this._enabled.look ? s.vignette : 0;
    f.uGrain.value = this._enabled.look ? s.grain : 0;
    f.uAspect.value = w / h;

    this.smaaPass.enabled = s.smaa && this._enabled.smaa;
    return this;
  }

  /**
   * Thin-lens DOF from the legacy BokehPass-style knobs. Depends on the live
   * camera FOV, so it is refreshed every frame rather than only on change.
   */
  _updateDof() {
    const s = this.settings.dof;
    const u = this.cocMat.uniforms;
    const fov = THREE.MathUtils.degToRad(this.camera.fov ?? 50);
    const ff = s.farField ?? {};
    const thin = !!(s.enabled && this._enabled.dof);
    const farOn = ff.enabled !== false && this._enabled.dof;
    // The thin lens is engaged only by the photographic shots, so it doubles as
    // the "this is a long lens wide open" flag the far field needs; the onboard
    // cameras get the shallower gameplay pair. See the note on `settings.dof`.
    const farCoC = farOn ? Math.max(0, (thin ? (ff.heroCoc ?? ff.coc) : ff.coc) ?? 1.5) : 0;
    const farStart = (thin ? (ff.heroStart ?? ff.start) : ff.start) ?? 120;

    u.uFocus.value = Math.max(0.2, s.focus);
    u.uFocal.value = 0.012 / Math.tan(fov * 0.5);
    u.uFStop.value = THREE.MathUtils.clamp(0.0038 / Math.max(s.aperture, 1e-5), 1.0, 22);
    u.uThinLens.value = thin ? 1 : 0;
    u.uFarCoC.value = farCoC;
    u.uFarStart.value = farStart;
    u.uFarEnd.value = Math.max(farStart + 1, ff.end ?? 460);
    u.uNearGuard.value = Math.max(0, s.nearGuard ?? 0.65);

    // The composite recomputes the CoC at full res, so it needs the same lens.
    const d = this.dofCompMat.uniforms;
    d.uFocus.value = u.uFocus.value;
    d.uFocal.value = u.uFocal.value;
    d.uFStop.value = u.uFStop.value;
    d.uThinLens.value = u.uThinLens.value;
    d.uFarCoC.value = farCoC;
    d.uFarStart.value = farStart;
    d.uFarEnd.value = u.uFarEnd.value;
    d.uNearGuard.value = u.uNearGuard.value;

    // With the aperture shut the only thing in the buffer is the far-field term,
    // so the CoC range must shrink to it or the whole pass quantises to nothing.
    let maxCoC = THREE.MathUtils.clamp(
      (s.maxblur ?? 0.008) * this.height * 2.4 * (s.bokehScale ?? 1), 4, this.height * 0.06);
    if (!thin) maxCoC = Math.max(4, farCoC * 1.35);
    u.uMaxCoC.value = maxCoC;
    this.bokehMat.uniforms.uMaxCoC.value = maxCoC * 0.5;
    this.dofCompMat.uniforms.uMaxCoC.value = maxCoC;
    // The stage runs if EITHER lens is contributing.
    this._dofActive = thin || (farOn && farCoC > 0.05);
  }

  /** Speed-driven radial blur on top of the velocity buffer. `t` is 0..1. */
  setMotionBlur(t) {
    this.settings.motionBlur.strength = clamp(t, 0, 1) * this.settings.motionBlur.maxStrength;
    this.motionMat.uniforms.uRadial.value =
      this.settings.motionBlur.enabled ? this.settings.motionBlur.strength : 0;
  }

  /** Vanishing point for the radial blur, in UV space. */
  setBlurCenter(u, v) { this.motionMat.uniforms.uRadialCentre.value.set(u, v); }

  /**
   * Shutter angle and the per-pixel smear ceiling — i.e. the LENS, live.
   *
   * `strength`/`setMotionBlur` only control the radial vanishing-point term; the
   * geometry velocity buffer blurs regardless, and how much it blurs is this.
   * The two are separate because they belong to different physical quantities:
   * how fast the camera is moving, and how long the shutter is open. A world-feed
   * broadcast camera runs a very fast shutter (~1/500 s) so a long-lens pan stays
   * crisp; an onboard camera reads far better with a long one. Calling this per
   * frame is cheap — two uniform writes.
   *
   * THE CEILING IS NO LONGER IN ABSOLUTE PIXELS. `maxPixels` is accepted as a
   * legacy hint and divided by `LEGACY_PX_REF` into a fraction of frame height,
   * which is the quantity the shader actually clamps against. A value below 1 is
   * taken as that fraction directly. The reference is set so the two hints
   * `engine.js` sends — 13 px onboard, 5 px broadcast — land on 0.054 and 0.021
   * of frame height, i.e. ~49 px and ~19 px of NEAR-field ceiling at 900p, with
   * the depth grade in `maxPxAt()` taking the far field down to 18% of that.
   *
   * @param {number} shutter fraction of the frame the shutter is open
   * @param {number} [maxPixels] smear ceiling: <1 = fraction of frame height,
   *                             >=1 = legacy absolute pixels
   */
  setShutter(shutter, maxPixels) {
    const s = this.settings.motionBlur;
    s.shutter = shutter;
    this.motionMat.uniforms.uScale.value = shutter * (s.shutterTrim ?? 1);
    if (maxPixels !== undefined) {
      const LEGACY_PX_REF = 240;
      s.maxPixels = maxPixels;
      s.maxPixelsFrac = THREE.MathUtils.clamp(
        maxPixels < 1 ? maxPixels : maxPixels / LEGACY_PX_REF, 0.004, 0.10);
      this.motionMat.uniforms.uMaxPixelsFrac.value = s.maxPixelsFrac;
    }
  }

  /** Sun position for the flare: uv in [0,1], visibility 0..1. */
  setSunScreen(u, v, visibility) { this.compositeMat.uniforms.uSunScreen.value.set(u, v, visibility); }

  /** Replace the grade LUT (Data3DTexture, cube of any size). */
  setLUT(tex) {
    this.compositeMat.uniforms.uLut.value = tex;
    this.compositeMat.uniforms.uLutSize.value = tex.image.width;
  }

  /** Drop the temporal history (camera cuts, teleports, shot changes). */
  resetHistory() { this.historyValid = false; }

  setCamera(camera) {
    if (camera !== this.camera) this.resetHistory();
    this.camera = camera;
    this.aoPass.camera = camera;
  }

  setSize(width, height) {
    const dpr = this.renderer.getPixelRatio();
    const w = Math.max(2, Math.floor(width * dpr));
    const h = Math.max(2, Math.floor(height * dpr));
    if (w === this.width && h === this.height) return;
    this.dpr = dpr;
    this.width = w; this.height = h;

    this.gbuffer.setSize(w, h);
    this.sceneRT.setSize(w, h);
    this.hdrA.setSize(w, h); this.hdrB.setSize(w, h);
    this.history[0].setSize(w, h); this.history[1].setSize(w, h);
    this.cocRT.setSize(Math.floor(w / 2), Math.floor(h / 2));
    this.bokehRT.setSize(Math.floor(w / 2), Math.floor(h / 2));
    const tw = Math.max(1, Math.ceil(w / this.tile)), th = Math.max(1, Math.ceil(h / this.tile));
    this.tileRTx.setSize(tw, h);
    this.tileRT.setSize(tw, th);
    this.neighbourRT.setSize(tw, th);
    for (let i = 0; i < this.bloomRT.length; i++) {
      const s = 2 ** (i + 1);
      this.bloomRT[i].setSize(Math.max(2, Math.floor(w / s)), Math.max(2, Math.floor(h / s)));
    }
    this.ldrA.setSize(w, h); this.ldrB.setSize(w, h);
    this.aoPass.setSize(w, h);
    this.smaaPass.setSize(w, h);

    const texel = new THREE.Vector2(1 / w, 1 / h);
    this.resolveMat.uniforms.uTexel.value.copy(texel);
    this.cocMat.uniforms.uTexel.value.copy(texel);
    this.bokehMat.uniforms.uTexel.value.set(2 / w, 2 / h);
    this.dofCompMat.uniforms.uTexel.value.copy(texel);
    this.tileMat.uniforms.uTexel.value.copy(texel);
    this.neighbourMat.uniforms.uTexel.value.set(1 / tw, 1 / th);
    this.motionMat.uniforms.uResolution.value.set(w, h);
    this.motionMat.uniforms.uTexel.value.copy(texel);
    this.bloomPreMat.uniforms.uTexel.value.copy(texel);
    this.finishMat.uniforms.uTexel.value.copy(texel);
    this.historyValid = false;
    this.applySettings();
  }

  // -- G-buffer ------------------------------------------------------------

  /** Cached prepass material for a mesh (one instance per mesh: it carries the previous world matrix). */
  _gbMaterialFor(mesh, source) {
    let m = this._gbMaterials.get(mesh.uuid);
    if (m) return m;
    const masked = source.alphaTest > 0 && !!(source.alphaMap || source.map);
    m = new THREE.ShaderMaterial({
      uniforms: {
        uPrevModelMatrix: { value: new THREE.Matrix4().copy(mesh.matrixWorld) },
        uCurrViewProj: this._sharedGB.uCurrViewProj,
        uPrevViewProj: this._sharedGB.uPrevViewProj,
        ...(masked ? { tMask: { value: source.alphaMap || source.map }, uAlphaTest: { value: source.alphaTest } } : {}),
      },
      defines: masked ? { USE_MASK: '' } : {},
      vertexShader: GBUFFER_VERT,
      fragmentShader: GBUFFER_FRAG,
      glslVersion: THREE.GLSL3,
      side: source.side,
      fog: false,
      lights: false,
    });
    this._gbMaterials.set(mesh.uuid, m);
    return m;
  }

  _renderGBuffer() {
    const swapped = this._swapped, hidden = this._hidden;
    swapped.length = 0; hidden.length = 0;

    this.scene.traverse((o) => {
      if (!o.visible) return;
      if (!o.isMesh && !o.isInstancedMesh) {
        if (o.isPoints || o.isLine || o.isSprite) { o.visible = false; hidden.push(o); }
        return;
      }
      const src = o.material;
      if (!src || Array.isArray(src) || src.transparent === true
          || o.renderOrder < -100 || o.userData.excludeFromGBuffer) {
        o.visible = false; hidden.push(o);
        return;
      }
      const gb = this._gbMaterialFor(o, src);
      swapped.push(o, src);
      o.material = gb;
    });

    const r = this.renderer;
    const prevAuto = r.shadowMap.autoUpdate;
    r.shadowMap.autoUpdate = false;      // the colour pass owns the shadow update
    const prevClear = r.getClearColor(new THREE.Color());
    const prevAlpha = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    r.setRenderTarget(this.gbuffer);
    r.clear(true, true, true);
    r.render(this.scene, this.camera);
    r.shadowMap.autoUpdate = prevAuto;
    r.setClearColor(prevClear, prevAlpha);

    for (let i = 0; i < swapped.length; i += 2) {
      const mesh = swapped[i];
      mesh.material = swapped[i + 1];
      // Stash this frame's world matrix for next frame's velocity.
      this._gbMaterials.get(mesh.uuid).uniforms.uPrevModelMatrix.value.copy(mesh.matrixWorld);
    }
    for (const o of hidden) o.visible = true;
    swapped.length = 0; hidden.length = 0;
  }

  // -- frame ---------------------------------------------------------------

  render(dt) {
    this.time += dt;
    this.frameIndex++;

    const r = this.renderer;
    const cam = this.camera;
    const s = this.settings;
    const w = this.width, h = this.height;

    const prevAutoClear = r.autoClear;
    const prevTarget = r.getRenderTarget();
    r.autoClear = false;

    const taaOn = s.taa.enabled && this._enabled.taa;

    // The renderer normally refreshes these inside render(); velocity and AO
    // both need them one pass earlier than that.
    cam.updateMatrixWorld();
    cam.matrixWorldInverse.copy(cam.matrixWorld).invert();
    this._updateDof();

    // Camera cuts must not drag a stale history across the frame.
    if (this._prevCamPos.distanceToSquared(cam.position) > 36) this.historyValid = false;
    this._prevCamPos.copy(cam.position);

    // --- projection jitter (TAA) -------------------------------------------
    this._unjitteredProj.copy(cam.projectionMatrix);
    this._currViewProj.multiplyMatrices(this._unjitteredProj, cam.matrixWorldInverse);
    if (!this.historyValid) this._prevViewProj.copy(this._currViewProj);
    this._sharedGB.uCurrViewProj.value.copy(this._currViewProj);
    this._sharedGB.uPrevViewProj.value.copy(this._prevViewProj);
    // Infinite-distance reprojection for the sky (see skyVelocity()).
    this.resolveMat.uniforms.uInvViewProj.value.copy(this._currViewProj).invert();
    this.resolveMat.uniforms.uPrevVP.value.copy(this._prevViewProj);
    this.resolveMat.uniforms.uCamPos.value.setFromMatrixPosition(cam.matrixWorld);

    if (taaOn) {
      const j = JITTER[this.frameIndex % JITTER.length];
      const amount = s.taa.jitter;
      cam.projectionMatrix.elements[8] += (j[0] * 2 * amount) / w;
      cam.projectionMatrix.elements[9] += (j[1] * 2 * amount) / h;
      cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    }

    const nearFar = (m) => { m.uniforms.uNear.value = cam.near; m.uniforms.uFar.value = cam.far; };
    nearFar(this.resolveMat); nearFar(this.cocMat); nearFar(this.motionMat);
    nearFar(this.compositeMat); nearFar(this.dofCompMat);

    // View-ray scale for the contact AO's position reconstruction. Read from the
    // UNJITTERED lens: a TAA jitter here would wobble the occlusion field.
    const tanHalf = Math.tan(THREE.MathUtils.degToRad(cam.fov ?? 50) * 0.5);
    this.resolveMat.uniforms.uProjXY.value.set(tanHalf * (cam.aspect ?? w / h), tanHalf);
    // Rotate the 8-tap spiral every frame so TAA integrates it into a smooth
    // term instead of freezing one sampling pattern into the image.
    this.resolveMat.uniforms.uDither.value = (this.frameIndex % 6) * 0.61803399;

    // --- 1. geometry prepass ------------------------------------------------
    this._renderGBuffer();

    // --- 2. scene colour ----------------------------------------------------
    r.setRenderTarget(this.sceneRT);
    r.clear(true, true, true);
    r.render(this.scene, cam);

    // --- 3. ambient occlusion ----------------------------------------------
    if (this.aoPass.enabled) {
      this.aoPass.render(r, null, null);
      this.resolveMat.uniforms.tAO.value = this.aoPass.pdRenderTarget.texture;
    }

    // --- 4. resolve (AO modulation + TAA) ----------------------------------
    const histRead = this.history[this.historyIndex];
    const histWrite = this.history[this.historyIndex ^ 1];
    this.resolveMat.uniforms.tCurrent.value = this.sceneRT.texture;
    this.resolveMat.uniforms.tHistory.value = histRead.texture;
    this.resolveMat.uniforms.uBlend.value = (taaOn && this.historyValid) ? s.taa.blend : 0;
    this._blit(this.resolveMat, histWrite);
    this.historyIndex ^= 1;
    this.historyValid = true;
    let src = histWrite;

    // --- 5. depth of field --------------------------------------------------
    if (this._dofActive) {
      this.cocMat.uniforms.tDiffuse.value = src.texture;
      this._blit(this.cocMat, this.cocRT);
      this._blit(this.bokehMat, this.bokehRT);
      this.dofCompMat.uniforms.tDiffuse.value = src.texture;
      const dst = src === this.hdrA ? this.hdrB : this.hdrA;
      this._blit(this.dofCompMat, dst);
      src = dst;
    }

    // --- 6. motion blur -----------------------------------------------------
    const mbOn = s.motionBlur.enabled && this._enabled.motionBlur;
    if (mbOn) {
      this.tileMat.uniforms.uDir.value.set(1, 0);
      this.tileMat.uniforms.uSteps.value = this.tile;
      this.tileMat.uniforms.tVelocity.value = this.velocityTexture;
      this.tileMat.uniforms.uTexel.value.set(1 / w, 1 / h);
      this._blit(this.tileMat, this.tileRTx);
      this.tileMat.uniforms.uDir.value.set(0, 1);
      this.tileMat.uniforms.tVelocity.value = this.tileRTx.texture;
      this._blit(this.tileMat, this.tileRT);
      this._blit(this.neighbourMat, this.neighbourRT);

      this.motionMat.uniforms.tDiffuse.value = src.texture;
      this.motionMat.uniforms.uJitter.value = (this.frameIndex % 8) * 0.7853;
      const dst = src === this.hdrA ? this.hdrB : this.hdrA;
      this._blit(this.motionMat, dst);
      src = dst;
    }

    // --- 7. bloom -----------------------------------------------------------
    // ONE exposure value for the whole frame, resolved here and handed to both
    // the bloom prefilter and the composite. Nothing else in the stack scales
    // radiance: `renderer.toneMapping` is NoToneMapping, so this is it.
    const exposure = r.toneMappingExposure * s.exposureTrim;

    if (s.bloom.enabled && this._enabled.bloom) {
      this.bloomPreMat.uniforms.tDiffuse.value = src.texture;
      this.bloomPreMat.uniforms.uExposure.value = exposure;
      this.bloomPreMat.uniforms.uTexel.value.set(1 / w, 1 / h);
      this._blit(this.bloomPreMat, this.bloomRT[0]);
      const n = this.bloomLevels;
      for (let i = 1; i < n; i++) {
        const from = this.bloomRT[i - 1];
        this.bloomDownMat.uniforms.tDiffuse.value = from.texture;
        this.bloomDownMat.uniforms.uTexel.value.set(1 / from.width, 1 / from.height);
        this._blit(this.bloomDownMat, this.bloomRT[i]);
      }
      this.bloomUpMat.uniforms.uScatter.value = this._bloomScatter();
      for (let i = n - 1; i > 0; i--) {
        const from = this.bloomRT[i];
        this.bloomUpMat.uniforms.tDiffuse.value = from.texture;
        this.bloomUpMat.uniforms.uTexel.value.set(1 / from.width, 1 / from.height);
        this._blit(this.bloomUpMat, this.bloomRT[i - 1], false);
      }
    }

    // --- 8. composite -------------------------------------------------------
    this.compositeMat.uniforms.tDiffuse.value = src.texture;
    this.compositeMat.uniforms.uExposure.value = exposure;
    this.compositeMat.uniforms.uBloom.value =
      (s.bloom.enabled && this._enabled.bloom) ? this._bloomGain() : 0;
    this._blit(this.compositeMat, this.ldrA);

    // --- 9/10. SMAA + finish ------------------------------------------------
    let ldr = this.ldrA;
    if (this.smaaPass.enabled) {
      this.smaaPass.renderToScreen = false;
      this.smaaPass.render(r, this.ldrB, this.ldrA);
      ldr = this.ldrB;
    }
    this.finishMat.uniforms.tDiffuse.value = ldr.texture;
    this.finishMat.uniforms.uTime.value = this.time;
    this.finishMat.uniforms.uGrainScale.value =
      THREE.MathUtils.clamp(0.85 / Math.max(r.toneMappingExposure * s.exposureTrim, 0.05), 0.5, 2.0);
    this._blit(this.finishMat, prevTarget ?? null);

    // --- restore ------------------------------------------------------------
    if (taaOn) {
      cam.projectionMatrix.copy(this._unjitteredProj);
      cam.projectionMatrixInverse.copy(this._unjitteredProj).invert();
    }
    this._prevViewProj.copy(this._currViewProj);
    r.setRenderTarget(prevTarget);
    r.autoClear = prevAutoClear;
  }

  _blit(material, target, clear = true) {
    const r = this.renderer;
    r.setRenderTarget(target);
    if (clear) r.clear(true, false, false);
    this.quad.material = material;
    this.quad.render(r);
  }

  dispose() {
    this.quad.dispose();
    for (const m of this._gbMaterials.values()) m.dispose();
    this._gbMaterials.clear();
    const targets = [this.gbuffer, this.sceneRT, this.hdrA, this.hdrB, ...this.history,
      this.cocRT, this.bokehRT, this.tileRTx, this.tileRT, this.neighbourRT,
      ...this.bloomRT, this.ldrA, this.ldrB];
    for (const t of targets) t.dispose();
    this.aoPass.dispose();
    this.smaaPass.dispose();
    this.lut.dispose();
    this.dirt.dispose();
  }
}
