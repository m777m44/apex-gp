/**
 * APEX GP — engine core.
 *
 * Owns the renderer, the scene, the fixed-timestep simulation loop and the
 * `window.__APEX__` capture contract. Every other subsystem is constructed
 * here and wired through explicit references — there is no global service
 * locator, so a specialist can always follow the data.
 *
 * SIMULATION MODEL
 *   Physics, AI and the race session run at a FIXED 1/60 s step. Rendering runs
 *   as fast as the display allows and interpolates the leftover accumulator, so
 *   the sim is frame-rate independent and captures are byte-reproducible.
 *
 * CAPTURE CONTRACT (implemented exactly as tools/shot.mjs expects)
 *   window.__APEX__ = {
 *     ready,                          true once sky, IBL and all assets exist
 *     pause(),                        stops rAF; frames become manual
 *     capture(shotName, frameIndex),  async; poses camera + sim deterministically
 *     renderFrame(i),                 advances the sim by exactly 1/60 and renders
 *     settle(),                       async; awaits PMREM + shader compilation
 *   }
 *
 * SHOT NAMES: chase, cockpit, tv, beauty, wide, grid, wheel, front, hud
 */

import * as THREE from 'three';

import { assets } from './assets.js';
import { Input } from './input.js';
import { Sky } from '../render/sky.js';
import { Lighting } from '../render/lighting.js';
import { PostFX } from '../render/postfx.js';
import { Circuit } from '../track/circuit.js';
import { Environment } from '../track/environment.js';
import { OpponentField, AIDriver } from '../ai/opponents.js';
import { fullGrid } from '../car/livery.js';
import { CameraRig } from '../camera/cameras.js';
import { HUD } from '../hud/hud.js';
import { Particles } from '../fx/particles.js';
import { EngineAudio } from '../audio/engine.js';
import { Weather } from '../weather/weather.js';
import { RaceSession } from '../game/race.js';
import { applyWakes } from '../physics/vehicle.js';
import { clamp, makeRng, hashSeed } from './rng.js';

export const FIXED_DT = 1 / 60;

/** Module-level scratch — nothing on the per-frame path may allocate. */
const _camVel = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _tmp = new THREE.Vector3();

/**
 * Camera modes that are bolted to the car. These get onboard-footage treatment
 * (long shutter, vanishing-point smear); everything else is a broadcast camera.
 */
const ONBOARD_MODES = new Set(['chase', 'cockpit', 'halo', 'bumper']);

// ---------------------------------------------------------------------------
// DETERMINISTIC CAPTURE  (the number every review this round is measured with)
// ---------------------------------------------------------------------------
//
// The contract at the top of this file promises captures are reproducible. They
// were not. MEASURED, two `capture('chase')` calls back to back inside ONE page
// load, 150 warm frames each:
//
//   run A   trackS 4544.94   lateral 6.696   speed 51.18
//   run B   trackS 4546.38   lateral 6.417   speed 50.28
//
// 1.44 m apart, and since a chase camera is bolted to the car that is the WHOLE
// WORLD shifted 1.44 m under a fixed frame: 99.0% of pixels differ, mean channel
// delta 62.8/765. Two separate `tools/shot.mjs` runs of the same build came out
// +37 / -37 luma apart in the near-tarmac cells of `tools/compare.mjs --grid 4`.
// That is several times the size of the regressions the reviewers are asking us
// to measure — the gate was reporting noise.
//
// Two causes, both "state that outlives a restage":
//
//  1. THE DRIVERS ARE STATEFUL. `AIDriver` holds a seeded PRNG *stream*, plus
//     `time`, the tactical/attack/defend timers and a `mistake` object.
//     `vehicle.reset()` cannot see any of it, so capture N+1 starts every driver
//     mid-stream with capture N's noise, and 2.5 s of racing amplifies that into
//     more than a car length. The engine's own autopilot (`_autoDriver`, which
//     drives the PLAYER in every capture) is the worst offender because the
//     player is the subject of the frame.
//  2. THE SIM RUNS BEFORE THE HARNESS EVER PAUSES IT. `main.js` starts the rAF
//     loop as soon as `init()` resolves; `tools/shot.mjs` only calls `pause()`
//     after `ready` goes true and the browser hands it back a turn. However many
//     wall-clock frames land in that window is a coin flip, and they burn fuel,
//     wear tyres, heat brakes and advance every PRNG.
//
// So: snapshot the mutable sim state ONCE, at the end of `init()` — the last
// moment the world is pristine — and restore it at the top of every `capture()`.
//
// The snapshot walks *leaves only* and restores them into the objects that are
// already there: it never replaces a reference, so live scene graph, geometry,
// materials and circuit samples cannot be touched by it even by accident.
// Anything shared or structural is refused by `SNAP_SKIP`; anything not a
// number/boolean/string/vector/typed array is not copied at all.
//
/** Keys never followed: shared world references, scene graph, big lookups. */
const SNAP_SKIP = new Set([
  'circuit', 'scene', 'camera', 'renderer', 'engine', 'field', 'session', 'weather',
  'sky', 'lighting', 'rig', 'particles', 'audio', 'hud', 'postfx', 'environment',
  'profile', 'line', 'samples', 'model', 'group', 'materials', 'wheels', 'entry',
  'team', 'driver', 'geometry', 'material', 'texture', 'map', 'parent', 'children',
  'vehicle', 'ai', 'cars', 'rivals', 'target', 'pose', 'surfaceProbe', 'trace',
  // The front end is a DOM tree. Walking it would be pointless and slow, and
  // `_snapshotSim()` runs during boot of the LIVE game too, not just captures.
  'frontEnd', 'ui', 'container', 'dom', 'element', 'canvas', 'input',
]);

/** True for objects that are values (copied) rather than structure (skipped). */
function isSnapVector(v) {
  return v.isVector2 || v.isVector3 || v.isVector4 || v.isQuaternion || v.isEuler || v.isColor;
}

/**
 * Deep-copy the *value* leaves of `o`. Returns a plain tree; `null` for
 * anything structural. `depth` bounds the walk so a stray back-reference that
 * slipped past SNAP_SKIP cannot run away.
 */
function snapState(o, depth = 4) {
  if (!o || typeof o !== 'object') return null;
  const out = {};
  for (const k of Object.keys(o)) {
    if (SNAP_SKIP.has(k)) continue;
    const v = o[k];
    const t = typeof v;
    if (v === null || v === undefined || t === 'number' || t === 'boolean' || t === 'string') { out[k] = v; continue; }
    if (t === 'function' || t === 'symbol') continue;
    if (ArrayBuffer.isView(v)) { out[k] = v.slice(); continue; }
    if (Array.isArray(v)) {
      if (v.every((x) => x === null || typeof x !== 'object')) out[k] = v.slice();
      else if (depth > 0) out[k] = v.map((x) => snapState(x, depth - 1));
      continue;
    }
    if (isSnapVector(v)) { out[k] = v.toArray(); continue; }
    if (v.isObject3D || v.isMaterial || v.isTexture || v.isBufferGeometry || v instanceof Map || v instanceof Set) continue;
    if (depth > 0) out[k] = snapState(v, depth - 1);
  }
  return out;
}

/** Write a `snapState` tree back into the live object, in place. */
function restoreState(o, snap, depth = 4) {
  if (!o || !snap || typeof o !== 'object') return;
  for (const k of Object.keys(snap)) {
    const s = snap[k];
    const v = o[k];
    if (s === null || s === undefined || typeof s !== 'object') { o[k] = s; continue; }
    if (ArrayBuffer.isView(s)) { if (ArrayBuffer.isView(v) && v.length === s.length) v.set(s); continue; }
    // A vector snapshots AS an array, so it has to be recognised before the
    // array branch or it is silently dropped (which is how a restore quietly
    // leaves the car's world position at the previous capture's value).
    if (Array.isArray(s) && v && typeof v === 'object' && isSnapVector(v)) { v.fromArray(s); continue; }
    if (Array.isArray(s)) {
      if (!Array.isArray(v)) continue;
      for (let i = 0; i < s.length && i < v.length; i++) {
        const si = s[i];
        if (si === null || typeof si !== 'object') v[i] = si;
        else if (depth > 0) restoreState(v[i], si, depth - 1);
      }
      continue;
    }
    if (!v || typeof v !== 'object') continue;
    if (depth > 0) restoreState(v, s, depth - 1);
  }
}

// ---------------------------------------------------------------------------
// CAR LEVEL OF DETAIL  (the renderer's single biggest cost, measured)
// ---------------------------------------------------------------------------
//
// PROFILE, 1600x900, `grid`, before this existed:
//   2792 draw calls / 11.18 M triangles per frame, split
//     971 calls  G-buffer prepass  (postfx: depth + normal + velocity)
//     986 calls  colour pass
//     809 calls  four shadow cascades
//      26 calls  post-process quads
//   Of the ~980 meshes in a scene pass, **856 were cars** — 82 calls for one
//   opponent and 154 for the player, because a car is 41 (low) / 81 (high)
//   separate meshes and every one of them is submitted three times a frame
//   (prepass, colour, ~2.5 cascades). The environment is only ~120 calls; the
//   review's diagnosis that "~2800 calls are environment" is simply wrong, and
//   merging trackside chunks would have reclaimed almost nothing.
//
// Per corner a wheel is tyre + sidewall band + rim + brake disc + upright +
// caliper + duct = 7 meshes, and at 100 m a caliper is six pixels across. This
// is a level-of-detail problem, not a batching problem: the fix is to stop
// submitting geometry that lands on less than a pixel.
//
// The ladder is expressed in RENDERED PIXELS subtended by the car, never in
// metres, so it is correct at any resolution and — critically — at any focal
// length: a car 60 m away fills half the frame through the `tv` long lens and
// must stay at full detail, while the same car at the same distance in a 62 deg
// chase view is 110 px and does not.
//
// The boundaries are set from the size the DROPPED part reaches, not from the
// size of the car — at 280 px the car is 54 px per metre, so a brake caliper is
// 12 px and a rear-wing sponsor is still legible; at 160 px they are 7 px and
// mush. Verified by A/B capture (`?lod=0`): in `grid`, where the field spans
// 71..226 px, the two frames are indistinguishable at 4x zoom.
//
//   tier 0  >= 280 px   everything
//   tier 1  160..280    - marbles, sponsor decals, brake disc, upright,
//                         caliper, brake duct
//   tier 2   60..160    - sidewall band, glass, rain light, exhaust,
//                         dark metal, suspension links
//   tier 3  <  60 px    - cockpit trim, helmet
//
// The tyre and the rim face are never dropped: the tyre is a LatheGeometry that
// runs bead to bead, so it is open at the hub, and hiding the rim would leave a
// hole you can see the world through.
const CAR_LOD_PX = [280, 160, 60];
/** Deadband on the tier boundaries — a car sitting on one must not flicker. */
const CAR_LOD_HYST = 1.15;
/** Half the car's diagonal; the sphere the pixel size is measured from. */
const CAR_LOD_RADIUS = 2.6;
/**
 * Slack on the off-frustum cull. A hidden car casts no shadow, so the margin
 * has to be larger than the furthest a shadow can travel from its caster:
 * body height / tan(sun elevation), i.e. 5.7 m at 10 deg. 14 m is safe at every
 * time of day the game uses and still culls the ~16 cars behind a chase camera.
 */
const CAR_LOD_MARGIN = 14;

/** Coarsest tier at which each `body:*` bucket still draws. */
const BODY_LOD = {
  paint: 3, carbonMatte: 3, carbon: 3,
  cockpitTrim: 2, helmet: 2,
  glass: 1, darkMetal: 1, exhaust: 1, rainLight: 1,
};

/**
 * Coarsest tier at which each `body:*` bucket still CASTS. A shadow is a
 * silhouette: past ~55 m (tier 2) the only thing a mirror housing, an exhaust
 * trumpet or a rain light contributes to the blob on the tarmac is a draw call.
 * The paint / carbon shells and the tyres carry the whole silhouette.
 */
const BODY_SHADOW_LOD = {
  paint: 3, carbonMatte: 3, carbon: 3,
  cockpitTrim: 1, helmet: 1,
  glass: 0, darkMetal: 1, exhaust: 0, rainLight: 0,
};

/**
 * Metres from the camera past which nothing needs to cast at all. This is a
 * cheap conservative early-out in front of three's own per-cascade frustum
 * cull, and it has to be derived from the cascades or it eats real shadows.
 *
 * `lighting.js` compiles `CASCADE_FAR = 260` into the shader and fits each
 * cascade to the BOUNDING SPHERE of its frustum slice, so the last cascade's
 * box is centred near 260 m with a ~164 m radius and therefore reaches ~424 m
 * down the view axis, plus light-space headroom in front of it for casters
 * standing outside the box. 620 m clears all of that.
 *
 * MEASURED THE HARD WAY: at 320 m — which is what "past the cascade far plane"
 * naively suggests — the `wide` establishing shot lost the self-shadow under
 * the marshal cabin roof at ~400 m and the structure read flat. The shot is
 * elevated and the camera sits a long way from the subject; the cascade ladder
 * is anchored to the CAMERA, not to the car.
 */
const SHADOW_CAST_RANGE = 620;

/**
 * Screen-size level of detail and off-frustum culling for the twenty cars.
 *
 * Owns nothing but `Object3D.visible`, and only on parts it has resolved by
 * IDENTITY (`w.tyreMat`, `w.discMat`, `w.marbles`, `w.blurPlane`) or by the
 * documented `body:<bucket>` names — never by guessing at child order. It does
 * not touch `castShadow`: an invisible mesh is already skipped by the shadow
 * pass, and leaving the flags alone means nothing can be left permanently off.
 *
 * `wheels.js` owns the marble gate (`pickup > 0.02`) and the wheel blur plane,
 * so this reproduces the former and never writes the latter.
 */
class CarLOD {
  constructor() {
    this._tables = new WeakMap();
    this._frustum = new THREE.Frustum();
    this._mat = new THREE.Matrix4();
    this._sphere = new THREE.Sphere(new THREE.Vector3(), CAR_LOD_RADIUS + CAR_LOD_MARGIN);
    /** Debug read-back, published through `stats()`. */
    this.tiers = [0, 0, 0, 0];
    this.offscreen = 0;
  }

  /** Flat `[mesh, maxTier, ...]` table for one car model. Built once, cached. */
  _table(model) {
    let t = this._tables.get(model);
    if (t) return t;
    const parts = [];
    const marbles = [];
    /** Flat `[mesh, maxShadowTier]`, every mesh that had `castShadow` set. */
    const casters = [];
    const add = (o, tier, shadowTier = tier) => {
      if (!o) return;
      parts.push(o, tier);
      if (o.castShadow) casters.push(o, Math.min(tier, shadowTier));
    };
    /** Always-drawn parts (tyre, rim face) still take part in shadow grading. */
    const addCaster = (o, shadowTier) => { if (o && o.castShadow) casters.push(o, shadowTier); };

    for (const child of model.group.children) {
      const n = child.name || '';
      if (n.startsWith('body:')) {
        const bucket = n.slice(5);
        add(child, BODY_LOD[bucket] ?? 3, BODY_SHADOW_LOD[bucket] ?? 3);
      } else if (n === 'teamDecals') add(child, 0);
    }

    const set = model.wheels;
    if (set && set.wheels) {
      for (const w of set.wheels) {
        let seenBand = false;
        for (const o of w.spinGroup.children) {
          if (!o.isMesh && !o.isInstancedMesh) continue;
          if (o === w.marbles) { marbles.push(o); continue; }
          if (o.material === w.tyreMat) { addCaster(o, 3); continue; }  // the tyre always draws
          if (o.material === w.discMat) { add(o, 0); continue; }
          if (!seenBand) { seenBand = true; add(o, 1); continue; }   // sidewall band
          // rim barrel / cover / nut — the wheel face. Never dropped, but past
          // tier 1 it is entirely inside the tyre's own shadow.
          addCaster(o, 1);
        }
        for (const o of w.steerPivot.children) {
          if (!o.isMesh || o === w.blurPlane) continue;
          add(o, 0);                                          // upright, caliper, duct
        }
      }
      // Suspension linkage: per-link aerofoils (high) or one merged mesh (low).
      for (const o of set.group.children) if (o.isMesh) add(o, 1, 0);
    }

    t = { parts, marbles, casters, set };
    this._tables.set(model, t);
    return t;
  }

  /**
   * @param {Array} cars      `field.cars`
   * @param {THREE.PerspectiveCamera} camera  matrices must already be current
   * @param {number} heightPx viewport height in CSS pixels
   * @param {boolean} enabled `?lod=0` turns the whole thing off for A/B work
   */
  update(cars, camera, heightPx, enabled = true) {
    this.tiers[0] = this.tiers[1] = this.tiers[2] = this.tiers[3] = 0;
    this.offscreen = 0;
    // Pixels a 1 m object subtends at 1 m distance.
    const pxPerM = heightPx / (2 * Math.tan(camera.fov * Math.PI / 360));
    this._frustum.setFromProjectionMatrix(
      this._mat.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
    );

    for (const car of cars) {
      const model = car.model;
      const group = model.group;
      this._sphere.center.copy(group.position);
      if (enabled && !this._frustum.intersectsSphere(this._sphere)) {
        group.visible = false;
        this.offscreen++;
        continue;
      }
      group.visible = true;

      const table = this._table(model);
      let tier = 0;
      if (enabled) {
        const dist = Math.max(1e-3, group.position.distanceTo(camera.position));
        const px = 2 * CAR_LOD_RADIUS * pxPerM / dist;
        const cur = model.__lodTier ?? 0;
        tier = px >= CAR_LOD_PX[0] ? 0 : px >= CAR_LOD_PX[1] ? 1 : px >= CAR_LOD_PX[2] ? 2 : 3;
        if (tier > cur && px > CAR_LOD_PX[cur] / CAR_LOD_HYST) tier = cur;
        else if (tier < cur && px < CAR_LOD_PX[tier] * CAR_LOD_HYST) tier = cur;
      }
      model.__lodTier = tier;
      this.tiers[tier]++;

      const parts = table.parts;
      for (let i = 0; i < parts.length; i += 2) parts[i].visible = tier <= parts[i + 1];
      const pickup = table.set ? table.set.pickup > 0.02 : false;
      for (const m of table.marbles) m.visible = tier === 0 && pickup;

      // SHADOW LOD. Cars were 478 of the 633 shadow-pass draw calls, because
      // every one of the ~16 meshes a car still draws at tier 2 was submitted
      // again into each cascade it touched. A shadow only needs the silhouette:
      // grade the casters on their own, coarser ladder, and stop casting
      // entirely past the cascade ladder's reach.
      const inRange = !enabled || group.position.distanceTo(camera.position) < SHADOW_CAST_RANGE;
      const casters = table.casters;
      for (let i = 0; i < casters.length; i += 2) {
        casters[i].castShadow = inRange && tier <= casters[i + 1];
      }
    }
  }

  /**
   * Put every car back to full detail. `renderer.compile()` walks the scene with
   * `traverseVisible`, so a shader whose mesh happens to be LOD'd out at settle
   * time never gets compiled and hitches later, when the car closes on the
   * camera. `settle()` calls this first.
   */
  forceFull(cars) {
    for (const car of cars) {
      const table = this._table(car.model);
      car.model.group.visible = true;
      car.model.__lodTier = 0;
      const parts = table.parts;
      for (let i = 0; i < parts.length; i += 2) parts[i].visible = true;
      const pickup = table.set ? table.set.pickup > 0.02 : false;
      for (const m of table.marbles) m.visible = pickup;
      const casters = table.casters;
      for (let i = 0; i < casters.length; i += 2) casters[i].castShadow = true;
    }
  }
}

// ---------------------------------------------------------------------------
// WORLD CHUNKING  (the environment's half of the frame budget)
// ---------------------------------------------------------------------------
//
// PROFILE, 1600x900, `grid`, before this existed — attributed by wrapping
// `renderer.renderBufferDirect` and walking each object's ancestor chain:
//
//   pass          calls   triangles
//   shadow          633     6.46 M      <- four cascades
//   G-buffer        487     3.73 M      <- postfx depth+normal+velocity prepass
//   colour          442     3.36 M
//   TOTAL          1562    13.56 M
//
// Of the 13.56 M, 5.13 M was the ENVIRONMENT INSIDE THE SHADOW PASS: single
// draws whose bounds span the whole 4.8 km circuit, so three's per-cascade
// frustum cull can never reject them and each one is submitted into all four
// cascades at full triangle count. `SpectatorEstate/ParkedCars` alone is 1675
// instances / 274 k triangles, drawn 4x for a car park nobody is looking at.
// `Trackside/BarrierPosts` is 5002 instances / 240 k, `Circuit/TrackSurface`
// 203 k in one call that covers every corner of the lap at once.
//
// So the review's diagnosis — "something trackside is not instanced or is split
// per chunk far too finely" — is exactly inverted. Everything IS instanced, and
// that is the problem: an InstancedMesh has ONE bounding sphere, so instancing a
// set across the whole circuit converts twenty cullable objects into one
// uncullable one. The fix is to split, not to merge. `environment.js` already
// arcs its trackside furniture into 14 chunks for precisely this reason; the
// track-wide sets never got the same treatment.
//
// This does it generically and from the outside, so no other specialist's file
// has to change:
//   * InstancedMesh  -> N InstancedMeshes over a spatial bucket of the instance
//                       transforms, with instanceMatrix / instanceColor / any
//                       custom InstancedBufferAttribute sliced to match.
//   * indexed Mesh   -> N Meshes that SHARE the original vertex buffers and own
//                       only a subset of the index. One GPU upload, N cullable
//                       objects; an indexed draw only fetches the vertices its
//                       own index references, so the vertex cost splits too.
// Bounds are computed from the chunk's own contents (three's
// `computeBoundingSphere` ignores the index, so it cannot be used here) and
// padded, because several of these materials displace in the vertex shader.
//
// `?chunk=0` restores the original meshes for A/B measurement.

/** Below this a mesh is already cheap enough that another draw call costs more. */
const CHUNK_MIN_TRIS = 12000;
/**
 * Aim for roughly this many triangles per chunk. Measured at `grid`, 1080p,
 * over 9000 / 14000 / 20000: the triangle saving is flat across that range
 * (the cull is dominated by WHICH corner of the circuit you are looking at,
 * not by the cell size) while the draw-call cost is linear in chunk count.
 */
const CHUNK_TARGET_TRIS = 16000;
/** Hard ceiling on chunks per source mesh — chunking must not cost more calls. */
const CHUNK_MAX = 14;
/**
 * Metres of bounding-sphere slack. Two jobs, and the second sets the number:
 *  1. crowd bob, grass wind and tree sway displace in the vertex shader, so a
 *     mathematically exact bound pops at the frustum edge;
 *  2. a little slack in the caster direction is free — chunks are 60-200 m
 *     across, so 6 m of pad changes nothing measurable in the colour pass.
 *
 * KNOWN, ACCEPTED COST. The CSM's last cascade is the SHADER's catch-all for
 * everything past `CASCADE_FAR` (260 m), but its box is only fitted to that
 * frustum slice — so geometry well beyond it used to be shadowed anyway, purely
 * because its whole-circuit bounding sphere dragged it into the cascade and
 * nothing was ever culled. With tight bounds three culls it correctly and the
 * self-shadow under far structures goes. Measured in `wide` (an elevated shot
 * whose subject sits ~400 m from the camera): 0.19% of pixels change, the
 * marshal-post canopy reads about two levels lighter. Padding does not recover
 * it (tried at 12 m) because those chunks are genuinely outside the box; the
 * real fix is a fifth, coarse cascade, which lives in `render/lighting.js`.
 */
const CHUNK_PAD = 6;

/**
 * Names that must survive as single objects because something outside
 * `environment.js` looks them up or holds a reference:
 *   `MarshalPosts`  — `game/race.js` rewrites its `aCell` instance attribute.
 *   `Grandstands`   — `audio/engine.js` reads `environment.grandstands`.
 *   `Crowd`         — `environment.crowd`, and it is `frustumCulled = false`.
 *   `StartLights`   — `environment.setStartLights()` writes its instanceColor.
 */
const CHUNK_PROTECT = /MarshalPosts|Grandstand|Crowd|StartLight|Flag/i;

const _bsA = new THREE.Sphere();
const _boxA = new THREE.Box3();
const _vA = new THREE.Vector3();
const _mA = new THREE.Matrix4();

/**
 * Spatially bucket `n` items whose XZ centroids are `cx`/`cz`, targeting
 * `want` buckets. Returns an array of Uint32Array index lists (never empty).
 *
 * A uniform XZ grid rather than a k-d tree: the world is a 4.8 km ribbon, so
 * the overwhelming majority of cells are empty and get dropped for free, and
 * the whole thing is O(n) instead of O(n log n) on a 200 k-triangle terrain.
 */
function bucketXZ(n, cx, cz, want) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    if (cx[i] < minX) minX = cx[i];
    if (cx[i] > maxX) maxX = cx[i];
    if (cz[i] < minZ) minZ = cz[i];
    if (cz[i] > maxZ) maxZ = cz[i];
  }
  const span = Math.max(maxX - minX, maxZ - minZ, 1);
  // Seed from the ribbon's own scale, then coarsen until the bucket count is
  // inside budget. Occupied cells are a fraction of the grid, so this converges
  // in two or three steps.
  let cell = Math.max(24, span / Math.max(2, Math.sqrt(want) * 3));
  let out = null;
  for (let guard = 0; guard < 12; guard++) {
    const map = new Map();
    const cols = Math.max(1, Math.ceil(span / cell) + 1);
    for (let i = 0; i < n; i++) {
      const gx = ((cx[i] - minX) / cell) | 0;
      const gz = ((cz[i] - minZ) / cell) | 0;
      const key = gz * cols + gx;
      let list = map.get(key);
      if (!list) map.set(key, (list = []));
      list.push(i);
    }
    out = [...map.values()];
    if (out.length <= want) break;
    cell *= 1.7;
  }
  if (out.length < 2) return null;

  // A grid over a ribbon leaves a long tail of nearly empty cells, and a cell
  // holding forty triangles still costs a full draw call in three passes. Fold
  // anything under a quarter of the target into its nearest surviving
  // neighbour: all of the culling, none of the tail.
  const floor = Math.max(1, (n / want) * 0.25);
  const cen = out.map((l) => {
    let x = 0, z = 0;
    for (const i of l) { x += cx[i]; z += cz[i]; }
    return [x / l.length, z / l.length];
  });
  for (;;) {
    if (out.length <= 2) break;
    let worst = -1;
    for (let i = 0; i < out.length; i++) {
      if (out[i].length >= floor) continue;
      if (worst < 0 || out[i].length < out[worst].length) worst = i;
    }
    if (worst < 0) break;
    let best = -1, bestD = Infinity;
    for (let i = 0; i < out.length; i++) {
      if (i === worst) continue;
      const dx = cen[i][0] - cen[worst][0], dz = cen[i][1] - cen[worst][1];
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    const a = out[best].length, b = out[worst].length;
    cen[best] = [(cen[best][0] * a + cen[worst][0] * b) / (a + b),
      (cen[best][1] * a + cen[worst][1] * b) / (a + b)];
    out[best] = out[best].concat(out[worst]);
    out.splice(worst, 1); cen.splice(worst, 1);
  }
  if (out.length < 2) return null;
  return out.map((l) => Uint32Array.from(l));
}

/** A BufferGeometry that shares `src`'s vertex buffers but owns `index`. */
function shareGeometry(src, index, instancePick) {
  const g = new THREE.BufferGeometry();
  if (index !== null) g.setIndex(index);
  else if (src.index) g.setIndex(src.index);
  for (const name in src.attributes) {
    const a = src.attributes[name];
    if (a.isInstancedBufferAttribute && instancePick) {
      const it = a.itemSize;
      const dst = new a.array.constructor(instancePick.length * it);
      for (let k = 0; k < instancePick.length; k++) {
        const s = instancePick[k] * it;
        for (let c = 0; c < it; c++) dst[k * it + c] = a.array[s + c];
      }
      const na = new THREE.InstancedBufferAttribute(dst, it, a.normalized);
      na.setUsage(a.usage);
      g.setAttribute(name, na);
    } else {
      g.setAttribute(name, a);   // shared — one GPU upload for every chunk
    }
  }
  return g;
}

/** Tight bounds over the vertices actually referenced by `index`. */
function boundsFromIndex(position, index, out) {
  out.makeEmpty();
  for (let i = 0; i < index.length; i++) {
    const v = index[i] * 3;
    _vA.set(position.array[v], position.array[v + 1], position.array[v + 2]);
    out.expandByPoint(_vA);
  }
  return out;
}

/**
 * Split one oversized mesh. Returns the replacement meshes, or null if the mesh
 * is not a safe or worthwhile candidate.
 */
function chunkMesh(mesh) {
  const geo = mesh.geometry;
  const mat = mesh.material;
  if (!geo || !mat || Array.isArray(mat)) return null;       // multi-material groups
  if (geo.groups && geo.groups.length > 1) return null;
  if (geo.morphAttributes && Object.keys(geo.morphAttributes).length) return null;
  if (mat.transparent) return null;                          // splitting reorders blending
  const pos = geo.attributes.position;
  if (!pos) return null;

  const baseTris = (geo.index ? geo.index.count : pos.count) / 3;

  // --- instanced ------------------------------------------------------------
  if (mesh.isInstancedMesh) {
    const n = mesh.count;
    if (n < 16 || baseTris * n < CHUNK_MIN_TRIS) return null;
    const cx = new Float32Array(n), cz = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      mesh.getMatrixAt(i, _mA);
      cx[i] = _mA.elements[12];
      cz[i] = _mA.elements[14];
    }
    const want = Math.min(CHUNK_MAX, Math.max(2, Math.round(baseTris * n / CHUNK_TARGET_TRIS)));
    const buckets = bucketXZ(n, cx, cz, want);
    if (!buckets) return null;

    const out = [];
    for (const pick of buckets) {
      const g = shareGeometry(geo, null, pick);
      const im = new THREE.InstancedMesh(g, mat, pick.length);
      for (let k = 0; k < pick.length; k++) {
        mesh.getMatrixAt(pick[k], _mA);
        im.setMatrixAt(k, _mA);
      }
      im.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) {
        const src = mesh.instanceColor.array;
        const dst = new Float32Array(pick.length * 3);
        for (let k = 0; k < pick.length; k++) {
          dst[k * 3] = src[pick[k] * 3];
          dst[k * 3 + 1] = src[pick[k] * 3 + 1];
          dst[k * 3 + 2] = src[pick[k] * 3 + 2];
        }
        im.instanceColor = new THREE.InstancedBufferAttribute(dst, 3);
        im.instanceColor.needsUpdate = true;
      }
      im.computeBoundingSphere();
      if (im.boundingSphere) im.boundingSphere.radius += CHUNK_PAD;
      out.push(im);
    }
    return out;
  }

  // --- indexed / non-indexed regular mesh ----------------------------------
  if (!mesh.isMesh || baseTris < CHUNK_MIN_TRIS) return null;
  const nTris = baseTris | 0;
  const idx = geo.index;
  const cx = new Float32Array(nTris), cz = new Float32Array(nTris);
  const px = pos.array;
  const at = (t, c) => (idx ? idx.getX(t * 3 + c) : t * 3 + c);
  for (let t = 0; t < nTris; t++) {
    const a = at(t, 0) * 3, b = at(t, 1) * 3, c = at(t, 2) * 3;
    cx[t] = (px[a] + px[b] + px[c]) / 3;
    cz[t] = (px[a + 2] + px[b + 2] + px[c + 2]) / 3;
  }
  const want = Math.min(CHUNK_MAX, Math.max(2, Math.round(nTris / CHUNK_TARGET_TRIS)));
  const buckets = bucketXZ(nTris, cx, cz, want);
  if (!buckets) return null;

  const out = [];
  for (const pick of buckets) {
    const index = new Uint32Array(pick.length * 3);
    for (let k = 0; k < pick.length; k++) {
      index[k * 3] = at(pick[k], 0);
      index[k * 3 + 1] = at(pick[k], 1);
      index[k * 3 + 2] = at(pick[k], 2);
    }
    const g = shareGeometry(geo, new THREE.BufferAttribute(index, 1), null);
    // three's computeBoundingSphere ignores the index and would hand back the
    // parent mesh's bounds — which is the very thing that made this uncullable.
    boundsFromIndex(pos, index, _boxA);
    g.boundingBox = _boxA.clone();
    g.boundingSphere = _boxA.getBoundingSphere(new THREE.Sphere());
    g.boundingSphere.radius += CHUNK_PAD;
    out.push(new THREE.Mesh(g, mat));
  }
  return out;
}

/**
 * Re-chunk every oversized static mesh under `roots`, in place.
 *
 * @returns {{ chunks: Array, replaced: number, before: number, after: number }}
 *   `chunks` is every static world mesh with a world-space bounding sphere,
 *   which is what the per-frame shadow-caster gate iterates.
 */
function chunkWorld(roots) {
  const chunks = [];
  const log = [];
  let replaced = 0, before = 0, after = 0;
  for (const root of roots) {
    root.updateMatrixWorld(true);
    const jobs = [];
    root.traverse((o) => {
      if (!o.isMesh && !o.isInstancedMesh) return;
      let cur = o;
      while (cur && cur !== root.parent) {
        if (CHUNK_PROTECT.test(cur.name || '')) return;
        cur = cur.parent;
      }
      jobs.push(o);
    });
    for (const o of jobs) {
      before++;
      const parts = chunkMesh(o);
      if (!parts) { after++; continue; }
      replaced++;
      after += parts.length;
      log.push(`${o.name || '?'}${o.isInstancedMesh ? `[${o.count}]` : ''}->${parts.length}`);
      for (const p of parts) {
        p.name = o.name;
        p.position.copy(o.position);
        p.quaternion.copy(o.quaternion);
        p.scale.copy(o.scale);
        p.castShadow = o.castShadow;
        p.receiveShadow = o.receiveShadow;
        p.renderOrder = o.renderOrder;
        p.layers.mask = o.layers.mask;
        p.userData = o.userData;
        p.frustumCulled = true;
        p.matrixAutoUpdate = o.matrixAutoUpdate;
        o.parent.add(p);
      }
      o.parent.remove(o);
      o.__apexChunked = parts;
    }
  }
  // Second walk: cache a WORLD-space bounding sphere on every static mesh, so
  // the per-frame caster gate is a distance compare and never touches matrices.
  for (const root of roots) {
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      if (!o.isMesh && !o.isInstancedMesh) return;
      if (!o.castShadow) return;
      // AN INSTANCED MESH MUST BE MEASURED THROUGH `InstancedMesh`, NOT THROUGH
      // ITS GEOMETRY. `geometry.boundingSphere` is one 3 m fence post at the
      // local origin; the object's own `boundingSphere` is the hull of all 5002
      // instance transforms. Reading the geometry here handed the gate a tiny
      // sphere at the world origin, which for anything far from the middle of
      // the circuit reads as "beyond 620 m" and switches its shadow off for
      // good. three computes this lazily on the first frustum test, so at this
      // point in boot it is still null and has to be asked for.
      let local = null;
      if (o.isInstancedMesh) {
        if (!o.boundingSphere) o.computeBoundingSphere();
        local = o.boundingSphere;
      } else if (o.geometry) {
        if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
        local = o.geometry.boundingSphere;
      }
      if (!local) return;
      chunks.push({ mesh: o, sphere: _bsA.copy(local).clone().applyMatrix4(o.matrixWorld) });
    });
  }
  return { chunks, replaced, before, after, log };
}

export class Engine {
  constructor(container, opts = {}) {
    this.container = container;
    this.opts = opts;
    this.running = false;
    this.frozen = false;
    this.accumulator = 0;
    this.simTime = 0;
    this.frame = 0;
    this.lastTime = 0;
    this.captureShot = null;

    this.stats = {
      fps: 0, drawCalls: 0, triangles: 0, simMs: 0, renderMs: 0,
      /** Cars in each LOD tier, and cars culled off-frustum. Additive. */
      carLod: [0, 0, 0, 0], carsOffscreen: 0,
      /** Static world meshes after chunking, and casters gated out this frame. */
      worldChunks: 0, castersGated: 0,
    };
    /** Screen-size car LOD. `?lod=0` disables it for A/B measurement. */
    this.carLod = new CarLOD();
    this.lodEnabled = true;
    this._fpsSamples = [];
    /** Previous frame's camera position — the motion-blur / TAA cut detector. */
    this._prevCamPos = new THREE.Vector3();
    this._camCut = true;
  }

  // -- setup ---------------------------------------------------------------

  async init() {
    const width = this.container.clientWidth || window.innerWidth;
    const height = this.container.clientHeight || window.innerHeight;

    this.renderer = new THREE.WebGLRenderer({
      antialias: false,             // SMAA in the post stack does this better
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      alpha: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.opts.maxPixelRatio ?? 2));
    this.renderer.setSize(width, height);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // TONE MAPPING IS OWNED BY PostFX, NOWHERE ELSE.
    //
    // Every pass in the post stack renders into a render target, and three only
    // applies `renderer.toneMapping` / `outputColorSpace` when drawing to the
    // canvas — so leaving ACESFilmic here did nothing for the normal path but
    // silently double tone-mapped anything that ever drew straight to screen.
    // `postfx.js` runs the single ACES fit and the single sRGB encode, on
    // scene-referred linear values, after applying the exposure below exactly
    // once. `toneMappingExposure` survives purely as the shared scalar that
    // `lighting.js` meters into and `postfx.js` reads.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    // PCFSoftShadowMap is deprecated in three r185 — it warns once and then
    // silently falls back to PCFShadowMap anyway. `lighting.js` runs its own
    // cascaded PCSS kernel, so the built-in filter choice is cosmetic; asking
    // for the mode we actually get keeps the console clean.
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = true;
    this.renderer.info.autoReset = false;
    this.container.appendChild(this.renderer.domElement);
    assets.attachRenderer(this.renderer);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(60, width / height, 0.25, 6000);
    this.camera.position.set(0, 3, 10);

    // --- sky + lighting -----------------------------------------------------
    this.sky = new Sky({ timeOfDay: this.opts.timeOfDay ?? 15.2, cloudCoverage: 0.40 });
    this.scene.add(this.sky.mesh);
    this.lighting = new Lighting(this.renderer, this.scene, this.sky, { shadowRadius: 52 });
    this.lighting.setCamera(this.camera);   // cascaded shadows are fitted to the view frustum
    this.lighting.refreshEnvironment();

    this.scene.fog = new THREE.FogExp2(0x9fb6cf, 0.00085);

    // --- world --------------------------------------------------------------
    this.circuit = new Circuit();
    this.circuit.build();
    this.scene.add(this.circuit.group);

    this.environment = new Environment(this.circuit, { detail: this.opts.detail ?? 'high' });
    const envGroup = this.environment.build();
    this.scene.add(envGroup);

    // Split the track-wide meshes so the frustum and the shadow cascades can
    // actually reject them (see the WORLD CHUNKING block above). This runs
    // before anything caches a scene-graph reference, and `?chunk=0` skips it.
    this._worldChunks = [];
    if (new URLSearchParams(location.search).get('chunk') !== '0') {
      const r = chunkWorld([this.circuit.group, envGroup]);
      this._worldChunks = r.chunks;
      this.stats.worldChunks = r.after;
      console.info(`[apex] world chunking: split ${r.replaced} oversized meshes; `
        + `static world meshes ${r.before} -> ${r.after}, ${r.chunks.length} shadow casters gated per frame`);
      if (new URLSearchParams(location.search).get('chunk') === 'log') console.info('[apex] chunked: ' + r.log.join(' '));
    }

    // --- cars ---------------------------------------------------------------
    this.entries = fullGrid();
    this.field = new OpponentField({
      circuit: this.circuit,
      scene: this.scene,
      entries: this.entries,
      playerIndex: 0,
    });
    this.player = this.field.player;

    // --- systems ------------------------------------------------------------
    this.input = new Input(window);
    this.rig = new CameraRig(this.camera, { circuit: this.circuit });
    this.rig.follow({
      position: this.player.vehicle.position,
      quaternion: this.player.vehicle.quaternion,
      speed: 0,
      telemetry: this.player.vehicle.telemetry,
    });
    this.rig.setMode('chase');

    this.hud = new HUD(this.container, { circuit: this.circuit });
    this.hud.resize(width, height, Math.min(window.devicePixelRatio || 1, 2));

    this.particles = new Particles(this.scene);
    this.particles.setViewport(height, this.camera.fov);
    this.audio = new EngineAudio();
    this.audio.attachPlayer(this.player.vehicle);

    this.weather = new Weather({
      sky: this.sky,
      lighting: this.lighting,
      circuit: this.circuit,
      scene: this.scene,
      camera: this.camera,
      rig: this.rig,
      particles: this.particles,
      carMaterials: this.field.cars.map((c) => c.model.materials),
      trackMaterial: assets.items.get('mat:track/asphalt'),
    });
    this.weather.setState(this.opts.weather ?? 'dry', { immediate: true });

    // Audio needs the world to spatialise opponents, occlude behind stands and
    // pick the cockpit/TV mix. Everything it reads is read-only.
    this.audio.attachWorld({
      camera: this.camera,
      rig: this.rig,
      field: this.field,
      circuit: this.circuit,
      environment: this.environment,
      weather: this.weather,
    });

    // Grip from the weather system feeds straight into the tyre model.
    for (const c of this.field.cars) {
      const v = c.vehicle;
      v.surfaceProbe = () => ({ grip: this.weather.gripAt(v.trackS, v.trackLateral) });
    }

    this.session = new RaceSession({
      circuit: this.circuit,
      cars: this.field.cars,
      totalLaps: this.opts.laps ?? 12,
      playerIndex: 0,
    });
    // DEFAULT BOOT GOES STRAIGHT TO THE LIGHTS.
    //
    // `session.start()` arms a full grand prix including the choreographed
    // formation lap. That is exactly right when the front end asks for it — but
    // it is the wrong default for a bare boot (a capture, `?ui=0`, or anyone who
    // just loads the page and presses a key), because for the ~29 s of the
    // formation lap race control poses every car with `_kinematic()` and the
    // player's steering, throttle and brake are silently discarded. Measured:
    // holding throttle + left during formation produced `controls.throttle 0.22,
    // controls.steer 0` — the game looked broken. Skip it; `RaceFrontEnd`
    // re-arms whatever session the player actually picks.
    this.session.beginSession('race', { lights: true, formation: false });

    // Start the field rolling so the first frames are not a standing start.
    for (const c of this.field.cars) {
      const slot = this.circuit.gridSlot(c.index);
      c.vehicle.reset({ s: slot.s, lateral: slot.lateral, speed: 0 });
    }

    // --- post ----------------------------------------------------------------
    this.postfx = new PostFX(this.renderer, this.scene, this.camera, { msaa: 0 });
    // FX hook: soft-particle depth fade reads the GTAO G-buffer; heat haze needs
    // the renderer to blit the framebuffer.
    this.particles.attachRenderer(this.renderer, this.camera, this.postfx);
    this._applyDebugFlags();

    this._bindEvents();
    this._installCaptureAPI();

    // First render primes shader compilation before we say ready.
    this.field.syncModels();
    this.rig.snap();
    this.rig.update(FIXED_DT);
    await this.settle();

    // The world is pristine exactly here: built, staged, and not yet stepped by
    // a single wall-clock frame. Bank it, so `capture()` can always come back.
    this._simBaseline = this._snapshotSim();

    this.ready = true;
    window.__APEX__.ready = true;
    return this;
  }

  /**
   * Bank every piece of mutable simulation state a restage cannot reach.
   * See the DETERMINISTIC CAPTURE block above for why this exists.
   */
  _snapshotSim() {
    const cars = this.field.cars.map((c) => ({
      vehicle: snapState(c.vehicle),
      ai: c.ai ? snapState(c.ai) : null,
      record: snapState({
        distance: c.distance, lastS: c.lastS, lap: c.lap,
        position: c.position, inPit: c.inPit, compound: c.compound,
      }),
    }));
    return {
      cars,
      field: snapState({ time: this.field.time, drsEnabled: this.field.drsEnabled }),
      // Race control owns fuel load and tyre wear, and it writes both into
      // `vehicle.cfg` — so a capture that starts on lap 4's fuel is a different
      // car. Snapshotting it is cheap (scalars plus two ring buffers).
      session: snapState(this.session, 3),
      weather: snapState(this.weather, 2),
    };
  }

  /**
   * Put the sim back to the state banked at the end of `init()` and re-seed
   * every PRNG stream the drivers own, so a capture is a pure function of its
   * shot name again.
   */
  _restoreSim() {
    const snap = this._simBaseline;
    if (!snap) return;
    this.field.cars.forEach((c, i) => {
      const s = snap.cars[i];
      if (!s) return;
      restoreState(c.vehicle, s.vehicle);
      if (c.ai && s.ai) restoreState(c.ai, s.ai);
      restoreState(c, s.record);
      // `AIDriver.rng` is a closure over a counter, so it cannot be snapshotted
      // — it has to be replaced. The stream only has to be the SAME every time,
      // not the same one `opponents.js` built, and the persona was drawn from it
      // at construction and is already restored above.
      if (c.ai) c.ai.rng = makeRng(hashSeed(`capture:ai:${c.index}`));
    });
    restoreState(this.field, snap.field);
    restoreState(this.session, snap.session, 3);
    restoreState(this.weather, snap.weather, 2);
    // Cheapest possible fix for the engine's own driver: throw it away. It is
    // rebuilt on the next step from a fixed seed, which is by construction the
    // same stream every capture.
    this._autoDriver = null;
    this._autopilot = true;
    /** Latched by the first E/Q press; see the MANUAL GEARBOX note in `step()`. */
    this._manualGearbox = false;
  }

  /**
   * Query-string overrides for isolating a subsystem while debugging, e.g.
   *   ?fx=0        bypass the whole post stack (raw render)
   *   ?ao=0&bloom=0&look=0&smaa=0&dof=1
   *   ?env=0.4     scale the IBL intensity
   *   ?exposure=1.2
   */
  _applyDebugFlags() {
    const q = new URLSearchParams(location.search);
    if (!q.toString()) return;
    const num = (k, d) => (q.has(k) ? parseFloat(q.get(k)) : d);
    if (q.get('fx') === '0') {
      for (const name of ['ao', 'dof', 'bloom', 'smaa', 'look', 'preGrade']) this.postfx.enable(name, false);
    }
    for (const name of ['ao', 'dof', 'bloom', 'smaa', 'look', 'preGrade']) {
      if (q.has(name)) this.postfx.enable(name, q.get(name) !== '0');
    }
    // `?env=<float>` — the contract documents this as "IBL intensity", and it
    // was a no-op for any capture: `weather.update()` calls
    // `lighting.setEnvironmentScale(envScale)`, which recomputes the live value
    // from `baseEnvironmentIntensity` every frame and threw the override away
    // before the first rendered frame. Set the BASE (the calibration) so the
    // flag survives, and keep the live write so a frozen shot updates at once.
    if (q.has('env')) {
      this.lighting.baseEnvironmentIntensity = num('env', 1);
      this.lighting.setEnvironmentIntensity(num('env', 1));
    }
    if (q.has('exposure')) this.renderer.toneMappingExposure = num('exposure', 0.95);
    if (q.has('fog') && q.get('fog') === '0') this.scene.fog = null;
    // `?fogk=1.8` — scale the atmospheric extinction without an edit/rebuild
    // cycle. This is the A/B switch the aerial-perspective curve below was
    // measured with; 1 is the shipping look.
    if (q.has('fogk')) this._fogK = num('fogk', 1);
    // `?fogh=420` — sweep the aerosol scale height (`lighting.aerialHeightScale`)
    // for the same reason. Diagnostic only: the shipping value is lighting's.
    if (q.has('fogh')) this._fogH = num('fogh', 0);
    // `?lod=0` — every car at full detail, no off-frustum culling. This is the
    // A/B switch the draw-call numbers in the CarLOD header were measured with.
    if (q.get('lod') === '0') this.lodEnabled = false;
    // `?weather=heavyRain` — pins the weather state for the live game AND for
    // every capture shot (see `capture()`), so the wet look can be reviewed.
    if (q.has('weather')) {
      this._weatherFlag = q.get('weather');
      this.weather.setState(this._weatherFlag, { immediate: true });
    }
    // `?sunover=el,side,skew[,hour]` — override the key-light bearing a capture
    // shot authors through `stageSun`, so the directorial choice can be swept
    // from the harness. `-` keeps the authored field.
    if (q.has('sunover')) {
      const f = q.get('sunover').split(',');
      this._sunOverride = [0, 1, 2, 3].map((i) => (f[i] === undefined || f[i] === '-' ? null : parseFloat(f[i])));
    }
  }

  _bindEvents() {
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);

    this.input.on('camera', () => { this.rig.cycleMode(); this._camCut = true; });
    this.input.on('reset', () => {
      const v = this.player.vehicle;
      v.reset({ s: v.trackS, lateral: this.circuit.racingLineOffset(v.trackS), speed: Math.min(v.speed, 40) });
      this.rig.snap();
      this._camCut = true;
      this.particles.reset();
      // A reset is a fresh start: hand the gearbox back to the auto box so the
      // driver is never dumped on track holding a gear they forgot they picked.
      this._manualGearbox = false;
    });
    const kick = () => this.audio.resume();
    window.addEventListener('pointerdown', kick, { once: true });
    window.addEventListener('keydown', kick, { once: true });
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.postfx.setSize(w, h);
    this.particles.setViewport(h, this.camera.fov);
    this.hud.resize(w, h, Math.min(window.devicePixelRatio || 1, 2));
  }

  // -- simulation ----------------------------------------------------------

  /** One fixed physics/AI/session step. */
  step(dt) {
    const t0 = performance.now();

    this.input.update(dt);
    const player = this.player.vehicle;

    if (!this.captureShot || this.captureAutoDrive) {
      // The player car is driven by the AI unless a human is providing input.
      const s = this.input.state;
      const humanActive = Math.abs(s.steer) > 0.02 || s.throttle > 0.02 || s.brake > 0.02;

      // MANUAL GEARBOX — E / Q were documented and dead.
      //
      // `vehicle.js` fully implements a sequential shift (the `else` branch of
      // its `controls.autoGearbox` test, `_shift(+1)` / `_shift(-1)` behind
      // `_shiftLock`), but this block hard-coded `autoGearbox: true` and never
      // forwarded `input.actions.shiftUp/shiftDown`, so the two keys reached
      // nothing at all: measured at 309 km/h in 8th, a Q press left the gear at
      // 8 and an E press left it at 8.
      //
      // Forwarding the flag alone is not enough. The auto box re-evaluates every
      // step, so a downshift granted for one frame is undone by the upshift rule
      // on the next — the driver has to be able to HOLD a gear. So the first
      // deliberate shift latches the box into manual for the rest of the stint;
      // `X` (reset) and handing the car back to the autopilot both restore auto.
      //
      // Captures are unaffected: they drive through the autopilot with no key
      // input, so `_manualGearbox` never latches and `autoGearbox` stays true.
      const shiftUp = this.input.actions.shiftUp;
      const shiftDown = this.input.actions.shiftDown;
      if (shiftUp || shiftDown) this._manualGearbox = true;

      if (humanActive || ((shiftUp || shiftDown) && !this._autopilot)) {
        player.setControls({
          steer: s.steer, throttle: s.throttle, brake: s.brake,
          // The clutch pedal was collected by `input.js` and then dropped on the
          // floor here, so `vehicle.controls.clutch` was permanently undefined
          // and a clutch start was impossible.
          clutch: s.clutch ?? 0,
          drs: s.drs, ers: s.ers,
          autoGearbox: !this._manualGearbox,
          shiftUp, shiftDown,
        });
        player.drsActive = s.drs && !!this.circuit.drsZoneAt(player.trackS);
        player.drsAvailable = !!this.circuit.drsZoneAt(player.trackS);
        this._autopilot = false;
      } else if (!this._autopilot) {
        this._autopilot = true;
        this._manualGearbox = false;
      }
      if (this._autopilot) this._driveAutopilot(dt);
    }

    this.input.endFrame();

    // DIRTY AIR / SLIPSTREAM — this was built and never called.
    //
    // `vehicle.js` exports `applyWakes`, the aero model reads `wake.dirty` and
    // `wake.tow` (see `_aero`), and `telemetry.dirtyAir` / `.slipstream` publish
    // them — but nothing in the tree invoked it, so every `wake` stayed at zero
    // for the whole race. The opponents were unaffected because `opponents.js`
    // had quietly grown its OWN copy, writing `veh.cfg.cdA` / `cfg.clA` directly
    // from its rival scan; the PLAYER, who is not driven by an AIDriver, got no
    // tow and no dirty air at all and the HUD's two telemetry channels were
    // permanently dead.
    //
    // Wire the shared model here, once, for the whole field — BEFORE the
    // vehicles integrate, so this frame's aero sees this frame's gaps — and let
    // `opponents.js` keep its scan for TACTICS only (see the note there). One
    // owner for the physics, one for the decisions.
    applyWakes(this.field.cars, this.circuit);

    this.field.update(dt);
    this.session.update(dt);
    this.weather.update(dt, this.field.cars, player.position);

    for (const c of this.field.cars) this.particles.driveFromCar(c, dt, this.weather.wetness);
    this.particles.update(dt);

    this.simTime += dt;
    this.stats.simMs = performance.now() - t0;
  }

  /**
   * Attract-mode driver for the player car. The same AI the opponents use, so
   * the game is always showing a convincing lap even with no input — which is
   * also what makes the capture shots reproducible.
   */
  _driveAutopilot(dt) {
    if (!this._autoDriver) {
      this._autoDriver = new AIDriver({
        vehicle: this.player.vehicle,
        circuit: this.circuit,
        profile: this.field.profile,
        skill: 0.985,
        seed: 999,
        name: 'PLAYER',
      });
    }
    this._autoDriver.update(dt, this.field.cars.map((c) => c.vehicle));
  }

  /** Per-render-frame visual updates (interpolation-friendly, no physics). */
  updateVisuals(dt) {
    const player = this.player.vehicle;

    this.field.syncModels();
    this.sky.update(dt);
    this.environment.update(dt);

    // ORDER IS LOAD BEARING. `rig.update()` is what writes camera position,
    // orientation and FOV, and `lighting.update()` fits its shadow cascades to
    // the camera FRUSTUM (`lighting.setCamera` in init). Metering the cascades
    // before the camera has moved fits them to last frame's view, which at
    // racing pace walks the near cascade ~1.5 m behind the car every frame and
    // pops geometry in at the cascade edge. Camera first, then lighting.
    this.rig.target.speed = player.speed;
    this.rig.update(dt);
    // A staged static shot owns the camera outright. It has to be applied HERE,
    // before anything reads the camera back, not after updateVisuals: the shadow
    // cascades, the sun-flare projection, the DOF focus and the motion-blur
    // vanishing point are all camera-derived, and fitting them to the rig pose
    // that `_applyShotCamera` is about to overwrite is why `grid`, `wheel` and
    // `front` were lit with the previous shot's shadow cascade.
    if (this._staticCam) this._applyShotCamera();

    // LONG LENS => SHALLOW DEPTH OF FIELD, and for `tv` that is not a garnish.
    // A world-feed corner camera is a 60-100x box lens shot wide open, so the
    // catch fence twenty metres in front of it and the skyline behind it are
    // both far outside the depth of field. That is the entire reason a real
    // broadcast frame reads *through* a debris fence; render it in focus and the
    // fence is a hard black lattice across the bottom of the shot.
    if (!this.captureShot) {
      const longLens = this.rig.mode === 'tv';
      const dof = this.postfx.settings.dof;
      if (dof.enabled !== longLens) {
        dof.enabled = longLens;
        dof.aperture = 0.0009;
        dof.maxblur = 0.007;
      }
    }
    // `rig.focusDistance` is the live subject distance (documented read-back).
    // A rig-driven DOF shot has to track it every frame or the subject drifts out
    // of focus as it closes on the camera; `postfx.render` re-derives the circle
    // of confusion from `settings.dof.focus` on every frame, so this is enough.
    if (this.postfx.settings.dof.enabled && !this._staticCam && this.rig.focusDistance > 0.1) {
      this.postfx.settings.dof.focus = this.rig.focusDistance;
    }

    // Point sprites are sized in metres, so they must track the live FOV.
    this.particles.setViewport(this.renderer.domElement.height / this.renderer.getPixelRatio(), this.camera.fov);
    // `project()` below and the shadow cascade fit both read matrixWorldInverse.
    // three only refreshes that during render, so without this the sun flare and
    // the cascades are a frame behind the camera they belong to.
    this.camera.updateMatrixWorld(true);

    // CAR LOD — the largest single item in the frame budget (see CarLOD above).
    // It has to run AFTER the camera is final (the tier is a pixel size, and
    // `_applyShotCamera` may have just replaced the rig pose) and BEFORE the
    // shadow cascades are fitted, so a car culled off-frustum is also gone from
    // the four cascade passes it was costing ~33 draw calls in.
    this.carLod.update(
      this.field.cars, this.camera,
      this.renderer.domElement.height / this.renderer.getPixelRatio(),
      this.lodEnabled
    );

    // Same idea as the car shadow gate, for the static world: a chunk further
    // from the camera than the cascade ladder reaches cannot land in any
    // cascade, so it should not be walked by the shadow pass at all.
    this._gateWorldShadows();

    this.lighting.update(dt, player.position);

    // --- camera motion --------------------------------------------------------
    // A hard cut (tv tower change, restage, rig.snap) teleports the camera. Both
    // the TAA history and the motion-blur velocity buffer describe the OLD view,
    // so carrying them across the cut ghosts one frame of the previous shot into
    // the new one. Detect the teleport from the camera's own displacement.
    const camMove = _camVel.subVectors(this.camera.position, this._prevCamPos).length();
    const cut = this._camCut || camMove > Math.max(6, player.speed * dt * 6);
    this._prevCamPos.copy(this.camera.position);
    this._camCut = false;
    if (cut) {
      this.postfx.resetHistory();
      _camVel.set(0, 0, 0);
    } else {
      _camVel.divideScalar(Math.max(dt, 1e-4));
    }

    // Fog + sun-flare follow the sky.
    //
    // AERIAL PERSPECTIVE IS AN EXTINCTION COEFFICIENT, SO READ IT AS VISIBILITY.
    //
    // `sky.js` replaced three's fog chunk with a proper single-scattering
    // integral, so this number is no longer a fudge factor: the haze fraction at
    // range d is 1 - exp(-d * density * lighting.aerialStrength), i.e. Koschmieder
    // with a meteorological visibility of 3.912 / (density * strength).
    //
    // At the old 0.00030 + 0.00035*(1-sunUp) the afternoon value came out at
    // 0.00044, and with `lighting.aerialStrength` 0.9 that is 11 km of visibility
    // — a scrubbed-clean alpine day. MEASURED against that on `chase` with
    // tools/_e5depth.mjs, which raycasts the live scene to find out what is
    // actually at each part of the frame:
    //
    //   hoardings      50-250 m    2 - 9% haze
    //   near canopy       253 m      9.6%
    //   far hillside      652 m       23%
    //   city skyline     4226 m       82%
    //
    // Nothing between the barrier and half a kilometre picked up any air at all,
    // which is exactly the review's "the 3 km treeline sits at full saturation
    // while the 8 km skyline is correctly hazed, so the depth ordering inverts".
    // 4.6 km of visibility (a normal summer afternoon over farmland, and still
    // clear enough to read the skyline) doubles the mid-field term: the 650 m
    // hillside goes to 40% and the near hoardings stay under 20%.
    //
    // Weighted toward the constant rather than the elevation term on purpose —
    // the old curve's `(1 - sunUp)` doubling is right in kind (low sun really
    // does mean a longer path through the boundary layer) but doubling THAT as
    // well would have put dusk under 3 km and swallowed the circuit.
    //
    // ROUND-5 INTEGRATION TRIM: 0.00065 + 0.00050 was too far. Extinction is
    // exponential in range, so a coefficient chosen to make the 650 m hillside
    // read costs the 1-4 km bands their whole dynamic range:
    //
    //   density   vis     650 m    4.2 km
    //   0.00044   9.9 km   23 %     81 %      round 4
    //   0.00115   3.8 km   49 %     99 %      round 5 as proposed  <- flattened
    //   0.00072   6.0 km   34 %     94 %      shipped
    //
    // At 0.00115 the far woodland bands and the city skyline both compressed
    // into the haze colour and stopped carrying edges at all. MEASURED with
    // `?fogk=` on `wide` against shots/r4-final-wide.png, tools/compare.mjs
    // --grid 6, counting cells with edge energy down more than 15 %:
    //
    //   fogk 1.00 (0.00115)   4 cells lost   r0c3 -26 %, r1c2 -22 %, r0c4 -21 %, r1c4 -20 %
    //   fogk 0.80 (0.00092)   3 cells lost
    //   fogk 0.70 (0.00081)   1 cell  lost
    //   fogk 0.63 (0.00072)   0 cells lost, and the far field gains edge (+0.39)
    //
    // 0.63 keeps HALF the mid-field gain the round-5 curve was written for (the
    // hillside goes 23 % -> 34 %, still a real doubling of the near-field air)
    // and gives the far bands their contrast back. Anything above ~0.7 trades
    // one defect for another, which is the thing this round exists to stop.
    const sunUp = clamp(this.sky.sunDirection.y, 0, 1);
    this.scene.fog.color.copy(this.sky.skyColour()).multiplyScalar(1.15);
    this.scene.fog.density = (0.00038 + (1 - sunUp) * 0.00029) * (this._fogK ?? 1)
      + this.weather.rain * 0.0020;
    if (this._fogH) this.lighting.aerialHeightScale = this._fogH;

    const fwd = this.camera.getWorldDirection(_fwd);
    const sunWorld = _tmp.copy(this.sky.sunDirection).multiplyScalar(3000).add(this.camera.position);
    const ndc = sunWorld.project(this.camera);
    const inFront = ndc.z < 1 && Math.abs(ndc.x) < 1.4 && Math.abs(ndc.y) < 1.4;
    const facing = this.sky.sunDirection.dot(fwd);
    this.postfx.setSunScreen(ndc.x * 0.5 + 0.5, ndc.y * 0.5 + 0.5,
      inFront && facing > 0.1 ? clamp(facing, 0, 1) * clamp(sunUp * 3, 0, 1) : 0);

    // MOTION BLUR FOLLOWS THE CAMERA, NOT THE CAR.
    //
    // The radial term in `postfx`'s motion pass smears the WHOLE frame away
    // from a vanishing point; it is there to sell the speed of a camera that is
    // itself travelling. Driving it off `player.speed` meant a static trackside
    // tower or an elevated establishing shot got full-strength smear applied to
    // the barriers, the grandstands and the skyline while the camera sat still —
    // `tv` and `wide` came out looking like a photograph of a photograph. The
    // cars' own streaks come from the velocity buffer and need no help.
    //
    // So: measure the camera's forward ground speed and use that. Chase and
    // cockpit still get the full effect (the camera really is doing 300 km/h),
    // tv/hero/wide get essentially none, and the vanishing point is put where
    // the camera is actually going instead of assuming the middle of the frame.
    const along = Math.max(0, _camVel.dot(fwd));
    // SHUTTER ANGLE BELONGS TO THE LENS, NOT TO THE CAR.
    //
    // Killing the radial term for the world-feed cameras was only half the fix.
    // The velocity buffer still blurs whatever moves across the frame, and a long
    // lens panning with a car at 100 m/s moves the ENTIRE background across the
    // frame — so at a 0.42 shutter and a 14 px ceiling the `tv` and `wide` frames
    // came out uniformly smeared, barriers, fence, skyline and cars alike. A real
    // world-feed camera runs about 1/500 s: the pan is crisp and only the wheels
    // and the sparks streak. Onboard footage is the opposite — a long shutter is
    // most of what sells the speed.
    const onboard = ONBOARD_MODES.has(this.rig.mode);
    // SHUTTER CALIBRATION. 0.42 / 13 px put a ~49 px near-field ceiling on a
    // 900-line frame and the onboard shots came back as mush: the barriers, the
    // grandstands and the skyline were all unreadable, and the plank sparks —
    // which already bake a 54 px camera-relative streak into the SPRITE — came
    // out of the pipe as 200 px ribbons because the two smears compose. A real
    // onboard camera runs about 1/100 s at 60 fps, i.e. a 0.6 shutter on paper,
    // but a game frame is a single sample and reads far softer than film at the
    // same angle. 0.30 / 8 px (a ~30 px ceiling at 900, 36 at 1080) keeps the
    // tarmac under the front wing dissolving and hands the far field back.
    this.postfx.setShutter(onboard ? 0.30 : 0.10, onboard ? 8 : 4);
    this.postfx.setMotionBlur(clamp(along / 105, 0, 1) * (this.rig.mode === 'cockpit' ? 1.0 : 0.8));
    if (along > 2) {
      const vp = _tmp.copy(this.camera.position).addScaledVector(_camVel, 400 / along).project(this.camera);
      this.postfx.setBlurCenter(clamp(vp.x, -1.6, 1.6) * 0.5 + 0.5, clamp(vp.y, -1.6, 1.6) * 0.5 + 0.5);
    } else {
      this.postfx.setBlurCenter(0.5, 0.5);
    }

    // HUD.
    if (this.hud.visible) {
      this.hud.render({
        telemetry: player.telemetry,
        race: this.session.snapshot(0),
        cars: this.session.carDots(),
        playerIndex: 0,
        banner: null,
        flag: this.session.flag,
      });
    }

    this.audio.update(dt);
  }

  /**
   * Turn `castShadow` off for static world chunks outside the cascade ladder's
   * reach. Pure distance compare against a world-space sphere cached at boot —
   * ~300 iterations, no allocation, no matrix work.
   */
  _gateWorldShadows() {
    const chunks = this._worldChunks;
    if (!chunks || !chunks.length) return;
    const p = this.camera.position;
    let gated = 0;
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      const on = c.sphere.center.distanceTo(p) - c.sphere.radius < SHADOW_CAST_RANGE;
      if (c.mesh.castShadow !== on) c.mesh.castShadow = on;
      if (!on) gated++;
    }
    this.stats.castersGated = gated;
  }

  render(dt) {
    const t0 = performance.now();
    this.renderer.info.reset();
    this.postfx.render(dt);
    this.stats.drawCalls = this.renderer.info.render.calls;
    this.stats.triangles = this.renderer.info.render.triangles;
    this.stats.renderMs = performance.now() - t0;
    const t = this.carLod.tiers;
    this.stats.carLod[0] = t[0]; this.stats.carLod[1] = t[1];
    this.stats.carLod[2] = t[2]; this.stats.carLod[3] = t[3];
    this.stats.carsOffscreen = this.carLod.offscreen;
  }

  // -- main loop -----------------------------------------------------------

  start() {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    const loop = (now) => {
      if (!this.running) return;
      this._raf = requestAnimationFrame(loop);
      // rAF hands us a `now` on the frame clock, but `lastTime` was seeded from
      // performance.now() at start(); on the first frame after a resume the two
      // can disagree by a whole frame and produce a NEGATIVE dt — which then
      // averaged out to a negative `stats.fps`, the number the debug HUD and
      // every perf probe read. Clamp to a sane frame window.
      let dt = (now - this.lastTime) / 1000;
      this.lastTime = now;
      if (!(dt > 0)) dt = FIXED_DT;
      if (dt > 0.25) dt = 0.25;

      this._fpsSamples.push(dt);
      if (this._fpsSamples.length > 60) this._fpsSamples.shift();
      this.stats.fps = 1 / (this._fpsSamples.reduce((a, b) => a + b, 0) / this._fpsSamples.length);

      this.accumulator += dt;
      let steps = 0;
      while (this.accumulator >= FIXED_DT && steps < 5) {
        if (!this.frozen) this.step(FIXED_DT);
        this.accumulator -= FIXED_DT;
        steps++;
      }
      this.updateVisuals(dt);
      this.render(dt);
      this.frame++;
    };
    this._raf = requestAnimationFrame(loop);
  }

  pause() {
    this.running = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  // -- capture contract ----------------------------------------------------

  _installCaptureAPI() {
    const api = {
      ready: false,
      version: 'apex-gp-1',
      engine: this,
      // The three namespace the engine itself was built against. Diagnostic
      // tools (tools/_e5depth.mjs) need a Raycaster/Vector to interrogate the
      // live scene, and a second copy pulled in through a dynamic import is a
      // different module instance with different class identities.
      THREE,
      pause: () => this.pause(),
      resume: () => this.start(),
      renderFrame: (i) => this.renderFrame(i),
      capture: (shot, i) => this.capture(shot, i),
      settle: () => this.settle(),
      stats: () => this.stats,
    };
    window.__APEX__ = api;
  }

  /** Advance the sim by exactly one fixed step and render one frame. */
  renderFrame(i) {
    if (!this.frozen) this.step(FIXED_DT);
    // `updateVisuals` applies `_staticCam` itself (see the note there), so the
    // whole camera-derived chain agrees with the camera we are about to render.
    this.updateVisuals(FIXED_DT);
    this.render(FIXED_DT);
    this.frame++;
    void i;
  }

  /** Await pending PMREM work and force shader compilation. */
  async settle() {
    this.lighting.refreshEnvironment();
    // Full detail while compiling: `compile()` uses `traverseVisible`.
    this.carLod.forceFull(this.field.cars);
    try {
      await this.renderer.compileAsync(this.scene, this.camera);
    } catch {
      this.renderer.compile(this.scene, this.camera);
    }
    // Two throwaway frames flush the post stack's own programs.
    this.postfx.render(FIXED_DT);
    this.postfx.render(FIXED_DT);
    await new Promise((r) => setTimeout(r, 0));
  }

  /**
   * Deterministically pose the world for a named shot.
   * Every shot resets the RNG-independent state it needs, so repeated captures
   * of the same name produce identical frames.
   */
  async capture(shot, frameIndex = 0) {
    this.pause();
    // A capture must never include the boot overlay (its fade needs wall time).
    document.getElementById('apex-loading')?.remove();
    this.captureShot = shot;
    this.captureAutoDrive = true;
    this.frozen = false;
    this.frame = 0;
    this.simTime = 0;
    this._staticCam = null;
    // A capture restages the field and teleports the camera: drop the temporal
    // history and every live particle, or the first frames of one shot carry the
    // tail of the previous one.
    this._camCut = true;
    this.postfx.resetHistory();
    this.particles.reset();
    // Rewind the whole simulation before staging anything (see DETERMINISTIC
    // CAPTURE). Without this, capture N+1 inherits capture N's tyre
    // temperatures, fuel load, wear, race-control timing traces and — the one
    // that actually moved the car a metre and a half — every driver's PRNG
    // stream and tactical timers.
    this._restoreSim();

    const c = this.circuit;
    const P = this.player.vehicle;

    /** Speed the AI would actually be doing here — keeps the field stable. */
    const paceAt = (s) => this.field.profile[c.sampleIndex(s)] * 0.97;

    /**
     * Stage the whole field around the player: a few cars ahead (so the frame
     * has depth) and the rest strung out behind, all at racing pace.
     */
    const put = (s, lateral, speed) => {
      const AHEAD = [17, 33, 54];
      // KEEP THE FIELD ON THE ROAD. A fixed +-1.6 m offset from the racing line
      // puts a car on the kerb wherever the line runs near the edge (the line
      // reaches +-5 m on a 7.6 m half-width), which is exactly where every
      // capture stages them. Parked on a kerb, the FX layer sees `kerbBand` for
      // twenty cars at once and turns the corner into a firework display, and
      // the physics is fighting for grip it does not have. Offset TOWARD the
      // centre of the road and clamp well inside the white line.
      const lane = (at, side) => {
        const line = c.racingLineOffset(at);
        const room = Math.max(0, c.halfWidth - 1.5);
        const off = side * 1.7 * (Math.abs(line) > room * 0.55 ? -Math.sign(line) * side : 1);
        return clamp(line + off, -room, room);
      };
      this.field.cars.forEach((car, i) => {
        let off;
        if (i === 0) off = 0;
        else if (i <= AHEAD.length) off = AHEAD[i - 1];
        // ~19 m at racing pace is ~0.22 s — a close but readable timing tower.
        else off = -(14 + (i - AHEAD.length) * 19);
        const at = c.wrapS(s + off);
        const lat = i === 0 ? lateral : lane(at, (i % 2) ? 1 : -1);
        car.vehicle.reset({ s: at, lateral: lat, speed: i === 0 ? (speed ?? paceAt(at)) : paceAt(at) });
      });
      void P;
    };

    /**
     * Stage a moving shot upstream of `s` so that after the harness's ~90 warm
     * frames (1.5 s) the car is actually AT the point we chose.
     */
    const lead = (s) => c.wrapS(s - paceAt(s) * 1.45);

    /** A photogenic medium-fast corner: big enough radius to be taken at speed. */
    const findCorner = () => {
      let best = 0, bestSpeed = 0;
      for (let i = 0; i < c.samples.length; i += 2) {
        const k = Math.abs(c.samples[i].curvature);
        if (k < 1 / 240 || k > 1 / 95) continue;
        const v = this.field.profile[i];
        if (v > bestSpeed) { bestSpeed = v; best = i; }
      }
      return best * c.step;
    };

    /**
     * PUT THE SUN WHERE THE SHOT NEEDS IT.
     *
     * A clock time alone does not decide whether a frame has shadows in it; the
     * BEARING of the sun relative to the lens does. `grid` photographed with
     * literally no shadow on the tarmac and it was not the cascade ladder: at
     * 10:24 the sun sat 173 deg round from the camera — dead behind it — so
     * every car's shadow fell along the track, straight away from the lens, and
     * hid underneath its own caster. Measured with tools/_sunprobe.mjs.
     *
     * So author the bearing off the TRACK, not off the clock. `side` is which of
     * the driver's hands the sun stands over at `s` (+1 = right), which makes
     * shadows rake ACROSS the frame for any camera looking along the road, at
     * any point of any circuit. Elevation still comes from the clock so the sky
     * colour, turbidity and the metered exposure stay honest — only the compass
     * bearing is a directorial choice.
     *
     * `skewDeg` rotates that bearing off the perpendicular. Dead square to the
     * road is right for a head-on shot but WRONG for a broadside one: a car seen
     * from the side with the sun square across the track throws its shadow along
     * its own 5.5 m length, entirely underneath itself, and `tv` photographed
     * with no shadow for exactly that reason. Skewing puts the shadow diagonally
     * out from under the car where the lens can see it.
     */
    const stageSun = (hour, atS, side = 1, elevationDeg = null, skewDeg = 0) => {
      // `?sunover=el,side,skew[,hour]` — sweep a shot's key light without an
      // edit/rebuild cycle. Any field may be `-` to keep the authored value.
      const ov = this._sunOverride;
      if (ov) {
        if (ov[0] !== null) elevationDeg = ov[0];
        if (ov[1] !== null) side = ov[1];
        if (ov[2] !== null) skewDeg = ov[2];
        if (ov[3] !== null) hour = ov[3];
      }
      this.sky.setTimeOfDay(hour);
      const sm = c.sampleAt(atS);
      const k = THREE.MathUtils.degToRad(skewDeg) * side;
      // Rotate `right` about +Y by the skew, staying in the ground plane.
      const x = sm.right.x * Math.cos(k) + sm.right.z * Math.sin(k);
      const z = -sm.right.x * Math.sin(k) + sm.right.z * Math.cos(k);
      const az = Math.atan2(x * side, z * side) * 180 / Math.PI;
      this.sky.setSun(elevationDeg ?? this.sky.elevation, az);
    };

    // Default look: mid-afternoon, dry, HUD off.
    this.sky.setTimeOfDay(15.2);
    this.weather.setState(this._weatherFlag ?? 'dry', { immediate: true });
    this.hud.setVisible(false);
    this.postfx.settings.dof.enabled = false;
    this.postfx.settings.bloom.strength = 0.42;
    this.postfx.settings.vignette = 0.32;
    this.postfx.settings.flare = 0.32;
    this.rig.orbitSpeed = 0;

    // A corner with elevation and a good background, plus a long straight.
    const CORNER_S = c.wrapS(findCorner());
    const STRAIGHT_S = c.wrapS((c.drsZones[0]?.startS ?? 0) + 180);
    const HERO_S = c.wrapS(findCorner() + 260);

    switch (shot) {
      case 'cockpit':
        put(lead(CORNER_S), c.racingLineOffset(lead(CORNER_S)));
        this.rig.setMode('cockpit');
        break;

      case 'tv':
        put(lead(c.wrapS(CORNER_S - 20)), c.racingLineOffset(lead(c.wrapS(CORNER_S - 20))));
        // The clock's own bearing put the sun 22 deg off the lens axis: a world
        // feed straight into the sun, with the car, the tarmac and the barriers
        // all showing the camera their shaded side. A tower camera is broadside
        // to the car, so the sun goes three-quarter across the road (55 deg off
        // square) at a late-afternoon elevation: the flank the lens sees is lit,
        // and the 2.4x shadow rakes diagonally out from under the floor instead
        // of hiding along the car's own length.
        stageSun(16.5, CORNER_S, +1, null, 55);
        this.rig.setMode('tv');
        // See the note in `updateVisuals`: a world feed is a long lens wide open,
        // and the shallow depth of field is what turns the foreground catch fence
        // from a hard black lattice into the grey veil a photograph shows.
        this.postfx.settings.dof.enabled = true;
        this.postfx.settings.dof.aperture = 0.0009;
        this.postfx.settings.dof.maxblur = 0.007;
        break;

      case 'beauty': {
        // Golden hour, keyed from the car's right — the same side the hero rig
        // orbits to — so the flank the lens sees is the lit one and the shadow
        // rakes away to the left of frame. At the clock's own 11 deg the car sat
        // in the main grandstand's shadow (a 15 m stand throws 75 m at that
        // elevation) and the frame had no contact shadow at all; 17 deg still
        // reads as low sun and still throws 3.3x the car's height.
        stageSun(17.6, HERO_S, +1, 17);
        put(HERO_S, 0, 0);
        this.frozen = true;
        this.rig.setMode('hero');
        this.rig.orbitAngle = 0.72;   // three-quarter front, from the car's right
        this.postfx.settings.dof.enabled = true;
        this.postfx.settings.dof.focus = 8.8;
        this.postfx.settings.dof.aperture = 0.0011;
        this.postfx.settings.dof.maxblur = 0.008;
        this.postfx.settings.bloom.strength = 0.55;
        this.postfx.settings.flare = 0.5;
        break;
      }

      case 'wide':
        put(lead(CORNER_S), c.racingLineOffset(lead(CORNER_S)));
        // An elevated establishing shot looks DOWN on the cars, so the only
        // shadow it can see is the one that reaches out from under the floor.
        // At the clock's 36 deg a car throws 1.2 m — entirely inside its own
        // 2 m width from above — and the field read as decals on the tarmac.
        // 26 deg doubles that, and skewing 30 deg off square walks it out past
        // the front wing instead of along the car.
        stageSun(15.2, CORNER_S, -1, 26, 30);
        this.rig.setMode('wide');
        break;

      case 'grid': {
        // Mid-morning, but raked ACROSS the grid rather than down it: at the
        // clock's own bearing every one of the twenty shadows fell along the
        // road and vanished under its own car. 38 deg of elevation is the
        // trade — high enough that the pit building and the main grandstand do
        // not throw the whole grid into shade, low enough that a car's shadow
        // is 1.2x its own height and reads as a contact shadow from 100 m.
        stageSun(10.4, c.gridSlot(0).s, +1, 38);
        this.field.cars.forEach((car, i) => {
          const slot = c.gridSlot(i);
          car.vehicle.reset({ s: slot.s, lateral: slot.lateral, speed: 0 });
        });
        this.frozen = true;
        const g0 = c.gridSlot(0);
        // Behind the last row, elevated: the classic pre-start establishing shot.
        const eye = c.pointAt(c.wrapS(g0.s - 108), 0, 0);
        eye.y += 9.5;
        const look = c.pointAt(c.wrapS(g0.s + 6), 0, 0);
        look.y += 1.0;
        this._staticCam = { position: eye, lookAt: look, fov: 34 };
        break;
      }

      case 'wheel': {
        put(HERO_S, 0, 0);
        this.frozen = true;
        const car = this.player.model;
        const hub = new THREE.Vector3(0.81, 0.36, -1.62).applyQuaternion(P.quaternion).add(P.position);
        const eye = hub.clone().add(new THREE.Vector3(1.55, 0.42, -1.15).applyQuaternion(P.quaternion));
        this._staticCam = { position: eye, lookAt: hub, fov: 34 };
        this.postfx.settings.dof.enabled = true;
        this.postfx.settings.dof.focus = eye.distanceTo(hub);
        this.postfx.settings.dof.aperture = 0.0038;
        this.postfx.settings.dof.maxblur = 0.010;
        void car;
        break;
      }

      case 'front': {
        this.sky.setTimeOfDay(16.8);
        put(HERO_S, 0, 0);
        this.frozen = true;
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(P.quaternion);
        // Ahead of the nose, looking back down the centreline.
        const eye = P.position.clone().addScaledVector(fwd, 9.2);
        eye.y += 0.58;
        const look = P.position.clone().addScaledVector(fwd, -0.4);
        look.y += 0.40;
        this._staticCam = { position: eye, lookAt: look, fov: 30 };
        this.postfx.settings.dof.enabled = true;
        this.postfx.settings.dof.focus = 9.2;
        this.postfx.settings.dof.aperture = 0.0022;
        break;
      }

      case 'hud':
        put(lead(STRAIGHT_S), c.racingLineOffset(lead(STRAIGHT_S)));
        this.rig.setMode('chase');
        this.hud.setVisible(true);
        break;

      case 'chase':
      default:
        put(lead(CORNER_S), c.racingLineOffset(lead(CORNER_S)));
        this.rig.setMode('chase');
        break;
    }

    this.postfx.applySettings();
    this.lighting.syncToSky();
    this.lighting.refreshEnvironment();

    this.field.syncModels();
    this.rig.target.speed = P.speed;
    this._applyShotCamera(frameIndex);
    this.rig.snap();
    this.rig.update(FIXED_DT);
    // The rig knows its own subject distance; a rig-driven DOF shot should focus
    // there rather than on a hard-coded number that drifts when the camera moves.
    if (!this._staticCam && this.postfx.settings.dof.enabled && this.rig.focusDistance > 0.1) {
      this.postfx.settings.dof.focus = this.rig.focusDistance;
      this.postfx.applySettings();
    }
    this.field.syncModels();
    await this.settle();
    return true;
  }

  _applyShotCamera(_frameIndex = 0) {
    if (!this._staticCam) return;
    const { position, lookAt, fov } = this._staticCam;
    this.camera.position.copy(position);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(lookAt);
    if (this.camera.fov !== fov) { this.camera.fov = fov; this.camera.updateProjectionMatrix(); }
    this.rig.position.copy(position);
    this.rig.lookAt.copy(lookAt);
  }

  dispose() {
    this.pause();
    window.removeEventListener('resize', this._onResize);
    this.input.dispose();
    this.hud.dispose();
    this.particles.dispose();
    this.audio.dispose();
    this.weather.dispose();
    this.field.dispose();
    this.postfx.dispose();
    this.lighting.dispose();
    assets.dispose();
    this.renderer.dispose();
  }
}
