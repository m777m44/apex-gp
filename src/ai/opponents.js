/**
 * APEX GP — AI drivers, racecraft and the opponent field.
 *
 * THE PIPELINE
 *   1. `buildRacingLine`  turns the track corridor into a driveable line by
 *      minimising the line's own curvature inside the width constraint, then
 *      warping the apex later wherever a long straight follows the exit.
 *   2. `buildSpeedProfile` runs the classic quasi-steady-state solve over that
 *      line: cornering limit -> backward (braking) pass -> forward (traction and
 *      power limited) pass, all evaluated on a friction ellipse so a corner
 *      exit is limited by whatever grip the lateral load has left over.
 *   3. `AIDriver` drives it through the SAME `Vehicle` the player uses. Nothing
 *      is scripted: steering is pure pursuit, braking comes from a predictive
 *      scan of the profile, and every overtake is a real lateral objective that
 *      the tyres may or may not be able to deliver.
 *
 * WHAT MAKES THE FIELD FEEL ALIVE
 *   personalities (skill / aggression / consistency / racecraft), braking-point
 *   variance, slipstream + dirty air, DRS trains, dive bombs, one-move defence,
 *   side-by-side awareness, blue flags, lock-ups and wide exits under pressure,
 *   tyre life with a real grip falloff, pit stops, off-track recovery, and a
 *   standing start with per-driver reaction times and wheelspin.
 *
 * PUBLIC API
 *   buildRacingLine(circuit, opts)          -> Float32Array lateral offsets
 *   racingLineFor(circuit)                  -> memoised line for a circuit
 *   buildSpeedProfile(circuit, vehicle, o)  -> Float32Array m/s per sample
 *   new AIDriver({ vehicle, circuit, profile, line, skill, seed, name, entry })
 *   ai.update(dt, rivals)                   rivals = Vehicle[] or field.cars
 *   new OpponentField({ circuit, scene, entries, playerIndex, detail })
 *   field.cars[i] = { entry, vehicle, model, ai, index, distance, position }
 *   field.update(dt) / field.syncModels() / field.dispose()
 */

import * as THREE from 'three';
import { clamp, lerp, makeRng, hashSeed } from '../core/rng.js';
import { Vehicle } from '../physics/vehicle.js';
import { createCarModel } from '../car/chassis.js';
import { buildLiveryTexture } from '../car/livery.js';

// ---------------------------------------------------------------------------
// Tunables shared by the line solver, the profile and the drivers.
// ---------------------------------------------------------------------------

/** Half the car's width plus the tarmac we insist on leaving under the tyres. */
const CAR_HALF_WIDTH = 1.0;
const EDGE_MARGIN = 0.10;            // F1 cars genuinely put a wheel on the paint

/** Tyre compounds: relative peak grip, and how long they last (seconds of use). */
export const COMPOUNDS = {
  soft: { pace: 1.014, life: 320, colour: 'soft' },
  medium: { pace: 1.000, life: 520, colour: 'medium' },
  hard: { pace: 0.985, life: 760, colour: 'hard' },
};

// ---------------------------------------------------------------------------
// 1. Racing line
// ---------------------------------------------------------------------------

const _lineCache = new WeakMap();

/** Memoised optimal line for a circuit (all drivers share one). */
export function racingLineFor(circuit, opts) {
  let line = _lineCache.get(circuit);
  if (!line) { line = buildRacingLine(circuit, opts); _lineCache.set(circuit, line); }
  return line;
}

/**
 * Curvature-minimising racing line, returned as a lateral offset per sample.
 *
 * The solver is a Gauss-Seidel relaxation of the line's world-space points
 * towards the midpoint of their neighbours, projected back onto the track
 * normal and clamped to the corridor. Where the clamp is inactive the line goes
 * straight; where it is active you get an apex — which is exactly how a driver
 * describes it: "straighten the corner until you run out of road".
 *
 * A second pass blends in a blurred copy of the solution. Pure relaxation
 * clips the apex to a point; blurring re-opens the minimum radius, which is the
 * difference between the shortest path and the minimum-curvature path.
 *
 * Finally the whole line is warped later in `s` in proportion to how much
 * full-throttle running follows the corner — the late apex.
 */
export function buildRacingLine(circuit, o = {}) {
  const n = circuit.samples.length;
  const step = circuit.step;
  const limit = Math.max(0.6, circuit.halfWidth - CAR_HALF_WIDTH + EDGE_MARGIN);
  const iterations = o.iterations ?? 900;
  const relax = o.relax ?? 0.45;
  const blend = o.smoothBlend ?? 0.32;
  const lateShift = o.lateApex ?? 13;   // metres of apex delay on a corner onto a straight

  // Flatten the geometry we need into plain arrays — this loop runs ~1.3M times.
  const cx = new Float64Array(n), cz = new Float64Array(n);
  const rx = new Float64Array(n), rz = new Float64Array(n);
  const kap = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const sm = circuit.samples[i];
    cx[i] = sm.position.x; cz[i] = sm.position.z;
    rx[i] = sm.right.x; rz[i] = sm.right.z;
    kap[i] = sm.curvature;
  }

  // Seed from the geometric apex so the relaxation starts in the right basin.
  const off = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    off[i] = clamp(Math.sign(kap[i]) * limit * clamp(Math.abs(kap[i]) * 150, 0, 1), -limit, limit);
  }

  for (let pass = 0; pass < iterations; pass++) {
    for (let i = 0; i < n; i++) {
      const p = (i - 1 + n) % n, q = (i + 1) % n;
      const ax = cx[p] + rx[p] * off[p], az = cz[p] + rz[p] * off[p];
      const bx = cx[i] + rx[i] * off[i], bz = cz[i] + rz[i] * off[i];
      const dx = cx[q] + rx[q] * off[q], dz = cz[q] + rz[q] * off[q];
      // Component of (midpoint - me) along my own normal.
      const d = ((ax + dx) * 0.5 - bx) * rx[i] + ((az + dz) * 0.5 - bz) * rz[i];
      off[i] = clamp(off[i] + relax * d, -limit, limit);
    }
  }

  // Re-open the apex radius: a wide blur of the solution, blended back in.
  const blurred = gaussianBlurRing(off, Math.max(2, Math.round(9 / step)), 3);
  for (let i = 0; i < n; i++) off[i] = clamp(lerp(off[i], blurred[i], blend), -limit, limit);

  // --- late apex ----------------------------------------------------------
  // How far can we run flat out after this point? Corners that open onto a long
  // straight get their apex pushed back so the car can get on the power early.
  const straightThresh = 1 / 320;
  const runAhead = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let d = 0;
    for (let k = 1; k < n && d < 420; k++) {
      if (Math.abs(kap[(i + k) % n]) > straightThresh) break;
      d += step;
    }
    runAhead[i] = d;
  }
  const cornerMask = new Float64Array(n);
  for (let i = 0; i < n; i++) cornerMask[i] = clamp(Math.abs(kap[i]) * 220, 0, 1);
  const shiftRaw = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    // Measured a corner-length ahead so the mask covers entry, apex and exit.
    let best = 0;
    for (let k = 0; k < 40; k++) best = Math.max(best, runAhead[(i + k) % n]);
    shiftRaw[i] = clamp(best / 340, 0, 1) * cornerMask[i];
  }
  const shift = gaussianBlurRing(shiftRaw, Math.max(3, Math.round(26 / step)), 3);

  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const src = i - shift[i] * (lateShift / step);
    const f = ((src % n) + n) % n;
    const a = Math.floor(f) % n, t = f - Math.floor(f);
    out[i] = clamp(lerp(off[a], off[(a + 1) % n], t), -limit, limit);
  }
  out.limit = limit;
  return out;
}

/** Periodic box blur repeated `passes` times — a cheap Gaussian on a ring. */
function gaussianBlurRing(src, radius, passes = 2) {
  const n = src.length;
  let a = Float64Array.from(src);
  let b = new Float64Array(n);
  const w = radius * 2 + 1;
  for (let p = 0; p < passes; p++) {
    let sum = 0;
    for (let k = -radius; k <= radius; k++) sum += a[((k % n) + n) % n];
    for (let i = 0; i < n; i++) {
      b[i] = sum / w;
      sum += a[(i + radius + 1) % n] - a[((i - radius) % n + n) % n];
    }
    const t = a; a = b; b = t;
  }
  return a;
}

// ---------------------------------------------------------------------------
// 2. Speed profile
// ---------------------------------------------------------------------------

const _profileCache = new WeakMap();

/** Memoised speed profile for a circuit (built from a reference vehicle). */
export function speedProfileFor(circuit, vehicle, opts) {
  let p = _profileCache.get(circuit);
  if (!p) { p = buildSpeedProfile(circuit, vehicle, opts); _profileCache.set(circuit, p); }
  return p;
}

/**
 * Achievable speed at every circuit sample, m/s, for the ideal line.
 *
 * Longitudinal capability is taken off a friction ellipse against the lateral
 * load the corner is already asking for, so the exit of a long corner is
 * traction limited (as it should be) rather than power limited.
 *
 * @param {import('../track/circuit.js').Circuit} circuit
 * @param {Vehicle} vehicle used for its aero/grip/power configuration
 */
export function buildSpeedProfile(circuit, vehicle, o = {}) {
  const line = o.line ?? racingLineFor(circuit);
  const cfg = vehicle.cfg;
  const n = circuit.samples.length;
  const grip = o.safety ?? 0.965;           // fraction of peak the profile plans for
  const rearTraction = o.rearTraction ?? 0.66;
  const power = o.power ?? cfg.maxTorque * ((2 * Math.PI * cfg.redline * 0.80) / 60) * cfg.driveEfficiency;

  // --- geometry of the LINE (not the centreline) ---------------------------
  const px = new Float64Array(n), py = new Float64Array(n), pz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const sm = circuit.samples[i];
    px[i] = sm.position.x + sm.right.x * line[i];
    py[i] = sm.position.y;
    pz[i] = sm.position.z + sm.right.z * line[i];
  }
  const ds = new Float64Array(n);            // arc length of segment i -> i+1
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    ds[i] = Math.hypot(px[j] - px[i], pz[j] - pz[i], py[j] - py[i]) || circuit.step;
  }
  const kappa = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n, c = (i + 1) % n;
    const ab = Math.hypot(px[i] - px[a], pz[i] - pz[a]);
    const bc = Math.hypot(px[c] - px[i], pz[c] - pz[i]);
    const ca = Math.hypot(px[a] - px[c], pz[a] - pz[c]);
    const area = Math.abs((px[i] - px[a]) * (pz[c] - pz[a]) - (px[c] - px[a]) * (pz[i] - pz[a])) * 0.5;
    kappa[i] = area < 1e-7 || ab * bc * ca < 1e-7 ? 0 : (4 * area) / (ab * bc * ca);
  }
  const kSmooth = gaussianBlurRing(kappa, 3, 2);

  const dragAccel = (v, cd) => (0.5 * cfg.rho * cd * v * v) / cfg.mass;
  const totalGrip = (v) => vehicle.corneringLimit(v) * grip;

  // Terminal velocity with DRS open — the ceiling nothing may exceed.
  let vCap = o.topSpeed ?? 0;
  if (!vCap) {
    const cd = cfg.cdA * (1 - cfg.drsDragDrop);
    vCap = Math.cbrt((2 * (power + cfg.ersPowerW)) / (cfg.rho * cd));
  }

  const speeds = new Float32Array(n);

  // --- 1. quasi-steady cornering limit -------------------------------------
  for (let i = 0; i < n; i++) {
    const k = Math.max(kSmooth[i], 1e-6);
    let v = 45;
    for (let it = 0; it < 20; it++) v = Math.min(vCap, Math.sqrt(totalGrip(v) / k));
    speeds[i] = v;
  }

  // --- 2. backward pass: what can we still be doing and stop in time? -------
  for (let pass = 0; pass < 3; pass++) {
    for (let i = n - 1; i >= 0; i--) {
      const j = (i + 1) % n;
      const vNext = speeds[j];
      const vMid = (speeds[i] + vNext) * 0.5;
      const g = totalGrip(vMid);
      const lat = kSmooth[i] * vMid * vMid;
      const longAvail = Math.sqrt(Math.max(0, g * g - lat * lat));
      const a = longAvail + dragAccel(vMid, cfg.cdA);
      speeds[i] = Math.min(speeds[i], Math.sqrt(vNext * vNext + 2 * a * ds[i]));
    }
  }

  // --- 3. forward pass: traction- and power-limited acceleration ------------
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < n; i++) {
      const p = (i - 1 + n) % n;
      const vPrev = speeds[p];
      const vMid = (vPrev + speeds[i]) * 0.5;
      const g = totalGrip(vMid);
      const lat = kSmooth[p] * vMid * vMid;
      const longAvail = Math.sqrt(Math.max(0, g * g - lat * lat)) * rearTraction;
      const aPower = (power + cfg.ersPowerW * 0.5) / (cfg.mass * Math.max(vMid, 9));
      const a = Math.min(longAvail, aPower) - dragAccel(vMid, cfg.cdA);
      if (a <= 0) continue;
      speeds[i] = Math.min(speeds[i], Math.sqrt(vPrev * vPrev + 2 * a * ds[p]));
    }
  }

  speeds.line = line;
  speeds.topSpeed = vCap;
  return speeds;
}

// ---------------------------------------------------------------------------
// 3. Driver personalities
// ---------------------------------------------------------------------------

/**
 * A believable grid is not twenty copies of one lap time. Base pace is ordered
 * by seat (the entry list is in championship order) but every trait is then
 * scattered, so the fast car with the ragged driver is a real thing.
 */
function makePersona(rng, gridIndex, count) {
  const rank = count > 1 ? gridIndex / (count - 1) : 0;
  const j = () => rng() - 0.5;
  const skill = clamp(0.985 - rank * 0.055 + j() * 0.030, 0.895, 0.998);
  return {
    skill,
    // Aggression drives dive bombs, defence and how late they brake in a fight.
    aggression: clamp(0.32 + rng() * 0.62 + (0.5 - rank) * 0.12, 0.08, 0.99),
    // Consistency gates mistakes and steering noise.
    consistency: clamp(0.42 + skill * 0.55 + j() * 0.24, 0.15, 0.99),
    // Racecraft decides how cleanly they place the car when wheel to wheel.
    racecraft: clamp(0.30 + skill * 0.6 + j() * 0.3, 0.1, 0.99),
    defence: clamp(0.25 + rng() * 0.7, 0.05, 0.98),
    reaction: 0.16 + (1 - skill) * 1.6 + rng() * 0.16,
    // How much of the theoretical braking capability they actually use.
    brakeConfidence: clamp(0.795 + skill * 0.155 + j() * 0.035, 0.74, 0.965),
    // Small permanent pace offset — car performance, not driver.
    paceScale: clamp(0.988 - rank * 0.020 + j() * 0.006, 0.94, 1.0),
  };
}

// ---------------------------------------------------------------------------
// 4. The driver
// ---------------------------------------------------------------------------

const _v = new THREE.Vector3();
const _t = new THREE.Vector3();

/** Distances (m) the braking scan probes ahead. Coarse far out, fine up close. */
const BRAKE_SCAN = (() => {
  const a = [];
  for (let d = 0; d <= 60; d += 4) a.push(d);
  for (let d = 70; d <= 300; d += 10) a.push(d);
  return a;
})();

export class AIDriver {
  /**
   * @param {{vehicle:Vehicle, circuit:object, profile:Float32Array, line?:Float32Array,
   *          skill?:number, seed?:number, name?:string, entry?:object,
   *          gridIndex?:number, fieldSize?:number}} o
   */
  constructor({
    vehicle, circuit, profile, line,
    skill, seed = 1, name = 'AI', entry = null,
    gridIndex = 0, fieldSize = 20,
  }) {
    this.vehicle = vehicle;
    this.circuit = circuit;
    this.profile = profile ?? speedProfileFor(circuit, vehicle);
    this.line = line ?? this.profile.line ?? racingLineFor(circuit);
    this.name = name;
    this.entry = entry;
    this.gridIndex = gridIndex;

    this.rng = makeRng(hashSeed(`ai:${name}:${seed}`));
    this.persona = makePersona(this.rng, gridIndex, fieldSize);
    if (skill !== undefined) {
      // An explicit skill (the player's attract-mode driver) overrides the rank.
      this.persona.skill = skill;
      this.persona.brakeConfidence = clamp(0.80 + skill * 0.155, 0.74, 0.965);
      this.persona.paceScale = clamp(0.955 + skill * 0.045, 0.94, 1.0);
      this.persona.consistency = clamp(0.5 + skill * 0.5, 0.2, 0.99);
    }
    this.skill = this.persona.skill;
    this.aggression = this.persona.aggression;

    // Baselines we temporarily modify for the tow, dirty air and tyre wear.
    this.baseCdA = vehicle.cfg.cdA;
    this.baseClA = vehicle.cfg.clA;
    this.baseMu = vehicle.cfg.muBase;

    this.lineLimit = this.line.limit ?? circuit.halfWidth - CAR_HALF_WIDTH;

    // --- live state ---------------------------------------------------------
    this.time = 0;
    this.mode = 'race';                 // race | launch | recover | pitIn | pitBox | pitOut
    this.lateralBias = vehicle.trackLateral;
    this.targetLateral = this.lateralBias;
    this.tactical = 0;                  // smoothed tactical offset from the line
    this._steer = 0;
    this._throttle = 0;
    this._brake = 0;
    this.errorPhase = this.rng() * Math.PI * 2;

    this.attacking = null;
    this.defendingFrom = null;
    this.attackSide = 0;
    this.attackTimer = 0;
    this.defendSide = 0;
    this.defendTimer = 0;
    this.sideContact = 0;
    this.towStrength = 0;
    this.dirtyAir = 0;
    this.blueFlag = false;

    this.mistake = null;
    this.mistakeCooldown = 3 + this.rng() * 6;
    this.lockup = 0;

    // Tyres and strategy.
    this.compound = 'medium';
    this.tyreLife = 1;                  // 1 = new, 0 = gone
    this.stintStart = 0;
    this.pitRequested = false;
    this.pitDone = 0;
    this.lap = 1;

    // Standing start.
    this.launched = vehicle.speed > 3;
    this.launchTimer = 0;
    this.launchJump = this.rng() < 0.12 ? -0.06 : 0;   // the odd driver anticipates
    this.raceTime = 0;

    this._pit = null;
  }

  // -- sampling helpers -----------------------------------------------------

  /** Interpolated planned speed at arc length `s`, before personal scaling. */
  rawSpeedAt(s) {
    const p = this.profile, n = p.length, st = this.circuit.step;
    const f = this.circuit.wrapS(s) / st;
    const i = Math.floor(f) % n;
    return lerp(p[i], p[(i + 1) % n], f - Math.floor(f));
  }

  /** Interpolated racing-line lateral offset at arc length `s`. */
  lineAt(s) {
    const l = this.line, n = l.length, st = this.circuit.step;
    const f = this.circuit.wrapS(s) / st;
    const i = Math.floor(f) % n;
    return lerp(l[i], l[(i + 1) % n], f - Math.floor(f));
  }

  /** Everything that scales this driver's pace right now. */
  get paceScale() {
    const p = this.persona;
    const wear = 1 - this.tyreLife;
    return p.paceScale * COMPOUNDS[this.compound].pace * (1 - wear * 0.034) * (this.blueFlag ? 0.93 : 1);
  }

  /** Peak deceleration the car can produce at `v`, m/s^2 (grip + drag). */
  brakeCapacity(v) {
    const cfg = this.vehicle.cfg;
    return this.vehicle.corneringLimit(v) * 0.97 + (0.5 * cfg.rho * cfg.cdA * v * v) / cfg.mass;
  }

  targetSpeedAt(s) { return this.rawSpeedAt(s) * this.paceScale; }

  // -- main update ----------------------------------------------------------

  /**
   * @param {number} dt fixed step
   * @param {Array} rivals `Vehicle[]` or `field.cars[]` (the latter enables blue flags)
   */
  update(dt, rivals) {
    const veh = this.vehicle;
    const circuit = this.circuit;
    this.time += dt;

    if (this.mode === 'pitIn' || this.mode === 'pitBox' || this.mode === 'pitOut') return;

    const s = veh.trackS;
    const speed = veh.speed;
    const hw = circuit.halfWidth;

    this._updateTyres(dt);

    // --- standing start ------------------------------------------------------
    if (!this.launched) {
      if (speed > 7) this.launched = true;
      else { this._launch(dt); return; }
    }
    this.raceTime += dt;

    // --- read the field ------------------------------------------------------
    const ctx = this._scanRivals(rivals, s, speed);

    // --- aerodynamic interaction --------------------------------------------
    // A tow is worth real top speed; dirty air costs front-end grip, which is
    // why the following car struggles in the corner before the straight.
    // THESE TWO ARE FOR DECISIONS, NOT FOR PHYSICS. `engine.step` now calls
    // `applyWakes` for the whole field, and `vehicle._aero` applies
    // `cfg.slipstreamDrag * wake.tow` (0.30 — the same coefficient this used to
    // write by hand) and `cfg.dirtyAirDownforce * wake.dirty`. Writing
    // `cfg.cdA` / `cfg.clA` here as well multiplied the effect a second time for
    // the nineteen AI cars and left the player, who has no AIDriver, with none
    // of it. The smoothed values stay because `_overtakeOffset` and the DRS
    // decision read them; the config is no longer touched.
    this.towStrength = lerp(this.towStrength, ctx.tow, 1 - Math.exp(-dt * 4));
    this.dirtyAir = lerp(this.dirtyAir, ctx.dirty, 1 - Math.exp(-dt * 5));

    // --- mistakes ------------------------------------------------------------
    this._updateMistakes(dt, ctx);

    // --- off-track recovery --------------------------------------------------
    const absLat = Math.abs(veh.trackLateral);
    if (this.mode !== 'recover' && absLat > hw + 1.9) this.mode = 'recover';
    if (this.mode === 'recover' && absLat < hw - 0.6 && Math.abs(veh.slipAngle[2]) < 0.14) this.mode = 'race';

    // --- lateral objective ---------------------------------------------------
    const lookahead = clamp(6.5 + speed * 0.40, 8.5, 36);
    let tactical = 0;
    let limit = this.lineLimit;

    if (this.mode === 'recover') {
      // Rejoin at a shallow angle, never straight back across the racing line.
      tactical = Math.sign(veh.trackLateral || 1) * (hw - 2.2) - this.lineAt(s + lookahead);
      limit = hw + 6;
    } else {
      tactical += ctx.avoidLateral;
      tactical += this._overtakeOffset(dt, ctx, s);
      tactical += this._defendOffset(dt, ctx, s);
      if (this.blueFlag) tactical += -Math.sign(this.lineAt(s + 40) || 1) * 2.6;
      if (this.mistake?.type === 'wide') tactical += this.mistake.side * 3.0 * this.mistake.strength;
    }

    this.tactical = lerp(this.tactical, tactical, 1 - Math.exp(-dt * 5.5));
    const base = this.lineAt(s + lookahead);
    this.targetLateral = clamp(base + this.tactical, -limit, limit);
    this.lateralBias = lerp(this.lateralBias, this.targetLateral, 1 - Math.exp(-dt * 8));

    // --- pure pursuit steering -----------------------------------------------
    // delta = atan(2 L sin(alpha) / Ld). An ad-hoc proportional gain oscillates,
    // and an oscillating AI generates slip angles (and a screen of tyre smoke).
    circuit.pointAt(s + lookahead, this.lateralBias, 0, _v);
    _t.subVectors(_v, veh.position);
    const cy = Math.cos(veh.yaw), sy = Math.sin(veh.yaw);
    const localX = _t.x * cy - _t.z * sy;          // dot with right = (cos, 0, -sin)
    const localZ = Math.max(1, -_t.x * sy - _t.z * cy);
    const alpha = Math.atan2(localX, localZ);
    const Ld = Math.max(5, Math.hypot(localX, localZ));
    let delta = Math.atan2(2 * veh.cfg.wheelbase * Math.sin(alpha), Ld);

    // Yaw-rate damping: catch the slide instead of chasing the target through it.
    const rDesired = -(veh.u * Math.tan(delta)) / veh.cfg.wheelbase;
    delta += clamp((veh.yawRate - rDesired) * 0.055, -0.06, 0.06);

    const speedFactor = 1 - veh.cfg.steerSpeedFalloff * clamp(speed / 85, 0, 1);
    const noise = Math.sin(this.time * 1.9 + this.errorPhase) * (1 - this.persona.consistency) * 0.09;
    const snap = this.mistake?.type === 'snap' ? Math.sin(this.time * 17) * 0.22 * this.mistake.strength : 0;
    const raw = clamp(delta / Math.max(0.05, veh.cfg.maxSteerAngle * speedFactor) + noise + snap, -1, 1);
    this._steer = lerp(this._steer, raw, 1 - Math.exp(-dt * 16));

    // --- longitudinal control -------------------------------------------------
    const { throttle, brake } = this._pedals(dt, s, speed, ctx);

    // --- DRS ------------------------------------------------------------------
    const zone = circuit.drsZoneAt(s);
    veh.drsAvailable = !!zone && ctx.gapAheadTime > 0 && ctx.gapAheadTime < 1.0;
    veh.drsActive = veh.drsAvailable && speed > 42 && this._brake < 0.05;

    veh.setControls({ steer: this._steer, throttle, brake, autoGearbox: true });
  }

  // -- longitudinal ---------------------------------------------------------

  _pedals(dt, s, speed, ctx) {
    const veh = this.vehicle;
    const p = this.persona;

    // Predictive braking: the tightest speed we could still be doing now and
    // make every point ahead. Confidence is what shifts the braking point, and
    // a little per-corner noise is what makes two laps look different.
    const conf = p.brakeConfidence * (1 + this.attackTimer * 0.10 * p.aggression)
      * (1 + Math.sin(s * 0.011 + this.errorPhase) * (1 - p.consistency) * 0.035);
    let vLimit = Infinity;
    for (let i = 0; i < BRAKE_SCAN.length; i++) {
      const d = BRAKE_SCAN[i];
      // A little slack at the car's own position: a tow or DRS can legitimately
      // push it past the planned speed on a straight and that is not a mistake.
      const vProfile = this.targetSpeedAt(s + d + speed * 0.05) * (d === 0 ? 1.06 : 1);
      if (vProfile >= speed && d > 0) continue;
      const aB = this.brakeCapacity((speed + vProfile) * 0.5) * conf;
      const v = Math.sqrt(vProfile * vProfile + 2 * aB * d);
      if (v < vLimit) vLimit = v;
    }
    if (!isFinite(vLimit)) vLimit = this.targetSpeedAt(s + 10);

    // Traffic: never plan to arrive faster than the car in front is going.
    if (ctx.aheadClose) vLimit = Math.min(vLimit, ctx.aheadSpeedLimit);
    if (this.mode === 'recover') vLimit = Math.min(vLimit, 26 + this.tyreLife * 6);
    if (this.blueFlag) vLimit *= 0.94;

    const err = vLimit - speed;
    let throttle = 0, brake = 0;
    if (err > 0.15) {
      throttle = clamp(err * 0.42 + 0.10, 0, 1);
    } else {
      brake = clamp(-err * 0.20, 0, 1);
      // Trail braking: bleed off as the corner loads up the front tyres.
      brake *= clamp(1.15 - Math.abs(veh.gLat) * 0.30, 0.25, 1);
    }
    if (this.mistake?.type === 'lockup') {
      brake = clamp(brake + 0.55 * this.mistake.strength, 0, 1);
      throttle = 0;
    }

    // Friction ellipse on the exit: what the fronts are using laterally is not
    // available to the rears longitudinally. This is what stops an AI spinning
    // itself out of every slow corner.
    const capacity = Math.max(6, veh.corneringLimit(speed));
    const latUse = clamp((Math.abs(veh.gLat) * 9.81) / capacity, 0, 1);
    const tractionCap = clamp(Math.sqrt(Math.max(0.03, 1 - latUse * latUse)) * (1.06 + p.skill * 0.22), 0.14, 1);
    throttle = Math.min(throttle, tractionCap);

    // Explicit wheelspin control on top of the car's own TC.
    const rearSlip = (veh.slipRatio[2] + veh.slipRatio[3]) * 0.5;
    if (rearSlip > 0.16) throttle *= clamp(1 - (rearSlip - 0.16) * 2.2, 0.25, 1);

    if (brake > 0.04) throttle = 0;
    if (!veh.onTrack && this.mode !== 'recover') throttle *= 0.6;

    this._throttle = lerp(this._throttle, throttle, 1 - Math.exp(-dt * 22));
    this._brake = lerp(this._brake, brake, 1 - Math.exp(-dt * 26));
    return { throttle: this._throttle, brake: this._brake };
  }

  // -- racecraft ------------------------------------------------------------

  /**
   * One pass over the field producing everything the driver needs to know:
   * the car it is attacking, the car attacking it, aero interaction and the
   * lateral avoidance it must apply right now.
   */
  _scanRivals(rivals, s, speed) {
    const circuit = this.circuit;
    const veh = this.vehicle;
    const myLat = veh.trackLateral;
    const ctx = {
      ahead: null, aheadGap: Infinity, aheadLat: 0, aheadSpeed: 0,
      behind: null, behindGap: Infinity, behindLat: 0, behindSpeed: 0,
      gapAheadTime: 0, aheadClose: false, aheadSpeedLimit: Infinity,
      avoidLateral: 0, sideBlocked: 0, tow: 0, dirty: 0, pressure: 0,
    };
    this.attacking = null;
    this.defendingFrom = null;
    this.blueFlag = false;
    if (!rivals) return ctx;

    const L = circuit.length;
    let sidePush = 0;

    for (let i = 0; i < rivals.length; i++) {
      const car = rivals[i];
      const r = car.vehicle ?? car;
      if (r === veh) continue;
      let ds = r.trackS - s;
      if (ds > L * 0.5) ds -= L; else if (ds < -L * 0.5) ds += L;
      if (Math.abs(ds) > 90) continue;
      const dLat = r.trackLateral - myLat;

      if (ds > 0) {
        if (ds < ctx.aheadGap) {
          ctx.aheadGap = ds; ctx.ahead = r; ctx.aheadLat = r.trackLateral; ctx.aheadSpeed = r.speed;
        }
        // Tow only counts when we are genuinely in the wake.
        if (Math.abs(dLat) < 2.8) {
          ctx.tow = Math.max(ctx.tow, clamp((55 - ds) / 48, 0, 1));
          ctx.dirty = Math.max(ctx.dirty, clamp((26 - ds) / 24, 0, 1));
        }
      } else if (ds < 0) {
        const gap = -ds;
        if (gap < ctx.behindGap) {
          ctx.behindGap = gap; ctx.behind = r; ctx.behindLat = r.trackLateral; ctx.behindSpeed = r.speed;
        }
        if (car.distance !== undefined && this.distance !== undefined
            && car.distance - this.distance > L * 0.75 && gap < 60) {
          this.blueFlag = true;
        }
      }

      // Wheel-to-wheel: keep a car's width. The closer the overlap the harder
      // the push, so two cars settle side by side instead of merging.
      const overlap = 1 - clamp((Math.abs(ds) - 2.0) / 4.2, 0, 1);
      if (overlap > 0 && Math.abs(dLat) < 3.6) {
        const room = clamp(1 - Math.abs(dLat) / 3.6, 0, 1);
        sidePush -= Math.sign(dLat || (this.rng() - 0.5)) * room * overlap * 3.2;
        ctx.sideBlocked = Math.max(ctx.sideBlocked, room * overlap);
      }
    }

    // Nose-to-tail avoidance: slot off line rather than driving into the gearbox.
    if (ctx.ahead && ctx.aheadGap < 24) {
      const dLat = ctx.aheadLat - myLat;
      const closing = speed - ctx.aheadSpeed;
      if (Math.abs(dLat) < 2.6) {
        const urgency = clamp((24 - ctx.aheadGap) / 24, 0, 1);
        // Pick the side with more road, biased by which way the track goes next.
        const kAhead = circuit.curvatureAt(s + 55);
        const preferred = Math.abs(kAhead) > 0.0022 ? Math.sign(kAhead) : (ctx.aheadLat > 0 ? -1 : 1);
        sidePush += preferred * urgency * 2.4;
        if (closing > 1.0 && ctx.aheadGap < 12) {
          ctx.aheadClose = true;
          ctx.aheadSpeedLimit = ctx.aheadSpeed + clamp((ctx.aheadGap - 5.5) * 1.5, -6, 14);
        }
      }
      ctx.gapAheadTime = ctx.aheadGap / Math.max(20, speed);
    } else if (ctx.ahead) {
      ctx.gapAheadTime = ctx.aheadGap / Math.max(20, speed);
    }

    ctx.avoidLateral = clamp(sidePush, -4.5, 4.5);
    ctx.pressure = ctx.behind ? clamp(1 - ctx.behindGap / 30, 0, 1) : 0;
    return ctx;
  }

  /** Lateral offset the driver wants in order to get past the car in front. */
  _overtakeOffset(dt, ctx, s) {
    const p = this.persona;
    if (!ctx.ahead || ctx.aheadGap > 34) {
      this.attackTimer = Math.max(0, this.attackTimer - dt * 1.5);
      if (this.attackTimer <= 0) this.attackSide = 0;
      return this.attackSide * this.attackTimer * 2.2;
    }

    const speed = this.vehicle.speed;
    const closing = speed - ctx.aheadSpeed;
    const paceEdge = closing > -1.0 || this.towStrength > 0.35;
    if (!paceEdge) {
      this.attackTimer = Math.max(0, this.attackTimer - dt);
      return this.attackSide * this.attackTimer * 2.2;
    }

    this.attacking = ctx.ahead;
    this.attackTimer = Math.min(1, this.attackTimer + dt * 1.8);

    if (this.attackSide === 0) {
      // Inside for the next corner if there is one worth having, otherwise the
      // side of the road the leading car has left open.
      const kAhead = this.circuit.curvatureAt(s + clamp(speed * 1.6, 40, 140));
      const inside = Math.abs(kAhead) > 0.0025 ? Math.sign(kAhead) : 0;
      const open = ctx.aheadLat > 0 ? -1 : 1;
      this.attackSide = inside && this.rng() < 0.35 + p.aggression * 0.55 ? inside : open;
    }

    // Dive bomb: brave enough, close enough, and a braking zone coming up.
    const diving = ctx.aheadGap < 16 && p.aggression > 0.55 && this.targetSpeedAt(s + 70) < speed * 0.82;
    const width = (diving ? 3.3 : 2.7) + p.aggression * 0.5;
    const desired = ctx.aheadLat + this.attackSide * width;
    return (desired - this.lineAt(s + 12)) * this.attackTimer * clamp(0.55 + p.racecraft * 0.6, 0, 1.2);
  }

  /** One decisive move to cover the inside, then hold it. */
  _defendOffset(dt, ctx, s) {
    const p = this.persona;
    if (!ctx.behind || ctx.behindGap > 22 || this.blueFlag) {
      this.defendTimer = Math.max(0, this.defendTimer - dt * 1.2);
      if (this.defendTimer <= 0) this.defendSide = 0;
      return this.defendSide * this.defendTimer * 2.0;
    }
    this.defendingFrom = ctx.behind;
    const threat = ctx.behindSpeed > this.vehicle.speed - 1.5;
    if (!threat) { this.defendTimer = Math.max(0, this.defendTimer - dt); return this.defendSide * this.defendTimer * 2.0; }

    this.defendTimer = Math.min(1, this.defendTimer + dt * 1.4);
    if (this.defendSide === 0) {
      const kAhead = this.circuit.curvatureAt(s + clamp(this.vehicle.speed * 1.5, 40, 130));
      // Cover the inside; if the track is straight, cover the side they are on.
      this.defendSide = Math.abs(kAhead) > 0.0025 ? Math.sign(kAhead) : Math.sign(ctx.behindLat - this.vehicle.trackLateral) || 1;
    }
    return this.defendSide * (0.9 + p.defence * 1.9) * this.defendTimer;
  }

  // -- fallibility ----------------------------------------------------------

  _updateMistakes(dt, ctx) {
    if (this.mistake) {
      this.mistake.t -= dt;
      this.mistake.strength = clamp(this.mistake.t / this.mistake.duration, 0, 1);
      if (this.mistake.t <= 0) { this.mistake = null; this.mistakeCooldown = 5 + this.rng() * 12; }
      return;
    }
    this.mistakeCooldown -= dt;
    if (this.mistakeCooldown > 0) return;

    const p = this.persona;
    const wear = 1 - this.tyreLife;
    const rate = (1 - p.consistency) * 0.11 + ctx.pressure * 0.07 + wear * 0.06 + this.attackTimer * 0.05;
    if (this.rng() > rate * dt * 60 * 0.016) return;

    const braking = this._brake > 0.35;
    const roll = this.rng();
    const type = braking ? (roll < 0.7 ? 'lockup' : 'wide') : (roll < 0.45 ? 'wide' : 'snap');
    const duration = type === 'lockup' ? 0.35 + this.rng() * 0.4 : 0.7 + this.rng() * 0.9;
    this.mistake = {
      type, duration, t: duration, strength: 1,
      side: this.rng() < 0.5 ? -1 : 1,
    };
    if (type === 'lockup') this.lockup = 1;
  }

  // -- tyres and strategy ---------------------------------------------------

  _updateTyres(dt) {
    const veh = this.vehicle;
    const load = clamp(Math.abs(veh.gLat) * 0.5 + Math.abs(veh.gLong) * 0.22, 0, 2.2);
    const rate = (0.35 + load) / COMPOUNDS[this.compound].life;
    this.tyreLife = clamp(this.tyreLife - rate * dt, 0.12, 1);
    // Wear is not just lap time: the peak the tyre can deliver actually falls.
    veh.cfg.muBase = this.baseMu * (1 - (1 - this.tyreLife) * 0.075);
  }

  /** Called by the field when a car crosses the line. */
  onLapComplete(lap) {
    this.lap = lap;
    if (!this.pitRequested && this.tyreLife < 0.42 + this.rng() * 0.12) this.pitRequested = true;
  }

  fitTyres(compound) {
    this.compound = compound;
    this.tyreLife = 1;
    this.pitRequested = false;
    this.pitDone++;
    this.vehicle.cfg.muBase = this.baseMu;
  }

  // -- standing start -------------------------------------------------------

  /**
   * Lights out. Reaction time is a personality trait, the clutch bite is a ramp,
   * and full throttle in first gear does the rest — the wheelspin is real.
   */
  _launch(dt) {
    const veh = this.vehicle;
    this.launchTimer += dt;
    const go = this.persona.reaction + this.launchJump + this.gridIndex * 0.012;

    const s = veh.trackS;
    const target = this.lineAt(s + 14) * 0.35 + veh.trackLateral * 0.65;
    this.lateralBias = lerp(this.lateralBias, target, 1 - Math.exp(-dt * 4));
    this.circuit.pointAt(s + 16, this.lateralBias, 0, _v);
    _t.subVectors(_v, veh.position);
    const cy = Math.cos(veh.yaw), sy = Math.sin(veh.yaw);
    const localX = _t.x * cy - _t.z * sy;
    const localZ = Math.max(1, -_t.x * sy - _t.z * cy);
    const delta = Math.atan2(2 * veh.cfg.wheelbase * Math.sin(Math.atan2(localX, localZ)), Math.max(6, Math.hypot(localX, localZ)));
    const steer = clamp(delta / veh.cfg.maxSteerAngle, -1, 1);

    if (this.launchTimer < go) {
      veh.setControls({ steer, throttle: 0.30, brake: 0.9, autoGearbox: true });
      return;
    }
    // Bite point, then progressively more torque as the tyres take it.
    const t = this.launchTimer - go;
    const throttle = clamp(0.62 + t * (1.4 + this.persona.skill), 0, 1);
    this._throttle = throttle;
    veh.setControls({ steer, throttle, brake: 0, autoGearbox: true });
  }
}

// ---------------------------------------------------------------------------
// 5. The field
// ---------------------------------------------------------------------------

/** Collision proxy: three oriented spheres down the car's centreline. */
const HULL = [
  { z: -2.05, r: 0.74 },
  { z: -0.15, r: 1.00 },
  { z: 1.80, r: 1.00 },
];

const _pa = new THREE.Vector3();
const _pb = new THREE.Vector3();

export class OpponentField {
  /**
   * @param {{circuit:object, scene:THREE.Object3D, entries:Array,
   *          playerIndex?:number, detail?:string, compounds?:boolean}} o
   */
  constructor({ circuit, scene, entries, playerIndex = 0, detail = 'low' }) {
    this.circuit = circuit;
    this.scene = scene;
    this.cars = [];
    this.playerIndex = playerIndex;
    this.time = 0;
    this.drsEnabled = true;

    const probe = new Vehicle({ circuit });
    this.line = racingLineFor(circuit);
    this.profile = speedProfileFor(circuit, probe, { line: this.line });

    // A believable strategy spread: the sharp end starts on the quick tyre.
    const startCompound = (i) => (i < 8 ? 'soft' : i < 16 ? 'medium' : 'hard');

    entries.forEach((entry, i) => {
      const vehicle = new Vehicle({ circuit, id: i });
      const slot = circuit.gridSlot(i);
      vehicle.reset({ s: slot.s, lateral: slot.lateral });

      const model = createCarModel(entry, {
        liveryTexture: buildLiveryTexture(entry.team, entry.driver),
        detail: i === playerIndex ? 'high' : detail,
      });
      scene.add(model.group);

      // The player's car is driven by the engine (human input or attract mode),
      // so it deliberately has no AI of its own.
      const ai = i === playerIndex ? null : new AIDriver({
        vehicle, circuit, profile: this.profile, line: this.line,
        seed: i, name: entry.driver.code, entry,
        gridIndex: i, fieldSize: entries.length,
      });
      const compound = startCompound(i);
      if (ai) { ai.compound = compound; ai.distance = 0; }
      model.wheels.setCompound(compound);

      this.cars.push({
        entry, vehicle, model, ai, index: i,
        distance: 0, lastS: vehicle.trackS, lap: 1, position: i + 1,
        inPit: false, compound,
      });
    });
  }

  get player() { return this.cars[this.playerIndex]; }

  /** Put the whole field back on the grid, ready for a real standing start. */
  armGridStart() {
    for (const c of this.cars) {
      const slot = this.circuit.gridSlot(c.index);
      c.vehicle.reset({ s: slot.s, lateral: slot.lateral, speed: 0 });
      c.distance = 0; c.lastS = c.vehicle.trackS; c.lap = 1; c.inPit = false;
      if (c.ai) { c.ai.launched = false; c.ai.launchTimer = 0; c.ai.mode = 'race'; }
    }
  }

  update(dt) {
    this.time += dt;
    const cars = this.cars;

    for (let i = 0; i < cars.length; i++) {
      const c = cars[i];
      const ai = c.ai;
      if (ai) {
        ai.distance = c.distance;
        if (c.inPit) { this._stepPit(c, dt); continue; }
        ai.update(dt, cars);
      }
      c.vehicle.step(dt);
    }

    this._separate();
    this._trackProgress(dt);
  }

  /** Lap counting (also what blue flags and pit windows key off). */
  _trackProgress() {
    const L = this.circuit.length;
    for (const c of this.cars) {
      const s = c.vehicle.trackS;
      let ds = s - c.lastS;
      if (ds < -L * 0.5) ds += L; else if (ds > L * 0.5) ds -= L;
      c.distance += ds;
      c.lastS = s;
      const lap = Math.floor(c.distance / L) + 1;
      if (lap !== c.lap) {
        c.lap = lap;
        c.ai?.onLapComplete(lap);
        if (c.ai?.pitRequested && !c.inPit) this._enterPit(c);
      }
    }
    const order = [...this.cars].sort((a, b) => b.distance - a.distance);
    order.forEach((c, i) => { c.position = i + 1; });
  }

  // -- pit lane -------------------------------------------------------------

  /**
   * Pit stops run kinematically. The pit lane sits ~11 m outside the racing
   * surface, where the tyre model would see gravel-grade grip and the car would
   * simply stop — so for the length of the stop the field drives the car along
   * the lane itself and hands it back to physics at the exit.
   */
  _enterPit(car) {
    const hw = this.circuit.halfWidth;
    const laneLat = -(hw + 8.5);
    const boxIndex = Math.floor(car.index / 2);
    car.inPit = true;
    car.ai.mode = 'pitIn';
    car.ai._pit = {
      phase: 'in',
      s: car.vehicle.trackS,
      lat: car.vehicle.trackLateral,
      laneLat,
      entryS: this.circuit.wrapS(-330),
      boxS: this.circuit.wrapS(-150 + boxIndex * 15),
      exitS: this.circuit.wrapS(210),
      speed: Math.max(car.vehicle.speed, 20),
      hold: 2.2 + car.ai.rng() * 1.1,
      next: car.ai.tyreLife < 0.5 && car.lap > 6 ? 'soft' : 'medium',
    };
  }

  _stepPit(car, dt) {
    const veh = car.vehicle;
    const ai = car.ai;
    const pit = ai._pit;
    const c = this.circuit;
    const LIMIT = 22.2;   // 80 km/h

    const distTo = (target) => {
      let d = target - pit.s;
      const L = c.length;
      if (d < -L * 0.5) d += L; else if (d > L * 0.5) d -= L;
      return d;
    };

    if (pit.phase === 'in') {
      const d = distTo(pit.entryS);
      pit.speed = lerp(pit.speed, d > 40 ? Math.max(LIMIT, 45) : LIMIT, 1 - Math.exp(-dt * 1.6));
      pit.lat = lerp(pit.lat, pit.laneLat, 1 - Math.exp(-dt * (d > 40 ? 0.5 : 1.6)));
      if (distTo(pit.boxS) < 6) pit.phase = 'brake';
    } else if (pit.phase === 'brake') {
      pit.speed = Math.max(0, pit.speed - 14 * dt);
      pit.lat = lerp(pit.lat, pit.laneLat + 1.6, 1 - Math.exp(-dt * 3));
      if (pit.speed <= 0.05) { pit.phase = 'stop'; ai.mode = 'pitBox'; }
    } else if (pit.phase === 'stop') {
      pit.speed = 0;
      pit.hold -= dt;
      if (pit.hold <= 0) {
        ai.fitTyres(pit.next);
        car.compound = pit.next;
        car.model.wheels.setCompound(pit.next);
        pit.phase = 'out';
        ai.mode = 'pitOut';
      }
    } else {
      pit.speed = Math.min(LIMIT, pit.speed + 9 * dt);
      pit.lat = lerp(pit.lat, pit.laneLat, 1 - Math.exp(-dt * 2));
      if (distTo(pit.exitS) < 0) {
        // Hand back to physics on the inside line, at the lane's speed.
        car.inPit = false;
        ai.mode = 'race';
        ai._pit = null;
        veh.reset({ s: pit.s, lateral: -(c.halfWidth - 1.8), speed: LIMIT });
        ai.launched = true;
        return;
      }
    }

    pit.s = c.wrapS(pit.s + pit.speed * dt);
    const sm = c.sampleAt(pit.s);
    c.pointAt(pit.s, pit.lat, 0, veh.position);
    veh.yaw = Math.atan2(-sm.tangent.x, -sm.tangent.z);
    veh.u = pit.speed;
    veh.v = 0;
    veh.yawRate = 0;
    veh.trackS = pit.s;
    veh.trackLateral = pit.lat;
    veh.quaternion.setFromEuler(new THREE.Euler(0, veh.yaw, 0, 'YXZ'));
    for (let i = 0; i < 4; i++) {
      veh.wheelOmega[i] = pit.speed / veh.cfg.wheelRadius;
      veh.wheelSpin[i] += veh.wheelOmega[i] * dt;
    }
    veh.controls.throttle = pit.speed > 1 ? 0.25 : 0;
    veh.controls.brake = pit.phase === 'brake' ? 0.8 : 0;
    veh._updateTelemetry?.();
  }

  // -- contact --------------------------------------------------------------

  /**
   * Oriented three-sphere hulls, positional de-penetration plus a restitution
   * impulse and a yaw kick from the contact arm. Rubbing wheels should cost you
   * time and unsettle the car, not teleport it.
   */
  _separate() {
    const cars = this.cars;
    for (let i = 0; i < cars.length; i++) {
      const A = cars[i].vehicle;
      if (cars[i].inPit) continue;
      const ca = Math.cos(A.yaw), sa = Math.sin(A.yaw);
      for (let j = i + 1; j < cars.length; j++) {
        const B = cars[j].vehicle;
        if (cars[j].inPit) continue;
        const dxc = B.position.x - A.position.x, dzc = B.position.z - A.position.z;
        if (dxc * dxc + dzc * dzc > 64) continue;      // 8 m broad phase
        const cb = Math.cos(B.yaw), sb = Math.sin(B.yaw);

        for (let m = 0; m < HULL.length; m++) {
          const hm = HULL[m];
          // Body-local +Z points backwards, so the local Z axis is (sin y, 0, cos y).
          _pa.set(A.position.x + sa * hm.z, 0, A.position.z + ca * hm.z);
          for (let k = 0; k < HULL.length; k++) {
            const hk = HULL[k];
            _pb.set(B.position.x + sb * hk.z, 0, B.position.z + cb * hk.z);
            const dx = _pb.x - _pa.x, dz = _pb.z - _pa.z;
            const d2 = dx * dx + dz * dz;
            const minD = hm.r + hk.r;
            if (d2 > minD * minD || d2 < 1e-8) continue;

            const d = Math.sqrt(d2);
            const nx = dx / d, nz = dz / d;
            const push = (minD - d) * 0.5;
            A.position.x -= nx * push; A.position.z -= nz * push;
            B.position.x += nx * push; B.position.z += nz * push;

            // World velocities -> normal impulse -> back into body axes.
            const avx = -sa * A.u + ca * A.v, avz = -ca * A.u - sa * A.v;
            const bvx = -sb * B.u + cb * B.v, bvz = -cb * B.u - sb * B.v;
            const vn = (bvx - avx) * nx + (bvz - avz) * nz;
            if (vn < 0) {
              const jimp = -(1.15) * vn * 0.5;
              const ax = avx - nx * jimp, az = avz - nz * jimp;
              const bx = bvx + nx * jimp, bz = bvz + nz * jimp;
              A.u = -sa * ax - ca * az; A.v = ca * ax - sa * az;
              B.u = -sb * bx - cb * bz; B.v = cb * bx - sb * bz;
              // Contact arm x lateral impulse. `UPSET` stands in for the full
              // m/I ratio (~0.84) — the honest value spins a car off a light
              // rub, which is not what wheel banging looks like on TV.
              const UPSET = 0.16;
              A.yawRate -= hm.z * jimp * (nx * ca - nz * sa) * UPSET;
              B.yawRate += hk.z * jimp * (nx * cb - nz * sb) * UPSET;
            }
            // Scrubbing tyres cost speed.
            A.u *= 0.994; B.u *= 0.994;
          }
        }
      }
    }
  }

  // -- presentation ---------------------------------------------------------

  /** Copy physics poses onto the models. Call once per RENDER frame. */
  syncModels() {
    for (const c of this.cars) {
      const v = c.vehicle;
      const m = c.model;
      m.group.position.copy(v.position);
      m.group.quaternion.copy(v.quaternion);
      m.setSteer(v.steerAngle());
      m.setWheelSpin(v.wheelSpin);
      m.setSuspension(v.suspension);
      m.setDRS(v.drsBlend);
      const heat = clamp((Math.max(v.brakeTemp[0], v.brakeTemp[1], v.brakeTemp[2], v.brakeTemp[3]) - 430) / 600, 0, 1);
      m.materials.setBrakeHeat(heat);
    }
  }

  dispose() {
    for (const c of this.cars) { this.scene.remove(c.model.group); c.model.dispose(); }
  }
}
