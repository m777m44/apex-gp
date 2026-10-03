/**
 * APEX GP — camera system.
 *
 * One PerspectiveCamera driven by swappable *solvers*. Every solver owns its
 * own spring state, so two of them can run at once and be cross-faded, which
 * is how mode changes and replay cuts stay smooth.
 *
 * MODES
 *   chase    behind-the-car; smoothed follow YAW (not a positional spring),
 *            corner look-ahead, speed-coupled FOV, roll into lateral g
 *   cockpit  driver eye point behind the halo; helmet looks into the corner,
 *            head is thrown around by g, counter-rolls to stay level
 *   halo     the T-cam on the airbox crown
 *   bumper   nose cam at the tip of the nose, ahead of the front wing
 *   tv       a real world-feed: a ring of fixed trackside cameras that acquire
 *            the car, pan/tilt/zoom with operator lag + hand-held float, and
 *            hand off to each other with a hard cut
 *   hero     cinematic orbit with a dolly move (used by the `beauty` shot)
 *   wide     elevated helicopter establishing shot anchored to the circuit
 *
 * FRAMING IS A NUMBER, NOT A FEELING
 *   Every solver here decides its lens from a target SUBJECT SIZE and then
 *   expresses every framing offset (lead room, headroom, follow-yaw swing) as a
 *   fraction of the resulting half-FOV. That is the difference between a camera
 *   that composes the same shot at 6 m and at 150 m and one that is centred up
 *   close and has the car half out of frame down the road. Two of the three big
 *   faults fixed in this pass were metric offsets on a variable lens; the third
 *   was a spring with no velocity feed-forward tracking an 80 m/s anchor.
 *
 * WHY THE CHASE CAM IS NOT A POSITION SPRING
 *   A critically damped spring with velocity feed-forward still lags a target
 *   by `a / k` metres.  An F1 car pulls ~3.5 g, so at k = 11 that is 3.2 m of
 *   steady-state error *sideways* through every corner — enough to push the car
 *   to the edge of frame.  Instead the follow BASIS (a yaw angle) is sprung and
 *   the camera is placed rigidly on that basis, so the lag shows up as the
 *   broadcast "camera swings wide on turn-in" and never as bad framing.
 *
 * PUBLIC API — see CONTRACT.md §5.
 */

import * as THREE from 'three';
import { clamp, lerp, makeRng, hashSeed } from '../core/rng.js';
import { carbonFibre, fabric, mapsToMaterial, cloneMaps, setRepeat } from '../textures/procedural.js';
import { assets, mergeGeometries } from '../core/assets.js';

/* -------------------------------------------------------------------------- */
/*  scratch — nothing in this file allocates per frame                         */
/* -------------------------------------------------------------------------- */
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _carUp = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _pos = new THREE.Vector3();
const _look = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _tmp2 = new THREE.Vector3();
const _dirA = new THREE.Vector3();
const _dirB = new THREE.Vector3();
const _dirC = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();
const _basis = new THREE.Vector3();
const _basisR = new THREE.Vector3();
/** Private to CockpitInterior — never touch the solver scratch from a prop. */
const _cv = new THREE.Vector3();
const _cv2 = new THREE.Vector3();
const _cq = new THREE.Quaternion();
const _mirrorEuler = new THREE.Euler();

export const CAMERA_MODES = ['chase', 'cockpit', 'halo', 'tcam', 'bumper', 'tv', 'hero', 'wide'];

/** Car-local mount points. Ground plane under the CoG is the origin, -Z fwd. */
export const MOUNTS = {
  // REAL COCKPIT. The driver's own eye point, raised the way every racing game
  // raises it so the lens clears the tub rim, the halo hoop and the nose instead
  // of being buried behind them. The helmet shell (centre 0.690/-0.196,
  // semi-axes 0.142 x 0.149 x 0.159) stays entirely INSIDE the 0.25 m near
  // plane, which is what lets the player sit inside their own head without a
  // shard of skull in frame — do not move this back past z = -0.15 or the far
  // side of the shell pokes through it.
  //
  // THE HEIGHT IS MEASURED, NOT CHOSEN. It decides how much ROAD the driver can
  // see, which is the whole point of the view. Projected frame fractions from
  // the top of a 1600x900 frame, measured on the `cockpit` shot at 181 km/h
  // (shots/d2-eye0*.png), horizon fixed at 0.42:
  //     eye y   halo apex   nose top   road band (horizon..nose)
  //     0.80      0.44        0.61       almost none — the hoop fills it
  //     0.84      0.51        0.64       0.13 of frame height, hoop through it
  //     0.92      0.65        0.67       0.25, hoop and nose stacked BELOW it
  //     1.00      0.78        0.70       0.28, but the hoop has left the frame
  // At 0.80 the driver cannot see the track at all: the halo band, the chassis
  // top and the nose stack up across the whole middle of the frame and the only
  // tarmac in shot is a sliver at the left edge. 0.91 keeps the hoop and its
  // centre pillar as a strong foreground band in the lower third — which is what
  // an F1 onboard looks like — with a quarter of the frame of open road above
  // it. `CockpitInterior` is authored against this point and RIDES it (see
  // `setEye`), so a seat-height change re-frames the world without moving the
  // wheel, the mirrors or the hands.
  cockpitEye: new THREE.Vector3(0.00, 0.910, -0.215),   // see CockpitInterior
  // The BROADCAST onboard, the one F1 calls the "halo cam". Height is not
  // cosmetic. The halo apex is at y 0.786, z -0.748 and its rear mounts at
  // y 0.512, z +0.216 — BEHIND the lens. Put the eye at 0.895 and the apex is
  // only 0.11 m above the sightline while the rear mounts sweep past 15 cm from
  // the lens, so the hoop renders as a fat tube eating the top half of the road
  // (captured and compared: shots/eyeA.png). At 0.975 the whole hoop drops into
  // the lower third with the pillar centred and both front tyres visible either
  // side of it — the broadcast onboard read.
  haloCam: new THREE.Vector3(0.00, 0.975, -0.215),
  // T-cam: on a pod on the airbox crown. The engine cover peaks at y 0.995 /
  // z 0.06, so 1.10 clears it by 10 cm — the real mounting — and z 0.16 puts the
  // crown lip just inside the bottom of frame the way a T-cam onboard reads.
  tcam: new THREE.Vector3(0.00, 1.100, 0.160),
  // Nose cam. It has to be AHEAD of the front wing, not behind it: at z -1.98
  // the mainplane (top y ~0.30, z -2.7…-3.0) sits dead on the sightline and the
  // whole middle of the frame is a slab of carbon (shots/cam-bumper.png, v1).
  // At the nose tip the wing falls away below the lens and only the endplate
  // tops clip the bottom corners, which is the shot people actually want.
  bumper: new THREE.Vector3(0.00, 0.410, -2.300),
  // Chase subject anchor. y is the height above the road the lens is TRAINED on,
  // not the height of the car: see `_solveChase`, where the vertical framing is
  // solved as a constraint pair and this point only sets the horizontal aim.
  chaseFocus: new THREE.Vector3(0.00, 0.860, 0.150),
};

const TAU = Math.PI * 2;

/* -------------------------------------------------------------------------- */
/*  maths helpers                                                             */
/* -------------------------------------------------------------------------- */

function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

function smootherstep(t) {
  t = clamp(t, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Deterministic value noise, C1 continuous — used for hand-held float. */
function hash1(n) {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453123;
  return s - Math.floor(s);
}
function vnoise(x) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return (hash1(i) * (1 - u) + hash1(i + 1) * u) * 2 - 1;
}
/** Two octaves — enough character without looking like a sine wave. */
function fbm1(x) { return vnoise(x) * 0.72 + vnoise(x * 2.17 + 19.3) * 0.28; }

/**
 * Analytic damped-spring integrator. Solved in closed form rather than stepped
 * with explicit Euler, so it is unconditionally stable and — more usefully —
 * frame-rate independent: a 30 fps frame and two 60 fps frames land in exactly
 * the same place, which is what keeps captures reproducible.
 *
 * Returns [x, v] through the module-level `_sp` pair to avoid allocating.
 */
const _sp = [0, 0];
function solveSpring(x0, v0, k, dt, zeta) {
  const w = Math.sqrt(k);
  if (zeta >= 0.9999) {
    const e = Math.exp(-w * dt);
    const c = v0 + w * x0;
    _sp[0] = (x0 + c * dt) * e;
    _sp[1] = (v0 - dt * w * c) * e;
  } else {
    const a = zeta * w;
    const wd = w * Math.sqrt(1 - zeta * zeta);
    const e = Math.exp(-a * dt);
    const cs = Math.cos(wd * dt), sn = Math.sin(wd * dt);
    const B = (v0 + a * x0) / wd;
    _sp[0] = e * (x0 * cs + B * sn);
    _sp[1] = e * (v0 * cs - (a * B + wd * x0) * sn);
  }
  return _sp;
}

/** Scalar damped spring with velocity feed-forward. */
class Spring1 {
  constructor(x = 0) { this.x = x; this.v = 0; }
  set(x, v = 0) { this.x = x; this.v = v; return x; }
  step(to, k, dt, ffv = 0, zeta = 1) {
    // Solve in the target's own frame. `to` is the target at the END of the
    // step, so the error at the START is (x - to) + ffv*dt; forgetting that
    // term makes the feed-forward double-count and parks the spring a full
    // `ffv * dt / (1 - decay)` behind — metres, at racing speed.
    const r = solveSpring(this.x - to + ffv * dt, this.v - ffv, k, dt, zeta);
    this.x = r[0] + to;
    this.v = r[1] + ffv;
    return this.x;
  }
}

/** As above, on the shortest arc — the state is rebased before each step. */
class SpringAngle extends Spring1 {
  set(x, v = 0) { return super.set(wrapAngle(x), v); }
  step(to, k, dt, ffv = 0, zeta = 1) {
    this.x = to + wrapAngle(this.x - to);
    return super.step(to, k, dt, ffv, zeta);
  }
}

/** Vector spring with independent horizontal / vertical stiffness. */
class Spring3 {
  constructor() { this.x = new THREE.Vector3(); this.v = new THREE.Vector3(); }
  set(to, vel) { this.x.copy(to); if (vel) this.v.copy(vel); else this.v.set(0, 0, 0); }
  step(to, kh, kv, dt, ffv) {
    const fx = ffv ? ffv.x : 0, fy = ffv ? ffv.y : 0, fz = ffv ? ffv.z : 0;
    let r = solveSpring(this.x.x - to.x + fx * dt, this.v.x - fx, kh, dt, 1);
    this.x.x = r[0] + to.x; this.v.x = r[1] + fx;
    r = solveSpring(this.x.y - to.y + fy * dt, this.v.y - fy, kv, dt, 1);
    this.x.y = r[0] + to.y; this.v.y = r[1] + fy;
    r = solveSpring(this.x.z - to.z + fz * dt, this.v.z - fz, kh, dt, 1);
    this.x.z = r[0] + to.z; this.v.z = r[1] + fz;
    return this.x;
  }
}

/** direction(yaw) with the project's convention: forward = (-sin, 0, -cos). */
function yawDir(yaw, out) { return out.set(-Math.sin(yaw), 0, -Math.cos(yaw)); }
function yawRight(yaw, out) { return out.set(Math.cos(yaw), 0, -Math.sin(yaw)); }

/* -------------------------------------------------------------------------- */
/*  replay ring buffer                                                        */
/* -------------------------------------------------------------------------- */

const REPLAY_STRIDE = 13;   // px py pz qx qy qz qw speed gLat gLong trackS onTrack t

/**
 * Fixed-size ring of car states. Cheap enough (13 floats/sample) to run all the
 * time, so a replay is always available without the game having to arm it.
 */
export class ReplayBuffer {
  constructor({ seconds = 24, hz = 60 } = {}) {
    this.hz = hz;
    this.capacity = Math.max(8, Math.ceil(seconds * hz));
    this.data = new Float32Array(this.capacity * REPLAY_STRIDE);
    this.count = 0;
    this.head = 0;             // next write slot
    this.time = 0;             // wall time of the newest sample
    this._acc = 0;
    this._out = {
      position: new THREE.Vector3(),
      quaternion: new THREE.Quaternion(),
      speed: 0,
      telemetry: { gLat: 0, gLong: 0, trackS: 0, onTrack: true },
    };
  }

  clear() { this.count = 0; this.head = 0; this.time = 0; this._acc = 0; }

  get seconds() { return this.capacity / this.hz; }
  get newest() { return this.time; }
  get oldest() { return this.count >= this.capacity ? this.time - (this.count - 1) / this.hz : 0; }
  get duration() { return Math.max(0, this.newest - this.oldest); }

  /** Feed one simulation frame. Resamples internally to the buffer rate. */
  push(dt, state) {
    if (!state || !state.position) return;
    this._acc += dt;
    const step = 1 / this.hz;
    if (this.count > 0 && this._acc < step) return;
    this._acc = this.count > 0 ? Math.min(this._acc - step, step) : 0;
    this.time += this.count > 0 ? step : 0;
    const d = this.data;
    const o = this.head * REPLAY_STRIDE;
    const p = state.position, q = state.quaternion, tm = state.telemetry;
    d[o] = p.x; d[o + 1] = p.y; d[o + 2] = p.z;
    d[o + 3] = q.x; d[o + 4] = q.y; d[o + 5] = q.z; d[o + 6] = q.w;
    d[o + 7] = state.speed ?? 0;
    d[o + 8] = tm ? (tm.gLat ?? 0) : 0;
    d[o + 9] = tm ? (tm.gLong ?? 0) : 0;
    d[o + 10] = tm ? (tm.trackS ?? 0) : 0;
    d[o + 11] = tm && tm.onTrack === false ? 0 : 1;
    d[o + 12] = this.time;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  /** Slot index of the i-th oldest sample. */
  _slot(i) {
    const start = this.count >= this.capacity ? this.head : 0;
    return (start + i) % this.capacity;
  }

  /** Interpolated state at wall time `t` (clamped into the buffer). */
  sample(t) {
    const out = this._out;
    if (this.count === 0) return out;
    const t0 = this.oldest;
    const f = clamp((t - t0) * this.hz, 0, this.count - 1);
    const i0 = Math.floor(f);
    const i1 = Math.min(this.count - 1, i0 + 1);
    const u = f - i0;
    const d = this.data;
    const a = this._slot(i0) * REPLAY_STRIDE;
    const b = this._slot(i1) * REPLAY_STRIDE;
    out.position.set(
      lerp(d[a], d[b], u),
      lerp(d[a + 1], d[b + 1], u),
      lerp(d[a + 2], d[b + 2], u),
    );
    _qa.set(d[a + 3], d[a + 4], d[a + 5], d[a + 6]);
    _qb.set(d[b + 3], d[b + 4], d[b + 5], d[b + 6]);
    out.quaternion.copy(_qa).slerp(_qb, u);
    out.speed = lerp(d[a + 7], d[b + 7], u);
    out.telemetry.gLat = lerp(d[a + 8], d[b + 8], u);
    out.telemetry.gLong = lerp(d[a + 9], d[b + 9], u);
    out.telemetry.trackS = d[u < 0.5 ? a + 10 : b + 10];
    out.telemetry.onTrack = d[a + 11] > 0.5;
    return out;
  }
}

/* -------------------------------------------------------------------------- */
/*  per-mode solver state                                                     */
/* -------------------------------------------------------------------------- */

class SolverState {
  constructor(fov) {
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.fov = fov;
    this.roll = 0;
    this.focus = 10;
    this.ready = false;
    this.yaw = new SpringAngle();
    this.pitch = new Spring1();
    this.aux = new SpringAngle();
    this.fovS = new Spring1(fov);
    this.body = new Spring3();
    this.lookS = new Spring3();
    this.head = new Spring3();
    this.prevYaw = 0;
    this.prevAim = 0;
    this.prevPitchAim = 0;
    this.prevLook = new THREE.Vector3();
    // Second finite-difference slot: a solver that springs BOTH its position and
    // its aim needs a previous-desired for each, or the aim spring runs without
    // feed-forward and lags 2v/omega — 31 m at racing speed on a k = 26 spring.
    this.prevAimPos = new THREE.Vector3();
    this.t = 0;
    this.i = 0;          // active trackside camera, tv only
    this.dwell = 0;
    this.seed = 0;
  }
}

/** Output frame of a solver. */
class Pose {
  constructor() {
    this.pos = new THREE.Vector3();
    this.look = new THREE.Vector3();
    this.up = new THREE.Vector3(0, 1, 0);
    this.fov = 60;
    this.roll = 0;
    this.focus = 10;
    this.shakeScale = 1;
  }
  copy(o) {
    this.pos.copy(o.pos); this.look.copy(o.look); this.up.copy(o.up);
    this.fov = o.fov; this.roll = o.roll; this.focus = o.focus;
    this.shakeScale = o.shakeScale;
    return this;
  }
}

/* -------------------------------------------------------------------------- */

export class CameraRig {
  constructor(camera, { circuit, topSpeed = 95, replaySeconds = 24 } = {}) {
    this.camera = camera;
    this.circuit = circuit;
    this.topSpeed = topSpeed;
    this.mode = 'chase';
    this.prevMode = 'chase';
    this.target = null;

    /** Final blended pose — `position`/`lookAt` are kept for compatibility. */
    this.position = new THREE.Vector3();
    this.lookAt = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.lookVelocity = new THREE.Vector3();

    this.baseFov = 62;
    this.fov = 62;
    this.roll = 0;
    this.focusDistance = 10;
    this.shake = 0;
    this.time = 0;
    this.rng = makeRng(hashSeed('camera'));
    this.needsSnap = true;

    /**
     * Per-rig copies of the car-local mount points, so a game can expose a seat
     * position slider (and a test can A/B an eye height) without reaching into
     * the module-level `MOUNTS`, which every rig shares.
     */
    this.mounts = {
      cockpitEye: MOUNTS.cockpitEye.clone(),
      haloCam: MOUNTS.haloCam.clone(),
      tcam: MOUNTS.tcam.clone(),
      bumper: MOUNTS.bumper.clone(),
      chaseFocus: MOUNTS.chaseFocus.clone(),
    };

    /**
     * Cockpit view. `pitch` is the lens depression in radians and is the ONLY
     * framing number here in an absolute unit, because a cockpit has a fixed
     * physical geometry — the wheel really is 40 cm below the eyeline. Everything
     * else the cockpit needs (wheel size, LED count, mirror placement) lives on
     * `CockpitInterior` so a seat-position slider only has to move the eye.
     */
    this.cockpit = {
      // 52 deg vertical is 82 deg horizontal. It is tempting to go wider — a real
      // helmet sees ~180 — but at 62 deg vertical (98 horizontal) the front tyres
      // subtend 29 deg each at 1.4 m and the frame becomes two enormous barrels
      // of tread with a fisheye horizon between them (shots/cam2-cockpit.png).
      // The mirrors were the only reason to go wide, and they are cheated inboard
      // instead. 82 deg is what F1 24's default cockpit is close to.
      fov: 52, fovSpeed: 6,
      // rad; NEGATIVE = pitched DOWN, and pitching further down moves the whole
      // interior UP the frame. At -0.075 the dash LCD's bottom row ('KM/H' and
      // the ERS bar) sat within ~18 px of the bottom edge at 16:9 and went off it
      // at 21:9 — a cropped instrument cluster reads as a framing accident. 1.3
      // deg more depression is 2.6 % of frame height; combined with the wheel and
      // screen lift in `CockpitInterior` the panel now clears the edge by ~6 %.
      pitch: -0.088,        // rad; the wheel rim and the halo apex both read
      visor: 1.0,           // 0..1 strength of the helmet aperture at frame top
      interior: true,       // render the wheel / hands / mirrors / dash
      // How far the helmet turns into the corner. Measured on `cockpit`, the old
      // 0.42 turned the head 14 deg, which slides the whole car — including both
      // mirrors — 0.29 ndc across the frame and pushed the outside mirror clean
      // off it. 8 deg still reads as looking into the apex.
      lookInto: 0.24,
    };
    this.interior = null;   // lazily built CockpitInterior

    /**
     * Chase framing. These are FRAMING numbers, not taste: at 6.4 m of lens-to-
     * car distance a 2 m wide car subtends 24 % of frame width only if the
     * horizontal FOV is ~66 deg, which at 16:9 is 41 deg VERTICAL. The old rig
     * ran 64 deg vertical (= 97 deg horizontal, a fisheye) at 8.8 m, so the car
     * was 12 % of the frame — a dot on a huge expanse of tarmac. Speed sense is
     * bought back with the distance/FOV ramp plus motion blur, not with a wide
     * lens that flattens the car.
     *
     * THE VERTICAL IS A CONSTRAINT PAIR, NOT AN OFFSET — see `_solveChase`.
     * The previous rig aimed at a point 0.86 m above the CoG from 5.05 m back and
     * 1.44 m up, which is a 6.6 deg depression before the look-ahead added more;
     * measured on shots/cam0-chase.png the horizon sat at 0.24 of frame height,
     * the diffuser was cut in half by the frame edge and NEITHER rear contact
     * patch nor the ground shadow was in shot. A car whose contact patches are
     * off-frame is a car floating on a sliding texture, so the ground line is now
     * a hard constraint and the horizon a soft target.
     *
     * SUBJECT SIZE IS A CONSTANT, NOT A FUNCTION OF SPEED. `back` and `fov` both
     * ramp with speed, and both SHRINK the car, so the two multiply: at
     * back +1.20 / fov +4.0 the car lost 26 % of its frame width between 180 and
     * 330 km/h (measured, `tools/_camframe.mjs`: 0.397 -> 0.348 of frame width).
     * That is what put the car at 28 % of frame width in the r3 flat-out frame
     * and made the vanishing point, not the car, the compositional subject.
     * The ramps are still there — they are what sells speed — but they are now
     * small enough that the car holds 0.40..0.45 of frame width everywhere.
     */
    this.chase = {
      back: 5.95, backSpeed: 0.85,        // metres behind the car, + at speed
      height: 0.88, heightSpeed: 0.24,    // metres above the road behind the car
      fov: 33.0, fovSpeed: 3.0,           // vertical degrees; 36.0 flat out
      lookAhead: 0.13, lookAheadSpeed: 0.11,   // YAW ONLY (see solver)
      swing: 0.145,                       // rad of follow-yaw lag allowed
      outside: 0.45,                      // metres of cross-corner offset (see solver)
      rollPerG: 0.0155,
      // Vertical framing, all as fractions of FRAME HEIGHT measured from the top.
      horizon: 0.325,                     // where the true horizon wants to sit
      floorFrac: 0.96,                    // the car's ground line may go no lower
      ceilFrac: 0.30,                     // the airbox crown may go no higher
      floorZ: 2.10,                       // car-local +Z of the ground reference
      ceilY: 1.02,                        // car-local height of the crown
      maxPitch: 0.26,                     // rad, hard clamp either way
    };

    // hero orbit (the `beauty` shot pokes these directly)
    this.orbitAngle = 0.72;
    this.orbitSpeed = 0.22;
    this.orbitAngleTrim = 0.42;  // pushes `orbitAngle` toward a true 3/4 front
    this.orbitRadius = 6.9;
    // Low, but below the airbox (1.05 m) rather than below the beltline: the car
    // still breaks the horizon, and the lens can be tipped slightly DOWN, which
    // is the only thing that gets the empty sky band out of the top of frame.
    this.orbitHeight = 0.84;
    this.orbitFov = 31;
    // Metres above the ground the lens is aimed at. RAISING THIS LOWERS THE CAR:
    // tipping the lens up pushes the subject down the frame. Tried at 0.86 to
    // buy back the empty foreground tarmac and it did the exact opposite — the
    // car went from 0.42..0.78 of frame height to 0.46..0.85 and picked up a band
    // of roof and sky (shots/c3-beauty.png vs c4-beauty.png). 0.68 it is.
    this.orbitAim = 0.68;
    this.orbitDolly = 1;         // 0 disables the dolly-in/parallax move
    this.orbitLead = 0.06;       // 0..1 — how far the nose is off frame centre

    // transitions
    this.transitionTime = 0.85;
    this._blend = 1;
    this._blendRate = 0;

    // shake channels — impact (kerbs, contact) vs road (suspension velocity)
    this.roadShake = 0;
    this._suspPrev = null;
    this._suspRate = 0;

    this._states = new Map();
    this._poseA = new Pose();
    this._poseB = new Pose();
    this._pose = new Pose();

    this.tvCameras = circuit ? this._buildTvCameras(circuit) : [];
    this._activeTv = 0;
    this.tvHoldMin = 2.1;
    this.tvHoldMax = 9.0;

    // replay
    this.replay = new ReplayBuffer({ seconds: replaySeconds });
    this.recording = true;
    this.replaying = false;
    this._replayTime = 0;
    this._replayRate = 1;
  }

  /* ---------------------------------------------------------------- config */

  follow(target) { this.target = target; return this; }

  setMode(mode, opts) {
    if (!CAMERA_MODES.includes(mode)) return this;
    if (mode === this.mode) return this;
    // The world feed cuts. Blending a 65-degree chase into a 12-degree long
    // lens reads as a rocket launch, never as a camera change.
    const instant = opts === true || (opts && opts.instant)
      || mode === 'tv' || this.mode === 'tv';
    const dur = (opts && opts.transition) ?? this.transitionTime;
    this.prevMode = this.mode;
    this.mode = mode;
    if (instant || dur <= 0 || !this._states.has(this.prevMode)) {
      this._blend = 1; this._blendRate = 0; this.needsSnap = true;
    } else {
      this._blend = 0;
      this._blendRate = 1 / dur;
    }
    return this;
  }

  cycleMode() {
    const i = CAMERA_MODES.indexOf(this.mode);
    return this.setMode(CAMERA_MODES[(i + 1) % CAMERA_MODES.length]);
  }

  /** Hard cut: kills any in-flight transition and teleports every spring. */
  snap() {
    this.needsSnap = true;
    this._blend = 1;
    this._blendRate = 0;
    for (const s of this._states.values()) s.ready = false;
    return this;
  }

  /** 0..1 impulse — kerb strike, lockup, contact, gear shift. */
  addShake(a) { this.shake = Math.min(1.6, this.shake + a); return this; }

  setBaseFov(f) { this.baseFov = f; return this; }

  /* ---------------------------------------------------------------- replay */

  /**
   * Play the ring buffer back from `offset` seconds ago. The rig substitutes a
   * synthetic follow-target, so every camera mode works on replayed data.
   *
   * RECORDING KEEPS RUNNING while a replay plays back. It has to: the sim is
   * still stepping, and if the recorder pauses (or worse, the buffer is cleared
   * on exit) then the *next* replay has nothing but the handful of frames since
   * the last one — a second "replay that" press showed a third of a second of
   * footage. Playback advances at `rate` and the write head at 1, so the two
   * never collide; `sample()` clamps if the playhead falls off the tail.
   */
  startReplay({ offset = 10, rate = 0.6, mode = null } = {}) {
    if (this.replay.count < 4) return false;
    this._replayTime = Math.max(this.replay.oldest, this.replay.newest - offset);
    this._replayRate = rate;
    this.replaying = true;
    if (mode) this.setMode(mode, { instant: true });
    else this.snap();
    return true;
  }

  /** 0..1 — how far through the recorded window the playhead is. */
  get replayProgress() {
    const d = this.replay.duration;
    if (!this.replaying || d <= 0) return 0;
    return clamp((this._replayTime - this.replay.oldest) / d, 0, 1);
  }

  /** Jump the playhead. `t` is seconds before the newest recorded sample. */
  seekReplay(secondsAgo) {
    this._replayTime = clamp(this.replay.newest - secondsAgo, this.replay.oldest, this.replay.newest);
    this.snap();
    return this;
  }

  setReplayRate(r) { this._replayRate = r; return this; }

  stopReplay() {
    if (!this.replaying) return this;
    this.replaying = false;
    this.recording = true;
    this.snap();
    return this;
  }

  /* ------------------------------------------------------------ tv cameras */

  /**
   * A world-feed camera plan: towers on the outside of every meaningful corner,
   * low "apron" cameras tight to the barrier for the fast stuff, and a long
   * lens looking straight down each big straight.
   */
  _buildTvCameras(circuit) {
    const rng = makeRng(hashSeed('camera/tv-plan'));
    const cams = [];
    const step = circuit.step;
    const n = circuit.samples.length;

    // 1. Corner towers: find local maxima of |curvature|, spaced out.
    const used = [];
    const minGap = 95;
    const cand = [];
    for (let i = 0; i < n; i++) cand.push(i);
    cand.sort((a, b) => Math.abs(circuit.samples[b].curvature) - Math.abs(circuit.samples[a].curvature));
    for (const i of cand) {
      const s = i * step;
      if (Math.abs(circuit.samples[i].curvature) < 1 / 420) break;
      if (used.some((u) => {
        const d = Math.abs(circuit.wrapS(s - u) > circuit.length * 0.5
          ? circuit.wrapS(s - u) - circuit.length : circuit.wrapS(s - u));
        return d < minGap;
      })) continue;
      used.push(s);
      if (used.length >= 14) break;
    }

    for (const s of used) {
      const sm = circuit.sampleAt(s);
      const side = sm.curvature !== 0 ? -Math.sign(sm.curvature) : 1;
      const low = rng() < 0.34;
      const dist = low ? 8.5 + rng() * 4.5 : 17 + rng() * 14;
      // Tower height is what sets the depression angle, and depression angle is
      // what decides whether the shot reads as a race or as a map. A real corner
      // tower is 5–11 m at 25–35 m out, i.e. 9–20 deg down. The old 7.5–15 m
      // gave 24–30 deg and filled three quarters of the frame with tarmac.
      const height = low ? 2.2 + rng() * 1.2 : 5.0 + rng() * 5.2;
      // Sit slightly before the apex so the car comes towards the lens.
      const back = 26 + rng() * 30;
      const at = circuit.sampleAt(circuit.wrapS(s - back));
      const p = new THREE.Vector3().copy(at.position)
        .addScaledVector(at.right, side * (circuit.halfWidth + dist));
      p.y += height;
      cams.push({
        s: circuit.wrapS(s - back), aimS: s, position: p, side,
        kind: low ? 'apron' : 'tower',
        lead: -170 - rng() * 60, trail: 70 + rng() * 60,
        // minFov is what actually decides subject size, and it was the single
        // reason the world feed looked like a webcam: clamped at 10.5 deg, a
        // tower 40 m out holds 13 m of frame and the car is 15 % of it. Race
        // broadcast uses 60–100x box lenses; 2.6 deg vertical (~ a 1000 mm
        // equivalent) is ordinary for a corner camera and is what lets the
        // constant-subject-size solver below actually reach its target.
        seed: rng() * 1000, minFov: low ? 8.0 : 2.6, maxFov: low ? 62 : 40,
      });
    }

    // 2. Straight cameras: long lens on the centreline axis, far down the road.
    for (const z of (circuit.drsZones ?? [])) {
      const at = circuit.sampleAt(circuit.wrapS(z.endS - 12));
      const p = new THREE.Vector3().copy(at.position)
        .addScaledVector(at.right, (rng() < 0.5 ? 1 : -1) * (circuit.halfWidth + 11 + rng() * 8));
      p.y += 5.5 + rng() * 3.5;
      cams.push({
        s: circuit.wrapS(z.endS - 12), aimS: circuit.wrapS(z.endS - 12), position: p,
        side: 1, kind: 'straight',
        lead: -300 - rng() * 90, trail: 45,
        seed: rng() * 1000, minFov: 1.8, maxFov: 34,
      });
    }

    // 3. Backfill so no part of the lap is uncovered.
    const gap = 165;
    for (let s = 0; s < circuit.length; s += gap) {
      const near = cams.some((c) => {
        let d = circuit.wrapS(c.s - s);
        if (d > circuit.length * 0.5) d -= circuit.length;
        return Math.abs(d) < gap * 0.62;
      });
      if (near) continue;
      const sm = circuit.sampleAt(s);
      const side = sm.curvature !== 0 ? -Math.sign(sm.curvature) : (cams.length % 2 ? 1 : -1);
      const p = new THREE.Vector3().copy(sm.position)
        .addScaledVector(sm.right, side * (circuit.halfWidth + 15 + rng() * 12));
      p.y += 4.5 + rng() * 4.5;
      cams.push({
        s, aimS: circuit.wrapS(s + 55), position: p, side, kind: 'tower',
        lead: -180 - rng() * 50, trail: 80,
        seed: rng() * 1000, minFov: 2.6, maxFov: 42,
      });
    }

    cams.sort((a, b) => a.s - b.s);
    return cams;
  }

  /**
   * `circuit.sampleAt` allocates a fresh Sample unless it is handed an `out`, and
   * this is called from a per-frame solver. Reuse one, lazily shaped by the
   * circuit's own first return value so we never hard-code its field list.
   */
  _sample(s) {
    if (!this._sampleOut) this._sampleOut = this.circuit.sampleAt(s);
    return this.circuit.sampleAt(s, this._sampleOut);
  }

  /** Signed metres from camera `c` to the car (negative = car approaching). */
  _tvRel(c, s) {
    let d = this.circuit.wrapS(s - c.s);
    if (d > this.circuit.length * 0.5) d -= this.circuit.length;
    return d;
  }

  _tvScore(c, s, carPos) {
    const rel = this._tvRel(c, s);
    if (rel < c.lead || rel > c.trail) return -1;
    const d = c.position.distanceTo(carPos);
    if (d < 9 || d > 340) return -1;
    // Best when the car is still coming toward the lens and 40–140 m out.
    const approach = rel < 0 ? 1 : 0.35;
    const near = 1 - clamp(Math.abs(d - 62) / 130, 0, 1);
    // Depression angle: a world feed wants some sky in the top of frame. Almost
    // straight down (a crane over the apex) reads as a map, not a race.
    const elev = Math.asin(clamp((c.position.y - carPos.y) / d, -1, 1));
    const elevOk = 1 - clamp((elev - 0.13) / 0.30, 0, 1) * 0.92;
    const kindBias = c.kind === 'apron' ? 0.9 : c.kind === 'straight' ? 1.05 : 1;
    return (0.55 + near * 0.9) * approach * kindBias * elevOk;
  }

  /* ---------------------------------------------------------------- update */

  _state(mode) {
    let s = this._states.get(mode);
    if (!s) { s = new SolverState(this.baseFov); this._states.set(mode, s); }
    return s;
  }

  update(dt) {
    let t = this.target;
    if (!t) return;
    dt = Math.min(Math.max(dt, 1e-4), 0.1);
    this.time += dt;

    // Record the LIVE state even while replaying — see startReplay().
    if (this.recording) this.replay.push(dt, t);
    if (this.replaying) {
      this._replayTime += dt * this._replayRate;
      if (this._replayTime > this.replay.newest) this._replayTime = this.replay.newest;
      if (this._replayTime < this.replay.oldest) this._replayTime = this.replay.oldest;
      t = this.replay.sample(this._replayTime);
    }
    this._live = t;

    this._carFrame(t);
    this._roadNoise(t, dt);

    const snap = this.needsSnap;
    const A = this._solve(this.mode, t, dt, snap, this._poseA);

    if (this._blend < 1) {
      this._blend = Math.min(1, this._blend + this._blendRate * dt);
      const B = this._solve(this.prevMode, t, dt, false, this._poseB);
      const u = smootherstep(this._blend);
      this._pose.copy(B);
      this._pose.pos.lerp(A.pos, u);
      this._pose.look.lerp(A.look, u);
      this._pose.fov = lerp(B.fov, A.fov, u);
      this._pose.roll = lerp(B.roll, A.roll, u);
      this._pose.focus = lerp(B.focus, A.focus, u);
      this._pose.shakeScale = lerp(B.shakeScale, A.shakeScale, u);
    } else {
      this._pose.copy(A);
    }

    this.needsSnap = false;
    this._apply(this._pose, t, dt);
    this._updateInterior(t, dt);
  }

  /**
   * The cockpit prop. Built on first use, so a game that never selects `cockpit`
   * pays nothing for it, and added to the scene the circuit is already in — the
   * rig is handed a camera, not a scene, and reaching up through the circuit
   * group is the only documented object that is guaranteed to be parented.
   */
  _updateInterior(t, dt) {
    const K = this.cockpit;
    // How much of the frame the cockpit solver currently owns.
    const wIn = this.mode === 'cockpit' ? (this._blend < 1 ? this._blend : 1) : 0;
    const wOut = this.prevMode === 'cockpit' && this._blend < 1 ? 1 - this._blend : 0;
    const w = Math.max(wIn, wOut);

    if (!K.interior || w <= 0.001) {
      if (this.interior) { this.interior.group.visible = false; this.interior.visor.visible = false; }
      return;
    }
    if (!this.interior) {
      let root = this.circuit && this.circuit.group ? this.circuit.group : this.camera;
      while (root.parent) root = root.parent;
      if (!root.isScene) return;              // nothing to attach to yet
      this.interior = new CockpitInterior();
      this._scene = root;
      root.add(this.interior.group);
      root.add(this.interior.visor);
    }
    const it = this.interior;
    it.group.visible = true;
    it.setEye(this.mounts.cockpitEye);
    // Steering first, THEN the pose: `pose()` ends with a forced
    // `updateMatrixWorld`, so the wheel's new angle and the arm aim it drives are
    // already in their local matrices when the world transforms are rebuilt.
    it.update(dt, t.telemetry, t.telemetry ? t.telemetry.steer : 0);
    it.pose(t.position, t.quaternion);
    this.camera.updateMatrixWorld(true);
    it.poseVisor(this.camera, K.visor * w);
    // The mirrors are a live pass of this same scene — see `renderMirror`. It
    // runs HERE, inside the update, so the target is filled before the frame's
    // own render samples it.
    if (this._scene) it.renderMirror(this._scene, t.position, t.quaternion);
  }

  /** Release the cockpit prop. The rig itself owns no other GPU resources. */
  dispose() {
    if (this.interior) {
      this.interior.group.removeFromParent();
      this.interior.visor.removeFromParent();
      this.interior.dispose();
      this.interior = null;
    }
    return this;
  }

  _carFrame(t) {
    _fwd.set(0, 0, -1).applyQuaternion(t.quaternion);
    _right.set(1, 0, 0).applyQuaternion(t.quaternion);
    _carUp.set(0, 1, 0).applyQuaternion(t.quaternion);
    this._carYaw = Math.atan2(-_fwd.x, -_fwd.z);
    this._carPitch = Math.asin(clamp(-_fwd.y, -1, 1));
    // Roll about the car's own forward axis: +ve = rolled onto its right side.
    this._carRoll = Math.atan2(-_right.y, Math.max(1e-4, _carUp.y));
  }

  /**
   * Road excitation, measured from suspension VELOCITY rather than position, so
   * a car sitting compressed under load does not shake and a kerb strike does.
   * This is the channel that is deliberately decoupled from `addShake()`.
   */
  _roadNoise(t, dt) {
    const susp = t.telemetry && t.telemetry.suspension;
    if (susp && susp.length) {
      if (!this._suspPrev || this._suspPrev.length !== susp.length) {
        this._suspPrev = new Float32Array(susp.length);
        for (let i = 0; i < susp.length; i++) this._suspPrev[i] = susp[i];
      }
      let rate = 0;
      for (let i = 0; i < susp.length; i++) {
        rate += Math.abs(susp[i] - this._suspPrev[i]);
        this._suspPrev[i] = susp[i];
      }
      rate /= susp.length * Math.max(dt, 1e-4);
      // 0 at a smooth surface, 1 at a kerb.
      this._suspRate = lerp(this._suspRate, clamp(rate / 1.5, 0, 1), 1 - Math.exp(-dt * 14));
    } else {
      this._suspRate *= Math.exp(-dt * 4);
    }
    const speedN = clamp((t.speed ?? 0) / this.topSpeed, 0, 1);
    const off = (t.telemetry && t.telemetry.onTrack === false) ? 1 : 0;
    const excite = this._suspRate * 0.85 + off * 0.55 + speedN * speedN * 0.16;
    this.roadShake = lerp(this.roadShake, clamp(excite, 0, 1.2), 1 - Math.exp(-dt * 9));
    this.shake *= Math.exp(-dt * 5.2);
  }

  /* ---------------------------------------------------------------- solvers */

  _solve(mode, t, dt, snap, out) {
    const st = this._state(mode);
    st.t += dt;
    const first = snap || !st.ready;
    switch (mode) {
      case 'cockpit': this._solveOnboard(st, t, dt, first, out, 'cockpit'); break;
      case 'halo': this._solveOnboard(st, t, dt, first, out, 'halo'); break;
      case 'tcam': this._solveOnboard(st, t, dt, first, out, 'tcam'); break;
      case 'bumper': this._solveOnboard(st, t, dt, first, out, 'bumper'); break;
      case 'tv': this._solveTv(st, t, dt, first, out); break;
      case 'hero': this._solveHero(st, t, dt, first, out); break;
      case 'wide': this._solveWide(st, t, dt, first, out); break;
      default: this._solveChase(st, t, dt, first, out); break;
    }
    st.ready = true;
    return out;
  }

  /** Curvature `d` metres down the road, +ve = the track turns right. */
  _curvatureAhead(t, d) {
    const c = this.circuit;
    if (!c || !t.telemetry) return 0;
    const s = t.telemetry.trackS;
    if (s === undefined || s === null) return 0;
    return c.curvatureAt(c.wrapS(s + d));
  }

  /* ------------------------------------------------------------------ chase */

  _solveChase(st, t, dt, first, out) {
    const speed = t.speed ?? 0;
    const speedN = clamp(speed / this.topSpeed, 0, 1);
    const carYaw = this._carYaw;

    // --- follow basis -------------------------------------------------------
    // Spring the yaw, not the position. Feed-forward the car's own yaw rate so
    // a constant-radius corner produces zero lag and only turn-IN swings wide.
    const yawRate = first ? 0 : wrapAngle(carYaw - st.prevYaw) / dt;
    st.prevYaw = carYaw;
    const k = 34 - speedN * 10;              // looser at speed = more sweep
    if (first) st.yaw.set(carYaw, yawRate);
    else st.yaw.step(carYaw, k, dt, yawRate * 0.85, 0.92);
    // Swing limit. It is a fraction of the half-horizontal-FOV, not a constant:
    // on the long lens this rig now uses, 11 deg of sweep is a third of the
    // frame and puts the car on the edge.
    const swing = this.chase.swing;
    st.yaw.x = carYaw + clamp(wrapAngle(st.yaw.x - carYaw), -swing, swing);

    // Corner look-ahead: aim the whole rig slightly into the coming corner.
    const aheadD = 26 + speedN * 46;
    const kA = this._curvatureAhead(t, aheadD * 0.62);
    const lead = clamp(-kA * aheadD * 0.55, -0.30, 0.30);
    if (first) st.aux.set(lead); else st.aux.step(lead, 9, dt, 0, 1);

    const basisYaw = st.yaw.x + st.aux.x * 0.55;
    yawDir(st.yaw.x, _basis);
    yawRight(st.yaw.x, _basisR);

    // --- placement ----------------------------------------------------------
    const C = this.chase;
    const back = C.back + speedN * C.backSpeed;
    const height = C.height + speedN * C.heightSpeed;
    // Follow the road's height, not the car's, so kerbs and crests do not
    // launch the camera; blend towards the car under big elevation change.
    _tmp.copy(t.position).addScaledVector(_basis, -back);
    let baseY = t.position.y;
    if (this.circuit && this.circuit.surfaceHeightAt) {
      const gy = this.circuit.surfaceHeightAt(_tmp.x, _tmp.z);
      // Over a crest the ground behind is far below the car; never let that
      // drop the lens under the car, or you end up filming the gearbox.
      if (Number.isFinite(gy)) {
        baseY = clamp(lerp(t.position.y, gy, 0.55), t.position.y - 0.85, t.position.y + 1.4);
        baseY = Math.max(baseY, gy + 0.25);
      }
    }
    _pos.set(_tmp.x, baseY + height, _tmp.z);
    // A little cross-corner offset, so the shot is not a dead-centre rear view.
    //
    // MIND WHAT THIS COSTS THE MOTION BLUR. `kA` is POSITIVE for a right-hand
    // corner and `_basisR` is the camera's right, so this pushes the lens toward
    // the INSIDE of the turn (the comment here used to claim the opposite; the
    // measured lateral, tools/_c5curv.mjs, is +0.82 m relative to the car through
    // a k = +0.0047 right-hander). Either sign is a legitimate broadcast framing
    // — but whichever way it goes, the rig then AIMS BACK AT THE CAR, and that
    // rotates the lens away from the direction the camera is actually travelling.
    // The focus of expansion moves off-axis by roughly atan(offset / back), and
    // every motion streak in the frame radiates from THERE, not from the road's
    // vanishing point.
    //
    // At 0.90 m over a 6.4 m boom that is ~8 deg, and the chase lens only has
    // 29 deg of HALF-horizontal-FOV: measured (tools/_c5foe.mjs) the FOE sat
    // 184 px right of centre on a 1600 px frame — 23 % of the half-width, 7.3 deg
    // — and the near-field streaks on the far side of the frame therefore ran
    // flatter than the road's own perspective says they should. The round-5
    // review read that as "the blur does not radiate from the focus of expansion".
    // Flipping the sign only mirrors it (measured: FOE -246 px, and the framing
    // gets worse); zeroing it centres the FOE at -31 px but leaves a dead-centre
    // rear view. 0.45 m lands the FOE at 77 px, 9.6 % of the half-width, and the
    // frame keeps the cross-corner read (shots/_c5-out45.png vs _c5-out0.png).
    _pos.addScaledVector(_basisR, clamp(kA * 260, -C.outside, C.outside));
    // Pitch with the road so a crest does not point the lens at the sky. Kept
    // SMALL (it was 0.30): the aim solver below already holds the horizon, and on
    // a downhill this term lifted the lens 0.30 m, which forced the floor
    // constraint to bind and dragged the horizon down to 0.29 of frame height.
    _pos.y += clamp(-this._carPitch, -0.35, 0.35) * back * 0.16;

    // Residual spring: soft vertically (heave over kerbs), stiff horizontally.
    if (first) st.body.set(_pos);
    else {
      _tmp2.copy(_pos).sub(st.prevLook);   // reuse prevLook as prev desired pos
      _tmp2.divideScalar(dt);
      st.body.step(_pos, 260, 46, dt, _tmp2);
    }
    st.prevLook.copy(_pos);
    out.pos.copy(st.body.x);

    // --- lens ---------------------------------------------------------------
    // The lens has to be chosen BEFORE the aim, because every framing offset
    // below is a fraction of the half-FOV it produces (CONTRACT §5).
    out.fov = this._fovStep(st, C.fov + speedN * C.fovSpeed, first, 7, dt);
    const tanV = Math.tan(THREE.MathUtils.degToRad(out.fov) * 0.5);

    // --- horizontal aim -----------------------------------------------------
    // Look at the car, then blend a fraction of the way toward a point down the
    // road. Blending DIRECTIONS (not points) bounds how far off-centre the car
    // can ever get, which is what keeps the framing honest in a hairpin. This is
    // a YAW-ONLY blend: the look-ahead used to carry a vertical term as well,
    // and since the road direction is level while the car sits below the lens,
    // that term always pitched the lens further DOWN — the exact contribution
    // that walked the diffuser off the bottom of the frame.
    _tmp.copy(t.position)
      .addScaledVector(_fwd, this.mounts.chaseFocus.z)
      .addScaledVector(_right, this.mounts.chaseFocus.x);
    _tmp.y += this.mounts.chaseFocus.y;
    _dirA.copy(_tmp).sub(out.pos);
    const carDist = _dirA.length() || 1;
    _dirA.y = 0;
    if (_dirA.lengthSq() < 1e-8) _dirA.copy(_basis); else _dirA.normalize();

    yawDir(basisYaw, _tmp2);
    const w = C.lookAhead + speedN * C.lookAheadSpeed;
    _dirB.copy(_dirA).multiplyScalar(1 - w).addScaledVector(_tmp2, w);
    _dirB.y = 0;
    if (_dirB.lengthSq() < 1e-8) _dirB.copy(_basis); else _dirB.normalize();

    // --- vertical framing: a target plus two hard constraints ---------------
    // The horizon sits at ndc y = tan(depression) / tan(halfV) — exact, and
    // independent of distance — so the depression that puts it at a given
    // fraction of frame height is closed form.
    //
    // A landmark at elevation `el` lands at ndc y = tan(el + down) / tan(halfV),
    // so the depression that puts it at a chosen fraction of frame height is
    // `atan(ndc * tanV) - el` for either bound. Ceiling first, floor second, so
    // the floor always wins a conflict.
    let down = Math.atan((1 - 2 * C.horizon) * tanV);
    // Ceiling: the airbox crown may not climb above `ceilFrac`.
    down = Math.min(down, Math.atan((1 - 2 * C.ceilFrac) * tanV)
      - this._frameAngle(t, out.pos, _dirB, 0, C.ceilY));
    // Floor: the car's GROUND LINE — the tarmac under the diffuser, where the
    // contact patches and the contact shadow live — may not fall below
    // `floorFrac`. This is the constraint the review was asking for and it is
    // the one that must never yield: lose it and the car floats.
    down = Math.max(down, Math.atan((1 - 2 * C.floorFrac) * tanV)
      - this._frameAngle(t, out.pos, _dirB, C.floorZ, null));
    down = clamp(down, -C.maxPitch, C.maxPitch);
    if (first) st.pitch.set(down); else st.pitch.step(down, 90, dt, 0, 1);
    down = st.pitch.x;

    _dirC.copy(_dirB).multiplyScalar(Math.cos(down));
    _dirC.y = -Math.sin(down);

    _look.copy(out.pos).addScaledVector(_dirC, carDist + 14 + speedN * 22);
    if (first) st.lookS.set(_look);
    else st.lookS.step(_look, 150, 150, dt, null);
    out.look.copy(st.lookS.x);

    out.roll = -clamp(t.telemetry?.gLat ?? 0, -5, 5) * C.rollPerG - this._carRoll * 0.25;
    out.focus = carDist;
    out.up.set(0, 1, 0);
    out.shakeScale = 0.85;
  }

  /**
   * Elevation of a car-referenced framing landmark above the horizontal, as seen
   * from `pos` looking along the horizontal unit `axis`. Positive = above.
   *
   * `localZ` is a car-local +Z (backward) station; `localY` a car-local height.
   * Pass `localY = null` for a GROUND reference — the road surface under that
   * station, which is what the contact patches and the contact shadow sit on and
   * therefore the only honest floor for the framing constraint. Distance is
   * measured along the aim axis, not as a euclidean range, so the result is the
   * angle the projection actually uses.
   */
  _frameAngle(t, pos, axis, localZ, localY) {
    _tmp2.copy(t.position).addScaledVector(_fwd, -localZ);
    if (localY === null) {
      let gy = t.position.y;
      if (this.circuit && this.circuit.surfaceHeightAt) {
        const g = this.circuit.surfaceHeightAt(_tmp2.x, _tmp2.z);
        if (Number.isFinite(g)) gy = g;
      }
      _tmp2.y = gy;
    } else {
      _tmp2.addScaledVector(_carUp, localY);
    }
    const dy = _tmp2.y - pos.y;
    _tmp2.sub(pos); _tmp2.y = 0;
    return Math.atan2(dy, Math.max(0.5, _tmp2.dot(axis)));
  }

  /* --------------------------------------------------------------- onboards */

  _solveOnboard(st, t, dt, first, out, kind) {
    const speed = t.speed ?? 0;
    const speedN = clamp(speed / this.topSpeed, 0, 1);
    const gLat = clamp(t.telemetry?.gLat ?? 0, -6, 6);
    const gLong = clamp(t.telemetry?.gLong ?? 0, -6, 6);

    const mount = kind === 'cockpit' ? this.mounts.cockpitEye
      : kind === 'halo' ? this.mounts.haloCam
        : kind === 'tcam' ? this.mounts.tcam : this.mounts.bumper;

    _pos.copy(t.position)
      .addScaledVector(_right, mount.x)
      .addScaledVector(_carUp, mount.y)
      .addScaledVector(_fwd, -mount.z);

    let yawOff = 0, pitchOff = 0, roll = 0, fov;

    if (kind === 'cockpit') {
      // --- g-force head movement -------------------------------------------
      // The helmet is a mass on a neck: it lags the chassis, so it is thrown
      // OUTWARD in a corner and forward under braking.
      _tmp.set(0, 0, 0)
        .addScaledVector(_right, clamp(-gLat * 0.0135, -0.055, 0.055))
        .addScaledVector(_fwd, clamp(gLong * 0.0125, -0.05, 0.05));
      _tmp.y += -Math.abs(gLat) * 0.004;
      if (first) st.head.set(_tmp); else st.head.step(_tmp, 90, 90, dt, null);
      _pos.add(st.head.x);

      // --- helmet looks into the corner -------------------------------------
      const kA = this._curvatureAhead(t, 34 + speedN * 34);
      const steer = t.telemetry?.steer ?? 0;
      const K = this.cockpit;
      const want = clamp((-kA * 62 - steer * 0.10) * (K.lookInto / 0.42), -0.46, 0.46);
      yawOff = first ? st.aux.set(want) : st.aux.step(want, 26, dt, 0, 1);
      // A REAL cockpit is pitched DOWN, not level: the wheel rim, the dash screen
      // and the driver's gloves all live 20–35 deg below the eyeline, and a view
      // that does not show them is not a cockpit view, it is an onboard.
      pitchOff = K.pitch;
      // Drivers keep their eyes level: counter-roll most of the chassis roll,
      // then add a touch of lateral-g head tilt.
      roll = -this._carRoll * 0.40 - gLat * 0.0085;
      fov = K.fov + speedN * K.fovSpeed;
      out.shakeScale = 1.35;
    } else if (kind === 'halo') {
      // The broadcast onboard: level, behind the hoop, no head movement.
      yawOff = 0;
      pitchOff = -0.030;
      roll = -this._carRoll * 0.10;
      fov = 51 + speedN * 9;
      out.shakeScale = 0.95;
    } else if (kind === 'tcam') {
      yawOff = 0;
      pitchOff = -0.030;
      roll = -this._carRoll * 0.10;
      fov = 51 + speedN * 9;
      out.shakeScale = 0.95;
    } else {
      yawOff = 0;
      // A nose cam 0.42 m off the deck wants a level-to-slightly-down line, not
      // the +0.7 deg it had: tipped up, two thirds of the frame is sky.
      pitchOff = -0.055;
      roll = 0;
      fov = 58 + speedN * 8;
      out.shakeScale = 1.6;
    }

    // Aim in the car's own frame so the horizon banks with the chassis.
    _dirA.copy(_fwd)
      .addScaledVector(_right, Math.tan(yawOff))
      .addScaledVector(_carUp, Math.tan(pitchOff))
      .normalize();

    out.pos.copy(_pos);
    out.look.copy(_pos).addScaledVector(_dirA, 60);
    out.fov = this._fovStep(st, fov, first, 6, dt);
    out.roll = roll;
    out.focus = kind === 'bumper' ? 12 : 22;
    // Onboards are bolted to the tub: the horizon banks with the chassis. The
    // driver's neck then takes a fraction of it back out (see `roll` above).
    out.up.copy(_carUp);
  }

  /* --------------------------------------------------------------------- tv */

  _solveTv(st, t, dt, first, out) {
    const c = this.circuit;
    const cams = this.tvCameras;
    if (!cams.length || !c) { this._solveChase(st, t, dt, first, out); return; }

    const s = t.telemetry?.trackS ?? 0;
    _tmp.copy(t.position); _tmp.y += 0.55;

    // --- handoff ------------------------------------------------------------
    // A world feed cuts, it never flies. The incumbent gets a scoring bonus and
    // a minimum dwell; it is dropped the moment the car leaves its arc.
    st.dwell += dt;
    if (st.i >= cams.length) st.i = 0;
    const curScore = this._tvScore(cams[st.i], s, _tmp);
    let best = st.i;
    let bestScore = curScore >= 0 && st.dwell < this.tvHoldMax ? curScore + 0.30 : -Infinity;
    if (first || curScore < 0 || st.dwell >= this.tvHoldMin) {
      for (let i = 0; i < cams.length; i++) {
        if (i === st.i) continue;
        const sc = this._tvScore(cams[i], s, _tmp);
        if (sc > bestScore) { bestScore = sc; best = i; }
      }
    }
    // Nothing has the car in shot (pit lane, off-track excursion): fall back to
    // whichever tower it is physically closest to.
    if (bestScore === -Infinity && curScore < 0) {
      let bd = Infinity;
      for (let i = 0; i < cams.length; i++) {
        const d = cams[i].position.distanceToSquared(_tmp);
        if (d < bd) { bd = d; best = i; }
      }
    }
    if (best !== st.i) { st.i = best; st.dwell = 0; first = true; }
    this._activeTv = st.i;
    const cam = cams[st.i];

    // --- pan / tilt with operator lag --------------------------------------
    _dirA.copy(_tmp).sub(cam.position);
    const dist = Math.max(2, _dirA.length());
    const aimYaw = Math.atan2(-_dirA.x, -_dirA.z);
    const aimPitch = Math.asin(clamp(_dirA.y / _dirA.length(), -1, 1));

    const yawRate = first ? 0 : wrapAngle(aimYaw - st.prevAim) / dt;
    const pitchRate = first ? 0 : (aimPitch - st.prevPitchAim) / dt;
    st.prevAim = aimYaw; st.prevPitchAim = aimPitch;

    // Slightly under-damped: the pan settles with one small overshoot, which is
    // the single most recognisable thing about a hand-operated long lens.
    const panK = 165;
    if (first) { st.yaw.set(aimYaw, yawRate); st.pitch.set(aimPitch, pitchRate); }
    else {
      st.yaw.step(aimYaw, panK, dt, yawRate * 0.93, 0.82);
      st.pitch.step(aimPitch, panK * 0.8, dt, pitchRate * 0.93, 0.86);
    }

    // --- zoom ---------------------------------------------------------------
    // Constant subject size. THE SUBJECT IS 5.5 m LONG, NOT 2 m WIDE: a corner
    // tower sees the car broadside or three-quarter, so the extent that has to
    // fit is the wheelbase-plus-wings, and sizing the span off the car's WIDTH
    // is what cropped the front wing off the edge of every `tv` frame. Hold
    // ~10 m of horizontal frame up close (car ~55 % of width) opening to ~21 m
    // at 150 m (~26 %) — broadcast numbers, and enough tarmac left in shot for
    // the car's own shadow to land on. Let the target breathe so the operator is
    // not a robot.
    const spanH = 14.0 + clamp((dist - 60) * 0.075, -4.0, 14);
    const spanV = spanH / 1.778;
    const sd = cam.seed;
    let want = THREE.MathUtils.radToDeg(2 * Math.atan(spanV * 0.5 / dist));
    want = clamp(want, cam.minFov, cam.maxFov);
    want *= 1 + fbm1(st.t * 0.42 + sd * 0.5) * 0.012;
    out.fov = first ? st.fovS.set(want) : st.fovS.step(want, 26, dt, 0, 1);

    // --- framing bias (must be FOV-relative, never metric) ------------------
    // Half-angles of the frame we just chose. Every framing offset below is a
    // fraction of these, so a 6 deg long lens and a 40 deg wide shot compose
    // identically. Doing it in metres — "lead the car by v * 0.06 s" — is how
    // you end up with the subject dead centre up close and off the edge at 150 m.
    const halfV = THREE.MathUtils.degToRad(out.fov) * 0.5;
    const halfH = Math.atan(Math.tan(halfV) * 1.778);
    // Headroom: park the car a touch below centre so the shot keeps its horizon.
    // Scaled by depression angle — a low apron camera needs none.
    const elev = Math.asin(clamp((cam.position.y - _tmp.y) / dist, -1, 1));
    const headroom = clamp(elev * 0.55, 0, 0.17) * halfV;
    // Lead room: the operator leaves space in the direction of travel, which
    // means aiming AHEAD of the car so the car sits on the trailing side.
    yawRight(st.yaw.x, _tmp2);
    const lat = clamp(_fwd.dot(_tmp2), -1, 1);
    const leadRoom = -0.16 * halfH * lat;

    // --- hand-held float ----------------------------------------------------
    const jitter = clamp(0.0012 + dist * 0.000010, 0, 0.004);
    const ny = fbm1(st.t * 0.85 + sd) * jitter + fbm1(st.t * 3.9 + sd * 1.7) * jitter * 0.30;
    const np = fbm1(st.t * 0.72 + sd + 40) * jitter * 0.8 + fbm1(st.t * 4.3 + sd) * jitter * 0.25;

    const yaw = st.yaw.x + ny + leadRoom;
    const pitch = clamp(st.pitch.x + np + headroom, -1.35, 1.0);

    yawDir(yaw, _dirB).multiplyScalar(Math.cos(pitch));
    _dirB.y = Math.sin(pitch);

    out.pos.copy(cam.position);
    out.look.copy(cam.position).addScaledVector(_dirB, dist);

    out.roll = fbm1(st.t * 0.55 + sd + 90) * 0.0045;
    out.focus = dist;
    out.up.set(0, 1, 0);
    out.shakeScale = 0.0;    // a tripod does not get the car's road shake
  }

  /* ------------------------------------------------------------------- hero */

  _solveHero(st, t, dt, first, out) {
    this.orbitAngle += dt * this.orbitSpeed;
    const a = this.orbitAngle + this.orbitAngleTrim;

    // A slow dolly: the radius and height breathe out of phase with the orbit
    // so the parallax reads even on a near-static shot.
    const breathe = this.orbitDolly * Math.sin(a * 0.63 + 0.4);
    const r = this.orbitRadius + breathe * 0.9;
    const h = this.orbitHeight + Math.sin(a * 0.81 + 1.1) * 0.16 * this.orbitDolly;

    // Orbit in the CAR's frame: a given angle always frames the same 3/4 view.
    // a = 0 -> the car's right flank, a = PI/2 -> dead ahead of the nose.
    _pos.copy(t.position)
      .addScaledVector(_right, Math.cos(a) * r)
      .addScaledVector(_fwd, Math.sin(a) * r);
    let gy = t.position.y;
    if (this.circuit && this.circuit.surfaceHeightAt) {
      const y = this.circuit.surfaceHeightAt(_pos.x, _pos.z);
      if (Number.isFinite(y)) gy = y;
    }
    _pos.y = gy + h;

    // Aim ahead of the CoG so the car sits back from centre with running room in
    // front of the nose, and at the car's own VISUAL centre in height. Aiming
    // above the airbox (the obvious "look at the car" choice) tips the lens up
    // and shoves the car into the bottom third under a half-frame of empty sky.
    const lead = this.orbitLead * r;
    _look.copy(t.position)
      .addScaledVector(_fwd, 0.35 + lead * 0.55)
      .addScaledVector(_right, -Math.sin(a) * lead * 0.9);
    _look.y = t.position.y + this.orbitAim;

    out.pos.copy(_pos);
    out.look.copy(_look);
    out.fov = first ? st.fovS.set(this.orbitFov) : st.fovS.step(this.orbitFov, 12, dt, 0, 1);
    out.roll = 0;
    out.focus = _pos.distanceTo(t.position);
    out.up.set(0, 1, 0);
    out.shakeScale = 0;
  }

  /* ------------------------------------------------------------------- wide */

  _solveWide(st, t, dt, first, out) {
    const c = this.circuit;
    const speedN = clamp((t.speed ?? 0) / this.topSpeed, 0, 1);
    if (!c || !t.telemetry) {
      _pos.copy(t.position).addScaledVector(_fwd, -60).addScaledVector(_right, 40);
      _pos.y += 38;
      out.pos.copy(_pos);
      out.look.copy(t.position);
      out.fov = 34; out.roll = 0; out.focus = 90; out.up.set(0, 1, 0);
      out.shakeScale = 0;
      return;
    }
    // Anchor to the circuit, not the car: a helicopter flying station off the
    // outside of the corner while the car sweeps through the frame.
    //
    // TWO THINGS THIS GETS WRONG IF YOU ARE NOT CAREFUL.
    //  1. LAG. The anchor travels with the car at ~80 m/s. A critically damped
    //     spring tracking a ramp settles 2v/omega BEHIND it: at the old k = 1.6
    //     that is 127 m, so the "helicopter" ended up somewhere near the car,
    //     steeply above it, and the shot read as a map with no horizon at all.
    //     Both the body and the aim now feed forward their own anchor velocity.
    //  2. DEPRESSION vs LENS. A horizon only appears if the depression angle is
    //     smaller than the half vertical FOV. 24 m up at 60 m out is 17 deg, so
    //     the lens must stay wider than ~36 deg — which is why the height came
    //     down from 34 m rather than the FOV going up.
    const s = t.telemetry.trackS ?? 0;
    const sm = this._sample(c.wrapS(s + 42));
    const side = sm.curvature !== 0 ? -Math.sign(sm.curvature) : 1;
    _pos.copy(sm.position)
      .addScaledVector(sm.right, side * (c.halfWidth + 52));
    _pos.y += 16;
    if (first) { st.body.set(_pos); st.prevLook.copy(_pos); }
    else {
      _tmp2.copy(_pos).sub(st.prevLook).divideScalar(dt);
      st.body.step(_pos, 5.5, 5.5, dt, _tmp2);
    }
    st.prevLook.copy(_pos);
    out.pos.copy(st.body.x);

    _look.copy(t.position).addScaledVector(_fwd, 14 + speedN * 18);
    _look.y += 1.6;
    if (first) { st.lookS.set(_look); st.prevAimPos.copy(_look); }
    else {
      _tmp2.copy(_look).sub(st.prevAimPos).divideScalar(dt);
      st.lookS.step(_look, 30, 30, dt, _tmp2);
    }
    st.prevAimPos.copy(_look);
    out.look.copy(st.lookS.x);

    const dist = out.pos.distanceTo(t.position);
    const want = clamp(THREE.MathUtils.radToDeg(2 * Math.atan(26 / dist)), 21, 42);
    out.fov = first ? st.fovS.set(want) : st.fovS.step(want, 8, dt, 0, 1);
    out.roll = 0;
    out.focus = dist;
    out.up.set(0, 1, 0);
    out.shakeScale = 0;
  }

  _fovStep(st, want, first, k, dt) {
    return first ? st.fovS.set(want) : st.fovS.step(want, k, dt, 0, 1);
  }

  /* ---------------------------------------------------------------- compose */

  _apply(p, t, dt) {
    this.fov = p.fov;

    this.velocity.subVectors(p.pos, this.position).divideScalar(Math.max(dt, 1e-4));
    this.lookVelocity.subVectors(p.look, this.lookAt).divideScalar(Math.max(dt, 1e-4));
    this.position.copy(p.pos);
    this.lookAt.copy(p.look);
    this.focusDistance = p.focus;

    // ---- shake -------------------------------------------------------------
    // Two independent channels: `shake` is discrete impact energy, `roadShake`
    // is continuous surface excitation. They use different frequency sets so
    // they never beat against each other.
    const sc = p.shakeScale;
    const impact = this.shake * sc;
    const road = this.roadShake * sc;
    const T = this.time;
    const ix = fbm1(T * 21.0) * impact;
    const iy = fbm1(T * 18.3 + 7.7) * impact;
    const iz = fbm1(T * 15.1 + 3.1) * impact;
    const rx = (fbm1(T * 9.3 + 41.0) * 0.7 + fbm1(T * 27.7) * 0.3) * road;
    const ry = (fbm1(T * 11.7 + 63.0) * 0.7 + fbm1(T * 31.3) * 0.3) * road;

    const posAmp = 0.028;
    const rotAmp = 0.0075;

    _m.lookAt(this.position, this.lookAt, p.up);
    _q.setFromRotationMatrix(_m);

    this.camera.position.copy(this.position);
    this.camera.quaternion.copy(_q);
    // Positional shake in the camera's own frame keeps it readable at any FOV.
    this.camera.translateX((ix * 0.9 + rx * 0.5) * posAmp);
    this.camera.translateY((iy * 0.9 + ry * 0.5) * posAmp);
    this.camera.translateZ(iz * posAmp * 0.5);

    this.roll = lerp(this.roll, p.roll, 1 - Math.exp(-dt * 9));
    this.camera.rotateX((iy * 1.1 + ry) * rotAmp);
    this.camera.rotateY((ix * 1.1 + rx) * rotAmp);
    this.camera.rotateZ(this.roll + (iz * 0.6 + rx * 0.4) * rotAmp * 1.4);

    if (Math.abs(this.camera.fov - this.fov) > 0.005) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  cockpit interior                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The thing that makes `cockpit` a cockpit view instead of a helmet-height
 * onboard: a steering wheel with a shift-light strip and a dash display, gloved
 * hands and forearms on the rim, two mirrors, and the helmet aperture cutting
 * the top of frame.
 *
 * WHY IT LIVES IN THE CAMERA MODULE
 *   None of it exists on the shared chassis geometry — `car/chassis.js` caches
 *   ONE body geometry for all twenty cars, and a wheel that has to rotate with
 *   the driver's steering input plus a canvas display that has to show the
 *   player's own telemetry cannot be part of a shared, merged, static bucket.
 *   It is also only ever seen by one car from one camera, so paying for it on
 *   twenty would be absurd. It is therefore a camera-mode prop: built once,
 *   posed from the follow target's rigid transform, and shown only while the
 *   cockpit solver owns the frame.
 *
 * EVERYTHING IS AUTHORED AGAINST `MOUNTS.cockpitEye`
 *   The eye is at (0, 0.800, -0.232) and the near plane is 0.25 m, which is a
 *   tight envelope: the rim top sits 8 cm below the eyeline at 46 cm range and
 *   the mirrors are pushed forward to z -0.70 so they fall inside the horizontal
 *   half-FOV instead of 20 deg outside it. Move the eye and re-check all four:
 *   rim top, grips, mirror azimuth, screen legibility.
 *
 * THE MIRRORS ARE A CHEAT AND ARE MEANT TO BE
 *   Real F1 mirrors sit at x ±0.574 (`chassis.buildMirrors`), which from the
 *   driver's eye is 67 deg off-axis — outside any sane lens. Every racing game
 *   pulls them inboard for the cockpit view; these are at ±0.42 on their own
 *   stalks and are only ever visible in `cockpit`, so the exterior silhouette is
 *   untouched. The glass is a rough metal that reflects the scene IBL: no extra
 *   render pass, no second exposure path, and at a grazing angle to the sky it
 *   reads as glass.
 */
/**
 * Mirror head, car-local, and the yaw of its glass inboard of straight back.
 * Placed so its azimuth from the eye is 31 deg — inside the 41 deg horizontal
 * half-FOV of the cockpit lens even with the helmet turned 8 deg into a corner,
 * which is what decides this number, not the styling.
 */
const MIRROR_X = 0.345, MIRROR_Y = 0.658, MIRROR_Z = -0.815;
const MIRROR_YAW = 0.55;

/**
 * THE MIRRORS ARE A REAL RENDER OF THE REAL WORLD.
 *
 * v1 painted them: a gradient sky with no cloud, a flat green verge, no
 * barriers, no hoardings, no grandstand and one stamped-on car. Against a frame
 * full of cumulus and trackside furniture it read instantly as a cheap second
 * render, which is exactly what the review said. They are now a live pass of the
 * SAME scene — same sky, same clouds, same barriers, same twenty cars — into one
 * small render target.
 *
 * ONE PASS FOR BOTH MIRRORS. A rear-view mirror's own reflection vector is
 * useless here: the glass is cheated 23 cm inboard of where a real one sits, so
 * reflecting the eye off it aims 33 deg the WRONG side of straight back, into
 * the driver's own airbox. What a mirror is for is "what is behind me on my
 * side", so the pass is one rearward camera whose left and right halves are each
 * mirror's window: `MIRROR_RT_W x MIRROR_RT_H` at a horizontal half-angle of
 * 37.6 deg, so each half spans straight-back to 37.6 deg outboard, and the glass
 * UVs (see `_mirrorGlassGeometry`) pick the half and flip it — a mirror image is
 * laterally inverted with respect to a camera pointing the other way.
 *
 * COST. 288 x 112 is 32 k pixels, 2 % of a 1080p frame, and the pass runs every
 * OTHER frame and only while the cockpit solver owns the screen. Shadow map
 * updates are suppressed for it (it reuses the frame's own cascade), so the
 * marginal cost is one culling pass and one set of draw submissions.
 *
 * EXPOSURE. The target is HalfFloat and NoColorSpace, i.e. it holds scene-linear
 * radiance, and it is bound as an EMISSIVE map at `MIRROR_GAIN` — a mirror's
 * reflectance. The mirror pixel therefore emits the radiance the world behind it
 * actually has and goes through the frame's single exposure/tonemap like
 * everything else. There is no second exposure path here and there must not be.
 */
const MIRROR_RT_W = 288, MIRROR_RT_H = 112;
const MIRROR_FOV = 33.3;                 // vertical deg; 2*atan(0.769) horizontal
// Reflectance of a real convex mirror. Measured off the live target at `cockpit`
// (tools/_mirror.mjs): sky band 0.85-1.0, treeline 0.16-0.35, tarmac 0.08-0.10 of
// scene radiance. At 0.52 the road half of the glass sat at sRGB ~60 and read as
// a dead panel; 0.64 puts it at ~72 with the sky band at ~150 against a real sky
// of ~205, which is the loss a wing mirror actually has, and leaves the brightest
// texel three stops under the 1.25 bloom threshold.
const MIRROR_GAIN = 0.64;
/** Car-local mount: just clear of the tail, so no bodywork blocks the lens. */
const MIRROR_CAM = new THREE.Vector3(0, 0.94, 3.05);
const MIRROR_CAM_PITCH = -0.060;         // rad; puts the horizon at ~0.44 of the glass

/**
 * The eye every number in this class is authored against. The furniture hangs
 * off `seat`, which `setEye()` translates by (eye - AUTHOR_EYE), so the driver's
 * eye height is free to move for reasons that have nothing to do with the
 * cockpit — how much road clears the nose, how the halo bands the frame — while
 * the wheel, the hands and the mirrors keep the framing they were tuned for.
 * Author to THIS point, never to the live mount.
 */
const AUTHOR_EYE = new THREE.Vector3(0, 0.800, -0.232);

export class CockpitInterior {
  constructor() {
    this.group = new THREE.Group();
    this.group.name = 'CockpitInterior';
    this.group.matrixAutoUpdate = false;

    // Everything car-local hangs off here — see AUTHOR_EYE.
    this.seat = new THREE.Group();
    this.seat.matrixAutoUpdate = false;
    this.group.add(this.seat);

    // --- materials ----------------------------------------------------------
    // The weave tiles at 0.25 m; every part here is 2–18 cm, so the repeat is
    // deliberately just above 1 (a 5 mm tow smeared over a 12 cm boss is the
    // "carbon reads as rubber hose" failure `chassis.js` warns about). `aoMap` is
    // dropped: three samples it from `uv1`, and merged primitive geometry has no
    // second channel, so it would multiply everything by the texel at (0,0).
    const weave = setRepeat(cloneMaps(carbonFibre({ size: 512, tows: 14, key: 'camera/cockpit-weave' })), 2.2, 2.2);
    const wm = mapsToMaterial(weave, { roughness: 0.46, metalness: 0.12 });
    wm.aoMap = null;
    this.mats = {};
    this.mats.carbon = new THREE.MeshStandardMaterial({ ...wm, color: 0x8b8d93 });
    // The rim is leather/suede-wrapped in real life; only the yoke is bare.
    this.mats.rim = new THREE.MeshStandardMaterial({ color: 0x2a2d35, roughness: 0.72, metalness: 0.06 });
    this.mats.suede = new THREE.MeshStandardMaterial({ color: 0x191b20, roughness: 0.94, metalness: 0.0 });
    // The gloves have to READ against the tub, which is black carbon: a black
    // glove on a black wheel in a black cockpit is a hole in the frame.
    // 0x363c47 was authored against the OLD key light. With the key at its
    // current strength the gloves metered sRGB 141/145/157 against a tub at 39 —
    // as bright as the sky and reading as white plastic mittens. 0x272b34 lands
    // at ~100, still 2.5x the tub (which is the separation that number exists
    // for) and inside the value range a nomex glove actually occupies.
    //
    // THE SOFT GOODS NEED A SURFACE, NOT JUST A VALUE. The glove, the sleeve and
    // the cuff were three flat `MeshStandardMaterial` colours on smooth primitives
    // — no map of any kind — so the only shading they carried was the lambert
    // gradient of a sphere. At cockpit range that is a modelling-clay read: a
    // grey lump with a lighter grey lump on it (shots/_ck-hand.png, r4). Nomex
    // knit is a ~2 mm grid, and `fabric()` is exactly that: its tile is 45 weave
    // cells per UV unit, and every one of these parts is a primitive whose UV
    // span is 6–12 cm, so at `repeat = 1` a cell lands at 1.5–2.5 mm without any
    // per-part tuning. Only the NORMAL and the ROUGHNESS are taken — the albedo
    // stays the authored value below, which is the one thing three rounds of
    // review have already calibrated. `aoMap` is dropped for the uv1 reason above.
    // A KNIT CELL IS 2 mm WHEREVER IT LANDS. The tile is 45 cells per UV unit,
    // so the repeat has to be set from each part's UV SPAN, not chosen by eye: a
    // glove primitive spans 6–9 cm (repeat 1 -> 1.7 mm) but the forearm capsule
    // spans 31 cm round and 36 cm long, and at repeat 1 that is an 8 mm cell —
    // which renders as a gingham tablecloth, not as nomex (first attempt,
    // shots/_ck-hand2.png). Hence two map sets off one bake.
    //
    // ROUGHNESS MAPS MULTIPLY. The `fabric` roughness channel averages ~0.86, so
    // dropping it straight on top of the authored scalars silently made all three
    // materials a sixth glossier and lifted the gloves half a stop. Each scalar
    // below is therefore pre-divided by that average; the MEAN roughness is
    // unchanged and only the variation is new.
    const knitBase = fabric({ size: 512, key: 'camera/cockpit-knit' });
    const knitFine = knitBase;                                   // repeat 1
    const knitCoarse = setRepeat(cloneMaps(knitBase), 3.6, 4.2);  // sleeve/cuff
    const soft = (maps, scale) => ({
      normalMap: maps.normalMap,
      normalScale: new THREE.Vector2(scale, scale),
      roughnessMap: maps.ormMap,
    });
    // The gloves have to READ against the tub, which is black carbon: a black
    // glove on a black wheel in a black cockpit is a hole in the frame.
    // 0x363c47 was authored against the OLD key light. With the key at its
    // current strength the gloves metered sRGB 141/145/157 against a tub at 39 —
    // as bright as the sky and reading as white plastic mittens. 0x272b34 lands
    // at ~100, still 2.5x the tub (which is the separation that number exists
    // for) and inside the value range a nomex glove actually occupies.
    this.mats.glove = new THREE.MeshStandardMaterial({ color: 0x272b34, roughness: 0.98, metalness: 0.0, ...soft(knitFine, 0.55) });
    this.mats.suit = new THREE.MeshStandardMaterial({ color: 0x22262e, roughness: 1.0, metalness: 0.0, ...soft(knitCoarse, 0.38) });
    // The one lighter value in the lower third: a glove, a forearm and a black
    // wheel rim at the same tone merge into one grey mass, and the cuff is what
    // says "this is a hand holding something". Mid grey, NOT white — at 0xa8b0bd
    // the two cuffs were the brightest objects below the horizon and read as
    // bandages (shots/_cx-hands.png). 0x596273 still metered as the brightest
    // object below the horizon once the knit lifted its highlights; 0x4b5361
    // keeps the separation from the sleeve (0x22262e) and gives it back.
    this.mats.cuff = new THREE.MeshStandardMaterial({ color: 0x4b5361, roughness: 0.77, metalness: 0.0, ...soft(knitCoarse, 0.42) });
    // Mirror glass. A pure metal reflecting `scene.environment` is the obvious
    // implementation and it is WRONG: measured on shots/c1-cockpit.png, both
    // mirrors came back (7,11,22) and (16,18,24) — flat black rectangles. The
    // reflected ray off a rear-view mirror leaves the eye, bounces off a plane
    // yawed 32 deg from straight-back and exits just BELOW the horizon, so a
    // sky-only IBL returns its darkest band, and the one thing a mirror must
    // never be is a hole.
    //
    // So the glass carries what a mirror actually shows — sky over a receding
    // road with a car in it — as a baked image 8 cm wide at 0.6 m range: a
    // value, not a picture.
    //
    // IT IS EMISSIVE, NOT ALBEDO. A reflection is not a diffuse surface. Run the
    // same image through `map` and the sun lands on the glass and multiplies it,
    // which washed both mirrors to flat white cards in direct light; as emissive
    // it holds its value whatever the sun is doing, and the dielectric specular
    // lobe still slides a real sky glint across it.
    // The painted image is now only the FALLBACK, for a headless or pre-renderer
    // frame: `_ensureMirrorRT()` swaps in the live pass the moment the renderer
    // is reachable. It is laid out in the same two half-windows as the target so
    // one set of glass UVs serves both.
    this.mirrorTex = _canvasTexture(_mirrorCanvas(MIRROR_RT_W, MIRROR_RT_H));
    this.mats.mirror = new THREE.MeshStandardMaterial({
      color: 0x05070b, roughness: 0.14, metalness: 0.0, envMapIntensity: 0.7,
      // 0.62 metered the mirror's sky band at sRGB 134 against a real sky of
      // 205; 0.82 puts it at ~160, which is the ratio a wing mirror actually
      // returns, and is still an order of magnitude under the bloom threshold.
      emissive: 0xffffff, emissiveMap: this.mirrorTex, emissiveIntensity: 0.82,
    });
    /** Live switch for the mirror pass — A/B, and a low-spec off ramp. */
    this.mirror = true;
    this.mirrorRT = undefined;      // undefined = not tried yet, null = no renderer
    this.mirrorCam = null;
    this._mirrorTick = 0;
    this._mirrorHide = null;

    // Emissive canvases. `emissiveIntensity` is deliberately just under the
    // bloom threshold (1.25 linear) so the dash glows without smearing.
    this.ledCanvas = _canvas(256, 16);
    this.ledTex = _canvasTexture(this.ledCanvas);
    this.mats.led = new THREE.MeshStandardMaterial({
      color: 0x05060a, roughness: 0.35, metalness: 0,
      // The LEDs are the one thing here that is MEANT to break the bloom
      // threshold (1.25 linear): a lit shift light is a 5 mm point source, and a
      // 5 mm point source that does not glow reads as a painted sticker. They
      // total ~2 cm² of screen area, so the bloom energy is negligible.
      emissive: 0xffffff, emissiveMap: this.ledTex, emissiveIntensity: 2.1,
    });
    this.screenCanvas = _canvas(336, 200);
    this.screenTex = _canvasTexture(this.screenCanvas);
    this.mats.screen = new THREE.MeshStandardMaterial({
      color: 0x04050a, roughness: 0.26, metalness: 0,
      emissive: 0xffffff, emissiveMap: this.screenTex, emissiveIntensity: 1.05,
    });
    // three reads `alphaMap` from its GREEN channel, not from alpha, so the mask
    // is painted into RGB and the texture must stay linear.
    this.visorTex = _canvasTexture(_visorCanvas(256));
    this.visorTex.colorSpace = THREE.NoColorSpace;
    // A HELMET INTERIOR IS NOT A HOLE. `color: 0x04040a` flat made the aperture a
    // dead slab: measured on the r4 `cockpit` frame, 13.1 % of the top quarter of
    // the frame sat below L=6 against 11.7 % in r3, and the review logged the void
    // as having grown. The shell 3 cm from the eye is out of focus and unlit from
    // the front, but its lower lip catches the same skylight the road does, so the
    // tone ramps from near-black under the brow to a soft grey right at the
    // opening. That ramp is `_visorLidCanvas`; painting it as an sRGB MAP rather
    // than raising `color` keeps the top of the band as black as it was.
    this.visorLidTex = _canvasTexture(_visorLidCanvas(128));
    this.mats.visor = new THREE.MeshBasicMaterial({
      color: 0xffffff, map: this.visorLidTex, transparent: true, alphaMap: this.visorTex,
      depthWrite: false, side: THREE.FrontSide,
    });

    // --- steering wheel -----------------------------------------------------
    // The hub sits ABOVE the dash bulkhead (`chassis.js` puts its top at y 0.565
    // and `setEye` lifts this whole rig with the seat) so the display is not
    // occluded by it, and 0.40 m from the eye — the rim then subtends 38 deg of
    // an 82 deg horizontal frame, which is the F1 24 proportion.
    //
    // THE HEIGHT IS A FRAMING NUMBER, and it is a NARROW window. Measured on the
    // `cockpit` shot (rim top / hub / knuckles, as fractions of frame height):
    //     hub y 0.618 (v1)   0.64 / 0.83 / 0.80   wheel across the middle of the
    //                                             frame, held at chin height
    //     hub y 0.551        0.80 / 0.99 / 1.12   hands off the bottom edge — a
    //                                             steering wheel with no driver
    //     hub y 0.593        0.70 / 0.90 / 0.96   rim in the bottom third, both
    //                                             gloves in frame, road above
    // 25 mm of wheel is 0.06 of frame height at this range, so this is not a
    // number to nudge by eye.
    const HUB = new THREE.Vector3(0, 0.601, -0.628);
    const TILT = 0.42;              // rad; the top of the rim leans away
    this.RX = 0.140; this.RY = 0.118;
    this.wheel = new THREE.Group();
    this.wheel.position.copy(HUB);
    this.wheel.rotation.x = TILT;
    this.seat.add(this.wheel);

    this.wheel.add(new THREE.Mesh(this._rimGeometry(), this.mats.rim));
    this.wheel.add(new THREE.Mesh(this._hubGeometry(), this.mats.carbon));
    this.wheel.add(new THREE.Mesh(this._gripGeometry(), this.mats.suede));
    this.wheel.add(new THREE.Mesh(this._gloveGeometry(), this.mats.glove));

    // Both panels stand PROUD of the plate they sit on — flush is coplanar, and
    // coplanar with a depth-tested emissive plane is a flickering mess — but only
    // just. At 4.5 mm the LED strip parallaxed off its own bezel and you could
    // see the tub through the gap at the left-hand end (the review's "floats
    // above the wheel bezel"). 1.6 mm is still 4 depth-buffer decades clear at
    // 0.44 m and reads as seated. `_hubGeometry` carries the matching bezels.
    const led = new THREE.Mesh(new THREE.PlaneGeometry(0.162, 0.0135), this.mats.led);
    led.position.set(0, 0.0955, 0.0176);
    this.wheel.add(led);

    // The screen is nearly the whole boss face, the way a 2022+ wheel is: the old
    // 112 x 62 mm panel left the top half of the boss as a dead black slab, which
    // is what read as "a small display on a big black rectangle".
    const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.118, 0.0700), this.mats.screen);
    screen.position.set(0, 0.018, 0.0215);
    this.wheel.add(screen);

    // --- forearms -----------------------------------------------------------
    // Elbow pivots roughly where the chassis' own upper arms end. Each arm is a
    // fixed-length capsule AIMED at its grip every frame, so the hands stay on
    // the rim through full lock instead of the wheel spinning inside them.
    this.arms = [];
    this.grips = [];
    for (const side of [-1, 1]) {
      const g = new THREE.Group();
      g.position.set(side * 0.196, 0.487, -0.262);
      const len = 0.36;
      const cap = new THREE.CapsuleGeometry(0.049, len - 0.098, 4, 10);
      cap.rotateX(-Math.PI / 2);
      cap.translate(0, 0, -len * 0.5);
      const m = new THREE.Mesh(cap, this.mats.suit);
      g.add(m);
      // A cuff at the wrist end. Without it the forearm and the glove are one
      // continuous grey sausage, which is exactly how the review read it.
      const cuff = new THREE.CylinderGeometry(0.052, 0.048, 0.028, 12, 1, true);
      cuff.rotateX(Math.PI / 2);
      cuff.translate(0, 0, -len + 0.048);
      g.add(new THREE.Mesh(cuff, this.mats.cuff));
      g.userData.len = len;
      this.seat.add(g);
      this.arms.push(g);
      this.grips.push(new THREE.Vector3(side * this.RX, -0.004, 0.020));
    }

    // --- mirrors ------------------------------------------------------------
    this.seat.add(new THREE.Mesh(this._mirrorShellGeometry(), this.mats.carbon));
    this.mirrorGlass = new THREE.Mesh(this._mirrorGlassGeometry(), this.mats.mirror);
    this.seat.add(this.mirrorGlass);

    // --- visor / helmet aperture -------------------------------------------
    // Eye-fixed, not car-fixed: it is part of the driver's helmet, so it must
    // ride the head-lag spring and the shake with the lens, not with the tub.
    this.visor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.mats.visor);
    this.visor.name = 'CockpitVisor';
    this.visor.frustumCulled = false;
    // After the particles (20) and the rain (30): the helmet shell is the last
    // thing between the driver and the world, so nothing may draw over it.
    this.visor.renderOrder = 60;
    this.visor.matrixAutoUpdate = false;

    for (const o of [this.group, this.visor]) {
      o.traverse((n) => {
        if (!n.isMesh) return;
        n.castShadow = false;
        n.receiveShadow = n !== this.visor;
        n.frustumCulled = false;
      });
    }
    this.group.visible = false;
    this.visor.visible = false;
    this._ledLit = -1;
    this._screenKey = '';
    this._screenT = 0;
  }

  /* --------------------------------------------------------------- geometry */

  /** Rim outline: a superellipse, so the wheel is an F1 butterfly, not a hoop. */
  _rimPath(n = 40, inset = 0) {
    const pts = [];
    const rx = this.RX - inset, ry = this.RY - inset;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * TAU;
      const c = Math.cos(a), s = Math.sin(a);
      const p = 2 / 3.1;
      pts.push(new THREE.Vector3(
        rx * Math.sign(c) * Math.pow(Math.abs(c), p),
        ry * Math.sign(s) * Math.pow(Math.abs(s), p),
        0,
      ));
    }
    return pts;
  }

  _rimGeometry() {
    const curve = new THREE.CatmullRomCurve3(this._rimPath(36, 0.017), true, 'catmullrom', 0.5);
    return new THREE.TubeGeometry(curve, 72, 0.0165, 8, true);
  }

  /** Hub boss, two spokes out to the rim, and the top plate that carries the LEDs. */
  _hubGeometry() {
    const parts = [];
    // The boss is the display BEZEL: it has to be bigger than the screen on all
    // four sides or the panel floats. 5 mm of frame each side, 8 mm top/bottom.
    const boss = new THREE.BoxGeometry(0.128, 0.104, 0.030);
    boss.translate(0, 0.014, 0.001);
    parts.push(boss);
    const back = new THREE.CylinderGeometry(0.030, 0.038, 0.055, 12);
    back.rotateX(Math.PI / 2);
    back.translate(0, 0.004, -0.038);
    parts.push(back);
    for (const side of [-1, 1]) {
      const spoke = new THREE.BoxGeometry(0.070, 0.040, 0.021);
      spoke.translate(side * 0.086, -0.004, 0.0);
      parts.push(spoke);
      // Shift paddle behind the rim.
      const pad = new THREE.BoxGeometry(0.014, 0.052, 0.010);
      pad.rotateY(side * 0.28);
      pad.translate(side * 0.104, -0.030, -0.030);
      parts.push(pad);
      // Rotary + button cluster.
      for (let i = 0; i < 3; i++) {
        const b = new THREE.CylinderGeometry(0.0085, 0.0085, 0.008, 8);
        b.rotateX(Math.PI / 2);
        b.translate(side * (0.074 + (i % 2) * 0.020), 0.038 - i * 0.030, 0.017);
        parts.push(b);
      }
    }
    // The LED bezel. Wider and taller than the strip it carries, so the strip is
    // let INTO it rather than laid on top of it.
    const yoke = new THREE.BoxGeometry(0.182, 0.038, 0.026);
    yoke.translate(0, 0.0955, 0.0035);
    parts.push(yoke);
    return mergeGeometries(parts);
  }

  /** Suede handles at 3 and 9 o'clock. */
  _gripGeometry() {
    const parts = [];
    for (const side of [-1, 1]) {
      const g = new THREE.CapsuleGeometry(0.0215, 0.086, 4, 10);
      g.rotateZ(0.16 * side);
      g.translate(side * this.RX, -0.004, 0.012);
      parts.push(g);
    }
    return mergeGeometries(parts);
  }

  /**
   * Gloved hands wrapped round the handles — children of the wheel, so they turn
   * with it.
   *
   * A HAND IS READ FROM ITS GAPS. v1 was a 9 x 12 cm scaled sphere with four
   * capsules buried in it: at cockpit range that silhouettes as one smooth lump
   * and the review called it exactly that. The palm is now smaller than the
   * finger span, the four fingers stand PROUD of it on the far side of the rim
   * with a 6 mm gap between each, and the knuckle line is a separate ridge — so
   * the shape has five hard edges in it instead of none.
   */
  _gloveGeometry() {
    const parts = [];
    for (const side of [-1, 1]) {
      const palm = new THREE.SphereGeometry(0.0355, 12, 9);
      palm.scale(1.05, 1.42, 0.92);
      palm.translate(side * (this.RX + 0.007), -0.002, 0.019);
      parts.push(palm);
      // Knuckle ridge, just proud of the palm.
      const knuck = new THREE.CapsuleGeometry(0.0125, 0.052, 4, 8);
      knuck.rotateX(Math.PI / 2);
      knuck.rotateZ(0.10 * side);
      knuck.translate(side * (this.RX + 0.006), 0.006, 0.034);
      parts.push(knuck);
      // Fingers, curling over the FRONT face of the rim and clear of the palm.
      for (let i = 0; i < 4; i++) {
        const len = 0.034 - Math.abs(i - 1.2) * 0.004;
        const f = new THREE.CapsuleGeometry(0.0098, len, 4, 8);
        f.rotateZ(Math.PI / 2);
        f.rotateY(-side * 0.18);
        f.translate(side * (this.RX - 0.004), 0.028 - i * 0.0205, 0.0455);
        parts.push(f);
        // Fingertip, tucked back toward the driver behind the rim.
        const tip = new THREE.SphereGeometry(0.0092, 7, 6);
        tip.translate(side * (this.RX - 0.022), 0.028 - i * 0.0205, 0.0425);
        parts.push(tip);
      }
      const thumb = new THREE.CapsuleGeometry(0.0115, 0.032, 4, 8);
      thumb.rotateX(Math.PI / 2 - 0.62);
      thumb.rotateZ(-side * 0.20);
      thumb.translate(side * (this.RX - 0.014), 0.041, 0.014);
      parts.push(thumb);
    }
    return mergeGeometries(parts);
  }

  /**
   * Mirror stalks + housings, pulled inboard and forward — see the class note.
   *
   * THE STALK RUNS UNDER THE GLASS, NEVER ACROSS IT. v1 ran a 20 x 52 mm arm
   * from the tub rim to the CENTRE of the housing; the arm is 20 cm nearer the
   * eye than the glass is, so it projected bigger than the mirror it carried and
   * cut the reflection in half (shots/_cx-mirrorR.png). It is now 14 x 22 mm and
   * lands on the bottom-inboard corner.
   */
  _mirrorShellGeometry() {
    const parts = [];
    for (const side of [-1, 1]) {
      const a = new THREE.Vector3(side * 0.262, 0.512, -0.500);
      const b = new THREE.Vector3(side * (MIRROR_X - 0.024), MIRROR_Y - 0.030, MIRROR_Z + 0.008);
      const len = a.distanceTo(b);
      const stalk = new THREE.BoxGeometry(0.014, 0.022, len);
      const q = new THREE.Quaternion().setFromUnitVectors(
        new THREE.Vector3(0, 0, 1), _cv.copy(b).sub(a).normalize(),
      );
      stalk.applyQuaternion(q);
      stalk.translate((a.x + b.x) * 0.5, (a.y + b.y) * 0.5, (a.z + b.z) * 0.5);
      parts.push(stalk);
      // A bezel, not a block: the housing may not be thicker than the glass is
      // wide or it silhouettes as a brick with a picture on it.
      const shell = new THREE.BoxGeometry(0.086, 0.068, 0.018);
      shell.rotateY(-side * MIRROR_YAW);
      shell.translate(
        side * MIRROR_X + side * Math.sin(MIRROR_YAW) * 0.006,
        MIRROR_Y,
        MIRROR_Z - Math.cos(MIRROR_YAW) * 0.006,
      );
      parts.push(shell);
    }
    return mergeGeometries(parts);
  }

  /**
   * The glass has to FACE THE DRIVER, or the reflection is on the far side of an
   * opaque box. `chassis.buildMirrorGlass()` rotates its plane by PI, i.e. it
   * points its normal down the road — from the cockpit you see the back of it.
   * Here the normal is yawed `MIRROR_YAW` inboard of straight-back, which is a
   * real mirror's compromise: enough toward the eye to read, enough outboard to
   * be showing something other than the airbox.
   */
  _mirrorGlassGeometry() {
    const parts = [];
    for (const side of [-1, 1]) {
      const g = new THREE.PlaneGeometry(0.074, 0.058);
      // Pick this mirror's window out of the shared rear pass and FLIP it.
      // A rearward camera's own right hand is the car's left, so its right half
      // (u 0.5..1) holds the back-LEFT world. The left mirror therefore reads
      // u' = 1 - u/2 (its outboard edge takes the widest left angle) and the
      // right mirror u' = 0.5 - u/2. Both run backwards, which is the lateral
      // inversion that makes a mirror a mirror instead of a rear-facing screen.
      const uv = g.attributes.uv;
      const base = side < 0 ? 1.0 : 0.5;
      for (let i = 0; i < uv.count; i++) uv.setX(i, base - uv.getX(i) * 0.5);
      uv.needsUpdate = true;
      g.rotateY(-side * MIRROR_YAW);
      // 8 mm proud along the glass normal — 5 mm clear of the bezel face, which
      // is enough to beat the depth test and not enough to read as a slab.
      g.translate(
        MIRROR_X * side - side * Math.sin(MIRROR_YAW) * 0.008,
        MIRROR_Y,
        MIRROR_Z + Math.cos(MIRROR_YAW) * 0.008,
      );
      parts.push(g);
    }
    return mergeGeometries(parts);
  }

  /* ------------------------------------------------------------- mirror pass */

  /**
   * Build the mirror target the first time a renderer is reachable. Returns null
   * for ever if there is none (a headless unit test), and the painted fallback
   * stays bound — the cockpit must never come up with two black holes in it.
   */
  _ensureMirrorRT() {
    if (this.mirrorRT !== undefined) return this.mirrorRT;
    const r = assets.renderer;
    if (!r) { this.mirrorRT = null; return null; }
    const rt = new THREE.WebGLRenderTarget(MIRROR_RT_W, MIRROR_RT_H, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      generateMipmaps: false,
      depthBuffer: true,
    });
    // Scene-linear radiance. NOT sRGB: this is a radiance buffer that the one
    // exposure path downstream will tonemap, not an authored image.
    rt.texture.colorSpace = THREE.NoColorSpace;
    rt.texture.wrapS = rt.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.mirrorRT = rt;
    this.mirrorCam = new THREE.PerspectiveCamera(MIRROR_FOV, MIRROR_RT_W / MIRROR_RT_H, 0.45, 8000);
    this.mats.mirror.emissiveMap = rt.texture;
    this.mats.mirror.emissiveIntensity = MIRROR_GAIN;
    this.mats.mirror.needsUpdate = true;
    return rt;
  }

  /**
   * One rearward pass into the shared target. `scene` is the live scene, and the
   * car's rigid transform places the lens.
   *
   * WHAT IS HIDDEN AND WHY. The interior itself (so the glass cannot see its own
   * stalks) and every `Points` cloud in the scene: `fx/particles.js` sizes its
   * sprites with `uPixelScale = viewportHeight / 2 tan(fov/2)`, a uniform set for
   * the MAIN viewport, so at 112 px tall every spark would draw eight times too
   * big. That is a viewport-scale defect, not a layer exclusion — everything with
   * a world-space size (sky, cloud, barriers, hoardings, crowd, cars, rain)
   * renders exactly as it does in the main frame.
   */
  renderMirror(scene, position, quaternion) {
    if (!this.mirror) return;               // live switch, for A/B and low spec
    const rt = this._ensureMirrorRT();
    if (!rt) return;
    // Every other frame. An 8 cm mirror 0.6 m from the eye cannot resolve 16 ms.
    this._mirrorTick++;
    if (this._mirrorTick > 1 && (this._mirrorTick & 1)) return;
    const r = assets.renderer;
    const cam = this.mirrorCam;
    cam.position.copy(MIRROR_CAM).applyQuaternion(quaternion).add(position);
    // Ry(PI) then a local pitch: look back along the car's +Z, nose slightly down.
    _cq.setFromEuler(_mirrorEuler.set(MIRROR_CAM_PITCH, Math.PI, 0, 'YXZ'));
    cam.quaternion.copy(quaternion).multiply(_cq);
    cam.updateMatrixWorld(true);

    // Re-walk every ~10 s of cockpit time: weather states build their own pools
    // late, and a sprite cloud that appears after the first walk would otherwise
    // never be excluded.
    if (!this._mirrorHide || this._mirrorTick % 600 === 0) {
      this._mirrorHide = [];
      scene.traverse((n) => { if (n.isPoints) this._mirrorHide.push(n); });
    }
    const hidden = this._mirrorHide;
    for (let i = 0; i < hidden.length; i++) hidden[i].visible = false;
    const wasGroup = this.group.visible, wasVisor = this.visor.visible;
    this.group.visible = false; this.visor.visible = false;

    const prevRT = r.getRenderTarget();
    const prevAuto = r.shadowMap.autoUpdate;
    // Reuse the frame's own cascade instead of re-rendering four shadow maps for
    // 32 k pixels. This is the single biggest reason the pass is nearly free.
    r.shadowMap.autoUpdate = false;
    r.setRenderTarget(rt);
    r.render(scene, cam);
    r.setRenderTarget(prevRT);
    r.shadowMap.autoUpdate = prevAuto;

    this.group.visible = wasGroup; this.visor.visible = wasVisor;
    for (let i = 0; i < hidden.length; i++) hidden[i].visible = true;
  }

  /* ----------------------------------------------------------------- runtime */

  /**
   * Ride the live eye mount. Everything in here was authored against
   * `AUTHOR_EYE`; this keeps the wheel, the hands and the mirrors at the frame
   * fractions they were tuned for whatever seat height the rig is using.
   */
  setEye(eye) {
    const p = this.seat.position;
    if (p.x === eye.x - AUTHOR_EYE.x && p.y === eye.y - AUTHOR_EYE.y && p.z === eye.z - AUTHOR_EYE.z) return;
    p.set(eye.x - AUTHOR_EYE.x, eye.y - AUTHOR_EYE.y, eye.z - AUTHOR_EYE.z);
    this.seat.updateMatrix();
  }

  /** Pose the whole prop from the car's rigid transform. */
  pose(position, quaternion) {
    this.group.position.copy(position);
    this.group.quaternion.copy(quaternion);
    this.group.updateMatrix();
    this.group.updateMatrixWorld(true);
  }

  /**
   * Steering, shift lights and the dash screen. `steerNorm` is the -1..1 control
   * value; 1.55 rad of wheel for full lock is about what an F1 rack gives.
   */
  update(dt, telemetry, steerNorm) {
    this.wheel.rotation.z = -clamp(steerNorm ?? 0, -1, 1) * 1.55;
    this.wheel.updateMatrix();

    // Aim each forearm at its (now rotated) grip, in car-local space.
    for (let i = 0; i < 2; i++) {
      const arm = this.arms[i];
      _cv.copy(this.grips[i]).applyMatrix4(this.wheel.matrix).sub(arm.position);
      const len = Math.max(0.18, _cv.length());
      _cq.setFromUnitVectors(_cv2.set(0, 0, -1), _cv.divideScalar(len));
      arm.quaternion.copy(_cq);
      arm.scale.z = len / arm.userData.len;
      arm.updateMatrix();
    }

    const rpm = clamp(telemetry?.rpmNorm ?? 0, 0, 1);
    const lit = Math.round(clamp((rpm - 0.52) / 0.44, 0, 1) * 15);
    if (lit !== this._ledLit) { this._ledLit = lit; _paintLeds(this.ledCanvas, lit); this.ledTex.needsUpdate = true; }

    // Repaint the dash at ~10 Hz and only when something on it actually changed.
    this._screenT += dt;
    if (this._screenT >= 0.1) {
      this._screenT = 0;
      const kph = Math.round(telemetry?.speedKph ?? 0);
      const tt = telemetry && telemetry.tyreTemp && telemetry.tyreTemp.length
        ? Math.round((telemetry.tyreTemp[0] + telemetry.tyreTemp[1] + telemetry.tyreTemp[2] + telemetry.tyreTemp[3]) / 4) : 0;
      const key = `${telemetry?.gear ?? 0}|${kph}|${lit}|${telemetry?.drs ? 1 : 0}|${Math.round((telemetry?.ers ?? 0) * 20)}|${tt}`;
      if (key !== this._screenKey) {
        this._screenKey = key;
        _paintDash(this.screenCanvas, telemetry, rpm);
        this.screenTex.needsUpdate = true;
      }
    }
  }

  /**
   * Fit the helmet aperture to the live lens. Sized from the ACTUAL fov and
   * aspect every frame, so it cuts the same fraction of frame height whatever
   * the speed-coupled FOV is doing.
   */
  poseVisor(camera, amount) {
    const m = this.mats.visor;
    this.visor.visible = amount > 0.01;
    if (!this.visor.visible) return;
    m.opacity = clamp(amount, 0, 1);
    const d = 0.30;
    const h = 2 * d * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5) * 1.04;
    this.visor.scale.set(h * (camera.aspect || 1.778), h, 1);
    this.visor.position.set(0, 0, -d);
    this.visor.quaternion.identity();
    this.visor.updateMatrix();
    this.visor.matrix.premultiply(camera.matrixWorld);
    this.visor.matrix.decompose(this.visor.position, this.visor.quaternion, this.visor.scale);
    this.visor.updateMatrix();
    this.visor.updateMatrixWorld(true);
  }

  dispose() {
    this.group.traverse((n) => { if (n.isMesh) n.geometry.dispose(); });
    this.visor.geometry.dispose();
    for (const k in this.mats) this.mats[k].dispose();
    this.ledTex.dispose(); this.screenTex.dispose(); this.visorTex.dispose();
    this.visorLidTex.dispose();
    this.mirrorTex.dispose();
    if (this.mirrorRT) this.mirrorRT.dispose();
    this.mirrorRT = null; this.mirrorCam = null; this._mirrorHide = null;
  }
}

/* ------------------------------- canvases --------------------------------- */

function _canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function _canvasTexture(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/**
 * 15-LED shift strip: green, red, then the blue "shift NOW" pair.
 *
 * AN UNLIT LED IS NEUTRAL. Painting the dark segments in their own hue (dark
 * red, dark blue) tells the viewer the colour of a light that is switched off,
 * which no real dashboard does and which the review called out as a giveaway: a
 * dead LED is a grey lens over a black cavity. They are now 0x1a1a1a with a
 * hairline of the live hue at the very bottom of the lens, which is the amount
 * of tint an unlit coloured diffuser actually shows.
 */
function _paintLeds(canvas, lit) {
  const g = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  g.clearRect(0, 0, W, H);
  g.fillStyle = '#050506';
  g.fillRect(0, 0, W, H);
  const n = 15;
  const pad = 3;
  const cell = (W - pad * 2) / n;
  for (let i = 0; i < n; i++) {
    const on = i < lit;
    const hue = i < 5 ? '#2bff6a' : i < 11 ? '#ff2f22' : '#5fa8ff';
    const x = pad + i * cell;
    // 0x33, not the 0x1a the review asked for, for one measured reason: this
    // canvas is an sRGB EMISSIVE map at intensity 2.1 and nothing else lights it,
    // so 0x1a lands at 0.010 linear x 2.1 = 0.022 — black. 0x33 is 0.033 x 2.1 =
    // 0.070, which is the value a grey lens over a dead LED actually returns, and
    // still 30x under the lit segment.
    g.fillStyle = on ? hue : '#333336';
    g.fillRect(x + 0.8, 3, cell - 1.6, H - 6);
  }
}

/**
 * The wheel display: rpm bar, gear, speed, ERS, tyre temperature, DRS.
 *
 * IT HAS TO FILL ITS OWN BEZEL. v1 put a gear numeral and a speed on the left
 * two thirds of the panel and left the rest black, which reads as a small
 * display on a big black rectangle rather than as an instrument. The layout is
 * now three bands over the full 336 x 200: rpm across the top, the two numbers
 * the driver actually reads in the middle at maximum size, and a status strip
 * along the bottom. Every value comes from `vehicle.telemetry`; nothing here is
 * invented, because a readout that does not move is a sticker.
 */
function _paintDash(canvas, tm, rpm) {
  const g = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  g.fillStyle = '#04060b';
  g.fillRect(0, 0, W, H);
  g.textBaseline = 'middle';

  // --- rpm bar, full width -------------------------------------------------
  const bx = 8, bw = W - 16, by = 7, bh = 26;
  g.fillStyle = '#0d131c';
  g.fillRect(bx, by, bw, bh);
  const seg = 24;
  for (let i = 0; i < seg; i++) {
    const f = (i + 1) / seg;
    if (f > rpm) break;
    g.fillStyle = f < 0.62 ? '#37e08a' : f < 0.86 ? '#ffcf3a' : '#ff3a2a';
    g.fillRect(bx + 2 + i * (bw - 4) / seg, by + 2, (bw - 4) / seg - 2, bh - 4);
  }

  // --- gear (left) ---------------------------------------------------------
  const gear = tm?.gear ?? 0;
  g.fillStyle = '#f2f5fb';
  g.textAlign = 'center';
  g.font = '700 96px ui-monospace, Menlo, monospace';
  g.fillText(gear <= 0 ? 'N' : String(gear), 58, 96);

  // Column rule: the panel is two instruments, and a hairline is what says so.
  g.fillStyle = '#1b2532';
  g.fillRect(112, 48, 2, 96);

  // --- speed (right) -------------------------------------------------------
  g.textAlign = 'right';
  g.font = '700 62px ui-monospace, Menlo, monospace';
  g.fillStyle = '#dfe6f2';
  g.fillText(String(Math.round(tm?.speedKph ?? 0)), W - 12, 88);
  g.font = '600 17px ui-monospace, Menlo, monospace';
  g.fillStyle = '#7c8798';
  g.fillText('KM/H', W - 12, 124);

  // --- status strip --------------------------------------------------------
  // ERS on the left with its own label, tyre temperature on the right, and the
  // DRS pill between them so the middle of the panel is never empty.
  const ers = clamp(tm?.ers ?? 0, 0, 1);
  g.textAlign = 'left';
  g.font = '600 15px ui-monospace, Menlo, monospace';
  g.fillStyle = '#7c8798';
  g.fillText('ERS', 10, 168);
  g.fillStyle = '#0d131c';
  g.fillRect(44, 158, 100, 19);
  g.fillStyle = '#3ad2ff';
  g.fillRect(46, 160, 96 * ers, 15);

  const temps = tm?.tyreTemp;
  if (temps && temps.length) {
    let t = 0;
    for (let i = 0; i < temps.length; i++) t += temps[i];
    t /= temps.length;
    g.textAlign = 'right';
    g.font = '600 15px ui-monospace, Menlo, monospace';
    g.fillStyle = '#7c8798';
    g.fillText('TYRE', W - 62, 168);
    g.font = '700 22px ui-monospace, Menlo, monospace';
    // Cold blue -> working white -> overheating amber, the way a real strategy
    // display colours it. 90-110 C is the window for a slick.
    g.fillStyle = t < 88 ? '#6fa8ff' : t > 112 ? '#ffb03a' : '#e8eef8';
    g.fillText(`${Math.round(t)}°`, W - 12, 167);
  }

  g.textAlign = 'center';
  g.font = '700 17px ui-monospace, Menlo, monospace';
  if (tm?.drs) {
    g.fillStyle = '#12e07a';
    g.fillRect(158, 154, 56, 26);
    g.fillStyle = '#04060b';
  } else {
    g.fillStyle = '#121821';
    g.fillRect(158, 154, 56, 26);
    g.fillStyle = '#3a4453';
  }
  g.fillText('DRS', 186, 168);
}

/**
 * What the mirror shows: sky over a road that recedes to a vanishing point, a
 * barrier line, and one car back there. Painted rather than rendered — an 8 cm
 * mirror at 0.6 m is 40 px on a 900p frame, and a second render pass for 40 px
 * would be the most expensive pixels in the game.
 *
 * KEEP IT DIM. It is a value against black carbon, not a light source: the sky
 * band tops out at sRGB 170 (the real sky in frame is ~205) because a mirror
 * loses light, and nothing in here may approach the bloom threshold.
 */
function _mirrorCanvas(fullW, h) {
  const half = _mirrorHalfCanvas(Math.round(fullW / 2), h);
  const c = _canvas(fullW, h);
  const g = c.getContext('2d');
  // Same two-window layout as the live target, so one set of glass UVs serves
  // both paths. The painted scene is symmetric enough that the flip is moot.
  g.drawImage(half, 0, 0);
  g.drawImage(half, Math.round(fullW / 2), 0);
  return c;
}

function _mirrorHalfCanvas(w, h) {
  const c = _canvas(w, h);
  const g = c.getContext('2d');
  const hz = h * 0.42;                       // horizon
  const sky = g.createLinearGradient(0, 0, 0, hz);
  sky.addColorStop(0, '#5b7ba6');
  sky.addColorStop(0.72, '#8fa8c6');
  sky.addColorStop(1, '#aab9cb');
  g.fillStyle = sky;
  g.fillRect(0, 0, w, hz);
  // Road: a trapezoid narrowing to the vanishing point, with the verge either
  // side. The taper is what makes it read as distance rather than as a stripe.
  const road = g.createLinearGradient(0, hz, 0, h);
  road.addColorStop(0, '#5a5d64');
  road.addColorStop(1, '#3a3c42');
  g.fillStyle = '#4a5340';                   // verge
  g.fillRect(0, hz, w, h - hz);
  g.fillStyle = road;
  g.beginPath();
  g.moveTo(w * 0.40, hz); g.lineTo(w * 0.62, hz);
  g.lineTo(w * 1.18, h); g.lineTo(w * -0.18, h);
  g.closePath(); g.fill();
  // Edge lines. Two converging whites are what makes 90 px of grey read as a
  // road going away from you rather than as a grey wedge.
  g.strokeStyle = '#c8ccd2';
  g.lineWidth = Math.max(1, w * 0.012);
  g.beginPath();
  g.moveTo(w * 0.415, hz + 1); g.lineTo(w * -0.10, h);
  g.moveTo(w * 0.605, hz + 1); g.lineTo(w * 1.10, h);
  g.stroke();
  // Barrier / hoarding band on the horizon.
  g.fillStyle = '#7c8391';
  g.fillRect(0, hz - h * 0.055, w, h * 0.055);
  g.fillStyle = '#2f3238';
  g.fillRect(0, hz - h * 0.012, w, h * 0.012);
  // A car, mid-distance, slightly off the centreline. Read from the top down:
  // two black tyres with ROAD between them, a body, a lit engine cover line and
  // the rain light. A single dark rectangle is a smudge, not a car.
  const cx = w * 0.60, cy = hz + h * 0.30, cw = w * 0.30, ch = h * 0.20;
  g.fillStyle = '#101114';
  g.fillRect(cx - cw * 0.62, cy - ch * 0.30, cw * 0.30, ch * 0.92);
  g.fillRect(cx + cw * 0.32, cy - ch * 0.30, cw * 0.30, ch * 0.92);
  g.fillStyle = '#2b2f36';
  g.fillRect(cx - cw * 0.34, cy - ch * 0.10, cw * 0.68, ch * 0.72);
  g.fillStyle = '#454b55';                   // engine cover, catching the sky
  g.fillRect(cx - cw * 0.16, cy - ch * 0.62, cw * 0.32, ch * 0.54);
  g.fillStyle = '#6d747f';                   // rear wing plane
  g.fillRect(cx - cw * 0.44, cy - ch * 0.66, cw * 0.88, ch * 0.13);
  g.fillStyle = '#b4261c';                   // rain light
  g.fillRect(cx - cw * 0.05, cy + ch * 0.16, cw * 0.10, ch * 0.16);
  // Soften everything: a mirror this size in a vibrating car is never sharp.
  g.globalAlpha = 0.5;
  g.filter = 'blur(1.6px)';
  g.drawImage(c, 0, 0);
  g.filter = 'none';
  g.globalAlpha = 1;
  return c;
}

/**
 * TONE of the helmet shell inside the aperture — an sRGB `map`, paired with the
 * alpha mask below. Black at the crown, ramping to a soft grey along the lip,
 * with the temples kept darker than the centre so the opening reads as a curved
 * shell and not as a gradient wipe. The values are deliberately low: multiplied
 * by an alpha that is already falling away, the lip peaks around L=26 in the
 * final frame, which is a shadowed dark-grey shell, not a lit one.
 */
function _visorLidCanvas(size) {
  const c = _canvas(size, size);
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    const up = 1 - y / (size - 1);
    // 1 at the crown, 0 at the lip: the shell turns away from the sky as it
    // climbs, so the skylight it catches falls off the same way.
    const lit = clamp((0.995 - up) / 0.11, 0, 1);
    for (let x = 0; x < size; x++) {
      const lat = Math.abs(x / (size - 1) - 0.5) * 2;
      const v = lit * lit * (1 - lat * lat * 0.55);
      const o = (y * size + x) * 4;
      d[o] = Math.round(clamp(v * 0.72, 0, 1) * 255);
      d[o + 1] = Math.round(clamp(v * 0.75, 0, 1) * 255);
      d[o + 2] = Math.round(clamp(v * 0.86, 0, 1) * 255);
      d[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}

/**
 * Helmet aperture mask. Alpha 1 = opaque helmet, 0 = the driver's view. Only the
 * TOP edge and the upper corners are cut: a full aperture turns the shot into a
 * letterbox, and the bottom of frame already has the wheel in it.
 */
function _visorCanvas(size) {
  const c = _canvas(size, size);
  const g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    // v = 0 at the TOP of the plane in UV space (PlaneGeometry uv y = 1 at top),
    // so build against `up` = 1 at the frame top.
    const up = 1 - y / (size - 1);
    for (let x = 0; x < size; x++) {
      const u = x / (size - 1);
      const lat = Math.abs(u - 0.5) * 2;                  // 0 centre, 1 edge
      // Brow line: level in the middle, dropping toward the temples. Deliberately
      // shallow — v1 cut from 0.845 at the centre to 0.710 at the temples with a
      // hard corner wedge on top, and the result read as a windscreen header rail,
      // not as the edge of a helmet.
      // 0.905/0.085 put the fully-opaque line at up 0.990 and the clear line at
      // 0.905, i.e. a band across the top 9.5 % of frame with a 7.6 % ramp under
      // it. Raising the brow 1.3 % of frame height and tightening the ramp gives
      // the same helmet read out of a shallower band, which is the "the void got
      // bigger" note; the tone ramp in `_visorLidCanvas` does the rest.
      const brow = 0.918 - lat * lat * 0.075;
      let a = clamp((up - brow) / 0.072, 0, 1);
      // A soft corner rounding, so the aperture is an opening and not a bar.
      const corner = clamp((up - 0.74) / 0.24, 0, 1) * clamp((lat - 0.80) / 0.20, 0, 1);
      a = Math.max(a, corner * corner * 0.9);
      const o = (y * size + x) * 4;
      const v = Math.round(clamp(a, 0, 1) * 255);
      d[o] = d[o + 1] = d[o + 2] = v;
      d[o + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return c;
}
