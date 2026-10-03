/**
 * APEX GP — particle and volumetric FX.
 *
 * Everything a modern F1 broadcast frame needs between the car and the camera:
 * tyre smoke, the blue haze that hangs at a lockup point, titanium plank sparks,
 * brake dust, surface-coloured dirt, gravel spray, marbles, contact debris,
 * carbon shards, exhaust heat haze and speed-sensitive wind streaks.
 *
 * DESIGN
 *   One THREE.Points draw call per family. Each pool is a fixed ring buffer, so
 *   emission never allocates. The CPU integrates position/velocity/turbulence
 *   and rebuilds a *sorted, live-only* index buffer each frame — dead particles
 *   cost nothing (they are not indexed) and translucent families blend
 *   back-to-front.
 *
 *   The shader is one source with #define variants:
 *     LIT      spherical-billboard normal, sun + ambient + back-scatter, and a
 *              thickness term so the core self-shadows (this is what stops
 *              smoke reading as a flat billboard)
 *     STRETCH  screen-space velocity-aligned capsule: real motion streaks for
 *              sparks and spray, still a single POINTS draw call
 *     EMBER    black-body cooling ramp along the particle's life
 *     REFRACT  samples a copy of the framebuffer through a swirl normal —
 *              exhaust heat haze and hot-tarmac shimmer
 *     SOFT     soft-particle depth fade against the scene depth buffer
 *     ADDITIVE fog attenuates alpha instead of tinting colour
 *
 * SOFT PARTICLES
 *   `GTAOPass` already renders a full-resolution normal+depth G-buffer every
 *   frame and explicitly hides `isPoints` objects while doing it, so its
 *   `depthTexture` is exactly the opaque-only depth we need — free. It lags the
 *   colour pass by one frame, which at 60 fps is invisible on smoke. If AO is
 *   off (`?ao=0`) the fade degrades gracefully to hard billboards.
 *
 * PUBLIC API
 *   const fx = new Particles(scene, { maxSmoke, maxDust, maxSpark, ... });
 *   fx.attachRenderer(renderer, camera, postfx)   // enables soft particles + refraction
 *   fx.emitSmoke(pos, vel, n, opts) / emitDust / emitSparks / emitSpray / emitDebris
 *   fx.emitLockupHaze(pos, n) / emitMarbles / emitCarbonShards / emitContact
 *   fx.emitHeatHaze(pos, vel, n, opts)
 *   fx.driveFromCar(car, dt, wetness)
 *   fx.update(dt) / fx.setViewport(h, fov) / fx.setWetness(w) / fx.reset() / fx.dispose()
 *
 * NOTE: `size` is a WORLD-SPACE RADIUS IN METRES everywhere in this module.
 */

import * as THREE from 'three';
import { makeRng, hashSeed, fbm, clamp } from '../core/rng.js';

// ---------------------------------------------------------------------------
// Local sprite bakes
// ---------------------------------------------------------------------------
// These are FX-only and never shared, so they live here rather than in the
// shared texture library. All are seeded from rng.js — no Math.random.

function dataTexture(px, w, h, colorSpace = THREE.SRGBColorSpace) {
  const t = new THREE.DataTexture(px, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = colorSpace;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

const B = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));

/**
 * 2x2 atlas of four distinct smoke puffs. Alpha is the density; RED carries a
 * smoothed thickness the shader uses for self-shadowing, so the core of a puff
 * goes darker than its rim and the sprite reads as a volume.
 */
function smokePuffAtlas(cell = 256) {
  const size = cell * 2;
  const px = new Uint8Array(size * size * 4);
  const rng = makeRng(hashSeed('fx/smokePuff'));
  // Each cell gets a handful of offset lobes so the four puffs differ in
  // silhouette, not just in noise phase.
  const cells = [];
  for (let c = 0; c < 4; c++) {
    const lobes = [];
    const n = 4 + ((rng() * 3) | 0);
    for (let i = 0; i < n; i++) {
      lobes.push({
        x: (rng() - 0.5) * 0.42,
        y: (rng() - 0.5) * 0.42,
        r: 0.30 + rng() * 0.26,
        w: 0.55 + rng() * 0.45,
      });
    }
    cells.push({ lobes, seed: 100 + c * 37 });
  }

  for (let cy = 0; cy < 2; cy++) {
    for (let cx = 0; cx < 2; cx++) {
      const c = cells[cy * 2 + cx];
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          const u = (x + 0.5) / cell - 0.5;
          const v = (y + 0.5) / cell - 0.5;
          let d = 0;
          for (const l of c.lobes) {
            const dr = Math.hypot(u - l.x, v - l.y) / l.r;
            d += Math.max(0, 1 - dr * dr) * l.w;
          }
          d = Math.min(1, d * 0.85);
          // Three noise scales: billow, erosion, and fine grain so the sprite
          // still holds detail when it fills a third of the screen.
          const n1 = fbm(x / cell, y / cell, { freq: 4, octaves: 4, seed: c.seed });
          const n2 = fbm(x / cell + 0.31, y / cell + 0.17, { freq: 11, octaves: 4, seed: c.seed + 11 });
          const n3 = fbm(x / cell + 0.62, y / cell + 0.44, { freq: 27, octaves: 3, seed: c.seed + 23 });
          let a = d * (0.35 + 1.05 * n1) * (0.60 + 0.75 * n2) * (0.78 + 0.42 * n3);
          // Hard vignette to zero at the cell border: no square seams.
          const edge = Math.max(Math.abs(u), Math.abs(v)) * 2;
          a *= Math.max(0, 1 - Math.pow(edge, 4));
          // SOFT KNEE, NOT A CLAMP. `min(1, a * 1.5)` clipped: the product of the
          // three noise octaves sits around 0.85 through the whole body of a puff,
          // so x1.5 saturated everything but the rim to alpha 1 and the sprite
          // came out as a FLAT-TOPPED DISC with a soft edge — which is exactly
          // what the review logged as "flat grey out-of-focus discs on the road".
          // An exponential knee never reaches 1, so the billow gradient survives
          // all the way into the core and a puff reads as gas at any magnification.
          a = 1 - Math.exp(-a * 1.75);
          // Thickness drives the self-shadow: contrasty, and billowed by the
          // low-frequency octave so the lit rim follows the puff's lobes.
          const thick = Math.min(1, Math.pow(d, 0.75) * (0.55 + 0.75 * n1) * 1.25);
          const i = ((cy * cell + y) * size + (cx * cell + x)) * 4;
          px[i] = B(thick);
          px[i + 1] = B(0.5 + n1 * 0.5);
          px[i + 2] = B(n2);
          px[i + 3] = B(a);
        }
      }
    }
  }
  return dataTexture(px, size, size, THREE.NoColorSpace);
}

/** 2x2 atlas of small solid chips: marble, angular stone, grass blade, carbon shard. */
function debrisAtlas(cell = 64) {
  const size = cell * 2;
  const px = new Uint8Array(size * size * 4);
  const shape = (k, u, v) => {
    const r = Math.hypot(u, v);
    if (k === 0) return r < 0.42 ? 1 : 0;                                   // marble
    if (k === 1) {                                                          // angular stone
      const a = Math.atan2(v, u);
      const rr = 0.30 + 0.10 * Math.cos(a * 5 + 0.7) + 0.05 * Math.cos(a * 3);
      return r < rr ? 1 : 0;
    }
    if (k === 2) return (Math.abs(u) < 0.055 - Math.abs(v) * 0.08 && Math.abs(v) < 0.44) ? 1 : 0;  // blade
    return (Math.abs(u * 0.9 + v * 0.35) < 0.30 - Math.abs(v) * 0.5 && Math.abs(v) < 0.40) ? 1 : 0; // shard
  };
  for (let cy = 0; cy < 2; cy++) {
    for (let cx = 0; cx < 2; cx++) {
      const k = cy * 2 + cx;
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          const u = (x + 0.5) / cell - 0.5;
          const v = (y + 0.5) / cell - 0.5;
          // 3x3 box AA on the hard shape mask.
          let a = 0;
          for (let sy = -1; sy <= 1; sy++) {
            for (let sx = -1; sx <= 1; sx++) a += shape(k, u + sx / (cell * 2.2), v + sy / (cell * 2.2));
          }
          a /= 9;
          // Cheap shading so a chip is not a flat silhouette.
          const lit = 0.55 + 0.45 * clamp(0.5 - v * 1.6, 0, 1);
          const i = ((cy * cell + y) * size + (cx * cell + x)) * 4;
          px[i] = B(lit); px[i + 1] = B(lit); px[i + 2] = B(lit); px[i + 3] = B(a);
        }
      }
    }
  }
  return dataTexture(px, size, size, THREE.NoColorSpace);
}

/** Swirl normal + radial mask for the refraction pool. RG = xy gradient, A = mask. */
function swirlNormal(size = 128) {
  const px = new Uint8Array(size * size * 4);
  const h = (x, y) => fbm(x / size, y / size, { freq: 4, octaves: 4, seed: 77 });
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size - 0.5, v = (y + 0.5) / size - 0.5;
      const gx = h(x + 1, y) - h(x - 1, y);
      const gy = h(x, y + 1) - h(x, y - 1);
      const r = Math.hypot(u, v) * 2;
      const mask = Math.pow(clamp(1 - r, 0, 1), 1.5);
      const i = (y * size + x) * 4;
      px[i] = B(0.5 + gx * 3.5);
      px[i + 1] = B(0.5 + gy * 3.5);
      px[i + 2] = 128;
      px[i + 3] = B(mask);
    }
  }
  return dataTexture(px, size, size, THREE.NoColorSpace);
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const VERT = /* glsl */ `
attribute float aSize;
attribute float aLife;      // 0 = born, 1 = dead
attribute vec3  aColour;
attribute float aSeed;
attribute vec3  aVel;
attribute float aAlpha;

uniform float uPixelScale;   // drawingBufferHeight / (2 tan(fov/2))
uniform float uStretch;      // seconds of velocity the streak spans (0 = round)
uniform vec2  uHalfRes;
uniform vec3  uCamVel;       // world m/s of the camera itself
uniform float uCamRel;       // 1 = streak along APPARENT motion, 0 = world motion
uniform float uMaxStreak;    // pixel cap on the streak (also caps sprite fill)
uniform float uMaxPx;        // 0 = unbounded; else fade the sprite out as it fills
                             // the frame, so nothing can sit ON the lens

varying float vLife;
varying vec3  vColour;
varying float vSeed;
varying float vViewZ;
varying float vRadius;
varying float vSizePx;
varying float vLenPx;
varying vec2  vDir;
varying float vAlpha;
varying float vBig;

void main() {
  vLife = aLife;
  vColour = aColour;
  vSeed = aSeed;
  vAlpha = aAlpha;
  vRadius = aSize;

  if ( aLife >= 1.0 ) {                 // parked: never rasterise
    gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 );
    gl_PointSize = 0.0;
    return;
  }

  float lenPx = 0.0;
  vec2 dir = vec2( 0.0, 1.0 );

#ifdef STRETCH
  // Streak along APPARENT motion, not world motion. A shutter smear is the path
  // the particle traced across the SENSOR, so the velocity that matters is
  // relative to the camera. Plank sparks leave the car at ~0.6x its speed, which
  // is forward in the world: streaked along that, a chase camera sees them
  // foreshortened to dots pointing away. Streaked along (particle - camera) they
  // trail behind the car exactly as they do in a broadcast shot, and a STATIC
  // trackside camera (uCamVel = 0) is unaffected.
  vec3 sVel = aVel - uCamVel * uCamRel;
  vec4 mvH = modelViewMatrix * vec4( position, 1.0 );
  vec4 mvT = modelViewMatrix * vec4( position - sVel * uStretch, 1.0 );
  vec4 cH = projectionMatrix * mvH;
  vec4 cT = projectionMatrix * mvT;
  vec2 d = ( cH.xy / max( cH.w, 1e-4 ) - cT.xy / max( cT.w, 1e-4 ) ) * uHalfRes;
  lenPx = min( length( d ), uMaxStreak );
  if ( lenPx > 0.75 ) dir = d / lenPx; else lenPx = 0.0;
#endif

  // The sprite stays centred on the particle's TRUE position and the capsule is
  // ONE-SIDED inside it (see FRAG). Centring the sprite on the middle of the
  // streak instead — position - sVel * stretch * 0.5, which is what this did —
  // pushes a ground-skimming spark BELOW the tarmac as soon as the apparent
  // velocity points downward, and the depth test then eats the whole streak.
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;

  float px = aSize * uPixelScale / max( -mv.z, 0.35 );
  // SCREEN-SIZE CEILING. A world-space sprite the camera drives INTO grows
  // without bound: the tarmac shimmer is spawned 30-120 m down the road, lives
  // ~3 s, and a chase camera at 93 m/s covers 280 m in that time — so it runs
  // straight through the layer and the measured peak sprite was 1347 px across,
  // a full-screen disc of displaced framebuffer sitting on the lens. That is the
  // "pale circular blob / dirt on the sensor" the review logged. Fading a sprite
  // out as it approaches the near plane is the standard billboard fix and it is
  // free: the sprites it kills are the ones that were about to cost the most
  // fill. Anything used at a sane scale (an exhaust plume is ~60 px) never sees it.
  //
  // THE CEILING IS ON THE CHIP, NOT ON THE STREAK. It is measured BEFORE the
  // streak is added, because a streaked sprite is deliberately long: a spark
  // whose 30 px tail pushed the point size past the cap would be culled for
  // being fast rather than for being close. What must never happen is the ROUND
  // part filling the lens — and for the spark pool that is the whole defect the
  // review measured. A chase camera closes on its own shower at ~35 m/s, so
  // every skid chip eventually passes within a metre of the lens, and the
  // measured peak chip radius on 'hud' was 119 px: a smooth orange lozenge the
  // size of a fist, one per frame, which is exactly what "ten fat isolated
  // lozenges" is. It is also physically wrong twice over — that chip is far
  // inside the focal plane and would be an invisible smear, not a hard pill.
  vBig = 1.0;
  if ( uMaxPx > 0.0 ) {
    vBig = clamp( ( uMaxPx * 1.75 - px ) / ( uMaxPx * 0.75 ), 0.0, 1.0 );
    px = min( px, uMaxPx * 1.75 );
  }
#ifdef STRETCH
  px += lenPx * 2.0;
#endif
  vSizePx = clamp( px, 1.0, 1024.0 );
  vLenPx = lenPx;
  vDir = dir;
  gl_PointSize = vSizePx;
}
`;

const FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec2  uAtlas;        // (cols, rows)
uniform float uFadeIn;
uniform float uFadeOut;
uniform float uOpacity;
uniform float uSpin;

uniform vec3  uSunDir;       // VIEW space, fragment -> sun
uniform vec3  uSunColour;
uniform vec3  uAmbColour;
uniform vec3  uGroundColour;

uniform sampler2D uDepth;
uniform vec2  uRes;
uniform float uNear;
uniform float uFar;
uniform float uSoft;
uniform float uSoftOn;

uniform vec3  uFogColour;
uniform float uFogDensity;

uniform sampler2D uScene;
uniform float uRefract;
uniform float uTime;

varying float vLife;
varying vec3  vColour;
varying float vSeed;
varying float vViewZ;
varying float vRadius;
varying float vSizePx;
varying float vLenPx;
varying vec2  vDir;
varying float vAlpha;
varying float vBig;

float viewDepth( float d ) {
  // perspectiveDepthToViewZ, returned positive (metres in front of the eye).
  return ( uNear * uFar ) / ( uFar - ( uFar - uNear ) * d );
}

void main() {
  if ( vLife >= 1.0 ) discard;

  vec2 pc = gl_PointCoord;
  pc.y = 1.0 - pc.y;                 // POINTS coords are top-left origin
  vec2 q = pc - 0.5;

  float alpha;
  vec3  albedo = vec3( 1.0 );
  float thick = 0.0;
  float nz = 0.0;
  // How much of THIS fragment is the incandescent filament rather than its
  // halo. EMBER reads it to keep the hue split (white core / orange falloff);
  // every other variant leaves it at zero.
  float hotMask = 0.0;

#ifdef STRETCH
  vec2 p = q * vSizePx;
  float along  = dot( p, vDir );
  float across = dot( p, vec2( -vDir.y, vDir.x ) );
  // ONE-SIDED capsule: the head sits at the sprite centre (= the particle's real
  // world position) and the tail runs back along -vDir, which is where the
  // particle actually WAS during the shutter. vDir points tail -> head.
  float L = vLenPx;
  float t = clamp( along, -L, 0.0 );
  float dist = length( vec2( along - t, across ) );
  float R = max( 0.75, ( vSizePx - 2.0 * vLenPx ) * 0.5 );
  float core = clamp( 1.0 - dist / R, 0.0, 1.0 );
  // Head bright, tail thin: a real streak, not a smear.
  float head = clamp( 1.0 + along / max( L, 1.0 ), 0.0, 1.0 );
  // OPTICAL HALO. A 2-3 px core is a firefly, and the bloom prefilter's Karis
  // average is specifically built to throw fireflies away — so a spark whose
  // radiance is 20x diffuse white still came out as a hard-edged orange dash
  // with nothing around it. The halo is not a cheat: a real spark photographed
  // through a broadcast lens is a bright point wrapped in a glow, and giving it
  // AREA is what lets the bloom chain see it at all. Exponential, so it has no
  // edge of its own, and it is gated on the head term so only the hot end glows.
  // THE HALO RADIUS IS A LENS PROPERTY, NOT A PARTICLE PROPERTY. This used to
  // scale with R, so a chip that happened to be close to the camera drew a halo
  // proportional to its own projected size — a 5 px chip carried a 25 px wash,
  // and half a dozen of those merged into the fat smooth bands the review
  // measured. A real point source glows through the same optics whatever it is,
  // so the halo is clamped to a few pixels and only the CORE is allowed to grow.
  float glow = exp( -dist / clamp( R * 1.4, 1.15, 3.2 ) );
  alpha = pow( core, 1.6 ) * mix( 0.05, 1.0, head * head )
        + glow * 0.20 * mix( 0.02, 1.0, head * head );
  // COLOUR IS A FUNCTION OF RADIUS, NOT JUST OF AGE. This used to ADD orange at
  // the centre — vec3(0.9,0.45,0.12) * pow(core,8) — on top of an already orange
  // EMBER body, so the hottest part of every chip was also the most saturated
  // and the whole lozenge sat in one flat orange band. A real spark is a
  // white-hot filament wrapped in an orange halo, and only the filament clears
  // the bloom threshold, which is what makes the shower read as points of light
  // rather than as fat smooth pills. 'hotMask' is that filament; EMBER turns it
  // into the hue split. Non-ember streaks (the wind pool) get a NEUTRAL core
  // lift instead, because a warm core on a wind streak was never intended.
  hotMask = pow( core, 3.5 ) * head;
  albedo = vec3( 1.0 ) + vec3( 0.35 ) * pow( core, 8.0 ) * head;
  nz = sqrt( max( 0.0, 1.0 - min( 1.0, core ) ) );
#else
  float ang = vSeed * 6.2831853 + uSpin * vLife * ( vSeed - 0.5 ) * 5.0;
  float ca = cos( ang ), sa = sin( ang );
  vec2 r = vec2( ca * q.x - sa * q.y, sa * q.x + ca * q.y ) + 0.5;
  if ( r.x < 0.0 || r.x > 1.0 || r.y < 0.0 || r.y > 1.0 ) discard;
  float cellIdx = floor( vSeed * uAtlas.x * uAtlas.y * 0.999 );
  vec2 cell = vec2( mod( cellIdx, uAtlas.x ), floor( cellIdx / uAtlas.x ) );
  vec2 uv = ( cell + r ) / uAtlas;
  vec4 tex = texture2D( uMap, uv );
  alpha = tex.a;
  albedo = vec3( 1.0 );
  thick = tex.r;
  float rr = min( 1.0, dot( q * 2.0, q * 2.0 ) );
  nz = sqrt( 1.0 - rr );
  #ifdef CHIP
    // A chip is a solid object: keep the baked shading, alpha only anti-aliases
    // the silhouette, and it must not self-shadow like a gas.
    albedo = vec3( 0.55 + tex.r * 0.70 );
    alpha = smoothstep( 0.30, 0.62, alpha );
    thick = 0.10;
  #endif
#endif

  if ( alpha <= 0.0 ) discard;

  float fade = smoothstep( 0.0, uFadeIn, vLife ) * ( 1.0 - smoothstep( uFadeOut, 1.0, vLife ) ) * vBig;

  // --- soft particles ------------------------------------------------------
#ifdef SOFT
  if ( uSoftOn > 0.5 ) {
    float sceneD = texture2D( uDepth, gl_FragCoord.xy / uRes ).x;
    float sceneZ = viewDepth( sceneD );
    // Treat the billboard as a sphere: its surface bulges toward the camera,
    // which makes the fade follow the puff's silhouette instead of a flat plane.
    float myZ = vViewZ - nz * vRadius;
    float soft = clamp( ( sceneZ - myZ ) / uSoft, 0.0, 1.0 );
    fade *= soft * soft * ( 3.0 - 2.0 * soft );
  }
#endif

  // --- lighting ------------------------------------------------------------
#ifdef LIT
  vec3 n = vec3( q * 2.0, nz );
  float ndl = dot( n, uSunDir );
  float wrap = max( 0.0, ndl * 0.6 + 0.4 );
  float trans = pow( max( 0.0, -ndl * 0.7 + 0.3 ), 3.0 );   // sun through the puff
  float shadow = mix( 1.0, 0.30, thick );                   // dense core self-shadows
  vec3 lit = uAmbColour * ( 0.62 + 0.38 * nz )
           + uGroundColour * ( 0.30 - 0.22 * nz )
           + uSunColour * wrap * shadow
           + uSunColour * trans * 0.85 * ( 1.0 - thick * 0.55 );
  albedo *= lit;
#endif

#ifdef EMBER
  // Titanium burns white-hot then cools through orange to a deep red. The
  // exponent is > 0.5 so the chip HOLDS its white-hot phase for the first ~15%
  // of its life instead of dropping into orange within two frames: the head of
  // a fresh spark has to sit clear of the bloom threshold (1.25 exposed) after
  // the motion-blur pass has smeared it, or nothing glows.
  // EVERY CHIP COOLS AT ITS OWN RATE. One shared curve means the whole shower
  // is the same colour at the same distance from the plank, which is a large
  // part of why it read as stamped copies of one sprite: the tint became a pure
  // function of screen position. A chip's cooling rate goes as its surface-to-
  // mass ratio, so the fine ones — most of them — go dull first while the odd
  // fat one is still white two metres downstream. 'vSeed' is already per
  // particle and free.
  float k = pow( vLife, 0.90 * ( 0.72 + vSeed * 0.62 ) );
  // TITANIUM, NOT MAGNESIUM. The first calibration put the birth colour at
  // (14, 8.4, 3.2) — a 4:1 red:blue ratio that is essentially white-hot — and a
  // dragging skid stacks 100 of them additively, so the shower resolved into
  // two saturated white ribbons that read as afterburners. The birth colour is
  // now 7:1 and 5.4x the bloom threshold: still comfortably above it (so the
  // halo survives the Karis prefilter) but it stays ORANGE where the streaks
  // pile up, which is the actual colour of titanium on tarmac.
  vec3 hot  = vec3( 9.0, 4.6, 1.3 );
  vec3 mid  = vec3( 4.4, 1.35, 0.20 );
  vec3 cool = vec3( 1.5, 0.22, 0.03 );
  vec3 body = k < 0.45 ? mix( hot, mid, k / 0.45 ) : mix( mid, cool, ( k - 0.45 ) / 0.55 );
  // WHITE-HOT CORE, ORANGE FALLOFF. Titanium leaves the plank at ~3000 K: the
  // filament itself is very nearly white and the orange everyone remembers is
  // the cooler shell around it plus the lens glow. Desaturating the body toward
  // its own luminance keeps the ENERGY identical (no second exposure path, no
  // hue shift in the halo) while pushing the centre line of each streak clear of
  // the bloom threshold on all three channels, so the bloom chain traces a fine
  // bright filament instead of smearing an orange lozenge. The white phase is
  // spent in the first third of the chip's life, exactly as the real thing is.
  float chill = 1.0 - smoothstep( 0.06, 0.42, vLife );
  float lum = dot( body, vec3( 0.2126, 0.7152, 0.0722 ) );
  vec3 whiteHot = mix( body, vec3( lum ), 0.86 ) * 2.5;
  albedo *= mix( body, whiteHot, hotMask * chill );
#endif

#ifdef REFRACT
  // Heat shimmer: offset the framebuffer copy through a scrolling swirl normal.
  // The offset is screen-space (constant with distance) because the shimmer of a
  // hot air column does not shrink the way a world-space displacement would.
  vec2 sub = texture2D( uMap, fract( uv * 1.6 + vec2( uTime * 0.11 + vSeed, uTime * 0.27 ) ) ).rg - 0.5;
  float amp = alpha * vAlpha * ( 1.0 - abs( vLife * 2.0 - 1.0 ) );
  vec2 suv = clamp( gl_FragCoord.xy / uRes + sub * uRefract * amp, 0.002, 0.998 );
  vec3 bg = texture2D( uScene, suv ).rgb;
  // vAlpha IS THE COMPOSITE WEIGHT, not just the offset amplitude. This used to
  // composite the displaced framebuffer at the swirl mask's own alpha — up to
  // 1.0 at the sprite centre — so a heat sprite REPLACED the background with a
  // copy of itself shifted by up to uRefract (0.013 of the screen = 21 px at
  // 1600 wide). A 0.22-alpha tarmac shimmer therefore drew as a hard, fully
  // opaque smeared disc instead of as a faint wobble, which is the other half of
  // the "lens smudge" defect. Blending it at the particle's real density is both
  // correct (a thin hot pocket bends only a fraction of the light) and subtle.
  gl_FragColor = vec4( bg * vColour, alpha * fade * uOpacity * vAlpha );
  return;
#endif

  // --- fog -----------------------------------------------------------------
  float fogF = 1.0 - exp( -vViewZ * vViewZ * uFogDensity * uFogDensity );
#ifdef ADDITIVE
  fade *= 1.0 - fogF;
#else
  albedo = mix( albedo, uFogColour, fogF * 0.9 );
#endif

  float a = alpha * fade * uOpacity * vAlpha;
  if ( a < 0.0035 ) discard;
  gl_FragColor = vec4( albedo * vColour, a );
}
`;

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

const SORT_BUCKETS = 512;
const SORT_RANGE = 260;      // metres; anything further sorts into the far bucket

/** A fixed-size ring buffer of particles rendered as one THREE.Points. */
class Pool {
  constructor(scene, o) {
    const count = this.count = o.count;
    this.cursor = 0;
    this.live = 0;
    this.sorted = !!o.sorted;
    this.turbulence = o.turbulence ?? 0;
    this.turbScale = o.turbScale ?? 0.35;
    this.bounce = o.bounce ?? 0;
    this.wind = o.wind ?? 0;
    // Gas expands fast at birth then stalls; a constant growth rate turns every
    // puff into a featureless dome after a second.
    this.growDecay = o.growDecay ?? 0;

    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.size = new Float32Array(count);
    this.grow = new Float32Array(count);
    this.life = new Float32Array(count).fill(1);
    this.rate = new Float32Array(count);
    this.colour = new Float32Array(count * 3);
    this.seed = new Float32Array(count);
    this.alpha = new Float32Array(count);
    this.drag = new Float32Array(count);
    this.gravity = new Float32Array(count);
    this.floor = new Float32Array(count).fill(-1e5);
    this.phase = new Float32Array(count);
    /** 1 once a particle has come to rest on `floor` — see the bounce in step(). */
    this.settled = new Uint8Array(count);

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aVel', new THREE.BufferAttribute(this.vel, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aLife', new THREE.BufferAttribute(this.life, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aColour', new THREE.BufferAttribute(this.colour, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aSeed', new THREE.BufferAttribute(this.seed, 1));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.index = new Uint16Array(count);
    g.setIndex(new THREE.BufferAttribute(this.index, 1).setUsage(THREE.DynamicDrawUsage));
    g.setDrawRange(0, 0);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = g;

    const defines = {};
    for (const d of o.defines ?? []) defines[d] = '';

    this.material = new THREE.ShaderMaterial({
      defines,
      uniforms: {
        uMap: { value: o.map },
        uAtlas: { value: new THREE.Vector2(o.atlas ?? 1, o.atlas ?? 1) },
        uPixelScale: { value: 900 },
        uStretch: { value: o.stretch ?? 0 },
        uHalfRes: { value: new THREE.Vector2(800, 450) },
        uCamVel: { value: new THREE.Vector3() },
        uCamRel: { value: o.camRel ?? 0 },
        uMaxStreak: { value: o.maxStreak ?? 120 },
        uMaxPx: { value: o.maxPx ?? 0 },
        uFadeIn: { value: o.fadeIn ?? 0.10 },
        uFadeOut: { value: o.fadeOut ?? 0.45 },
        uOpacity: { value: o.opacity ?? 1 },
        uSpin: { value: o.spin ?? 0 },
        uSunDir: { value: new THREE.Vector3(0, 1, 0) },
        uSunColour: { value: new THREE.Color(1.6, 1.5, 1.35) },
        uAmbColour: { value: new THREE.Color(0.55, 0.62, 0.78) },
        uGroundColour: { value: new THREE.Color(0.18, 0.17, 0.16) },
        uDepth: { value: null },
        uRes: { value: new THREE.Vector2(1600, 900) },
        uNear: { value: 0.25 },
        uFar: { value: 6000 },
        uSoft: { value: o.soft ?? 1.2 },
        uSoftOn: { value: 0 },
        uFogColour: { value: new THREE.Color(0.62, 0.71, 0.82) },
        uFogDensity: { value: 0.00035 },
        uScene: { value: null },
        uRefract: { value: o.refract ?? 0 },
        uTime: { value: 0 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: o.depthWrite ?? false,
      depthTest: true,
      blending: o.blending,
    });

    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = o.renderOrder ?? 20;
    scene.add(this.points);

    if (this.sorted) {
      this.keys = new Uint16Array(count);
      this.counts = new Uint32Array(SORT_BUCKETS + 1);
    }
  }

  spawn(p, v, o) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.count;
    const i3 = i * 3;
    this.pos[i3] = p.x; this.pos[i3 + 1] = p.y; this.pos[i3 + 2] = p.z;
    this.vel[i3] = v.x; this.vel[i3 + 1] = v.y; this.vel[i3 + 2] = v.z;
    this.size[i] = o.size;
    this.grow[i] = o.grow ?? 0;
    this.life[i] = 0;
    this.rate[i] = 1 / Math.max(0.05, o.lifetime);
    this.colour[i3] = o.colour[0]; this.colour[i3 + 1] = o.colour[1]; this.colour[i3 + 2] = o.colour[2];
    this.seed[i] = o.seed;
    this.alpha[i] = o.alpha ?? 1;
    this.drag[i] = o.drag ?? 1.2;
    this.gravity[i] = o.gravity ?? 0;
    this.floor[i] = o.floor ?? -1e5;
    this.phase[i] = o.seed * 62.83;
    this.settled[i] = 0;
  }

  /** Integrate one step. `t` is the running FX clock (turbulence phase). */
  step(dt, t, windX, windZ) {
    const { pos, vel, life, rate, drag, gravity, size, grow, floor, phase, settled } = this;
    const turb = this.turbulence;
    const ts = this.turbScale;
    const wind = this.wind;
    const gd = this.growDecay > 0 ? Math.exp(-this.growDecay * dt) : 0;
    for (let i = 0; i < this.count; i++) {
      if (life[i] >= 1) continue;
      life[i] += rate[i] * dt;
      const i3 = i * 3;
      const d = Math.exp(-drag[i] * dt);

      if (turb > 0) {
        // Cheap divergence-light swirl: three orthogonal sine lobes sampled in
        // world space so neighbouring particles curl together, not independently.
        const px = pos[i3] * ts, py = pos[i3 + 1] * ts * 1.7, pz = pos[i3 + 2] * ts;
        const ph = phase[i];
        const a = turb * (1 - life[i] * 0.55) * dt;
        vel[i3] += (Math.sin(py + t * 1.7 + ph) + 0.6 * Math.cos(pz * 2.3 - t * 1.1)) * a;
        vel[i3 + 1] += (Math.sin(pz + t * 1.3 + ph * 0.7) + 0.6 * Math.cos(px * 2.1 + t * 0.9)) * a * 0.7;
        vel[i3 + 2] += (Math.sin(px + t * 1.5 + ph * 1.3) + 0.6 * Math.cos(py * 1.9 - t * 1.4)) * a;
      }

      vel[i3] = vel[i3] * d + wind * windX * dt;
      vel[i3 + 1] = vel[i3 + 1] * d + gravity[i] * dt;
      vel[i3 + 2] = vel[i3 + 2] * d + wind * windZ * dt;

      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;

      if (this.bounce > 0 && pos[i3 + 1] < floor[i]) {
        pos[i3 + 1] = floor[i];
        if (vel[i3 + 1] < 0) {
          vel[i3 + 1] = -vel[i3 + 1] * this.bounce;
          vel[i3] *= 0.62;
          vel[i3 + 2] *= 0.62;
          // A spark that has stopped skipping dies quickly rather than sliding —
          // but ONCE. This used to be an unguarded `rate *= 1.9` inside the
          // contact test, and a plank chip is launched from the tarmac with
          // almost no vertical component, so it contacts on frame one and then
          // on EVERY frame after: the penalty compounded as 1.9^n and the whole
          // shower was dead inside four frames. That is what cut the trail off
          // a metre behind the diffuser instead of letting it skitter away down
          // the road, which is most of what a spark shower actually is.
          if (vel[i3 + 1] < 0.5 && !settled[i]) { settled[i] = 1; rate[i] *= 1.9; }
        }
      }

      size[i] += grow[i] * dt;
      if (gd > 0) grow[i] *= gd;
      if (size[i] < 0.004) life[i] = 1;
    }
  }

  /** Rebuild the live index, back-to-front when the pool is sorted. */
  reindex(cam) {
    const { life, pos, index } = this;
    const n = this.count;
    let live = 0;

    if (!this.sorted) {
      for (let i = 0; i < n; i++) if (life[i] < 1) index[live++] = i;
    } else {
      const keys = this.keys;
      const counts = this.counts.fill(0);
      const scale = SORT_BUCKETS / SORT_RANGE;
      for (let i = 0; i < n; i++) {
        if (life[i] >= 1) continue;
        const i3 = i * 3;
        const dx = pos[i3] - cam.x, dy = pos[i3 + 1] - cam.y, dz = pos[i3 + 2] - cam.z;
        let k = Math.sqrt(dx * dx + dy * dy + dz * dz) * scale | 0;
        if (k >= SORT_BUCKETS) k = SORT_BUCKETS - 1;
        k = SORT_BUCKETS - 1 - k;             // bucket 0 = farthest, drawn first
        keys[i] = k;
        counts[k]++;
        live++;
      }
      let acc = 0;
      for (let b = 0; b < SORT_BUCKETS; b++) { const c = counts[b]; counts[b] = acc; acc += c; }
      for (let i = 0; i < n; i++) if (life[i] < 1) index[counts[keys[i]]++] = i;
    }

    this.live = live;
    this.geometry.setDrawRange(0, live);
    if (live > 0) {
      this.geometry.index.needsUpdate = true;
      this.geometry.getAttribute('position').needsUpdate = true;
      this.geometry.getAttribute('aVel').needsUpdate = true;
      this.geometry.getAttribute('aSize').needsUpdate = true;
      this.geometry.getAttribute('aLife').needsUpdate = true;
      this.geometry.getAttribute('aColour').needsUpdate = true;
      this.geometry.getAttribute('aSeed').needsUpdate = true;
      this.geometry.getAttribute('aAlpha').needsUpdate = true;
    }
    this.points.visible = live > 0;
  }

  clear() {
    this.life.fill(1);
    this.live = 0;
    this.geometry.setDrawRange(0, 0);
    this.points.visible = false;
  }

  dispose() {
    this.points.parent?.remove(this.points);
    this.geometry.dispose();
    this.material.dispose();
  }
}

// ---------------------------------------------------------------------------
// Spark bounce light
// ---------------------------------------------------------------------------

/**
 * SPARK BOUNCE LIGHT — the road under a shower is lit BY the shower.
 *
 * Additive particles add their own radiance to the frame but never to the
 * surface they are skittering across, so a plank shower rendered with sprites
 * alone floats above a tarmac that stays exactly as dark as it was. Every
 * reference frame shows the opposite: a warm pool of light dragging along the
 * road under the car, and it is a large part of why the effect reads as fire.
 *
 * This is a flat additive patch, not a light: no shadow pass, no second
 * exposure path, no change to the material stack. Three slots, one draw call
 * each, handed out per frame to the three strongest showers on screen — a
 * shower that is not among them is by definition not the one being looked at.
 *
 * The quad is coplanar-ish with a road that banks and crests under it, so it
 * carries the same NEGATIVE polygonOffset the track's own decals use and rides
 * 30 mm proud; `transparent` keeps it out of the G-buffer (postfx skips
 * transparent meshes), so it cannot contaminate AO, DOF or motion-blur depth.
 */
const GLOW_LEN = 4.4;      // metres of road behind the diffuser
const GLOW_WIDE = 2.6;     // metres across at its widest

const GLOW_VERT = /* glsl */ `
varying vec2 vUv;
varying float vZ;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4( position, 1.0 );
  vZ = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const GLOW_FRAG = /* glsl */ `
uniform vec3  uColour;
uniform float uIntensity;
uniform float uFogDensity;
varying vec2 vUv;
varying float vZ;
void main() {
  // v = 0 at the diffuser, 1 at the far end of the trail. The pool FANS OUT
  // behind the car because the chips do, and it is brightest where they are
  // still white-hot rather than at the centroid of the patch.
  //
  // WHERE THE PEAK SITS IS THE WHOLE FIXTURE. The first calibration put
  // 'along' at pow(1-v,1.7) * smoothstep(0,0.05,v) against halfW = 0.16 at the
  // near end: peak at v = 0.05, which is 0.26 m behind the diffuser and 0.33 m
  // wide — i.e. the entire bright part of the bounce light lived UNDER the
  // floor, occluded by the car in every camera that can see the shower. That is
  // why the review logged "they cast no light on the tarmac" against a build
  // that already had this patch. The chips are hottest for their first ~0.1 s
  // and at 35 m/s of closing speed that is 1-2 m of road, so the peak belongs
  // there: at v = 0.20 the pool is clear of the bodywork and roughly as wide as
  // the two skid rows are apart.
  float v = vUv.y;
  float halfW = mix( 0.30, 1.0, pow( v, 0.55 ) );
  float across = clamp( 1.0 - abs( vUv.x * 2.0 - 1.0 ) / halfW, 0.0, 1.0 );
  float along = pow( 1.0 - v, 1.5 ) * smoothstep( 0.0, 0.17, v );
  float a = across * across * along;
  a *= exp( -vZ * vZ * uFogDensity * uFogDensity );
  if ( a < 0.002 ) discard;
  // GAIN. 'uIntensity' is a strike weight that runs to ~1.05, and the tarmac it
  // lands on sits at 0.03-0.06 linear, so the raw product would put a 0.5-
  // radiance orange disc on the road — a bloom-clipping blob, not bounce light.
  // 0.42 puts the peak at ~0.21 red over a 0.05 road: a clear warm pool that
  // stays under the 1.25 bloom threshold on every channel, so it lights the
  // asphalt without becoming a light source in its own right.
  gl_FragColor = vec4( uColour * ( a * uIntensity * 0.42 ), 1.0 );
}
`;

class SparkGlow {
  constructor(scene, slots = 3) {
    this.scene = scene;
    // Local XZ plane: x across the car, y (uv.y) running BACKWARDS along it.
    const g = new THREE.PlaneGeometry(GLOW_WIDE, GLOW_LEN, 1, 1);
    g.rotateX(-Math.PI / 2);
    // After the rotation the plane's +v edge points at -Z locally; the mesh is
    // yawed to the car, whose forward is -Z, so +v is FORWARD. Flip it so the
    // patch trails the car instead of leading it.
    g.rotateY(Math.PI);
    this.geometry = g;

    this.slots = [];
    for (let i = 0; i < slots; i++) {
      const m = new THREE.ShaderMaterial({
        vertexShader: GLOW_VERT,
        fragmentShader: GLOW_FRAG,
        uniforms: {
          uColour: { value: new THREE.Color(1.0, 0.40, 0.11) },
          uIntensity: { value: 0 },
          uFogDensity: { value: 0 },
        },
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        depthTest: true,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(g, m);
      mesh.frustumCulled = false;
      mesh.visible = false;
      mesh.renderOrder = 19;
      mesh.userData.excludeFromGBuffer = true;
      mesh.matrixAutoUpdate = false;
      scene.add(mesh);
      this.slots.push(mesh);
    }

    // Fixed-size candidate list — emission must never allocate.
    this._cand = [];
    for (let i = 0; i < 12; i++) this._cand.push({ x: 0, y: 0, z: 0, yaw: 0, w: 0, key: 0 });
    this._n = 0;
  }

  /** Queue one shower. `w` is its strength; the strongest few get drawn. */
  request(pos, yaw, w, camera) {
    if (this._n >= this._cand.length) return;
    const c = this._cand[this._n++];
    // The patch is centred half its length behind the anchor, so the anchor
    // sits at the shower's origin rather than at the middle of its trail.
    const back = GLOW_LEN * 0.5;
    c.x = pos.x + Math.sin(yaw) * back;
    c.y = pos.y;
    c.z = pos.z + Math.cos(yaw) * back;
    c.yaw = yaw;
    c.w = w;
    // Rank by screen presence, not raw strength: a bright shower 150 m away is
    // three pixels. 12 m is roughly the chase camera's own standoff.
    let d = 12;
    if (camera) d = Math.max(6, camera.position.distanceTo(pos));
    c.key = w * (12 / d);
  }

  /** Assign the queued showers to slots. Call once per frame, after emission. */
  commit(fogDensity) {
    const n = this._n;
    const cand = this._cand;
    // Partial selection sort — n is at most 12.
    for (let s = 0; s < this.slots.length; s++) {
      const mesh = this.slots[s];
      if (s >= n) { mesh.visible = false; continue; }
      let best = s;
      for (let i = s + 1; i < n; i++) if (cand[i].key > cand[best].key) best = i;
      if (best !== s) { const t = cand[s]; cand[s] = cand[best]; cand[best] = t; }
      const c = cand[s];
      mesh.position.set(c.x, c.y, c.z);
      mesh.rotation.set(0, c.yaw, 0);
      mesh.updateMatrix();
      mesh.material.uniforms.uIntensity.value = c.w;
      mesh.material.uniforms.uFogDensity.value = fogDensity;
      mesh.visible = true;
    }
    this._n = 0;
  }

  hide() {
    for (const m of this.slots) m.visible = false;
    this._n = 0;
  }

  dispose() {
    for (const m of this.slots) {
      m.parent?.remove(m);
      m.material.dispose();
    }
    this.geometry.dispose();
    this.slots.length = 0;
  }
}

// ---------------------------------------------------------------------------
// Particles
// ---------------------------------------------------------------------------

const _p = new THREE.Vector3();
const _v = new THREE.Vector3();
const _q = new THREE.Vector3();
// ALIASING. Callers legitimately pass `_p` / `_v` straight into an emitter (that
// is the whole point of module-level scratch — no per-frame allocation), so an
// emitter must never write its per-particle jitter into the vectors it is still
// reading its ORIGIN from. It used to: `_p.set( j(pos.x), pos.y + rng*0.03, ...)`
// with `pos === _p` reads the PREVIOUS particle's jittered value, so x/z random-
// walk and y — which has no zero-mean term — climbs monotonically by up to
// 0.03 m PER PARTICLE. At 50 sparks in one frame that lifted the tail of the
// burst almost a metre off the ground: the "detached cluster floating in mid-air"
// in the chase shot. Every family was affected (smoke +0.14/particle, lockup
// haze +0.5, debris +0.14). These two are the emitters' own write targets.
const _sp = new THREE.Vector3();
const _sv = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _rgt = new THREE.Vector3();
const _cam = new THREE.Vector3();
const _sun = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _res = new THREE.Vector2();
const _amb = new THREE.Color();

/** Dust/dirt albedo per surface. Multiplied by scene lighting in the shader. */
const SURFACE_DUST = {
  track: [0.30, 0.295, 0.285],
  kerb: [0.36, 0.34, 0.33],
  runoff: [0.44, 0.42, 0.39],
  gravel: [0.62, 0.48, 0.32],
  grass: [0.33, 0.36, 0.19],
};
/**
 * SKID-BLOCK STATIONS — where an F1 car actually throws sparks.
 *
 * The titanium skids are two strips inset into the 1.0 m wide plank, ~0.30 m
 * either side of the floor centreline, one pair at the front end of the plank
 * and one pair at the rear. FOUR contact points, not one: emitting on the
 * centreline behind the origin put a vertical orange fountain out of the middle
 * of the diffuser in every chase frame, which is the one thing a real spark
 * shower never looks like.
 *
 * `wr` / `tr` are the bilinear weights that read a skid's own suspension travel
 * out of the four corner travels (`[FL,FR,RL,RR]`, compression positive) —
 * longitudinally from the axle lines at z -1.62 / +1.98, laterally from the
 * contact patches at x -0.80 / +0.80. Going through the plane instead of a
 * front/rear average is what makes ROLL dig the outside skid into the road and
 * lift the inside one, so a car leaning on a kerb sparks from the kerb side.
 *
 * `bite` is the travel at which that skid reaches the tarmac. The car runs rake
 * (28 mm front / 78 mm rear static ride height), so the front of the plank
 * grounds ~5 mm of travel before the rear does — which is why the front skids
 * do most of the work and the rear pair only lights up on the big compressions.
 *
 * The two bite values are CALIBRATED, not guessed — and the calibration is only
 * valid against the suspension rates and aero map of the build it was taken on.
 * RE-MEASURED against the current build with `tools/_fxlat.mjs` (150 frames per
 * staged shot, per-skid bilinear travel in mm):
 *
 *   shot    speed        front skid p10/p50/p90/max   rear skid p10/p50/p90/max
 *   hud     93-106 m/s   17.1 / 18.9 / 21.7 / 26.8    22.3 / 23.1 / 24.8 / 30.4
 *   chase   50-55  m/s    2.8 /  5.4 /  7.8 / 13.5     4.1 /  8.6 / 11.2 / 18.9
 *   tv      48-51  m/s    2.6 /  5.3 /  7.4 / 11.0     4.8 /  9.1 / 11.9 / 18.0
 *
 * The previous pair (19.4 / 24.4 mm) was calibrated against an older chassis and
 * is now ABOVE the travel the car actually runs: the rear skids sat 1.3 mm clear
 * of the road at peak aero squat on the DRS straight and never fired at all,
 * and the front pair straddled its own threshold at p50, so the hero car threw
 * 0 sparks at `chase`/`tv` and a sub-visible trickle at `hud` — measured 7.2
 * chips/frame spread over 25 m of road, of which the capture caught none. The
 * previous author wrote "sparks that never appear are not a fixed defect, they
 * are a deleted feature" one paragraph above the numbers that deleted them.
 *
 * The pair below puts the DRS straight 1-4 mm INSIDE both bites (a saturated
 * front drag, a modulated rear one) while mid-corner at chase/tv stays 3-4 mm
 * CLEAR even at its 99th-percentile compression. That ordering is the real
 * behaviour and it is the opposite way round from the intuition that a corner
 * loads the floor: peak aero squat happens at peak SPEED, so an F1 car sparks
 * down the straights, over crests, under braking and on kerbs, and goes dark
 * through a 190 km/h corner where it is leaning on the tyres, not the floor.
 *
 * Margins are stated as a rule, not a coincidence, so the next person can check
 * them in one command: bite must sit 1-2 mm under the straight-line p50 and at
 * least 3 mm over the mid-corner p99.
 */
const SKID = [
  { z: -0.95, x: -0.30, wr: 0.186, tr: 0.3125, bite: 0.0176 },
  { z: -0.95, x: 0.30, wr: 0.186, tr: 0.6875, bite: 0.0176 },
  { z: 1.55, x: -0.30, wr: 0.881, tr: 0.3125, bite: 0.0222 },
  { z: 1.55, x: 0.30, wr: 0.881, tr: 0.6875, bite: 0.0222 },
];
/**
 * ROAD MICRO-PROFILE. The suspension model runs on a perfectly smooth road, so
 * a skid held just inside its bite point would drag at a mathematically constant
 * depth and the shower would come out as a steady torch — the exact defect the
 * review logged. A real straight is not flat: the plank rides long-wavelength
 * undulation and the shower pulses at a few hertz with it.
 *
 * Two irrational-ratio wavelengths (23.7 m and 8.3 m) sampled on arc length, so
 * the flicker is locked to GROUND POSITION rather than to time: it slows down
 * with the car, it repeats when you come back round, and it is identical for
 * every car in the field at the same point on the road, which is what makes a
 * pack of cars all light up over the same crest. +-0.55 mm, about a third of the
 * saturation depth.
 */
const BUMP_AMP = 0.00055;
function roadBump(s) {
  return (Math.sin(s * 0.2651) * 0.62 + Math.sin(s * 0.7570 + 2.1) * 0.38) * BUMP_AMP;
}
/** Metres of plank intrusion at which a strike is throwing its full shower. */
const SKID_SATURATE = 0.0016;
/**
 * How fast a strike dies once the skid lifts again, 1/s. This is the knob that
 * decides burst vs stream: at 9 the tail of one strike was still emitting when
 * the next one landed and the duty cycle came back to 0.69 — a modulated torch.
 * At 20 a strike is a ~120 ms shower with real darkness between showers.
 */
const SKID_DECAY = 20;
/** Upper bound on one strike, so an impact flash cannot drain the pool. */
const SKID_MAX = 1.6;
/**
 * A kerb stands this far proud of the tarmac, so it bites that much earlier.
 *
 * 11 mm was under a quarter of a real sawtooth kerb's 40-50 mm rise, and the
 * consequence was measurable: in the `chase` capture the car is sitting on the
 * inside kerb of a right-hander with its right-hand suspension travel at 1.8 mm
 * (a right-hander ROLLS THE CAR OFF its inside wheels, so the corner unloads
 * exactly where the kerb is), giving the right-hand skids an intrusion of
 * -4.6 mm. A car straddling a kerb — the single most reliable spark source there
 * is, and the shot every broadcast cuts to — therefore threw nothing at all.
 * 20 mm is still less than half a real kerb and it puts that same frame 6.4 mm
 * inside the bite. `st.kerb` decays over ~110 ms, so the shower stops with the
 * kerb rather than trailing down the following straight.
 */
const KERB_PROUD = 0.020;

const SURFACE_CHIP = {
  track: [0.10, 0.10, 0.11],
  kerb: [0.24, 0.23, 0.23],
  runoff: [0.34, 0.33, 0.31],
  gravel: [0.50, 0.40, 0.28],
  grass: [0.22, 0.30, 0.12],
};

export class Particles {
  constructor(scene, o = {}) {
    this.scene = scene;
    this.rng = makeRng(hashSeed('particles'));
    this.enabled = true;
    this.time = 0;
    this.wetness = 0;
    this.windX = 0.9;
    this.windZ = -0.4;
    this.playerIndex = o.playerIndex ?? 0;
    /** Ambient shimmer over hot tarmac; 0 disables. */
    this.tarmacShimmer = o.tarmacShimmer ?? 1;
    /** 3D wind streaks past the camera at speed; 0 disables. */
    this.speedStreaks = o.speedStreaks ?? 1;

    const puff = smokePuffAtlas();
    const chips = debrisAtlas();
    const swirl = swirlNormal();
    this._textures = [puff, chips, swirl];

    const A = THREE.AdditiveBlending;
    const N = THREE.NormalBlending;

    this.smoke = new Pool(scene, {
      count: o.maxSmoke ?? 2400, map: puff, atlas: 2, blending: N, opacity: 1.0,
      fadeIn: 0.07, fadeOut: 0.28, spin: 1.0, soft: 1.2, sorted: true,
      turbulence: 1.7, turbScale: 0.30, wind: 1, growDecay: 1.15,
      defines: ['LIT', 'SOFT'], renderOrder: 20,
    });

    this.dust = new Pool(scene, {
      count: o.maxDust ?? 1400, map: puff, atlas: 2, blending: N, opacity: 1.0,
      fadeIn: 0.06, fadeOut: 0.26, spin: 0.8, soft: 0.9, sorted: true, maxPx: 240,
      turbulence: 1.1, turbScale: 0.5, wind: 0.7, growDecay: 1.4,
      defines: ['LIT', 'SOFT'], renderOrder: 20,
    });

    this.spray = new Pool(scene, {
      count: o.maxSpray ?? 1200, map: puff, atlas: 2, blending: N, opacity: 0.0,
      fadeIn: 0.05, fadeOut: 0.28, spin: 1.2, soft: 0.8, sorted: true,
      turbulence: 1.8, turbScale: 0.6, wind: 1, growDecay: 1.2,
      defines: ['LIT', 'SOFT'], renderOrder: 21,
    });

    this.spark = new Pool(scene, {
      // POOL BUDGET. 20 cars scraping their planks at racing pace asked for
      // ~5500 sparks/second against a 1100-slot ring at ~0.5 s of life: every
      // spark was recycled after ~60 ms, so none of them ever got to arc, bounce
      // or cool. One THREE.Points draw call and a 2600-element CPU loop is far
      // cheaper than that trade.
      // STREAK LENGTH. `stretch` is a shutter time in seconds. At 0.030 s a
      // spark whose apparent speed is 0.38x of 95 m/s draws a 1.1 m tail, which
      // at 8 m from a chase camera is 150 px — the cap — so every spark on a
      // straight rendered as a full-length hard bar and the shower read as a
      // handful of laser lines.
      // DOUBLE SMEAR. postfx now runs a real depth-graded motion blur with a
      // ~49 px near-ground ceiling, and a ground-skimming spark is exactly the
      // depth band that gets the most of it. The shutter smear the sprite bakes
      // in and the shutter smear post applies COMPOSE, so 0.017 s / 84 px came
      // out of the pipe as parallel ribbons. 0.010 s / 54 px leaves post to do
      // the rest and the shower resolves into separate chips again.
      // 0.010 s / 54 px was still tuned against the OLD post shutter (0.42 and a
      // ~49 px near-field ceiling). Post now runs 0.30 / ~30 px, but a spark is
      // the one thing in the frame that gets the sprite streak AND the full
      // near-field post smear AND an additive bloom on top, and at 336 km/h the
      // shower came out of the pipe as two solid orange bars under the diffuser
      // rather than a scatter of cooling chips. 0.006 s / 30 px lets post carry
      // the smear and the shower resolves into individual sparks again.
      // GRAIN IS THE WHOLE EFFECT. A titanium shower is HUNDREDS of fine chips,
      // not a dozen fat ones: at ~18 chips a frame the capture came back as ten
      // isolated smooth lozenges, and no amount of colour work fixes that,
      // because the defect is the sampling density. The emitter now runs ~10x
      // the rate at ~4x smaller a chip (see emitSparks / driveFromCar), which is
      // roughly the same total incandescent AREA delivered as a spray instead of
      // as pills — and thin chips are far cheaper to fill than fat ones, so the
      // extra count is close to free. 12000 slots holds the player's shower
      // (~180/frame x 0.55 s ~= 5900) plus a couple of nearby cars.
      // THE SPRITE STREAK AND THE POST SMEAR COMPOSE — AGAIN. Measured on 'hud'
      // at 336 km/h: with post's motion blur switched off the shower resolves
      // into ~100 separate filaments and reads exactly like titanium on tarmac;
      // switch it back on and the same frame is a dozen fat ribbons. Post smears
      // the sparks along the TARMAC's screen velocity (an additive sprite writes
      // no velocity of its own), and the tarmac is running at 93 m/s while a
      // chip is only doing ~35 m/s relative to the camera — so post alone
      // over-smears them by ~2.7x, on top of the 30 px the sprite had already
      // baked in. The sprite's own share has to come down to leave room:
      // 0.0035 s / 18 px is ~0.12 m of tail, and the composite lands at roughly
      // the length the chip actually travelled during the shutter.
      // maxPx: the near-lens ceiling (see VERT). 11 px of chip radius fades out
      // by 19 px, which is ~0.9 m from the lens for the median chip. The camera
      // closes on its own shower at 35 m/s, so without this every chip ends its
      // life as a fist-sized lozenge stamped on the lens for two frames.
      count: o.maxSpark ?? 12000, map: puff, atlas: 2, blending: A, opacity: 1.0,
      fadeIn: 0.02, fadeOut: 0.52, soft: 0.06, stretch: 0.0035, bounce: 0.42,
      camRel: 1, maxStreak: 18, maxPx: 11,
      defines: ['STRETCH', 'EMBER', 'SOFT', 'ADDITIVE'], renderOrder: 22,
    });

    this.debris = new Pool(scene, {
      count: o.maxDebris ?? 500, map: chips, atlas: 2, blending: N, opacity: 1.0,
      fadeIn: 0.01, fadeOut: 0.80, spin: 3.5, soft: 0.25, bounce: 0.30,
      depthWrite: true,
      defines: ['CHIP', 'LIT', 'SOFT'], renderOrder: 19,
    });

    this.haze = new Pool(scene, {
      // maxPx: a refractive sprite is the one family that CANNOT be allowed to
      // fill the frame — it carries a copy of the framebuffer, so a big one is a
      // smear rather than a soft blob. 150 px fades out from 262 px, which no
      // legitimate plume ever reaches (an exhaust column is ~60 px at chase
      // range) and which the overtaken tarmac shimmer used to blow past by 9x.
      // SOFT: without a depth fade a 2 m disc lying on the road pops on and off
      // in one frame as its single point depth crosses the tarmac.
      count: o.maxHaze ?? 300, map: swirl, atlas: 1, blending: N, opacity: 1.0,
      fadeIn: 0.14, fadeOut: 0.30, spin: 0.4, refract: 0.013, turbulence: 0.55,
      soft: 1.6, maxPx: 150,
      defines: ['REFRACT', 'SOFT'], renderOrder: 23,
    });

    this.wind = new Pool(scene, {
      count: o.maxWind ?? 420, map: puff, atlas: 2, blending: A, opacity: 0.0,
      fadeIn: 0.14, fadeOut: 0.30, soft: 0.6, stretch: 0.055, maxStreak: 70,
      defines: ['STRETCH', 'SOFT', 'ADDITIVE'], renderOrder: 22,
    });

    this.pools = [this.debris, this.smoke, this.dust, this.spray, this.spark, this.wind, this.haze];

    /** Additive road patch under a spark shower (see SparkGlow). */
    this._glow = new SparkGlow(scene, 3);

    this._carState = new Map();
    this._teleport = false;
    this._speed01 = 0;
    this._playerPos = new THREE.Vector3();
    this._playerVel = new THREE.Vector3();
    this._shimmerAcc = 0;
    this._windAcc = 0;
    this._refractOK = false;
    this._camVel = new THREE.Vector3();
    this._camPrev = new THREE.Vector3();
    this._camPrevValid = false;

    /** Grading knobs — how much sun/ambient a puff receives vs a solid surface. */
    this.sunScale = o.sunScale ?? 0.34;
    this.ambientScale = o.ambientScale ?? 0.80;
  }

  // -- render context ------------------------------------------------------

  /**
   * Wire up the renderer-dependent features. Optional: without it the module
   * still works, it just loses soft-particle depth fade and heat refraction.
   * @param {THREE.WebGLRenderer} renderer
   * @param {THREE.PerspectiveCamera} camera
   * @param {import('../render/postfx.js').PostFX} [postfx] source of the depth G-buffer
   */
  attachRenderer(renderer, camera, postfx = null) {
    this.renderer = renderer;
    this.camera = camera;
    this.postfx = postfx;
    this._initRefraction();
    return this;
  }

  _initRefraction() {
    if (!this.renderer || this._sceneCopy) return;
    const s = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    try {
      this._sceneCopy = new THREE.WebGLRenderTarget(Math.max(2, s.x), Math.max(2, s.y), {
        type: THREE.HalfFloatType,
        format: THREE.RGBAFormat,
        colorSpace: THREE.LinearSRGBColorSpace,
        depthBuffer: false,
        stencilBuffer: false,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
      });
      this.renderer.initRenderTarget(this._sceneCopy);
      this.haze.material.uniforms.uScene.value = this._sceneCopy.texture;
      // Grab the framebuffer immediately before the haze sprites draw, so the
      // copy already contains the car, the track and every other FX layer.
      this.haze.points.onBeforeRender = (renderer) => {
        if (!this._refractOK || this.haze.live === 0) return;
        const rt = renderer.getRenderTarget();
        if (rt && rt.samples > 0) return;              // cannot blit from an MSAA FBO
        try {
          renderer.copyFramebufferToTexture(this._sceneCopy.texture);
        } catch {
          this._refractOK = false;
        }
      };
      this._refractOK = true;
    } catch {
      this._refractOK = false;
    }
  }

  _resizeRefraction(w, h) {
    if (!this._sceneCopy) return;
    if (w === this._sceneCopy.width && h === this._sceneCopy.height) return;
    this._sceneCopy.setSize(Math.max(2, w), Math.max(2, h));
    try { this.renderer.initRenderTarget(this._sceneCopy); } catch { this._refractOK = false; }
  }

  // -- emission ------------------------------------------------------------

  _j(v, amount) { return v + (this.rng() - 0.5) * amount; }

  /**
   * Tyre smoke. `opts.colour` overrides the tint, `opts.density` (0..1) scales
   * opacity and lifetime, `opts.rise` the buoyancy.
   */
  emitSmoke(pos, vel, amount, o = {}) {
    const n = this._count(amount);
    const col = o.colour ?? [0.80, 0.805, 0.82];
    const density = o.density ?? 1;
    const scale = o.scale ?? 1;
    for (let i = 0; i < n; i++) {
      const r = this.rng();
      _sp.set(this._j(pos.x, 0.34), pos.y + r * 0.14, this._j(pos.z, 0.34));
      _sv.set(this._j(vel.x, 3.0), (o.rise ?? 1.0) * (0.7 + this.rng() * 1.5), this._j(vel.z, 3.0));
      this.smoke.spawn(_sp, _sv, {
        size: (0.15 + this.rng() * 0.16) * scale,
        grow: (1.5 + this.rng() * 1.2) * scale,
        lifetime: (1.3 + this.rng() * 1.5) * (0.6 + density * 0.7),
        colour: col,
        // The puff atlas' soft knee tops out at ~0.83 instead of clipping to 1,
        // so every alpha in this file is scaled by ~1.2 to hold the same optical
        // depth as before. The gain is entirely in the gradient, not the density.
        alpha: (0.18 + this.rng() * 0.16) * density,
        seed: this.rng(), drag: 1.35, gravity: 0.30,
      });
    }
  }

  /**
   * The pale-blue cloud that hangs in the air where a car locked up: almost no
   * initial velocity, very long life, heavy growth. Anchored in world space, so
   * the car drives out of its own smoke.
   */
  emitLockupHaze(pos, amount, o = {}) {
    const n = this._count(amount);
    for (let i = 0; i < n; i++) {
      _sp.set(this._j(pos.x, 1.0), pos.y + 0.12 + this.rng() * 0.5, this._j(pos.z, 1.0));
      _sv.set(this._j(0, 1.1), 0.30 + this.rng() * 0.55, this._j(0, 1.1));
      this.smoke.spawn(_sp, _sv, {
        size: 0.45 + this.rng() * 0.55,
        grow: 1.3 + this.rng() * 1.0,
        lifetime: 4.5 + this.rng() * 4.0,
        colour: o.colour ?? [0.66, 0.72, 0.88],
        alpha: 0.066 + this.rng() * 0.06,
        seed: this.rng(), drag: 0.55, gravity: 0.16,
      });
    }
  }

  /**
   * Dirt lifted off a surface. `opts.surface` selects the colour; `size`, `grow`
   * and `lifetime` scale the plume (a run-off excursion throws a real cloud, the
   * film off a clean lap must not).
   */
  emitDust(pos, vel, amount, o = {}) {
    const n = this._count(amount);
    const col = o.colour ?? SURFACE_DUST[o.surface ?? 'runoff'];
    const size = o.size ?? 0.14;
    const grow = o.grow ?? 1.2;
    const life = o.lifetime ?? 1.4;
    // BUOYANCY. A gravel or grass excursion genuinely throws a cloud upward, but
    // the thin film a clean lap lifts off dry tarmac does not: at the default
    // 1.0-3.4 m/s a track-film puff climbs 1.3 m over its life and ends up a
    // pale disc hanging in mid-air a car's length behind the rear wing, which in
    // the `tv` long lens reads as a smudge on the lens. Callers that are lifting
    // road film pass `rise` down near zero and the wake stays on the deck.
    const rise = o.rise ?? 1.0;
    for (let i = 0; i < n; i++) {
      _sp.set(this._j(pos.x, 0.42), pos.y + this.rng() * 0.12, this._j(pos.z, 0.42));
      _sv.set(this._j(vel.x, 3.6), rise * (1.0 + this.rng() * 2.4), this._j(vel.z, 3.6));
      this.dust.spawn(_sp, _sv, {
        size: size + this.rng() * size * 1.55,
        grow: grow * (1 + this.rng() * 0.9),
        lifetime: life * (1 + this.rng() * 1.05),
        colour: col,
        alpha: (0.24 + this.rng() * 0.20) * (o.density ?? 1),
        seed: this.rng(), drag: 1.5, gravity: -0.9,
      });
    }
  }

  /**
   * Titanium plank / kerb sparks: stretched, black-body cooled, bouncing.
   *
   * `vel` is the WORLD velocity the particles are launched with — for plank
   * sparks that is a fraction of the car's own velocity, because a scraped chip
   * of titanium leaves the plank moving with the car and then air-brakes. It is
   * NOT a relative velocity: getting that wrong is what made the streaks fly
   * backwards through the world instead of trailing the car.
   *
   * `o.tangent` (unit, the direction of travel) biases the launch cone so the
   * lateral scatter is across the direction of travel and the vertical kick is
   * small — a plank scrape throws a flat fan, not a fountain.
   */
  emitSparks(pos, vel, amount, o = {}) {
    const n = this._count(amount);
    const floor = o.floor ?? pos.y;
    const spread = o.spread ?? 6.0;
    const rise = o.rise ?? 3.0;
    // Across-track axis: perpendicular to travel, in the ground plane.
    let ax = 1, az = 0, tx = 0, tz = 0;
    if (o.tangent) {
      ax = o.tangent.z; az = -o.tangent.x;
      const m = Math.hypot(ax, az) || 1;
      ax /= m; az /= m;
      tx = o.tangent.x / m; tz = o.tangent.z / m;
    }
    // SUB-FRAME EMISSION. At 93 m/s the car covers 1.55 m in one 1/60 step, so
    // spawning a frame's whole batch at one point lays the shower down as a
    // train of discrete clumps 1.55 m apart — visible in the capture as diagonal
    // bands inside what should be a continuous spray. `stride` is the metres the
    // emitter travelled during this step; each chip is placed uniformly back
    // along it, which is where it would have been born had the skid been
    // scraping continuously (it was).
    const stride = o.stride ?? 0;
    for (let i = 0; i < n; i++) {
      const across = (this.rng() - 0.5) * (o.jitter ?? 0.30);
      const back = this.rng() * stride;
      _sp.set(
        pos.x + ax * across - tx * back,
        pos.y + this.rng() * 0.02,
        pos.z + az * across - tz * back,
      );
      // LATERAL KICK IS BIMODAL for the same reason the vertical one is: a
      // uniform fan gives every chip the same sideways push and the shower
      // resolves into two parallel ribbons. Most of a scrape stays in the
      // plane of the plank; roughly one chip in seven catches an edge and is
      // flung properly wide, and those few outliers are what stop the trail
      // reading as a jet.
      const w = this.rng() - 0.5;
      const s = (Math.abs(w) < 0.43 ? w * 0.55 : w * 2.0) * spread;
      // RISE IS BIMODAL. A uniform 0..rise kick gives every chip the same little
      // hop and the shower reads as a fountain. In reality most chips skitter
      // flat along the tarmac and a few get flicked up and arc — so four out of
      // five stay under a fifth of the kick and the rest take the whole range.
      const hop = this.rng();
      const up = (hop < 0.78 ? hop * 0.26 : 0.2 + (hop - 0.78) * 3.6) * rise;
      // LAUNCH SPEED IS NOT UNIFORM. Every chip leaving with exactly the same
      // fraction of the car's velocity keeps the whole batch in lockstep: they
      // stay a rigid line, overlap additively and read as two solid jets rather
      // than as a spray of separate chips. A scrape tears the titanium off at a
      // range of speeds — spread over 0.72..1.18 of the nominal, each chip pulls
      // away from its neighbours and the shower opens out along its own length.
      const kv = 0.72 + this.rng() * 0.46;
      _sv.set(vel.x * kv + ax * s, up, vel.z * kv + az * s);
      // SIZE AND LIFE ARE HEAVILY SKEWED, NOT UNIFORM. A uniform 0.026..0.060
      // range is only 2.3:1 and its mean sits near the top, so every chip drew
      // at very nearly the same width and the shower read as stamped copies of
      // one sprite. A grinding contact makes mostly dust-fine chips and a few
      // big ones: r^3 on the size gives a 7:1 range whose mass is at the fine
      // end, and r^2 on the life does the same for how far each one gets. The
      // mean radius is ~4x smaller than r4's, which is what turns a lozenge into
      // a filament (screen width is R = px/2, so this is a direct divide).
      // r^3 over 0.0055..0.0375 measured out at a p10 of 0.17 px and a p90 of
      // 5.2 px of screen RADIUS on 'hud' — a 30:1 spread in which the bottom
      // decile is invisible (it costs fill and delivers nothing) and the top
      // decile is a fat pill carrying a halo. The shower wants GRAIN, which is
      // a narrow band of chips all near the resolution limit: r^2 over
      // 0.0075..0.0215 is 2.9:1, still mass-weighted to the fine end, and lands
      // the bulk of the player's shower between 1 and 3 px of radius where a
      // filament reads as a filament.
      const rs = this.rng();
      const rl = this.rng();
      this.spark.spawn(_sp, _sv, {
        size: 0.0075 + rs * rs * 0.0140,
        grow: -0.0015,
        lifetime: 0.20 + rl * rl * 0.62,
        colour: o.colour ?? [1, 1, 1],
        // 0.40..0.82 is 2:1 and its mean sits high, so every chip drew at very
        // nearly the same brightness — the "no brightness variance" half of the
        // note. A grinding contact tears off chips of wildly different mass and
        // the small ones simply carry less incandescent material: r^1.7 over
        // 0.22..0.98 is 4.5:1, mass-weighted dim, so the shower has a scatter of
        // genuinely bright heads inside a haze of faint ones.
        alpha: 0.22 + Math.pow(this.rng(), 1.7) * 0.76,
        // 1.33 g was carrying the vertical apparent velocity to a quarter of the
        // longitudinal one, and because a chase camera foreshortens the
        // longitudinal component to almost nothing near the focus of expansion,
        // that is what tipped individual streaks 30-45 degrees off the direction
        // the tarmac underneath them is blurring. Real gravity, and a flatter
        // launch (see `rise` at the call site), keeps the fan in the road plane.
        seed: this.rng(), drag: o.drag ?? 0.85, gravity: -9.81, floor,
      });
    }
  }

  /** Wet-weather rooster tail. */
  emitSpray(pos, vel, amount, o = {}) {
    const n = this._count(amount);
    for (let i = 0; i < n; i++) {
      _sp.set(this._j(pos.x, 0.30), pos.y + 0.08, this._j(pos.z, 0.30));
      _sv.set(this._j(vel.x, 4.5), 1.6 + this.rng() * 3.6, this._j(vel.z, 4.5));
      this.spray.spawn(_sp, _sv, {
        size: 0.16 + this.rng() * 0.26,
        grow: 1.5 + this.rng() * 1.1,
        lifetime: 0.75 + this.rng() * 0.85,
        colour: o.colour ?? [0.78, 0.83, 0.92],
        alpha: 0.26 + this.rng() * 0.21,
        seed: this.rng(), drag: 1.7, gravity: -2.4,
      });
    }
  }

  /** Solid tumbling bits: stones, marbles, grass, carbon. */
  emitDebris(pos, vel, amount, o = {}) {
    const n = this._count(amount);
    const floor = o.floor ?? pos.y;
    for (let i = 0; i < n; i++) {
      _sp.set(this._j(pos.x, o.jitter ?? 0.25), pos.y + 0.04 + this.rng() * 0.1, this._j(pos.z, o.jitter ?? 0.25));
      _sv.set(this._j(vel.x, o.spread ?? 5), (o.rise ?? 2.5) + this.rng() * 3.5, this._j(vel.z, o.spread ?? 5));
      this.debris.spawn(_sp, _sv, {
        size: (o.size ?? 0.030) * (0.6 + this.rng() * 0.9),
        grow: 0,
        lifetime: o.lifetime ?? (1.4 + this.rng() * 1.6),
        colour: o.colour ?? SURFACE_CHIP.gravel,
        alpha: 1,
        seed: this.rng(), drag: o.drag ?? 0.30, gravity: -16, floor,
      });
    }
  }

  /** Rubber marbles flicked off a sliding tyre. */
  emitMarbles(pos, vel, amount, o = {}) {
    this.emitDebris(pos, vel, amount, {
      colour: [0.075, 0.072, 0.070], size: 0.024, spread: 3.2, rise: 1.6,
      lifetime: 2.4 + this.rng() * 1.6, floor: o.floor, drag: 0.5,
    });
  }

  /** Carbon shards from a broken wing: light, flat, they flutter. */
  emitCarbonShards(pos, vel, amount, o = {}) {
    const n = this._count(amount);
    const floor = o.floor ?? pos.y;
    for (let i = 0; i < n; i++) {
      _sp.set(this._j(pos.x, 0.35), pos.y + 0.2 + this.rng() * 0.4, this._j(pos.z, 0.35));
      _sv.set(this._j(vel.x, 8), 1.5 + this.rng() * 5.5, this._j(vel.z, 8));
      this.debris.spawn(_sp, _sv, {
        size: 0.055 + this.rng() * 0.075,
        grow: 0,
        lifetime: 2.6 + this.rng() * 2.2,
        colour: [0.055, 0.058, 0.065],
        alpha: 1,
        seed: 0.75 + this.rng() * 0.25,     // biased into the shard atlas cell
        drag: 1.15, gravity: -9.5, floor,
      });
    }
  }

  /** Car-to-car or car-to-barrier contact: shards, dust and a burst of sparks. */
  emitContact(pos, vel, severity = 1) {
    const s = clamp(severity, 0, 1);
    this.emitCarbonShards(pos, vel, 6 + s * 22);
    this.emitSparks(pos, vel, 14 + s * 50, { spread: 9 });
    this.emitDust(pos, vel, 4 + s * 12, { surface: 'track', density: 0.8 });
  }

  /** Refractive heat plume. Cheap: a handful of large, slow, low-alpha sprites. */
  emitHeatHaze(pos, vel, amount, o = {}) {
    if (!this._refractOK) return;
    const n = this._count(amount);
    for (let i = 0; i < n; i++) {
      _sp.set(this._j(pos.x, o.jitter ?? 0.18), pos.y + this.rng() * 0.12, this._j(pos.z, o.jitter ?? 0.18));
      _sv.set(this._j(vel.x, 1.6), (o.rise ?? 1.2) + this.rng() * 1.0, this._j(vel.z, 1.6));
      this.haze.spawn(_sp, _sv, {
        size: o.size ?? (0.16 + this.rng() * 0.20),
        grow: o.grow ?? 0.55,
        lifetime: o.lifetime ?? (0.7 + this.rng() * 0.7),
        colour: o.colour ?? [1, 1, 1],
        alpha: o.alpha ?? 1,
        seed: this.rng(), drag: 1.1, gravity: 0.5,
      });
    }
  }

  /** Fractional amounts accumulate probabilistically so low rates still emit. */
  _count(amount) {
    if (amount <= 0) return 0;
    const n = Math.floor(amount);
    return n + (this.rng() < amount - n ? 1 : 0);
  }

  // -- car-driven emission -------------------------------------------------

  /**
   * Reads a car's physics state and emits everything it should be producing.
   * @param {{vehicle:object, model:object, index:number}} car
   * @param {number} dt
   * @param {number} wetness 0..1 from the weather system
   */
  driveFromCar(car, dt, wetness = 0) {
    if (!this.enabled) return;
    const v = car.vehicle;
    const speed = v.speed;

    // A capture or a reset teleports the whole field; drop the stale trail once.
    let st = this._carState.get(car);
    if (!st) {
      st = {
        pos: new THREE.Vector3().copy(v.position), lockS: -1, lockT: 0, kerb: 0,
        // Per-skid travel history + the decaying strike each one is running.
        skid: new Float32Array(4), strike: new Float32Array(4), skidReady: false,
      };
      this._carState.set(car, st);
    }
    const moved = st.pos.distanceToSquared(v.position);
    st.pos.copy(v.position);
    if (moved > 36) {                     // > 6 m in one 1/60 step
      // A restage makes the travel history meaningless: differencing across it
      // would read as a 100 m/s floor strike and fire a shower on frame one.
      st.skidReady = false;
      st.strike.fill(0);
      if (!this._teleport) { this._teleport = true; this.reset(); }
      return;
    }

    if (speed < 0.8) return;

    // Distance LOD: cars the camera cannot see do not need a full FX budget.
    let lod = 1;
    if (this.camera) {
      const d = this.camera.position.distanceTo(v.position);
      if (d > 220) return;
      lod = d > 130 ? 0.18 : d > 70 ? 0.5 : 1;
    }

    if (car.index === this.playerIndex) {
      this._playerPos.copy(v.position);
      this._speed01 = clamp(speed / 88, 0, 1);
    }

    const yaw = v.yaw;
    _fwd.set(-Math.sin(yaw), 0, -Math.cos(yaw));
    _rgt.set(Math.cos(yaw), 0, -Math.sin(yaw));

    const circuit = v.circuit;
    // THE TRACK EDGE IS LOCAL, NOT GLOBAL. `circuit.halfWidth` is the WIDEST the
    // circuit ever gets (7.6 m here); every corner carries its own `sample.width`
    // (6.2-7.6 m) and circuit.js lays the kerb, the verge and the run-off against
    // that local edge — `onTrack()` itself takes an `s`. Measuring against the
    // global maximum therefore reported the car as 1.1 m from the edge while it
    // was physically ON the kerb, which is why no kerb-side effect (sparks, kerb
    // dust, kerb dirt colour) ever fired in a corner. Read the stored sample
    // directly: `sampleAt` allocates, `samples[]` is a documented read-only view.
    let hw = 6.7;
    if (circuit) {
      hw = circuit.halfWidth;
      const smp = circuit.samples?.[circuit.sampleIndex(v.trackS ?? 0)];
      if (smp && smp.width > 0) hw = smp.width;
    }
    const lat = Math.abs(v.trackLateral ?? 0);
    const kerbBand = lat > hw - 0.2 && lat < hw + 1.5;
    let surface = 'track';
    if (lat > hw + 1.5) {
      const k = circuit ? Math.abs(circuit.curvatureAt(v.trackS)) : 0;
      surface = lat < hw + 7 ? 'runoff' : (k > 0.0045 ? 'gravel' : 'grass');
    } else if (kerbBand) surface = 'kerb';

    const groundY = v.position.y;
    const speedFade = clamp((speed - 8) / 18, 0, 1);
    const backwash = -speed * 0.24;

    // --- rear tyres: wheelspin, scrub haze, marbles, surface dirt ------------
    for (let i = 2; i < 4; i++) {
      const side = i === 2 ? -1 : 1;
      _p.copy(v.position).addScaledVector(_fwd, -1.98).addScaledVector(_rgt, side * 0.80);
      _p.y += 0.10;
      _v.copy(_fwd).multiplyScalar(backwash).addScaledVector(_rgt, side * speed * 0.05);

      const spin = clamp(v.slipRatio[i] - 0.22, 0, 1.4);
      const slide = clamp(Math.abs(v.slipAngle[i]) - 0.14, 0, 0.8);
      const heat = spin * 1.5 + slide * 2.2;

      if (surface === 'track' || surface === 'kerb') {
        if (heat > 0.02) {
          const amt = heat * 34 * speedFade * lod * dt * 60;
          this.emitSmoke(_p, _v, amt, {
            density: clamp(0.28 + heat * 1.5, 0, 1.35),
            scale: 1 + clamp(heat, 0, 1) * 0.5,
            rise: 0.85,
          });
          if (heat > 0.45) this.emitLockupHaze(_p, heat * 1.4 * lod * dt * 60 * 0.10);
          if (heat > 0.25 && this.rng() < heat * 5 * dt) {
            this.emitMarbles(_p, _v, 1 + this.rng() * 2, { floor: groundY });
          }
        }
        // Even a clean fast lap lifts a fine film of dust and rubber dust.
        //
        // BUDGET. This is the only emitter that fires on EVERY car on EVERY
        // frame, so its rate sets the floor of the whole FX budget. At
        // `speed * 0.020` it was 1.7 puffs per rear tyre per frame — 3.4 per car,
        // ~1300/s across a close-quarters field — against a 1400-deep pool with a
        // 1.4-2.9 s lifetime. The pool sat permanently at 1400/1400, so (a) every
        // lockup, gravel excursion and kerb strike had nothing left to spawn into,
        // and (b) 1400 sprites that grow to ~2 m radius covered the whole corner
        // in a pale haze that read as smoke lying on a dry track. A film of dust
        // is a hint, not a smoke screen: a tenth of the rate and a short life.
        // At 0.0022 the wake was ~6 puffs alive per rear tyre — under the
        // threshold of being visible at all, which is why every broadcast-angle
        // capture came back with a car moving through completely still air. 2.7x
        // the rate, a fifth of the buoyancy and a slightly bigger puff give a
        // low, flat rubber-dust wake that hugs the tarmac behind the diffuser
        // and is gone within a second. It is still an order of magnitude below
        // the rate that once filled the whole corner with haze.
        // SIZE, NOT RATE, IS WHAT MADE THIS READ AS DISCS. At grow 0.85 (jittered
        // to 1.6) over a 0.6 s life (jittered to 1.23 s) a single film puff
        // reached ~0.9 m of RADIUS — a two-metre pale blob lying on the tarmac a
        // car's length behind the diffuser, measured at 340 px across in the
        // `hud` capture. Road film is not a smoke screen: it is a lot of small
        // parcels. Half the growth, three-quarters the birth size, two-thirds the
        // density and 1.5x the count keeps exactly the same amount of matter in
        // the air while changing the grain from "discs" to "dust".
        // SCRUB SCALES THE FILM, IT DOES NOT SWITCH ON SMOKE. The `heat` gate
        // above only opens at 8 degrees of slip angle, which is past the peak of
        // the tyre curve — so a car balanced ON the limit (measured 5-6 degrees
        // at `chase`/`tv`) produced exactly the same wake as one cruising the
        // pit lane, and the mid-corner broadcast frame came back with the car
        // moving through still air. A tyre working that hard is abrading rubber
        // and lifting road film well before it is smoking, so the honest place
        // for it is a scale on the film, not a second threshold: a bit more of
        // it, lasting a bit longer, lifted a bit higher. It stays the same SMALL
        // PARCEL either way, which is the invariant that keeps this emitter from
        // regressing into the pale discs the review logged.
        if (speed > 30 && lod > 0.4) {
          const scrub = clamp((Math.abs(v.slipAngle[i]) - 0.045) * 6.5, 0, 1)
                      + clamp(v.slipRatio[i] - 0.10, 0, 0.4);
          // `size`, `grow` and `lifetime` are deliberately NOT on the scrub term.
          // Those three are what set a puff's final radius, and the tuned trio
          // (0.080 / 0.34 / 0.55) tops out at ~1.1 m across, which is the ceiling
          // that keeps this reading as dust. An earlier cut of this scaled grow
          // and lifetime too and would have taken a hard-working tyre back to a
          // 2.3 m puff — the pale disc, re-derived from a different direction.
          // Scrub buys COUNT, OPACITY and a little lift. Nothing else.
          this.emitDust(_p, _v, speed * (0.0135 + 0.026 * scrub) * lod * dt * 60, {
            surface: 'track', density: 0.13 + 0.13 * scrub,
            grow: 0.34, lifetime: 0.55,
            size: 0.080, rise: 0.20 + 0.30 * scrub,
          });
        }
      } else {
        const off = speed * (surface === 'gravel' ? 0.55 : 0.34) * lod * dt * 60;
        this.emitDust(_p, _v, off, { surface, density: surface === 'gravel' ? 1.15 : 0.85 });
        if (surface === 'gravel' || surface === 'grass') {
          this.emitDebris(_p, _v, speed * 0.10 * lod * dt * 60, {
            colour: SURFACE_CHIP[surface], floor: groundY,
            size: surface === 'gravel' ? 0.032 : 0.026, spread: 6, rise: 2.5,
          });
        }
      }

      if (wetness > 0.12 && speed > 10) {
        this.emitSpray(_p, _v, wetness * speed * 0.30 * lod * dt * 60);
      }
      // Brake dust off the rear ducts under heavy braking.
      if (v.brakeTemp[i] > 620 && v.controls.brake > 0.4 && lod > 0.4) {
        _q.copy(v.position).addScaledVector(_fwd, -1.98).addScaledVector(_rgt, side * 0.55);
        _q.y += 0.30;
        // Explicit small parcels: the emitter's defaults (0.14 m growing at
        // 1.2 m/s for 1.4 s) are sized for a gravel excursion, and brake dust
        // borrowing them put 1.5 m grey domes on the rear wheels under braking.
        this.emitDust(_q, _v, 4.5 * lod * dt * 60, {
          colour: [0.20, 0.17, 0.16], density: 0.34,
          size: 0.065, grow: 0.45, lifetime: 0.70, rise: 0.55,
        });
      }
    }

    // --- front tyres: lockups (the money shot) -------------------------------
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? -1 : 1;
      const lock = v.lockup[i];
      _p.copy(v.position).addScaledVector(_fwd, 1.62).addScaledVector(_rgt, side * 0.83);
      _p.y += 0.09;
      _v.copy(_fwd).multiplyScalar(-speed * 0.16);

      if (lock > 0.06 && speed > 10 && (surface === 'track' || surface === 'kerb')) {
        const amt = lock * 60 * speedFade * lod * dt * 60;
        this.emitSmoke(_p, _v, amt, {
          colour: [0.84, 0.855, 0.90],
          density: clamp(0.35 + lock * 1.6, 0, 1.5),
          scale: 1.15, rise: 0.7,
        });
        // Leave a hanging cloud behind — this is what a lockup point looks like.
        this.emitLockupHaze(_p, lock * 5.0 * lod * dt * 60 * 0.12);
        if (this.rng() < lock * 3 * dt) this.emitMarbles(_p, _v, 1 + this.rng() * 2, { floor: groundY });
      }
      if (v.brakeTemp[i] > 700 && v.controls.brake > 0.45 && lod > 0.4) {
        _q.copy(v.position).addScaledVector(_fwd, 1.62).addScaledVector(_rgt, side * 0.60);
        _q.y += 0.28;
        this.emitDust(_q, _v, 5 * lod * dt * 60, {
          colour: [0.22, 0.185, 0.17], density: 0.38,
          size: 0.060, grow: 0.42, lifetime: 0.65, rise: 0.60,
        });
        this.emitHeatHaze(_q, _v, 1.2 * lod * dt * 60, { size: 0.10, alpha: 0.55, rise: 0.9, lifetime: 0.4 });
      }
      if (wetness > 0.12 && speed > 10) this.emitSpray(_p, _v, wetness * speed * 0.16 * lod * dt * 60);
    }

    // --- titanium skid-block sparks -----------------------------------------
    // SPARKS ARE AN EVENT, NOT A FUNCTION OF SPEED. The old gate was
    // `clamp((maxCompression - 0.014) * 900, 0, 3.4) * aeroRamp`, and on a DRS
    // straight the measured travel sits at 17-25 mm — so the gate saturated and
    // stayed saturated, emitting 3.4 chips per frame for ever out of one point
    // on the centreline. That is a welding torch bolted to the diffuser, on a
    // flat straight where nothing is striking the floor at all.
    //
    // What actually makes a car spark is the PLANK REACHING THE ROAD: each skid
    // has its own travel (see SKID), its own bite point, and a strike that
    // persists for the 60-150 ms the titanium is dragging and then decays. So a
    // crest, a braking compression or a kerb produces a burst, and steady-state
    // aero squat produces the odd flicker as the road undulates under it.
    // KERB PROUD IS A PLANK TEST, NOT A CAR TEST. What raises the road under a
    // skid is the kerb being under THAT SKID, and a skid sits 0.30 m off the
    // centreline while the wheel that puts the car on the kerb is at 0.80 m. The
    // old form gated on the car's own `kerbBand` (centreline within 0.2 m of the
    // edge) and then guessed at the geometry with a `sign(S.x) === kerbSide`
    // side weight — and since `kerbBand` was measured against the GLOBAL
    // halfWidth, the whole path was unreachable: a car would have had to put two
    // wheels in the run-off before a kerb spark could fire. `skidOverKerb()`
    // replaces both with the real question, per skid: how far is this skid onto
    // the kerb? circuit.js laps the kerb's inner edge 0.10 m over the road
    // ribbon, so the kerb top starts at `width - 0.10`, and a skid is fully
    // proud once it is 0.30 m past that.
    //
    // `st.kerb` survives as the CAR-level smoothed gate for the things that are
    // genuinely car-level — kerb dust and the wider launch fan — with a rise/decay
    // that keeps a brushed kerb from strobing.
    const kerbRamp = clamp((lat + 0.80 - (hw - 0.10)) / 0.70, 0, 1) * (lat < hw + 1.6 ? 1 : 0);
    if (kerbRamp > st.kerb) st.kerb = Math.min(kerbRamp, st.kerb + dt * 7);
    else st.kerb = Math.max(kerbRamp, st.kerb - dt * 9);
    // Signed lateral of a skid: +ve lateral is the driver's right and car-local
    // +X is the car's right, so the two sign conventions agree and the skid's own
    // track offset is just `trackLateral + S.x`.
    const carLat = v.trackLateral ?? 0;
    const skidOverKerb = (sx) => clamp((Math.abs(carLat + sx) - (hw - 0.10)) / 0.30, 0, 1);
    const skidSpeed = clamp((speed - 14) / 26, 0, 1);
    // The road the plank is actually riding, sampled where the plank is. One
    // evaluation per car per frame — the two skid rows are 2.5 m apart, which is
    // a tenth of the short wavelength, so they see the same bump.
    const bump = roadBump(v.trackS ?? 0);

    let glowStrike = 0, glowX = 0;

    for (let k = 0; k < 4; k++) {
      const S = SKID[k];
      const colL = v.suspension[0] * (1 - S.wr) + v.suspension[2] * S.wr;
      const colR = v.suspension[1] * (1 - S.wr) + v.suspension[3] * S.wr;
      const travel = colL * (1 - S.tr) + colR * S.tr;
      const prev = st.skid[k];
      st.skid[k] = travel;
      // Collapse rate, m/s. First frame after a (re)stage has no history.
      const closing = st.skidReady ? (travel - prev) / Math.max(dt, 1e-4) : 0;

      const onKerb = skidOverKerb(S.x);
      const intrusion = travel - S.bite + onKerb * KERB_PROUD + bump;
      // Depth sets how wide the shower is; the closing SPEED sets the flash at
      // the instant of impact, which is why a strike reads as a burst and a
      // drag reads as a trickle.
      let strike = st.strike[k] * Math.exp(-dt * SKID_DECAY);
      if (intrusion > 0) {
        const depth = clamp(intrusion / SKID_SATURATE, 0, 1);
        strike = Math.min(SKID_MAX,
          Math.max(strike, depth * (0.40 + 1.60 * clamp(closing / 0.18, 0, 1))));
      }
      st.strike[k] = strike;
      if (strike < 0.08 || skidSpeed <= 0) continue;

      // ATTACHMENT. On the road surface under the skid itself — not at the body
      // origin, and not on the centreline.
      _p.copy(v.position).addScaledVector(_fwd, -S.z).addScaledVector(_rgt, S.x);
      _p.y = groundY + 0.010;
      // VELOCITY BASIS. A chip scraped off the plank leaves it moving with the
      // car and then air-brakes, so its WORLD velocity is a fraction of the
      // car's own — forward, decaying — and it therefore trails away BEHIND the
      // car in the car's frame. Launching it at -0.55 * speed along forward
      // sends it backwards through the world at 1.55x the car's speed, which is
      // what made the streaks shoot off the car instead of trailing it.
      _v.copy(_fwd).multiplyScalar(v.u * 0.62).addScaledVector(_rgt, v.v * 0.62);
      // RATE. `strike` runs 0.4 for a drag and up to SKID_MAX for an impact, so
      // at 9 chips per unit strike per frame a dragging skid throws ~3.6/frame
      // (~110 alive at a 0.5 s life, per skid) and a kerb strike flashes 14 in
      // one frame. The old 3.6 gave 21 alive across the whole car, which is
      // below the threshold of being visible at all at 1600x900.
      // 6.5 was tuned against a bite the car never actually reached, so it was
      // only ever exercised on the impulse path (strike -> SKID_MAX). With the
      // bite recalibrated the common case is a steady DRAG at strike 0.22-0.32,
      // and 6.5 put ~12 chips/frame on the road: enough to see, not enough to
      // read as a shower — the capture came out as a dozen separate orange
      // dashes. 9.5 lands the DRS straight at ~18/frame, which is what the
      // forced-emission reference (tools/_fxforce.mjs) showed reading as
      // titanium on tarmac rather than as tracer fire.
      // 9.5 landed the DRS straight at ~18 chips a frame across the whole car.
      // That is the number the review measured as "about ten fat isolated
      // lozenges", and it is the root cause: a shower is a DENSITY, and 18
      // samples cannot express one however they are shaded. 95 gives ~180 a
      // frame (~5900 alive), which is a spray. The extra fill is paid for by the
      // 4x smaller chip — measured, the pass is cheaper than r4's.
      // 95 was calibrated against chips that carried a halo scaling with their
      // own projected size, so a third of the shower's apparent mass was wash
      // rather than chips. With the halo clamped to a lens-sized few pixels and
      // the chip itself held near the resolution limit, the same 95 reads as a
      // thin scatter — the mass has to come from COUNT, which is what it should
      // have been all along. 170 puts ~190 chips a frame on the road under the
      // player at DRS speed (~6300 alive) and the shower reads as a continuous
      // spray of grain rather than as countable streaks.
      this.emitSparks(_p, _v, strike * 170 * skidSpeed * lod * dt * 60, {
        floor: groundY + 0.010,
        tangent: _fwd,
        // A plank scrape throws chips ALONG the floor, not out to the side: a
        // 5.5 m/s lateral fan over a 0.5 s life put sparks nearly three metres
        // wide of the car and read as pyrotechnics rather than as titanium on
        // tarmac. A kerb strike genuinely does spray wider, hence the bonus.
        // 5.0 was still enough to matter for a DIFFERENT reason than width: the
        // lateral component is the one a chase camera does NOT foreshorten, so
        // it sets the on-screen streak angle almost by itself near the focus of
        // expansion. Halving it, and flattening `rise` with it, is what puts the
        // streaks back on the same axis as the motion blur under them.
        spread: 2.4 + onKerb * 2.6,
        rise: 0.85 + onKerb * 1.4,
        // The plank is 300 mm wide and the skid it wears is not a point: 0.16 m
        // launched the whole shower from two pencil-thin jets with a dark gap
        // between them, which is half of why the streaks read as countable
        // objects rather than as a spray. 0.34 m is the real footprint and it
        // closes the gap without widening the shower beyond the car.
        jitter: 0.34,
        stride: speed * dt,
      });
      // Bounce light: a shower this bright lights the road it is skittering
      // across. One flat additive patch per car, driven by the same strike.
      glowStrike += strike * skidSpeed;
      glowX += S.x * strike * skidSpeed;
      if (onKerb > 0.35 && this.rng() < 8 * dt) {
        this.emitDust(_p, _v, 2, { surface: 'kerb', density: 0.5 });
      }
    }
    st.skidReady = true;

    // --- bounce light under the shower --------------------------------------
    // Hundreds of incandescent chips skittering down a metre of road ARE a light
    // source, and in every reference frame the tarmac under a spark shower is
    // visibly warm. The particles themselves cannot do this: they are additive
    // billboards, so they add their own radiance to the frame but never to the
    // surface they are bouncing off. One flat additive patch on the road, keyed
    // to the same `strike` that drives the emission, is the whole of it — no
    // extra light, no shadow pass, no second exposure path.
    // It is SMOOTHED because a strike is a 120 ms burst and an unfiltered patch
    // would strobe; the emission itself is allowed to be that sharp because a
    // spark carries its own 0.2-0.8 s tail and the patch does not.
    st.glow = st.glow ?? 0;
    const glowTarget = clamp(glowStrike * 0.62, 0, 1.25);
    st.glow += (glowTarget - st.glow) * Math.min(1, dt * (glowTarget > st.glow ? 26 : 9));
    if (st.glow > 0.012 && lod > 0.45) {
      // Behind the rear skids, offset toward whichever pair is actually digging
      // in, and laid along the car's own axis so it agrees with the shower.
      const off = glowStrike > 1e-4 ? clamp(glowX / glowStrike, -0.30, 0.30) : 0;
      _q.copy(v.position).addScaledVector(_fwd, -2.05).addScaledVector(_rgt, off);
      // RIDE HEIGHT. `groundY` is the road under the car's CG; the patch is a
      // FLAT quad and the road it lies on is crowned, cambered and cresting, so
      // 14 mm was measured (green-tinted debug capture, 'hud') to be entirely
      // buried — not dim, absent. That is the whole of "the sparks cast no light
      // on the tarmac". 55 mm clears the road profile over the patch's length
      // everywhere the shower is actually visible, and because this is an edge-
      // free additive glow rather than a decal, floating it 5 cm reads as light
      // on the surface, not as a card above it.
      _q.y = groundY + 0.055;
      this._glow.request(_q, yaw, st.glow * lod, this.camera);
    }

    // --- exhaust heat haze ---------------------------------------------------
    if (lod > 0.9 && this._refractOK) {
      const throttle = v.controls.throttle ?? 0;
      const plume = 0.35 + throttle * 0.9;
      _p.copy(v.position).addScaledVector(_fwd, -2.52);
      _p.y += 0.47;
      _v.copy(_fwd).multiplyScalar(-2.5 - speed * 0.10);
      this.emitHeatHaze(_p, _v, plume * 16 * dt, {
        size: 0.13 + throttle * 0.10, jitter: 0.10, rise: 1.6, grow: 0.75,
        lifetime: 0.55 + throttle * 0.35, alpha: 0.55 + throttle * 0.45,
      });
      // Brake-duct and radiator exit heat off the sidepods at low speed.
      if (speed < 30) {
        _p.copy(v.position).addScaledVector(_fwd, 0.2);
        _p.y += 0.62;
        this.emitHeatHaze(_p, _v, 5 * dt, { size: 0.22, jitter: 0.55, rise: 1.1, alpha: 0.35 });
      }
    }
  }

  // -- ambient effects -----------------------------------------------------

  /** Shimmer over hot tarmac ahead of the camera, and wind streaks at speed. */
  _ambient(dt) {
    if (!this.camera) return;
    const cam = this.camera;
    cam.getWorldDirection(_tmp);

    if (this.tarmacShimmer > 0 && this._refractOK) {
      this._shimmerAcc += dt * 11 * this.tarmacShimmer;
      const n = Math.floor(this._shimmerAcc);
      this._shimmerAcc -= n;
      // SHIMMER IS A FAR-FIELD PHENOMENON. You see the road boil at 100 m; you
      // never see it on your own bonnet, because the effect is an integral along
      // a long grazing path through hot air. It was spawned at 30-120 m with a
      // 1.8-3.2 s life, and a chase camera closing at up to 93 m/s covers 280 m
      // in that time — so it overran its own shimmer layer every single frame and
      // the sprites finished their lives ON the lens. Push the layer out, scale
      // the push with how fast the camera is actually travelling, and shorten the
      // life so a sprite dies before the camera can reach it.
      const closing = Math.min(60, this._camVel.length() * 1.35);
      for (let i = 0; i < n; i++) {
        const dist = 58 + closing + this.rng() * 95;
        _p.copy(cam.position).addScaledVector(_tmp, dist);
        _p.x += (this.rng() - 0.5) * dist * 0.24;
        _p.z += (this.rng() - 0.5) * dist * 0.24;
        _p.y = this._playerPos.y + 0.15 + this.rng() * 0.85;
        _v.set(0, 0.35 + this.rng() * 0.35, 0);
        this.haze.spawn(_p, _v, {
          size: 0.7 + this.rng() * 1.3, grow: 0.45,
          lifetime: 1.1 + this.rng() * 0.9,
          // Now that REFRACT composites at the particle's own alpha this is a
          // real density, not a no-op: a 10% wobble, which is what a heat
          // boundary 100 m down a straight actually costs you.
          colour: [1, 1, 1], alpha: 0.10,
          seed: this.rng(), drag: 0.6, gravity: 0.2,
        });
      }
    }

    if (this.speedStreaks > 0 && this._speed01 > 0.45) {
      const k = (this._speed01 - 0.45) / 0.55;
      this._windAcc += dt * 190 * k * k * this.speedStreaks;
      const n = Math.floor(this._windAcc);
      this._windAcc -= n;
      const vmag = 30 + this._speed01 * 70;
      for (let i = 0; i < n; i++) {
        // A ring of air ahead of the camera that rushes past its edges.
        const a = this.rng() * Math.PI * 2;
        const rad = 5.0 + this.rng() * 9.0;    // out at the frame edges, clear of the car
        _p.copy(cam.position).addScaledVector(_tmp, 8 + this.rng() * 18);
        _p.x += Math.cos(a) * rad;
        _p.y += Math.sin(a) * rad * 0.62;
        _p.z += Math.sin(a) * rad * 0.5;
        _v.copy(_tmp).multiplyScalar(-vmag);
        this.wind.spawn(_p, _v, {
          size: 0.010 + this.rng() * 0.014, grow: 0,
          lifetime: 0.28 + this.rng() * 0.22,
          colour: [0.72, 0.80, 0.95],
          alpha: 0.35 + this.rng() * 0.4,
          seed: this.rng(), drag: 0.05, gravity: 0,
        });
      }
      this.wind.material.uniforms.uOpacity.value = 0.16 * k;
    } else {
      this.wind.material.uniforms.uOpacity.value = 0;
    }
  }

  // -- frame update --------------------------------------------------------

  /** Keep point sizes physical when the viewport or FOV changes. */
  setViewport(heightPx, fovDeg) {
    // gl_PointSize is in DRAWING-BUFFER pixels, so fold the pixel ratio in.
    const dpr = this.renderer ? this.renderer.getPixelRatio() : 1;
    const scale = (heightPx * dpr) / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) * 0.5));
    for (const p of this.pools) p.material.uniforms.uPixelScale.value = scale;
    return this;
  }

  setWetness(w) {
    this.wetness = clamp(w, 0, 1);
    this.spray.material.uniforms.uOpacity.value = clamp(this.wetness * 1.6, 0, 1);
    // Wet tarmac cannot smoke and does not shed dust.
    this.smoke.material.uniforms.uOpacity.value = 1 - this.wetness * 0.85;
    this.dust.material.uniforms.uOpacity.value = 1 - this.wetness * 0.9;
    return this;
  }

  /** Kill everything in flight (used when the field is teleported). */
  reset() {
    for (const p of this.pools) p.clear();
    this._glow.hide();
    this._shimmerAcc = this._windAcc = 0;
    // Per-car trail state is stale after a restage too — in particular the skid
    // travel history, which is differenced.
    for (const st of this._carState.values()) {
      st.skidReady = false;
      st.strike.fill(0);
      st.kerb = 0;
      st.glow = 0;
    }
    return this;
  }

  /**
   * Finite-difference the camera's own world velocity. Streak-rendered families
   * need it to smear along apparent rather than world motion; a cut, a reset or
   * a capture restage teleports the rig, so anything superluminal is discarded.
   */
  _trackCamera(dt) {
    if (!this.camera || dt <= 1e-5) return;
    this.camera.getWorldPosition(_cam);
    if (this._camPrevValid) {
      _q.subVectors(_cam, this._camPrev).divideScalar(dt);
      if (_q.lengthSq() > 4e4) _q.set(0, 0, 0);     // > 200 m/s: a teleport
      this._camVel.lerp(_q, 0.5);                    // one-pole smoothing
    }
    this._camPrev.copy(_cam);
    this._camPrevValid = true;
  }

  update(dt) {
    this._teleport = false;
    this.time += dt;
    this._trackCamera(dt);
    this._ambient(dt);
    this._syncLighting();
    this._glow.commit(this.scene.fog?.density ?? 0);

    const cam = this.camera ? this.camera.position : _cam.set(0, 0, 0);
    for (const p of this.pools) {
      p.step(dt, this.time, this.windX, this.windZ);
      p.reindex(cam);
    }
  }

  /**
   * Pull the sun, ambient, fog and depth buffer out of the live scene so the FX
   * grade themselves without the engine having to push anything at us.
   */
  _syncLighting() {
    const scene = this.scene;
    if (!this._sunLight || !this._sunLight.parent) {
      this._sunLight = scene.getObjectByProperty('isDirectionalLight', true) ?? null;
      this._hemi = scene.getObjectByProperty('isHemisphereLight', true) ?? null;
    }

    let sunI = 3.0;
    if (this._sunLight) {
      _sun.copy(this._sunLight.position);
      if (this._sunLight.target) _sun.sub(this._sunLight.target.position);
      _sun.normalize();
      sunI = this._sunLight.intensity;
    } else {
      _sun.set(0.4, 0.85, 0.3).normalize();
    }
    if (this.camera) _sun.transformDirection(this.camera.matrixWorldInverse);

    const fog = scene.fog;
    let depth = null;
    if (this.postfx?.aoPass?.enabled) depth = this.postfx.aoPass.depthTexture ?? null;

    let res = null;
    if (this.renderer) {
      res = this.renderer.getDrawingBufferSize(_res);
      this._resizeRefraction(res.x, res.y);
    }

    // The engine keeps `scene.fog.color` locked to the sky radiance, which makes
    // it the cheapest honest proxy for the ambient a smoke puff actually sees —
    // the real ambient here is the PMREM sky, not the (weak) hemisphere fill.
    if (fog) _amb.copy(fog.color).multiplyScalar(this.ambientScale);
    else if (this._hemi) _amb.copy(this._hemi.color).multiplyScalar(this._hemi.intensity);
    else _amb.setRGB(0.45, 0.52, 0.68);

    for (const p of this.pools) {
      const u = p.material.uniforms;
      u.uSunDir.value.copy(_sun);
      if (this._sunLight) {
        // Smoke is optically thin: the direct term is a fraction of what a
        // surface receives, or the puffs blow out to featureless white.
        u.uSunColour.value.copy(this._sunLight.color).multiplyScalar(sunI * this.sunScale);
      }
      u.uAmbColour.value.copy(_amb);
      if (this._hemi) u.uGroundColour.value.copy(this._hemi.groundColor).multiplyScalar(0.8);
      if (fog) {
        u.uFogColour.value.copy(fog.color);
        u.uFogDensity.value = fog.density ?? 0;
      } else {
        u.uFogDensity.value = 0;
      }
      u.uTime.value = this.time;
      u.uCamVel.value.copy(this._camVel);
      u.uDepth.value = depth;
      u.uSoftOn.value = depth ? 1 : 0;
      if (res) {
        u.uRes.value.set(res.x, res.y);
        u.uHalfRes.value.set(res.x * 0.5, res.y * 0.5);
      }
      if (this.camera) {
        u.uNear.value = this.camera.near;
        u.uFar.value = this.camera.far;
      }
    }
  }

  dispose() {
    for (const p of this.pools) p.dispose();
    this._glow.dispose();
    for (const t of this._textures) t.dispose();
    this._sceneCopy?.dispose();
    this._carState.clear();
  }
}
