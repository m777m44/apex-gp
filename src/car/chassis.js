/**
 * APEX GP — F1 car body geometry (current-generation regulations).
 *
 * LOCAL COORDINATE FRAME (identical for every car in the game)
 *   +X = car's right,  +Y = up,  -Z = forward (three.js convention)
 *   origin = ground plane at the centre of gravity
 *   front axle z = -1.62, rear axle z = +1.98 (3.60 m wheelbase)
 *   nose tip z = -3.00, rear crash structure z = +2.45, overall width 2.00 m
 *
 * The body is authored as many small pieces and then MERGED PER MATERIAL, so a
 * complete car is ~11 draw calls (body groups + 4 wheels + DRS flap). Geometry
 * is cached in the asset registry per detail level and shared by every car that
 * uses it; only materials differ. Do not add per-frame-animated detail to the
 * merged body — attach it as a separate child (see `drsFlap`).
 *
 * LOFT WINDING (the one thing that will silently eat your geometry)
 *   `loft()` needs (ring tangent) x (row direction) to point OUT of the surface.
 *   Practical test: **the ring must appear CLOCKWISE when you look along the row
 *   direction.** Every ring builder here obeys that:
 *     rows +Z, ring in XY  -> counter-clockwise in (x, y)      [bodySection]
 *     rows +X, ring in ZY  -> counter-clockwise in (z, y)      [aerofoilProfile]
 *     rows +Y, ring in XZ  -> (cos a, -sin a) in (x, z)        [verticalLoft]
 *     rows along a path    -> [top+N, top-N, bot-N, bot+N], N = up x tangent
 *   Reverse the SECTION ORDER to see the inside of a surface — that is how the
 *   sidepod and airbox inlet throats are built.
 *
 * PUBLIC API
 *   buildChassisGeometry(detail?)  -> { buckets:Map<string,BufferGeometry>, drsFlap:BufferGeometry }
 *   createCarModel(entry, opts)    -> CarModel
 *   CarModel.group                 THREE.Group in car-local space
 *   CarModel.setDRS(0..1)
 *   CarModel.setSteer(rad), .setWheelSpin([4]), .setSuspension([4]), .setBrakeHeat(t)
 *   CarModel.anchors               { cockpitEye, chaseTarget, exhaust, nose, tail, roll, frontWing }
 */

import * as THREE from 'three';
import { assets, loft, mergeGeometries } from '../core/assets.js';
import {
  bodyU, haloCurve, haloProfile, sweepUpLocked,
  createHelmetMaterial, HELMET_UV_SPARE,
} from './livery.js';
import { createCarMaterials } from './materials.js';
import { buildWheelSet } from './wheels.js';

export const AXLE_FRONT_Z = -1.62;
export const AXLE_REAR_Z = 1.98;
export const WHEELBASE = AXLE_REAR_Z - AXLE_FRONT_Z;
export const TRACK_FRONT = 1.62;   // distance between front hub centres
export const TRACK_REAR = 1.56;
export const CAR_LENGTH = 5.45;
export const CAR_WIDTH = 2.0;

/**
 * Front wing half-span, to the INBOARD face of the endplate.
 *
 * This number is the single biggest silhouette tell on the whole car and it was
 * wrong by 85 mm a side. The front tyre's outer face sits at
 * `TRACK_FRONT / 2 + TYRE_HALF_WIDTH_FRONT` = 0.810 + 0.1525 = **0.9625 m**. A
 * real front wing stops visibly INSIDE that line — the endplate, the footplate
 * roll-out and the diveplane must all stay behind it, or the wing silhouettes
 * wider than the track and the car reads as a Formula Ford.
 *
 * 0.900 + the endplate half-thickness + the footplate's 0.034 outboard curve
 * puts the widest point of the wing at 0.943 m: 20 mm inboard of the tyre. Head
 * on, the tips step in under the tyre shoulders, which is the read.
 */
const FW_HALF_SPAN = 0.900;
/**
 * Nothing on the front wing may be outboard of this (metres from centreline).
 *
 * 0.944 still let the footplate roll-out and the diveplane put the widest point
 * of the wing within 19 mm of the tyre's outer face (0.9625), and at any camera
 * distance under ~22 m perspective alone makes the wing — which is 1.5 m closer
 * to the lens than the front axle — project WIDER than the tyres regardless.
 * 0.926 leaves a 37 mm step, which is enough for the tips to read as tucked
 * under the tyre shoulders head-on.
 */
const FW_MAX_X = 0.926;
/** Rear wing half-span (1.05 m plane between the endplates). */
const RW_HALF_SPAN = 0.520;
/**
 * Rear-wing main-plane leading-edge height, and the DRS flap hinge derived from
 * it. These two numbers are a PAIR: the flap's leading edge has to sit in the
 * main plane's wake with a slot you can see through, and it used to sit 148 mm
 * above it — a biplane, not a two-element wing, with no DRS gap to open because
 * there was nothing but air between the elements.
 *
 * Main plane: zLE 2.100, chord 0.330, aoa 0.28 -> trailing edge at
 * (y 0.883, z 2.417), upper surface passing (y 0.869, z 2.397).
 * Flap hinge at (0.888, 2.372) puts the flap's lower surface ~20 mm above that
 * surface at 10% of flap chord. That is the slot.
 *
 * RAISED 32 mm AND LENGTHENED 30 mm this round. At 0.760 / 0.300 chord the main
 * plane sat 235 mm BELOW the airbox crown (0.995) and the whole rear assembly
 * read as a low letterbox slot bolted behind the engine cover. On a real car the
 * rear wing is the HIGHEST point of the car: at 0.792 the flap's trailing edge
 * closes at y 1.004 and the endplate at 1.030, i.e. 35 mm proud of the airbox,
 * which is the read. `DRS_HINGE`, the endplate outline, the swan necks and the
 * louvre bank were all moved with it — they are one assembly, and moving the
 * plane alone is what turns a two-element wing back into a biplane.
 *
 * RAISED A FURTHER 20 mm AND LENGTHENED 38 mm this round, because in the `tv`
 * profile the plane still sat level with the airbox crown rather than over it and
 * the chord read short against a 1.04 m span. At 0.812 / 0.368 the trailing edge
 * closes at (y 0.914, z 2.454) and the flap's at y 1.027 — 32 mm proud of the
 * airbox — with the aspect ratio down from 3.2:1 to 2.8:1, which is where a real
 * rear wing sits. `DRS_HINGE`, the endplate top edge, the actuator fairing and the
 * swan necks all moved with it; they are one assembly.
 */
const RW_MAIN_Y = 0.812;
/** Main-plane root chord. Paired with RW_MAIN_Y; see DRS_HINGE. */
const RW_CHORD = 0.368;

/**
 * Geometry budget per detail level. `high` is the player's car (~55 k tris),
 * `low` is every AI car (~16 k tris) — the silhouette survives, the jewellery
 * does not.
 */
const DETAIL = {
  high: { ring: 32, wingN: 9, wingSteps: 15, arc: 88, radial: 12, extras: true, fences: 4, strakes: 3 },
  low: { ring: 14, wingN: 4, wingSteps: 7, arc: 26, radial: 6, extras: false, fences: 2, strakes: 0 },
};
const detailOf = (name) => DETAIL[name] ?? DETAIL.low;

const smooth = (a, b, x) => THREE.MathUtils.smoothstep(x, a, b);

// ---------------------------------------------------------------------------
// Cross-section helpers
// ---------------------------------------------------------------------------

/**
 * A closed body cross-section in the XY plane at a given z.
 *
 * Angular convention matches BODY-UV: a = 0 is +X (the section's right) and the
 * angle increases upward, so the loft's ring parameter lands on
 * v = 0 right, 0.25 top, 0.50 left, 0.75 floor — exactly what livery.js paints.
 *
 * `nTop`/`nBot` are superellipse exponents (2 = ellipse, 5 = nearly flat top).
 * `waist` pinches the lower half inward, which is what makes a sidepod undercut.
 * `openHW`/`openDepth` sink a concave channel into the top of the section: x
 * stays monotonic across the roof, so the ring is still correctly wound, and
 * the tub gets a REAL cockpit opening instead of a lid with a box on it.
 *
 * `crown`/`crownPow` — THE SHOULDER ROLL-OVER. A superellipse alone gives you a
 * choice between a flat deck with a knife-sharp shoulder (high `nTop`) and a
 * barrel (low `nTop`); neither is a sidepod. `crown` drops the deck by
 * `crown * (|px|/hw)^crownPow` metres, i.e. nothing on the centreline and the
 * full amount at the widest line, so the top surface becomes a DOWNWASH RAMP
 * that rolls continuously into the flank. That matters for one measurable
 * reason: an env-lit flank only carries a gradient where its normal SWEEPS, and
 * a vertical wall's reflection vector points into 13 % tarmac at every height on
 * it. See the POD table for the measured normal ladder.
 */
function sectionOffset(o, a) {
  const {
    hw, yTop, yBot, nTop = 3.4, nBot = 3.0,
    waist = 1, waistPow = 1.8, openHW = 0, openDepth = 0, crown = 0, crownPow = 1.8,
  } = o;
  const hh = (yTop - yBot) * 0.5;
  const ca = Math.cos(a), sa = Math.sin(a);
  const n = sa >= 0 ? nTop : nBot;
  let px = Math.sign(ca) * Math.pow(Math.abs(ca), 2 / n) * hw;
  let py = Math.sign(sa) * Math.pow(Math.abs(sa), 2 / n) * hh;
  if (sa < 0 && waist < 1) px *= 1 - (1 - waist) * Math.pow(-sa, waistPow);
  if (sa > 0 && crown > 0) py -= crown * Math.pow(Math.min(1, Math.abs(px) / hw), crownPow);
  if (sa > 0 && openHW > 0) {
    const t = Math.abs(px) / openHW;
    if (t < 1) py -= openDepth * Math.pow(1 - t * t, 0.55);
  }
  return { px, py };
}

function bodySection(count, o) {
  const { z, x = 0, yTop, yBot } = o;
  const cy = (yTop + yBot) * 0.5;
  const pts = [];
  for (let i = 0; i < count; i++) {
    const { px, py } = sectionOffset(o, (i / count) * Math.PI * 2);
    pts.push(new THREE.Vector3(x + px, cy + py, z));
  }
  return pts;
}

const STATION_KEYS = ['z', 'x', 'hw', 'yTop', 'yBot', 'nTop', 'nBot', 'waist', 'waistPow',
  'openHW', 'openDepth', 'crown', 'crownPow'];

/**
 * SEAL A LOFT'S END CAPS — every capped loft on this car was an OPEN TUBE.
 *
 * `core/assets.js#loft({caps:true})` fan-caps the first and last rings, but both
 * fans are wound the wrong way round. Take the first ring, which is
 * counter-clockwise in (x, y) with the rows running +Z: a cap triangle is
 * `(centre, p_c, p_c+1)`, whose normal is `(p_c - centre) x (p_c+1 - p_c)`. At
 * the top of the ring that is `(0,+hh,0) x (-1,0,0)` = **+Z** — i.e. the front
 * cap faces BACKWARDS, into the body. The last ring is capped with the opposite
 * sign and comes out facing -Z, into the body from the other end. Both are
 * therefore back-face culled from outside, and every `caps: true` part on the
 * car — nose tip, floor leading edge, wing tips, blade ends, the underbody
 * closeout — has been a tube open at both ends.
 *
 * MEASURED, before the fix (`tools/_chray.mjs --shot front --px 799,515`): a ray
 * down the nose centreline passed through the tip's end face at z -3.180, then
 * through the underbody closeout's front face at z -1.646, and terminated on
 * `body:carbonMatte` at car-local (0.005, 0.051, +0.010) with normal (0, 1, 0) —
 * **the top surface of the floor**, a sky-facing satin panel, seen from a head-on
 * camera through the front of the car. That is the "pale light-grey block under
 * the nose tip" that has been logged in three consecutive rounds. It was never a
 * material assignment: it was the inside of the car.
 *
 * `loft` is owned by `core/assets.js`, so the flip is applied here on the way
 * out. Only the last `2 * cols` triangles are caps; the side-wall winding (which
 * is correct, and verified in-frame: the nose top deck rays back n = +Y) is left
 * alone. Call BEFORE `computeVertexNormals`.
 */
function sealCaps(g, cols) {
  const idx = g.getIndex();
  if (!idx) return g;
  const a = idx.array;
  for (let i = a.length - cols * 6; i < a.length; i += 3) {
    const t = a[i + 1]; a[i + 1] = a[i + 2]; a[i + 2] = t;
  }
  idx.needsUpdate = true;
  return g;
}

/** `loft` with both end caps wound outward. See `sealCaps`. */
function loftSolid(sections, o = {}) {
  return sealCaps(loft(sections, { ...o, caps: true }), sections[0].length);
}

/** Linearly interpolate a station list at an arbitrary z (used for shutlines). */
function stationAt(list, z) {
  let i = 0;
  while (i < list.length - 2 && list[i + 1].z < z) i++;
  const a = list[i], b = list[i + 1];
  const t = THREE.MathUtils.clamp((z - a.z) / (b.z - a.z || 1), 0, 1);
  const out = {};
  for (const k of STATION_KEYS) {
    const av = a[k], bv = b[k];
    if (av === undefined && bv === undefined) continue;
    out[k] = THREE.MathUtils.lerp(av ?? bv, bv ?? av, t);
  }
  return out;
}

/** Push every point of a section outward from its centroid. */
function expandRing(pts, d) {
  const c = new THREE.Vector3();
  for (const p of pts) c.add(p);
  c.divideScalar(pts.length);
  return pts.map((p) => {
    const dx = p.x - c.x, dy = p.y - c.y;
    const l = Math.hypot(dx, dy) || 1;
    return new THREE.Vector3(p.x + (dx / l) * d, p.y + (dy / l) * d, p.z);
  });
}

/**
 * A narrow raised band around a body at `z` — reads as a panel shutline once it
 * is drawn in matte carbon against gloss paint.
 */
function shutline(stations, z, ring, { halfLen = 0.008, grow = 0.004 } = {}) {
  const a = bodySection(ring, { ...stationAt(stations, z - halfLen), z: z - halfLen });
  const b = bodySection(ring, { ...stationAt(stations, z + halfLen), z: z + halfLen });
  return loft([expandRing(a, grow), expandRing(b, grow)], { closed: true, caps: false });
}

/** Re-unwrap a lofted body part into BODY-UV space (u = nose->tail, v = around). */
function bodyUV(g) {
  const uv = g.getAttribute('uv');
  const pos = g.getAttribute('position');
  // CLAMPED. The nose tip is at z = -3.180 but `livery.BODY_Z0` is -3.00, so
  // `bodyU` goes NEGATIVE over the front 180 mm and the livery texture (wrapping)
  // sampled u ~0.97 there — the tail of the car — painting a stray band of the
  // rear livery across the blunt tip face that `sealCaps` has just made visible.
  for (let i = 0; i < uv.count; i++) {
    uv.setXY(i, THREE.MathUtils.clamp(bodyU(pos.getZ(i)), 0.0004, 0.9996), uv.getX(i));
  }
  uv.needsUpdate = true;
  return g;
}

/**
 * Loft a station list into a closed body shell.
 * `tile` re-unwraps the result in metres — pass it for parts that go into a
 * carbon bucket instead of the livery-mapped `paint` bucket.
 */
function bodyLoft(stations, ring, { caps = true, reverse = false, tile = null } = {}) {
  const sections = stations.map((s) => bodySection(ring, s));
  if (reverse) sections.reverse();
  const g = caps ? loftSolid(sections, { closed: true }) : loft(sections, { closed: true, caps: false });
  g.computeVertexNormals();
  if (tile) loftUV(g, sections, tile[0], tile[1]);
  return g;
}

// ---------------------------------------------------------------------------
// Carbon-weave UV scaling
// ---------------------------------------------------------------------------
//
// `materials.js` tiles the shared 0.25 m weave tile by (4, 8) for the `carbon`
// bucket and (3.4, 3.4) for `carbonMatte`, so ONE UV UNIT must span
// repeat * 0.25 metres of real surface for the tows to land at 5 mm. Anything
// that ships raw loft/extrude UVs (0..1 across a 30 mm blade, 0..1 along a 2 m
// halo) smears those 5 mm tows into 100:1 stripes — which is what made the halo
// read as a rope and the aero furniture read as brushed plastic.

// The tile itself is 50 tow crossings across `TOW_TILE` metres. A 2/2 twill's
// diagonal rib repeats every FOUR crossings, so the pattern a viewer actually
// sees has a pitch of 4 * TOW_TILE / 50. At 0.25 m that rib is 20 mm and the
// wing reads like a woven basket; real 3k pre-preg ribs at 7-9 mm.
const TOW_TILE = 0.115;
const WEAVE = {
  carbon: [4 * TOW_TILE, 8 * TOW_TILE],           // matches repeat (4, 8)
  carbonMatte: [3.4 * TOW_TILE, 3.4 * TOW_TILE],  // matches repeat (3.4, 3.4)
};

/**
 * Rewrite a lofted part's UVs in metres: u follows the ring perimeter, v the
 * distance travelled along the rows. Pass the same `sections` the loft was
 * built from. Cap vertices keep their (0.5, 0.5) — caps are end faces a few
 * millimetres across and never carry a readable weave.
 */
function loftUV(g, sections, tileU, tileV, closed = true) {
  const rows = sections.length, cols = sections[0].length;
  const colCount = closed ? cols + 1 : cols;
  const uv = g.getAttribute('uv');
  const perim = new Float32Array(colCount);
  for (let c = 1; c < colCount; c++) {
    let d = 0;
    for (let r = 0; r < rows; r++) d += sections[r][(c - 1) % cols].distanceTo(sections[r][c % cols]);
    perim[c] = perim[c - 1] + d / rows;
  }
  const along = new Float32Array(rows);
  for (let r = 1; r < rows; r++) {
    let d = 0;
    for (let c = 0; c < cols; c++) d += sections[r][c].distanceTo(sections[r - 1][c]);
    along[r] = along[r - 1] + d / cols;
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < colCount; c++) {
      const i = r * colCount + c;
      if (i < uv.count) uv.setXY(i, perim[c] / tileU, along[r] / tileV);
    }
  }
  uv.needsUpdate = true;
  return g;
}

/**
 * Triplanar UVs in metres for parts with no natural parameterisation (extruded
 * plates, boxes, louvres). Each vertex projects along the dominant axis of its
 * own normal, so a plate drawn in ZY gets (z, y) and a floor panel gets (x, z).
 * Seams only occur where the normal crosses 45 deg, i.e. on bevels, and the
 * weave is fine and stochastic enough that they do not read.
 */
function metricUV(g, tileU, tileV) {
  const pos = g.getAttribute('position');
  if (!g.getAttribute('normal')) g.computeVertexNormals();
  const nrm = g.getAttribute('normal');
  let uv = g.getAttribute('uv');
  if (!uv) {
    uv = new THREE.BufferAttribute(new Float32Array(pos.count * 2), 2);
    g.setAttribute('uv', uv);
  }
  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nrm.getX(i)), ny = Math.abs(nrm.getY(i)), nz = Math.abs(nrm.getZ(i));
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    if (nx >= ny && nx >= nz) uv.setXY(i, z / tileU, y / tileV);
    else if (ny >= nz) uv.setXY(i, x / tileU, z / tileV);
    else uv.setXY(i, x / tileU, y / tileV);
  }
  uv.needsUpdate = true;
  return g;
}

/** metricUV for the matte-carbon bucket (the common case). */
const matteUV = (g) => metricUV(g, WEAVE.carbonMatte[0], WEAVE.carbonMatte[1]);
/** metricUV for the gloss-carbon bucket (wings, mirrors). */
const glossUV = (g) => metricUV(g, WEAVE.carbon[0], WEAVE.carbon[1]);

// ---------------------------------------------------------------------------
// Aerofoil helpers
// ---------------------------------------------------------------------------

/**
 * Closed inverted-aerofoil ring in chord space, ordered so that a wing lofted
 * from left (-x) to right (+x) faces outward: counter-clockwise in (chord, thickness).
 */
/**
 * @param {number} n          chordwise stations per surface
 * @param {number} thickness  t/c
 * @param {number} camber     max camber as a fraction of chord (negative lift)
 * @param {{nose?:number, te?:number, teChamfer?:number}} [o]
 *
 * `nose` scales the sqrt term by `1 + (nose-1)(1-x)` — the bulge therefore dies
 * at the trailing edge and the section still CLOSES (scaling the sqrt term flat
 * leaves `yt(1) = 5t(0.2969(nose-1))`, i.e. a 91 mm-thick trailing edge at
 * nose 2.05, which is a wedge, not a wing). What it changes is the
 * LEADING-EDGE RADIUS, and that is a
 * rendering number as much as an aero one. NACA's radius is 1.1019 t^2 c: on a
 * 300 mm mainplane at t/c 0.058 that is **1.1 mm**, so the round-over that is
 * supposed to catch the sky on every element's leading edge is a sub-pixel
 * feature at any framing a car is photographed from, and the four elements
 * silhouette as one corrugated slab. A real front-wing flap LE is 4-6 mm.
 *
 * `te` opens the trailing edge to a finite thickness (t/c units) instead of the
 * knife edge a 4-digit section closes to, and `teChamfer` breaks that blunt end
 * into two facets over the last few percent of chord. The upper facet turns to
 * the sky and the blunt end stays in shade, so each element's trailing edge is
 * a light-over-dark pair instead of a vanishing wedge — which is what puts a
 * lit edge at the top of every slot.
 */
function aerofoilProfile(n = 9, thickness = 0.09, camber = 0.085, o = {}) {
  const { nose = 1, te = 0, teChamfer = 0.05 } = o;
  const yt = (x) => 5 * thickness * (
    0.2969 * Math.sqrt(x) * (1 + (nose - 1) * (1 - x))
    - 0.126 * x - 0.3516 * x * x + 0.2843 * x ** 3 - 0.1036 * x ** 4
  ) + te * x;
  const yc = (x) => -camber * 4 * x * (1 - x);   // negative camber = downforce
  const upper = [], lower = [];
  for (let i = 0; i <= n; i++) {
    // Cosine spacing packs points at the leading edge where curvature is high.
    let x = 0.5 * (1 - Math.cos((i / n) * Math.PI));
    // Pull the last station forward of the TE and let the closing segment be the
    // chamfer, so the blunt end is a real facet pair rather than one square face.
    if (te > 0 && i === n) x = 1 - teChamfer;
    upper.push(new THREE.Vector2(x, yc(x) + yt(x) * 0.5));
    lower.push(new THREE.Vector2(x, yc(x) - yt(x) * 0.5));
  }
  if (te > 0) {
    const h = te * 0.5 * 0.42;                    // the blunt end, 42% of full TE
    upper.push(new THREE.Vector2(1, yc(1) + h));
    lower.push(new THREE.Vector2(1, yc(1) - h));
  }
  // LE -> upper -> TE -> lower -> LE.
  return [...upper, ...lower.slice(1, -1).reverse()];
}

/**
 * Lofts a wing from spanwise stations, ordered left (-x) to right (+x).
 * `aoa` positive raises the trailing edge (more downforce on an inverted wing).
 * `roll` rotates the section about +Z, which is how a modern rear wing tip
 * curls up into its endplate.
 */
function buildWingGeometry(stations, o = {}) {
  const { profileN = 9, thickness = 0.085, camber = 0.09, tile = WEAVE.carbon,
    nose = 1, te = 0, teChamfer = 0.05 } = o;
  const profile = aerofoilProfile(profileN, thickness, camber, { nose, te, teChamfer });
  const sections = stations.map((st) => {
    const c = st.chord;
    const ca = Math.cos(st.aoa), sa = Math.sin(st.aoa);
    const roll = st.roll ?? 0;
    const cr = Math.cos(roll), sr = Math.sin(roll);
    return profile.map((p) => {
      const dz = p.x * c, dy = p.y * c;
      const uy = dz * sa + dy * ca;          // vertical offset after angle of attack
      const uz = dz * ca - dy * sa;          // chordwise offset
      return new THREE.Vector3(st.x - uy * sr, st.y + uy * cr, st.zLE + uz);
    });
  });
  const g = loftSolid(sections, { closed: true });
  g.computeVertexNormals();
  loftUV(g, sections, tile[0], tile[1]);
  return g;
}

/**
 * An upright plate drawn in the (carZ, carY) plane and extruded across X.
 * `curl(y, z)` optionally bends it outward — the front-wing endplate flick.
 */
function plateGeometry(outline, thickness, o = {}) {
  // `bevel` is the chamfer as a FRACTION OF THE PLATE THICKNESS. It defaulted to
  // 0.4, which on a 16 mm endplate is a 6.4 mm chamfer running the whole outline
  // — and `carbonMatte` is a light satin (0xdad8d6) with a clearcoat lobe, so
  // that chamfer catches the sun and draws a bright chrome pinstripe around every
  // aero part. Real pre-preg edges are a 1 mm radius. Aero plates now pass 0.15.
  const { curveSegments = 4, curl = null, bevel = 0.4 } = o;
  const shape = new THREE.Shape();
  outline.forEach((p, i) => (i ? shape.lineTo(p[0], p[1]) : shape.moveTo(p[0], p[1])));
  shape.closePath();
  const b = thickness * bevel;
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: thickness, bevelEnabled: b > 1e-4,
    bevelSize: b, bevelThickness: b, bevelSegments: 1, curveSegments,
  });
  g.translate(0, 0, -thickness / 2);
  // Shape-x -> +Z, extrusion depth -> X: the plate ends up upright and facing
  // sideways at the Z positions it was drawn at.
  g.rotateY(-Math.PI / 2);
  if (curl) {
    const pos = g.getAttribute('position');
    for (let i = 0; i < pos.count; i++) pos.setX(i, pos.getX(i) + curl(pos.getY(i), pos.getZ(i)));
    pos.needsUpdate = true;
    g.computeVertexNormals();
  }
  return g;
}

/**
 * A thin vertical blade swept along a horizontal path — floor fences, diffuser
 * strakes, barge boards, turning vanes. Path entries are {x, z, y0, y1}.
 */
function bladeGeometry(path, thickness, tile = WEAVE.carbonMatte) {
  const half = thickness * 0.5;
  const sections = path.map((p, i) => {
    const a = path[Math.max(0, i - 1)], b = path[Math.min(path.length - 1, i + 1)];
    const tx = b.x - a.x, tz = b.z - a.z;
    const l = Math.hypot(tx, tz) || 1;
    // N = up x tangent, so the ring below reads clockwise along the path.
    const nx = tz / l, nz = -tx / l;
    return [
      new THREE.Vector3(p.x + nx * half, p.y1, p.z + nz * half),
      new THREE.Vector3(p.x - nx * half, p.y1, p.z - nz * half),
      new THREE.Vector3(p.x - nx * half, p.y0, p.z - nz * half),
      new THREE.Vector3(p.x + nx * half, p.y0, p.z + nz * half),
    ];
  });
  const g = loftSolid(sections, { closed: true });
  g.computeVertexNormals();
  loftUV(g, sections, tile[0], tile[1]);
  return g;
}

/**
 * Stack rings drawn in the XZ plane along +Y — vertical struts with a real
 * aerofoil section (halo pillar, rear-wing swan necks, roll-hoop blade).
 * Rings are supplied as [{z, x}] and reordered to (cos a, -sin a) winding.
 */
function verticalLoft(rows, tile = WEAVE.carbonMatte) {
  const sections = rows.map((row) =>
    row.ring.map((p) => new THREE.Vector3(p.x, row.y, p.z))
  );
  const g = loftSolid(sections, { closed: true });
  g.computeVertexNormals();
  loftUV(g, sections, tile[0], tile[1]);
  return g;
}

/** Symmetric aerofoil ring in the XZ plane, wound for a +Y loft. */
function strutRing(n, cz, chord, thick, sweep = 0) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const c = Math.cos(a), s = -Math.sin(a);
    // (c) walks the chord, (s) the thickness; |c|^0.7 fattens the nose.
    const zc = cz + (chord * 0.5) * (-c) + sweep;
    const xc = (thick * 0.5) * s * Math.pow(1 - c * c, 0.25) * 1.35;
    pts.push({ z: zc, x: xc });
  }
  return pts;
}

// ---------------------------------------------------------------------------
// Body station tables
// ---------------------------------------------------------------------------

/**
 * Nose cone: tip at the wing, climbing to the front bulkhead.
 *
 * **THE TIP MUST PROJECT FORWARD OF THE MAINPLANE.** The defining head-on read
 * of a modern car is a slender high nose whose tip stands proud of the wing
 * stack, with the flaps stepping back and up behind it. The tip used to sit at
 * z = -3.020, i.e. 85 mm BEHIND element 1's leading edge at -3.105, which
 * inverts that read: the wing became the front of the car and the nose a lump
 * bolted on top. -3.180 puts the tip 75 mm ahead of the mainplane.
 */
/**
 * **AND THE TIP SECTION IS A TRAPEZOID, NOT A CIRCLE.** At `hw` 0.050 / `nTop`
 * 2.3 the tip was a 100 mm round bullet — the 2014-16 "anteater" read. The
 * current-regulation tip is a blunt slab roughly 250-300 mm across with a flat
 * top, a flatter underside, and the sides raked in between the two. Three
 * numbers do all of it:
 *   `hw` 0.130          260 mm across the widest line
 *   `nTop`/`nBot` 4.4/5.6  superellipse exponents — high = square, so the top
 *                       deck and the underside are both nearly flat
 *   `waist` 0.70, `waistPow` 0.9   pinches the LOWER half to 0.70 of full width
 *                       almost linearly in the ring angle, which is exactly a
 *                       chamfered side: 260 mm at the shoulder, 182 mm at the
 *                       keel. (`waistPow` 1.8 would round it back off.)
 * `bodyLoft(..., {caps:true})` fans the first ring into a flat blunt end face,
 * so the tip really does terminate in a squared-off plate rather than a point.
 * The waist relaxes to 1 and the exponents come back down by the bulkhead, so
 * the section is round again where the tub picks it up. `bodyU(z)` is untouched,
 * so the yellow chevron just paints wider.
 */
const NOSE = [
  { z: -3.180, hw: 0.130, yBot: 0.148, yTop: 0.252, nTop: 4.4, nBot: 5.6, waist: 0.70, waistPow: 0.9 },
  { z: -3.084, hw: 0.134, yBot: 0.147, yTop: 0.262, nTop: 4.2, nBot: 5.2, waist: 0.72, waistPow: 0.9 },
  { z: -2.900, hw: 0.144, yBot: 0.149, yTop: 0.294, nTop: 3.9, nBot: 4.5, waist: 0.76, waistPow: 1.0 },
  { z: -2.680, hw: 0.156, yBot: 0.153, yTop: 0.330, nTop: 3.6, nBot: 3.9, waist: 0.82, waistPow: 1.2 },
  { z: -2.380, hw: 0.174, yBot: 0.158, yTop: 0.368, nTop: 3.4, nBot: 3.3, waist: 0.88, waistPow: 1.4 },
  { z: -2.060, hw: 0.196, yBot: 0.165, yTop: 0.408, nTop: 3.3, nBot: 3.0, waist: 0.94, waistPow: 1.6 },
  { z: -1.780, hw: 0.220, yBot: 0.172, yTop: 0.452, nTop: 3.3, nBot: 2.9 },
  { z: -1.540, hw: 0.242, yBot: 0.178, yTop: 0.500, nTop: 3.4, nBot: 3.0 },
  { z: -1.340, hw: 0.262, yBot: 0.184, yTop: 0.545, nTop: 3.5, nBot: 3.0 },
];

/** Survival cell: front bulkhead to the back of the cockpit. */
const TUB = [
  { z: -1.360, hw: 0.258, yBot: 0.184, yTop: 0.542, nTop: 3.5, nBot: 3.0 },
  { z: -1.120, hw: 0.300, yBot: 0.132, yTop: 0.572, nTop: 3.7, nBot: 3.2 },
  { z: -0.820, hw: 0.338, yBot: 0.098, yTop: 0.594, nTop: 4.0, nBot: 3.4 },
  { z: -0.500, hw: 0.362, yBot: 0.078, yTop: 0.606, nTop: 4.2, nBot: 3.6 },
  { z: -0.180, hw: 0.376, yBot: 0.068, yTop: 0.616, nTop: 4.4, nBot: 3.8 },
  { z: 0.120, hw: 0.378, yBot: 0.064, yTop: 0.624, nTop: 4.4, nBot: 3.8 },
  { z: 0.400, hw: 0.360, yBot: 0.064, yTop: 0.634, nTop: 4.2, nBot: 3.6 },
  { z: 0.620, hw: 0.328, yBot: 0.068, yTop: 0.636, nTop: 4.0, nBot: 3.4 },
];

/** Roll hoop blade -> airbox -> engine cover -> gearbox -> crash structure. */
const COVER = [
  { z: -0.090, hw: 0.072, yBot: 0.600, yTop: 0.975, nTop: 2.6, nBot: 3.0 },
  { z: 0.060, hw: 0.116, yBot: 0.545, yTop: 0.995, nTop: 3.0, nBot: 3.4 },
  { z: 0.220, hw: 0.156, yBot: 0.480, yTop: 0.988, nTop: 3.4, nBot: 3.6 },
  { z: 0.460, hw: 0.184, yBot: 0.415, yTop: 0.946, nTop: 3.6, nBot: 3.6 },
  { z: 0.760, hw: 0.192, yBot: 0.362, yTop: 0.874, nTop: 3.6, nBot: 3.4 },
  { z: 1.080, hw: 0.176, yBot: 0.330, yTop: 0.790, nTop: 3.4, nBot: 3.2 },
  { z: 1.400, hw: 0.146, yBot: 0.312, yTop: 0.706, nTop: 3.2, nBot: 3.0 },
  { z: 1.720, hw: 0.112, yBot: 0.302, yTop: 0.618, nTop: 3.0, nBot: 2.8 },
  { z: 2.020, hw: 0.082, yBot: 0.300, yTop: 0.534, nTop: 2.8, nBot: 2.6 },
  { z: 2.260, hw: 0.060, yBot: 0.306, yTop: 0.474, nTop: 2.6, nBot: 2.5 },
  { z: 2.440, hw: 0.042, yBot: 0.320, yTop: 0.428, nTop: 2.4, nBot: 2.4 },
];

/**
 * Sidepod: letterbox inlet, maximum volume over the front of the floor, then a
 * hard coke-bottle taper. `waist` is the undercut — the lower half tucks in
 * over the floor's venturi inlet.
 *
 * THE FLANK CARRIED NO ENVIRONMENT GRADIENT BECAUSE IT WAS A WALL. At `nTop`
 * 5.6 the upper half is a flat deck with a ~25 mm shoulder radius, so 84 mm of
 * flank between the widest line and the shoulder sat within 6 deg of vertical,
 * and `waistPow` 1.8 meant the undercut did not start biting until 40 % of the
 * way down the lower half — another 60 mm of wall. A vertical surface reflects
 * the horizon: 13 % tarmac, at every height on it, which is why a paint
 * env-gain sweep from 0 to 20 came back pixel-identical. It is geometry, and
 * these are the numbers (right flank, station z = 0, normal angle from +Y):
 *
 *          y      OLD (nTop 5.6)     NEW (nTop 4.6, crown 58 mm)
 *        0.470       0 deg (deck)        —   deck peak is now 0.492
 *        0.440      69                  22   sloping downwash ramp
 *        0.400      86                  47   the roll-over itself
 *        0.360      90                  70
 *        0.331      90 (widest)         90   widest line
 *        0.300      90                 103   undercut has already started
 *
 * So the flank now sweeps ~90 deg of normal over 190 mm instead of jumping 90
 * deg in the last 30: the top band reflects sky, the middle band the horizon,
 * the bottom band tarmac, and that IS the gradient. `crown` is the downwash
 * ramp (see `sectionOffset`), `waistPow` ~1.15 starts the undercut at the
 * widest line, and `yTop` is raised by the crown so the inboard deck height is
 * unchanged — only the outboard shoulder drops.
 */
const POD = [
  { z: -0.895, x: 0.572, hw: 0.116, yBot: 0.252, yTop: 0.410, nTop: 4.6, nBot: 4.0, waist: 0.62, waistPow: 1.50, crown: 0.014, crownPow: 1.7 },
  { z: -0.720, x: 0.590, hw: 0.166, yBot: 0.222, yTop: 0.444, nTop: 4.8, nBot: 4.0, waist: 0.52, waistPow: 1.35, crown: 0.030, crownPow: 1.7 },
  { z: -0.400, x: 0.578, hw: 0.232, yBot: 0.188, yTop: 0.478, nTop: 4.8, nBot: 3.8, waist: 0.42, waistPow: 1.20, crown: 0.048, crownPow: 1.7 },
  { z: 0.000, x: 0.546, hw: 0.276, yBot: 0.170, yTop: 0.492, nTop: 4.6, nBot: 3.6, waist: 0.36, waistPow: 1.12, crown: 0.058, crownPow: 1.7 },
  { z: 0.400, x: 0.502, hw: 0.288, yBot: 0.160, yTop: 0.488, nTop: 4.5, nBot: 3.6, waist: 0.35, waistPow: 1.12, crown: 0.060, crownPow: 1.7 },
  { z: 0.800, x: 0.438, hw: 0.272, yBot: 0.156, yTop: 0.466, nTop: 4.4, nBot: 3.6, waist: 0.38, waistPow: 1.20, crown: 0.056, crownPow: 1.7 },
  { z: 1.150, x: 0.356, hw: 0.226, yBot: 0.156, yTop: 0.432, nTop: 4.2, nBot: 3.4, waist: 0.44, waistPow: 1.35, crown: 0.044, crownPow: 1.7 },
  { z: 1.450, x: 0.264, hw: 0.166, yBot: 0.162, yTop: 0.394, nTop: 3.8, nBot: 3.2, waist: 0.54, waistPow: 1.50, crown: 0.028, crownPow: 1.7 },
  { z: 1.700, x: 0.172, hw: 0.100, yBot: 0.176, yTop: 0.350, nTop: 3.2, nBot: 3.0, waist: 0.70, waistPow: 1.70, crown: 0.012, crownPow: 1.7 },
  { z: 1.820, x: 0.110, hw: 0.052, yBot: 0.200, yTop: 0.314, nTop: 2.8, nBot: 2.8, waist: 0.85, crown: 0.004, crownPow: 1.7 },
  // Tail closer. The pod is lofted with `caps: false` so that its FRONT is an
  // open ring the inlet can be seen through (see buildSidepodInlet); this
  // near-degenerate station is what seals the other end instead of a fan cap.
  // crown MUST be 0 here: `stationAt` carries a missing key forward from the
  // previous station, and a 4 mm crown on a 6 mm half-height section folds the
  // top of the ring below its own widest line.
  { z: 1.868, x: 0.092, hw: 0.005, yBot: 0.250, yTop: 0.262, nTop: 2.6, nBot: 2.6, crown: 0 },
];

// ---------------------------------------------------------------------------
// Body parts
// ---------------------------------------------------------------------------

function buildNose(D) {
  return bodyUV(bodyLoft(NOSE, D.ring));
}

/**
 * The nose's lower chamfer ridge — the hard line where the flat top deck breaks
 * into the raked side of the tip trapezoid.
 *
 * The `waist` taper in `NOSE` puts the geometry there, but `computeVertexNormals`
 * smooths straight across it, so there is no normal discontinuity for a highlight
 * to break on and head-on the tip still rounds off into the shadow. This is the
 * same trick `buildPodRampLip` uses on the sidepod shoulder: a 12 mm rib sitting
 * ON the widest line, which a superellipse places exactly at (yTop+yBot)/2.
 *
 * It goes in the PAINT bucket, not carbon — the chamfer is painted bodywork on
 * a real car, and a satin-carbon rib here would draw a grey pinstripe down the
 * length of the livery. It is re-unwrapped into BODY-UV at v = 0 / 0.5, i.e. the
 * ring angle the ridge actually sits at.
 */
function buildNoseChamfer(D) {
  const parts = [];
  const steps = D.extras ? 14 : 6;
  for (const side of [-1, 1]) {
    const path = [];
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const z = -3.178 + t * 1.298;
      const st = stationAt(NOSE, z);
      const y = (st.yTop + st.yBot) * 0.5;
      // Fade the REAR end only. The forward end used to fade in from zero over the
      // first 77 mm, which is exactly the length of the blunt tip — so the one
      // place the chamfer has to read, head-on, was the one place the rib was not
      // there. It now starts at 78% depth on the tip's own end face.
      const fade = Math.sin(Math.min(1, 0.55 + t / 0.05) * Math.PI * 0.5)
        * Math.sin(Math.min(1, (1 - t) / 0.22) * Math.PI * 0.5);
      path.push({
        x: side * (st.hw + 0.003), z,
        y0: y - 0.013 * fade - 0.003,
        y1: y + 0.007 * fade + 0.003,
      });
    }
    const g = bladeGeometry(path, 0.012);
    // BODY-UV: u from z, v pinned to the flank the rib is on (0 = right flank,
    // 0.5 = left) so it samples the same livery pixels as the skin beside it.
    const uv = g.getAttribute('uv');
    const pos = g.getAttribute('position');
    for (let i = 0; i < uv.count; i++) uv.setXY(i, bodyU(pos.getZ(i)), side > 0 ? 0.004 : 0.496);
    uv.needsUpdate = true;
    parts.push(g);
  }
  return mergeGeometries(parts);
}

function buildTub(D) {
  return bodyUV(bodyLoft(TUB, D.ring));
}

function buildEngineCover(D) {
  return bodyUV(bodyLoft(COVER, D.ring));
}

function buildSidepod(side, D) {
  const stations = POD.map((s) => ({ ...s, x: side * s.x }));
  // NO FRONT CAP. The sidepod's fan cap at z = -0.895 was a solid painted disc
  // across the whole inlet, so all 320 mm of duct behind it was invisible and
  // the pod read as a closed canoe with a decal where the radiator should be.
  // `buildSidepodInlet` supplies the chamfered lip that seals this open ring.
  return bodyUV(bodyLoft(stations, D.ring, { caps: false }));
}

/**
 * The lower surface of a sidepod as an open ribbon, offset 5 mm outward.
 *
 * A real pod's undercut is BARE CARBON, and that is most of why the tunnel
 * entrance reads as a shadowed void on a real car and read as a bright red
 * shoulder here: `paint` runs `envMapIntensity 1.45` with a full clearcoat lobe,
 * so a downward-facing concave surface in that material collects the whole lower
 * hemisphere and comes out LIGHTER than the flank above it. Screen-space GTAO
 * cannot fix that — at its radius it cannot see a 250 mm cavity — but moving the
 * surface into `carbonMatte` can, and it is also what the car actually is.
 *
 * `a` runs 1.13pi -> 1.87pi so the ribbon covers the underside and the bottom
 * third of each flank and stops before it eats the painted bodyside.
 */
function podUnderArc(count, o, grow) {
  const { z, x = 0, yTop, yBot } = o;
  const cy = (yTop + yBot) * 0.5;
  // 1.06pi now, not 1.13pi: the undercut starts AT the widest line (see POD's
  // waistPow), so the bare-carbon ribbon has to start there too or a 20 mm band
  // of painted red is left hanging over the tunnel entrance.
  const A0 = Math.PI * 1.06, A1 = Math.PI * 1.94;
  const pts = [];
  for (let i = 0; i <= count; i++) {
    const { px, py } = sectionOffset(o, A0 + (A1 - A0) * (i / count));
    const l = Math.hypot(px, py) || 1;
    pts.push(new THREE.Vector3(x + px + (px / l) * grow, cy + py + (py / l) * grow, z));
  }
  return pts;
}

/**
 * A point on a station's outer skin at ring angle `a` (0 = the widest point,
 * +pi/2 = the top). Louvres, gills and creases have to be placed ON the skin;
 * placing them at a fraction of `hw` (which is what `buildLouvres` used to do)
 * buries some of the bank inside the body and floats the rest, so the result
 * reads as a scatter of black stickers rather than a vent bank.
 */
function skinPoint(st, side, a) {
  const cy = (st.yTop + st.yBot) * 0.5;
  const { px, py } = sectionOffset(st, a);
  return { x: side * ((st.x ?? 0) + px), y: cy + py };
}

function buildPodShroud(side, D) {
  const n = D.extras ? 12 : 6;
  // NOTE the left pod is a TRANSLATE of the right one, not a mirror: only the
  // station's centre x is negated and `bodySection` is symmetric in x. So the
  // ring parameterisation — and therefore the winding — is identical on both
  // sides and must NOT be reversed.
  const sections = POD.slice(0, POD.length - 1)
    .map((s) => podUnderArc(n, { ...s, x: side * s.x }, 0.005));
  const g = loft(sections, { closed: false, caps: false });
  g.computeVertexNormals();
  return loftUV(g, sections, WEAVE.carbonMatte[0], WEAVE.carbonMatte[1], false);
}

/**
 * The hard carbon lip along the top outboard edge of the sidepod — the edge of
 * the downwash ramp.
 *
 * The review asked for the pod's `nTop` superellipse exponent to be DROPPED from
 * 5.4-5.6 to ~3.2 to get a crease. That is backwards: a higher exponent is a
 * squarer section with a TIGHTER shoulder radius, and 3.2 would have rounded the
 * pod off further. The real reason there was no crease is that
 * `computeVertexNormals` smooths across the shoulder no matter how tight it is,
 * so there is no normal discontinuity for a highlight to break on. A physical
 * lip gives you one — and it is what the part looks like.
 */
function buildPodRampLip(side, D) {
  // The point on the upper superellipse at |px| = f * hw. `f` is unsigned and the
  // side is applied to the whole (centre + offset), because the section is
  // symmetric in x and the left pod is a translate, not a mirror.
  // NOTE this must evaluate the SAME surface `bodySection` builds, crown and all
  // — a lip authored against the bare superellipse floats 40 mm off a crowned
  // deck at the shoulder, which is where it is most visible.
  const surfaceAt = (st, f) => {
    const cy = (st.yTop + st.yBot) * 0.5;
    const c = Math.pow(f, st.nTop / 2);
    const a = Math.acos(THREE.MathUtils.clamp(c, -1, 1));
    return { x: side * (st.x + f * st.hw), y: cy + sectionOffset(st, a).py };
  };
  const parts = [];
  const steps = D.extras ? 12 : 6;
  const ramp = [];
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    const z = -0.780 + t * 1.960;
    const st = stationAt(POD, z);
    const p = surfaceAt(st, 0.90);
    // Fade the lip in and out so it does not end in a step at either extremity.
    const fade = Math.sin(Math.min(1, t / 0.10) * Math.PI * 0.5) * Math.sin(Math.min(1, (1 - t) / 0.16) * Math.PI * 0.5);
    const h = 0.010 + fade * 0.026;
    ramp.push({ x: p.x, z, y0: p.y - 0.020, y1: p.y + h });
  }
  parts.push(bladeGeometry(ramp, 0.013));

  // SHOULDER CREASE. The ramp lip alone still left the whole flank below it as
  // one continuous painted surface with a single rolling highlight — the "smooth
  // red canoe". A real pod has a hard step along its widest line, where the
  // radiator bay's outer skin meets the undercut panel. A superellipse is widest
  // at y = (yTop + yBot)/2, so that line is exact; an 8 mm ledge there splits the
  // flank into an upper and a lower band and puts a shadow between them.
  const crease = [];
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    const z = -0.840 + t * 2.180;
    const st = stationAt(POD, z);
    const fade = Math.sin(Math.min(1, t / 0.09) * Math.PI * 0.5) * Math.sin(Math.min(1, (1 - t) / 0.14) * Math.PI * 0.5);
    const y = (st.yTop + st.yBot) * 0.5;
    crease.push({
      x: side * (st.x + st.hw + 0.004),
      z, y0: y - 0.026 * fade - 0.004, y1: y + 0.010 * fade + 0.004,
    });
  }
  parts.push(bladeGeometry(crease, 0.015));
  return mergeGeometries(parts);
}

/**
 * The dark throat behind an inlet. Sections run from the deep end to the mouth
 * so the loft's normals point INWARD and we see the inside of the duct.
 */
function buildInletThroat(sections, ring) {
  const rings = sections.map((s) => bodySection(ring, s)).reverse();
  const g = loft(rings, { closed: true, caps: false });
  g.computeVertexNormals();
  return g;
}

/**
 * SIDEPOD INLET — a real aperture, not a painted rectangle.
 *
 * Three things had to be true at once and only one of them was:
 *  1. the sidepod must not be capped at the front (see `buildSidepod`);
 *  2. there must be a chamfered LIP joining the skin to the mouth, or the open
 *     ring shows daylight through the backfaces;
 *  3. the throat must be deep AND close to a point, so the far end is genuinely
 *     black instead of a bright pinhole.
 */
function buildSidepodInlet(side, D) {
  // MUST match the sidepod's own ring count: the lip's outer edge shares vertices
  // with the pod's now-uncapped front ring, and a 16-gon inscribed in a 32-gon
  // leaves sixteen slivers of daylight along the joint.
  const ring = D.ring;
  const parts = [];
  const skin = { ...POD[0], x: side * POD[0].x };
  const mouth = {
    z: -0.912, x: side * 0.574, hw: 0.104, yBot: 0.262, yTop: 0.392, nTop: 5.2, nBot: 4.6,
  };

  // Chamfered lip: mouth ring FIRST so the rows run +Z and the normals point out
  // of the chamfer (which is what a lip is — a surface you see from in front).
  const lip = loft([bodySection(ring, mouth), bodySection(ring, skin)], { closed: true, caps: false });
  lip.computeVertexNormals();
  parts.push(metricUV(lip, WEAVE.carbonMatte[0], WEAVE.carbonMatte[1]));

  // 436 mm of throat, closing to a 10 mm point.
  parts.push(buildInletThroat([
    mouth,
    { z: -0.840, x: side * 0.566, hw: 0.088, yBot: 0.274, yTop: 0.380, nTop: 4.2, nBot: 3.8 },
    { z: -0.720, x: side * 0.552, hw: 0.074, yBot: 0.284, yTop: 0.366, nTop: 3.8, nBot: 3.4 },
    { z: -0.560, x: side * 0.516, hw: 0.044, yBot: 0.300, yTop: 0.344, nTop: 3.2, nBot: 3.0 },
    { z: -0.470, x: side * 0.500, hw: 0.005, yBot: 0.316, yTop: 0.328, nTop: 2.6, nBot: 2.6 },
  ], ring));

  // UNDERBITE LIP. The single most recognisable 2022-spec sidepod feature and the
  // one that survives being half-hidden behind a front tyre: a horizontal shelf
  // projecting ~120 mm forward of the mouth's lower edge, with a small fence at
  // each end. It reads at any three-quarter angle because it is the only
  // horizontal surface in that whole quarter of the car and it throws a hard
  // shadow onto the undercut below.
  if (D.extras) {
    const shelf = new THREE.BoxGeometry(0.230, 0.014, 0.150);
    shelf.rotateX(-0.10);
    shelf.translate(side * 0.566, 0.246, -0.972);
    parts.push(matteUV(shelf));
    for (const e of [-1, 1]) {
      const fence = new THREE.BoxGeometry(0.011, 0.052, 0.128);
      fence.rotateY(e * side * 0.16);
      fence.translate(side * 0.566 + e * 0.112, 0.268, -0.966);
      parts.push(matteUV(fence));
    }
  }
  return mergeGeometries(parts);
}

function buildAirboxInlet(D) {
  return buildInletThroat([
    { z: -0.082, hw: 0.058, yBot: 0.828, yTop: 0.958, nTop: 2.4, nBot: 2.6 },
    { z: 0.040, hw: 0.048, yBot: 0.842, yTop: 0.944, nTop: 2.4, nBot: 2.6 },
    { z: 0.200, hw: 0.030, yBot: 0.868, yTop: 0.918, nTop: 2.2, nBot: 2.4 },
  ], Math.max(10, D.ring >> 1));
}

/** Secondary cooling inlets either side of the roll hoop. */
function buildHoopInlets(D) {
  const parts = [];
  for (const side of [-1, 1]) {
    parts.push(buildInletThroat([
      { z: -0.040, x: side * 0.104, hw: 0.034, yBot: 0.700, yTop: 0.820, nTop: 3.0, nBot: 3.0 },
      { z: 0.120, x: side * 0.108, hw: 0.024, yBot: 0.716, yTop: 0.796, nTop: 2.6, nBot: 2.6 },
    ], Math.max(8, D.ring >> 2)));
  }
  return mergeGeometries(parts);
}

/**
 * Floor: flat plank section, venturi tunnel exits, and a diffuser that kicks up
 * hard behind the rear axle line. Rows are (z, halfWidth, upper surface y).
 */
const FLOOR_ROWS = [
  { z: -1.640, hw: 0.270, y: 0.066 },
  { z: -1.400, hw: 0.480, y: 0.062 },
  { z: -1.120, hw: 0.660, y: 0.058 },
  { z: -0.820, hw: 0.760, y: 0.055 },
  { z: -0.400, hw: 0.806, y: 0.052 },
  { z: 0.200, hw: 0.824, y: 0.050 },
  { z: 0.800, hw: 0.820, y: 0.050 },
  { z: 1.200, hw: 0.782, y: 0.054 },
  { z: 1.440, hw: 0.700, y: 0.062 },
  // DIFFUSER EXIT HEIGHT. This ramp used to climb to y = 0.352 at the trailing
  // edge, so the exit was a 330 mm-tall cave and the strakes inside it hung down
  // as 300 mm teeth with lit tarmac between every pair — the "bank of full-width
  // horizontal slats / air-conditioner" read, seen from every chase frame.
  // The regulation limit is 175 mm of diffuser above the reference plane; with a
  // ~30 mm ride height that puts the roof of the exit at ~205 mm. At that height
  // the strakes are 150 mm fins inside a shallow tunnel, which is a diffuser.
  { z: 1.620, hw: 0.598, y: 0.074 },
  { z: 1.860, hw: 0.540, y: 0.104 },
  { z: 2.120, hw: 0.512, y: 0.150 },
  { z: 2.320, hw: 0.502, y: 0.190 },
  { z: 2.430, hw: 0.498, y: 0.206 },
];

function buildFloor(D) {
  const cols = D.extras ? 14 : 8;
  const sections = FLOOR_ROWS.map((r) => {
    const pts = [];
    // THE FLOOR RING WAS WOUND INSIDE OUT, and it is the single largest flat area
    // on the car. `loft` needs (ring tangent) x (row direction) to point OUT.
    // Rows run +Z, so the TOP edge must be traversed right -> left
    //   (-1,0,0) x (0,0,1) = (0,+1,0) — up, which is what a top face wants
    // and the BOTTOM edge left -> right
    //   (+1,0,0) x (0,0,1) = (0,-1,0) — down.
    // The old order was exactly reversed, so every face on the floor pointed
    // INTO the slab: the underside was shaded as though it faced the sky and,
    // being `carbonMatte` (0xcfcdcb satin), came out as a bare pale rectangle —
    // the "light-grey block under the nose tip" that has been flagged twice. The
    // top face, pointing down, was back-face culled from above, which is why the
    // ray from a head-on camera passed straight through it to hit that block.
    for (let i = 0; i < cols; i++) {
      const t = i / (cols - 1);
      pts.push(new THREE.Vector3(r.hw - 2 * r.hw * t, r.y, r.z));
    }
    for (let i = 0; i < cols; i++) {
      const t = i / (cols - 1);
      pts.push(new THREE.Vector3(-r.hw + 2 * r.hw * t, r.y - 0.024, r.z));
    }
    return pts;
  });
  const g = loftSolid(sections, { closed: true });
  // Flat part: project UVs from XZ, in metres, so the weave does not smear.
  const uv = g.getAttribute('uv');
  const pos = g.getAttribute('position');
  const k = 1 / WEAVE.carbonMatte[0];
  for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) * k, pos.getZ(i) * k);
  uv.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/**
 * TEA-TRAY CLOSEOUT — the solid volume between the floor's upper surface and the
 * underside of the nose and the tub.
 *
 * There was a 40-110 mm horizontal slot running the whole length of the chassis
 * (tub `yBot` 0.132 -> 0.064 against floor `y` 0.058 -> 0.050), and head-on you
 * looked straight through it at a wide, flat, SKY-FACING patch of floor. That is
 * the other half of the "pale block under the nose": correcting the floor's
 * winding stopped the underside being lit as a top, but the actual top was still
 * in the shot. On a real car that volume is solid — it is the splitter and the
 * tub's lower skin — so the honest fix is to fill it rather than to darken it.
 *
 * `nTop`/`nBot` 6 keep it a slab with the tub's flat underside, so it reads as
 * the chassis reaching down to the floor and not as a separate part.
 */
function buildUnderbodyCloseout(D) {
  const ring = Math.max(10, D.ring >> 1);
  return bodyLoft([
    { z: -1.646, hw: 0.236, yBot: 0.064, yTop: 0.170, nTop: 5.0, nBot: 6.0 },
    { z: -1.400, hw: 0.252, yBot: 0.061, yTop: 0.180, nTop: 5.4, nBot: 6.0 },
    { z: -1.120, hw: 0.296, yBot: 0.057, yTop: 0.134, nTop: 6.0, nBot: 6.0 },
    { z: -0.820, hw: 0.334, yBot: 0.054, yTop: 0.100, nTop: 6.0, nBot: 6.0 },
    { z: -0.500, hw: 0.358, yBot: 0.052, yTop: 0.080, nTop: 6.0, nBot: 6.0 },
    { z: -0.180, hw: 0.372, yBot: 0.051, yTop: 0.070, nTop: 6.0, nBot: 6.0 },
    { z: 0.120, hw: 0.374, yBot: 0.049, yTop: 0.066, nTop: 6.0, nBot: 6.0 },
    { z: 0.400, hw: 0.356, yBot: 0.049, yTop: 0.066, nTop: 6.0, nBot: 6.0 },
    { z: 0.640, hw: 0.322, yBot: 0.050, yTop: 0.070, nTop: 6.0, nBot: 6.0 },
  ], ring, { tile: WEAVE.carbonMatte });
}

/**
 * DIFFUSER — the whole rear underbody, which is most of what a chase camera
 * sees. Side walls that reach the plank, five strakes a side with progressive
 * height, a central keel over the gearbox, the trailing gurney, and the little
 * outboard "kick" fins on the wall tops.
 */
function buildDiffuser(D) {
  const parts = [];
  // THREE strakes a side. With four a side plus a keel and two walls there were
  // eleven blades across a metre, all the same height and pitch, and the eye
  // reads eleven evenly spaced teeth as a grille no matter what they are. Three
  // a side, 16 mm thick and unevenly pitched, reads as structure.
  const strakes = D.strakes ? 2 : 0;
  for (const side of [-1, 1]) {
    // Outer wall: follows the floor edge, kicks up over the exit, and hangs
    // below the floor to the plank so the exit reads as a real throat.
    const wall = plateGeometry([
      [1.500, 0.036], [2.448, 0.034], [2.448, 0.226], [2.300, 0.200],
      [2.120, 0.156], [1.900, 0.112], [1.680, 0.082], [1.540, 0.058],
    ], 0.020, { curveSegments: 2, bevel: 0.15 });
    wall.translate(side * 0.500, 0, 0);
    parts.push(matteUV(wall));

    // Vertical strakes inside the throat. They start well back so the comb is
    // confined to the kick-up and does not run the whole length of the floor.
    for (let i = 0; i < strakes; i++) {
      const f = i / Math.max(1, strakes - 1);
      const x = side * (0.168 + f * 0.244);
      const zStart = 1.960 + f * 0.130;
      // Bottom edge at 72 mm, not 44 mm. A strake that reaches the deck is
      // silhouetted against the tarmac all the way down and the bank of them
      // reads as teeth; held clear of the road they read as fins inside a throat.
      const s = plateGeometry([
        [zStart, 0.076], [2.438, 0.072],
        [2.438, 0.202 - f * 0.026], [zStart, 0.104 + f * 0.014],
      ], 0.020, { bevel: 0.15 });
      s.translate(x, 0, 0);
      parts.push(matteUV(s));
    }

    // Outboard kick fin on top of the wall — a real diffuser has two or three
    // of these and they catch the light from behind.
    if (D.extras) {
      for (let i = 0; i < 2; i++) {
        const fin = [];
        for (let k = 0; k <= 3; k++) {
          const t = k / 3;
          fin.push({
            x: side * (0.500 + 0.008 + t * 0.030),
            z: 2.180 + i * 0.130 + t * 0.070,
            y0: 0.156 + i * 0.034, y1: 0.190 + i * 0.034 + t * 0.008,
          });
        }
        parts.push(bladeGeometry(fin, 0.010));
      }
    }
  }

  // Central keel dividing the two tunnels, under the gearbox.
  const keel = plateGeometry([
    [1.700, 0.070], [2.440, 0.062], [2.440, 0.216], [2.140, 0.170], [1.840, 0.100],
  ], 0.026, { curveSegments: 2, bevel: 0.15 });
  parts.push(matteUV(keel));

  // Trailing gurney across the diffuser exit.
  const gurney = new THREE.BoxGeometry(1.00, 0.028, 0.012);
  gurney.translate(0, 0.218, 2.436);
  parts.push(matteUV(gurney));
  return mergeGeometries(parts);
}

/**
 * REAR END — crash structure fairing, exhaust shroud and the FIA rain-light
 * housing. From behind, the tail was a thin dark slab: the crash structure had
 * no volume of its own and the rain light was a naked box floating on the
 * diffuser. This gives the tail a silhouette.
 */
function buildRearEnd(D) {
  const parts = [];

  // Crash-structure fairing: a flattened tube from the gearbox back to the tip,
  // sitting under the tapering engine cover.
  const rows = [];
  const stations = [
    { z: 1.940, hw: 0.108, yBot: 0.300, yTop: 0.470 },
    { z: 2.120, hw: 0.100, yBot: 0.302, yTop: 0.452 },
    { z: 2.300, hw: 0.088, yBot: 0.308, yTop: 0.430 },
    { z: 2.450, hw: 0.072, yBot: 0.318, yTop: 0.408 },
    { z: 2.492, hw: 0.052, yBot: 0.330, yTop: 0.392 },
  ];
  for (const s of stations) rows.push(bodySection(D.extras ? 16 : 10, { ...s, nTop: 3.0, nBot: 3.0 }));
  {
    const g = loftSolid(rows, { closed: true });
    g.computeVertexNormals();
    parts.push(loftUV(g, rows, WEAVE.carbonMatte[0], WEAVE.carbonMatte[1]));
  }

  // Rain-light housing: a black surround with the lens recessed into it.
  const box = new THREE.BoxGeometry(0.132, 0.168, 0.036);
  box.translate(0, 0.318, 2.472);
  parts.push(matteUV(box));

  // Rear-wing pylon fairing where the swan necks meet the crash structure.
  if (D.extras) {
    const fair = plateGeometry([
      [1.980, 0.462], [2.320, 0.452], [2.330, 0.510], [2.000, 0.520],
    ], 0.150, { curveSegments: 2 });
    parts.push(matteUV(fair));
  }
  return mergeGeometries(parts);
}

/** Curved floor fences at the venturi inlet — very visible on a modern car. */
function buildFloorFences(D) {
  const parts = [];
  for (const side of [-1, 1]) {
    for (let i = 0; i < D.fences; i++) {
      const f = i / Math.max(1, D.fences - 1);
      const path = [];
      const steps = D.extras ? 7 : 4;
      for (let k = 0; k <= steps; k++) {
        const t = k / steps;
        const z = -1.660 + t * (0.760 + f * 0.180);
        const x = side * (0.180 + f * 0.150 + Math.pow(t, 1.5) * (0.360 + f * 0.180));
        const h = 0.055 + f * 0.020 + Math.sin(t * Math.PI) * 0.048;
        path.push({ x, z, y0: 0.052 - t * 0.008, y1: 0.052 + h });
      }
      parts.push(bladeGeometry(path, 0.011));
    }
    // Floor edge lip + the little edge wing fins that sit on it.
    const edge = [];
    for (let k = 0; k <= 8; k++) {
      const t = k / 8;
      const z = -0.700 + t * 2.100;
      const hw = 0.760 + Math.sin(t * Math.PI) * 0.070 - Math.pow(Math.max(0, t - 0.72) / 0.28, 2) * 0.220;
      edge.push({ x: side * hw, z, y0: 0.046, y1: 0.078 + Math.sin(t * Math.PI) * 0.014 });
    }
    parts.push(bladeGeometry(edge, 0.016));
  }
  return mergeGeometries(parts);
}

/** Sidepod-front deflectors and the under-chassis turning vanes. */
function buildBargeboards(D) {
  const parts = [];
  const steps = D.extras ? 6 : 3;
  for (const side of [-1, 1]) {
    // Tall inlet-front deflector wrapping around the sidepod shoulder.
    const outer = [];
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const z = -1.180 + t * 0.560;
      const x = side * (0.430 + Math.pow(t, 1.4) * 0.300);
      outer.push({ x, z, y0: 0.130 + t * 0.060, y1: 0.330 + t * 0.090 });
    }
    parts.push(bladeGeometry(outer, 0.014));

    // Inner vane under the chassis, feeding the floor.
    const inner = [];
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const z = -1.320 + t * 0.500;
      const x = side * (0.300 + Math.pow(t, 1.6) * 0.200);
      inner.push({ x, z, y0: 0.090 + t * 0.030, y1: 0.230 + t * 0.070 });
    }
    parts.push(bladeGeometry(inner, 0.011));

    if (D.extras) {
      // Mirror-stalk winglet / sidepod shoulder vane.
      const wing = [];
      for (let k = 0; k <= 4; k++) {
        const t = k / 4;
        const z = -0.860 + t * 0.320;
        const x = side * (0.520 + t * 0.180);
        wing.push({ x, z, y0: 0.408 + t * 0.010, y1: 0.436 + t * 0.014 });
      }
      parts.push(bladeGeometry(wing, 0.010));
    }
  }
  return mergeGeometries(parts);
}

/**
 * FRONT WING — four cambered elements on a sculpted endplate.
 *
 * The whole recognisability of an F1 car from the front lives here, and it hangs
 * on one thing being right: **each element's leading edge must sit BEHIND and
 * ABOVE the previous element's trailing edge, with an open slot between them.**
 * Get the stagger wrong and the flaps hide inside the mainplane's chord
 * footprint; the wing then silhouettes as one flat slab no matter how many
 * elements you built. So the table below is authored as a ladder: `zLE` is the
 * root leading edge, `chord` shrinks going up the stack (progressive chord), and
 * the next element starts `chord * (1 - OVERLAP)` further back.
 *
 * Element 1 is full span. Elements 2-4 stop at the regulation neutral zone
 * (|x| < 0.125 m) so the central section really is a single plane, and their
 * inboard ends tuck against the nose flanks.
 *
 * Outboard, every element does three things at once: sweeps back, rises, and
 * ROLLS up into the endplate. That roll is the outwash device on a 2022-spec
 * wing — it is why the tips look like they are peeling upward.
 *
 * The whole assembly goes to `carbonMatte`. It is the largest near-flat carbon
 * area on the car and it faces the sky, so on the gloss `carbon` material (full
 * clearcoat lobe, envMapIntensity 1.5) it mirrors the whole hemisphere and reads
 * as one navy-blue slab no matter how many elements are underneath. Satin keeps
 * the weave and the slot shadows.
 * @returns {BufferGeometry}
 */
function buildFrontWing(D) {
  const parts = [];
  const hs = FW_HALF_SPAN;
  const NEUTRAL = 0.125;    // half-width of the mandated neutral central section

  // The stack is NEARLY FLAT. Three numbers used to turn it into a banana wider
  // than the car:
  //   * roll up to 1.05 rad (60 deg) on the top element, ramped from a = 0.70,
  //     so the outer 30% of a 1970 mm span peeled up like a bath tap;
  //   * tipRise up to 94 mm on top of that;
  //   * a y ladder topping out at 0.220 + 0.094 = 0.314 against a 250 mm cap.
  // A real 2022-spec wing rolls maybe 20 deg and does it in the last 100 mm
  // against the endplate. Everything inboard of that is a flat cambered plank.
  const elements = [
    { zLE: -3.105, chord: 0.300, y: 0.040, aoa: 0.08, tipRise: 0.020, from: 0.000, sweep: 0.058, roll: 0.12 },
    { zLE: -2.940, chord: 0.266, y: 0.084, aoa: 0.18, tipRise: 0.024, from: NEUTRAL, sweep: 0.066, roll: 0.20 },
    { zLE: -2.808, chord: 0.234, y: 0.130, aoa: 0.27, tipRise: 0.027, from: NEUTRAL, sweep: 0.074, roll: 0.27 },
    { zLE: -2.692, chord: 0.204, y: 0.176, aoa: 0.35, tipRise: 0.030, from: NEUTRAL, sweep: 0.082, roll: 0.34 },
  ];

  // Element tip. It must land INSIDE the endplate's inner face (hs - 0.007), not
  // short of it: at hs - 0.024 every element stopped 17 mm shy of the plate and
  // head-on you could see daylight in four slots along the joint, which read as a
  // manufacturing gap rather than a wing.
  const hsE = hs - 0.002;
  const station = (e, x) => {
    const a = Math.abs(x) / hs;
    const b = THREE.MathUtils.clamp((Math.abs(x) - e.from) / (hsE - e.from || 1), 0, 1);
    return {
      x,
      zLE: e.zLE + Math.pow(b, 1.8) * e.sweep,
      y: e.y + Math.pow(b, 2.4) * e.tipRise,
      chord: e.chord * (1 - Math.pow(b, 2.4) * 0.22),
      // A shallow washout ramp: the tip must not gain so much incidence that its
      // trailing edge climbs back above the 250 mm box the whole wing lives in.
      aoa: e.aoa * (1 + b * 0.15),
      roll: Math.sign(x || 1) * Math.pow(smooth(0.90, 1.0, a), 1.2) * e.roll,
    };
  };
  for (const e of elements) {
    const steps = D.wingSteps;
    // Elements 2-4 are TWO separate spans with the nose between them. Bridging
    // them across the centreline would bury the upper flaps inside the nose
    // cone; a real car cuts them at the neutral-section boundary.
    const spans = e.from > 0
      ? [[-hsE, -e.from], [e.from, hsE]]
      : [[-hsE, hsE]];
    for (const [x0, x1] of spans) {
      const stations = [];
      for (let i = 0; i <= steps; i++) stations.push(station(e, x0 + (x1 - x0) * (i / steps)));
      parts.push(buildWingGeometry(stations, {
        // Camber 0.115 over a 300 mm chord droops the mainplane 35 mm below its
        // own leading edge, which is what made the stack read as a hammock
        // slung between two upswept tips. 0.072 keeps the section obviously
        // cambered without the sag.
        profileN: D.wingN, thickness: 0.058, camber: 0.072, tile: WEAVE.carbonMatte,
        // 4.7 mm leading-edge radius on the mainplane (1.1 mm before) and a
        // 7.8 mm chamfered trailing edge: the two features that make an element
        // read as an element rather than as a corrugation in one slab.
        nose: 2.05, te: 0.026, teChamfer: 0.020,
      }));
    }
  }

  // ---- endplate ---------------------------------------------------------
  // Drawn in (z, y). The top edge follows the element staircase, the trailing
  // edge is the tallest point, and the bottom edge is the footplate line.
  // The top edge steps DOWN toward the front, following the element staircase,
  // and the whole plate lives inside the 250 mm box (it used to reach 0.330).
  const epOutline = [
    [-3.152, 0.006], [-2.900, 0.000], [-2.680, 0.006], [-2.560, 0.020],
    [-2.505, 0.052], [-2.480, 0.120], [-2.474, 0.186], [-2.492, 0.234],
    [-2.548, 0.252], [-2.700, 0.234], [-2.900, 0.172], [-3.062, 0.100],
    [-3.140, 0.046],
  ];
  for (const side of [-1, 1]) {
    // The outboard face is not flat: it rolls out at the bottom (that is the
    // footplate tuck) and flicks out again at the top trailing corner. Both
    // amplitudes are capped so the widest point of the plate stays inboard of
    // FW_MAX_X.
    const g = plateGeometry(epOutline, 0.014, {
      curveSegments: D.extras ? 5 : 2, bevel: 0.15,
      curl: (y, z) => side * (
        smooth(0.070, 0.004, y) * 0.019                        // footplate roll-out
        + smooth(0.150, 0.250, y) * smooth(-2.62, -2.47, z) * 0.026   // upper flick
      ),
    });
    g.translate(side * hs, 0, 0);
    parts.push(matteUV(g));

    // Footplate: a horizontal shelf curving outboard under the endplate. This
    // is the single most recognisable front-wing feature after the elements.
    const foot = [];
    const fsteps = D.extras ? 7 : 4;
    for (let k = 0; k <= fsteps; k++) {
      const t = k / fsteps;
      const z = -3.130 + t * 0.660;
      foot.push({
        x: side * Math.min(FW_MAX_X, hs - 0.002 + Math.pow(t, 1.7) * 0.026),
        z,
        y0: 0.006 + Math.pow(t, 2) * 0.012,
        y1: 0.024 + Math.pow(t, 1.4) * 0.034,
      });
    }
    parts.push(bladeGeometry(foot, 0.012));

    if (D.extras) {
      // Outboard diveplane, mounted on the endplate's outer face.
      const dive = [];
      for (let k = 0; k <= 5; k++) {
        const t = k / 5;
        dive.push({
          x: side * Math.min(FW_MAX_X, hs + 0.008 + t * 0.020),
          zLE: -2.620 + t * 0.036,
          y: 0.158 + t * 0.026,
          chord: 0.132 - t * 0.034,
          aoa: 0.24 + t * 0.14,
          roll: side * t * 0.30,
        });
      }
      if (side < 0) dive.reverse();
      parts.push(buildWingGeometry(dive, {
        profileN: 5, thickness: 0.085, camber: 0.10, tile: WEAVE.carbonMatte,
      }));

      // Two outwash strakes hanging under the mainplane's outer third.
      for (let i = 0; i < 2; i++) {
        const st = [];
        for (let k = 0; k <= 4; k++) {
          const t = k / 4;
          st.push({
            x: side * (0.590 + i * 0.130 + t * 0.026),
            z: -3.020 + t * 0.280,
            y0: 0.010, y1: 0.046 + i * 0.006 + t * 0.024,
          });
        }
        parts.push(bladeGeometry(st, 0.010));
      }
    }
  }

  // ---- nose-to-mainplane pylons ----------------------------------------
  // Aerofoil-section struts, not slabs: they are in every head-on shot. They now
  // sit under the projecting nose tip, which is where the load path actually is.
  for (const side of [-1, 1]) {
    const rows = [];
    const steps = D.extras ? 5 : 2;
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      rows.push({
        y: 0.052 + t * 0.116,
        ring: strutRing(D.extras ? 12 : 8, -3.026 - t * 0.024, 0.168 - t * 0.022, 0.030 - t * 0.006),
      });
    }
    const p = verticalLoft(rows);
    p.translate(side * 0.062, 0, 0);
    parts.push(p);
  }
  return mergeGeometries(parts);
}

/**
 * REAR WING — main plane, two beam-wing elements, sculpted endplates.
 * Split gloss / matte for the same reason as the front wing: big flat endplates
 * on a full clearcoat lobe mirror the sky and read brighter than the paint.
 * @returns {{gloss: BufferGeometry, matte: BufferGeometry}}
 */
function buildRearWing(D) {
  const parts = [];
  const matte = [];
  const hs = RW_HALF_SPAN;

  // Main plane — spoon-shaped, tips rolling up into the endplates.
  // RW_MAIN_Y is the number the DRS flap hinge is derived from; see DRS_HINGE.
  const main = [];
  for (let i = 0; i <= D.wingSteps; i++) {
    const t = i / D.wingSteps;
    const x = -hs + 2 * hs * t;
    const a = Math.abs(x) / hs;
    const roll = Math.pow(smooth(0.72, 1.0, a), 1.3) * 1.20;
    main.push({
      x: Math.sign(x) * hs * (a - smooth(0.80, 1.0, a) * 0.085),
      zLE: 2.100 - smooth(0.55, 1.0, a) * 0.020,
      y: RW_MAIN_Y + smooth(0.62, 1.0, a) * 0.062,
      chord: RW_CHORD - smooth(0.75, 1.0, a) * 0.044,
      aoa: 0.28,
      roll: Math.sign(x) * roll,
    });
  }
  parts.push(buildWingGeometry(main, { profileN: D.wingN, thickness: 0.090, camber: 0.115 }));

  // DRS ACTUATOR FAIRING. The pod that houses the actuator sits on the main
  // plane's centreline between the swan necks; it is the only thing that breaks
  // the wing's top edge and it is in every trackside and chase frame. Without it
  // the main plane is a bare extrusion from tip to tip.
  matte.push(bodyLoft([
    { z: 2.166, hw: 0.024, yBot: 0.812, yTop: 0.848, nTop: 2.8, nBot: 2.8 },
    { z: 2.256, hw: 0.050, yBot: 0.832, yTop: 0.902, nTop: 3.6, nBot: 3.4 },
    { z: 2.360, hw: 0.048, yBot: 0.860, yTop: 0.926, nTop: 3.6, nBot: 3.4 },
    { z: 2.442, hw: 0.022, yBot: 0.890, yTop: 0.930, nTop: 2.8, nBot: 2.8 },
  ], D.extras ? 14 : 8, { tile: WEAVE.carbonMatte }));

  // BEAM WING — two elements, in two spans, either side of the crash structure.
  //
  // It used to be "completely lost", and it was: at zLE 2.150 / y 0.298-0.372 it
  // was buried inside the diffuser roof (which is at y 0.318 at z 2.32 and
  // carries a gurney at y 0.382) and it bridged straight across the centreline
  // through the exhaust. Moving it back to 2.290 and up to 0.404 / 0.492 puts it
  // in clear air between the diffuser exit and the main plane, and splitting it
  // at |x| = 0.132 leaves the exhaust and the crash structure their own gap —
  // which is what a 2022-spec rear end actually looks like from behind.
  // (Lowered with the diffuser roof: the beam wing works the diffuser exit, so
  // once the exit came down to 206 mm a beam at 404 mm was floating in the gap.)
  for (const [y, chord, aoa] of [[0.352, 0.188, 0.34], [0.440, 0.150, 0.26]]) {
    const n = Math.max(4, D.wingSteps - 6);
    for (const side of [-1, 1]) {
      const beam = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const x = side * (0.104 + t * 0.404);
        beam.push({ x, zLE: 2.290, y: y + Math.pow(t, 3) * 0.014, chord, aoa });
      }
      if (side < 0) beam.reverse();
      parts.push(buildWingGeometry(beam, { profileN: Math.max(4, D.wingN - 2), thickness: 0.080, camber: 0.100 }));
    }
  }

  // ENDPLATES. Drawn in (z, y), extruded across X, then curled.
  //
  // The old outline topped out at y = 1.052 — 100 mm above the regulation height
  // and 250 mm above the wing it was supposed to be holding, which is most of why
  // the rear of the car read as an air-conditioner: two thin horizontal slats
  // rattling around inside a pair of tall blank plates. The top edge now closes
  // ~25 mm over the DRS flap's trailing edge (0.968), so the plate reads as a
  // wrapper for the wing rather than a signboard beside it.
  const outline = [
    [2.010, 0.300], [2.330, 0.318], [2.520, 0.352], [2.560, 0.500],
    [2.566, 0.646], [2.562, 0.812], [2.546, 0.950], [2.506, 1.036],
    [2.360, 1.056], [2.160, 1.018], [2.040, 0.880], [2.006, 0.646],
    [1.998, 0.470],
  ];
  for (const side of [-1, 1]) {
    const g = plateGeometry(outline, 0.014, {
      curveSegments: D.extras ? 4 : 2,
      curl: (y, z) => side * (
        smooth(2.30, 2.56, z) * smooth(0.84, 1.03, y) * 0.040      // upper flick
        + smooth(0.44, 0.32, y) * 0.020                            // lower tuck
      ),
    });
    g.translate(side * hs, 0, 0);
    matte.push(matteUV(g));

    // LONGITUDINAL CREASE. A near-flat plate edge-on to the sky is the exact
    // failure the contract warns about: with no normal break anywhere on it, it
    // silhouettes as one uniform slab whether it is gloss or matte. This rib runs
    // the full chord and splits the plate into an upper and a lower band with a
    // highlight line and a shadow between them.
    //
    // It sits at y = 0.50, not the y = 0.62 the review asked for, because
    // `livery.buildTeamDecals` pins the driver-number panel to this face at
    // y 0.570-0.740 / z 2.175-2.375 and a rib at 0.62 runs straight through it.
    const rib = plateGeometry([
      [2.014, 0.498], [2.548, 0.506], [2.548, 0.536], [2.014, 0.528],
    ], 0.018, { curveSegments: 1 });
    rib.translate(side * (hs + 0.014), 0, 0);
    matte.push(matteUV(rib));

    if (D.extras) {
      // Louvre bank: six gills raked back on the OUTBOARD face, above the crease,
      // where a chase or trackside camera can actually see them. At hs + 0.016
      // they were all but flush with the plate.
      for (let i = 0; i < 6; i++) {
        const l = new THREE.BoxGeometry(0.030, 0.014, 0.120);
        l.rotateX(0.42);
        l.translate(side * (hs + 0.028), 0.716 + i * 0.058, 2.478 - i * 0.012);
        matte.push(matteUV(l));
      }
      // Lower vertical strake on the inboard face, under the beam wing.
      const st = [];
      for (let k = 0; k <= 3; k++) {
        const t = k / 3;
        st.push({ x: side * (hs - 0.020 - t * 0.014), z: 2.120 + t * 0.280, y0: 0.250, y1: 0.336 + t * 0.026 });
      }
      matte.push(bladeGeometry(st, 0.010));
    }
  }

  // Swan-neck pylons: they hang the main plane from above, off the crash structure.
  for (const side of [-1, 1]) {
    const p = plateGeometry([
      [2.250, 0.470], [2.330, 0.470], [2.250, 0.752], [2.150, 0.842], [2.120, 0.834], [2.190, 0.712],
    ], 0.026, { curveSegments: 2 });
    p.translate(side * 0.098, 0, 0);
    matte.push(matteUV(p));
  }
  return { gloss: mergeGeometries(parts), matte: mergeGeometries(matte) };
}

/** DRS flap, authored about its own hinge (pivot at the flap leading edge). */
function buildDrsFlap(D) {
  const hs = 0.448;
  const stations = [];
  for (let i = 0; i <= Math.max(6, D.wingSteps - 2); i++) {
    const n = Math.max(6, D.wingSteps - 2);
    const t = i / n;
    const x = -hs + 2 * hs * t;
    const a = Math.abs(x) / hs;
    stations.push({ x, zLE: 0, y: -Math.pow(a, 3) * 0.010, chord: 0.200 - Math.pow(a, 3) * 0.018, aoa: 0 });
  }
  const g = buildWingGeometry(stations, { profileN: D.wingN, thickness: 0.070, camber: 0.095 });
  // End fins so the flap does not read as a floating slab when it opens.
  const parts = [g];
  for (const side of [-1, 1]) {
    const f = new THREE.BoxGeometry(0.010, 0.052, 0.190);
    f.translate(side * (hs + 0.006), 0.004, 0.096);
    parts.push(glossUV(f));
  }
  return mergeGeometries(parts);
}

/**
 * HALO — teardrop hoop, central forward pylon, rear shoulder mounts.
 *
 * Three things make a halo read on screen and all three were weak before:
 *  1. HEIGHT, relative to the helmet. The hoop crown is y = 0.752 and its section
 *     tops out at 0.788; the helmet crown is 0.839. The hoop therefore crosses
 *     the helmet at about eyebrow level and the whole upper half of the head
 *     stands clear of it, which is what a head-on shot of a real car looks like.
 *     Level the two and the halo simply eats the driver.
 *  2. SECTION. It is a 34 x 60 mm teardrop, deep front-to-back and thin across.
 *     Swept with FRENET frames it twists with the curve's torsion; swept with an
 *     up-locked frame the deep axis stays vertical, which is what catches the
 *     highlight along the top and gives it a readable edge.
 *  3. UV SCALE. Raw loft UVs stretched the 5 mm weave into 100:1 bands, so the
 *     hoop looked like a rubber hose. `loftUV` puts the tows back at 5 mm.
 * The spline lives in `livery.js` because the coloured tip sleeve has to sit on
 * exactly the same curve.
 */
function buildHalo(D) {
  const parts = [];
  const ring = haloCurve();
  const { geometry, sections } = sweepUpLocked(ring, haloProfile(D.extras ? 16 : 9), D.arc);
  parts.push(loftUV(geometry, sections, WEAVE.carbonMatte[0], WEAVE.carbonMatte[1]));

  // ---- central forward pylon -------------------------------------------
  //
  // In a front three-quarter view this single pillar is the most legible thing
  // on the car, and it used to read as a floating black stub. Three faults:
  //   * it started at y = 0.398, but the tub top deck at z = -0.70 is at
  //     y = 0.5985, so only 158 mm of the loft was ever above the skin;
  //   * the only fairing (`collar`) was at the TOP joint, leaving the bottom
  //     joint a raw unfaired boolean with a visible notch;
  //   * it raked 9 deg (-0.700 -> -0.756 over 0.358 of rise). The real pillar
  //     leans ~18 deg forward, which is what makes it read as a load path
  //     rather than a post.
  // Now: visible from y = 0.560 (18 mm inside the deck) with a 210 mm chord that
  // necks to 114 mm at the hoop, raked 17.6 deg, and BOTH joints faired.
  const PYL_Y0 = 0.560, PYL_Y1 = 0.762;
  const PYL_Z0 = -0.700, PYL_Z1 = -0.764;   // 64 mm over 202 mm of rise = 17.6 deg
  const rows = [];
  const steps = D.extras ? 8 : 3;
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    rows.push({
      y: PYL_Y0 + t * (PYL_Y1 - PYL_Y0),
      ring: strutRing(
        D.extras ? 14 : 8,
        PYL_Z0 + t * (PYL_Z1 - PYL_Z0),
        0.210 - t * 0.096,          // chord 210 -> 114 mm: the taper IS the load path
        0.056 - t * 0.026,
      ),
    });
  }
  parts.push(verticalLoft(rows));

  // Fairings at BOTH ends of the pylon.
  if (D.extras) {
    // Bottom: a swept fillet where the pylon meets the deck. It flares to a
    // 356 mm chord and 142 mm width at y = 0.560 and has decayed back to the
    // pylon's own section by y = 0.636, so it blends over ~120 mm of z and
    // ~40 mm of y either side of the deck line at 0.5985.
    const fillet = [];
    const fsteps = D.extras ? 6 : 2;
    for (let k = 0; k <= fsteps; k++) {
      const t = k / fsteps;
      const flare = Math.pow(1 - t, 1.8);
      fillet.push({
        y: PYL_Y0 + t * 0.076,
        ring: strutRing(
          D.extras ? 14 : 8,
          PYL_Z0 - t * 0.024,
          0.210 + flare * 0.146,
          0.056 + flare * 0.086,
        ),
      });
    }
    parts.push(verticalLoft(fillet));

    // Top: a collar at the hoop joint so it is not a straight loft intersection.
    const collar = new THREE.SphereGeometry(0.038, 12, 8);
    collar.scale(0.66, 0.72, 1.50);
    collar.translate(0, 0.744, -0.756);
    parts.push(matteUV(collar));
  }

  // Rear halo mounts into the tub shoulders: a bracket, not a cube.
  for (const side of [-1, 1]) {
    const m = plateGeometry([
      [0.132, 0.452], [0.284, 0.470], [0.286, 0.560], [0.180, 0.556], [0.126, 0.520],
    ], 0.052, { curveSegments: 2 });
    m.translate(side * 0.348, 0, 0);
    parts.push(matteUV(m));
    const boss = new THREE.CylinderGeometry(0.026, 0.030, 0.052, D.extras ? 12 : 6);
    boss.rotateZ(Math.PI / 2);
    boss.translate(side * 0.348, 0.512, 0.216);
    parts.push(matteUV(boss));
  }
  return mergeGeometries(parts);
}

/**
 * Cockpit opening: coaming rim, interior trough, headrest surround.
 *
 * SPLIT ACROSS TWO MATERIALS ON PURPOSE. Everything here used to be
 * `cockpitTrim` (0x101116, roughness 0.94, envMapIntensity 0.35) — the coaming,
 * the trough, the headrest, the driver and his helmet surround all the same
 * unlit black. That is why the cockpit read as "a floating helmet in a hole":
 * the shoulders were already modelled, they were just black-on-black. The
 * coaming rim is exposed CARBON on a real car, so it goes to `carbonMatte`
 * (0xdad8d6 satin) and the padded trough and headrest stay black — which is the
 * separation the review asked for, at zero extra draw calls.
 *
 * @returns {{trim: BufferGeometry, carbon: BufferGeometry}}
 */
function buildCockpit(D) {
  const parts = [];
  const carbon = [];
  const seg = D.extras ? 26 : 14;

  // Coaming: a raised rim following the opening, slightly proud of the tub.
  const rimPath = [];
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    const z = -0.640 + t * 0.840;
    const hw = 0.300 * Math.sqrt(Math.max(0.02, 1 - Math.pow((t - 0.46) / 0.60, 2)));
    const st = stationAt(TUB, z);
    rimPath.push({ z, hw, y: st.yTop });
  }
  const rimSections = [];
  for (const p of rimPath) {
    // A closed ring that hugs the opening: outer lip, top, inner lip, underside.
    const pts = [];
    const n = 8;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      pts.push(new THREE.Vector3(
        Math.cos(a) * (p.hw + 0.026),
        p.y - 0.012 + Math.sin(a) * 0.016,
        p.z,
      ));
    }
    rimSections.push(pts);
  }
  {
    const g = loftSolid(rimSections, { closed: true });
    g.computeVertexNormals();
    carbon.push(loftUV(g, rimSections, WEAVE.carbonMatte[0], WEAVE.carbonMatte[1]));
  }

  // Interior trough — a bucket the driver sits in, visible through the opening.
  const trough = [];
  for (let i = 0; i <= seg; i++) {
    const t = i / seg;
    const z = -0.640 + t * 0.840;
    const hw = 0.286 * Math.sqrt(Math.max(0.02, 1 - Math.pow((t - 0.46) / 0.60, 2)));
    const st = stationAt(TUB, z);
    trough.push(bodySection(D.extras ? 18 : 10, {
      z, hw, yTop: st.yTop - 0.006, yBot: st.yTop - 0.300, nTop: 6, nBot: 3,
    }));
  }
  {
    const g = loftSolid(trough, { closed: true });
    g.computeVertexNormals();
    parts.push(g);
  }

  // HEADREST. The real part is a STEPPED extraction pad: a tall centre block
  // behind the helmet with two lower wings wrapping round the driver's ears, and
  // a chamfer where the two tiers meet. A single tapering horseshoe reads as a
  // black lump; the step is what gives it a shading break at chase distance.
  const hr = [];
  for (let i = 0; i <= 12; i++) {
    const t = i / 12;
    const z = 0.014 + t * 0.252;
    // The step: the pad's crown holds 0.700 for the first 40% and then drops.
    const drop = Math.pow(smooth(0.34, 0.62, t), 1.4) * 0.062;
    hr.push(bodySection(D.extras ? 16 : 10, {
      z,
      hw: 0.246 - Math.pow(t, 1.6) * 0.052,
      yTop: 0.702 - drop,
      yBot: 0.492,
      nTop: 3.6 - t * 0.8,
      nBot: 4,
    }));
  }
  {
    const g = loftSolid(hr, { closed: true });
    g.computeVertexNormals();
    parts.push(g);
  }
  if (D.extras) {
    // Side pads: the lower tier, standing 18 mm proud of the main pad so the
    // step actually casts.
    for (const side of [-1, 1]) {
      const pad = [];
      for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        const z = -0.030 + t * 0.230;
        pad.push(bodySection(D.extras ? 12 : 8, {
          z, x: side * 0.150,
          hw: 0.086 - Math.pow(t, 2) * 0.026,
          yTop: 0.606 - t * 0.030, yBot: 0.470,
          nTop: 3.0, nBot: 3.4,
        }));
      }
      const g = loftSolid(pad, { closed: true });
      g.computeVertexNormals();
      parts.push(g);
    }
  }

  // Dash bulkhead ahead of the driver.
  const dash = new THREE.BoxGeometry(0.300, 0.090, 0.120);
  dash.translate(0, 0.520, -0.560);
  parts.push(dash);
  return { trim: mergeGeometries(parts), carbon: mergeGeometries(carbon) };
}

/**
 * DRIVER — shoulders, arms, HANS collar, and a six-point harness.
 *
 * Split into two buckets. The body goes to `paintSecondary` (the team's second
 * colour, roughness 0.34) because a race suit is team-coloured cloth, and because
 * a black driver inside a black tub is invisible however well he is modelled —
 * that is the whole of the "floating helmet in a hole" finding. The HANS collar
 * and the harness hardware stay black `cockpitTrim`.
 *
 * The suit bucket only exists at `high` detail, so it costs ONE extra draw call
 * for the player's car and nothing for the other nineteen.
 *
 * @returns {{trim: BufferGeometry, suit: BufferGeometry|null}}
 */
/** Point a Y-axis primitive (capsule / cylinder) along `dir`. */
const _qA = new THREE.Quaternion(), _vA = new THREE.Vector3(), _vB = new THREE.Vector3(0, 1, 0);
function aimY(g, dx, dy, dz) {
  _vA.set(dx, dy, dz).normalize();
  return g.applyQuaternion(_qA.setFromUnitVectors(_vB, _vA));
}

/**
 * A gloved hand closed on one of the wheel's 3-/9-o'clock grips.
 *
 * Authored in the STEERING WHEEL's own local frame (+Y along the grip before
 * the grip's own 0.30 rad cant, +Z toward the driver, +X outboard for the right
 * hand), then put through exactly the transform `buildSteeringWheel.place`
 * applies — cant, offset to the grip centre, `rotateX(-0.40)`, translate to
 * (0, 0.540, -0.492). Author against the grip, never against car-local: the two
 * disagree by 23 deg and a hand that is 20 mm off its rim reads as a floating
 * mitten no matter how many fingers it has.
 *
 * @param {number} side -1 left, +1 right
 * @returns {BufferGeometry[]} in CAR-LOCAL space
 */
function gloveGeometry(side) {
  const s = side;
  const out = [];
  const push = (g) => { out.push(g); return g; };

  // Back of the hand, wrapped round the outboard face of the 20 mm rim tube.
  const palm = new THREE.SphereGeometry(1, 12, 9);
  palm.scale(0.021, 0.045, 0.030);
  palm.translate(s * 0.019, 0.004, 0.003);
  push(palm);

  // Four fingers. Each is knuckle -> proximal (round the front of the rim) ->
  // fingertip (curling back toward the palm), 20 mm apart along the grip, with
  // the index finger longest and the little finger shortest and tucked in.
  const FY = [0.031, 0.011, -0.009, -0.028];
  const LEN = [1.00, 1.00, 0.94, 0.86];
  for (let i = 0; i < 4; i++) {
    const y = FY[i], k = LEN[i], r = 0.0098 - i * 0.0007;
    const knuck = new THREE.SphereGeometry(r * 1.14, 8, 6);
    knuck.translate(s * 0.014, y, -0.010);
    push(knuck);

    const prox = new THREE.CapsuleGeometry(r, 0.021 * k, 2, 8);
    aimY(prox, -s * 0.62, 0, -0.78);
    prox.translate(s * 0.005, y, -0.021);
    push(prox);

    const tip = new THREE.CapsuleGeometry(r * 0.86, 0.016 * k, 2, 8);
    aimY(tip, -s * 0.96, 0, -0.28);
    tip.translate(-s * 0.015, y - 0.001, -0.026);
    push(tip);
  }

  // Thumb: laid ALONG the top of the rim, not wrapped round it — that is how a
  // driver holds a grip, and it is the one part of the hand that silhouettes
  // against the dash from the eye point.
  const thumb = new THREE.CapsuleGeometry(0.0108, 0.030, 3, 8);
  aimY(thumb, -s * 0.20, 0.90, -0.39);
  thumb.translate(s * 0.014, 0.044, -0.012);
  push(thumb);

  // Grip-side cuff so the wrist is not an open tube where the forearm meets it.
  const cuff = new THREE.CylinderGeometry(0.027, 0.031, 0.026, 10, 1);
  cuff.translate(s * 0.006, -0.046, 0.004);
  push(cuff);

  for (const g of out) {
    g.rotateZ(0.30 * s);
    g.translate(s * 0.128, -0.020, 0.026);
    g.rotateX(-0.40);
    g.translate(0, 0.540, -0.492);
  }
  return out;
}

function buildDriverBody(D) {
  const parts = [];
  const suit = [];
  const seg = D.extras ? 14 : 6;
  const body = D.extras ? suit : parts;

  // Shoulders: 380 mm across the deltoids, filling the opening from y 0.44 to
  // 0.63 — the coaming top at this z is 0.62-0.63, so they break the rim line.
  const shoulders = new THREE.CapsuleGeometry(0.118, 0.256, Math.max(3, seg >> 1), seg);
  shoulders.rotateZ(Math.PI / 2);
  shoulders.scale(1.0, 1.06, 0.84);
  shoulders.translate(0, 0.506, 0.046);
  body.push(shoulders);

  // Chest, rising out of the trough toward the wheel.
  const chest = new THREE.CapsuleGeometry(0.104, 0.130, Math.max(3, seg >> 1), seg);
  chest.rotateZ(Math.PI / 2);
  chest.scale(1.0, 0.92, 1.9);
  chest.translate(0, 0.470, -0.126);
  body.push(chest);

  // HANS collar — always black, it is a moulded composite part.
  const collar = new THREE.TorusGeometry(0.112, 0.030, Math.max(4, seg >> 1), seg);
  collar.rotateX(Math.PI / 2 - 0.22);
  collar.translate(0, 0.602, -0.016);
  parts.push(collar);

  if (D.extras) {
    for (const side of [-1, 1]) {
      const upper = new THREE.CapsuleGeometry(0.048, 0.204, 3, 10);
      upper.rotateX(1.20);
      upper.translate(side * 0.154, 0.516, -0.184);
      body.push(upper);
      // Elbow/sleeve cuff — a black band where the sleeve meets the glove cuff,
      // so the arm is not one unbroken pale tube down the side of the frame.
      const cuff = new THREE.CapsuleGeometry(0.045, 0.030, 3, 10);
      cuff.rotateX(1.34);
      cuff.translate(side * 0.140, 0.514, -0.286);
      parts.push(cuff);
      // Forearm tapers to the wrist (0.046 all the way read as a pale grey pipe
      // from the cockpit eye point, which is the one camera that sees it close).
      // The forearm is BLACK, not suit colour. It is the largest thing in the
      // bottom of every cockpit frame, and in a light team secondary it read as
      // a pale grey pipe — the "clay" look. Real suits are dark from the elbow
      // down (that is where the fireproof underlayer and the glove cuff are),
      // and from outside the car this part is never visible anyway.
      const fore = new THREE.CapsuleGeometry(0.042, 0.180, 3, 10);
      fore.rotateX(1.42);
      fore.scale(0.92, 1.0, 0.92);
      fore.translate(side * 0.128, 0.512, -0.372);
      parts.push(fore);
      // GLOVES ARE BLACK, and they close on the wheel grips at (+-0.128, 0.532,
      // -0.460). In the suit colour at 108 mm across they were two pale lumps
      // filling the bottom of every cockpit frame — the "oven mitt" read. Nomex
      // gloves are dark, and a fist is 95 mm, not 108.
      //
      // AND A FIST IS NOT A SPHERE. One 94 x 82 x 114 mm ellipsoid is a clay
      // lump whichever colour it is painted; what says "a hand holding
      // something" is four separated finger tubes crossing the rim and a thumb
      // laid along it, because those are the only edges in the shape.
      for (const g of gloveGeometry(side)) parts.push(g);
    }

    // SIX-POINT HARNESS. Four 50 mm webbing straps: two over the shoulders from
    // the headrest bulkhead, two across the lap. Modelled as thin slabs skinned
    // in the suit's own colour rather than decal planes — a plane with
    // depthWrite off and polygonOffset -3 slides through a curved torso.
    for (const side of [-1, 1]) {
      // 70 mm webbing, run forward to z = -0.168 so it crosses the part of the
      // chest and shoulder the COCKPIT EYE POINT actually sees. At 52 mm and
      // z = -0.078 the straps sat behind the driver's own torso from that camera
      // and the only thing in the bottom of the frame was a pale suit-coloured
      // ellipsoid with nothing on it.
      const strap = new THREE.BoxGeometry(0.070, 0.360, 0.014);
      strap.rotateX(-0.46);
      strap.rotateZ(side * 0.22);
      strap.translate(side * 0.092, 0.508, -0.168);
      parts.push(strap);
      const lap = new THREE.BoxGeometry(0.056, 0.014, 0.140);
      lap.rotateX(0.24);
      lap.rotateY(side * 0.30);
      lap.translate(side * 0.104, 0.408, -0.220);
      parts.push(lap);
    }
    // Central buckle.
    const buckle = new THREE.BoxGeometry(0.084, 0.070, 0.020);
    buckle.rotateX(-0.34);
    buckle.translate(0, 0.428, -0.278);
    parts.push(buckle);
  }
  return { trim: mergeGeometries(parts), suit: suit.length ? mergeGeometries(suit) : null };
}

/** Helmet centre, in car-local space. The crown must clear the halo hoop. */
const HELMET_C = new THREE.Vector3(0, 0.690, -0.196);
const HELMET_R = 0.142;

/**
 * Helmet shell. The sphere keeps THREE's own spherical unwrap, because
 * `livery.helmetTexture()` is authored directly against it: u = phi/2pi with the
 * seam at the BACK, v = 1 at the crown. The helmet is rotated so phi = pi lands
 * dead ahead (-Z), which is what puts the visor aperture over the eyes.
 *
 * The aero fin and chin bar are merged in, with their UVs pinned into the flat
 * strip the texture reserves at v < HELMET_UV_SPARE — so the whole helmet is one
 * mesh sharing one per-driver material and costs no extra draw call.
 */
function buildHelmetShell(D) {
  // 36 x 30 segments at high detail. At 24 x 18 the crown showed visible facets
  // in any shot where the helmet spans 200+ px, and it is 1.1 k extra triangles
  // on ONE mesh per car.
  const seg = D.extras ? 36 : 12;
  const helmet = new THREE.SphereGeometry(HELMET_R, seg, Math.max(8, seg - 6));
  // Scale BEFORE the quarter turn, so the long axis (1.12) ends up front-to-back
  // rather than across the driver's ears.
  helmet.scale(1.12, 1.05, 1.0);
  // SphereGeometry puts u = 0.5 (phi = pi) at +X; a quarter turn about +Y swings
  // it to -Z, so the painted visor aperture lands over the eyes and the texture
  // seam ends up at the back of the helmet where nothing can see it.
  helmet.rotateY(Math.PI / 2);
  helmet.translate(HELMET_C.x, HELMET_C.y, HELMET_C.z);
  const parts = [helmet];

  if (D.extras) {
    const pin = (g) => {
      const uv = g.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) uv.setXY(i, 0.5, HELMET_UV_SPARE * 0.5);
      uv.needsUpdate = true;
      return g;
    };
    // Aero fin along the crown.
    const fin = new THREE.BoxGeometry(0.015, 0.032, 0.168);
    fin.rotateX(-0.10);
    fin.translate(0, 0.830, -0.156);
    parts.push(pin(fin));
    // Chin bar / lower air intake, with the central duct mouth.
    const chin = new THREE.BoxGeometry(0.150, 0.048, 0.046);
    chin.translate(0, 0.618, -0.330);
    parts.push(pin(chin));
    const chinDuct = new THREE.BoxGeometry(0.062, 0.026, 0.024);
    chinDuct.translate(0, 0.620, -0.352);
    parts.push(pin(chinDuct));
    // Brow vents above the visor aperture — two small raised scoops.
    for (const side of [-1, 1]) {
      const brow = new THREE.BoxGeometry(0.038, 0.018, 0.030);
      brow.rotateX(0.34);
      brow.translate(side * 0.052, 0.790, -0.300);
      parts.push(pin(brow));
    }
    // Tear-off tabs stacked on the left of the visor.
    for (let i = 0; i < 2; i++) {
      const tab = new THREE.BoxGeometry(0.006, 0.030, 0.020);
      tab.rotateY(0.30);
      tab.translate(-0.128 - i * 0.005, 0.706, -0.286);
      parts.push(pin(tab));
    }
  }
  return mergeGeometries(parts);
}

// Visor aperture, in the sphere's own (phi, theta) parameters — the same window
// `livery.helmetTexture()` paints at u 0.235..0.765, v 0.115..0.665.
const VISOR_PHI = Math.PI * 0.685, VISOR_PHI_LEN = Math.PI * 0.630;
const VISOR_THETA = Math.PI * 0.415, VISOR_THETA_LEN = Math.PI * 0.190;

/**
 * VISOR BEZEL — four sphere-patch strips standing 4 mm proud all round the
 * aperture, so the glass inside them reads as RECESSED.
 *
 * The review asked for the visor to be recessed 6 mm with a 3 mm edge. A true
 * recess needs the aperture cut out of the shell, and the shell cannot be cut:
 * `livery.helmetTexture()` is authored against one continuous
 * `THREE.SphereGeometry` unwrap and paints the visor band itself, so punching a
 * hole in it means the painted band and the glass patch have to agree to the
 * pixel or you can see through the driver's head. A raised bezel gets the same
 * read — 4 mm of dark lip standing over the glass, with its own shadow along the
 * top edge — for four sphere sub-ranges and no risk to the unwrap.
 */
function buildVisorBezel(D) {
  const seg = D.extras ? 24 : 10;
  const d = Math.PI * 0.026;
  const R = HELMET_R * 1.026;
  const strips = [
    [VISOR_PHI - d, VISOR_PHI_LEN + 2 * d, VISOR_THETA - d, d],                      // brow
    [VISOR_PHI - d, VISOR_PHI_LEN + 2 * d, VISOR_THETA + VISOR_THETA_LEN, d],        // chin lip
    [VISOR_PHI - d, d, VISOR_THETA - d, VISOR_THETA_LEN + 2 * d],                    // side
    [VISOR_PHI + VISOR_PHI_LEN, d, VISOR_THETA - d, VISOR_THETA_LEN + 2 * d],        // side
  ];
  const parts = [];
  for (const [p0, pl, t0, tl] of strips) {
    const g = new THREE.SphereGeometry(R, Math.max(3, Math.round(seg * pl / Math.PI)), Math.max(2, Math.round(seg * tl / Math.PI)), p0, pl, t0, tl);
    g.scale(1.12, 1.05, 1.0);
    g.rotateY(Math.PI / 2);
    g.translate(HELMET_C.x, HELMET_C.y, HELMET_C.z);
    parts.push(g);
  }
  return mergeGeometries(parts);
}

/**
 * Tinted visor, cut from the same sphere the helmet texture is painted for.
 * Kept SMALL and inside the painted aperture on purpose: `materials.glass` is a
 * double-sided, depth-write-off, 55%-opacity iridescent shader, so a wide patch
 * of it stops being a visor and becomes a translucent teal dome over the whole
 * head. The texture paints the visor band underneath, so the glass only has to
 * add the reflection.
 */
function buildVisor(D) {
  const seg = D.extras ? 30 : 12;
  const g = new THREE.SphereGeometry(
    HELMET_R * 1.010, seg, Math.max(8, seg - 8),
    VISOR_PHI, VISOR_PHI_LEN, VISOR_THETA, VISOR_THETA_LEN,
  );
  g.scale(1.12, 1.05, 1.0);
  g.rotateY(Math.PI / 2);
  g.translate(HELMET_C.x, HELMET_C.y, HELMET_C.z);
  return g;
}

/**
 * Steering wheel. It used to go wholesale into `darkMetal` (0x3d4046, metalness
 * 1) — a mid-grey metallic slab with two grey sausages on it, which from the
 * cockpit eye point reads as grey plasticine. A real wheel is a black moulded
 * carbon body with black rubber grips; only the shift paddles are metal.
 * @returns {{trim: BufferGeometry, metal: BufferGeometry}}
 */
function buildSteeringWheel(D) {
  const parts = [];
  const shape = new THREE.Shape();
  const w = 0.140, h = 0.098, r = 0.026;
  shape.moveTo(-w + r, -h);
  shape.lineTo(w - r, -h);
  shape.quadraticCurveTo(w, -h, w, -h + r);
  shape.lineTo(w, h - r);
  shape.quadraticCurveTo(w, h, w - r, h);
  shape.lineTo(-w + r, h);
  shape.quadraticCurveTo(-w, h, -w, h - r);
  shape.lineTo(-w, -h + r);
  shape.quadraticCurveTo(-w, -h, -w + r, -h);
  const hole = new THREE.Path();
  hole.moveTo(-0.062, -0.030);
  hole.lineTo(0.062, -0.030);
  hole.lineTo(0.062, 0.052);
  hole.lineTo(-0.062, 0.052);
  shape.holes.push(hole);
  const face = new THREE.ExtrudeGeometry(shape, {
    depth: 0.030, bevelEnabled: true, bevelSize: 0.006, bevelThickness: 0.005,
    bevelSegments: 1, curveSegments: D.extras ? 3 : 1,
  });
  parts.push(face);
  for (const side of [-1, 1]) {
    const grip = new THREE.CapsuleGeometry(0.020, 0.070, 2, D.extras ? 8 : 5);
    grip.rotateZ(0.30 * side);
    grip.translate(side * 0.128, -0.020, 0.026);
    parts.push(grip);
  }
  const metal = [];
  // Shift paddles behind the wheel — the only metal on it, and the one detail
  // that says "F1 wheel" rather than "controller".
  for (const side of [-1, 1]) {
    const p = new THREE.BoxGeometry(0.052, 0.088, 0.008);
    p.rotateY(side * 0.22);
    p.translate(side * 0.086, -0.010, -0.034);
    metal.push(p);
  }
  const place = (g) => { g.rotateX(-0.40); g.translate(0, 0.540, -0.492); return g; };
  return {
    trim: place(mergeGeometries(parts)),
    metal: place(mergeGeometries(metal)),
  };
}

function buildMirrors(D) {
  const parts = [];
  for (const side of [-1, 1]) {
    // Aerofoil stalk.
    const stalk = [];
    for (let k = 0; k <= 4; k++) {
      const t = k / 4;
      stalk.push({
        x: side * (0.330 + t * 0.232), zLE: -0.404 - t * 0.010,
        y: 0.588 + t * 0.008, chord: 0.115, aoa: 0.06,
      });
    }
    if (side < 0) stalk.reverse();
    parts.push(buildWingGeometry(stalk, { profileN: 4, thickness: 0.12, camber: 0.02 }));

    const pod = bodyLoft([
      { z: -0.454, x: side * 0.568, hw: 0.026, yTop: 0.626, yBot: 0.572, nTop: 3, nBot: 3 },
      { z: -0.412, x: side * 0.574, hw: 0.036, yTop: 0.636, yBot: 0.564, nTop: 4, nBot: 4 },
      { z: -0.366, x: side * 0.574, hw: 0.036, yTop: 0.636, yBot: 0.564, nTop: 5, nBot: 5 },
      { z: -0.352, x: side * 0.572, hw: 0.032, yTop: 0.632, yBot: 0.568, nTop: 5, nBot: 5 },
    ], D.extras ? 14 : 8, { tile: WEAVE.carbon });
    parts.push(pod);
  }
  return mergeGeometries(parts);
}

function buildMirrorGlass() {
  const parts = [];
  for (const side of [-1, 1]) {
    const g = new THREE.PlaneGeometry(0.066, 0.062);
    g.rotateY(Math.PI);
    g.translate(side * 0.574, 0.600, -0.346);
    parts.push(g);
  }
  return mergeGeometries(parts);
}

/** Engine-cover cooling louvres, following the cover surface. */
function buildLouvres(D) {
  const parts = [];
  const n = 7;
  for (const side of [-1, 1]) {
    for (let i = 0; i < n; i++) {
      const t = i / (n - 1);
      const z = 1.020 + t * 0.560;
      const st = stationAt(COVER, z);
      const p = skinPoint(st, side, 0.72 - t * 0.10);
      const g = new THREE.BoxGeometry(0.010, 0.028, 0.100);
      g.rotateX(-0.22);
      g.rotateZ(side * 0.24);
      g.translate(p.x + side * 0.003, p.y, z);
      parts.push(matteUV(g));
    }
    // Sidepod exit gills. At 7 x 22 x 70 mm these were sub-pixel at any distance
    // a car is normally photographed from; a real gill bank is 120 mm long and
    // stands 12 mm off the skin, and it is one of the few things that breaks up
    // the pod's rear flank.
    for (let i = 0; i < 5; i++) {
      const t = i / 4;
      const z = 1.060 + t * 0.420;
      const st = stationAt(POD, z);
      const p = skinPoint(st, side, 0.60 + t * 0.14);
      const g = new THREE.BoxGeometry(0.013, 0.026, 0.128);
      g.rotateX(-0.10);
      g.rotateZ(side * 0.34);
      g.translate(p.x + side * 0.004, p.y, z);
      parts.push(matteUV(g));
    }
  }
  return mergeGeometries(parts);
}

/** Panel shutlines: the joints a real car actually has. */
function buildShutlines(D) {
  const parts = [];
  parts.push(shutline(NOSE, -1.352, D.ring));
  parts.push(shutline(NOSE, -2.280, D.ring, { grow: 0.003 }));
  parts.push(shutline(COVER, 0.760, D.ring, { grow: 0.003 }));
  parts.push(shutline(COVER, 1.700, D.ring, { grow: 0.003 }));
  for (const side of [-1, 1]) {
    const pod = POD.map((s) => ({ ...s, x: side * s.x }));
    parts.push(shutline(pod, 0.300, D.ring, { grow: 0.003 }));
    parts.push(shutline(pod, 1.120, D.ring, { grow: 0.003 }));
  }
  return mergeGeometries(parts);
}

/**
 * Non-moving suspension structure. The MOVING links live in `wheels.js`; what
 * this owns is everything bolted to the chassis that they hang off.
 *
 * @returns {{carbon: BufferGeometry, metal: BufferGeometry}}
 *
 * Two things were missing and both were called out. First the wishbone roots
 * were flat 40 mm slabs, so the links appeared to grow out of a box; a real root
 * fairing is an aerofoil in its own right and it is the part that tells you the
 * wishbone is a wing section rather than a tube. `buildWingGeometry` gives it a
 * true section for the same cost as the plate it replaces.
 *
 * Second there was no inboard mechanism at all — the pushrods simply vanished
 * into the bodywork. `wheels.js` puts the front pushrod's chassis pickup at
 * (+-0.133, 0.430, -1.385) and the rear pullrod's at (+-0.152, 0.130, 1.690),
 * and the rocker that receives each of them is machined titanium standing in
 * clear air. Those go into the `darkMetal` bucket, which the steering wheel's
 * shift paddles already create, so the whole rocker/torsion-bar assembly costs
 * ZERO extra draw calls per car — and it is the only metal on the car between
 * the wheels, so it is the only thing back there that takes a hard specular.
 */
function buildSuspensionFairings(D) {
  const parts = [];
  const metal = [];
  for (const side of [-1, 1]) {
    // ---- front upper-wishbone root fairing -------------------------------
    // The two upper legs pick up at z -1.955 and -1.265; one fairing spans both
    // and sits on the nose flank where the skin is at x ~0.25 at this height.
    const upper = [];
    for (let k = 0; k <= 3; k++) {
      const t = k / 3;
      upper.push({
        x: side * (0.196 + t * 0.104), zLE: -1.880 + t * 0.030,
        y: 0.346 - t * 0.006, chord: 0.360 - t * 0.070, aoa: 0.04,
      });
    }
    if (side < 0) upper.reverse();
    parts.push(buildWingGeometry(upper, {
      profileN: D.extras ? 7 : 4, thickness: 0.075, camber: 0.0, tile: WEAVE.carbonMatte,
    }));

    // ---- front lower-wishbone bracket ------------------------------------
    // The lower legs pick up at y 0.112-0.118, which is 55 mm BELOW the nose's
    // underside (0.171), so they used to start in mid air. This is the keel the
    // real pickups are bonded to.
    const keel = plateGeometry([
      [-2.030, 0.108], [-1.230, 0.104], [-1.230, 0.196], [-2.030, 0.186],
    ], 0.052, { curveSegments: 2, bevel: 0.15 });
    keel.translate(side * 0.208, 0, 0);
    parts.push(matteUV(keel));

    // Rear crash-structure side fairings / rear suspension roots.
    const rear = plateGeometry([[1.860, 0.300], [2.140, 0.320], [2.140, 0.420], [1.860, 0.430]], 0.034);
    rear.translate(side * 0.110, 0, 0);
    parts.push(matteUV(rear));

    // ---- inboard rockers -------------------------------------------------
    // Front: a bellcrank on the chassis flank where the pushrod dies, on a
    // pivot boss, with the torsion-bar tube running inboard from it.
    const fr = plateGeometry([
      [-1.500, 0.372], [-1.298, 0.398], [-1.318, 0.502], [-1.472, 0.494],
    ], 0.026, { curveSegments: 1, bevel: 0.2 });
    fr.translate(side * 0.250, 0, 0);
    metal.push(matteUV(fr));
    const fbar = new THREE.CylinderGeometry(0.024, 0.024, 0.116, D.extras ? 12 : 6);
    fbar.rotateZ(Math.PI / 2);
    fbar.translate(side * 0.204, 0.446, -1.392);
    metal.push(matteUV(fbar));

    // Rear: the pullrod pickup sits low, so its rocker points down off the
    // gearbox casing — which is why a real rear end looks nothing like a front.
    const rr = plateGeometry([
      [1.628, 0.150], [1.812, 0.132], [1.868, 0.284], [1.706, 0.296],
    ], 0.026, { curveSegments: 1, bevel: 0.2 });
    rr.translate(side * 0.176, 0, 0);
    metal.push(matteUV(rr));
    const rbar = new THREE.CylinderGeometry(0.026, 0.026, 0.150, D.extras ? 12 : 6);
    rbar.rotateZ(Math.PI / 2);
    rbar.translate(side * 0.110, 0.268, 1.788);
    metal.push(matteUV(rbar));
  }

  if (D.extras) {
    // Front heave damper across the two rockers, under the nose top deck.
    const heave = new THREE.CylinderGeometry(0.030, 0.030, 0.256, 14);
    heave.rotateZ(Math.PI / 2);
    heave.translate(0, 0.470, -1.318);
    metal.push(matteUV(heave));
    // Rear heave damper / third element on top of the gearbox casing.
    const rheave = new THREE.CylinderGeometry(0.028, 0.028, 0.190, 14);
    rheave.rotateZ(Math.PI / 2);
    rheave.translate(0, 0.352, 1.706);
    metal.push(matteUV(rheave));
    // Nose camera pods.
    for (const side of [-1, 1]) {
      const cam = new THREE.BoxGeometry(0.050, 0.045, 0.090);
      cam.translate(side * 0.150, 0.302, -2.180);
      parts.push(matteUV(cam));
      const stalk = new THREE.BoxGeometry(0.018, 0.070, 0.030);
      stalk.translate(side * 0.150, 0.257, -2.180);
      parts.push(matteUV(stalk));
    }
  }
  return { carbon: mergeGeometries(parts), metal: mergeGeometries(metal) };
}

// ---------------------------------------------------------------------------

/**
 * All static body geometry, merged into one BufferGeometry per material name.
 * Cached per detail level: called once per level for the whole game.
 * @param {'high'|'low'} detail
 */
export function buildChassisGeometry(detail = 'high') {
  const level = DETAIL[detail] ? detail : 'low';
  return assets.geometry(`car/chassis/${level}`, () => {
    const D = detailOf(level);
    const buckets = new Map();
    const add = (mat, geo) => {
      if (!buckets.has(mat)) buckets.set(mat, []);
      buckets.get(mat).push(geo);
    };

    // Painted bodywork (livery-mapped).
    add('paint', buildNose(D));
    add('paint', buildNoseChamfer(D));
    add('paint', buildTub(D));
    add('paint', buildEngineCover(D));
    add('paint', buildSidepod(-1, D));
    add('paint', buildSidepod(1, D));

    // Exposed carbon aero. Which bucket a panel lands in is a LOOK decision, not
    // a naming one: `carbon` is a full clearcoat lobe at envMapIntensity 1.5, so
    // any large, near-flat, sky-facing panel put there mirrors the whole
    // hemisphere and reads as a uniform navy slab. That is what made the front
    // wing look like one plate even after it grew four elements and slot gaps.
    // Sky-facing panels -> `carbonMatte`; edge-on panels keep the gloss.
    add('carbonMatte', buildFrontWing(D));
    const rw = buildRearWing(D);
    add('carbon', rw.gloss);
    add('carbonMatte', rw.matte);
    add('carbon', buildMirrors(D));

    // Matte carbon underbody and furniture.
    add('carbonMatte', buildFloor(D));
    add('carbonMatte', buildUnderbodyCloseout(D));
    add('carbonMatte', buildDiffuser(D));
    add('carbonMatte', buildRearEnd(D));
    add('carbonMatte', buildFloorFences(D));
    add('carbonMatte', buildBargeboards(D));
    add('carbonMatte', buildHalo(D));
    const susp = buildSuspensionFairings(D);
    add('carbonMatte', susp.carbon);
    // Machined rockers and torsion bars. `darkMetal` already exists for the
    // shift paddles, so this merges into an existing bucket: no extra draw call.
    add('darkMetal', susp.metal);
    for (const side of [-1, 1]) {
      add('carbonMatte', buildSidepodInlet(side, D));
      // The undercut is bare carbon, and moving it out of `paint` is what turns
      // the venturi entrance from a bright red shoulder into a shadowed void.
      add('carbonMatte', buildPodShroud(side, D));
      add('carbonMatte', buildPodRampLip(side, D));
    }
    add('carbonMatte', buildAirboxInlet(D));
    if (D.extras) {
      add('carbonMatte', buildHoopInlets(D));
      add('carbonMatte', buildLouvres(D));
      add('carbonMatte', buildShutlines(D));
    }

    // Cockpit and driver.
    const cockpit = buildCockpit(D);
    add('cockpitTrim', cockpit.trim);
    add('carbonMatte', cockpit.carbon);       // the coaming rim is exposed carbon
    const driver = buildDriverBody(D);
    add('cockpitTrim', driver.trim);
    // The race suit is the ONE bucket this module adds beyond the nine it used to
    // have, and only at `high` detail — one draw call for the player's car, zero
    // for the nineteen AI cars, which are all built at `low`.
    if (driver.suit) add('paintSecondary', driver.suit);
    // `helmet` is not part of the materials.js bundle: CarModel attaches a
    // per-driver material under that key, so the geometry stays shared and the
    // helmet still costs zero extra draw calls.
    add('helmet', buildHelmetShell(D));
    const wheel = buildSteeringWheel(D);
    add('cockpitTrim', wheel.trim);
    add('darkMetal', wheel.metal);
    if (D.extras) {
      add('cockpitTrim', buildVisorBezel(D));
      add('glass', buildVisor(D));
      add('glass', buildMirrorGlass());
    }

    // Exhaust: central tailpipe plus the two wastegates.
    const pipe = new THREE.CylinderGeometry(0.052, 0.058, 0.200, D.extras ? 16 : 8, 1, true);
    pipe.rotateX(Math.PI / 2);
    pipe.translate(0, 0.436, 2.400);
    add('exhaust', pipe);
    for (const side of [-1, 1]) {
      const wg = new THREE.CylinderGeometry(0.022, 0.024, 0.130, D.extras ? 10 : 6, 1, true);
      wg.rotateX(Math.PI / 2);
      wg.translate(side * 0.086, 0.470, 2.360);
      add('exhaust', wg);
    }

    // FIA rain light: the lens sits recessed in the housing that buildRearEnd
    // puts on the crash structure, plus the two mandatory diffuser-edge lights.
    const light = new THREE.BoxGeometry(0.100, 0.134, 0.030);
    light.translate(0, 0.318, 2.482);
    add('rainLight', light);
    for (const side of [-1, 1]) {
      const l = new THREE.BoxGeometry(0.052, 0.052, 0.022);
      l.translate(side * 0.452, 0.176, 2.442);
      add('rainLight', l);
    }

    const merged = new Map();
    for (const [mat, list] of buckets) merged.set(mat, mergeGeometries(list));
    for (const g of merged.values()) g.computeBoundingSphere();
    return { buckets: merged, drsFlap: buildDrsFlap(D) };
  });
}

/** DRS flap hinge position, in car-local space. See RW_MAIN_Y. */
const DRS_HINGE = new THREE.Vector3(0, 0.911, 2.398);

export class CarModel {
  /**
   * @param {{team:object, driver:object}} entry from livery.fullGrid()
   * @param {{liveryTexture?:THREE.Texture, detail?:'high'|'low'}} opts
   */
  constructor(entry, opts = {}) {
    this.entry = entry;
    this.detail = DETAIL[opts.detail] ? opts.detail : 'low';
    this.group = new THREE.Group();
    this.group.name = `Car:${entry.team.id}:${entry.driver.code}`;

    const liveryTex = opts.liveryTexture ?? null;
    this.materials = createCarMaterials(entry.team, liveryTex);
    // Helmets are per DRIVER, not per team, so the bundle cannot bake one. The
    // key is added here; `materials.dispose()` walks its own values and will
    // dispose it with the rest.
    this.materials.helmet = createHelmetMaterial(entry.team, entry.driver);

    const { buckets, drsFlap } = buildChassisGeometry(this.detail);
    this.bodyMeshes = [];
    for (const [matName, geo] of buckets) {
      const mat = this.materials[matName] ?? this.materials.carbon;
      const m = new THREE.Mesh(geo, mat);
      // Glass (visor, camera lenses) and the rain light are transparent or tiny
      // and sit inside the silhouette the body already casts, so they only cost
      // a draw call per shadow cascade per car.
      m.castShadow = matName !== 'glass' && matName !== 'rainLight';
      m.receiveShadow = matName !== 'glass';
      m.name = `body:${matName}`;
      this.group.add(m);
      this.bodyMeshes.push(m);
    }

    // Per-car decals that cannot live in the shared merged buckets: the
    // rear-wing number panel and the halo tip. Owned by car/materials.js.
    if (this.materials.decorate) this.group.add(this.materials.decorate(entry));

    // DRS flap on its own pivot. Closed = trailing edge up (an inverted wing);
    // open = the flap rotates down to near-horizontal and the slot stalls.
    this.drsPivot = new THREE.Group();
    this.drsPivot.position.copy(DRS_HINGE);
    const flap = new THREE.Mesh(drsFlap, this.materials.carbon);
    flap.castShadow = true;
    flap.receiveShadow = true;
    this.drsPivot.add(flap);
    this.group.add(this.drsPivot);
    this.drsClosedAngle = -0.62;
    this.drsOpenAngle = -0.04;
    this.setDRS(0);

    // Wheels + suspension.
    this.wheels = buildWheelSet(this.materials, {
      frontZ: AXLE_FRONT_Z, rearZ: AXLE_REAR_Z,
      frontTrack: TRACK_FRONT, rearTrack: TRACK_REAR,
      chassis: this.group,
      detail: opts.detail ?? 'high',
    });

    /** Named attachment points used by cameras, FX and audio. */
    this.anchors = {
      cockpitEye: new THREE.Vector3(0, 0.685, -0.245),
      chaseTarget: new THREE.Vector3(0, 0.58, 0.20),
      nose: new THREE.Vector3(0, 0.22, -2.95),
      tail: new THREE.Vector3(0, 0.45, 2.45),
      exhaust: new THREE.Vector3(0, 0.44, 2.52),
      roll: new THREE.Vector3(0, 0.99, 0.20),
      frontWing: new THREE.Vector3(0, 0.10, -2.95),
    };
  }

  /** @param {number} t 0 = closed, 1 = fully open. */
  setDRS(t) {
    this.drsOpen = t;
    this.drsPivot.rotation.x = THREE.MathUtils.lerp(this.drsClosedAngle, this.drsOpenAngle, t);
  }

  setSteer(rad) { this.wheels.setSteer(rad); }
  setWheelSpin(radArray) { this.wheels.setSpin(radArray); }
  setSuspension(travel) { this.wheels.setSuspension(travel); }
  setBrakeHeat(t) { this.materials.setBrakeHeat(t); }

  update(dt, state) { this.wheels.update(dt, state); }

  dispose() {
    this.materials.dispose();
    this.wheels.dispose();
  }
}

/** Convenience factory used by the engine and the AI. */
export function createCarModel(entry, opts = {}) {
  return new CarModel(entry, opts);
}
