/**
 * APEX GP — race control, session state and the front end.
 *
 * This module is "race control": everything that is true about the SESSION
 * rather than about a car. It observes `Vehicle` instances, keeps the official
 * timing, decides what the flags are, and produces the snapshot the HUD draws.
 *
 * WHAT LIVES HERE
 *   • A full weekend: practice → Q1/Q2/Q3 with eliminations → the grand prix.
 *   • Formation lap, the five-red-lights sequence, jump-start detection.
 *   • Lap and sector timing to the millisecond, with sub-frame interpolation of
 *     the timing-line crossing (see `_crossings`).
 *   • Live standings, leader gaps and car-to-car intervals computed from real
 *     time-at-position rather than distance/speed guesswork.
 *   • Personal best / session best / purple-sector logic.
 *   • Track limits: sustained excursions become warnings, then deleted laps in
 *     practice and qualifying, then time penalties in the race.
 *   • Flags — green, yellow, double yellow, blue, red, chequered — propagated
 *     to the marshal-post flag instances and the start-gantry light panel.
 *   • Safety car and VSC with real field bunching (closing-rate control, not a
 *     teleport).
 *   • Pit stops: request, entry, the 80 km/h limiter, a jacked-up stop with the
 *     wheels actually coming off, a compound change, and the exit.
 *   • Fuel burn (which feeds back into the car's mass) and tyre strategy.
 *   • Penalties, served or added, and the end-of-race classification with points.
 *   • `RaceFrontEnd` — title, session/car/livery/circuit/weather/difficulty
 *     selection, pause menu, settings and results, in the HUD's design language.
 *
 * HOW IT TOUCHES THE WORLD
 *   Race control is *authoritative*, so unlike the old version it does write to
 *   the sim — but only in three narrow, documented ways:
 *     1. `_kinematic()` drives a car along the circuit by pose when physics
 *        cannot (pit lane, formation lap, parked in the garage). Identical in
 *        spirit to `OpponentField._stepPit`.
 *     2. Speed caps under SC/VSC/limiter, applied to the body velocity after
 *        `field.update()` has stepped physics for the frame.
 *     3. `cfg.mass` and `cfg.tyreWearRate` as fuel burns and compounds change.
 *   Everything else is read-only observation.
 *
 * PUBLIC API
 *   new RaceSession({ circuit, cars, totalLaps, playerIndex, ...opts })
 *   session.start()                          legacy: arm a race, lights sequence
 *   session.update(dt)                       call once per FIXED sim step
 *   session.snapshot(index?)                 -> HUD-ready frame
 *   session.carDots()                        -> minimap positions
 *   session.beginWeekend(format?, opts?)     'grandPrix' | 'sprint' | 'quick'
 *   session.beginSession(type, opts?)        'practice'|'q1'|'q2'|'q3'|'race'|'timeTrial'
 *   session.advanceWeekend()                 -> next session in the format
 *   session.setFlag(f) / session.localFlag(sector, f)
 *   session.deployVSC() / session.endVSC()
 *   session.deploySafetyCar() / session.endSafetyCar()
 *   session.throwRedFlag(reason) / session.resumeFromRed()
 *   session.requestPit(index?, { compound })  / session.cancelPit(index?)
 *   session.addPenalty(index, seconds, reason)
 *   session.classify()                       -> [{ position, code, time, points, ... }]
 *   session.standings / .phase / .flag / .drsEnabled / .classification
 *   session.frontEnd                         RaceFrontEnd | null
 *
 * PHASES  'menu' | 'formation' | 'grid' | 'countdown' | 'green' | 'red'
 *         | 'finished' | 'classified' | 'running' (practice / qualifying)
 */

import * as THREE from 'three';
import { formatLapTime, formatGap } from '../hud/hud.js';
import { TEAMS } from '../car/livery.js';
import { WEATHER_STATES } from '../weather/weather.js';
import { clamp, lerp, makeRng, hashSeed } from '../core/rng.js';

// ───────────────────────────────────────────────────────────────────────────
// Rulebook
// ───────────────────────────────────────────────────────────────────────────

/** Championship points for the top ten, plus the fastest-lap bonus. */
export const POINTS = [25, 18, 15, 12, 10, 8, 6, 4, 2, 1];
export const FASTEST_LAP_POINT = 1;

/** 80 km/h, the pit-lane limit. */
export const PIT_SPEED_LIMIT = 80 / 3.6;
/** Safety-car delta pace and the VSC target, as a fraction of racing pace. */
const SC_SPEED = 27.0;            // m/s ≈ 97 km/h behind the safety car
const SC_GAP = 22;                // metres the field is bunched to
const VSC_PACE = 0.62;            // fraction of the AI's normal target speed

/**
 * Tyre compounds as race control sees them: relative pace, how fast they wear
 * (multiplier on the physics' `tyreWearRate`) and how far they will go.
 */
export const TYRES = {
  soft:   { label: 'SOFT',   letter: 'C5', pace: 1.014, wear: 1.85, life: 0.55, colour: '#ff2d37' },
  medium: { label: 'MEDIUM', letter: 'C3', pace: 1.000, wear: 1.20, life: 0.78, colour: '#ffd21e' },
  hard:   { label: 'HARD',   letter: 'C1', pace: 0.985, wear: 0.85, life: 1.00, colour: '#eef2f6' },
  inter:  { label: 'INTER',  letter: 'IN', pace: 0.93,  wear: 1.55, life: 0.62, colour: '#22e07c' },
  wet:    { label: 'WET',    letter: 'WE', pace: 0.86,  wear: 1.35, life: 0.70, colour: '#3399ff' },
};
export const DRY_COMPOUNDS = ['soft', 'medium', 'hard'];

/** AI skill / assist package per difficulty. */
export const DIFFICULTIES = {
  rookie:   { label: 'ROOKIE',   ai: 0.860, assists: { tc: 1.0, abs: 1.0, stability: 1.0 }, fuel: 0.7, wear: 0.55 },
  amateur:  { label: 'AMATEUR',  ai: 0.905, assists: { tc: 0.7, abs: 0.8, stability: 0.6 }, fuel: 0.85, wear: 0.75 },
  pro:      { label: 'PRO',      ai: 0.945, assists: { tc: 0.35, abs: 0.5, stability: 0.3 }, fuel: 1.0, wear: 1.0 },
  expert:   { label: 'EXPERT',   ai: 0.975, assists: { tc: 0.1, abs: 0.2, stability: 0.1 }, fuel: 1.0, wear: 1.15 },
  legend:   { label: 'LEGEND',   ai: 1.000, assists: { tc: 0, abs: 0, stability: 0 }, fuel: 1.0, wear: 1.3 },
};

/**
 * Session definitions. `minutes` is wall-clock length; qualifying knockouts
 * eliminate `drop` cars from the back of the timesheet when the clock expires.
 */
export const SESSION_DEFS = {
  practice:  { key: 'practice',  label: 'FREE PRACTICE', short: 'FP',  timed: true, minutes: 6,   drop: 0,  flyingStart: true },
  q1:        { key: 'q1',        label: 'QUALIFYING 1',  short: 'Q1',  timed: true, minutes: 5,   drop: 5,  flyingStart: true },
  q2:        { key: 'q2',        label: 'QUALIFYING 2',  short: 'Q2',  timed: true, minutes: 4,   drop: 5,  flyingStart: true },
  q3:        { key: 'q3',        label: 'QUALIFYING 3',  short: 'Q3',  timed: true, minutes: 3.5, drop: 0,  flyingStart: true },
  race:      { key: 'race',      label: 'GRAND PRIX',    short: 'RACE', timed: false, minutes: 0,  drop: 0,  flyingStart: false },
  timeTrial: { key: 'timeTrial', label: 'TIME TRIAL',    short: 'TT',  timed: true, minutes: 10,  drop: 0,  flyingStart: true, solo: true },
};

export const WEEKEND_FORMATS = {
  quick:     { label: 'QUICK RACE',    sessions: ['race'] },
  grandPrix: { label: 'RACE WEEKEND',  sessions: ['practice', 'q1', 'q2', 'q3', 'race'] },
  sprint:    { label: 'SPRINT WEEKEND', sessions: ['practice', 'q1', 'q2', 'q3', 'race'] },
  timeTrial: { label: 'TIME TRIAL',    sessions: ['timeTrial'] },
};

/** Marshal-flag atlas cells, as painted by `environment.js#flagTexture`. */
const FLAG_CELL = { yellow: 0, blue: 1, chequered: 2, team: 3 };

/** How far past the white line all four wheels must be to count as off track. */
const TRACK_LIMIT_MARGIN = 0.95;
/** Sustained excursion that becomes an official warning. */
const TRACK_LIMIT_HOLD = 0.22;

/**
 * Every car keeps a ring buffer of (progress, time) so a gap can be answered
 * the way a real timing loop answers it — "how long ago was the car ahead
 * standing where I am now?" — instead of dividing metres by a speed that is
 * changing under braking. 2048 samples at 30 Hz is 68 s of history, about one
 * lap, which is exactly as far back as a gap is ever meaningful (beyond that
 * the car is lapped and the tower says so).
 */
const TRACE_N = 2048;
const TRACE_DT = 1 / 30;
/** A jump larger than this is a restage, not driving: rebaseline, don't integrate. */
const TELEPORT_M = 45;
/** Seconds behind the car ahead, at the detection point, that grants the flap. */
const DRS_WINDOW = 1.0;

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _one = new THREE.Vector3(1, 1, 1);
const _up = new THREE.Vector3(0, 1, 0);

// ───────────────────────────────────────────────────────────────────────────
// Small helpers
// ───────────────────────────────────────────────────────────────────────────

/** Shortest signed distance from `a` to `b` around a loop of length `L`. */
function wrapDelta(a, b, L) {
  let d = b - a;
  if (d < -L * 0.5) d += L;
  else if (d > L * 0.5) d -= L;
  return d;
}

/** Forward-only distance from `a` to `b` around a loop of length `L`. */
function forwardDelta(a, b, L) {
  let d = b - a;
  while (d < 0) d += L;
  while (d >= L) d -= L;
  return d;
}

export function formatDelta(d) {
  if (!isFinite(d)) return '';
  return `${d >= 0 ? '+' : '-'}${Math.abs(d).toFixed(3)}`;
}

export function formatClock(seconds) {
  if (!isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds - m * 60);
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

/** Sector time, ss.sss with no minute field (they are always < 60 s here). */
export function formatSector(t) {
  return isFinite(t) && t > 0 ? t.toFixed(3) : '--.---';
}

/**
 * A race distance, not a lap. `formatLapTime` has no hours field, so a full
 * grand prix classified through it reads "63:12.480" instead of "1:03:12.480".
 * Hours appear only once there are any, exactly as a results sheet prints them.
 */
export function formatRaceTime(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return '--:--.---';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds - h * 3600) / 60);
  const s = seconds - h * 3600 - m * 60;
  const mm = h > 0 && m < 10 ? `0${m}` : `${m}`;
  return `${h > 0 ? `${h}:` : ''}${mm}:${s < 10 ? '0' : ''}${s.toFixed(3)}`;
}

// ───────────────────────────────────────────────────────────────────────────
// RaceSession
// ───────────────────────────────────────────────────────────────────────────

export class RaceSession {
  /**
   * @param {{circuit:object, cars:Array, totalLaps?:number, playerIndex?:number,
   *          field?:object, environment?:object, weather?:object, engine?:object,
   *          sessionType?:string, format?:string, difficulty?:string,
   *          ui?:boolean|'auto', seed?:number}} o
   */
  constructor({
    circuit, cars, totalLaps = 12, playerIndex = 0,
    field = null, environment = null, weather = null, engine = null,
    sessionType = 'race', format = 'quick', difficulty = 'pro',
    ui = 'auto', seed = 7,
  }) {
    this.circuit = circuit;
    this.cars = cars;
    this.totalLaps = totalLaps;
    this.playerIndex = playerIndex;
    this.field = field;
    this.environment = environment;
    this.weather = weather;
    this.engine = engine;
    this.difficulty = difficulty;
    this.rng = makeRng(hashSeed(`race:${seed}`));

    this.time = 0;                 // session clock, seconds since update() began
    this.sessionTime = 0;          // clock for the *current* session
    this.phase = 'countdown';
    this.flag = 'green';
    this.countdown = 0;
    this.lights = 0;               // 0..5 red columns lit on the gantry
    this.banner = null;
    this.drsEnabled = false;
    this.bestLapOverall = Infinity;
    this.bestSectors = [Infinity, Infinity, Infinity];
    this.fastestLap = null;
    this.classification = null;
    this.raceStart = 0;
    this.leaderFinishTime = Infinity;

    this.format = WEEKEND_FORMATS[format] ? format : 'quick';
    this.weekend = [...WEEKEND_FORMATS[this.format].sessions];
    this.weekendIndex = 0;
    this.sessionType = sessionType;
    this.def = SESSION_DEFS[sessionType] ?? SESSION_DEFS.race;
    this.sessionRemaining = this.def.minutes * 60;
    this.eliminated = new Set();   // driver indices knocked out of qualifying
    this.gridOrder = cars.map((_, i) => i);

    // Safety car / VSC.
    this.safetyCar = { active: false, phase: 'none', timer: 0, lapsLeft: 0 };
    this.vsc = { active: false, timer: 0 };
    this.sectorFlags = ['green', 'green', 'green'];
    this.incidents = [];

    this.messages = [];            // race-control radio feed for the HUD/UI
    this._marshals = null;
    this._bound = false;
    this._timingPoints = circuit ? [0, circuit.sectorStarts[1], circuit.sectorStarts[2]] : [0, 0, 0];

    this.state = cars.map((c, i) => this._makeState(c, i));

    // Physics baselines we scale as fuel burns and compounds change. Captured
    // once, here, so repeated `beginSession()` calls never compound them.
    for (const c of cars) {
      const cfg = c.vehicle.cfg;
      if (cfg._baseMass == null) cfg._baseMass = cfg.mass;
      if (cfg._baseWear == null) cfg._baseWear = cfg.tyreWearRate;
    }

    this.standings = [...this.state];
    this._rank();
    this._watchCapture();

    this.uiMode = ui;
    this.frontEnd = null;
    if (ui !== false && typeof document !== 'undefined') {
      this.frontEnd = new RaceFrontEnd(this, { auto: ui === 'auto' });
    }
  }

  _makeState(c, i) {
    const L = this.circuit.length;
    const s = isFinite(c.vehicle.trackS) ? c.vehicle.trackS : 0;
    // Reuse the ring buffers across `beginSession()` so a weekend does not
    // allocate 650 kB per session; `_resetTrace` just empties them.
    const trace = this.state?.[i]?.trace ?? {
      p: new Float64Array(TRACE_N), t: new Float64Array(TRACE_N),
      head: -1, count: 0, last: -1e9,
    };
    trace.head = -1; trace.count = 0; trace.last = -1e9;
    return {
      trace,
      index: i,
      code: c.entry.driver.code,
      name: c.entry.driver.name,
      number: c.entry.driver.number,
      team: c.entry.team.name,
      teamShort: c.entry.team.short,
      colour: c.entry.team.primary,

      // Timing.
      lapsDone: 0,                 // completed timing-line crossings
      lap: 1,
      sector: this.circuit.sectorOf(s),
      lapStart: 0,                 // session clock at the start of this lap
      sectorStart: 0,
      lastLap: 0,
      bestLap: Infinity,
      currentSectors: [0, 0, 0],
      lastSectors: [0, 0, 0],
      lastSectorStatus: ['', '', ''],
      shownSectors: [0, 0, 0],
      shownStatus: ['', '', ''],
      bestSectorTimes: [Infinity, Infinity, Infinity],
      sectorStatus: ['', '', ''],
      timingArmed: false,          // true once the car has crossed the line once
      lapValid: true,
      deletedLaps: 0,

      // Position.
      lastS: s,
      progress: s,                 // monotonic metres travelled
      position: i + 1,
      gap: 0,
      interval: 0,
      lapped: false,

      // Race craft.
      compound: c.compound ?? 'medium',
      tyreAge: 0,
      tyreLife: 1,
      fuel: 0,
      fuelStart: 0,
      pit: false,
      pitRequests: 0,
      pitStops: 0,
      pitState: null,
      drs: false,
      drsOpen: false,
      drsArmed: -1,                // index of the zone this car has been granted
      penalty: 0,
      penaltyServed: 0,
      penalties: [],
      warnings: 0,
      offTrackTimer: 0,
      blue: false,
      retired: false,
      out: false,                  // eliminated from qualifying / in the garage
      finished: false,
      finishTime: Infinity,
      jumpStart: false,
      parkS: null,                 // where a parked/retired car is held
      parkLat: 0,
      startProgress: 0,
      grid: i + 1,
      points: 0,
      _L: L,
    };
  }

  // ── binding to the live engine ──────────────────────────────────────────

  /**
   * The engine constructs the session before it installs `window.__APEX__`, so
   * everything optional is resolved lazily on the first update. This is what
   * lets race control reach the environment's light panel and the weather.
   */
  _bindEngine() {
    if (this._bound) return;
    const eng = this.engine ?? (typeof window !== 'undefined' ? window.__APEX__?.engine : null);
    if (!eng) return;
    this._bound = true;
    this.engine = eng;
    this.field = this.field ?? eng.field;
    this.environment = this.environment ?? eng.environment;
    this.weather = this.weather ?? eng.weather;

    this._bindMarshals();
    this.setDifficulty(this.difficulty);
    // The reference lap needs the field's speed profile, which only exists now.
    this._syncStrategy();
    this.frontEnd?.onEngineReady();
  }

  /**
   * Find the marshal-post flag instances so local flags can actually fly. The
   * mesh is public (it hangs off `environment.group`); we only rewrite its
   * per-instance atlas cell, never its geometry.
   */
  _bindMarshals() {
    const env = this.environment;
    if (!env?.group) return;
    const posts = env.group.getObjectByName('MarshalPosts');
    if (!posts) return;
    let mesh = null;
    posts.traverse((o) => {
      if (!mesh && o.isInstancedMesh && o.geometry?.getAttribute('aCell')) mesh = o;
    });
    if (!mesh) return;
    const cell = mesh.geometry.getAttribute('aCell');
    const sectors = new Int8Array(mesh.count);
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, _m);
      _v.setFromMatrixPosition(_m);
      sectors[i] = this.circuit.sectorOf(this.circuit.nearest(_v).s);
    }
    this._marshals = { mesh, cell, sectors, shown: new Int8Array(mesh.count).fill(-1) };
  }

  /** Fly the right flag at every marshal post for the current sector state. */
  _updateMarshals() {
    const m = this._marshals;
    if (!m) return;
    let dirty = false;
    for (let i = 0; i < m.mesh.count; i++) {
      const f = this.flag === 'chequered' || this.flag === 'red'
        ? (this.flag === 'red' ? FLAG_CELL.yellow : FLAG_CELL.chequered)
        : this.sectorFlags[m.sectors[i]] === 'yellow' || this.sectorFlags[m.sectors[i]] === 'double'
          ? FLAG_CELL.yellow
          : this._anyBlueIn(m.sectors[i]) ? FLAG_CELL.blue : FLAG_CELL.team;
      if (m.shown[i] !== f) { m.shown[i] = f; m.cell.setX(i, f); dirty = true; }
    }
    if (dirty) m.cell.needsUpdate = true;
  }

  _anyBlueIn(sector) {
    for (const st of this.state) {
      if (st.blue && this.circuit.sectorOf(this.cars[st.index].vehicle.trackS) === sector) return true;
    }
    return false;
  }

  // ── session lifecycle ───────────────────────────────────────────────────

  /** Legacy entry point: arm a grand prix and run the lights. */
  start() {
    this.beginSession('race', { lights: true });
    return this;
  }

  /** Start a whole weekend from the beginning of its first session. */
  beginWeekend(format = this.format, opts = {}) {
    this.format = WEEKEND_FORMATS[format] ? format : 'quick';
    this.weekend = [...WEEKEND_FORMATS[this.format].sessions];
    this.weekendIndex = 0;
    this.eliminated.clear();
    this.championship = this.championship ?? new Map();
    return this.beginSession(this.weekend[0], opts);
  }

  /** Move to the next session in the weekend; returns false at the end. */
  advanceWeekend(opts = {}) {
    if (this.weekendIndex >= this.weekend.length - 1) return false;
    this.weekendIndex++;
    return this.beginSession(this.weekend[this.weekendIndex], opts) && true;
  }

  get nextSessionType() {
    return this.weekendIndex < this.weekend.length - 1 ? this.weekend[this.weekendIndex + 1] : null;
  }

  /**
   * Arm a session. Qualifying and practice roll out of the pit lane onto a
   * flying lap; the race stages the grid and runs the formation lap.
   */
  beginSession(type, opts = {}) {
    this._bindEngine();
    const def = SESSION_DEFS[type] ?? SESSION_DEFS.race;
    this.sessionType = type;
    this.def = def;
    this.sessionTime = 0;
    this.sessionRemaining = (opts.minutes ?? def.minutes) * 60;
    this.classification = null;
    this.fastestLap = null;
    this.bestLapOverall = Infinity;
    this.bestSectors = [Infinity, Infinity, Infinity];
    this.flag = 'green';
    this.sectorFlags = ['green', 'green', 'green'];
    this.banner = null;
    this.messages.length = 0;
    this.leaderFinishTime = Infinity;
    this.safetyCar = { active: false, phase: 'none', timer: 0, lapsLeft: 0 };
    this.vsc = { active: false, timer: 0 };
    this.incidents.length = 0;
    this._chequeredHold = 100;
    this.leaderFinishTime = Infinity;
    this._restorePace();
    if (opts.laps) this.totalLaps = opts.laps;

    // Everyone who was knocked out of qualifying is back in for the race.
    if (type === 'race' || type === 'practice') this.eliminated.clear();

    // Reset per-driver state but keep identity and championship points.
    this.state.forEach((st, i) => {
      const fresh = this._makeState(this.cars[i], i);
      fresh.points = st.points;
      fresh.grid = st.grid;
      Object.assign(st, fresh);
      st.out = this.eliminated.has(i);
    });

    if (type === 'race') this._stageGrid(opts);
    else this._stageFlying(opts);

    this._syncStrategy();
    this._rank();
    return this;
  }

  /**
   * A grid nobody qualified for.
   *
   * The AI's personas already carry a pecking order — `paceScale` spreads the
   * field over about 1.6 s a lap — so ordering by pace alone reproduces the
   * entry list exactly, teams in pairs, which is the one thing a real starting
   * grid never looks like. What breaks that up in reality is driver form on the
   * day, and the two effects are calibrated against each other: a real
   * qualifying sheet spans roughly 2 s from pole to P20 while a driver's
   * session-to-session scatter is only a couple of tenths. So `QUALI_SPREAD`
   * scales the race-pace deficit up to a qualifying deficit and `scatter` stays
   * deliberately small — big enough to shuffle team-mates and the cars inside a
   * performance bracket, far too small to move a midfield car onto the front
   * row. Deterministic from the master seed.
   *
   * `playerSlot` (1-based) forces the player into a slot after the sort, which
   * is what the setup screen's GRID row asks for; without it the player is
   * seeded from their team-mate's pace, so the grid honours the car they are
   * actually driving.
   */
  seedGrid({ scatter = 0.20, playerSlot = null } = {}) {
    const ref = this._reference();
    const lap = ref?.lap ?? 68;
    const QUALI_SPREAD = 1.15;
    const rng = makeRng(hashSeed(`grid:${this.format}:${this.cars.length}`));
    const paceOf = (index) => this.cars[index].ai?.persona?.paceScale ?? NaN;
    const paces = this.cars.map((_, i) => paceOf(i)).filter(isFinite).sort((a, b) => a - b);
    const median = paces.length ? paces[paces.length >> 1] : 1;
    // The player has no persona. Their team-mate is in the same car, so that is
    // the honest performance estimate; fall back to the field median.
    const mate = this.cars.findIndex((c, i) => i !== this.playerIndex
      && c.entry.team === this.cars[this.playerIndex]?.entry.team && isFinite(paceOf(i)));
    const playerPace = mate >= 0 ? paceOf(mate) : median;

    const rows = this.state.map((st) => {
      const pace = isFinite(paceOf(st.index)) ? paceOf(st.index) : playerPace;
      const t = (1 / clamp(pace, 0.5, 1) - 1) * lap * QUALI_SPREAD + (rng() - 0.5) * 2 * scatter;
      return { index: st.index, t };
    });
    rows.sort((a, b) => a.t - b.t);

    let order = rows.map((r) => r.index);
    if (playerSlot != null) {
      const want = clamp(Math.round(playerSlot), 1, order.length) - 1;
      order = order.filter((i) => i !== this.playerIndex);
      order.splice(want, 0, this.playerIndex);
    }
    this.gridOrder = order;
    // The timesheet that would have produced this grid, pole-relative. The
    // player's own entry is only meaningful when they were not forced into a
    // slot, so it is reported as NaN when it would be a fiction.
    const t0 = rows[0].t;
    const byIndex = new Map(rows.map((r) => [r.index, r.t - t0]));
    this.gridTimes = order.map((i) => (playerSlot != null && i === this.playerIndex
      ? NaN : byIndex.get(i)));
    return this;
  }

  /** Put the field on the grid in classification order and arm the start. */
  _stageGrid(opts = {}) {
    // No qualifying result to work from (a quick race, or a restart before the
    // weekend has run its Saturday) — invent a believable one.
    if (opts.seedGrid !== false && !this.qualifyingResult) {
      this.seedGrid({ playerSlot: opts.playerSlot ?? this.playerSlot ?? null });
    }
    const order = this.gridOrder;
    order.forEach((carIndex, slotIndex) => {
      const slot = this.circuit.gridSlot(slotIndex);
      const car = this.cars[carIndex];
      car.vehicle.reset({ s: slot.s, lateral: slot.lateral, speed: 0 });
      const st = this.state[carIndex];
      st.grid = slotIndex + 1;
      st.position = slotIndex + 1;
      st.lastS = slot.s;
      // `progress` is monotonic metres, so the grid sits just BEHIND the line:
      // pole on -18 m, the back row a hundred metres further back.
      st.progress = slot.s - this.circuit.length;
      if (car.ai) { car.ai.launched = false; car.ai.launchTimer = 0; car.ai.mode = 'race'; }
      if (this.field) { car.distance = 0; car.lastS = slot.s; car.lap = 1; car.inPit = false; }
    });

    // The formation lap is staged over the last ~1.1 km rather than a full lap:
    // that is the part television actually shows — the field streaming down to
    // the grid and slotting in — and it keeps it to about half a minute.
    this.formationLaps = opts.formation === false ? 0 : 1;
    const runIn = Math.min(this.circuit.length - 40, opts.formationMetres ?? 1150);
    this._formation = {
      t: 0, total: runIn, dist: 0,
      s0: this.circuit.wrapS(this.circuit.gridSlot(0).s - runIn),
    };
    this.phase = this.formationLaps > 0 ? 'formation' : 'grid';
    if (this.formationLaps > 0) {
      // Put everyone at the head of the run-in so the lap starts on the move.
      order.forEach((carIndex, slotIndex) => {
        const back = slotIndex * 11.5;
        const s = this.circuit.wrapS(this._formation.s0 - back);
        this._kinematic(this.cars[carIndex], s, this.circuit.racingLineOffset(s), 22, 1 / 60);
        this.state[carIndex].lastS = s;
        this.state[carIndex].progress = -(runIn + back);
      });
    }
    this.countdown = 0;
    this.lights = 0;
    this.raceStart = 0;
    this.drsEnabled = false;
    if (this.formationLaps > 0) this._say('FORMATION LAP', 'Formation lap under way');
    else { this._say('GRID', 'Field forming up on the grid'); this._armLights(); }
  }

  /** Practice / qualifying: everyone is already circulating on a flying lap. */
  _stageFlying() {
    const c = this.circuit;
    const n = this.cars.length;
    this.cars.forEach((car, i) => {
      const st = this.state[i];
      if (st.out) { this._parkInGarage(car, st); return; }
      // Space the field out around the whole lap so nobody is in traffic.
      const s = c.wrapS((i / n) * c.length + 30);
      const lat = c.racingLineOffset(s);
      const pace = this._paceAt(s) * 0.92;
      car.vehicle.reset({ s, lateral: lat, speed: pace });
      st.lastS = s;
      st.progress = s;
      st.timingArmed = false;
      if (car.ai) { car.ai.launched = true; car.ai.mode = 'race'; car.ai.launchTimer = 9; }
      if (this.field) { car.distance = 0; car.lastS = s; car.lap = 1; car.inPit = false; }
    });
    this.phase = 'running';
    this.flag = 'green';
    this.drsEnabled = true;
    this.lights = 0;
    this.environment?.setStartLights?.(0);
    this._say(this.def.label, `${this.def.label} — green light`);
  }

  _paceAt(s) {
    const p = this.field?.profile;
    if (!p) return 55;
    return p[this.circuit.sampleIndex(s)] ?? 55;
  }

  setDifficulty(key) {
    const d = DIFFICULTIES[key] ?? DIFFICULTIES.pro;
    this.difficulty = DIFFICULTIES[key] ? key : 'pro';
    for (const c of this.cars) {
      if (c.ai && c.ai.persona) {
        c.ai.persona._baseSkill = c.ai.persona._baseSkill ?? c.ai.persona.skill;
        const s = clamp(c.ai.persona._baseSkill * (0.72 + d.ai * 0.30), 0.55, 1.0);
        c.ai.persona.skill = s;
        c.ai.persona.paceScale = clamp(0.938 + s * 0.062, 0.90, 1.0);
        c.ai.persona.brakeConfidence = clamp(0.80 + s * 0.155, 0.72, 0.965);
      }
    }
    const player = this.cars[this.playerIndex]?.vehicle;
    player?.setAssists?.({
      tractionControl: d.assists.tc,
      abs: d.assists.abs,
      stability: d.assists.stability,
    });
    return this;
  }

  // ── the lights ──────────────────────────────────────────────────────────

  _armLights() {
    this.phase = 'countdown';
    this.lights = 0;
    this.countdown = 5.6;
    // The hold after the fifth light is genuinely random, 0.2–3.0 s.
    this._lightHold = 0.9 + this.rng() * 1.9;
    this._lightsT = 0;
    this.environment?.setStartLights?.(0);
    // The mark every car is measured against for a jump start.
    for (const st of this.state) st.startProgress = st.progress;
    this._say('LIGHTS', 'Starting procedure — lights on the gantry');
  }

  _updateLights(dt) {
    this._lightsT += dt;
    // 1 s per light, five lights, then the hold, then out.
    const n = Math.min(5, Math.floor(this._lightsT / 1.0));
    if (n !== this.lights) {
      this.lights = n;
      this.environment?.setStartLights?.(n);
    }
    this.countdown = Math.max(0, 5.0 + this._lightHold - this._lightsT);

    // Hold everyone until the lights go out.
    for (const c of this.cars) {
      const st = this.state[c.index];
      if (st.out || st.retired) continue;
      if (c.ai) { c.ai.launched = false; c.ai.launchTimer = 0; }
      // Jump start: 30 cm of creep before the lights go out.
      if (!st.jumpStart && st.progress - st.startProgress > 0.30 && this._lightsT > 1.0) {
        st.jumpStart = true;
        this.addPenalty(c.index, 5, 'JUMP START');
      }
    }
    const auto = this.engine?._autoDriver;
    if (auto) { auto.launched = false; auto.launchTimer = 0; }

    if (this._lightsT >= 5.0 + this._lightHold) {
      this.lights = 0;
      this.environment?.setStartLights?.(0);
      this.phase = 'green';
      this.flag = 'green';
      this.raceStart = this.time;
      this.countdown = 0;
      for (const st of this.state) { st.lapStart = this.time; st.sectorStart = this.time; st.sector = 0; }
      this._say('LIGHTS OUT', 'Lights out and away we go');
    }
  }

  // ── formation lap ───────────────────────────────────────────────────────

  /**
   * The formation lap is choreographed rather than simulated: the field snakes
   * round in grid order at a warm-up pace and slots back onto the boxes. This
   * is both far more robust than asking twenty AI drivers to do a slow lap in
   * formation, and much closer to what it looks like on television.
   */
  _updateFormation(dt) {
    const c = this.circuit;
    const f = this._formation;
    f.t += dt;

    const LEAD_PACE = 40;          // m/s, a proper warm-up pace
    const total = f.total;
    // Ease in and out: the field runs down to the line, then closes right up so
    // the back rows are already on their marks when the leader stops.
    const remaining = total - f.dist;
    const ramp = Math.min(1, 0.55 + f.t / 3.0);
    const slow = clamp(remaining / 170, 0.10, 1);
    const leadSpeed = LEAD_PACE * ramp * slow;
    f.dist += leadSpeed * dt;

    this.gridOrder.forEach((carIndex, slotIndex) => {
      const car = this.cars[carIndex];
      const st = this.state[carIndex];
      if (st.out || st.retired) return;
      // The queue compresses as the leader slows for the grid.
      const back = slotIndex * lerp(8.4, 11.5, clamp(remaining / 260, 0, 1));
      const s = c.wrapS(f.s0 + Math.max(0, f.dist - back));
      // Weave: warming the tyres is the whole point of the lap.
      const weave = Math.sin(f.t * 1.7 + slotIndex * 0.9) * 1.5 * clamp(remaining / total, 0, 1);
      const home = c.gridSlot(slotIndex).lateral;
      const blend = clamp((remaining - 40) / 170, 0, 1);
      const lat = lerp(home, c.racingLineOffset(s) + weave, blend);
      this._kinematic(car, s, lat, Math.max(0, leadSpeed - slotIndex * 0.02), dt);
      st.lastS = car.vehicle.trackS;
      st.progress = -(remaining + back);
    });

    this.banner = 'FORMATION LAP';
    if (f.dist >= total - 2) {
      // Settle everyone exactly on their box and arm the lights.
      this.gridOrder.forEach((carIndex, slotIndex) => {
        const slot = c.gridSlot(slotIndex);
        const car = this.cars[carIndex];
        car.vehicle.reset({ s: slot.s, lateral: slot.lateral, speed: 0 });
        const st = this.state[carIndex];
        st.lastS = slot.s;
        st.progress = slot.s - c.length;
        st.startProgress = st.progress;
      });
      this.phase = 'grid';
      this._gridTimer = 2.2;
      this.banner = 'GRID';
      this._say('GRID', 'Field formed up on the grid');
    }
  }

  // ── the capture harness ─────────────────────────────────────────────────

  /**
   * `tools/shot.mjs` stages the whole field itself and then freezes the sim, so
   * race control must get out of the way: a formation lap or a pit sequence
   * would drag the cars straight back off their marks. A tiny rAF watch is the
   * only place we can see it, because a frozen engine never calls `update()`.
   */
  _watchCapture() {
    if (typeof requestAnimationFrame === 'undefined') return;
    const tick = () => {
      this._captureRaf = requestAnimationFrame(tick);
      const eng = this.engine ?? window.__APEX__?.engine;
      const shot = eng?.captureShot;
      if (!shot || shot === this._lastShot) return;
      this._lastShot = shot;
      this.engine = this.engine ?? eng;
      this.environment = this.environment ?? eng.environment;
      this.field = this.field ?? eng.field;
      this.weather = this.weather ?? eng.weather;
      this._poseForCapture(shot);
    };
    this._captureRaf = requestAnimationFrame(tick);
  }

  // ── the reference lap ───────────────────────────────────────────────────

  /**
   * Integrating `1/v` along the AI's speed profile gives the time a car would
   * take to reach any point on the circuit. That is a real, physically-derived
   * lap — the same solve the AI drives to — and it is what race control uses as
   * the delta reference before a driver has set a lap of their own, and to
   * resume timing coherently when a session is joined part way through.
   */
  _reference() {
    if (this._ref) return this._ref;
    const p = this.field?.profile;
    const c = this.circuit;
    if (!p || !p.length) return null;
    const step = c.step;
    const cum = new Float64Array(p.length + 1);
    for (let i = 0; i < p.length; i++) cum[i + 1] = cum[i] + step / Math.max(12, p[i]);
    // The quasi-steady-state solve is optimistic by a couple of percent.
    const SLACK = 1.028;
    for (let i = 0; i <= p.length; i++) cum[i] *= SLACK;
    const timeAt = (s) => {
      const f = c.wrapS(s) / step;
      const i = Math.min(p.length - 1, Math.floor(f));
      return lerp(cum[i], cum[i + 1], f - i);
    };
    const lap = cum[p.length];
    // Cumulative time at each sector boundary; the third closes on the lap.
    const splits = [0, timeAt(c.sectorStarts[1]), timeAt(c.sectorStarts[2])];
    const sectors = [splits[1] - splits[0], splits[2] - splits[1], lap - splits[2]];
    this._ref = { cum, timeAt, lap, sectors, splits };
    return this._ref;
  }

  /**
   * Give every driver a coherent, already-running lap consistent with where
   * they physically are on the circuit. Used when a capture or a resume drops
   * the field in mid-session with no timing history.
   */
  seedReferenceTimes({ spread = true } = {}) {
    const ref = this._reference();
    if (!ref) return this;

    // The timesheet has to agree with the running order. Seeding each driver's
    // pace purely from their persona does not: the field is dropped wherever the
    // harness put it, so the leader can end up a second a lap slower than the
    // car fourth on the road, which is the one thing that makes a timing tower
    // read as fake. So the deficit is mostly a function of *position* — the car
    // in front is, on average, the quicker car — with the persona and a seeded
    // jitter supplying the rest, so it is not a perfect staircase either.
    const byRoad = [...this.state].sort((a, b) => b.progress - a.progress);
    const rank = new Map(byRoad.map((st, i) => [st.index, i]));
    const n = Math.max(1, byRoad.length - 1);
    const rng = makeRng(hashSeed(`sheet:${this.sessionType}`));
    const jitter = new Map(this.state.map((st) => [st.index, (rng() - 0.5) * 2]));
    const paceOf = (st) => {
      if (!spread) return 1;
      const pos = (rank.get(st.index) ?? 0) / n;                       // 0 = leader
      const persona = 1 / clamp(this.cars[st.index].ai?.persona?.paceScale ?? 1, 0.5, 1);
      // 0 → +2.4% over the field, plus a quarter of the persona's own deficit
      // and ±0.25% of scatter. Roughly a 1.7 s spread over a 68 s lap.
      const k = 1 + pos * 0.024 + (persona - 1) * 0.25 + jitter.get(st.index) * 0.0025;
      return clamp(k, 0.99, 1.06);
    };
    let bestSeen = Infinity, bestBy = null;
    for (const st of this.state) {
      const v = this.cars[st.index].vehicle;
      const k = paceOf(st);
      const sector = this.circuit.sectorOf(v.trackS);
      const elapsed = ref.timeAt(v.trackS) * k;
      st.timingArmed = true;
      st.lapStart = this.time - elapsed;
      st.sector = sector;
      st.sectorStart = this.time - (elapsed - ref.splits[sector] * k);
      st.currentSectors = [0, 0, 0];
      st.sectorStatus = ['', '', ''];
      // THE PREVIOUS LAP'S SPLITS MUST ADD UP TO IT. The HUD carries them
      // forward under the lap in progress and prints `LAST` two rows below, so
      // scaling the reference sectors by `k` while the lap itself got `k*1.011`
      // put `28.237 + 32.946 + 31.013` next to `LAST 1:33.210` — a one-second
      // hole, and exactly the kind of tell that makes a timesheet read as
      // generated. Skew redistributes between the three, then one factor closes
      // the sum on the lap exactly.
      const lastK = k * 1.011;
      st.lastLap = ref.lap * lastK;
      const skew = ref.sectors.map(() => 1 + (rng() - 0.5) * 0.020);
      const raw = ref.sectors.map((t, i) => t * lastK * skew[i]);
      const sum = raw[0] + raw[1] + raw[2];
      st.lastSectors = raw.map((t) => (t * st.lastLap) / sum);
      st.lastSectorStatus = ['yellow', 'yellow', 'yellow'];
      for (let i = 0; i < sector; i++) st.currentSectors[i] = ref.sectors[i] * k;
      st.bestSectorTimes = ref.sectors.map((t) => t * k * 1.004);
      st.bestLap = ref.lap * k * 1.004;
      st.lapValid = true;
      if (st.bestLap < bestSeen) { bestSeen = st.bestLap; bestBy = st; }
    }
    this.bestLapOverall = bestSeen;
    // Session best has to include the splits banked on the lap in progress,
    // otherwise a sector graded 'purple' below is quicker than the session best
    // it was graded against.
    this.bestSectors = [0, 1, 2].map((i) => Math.min(
      ...this.state.map((s) => s.bestSectorTimes[i]),
      ...this.state.map((s) => (s.currentSectors[i] > 0 ? s.currentSectors[i] : Infinity)),
    ));
    for (const st of this.state) {
      for (let i = 0; i < 3; i++) {
        if (st.currentSectors[i] <= 0) continue;
        st.sectorStatus[i] = st.currentSectors[i] <= this.bestSectors[i] + 1e-9 ? 'purple'
          : st.currentSectors[i] <= st.bestSectorTimes[i] + 1e-9 ? 'green' : 'yellow';
      }
    }
    if (bestBy) {
      this.fastestLap = {
        code: bestBy.code, index: bestBy.index, time: bestBy.bestLap,
        colour: bestBy.colour, lap: Math.max(1, bestBy.lapsDone),
      };
    }
    return this;
  }

  /** Put race control into a state that flatters the shot being taken. */
  _poseForCapture(shot) {
    this.paused = false;
    this.frontEnd?.hide?.();
    if (shot === 'grid') {
      // Five reds on the gantry: the moment every grid photograph is taken.
      this.phase = 'countdown';
      this.lights = 5;
      this.countdown = 1.2;
      this.banner = 'GRID';
      this.messages.length = 0;
      this.environment?.setStartLights?.(5);
      // The harness stages the grid by CAR INDEX, which is the entry list — so
      // the photograph came out with both cars of every team side by side in all
      // ten rows, the one thing a real grid never looks like. `gridOrder` is the
      // authority on who starts where, so put them where they qualified. This
      // runs from the capture watchdog, i.e. after the harness's own staging.
      this.gridOrder.forEach((carIndex, slot) => {
        const st = this.state[carIndex];
        st.grid = slot + 1;
        st.position = slot + 1;
        const box = this.circuit.gridSlot(slot);
        const car = this.cars[carIndex];
        car.vehicle.reset({ s: box.s, lateral: box.lateral, speed: 0 });
        st.lastS = box.s;
        st.lapsDone = 0;
        st.progress = box.s - this.circuit.length;
        if (this.field) { car.distance = 0; car.lastS = box.s; car.lap = 1; car.inPit = false; }
      });
      this._rank();
      this.field?.syncModels?.();
      return;
    }
    // Every other shot is a car at racing pace: green flag, mid-race.
    this.phase = this.sessionType === 'race' ? 'green' : 'running';
    this.flag = 'green';
    this.sectorFlags = ['green', 'green', 'green'];
    this.banner = null;
    // `banner` falls back to the newest race-control message, and the staging
    // messages ('FORMATION LAP', 'LIGHTS') are still in the feed — they would
    // caption a green-flag frame with the wrong thing.
    this.messages.length = 0;
    this.incidents.length = 0;
    // `this.time` is 0 on the frame a capture is armed, so `||` would leave the
    // race start at zero and every elapsed time with it.
    if (!(this.raceStart > 0)) this.raceStart = Math.max(1e-3, this.time);
    this.drsEnabled = true;
    this.environment?.setStartLights?.(0);
    for (const st of this.state) {
      st.pitState = null;
      st.pit = false;
      st.pitRequested = false;
      // Mid-race means the third lap or later: DRS is only armed from lap 3, and
      // the `hud` shot is specified as a run down a DRS straight.
      st.lapsDone = Math.max(st.lapsDone, 2);
      st.tyreFittedLap = st.lapsDone - 2;
    }
    // The tower is only ON SCREEN for the `hud` shot, and that is the one shot
    // whose staging has to survive being read as a timing screen. Every other
    // shot is composed around the car, so leave its framing alone.
    if (shot === 'hud') {
      this._respaceForCapture(shot);
      // Lap 3 is the lap DRS is enabled — a real race-control call, and what
      // fills the HUD's one contextual slot in the showcase frame.
      // No sub-line: 'ALL CARS' was filler, and the HUD's one contextual chip
      // reads better as a single call than as a call plus a padded qualifier.
      this._say('DRS ENABLED', '');
    }
    // The harness drops the field mid-circuit with no history: rebuild one.
    // Order matters — `seedReferenceTimes` seeds each driver's pace from where
    // they are on the road, so the monotonic distance has to be true first.
    this._rebaseline();
    // The harness drops the field on a straight, i.e. past the detection loop it
    // would have had to cross to get there — so re-run that decision rather than
    // leaving every car un-armed and the DRS panel dark.
    const zones = this.circuit.drsZones;
    for (const st of this.state) {
      st.drsArmed = -1;
      const z = zones.indexOf(this.circuit.drsZoneAt(this.cars[st.index].vehicle.trackS));
      if (z >= 0) this._armDRS(st, z);
    }
    this.seedReferenceTimes();
    this._rank();
  }

  /**
   * Spread the field the way lap 3 of a grand prix actually looks.
   *
   * The capture harness stages the whole field around the player at a fixed 19 m
   * — about 0.22 s — which produced a timing tower with all nineteen intervals
   * between +0.16 and +1.82: twenty cars nose to tail eight seconds apart in
   * total, which is impossible two laps after a standing start and is instantly
   * recognisable as generated. Nothing about the *timing* code was wrong; the
   * intervals were a truthful reading of a false grid.
   *
   * So respace by TIME, not metres: an interval ladder that grows from ~0.45 s
   * at the front to ~1.4 s at the back, plus a couple of 2-5 s breaks where the
   * field has split into groups, is inverted through the reference lap
   * (`_reference().cum` is time-to-any-point, so a gap in seconds becomes the
   * right number of metres in a corner and on a straight alike). The player is
   * never moved — the camera is already framed on them — and the road order the
   * harness chose is preserved, so the shot keeps its cars-ahead depth.
   *
   * Deterministic from the master seed. Capture staging only: in a live race the
   * spread is whatever the physics and the AI have produced.
   */
  _respaceForCapture(shot) {
    const ref = this._reference();
    const c = this.circuit;
    if (!ref || !this.field) return this;
    const L = c.length;
    const lapT = ref.lap;
    const cum = ref.cum;
    const step = c.step;

    /** Invert `timeAt`: which `s` is a car at, `tt` seconds into its lap? */
    const sAtTime = (tt) => {
      let t = tt % lapT;
      if (t < 0) t += lapT;
      let lo = 0, hi = cum.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] <= t) lo = mid; else hi = mid;
      }
      const span = cum[hi] - cum[lo];
      return c.wrapS((lo + (span > 1e-9 ? (t - cum[lo]) / span : 0)) * step);
    };

    // KEEP THE FIELD ON THE ROAD — the same rule the harness uses: offset toward
    // the centre wherever the racing line already runs near the edge.
    const lane = (at, side) => {
      const line = c.racingLineOffset(at);
      const room = Math.max(0, c.halfWidth - 1.5);
      const off = side * 1.7 * (Math.abs(line) > room * 0.55 ? -Math.sign(line) * side : 1);
      return clamp(line + off, -room, room);
    };
    const paceAt = (at) => (this.field.profile?.[c.sampleIndex(at)] ?? 60) * 0.97;

    const player = this.state[this.playerIndex];
    const pS = this.cars[this.playerIndex].vehicle.trackS;
    const relative = (st) => {
      let d = this.cars[st.index].vehicle.trackS - pS;
      if (d > L / 2) d -= L;
      if (d < -L / 2) d += L;
      return d;
    };
    const list = this.state.filter((st) => !st.out).sort((a, b) => relative(b) - relative(a));
    const pi = Math.max(0, list.indexOf(player));
    const n = Math.max(1, list.length - 1);

    const rng = makeRng(hashSeed(`spacing:${shot}:${list.length}`));
    const iv = [0];
    for (let i = 1; i < list.length; i++) {
      let g = 0.45 + 0.95 * (i / n) + (rng() - 0.5) * 0.34;
      if (rng() < 0.17) g += 2.0 + rng() * 2.8;     // the field breaks into groups
      iv.push(Math.max(0.30, g));
    }
    // The player is in a fight, because that is the only reason the camera is
    // there: the car ahead sits inside the 1 s DRS window (which is what makes
    // the player's own DRS pill legitimate) and the car behind is on the tail.
    if (pi > 0) iv[pi] = 0.42;
    if (pi + 1 < iv.length) iv[pi + 1] = 0.58;
    const cumGap = [0];
    for (let i = 1; i < list.length; i++) cumGap.push(cumGap[i - 1] + iv[i]);

    const tPlayer = ref.timeAt(pS);
    for (let i = 0; i < list.length; i++) {
      const st = list[i];
      if (st === player) continue;
      const tt = tPlayer + (cumGap[pi] - cumGap[i]);
      const at = sAtTime(tt);
      // A car whose lap time ran past the line is on the NEXT lap; one that ran
      // back past it is on the previous. `progress` is rebuilt from `lapsDone`
      // straight after this, so the running order only stays right if both agree.
      st.lapsDone = Math.max(0, (st.lapsDone ?? 2) + Math.floor(tt / lapT));
      const car = this.cars[st.index];
      car.vehicle.reset({ s: at, lateral: lane(at, i % 2 ? 1 : -1), speed: paceAt(at) });
      st.lastS = at;
      if (this.field) { car.lastS = at; car.lap = st.lapsDone + 1; car.inPit = false; }
    }
    this.field?.syncModels?.();
    return this;
  }

  /**
   * Re-derive the monotonic distance from where the cars actually are. Anything
   * that moves the field without driving it there — a capture restage, a resume,
   * a red-flag grid — has to call this or `progress` (and every gap built on it)
   * describes the old positions.
   */
  _rebaseline() {
    const L = this.circuit.length;
    for (const st of this.state) {
      const s = this.cars[st.index].vehicle.trackS;
      st.lastS = s;
      st.progress = st.lapsDone * L + s;
      st.trace.head = -1; st.trace.count = 0; st.trace.last = -1e9;
    }
    return this;
  }

  get capturing() { return !!(this.engine?.captureShot); }

  /** Skip straight to the grid (the player pressing through the formation). */
  skipFormation() {
    if (this.phase !== 'formation') return;
    this._formation.dist = this._formation.total;
  }

  // ── the kinematic driver ────────────────────────────────────────────────

  /**
   * Drive a car by pose along the circuit. Used wherever the tyre model cannot
   * help us: the formation lap, the pit lane, and cars parked in the garage.
   * Everything the renderer, HUD and audio read is kept consistent.
   */
  _kinematic(car, s, lateral, speed, dt, lift = 0) {
    const v = car.vehicle;
    const c = this.circuit;
    const sm = c.sampleAt(s);
    c.pointAt(s, lateral, 0, v.position);
    v.position.y += lift;
    v.yaw = Math.atan2(-sm.tangent.x, -sm.tangent.z);
    _q.setFromAxisAngle(_up, v.yaw);
    v.quaternion.copy(_q);
    // `speed`/`speedKph` are getters over (u, v) — drive the body velocity.
    v.u = speed;
    v.v = 0;
    v.yawRate = 0;
    v.trackS = s;
    v.trackLateral = lateral;
    const r = v.cfg.wheelRadius ?? 0.36;
    for (let i = 0; i < 4; i++) {
      v.wheelOmega[i] = speed / r;
      v.wheelSpin[i] = (v.wheelSpin[i] + (speed / r) * dt) % (Math.PI * 2);
      v.slipRatio[i] = 0;
      v.slipAngle[i] = 0;
    }
    v.controls.throttle = speed > 1 ? 0.22 : 0;
    v.controls.brake = 0;
    v.controls.steer = 0;
    v.rpm = clamp(3200 + speed * 120, 3000, v.cfg.redline ?? 12500);
    v.gear = speed < 6 ? 1 : speed < 20 ? 2 : 3;

    // Physics kept stepping underneath us on a surface it has no business on,
    // so the vertical state is nonsense. Settle it, or the car bounces on its
    // springs while it is sitting on the jacks.
    v.heave = 0; v.heaveVel = 0;
    v.pitchBody = 0; v.pitchVel = 0;
    v.rollBody = 0; v.rollVel = 0;
    v.pitch = 0; v.roll = 0;
    v.gLat = 0; v.gLong = 0;
    for (let i = 0; i < 4; i++) {
      v.wheelZ[i] = 0; v.wheelZVel[i] = 0; v.suspension[i] = 0; v.lockup[i] = 0;
    }
    v._updateTelemetry?.();
  }

  /**
   * Put a car in its garage and leave it there.
   *
   * NOTE: this must NOT set `car.inPit`. `OpponentField.update` treats that flag
   * as "a pit stop is in progress" and hands the car straight to `_stepPit`,
   * which dereferences `ai._pit` — an object only the field itself creates. Race
   * control setting the flag on its own crashed the whole sim on the first
   * qualifying segment that eliminated anybody. Parked cars are held by
   * `_updateParked` instead, which is race control's own documented mechanism.
   */
  _parkInGarage(car, st) {
    const c = this.circuit;
    st.parkS = c.wrapS(-150 + Math.floor(st.index / 2) * 15);
    st.parkLat = -(c.halfWidth + 10.5);
    st.out = true;
    this._kinematic(car, st.parkS, st.parkLat, 0, 1 / 60);
  }

  /**
   * Hold every parked car still. The field steps its AI and physics for eliminated
   * and retired cars regardless, so without this they simply drive out of the
   * garage again on the next frame. Race control runs after `field.update()`, so
   * re-posing here is the last word.
   */
  _updateParked(dt) {
    for (const st of this.state) {
      if (!st.out && !st.retired) continue;
      if (st.parkS == null) continue;
      const car = this.cars[st.index];
      if (car.inPit) continue;                 // a real pit stop owns the car
      this._kinematic(car, st.parkS, st.parkLat ?? 0, 0, dt);
      if (car.ai) { car.ai.launched = false; car.ai.launchTimer = 0; }
    }
  }

  // ── main update ─────────────────────────────────────────────────────────

  update(dt) {
    if (!this._bound) this._bindEngine();
    if (this.paused) return;

    const t0 = this.time;
    this.time += dt;
    this.sessionTime += dt;

    // A capture owns the field: observe and report, never steer.
    if (this.capturing) {
      if (this._lastShot !== this.engine.captureShot) {
        this._lastShot = this.engine.captureShot;
        this._poseForCapture(this.engine.captureShot);
      }
      for (let i = 0; i < this.cars.length; i++) this._updateCar(this.cars[i], this.state[i], t0, dt);
      this._updateStrategy(dt);
      this._rank();
      this._updateDRS();
      return;
    }

    switch (this.phase) {
      case 'formation': this._updateFormation(dt); break;
      case 'grid':
        this._gridTimer -= dt;
        this.banner = 'GRID';
        for (const c of this.cars) if (c.ai) { c.ai.launched = false; c.ai.launchTimer = 0; }
        if (this._gridTimer <= 0) this._armLights();
        break;
      case 'countdown': this._updateLights(dt); break;
      case 'red': this._updateRedFlag(dt); break;
      default: break;
    }

    // Timing runs in every phase so out-laps and formation laps are tracked.
    for (let i = 0; i < this.cars.length; i++) {
      this._updateCar(this.cars[i], this.state[i], t0, dt);
    }

    this._updateStrategy(dt);
    this._updatePits(dt);
    this._updateParked(dt);
    this._updateSafetyCar(dt);
    this._rank();
    this._updateFlags(dt);
    this._updateDRS();
    this._updateSessionClock(dt);
    this._updateMarshals();
    this._pruneMessages(dt);
    this.frontEnd?.onSessionUpdate();
  }

  // ── per-car timing ──────────────────────────────────────────────────────

  _updateCar(car, st, t0, dt) {
    const v = car.vehicle;
    const c = this.circuit;
    const L = c.length;
    const s = v.trackS;

    const ds = wrapDelta(st.lastS, s, L);
    const prevS = st.lastS;
    st.lastS = s;
    // A teleport (a capture restaging the field, a red-flag restage) must not
    // fake a lap — and must not corrupt `progress` either. `wrapDelta` caps the
    // step at half a lap, so integrating it would leave the monotonic distance
    // permanently wrong; rebuild it from laps completed instead and throw away
    // the history, which no longer describes anything the car actually did.
    const teleport = Math.abs(ds) > TELEPORT_M;
    if (teleport) {
      st.progress = st.lapsDone * L + s;
      st.trace.head = -1; st.trace.count = 0; st.trace.last = -1e9;
    } else {
      st.progress += ds;
    }
    this._pushTrace(st);

    // Nothing to time for a parked or retired car.
    if (st.out || st.retired) return;

    if (!teleport && ds > 0) {
      // ── timing lines, crossed with sub-frame interpolation ───────────────
      for (let k = 0; k < 3; k++) {
        const p = this._timingPoints[k];
        const d = forwardDelta(prevS, p, L);
        if (d < ds) {
          const tCross = t0 + dt * (d / ds);
          this._onTimingLine(car, st, k, tCross);
        }
      }
      // ── DRS detection loops ───────────────────────────────────────────────
      // Being within a second HERE is what grants the flap for the zone that
      // follows. Measuring it continuously once the car is already on the
      // straight — which is what this used to do — grants DRS to everyone in a
      // train and takes it away again the instant the driver closes up, which is
      // both wrong and the reason every car in the field lit up its DRS pill.
      const zones = this.circuit.drsZones;
      for (let z = 0; z < zones.length; z++) {
        if (forwardDelta(prevS, zones[z].detectS, L) < ds) this._armDRS(st, z);
      }
    }

    st.tyreAge = st.timingArmed ? st.lapsDone - (st.tyreFittedLap ?? 0) : 0;
    st.lap = clamp(st.lapsDone + 1, 1, Math.max(1, this.totalLaps));
    this._trackLimits(car, st, dt);
  }

  /**
   * Crossing timing point `k` (0 = start/finish). This is the only place lap
   * and sector times are minted, and it is exact to the interpolated instant.
   */
  _onTimingLine(car, st, k, tCross) {
    const prevSector = (k + 2) % 3;

    // Close out the sector we just left.
    if (st.timingArmed && st.sectorStart > 0) {
      const t = tCross - st.sectorStart;
      if (t > 3 && t < 400) {
        st.currentSectors[prevSector] = t;
        this._gradeSector(st, prevSector, t);
      }
    }
    st.sectorStart = tCross;
    st.sector = k;

    if (k !== 0) return;

    // ── the lap ────────────────────────────────────────────────────────────
    if (!st.timingArmed) {
      // First crossing of the session: the clock starts here. In a race the
      // lap is already running (F1 times lap 1 from lights out).
      st.timingArmed = true;
      st.lapStart = this.sessionType === 'race' && this.raceStart > 0 ? this.raceStart : tCross;
      // A LAP IS A LAP'S WORTH OF ROAD, not just a crossing.
      //
      // F1 does time lap 1 from lights out, and on a real circuit that works
      // because the grid sits ON the timing line. `_stageGrid` puts the field a
      // few tens of metres BEHIND it, so the first crossing happened about a
      // second after the lights went out and was banked as a complete lap: a
      // 13-second "fastest lap of the race" that then poisoned every delta, every
      // gap and the purple/green grading on the tower for the rest of the session.
      // `startProgress` is already the monotonic distance at the start, so ask it.
      const covered = st.progress - (st.startProgress ?? st.progress);
      if (this.sessionType === 'race' && covered > this.circuit.length * 0.5) {
        st.lapsDone += 1;
        this._recordLap(st, tCross - st.lapStart, tCross);
      }
      st.lapStart = tCross;
      st.lapValid = true;
      st.currentSectors = [0, 0, 0];
      return;
    }

    st.lapsDone += 1;
    this._recordLap(st, tCross - st.lapStart, tCross);
    st.lapStart = tCross;
    st.lastSectors = [...st.currentSectors];
    st.lastSectorStatus = [...st.sectorStatus];
    st.currentSectors = [0, 0, 0];
    st.sectorStatus = ['', '', ''];
    st.lapValid = true;

    if (this.sessionType === 'race') this._checkRaceFinish(car, st, tCross);
  }

  _recordLap(st, lapTime, tCross) {
    if (!(lapTime > 12 && lapTime < 500)) return;
    st.lastLapRaw = lapTime;
    if (!st.lapValid) {
      st.deletedLaps++;
      st.lastLap = lapTime;
      st.lastLapDeleted = true;
      this._say('LAP DELETED', `${st.code} — lap deleted, track limits`, 'warn');
      return;
    }
    st.lastLapDeleted = false;
    st.lastLap = lapTime;
    if (lapTime < st.bestLap) st.bestLap = lapTime;
    if (lapTime < this.bestLapOverall) {
      this.bestLapOverall = lapTime;
      this.fastestLap = { code: st.code, index: st.index, time: lapTime, colour: st.colour, lap: st.lapsDone };
      this._say('FASTEST LAP', `${st.code}  ${formatLapTime(lapTime)}`, 'purple');
    }
    st.lineTime = tCross;
  }

  _gradeSector(st, i, t) {
    if (t < st.bestSectorTimes[i]) st.bestSectorTimes[i] = t;
    if (t < this.bestSectors[i] && st.lapValid) {
      this.bestSectors[i] = t;
      st.sectorStatus[i] = 'purple';
    } else if (t <= st.bestSectorTimes[i] + 1e-9) {
      st.sectorStatus[i] = 'green';
    } else {
      st.sectorStatus[i] = 'yellow';
    }
  }

  // ── track limits ────────────────────────────────────────────────────────

  /**
   * All four wheels beyond the white line for more than `TRACK_LIMIT_HOLD`
   * seconds is a violation. Practice and qualifying delete the lap; the race
   * gives three warnings and then a five-second penalty per further offence.
   */
  _trackLimits(car, st, dt) {
    if (st.pit || st.out || st.retired || this.phase === 'formation' || this.capturing) { st.offTrackTimer = 0; return; }
    const v = car.vehicle;
    const beyond = Math.abs(v.trackLateral) - (this.circuit.halfWidth + TRACK_LIMIT_MARGIN);
    if (beyond > 0 && v.speed > 12) {
      st.offTrackTimer += dt;
      if (st.offTrackTimer > TRACK_LIMIT_HOLD && !st.offFlagged) {
        st.offFlagged = true;
        st.lapValid = false;
        st.warnings++;
        st.offSide = Math.sign(v.trackLateral);
        if (this.sessionType === 'race') {
          if (st.warnings > 3) this.addPenalty(st.index, 5, 'TRACK LIMITS');
          else if (st.index === this.playerIndex) {
            this._say('TRACK LIMITS', `Warning ${st.warnings} of 3 — track limits`, 'warn');
          }
        } else if (st.index === this.playerIndex) {
          this._say('LAP INVALIDATED', 'Track limits — lap deleted', 'warn');
        }
      }
      // A long excursion is an incident: local yellows.
      if (st.offTrackTimer > 2.5) this._raiseIncident(st, v.speed < 6 ? 'double' : 'yellow');
    } else {
      st.offTrackTimer = 0;
      st.offFlagged = false;
    }
  }

  // ── flags ───────────────────────────────────────────────────────────────

  setFlag(f) {
    this.flag = f;
    if (f === 'green') this.sectorFlags = ['green', 'green', 'green'];
    return this;
  }

  /** Raise a local flag in one sector for a few seconds. */
  localFlag(sector, kind = 'yellow', seconds = 6) {
    this.incidents.push({ sector, kind, ttl: seconds });
    return this;
  }

  _raiseIncident(st, kind) {
    const sector = this.circuit.sectorOf(this.cars[st.index].vehicle.trackS);
    const live = this.incidents.find((i) => i.sector === sector && i.by === st.index);
    if (live) { live.ttl = Math.max(live.ttl, 4); live.kind = kind; return; }
    this.incidents.push({ sector, kind, ttl: 6, by: st.index });
    this._say(kind === 'double' ? 'DOUBLE YELLOW' : 'YELLOW FLAG', `Incident sector ${sector + 1}`, 'warn');
  }

  _updateFlags(dt) {
    // Expire local incidents.
    for (let i = this.incidents.length - 1; i >= 0; i--) {
      this.incidents[i].ttl -= dt;
      if (this.incidents[i].ttl <= 0) this.incidents.splice(i, 1);
    }
    const next = ['green', 'green', 'green'];
    for (const inc of this.incidents) {
      const cur = next[inc.sector];
      if (inc.kind === 'double' || cur === 'double') next[inc.sector] = 'double';
      else next[inc.sector] = 'yellow';
    }
    // A stopped car anywhere on the racing surface is a double yellow.
    for (const st of this.state) {
      if (st.retired && !st.out) {
        const sec = this.circuit.sectorOf(this.cars[st.index].vehicle.trackS);
        next[sec] = 'double';
      }
    }
    this.sectorFlags = next;

    // Blue flags: a car about to be lapped, within two seconds of the leader
    // of the class ahead of it on the road.
    if (this.sessionType === 'race' && this.phase === 'green') {
      this._updateBlueFlags();
    } else if (this.sessionType !== 'race') {
      // In practice / qualifying a car on a flying lap gets blue-flagged past.
      this._updateBlueFlags(true);
    }

    // The session-wide flag.
    if (this.phase === 'red') this.flag = 'red';
    else if (this.phase === 'finished' || this.phase === 'classified') this.flag = 'chequered';
    else if (this.safetyCar.active) this.flag = 'sc';
    else if (this.vsc.active) this.flag = 'vsc';
    else if (next.includes('double')) this.flag = 'double';
    else if (next.includes('yellow')) this.flag = 'yellow';
    else this.flag = 'green';
  }

  /**
   * Blue flags. In the race a car is shown blue when a car at least one lap up
   * is closing on it and within ~1.5 s. In practice and qualifying it is shown
   * to whoever is NOT on a hot lap when someone who is arrives behind them.
   */
  _updateBlueFlags(quali = false) {
    const L = this.circuit.length;
    const list = this.standings;
    for (const st of list) st.blue = false;

    const live = list.filter((s) => !s.out && !s.retired && !s.pit);
    const hot = (s) => this.cars[s.index].vehicle.speed > 42 && s.lapValid && s.timingArmed;

    for (const slow of live) {
      const vSlow = this.cars[slow.index].vehicle;
      for (const fast of live) {
        if (fast === slow) continue;
        // Distance from the car being lapped forward to the car catching it
        // is meaningless; we want how far BEHIND `slow` the faster car is.
        const behind = forwardDelta(this.cars[fast.index].vehicle.trackS, vSlow.trackS, L);
        if (behind > 110 || behind < 0.5) continue;
        const closingTime = behind / Math.max(22, vSlow.speed);
        if (closingTime > 1.6) continue;
        if (quali) {
          if (hot(fast) && !hot(slow)) { slow.blue = true; break; }
        } else if (fast.progress - slow.progress >= L * 0.98) {
          slow.blue = true;
          break;
        }
      }
    }
    for (const st of this.state) {
      const ai = this.cars[st.index].ai;
      if (ai) ai.blueFlag = st.blue;
    }
  }

  /** Red flag: stop the session, freeze the field, wait for the restart. */
  throwRedFlag(reason = 'INCIDENT') {
    if (this.phase === 'red') return this;
    this._prePhase = this.phase;
    this.phase = 'red';
    this.flag = 'red';
    this._redTimer = 8;
    this.banner = 'RED FLAG';
    this._say('RED FLAG', `Session stopped — ${reason}`, 'danger');
    return this;
  }

  _updateRedFlag(dt) {
    this._redTimer -= dt;
    // Everyone crawls back to the pit lane entry.
    for (const c of this.cars) {
      const st = this.state[c.index];
      if (st.out || st.retired) continue;
      const v = c.vehicle;
      const cap = 18;
      if (v.speed > cap) this._capSpeed(v, cap);
      if (c.ai) c.ai.blueFlag = true;
    }
    if (this._redTimer <= 0) this.resumeFromRed();
  }

  resumeFromRed() {
    if (this.phase !== 'red') return this;
    for (const c of this.cars) if (c.ai) c.ai.blueFlag = false;
    if (this.sessionType === 'race') {
      // Restart from a standing grid in current order.
      this.gridOrder = this.standings.filter((s) => !s.retired && !s.out).map((s) => s.index);
      // The restart order is the order they were running in — never re-seeded.
      this._stageGrid({ formation: false, seedGrid: false });
    } else {
      this.phase = 'running';
      this.flag = 'green';
    }
    this._say('GREEN', 'Session resumed', 'ok');
    return this;
  }

  // ── safety car and VSC ──────────────────────────────────────────────────

  deployVSC(seconds = 25) {
    if (this.safetyCar.active) return this;
    this.vsc = { active: true, timer: seconds, ending: 0 };
    this._say('VIRTUAL SAFETY CAR', 'VSC deployed — delta positive', 'warn');
    return this;
  }

  endVSC() {
    if (!this.vsc.active) return this;
    this.vsc.ending = 3;
    return this;
  }

  deploySafetyCar(laps = 2) {
    if (this.sessionType !== 'race') return this;
    this.vsc.active = false;
    this.safetyCar = { active: true, phase: 'bunching', timer: 0, lapsLeft: laps };
    this._say('SAFETY CAR', 'Safety car deployed', 'warn');
    return this;
  }

  endSafetyCar() {
    if (!this.safetyCar.active) return this;
    this.safetyCar.phase = 'in';
    this.safetyCar.timer = 0;
    this._say('SAFETY CAR IN', 'Safety car in this lap', 'ok');
    return this;
  }

  /**
   * Bunching is a closing-rate controller, not a teleport: the leader is held
   * at the safety-car delta and everyone behind targets a fixed gap to the car
   * in front, so the queue forms up over ten or fifteen seconds exactly as it
   * does on television.
   */
  _updateSafetyCar(dt) {
    const sc = this.safetyCar;
    const vsc = this.vsc;

    if (vsc.active) {
      vsc.timer -= dt;
      if (vsc.ending > 0) {
        vsc.ending -= dt;
        if (vsc.ending <= 0) {
          vsc.active = false;
          this._restorePace();
          this._say('GREEN FLAG', 'VSC ending — green flag', 'ok');
          // MUST return. Falling through to the capping loop below re-applied
          // `_scalePace(VSC_PACE)` on this very frame, which re-captured the
          // already-restored pace as the new baseline — so a single VSC left the
          // entire field permanently pegged at 62% of racing pace for the rest of
          // the grand prix, and nothing ever restored it because `vsc.active` was
          // now false. The safety-car branch below is already ordered correctly.
          return;
        }
      } else if (vsc.timer <= 0) this.endVSC();
      const cap = SC_SPEED * 1.35;
      for (const c of this.cars) {
        const st = this.state[c.index];
        if (st.out || st.retired || st.pit) continue;
        if (c.ai) this._scalePace(c.ai, VSC_PACE);
        this._capSpeed(c.vehicle, cap);
      }
      return;
    }

    if (!sc.active) return;
    sc.timer += dt;

    const order = this.standings.filter((s) => !s.out && !s.retired && !s.pit);
    let aheadProgress = null;
    for (let i = 0; i < order.length; i++) {
      const st = order[i];
      const car = this.cars[st.index];
      const v = car.vehicle;
      let cap;
      if (i === 0) {
        cap = SC_SPEED;
      } else {
        const gap = aheadProgress - st.progress;                 // metres
        const err = gap - SC_GAP;
        cap = clamp(SC_SPEED + err * 0.55, 8, SC_SPEED * 1.9);
      }
      if (sc.phase === 'in' && i === 0) cap = SC_SPEED * 1.15;
      if (car.ai) this._scalePace(car.ai, clamp(cap / 62, 0.18, 0.95));
      this._capSpeed(v, cap);
      aheadProgress = st.progress;
    }

    if (sc.phase === 'bunching') {
      const spread = order.length > 1 ? order[0].progress - order[order.length - 1].progress : 0;
      if (sc.timer > 8 && spread < SC_GAP * order.length * 1.35) {
        sc.phase = 'queued';
        sc.timer = 0;
        this._say('SAFETY CAR', 'Field bunched up behind the safety car');
      }
    } else if (sc.phase === 'queued') {
      if (sc.timer > 14) this.endSafetyCar();
    } else if (sc.phase === 'in') {
      if (sc.timer > 6) {
        sc.active = false;
        this._restorePace();
        this.flag = 'green';
        this._say('GREEN FLAG', 'Safety car in — racing resumes', 'ok');
      }
    }
  }

  _scalePace(ai, factor) {
    if (!ai.persona) return;
    ai.persona._racePace = ai.persona._racePace ?? ai.persona.paceScale;
    ai.persona.paceScale = ai.persona._racePace * factor;
  }

  _restorePace() {
    for (const c of this.cars) {
      const p = c.ai?.persona;
      if (p && p._racePace != null) { p.paceScale = p._racePace; p._racePace = null; }
    }
  }

  /**
   * Scale the body velocity down to `cap` without upsetting the attitude.
   * `Vehicle.speed` is a getter over (u, v), so scaling those is the only way
   * to slow a car down from outside the tyre model.
   */
  _capSpeed(v, cap) {
    const sp = Math.hypot(v.u, v.v);
    if (sp <= cap || sp < 1e-3) return;
    const k = cap / sp;
    v.u *= k;
    v.v *= k;
  }

  // ── DRS ─────────────────────────────────────────────────────────────────

  /**
   * The car immediately in front on the road — which is what a DRS detection
   * loop measures against, so it counts lapped traffic and cars out of sequence,
   * not just the next name up the timing screen.
   */
  _carAheadOnRoad(st) {
    const L = this.circuit.length;
    const s = this.cars[st.index].vehicle.trackS;
    let best = null, bestD = Infinity;
    for (const other of this.state) {
      if (other === st || other.out || other.retired || other.pit) continue;
      const d = forwardDelta(s, this.cars[other.index].vehicle.trackS, L);
      if (d > 0.5 && d < bestD) { bestD = d; best = other; }
    }
    return best ? { st: best, distance: bestD } : null;
  }

  /**
   * A car has just crossed the detection loop for zone `z`. Latch the
   * entitlement — it holds for that zone and nothing else, and is re-decided at
   * every detection point, exactly as the rule works.
   */
  _armDRS(st, z) {
    if (this.sessionType !== 'race') { st.drsArmed = z; return; }
    const ahead = this._carAheadOnRoad(st);
    if (!ahead) { st.drsArmed = -1; return; }
    const va = this.cars[st.index].vehicle.speed;
    const vb = this.cars[ahead.st.index].vehicle.speed;
    const gap = ahead.distance / Math.max(30, (va + vb) * 0.5);
    st.drsArmed = gap < DRS_WINDOW ? z : -1;
    st.drsDetectGap = gap;
  }

  /**
   * DRS is enabled from lap 3, disabled under yellow/SC/VSC, and usable only in
   * the zone the car was granted at the preceding detection point.
   */
  _updateDRS() {
    const leader = this.standings[0];
    const raceLap = leader?.lapsDone ?? 0;
    const armed = this.sessionType === 'race'
      ? this.phase === 'green' && raceLap >= 2
      : this.phase === 'running';
    const blocked = this.safetyCar.active || this.vsc.active
      || this.flag === 'yellow' || this.flag === 'double' || this.flag === 'red';
    this.drsEnabled = armed && !blocked;
    if (this.field) this.field.drsEnabled = this.drsEnabled;

    const zones = this.circuit.drsZones;
    for (const st of this.state) {
      const v = this.cars[st.index].vehicle;
      const zone = this.circuit.drsZoneAt(v.trackS);
      const z = zone ? zones.indexOf(zone) : -1;
      st.drs = this.drsEnabled && z >= 0 && st.drsArmed === z
        && !st.pit && !st.out && !st.retired;
      v.drsAvailable = st.drs;
      // A timing tower's DRS pill means the flap is OPEN, not that the driver is
      // entitled to open it — so it reads off what the car is actually doing.
      st.drsOpen = st.drs && (v.telemetry?.drs ?? v.controls?.drs ?? 0) > 0.5;
    }
  }

  // ── fuel, tyres and strategy ────────────────────────────────────────────

  _syncStrategy() {
    const laps = Math.max(1, this.totalLaps);
    const d = DIFFICULTIES[this.difficulty] ?? DIFFICULTIES.pro;
    // Fuel is carried as a *load*, 0–103 units, the way a pit wall and the HUD
    // both talk about it: a full tank is exactly enough for the race distance
    // plus a small reserve, whatever the distance is. `_fuelKgPerUnit` converts
    // that back to real kilograms for the mass model.
    const ref = this._reference();
    this._fuelPerLap = 103 / (laps + 0.8);
    this._fuelBurnRate = this._fuelPerLap / Math.max(45, (ref?.lap ?? 90));
    this._fuelKgPerUnit = (laps * 1.85) / 103;

    const startRng = makeRng(hashSeed(`start:${this.sessionType}:${laps}`));
    for (const st of this.state) {
      const car = this.cars[st.index];
      const isRace = this.sessionType === 'race';
      st.fuelStart = isRace ? 103 : 62;
      st.fuel = st.fuelStart;
      st.compound = isRace
        ? this._startingCompound(st, laps, startRng)
        : (car.compound ?? car.ai?.compound ?? 'soft');
      st.tyreFittedLap = 0;
      st.tyreLife = 1;
      st.pitStops = 0;
      st.plan = this._buildStrategy(st, laps);
      this._applyCompound(st, st.compound, false);
      car.vehicle.tyreWear = [0, 0, 0, 0];
      car.vehicle.cfg.tyreWearRate = (car.vehicle.cfg._baseWear ?? car.vehicle.cfg.tyreWearRate)
        * TYRES[st.compound].wear * (st.index === this.playerIndex ? d.wear : 1);
    }
  }

  /**
   * What a driver starts the race on.
   *
   * Taking whatever compound the entry list happened to carry gave a grid
   * stratified in blocks — the first eight cars on softs, the next eight on
   * mediums, the last four on hards — which is the tell that nobody chose
   * anything. A real grid correlates with qualifying without being sorted by it:
   * the front runners take the medium for a long first stint and the flexibility
   * of a soft finish, a handful of cars gamble on a soft start to attack into
   * the first stops, and the cars with nothing to lose at the back go long on
   * the hard. Weather overrides everything.
   */
  _startingCompound(st, laps, rng) {
    const wet = this.weather?.wetness ?? 0;
    if (wet > 0.55) return 'wet';
    if (wet > 0.22) return 'inter';
    const slot = Math.max(0, this.gridOrder.indexOf(st.index));
    const front = slot / Math.max(1, this.gridOrder.length - 1);   // 0 = pole
    const r = rng();
    // A short race is a sprint: almost everyone starts on the softest thing
    // that will last, and the strategy spread collapses.
    if (laps <= 8) return r < 0.72 ? 'soft' : 'medium';
    // Chance of the aggressive option falls, and of the long option rises, as
    // you go down the grid — but neither ever reaches zero, so no contiguous
    // block of one compound can form.
    const pSoft = lerp(0.34, 0.14, front);
    const pHard = lerp(0.08, 0.42, front);
    if (r < pSoft) return 'soft';
    if (r > 1 - pHard) return 'hard';
    return 'medium';
  }

  /** A believable one- or two-stop plan for a driver. */
  _buildStrategy(st, laps) {
    const start = st.compound;
    const wet = (this.weather?.wetness ?? 0) > 0.35;
    if (wet) return { stops: [{ lap: Math.round(laps * 0.5), compound: 'inter' }] };
    const stops = laps > 26 ? 2 : 1;
    // Two-stoppers go softer as the fuel comes off; a one-stopper takes the
    // compound that will see the flag. Nobody starts and finishes on the same.
    const ladder = start === 'soft' ? ['medium', 'hard'] : start === 'hard' ? ['medium', 'soft'] : ['hard', 'soft'];
    const plan = [];
    for (let i = 1; i <= stops; i++) {
      const lap = Math.round((laps * i) / (stops + 1) + (this.rng() - 0.5) * 3);
      const compound = stops === 1 ? (laps - lap < 16 ? 'soft' : ladder[0]) : ladder[i - 1];
      plan.push({ lap: clamp(lap, 4, laps - 2), compound });
    }
    return { stops: plan };
  }

  _applyCompound(st, compound, refit = true) {
    const car = this.cars[st.index];
    st.compound = compound;
    car.compound = compound;
    car.model?.wheels?.setCompound?.(compound);
    const d = DIFFICULTIES[this.difficulty] ?? DIFFICULTIES.pro;
    const cfg = car.vehicle.cfg;
    cfg.tyreWearRate = (cfg._baseWear ?? cfg.tyreWearRate) * TYRES[compound].wear
      * (st.index === this.playerIndex ? d.wear : 1);
    if (refit) {
      car.vehicle.tyreWear = [0, 0, 0, 0];
      st.tyreFittedLap = st.lapsDone;
      st.tyreLife = 1;
      car.ai?.fitTyres?.(DRY_COMPOUNDS.includes(compound) ? compound : 'medium');
    }
  }

  _updateStrategy(dt) {
    const d = DIFFICULTIES[this.difficulty] ?? DIFFICULTIES.pro;
    const racing = this.phase === 'green' || this.phase === 'running';
    for (const st of this.state) {
      const car = this.cars[st.index];
      const v = car.vehicle;
      if (st.out || st.retired) continue;

      // Tyre life from the physics' own wear, scaled by what the compound can take.
      const w = v.tyreWear;
      const mean = (w[0] + w[1] + w[2] + w[3]) * 0.25;
      st.tyreLife = clamp(1 - mean / TYRES[st.compound].life, 0.05, 1);
      if (car.ai) car.ai.tyreLife = clamp(Math.min(car.ai.tyreLife, st.tyreLife + 0.06), 0.12, 1);

      // Fuel: the burn is dominated by throttle, normalised so an average lap
      // costs exactly one lap's worth of the load.
      if (racing && !st.pit && this._fuelBurnRate) {
        const throttle = v.controls.throttle ?? 0;
        const mix = (0.34 + 0.82 * throttle) / 1.0;
        const lean = st.index === this.playerIndex ? d.fuel : 1;
        st.fuel = Math.max(0, st.fuel - this._fuelBurnRate * mix * lean * dt);
      }
      // ...and the car gets lighter for it. `cfg.mass` is authored as the
      // mid-stint mass, so we centre the correction on half a tank and re-derive
      // the static corner loads rather than leaving them stale.
      st._massTimer = (st._massTimer ?? 0) + dt;
      if (st._massTimer > 1.0) {
        st._massTimer = 0;
        const cfg = v.cfg;
        const kg = (st.fuel - st.fuelStart * 0.5) * (this._fuelKgPerUnit ?? 0.45);
        const want = cfg._baseMass + clamp(kg, -60, 60);
        if (Math.abs(want - cfg.mass) > 0.8) { cfg.mass = want; v._deriveGeometry?.(); }
      }
      // Keep the compound in step with the field's own pit stops.
      if (car.ai && car.compound && car.compound !== st.compound) {
        st.compound = car.compound;
        st.tyreFittedLap = st.lapsDone;
        st.pitStops++;
      }

      // Publish to the HUD.
      const tel = v.telemetry;
      if (tel) {
        // `st.fuel` is a 0–103 LOAD, not a mass — publishing it straight as
        // `fuelKg` put "103.0 KG" on a dashboard whose tank the mass model
        // itself values at ~44 kg. Both numbers are now published under names
        // that mean what they say, plus the only fuel figure a pit wall
        // actually says out loud: laps in hand.
        tel.fuelLoad = st.fuel;
        tel.fuelKg = st.fuel * (this._fuelKgPerUnit ?? 0.45);
        tel.fuelLaps = this._fuelPerLap > 0 ? st.fuel / this._fuelPerLap : NaN;
        tel.fuelLapsMargin = this._fuelPerLap > 0
          ? st.fuel / this._fuelPerLap - Math.max(0, this.totalLaps - st.lapsDone)
          : NaN;
        tel.compound = st.compound;
        tel.tyreAge = st.tyreAge;
        tel.tyreLife = st.tyreLife;
      }

      // AI pit calls.
      if (car.ai && this.sessionType === 'race' && racing && !st.pit && !this.capturing) {
        const next = st.plan?.stops?.[st.pitStops];
        const worn = st.tyreLife < 0.30;
        if (next && (st.lapsDone >= next.lap || worn) && st.lapsDone < this.totalLaps - 1) {
          car.ai.pitRequested = true;
        }
      }
    }
  }

  // ── pit stops ───────────────────────────────────────────────────────────

  /** Ask for a stop next time round. `index` defaults to the player. */
  requestPit(index = this.playerIndex, opts = {}) {
    const st = this.state[index];
    if (!st || st.pit || st.retired) return this;
    st.pitRequested = true;
    st.pitCompound = opts.compound ?? this._pickCompound(st);
    const car = this.cars[index];
    if (car.ai) car.ai.pitRequested = true;
    if (index === this.playerIndex) this._say('BOX BOX', `Box this lap — ${TYRES[st.pitCompound].label}`, 'ok');
    return this;
  }

  cancelPit(index = this.playerIndex) {
    const st = this.state[index];
    if (st) { st.pitRequested = false; const c = this.cars[index]; if (c.ai) c.ai.pitRequested = false; }
    return this;
  }

  _pickCompound(st) {
    const wet = (this.weather?.wetness ?? 0);
    if (wet > 0.6) return 'wet';
    if (wet > 0.25) return 'inter';
    const next = st.plan?.stops?.[st.pitStops];
    if (next) return next.compound;
    const left = this.totalLaps - st.lapsDone;
    return left < 14 ? 'soft' : left < 30 ? 'medium' : 'hard';
  }

  /**
   * The player's stop. Opponents use `OpponentField._stepPit`; the player gets a
   * richer version with a real pit box, the limiter, a jacked-up stop and the
   * wheels actually coming off the car.
   */
  _updatePits(dt) {
    const c = this.circuit;
    const L = c.length;
    const hw = c.halfWidth;
    const entryS = c.wrapS(-330);
    const exitS = c.wrapS(210);

    for (const st of this.state) {
      const car = this.cars[st.index];
      if (car.ai) { st.pit = !!car.inPit; continue; }   // the field owns AI stops
      const v = car.vehicle;

      // Manual pit-lane speeding, when the player drives the lane themselves.
      if (!st.pitState && v.trackLateral < -(hw + 3) && this._inPitWindow(v.trackS)) {
        if (v.speed > PIT_SPEED_LIMIT + 1.2 && !st.speedFlag) {
          st.speedFlag = true;
          this.addPenalty(st.index, 5, 'PIT LANE SPEEDING');
        }
      } else if (v.trackLateral > -(hw + 2)) st.speedFlag = false;

      // Arm the stop when we reach the entry.
      if (st.pitRequested && !st.pitState && !st.retired) {
        const d = forwardDelta(v.trackS, entryS, L);
        if (d < Math.max(20, v.speed * 0.9)) {
          st.pitState = {
            phase: 'in', s: v.trackS, lat: v.trackLateral,
            laneLat: -(hw + 8.5),
            boxS: c.wrapS(-150 + Math.floor(st.index / 2) * 15),
            exitS, speed: v.speed,
            hold: 2.35 + this.rng() * 0.5,
            work: 0, lift: 0, wheelOff: 0,
            compound: st.pitCompound ?? this._pickCompound(st),
            penaltyHold: Math.max(0, st.penalty - st.penaltyServed),
            t: 0,
          };
          st.pit = true;
          st.pitRequested = false;
          this._say('PIT ENTRY', 'In the pit lane — limiter on');
        }
      }

      if (st.pitState) this._stepPlayerPit(car, st, dt);
    }
  }

  _inPitWindow(s) {
    const c = this.circuit;
    const from = c.wrapS(-430), to = c.wrapS(250);
    return from < to ? (s >= from && s <= to) : (s >= from || s <= to);
  }

  _stepPlayerPit(car, st, dt) {
    const c = this.circuit;
    const L = c.length;
    const p = st.pitState;
    const v = car.vehicle;
    p.t += dt;
    const distTo = (target) => wrapDelta(p.s, target, L);

    if (p.phase === 'in') {
      const d = distTo(p.boxS);
      const brakeZone = d < 55;
      p.speed = lerp(p.speed, brakeZone ? PIT_SPEED_LIMIT : Math.max(PIT_SPEED_LIMIT, 40), 1 - Math.exp(-dt * 2.0));
      p.lat = lerp(p.lat, p.laneLat, 1 - Math.exp(-dt * (d > 60 ? 0.7 : 2.2)));
      if (d < 9) p.phase = 'brake';
    } else if (p.phase === 'brake') {
      p.speed = Math.max(0, p.speed - 13 * dt);
      p.lat = lerp(p.lat, p.laneLat + 1.7, 1 - Math.exp(-dt * 3.5));
      if (p.speed <= 0.06 || distTo(p.boxS) < 0.4) { p.speed = 0; p.phase = 'stop'; p.work = 0; }
    } else if (p.phase === 'stop') {
      p.speed = 0;
      p.work += dt;
      const total = p.hold + p.penaltyHold;
      // Jack up (0.15–0.5 s), wheels off (0.5–1.4 s), wheels on, drop.
      const w = p.work;
      p.lift = clamp((w - 0.12) / 0.30, 0, 1) * clamp((total - 0.45 - w) / 0.30, 0, 1) * 0.075;
      p.wheelOff = clamp((w - 0.32) / 0.22, 0, 1) * clamp((total - 0.85 - w) / 0.26, 0, 1);
      if (!p.fitted && w > total * 0.55) {
        p.fitted = true;
        this._applyCompound(st, p.compound, true);
        st.pitStops++;
        if (p.penaltyHold > 0) { st.penaltyServed += p.penaltyHold; this._say('PENALTY SERVED', `${p.penaltyHold.toFixed(0)}s served`, 'ok'); }
      }
      if (w > total) { p.phase = 'out'; st.pitTime = w; this._say('PIT EXIT', `Stop: ${w.toFixed(2)}s`, 'ok'); }
    } else if (p.phase === 'out') {
      p.speed = Math.min(PIT_SPEED_LIMIT, p.speed + 8.5 * dt);
      p.lat = lerp(p.lat, p.laneLat, 1 - Math.exp(-dt * 2.4));
      p.lift = Math.max(0, p.lift - dt * 0.4);
      p.wheelOff = 0;
      if (wrapDelta(p.s, p.exitS, L) < 0.5 && wrapDelta(p.s, p.exitS, L) > -30) {
        // Hand the car back to physics on the pit-exit line.
        v.reset({ s: p.s, lateral: -(c.halfWidth - 1.9), speed: PIT_SPEED_LIMIT });
        st.pitState = null;
        st.pit = false;
        this._setWheelOffset(car, 0);
        return;
      }
    }

    p.s = c.wrapS(p.s + p.speed * dt);
    this._kinematic(car, p.s, p.lat, p.speed, dt, p.lift);
    this._setWheelOffset(car, p.wheelOff);
  }

  /** Pull the wheels off their uprights during a stop (visual only). */
  _setWheelOffset(car, t) {
    const set = car.model?.wheels?.wheels;
    if (!set) return;
    if (car._wheelOff === t) return;
    car._wheelOff = t;
    for (let i = 0; i < set.length; i++) {
      const g = set[i].spinGroup;
      if (!g) continue;
      g.position.x = (i % 2 === 0 ? -1 : 1) * t * 0.42;
    }
  }

  // ── penalties ───────────────────────────────────────────────────────────

  addPenalty(index, seconds, reason = 'PENALTY') {
    const st = this.state[index];
    if (!st) return this;
    st.penalty += seconds;
    st.penalties.push({ seconds, reason, lap: st.lapsDone + 1 });
    this._say('PENALTY', `${st.code} — ${seconds}s, ${reason}`, 'danger');
    return this;
  }

  // ── finishing and classification ────────────────────────────────────────

  _checkRaceFinish(car, st, tCross) {
    if (this.phase === 'classified') return;
    const done = st.lapsDone;
    if (done >= this.totalLaps && !st.finished) {
      st.finished = true;
      st.finishTime = tCross;
      if (this.leaderFinishTime === Infinity) {
        this.leaderFinishTime = tCross;
        this.phase = 'finished';
        this.flag = 'chequered';
        this.banner = 'CHEQUERED FLAG';
        this._say('CHEQUERED FLAG', `${st.code} takes the win`, 'ok');
        // Everyone still running is on their last lap.
      }
      if (car.ai) this._scalePace(car.ai, 0.72);
    }
    const running = this.state.filter((s) => !s.out && !s.retired);
    if (this.phase === 'finished' && running.every((s) => s.finished)) this._classify();
    if (this.phase === 'finished' && this.time - this.leaderFinishTime > 120) this._classify();
  }

  _classify() {
    if (this.classification) return this.classification;
    this.phase = 'classified';
    this.classification = this.classify();
    this.frontEnd?.onSessionEnd(this.classification);
    return this.classification;
  }

  /**
   * Official classification. Race: by laps completed then finishing time, with
   * penalties added to elapsed time. Qualifying / practice: by best lap.
   */
  classify() {
    const race = this.sessionType === 'race';
    const rows = this.state.map((st) => {
      const outstanding = Math.max(0, st.penalty - st.penaltyServed);
      const elapsed = st.finished ? st.finishTime - this.raceStart + outstanding : Infinity;
      return {
        index: st.index, code: st.code, name: st.name, number: st.number,
        team: st.team, colour: st.colour, grid: st.grid,
        laps: st.lapsDone, best: st.bestLap, elapsed,
        penalty: outstanding, retired: st.retired, out: st.out,
        stops: st.pitStops, compound: st.compound, warnings: st.warnings,
      };
    });

    if (race) {
      rows.sort((a, b) => {
        if (a.retired !== b.retired) return a.retired ? 1 : -1;
        if (a.laps !== b.laps) return b.laps - a.laps;
        if (isFinite(a.elapsed) || isFinite(b.elapsed)) return a.elapsed - b.elapsed;
        return this.state[a.index].progress > this.state[b.index].progress ? -1 : 1;
      });
    } else {
      rows.sort((a, b) => (a.best === b.best ? a.index - b.index : a.best - b.best));
    }

    const leader = rows[0];
    rows.forEach((r, i) => {
      r.position = i + 1;
      const down = Math.max(0, leader.laps - r.laps);
      // A gap is only a time when BOTH cars have one. Subtracting two Infinities
      // — which is what a field that never took the flag produces — put a
      // literal "+NaN" in every row of the classification.
      const timed = isFinite(r.elapsed) && isFinite(leader.elapsed);
      r.gap = i === 0 ? 0
        : (race ? (down > 0 ? -down : (timed ? r.elapsed - leader.elapsed : NaN))
          : r.best - leader.best);
      r.timeText = race
        ? (i === 0 ? formatRaceTime(r.elapsed)
          : down > 0 ? `+${down} LAP${down > 1 ? 'S' : ''}`
            : timed ? `+${(r.elapsed - leader.elapsed).toFixed(3)}` : '--')
        : formatLapTime(r.best);
      if (r.retired) r.timeText = 'DNF';
      if (r.out && !isFinite(r.best)) r.timeText = 'NO TIME';
      r.points = race && !r.retired && i < POINTS.length ? POINTS[i] : 0;
      r.bestText = formatLapTime(r.best);
    });
    if (race && this.fastestLap) {
      const fl = rows.find((r) => r.index === this.fastestLap.index);
      if (fl && fl.position <= 10 && !fl.retired) { fl.points += FASTEST_LAP_POINT; fl.fastest = true; }
      else if (fl) fl.fastest = true;
    }
    for (const r of rows) this.state[r.index].points += r.points;

    // The result of qualifying is the grid for the race.
    if (this.sessionType.startsWith('q')) this._applyQualifyingResult(rows);
    else if (race) this.gridOrder = rows.map((r) => r.index);
    return rows;
  }

  /**
   * Qualifying knockout: the slowest `drop` cars are eliminated and take the
   * back rows of the grid; the rest go through to the next segment.
   */
  _applyQualifyingResult(rows) {
    const live = rows.filter((r) => !this.eliminated.has(r.index));
    const drop = this.def.drop;
    const knocked = drop > 0 ? live.slice(live.length - drop) : [];
    for (const r of knocked) this.eliminated.add(r.index);
    // Grid: survivors in this session's order, then previously eliminated
    // groups in the order they were knocked out.
    const survivors = live.filter((r) => !this.eliminated.has(r.index)).map((r) => r.index);
    const knockedNow = knocked.map((r) => r.index);
    const previouslyOut = this.gridOrder.filter((i) => this.eliminated.has(i) && !knockedNow.includes(i));
    this.gridOrder = [...survivors, ...knockedNow, ...previouslyOut];
    this.qualifyingResult = rows;
  }

  retire(index, reason = 'RETIRED') {
    const st = this.state[index];
    if (!st || st.retired) return this;
    st.retired = true;
    st.retireReason = reason;
    // Park it where it expired, pulled toward the barrier so it is off the
    // racing line — which is also what makes the local double yellow honest.
    const v = this.cars[index]?.vehicle;
    if (v && st.parkS == null) {
      st.parkS = v.trackS;
      const side = Math.sign(v.trackLateral) || 1;
      st.parkLat = side * (this.circuit.halfWidth + 1.6);
    }
    this._say('RETIREMENT', `${st.code} is out — ${reason}`, 'danger');
    return this;
  }

  // ── practice / qualifying clock ─────────────────────────────────────────

  _updateSessionClock(dt) {
    if (!this.def.timed || this.phase === 'classified') return;
    if (this.phase !== 'running') return;
    this.sessionRemaining = Math.max(0, this.sessionRemaining - dt);
    if (this.sessionRemaining > 0) return;
    // The flag falls, but a car already on a lap gets to finish it.
    this.flag = 'chequered';
    this.banner = 'CHEQUERED FLAG';
    this._chequeredHold = (this._chequeredHold ?? 100) - dt;
    const stillRunning = this.state.some((s) => !s.out && !s.retired
      && this.circuit.sectorOf(this.cars[s.index].vehicle.trackS) > 0);
    if (!stillRunning || this._chequeredHold <= 0) {
      this.phase = 'finished';
      this._classify();
    }
  }

  // ── the timing trace ────────────────────────────────────────────────────

  /** Bank (progress, time) at 30 Hz. `progress` is monotonic, so the ring is sorted. */
  _pushTrace(st) {
    const tr = st.trace;
    if (this.time - tr.last < TRACE_DT) return;
    tr.last = this.time;
    tr.head = (tr.head + 1) % TRACE_N;
    tr.p[tr.head] = st.progress;
    tr.t[tr.head] = this.time;
    if (tr.count < TRACE_N) tr.count++;
  }

  /**
   * When was `st` at monotonic distance `p`? This is the whole of gap
   * computation: a gap is `now - _traceTimeAt(carAhead, myProgress)`. Because
   * the ring is sorted by construction it is a binary search, and the answer is
   * interpolated between samples so it is good to a millisecond.
   *
   * Returns NaN when the trace does not reach back that far (a fresh session, a
   * restage, or a car more than a lap down) — callers fall back to metres.
   */
  _traceTimeAt(st, p) {
    const tr = st.trace;
    const n = tr.count;
    if (n < 2) return NaN;
    const at = (k) => (tr.head - k + TRACE_N * 2) % TRACE_N;
    // k counts backwards in time, so p[at(k)] DECREASES as k grows.
    if (tr.p[at(0)] <= p) return tr.t[at(0)];        // ahead of the newest sample
    if (tr.p[at(n - 1)] > p) return NaN;             // older than the ring holds
    let lo = 0, hi = n - 1;                          // p[at(lo)] > p >= p[at(hi)]
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (tr.p[at(mid)] > p) lo = mid; else hi = mid;
    }
    const a = at(hi), b = at(lo);                    // p[a] <= p < p[b]
    const span = tr.p[b] - tr.p[a];
    const f = span > 1e-6 ? (p - tr.p[a]) / span : 0;
    return tr.t[a] + (tr.t[b] - tr.t[a]) * f;
  }

  /**
   * Seconds `behind` is adrift of `ahead`, right now. The trace is the truth;
   * when it cannot answer (first seconds of a session, straight after a
   * restage) fall back to metres over the *pair's* mean speed, which at least
   * does not jitter as one of the two brakes.
   */
  _gapBetween(ahead, behind) {
    const t = this._traceTimeAt(ahead, behind.progress);
    if (isFinite(t)) return Math.max(0, this.time - t);
    const d = ahead.progress - behind.progress;
    // REFERENCE-LAP FALLBACK. Dividing metres by a speed is wrong by a factor of
    // two between a hairpin and a straight, and — worse — it is not monotonic in
    // progress, so a freshly staged field reported the SAME gap for three cars in
    // a row (each one clamped to the car ahead by the `max` in `_rank`) and their
    // intervals came out as a literal +0.000. Integrating 1/v along the circuit
    // is the honest conversion and telescopes correctly.
    const ref = this._reference();
    const L = this.circuit.length;
    if (ref && d >= 0) {
      const sA = this.cars[ahead.index].vehicle.trackS;
      const sB = this.cars[behind.index].vehicle.trackS;
      const within = (((sA - sB) % L) + L) % L;
      const laps = Math.max(0, Math.round((d - within) / L));
      let dt = ref.timeAt(sA) - ref.timeAt(sB);
      if (dt < 0) dt += ref.lap;
      return Math.max(0, dt + laps * ref.lap);
    }
    const va = this.cars[ahead.index].vehicle.speed;
    const vb = this.cars[behind.index].vehicle.speed;
    return Math.max(0, d / Math.max(22, (va + vb) * 0.5));
  }

  // ── standings ───────────────────────────────────────────────────────────

  /**
   * Rank the field and produce the two numbers television actually shows: the
   * gap to the leader and the interval to the car in front. Both come from the
   * timing trace — the time at which the car ahead stood where this car is now
   * — which is the real definition and is stable through a braking zone, where
   * dividing metres by an instantaneous speed swings by tenths.
   */
  _rank() {
    const race = this.sessionType === 'race';
    const list = [...this.state];

    if (race || this.phase === 'formation' || this.phase === 'countdown' || this.phase === 'grid') {
      list.sort((a, b) => {
        if (a.retired !== b.retired) return a.retired ? 1 : -1;
        if (a.finished !== b.finished) return a.finished ? -1 : 1;
        if (a.finished && b.finished) return a.finishTime - b.finishTime;
        return b.progress - a.progress;
      });
    } else {
      list.sort((a, b) => {
        if (a.out !== b.out) return a.out ? 1 : -1;
        const ab = isFinite(a.bestLap) ? a.bestLap : Infinity;
        const bb = isFinite(b.bestLap) ? b.bestLap : Infinity;
        if (ab !== bb) return ab - bb;
        return a.index - b.index;
      });
    }

    const leader = list[0];
    for (let i = 0; i < list.length; i++) {
      const st = list[i];
      st.position = i + 1;
      if (race || this.phase !== 'running') {
        const dd = leader.progress - st.progress;
        st.lapped = dd > this.circuit.length * 0.98;
        if (i === 0) { st.gap = 0; st.interval = 0; }
        else {
          // Gap to the leader is the measured quantity; the interval is its
          // first difference. Deriving it that way is what makes the tower
          // telescope — the intervals sum to the gap, exactly as they do on a
          // real timing screen — and it costs one lookup per car, not two.
          // `max` with the car ahead only guards the frame in which a pass
          // completes, where two independent lookups can cross over.
          st.gap = Math.max(this._gapBetween(leader, st), list[i - 1].gap);
          st.interval = st.gap - list[i - 1].gap;
        }
        if (st.lapped) st.gapText = `+${Math.floor(dd / this.circuit.length)} LAP`;
        else st.gapText = i === 0 ? 'LEADER' : formatGap(st.gap);
      } else {
        st.gap = i === 0 ? 0 : (isFinite(st.bestLap) && isFinite(leader.bestLap) ? st.bestLap - leader.bestLap : NaN);
        st.interval = i === 0 ? 0 : (isFinite(st.bestLap) && isFinite(list[i - 1].bestLap) ? st.bestLap - list[i - 1].bestLap : NaN);
        st.gapText = i === 0 ? (isFinite(st.bestLap) ? formatLapTime(st.bestLap) : 'NO TIME')
          : isFinite(st.gap) ? `+${st.gap.toFixed(3)}` : '--';
      }
    }
    this.standings = list;
  }

  // ── race-control radio ──────────────────────────────────────────────────

  _say(title, text, kind = 'info') {
    const last = this.messages[this.messages.length - 1];
    if (last && last.title === title && last.text === text) return;
    this.messages.push({ title, text, kind, ttl: 6.5, t: this.time });
    if (this.messages.length > 6) this.messages.shift();
    this.frontEnd?.onMessage?.(this.messages[this.messages.length - 1]);
  }

  _pruneMessages(dt) {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      this.messages[i].ttl -= dt;
      if (this.messages[i].ttl <= 0) this.messages.splice(i, 1);
    }
  }

  // ── snapshot ────────────────────────────────────────────────────────────

  /**
   * The three sector cells. Only splits banked on the CURRENT lap are reported:
   * the HUD treats any non-empty sector status as "a sector was just set" and
   * raises an event card for it, so holding the previous lap's colours over
   * would spam the overlay with sectors the driver has not run yet.
   */
  _composeSectors(st) {
    const shown = st.shownSectors, status = st.shownStatus;
    const held = st.heldSectors ?? (st.heldSectors = [0, 0, 0]);
    for (let i = 0; i < 3; i++) {
      const done = st.currentSectors[i] > 0;
      shown[i] = done ? st.currentSectors[i] : 0;
      status[i] = done ? st.sectorStatus[i] : '';
      // The PREVIOUS lap's split, published alongside so the timing block can
      // hold it greyed instead of printing '--.---' for two thirds of every lap.
      held[i] = st.lastSectors?.[i] > 0 ? st.lastSectors[i] : 0;
    }
  }

  /** Everything the HUD needs, in HUD-friendly shapes. */
  snapshot(index = this.playerIndex) {
    const st = this.state[index] ?? this.state[0];
    const car = this.cars[st.index];
    this._composeSectors(st);
    const running = st.timingArmed || (this.sessionType === 'race' && this.raceStart > 0);
    const now = running ? Math.max(0, this.time - st.lapStart) : 0;

    // Live delta to the personal best, sampled at the current sector boundary.
    const sector = this.circuit.sectorOf(car.vehicle.trackS);
    let delta = 0, deltaLive = false;
    if (isFinite(st.bestLap) && st.timingArmed) {
      const refSplit = st.bestSectorTimes.slice(0, sector).reduce((a, b) => a + (isFinite(b) ? b : 0), 0);
      const done = st.currentSectors.slice(0, sector).reduce((a, b) => a + b, 0);
      const inSector = this.time - st.sectorStart;
      const refSector = isFinite(st.bestSectorTimes[sector]) ? st.bestSectorTimes[sector] : 0;
      const frac = refSector > 0 ? clamp(inSector / refSector, 0, 1.6) : 0;
      delta = (done + inSector) - (refSplit + refSector * frac);
      deltaLive = true;
    }

    const msg = this.messages[this.messages.length - 1];

    return {
      phase: this.phase,
      sessionType: this.sessionType,
      sessionLabel: this.def.label,
      sessionShort: this.def.short,
      sessionTimeText: this.def.timed ? formatClock(this.sessionRemaining) : '',
      sessionRemaining: this.sessionRemaining,
      lap: clamp(st.lapsDone + 1, 1, this.totalLaps),
      lapsDone: st.lapsDone,
      totalLaps: this.totalLaps,
      currentLapText: formatLapTime(now),
      lastLapText: formatLapTime(st.lastLap),
      bestLapText: formatLapTime(st.bestLap),
      sectorStatus: st.shownStatus,
      // ONE LAP RECORD. The sector strip used to mix this lap's banked splits
      // with the previous lap's held ones, which put three numbers side by side
      // that summed to a lap time printed nowhere on the HUD — the arithmetic
      // did not close and that is exactly the tell that makes a timing graphic
      // read as generated. Everything below now belongs to the LAP IN PROGRESS:
      // `sectorTimes[i]` for the splits already banked, `sectorLive` for the one
      // being driven, zero for the ones still to come. Banked + live is the
      // current lap time to the millisecond, so the strip and `currentLapText`
      // agree on screen.
      sectorTimes: st.shownSectors,
      sectorIndex: sector,
      // NOT `sectorStart > 0`: a staged capture rebases the whole timing trace
      // off `this.time`, which is near zero on the frame a shot is armed, so
      // every lap and sector start is legitimately NEGATIVE. Gate on the timer
      // being armed and on the elapsed value being a plausible sector instead.
      sectorLive: running && st.timingArmed && this.time - st.sectorStart > 0
        && this.time - st.sectorStart < 400 ? this.time - st.sectorStart : 0,
      // Kept for anything that still wants the carry-forward (the front end);
      // the HUD no longer draws it.
      prevSectorTimes: st.heldSectors,
      // Laps still to be completed INCLUDING the one in progress. One
      // definition, published once, so nothing can disagree with `lap/totalLaps`.
      lapsRemaining: Math.max(0, this.totalLaps - clamp(st.lapsDone + 1, 1, this.totalLaps) + 1),
      weatherLabel: this.weather?.conditions?.label ?? this.weather?.label ?? null,
      delta,
      deltaText: deltaLive ? formatDelta(delta) : '',
      flag: this.flag,
      sectorFlags: this.sectorFlags,
      drsEnabled: this.drsEnabled,
      bestOverall: this.bestLapOverall,
      fastestLap: this.fastestLap,
      playerCode: st.code,
      countdown: this.countdown,
      lights: this.lights,
      banner: this.banner ?? (msg ? msg.title : null),
      message: msg ?? null,
      penalty: Math.max(0, st.penalty - st.penaltyServed),
      warnings: st.warnings,
      pitting: !!st.pitState || !!st.pit,
      pitPhase: st.pitState?.phase ?? (st.pit ? 'in' : null),
      pitLimiter: !!st.pitState,
      safetyCar: this.safetyCar.active,
      vsc: this.vsc.active,
      classification: this.classification,
      standings: this.standings.map((s) => ({
        index: s.index,
        code: s.code,
        name: s.name,
        number: s.number,
        colour: s.colour,
        position: s.position,
        // NULL, not NaN, when there is no time to compare. In practice and
        // qualifying a driver who has not set a lap has no gap, and the HUD's
        // tower does `typeof e.interval === 'number'` before formatting it — NaN
        // passes that test and printed a literal "+NaN" down the timing tower.
        gap: isFinite(s.gap) ? s.gap : null,
        interval: isFinite(s.interval) ? s.interval : null,
        gapText: s.position === 1 ? (this.sessionType === 'race' ? 'LEADER' : s.gapText) : s.gapText,
        compound: s.compound,
        tyreAge: s.tyreAge,
        pit: !!s.pit,
        drs: !!s.drsOpen,
        blue: !!s.blue,
        retired: s.retired,
        out: s.out,
        penalty: Math.max(0, s.penalty - s.penaltyServed),
      })),
    };
  }

  /** Positions for the minimap. */
  carDots() {
    const out = [];
    for (let i = 0; i < this.cars.length; i++) {
      const st = this.state[i];
      if (st.out) continue;
      out.push({
        index: i,
        s: this.cars[i].vehicle.trackS,
        lateral: this.cars[i].vehicle.trackLateral,
        colour: st.colour,
      });
    }
    return out;
  }

  dispose() {
    this.frontEnd?.dispose();
    this.frontEnd = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// RaceFrontEnd — the game's shell
// ═══════════════════════════════════════════════════════════════════════════

/** The attract shot's orbit angle, framed by eye. See `_enterAttract`. */
const ATTRACT_ANGLE = 1.30;
/** Bounded sway around it: alive, but never wanders out of composition. */
const ATTRACT_SWAY = 0.085;
const ATTRACT_RATE = 0.085;

const F_NUM = '"DIN Condensed","Oswald","Avenir Next Condensed","Arial Narrow","Helvetica Neue",sans-serif';
const F_UI = '"DIN Alternate","Roboto Condensed","Helvetica Neue",Helvetica,Arial,sans-serif';

const CSS = `
/* The root never eats input; only a live screen does. The session-intro card
   flashes over the running game, and must not block the mouse while it does. */
#apex-frontend{position:absolute;inset:0;z-index:40;color:#f2f6fa;font-family:${F_UI};
  -webkit-font-smoothing:antialiased;overflow:hidden;user-select:none;pointer-events:none;}
#apex-frontend.hidden{display:none}
#apex-frontend .scrim{position:absolute;inset:0;
  background:radial-gradient(130% 100% at 50% 34%,rgba(5,8,14,.30) 0%,rgba(3,5,9,.88) 80%);
  backdrop-filter:blur(3px) saturate(1.2) brightness(.80);
  -webkit-backdrop-filter:blur(3px) saturate(1.2) brightness(.80);}
/* The title screen keeps the car visible on the right; everything else centres. */
#apex-frontend.title .scrim{
  background:linear-gradient(101deg,rgba(3,5,9,.95) 0%,rgba(3,5,9,.88) 30%,rgba(4,7,12,.34) 58%,
    rgba(3,5,9,.24) 76%,rgba(3,5,9,.66) 100%);
  backdrop-filter:blur(1.5px) saturate(1.3) brightness(.92);
  -webkit-backdrop-filter:blur(1.5px) saturate(1.3) brightness(.92);}
#apex-frontend .screen{position:absolute;inset:0;display:flex;flex-direction:column;
  align-items:center;justify-content:center;pointer-events:auto;
  opacity:0;transform:translateY(10px);transition:opacity .28s ease,transform .28s ease}
#apex-frontend .screen.left{align-items:flex-start;padding-left:clamp(48px,7vw,120px)}
#apex-frontend .screen.on{opacity:1;transform:none}
#apex-frontend .screen.off{pointer-events:none;display:none}

#apex-frontend .panel{position:relative;
  background:linear-gradient(180deg,rgba(17,22,31,.72),rgba(6,9,14,.86));
  border:1px solid rgba(255,255,255,.16);
  box-shadow:0 22px 60px rgba(0,0,0,.62), inset 0 1px 0 rgba(255,255,255,.10);
  backdrop-filter:blur(14px) saturate(1.3) brightness(.76);
  -webkit-backdrop-filter:blur(14px) saturate(1.3) brightness(.76);
  clip-path:polygon(0 0,calc(100% - 22px) 0,100% 22px,100% 100%,22px 100%,0 calc(100% - 22px));}
#apex-frontend .panel > .rule{position:absolute;left:0;top:0;height:3px;width:100%;
  background:linear-gradient(90deg,#c4202c 0%,rgba(196,32,44,.25) 62%,rgba(196,32,44,0) 100%)}

#apex-frontend .lab{font-size:10px;font-weight:700;letter-spacing:2.1px;
  color:rgba(223,233,243,.38);text-transform:uppercase}
#apex-frontend .num{font-family:${F_NUM};font-weight:700;font-variant-numeric:tabular-nums}

/* ── title ─────────────────────────────────────────────────────────────── */
#apex-frontend .wordmark{display:flex;align-items:flex-end;gap:14px;margin-bottom:6px;
  animation:apx-in .7s cubic-bezier(.16,1,.3,1) both}
@keyframes apx-in{from{opacity:0;transform:translateX(-26px)}to{opacity:1;transform:none}}
#apex-frontend .wordmark b{font-family:${F_NUM};font-size:104px;line-height:.84;font-weight:700;
  letter-spacing:8px;transform:skewX(-11deg);
  background:linear-gradient(180deg,#ffffff 8%,#c9d6e4 62%,#7d8fa3 100%);
  -webkit-background-clip:text;background-clip:text;color:transparent;
  filter:drop-shadow(0 6px 22px rgba(0,0,0,.7))}
#apex-frontend .wordmark i{font-family:${F_NUM};font-style:normal;font-size:104px;line-height:.84;
  font-weight:700;letter-spacing:6px;transform:skewX(-11deg);color:#ff2f3b;
  text-shadow:0 0 34px rgba(255,47,59,.55)}
#apex-frontend .tagline{font-size:11.5px;letter-spacing:6.5px;font-weight:700;
  color:rgba(223,233,243,.72);margin-bottom:30px}
#apex-frontend .speedline{height:2px;width:430px;margin-bottom:26px;
  background:linear-gradient(90deg,#ff2f3b 0%,#ffffff 34%,#33ccff 66%,rgba(51,204,255,0) 100%)}

#apex-frontend .menu{display:flex;flex-direction:column;gap:7px;width:430px;
  padding:14px 0;position:relative}
#apex-frontend .screen.left .menu:before{content:'';position:absolute;
  left:-26px;right:-40px;top:0;bottom:0;z-index:-1;
  background:linear-gradient(96deg,rgba(8,12,18,.80),rgba(8,12,18,.30) 72%,rgba(8,12,18,0));
  border-left:1px solid rgba(255,255,255,.10)}
#apex-frontend .brandbar{position:absolute;left:0;right:0;bottom:0;height:44px;
  display:flex;align-items:center;gap:22px;padding:0 clamp(48px,7vw,120px);
  background:linear-gradient(0deg,rgba(3,5,9,.92),rgba(3,5,9,0));
  font-size:9.5px;letter-spacing:2.4px;font-weight:700;color:rgba(223,233,243,.42)}
#apex-frontend .brandbar b{color:rgba(223,233,243,.8);font-weight:700}
#apex-frontend .brandbar .dot{width:4px;height:4px;background:#ff2f3b;border-radius:50%}
#apex-frontend .item{position:relative;display:flex;align-items:center;gap:14px;
  height:50px;padding:0 18px;cursor:pointer;
  background:linear-gradient(90deg,rgba(255,255,255,.055),rgba(255,255,255,.012));
  border-left:3px solid rgba(255,255,255,.14);
  clip-path:polygon(0 0,100% 0,calc(100% - 14px) 100%,0 100%);
  transition:background .16s ease,border-color .16s ease,transform .16s ease}
#apex-frontend .item .k{font-family:${F_NUM};font-size:15px;color:rgba(223,233,243,.34);width:22px}
#apex-frontend .item .t{font-size:15.5px;font-weight:700;letter-spacing:2.6px}
#apex-frontend .item .d{margin-left:auto;font-size:10px;letter-spacing:1.6px;color:rgba(223,233,243,.4)}
#apex-frontend .item:hover,#apex-frontend .item.sel{background:linear-gradient(90deg,rgba(196,32,44,.55),rgba(196,32,44,.06));
  border-left-color:#ff2f3b;transform:translateX(5px)}
#apex-frontend .item.sel .t{color:#fff}
#apex-frontend .hint{margin-top:34px;font-size:10px;letter-spacing:2.6px;color:rgba(223,233,243,.3)}

/* ── setup ─────────────────────────────────────────────────────────────── */
#apex-frontend .sheet{width:min(1180px,92vw);max-height:88vh;padding:0 0 22px}
#apex-frontend .head{display:flex;align-items:center;height:52px;padding:0 22px;
  background:linear-gradient(90deg,rgba(196,32,44,.92) 0%,rgba(120,16,26,.5) 58%,rgba(10,14,20,.16) 100%)}
#apex-frontend .head h2{font-size:17px;font-weight:700;letter-spacing:3.4px;margin:0}
#apex-frontend .head .sub{margin-left:auto;font-size:10.5px;letter-spacing:2.4px;color:rgba(255,255,255,.62)}
#apex-frontend .body{padding:22px 24px 4px;display:grid;gap:20px}
#apex-frontend .row{display:grid;grid-template-columns:150px 1fr;align-items:center;gap:18px}
#apex-frontend .row.top{align-items:start}
#apex-frontend .row.top > .lab{padding-top:9px}
#apex-frontend .opts{display:flex;flex-wrap:wrap;gap:6px}
#apex-frontend .opt{padding:8px 15px;font-size:12px;font-weight:700;letter-spacing:1.7px;cursor:pointer;
  background:rgba(255,255,255,.045);border:1px solid rgba(255,255,255,.12);
  clip-path:polygon(0 0,100% 0,calc(100% - 9px) 100%,0 100%);color:rgba(233,240,248,.72);
  transition:all .14s ease}
#apex-frontend .opt:hover{background:rgba(255,255,255,.11);color:#fff}
#apex-frontend .opt.on{background:linear-gradient(90deg,rgba(51,204,255,.30),rgba(51,204,255,.10));
  border-color:#33ccff;color:#fff;box-shadow:0 0 18px rgba(51,204,255,.22)}
#apex-frontend .opt .sw{display:inline-block;width:9px;height:9px;margin-right:8px;vertical-align:-1px;
  border-radius:1px;box-shadow:0 0 7px currentColor}

#apex-frontend .cars{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;max-height:250px;overflow-y:auto;
  padding-right:4px;scrollbar-width:thin}
#apex-frontend .card{position:relative;padding:9px 10px 9px 13px;cursor:pointer;
  background:linear-gradient(90deg,rgba(255,255,255,.05),rgba(255,255,255,.012));
  border:1px solid rgba(255,255,255,.09);transition:all .14s ease;overflow:hidden}
#apex-frontend .card:before{content:'';position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--c)}
#apex-frontend .card:hover{background:rgba(255,255,255,.1)}
#apex-frontend .card.on{border-color:var(--c);background:linear-gradient(90deg,color-mix(in srgb,var(--c) 42%,transparent),rgba(255,255,255,.02));
  box-shadow:0 0 20px -6px var(--c)}
#apex-frontend .card .nm{font-size:13px;font-weight:700;letter-spacing:1.4px}
#apex-frontend .card .tm{font-size:9px;letter-spacing:1.5px;color:rgba(223,233,243,.46);margin-top:2px}
#apex-frontend .card .no{position:absolute;right:9px;top:6px;font-family:${F_NUM};font-size:22px;
  font-weight:700;color:rgba(255,255,255,.20);transform:skewX(-11deg)}

#apex-frontend .foot{display:flex;align-items:center;gap:10px;padding:16px 24px 0;margin-top:4px;
  border-top:1px solid rgba(255,255,255,.09)}
#apex-frontend .btn{padding:12px 26px;font-size:13px;font-weight:700;letter-spacing:2.6px;cursor:pointer;
  background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.16);color:#e9f0f8;
  clip-path:polygon(0 0,100% 0,calc(100% - 12px) 100%,0 100%);transition:all .15s ease}
#apex-frontend .btn:hover{background:rgba(255,255,255,.14);color:#fff}
#apex-frontend .btn.go{background:linear-gradient(90deg,#c4202c,#8a121c);border-color:#ff4a55;color:#fff;
  box-shadow:0 0 26px -6px rgba(255,60,70,.85)}
#apex-frontend .btn.go:hover{background:linear-gradient(90deg,#e12734,#a4141f)}
#apex-frontend .spacer{margin-left:auto}

/* ── results ───────────────────────────────────────────────────────────── */
#apex-frontend table{border-collapse:collapse;width:100%;font-size:13px}
#apex-frontend th{font-size:9px;letter-spacing:2px;color:rgba(223,233,243,.38);font-weight:700;
  text-align:left;padding:0 8px 8px;text-transform:uppercase}
#apex-frontend td{padding:4px 8px;border-top:1px solid rgba(255,255,255,.05)}
#apex-frontend tr.me td{background:linear-gradient(90deg,rgba(255,255,255,.17),rgba(255,255,255,.06) 55%,rgba(255,255,255,.03));
  box-shadow:inset 0 1px 0 rgba(255,255,255,.16),inset 0 -1px 0 rgba(255,255,255,.10)}
#apex-frontend tr.me td.p{color:#fff}
#apex-frontend tr.podium td.p{color:#ffd21e}
#apex-frontend tr.gone td{color:rgba(223,233,243,.32)}
#apex-frontend th.r,#apex-frontend td.p,#apex-frontend td.t,#apex-frontend td.pts{text-align:right}
#apex-frontend td.p{font-family:${F_NUM};font-size:17px;font-weight:700;width:38px}
#apex-frontend td.t{font-family:${F_NUM};font-size:14.5px;font-variant-numeric:tabular-nums}
#apex-frontend td.pts{font-family:${F_NUM};font-size:15px;color:#22e07c;width:44px}
#apex-frontend td.c{width:5px;padding:0}
#apex-frontend td.c span{display:block;width:5px;height:19px;box-shadow:0 0 8px -1px currentColor}
#apex-frontend .scroll{max-height:66vh;overflow-y:auto;padding:0 24px 14px;
  -webkit-mask-image:linear-gradient(180deg,#000 0,#000 calc(100% - 26px),transparent 100%);
  mask-image:linear-gradient(180deg,#000 0,#000 calc(100% - 26px),transparent 100%)}
#apex-frontend .purple{color:#c264ff}
#apex-frontend .fl{display:inline-block;width:0;height:0;margin-left:6px;vertical-align:2px;
  border-left:4px solid transparent;border-right:4px solid transparent;border-bottom:7px solid #c264ff}

/* ── pause ─────────────────────────────────────────────────────────────── */
#apex-frontend .pause{width:380px;padding:0 0 20px}
#apex-frontend .slider{display:flex;align-items:center;gap:12px}
#apex-frontend input[type=range]{-webkit-appearance:none;appearance:none;flex:1;height:4px;
  background:rgba(255,255,255,.14);outline:none}
#apex-frontend input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;width:12px;height:16px;
  background:#33ccff;cursor:pointer;box-shadow:0 0 12px rgba(51,204,255,.7)}
#apex-frontend .val{font-family:${F_NUM};font-size:15px;width:46px;text-align:right;color:#33ccff}

/* ── session intro banner ──────────────────────────────────────────────── */
#apex-frontend .intro{position:absolute;left:0;right:0;top:34%;text-align:center;pointer-events:none}
#apex-frontend .intro .big{font-family:${F_NUM};font-size:74px;font-weight:700;letter-spacing:9px;
  transform:skewX(-11deg);text-shadow:0 8px 40px rgba(0,0,0,.85)}
`;

/**
 * Colour a weather swatch from what the state actually does, not its name, so
 * a new entry in `WEATHER_STATES` gets a sensible chip for free.
 */
function weatherSwatch(w) {
  if ((w.rain ?? 0) > 0.5) return '#2f6fc8';
  if ((w.rain ?? 0) > 0.04) return '#3399ff';
  if ((w.wetness ?? 0) > 0.08) return '#22e07c';
  if ((w.cloudCoverage ?? 0) > 0.5) return '#9fb6cf';
  return '#ffd21e';
}

/**
 * The game's shell: title, setup, pause, settings and results.
 *
 * It drives the engine through the documented public API only — `engine.frozen`
 * for the sim, `rig.setMode`, `hud.setVisible`, `weather.setState`,
 * `audio.setMasterVolume` — so it stays valid as those modules evolve.
 */
export class RaceFrontEnd {
  constructor(session, { auto = true } = {}) {
    this.session = session;
    this.engine = null;
    this.screen = null;
    this.visible = false;
    this.sel = 0;
    this.hidden = false;

    const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
    this.forceOff = q.get('ui') === '0';
    this.forceOn = q.get('ui') === '1';
    // A capture harness drives the page headless: never let the shell into a shot.
    this.headless = typeof navigator !== 'undefined' && navigator.webdriver === true;
    if (this.forceOff || (this.headless && !this.forceOn)) { this.hidden = true; }

    this.config = {
      format: 'quick',
      driver: 0,
      livery: 0,
      circuit: 0,
      weather: 'dry',
      difficulty: 'pro',
      laps: session.totalLaps,
      gridSlot: 0,          // 0 = whatever the seeded qualifying gave you
      camera: 'chase',
      hud: true,
      glass: true,
      volume: 0.7,
      assists: true,
      racingLine: false,
    };

    this._root = null;
    this._raf = null;
    this._onKey = (e) => this._key(e);
    if (auto && !this.hidden) this.mount();
    if (!this.hidden) this._loop();
  }

  // ── mounting ────────────────────────────────────────────────────────────

  mount() {
    if (this._root || typeof document === 'undefined') return;
    if (!document.getElementById('apex-frontend-css')) {
      const style = document.createElement('style');
      style.id = 'apex-frontend-css';
      style.textContent = CSS;
      document.head.appendChild(style);
    }
    const root = document.createElement('div');
    root.id = 'apex-frontend';
    root.innerHTML = `<div class="scrim"></div>`;
    (document.getElementById('app') ?? document.body).appendChild(root);
    this._root = root;
    this._scrim = root.querySelector('.scrim');
    window.addEventListener('keydown', this._onKey);
    this.show('title');
  }

  dispose() {
    if (this._raf) cancelAnimationFrame(this._raf);
    window.removeEventListener('keydown', this._onKey);
    this._root?.remove();
    this._root = null;
  }

  /** The shell owns its own rAF: the engine's loop stops while we are up. */
  _loop() {
    let last = 0;
    const tick = (now) => {
      this._raf = requestAnimationFrame(tick);
      // Bail out of the shell entirely the moment a capture starts.
      const capturing = typeof window !== 'undefined' && window.__APEX__?.engine?.captureShot;
      if (capturing && this._root) { this._root.remove(); this._root = null; this.visible = false; return; }
      if (!this.engine) { this.onEngineReady(); last = now; return; }
      const dt = Math.min(0.1, last ? (now - last) / 1000 : 0);
      last = now;
      // The sim is frozen behind the menu but the engine keeps rendering, so the
      // orbit is the only motion in the shot. Sway it around the framed angle
      // rather than letting the rig integrate away from the composition.
      if (this.visible && this._attractT != null && this.engine.rig?.mode === 'hero') {
        this._attractT += dt;
        this.engine.rig.orbitAngle = ATTRACT_ANGLE
          + Math.sin(this._attractT * ATTRACT_RATE) * ATTRACT_SWAY;
      }
    };
    this._raf = requestAnimationFrame(tick);
  }

  onEngineReady() {
    const eng = typeof window !== 'undefined' ? window.__APEX__?.engine : null;
    if (!eng || this.engine) return;
    this.engine = eng;
    this.config.laps = this.session.totalLaps;
    if (this.visible) this._enterAttract();
  }

  // ── engine control ──────────────────────────────────────────────────────

  /**
   * Attract mode: the sim is frozen on a formed-up grid and the hero rig makes
   * a slow three-quarter orbit of the player's car, so the menu sits over a
   * live render rather than a still.
   */
  _enterAttract() {
    const e = this.engine;
    if (!e) return;
    e.frozen = true;
    this.session.paused = true;
    e.hud?.setVisible?.(false);
    try {
      this.session.gridOrder.forEach((carIndex, slot) => {
        const s = e.circuit.gridSlot(slot);
        e.field.cars[carIndex].vehicle.reset({ s: s.s, lateral: s.lateral, speed: 0 });
      });
      e.field.syncModels();
      e.rig.setMode('hero');
      // Nearly head-on to the pole car (a ≈ π/2 is dead ahead of the nose), at
      // wing height, on a long lens. Framed by eye: this puts the hero car in
      // the right two thirds with the second column of the grid receding
      // diagonally away behind the menu — depth rather than clutter — and leaves
      // the left column of the frame completely clean for the menu to live on.
      // A lifted, wide three-quarter (the previous 14.5 m / 3.1 m / 36°) instead
      // pointed the lens across the track at the pit garages and cropped the car
      // into the bottom-left corner.
      e.rig.orbitAngleTrim = 0.30;
      e.rig.orbitAngle = ATTRACT_ANGLE;
      e.rig.orbitRadius = 11.5;
      e.rig.orbitHeight = 1.55;
      e.rig.orbitDolly = 0.25;
      // `orbitLead` shifts the subject the OPPOSITE way to what its name
      // suggests from this angle: negative pushes the car right, off the menu.
      e.rig.orbitLead = -0.28;
      e.rig.orbitFov = 29;
      // The rig's own drift accumulates without bound, which would rotate this
      // composition right round inside a minute. The sway below owns the angle.
      e.rig.orbitSpeed = 0;
      this._attractT = 0;
      e.rig.snap();
      e.rig.update(1 / 60);
      e.environment?.setStartLights?.(0);
    } catch { /* engine still booting */ }
  }

  _leaveAttract() {
    const e = this.engine;
    if (!e) return;
    e.frozen = false;
    this.session.paused = false;
    e.hud?.setVisible?.(this.config.hud);
    e.rig?.setMode?.(this.config.camera);
    e.audio?.resume?.();
  }

  // ── screens ─────────────────────────────────────────────────────────────

  show(name) {
    if (this.hidden) return;
    if (!this._root) this.mount();
    this.screen = name;
    this.visible = name !== null;
    this.sel = 0;
    for (const el of this._root.querySelectorAll('.screen')) el.remove();
    if (!name) {
      this._root.classList.add('hidden');
      this._leaveAttract();
      return;
    }
    this._root.classList.remove('hidden');
    this._root.classList.toggle('title', name === 'title');
    const el = document.createElement('div');
    el.className = `screen off${name === 'title' ? ' left' : ''}`;
    el.innerHTML = this[`_${name}`]?.() ?? '';
    this._root.appendChild(el);
    this._screenEl = el;
    requestAnimationFrame(() => { el.classList.remove('off'); requestAnimationFrame(() => el.classList.add('on')); });
    this._wire(el);
    if (name === 'title' || name === 'setup') this._enterAttract();
    else if (name === 'pause' || name === 'settings') {
      if (this.engine) { this.engine.frozen = true; this.session.paused = true; }
    }
  }

  hide() { this.show(null); }

  // ── title ───────────────────────────────────────────────────────────────

  _title() {
    const c = this.session.circuit;
    const items = [
      ['1', 'QUICK RACE', `${this.config.laps} LAPS`, 'quick'],
      ['2', 'RACE WEEKEND', 'FP · Q1 Q2 Q3 · GP', 'grandPrix'],
      ['3', 'TIME TRIAL', 'SOLO', 'timeTrial'],
      ['4', 'SETTINGS', '', 'settings'],
    ];
    return `
      <div class="wordmark"><b>APEX</b><i>GP</i></div>
      <div class="tagline">FORMULA RACING SIMULATOR</div>
      <div class="speedline"></div>
      <div class="menu">
        ${items.map(([k, t, d, act], i) => `
          <div class="item${i === 0 ? ' sel' : ''}" data-act="${act}" data-i="${i}">
            <span class="k num">${k}</span><span class="t">${t}</span><span class="d">${d}</span>
          </div>`).join('')}
      </div>
      <div class="hint">↑ ↓ SELECT · ENTER CONFIRM · ESC BACK</div>
      <div class="brandbar">
        <span class="dot"></span><b>APEX INTERNATIONAL</b>
        <span>${(c.length / 1000).toFixed(3)} KM</span>
        <span>${c.drsZones.length} DRS ZONES</span>
        <span>${this.session.cars.length} CARS · ${TEAMS.length} TEAMS</span>
        <span style="margin-left:auto">THREE.JS · PROCEDURAL · 60 FPS</span>
      </div>`;
  }

  // ── setup ───────────────────────────────────────────────────────────────

  _setup() {
    const c = this.config;
    const grid = [];
    TEAMS.forEach((team, ti) => team.drivers.forEach((d, di) => {
      grid.push({ team, driver: d, index: ti * 2 + di });
    }));
    const opt = (v, label, on, extra = '') =>
      `<div class="opt${on ? ' on' : ''}" ${extra} data-set="${v}">${label}</div>`;

    return `
      <div class="panel sheet">
        <div class="rule"></div>
        <div class="head"><h2>RACE SETUP</h2>
          <div class="sub">${WEEKEND_FORMATS[c.format]?.label ?? 'QUICK RACE'}</div></div>
        <div class="body">
          <div class="row top"><div class="lab">DRIVER &amp; CAR</div>
            <div class="cars" data-group="driver">
              ${grid.map((g) => `
                <div class="card${g.index === c.driver ? ' on' : ''}" style="--c:${g.team.primary}" data-set="${g.index}">
                  <div class="nm">${g.driver.code}</div>
                  <div class="tm">${g.team.short} · ${g.team.name.toUpperCase()}</div>
                  <div class="no num">${g.driver.number}</div>
                </div>`).join('')}
            </div></div>

          <div class="row"><div class="lab">LIVERY</div>
            <div class="opts" data-group="livery">
              ${['WORKS', 'HERITAGE', 'SPECIAL'].map((l, i) => opt(i, l, i === c.livery)).join('')}
            </div></div>

          <div class="row"><div class="lab">CIRCUIT</div>
            <div class="opts" data-group="circuit">
              ${opt(0, 'APEX INTERNATIONAL', true)}
              <div class="opt" style="opacity:.35;cursor:default">${(this.session.circuit.length / 1000).toFixed(3)} KM · ${this.session.circuit.corners?.length ?? 16} CORNERS · ${this.session.circuit.drsZones.length} DRS</div>
            </div></div>

          <div class="row"><div class="lab">WEATHER</div>
            <div class="opts" data-group="weather">
              ${Object.entries(WEATHER_STATES).map(([k, w]) =>
                opt(k, `<span class="sw" style="color:${weatherSwatch(w)};background:currentColor"></span>${w.label ?? k.toUpperCase()}`, k === c.weather)).join('')}
            </div></div>

          <div class="row"><div class="lab">DIFFICULTY</div>
            <div class="opts" data-group="difficulty">
              ${Object.entries(DIFFICULTIES).map(([k, d]) => opt(k, d.label, k === c.difficulty)).join('')}
            </div></div>

          <div class="row"><div class="lab">RACE DISTANCE</div>
            <div class="opts" data-group="laps">
              ${[5, 10, 15, 24, 36, 50].map((n) => opt(n, `${n} LAPS`, n === c.laps)).join('')}
            </div></div>

          <div class="row"><div class="lab">STARTING GRID</div>
            <div class="opts" data-group="gridSlot">
              ${[[0, 'AS QUALIFIED'], [1, 'POLE'], [5, 'P5'], [10, 'P10'], [16, 'P16'], [20, 'LAST']]
                .map(([v, l]) => opt(v, l, v === c.gridSlot)).join('')}
            </div></div>
        </div>
        <div class="foot">
          <div class="btn" data-act="title">BACK</div>
          <div class="spacer"></div>
          <div class="lab" style="margin-right:14px">ENTER TO START</div>
          <div class="btn go" data-act="start">ENTER SESSION</div>
        </div>
      </div>`;
  }

  // ── pause ───────────────────────────────────────────────────────────────

  _pause() {
    const s = this.session;
    const snap = s.snapshot();
    const st = s.state[s.playerIndex];
    const me = snap.standings.find((x) => x.index === s.playerIndex);
    const items = [
      ['RESUME', 'resume'],
      ['SETTINGS', 'settings'],
      ['RESTART SESSION', 'restart'],
      ['QUIT TO TITLE', 'title'],
    ];
    const tyre = TYRES[st.compound] ?? TYRES.medium;
    const laps = Math.max(1, s.totalLaps);
    // Laps of fuel in hand. This uses the burn rate race control actually
    // calibrated (`_fuelPerLap`, which carries a 0.8-lap reserve) rather than the
    // flat `103 / laps` the HUD assumes, so the number is the truth: you leave
    // the grid with a real margin instead of exactly nothing.
    const perLap = s._fuelPerLap || (103 / laps);
    const margin = st.fuel / perLap - (laps - snap.lapsDone);
    const row = (label, value, colour) => `
      <div class="row" style="grid-template-columns:1fr auto">
        <div class="lab">${label}</div>
        <div class="num" style="font-size:21px${colour ? `;color:${colour}` : ''}">${value}</div>
      </div>`;
    const outstanding = Math.max(0, st.penalty - st.penaltyServed);
    return `
      <div class="panel pause">
        <div class="rule"></div>
        <div class="head"><h2>PAUSED</h2><div class="sub">${snap.sessionLabel}</div></div>
        <div class="body" style="gap:9px;padding:18px 20px 6px">
          ${row('POSITION', `P${me?.position ?? 1}`)}
          ${row('LAP', `${snap.lap} / ${snap.totalLaps}`)}
          ${row('INTERVAL', me && me.position > 1 && isFinite(me.interval)
            ? `+${me.interval.toFixed(3)}` : '—')}
          ${row('BEST LAP', snap.bestLapText)}
          ${row('TYRES', `<span style="color:${tyre.colour}">${tyre.label}</span>`
            + `<span style="color:rgba(223,233,243,.5);font-size:14px"> ${st.tyreAge}L`
            + ` · ${Math.round(st.tyreLife * 100)}%</span>`)}
          ${row('FUEL', `${st.fuel.toFixed(1)}<span style="font-size:12px;color:rgba(223,233,243,.5)">kg</span>`
            + `<span style="font-size:14px;color:${margin >= 0 ? '#22e07c' : '#ff2d37'}">`
            + ` ${margin >= 0 ? '+' : ''}${margin.toFixed(2)}L</span>`)}
          ${outstanding > 0 ? row('PENALTY', `+${outstanding.toFixed(0)}s`, '#ff9a17') : ''}
          ${st.warnings > 0 ? row('TRACK LIMITS', `${st.warnings} / 3`, '#ff9a17') : ''}
          <div class="menu" style="width:auto;margin-top:10px">
            ${items.map(([t, act], i) => `<div class="item${i === 0 ? ' sel' : ''}" data-act="${act}" data-i="${i}"><span class="t">${t}</span></div>`).join('')}
          </div>
        </div>
      </div>`;
  }

  // ── settings ────────────────────────────────────────────────────────────

  _settings() {
    const c = this.config;
    const opt = (v, label, on) => `<div class="opt${on ? ' on' : ''}" data-set="${v}">${label}</div>`;
    return `
      <div class="panel sheet" style="width:min(760px,90vw)">
        <div class="rule"></div>
        <div class="head"><h2>SETTINGS</h2><div class="sub">APEX GP</div></div>
        <div class="body">
          <div class="row"><div class="lab">CAMERA</div><div class="opts" data-group="camera">
            ${['chase', 'cockpit', 'halo', 'tv', 'hero', 'wide'].map((m) => opt(m, m.toUpperCase(), m === c.camera)).join('')}
          </div></div>
          <div class="row"><div class="lab">HUD</div><div class="opts" data-group="hud">
            ${opt('1', 'BROADCAST', c.hud)}${opt('0', 'OFF', !c.hud)}
          </div></div>
          <div class="row"><div class="lab">FROSTED GLASS</div><div class="opts" data-group="glass">
            ${opt('1', 'ON', c.glass)}${opt('0', 'OFF', !c.glass)}
          </div></div>
          <div class="row"><div class="lab">DRIVING AIDS</div><div class="opts" data-group="assists">
            ${opt('1', 'ON', c.assists)}${opt('0', 'OFF', !c.assists)}
          </div></div>
          <div class="row"><div class="lab">DIFFICULTY</div><div class="opts" data-group="difficulty">
            ${Object.entries(DIFFICULTIES).map(([k, d]) => opt(k, d.label, k === c.difficulty)).join('')}
          </div></div>
          <div class="row"><div class="lab">VOLUME</div>
            <div class="slider"><input type="range" min="0" max="100" value="${Math.round(c.volume * 100)}" data-slider="volume">
              <div class="val num">${Math.round(c.volume * 100)}</div></div></div>
        </div>
        <div class="foot"><div class="btn" data-act="back">BACK</div></div>
      </div>`;
  }

  // ── results ─────────────────────────────────────────────────────────────

  _results() {
    const s = this.session;
    const rows = s.classification ?? s.classify();
    const race = s.sessionType === 'race';
    const nextType = s.nextSessionType;
    const fl = s.fastestLap;
    return `
      <div class="panel sheet" style="width:min(1020px,92vw)">
        <div class="rule"></div>
        <div class="head"><h2>${s.def.label} — CLASSIFICATION</h2>
          <div class="sub">APEX INTERNATIONAL${race ? ` · ${s.totalLaps} LAPS` : ''}</div></div>
        <div class="scroll" style="padding-top:16px">
          <table>
            <thead><tr><th></th><th class="r">POS</th><th>DRIVER</th><th>TEAM</th>
              <th class="r">${race ? 'TIME / GAP' : 'BEST LAP'}</th>
              <th class="r">${race ? 'BEST LAP' : 'GAP'}</th>
              <th class="r">${race ? 'STOPS' : 'LAPS'}</th><th class="r">PTS</th></tr></thead>
            <tbody>
              ${rows.map((r) => `
                <tr class="${r.index === s.playerIndex ? 'me' : ''}${r.retired || r.out ? ' gone' : ''}${!r.retired && r.position <= 3 ? ' podium' : ''}">
                  <td class="c"><span style="background:${r.colour};color:${r.colour}"></span></td>
                  <td class="p">${r.retired ? '—' : r.position}</td>
                  <td style="font-weight:700;letter-spacing:1.2px">${r.code}<span style="color:rgba(223,233,243,.42);font-weight:600;letter-spacing:.6px"> ${r.name}</span>${r.penalty ? `<span style="color:#ff9a17;font-size:10px;letter-spacing:1.4px"> +${r.penalty}s</span>` : ''}</td>
                  <td style="color:rgba(223,233,243,.55);font-size:11px;letter-spacing:1.1px">${r.team.toUpperCase()}</td>
                  <td class="t">${r.timeText}</td>
                  <td class="t ${fl && fl.index === r.index ? 'purple' : ''}">${race ? r.bestText : (r.position === 1 ? '—' : isFinite(r.gap) ? `+${r.gap.toFixed(3)}` : '—')}${fl && fl.index === r.index ? '<span class="fl"></span>' : ''}</td>
                  <td class="t">${race ? r.stops : r.laps}</td>
                  <td class="pts">${r.points || ''}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div class="foot">
          <div class="btn" data-act="title">MAIN MENU</div>
          <div class="spacer"></div>
          ${fl ? `<div class="lab" style="margin-right:16px">FASTEST LAP <span class="num purple" style="font-size:15px">${formatLapTime(fl.time)}</span> ${fl.code}</div>` : ''}
          ${nextType ? `<div class="btn go" data-act="next">CONTINUE TO ${SESSION_DEFS[nextType].short}</div>`
                     : `<div class="btn go" data-act="setup">NEW SESSION</div>`}
        </div>
      </div>`;
  }

  // ── interaction ─────────────────────────────────────────────────────────

  _wire(el) {
    el.addEventListener('click', (ev) => {
      const opt = ev.target.closest('[data-set]');
      if (opt) {
        const group = opt.closest('[data-group]')?.dataset.group;
        if (group) { this._set(group, opt.dataset.set, opt); return; }
      }
      const act = ev.target.closest('[data-act]');
      if (act) this._act(act.dataset.act);
    });
    el.addEventListener('mousemove', (ev) => {
      const item = ev.target.closest('.item');
      if (!item) return;
      for (const i of el.querySelectorAll('.item')) i.classList.remove('sel');
      item.classList.add('sel');
      this.sel = parseInt(item.dataset.i ?? '0', 10);
    });
    const slider = el.querySelector('[data-slider]');
    if (slider) {
      slider.addEventListener('input', () => {
        this.config.volume = slider.value / 100;
        slider.parentElement.querySelector('.val').textContent = slider.value;
        this.engine?.audio?.setMasterVolume?.(this.config.volume);
      });
    }
  }

  _set(group, value, el) {
    const numeric = ['driver', 'livery', 'circuit', 'laps', 'gridSlot'];
    this.config[group] = numeric.includes(group) ? parseInt(value, 10)
      : (group === 'hud' || group === 'glass' || group === 'assists') ? value === '1'
        : value;
    const container = el.closest('[data-group]');
    for (const o of container.querySelectorAll('.opt,.card')) o.classList.remove('on');
    el.classList.add('on');
    this._applyLive(group);
  }

  /** Settings that take effect immediately, without leaving the menu. */
  _applyLive(group) {
    const e = this.engine;
    const c = this.config;
    if (!e) return;
    switch (group) {
      case 'weather': e.weather?.setState?.(c.weather, { immediate: false }); break;
      case 'difficulty': this.session.setDifficulty(c.difficulty); break;
      case 'camera': e.rig?.setMode?.(c.camera); break;
      case 'hud': e.hud?.setVisible?.(c.hud && !this.visible); break;
      case 'glass': e.hud?.setGlass?.(c.glass); break;
      case 'assists': {
        const d = DIFFICULTIES[c.difficulty] ?? DIFFICULTIES.pro;
        e.player?.vehicle?.setAssists?.(c.assists
          ? { tractionControl: d.assists.tc, abs: d.assists.abs, stability: d.assists.stability }
          : { tractionControl: 0, abs: 0, stability: 0 });
        break;
      }
      case 'laps': this.session.totalLaps = c.laps; break;
      default: break;
    }
  }

  _act(action) {
    const s = this.session;
    switch (action) {
      case 'quick': this.config.format = 'quick'; this.show('setup'); break;
      case 'grandPrix': this.config.format = 'grandPrix'; this.show('setup'); break;
      case 'timeTrial': this.config.format = 'timeTrial'; this.show('setup'); break;
      case 'settings': this._settingsFrom = this.screen; this.show('settings'); break;
      case 'back': this.show(this._settingsFrom === 'pause' ? 'pause' : 'title'); break;
      case 'title': this.show('title'); break;
      case 'setup': this.show('setup'); break;
      case 'start': this._startSession(); break;
      case 'resume': this.hide(); break;
      case 'restart': this._startSession(); break;
      case 'next':
        this.hide();
        s.advanceWeekend();
        this._leaveAttract();
        this._flashIntro(s.def.label);
        break;
      default: break;
    }
  }

  _startSession() {
    const s = this.session;
    const c = this.config;
    const e = this.engine;
    s.totalLaps = c.laps;
    s.setDifficulty(c.difficulty);
    if (e) {
      e.weather?.setState?.(c.weather, { immediate: true });
      e.hud?.setVisible?.(c.hud);
      e.hud?.setGlass?.(c.glass);
      e.rig?.setMode?.(c.camera);
      // Hand the hero rig its own defaults back after attract mode borrowed it.
      if (e.rig) {
        e.rig.orbitSpeed = 0.22;
        e.rig.orbitAngleTrim = 0.42;
        e.rig.orbitRadius = 9.4;
        e.rig.orbitHeight = 0.66;
        e.rig.orbitDolly = 1;
        e.rig.orbitLead = 0.06;
        e.rig.orbitFov = 33;
      }
      this._attractT = null;
      e.audio?.setMasterVolume?.(c.volume);
      e.audio?.resume?.();
    }
    s.playerSlot = c.gridSlot > 0 ? c.gridSlot : null;
    s.beginWeekend(c.format, { laps: c.laps, playerSlot: s.playerSlot });
    this.hide();
    this._flashIntro(s.def.label);
  }

  /** A short broadcast-style session title card. */
  _flashIntro(text) {
    if (!this._root) return;
    const el = document.createElement('div');
    el.className = 'intro';
    el.innerHTML = `<div class="lab" style="letter-spacing:6px;margin-bottom:8px">APEX INTERNATIONAL</div>
                    <div class="big">${text}</div>`;
    el.style.transition = 'opacity .5s ease';
    this._root.classList.remove('hidden');
    this._root.appendChild(el);
    this._scrim.style.opacity = '0';
    setTimeout(() => { el.style.opacity = '0'; }, 1900);
    setTimeout(() => {
      el.remove();
      this._scrim.style.opacity = '';
      if (!this.visible) this._root.classList.add('hidden');
    }, 2500);
  }

  _key(e) {
    if (this.hidden) return;
    const items = this._screenEl?.querySelectorAll('.item') ?? [];
    if (e.code === 'Escape') {
      e.preventDefault();
      if (!this.visible) this.show('pause');
      else if (this.screen === 'pause') this.hide();
      else if (this.screen === 'settings') this._act('back');
      else if (this.screen === 'setup') this.show('title');
      return;
    }
    if (!this.visible) {
      // In-game shortcuts owned by the shell.
      if (e.code === 'KeyB') { this.session.requestPit(); }
      if (e.code === 'Space' && this.session.phase === 'formation') this.session.skipFormation();
      return;
    }
    if (!items.length) return;
    if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
      e.preventDefault();
      this.sel = (this.sel + (e.code === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      items.forEach((it, i) => it.classList.toggle('sel', i === this.sel));
    } else if (e.code === 'Enter' || e.code === 'NumpadEnter') {
      e.preventDefault();
      if (this.screen === 'setup') this._act('start');
      else items[this.sel]?.click();
    } else if (/^Digit[1-9]$/.test(e.code)) {
      const i = parseInt(e.code.slice(5), 10) - 1;
      items[i]?.click();
    }
  }

  // ── session hooks ───────────────────────────────────────────────────────

  onSessionUpdate() { /* reserved: live menu telemetry */ }

  onSessionEnd() {
    if (this.hidden) return;
    setTimeout(() => {
      if (this.session.phase !== 'classified') return;
      this.show('results');
      if (this.engine) { this.engine.frozen = false; }
      this.engine?.hud?.setVisible?.(false);
    }, 2600);
  }
}

export default RaceSession;
