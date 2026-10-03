/**
 * APEX GP — vehicle dynamics.
 *
 * A planar rigid body (surge / sway / yaw) coupled to a real vertical model
 * (heave / pitch / roll of the sprung mass over four unsprung masses on spring,
 * damper, anti-roll bar and tyre-carcass rates), driven by Pacejka Magic-Formula
 * tyres with combined slip, a ground-effect aero map, a fuel-flow-limited 1.6 V6
 * turbo hybrid, an 8-speed sequential box, a clutch-pack limited-slip diff,
 * carbon brakes with temperature-dependent torque, and tyre thermal / wear /
 * pressure state.
 *
 * INTEGRATION
 *   `step(dt)` is called at the sim rate (1/60) and internally substeps at a
 *   fixed 240 Hz. Damper and tyre-carcass forces — the two stiff terms — are
 *   integrated with implicit damping so the vertical model cannot ring or
 *   explode no matter how hard the car hits a kerb.
 *
 * FRAME (matches car/chassis.js)
 *   F = forward = (-sin psi, 0, -cos psi)   R = right = (cos psi, 0, -sin psi)
 *   u = velocity along F, v = velocity along R, r = yaw rate (+ve = LEFT)
 *   steer angle delta > 0 turns the wheels to the RIGHT
 *   wheel order is ALWAYS [FL, FR, RL, RR]
 *
 *   `vehicle.position` is the MODEL origin (what the renderer consumes). The
 *   dynamics run at the real centre of gravity, which sits `cgBehind` metres
 *   further back so the car carries a proper 45/55 rearward weight split while
 *   the chassis mesh stays where chassis.js put it.
 *
 * PUBLIC API
 *   new Vehicle({ circuit, config, id })
 *   vehicle.reset({ s, lateral, speed })
 *   vehicle.setControls({steer, throttle, brake, drs, ers, shiftUp, shiftDown, autoGearbox})
 *   vehicle.setAssists({ traction, abs, stability })
 *   vehicle.setSetup({ ... })              live suspension / aero / diff tuning
 *   vehicle.step(dt)
 *   vehicle.pose        { position, quaternion }
 *   vehicle.telemetry   see _updateTelemetry()
 *   vehicle.corneringLimit(speed)          peak lateral m/s^2 (AI speed profile)
 *   vehicle.surfaceProbe = (worldPos) => ({ grip, drag })     injected by the game
 *   vehicle.wake        { dirty, tow, gap } written by applyWakes()
 *   applyWakes(cars, circuit)              dirty air / slipstream for the field
 *   DEFAULT_CONFIG
 */

import * as THREE from 'three';
import { clamp, lerp, makeRng, hashSeed } from '../core/rng.js';

const G = 9.81;

export const DEFAULT_CONFIG = {
  // ---- mass and geometry ---------------------------------------------------
  mass: 852,               // kg, car + driver + mid-stint fuel
  unsprungPerCorner: 20,   // kg — wheel, tyre, upright, brake, half the links
  inertiaYaw: 1150,        // kg m^2
  inertiaPitch: 900,
  inertiaRoll: 112,
  wheelbase: 3.60,
  frontAxle: 1.62,         // model origin -> front axle (chassis.js geometry)
  rearAxle: 1.98,          // model origin -> rear axle
  cgBehind: 0.36,          // CG sits this far behind the model origin -> 45/55
  trackFront: 1.62,
  trackRear: 1.56,
  cgHeight: 0.285,
  rollCentreFront: 0.030,  // very low, as on a real F1 car
  rollCentreRear: 0.065,
  antiDive: 0.22,          // fraction of front load transfer taken by the links
  antiSquat: 0.32,
  wheelRadius: 0.360,      // unloaded
  wheelInertia: 1.45,      // kg m^2 incl. disc, upright and driveshaft share

  // ---- aerodynamics --------------------------------------------------------
  // F = 0.5 rho C v^2. clA ~ 4.9 / cdA ~ 1.28 gives ~5 g at 300 km/h and a
  // ~335 km/h terminal speed on the available power — both F1-realistic.
  rho: 1.225,
  clA: 4.90,
  cdA: 1.28,
  aeroBalance: 0.445,      // fraction of downforce carried by the front axle
  rideHeightFront: 0.028,  // static, metres (plank to road)
  rideHeightRear: 0.078,
  groundEffectGain: 0.42,  // extra clA as the floor is sealed to the road
  groundEffectScale: 0.055,
  floorStallHeight: 0.010, // below this the floor stalls and downforce collapses
  rakeBalanceGain: 1.30,   // aero balance shift per metre of rake change
  drsDragDrop: 0.235,
  drsDownforceDrop: 0.205,
  drsBalanceShift: 0.045,  // DRS unloads the rear wing -> balance moves forward
  yawDamping: 260,         // Nm per (rad/s) per (m/s) — aero weathervaning
  dirtyAirDownforce: 0.42, // downforce lost directly behind another car
  dirtyAirBalance: 0.055,  // front wing suffers most -> understeer
  slipstreamDrag: 0.30,

  // ---- suspension ----------------------------------------------------------
  springFront: 260000,     // N/m at the wheel
  springRear: 190000,
  bumpFront: 7000,         // Ns/m at the wheel
  reboundFront: 12000,
  bumpRear: 6000,
  reboundRear: 10000,
  arbFront: 40000,         // N/m of roll-only wheel rate
  arbRear: 24000,
  bumpStopGap: 0.022,      // travel before the packer takes over
  bumpStopRate: 1.2e6,
  droopLimit: 0.045,
  tyreRateFront: 260000,   // carcass vertical rate
  tyreRateRear: 240000,
  tyreDamping: 2200,

  // ---- tyres ---------------------------------------------------------------
  muFront: 1.64,
  muRear: 1.70,            // wider rear slick
  muLongBonus: 1.06,       // longitudinal grip exceeds lateral slightly
  loadRefFront: 3100,      // N at which mu = muFront
  loadRefRear: 3600,
  loadExponent: 0.135,     // mu ~ (Fz/Fzref)^-loadExponent
  peakSlipRatio: 0.105,
  peakSlipAngle: 0.108,    // tan(alpha) at peak — about 6.2 deg
  pacejka: { B: 7.4, C: 1.58, E: 0.94 },
  relaxLong: 0.28,         // relaxation lengths, metres
  relaxLat: 0.45,
  toeFront: -0.0016,       // radians, negative = toe-out
  toeRear: 0.0022,
  ackermann: 0.16,
  camberGain: 0.55,        // grip lost per radian of body roll on the outside
  tyreOptTemp: 100,        // deg C, surface
  tyreTempWindow: 30,
  tyreColdGrip: 0.80,
  tyrePressureCold: 1.55,  // bar
  tyrePressureOpt: 1.85,
  tyreWearRate: 3.2e-8,    // per joule of frictional work
  compoundGrip: 1.0,
  muBase: 1.0,             // global grip scale — the knob the AI's tyre-life
                           // model and the compound picker turn

  // ---- powertrain ceiling --------------------------------------------------
  // `maxTorque` is the mechanical peak of the ICE. The delivered curve is the
  // lesser of this shape and the FIA fuel-flow power limit, which is what makes
  // the engine behave like a real one from 10500 rpm to the limiter.
  maxTorque: 605,

  // ---- powertrain ----------------------------------------------------------
  redline: 15000,
  idleRpm: 4200,
  shiftRpm: 14600,
  fuelLhv: 43.0e6,         // J/kg
  thermalEfficiency: 0.470,
  engineFrictionBase: 14,  // Nm
  engineFrictionRpm: 0.0021,
  engineBrake: 58,         // Nm of overrun braking at redline
  gearRatios: [5.06, 4.34, 3.73, 3.21, 2.76, 2.38, 2.06, 1.80],
  finalDrive: 3.30,
  driveEfficiency: 0.955,
  shiftTime: 0.042,        // seconds of torque cut
  turboLag: 0.34,          // spool time constant, seconds
  turboAntiLag: 0.09,      // with the MGU-H spinning the compressor

  // ---- ERS -----------------------------------------------------------------
  ersPowerW: 120000,       // MGU-K, regulation limit
  ersCapacityJ: 4.0e6,
  ersDeployPerLapJ: 4.0e6,
  ersHarvestKPerLapJ: 2.0e6,
  ersHarvestPowerW: 120000,
  mguHHarvestW: 45000,     // from exhaust energy, straight to the battery

  // ---- differential --------------------------------------------------------
  diffPreload: 90,         // Nm
  diffPowerRamp: 0.52,     // fraction of drive torque available as lock
  diffCoastRamp: 0.24,
  diffViscous: 22,         // Nm per rad/s of cross-axle speed difference

  // ---- brakes --------------------------------------------------------------
  brakeTorqueFront: 11000, // Nm across the axle at full pedal, hot
  brakeTorqueRear: 7000,
  brakeBias: 0.585,
  brakeOptTemp: 620,       // carbon: cold below ~350, fade above ~1000
  brakeColdTemp: 340,
  brakeFadeTemp: 1020,
  brakeColdFactor: 0.55,

  // ---- steering ------------------------------------------------------------
  maxSteerAngle: 0.32,     // radians at the road wheel
  steerSpeedFalloff: 0.55,

  // ---- surfaces ------------------------------------------------------------
  kerbWidth: 1.15,
  kerbGrip: 0.86,
  runoffGrip: 0.88,
  gravelGrip: 0.46,
  grassGrip: 0.44,
  roadRoughness: 1.0,      // scales the baked bump profile

  // ---- what the AI is allowed to BELIEVE about this car ---------------------
  // Calibration for `corneringLimit()` only — see the long note there. These
  // reconcile the closed-form limit with what the simulated tyre + stalled floor
  // actually deliver, measured on a constant-speed skidpad. They do not touch the
  // physics; raise them when the aero map stops stalling at racing speed.
  aeroEffectiveProfile: 0.24,   // fraction of `clA` the car really makes in a corner
  gripEffectiveProfile: 0.80,   // fraction of the closed-form axle-average mu

  // ---- assists (default: medium) -------------------------------------------
  assists: { traction: 0.5, abs: 0.5, stability: 0.35 },
};

// ---------------------------------------------------------------------------
// Magic Formula, normalised so that peak = 1.0 at a resultant slip of 1.0.
// Working in normalised slip space is what makes the friction ellipse fall out
// of the model instead of being bolted on as a clamp afterwards.
// ---------------------------------------------------------------------------

function rawMF(x, B, C, E) {
  const Bx = B * x;
  return Math.sin(C * Math.atan(Bx - E * (Bx - Math.atan(Bx))));
}

function calibrateMF({ B, C, E }) {
  let peakX = 0.1, peakY = 0;
  for (let i = 1; i <= 400; i++) {
    const x = i * 0.005;
    const y = rawMF(x, B, C, E);
    if (y > peakY) { peakY = y; peakX = x; }
  }
  return { B, C, E, peakX, inv: 1 / peakY };
}

/** Normalised Magic Formula: mf(1) === 1 at the peak, falls away past it. */
function mf(rho, k) {
  return rawMF(rho * k.peakX, k.B, k.C, k.E) * k.inv;
}

// ---------------------------------------------------------------------------
// Road micro-profile. A small baked table keeps kerb strikes, bumps and the
// straight-line "shimmer" deterministic and allocation-free at 240 Hz.
// ---------------------------------------------------------------------------

const BUMP_NODES = 512;    // along the lap, ~ every 9 m on a 4.5 km circuit
const BUMP_BANDS = 8;      // across the track
const BUMP_TABLE = (() => {
  const rng = makeRng(hashSeed('physics/road-profile'));
  const t = new Float32Array(BUMP_NODES * BUMP_BANDS);
  for (let i = 0; i < t.length; i++) t[i] = rng() * 2 - 1;
  return t;
})();

const wrapIndex = (i, n) => ((i % n) + n) % n;

function bumpAt(sNorm, band) {
  const x = sNorm * BUMP_NODES;
  const i0 = wrapIndex(Math.floor(x), BUMP_NODES);
  const i1 = (i0 + 1) % BUMP_NODES;
  const f = x - Math.floor(x);
  const b0 = wrapIndex(Math.floor(band), BUMP_BANDS);
  const b1 = (b0 + 1) % BUMP_BANDS;
  const g = band - Math.floor(band);
  const a = lerp(BUMP_TABLE[i0 * BUMP_BANDS + b0], BUMP_TABLE[i1 * BUMP_BANDS + b0], f);
  const b = lerp(BUMP_TABLE[i0 * BUMP_BANDS + b1], BUMP_TABLE[i1 * BUMP_BANDS + b1], f);
  return lerp(a, b, g);
}

// Kerb cross-section, matching the ribbon profile built by track/circuit.js.
const KERB_PROFILE = [
  [0.00, 0.005], [0.35, 0.075], [0.86, 0.105], [1.15, 0.055], [1.50, -0.050],
];

function kerbHeight(t) {
  if (t <= 0) return 0;
  for (let i = 1; i < KERB_PROFILE.length; i++) {
    const [x1, y1] = KERB_PROFILE[i];
    if (t <= x1) {
      const [x0, y0] = KERB_PROFILE[i - 1];
      return lerp(y0, y1, (t - x0) / (x1 - x0));
    }
  }
  return -0.05;
}

/** 1.6 V6 turbo: mechanical torque ceiling before the fuel-flow limit bites. */
function mechanicalTorque(rpm) {
  const n = rpm / 1000;
  if (n < 4) return 260 + n * 40;
  if (n < 6) return 420 + (n - 4) * 70;
  if (n < 8) return 560 + (n - 6) * 15;
  if (n < 10.5) return 590 + (n - 8) * 6;
  if (n < 13) return 605 - (n - 10.5) * 16;
  return 565 - (n - 13) * 45;
}

/**
 * FIA fuel-flow limit: 100 kg/h above 10500 rpm, 0.009 N + 5.5 below it. This
 * single rule is what gives an F1 engine its signature near-constant power from
 * 10500 to the limiter, so it is modelled explicitly rather than baked into a
 * torque curve.
 */
function fuelFlowKgPerHour(rpm) {
  return rpm > 10500 ? 100 : 0.009 * rpm + 5.5;
}

/** Carbon-carbon brake friction as a function of disc temperature. */
function brakeFriction(temp, cfg) {
  if (temp < cfg.brakeColdTemp) {
    return lerp(cfg.brakeColdFactor, 1, clamp(temp / cfg.brakeColdTemp, 0, 1) ** 2);
  }
  if (temp < cfg.brakeOptTemp) return 1;
  return lerp(1, 0.62, clamp((temp - cfg.brakeOptTemp) / (cfg.brakeFadeTemp - cfg.brakeOptTemp), 0, 1));
}

const _F = new THREE.Vector3();
const _R = new THREE.Vector3();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
// Scratch buffers — the 240 Hz substep must not allocate.
const _susp = [0, 0, 0, 0];
const _defl = [0, 0, 0, 0];
const _deflVel = [0, 0, 0, 0];
const _brakeT = [0, 0, 0, 0];
const _wheelSurf = [
  { h: 0, grip: 1, drag: 0, kerb: 0 }, { h: 0, grip: 1, drag: 0, kerb: 0 },
  { h: 0, grip: 1, drag: 0, kerb: 0 }, { h: 0, grip: 1, drag: 0, kerb: 0 },
];
const _sample = {
  position: new THREE.Vector3(), tangent: new THREE.Vector3(),
  right: new THREE.Vector3(), up: new THREE.Vector3(),
  s: 0, curvature: 0, banking: 0, racing: 0,
};
const _surf = new THREE.Vector3();

export class Vehicle {
  constructor({ circuit, config = {}, id = 0 } = {}) {
    this.circuit = circuit;
    this.cfg = { ...DEFAULT_CONFIG, ...config };
    this.cfg.assists = { ...DEFAULT_CONFIG.assists, ...(config.assists ?? {}) };
    this.id = id;

    this._deriveGeometry();

    this.position = new THREE.Vector3();          // model origin, world
    this.quaternion = new THREE.Quaternion();
    this.pose = { position: this.position, quaternion: this.quaternion };
    this._cg = new THREE.Vector3();               // real CG, world

    // Planar state.
    this.yaw = 0;
    this.yawRate = 0;
    this.u = 0;
    this.v = 0;

    // Vertical state (all relative to the static-laden attitude).
    this.heave = 0; this.heaveVel = 0;
    this.pitchBody = 0; this.pitchVel = 0;        // +ve = nose up
    this.rollBody = 0; this.rollVel = 0;          // +ve = right side down
    this.wheelZ = [0, 0, 0, 0];                   // unsprung travel, +ve = up
    this.wheelZVel = [0, 0, 0, 0];

    // Visual attitude (includes road slope and banking).
    this.pitch = 0;
    this.roll = 0;

    // Powertrain.
    this.gear = 1;
    this.rpm = this.cfg.idleRpm;
    this.boost = 0;
    this.ers = this.cfg.ersCapacityJ * 0.72;
    this.ersLapDeployed = 0;
    this.ersLapHarvested = 0;
    this.drsAvailable = false;
    this.drsActive = false;
    this.drsBlend = 0;
    this.wake = { dirty: 0, tow: 0, gap: Infinity };

    this.controls = {
      steer: 0, throttle: 0, brake: 0, drs: false, ers: false,
      shiftUp: false, shiftDown: false, autoGearbox: true,
    };

    // Per-wheel state.
    this.wheelSpin = [0, 0, 0, 0];
    this.wheelOmega = [0, 0, 0, 0];
    this.wheelLoad = [0, 0, 0, 0];
    this.slipRatio = [0, 0, 0, 0];
    this.slipAngle = [0, 0, 0, 0];
    this.tanAlpha = [0, 0, 0, 0];   // relaxed lateral slip state
    this.tyreForceX = [0, 0, 0, 0];
    this.tyreForceY = [0, 0, 0, 0];
    this.tyreTemp = [85, 85, 85, 85];             // surface, deg C
    this.tyreCore = [80, 80, 80, 80];
    this.tyreCarcass = [70, 70, 70, 70];
    this.tyrePressure = [this.cfg.tyrePressureOpt, this.cfg.tyrePressureOpt,
      this.cfg.tyrePressureOpt, this.cfg.tyrePressureOpt];
    this.tyreWear = [0, 0, 0, 0];                 // 0 = new, 1 = gone
    this.tyreLoadNorm = [0.25, 0.25, 0.25, 0.25];
    this.brakeTemp = [320, 320, 320, 320];
    this.lockup = [0, 0, 0, 0];
    this.suspension = [0, 0, 0, 0];               // compression, metres (visual)
    this.surfaceGrip = [1, 1, 1, 1];
    this.kerbContact = 0;

    this.gLat = 0;
    this.gLong = 0;
    this.gVert = 1;
    this.understeer = 0;
    this.trackS = 0;
    this.trackLateral = 0;
    this.onTrack = true;
    this.airborne = false;
    this.lastShift = null;

    /** Injected by the game: (worldPos) => { grip, drag } */
    this.surfaceProbe = null;

    this.telemetry = {};
    this._mfLat = calibrateMF(this.cfg.pacejka);
    this._mfLong = calibrateMF(this.cfg.pacejka);
    this._shiftTimer = 0;
    this._shiftLock = 0;
    this._tcCut = 0;
    this._absRelease = [0, 0, 0, 0];
    this._headingErr = 0;
    this._lastS = 0;
    this._downforce = 0;
    this._drag = 0;
    this._aeroFront = 0;
    this._aeroRear = 0;
    this._rideFront = this.cfg.rideHeightFront;
    this._rideRear = this.cfg.rideHeightRear;
    this._surfaceScale = 1;
    this._extraDrag = 0;
  }

  _deriveGeometry() {
    const c = this.cfg;
    // Axle distances measured from the true CG.
    this.af = c.frontAxle + c.cgBehind;      // 1.98
    this.ar = c.rearAxle - c.cgBehind;       // 1.62
    c.wheelbase = this.af + this.ar;
    this.frontMassFraction = this.ar / c.wheelbase;   // 0.45

    this.sprungMass = c.mass - 4 * c.unsprungPerCorner;
    // Body-frame corner offsets: bx = right (+), bz = forward (+), from the CG.
    this.cornerX = [-c.trackFront / 2, c.trackFront / 2, -c.trackRear / 2, c.trackRear / 2];
    this.cornerZ = [this.af, this.af, -this.ar, -this.ar];
    this.springRate = [c.springFront, c.springFront, c.springRear, c.springRear];
    this.tyreRate = [c.tyreRateFront, c.tyreRateFront, c.tyreRateRear, c.tyreRateRear];
    this.arbRate = [c.arbFront, c.arbFront, c.arbRear, c.arbRear];
    this.muNominal = [c.muFront, c.muFront, c.muRear, c.muRear];
    this.loadRef = [c.loadRefFront, c.loadRefFront, c.loadRefRear, c.loadRefRear];

    // Static loads (car at rest, no aero).
    const wf = this.frontMassFraction;
    this.staticLoad = [
      c.mass * G * wf * 0.5, c.mass * G * wf * 0.5,
      c.mass * G * (1 - wf) * 0.5, c.mass * G * (1 - wf) * 0.5,
    ];
    // Sprung share of each corner — the part carried by the springs.
    this.staticSpring = this.staticLoad.map((f) => f - c.unsprungPerCorner * G);
    this.tyreStatic = this.staticLoad.map((f, i) => f / this.tyreRate[i]);
  }

  // -- lifecycle -------------------------------------------------------------

  /** Place the car on the circuit at arc length `s`, `lateral` metres across. */
  reset({ s = 0, lateral = 0, speed = 0 } = {}) {
    const cfg = this.cfg;
    const sm = this.circuit.sampleAt(s, _sample);
    this.circuit.pointAt(s, lateral, 0, this.position);
    this.yaw = Math.atan2(-sm.tangent.x, -sm.tangent.z);
    this.yawRate = 0;
    this.u = speed;
    this.v = 0;
    this.trackS = this.circuit.wrapS(s);
    this._lastS = this.trackS;
    this.trackLateral = lateral;

    this.heave = 0; this.heaveVel = 0;
    this.pitchBody = 0; this.pitchVel = 0;
    this.rollBody = 0; this.rollVel = 0;
    for (let i = 0; i < 4; i++) {
      this.wheelZ[i] = 0; this.wheelZVel[i] = 0;
      this.wheelOmega[i] = speed / cfg.wheelRadius;
      this.wheelLoad[i] = this.staticLoad[i];
      this.slipRatio[i] = 0; this.slipAngle[i] = 0; this.tanAlpha[i] = 0;
      this.suspension[i] = 0; this.lockup[i] = 0;
      this.tyreTemp[i] = 88; this.tyreCore[i] = 84; this.tyreCarcass[i] = 72;
      this.brakeTemp[i] = 340;
      this._absRelease[i] = 0;
    }
    this.gear = this._gearForSpeed(speed);
    this.rpm = Math.max(cfg.idleRpm, this._gearedRpm());
    this.boost = speed > 20 ? 0.85 : 0;
    this.gLat = 0; this.gLong = 0; this.gVert = 1;
    this._shiftTimer = 0;
    this._headingErr = 0;
    this._updateCg();
    this._syncPose(sm);
    this._updateTelemetry();
    return this;
  }

  setControls(c) { Object.assign(this.controls, c); }

  /** Assist levels, 0 = off, 1 = maximum intervention. */
  setAssists(a) { Object.assign(this.cfg.assists, a); }

  /** Live setup changes (springs, bars, aero, diff). Re-derives the geometry. */
  setSetup(s) {
    Object.assign(this.cfg, s);
    this._deriveGeometry();
    this._mfLat = calibrateMF(this.cfg.pacejka);
    this._mfLong = calibrateMF(this.cfg.pacejka);
  }

  get speed() { return Math.hypot(this.u, this.v); }
  get speedKph() { return this.speed * 3.6; }

  /** Effective steer angle at the road wheel, including the speed taper. */
  steerAngle() {
    const cfg = this.cfg;
    const speedFactor = 1 - cfg.steerSpeedFalloff * clamp(this.speed / 85, 0, 1);
    return this.controls.steer * cfg.maxSteerAngle * speedFactor;
  }

  // -- integration -----------------------------------------------------------

  /**
   * Advance the simulation. `dt` is the sim step (1/60); internally the model
   * runs at a fixed 240 Hz so tyre relaxation, wheel spin and the suspension
   * stay well inside their stability limits.
   */
  step(dt) {
    if (!(dt > 0)) return;
    const n = clamp(Math.round(dt * 240), 1, 8);
    const h = dt / n;

    this._beginStep();
    for (let i = 0; i < n; i++) this._substep(h);
    this._endStep(dt);
  }

  /** Locate the car on the circuit once per sim step — nearest() is the cost. */
  _beginStep() {
    const c = this.circuit;
    if (!c) { this._slope = 0; this._kerbHere = 0; this._kerbFade = 0; return; }
    const near = c.nearest(this.position, this.trackS);
    this.trackS = near.s;
    this.trackLateral = near.lateral;
    const sm = c.sampleAt(near.s, _sample);
    this._trackHeading = Math.atan2(-sm.tangent.x, -sm.tangent.z);
    this._slope = Math.asin(clamp(sm.tangent.y, -1, 1));
    this._banking = sm.banking;
    this._curvature = sm.curvature;
    this._halfWidth = c.halfWidth;
    this._headingErr = this._wrapAngle(this.yaw - this._trackHeading);
    // Does this part of the circuit have kerbs? circuit.js lays them wherever
    // the curvature exceeds this threshold, so mirror the same test.
    this._kerbHere = Math.abs(sm.curvature) > 0.0038 ? 1 : 0;
    this._kerbFade = clamp((Math.abs(sm.curvature) - 0.0038) / 0.004, 0, 1);
  }

  _wrapAngle(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
  }

  /**
   * Surface under a wheel. Returns the height deviation from the smooth road
   * plane (kerbs, bumps, run-off), plus grip and rolling drag.
   */
  _surfaceAt(s, lat, out) {
    const cfg = this.cfg;
    const hw = this._halfWidth ?? 7;
    const absLat = Math.abs(lat);
    const sNorm = ((s / (this.circuit?.length ?? 1)) % 1 + 1) % 1;
    const band = (lat / (hw * 2) + 0.5) * BUMP_BANDS;

    // Baked road texture: long undulations plus a fine tremor.
    let h = bumpAt(sNorm, band) * 0.011 * cfg.roadRoughness;
    h += bumpAt((sNorm * 6.3) % 1, (band * 2.7) % BUMP_BANDS) * 0.0035 * cfg.roadRoughness;

    let grip = 1;
    let drag = 12;
    let kerb = 0;

    if (absLat > hw) {
      const t = absLat - hw;
      if (this._kerbHere && t < cfg.kerbWidth + 0.35) {
        // Sawtooth ribs along the kerb — this is what shakes the car.
        const rib = Math.sin(s * 12.6) * 0.5 + Math.sin(s * 25.1) * 0.25;
        h += (kerbHeight(t) + rib * 0.010 * clamp(t / 0.4, 0, 1)) * this._kerbFade;
        grip = cfg.kerbGrip;
        drag = 55;
        kerb = clamp(t / cfg.kerbWidth, 0, 1);
      } else {
        const off = t - (this._kerbHere ? cfg.kerbWidth : 0);
        h -= clamp(off, 0, 2) * 0.045;                       // the road drops away
        if (off < 8) {
          grip = cfg.runoffGrip; drag = 90;
          h += bumpAt((sNorm * 3.1) % 1, band) * 0.010;
        } else if (off < 16) {
          grip = cfg.gravelGrip; drag = 900;
          h += bumpAt((sNorm * 17.3) % 1, band) * 0.035;
        } else {
          grip = cfg.grassGrip; drag = 420;
          h += bumpAt((sNorm * 11.7) % 1, band) * 0.028;
        }
      }
    }
    out.h = h; out.grip = grip; out.drag = drag; out.kerb = kerb;
    return out;
  }

  // -- the 240 Hz core -------------------------------------------------------

  _substep(h) {
    const cfg = this.cfg;
    const m = cfg.mass;

    // ---- where each wheel sits on the road ---------------------------------
    const dyaw = this._wrapAngle(this.yaw - (this._trackHeading ?? this.yaw));
    const cy = Math.cos(dyaw), sy = Math.sin(dyaw);
    let kerbTouch = 0;
    let surfaceDrag = 0;
    for (let i = 0; i < 4; i++) {
      // Body offset of the contact patch, rotated into track coordinates.
      const bx = this.cornerX[i], bz = this.cornerZ[i];
      const ds = bz * cy - bx * sy;
      const dl = bz * sy + bx * cy;
      const s = (this.trackS ?? 0) + ds;
      const lat = (this.trackLateral ?? 0) + dl;
      const info = this._surfaceAt(s, lat, _wheelSurf[i]);
      this.surfaceGrip[i] = info.grip;
      surfaceDrag += info.drag * 0.25;
      kerbTouch = Math.max(kerbTouch, info.kerb);
    }
    this.kerbContact = kerbTouch;

    let probeGrip = 1;
    if (this.surfaceProbe) {
      const p = this.surfaceProbe(this.position);
      if (p) { probeGrip = p.grip ?? 1; surfaceDrag += p.drag ?? 0; }
    }

    // ---- aerodynamics ------------------------------------------------------
    this._aero(h);

    // ---- vertical model ----------------------------------------------------
    this._vertical(h);

    // ---- powertrain --------------------------------------------------------
    const driveTorque = this._powertrain(h);

    // ---- tyres and wheels --------------------------------------------------
    const delta = this.steerAngle();
    let sumFx = 0, sumFy = 0, sumMz = 0;

    const diffTorque = this._differential(driveTorque);
    const brakeTorques = this._brakes(h);

    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      const bx = this.cornerX[i], bz = this.cornerZ[i];

      // Steer angle including Ackermann and static toe.
      let st = 0;
      if (front) {
        const inner = Math.sign(bx) === Math.sign(delta) ? -1 : 1;
        st = delta * (1 + cfg.ackermann * inner * clamp(Math.abs(delta) * 4, 0, 1));
        st += cfg.toeFront * Math.sign(bx);
      } else {
        st += cfg.toeRear * -Math.sign(bx);
      }

      // Contact-patch velocity in wheel axes.
      const uw = this.u + this.yawRate * bx;
      const vw = this.v - this.yawRate * bz;
      const cd = Math.cos(st), sd = Math.sin(st);
      const vLong = uw * cd + vw * sd;
      const vLat = -uw * sd + vw * cd;

      const Fz = this.wheelLoad[i];
      const re = cfg.wheelRadius - Math.min(0.03, Fz / this.tyreRate[i]);

      // Transient slip: relaxation-length ODEs, integrated implicitly so they
      // are unconditionally stable down to a standstill.
      const vRef = Math.max(Math.abs(vLong), 1.0);
      const slipSpeed = vLong - this.wheelOmega[i] * re;
      const kx = h * vRef / cfg.relaxLong;
      this.slipRatio[i] = clamp((this.slipRatio[i] - h * slipSpeed / cfg.relaxLong) / (1 + kx), -4, 4);
      const ky = h * vRef / cfg.relaxLat;
      const tanA = clamp((this.tanAlpha[i] + h * vLat / cfg.relaxLat) / (1 + ky), -3, 3);
      this.tanAlpha[i] = tanA;
      this.slipAngle[i] = Math.atan(tanA);

      const kappa = this.slipRatio[i];

      let fx = 0, fy = 0;
      if (Fz > 1) {
        // Load sensitivity, temperature window, wear, pressure, camber, surface.
        const mu = this._muAt(i, Fz) * this.surfaceGrip[i] * probeGrip;

        // Normalised resultant slip -> friction ellipse for free.
        const nx = kappa / cfg.peakSlipRatio;
        const ny = tanA / cfg.peakSlipAngle;
        const rho = Math.hypot(nx, ny);
        if (rho > 1e-6) {
          const share = mf(rho, this._mfLong);
          // Direction-weighted friction: longitudinal grip is slightly higher.
          const wx = nx / rho, wy = ny / rho;
          const muDir = mu * (1 + (cfg.muLongBonus - 1) * wx * wx);
          const F = muDir * Fz * share;
          fx = wx * F;
          fy = -wy * F;
        }
      }
      this.tyreForceX[i] = fx;
      this.tyreForceY[i] = fy;

      // ---- wheel rotation --------------------------------------------------
      let torque = -fx * re;
      if (!front) torque += driveTorque * 0.5 + diffTorque * (i === 2 ? 1 : -1);
      torque -= Math.sign(this.wheelOmega[i]) * Math.min(6, Math.abs(this.wheelOmega[i]) * 2);  // bearing drag
      let omega = this.wheelOmega[i] + (torque / cfg.wheelInertia) * h;

      // Brakes clamp toward zero rather than reversing the wheel.
      const bt = brakeTorques[i];
      if (bt > 0) {
        const dOmega = (bt / cfg.wheelInertia) * h;
        omega = Math.abs(omega) <= dOmega ? 0 : omega - Math.sign(omega) * dOmega;
      }
      this.wheelOmega[i] = omega;
      this.wheelSpin[i] += omega * h;
      this.lockup[i] = clamp(-kappa - 0.12, 0, 1) * (bt > 50 ? 1 : 0);

      // ---- resolve into the body frame -------------------------------------
      const bfx = fx * cd - fy * sd;
      const bfy = fx * sd + fy * cd;
      sumFx += bfx;
      sumFy += bfy;
      sumMz += bx * bfx - bz * bfy;

      // Pneumatic trail: a real self-aligning moment adds genuine yaw damping.
      const trail = 0.045 * clamp(1 - Math.abs(tanA) / (cfg.peakSlipAngle * 2.2), 0, 1);
      sumMz += -fy * trail * (front ? 1 : 0.6) * Math.cos(st);

      this._thermal(i, h, fx, fy, vLong, omega * re, vLat, bt);
    }

    // ---- resistances -------------------------------------------------------
    const speedSign = Math.sign(this.u) || 1;
    sumFx -= this._drag;
    sumFx -= surfaceDrag * speedSign * clamp(Math.abs(this.u) / 3, 0, 1);
    sumFx -= m * G * Math.sin(this._slope ?? 0);          // gravity along the road

    // ---- electronic stability control --------------------------------------
    sumMz += this._stability(delta);

    // ---- rigid-body update -------------------------------------------------
    const ax = sumFx / m;                                  // body-frame accel
    const ay = sumFy / m;
    this.u += (ax - this.v * this.yawRate) * h;
    this.v += (ay + this.u * this.yawRate) * h;

    const yawAero = -(this._yawDamp ?? 0) * this.yawRate;
    this.yawRate += ((sumMz + yawAero) / cfg.inertiaYaw) * h;
    this.yaw += this.yawRate * h;

    if (Math.abs(this.u) < 0.04 && this.controls.throttle < 0.02) { this.u = 0; this.v *= 0.5; }

    // Smoothed g-loads: these drive load transfer, the visual attitude and the
    // camera, so they must be the real accelerations, not the derivatives of u/v.
    const blend = 1 - Math.exp(-h * 22);
    this.gLong = lerp(this.gLong, ax / G, blend);
    this.gLat = lerp(this.gLat, ay / G, blend);
    this.gVert = lerp(this.gVert, (this.wheelLoad[0] + this.wheelLoad[1]
      + this.wheelLoad[2] + this.wheelLoad[3]) / (m * G), blend);

    // ---- move --------------------------------------------------------------
    _F.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    _R.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    this._cg.addScaledVector(_F, this.u * h).addScaledVector(_R, this.v * h);
    this.position.copy(this._cg).addScaledVector(_F, cfg.cgBehind);

    // Track coordinates advance analytically between nearest() calls.
    if (this.circuit) {
      const dyaw2 = this._wrapAngle(this.yaw - (this._trackHeading ?? this.yaw));
      this.trackS += (this.u * Math.cos(dyaw2) - this.v * Math.sin(dyaw2)) * h;
      this.trackLateral += (this.u * Math.sin(dyaw2) + this.v * Math.cos(dyaw2)) * h;
    }
  }

  // -- aerodynamics ----------------------------------------------------------

  _aero(h) {
    const cfg = this.cfg;
    const drsOpen = this.drsActive && this.speed > 13 && this.controls.brake < 0.05;
    this.drsBlend = lerp(this.drsBlend, drsOpen ? 1 : 0, 1 - Math.exp(-h * 11));

    const vAir = this.u;
    const q = 0.5 * cfg.rho * vAir * Math.abs(vAir);

    // Ground effect: downforce climbs as the floor is sealed, then collapses if
    // the plank is driven into the road.
    const gf = this._groundEffect(this._rideFront, this._rideRear);
    const dirty = this.wake.dirty;

    let clA = cfg.clA * gf
      * (1 - cfg.drsDownforceDrop * this.drsBlend)
      * (1 - cfg.dirtyAirDownforce * dirty);
    let cdA = cfg.cdA
      * (1 - cfg.drsDragDrop * this.drsBlend)
      * (1 - cfg.slipstreamDrag * this.wake.tow);
    // Induced drag tracks downforce, so a stalled floor is also a slippery one.
    cdA *= 1 + 0.16 * (gf - 1);

    const downforce = Math.max(0, q * clA);
    this._downforce = downforce;
    this._drag = q * cdA;
    this._yawDamp = cfg.yawDamping * Math.abs(vAir) * 0.01;

    const rake = this._rideRear - this._rideFront;
    let balance = cfg.aeroBalance
      + cfg.rakeBalanceGain * (rake - (cfg.rideHeightRear - cfg.rideHeightFront))
      + cfg.drsBalanceShift * this.drsBlend
      - cfg.dirtyAirBalance * dirty;
    // A stalled floor loses the front first — the classic low-ride-height snap.
    if (this._rideFront < cfg.floorStallHeight * 1.6) {
      balance -= 0.06 * clamp((cfg.floorStallHeight * 1.6 - this._rideFront) / cfg.floorStallHeight, 0, 1);
    }
    balance = clamp(balance, 0.34, 0.56);
    this._aeroBalance = balance;
    this._aeroFront = downforce * balance;
    this._aeroRear = downforce * (1 - balance);
  }

  _groundEffect(rhF, rhR) {
    const cfg = this.cfg;
    const nominal = (cfg.rideHeightFront + cfg.rideHeightRear) * 0.5;
    const h = Math.max(0.001, (rhF + rhR) * 0.5);
    // Rises as 1/(h + scale) then stalls hard once the floor grounds out.
    const gain = 1 + cfg.groundEffectGain
      * ((cfg.groundEffectScale / (h + cfg.groundEffectScale))
        - (cfg.groundEffectScale / (nominal + cfg.groundEffectScale)));
    const stall = h < cfg.floorStallHeight
      ? clamp(h / cfg.floorStallHeight, 0.35, 1)
      : 1;
    return clamp(gain * stall, 0.55, 1.55);
  }

  // -- vertical model --------------------------------------------------------

  /**
   * Heave / pitch / roll of the sprung mass over four unsprung masses.
   *
   * Load transfer is split the way it is on a real car: the geometric part goes
   * straight into the tyres through the links (roll centres, anti-dive,
   * anti-squat) and the elastic part arrives through the springs, which is what
   * makes the platform take time to settle and the balance move with it.
   */
  _vertical(h) {
    const cfg = this.cfg;
    const ms = this.sprungMass;
    const mu = cfg.unsprungPerCorner;

    const ax = this.gLong * G;
    const ay = this.gLat * G;

    // Elastic moments about the roll axis / pitch axis.
    const rcAvg = (cfg.rollCentreFront + cfg.rollCentreRear) * 0.5;
    const rollMoment = -ms * ay * (cfg.cgHeight - rcAvg);
    const antiLong = ax > 0 ? cfg.antiSquat : cfg.antiDive;
    const pitchMoment = ms * ax * cfg.cgHeight * (1 - antiLong)
      - this._aeroFront * this.af + this._aeroRear * this.ar;

    // Geometric (through-the-links) transfer, applied straight to the tyres.
    const geoLatF = (cfg.mass * this.frontMassFraction) * ay * cfg.rollCentreFront / cfg.trackFront;
    const geoLatR = (cfg.mass * (1 - this.frontMassFraction)) * ay * cfg.rollCentreRear / cfg.trackRear;
    const geoLong = cfg.mass * ax * cfg.cgHeight * antiLong / cfg.wheelbase;

    // Suspension deflections and rates (positive = extension).
    const d = _defl, dv = _deflVel;
    for (let i = 0; i < 4; i++) {
      const zs = this.heave + this.pitchBody * this.cornerZ[i] - this.rollBody * this.cornerX[i];
      const zsv = this.heaveVel + this.pitchVel * this.cornerZ[i] - this.rollVel * this.cornerX[i];
      d[i] = zs - this.wheelZ[i];
      dv[i] = zsv - this.wheelZVel[i];
    }
    const arbF = cfg.arbFront * (d[0] - d[1]) * 0.5;
    const arbR = cfg.arbRear * (d[2] - d[3]) * 0.5;

    let sumF = 0, sumPitch = 0, sumRoll = 0;
    const susp = _susp;

    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      // Spring, then the packer once the travel runs out, then the droop stop.
      let f = this.staticSpring[i] - this.springRate[i] * d[i];
      const compression = -d[i];
      if (compression > cfg.bumpStopGap) f += cfg.bumpStopRate * (compression - cfg.bumpStopGap);
      if (d[i] > cfg.droopLimit) f -= cfg.bumpStopRate * 0.4 * (d[i] - cfg.droopLimit);

      // Anti-roll bar: resists the left/right deflection difference on the axle.
      f += (front ? arbF : arbR) * Math.sign(this.cornerX[i]);

      // Damper, integrated implicitly against the reduced mass of the pair so
      // a high-rate damper can never destabilise the 240 Hz step.
      const c = dv[i] < 0
        ? (front ? cfg.bumpFront : cfg.bumpRear)
        : (front ? cfg.reboundFront : cfg.reboundRear);
      const mred = 1 / (4 / ms + 1 / mu);
      const fd = -c * dv[i] / (1 + (c * h) / mred);
      f += fd;

      susp[i] = f;
      sumF += f;
      sumPitch += f * this.cornerZ[i];
      sumRoll += -f * this.cornerX[i];
    }

    // Sprung mass.
    const heaveAcc = (sumF - ms * G - this._downforce) / ms;
    this.heaveVel += heaveAcc * h;
    this.heave += this.heaveVel * h;

    this.pitchVel += ((sumPitch + pitchMoment) / cfg.inertiaPitch) * h;
    this.pitchBody += this.pitchVel * h;

    this.rollVel += ((sumRoll + rollMoment) / cfg.inertiaRoll) * h;
    this.rollBody += this.rollVel * h;

    // Unsprung masses + tyre carcass springs.
    let contact = 0;
    for (let i = 0; i < 4; i++) {
      const road = _wheelSurf[i].h;
      const defl = this.tyreStatic[i] + road - this.wheelZ[i];
      let Fz = 0;
      if (defl > 0) {
        const kt = this.tyreRate[i] * (0.85 + 0.15 * this.tyrePressure[i] / cfg.tyrePressureOpt);
        Fz = kt * defl;
        const ct = cfg.tyreDamping;
        Fz += -ct * this.wheelZVel[i] / (1 + (ct * h) / mu);
        if (Fz < 0) Fz = 0;
      }

      // Geometric transfer arrives through the links, not the springs, so it
      // is added straight to the contact patch.
      const geoLat = i < 2 ? geoLatF : geoLatR;
      let extra = -Math.sign(this.cornerX[i]) * geoLat;
      extra += (i < 2 ? -1 : 1) * geoLong * 0.5;
      const total = Math.max(0, Fz + extra);
      this.wheelLoad[i] = total;
      if (total > 30) contact++;

      const acc = (Fz - susp[i] - mu * G) / mu;
      this.wheelZVel[i] += acc * h;
      this.wheelZ[i] += this.wheelZVel[i] * h;
      this.wheelZ[i] = clamp(this.wheelZ[i], -0.12, 0.14);

      // Visual travel: compression is positive.
      this.suspension[i] = clamp(-d[i], -cfg.droopLimit, 0.06);
      this.tyreLoadNorm[i] = clamp(total / 9000, 0, 1);
    }
    this.airborne = contact === 0;

    // Keep the platform sane if something upstream feeds a silly number in.
    if (!Number.isFinite(this.heave)) { this.heave = 0; this.heaveVel = 0; }
    this.heave = clamp(this.heave, -0.10, 0.30);
    this.pitchBody = clamp(this.pitchBody, -0.09, 0.09);
    this.rollBody = clamp(this.rollBody, -0.09, 0.09);

    // Ride heights drive the aero map on the next substep.
    this._rideFront = Math.max(0.001,
      cfg.rideHeightFront + this.heave + this.pitchBody * this.af);
    this._rideRear = Math.max(0.001,
      cfg.rideHeightRear + this.heave - this.pitchBody * this.ar);
  }

  // -- powertrain ------------------------------------------------------------

  _gearedRpm(gear = this.gear) {
    const cfg = this.cfg;
    const ratio = cfg.gearRatios[gear - 1] * cfg.finalDrive;
    const rearOmega = (this.wheelOmega[2] + this.wheelOmega[3]) * 0.5;
    return Math.abs(rearOmega) * ratio * 60 / (2 * Math.PI);
  }

  /**
   * Geared rpm implied by the CHASSIS' own speed rather than by wheel omega —
   * i.e. what the engine would be doing with no wheelspin. This is the signal the
   * auto gearbox shifts on; see the note at the shift logic.
   */
  _roadRpm(gear = this.gear) {
    // Derived FROM `_gearedRpm` by dividing out the slip, not recomputed from
    // `speed / cfg.wheelRadius`: `wheelRadius` is the unloaded radius, the tyres
    // actually roll on ~0.345 m, and that 4.5 % disagreement is enough to leave
    // the gearbox permanently one gear short — `this.rpm` sat on the 15 000 rpm
    // limiter in 2nd while a road rpm of 14 440 said "no upshift needed", and the
    // whole field was capped at 38 m/s. Same source, same radius, no drift.
    const sr = Math.max(0, this.slipRatio[2], this.slipRatio[3]);
    return this._gearedRpm(gear) / (1 + sr);
  }

  _gearForSpeed(speed) {
    const cfg = this.cfg;
    const wheelOmega = speed / cfg.wheelRadius;
    for (let g = 1; g <= cfg.gearRatios.length; g++) {
      const rpm = wheelOmega * cfg.gearRatios[g - 1] * cfg.finalDrive * 60 / (2 * Math.PI);
      if (rpm < cfg.shiftRpm) return g;
    }
    return cfg.gearRatios.length;
  }

  /** @returns {number} torque at the differential input, Nm. */
  _powertrain(h) {
    const cfg = this.cfg;
    const throttle = clamp(this.controls.throttle, 0, 1);
    const ratio = cfg.gearRatios[this.gear - 1] * cfg.finalDrive;

    // Engine speed follows the driveline through a slipping clutch at low revs.
    //
    // LAUNCH. `lock` is how far the clutch has locked crank to driveline, and
    // deriving the TRANSMITTED torque from it alone makes a standing start
    // physically impossible: at rest `geared` is 0, so `lock` is 0, so the drive
    // torque is 0, so the wheels never turn, so `geared` stays 0. Measured before
    // this fix — full throttle from the grid for forty seconds of sim: 0.06 m/s,
    // gear 1, stuck at idle, for the player AND for all nineteen AI cars. Every
    // capture hid it because `reset({ speed })` starts the field already rolling.
    //
    // A real clutch transmits its capacity ACROSS a slip; below lock-up the
    // torque it passes is set by how far the driver has let it out, not by how
    // fast the wheels happen to be turning. So take whichever is greater: the
    // geared lock-up (which keeps the running case bit-identical, since `lock`
    // saturates at 1 above ~35 km/h) or a throttle-fed launch capacity. Holding
    // the clutch pedal takes the launch term back out, which is what makes a
    // clutch start and a bogged-down getaway possible.
    const geared = this._gearedRpm();
    const lock = clamp((geared - cfg.idleRpm * 0.55) / (cfg.idleRpm * 0.5), 0, 1);
    const pedal = 1 - clamp(this.controls.clutch ?? 0, 0, 1);
    // The launch capacity RAMPS with road speed, because that is what a driver
    // feeding a clutch does — nobody dumps full engine torque into a stationary
    // rear axle. Measured without the ramp: 0.62 of ~600 Nm through the 16.7:1
    // first-gear reduction demands 17 kN of tractive effort against roughly 7 kN
    // of rear grip, so the tyres went straight to a slip ratio of 4, the geared
    // rpm chased the spinning wheels past `shiftRpm`, the auto box walked itself
    // up to 8th, and the car stood there smoking its rears at 15 km/h.
    const rolling = clamp(this.speed / 9, 0, 1);
    const clutch = Math.max(lock, throttle * pedal * (0.22 + 0.42 * rolling));
    const target = Math.max(cfg.idleRpm * (throttle > 0.2 ? 1 : 0.86), geared);
    this.rpm = lerp(this.rpm, target, 1 - Math.exp(-h * (clutch > 0.99 ? 40 : 9)));
    this.rpm = clamp(this.rpm, 500, cfg.redline * 1.03);

    // Gear selection.
    this._shiftTimer = Math.max(0, this._shiftTimer - h);
    this._shiftLock = Math.max(0, this._shiftLock - h);
    if (this.controls.autoGearbox) {
      if (this._shiftLock === 0) {
        // SHIFT ON THE ROAD, NOT ON THE WHEELS.
        //
        // `this.rpm` follows `_gearedRpm()`, which is derived from rear-wheel
        // omega, so under wheelspin it reads high. Shifting on it made the box
        // chase the spinning wheels all the way to 8th gear during a standing
        // start — a taller gear, still spinning, repeat. `_roadRpm()` is the same
        // quantity computed from the chassis' own velocity, so it is immune to
        // that feedback and is what the driver's ear is really reacting to.
        const roadRpm = this._roadRpm();
        if (roadRpm > cfg.shiftRpm && this.gear < cfg.gearRatios.length) this._shift(1);
        else if (this.gear > 1) {
          // Downshift when the lower gear would still sit below the limiter.
          const lower = cfg.gearRatios[this.gear - 2] / cfg.gearRatios[this.gear - 1];
          if (roadRpm * lower < cfg.shiftRpm * 0.94 && roadRpm < cfg.shiftRpm * 0.70) this._shift(-1);
        }
      }
    } else {
      if (this.controls.shiftUp && this.gear < cfg.gearRatios.length && this._shiftLock === 0) this._shift(1);
      if (this.controls.shiftDown && this.gear > 1 && this._shiftLock === 0) this._shift(-1);
    }
    this.controls.shiftUp = this.controls.shiftDown = false;

    // Turbo. The MGU-H keeps the compressor spinning, so lag is short but real.
    const spool = throttle > 0.15 && this.rpm > 6000;
    const tau = this._ersDeploying ? cfg.turboAntiLag : cfg.turboLag;
    this.boost = lerp(this.boost, spool ? clamp(this.rpm / 9000, 0, 1) : 0.05,
      1 - Math.exp(-h / (spool ? tau : 0.22)));

    const omegaE = Math.max(60, this.rpm * 2 * Math.PI / 60);
    const flowW = fuelFlowKgPerHour(this.rpm) / 3600 * cfg.fuelLhv
      * cfg.thermalEfficiency * (this.rpm > 12000 ? lerp(1, 0.92, (this.rpm - 12000) / 3000) : 1);
    const fuelLimited = flowW / omegaE;
    const mech = mechanicalTorque(this.rpm) * (cfg.maxTorque / 605);
    let ice = Math.min(mech, fuelLimited) * throttle * lerp(0.55, 1, this.boost);

    // Limiter: hard ignition cut, not a soft roll-off.
    if (this.rpm > cfg.redline) ice = 0;
    // Shift cut.
    if (this._shiftTimer > 0) ice = 0;
    // Overrun braking.
    ice -= (1 - throttle) * cfg.engineBrake * clamp(this.rpm / cfg.redline, 0, 1);
    ice -= cfg.engineFrictionBase + cfg.engineFrictionRpm * this.rpm;

    // ---- ERS ---------------------------------------------------------------
    const wantDeploy = (this.controls.ers || throttle > 0.85)
      && this.ers > 0
      && this.ersLapDeployed < cfg.ersDeployPerLapJ
      && this.rpm > 5500;
    this._ersDeploying = wantDeploy;
    let mguk = 0;
    if (wantDeploy) {
      mguk = cfg.ersPowerW * clamp(throttle * 1.1, 0, 1);
      const used = Math.min(mguk * h, this.ers, cfg.ersDeployPerLapJ - this.ersLapDeployed);
      mguk = used / h;
      this.ers -= used;
      this.ersLapDeployed += used;
      ice += mguk / omegaE;
    }
    this._mgukPower = mguk;

    // MGU-H harvest whenever the exhaust is doing work.
    if (throttle > 0.35 && this.rpm > 8000) {
      const e = cfg.mguHHarvestW * throttle * h;
      this.ers = Math.min(cfg.ersCapacityJ, this.ers + e);
    }

    // Lap rollover: the energy budget is per lap, so reset on the S wrap.
    if (this.circuit) {
      const s = this.trackS;
      if (this._lastS - s > this.circuit.length * 0.5) {
        this.ersLapDeployed = 0;
        this.ersLapHarvested = 0;
      }
      this._lastS = s;
    }

    // ---- traction control --------------------------------------------------
    // TC AUTHORITY HAS TO BE ENOUGH TO WIN.
    //
    // `over * tc` capped the cut at 0.5, and `* 0.92` at 0.46, so with the shipped
    // medium assist the ECU could only ever take away 46 % of the torque. In first
    // gear that is nowhere near enough: at full throttle the rears broke away,
    // slip ran to the 4.0 clamp, `_gearedRpm` (which reads WHEEL omega) chased it
    // past the redline, `ice` went to zero on the limiter and the overrun braking
    // then dragged the CAR back down — the whole field topped out at 38 m/s from a
    // standing start and never reached racing speed. Measured after: the field
    // clears 80 m/s inside twenty seconds.
    //
    // So `tc` now sets how AGGRESSIVELY the ECU intervenes and how early, not how
    // much of the problem it is allowed to solve. Full authority, because a real
    // traction control cuts to whatever it takes; the assist level decides the
    // slip target and the reaction rate, which is the knob that actually changes
    // how the car feels.
    const tc = this.cfg.assists.traction;
    if (tc > 0) {
      const slip = Math.max(this.slipRatio[2], this.slipRatio[3]);
      const target = cfg.peakSlipRatio * lerp(1.55, 1.08, tc);
      const over = clamp((slip - target) / (cfg.peakSlipRatio * 0.9), 0, 1);
      this._tcCut = lerp(this._tcCut, over, 1 - Math.exp(-h * lerp(22, 60, tc)));
    } else this._tcCut = 0;

    const crank = ice * (1 - this._tcCut * 0.97);
    this._crankTorque = crank;
    return crank * ratio * cfg.driveEfficiency * clutch;
  }

  _shift(dir) {
    const next = clamp(this.gear + dir, 1, this.cfg.gearRatios.length);
    if (next === this.gear) return;
    this.gear = next;
    this._shiftTimer = this.cfg.shiftTime;
    this._shiftLock = this.cfg.shiftTime + 0.06;
    this.lastShift = { dir, at: this.trackS };
  }

  /**
   * Clutch-pack LSD: preload plus a torque-sensitive ramp, different on power
   * and on the overrun. Returns the torque added to the LEFT rear and removed
   * from the right (so the diff can only ever move torque across the axle).
   */
  _differential(driveTorque) {
    const cfg = this.cfg;
    const dOmega = this.wheelOmega[2] - this.wheelOmega[3];
    const ramp = driveTorque >= 0 ? cfg.diffPowerRamp : cfg.diffCoastRamp;
    const capacity = cfg.diffPreload + Math.abs(driveTorque) * ramp;
    return clamp(-dOmega * cfg.diffViscous, -capacity, capacity);
  }

  /** Per-wheel brake torque including bias, carbon temperature and ABS. */
  _brakes(h) {
    const cfg = this.cfg;
    const pedal = clamp(this.controls.brake, 0, 1);
    const out = _brakeT;
    const abs = cfg.assists.abs;
    // The bias knob redistributes a fixed total line pressure between the axles.
    const biasF = cfg.brakeBias / 0.585;
    const biasR = (1 - cfg.brakeBias) / 0.415;

    for (let i = 0; i < 4; i++) {
      const front = i < 2;
      const axle = (front ? cfg.brakeTorqueFront * biasF : cfg.brakeTorqueRear * biasR);
      let t = pedal * axle * 0.5;
      t *= brakeFriction(this.brakeTemp[i], cfg);

      if (abs > 0 && t > 0) {
        // Cycle pressure to hold the slip ratio near the peak.
        const over = clamp((-this.slipRatio[i] - cfg.peakSlipRatio * 1.1) / 0.10, 0, 1);
        this._absRelease[i] = lerp(this._absRelease[i], over * abs, 1 - Math.exp(-h * 60));
        t *= 1 - this._absRelease[i] * 0.9;
      } else {
        this._absRelease[i] = 0;
      }
      out[i] = t;
    }
    // Brake-by-wire: MGU-K harvesting adds rear retardation under braking.
    if (pedal > 0.08 && this.ers < cfg.ersCapacityJ
      && this.ersLapHarvested < cfg.ersHarvestKPerLapJ && this.speed > 12) {
      const rearOmega = Math.max(4, (Math.abs(this.wheelOmega[2]) + Math.abs(this.wheelOmega[3])) * 0.5);
      const harvestW = cfg.ersHarvestPowerW * Math.min(1, pedal * 1.6);
      const torque = Math.min(2600, harvestW / rearOmega);   // reaction at the wheels
      out[2] += torque * 0.5;
      out[3] += torque * 0.5;
      const e = harvestW * h;
      this.ers = Math.min(cfg.ersCapacityJ, this.ers + e);
      this.ersLapHarvested += e;
    }
    return out;
  }

  // -- tyre condition --------------------------------------------------------

  _muAt(i, Fz) {
    const cfg = this.cfg;
    const ratio = clamp(Fz / this.loadRef[i], 0.25, 4);
    let mu = this.muNominal[i] * Math.pow(ratio, -cfg.loadExponent)
      * cfg.compoundGrip * cfg.muBase;

    // Temperature window (surface rubber does the gripping).
    const dT = (this.tyreTemp[i] - cfg.tyreOptTemp) / cfg.tyreTempWindow;
    mu *= lerp(cfg.tyreColdGrip, 1, clamp(1 - dT * dT, 0, 1));

    // Pressure: too low and the carcass folds, too high and the patch shrinks.
    const dp = (this.tyrePressure[i] - cfg.tyrePressureOpt) / 0.45;
    mu *= clamp(1 - 0.16 * dp * dp, 0.7, 1);

    // Wear.
    mu *= 1 - 0.22 * this.tyreWear[i];

    // Camber loss on the loaded outside tyre as the body rolls.
    mu *= 1 - cfg.camberGain * Math.abs(this.rollBody) * 0.5;

    return mu;
  }

  _thermal(i, h, fx, fy, vLong, wheelSurfaceSpeed, vLat, brakeTorque) {
    const cfg = this.cfg;
    // Frictional power in the contact patch.
    const slidePower = Math.abs(fx * (wheelSurfaceSpeed - vLong)) + Math.abs(fy * vLat);
    // Carcass hysteresis: deflection work, roughly load x speed.
    const flexPower = this.wheelLoad[i] * Math.abs(vLong) * 0.0016;

    const air = 26 + this.speed * 0.25;
    const surf = this.tyreTemp[i], core = this.tyreCore[i], carc = this.tyreCarcass[i];

    this.tyreTemp[i] = surf + h * (
      slidePower * 0.0022
      - (surf - air) * (0.35 + this.speed * 0.010)
      - (surf - core) * 1.6
    );
    this.tyreCore[i] = core + h * (
      (surf - core) * 0.55 + flexPower * 0.010
      + Math.max(0, this.brakeTemp[i] - core) * 0.010
      - (core - carc) * 0.30
    );
    this.tyreCarcass[i] = carc + h * ((core - carc) * 0.16 - (carc - air) * 0.030);

    this.tyreTemp[i] = clamp(this.tyreTemp[i], 20, 175);
    this.tyreCore[i] = clamp(this.tyreCore[i], 20, 165);
    this.tyreCarcass[i] = clamp(this.tyreCarcass[i], 20, 150);

    // Pressure follows the carcass gas temperature (ideal gas, cold fill).
    this.tyrePressure[i] = cfg.tyrePressureCold * (this.tyreCarcass[i] + 273) / (25 + 273);

    // Wear from frictional work, accelerated when the surface is overheating.
    const hot = 1 + clamp((this.tyreTemp[i] - cfg.tyreOptTemp - 25) / 45, 0, 2);
    this.tyreWear[i] = clamp(this.tyreWear[i] + slidePower * h * cfg.tyreWearRate * hot, 0, 1);

    // Brake disc: heated by the pad, cooled by the duct.
    const brakePower = Math.abs(brakeTorque * this.wheelOmega[i]);
    const cool = (this.brakeTemp[i] - air) * (0.16 + this.speed * 0.0075);
    this.brakeTemp[i] = clamp(this.brakeTemp[i] + h * (brakePower * 0.0032 - cool), 60, 1250);
  }

  // -- assists ---------------------------------------------------------------

  /** Yaw-moment correction, the way a real stability system trims a slide. */
  _stability(delta) {
    if (this.speed < 8) { this.understeer = 0; return 0; }
    const cfg = this.cfg;

    // Understeer-gradient reference model, capped by the available grip.
    const Kus = 0.0016;
    const ref = -(this.u * delta) / (cfg.wheelbase + Kus * this.u * this.u);
    const muCap = 1.9 * G / Math.max(this.u, 8);
    const target = clamp(ref, -muCap, muCap);
    const err = target - this.yawRate;

    // Understeer (+) / oversteer (-) readout for the HUD and the AI.
    this.understeer = clamp((Math.abs(target) - Math.abs(this.yawRate))
      / Math.max(0.15, Math.abs(target)), -1, 1);

    const k = cfg.assists.stability;
    if (k <= 0) return 0;
    const dead = 0.035;
    const e = Math.sign(err) * Math.max(0, Math.abs(err) - dead);
    return clamp(e * k * 12000 * clamp(this.speed / 26, 0, 1), -3200, 3200);
  }

  // -- pose and telemetry ----------------------------------------------------

  _updateCg() {
    _F.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    this._cg.copy(this.position).addScaledVector(_F, -this.cfg.cgBehind);
  }

  _endStep(dt) {
    const sm = this.circuit ? this.circuit.sampleAt(this.trackS, _sample) : null;
    this._syncPose(sm, dt);
    this._updateTelemetry();
  }

  _syncPose(sm, dt = 1 / 60) {
    if (this.circuit) {
      this.circuit.pointAt(this.trackS, this.trackLateral, 0, _surf);
      this.position.y = _surf.y + this.heave;
    }

    let slope = 0, cross = 0;
    if (sm) {
      slope = Math.asin(clamp(sm.tangent.y, -1, 1));
      const lat = this.trackLateral;
      cross = sm.banking * 0.5 - Math.sign(lat) * 0.10 / this.circuit.halfWidth;
    }

    // Body attitude = road plane + the suspension's own pitch and roll.
    // rotation.x > 0 is nose up; rotation.z > 0 lifts the car's right side.
    const targetPitch = slope + this.pitchBody;
    const targetRoll = Math.atan(cross) - this.rollBody;
    const k = 1 - Math.exp(-dt * 26);
    this.pitch = lerp(this.pitch, targetPitch, k);
    this.roll = lerp(this.roll, targetRoll, k);

    _euler.set(this.pitch, this.yaw, this.roll, 'YXZ');
    this.quaternion.setFromEuler(_euler);
  }

  _updateTelemetry() {
    const t = this.telemetry;
    const cfg = this.cfg;
    t.speed = this.speed;
    t.speedKph = this.speedKph;
    t.rpm = this.rpm;
    t.rpmNorm = clamp(this.rpm / cfg.redline, 0, 1.05);
    t.gear = this.gear;
    t.throttle = this.controls.throttle;
    t.brake = this.controls.brake;
    t.steer = this.controls.steer;
    t.drs = this.drsActive && this.drsBlend > 0.5;
    t.drsBlend = this.drsBlend;
    t.drsAvailable = this.drsAvailable;
    t.ers = this.ers / cfg.ersCapacityJ;
    t.ersDeployedLap = this.ersLapDeployed / cfg.ersDeployPerLapJ;
    t.ersPower = this._mgukPower ?? 0;
    t.boost = this.boost;
    t.gLat = this.gLat;
    t.gLong = this.gLong;
    t.gVert = this.gVert;
    t.wheelSpin = this.wheelSpin;
    t.wheelOmega = this.wheelOmega;
    t.suspension = this.suspension;
    t.slipRatio = this.slipRatio;
    t.slipAngle = this.slipAngle;
    t.tyreTemp = this.tyreTemp;
    t.tyreCore = this.tyreCore;
    t.tyreCarcass = this.tyreCarcass;
    t.tyrePressure = this.tyrePressure;
    t.tyreWear = this.tyreWear;
    t.tyreLoad = this.tyreLoadNorm;
    t.wheelLoad = this.wheelLoad;
    t.brakeTemp = this.brakeTemp;
    t.lockup = this.lockup;
    t.onTrack = this.onTrack = Math.abs(this.trackLateral) <= (this.circuit?.halfWidth ?? 7) + 0.6;
    t.airborne = this.airborne;
    t.kerb = this.kerbContact;
    t.trackS = this.trackS;
    t.trackLateral = this.trackLateral;
    t.rideHeightFront = this._rideFront;
    t.rideHeightRear = this._rideRear;
    t.rake = this._rideRear - this._rideFront;
    t.downforce = this._downforce;
    t.drag = this._drag;
    t.aeroBalance = this._aeroBalance ?? cfg.aeroBalance;
    t.dirtyAir = this.wake.dirty;
    t.slipstream = this.wake.tow;
    t.understeer = this.understeer;
    t.tcCut = this._tcCut;
    t.absActive = Math.max(this._absRelease[0], this._absRelease[1], this._absRelease[2], this._absRelease[3]);
    t.brakeBias = cfg.brakeBias;
  }

  /**
   * Peak lateral acceleration the car can sustain at `speed`, m/s^2.
   * The AI's speed profile is built from this, so it must reflect the same aero
   * map and the same load-sensitive tyre the physics actually uses.
   */
  corneringLimit(speed) {
    const cfg = this.cfg;
    // EFFECTIVE downforce and effective grip, not the wind-tunnel numbers.
    //
    // This function is the AI's ONLY model of what the car can do (three call
    // sites, all in `ai/opponents.js`: the speed profile, the braking scan and
    // the overtaking capacity), so if it is optimistic the whole field drives off
    // the road. It was very optimistic. Two reasons, both real:
    //
    //   * The floor stalls. `_aeroGain()` collapses the floor's contribution once
    //     the plank grounds out, and the static 28 mm front ride height is
    //     compressed to ~4 mm by 90 m/s — measured — so the car spends every fast
    //     corner pinned against the 0.55 gain floor rather than making `clA`.
    //   * The load-sensitive Magic Formula, evaluated through the real load
    //     transfer and the friction ellipse, returns less than this closed form's
    //     axle-average mu.
    //
    // Measured on a constant-speed skidpad, peak sustained lateral was 12.1 m/s^2
    // at 30 m/s and 19.1 at 90, against the 21.6 and 55.2 this function used to
    // promise. The AI therefore planned every medium and fast corner 40-70 % too
    // fast: it arrived over the limit, the rear stepped out, and a solo car with
    // no traffic at all spent a third of its lap in the gravel. The two constants
    // below are fitted to that measurement (they reproduce 12.2 and 19.3) and are
    // named so a physics pass can retune the aero map and then raise them.
    const down = 0.5 * cfg.rho * cfg.clA * speed * speed * cfg.aeroEffectiveProfile;
    const total = cfg.mass * G + down;
    // Two loaded outside tyres carry roughly 70% of it in a steady corner.
    const front = total * this.frontMassFraction * 0.5;
    const rear = total * (1 - this.frontMassFraction) * 0.5;
    const muF = cfg.muFront * Math.pow(clamp(front / cfg.loadRefFront, 0.25, 4), -cfg.loadExponent);
    const muR = cfg.muRear * Math.pow(clamp(rear / cfg.loadRefRear, 0.25, 4), -cfg.loadExponent);
    const mu = (muF * this.frontMassFraction + muR * (1 - this.frontMassFraction))
      * cfg.muBase * cfg.compoundGrip;
    return (mu * total * 0.97 * cfg.gripEffectiveProfile) / cfg.mass;
  }
}

/**
 * Dirty air and slipstream for a whole field, in one O(n^2) sweep.
 *
 * A modern F1 car following another loses a large slice of its downforce — and
 * loses it unevenly, front first — while gaining a tow on the straights. Both
 * effects live on `vehicle.wake` and are read by the aero model.
 *
 * @param {Array<Vehicle|{vehicle:Vehicle}>} cars
 * @param {{wrapS:(s:number)=>number}} circuit
 */
export function applyWakes(cars, circuit) {
  const list = [];
  for (const c of cars) list.push(c instanceof Vehicle ? c : c.vehicle);

  for (const v of list) {
    let gap = Infinity;
    let align = 0;
    for (const o of list) {
      if (o === v) continue;
      const ds = circuit.wrapS(o.trackS - v.trackS);
      if (ds <= 0.5 || ds > 70) continue;
      const dLat = Math.abs(o.trackLateral - v.trackLateral);
      if (dLat > 5.5) continue;
      if (ds < gap) { gap = ds; align = clamp(1 - dLat / 5.5, 0, 1); }
    }
    if (gap === Infinity) {
      v.wake.dirty = 0; v.wake.tow = 0; v.wake.gap = Infinity;
      continue;
    }
    const near = clamp(1 - (gap - 3) / 55, 0, 1);
    v.wake.dirty = Math.pow(near, 1.35) * align;
    v.wake.tow = clamp(1 - (gap - 3) / 30, 0, 1) * align;
    v.wake.gap = gap;
  }
}
