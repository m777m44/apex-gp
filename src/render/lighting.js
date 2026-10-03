/**
 * APEX GP — key light, cascaded shadows, IBL and exposure.
 *
 * CASCADED SHADOW MAPS
 *   Four stabilised cascades. The GLSL comes from three's own `CSMShader`, but
 *   it is installed by REPLACING the `lights_pars_begin` / `lights_fragment_begin`
 *   chunks globally instead of per material. That matters here: fifteen people
 *   are writing materials in this tree and `CSM.setupMaterial()` would stamp on
 *   their `onBeforeCompile` hooks. Patching the chunk means every lit material —
 *   including ones created later, cloned, or owned by someone else — gets CSM
 *   for free and nobody has to know.
 *
 *   Each cascade fits the bounding SPHERE of its frustum slice (constant radius
 *   under camera rotation) and its centre is snapped to the shadow-map texel
 *   grid in light space, so the shadow edges do not crawl while driving.
 *
 *   THE CASCADE LADDER IS SIZED IN SCREEN PIXELS, NOT IN METRES. A cascade is
 *   only useful if its world texel is about the size of a screen pixel at the
 *   NEAR edge of its own depth band; a pixel at distance d subtends
 *   `d * fovY / height` metres, so the ladder is tuned until
 *   `2 * radius / mapSize` is ~2 screen pixels at `splits[i]` for every i.
 *   That is what `CASCADE_FAR` and `splitLambda` are for. The old 520 m far
 *   plane with lambda 0.86 produced radii of 18/42/108/327 m — the two outer
 *   cascades had 10 cm and 64 cm texels, and since the normal offset has to
 *   scale with the texel, they carried 14 cm and 86 cm of normal bias. A 14 cm
 *   normal offset slides a tyre's contact shadow clean off its contact patch,
 *   which is why the grid photographed with no contact shadows at all: the
 *   shadows were being computed, sampled and applied correctly, they were just
 *   peter-panned out from under every car. The cap is now 5 cm, hard.
 *
 *   Bias discipline: `shadow.bias` is in NORMALISED depth, so its world meaning
 *   is `bias * (far - near)`. It therefore has to be divided by the cascade's
 *   own depth range or it means something different in every cascade. Ortho
 *   shadow depth is linear and the map is a native 24-bit DepthTexture, so a
 *   500 m range costs nothing in precision — but it does silently rescale the
 *   bias, which is the part that actually bit.
 *
 *   Casters are rendered DOUBLE SIDED (`_applyShadowSide`). three's default is
 *   back faces only, which writes the BOTTOM of a tyre for its own contact patch
 *   and drops every one-sided aero surface out of the map entirely. See the note
 *   on that method — it is half of why contact shadows were missing.
 *
 *   DEBUG VIEWS, AND A WARNING ABOUT THE OLD ONE. `?csmdbg=1` paints which
 *   cascade each pixel selected. `?csmdbg=2` paints the shadow test THROUGH the
 *   lighting, and it is the reason round 3 was diagnosed wrong: it overwrites
 *   `directLight.color` with a debug colour of magnitude 3.0, which is ~5x
 *   dimmer than the real key, so the sky's blue ambient swamps it and the whole
 *   racing surface comes back a flat red-violet with no visible blue. It was
 *   read as "the tarmac is 100 % lit"; the tarmac was in fact correctly
 *   shadowed the whole time. Modes 3-5 (with `?fx=0`) replace `gl_FragColor`
 *   outright and are the ones to trust:
 *     `3` raw shadow term         red = lit, blue = shadowed
 *     `4` selected cascade's shadow coordinate
 *     `5` shadow-map occupancy    black = a caster was rasterised into this texel
 *     `6` `reflectedLight.directDiffuse`   (what the key actually delivered)
 *     `7` `reflectedLight.indirectDiffuse` (what the IBL delivered — the thing
 *                                           a shadow has to out-shout)
 *     `8` the shadow factor actually multiplied into the key
 *     `9` the CSM cross-fade weight `blendRatio`
 *   Bisecting 5 -> 3 -> 8 separates "the map is empty" from "the lookup misses"
 *   from "the term is applied but has nothing to bite on", which are three
 *   completely different bugs that all photograph identically.
 *
 * SUN / SKY RATIO — THE THING THAT MAKES A SHADOW READ
 *   A geometrically perfect shadow is invisible if the key light only carries a
 *   fifth of the illuminance. `sunBoost` sets that share and it is a
 *   CORRECTNESS knob, not a taste one. See the block where it is declared for
 *   the measurement that set it.
 *
 * KEY ECLIPSE RESCUE — AND IT HAS TO REACH THE SUBJECT
 *   The ratio above is worth nothing if a grandstand roof is standing between
 *   the sun and the car. Every shot author picks a compass bearing for the key
 *   from the ROAD (see `stageSun` in core/engine.js) without any knowledge of
 *   what is built beside that piece of road, and a modern circuit is a bowl of
 *   15 m architecture: at the start line the main stand sits ~10 m off a 13.4 m
 *   track, so a bearing over the stand at 38 deg of elevation lays 19 m of roof
 *   shadow across the whole racing surface. Measured on `grid` before this
 *   existed, key-off differencing on two tarmac patches: direct:ambient 1.00
 *   and 1.01 — the twenty cars were receiving LITERALLY NO KEY LIGHT.
 *   `_rescueKey` probes it and moves the sun. See that method.
 *
 * IBL GROUND
 *   The PMREM is baked from the sky shader, which returns sky radiance in EVERY
 *   direction including straight down. A world with no floor lights every
 *   surface from below as brightly as from above: it flattens shading, fills in
 *   exactly the contact regions a shadow is supposed to own, and gives cars an
 *   empty lower hemisphere to reflect. `_buildEnvGround` puts a physically
 *   sized floor and a low horizon band into the bake scene, re-tinted from the
 *   live sun and sky every refresh.
 *
 * EXPOSURE
 *   `renderer.toneMappingExposure` is metered, not guessed. We estimate scene
 *   luminance from the sun irradiance and the sky's own radiance probes, convert
 *   to EV100, then apply partial adaptation toward the reference (noon) EV so
 *   dusk still LOOKS darker than noon while staying printable. `?exposure=`
 *   pins it manually.
 *
 * IBL
 *   PMREM straight off the sky shader (a cheap low-step twin of it), refreshed
 *   whenever the sky changes and periodically as the clouds drift.
 */

import * as THREE from 'three';
import { CSMShader } from 'three/addons/csm/CSMShader.js';
import { aerialUniforms } from './sky.js';

const CASCADES = 4;

/**
 * View depth (metres) the cascade ladder spans. **Baked into the shader** as
 * `CSM_SHADOW_FAR`, so the CPU-side splits MUST be normalised by this exact
 * number or the fragment shader picks a different cascade than the one the CPU
 * fitted. Shortening it is the single biggest lever on shadow sharpness (it
 * shrinks every cascade radius), at the cost of shadows fading out past it —
 * 260 m is where a car is ~25 px tall and its shadow is a smudge anyway.
 */
const CASCADE_FAR = 260;

/**
 * Hard ceiling on the normal offset, metres. An F1 floor sits ~40 mm off the
 * tarmac; anything near that detaches the contact shadow, so this is a
 * correctness limit and not a taste knob.
 */
const MAX_NORMAL_BIAS = 0.05;

/**
 * Metres of light-space headroom in front of each cascade box, so a caster that
 * is ABOVE the box (grandstand roof, gantry, floodlight pylon, tree) is still
 * inside the shadow frustum and still throws its shadow into the box. Measured
 * along the light axis, so it is divided by the sun's elevation sine.
 */
const CASTER_HEADROOM = 150;

/**
 * Shared cascade-break uniform. `UniformsUtils.clone` copies Colors and Vectors
 * but assigns anything else by reference, so a Float32Array injected into
 * `ShaderLib` is genuinely shared by every material in the scene — one write
 * per frame updates all of them.
 */
const cascadeBreaks = new Float32Array(CASCADES * 2);

let csmInstalled = false;

/**
 * `?csmdbg=1` paints the selected cascade, `=2` paints the shadow test through
 * the lighting (so it is modulated by albedo and N.L), `=3` writes the RAW
 * shadow term straight to the framebuffer, `=4` the selected cascade's shadow
 * coordinate, `=5` whether the selected cascade's depth map contains ANY
 * geometry at this receiver's texel (black = a caster was rasterised there,
 * white = the map is still at its cleared value).
 *
 * Modes 3-5 bypass the lighting entirely by overwriting `gl_FragColor` in the
 * last chunk of the shader, so they are only meaningful with `?fx=0`. They are
 * the ones that tell a broken RECEIVE from an empty MAP, which is the single
 * distinction this file has now been debugged along twice.
 */
const CSM_DEBUG = (() => {
  if (typeof location === 'undefined') return 0;
  const v = new URLSearchParams(location.search).get('csmdbg');
  return v ? parseInt(v, 10) : 0;
})();

/** The shadow lookup, verbatim from `CSMShader.lights_fragment_begin`. */
const SHADOW_CALL =
  'directLight.color *= ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;';

/** Patch three's lighting chunks for CSM. Must run before the first compile. */
function installCascadeShadows() {
  if (csmInstalled) return;
  csmInstalled = true;

  const defines =
    `#define USE_CSM\n` +
    `#define CSM_CASCADES ${CASCADES}\n` +
    `#define CSM_FADE\n` +
    `#define CSM_SHADOW_FAR ${CASCADE_FAR.toFixed(1)}\n`;

  THREE.ShaderChunk.lights_pars_begin = defines + CSMShader.lights_pars_begin;

  // three's CSM normalises view depth with cameraNear/shadowFar uniforms, which
  // would have to be pushed per material. A compile-time constant costs nothing
  // and keeps the whole thing uniform-free apart from the shared break array.
  let frag = CSMShader.lights_fragment_begin.replace(
    'float linearDepth = (vViewPosition.z) / (shadowFar - cameraNear);',
    'float linearDepth = ( vViewPosition.z ) / CSM_SHADOW_FAR;'
  );

  if (CSM_DEBUG) {
    if (frag.indexOf(SHADOW_CALL) < 0) console.warn('lighting: CSM debug patch missed the shadow call');
    const RAW = 'float csmDbg = ( directLight.visible && receiveShadow ) ? getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowIntensity, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ) : 1.0;\n';
    let dbg;
    if (CSM_DEBUG === 1) {
      // Cascade selection: 0 = red, 1 = green, 2 = blue, 3 = white.
      dbg = 'directLight.color = 3.0 * vec3( UNROLLED_LOOP_INDEX == 0 || UNROLLED_LOOP_INDEX == 3 ? 1.0 : 0.0, UNROLLED_LOOP_INDEX == 1 || UNROLLED_LOOP_INDEX == 3 ? 1.0 : 0.0, UNROLLED_LOOP_INDEX == 2 || UNROLLED_LOOP_INDEX == 3 ? 1.0 : 0.0 );';
    } else if (CSM_DEBUG === 2) {
      // Shadow test through the lighting: red = lit, blue = shadowed.
      dbg = RAW + 'directLight.color = 3.0 * vec3( csmDbg, 0.0, 1.0 - csmDbg );';
    } else if (CSM_DEBUG === 3) {
      dbg = RAW + 'apexCsmDbg = vec3( csmDbg, 0.0, 1.0 - csmDbg );';
    } else if (CSM_DEBUG === 4) {
      dbg = RAW + 'apexCsmDbg = clamp( vDirectionalShadowCoord[ i ].xyz / vDirectionalShadowCoord[ i ].w, 0.0, 1.0 );';
    } else if (CSM_DEBUG === 5) {
      // Map occupancy. LessEqualCompare: a probe depth of 0.9999 passes (1.0)
      // only where the map is still at its cleared far value, so black is
      // "something was rasterised into this texel".
      dbg = RAW +
        'vec3 csmC = vDirectionalShadowCoord[ i ].xyz / vDirectionalShadowCoord[ i ].w;\n' +
        'apexCsmDbg = vec3( texture( directionalShadowMap[ i ], vec3( csmC.xy, 0.9999 ) ) );';
    } else {
      // 6-9 leave the real shadow multiply in place: they read out what the
      // PRODUCTION shader did, rather than substituting for it.
      dbg = null;
    }
    if (dbg !== null) frag = frag.split(SHADOW_CALL).join(dbg);

    if (CSM_DEBUG === 8) {
      const MIX = 'directLight.color = mix( prevColor, directLight.color, shouldFadeLastCascade ? ratio : 1.0 );';
      if (frag.indexOf(MIX) < 0) console.warn('lighting: csmdbg=8 missed the fade mix');
      frag = frag.split(MIX).join(MIX + '\napexCsmDbg = directLight.color / max( prevColor, vec3( 1e-4 ) );');
    }
    if (CSM_DEBUG === 9) {
      const BR = 'float blendRatio = shouldBlend ? ratio : 1.0;';
      if (frag.indexOf(BR) < 0) console.warn('lighting: csmdbg=9 missed the blend ratio');
      frag = frag.split(BR).join(BR + '\napexCsmDbg = vec3( blendRatio );');
    }

    if (CSM_DEBUG >= 3) {
      // `apexCsmDbg` has to exist for EVERY shader, lit or not — `common` is the
      // only chunk they all include (declaring it in `lights_pars_begin` breaks
      // the PMREM background's MeshBasicMaterial). The last chunk in the
      // fragment shader then overwrites the framebuffer with it, guarded on
      // `RE_Direct` so unlit materials keep their own output. Use `?fx=0` so
      // post does not regrade the readout.
      THREE.ShaderChunk.common = 'vec3 apexCsmDbg = vec3( 0.0 );\n' + THREE.ShaderChunk.common;
      const src = CSM_DEBUG === 6 ? 'reflectedLight.directDiffuse * 3.0'
        : CSM_DEBUG === 7 ? 'reflectedLight.indirectDiffuse * 3.0'
        : 'apexCsmDbg';
      THREE.ShaderChunk.dithering_fragment += `\n#ifdef RE_Direct\ngl_FragColor = vec4( ${src}, 1.0 );\n#endif\n`;
    }
  }

  THREE.ShaderChunk.lights_fragment_begin = frag;

  for (const name of Object.keys(THREE.ShaderLib)) {
    const lib = THREE.ShaderLib[name];
    if (!lib || !lib.uniforms || !lib.uniforms.ambientLightColor) continue;
    lib.uniforms.CSM_cascades = { value: cascadeBreaks };
  }
}

installCascadeShadows();

// ---------------------------------------------------------------------------

const _centre = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _camPos = new THREE.Vector3();
const _tmpFocus = new THREE.Vector3();
const _camDir = new THREE.Vector3();
const _colour = new THREE.Color();
const _envC = new THREE.Color();
const _envSky = new THREE.Color();
const _rayPerp = new THREE.Vector3();
const _rayOrigin = new THREE.Vector3();
const _rayDir = new THREE.Vector3();
const _camFwd = new THREE.Vector3();

const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** 4300 K metal-halide, the colour every night circuit is lit with. */
const FLOODLIGHT_COLOUR = new THREE.Color(1.0, 0.93, 0.80);

/**
 * Hemispherical albedo of "the world outside the car" as the IBL sees it: a
 * circuit is roughly half tarmac (0.07), half grass/gravel (0.16), so the
 * area-weighted mean lands near 0.11 with a faint green-grey bias.
 */
const ENV_GROUND_ALBEDO = new THREE.Color(0.112, 0.116, 0.098);

/**
 * The 0-8 deg band is barriers, hoardings, garages, grandstands and trees. They
 * are VERTICAL, so they see about half the sky and take the sun at a grazing
 * angle — but their albedo (concrete, painted panel) is 3-4x the ground's. Net,
 * a photograph puts that band a little brighter and a little warmer than the
 * floor, which is also what stops a car's flank reflecting a black void.
 */
const ENV_BAND_ALBEDO = new THREE.Color(0.20, 0.192, 0.176);
const ENV_BAND_ELEVATION = 8;      // degrees
const ENV_GROUND_RADIUS = 900;     // metres; inside the PMREM camera's 2000 m far plane

/**
 * Radial segments of the horizon band. It is no longer a single flat colour —
 * see `_updateEnvGround` — so this is the azimuthal resolution of the horizon
 * gradient, not just a tessellation number. 48 puts one segment every 7.5 deg,
 * which is far finer than the PMREM's diffuse mip can resolve and about right
 * for the rough-specular mips a car flank actually samples.
 */
const ENV_BAND_SEGMENTS = 48;

/**
 * A vertical surface sees a bit over half the sky (the rest of its hemisphere
 * is ground, which is carried by the bounce term below it). Used to convert the
 * sky's hemispherical irradiance into the irradiance landing on the band.
 */
const ENV_BAND_SKY_VIEW = 0.55;

/**
 * THE FLOOR IS RADIANCE, AND `environmentIntensity` IS APPLIED TO IT TWICE.
 *
 * `_updateEnvGround` computes the floor's radiance from the irradiance landing
 * on it, and that irradiance contains the sky term `PI * avgLum * environmentIntensity`.
 * The result is then written into the PMREM, which every material samples and
 * multiplies by `scene.environmentIntensity` AGAIN. So the floor's contribution
 * scaled with env SQUARED while the sky's scaled linearly.
 *
 * That is invisible while env never moves, and it is a trap the moment it does:
 * cutting the sky's share of the illuminance to buy shadow contrast (which is
 * exactly what finding 2 asks for) would have cut the ground bounce by the
 * square of the same factor, and the ground bounce is the ONLY thing filling a
 * car's floor, diffuser and beam wing. That is the mechanism behind the
 * "crushed blacks nearly tripled on `chase`" regression: the round-4 rebalance
 * moved env, and the under-car fill fell off a cliff it did not need to.
 *
 * So the sky term is now divided back out once, making the floor physical, and
 * a single explicit gain sits in front of it. The gain is NOT 1: the 900 m
 * sphere stands in for a world that is much closer and much brighter than a
 * 0.11-albedo plane at infinity (pit garages, white run-off, kerbs, painted
 * barriers, the underside of a grandstand roof), and it was measured — see the
 * sweep in `_updateEnvGround`.
 */
const ENV_BOUNCE_GAIN = 3.5;

/**
 * Scene children the eclipse probe treats as occluders. Deliberately ONLY the
 * big opaque architecture named in the contract, for three reasons:
 *   - `CatchFence` and `Hoarding` are thin sheets that a ray hits but light
 *     mostly gets past (and the fence is alpha-tested, so a raycast reports a
 *     hit on a hole);
 *   - `Trees` are alpha-tested cards, same problem;
 *   - `Gantries` genuinely eclipse, but only for the two seconds a car spends
 *     under one, and this decision must not be a function of that.
 * `Terrain` and `SpectatorEstate` were on this list and came off on COST: they
 * are the two largest triangle counts in the scene and a brute-force raycast
 * against them took the probe from 40 ms to 2.1 s, which is a visible hitch at
 * boot. Neither can eclipse a track that is carved into its own terrain at any
 * elevation this guard is allowed to run at.
 * Anything not on this list can never move the sun.
 */
const KEY_RESCUE_ROOTS = ['Grandstands', 'PitLane', 'Towers'];

/** Below this the sun is setting and EVERYTHING is eclipsed; leave it alone. */
const KEY_RESCUE_MIN_ELEVATION = 8;

/** Ignore hits closer than this: that is the car's own furniture, not a stand. */
const KEY_RESCUE_MIN_DISTANCE = 6;

/** Ray length. A 15 m stand at 8 deg reaches 107 m; 400 m covers a hill too. */
const KEY_RESCUE_RANGE = 400;

/**
 * Fraction of the probe bundle that has to be blocked before the key is
 * declared eclipsed, and the fraction a candidate has to get under to be
 * accepted. The gap between them is deliberate hysteresis: a marginal frame
 * (`beauty` at 17 deg, where the stand's shadow ends a few metres short of the
 * car) must not be able to flip, because that shot's whole composition is
 * "the flank the lens sees is the lit one".
 */
const KEY_RESCUE_TRIGGER = 0.99;
const KEY_RESCUE_ACCEPT = 0.20;

export class Lighting {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.Scene} scene
   * @param {import('./sky.js').Sky} sky
   */
  constructor(renderer, scene, sky, opts = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.sky = sky;

    this.cascadeCount = CASCADES;
    // Never larger than CASCADE_FAR: that constant is compiled into the shader.
    this.cascadeFar = Math.min(opts.cascadeFar ?? CASCADE_FAR, CASCADE_FAR);
    this.cascadeNear = opts.cascadeNear ?? 1.2;
    // 0.92 is nearly a pure logarithmic split. The uniform term only exists to
    // stop cascade 0 collapsing; at 0.86 it dominated and pushed the first
    // break out to 27 m, which is why cascade 1 had to cover 27-68 m at a 42 m
    // radius. See the ladder note in the file header.
    this.splitLambda = opts.splitLambda ?? 0.92;
    // Resolution is the ONLY lever left on shadow sharpness once the ladder is
    // right: the texel-to-pixel ratio at a cascade's near edge is set by the
    // split ratio r = (far/near)^(1/N), and with four cascades over 1.2..260 m
    // that r is ~2.9 no matter how the splits are arranged — which is 2.6-3.1
    // screen pixels per shadow texel at 2048. Doubling the three cascades that
    // cover 0-78 m (where the subject lives in every shot but `wide`) takes
    // that to ~1.4 px, which is the difference between a soft grey bruise and a
    // contact shadow. The far cascade stays at 2048: at 78 m+ a car is 25 px
    // tall and 1.6 px of penumbra is free.
    //
    // MEASURED COST, `chase` and `grid` at 1600x900 on an M3 Max with a
    // readPixels stall around each batch so the GPU is actually drained:
    // 4096/4096/4096/2048 = 21.3 / 24.7 ms, 2048 x4 = 20.7 / 24.1 ms, whole
    // shadow pass removed = 21.3 ms on `grid`. So the upgrade is ~0.6-1.0 ms and
    // the entire cascade pass is ~3 ms. If the frame needs that back, this is a
    // one-line constructor option — pass `mapSizes: [2048, 2048, 2048, 2048]`.
    this.mapSizes = opts.mapSizes ?? [4096, 4096, 4096, 2048];

    /** @type {THREE.DirectionalLight[]} cascade 0 is the tight near shadow. */
    this.cascadeLights = [];
    for (let i = 0; i < CASCADES; i++) {
      const l = new THREE.DirectionalLight(0xffffff, 3.4);
      l.name = `SunCascade${i}`;
      l.castShadow = true;
      l.shadow.mapSize.set(this.mapSizes[i], this.mapSizes[i]);
      l.shadow.camera.near = 1;
      l.shadow.camera.far = 4000;
      l.shadow.bias = -0.00008;
      l.shadow.normalBias = 0.02;
      // three 0.185 folds PCFSoft into PCF, so `radius` is the PCF kernel
      // spread IN TEXELS over a 5-tap Vogel disk. The ladder is already tuned
      // so one texel is ~2 screen pixels, so anything over ~1.6 turns a contact
      // shadow into a bruise. The sun's own penumbra is ~1 cm per metre of gap,
      // i.e. a contact shadow is nearly hard — keep the kernel tight.
      l.shadow.radius = [1.3, 1.2, 1.1, 1.0][i];
      // Placement is ours, but the MAP still has to be re-rendered every frame.
      l.shadow.autoUpdate = true;
      l.target.position.set(0, 0, 0);
      scene.add(l, l.target);
      this.cascadeLights.push(l);
    }

    /**
     * The key light. Other modules (weather) write `lighting.sun.intensity`;
     * the remaining cascades mirror whatever it holds.
     */
    this.sun = this.cascadeLights[0];

    /** Sky/ground bounce fill. The IBL does most of this; keep it subtle. */
    this.fill = new THREE.HemisphereLight(0x9fc0ff, 0x2a2622, 0.35);
    scene.add(this.fill);

    /**
     * Night race floodlight banks: two cross-lit, non-shadowing directionals.
     * They are added AFTER the cascades so three's uniform packing keeps the
     * shadow-casting lights in the first four slots.
     */
    this.floodlights = [];
    for (let i = 0; i < 2; i++) {
      const l = new THREE.DirectionalLight(0xfff2df, 0);
      l.name = `Floodlight${i}`;
      l.castShadow = false;
      const az = i === 0 ? 2.2 : -1.1;
      l.position.set(Math.sin(az) * 120, 190, Math.cos(az) * 120);
      scene.add(l, l.target);
      this.floodlights.push(l);
    }
    this.floodBoost = 0;

    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();

    // Rendered from its own scene so nothing else leaks into the IBL. The mesh
    // shares the sky's uniform objects but compiles at a much lower step count.
    this.envScene = new THREE.Scene();
    this.envScene.add(sky.envMesh);

    this.envRT = null;
    this._focus = new THREE.Vector3();
    this._camera = null;
    this._envDirty = true;
    this._envAge = 1e9;
    this.envRefreshInterval = opts.envRefreshInterval ?? 3.0;
    // THE SKY'S SHARE OF THE ILLUMINANCE. See the `sunBoost` block below: this
    // number and that one are ONE decision, and round 4 moved only half of it.
    //
    // TWO FIELDS, ONE OWNER EACH. `baseEnvironmentIntensity` is the CALIBRATION
    // — it pairs with `sunBoost` and nothing outside this file may write it.
    // `environmentIntensity` is the LIVE value and `weather.js` scales it per
    // preset. They were the same field, and `weather.setState()` (which the
    // engine calls at boot, before the first frame) passed its preset's
    // `envScale` — a RATIO, 1.00 for dry — straight into `setEnvironmentIntensity`
    // as an absolute. Result: whatever this file calibrated was overwritten with
    // 1.0 during init, every time, and the shadow rebalance below silently did
    // not happen. Measured after the fix landed and before this one: `sunBoost`
    // read back as 3.7 (applied) while `environmentIntensity` read back as 1.0
    // (discarded) — half a change is worse than none, because it moves the key
    // down without moving the sky up.
    //
    // ROUND 5: 2.15 -> 1.55. See the sun/sky block below — this is one decision
    // with `sunBoost`, and the pair is what buys the shadow contrast finding 2
    // asks for. The under-car bounce that used to fall with the SQUARE of this
    // number no longer does; see ENV_BOUNCE_GAIN.
    //
    // ROUND 5, SECOND PASS: 1.55 -> 1.46, and the move is deliberately SMALL.
    // This field multiplies the IBL for every material in the game, so it is
    // also the gain on the car's flank reflection — the thing the paint critic
    // called last round's deciding factor. The key/ambient ratio is bought
    // mostly with `sunBoost` and the shadow floor is held with the bounce gain;
    // env only trims. Measured on `chase` and `grid`, same page load:
    // sun 4.8/env 1.36 and sun 5.1/env 1.46 land on the SAME ratio (5.47/5.78
    // vs 5.48/5.79) and the second clips 0.33 pp less, for 7 % more specular.
    //
    // ROUND 5 INTEGRATION: 1.46 -> 1.70. The pair above was optimised on `chase`
    // and `grid`, and on those two it is right — but it was never checked on the
    // three shots with a LOW sun and the car close to the lens, and there the
    // extra key with less ambient crushed the car's shade side. Measured over
    // the nine capture shots, % of pixels below L=6, round 4 -> this build:
    //
    //   improved   cockpit 18.5 -> 7.2   grid 10.9 -> 6.3   tv 2.6 -> 1.0
    //   REGRESSED  wheel 16.2 -> 19.4    hud 5.8 -> 8.1     front 1.6 -> 2.8
    //
    // and tools/compare.mjs against shots/r4-final-* put five cells over the
    // 15 % edge-loss line in exactly those three frames (wheel r3c4/r4c4/r5c4,
    // hud r3c3/r2c3, front r1c0) — the shaded floor edge, the rear-quarter and
    // the shadowed hills. Swept here with `?env=` (which had to be repaired in
    // core/engine.js first — weather.update() was overwriting it every frame):
    //
    //   env 1.46   front L<6 2.79 %   wheel 19.36 %   hud 8.12 %   5 cells lost
    //   env 1.70   front L<6 2.49 %   wheel 18.10 %   hud 7.62 %   2 cells lost
    //   env 1.90   front L<6 2.26 %   wheel 17.08 %   hud 7.20 %   2 cells lost
    //
    // p99 moves by at most one code and clipped-white stays at 0.000 % in all
    // nine shots, so this is bought out of the shadow floor, not the highlights.
    // 1.70 is still a HIGHER key/ambient ratio than round 4 shipped (5.1/1.70 =
    // 3.00 against 4.2/1.55 = 2.71), so the contrast the pass above was written
    // for survives; 1.90 buys no further cell and starts giving it away.
    this.baseEnvironmentIntensity = opts.environmentIntensity ?? 1.70;
    this.environmentIntensity = this.baseEnvironmentIntensity;

    /** Gain on the IBL floor/band radiance. See ENV_BOUNCE_GAIN. */
    this.bounceGain = opts.bounceGain ?? ENV_BOUNCE_GAIN;

    // -- key eclipse rescue -------------------------------------------------
    /** Set false to take the shot author's compass bearing literally. */
    this.keyRescue = opts.keyRescue !== false;
    /** authored `elevation|azimuth` -> the bearing actually used. */
    this._rescueCache = new Map();
    this._rescueRoots = null;
    this._raycaster = null;
    /** Last decision, for tools/_l5key.mjs. */
    this.keyRescueLog = null;

    // -- exposure ----------------------------------------------------------
    //
    // CALIBRATION. `exposureBias` is not a taste knob, it is the constant that
    // makes the metered EV land on the tone map, so it is only meaningful
    // against measured scene radiances. At 15:20 with the sky fixed: asphalt
    // 0.06-0.24, white kerb paint 0.55, sunlit cumulus 0.3-2.8, sun disc 19.
    // An 18% grey in that light is ~0.19, and the ACES fit wants it near 0.21
    // exposed to print as a 0.40 mid-tone — hence ~2.3x at the reference EV.
    //
    // (It was 3.05 while the cloud march was handing the PMREM bake a 20x-too-
    // bright sky; the ambient that inflated made everything look correctly lit
    // at half this exposure. Fixing the sky is what moved this number.)
    this.exposureBias = opts.exposureBias ?? 4.85;
    this.adaptation = opts.adaptation ?? 0.72;   // 1 = full auto-exposure, 0 = fixed
    this.referenceEV = opts.referenceEV ?? 1.35; // metered EV100 of a clear noon
    this.exposureRange = [0.35, 6.0];
    this.exposureOverride = null;

    // -- SUN / SKY RATIO ----------------------------------------------------
    //
    // This is the number that decides whether a shadow READS. Measured off the
    // `grid` frame before this existed: sunlit tarmac 0.078 display-linear,
    // the same tarmac with the key at zero 0.026 — a 3.0:1 ratio, so a perfect
    // shadow could only ever be 1.6 stops down. A clear sky at 49 deg of
    // elevation puts ~610 W/m^2 of direct on the horizontal against ~110 of sky
    // diffuse, i.e. 6.5:1, which is 2.7 stops. The shadows were correct and
    // simply had nothing to bite on.
    //
    // The IBL is NOT what is wrong: the sky's radiance is calibrated (see the
    // cloud note in the contract) and halving `environmentIntensity` would gut
    // every car's specular. The key light is what was light. `_skyBase` cannot
    // change (weather.js round-trips through it), so the boost lives here and
    // is applied on the way out of `_applyKeyIntensity`.
    //
    // The exposure meter sees the boost too, so ~72% of it is given straight
    // back as a lower exposure (`adaptation`): the frame keeps its mid-tone and
    // gains contrast, which is exactly the trade wanted. Re-measured on `chase`
    // (which looks into the sun) for clipping after every change to this.
    //
    // ROUND 4, RE-MEASURED, AND 1.85 WAS STILL FAR TOO LOW. Method: capture
    // `grid`, then capture it again with `renderer.shadowMap.enabled = false`
    // and difference the two. That isolates the key's share exactly, because
    // the only thing the shadow map can subtract IS the key. At 1.85 a fully
    // shadowed patch of tarmac came back at 63 % of its lit value — 0.66 of a
    // stop, which after the look grade is four 8-bit code values on a surface
    // already sitting at 21/255. That is why twenty cars photographed as
    // stickers on paper: not a broken shadow, a shadow with nothing to bite on.
    //
    // Sweep at 1.85 / 3.2 / 4.5 / 6.0, sunlit vs shadowed tarmac in the graded
    // `grid` frame (sRGB code values):
    //     1.85  21 -> 13   1.6:1     (invisible)
    //     3.2   27 -> 11   2.5:1
    //     4.5   31 ->  9.9 3.2:1     <- chosen
    //     6.0   36 ->  9.1 3.9:1     (sunlit grass starts to posterise)
    // 4.6 puts direct:ambient on a horizontal surface at ~3:1, i.e. a 2-stop
    // shadow, which is where a clear-sky photograph with this much cumulus in
    // it actually sits. It also pulls the sky off the ceiling (peak cloud
    // 205 -> 166) because the meter closes down to pay for the key, so this is
    // a net REDUCTION in clipping risk, not an increase.
    //
    // ROUND 4 INTEGRATION — 4.6 DID NOT LAND ON 3:1, IT LANDED ON 8.7:1.
    //
    // The intent above is right and the arithmetic behind it was never checked
    // against the OTHER two round-4 changes that moved the same ratio in the
    // same direction: the hemisphere fill was halved (0.11 -> 0.055 by day) and
    // `_buildEnvGround` put a 13 %-albedo floor into the PMREM, which pulls the
    // wide diffuse mip an up-facing normal reads DOWN as well. Three cuts to the
    // sky, one boost to the sun, each argued on its own page. Measured live at
    // `grid` after all three: direct 9.86, ambient 1.13 — 8.7:1, i.e. a 3.1-stop
    // shadow, not the 2 stops this block set out to buy.
    //
    // What that looks like in the capture: the main grandstand's shadow across
    // the run-off, the grass and the outside of the track photographs at sRGB 7
    // against sunlit tarmac at 60. Not "a dark shadow" — a black hole with the
    // crowd, the sponsor boards and the grass inside it. Isolated by A/B:
    // `aoPass.enabled = false` moves it 7 -> 6, `fill.intensity * 4` moves it
    // 7 -> 9, `environmentIntensity = 3` moves it 7 -> 50. It is the sky term
    // and nothing else.
    //
    // Swept as a PAIR (the sunlit level has to stay put, or every other shot
    // re-exposes), sunlit / shadowed tarmac in the graded `grid` frame:
    //     env 1.00  sun 4.6    69 ->  8    8.6:1 sRGB   <- shipped in round 4
    //     env 1.80  sun 3.4    81 -> 31    2.6:1
    //     env 2.00  sun 3.8    83 -> 32    2.6:1
    //     env 2.15  sun 3.7    -- chosen --
    //     env 2.40  sun 4.2    87 -> 38    2.3:1
    // 2.15 / 3.7 puts direct:ambient at 3.8:1 — 1.9 stops, the number the block
    // above always meant — and leaves the key carrying two thirds of the
    // illuminance, so a cast shadow still has plenty to bite on.
    //
    // ROUND 5 — 3.8:1 IS AN OVERCAST DAY, AND THE PAIR MOVES AGAIN.
    //
    // Measured in the round-4 build with tools/_r5lt.mjs (capture the shot,
    // then re-render it with the cascade lights at zero and difference the two,
    // which isolates the key's share exactly): sunlit tarmac at `grid` came
    // back at direct:ambient 2.6:1. The physics for a clear sky with light
    // cumulus at 38 deg of elevation is ~850 W/m^2 of direct normal, so
    // 850*sin(38) = 523 horizontal, against 90-150 of diffuse: 3.5-5.8:1. The
    // shipped frame was below the bottom of that range, which is why every
    // shadow read as a grey wash and the whole world read soft.
    //
    // Swept as a PAIR again, because the sunlit level has to stay put or every
    // other shot re-exposes. `grid`, direct:ambient on sunlit tarmac measured
    // by the key-off difference, and the crushed-black share of `chase`:
    //     env 2.15  sun 3.70   2.6:1   chase L<6 = 2.71 %   <- round 4
    //     env 1.80  sun 3.95   3.6:1   chase L<6 = 2.63 %
    //     env 1.55  sun 4.20   4.5:1   chase L<6 = 2.58 %   <- chosen
    //     env 1.30  sun 4.55   5.8:1   chase L<6 = 2.79 %
    //     env 1.05  sun 5.00   8.0:1   chase L<6 = 3.41 %   (grandstand shadow
    //                                   goes to a hole again — the round-4 bug)
    // The crushed-black column is flat across the first three ONLY because
    // ENV_BOUNCE_GAIN now holds the under-car bounce steady while the sky's
    // share falls; without it, env 1.55 costs the square of the same cut and
    // `chase` lands at 4.9 %.
    //
    // ROUND 5, SECOND PASS — 4.2 -> 5.1, AND THE MEASUREMENT IS NOW OFF PIXELS
    // AND OFF PHYSICS, NOT OFF THE FRAMEBUFFER'S OPINION.
    //
    // Everything above tunes against sRGB code values read out of the graded
    // frame, and that is why the numbers never agreed with each other: ACES
    // plus the look curve compress a sunlit road far harder than the shadow
    // beside it, so ONE physical ratio photographs as 3:1 at `grid`'s exposure
    // and 9:1 at `tv`'s. `_updateExposure` now publishes `keyAmbientRatio` —
    // direct against sky+bounce irradiance on a horizontal surface, in scene
    // units, which is exactly what a cast shadow removes. Measured on the
    // round-4 pair: grid 4.54, chase 4.30, wide 2.96, tv 2.51, beauty 1.60.
    // The review asked for 5-8:1 and the round-4 build was under it everywhere.
    //
    // 5.1 with env 1.46 puts the two shots that matter — the 36-38 deg suns —
    // at 5.79 (grid) and 5.48 (chase), inside the window and inside the physics
    // (850 W/m^2 direct normal at 38 deg is 523 horizontal against 90-150 of
    // diffuse, i.e. 3.5-5.8:1). The low-sun shots stay lower (tv 3.2 at 23 deg,
    // beauty 2.1 at 17 deg) and that is CORRECT: the ratio really does collapse
    // toward the horizon, and forcing golden hour to 6:1 is what makes a sunset
    // frame look like a mid-morning frame with an orange filter on it.
    this.sunBoost = opts.sunBoost ?? 5.1;

    // -- aerial perspective -------------------------------------------------
    // 1.55 put ~75% haze on a 2 km hill at a low sun, which erased the sky's
    // own colour and left golden hour looking overcast. 0.90 lands nearer the
    // 30-40% a photograph shows at that range, so the distance keeps contrast.
    this.aerialStrength = opts.aerialStrength ?? 0.90;
    this.aerialHeightScale = opts.aerialHeightScale ?? 850;
    this.aerialSunGlow = opts.aerialSunGlow ?? 0.13;

    const q = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
    if (q.has('exposure')) this.exposureOverride = parseFloat(q.get('exposure'));
    if (q.get('csm') === '0') for (const l of this.cascadeLights) l.castShadow = l === this.sun;

    /** Direction the key light comes FROM. The sun by day, the main
     *  floodlight bank at night. */
    this.keyDirection = new THREE.Vector3().copy(sky.sunDirection);
    this._skyBase = this.sun.intensity;    // what the sky alone asks for
    this._weatherScale = 1;                // what weather.js last multiplied it by
    this._lastApplied = this.sun.intensity;

    this._splits = new Float32Array(CASCADES + 1);
    this._computeSplits();
    // After `keyDirection` / `_skyBase` exist — the floor is tinted from them.
    this._buildEnvGround();
    this.syncToSky();
  }

  /** The camera the cascades are fitted to. Falls back to focus-centred boxes. */
  setCamera(camera) {
    this._camera = camera;
    this._computeSplits();
    return this;
  }

  // -- cascade geometry -----------------------------------------------------

  /**
   * Practical split scheme: a blend of the logarithmic split (which matches
   * perspective texel density) and the uniform split (which stops the near
   * cascade from collapsing to nothing).
   */
  _computeSplits() {
    const n = this.cascadeNear;
    const f = this.cascadeFar;
    const l = this.splitLambda;
    for (let i = 0; i <= CASCADES; i++) {
      const t = i / CASCADES;
      const log = n * Math.pow(f / n, t);
      const uni = n + (f - n) * t;
      this._splits[i] = l * log + (1 - l) * uni;
    }
    this._splits[0] = n;
    this._splits[CASCADES] = f;
    // NORMALISE BY THE SHADER'S CONSTANT, not by `this.cascadeFar`. The shader
    // computes `linearDepth = viewZ / CSM_SHADOW_FAR` with CSM_SHADOW_FAR baked
    // at install time; using the instance field here (which `setCascade` can
    // change) would silently shift every break and select a cascade the CPU
    // never fitted.
    for (let i = 0; i < CASCADES; i++) {
      cascadeBreaks[i * 2] = this._splits[i] / CASCADE_FAR;
      cascadeBreaks[i * 2 + 1] = this._splits[i + 1] / CASCADE_FAR;
    }
    // The first cascade has to start at the camera or the car's own shadow
    // vanishes when the chase camera is close.
    cascadeBreaks[0] = 0;
    // The last cascade is the shader's catch-all (`|| i == CSM_CASCADES - 1`),
    // and its CSM_FADE ramp is derived from this edge. It must read 1.0 or the
    // fade-out band sits somewhere other than the far end of the ladder.
    cascadeBreaks[CASCADES * 2 - 1] = 1;
  }

  /**
   * Bounding sphere of the frustum slice [near, far], in camera space. Its
   * radius depends only on the slice bounds and the lens, never on the camera's
   * orientation — that rotational invariance is what makes the cascade stable.
   */
  _sliceSphere(near, far, out) {
    const cam = this._camera;
    const tanV = Math.tan(THREE.MathUtils.degToRad(cam.fov * 0.5));
    const k = Math.sqrt(1 + cam.aspect * cam.aspect) * tanV;
    const k2 = k * k;
    let centreZ, radius;
    if (k2 >= (far - near) / (far + near)) {
      centreZ = far;
      radius = far * k;
    } else {
      centreZ = 0.5 * (far + near) * (1 + k2);
      radius = 0.5 * Math.sqrt(
        (far - near) * (far - near) +
        2 * (far * far + near * near) * k2 +
        (far + near) * (far + near) * k2 * k2
      );
    }
    cam.getWorldPosition(_camPos);
    cam.getWorldDirection(_camDir);
    out.copy(_camPos).addScaledVector(_camDir, centreZ);
    return radius;
  }

  /** Ortho half-extent (metres) and how far the light sits back. Legacy API. */
  setCascade(radius, distance) {
    // Interpreted as "the near cascade should cover `radius` metres"; the rest
    // of the split scheme scales with it. Clamped to CASCADE_FAR because that
    // number is compiled into the shader.
    this.cascadeFar = THREE.MathUtils.clamp(radius * 10, 90, CASCADE_FAR);
    if (distance) this.cascadeDistance = distance;
    this._computeSplits();
    return this;
  }

  /** Point the cascades at a world position (normally the player car). */
  setShadowFocus(v) {
    this._focus.copy(v);
  }

  // -- sky-driven lighting --------------------------------------------------

  /** Pull sun colour/intensity, fill, floodlights and exposure from the sky. */
  syncToSky() {
    const s = this.sky;
    const i = s.sunIntensity();
    const night = s.uniforms.uNight.value;

    s.sunColour(_colour);
    if (night > 0.01) _colour.lerp(FLOODLIGHT_COLOUR, night);

    // Keep the exact shape of the formula weather.js multiplies, so its writes
    // stay meaningful; the night floodlight bank is added on top of it.
    this._skyBase = 0.35 + 3.6 * i;
    this.floodBoost = night * 3.1;

    // At night the key stops being the sun: a floodlight bank sits high and to
    // one side so the cars still throw the hard, short shadows a night race has.
    if (night > 0.5) {
      const az = THREE.MathUtils.degToRad(s.azimuth + 52);
      this.keyDirection.set(Math.sin(az) * 0.52, 0.85, Math.cos(az) * 0.52).normalize();
    } else {
      this.keyDirection.copy(s.sunDirection);
    }

    for (const l of this.cascadeLights) l.color.copy(_colour);
    this._applyKeyIntensity();

    this.fill.color.copy(s.skyColour()).lerp(FLOODLIGHT_COLOUR, night * 0.8);
    this.fill.groundColor.setRGB(0.10 + 0.06 * i, 0.09 + 0.05 * i, 0.08 + 0.04 * i, THREE.LinearSRGBColorSpace);
    // The IBL already carries the sky; the hemisphere is only a bounce trim by
    // day, but at night it stands in for the stadium's own spill.
    //
    // HALVED FOR ROUND 4, and the reason is `_buildEnvGround`. A HemisphereLight
    // is the one term in this file that NOTHING can occlude — no cascade, no
    // GTAO — so every unit of it is a unit a cast shadow can never remove. It
    // was carrying ~20 % of the ground's ambient purely to fake the ground
    // bounce that a PMREM with no floor in it could not supply. The floor now
    // supplies it, correctly and with a real horizon, so the fake comes off.
    // The night term is untouched: floodlit stadium spill is genuinely ambient.
    this.fill.intensity = 0.055 + 0.05 * i + night * 0.55;

    for (const l of this.floodlights) l.intensity = night * 1.35;
    for (const l of this.floodlights) l.color.copy(FLOODLIGHT_COLOUR);

    this._envDirty = true;
    this._updateExposure();
    return this;
  }

  /**
   * `_skyBase` has to keep the literal shape `0.35 + 3.6 * sunIntensity()`
   * because `weather.js` writes its own copy of it into `sun.intensity` and
   * `update()` divides by `_skyBase` to recover the cloud scale. `sunBoost` is
   * therefore applied on the way OUT and never folded into `_skyBase` — that
   * keeps the weather read-back exact while letting the key light carry a
   * physical share of the total illuminance.
   */
  _applyKeyIntensity() {
    const key = this._skyBase * this._weatherScale * this.sunBoost + this.floodBoost;
    for (const l of this.cascadeLights) l.intensity = key;
    this._lastApplied = key;
    this.keyIntensity = key;
  }

  // -- key eclipse rescue ---------------------------------------------------

  /** Unit direction toward a sun at (elevation, azimuth) in DEGREES. Matches
   *  `Sky.setSun`'s `setFromSphericalCoords(1, 90 - el, az)` exactly. */
  _sunDirFrom(elevationDeg, azimuthDeg, out) {
    const e = THREE.MathUtils.degToRad(elevationDeg);
    const a = THREE.MathUtils.degToRad(azimuthDeg);
    return out.set(Math.cos(e) * Math.sin(a), Math.sin(e), Math.cos(e) * Math.cos(a));
  }

  /**
   * Fraction of a six-ray bundle from the shadow focus that a piece of circuit
   * architecture blocks. Returns -1 while the world does not exist yet (boot,
   * and the constructor's own `syncToSky`), which is NOT the same as 0 and must
   * never be cached as a decision.
   *
   * The bundle is two heights (0.45 m — a floor/diffuser, and 1.05 m — the roll
   * hoop) at three lateral offsets across the light ray, so a car half in and
   * half out of a shadow edge does not read as fully eclipsed.
   */
  _probeKeyOcclusion(dir) {
    if (!this._rescueRoots || !this._rescueRoots.length) {
      this._rescueRoots = KEY_RESCUE_ROOTS
        .map((n) => this.scene.getObjectByName(n))
        .filter(Boolean);
    }
    const roots = this._rescueRoots;
    if (!roots.length) return -1;
    if (!this._raycaster) this._raycaster = new THREE.Raycaster();
    const rc = this._raycaster;
    rc.near = 0;
    rc.far = KEY_RESCUE_RANGE;

    _rayPerp.crossVectors(dir, WORLD_UP);
    if (_rayPerp.lengthSq() < 1e-8) _rayPerp.set(1, 0, 0);
    _rayPerp.normalize();

    const dbg = this.keyRescueDebug ? [] : null;
    let blocked = 0, total = 0;
    for (const lat of [-2.2, 0, 2.2]) {
      for (const hgt of [0.45, 1.05]) {
        _rayOrigin.copy(this._focus).addScaledVector(_rayPerp, lat);
        _rayOrigin.y += hgt;
        rc.set(_rayOrigin, dir);
        let hit = false;
        for (const r of roots) {
          let list;
          // Fifteen people add meshes to this tree; one geometry without a
          // position attribute must not be able to take the frame down.
          try { list = rc.intersectObject(r, true); } catch { continue; }
          for (const h of list) {
            if (h.distance > KEY_RESCUE_MIN_DISTANCE) {
              hit = true;
              if (dbg) dbg.push({ lat, hgt, root: r.name, obj: h.object.name || h.object.type, d: +h.distance.toFixed(1) });
              break;
            }
          }
          if (hit) break;
        }
        if (hit) blocked++;
        else if (dbg) dbg.push({ lat, hgt, root: null });
        total++;
      }
    }
    if (dbg) this.keyProbeHits = dbg;
    return blocked / total;
  }

  /**
   * THE KEY HAS TO REACH THE SUBJECT.
   *
   * `stageSun` in `core/engine.js` authors every shot's key as a bearing off
   * the ROAD — which is the right call, because it makes shadows rake across
   * the lens on any corner of any circuit — but it cannot know what is BUILT
   * beside that piece of road. At the start line the main grandstand stands
   * ~10 m off a 13.4 m track and is ~15 m tall, so the authored "sun over the
   * driver's right hand at 38 deg" lays 19 m of roof shadow across the entire
   * racing surface. Measured with `tools/_r5lt.mjs` (capture, then re-render
   * with the cascade lights at zero and difference): two tarmac patches in the
   * `grid` frame came back at direct:ambient 1.00 and 1.01. Not a weak key — no
   * key. Twenty cars lit purely by the sky, which is exactly what "reads as a
   * flat silhouette with no carbon highlight and no livery separation" is.
   *
   * So the bearing is VALIDATED before it is used, and the fix preserves the
   * author's intent rather than overriding it:
   *
   *   1. The first candidate is the authored bearing MIRRORED ABOUT THE VIEW
   *      AXIS. That keeps the elevation, keeps how frontal or backlit the key
   *      is relative to the lens, keeps the rake angle across frame, and only
   *      swaps which of the driver's hands the sun stands over — which is the
   *      one degree of freedom the shot author had no information about.
   *   2. Then the same two bearings with the sun lifted, for the case where
   *      both sides are walled in (a stadium section).
   *   3. If nothing is clear, the authored bearing is kept. A shot with no
   *      answer must not be left oscillating.
   *
   * It moves the SKY, not just the light: `sky.setSun` re-derives the sun disc,
   * the radiance probes, the aerial-perspective uniforms and the lens flare, so
   * the frame stays internally consistent. A key that disagrees with the sun in
   * the sky is the other way to fail this, and it photographs worse.
   *
   * STABILITY. The decision is cached against the AUTHORED (elevation,
   * azimuth), never re-derived from where the car happens to be, so it is taken
   * once per staged sun and cannot flip while driving — a sun that swings when
   * you pass a grandstand would be far worse than the defect it fixes. Applying
   * a rescue makes the sky report the rescued bearing, which is then probed
   * once more, comes back clear, and caches as a no-op: two probe bundles per
   * shot and nothing per frame after that.
   */
  _rescueKey() {
    if (!this.keyRescue || !this._camera) return false;
    const s = this.sky;
    if ((s.uniforms?.uNight?.value ?? 0) > 0.3) return false;
    const el = s.elevation, az = s.azimuth;
    if (!(el > KEY_RESCUE_MIN_ELEVATION)) return false;

    // A running time-of-day cycle would mint a new entry every frame; the cache
    // exists for stability across a handful of staged suns, not as a history.
    if (this._rescueCache.size > 64) this._rescueCache.clear();

    const cacheKey = `${el.toFixed(2)}|${az.toFixed(2)}`;
    const hit = this._rescueCache.get(cacheKey);
    if (hit) {
      if (Math.abs(hit.el - el) < 1e-6 && Math.abs(hit.az - az) < 1e-6) return false;
      s.setSun(hit.el, hit.az);
      this.syncToSky();
      return true;
    }

    const f0 = this._probeKeyOcclusion(this._sunDirFrom(el, az, _rayDir));
    this.keyRescueLog = {
      authored: { el: +el.toFixed(2), az: +az.toFixed(2) }, authoredBlocked: f0,
      focus: this._focus.toArray().map((v) => +v.toFixed(1)),
      chosen: null, chosenBlocked: null,
      hits: this.keyProbeHits ?? null,
    };
    if (f0 < 0) return false;                       // world not built yet
    if (f0 < KEY_RESCUE_TRIGGER) {
      this._rescueCache.set(cacheKey, { el, az });
      return false;
    }

    // Mirror about the camera's horizontal forward axis.
    this._camera.getWorldDirection(_camFwd);
    const camAz = THREE.MathUtils.radToDeg(Math.atan2(_camFwd.x, _camFwd.z));
    const mirrored = 2 * camAz - az;

    const candidates = [
      { el, az: mirrored },
      { el: Math.min(el + 18, 78), az: mirrored },
      { el: Math.min(el + 18, 78), az },
      { el: Math.min(el + 32, 82), az },
    ];
    let chosen = null, chosenBlock = 1;
    for (const c of candidates) {
      const f = this._probeKeyOcclusion(this._sunDirFrom(c.el, c.az, _rayDir));
      if (f >= 0 && f <= KEY_RESCUE_ACCEPT) { chosen = c; chosenBlock = f; break; }
    }
    this.keyRescueLog.chosen = chosen ? { el: +chosen.el.toFixed(2), az: +chosen.az.toFixed(2) } : null;
    this.keyRescueLog.chosenBlocked = chosen ? chosenBlock : null;
    if (!chosen) { this._rescueCache.set(cacheKey, { el, az }); return false; }

    this._rescueCache.set(cacheKey, { el: chosen.el, az: chosen.az });
    s.setSun(chosen.el, chosen.az);
    this.syncToSky();
    return true;
  }

  /**
   * Metered exposure. `luminance` here is scene-referred (the same units the
   * sky shader emits), so EV100 is only meaningful up to the calibration in
   * `exposureBias` — but it is consistent, which is the point: every time of
   * day is exposed by the same rule rather than hand-picked.
   */
  _updateExposure() {
    if (this.exposureOverride !== null) {
      this.renderer.toneMappingExposure = this.exposureOverride;
      return;
    }
    const s = this.sky;
    const sunLum = 0.2126 * this.sun.color.r + 0.7152 * this.sun.color.g + 0.0722 * this.sun.color.b;
    const cosGround = Math.max(0, s.sunDirection.y);
    const cosKey = Math.max(0, this.keyDirection.y);
    const direct = (this._skyBase * this._weatherScale * this.sunBoost) * sunLum * cosGround
      + this.floodBoost * cosKey;
    const ambient = (s.averageLuminance() * this.environmentIntensity + this.fill.intensity) * Math.PI;
    // Reflected luminance off an 18% grey Lambertian ground.
    const sceneLuminance = 0.18 * (direct + ambient) / Math.PI;

    /**
     * THE NUMBER FINDING 2 IS ABOUT, in SCENE-REFERRED units — direct against
     * sky+bounce irradiance on a horizontal surface, which is exactly what a
     * cast shadow removes. Do not tune this off the framebuffer: the ACES
     * shoulder compresses a sunlit road far harder than the shadow beside it,
     * so the same physical 5:1 reads as 3:1 at `grid`'s exposure and 9:1 at
     * `tv`'s. Clear sky with light cumulus is 3.5-6:1; overcast is 1:1.
     */
    this.keyAmbientRatio = direct / Math.max(ambient, 1e-6);

    const ev100 = Math.log2(Math.max(sceneLuminance, 1e-5) * 100 / 12.5);
    const target = this.referenceEV + (ev100 - this.referenceEV) * this.adaptation
      - (s.exposureCompensation ?? 0);
    this.ev100 = target;

    const e = this.exposureBias / (1.2 * Math.pow(2, target));
    this.renderer.toneMappingExposure = THREE.MathUtils.clamp(e, this.exposureRange[0], this.exposureRange[1]);
  }

  /**
   * THE IBL NEEDS A FLOOR.
   *
   * `pmrem.fromScene` renders a cube from the origin of `envScene`. With only
   * the sky mesh in there, every one of those six faces — including the one
   * pointing at the tarmac — comes back full sky radiance. Three things follow,
   * and all three are what a diorama looks like:
   *
   *   1. Every surface is lit from below as hard as from above, so the shading
   *      gradient that tells you where the light is coming from is gone.
   *   2. The under-car, under-wing and under-barrier regions — the exact places
   *      a cast shadow is supposed to own — are filled back in by ambient.
   *   3. A car's flank at a grazing angle reflects the sky in BOTH directions
   *      instead of sky above / dark ground below, which is why the paint had to
   *      have its specular IBL crushed to stop the nose smearing silver-pink
   *      (see the note in `car/materials.js`). No horizon in the reflection is
   *      the single biggest tell against a real broadcast frame.
   *
   * So: a hemispherical floor plus a low band standing in for the barriers,
   * hoardings, garages and grandstands that actually surround a circuit. Both
   * are unlit `MeshBasicMaterial` — they ARE radiance, not albedo — and both are
   * re-tinted from the live key and sky on every refresh, so they dim through
   * dusk and go to floodlight colour at night without any special casing.
   *
   * They live only in `envScene`; the real scene never sees them.
   */
  _buildEnvGround() {
    const R = ENV_GROUND_RADIUS;
    const mk = (geo) => {
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        side: THREE.BackSide, toneMapped: false, fog: false, depthWrite: true,
      }));
      m.frustumCulled = false;
      // `sky.envMesh` draws with `depthTest: false` at renderOrder 0, so the
      // floor has to be queued AFTER it or the sky simply paints over it.
      m.renderOrder = 1;
      return m;
    };

    // Lower hemisphere. Centred on the origin, so from the bake camera it
    // subtends exactly the half-space below the horizon.
    this.envGround = mk(new THREE.SphereGeometry(R, 24, 8, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.5));
    this.envGround.name = 'EnvGround';

    // Trackside band, 0 to ENV_BAND_ELEVATION degrees. An open cylinder sitting
    // on the horizon; `h` is the height that subtends that angle at radius R.
    //
    // VERTEX COLOURED, because a horizon ring is not one colour. See
    // `_updateEnvGround` for why that is the difference between a car with a
    // shaped ambient and a car lit by a light box.
    const h = R * Math.tan(THREE.MathUtils.degToRad(ENV_BAND_ELEVATION));
    this.envBand = mk(new THREE.CylinderGeometry(R, R, h, ENV_BAND_SEGMENTS, 1, true));
    this.envBand.position.y = h * 0.5;
    this.envBand.name = 'EnvHorizonBand';
    this.envBand.material.vertexColors = true;
    const bandPos = this.envBand.geometry.attributes.position;
    this.envBand.geometry.setAttribute(
      'color', new THREE.BufferAttribute(new Float32Array(bandPos.count * 3), 3)
    );

    this.envScene.add(this.envGround, this.envBand);
    this._updateEnvGround();
  }

  /**
   * Re-tint the IBL floor from the current lighting. The floor is a Lambertian
   * patch of the world, so its radiance is `albedo * E / PI` where `E` is the
   * irradiance actually landing on it: the key at its own elevation, plus the
   * sky's own hemispherical irradiance (`PI * averageLuminance`), plus the
   * hemisphere fill. Same numbers the exposure meter uses, so the floor can
   * never drift out of step with the frame it is lighting.
   *
   * Divided by `environmentIntensity` once — see ENV_BOUNCE_GAIN. The gain in
   * front of it was measured on `chase` (the shot whose crushed blacks are the
   * regression this pays off), as the share of pixels under sRGB L=6 with the
   * sky's share cut to buy the shadow contrast finding 2 asks for:
   *     gain 1.0   4.9 %   (under-wing, diffuser and beam wing one black slab)
   *     gain 1.6   3.4 %
   *     gain 2.1   2.6 %
   *     gain 3.0   2.1 %
   *
   * ROUND 5 — 2.1 -> 3.5, AND THE SWEEP ABOVE WAS RUN TOO FAR APART TO TRUST.
   * Every row of it was measured minutes apart while fourteen other people were
   * editing this tree, so it compares calibrations AND worlds. Re-run in
   * `tools/_l5ab.mjs`, which stages and measures every variant inside ONE page
   * load — the round-4 pair and two candidates, on `chase` and `grid`:
   *   sun 4.2 env 1.55 bounce 2.1   ratio 4.30/4.54  chase L<6 5.30%  clip 4.25%
   *   sun 4.8 env 1.36 bounce 3.6   ratio 5.47/5.78  chase L<6 4.89%  clip 3.91%
   *   sun 5.1 env 1.46 bounce 3.5   ratio 5.48/5.79  chase L<6 4.86%  clip 3.58%
   * The last one ships. Note what that says: round 4's belief that buying key
   * contrast COSTS crushed blacks is false once the bounce term moves with the
   * pair — more key, fewer crushed pixels AND less clipping, all three at once.
   * 3.5 over 3.6 because extra bounce is the cheaper way to hold the under-car
   * than another 0.10 off `environmentIntensity`, which is a straight multiplier
   * on every car's flank reflection (see `car/materials.js` — that reflection is
   * a shipped round-5 fix and must not be quietly undone from this file).
   *
   * THE HORIZON BAND IS NOT ONE COLOUR.
   *
   * The band stands in for the barriers, hoardings, garages, grandstands and
   * trees ringing the circuit, and those are VERTICAL surfaces: the ones on the
   * far side of you from the sun turn their lit face toward you, and the ones
   * on the sun's own side show you their shaded backs. A photograph of a grid
   * has a warm bright wall down one side and a cool one down the other, and
   * that split is most of the ambient SHAPE on a car photographed from behind —
   * the case where the key is across the lens and every camera-facing surface
   * is ambient-only. A single flat band gives those surfaces one uniform colour
   * from every direction, which is a light box, which is why twenty cars can
   * photograph as flat silhouettes while the shadow map insists they are lit.
   *
   * So the band's irradiance is evaluated per vertex against its own inward
   * normal. Cost: 98 vertex writes per IBL refresh (every 3 s).
   */
  _updateEnvGround() {
    if (!this.envGround) return;
    const s = this.sky;
    const key = this.keyIntensity ?? this._lastApplied;
    const cos = Math.max(0, this.keyDirection.y);
    const env = Math.max(this.environmentIntensity, 1e-3);
    const skyIrr = Math.PI * s.averageLuminance() * env + this.fill.intensity;

    // E, spectrally: the key carries the sun/floodlight colour, the ambient the
    // sky's. (`THREE.Color` has no addScaledVector, hence the explicit terms.)
    // `inv` folds in the 1/PI of a Lambertian, the division that undoes the
    // second application of `environmentIntensity`, and the measured gain.
    const k = this.sun.color, a = s.skyColour(_envSky);
    const inv = this.bounceGain / (Math.PI * env);
    _envC.setRGB(
      (k.r * key * cos + a.r * skyIrr) * inv,
      (k.g * key * cos + a.g * skyIrr) * inv,
      (k.b * key * cos + a.b * skyIrr) * inv,
      THREE.LinearSRGBColorSpace
    );
    this.envGround.material.color.copy(_envC).multiply(ENV_GROUND_ALBEDO);

    // -- the band, per vertex ----------------------------------------------
    // Horizontal bearing of the key. A vertical surface's normal has no Y, so
    // only the horizontal part of the light direction can land on it, and its
    // magnitude is the key's own cosine at the horizon.
    const kx = this.keyDirection.x, kz = this.keyDirection.z;
    const kh = Math.hypot(kx, kz);
    const horiz = key * kh;                       // key irradiance at grazing
    const skyVert = skyIrr * ENV_BAND_SKY_VIEW + skyIrr * 0.10; // sky + a little floor bounce
    const geo = this.envBand.geometry;
    const pos = geo.attributes.position, col = geo.attributes.color;
    const ux = kh > 1e-5 ? kx / kh : 0, uz = kh > 1e-5 ? kz / kh : 1;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), z = pos.getZ(i);
      const r = Math.hypot(x, z) || 1;
      // Inward normal of the face we see from the bake origin.
      const nx = -x / r, nz = -z / r;
      // Soft wrap rather than a hard clamp: a real wall is not a perfect
      // Lambertian slab and its neighbours bounce into it, so the terminator
      // is a gradient. A hard max(0, .) put a visible seam in the flank
      // reflection where the band's lit half met its dark half.
      const d = nx * ux + nz * uz;
      const lit = Math.max(0, (d + 0.28) / 1.28);
      const e = horiz * lit;
      col.setXYZ(
        i,
        (k.r * e + a.r * skyVert) * inv * ENV_BAND_ALBEDO.r,
        (k.g * e + a.g * skyVert) * inv * ENV_BAND_ALBEDO.g,
        (k.b * e + a.b * skyVert) * inv * ENV_BAND_ALBEDO.b
      );
    }
    col.needsUpdate = true;
    this.envBand.material.color.setRGB(1, 1, 1, THREE.LinearSRGBColorSpace);
  }

  /** Rebuild the PMREM environment from the sky. */
  refreshEnvironment() {
    const prev = this.envRT;
    this._updateEnvGround();
    this.envRT = this.pmrem.fromScene(this.envScene, 0.0, 0.5, 2000);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = this.environmentIntensity;
    this.scene.background = null; // the sky mesh draws the background
    if (prev) prev.dispose();
    this._envDirty = false;
    this._envAge = 0;
    return this.envRT.texture;
  }

  // -- per-frame ------------------------------------------------------------

  /**
   * @param {number} dt seconds
   * @param {THREE.Vector3} [focus] world point the near cascade should favour
   */
  update(dt, focus) {
    if (focus) this._focus.copy(focus);
    this._envAge += dt;

    // Before anything reads `keyDirection`: the shot's authored bearing may put
    // the sun behind a grandstand. Cached against the authored sun, so this is
    // a cache lookup on all but the first two frames after a sun change.
    this._rescueKey();

    // weather.js writes `sun.intensity` directly with its own copy of the
    // `0.35 + 3.6 * sunIntensity()` formula times a cloud-cover scale. Rather
    // than fight it, read back what it asked for AS A SCALE, so the night
    // floodlight bank survives and the rain dimming still works.
    if (Math.abs(this.sun.intensity - this._lastApplied) > 1e-6) {
      this._weatherScale = THREE.MathUtils.clamp(this.sun.intensity / Math.max(this._skyBase, 1e-4), 0, 1.5);
      this._applyKeyIntensity();
      this._updateExposure();
    } else {
      this._applyKeyIntensity();
    }

    this._applyShadowSide();
    this._fitCascades();
    this._updateAerial();

    if (this._envDirty || this._envAge > this.envRefreshInterval) this.refreshEnvironment();
  }

  /**
   * SHADOW-CASTING FACE POLICY — the other half of the missing contact shadow.
   *
   * `WebGLShadowMap` renders casters with `shadowSide[material.side]`, which for
   * a FrontSide material is **BackSide**. That default exists to hide acne on
   * closed meshes without any bias, and it costs two things this game cannot
   * afford:
   *
   *   1. A tyre resting on tarmac. Back faces only, so the depth written for the
   *      contact patch is the BOTTOM of the tyre — coincident with the ground it
   *      is standing on. Any bias at all then declares the ground unoccluded, so
   *      a wheel never gets a contact patch no matter how the cascade is fitted.
   *   2. Thin single-sided aero. A floor plank, a front-wing element or an
   *      endplate has no back face toward the sun, so it is culled out of the
   *      shadow map entirely and casts NOTHING. That is the missing "dark wedge
   *      under the floor".
   *
   * `DoubleSide` writes the nearest surface along the light ray, which is what a
   * shadow map is supposed to contain: correct for closed bodywork, correct for
   * a one-sided plate, and correct for a tyre (the tread, 0.72 m up). The acne
   * it re-exposes is exactly what the normal offset above is for.
   *
   * `shadowSide` is read ONLY by the shadow pass, so this cannot change how any
   * material looks in the beauty pass — it is a shadow policy, not a look edit,
   * which is why it belongs here and not in the nine files that own materials.
   * Re-run periodically because weather, particles and the front end all create
   * materials after boot; `_shadowSideSeen` keeps it to a no-op walk.
   */
  _applyShadowSide() {
    this._shadowSideAge = (this._shadowSideAge ?? 1e9) + 1;
    if (this._shadowSideAge < 45) return;
    this._shadowSideAge = 0;
    if (!this._shadowSideSeen) this._shadowSideSeen = new WeakSet();
    const seen = this._shadowSideSeen;
    this.scene.traverse((o) => {
      if (!o.castShadow || !o.material) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m || seen.has(m)) continue;
        seen.add(m);
        if (m.shadowSide === null || m.shadowSide === undefined) m.shadowSide = THREE.DoubleSide;
      }
    });
  }

  _fitCascades() {
    const dir = this.keyDirection;

    // Light-space basis. `_fwd` is the direction the light travels.
    _fwd.copy(dir).multiplyScalar(-1).normalize();
    if (Math.abs(_fwd.y) > 0.999) _right.set(1, 0, 0);
    else _right.copy(WORLD_UP).cross(_fwd).normalize();
    _up.copy(_fwd).cross(_right).normalize();

    // Light-space headroom, so a caster above a box still reaches into it. At a
    // low sun the same vertical clearance needs a much longer run along the
    // light axis, hence the division by the elevation sine.
    const head = THREE.MathUtils.clamp(CASTER_HEADROOM / Math.max(dir.y, 0.10), 170, 1400);

    // Slope proxy for the depth bias. The dominant receiver in a racing game is
    // the ground, and a horizontal plane lit from elevation e has a shadow-map
    // depth gradient of cot(e) metres per metre. three's `getShadow` has no
    // access to ddx/ddy of depth, so a real slope-scaled bias is not available;
    // the light's own elevation is a very good stand-in, and it is what stops a
    // golden-hour frame from speckling. Capped at 4 so a sunrise cannot bias the
    // shadow off the car.
    const slope = Math.min(4.0, Math.sqrt(Math.max(0, 1 - dir.y * dir.y)) / Math.max(dir.y, 0.15));

    let bestFocusSlack = Infinity;

    for (let i = 0; i < CASCADES; i++) {
      const light = this.cascadeLights[i];
      let radius;
      if (this._camera) {
        radius = this._sliceSphere(this._splits[i], this._splits[i + 1], _centre);
      } else {
        radius = this._splits[i + 1];
        _centre.copy(this._focus);
      }

      // NO per-cascade offset along the view vector beyond the slice sphere's
      // own centre. An earlier version lerped cascade 0 65% of the way toward
      // the focus, which moved the box out from under the depth band the shader
      // selects it for — pixels in band 0 landed outside box 0 and came back
      // unshadowed. The frustum-slice sphere IS the correct centre; if the
      // subject needs a tighter cascade the answer is a shorter ladder, not a
      // displaced box.

      // Snap the centre to this cascade's shadow texel grid in light space.
      const texel = (radius * 2) / light.shadow.mapSize.x;
      const cx = Math.round(_centre.dot(_right) / texel) * texel;
      const cy = Math.round(_centre.dot(_up) / texel) * texel;
      const cz = _centre.dot(_fwd);
      _centre.copy(_right).multiplyScalar(cx)
        .addScaledVector(_up, cy)
        .addScaledVector(_fwd, cz);

      const back = radius + head;
      light.position.copy(_centre).addScaledVector(dir, back);
      light.target.position.copy(_centre);
      light.target.updateMatrixWorld();

      const c = light.shadow.camera;
      const far = back + radius;
      if (c.right !== radius || c.far !== far) {
        c.left = -radius; c.right = radius;
        c.top = radius; c.bottom = -radius;
        // Ortho depth is linear and the map is a native 24-bit DepthTexture, so
        // this range is about bias sanity, not precision: `shadow.bias` is in
        // normalised depth and is divided by it below.
        c.near = 1;
        c.far = far;
        c.updateProjectionMatrix();
      }

      // Acne scales with the world size of a texel, so the normal offset has to
      // — but ONLY up to the point where it starts sliding contact shadows off
      // their contact patches. Past MAX_NORMAL_BIAS the depth bias carries it.
      light.shadow.normalBias = Math.min(MAX_NORMAL_BIAS, Math.max(0.006, texel));
      // Depth bias as a WORLD offset, then converted into this cascade's own
      // normalised depth — `shadow.bias` is added to a [0,1] coordinate, so the
      // same literal means 3 cm in one cascade and 50 cm in another unless it is
      // divided by the range. Sized to just cover the depth error the PCF kernel
      // reaches across on a ground plane (kernel radius x texel x cot(elevation)).
      const worldBias = (light.shadow.radius + 0.5) * texel * slope + 0.006;
      light.shadow.bias = -worldBias / (far - c.near);

      if (this._camera) {
        // Test the focus against the cascade's actual ORTHO BOX, not against the
        // slice sphere. The box is `radius` half-extents across light-space
        // right/up but spans `back +- radius` along the light axis, so a sphere
        // test reports a miss for a subject that is comfortably inside the
        // frustum — which is why a plain chase lap spammed the console with
        // "0.1 m outside every cascade box" while the shadow was rendering fine.
        _tmpFocus.subVectors(this._focus, _centre);
        const slack = Math.max(
          Math.abs(_tmpFocus.dot(_right)) - radius,
          Math.abs(_tmpFocus.dot(_up)) - radius,
          Math.abs(_tmpFocus.dot(_fwd)) - radius
        );
        if (slack < bestFocusSlack) bestFocusSlack = slack;
      }
    }

    // Debug assert: the shadow focus must lie INSIDE some cascade's box, or the
    // subject is being shadowed by nothing. (Asserting that a cascade is
    // CENTRED on the focus would be wrong — a cascaded map deliberately marches
    // its boxes down the view vector; what matters is coverage.)
    if (bestFocusSlack > 0) {
      this._focusMissAge = (this._focusMissAge ?? 0) + 1;
      if (this._focusMissAge % 120 === 1) {
        console.warn(
          `lighting: shadow focus is ${bestFocusSlack.toFixed(1)} m outside every cascade box ` +
          `(focus ${this._focus.x.toFixed(0)},${this._focus.y.toFixed(0)},${this._focus.z.toFixed(0)})`
        );
      }
    } else {
      this._focusMissAge = 0;
    }
  }

  /** Push the sky's radiance probes into the shared aerial-perspective uniforms. */
  _updateAerial() {
    const s = this.sky;
    const k = s.uniforms.uIntensity.value;
    const d = s.sunDirection;
    aerialUniforms.sunDir[0] = d.x;
    aerialUniforms.sunDir[1] = d.y;
    aerialUniforms.sunDir[2] = d.z;

    const z = s.zenithRadiance, h = s.horizonRadiance, g = s.sunHazeRadiance;
    aerialUniforms.zenith[0] = z.r * k; aerialUniforms.zenith[1] = z.g * k; aerialUniforms.zenith[2] = z.b * k;
    aerialUniforms.horizon[0] = h.r * k; aerialUniforms.horizon[1] = h.g * k; aerialUniforms.horizon[2] = h.b * k;
    aerialUniforms.sunHaze[0] = g.r * k; aerialUniforms.sunHaze[1] = g.g * k; aerialUniforms.sunHaze[2] = g.b * k;

    aerialUniforms.params[0] = this.aerialStrength;
    aerialUniforms.params[1] = this.aerialHeightScale;
    aerialUniforms.params[2] = this.aerialSunGlow * Math.max(0, d.y + 0.12);
    aerialUniforms.params[3] = 1;
    // Read-back for the harness: proves the shared uniform array this file
    // writes is the same one the materials are sampling.
    this.aerialApplied = aerialUniforms.params[0];
  }

  setEnvironmentIntensity(v) {
    this.environmentIntensity = v;
    this.scene.environmentIntensity = v;
  }

  /**
   * Weather's handle on the sky's share of the illuminance: a RATIO against the
   * calibrated baseline, which is what `weather.js`'s per-preset `envScale`
   * numbers (0.96 dry-ish .. 1.22 storm) have always meant. Use this rather
   * than `setEnvironmentIntensity`, which takes an absolute and will therefore
   * throw the sun/sky calibration away.
   */
  setEnvironmentScale(k) {
    this.setEnvironmentIntensity(this.baseEnvironmentIntensity * k);
  }

  dispose() {
    if (this.envRT) this.envRT.dispose();
    for (const m of [this.envGround, this.envBand]) {
      if (!m) continue;
      m.geometry.dispose();
      m.material.dispose();
    }
    this.pmrem.dispose();
  }
}
