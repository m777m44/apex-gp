/**
 * APEX GP — WebAudio sound engine. Everything is synthesised; there are no
 * sample files and no network fetches.
 *
 * WHAT IS MODELLED
 *   Engine      a 1.6 V6 turbo hybrid built from an analytic firing-order
 *               spectrum (six blasts per 720 deg cycle -> only the 6th, 12th,
 *               18th... harmonic of the cycle frequency survive, i.e. the 3rd
 *               engine order), morphed across three exhaust-blast widths so the
 *               rasp hardens with revs, then pushed through an asymmetric soft
 *               clipper whose drive tracks load.
 *   Turbo       compressor whistle + MGU-H electric whine, both tracking a
 *               spool state with asymmetric attack/release, resonant air rush,
 *               and wastegate chatter (amplitude-modulated burst) on a lift.
 *   Overrun     stochastic crackle/pops on a closed throttle, downshift blips.
 *   Limiter     an audio-rate ignition-cut gate: a narrow negative pulse train
 *               added to the engine gain, exactly like a real fuel cut.
 *   Gearbox     two straight-cut whines, one on the final drive (road speed)
 *               and one on the gear cluster (engine speed).
 *   Tyres       broadband scrub plus a high-Q stick-slip squeal driven by the
 *               real Pacejka slip angle, lock-up screech from `lockup[]`.
 *   Surfaces    kerb rib train at speed/ribPitch Hz, grass, gravel, impacts.
 *   Aero        two-band wind noise scaling with v^2, rain on the bodywork.
 *   Field       up to 8 voice slots stolen by the nearest opponents, each with
 *               distance attenuation, manual Doppler and grandstand occlusion.
 *   Space       a procedurally generated convolution reverb (open / stands /
 *               pit / tunnel) crossfaded between two convolvers.
 *   Master      compressor -> 4x-oversampled tanh soft clip -> gain, so the
 *               output is mathematically bounded by the master volume.
 *
 * Browsers block audio until a user gesture, so nothing is constructed until
 * `resume()` succeeds. Every method is safe to call before then — which is what
 * makes headless capture silent and error free.
 *
 * PUBLIC API
 *   new EngineAudio({ volume, enabled, context, voices })
 *   await audio.resume()                  call from a click/keydown
 *   audio.attachPlayer(vehicle)
 *   audio.attachWorld({ camera, rig, field, circuit, environment, weather })
 *   audio.update(dt)
 *   audio.setMasterVolume(0..1) / audio.setMix(name) / audio.setSpace(name, amt)
 *   audio.playShift(dir) / playLockup(x) / playKerb(x) / playGravel(x) / playImpact(x)
 *   audio.spectrum() / audio.levels() / audio.dispose()
 *   MIX_MODES, SPACES, makeImpulseResponse(ctx, opts)
 */

import { clamp, lerp, smoothstep, rngFor } from '../core/rng.js';

const SPEED_OF_SOUND = 343;

/** Even-fire 90 deg V6 on a split-pin crank: six blasts, 120 deg apart. */
const V6_FIRING_ANGLES = [0, 120, 240, 360, 480, 600];

/** Harmonics of the CYCLE frequency (rpm/120 Hz) kept in the firing wave. */
const FIRING_HARMONICS = 168;

/**
 * Per-mix layer trims. `tone` is the master air-absorption low-pass in Hz;
 * `opponents` scales the whole spatial bus. Crossfaded, never switched.
 */
export const MIX_MODES = {
  onboard: { engine: 1.00, intake: 1.15, turbo: 1.20, gearbox: 1.00, tyre: 0.80, surface: 1.10, wind: 2.10, rain: 1.50, opponents: 0.50, reverb: 0.30, tone: 15000, width: 0.35 },
  chase:   { engine: 0.92, intake: 0.85, turbo: 0.85, gearbox: 0.62, tyre: 1.00, surface: 0.85, wind: 0.75, rain: 0.70, opponents: 0.85, reverb: 0.55, tone: 12000, width: 0.75 },
  tv:      { engine: 0.62, intake: 0.45, turbo: 0.60, gearbox: 0.30, tyre: 0.85, surface: 0.45, wind: 0.12, rain: 0.35, opponents: 1.00, reverb: 0.95, tone: 6200, width: 1.00 },
  external:{ engine: 0.78, intake: 0.60, turbo: 0.75, gearbox: 0.40, tyre: 0.90, surface: 0.60, wind: 0.25, rain: 0.45, opponents: 0.95, reverb: 0.80, tone: 8800, width: 0.90 },
};

/** Camera mode -> mix. */
const MODE_TO_MIX = { cockpit: 'onboard', halo: 'onboard', chase: 'chase', tv: 'tv', hero: 'external', wide: 'external' };

/**
 * Reverb spaces. `early` are [delaySeconds, gain] taps; the late tail is
 * exponentially decaying noise through a one-pole whose cutoff collapses at
 * `damping`, which is what makes a concrete box sound different from open air.
 */
export const SPACES = {
  open:   { seconds: 1.05, decay: 5.4, predelay: 0.014, damping: 2.6, gain: 0.55, early: [[0.021, 0.16], [0.037, 0.10], [0.061, 0.07]] },
  stands: { seconds: 1.90, decay: 3.1, predelay: 0.010, damping: 1.7, gain: 0.85, early: [[0.012, 0.42], [0.019, 0.30], [0.028, 0.24], [0.041, 0.17], [0.058, 0.12]] },
  pit:    { seconds: 2.10, decay: 2.7, predelay: 0.006, damping: 3.1, gain: 1.00, early: [[0.005, 0.55], [0.009, 0.40], [0.015, 0.33], [0.022, 0.26], [0.031, 0.20], [0.044, 0.15]] },
  tunnel: { seconds: 2.80, decay: 1.9, predelay: 0.004, damping: 1.1, gain: 1.25, early: [[0.006, 0.62], [0.012, 0.55], [0.018, 0.48], [0.024, 0.42], [0.030, 0.36], [0.036, 0.31], [0.042, 0.26], [0.048, 0.22]] },
};

// ---------------------------------------------------------------------------
// Wave / buffer generators
// ---------------------------------------------------------------------------

/**
 * Analytic spectrum of an exhaust pulse train.
 *
 * The cylinder blasts are one-sided exponentials of decay length `width` (in
 * cycles) fired at `angles` degrees of a 720 deg cycle, so the coefficient of
 * harmonic n is `H(n) * SUM_k a_k exp(-i 2pi n phi_k)` with the blast transfer
 * `H(n) = 1 / (1 + i 2pi n width)`. Even firing kills every harmonic that is
 * not a multiple of six — the firing order really does fall out of the maths.
 * A little per-cylinder timing/amplitude scatter puts the missing orders back,
 * which is the difference between an engine and a buzzer.
 */
function firingWave(ctx, { angles = V6_FIRING_ANGLES, width = 0.010, harmonics = FIRING_HARMONICS, scatter = 1.1, spread = 0.07, seed = 'audio/firing' } = {}) {
  const rng = rngFor(seed);
  const N = harmonics + 1;
  const real = new Float32Array(N);
  const imag = new Float32Array(N);
  const phi = angles.map((a) => (a + rng.gauss() * scatter) / 720);
  const amp = angles.map(() => 1 + rng.gauss() * spread);
  const inv = 2 / angles.length;

  for (let n = 1; n < N; n++) {
    const wi = 2 * Math.PI * n * width;
    const d2 = 1 + wi * wi;
    const hr = 1 / d2;
    const hi = -wi / d2;
    let sr = 0;
    let si = 0;
    for (let k = 0; k < phi.length; k++) {
      const th = -2 * Math.PI * n * phi[k];
      sr += amp[k] * Math.cos(th);
      si += amp[k] * Math.sin(th);
    }
    real[n] = inv * (hr * sr - hi * si);
    imag[n] = -inv * (hr * si + hi * sr);
  }
  return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
}

/** Zero-mean pulse train of duty `d`, used for the rev limiter cut and kerb ribs. */
function pulseWave(ctx, d = 0.35, harmonics = 48, polarity = -1) {
  const N = harmonics + 1;
  const real = new Float32Array(N);
  const imag = new Float32Array(N);
  for (let n = 1; n < N; n++) {
    const p = 2 * Math.PI * n;
    const ph = p * d;
    real[n] = polarity * 2 * (Math.sin(ph) / p);
    imag[n] = -polarity * 2 * (-(1 - Math.cos(ph)) / p);
  }
  return ctx.createPeriodicWave(real, imag, { disableNormalization: false });
}

/**
 * Asymmetric soft clip. The two half-slopes differ, so the shaper produces even
 * harmonics as well as odd — the "loaded" thickening you hear on full throttle.
 */
function driveCurve(n = 2048, negSlope = 1.42) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = x >= 0 ? 1 - Math.exp(-x) : -(1 - Math.exp(x * negSlope));
  }
  const dc = c[(n >> 1)];
  for (let i = 0; i < n; i++) c[i] -= dc;
  return c;
}

/**
 * tanh brickwall. The ceiling is 0.90, not 1.0: a 4x-oversampled WaveShaper's
 * resampling filters ring, and a curve that touched 1.0 measured +0.05 dBFS on
 * a worst-case transient. With this ceiling the output is provably bounded.
 */
const CLIP_CEILING = 0.90;
function softClipCurve(n = 8192, k = 1.6) {
  const c = new Float32Array(n);
  const norm = Math.tanh(k) / CLIP_CEILING;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / norm;
  }
  return c;
}

/** Two seconds of seeded white noise, shared by every noise layer. */
function makeNoiseBuffer(ctx, seed = 'audio/noise') {
  const len = Math.floor(ctx.sampleRate * 2);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  const rng = rngFor(seed);
  for (let i = 0; i < len; i++) d[i] = rng() * 2 - 1;
  return buf;
}

/**
 * Procedural impulse response: sparse early reflections plus a decaying noise
 * tail that darkens over time. Energy-normalised so swapping spaces does not
 * change the send level.
 */
export function makeImpulseResponse(ctx, opts = {}) {
  const { seconds = 1.8, decay = 3.0, predelay = 0.01, damping = 2.0, early = [], seed = 'audio/ir' } = opts;
  const rate = ctx.sampleRate;
  const len = Math.max(64, Math.floor(seconds * rate));
  const buf = ctx.createBuffer(2, len, rate);
  const rng = rngFor(seed);

  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    const pre = Math.floor(predelay * rate) + ch * 11;
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / rate;
      const u = t / seconds;
      // Cutoff collapses with time: bright slap, dark tail.
      const fc = 320 + 11000 * Math.exp(-damping * t);
      const a = 1 - Math.exp((-2 * Math.PI * fc) / rate);
      lp += a * ((rng() * 2 - 1) - lp);
      d[i] = lp * Math.exp(-decay * t) * (1 - u) * (1 - u);
    }
    for (const [dl, g] of early) {
      const i = Math.floor((dl + ch * 0.0013) * rate) + pre;
      if (i < len - 4) {
        // Smear each tap over a few samples so it reads as a wall, not a tick.
        for (let k = 0; k < 5; k++) d[i + k] += g * (1 - k / 5) * (rng() * 2 - 1);
      }
    }
  }

  // Energy-normalise (RMS over the whole IR) so `gain` is the only level knob.
  let e = 0;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) e += d[i] * d[i];
  }
  // sqrt(sum h^2) IS the convolution gain for a broadband input, so fixing it
  // makes every space the same loudness and `SPACES[].gain` the only knob.
  const norm = 0.5 / Math.sqrt(Math.max(1e-12, e));
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] *= norm;
  }
  return buf;
}

// ---------------------------------------------------------------------------
// Geometry helpers (kept dependency-free so the module is testable in isolation)
// ---------------------------------------------------------------------------

/** Slab test: does the segment p->q pierce the axis-aligned box? */
function segmentHitsBox(px, py, pz, qx, qy, qz, b) {
  let t0 = 0;
  let t1 = 1;
  const dx = qx - px;
  const dy = qy - py;
  const dz = qz - pz;
  for (let axis = 0; axis < 3; axis++) {
    const p = axis === 0 ? px : axis === 1 ? py : pz;
    const d = axis === 0 ? dx : axis === 1 ? dy : dz;
    const lo = axis === 0 ? b.x0 : axis === 1 ? b.y0 : b.z0;
    const hi = axis === 0 ? b.x1 : axis === 1 ? b.y1 : b.z1;
    if (Math.abs(d) < 1e-6) {
      if (p < lo || p > hi) return false;
      continue;
    }
    let ta = (lo - p) / d;
    let tb = (hi - p) / d;
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return false;
  }
  return true;
}

/** World-space AABB of a Mesh, without importing three. */
function worldBox(mesh) {
  const g = mesh.geometry;
  if (!g) return null;
  if (!g.boundingBox) g.computeBoundingBox();
  const bb = g.boundingBox;
  if (!bb) return null;
  mesh.updateWorldMatrix?.(true, false);
  const e = mesh.matrixWorld.elements;
  const b = { x0: Infinity, y0: Infinity, z0: Infinity, x1: -Infinity, y1: -Infinity, z1: -Infinity };
  for (let i = 0; i < 8; i++) {
    const x = (i & 1) ? bb.max.x : bb.min.x;
    const y = (i & 2) ? bb.max.y : bb.min.y;
    const z = (i & 4) ? bb.max.z : bb.min.z;
    const wx = e[0] * x + e[4] * y + e[8] * z + e[12];
    const wy = e[1] * x + e[5] * y + e[9] * z + e[13];
    const wz = e[2] * x + e[6] * y + e[10] * z + e[14];
    if (wx < b.x0) b.x0 = wx; if (wx > b.x1) b.x1 = wx;
    if (wy < b.y0) b.y0 = wy; if (wy > b.y1) b.y1 = wy;
    if (wz < b.z0) b.z0 = wz; if (wz > b.z1) b.z1 = wz;
  }
  return b;
}

// ---------------------------------------------------------------------------
// Opponent voice
// ---------------------------------------------------------------------------

/**
 * One spatialised opponent car. Deliberately cheaper than the player voice:
 * a single firing oscillator, one exhaust noise band, a turbo whistle and a
 * tyre band, behind a shared occlusion/air-absorption low-pass and a panner.
 * Slots are stolen by the nearest cars each frame.
 */
class CarVoice {
  constructor(audio, index) {
    const ctx = audio.ctx;
    this.audio = audio;
    this.index = index;
    this.car = null;
    this.muteUntil = 0;
    this._px = 0; this._py = 0; this._pz = 0;
    this._hasPrev = false;

    this.osc = ctx.createOscillator();
    this.osc.setPeriodicWave(audio.waves.mid);
    this.osc.frequency.value = 100;
    this.oscGain = ctx.createGain();
    this.oscGain.gain.value = 0;

    this.turboOsc = ctx.createOscillator();
    this.turboOsc.type = 'sine';
    this.turboOsc.frequency.value = 2000;
    this.turboGain = ctx.createGain();
    this.turboGain.gain.value = 0;

    this.exhaust = audio._noiseSource(index * 0.31 + 0.07);
    this.exhaustBP = ctx.createBiquadFilter();
    this.exhaustBP.type = 'bandpass';
    this.exhaustBP.frequency.value = 420;
    this.exhaustBP.Q.value = 0.9;
    this.exhaustGain = ctx.createGain();
    this.exhaustGain.gain.value = 0;

    this.tyre = audio._noiseSource(index * 0.53 + 0.41);
    this.tyreBP = ctx.createBiquadFilter();
    this.tyreBP.type = 'bandpass';
    this.tyreBP.frequency.value = 1400;
    this.tyreBP.Q.value = 3.0;
    this.tyreGain = ctx.createGain();
    this.tyreGain.gain.value = 0;

    // Occlusion + air absorption share one filter; distance darkens it too.
    this.lp = ctx.createBiquadFilter();
    this.lp.type = 'lowpass';
    this.lp.frequency.value = 18000;
    this.lp.Q.value = 0.4;

    this.gain = ctx.createGain();
    this.gain.gain.value = 0;

    this.panner = ctx.createPanner();
    this.panner.panningModel = 'equalpower';
    this.panner.distanceModel = 'inverse';
    this.panner.refDistance = 9;
    this.panner.maxDistance = 600;
    this.panner.rolloffFactor = 1.15;
    this.panner.coneInnerAngle = 360;

    this.send = ctx.createGain();
    this.send.gain.value = 0.25;

    this.osc.connect(this.oscGain).connect(this.lp);
    this.turboOsc.connect(this.turboGain).connect(this.lp);
    this.exhaust.connect(this.exhaustBP).connect(this.exhaustGain).connect(this.lp);
    this.tyre.connect(this.tyreBP).connect(this.tyreGain).connect(this.lp);
    this.lp.connect(this.gain).connect(this.panner).connect(audio.busOpponents);
    this.gain.connect(this.send).connect(audio.reverbSend);

    this.osc.start();
    this.turboOsc.start();
  }

  setPosition(t, x, y, z) {
    const p = this.panner;
    if (p.positionX) {
      p.positionX.setTargetAtTime(x, t, 0.015);
      p.positionY.setTargetAtTime(y, t, 0.015);
      p.positionZ.setTargetAtTime(z, t, 0.015);
    } else {
      p.setPosition(x, y, z);
    }
  }

  silence(t) {
    this.gain.gain.setTargetAtTime(0, t, 0.02);
  }

  dispose() {
    try { this.osc.stop(); this.turboOsc.stop(); this.exhaust.stop(); this.tyre.stop(); } catch { /* already stopped */ }
  }
}

// ---------------------------------------------------------------------------
// EngineAudio
// ---------------------------------------------------------------------------

export class EngineAudio {
  constructor(o = {}) {
    this.ctx = o.context ?? null;
    this._externalCtx = !!o.context;
    this._offline = !!(o.context && typeof o.context.startRendering === 'function');
    this.ready = false;
    this.enabled = o.enabled ?? true;
    this.masterVolume = o.volume ?? 0.75;
    this.voiceCount = o.voices ?? 10;

    this.vehicle = null;
    this.world = null;

    /**
     * Analysis hook. An OfflineAudioContext renders with a frozen clock, so the
     * spectrum harness sets this to the wall time it is simulating; when it is
     * null the real `ctx.currentTime` is used.
     */
    this.clockOverride = null;

    this.mix = 'chase';
    this.space = 'open';
    this._mixTrim = { ...MIX_MODES.chase };

    this._rng = rngFor('audio/runtime');
    this._boost = 0;
    this._lastGear = 1;
    this._popTimer = 0;
    this._grainTimer = 0;
    this._rainTimer = 0;
    this._onKerb = false;
    this._offTrack = 0;
    this._t = 0;
    this._ersBlend = 0;
    this._lastDrs = false;
    this._lx = 0; this._ly = 0; this._lz = 0;
    this._lvx = 0; this._lvy = 0; this._lvz = 0;
    this._hasListener = false;
    this._occBoxes = [];
    this._order = [];
  }

  // -- lifecycle -----------------------------------------------------------

  /** Must be called from a user gesture (no-op and harmless before then). */
  async resume() {
    if (!this.enabled) return false;
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        this.ctx = new AC({ latencyHint: 'interactive' });
      }
      if (!this._built) this._build();
      if (this._offline) { this.ready = true; return true; }
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      this.ready = this.ctx.state === 'running';
      return this.ready;
    } catch {
      this.enabled = false;
      return false;
    }
  }

  _build() {
    this._built = true;
    const ctx = this.ctx;

    this.noiseBuffer = makeNoiseBuffer(ctx);
    this.waves = {
      // Wide blast = soft and woolly; narrow blast = hard and raspy.
      low: firingWave(ctx, { width: 0.0180, scatter: 1.9, spread: 0.10, seed: 'audio/firing/low' }),
      mid: firingWave(ctx, { width: 0.0085, scatter: 1.2, spread: 0.07, seed: 'audio/firing/mid' }),
      high: firingWave(ctx, { width: 0.0038, scatter: 0.7, spread: 0.05, seed: 'audio/firing/high' }),
      cut: pulseWave(ctx, 0.30, 40, -1),
      rib: pulseWave(ctx, 0.42, 26, 1),
    };

    this._buildMaster();
    this._buildEngine();
    this._buildTurbo();
    this._buildGearbox();
    this._buildTyres();
    this._buildSurfaces();
    this._buildAero();
    this._buildSpace();

    this.voices = [];
    for (let i = 0; i < this.voiceCount; i++) this.voices.push(new CarVoice(this, i));

    this.setMix(this.mix, true);
  }

  /** Shared looping noise source, phase-offset so layers do not correlate. */
  _noiseSource(offset = 0) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    src.start(0, (offset % 1) * 1.9);
    return src;
  }

  _buildMaster() {
    const ctx = this.ctx;

    this.master = ctx.createGain();
    this.master.gain.value = this.masterVolume;
    this.master.connect(ctx.destination);

    // Brickwall: tanh, 4x oversampled so the clip does not alias.
    this.softClip = ctx.createWaveShaper();
    this.softClip.curve = softClipCurve();
    this.softClip.oversample = '4x';
    this.softClip.connect(this.master);

    this.comp = ctx.createDynamicsCompressor();
    this.comp.threshold.value = -5;
    this.comp.knee.value = 8;
    this.comp.ratio.value = 5;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.22;
    this.comp.connect(this.softClip);

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.6;
    this.analyser.connect(this.comp);

    // Air absorption / mix tone control sits in front of the analyser so the
    // measured spectrum is the spectrum the listener actually gets.
    this.airLP = ctx.createBiquadFilter();
    this.airLP.type = 'lowpass';
    this.airLP.frequency.value = 12000;
    this.airLP.Q.value = 0.5;
    this.airLP.connect(this.analyser);

    this.mixBus = ctx.createGain();
    this.mixBus.gain.value = 1;
    this.mixBus.connect(this.airLP);

    /** Layer buses — the mix profile trims these and nothing else. */
    this.reverbSend = ctx.createGain();
    this.reverbSend.gain.value = 1;

    /**
     * Layer buses. The mix profile trims these and nothing else, and the reverb
     * send is tapped POST-trim (`send > 0`) so a layer that the mix pulls down
     * cannot sneak back in through the wet return. Wind and rain send nothing:
     * they are already diffuse and reverberating them only smears the mix.
     */
    const bus = (g, send) => {
      const n = ctx.createGain();
      n.gain.value = g;
      n.connect(this.mixBus);
      if (send > 0) {
        const s = ctx.createGain();
        s.gain.value = send;
        n.connect(s).connect(this.reverbSend);
      }
      return n;
    };
    this.busEngine = bus(1, 0.9);
    this.busIntake = bus(1, 0.5);
    this.busTurbo = bus(1, 0.7);
    this.busGearbox = bus(1, 0.4);
    this.busTyre = bus(1, 0.6);
    this.busSurface = bus(1, 0.5);
    this.busWind = bus(1, 0);
    this.busRain = bus(1, 0);
    this.busOpponents = bus(1, 0);   // voices carry their own distance-scaled send
    this.busTransient = bus(1, 1.0);
  }

  // -- engine core ---------------------------------------------------------

  _buildEngine() {
    const ctx = this.ctx;

    const mkOsc = (wave) => {
      const o = ctx.createOscillator();
      o.setPeriodicWave(wave);
      o.frequency.value = 60;
      const g = ctx.createGain();
      g.gain.value = 0;
      o.connect(g);
      o.start();
      return { osc: o, gain: g };
    };
    this.oscLow = mkOsc(this.waves.low);
    this.oscMid = mkOsc(this.waves.mid);
    this.oscHigh = mkOsc(this.waves.high);

    // Combustion jitter. A perfectly periodic oscillator sounds synthetic; real
    // cycle-to-cycle variation is a few tenths of a percent of crank speed, so
    // slow filtered noise is added straight onto the frequency of all three.
    this.jitterSrc = this._noiseSource(0.13);
    this.jitterLP = ctx.createBiquadFilter();
    this.jitterLP.type = 'lowpass';
    this.jitterLP.frequency.value = 22;
    this.jitterLP.Q.value = 0.7;
    this.jitter = ctx.createGain();
    this.jitter.gain.value = 0;
    this.jitterSrc.connect(this.jitterLP).connect(this.jitter);
    this.jitter.connect(this.oscLow.osc.frequency);
    this.jitter.connect(this.oscMid.osc.frequency);
    this.jitter.connect(this.oscHigh.osc.frequency);

    // 1.5th order: crank/manifold burble half an octave under the firing note.
    this.halfOrder = ctx.createOscillator();
    this.halfOrder.type = 'triangle';
    this.halfOrder.frequency.value = 60;
    this.halfGain = ctx.createGain();
    this.halfGain.gain.value = 0;
    this.halfOrder.connect(this.halfGain);
    this.halfOrder.start();

    // Rev limiter: an audio-rate ignition cut added straight onto the gate.
    this.limiterOsc = ctx.createOscillator();
    this.limiterOsc.setPeriodicWave(this.waves.cut);
    this.limiterOsc.frequency.value = 58;
    this.limiterDepth = ctx.createGain();
    this.limiterDepth.gain.value = 0;
    this.limiterOsc.connect(this.limiterDepth);
    this.limiterOsc.start();

    this.gate = ctx.createGain();
    this.gate.gain.value = 1;
    this.limiterDepth.connect(this.gate.gain);

    this.drive = ctx.createGain();
    this.drive.gain.value = 1;

    this.shaper = ctx.createWaveShaper();
    this.shaper.curve = driveCurve();
    this.shaper.oversample = '2x';

    this.dcBlock = ctx.createBiquadFilter();
    this.dcBlock.type = 'highpass';
    this.dcBlock.frequency.value = 46;
    this.dcBlock.Q.value = 0.7;

    // Body resonance (block/exhaust primary) and airbox formant.
    this.resBody = ctx.createBiquadFilter();
    this.resBody.type = 'peaking';
    this.resBody.frequency.value = 340;
    this.resBody.Q.value = 1.5;
    this.resBody.gain.value = 4;

    this.resAirbox = ctx.createBiquadFilter();
    this.resAirbox.type = 'peaking';
    this.resAirbox.frequency.value = 1500;
    this.resAirbox.Q.value = 2.2;
    this.resAirbox.gain.value = 4;

    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 6000;
    this.tone.Q.value = 0.8;

    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;

    this.oscLow.gain.connect(this.gate);
    this.oscMid.gain.connect(this.gate);
    this.oscHigh.gain.connect(this.gate);
    this.halfGain.connect(this.gate);
    this.gate.connect(this.drive).connect(this.shaper).connect(this.dcBlock)
      .connect(this.resBody).connect(this.resAirbox).connect(this.tone)
      .connect(this.engineGain).connect(this.busEngine);

    // Exhaust gas noise: the breath under the tone.
    this.exhaustNoise = this._noiseSource(0.11);
    this.exhaustBP = ctx.createBiquadFilter();
    this.exhaustBP.type = 'bandpass';
    this.exhaustBP.frequency.value = 380;
    this.exhaustBP.Q.value = 0.8;
    this.exhaustGain = ctx.createGain();
    this.exhaustGain.gain.value = 0;
    this.exhaustNoise.connect(this.exhaustBP).connect(this.exhaustGain).connect(this.busEngine);

    /**
     * Exhaust pipe comb. A short feedback delay is literally what a pipe is: it
     * puts resonant peaks every 1/delay Hz, so the note swells when the firing
     * order lands on one. Without it the tone is clean in a way no exhaust is.
     */
    this.pipe = ctx.createDelay(0.05);
    this.pipe.delayTime.value = 0.0035;          // peaks every ~285 Hz
    this.pipeFB = ctx.createGain();
    this.pipeFB.gain.value = 0.42;
    this.pipeDamp = ctx.createBiquadFilter();
    this.pipeDamp.type = 'lowpass';
    this.pipeDamp.frequency.value = 4200;
    this.pipeMix = ctx.createGain();
    this.pipeMix.gain.value = 0.45;
    this.tone.connect(this.pipe);
    this.pipe.connect(this.pipeDamp).connect(this.pipeFB).connect(this.pipe);
    this.pipe.connect(this.pipeMix).connect(this.engineGain);

    /**
     * Valvetrain / injector clatter, amplitude-modulated at the CAMSHAFT rate
     * (half crank speed = the cycle frequency). This mechanical bed is most of
     * what separates a real onboard from a synth pad.
     */
    this.clatter = this._noiseSource(0.79);
    this.clatterBP = ctx.createBiquadFilter();
    this.clatterBP.type = 'bandpass';
    this.clatterBP.frequency.value = 4200;
    this.clatterBP.Q.value = 1.4;
    this.clatterAM = ctx.createGain();
    this.clatterAM.gain.value = 0.45;
    this.camOsc = ctx.createOscillator();
    this.camOsc.setPeriodicWave(this.waves.rib);
    this.camOsc.frequency.value = 60;
    this.camDepth = ctx.createGain();
    this.camDepth.gain.value = 0.55;
    this.camOsc.connect(this.camDepth).connect(this.clatterAM.gain);
    this.camOsc.start();
    this.clatterGain = ctx.createGain();
    this.clatterGain.gain.value = 0;
    this.clatter.connect(this.clatterBP).connect(this.clatterAM).connect(this.clatterGain).connect(this.busEngine);

    // Intake / airbox roar — a separate band so the onboard mix can lift it.
    this.intakeNoise = this._noiseSource(0.63);
    this.intakeBP = ctx.createBiquadFilter();
    this.intakeBP.type = 'bandpass';
    this.intakeBP.frequency.value = 1600;
    this.intakeBP.Q.value = 1.1;
    this.intakeGain = ctx.createGain();
    this.intakeGain.gain.value = 0;
    this.intakeNoise.connect(this.intakeBP).connect(this.intakeGain).connect(this.busIntake);
  }

  _buildTurbo() {
    const ctx = this.ctx;

    this.turbo1 = ctx.createOscillator();
    this.turbo1.type = 'sine';
    this.turbo1.frequency.value = 1200;
    this.turbo2 = ctx.createOscillator();
    this.turbo2.type = 'sine';
    this.turbo2.frequency.value = 2420;
    this.turboGain = ctx.createGain();
    this.turboGain.gain.value = 0;
    this.turbo2Gain = ctx.createGain();
    this.turbo2Gain.gain.value = 0;
    this.turbo1.connect(this.turboGain).connect(this.busTurbo);
    this.turbo2.connect(this.turbo2Gain).connect(this.busTurbo);
    this.turbo1.start();
    this.turbo2.start();

    // MGU-H: a thin electric whine well above the compressor note.
    this.mguh = ctx.createOscillator();
    this.mguh.type = 'sine';
    this.mguh.frequency.value = 6000;
    this.mguhGain = ctx.createGain();
    this.mguhGain.gain.value = 0;
    this.mguh.connect(this.mguhGain).connect(this.busTurbo);
    this.mguh.start();

    // MGU-K: the deploy whine tracks crank speed, not shaft speed, and only
    // exists while the battery is actually pushing.
    this.mguk = ctx.createOscillator();
    this.mguk.type = 'sawtooth';
    this.mguk.frequency.value = 2000;
    this.mgukBP = ctx.createBiquadFilter();
    this.mgukBP.type = 'bandpass';
    this.mgukBP.frequency.value = 2000;
    this.mgukBP.Q.value = 6;
    this.mgukGain = ctx.createGain();
    this.mgukGain.gain.value = 0;
    this.mguk.connect(this.mgukBP).connect(this.mgukGain).connect(this.busTurbo);
    this.mguk.start();

    // Air rush: resonant noise riding the same blade-pass frequency.
    this.rush = this._noiseSource(0.29);
    this.rushBP = ctx.createBiquadFilter();
    this.rushBP.type = 'bandpass';
    this.rushBP.frequency.value = 3200;
    this.rushBP.Q.value = 8;
    this.rushGain = ctx.createGain();
    this.rushGain.gain.value = 0;
    this.rush.connect(this.rushBP).connect(this.rushGain).connect(this.busTurbo);
  }

  _buildGearbox() {
    const ctx = this.ctx;
    const mk = (freq) => {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.value = 0;
      o.connect(g).connect(this.busGearbox);
      o.start();
      return { osc: o, gain: g };
    };
    this.gearFinal = mk(1200);    // final drive, tracks road speed
    this.gearCluster = mk(3000);  // gear cluster, tracks engine speed
  }

  _buildTyres() {
    const ctx = this.ctx;

    this.scrub = this._noiseSource(0.37);
    this.scrubBP = ctx.createBiquadFilter();
    this.scrubBP.type = 'bandpass';
    this.scrubBP.frequency.value = 1300;
    this.scrubBP.Q.value = 1.1;
    this.scrubGain = ctx.createGain();
    this.scrubGain.gain.value = 0;
    this.scrub.connect(this.scrubBP).connect(this.scrubGain).connect(this.busTyre);

    // Squeal is a self-excited stick-slip resonance: high-Q band + slow AM.
    this.squeal = this._noiseSource(0.71);
    this.squealBP = ctx.createBiquadFilter();
    this.squealBP.type = 'bandpass';
    this.squealBP.frequency.value = 1000;
    this.squealBP.Q.value = 16;
    this.squealGain = ctx.createGain();
    this.squealGain.gain.value = 0;
    this.squealAM = ctx.createGain();
    this.squealAM.gain.value = 1;
    this.stickSlip = ctx.createOscillator();
    this.stickSlip.type = 'sawtooth';
    this.stickSlip.frequency.value = 38;
    this.stickSlipDepth = ctx.createGain();
    this.stickSlipDepth.gain.value = 0.5;
    this.stickSlip.connect(this.stickSlipDepth).connect(this.squealAM.gain);
    this.stickSlip.start();
    this.squeal.connect(this.squealBP).connect(this.squealAM).connect(this.squealGain).connect(this.busTyre);

    this.lockNoise = this._noiseSource(0.17);
    this.lockBP = ctx.createBiquadFilter();
    this.lockBP.type = 'bandpass';
    this.lockBP.frequency.value = 1650;
    this.lockBP.Q.value = 1.6;
    this.lockGain = ctx.createGain();
    this.lockGain.gain.value = 0;
    this.lockNoise.connect(this.lockBP).connect(this.lockGain).connect(this.busTyre);

    // Carbon brake shriek.
    this.brakeNoise = this._noiseSource(0.83);
    this.brakeBP = ctx.createBiquadFilter();
    this.brakeBP.type = 'bandpass';
    this.brakeBP.frequency.value = 2700;
    this.brakeBP.Q.value = 22;
    this.brakeGain = ctx.createGain();
    this.brakeGain.gain.value = 0;
    this.brakeNoise.connect(this.brakeBP).connect(this.brakeGain).connect(this.busTyre);
  }

  _buildSurfaces() {
    const ctx = this.ctx;

    // Kerb ribs: a pulse train at speed / ribPitch, gated into a low thump plus
    // a bright slap band, so the rumble speeds up exactly with the car.
    this.ribOsc = ctx.createOscillator();
    this.ribOsc.setPeriodicWave(this.waves.rib);
    this.ribOsc.frequency.value = 40;
    this.ribDepth = ctx.createGain();
    this.ribDepth.gain.value = 0.9;
    this.ribOsc.connect(this.ribDepth);
    this.ribOsc.start();

    this.kerbNoise = this._noiseSource(0.47);
    this.kerbLP = ctx.createBiquadFilter();
    this.kerbLP.type = 'lowpass';
    this.kerbLP.frequency.value = 900;
    this.kerbLP.Q.value = 0.9;
    this.kerbAM = ctx.createGain();
    this.kerbAM.gain.value = 0.4;
    this.ribDepth.connect(this.kerbAM.gain);
    this.kerbGain = ctx.createGain();
    this.kerbGain.gain.value = 0;
    this.kerbNoise.connect(this.kerbLP).connect(this.kerbAM).connect(this.kerbGain).connect(this.busSurface);

    // Off-track: grass hiss / gravel roar share one band whose tone moves.
    this.roughNoise = this._noiseSource(0.91);
    this.roughBP = ctx.createBiquadFilter();
    this.roughBP.type = 'bandpass';
    this.roughBP.frequency.value = 1100;
    this.roughBP.Q.value = 0.6;
    this.roughGain = ctx.createGain();
    this.roughGain.gain.value = 0;
    this.roughNoise.connect(this.roughBP).connect(this.roughGain).connect(this.busSurface);
  }

  _buildAero() {
    const ctx = this.ctx;

    this.windLow = this._noiseSource(0.05);
    this.windLowBP = ctx.createBiquadFilter();
    this.windLowBP.type = 'bandpass';
    this.windLowBP.frequency.value = 240;
    this.windLowBP.Q.value = 0.5;
    this.windLowGain = ctx.createGain();
    this.windLowGain.gain.value = 0;
    this.windLow.connect(this.windLowBP).connect(this.windLowGain).connect(this.busWind);

    this.windHi = this._noiseSource(0.59);
    this.windHiBP = ctx.createBiquadFilter();
    this.windHiBP.type = 'bandpass';
    this.windHiBP.frequency.value = 2200;
    this.windHiBP.Q.value = 0.45;
    this.windHiGain = ctx.createGain();
    this.windHiGain.gain.value = 0;
    this.windHi.connect(this.windHiBP).connect(this.windHiGain).connect(this.busWind);

    this.rainNoise = this._noiseSource(0.23);
    this.rainBP = ctx.createBiquadFilter();
    this.rainBP.type = 'bandpass';
    this.rainBP.frequency.value = 3400;
    this.rainBP.Q.value = 0.7;
    this.rainGain = ctx.createGain();
    this.rainGain.gain.value = 0;
    this.rainNoise.connect(this.rainBP).connect(this.rainGain).connect(this.busRain);
  }

  _buildSpace() {
    const ctx = this.ctx;
    this.convA = ctx.createConvolver();
    this.convB = ctx.createConvolver();
    this.convA.normalize = false;
    this.convB.normalize = false;
    this.convA.buffer = makeImpulseResponse(ctx, { ...SPACES.open, seed: 'audio/ir/open' });
    this.convB.buffer = makeImpulseResponse(ctx, { ...SPACES.stands, seed: 'audio/ir/stands' });
    this._irCache = { open: this.convA.buffer, stands: this.convB.buffer };
    this._convSlot = 'A';
    this._spaceOf = { A: 'open', B: 'stands' };

    this.wetA = ctx.createGain();
    this.wetB = ctx.createGain();
    this.wetA.gain.value = 1;
    this.wetB.gain.value = 0;

    this.reverbReturn = ctx.createGain();
    this.reverbReturn.gain.value = 0.55;

    this.reverbSend.connect(this.convA).connect(this.wetA).connect(this.reverbReturn);
    this.reverbSend.connect(this.convB).connect(this.wetB).connect(this.reverbReturn);
    this.reverbReturn.connect(this.airLP);
  }

  // -- wiring --------------------------------------------------------------

  attachPlayer(vehicle) { this.vehicle = vehicle; return this; }

  /**
   * Optional world references. With them the module gets spatialised opponents,
   * grandstand occlusion, kerb detection, reverb space selection and automatic
   * cockpit/TV mixing; without them the player voice still works standalone.
   */
  attachWorld(world) {
    this.world = world;
    this._occBoxes = [];
    const stands = world?.environment?.grandstands ?? [];
    for (const s of stands) {
      const b = worldBox(s);
      if (b) this._occBoxes.push(b);
    }
    return this;
  }

  setMasterVolume(v) {
    this.masterVolume = clamp(v, 0, 1);
    if (this.master) this.master.gain.value = this.masterVolume;
    return this;
  }

  /** Crossfade the layer trims to a named mix (`onboard`/`chase`/`tv`/`external`). */
  setMix(name, immediate = false) {
    if (!MIX_MODES[name]) return this;
    this.mix = name;
    if (!this.ready && !this._built) return this;
    const t = this._now();
    const tau = immediate ? 0.001 : 0.10;
    const m = MIX_MODES[name];
    const set = (bus, v) => bus?.gain.setTargetAtTime(v, t, tau);
    set(this.busEngine, m.engine);
    set(this.busIntake, m.intake);
    set(this.busTurbo, m.turbo);
    set(this.busGearbox, m.gearbox);
    set(this.busTyre, m.tyre);
    set(this.busSurface, m.surface);
    set(this.busWind, m.wind);
    set(this.busRain, m.rain);
    set(this.busOpponents, m.opponents);
    this.reverbReturn?.gain.setTargetAtTime(m.reverb, t, tau);
    this.airLP?.frequency.setTargetAtTime(m.tone, t, tau);
    this._mixTrim = m;
    return this;
  }

  /**
   * Select a reverb space. Impulse responses are baked lazily and crossfaded
   * between two convolvers, so a tunnel or pit-lane change is seamless.
   */
  setSpace(name, amount = 1) {
    if (!SPACES[name] || !this._built) return this;
    const t = this._now();
    if (name !== this.space) {
      const target = this._convSlot === 'A' ? 'B' : 'A';
      const conv = target === 'A' ? this.convA : this.convB;
      if (this._spaceOf[target] !== name) {
        if (!this._irCache[name]) {
          this._irCache[name] = makeImpulseResponse(this.ctx, { ...SPACES[name], seed: `audio/ir/${name}` });
        }
        conv.buffer = this._irCache[name];
        this._spaceOf[target] = name;
      }
      this._convSlot = target;
      this.space = name;
    }
    const g = SPACES[name].gain * clamp(amount, 0, 1.5);
    this.wetA.gain.setTargetAtTime(this._convSlot === 'A' ? g : 0, t, 0.25);
    this.wetB.gain.setTargetAtTime(this._convSlot === 'B' ? g : 0, t, 0.25);
    return this;
  }

  _now() { return this.clockOverride ?? this.ctx.currentTime; }

  // -- transients ----------------------------------------------------------

  /** Short filtered-noise burst. `at` lets a caller schedule it in the future. */
  _burst({ freq = 260, Q = 2, gain = 0.5, decay = 0.12, type = 'bandpass', at = 0, attack = 0.002, am = 0 }) {
    if (!this._built) return;
    const ctx = this.ctx;
    const t = this._now() + at;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;
    src.playbackRate.value = 0.8 + this._rng() * 0.5;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = Q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    src.connect(f).connect(g);

    if (am > 0) {
      // Wastegate chatter: gate the burst with a fast square so it flutters.
      const lfo = ctx.createOscillator();
      lfo.type = 'square';
      lfo.frequency.value = am;
      const depth = ctx.createGain();
      depth.gain.value = 0.7;
      const vca = ctx.createGain();
      vca.gain.value = 0.5;
      lfo.connect(depth).connect(vca.gain);
      lfo.start(t);
      lfo.stop(t + decay + 0.02);
      g.connect(vca).connect(this.busTransient);
    } else {
      g.connect(this.busTransient);
    }

    src.start(t, this._rng() * 1.8);
    src.stop(t + decay + 0.03);
  }

  /** Short pitched transient (gear dog engagement, suspension thud). */
  _thump({ freq = 90, gain = 0.35, decay = 0.10, at = 0, type = 'sine' }) {
    if (!this._built) return;
    const ctx = this.ctx;
    const t = this._now() + at;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq * 1.9, t);
    o.frequency.exponentialRampToValueAtTime(freq, t + decay * 0.7);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    o.connect(g).connect(this.busTransient);
    o.start(t);
    o.stop(t + decay + 0.02);
  }

  /** Upshift = dog-ring clack + air release. Downshift = blip + overrun pop. */
  playShift(dir = 1, rpmNorm = 0.8) {
    if (!this._built) return;
    if (dir > 0) {
      this._thump({ freq: 240 + rpmNorm * 200, gain: 0.22, decay: 0.045, type: 'square' });
      this._burst({ freq: 2600 + rpmNorm * 1800, Q: 2.2, gain: 0.16, decay: 0.075 });
      this._burst({ freq: 620, Q: 1.1, gain: 0.10, decay: 0.05, at: 0.012 });
    } else {
      this._thump({ freq: 180, gain: 0.20, decay: 0.05, type: 'square' });
      this._burst({ freq: 340, Q: 1.2, gain: 0.30, decay: 0.16 });
      this._burst({ freq: 1500, Q: 5, gain: 0.20, decay: 0.09, at: 0.045 });
      this._burst({ freq: 900, Q: 3, gain: 0.14, decay: 0.06, at: 0.10 });
    }
  }

  playLockup(intensity = 1) {
    this._burst({ freq: 1550, Q: 1.3, gain: 0.20 * clamp(intensity, 0, 1), decay: 0.22 });
  }

  playKerb(intensity = 1) {
    const i = clamp(intensity, 0, 1);
    this._thump({ freq: 62, gain: 0.30 * i, decay: 0.11 });
    this._burst({ freq: 520, Q: 0.9, gain: 0.18 * i, decay: 0.07 });
  }

  playGravel(intensity = 1) {
    this._burst({ freq: 1900, Q: 0.8, gain: 0.14 * clamp(intensity, 0, 1), decay: 0.09 });
  }

  playImpact(intensity = 1) {
    const i = clamp(intensity, 0, 1);
    this._thump({ freq: 48, gain: 0.42 * i, decay: 0.22 });
    this._burst({ freq: 1400, Q: 0.6, gain: 0.30 * i, decay: 0.16 });
  }

  // -- per-frame update ----------------------------------------------------

  update(dt) {
    if (!this.ready || !this.vehicle || !this._built) return;
    const t = this._now();
    this._t += dt;

    this._updateListener(dt, t);
    this._updateMixMode();
    this._updateEngine(dt, t);
    this._updateDriveline(dt, t);
    this._updateTyres(dt, t);
    this._updateSurfaces(dt, t);
    this._updateAero(dt, t);
    this._updateOpponents(dt, t);
    this._updateSpace(dt, t);
  }

  _updateListener(dt, t) {
    const cam = this.world?.camera;
    const L = this.ctx.listener;
    if (!cam || !L) return;
    const e = cam.matrixWorld.elements;
    const x = e[12], y = e[13], z = e[14];
    if (this._hasListener && dt > 1e-5) {
      this._lvx = (x - this._lx) / dt;
      this._lvy = (y - this._ly) / dt;
      this._lvz = (z - this._lz) / dt;
    }
    this._lx = x; this._ly = y; this._lz = z;
    this._hasListener = true;

    // Camera forward is -Z of its world basis.
    const fx = -e[8], fy = -e[9], fz = -e[10];
    const ux = e[4], uy = e[5], uz = e[6];
    if (L.positionX) {
      L.positionX.setTargetAtTime(x, t, 0.01);
      L.positionY.setTargetAtTime(y, t, 0.01);
      L.positionZ.setTargetAtTime(z, t, 0.01);
      L.forwardX.setTargetAtTime(fx, t, 0.02);
      L.forwardY.setTargetAtTime(fy, t, 0.02);
      L.forwardZ.setTargetAtTime(fz, t, 0.02);
      L.upX.setTargetAtTime(ux, t, 0.02);
      L.upY.setTargetAtTime(uy, t, 0.02);
      L.upZ.setTargetAtTime(uz, t, 0.02);
    } else {
      L.setPosition(x, y, z);
      L.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  _updateMixMode() {
    const mode = this.world?.rig?.mode;
    if (!mode) return;
    const want = MODE_TO_MIX[mode] ?? 'chase';
    if (want !== this.mix) this.setMix(want);
  }

  _updateEngine(dt, t) {
    const v = this.vehicle;
    const cfg = v.cfg ?? { redline: 15000 };
    const rpm = v.rpm ?? 0;
    const rpmN = clamp(rpm / cfg.redline, 0, 1.08);
    const load = clamp(v.controls?.throttle ?? 0, 0, 1);
    const brake = clamp(v.controls?.brake ?? 0, 0, 1);
    const decel = clamp(-(v.gLong ?? 0), 0, 3);

    // Cycle frequency: 720 deg of crank = two revolutions. The wave puts the
    // firing note at the 6th harmonic, i.e. 3 x rev = the 3rd engine order.
    const cycle = clamp(rpm / 120, 12, 160);
    const set = (p, x, tau) => p.setTargetAtTime(x, t, tau);
    set(this.oscLow.osc.frequency, cycle, 0.012);
    set(this.oscMid.osc.frequency, cycle, 0.012);
    set(this.oscHigh.osc.frequency, cycle, 0.012);
    set(this.halfOrder.frequency, cycle * 3, 0.02);      // 1.5 order = fire/2
    set(this.jitter.gain, cycle * 0.004, 0.08);          // +-0.4% of crank speed
    set(this.camOsc.frequency, cycle, 0.02);             // camshaft = cycle rate

    // Rasp morph: soft blast low down, hard narrow blast at the top end.
    const wLow = 1 - smoothstep(0.20, 0.58, rpmN);
    const wHigh = smoothstep(0.42, 0.94, rpmN);
    const wMid = clamp(1 - wLow - wHigh, 0, 1) + 0.18;
    const norm = 1 / (wLow + wMid + wHigh);
    set(this.oscLow.gain.gain, wLow * norm, 0.06);
    set(this.oscMid.gain.gain, wMid * norm, 0.06);
    set(this.oscHigh.gain.gain, wHigh * norm, 0.06);

    // Overrun: throttle shut, still turning, still decelerating.
    const overrun = (1 - load) * smoothstep(0.22, 0.5, rpmN) * clamp(0.35 + decel * 0.5, 0, 1);
    // The 1.5 order is the burble, not the note: keep it well under the firing
    // harmonic on throttle and let it come forward only when the throttle shuts.
    set(this.halfGain.gain, (0.028 + overrun * 0.075) * (0.5 + rpmN * 0.5), 0.06);

    // Drive into the asymmetric clipper: this is the load-dependent timbre.
    set(this.drive.gain, 0.55 + load * 2.1 + rpmN * 1.15, 0.05);

    const core = (0.085 + 0.48 * Math.pow(rpmN, 0.8)) * (0.34 + 0.66 * load);
    set(this.engineGain.gain, core, 0.035);

    // Exhaust primary sits near the firing note across the usable rev range, so
    // the 3rd order keeps the melody; the airbox formant is deliberately weaker
    // than it was — at +11 dB it made the 4th firing harmonic the loudest thing
    // in the frame, which reads as a wasp, not an engine.
    set(this.resBody.frequency, 330 + rpmN * 300, 0.06);
    this.resBody.gain.setTargetAtTime(5.0 + load * 5.0, t, 0.08);
    set(this.resAirbox.frequency, 1150 + rpmN * 1700, 0.05);
    this.resAirbox.Q.setTargetAtTime(1.3 + load * 1.9, t, 0.08);
    this.resAirbox.gain.setTargetAtTime(1.0 + load * 6.5, t, 0.06);
    // Closing the low-pass on a shut throttle is most of the on/off character.
    set(this.tone.frequency, (2200 + rpmN * 9500) * (0.42 + load * 0.58), 0.045);

    // Off throttle the exhaust gargles: more gas noise, pitched lower.
    set(this.exhaustGain.gain, (0.020 + rpmN * 0.045) * (0.45 + load * 0.55) + overrun * 0.055, 0.05);
    set(this.exhaustBP.frequency, (240 + rpmN * 700) * (1 - overrun * 0.45), 0.06);
    set(this.clatterGain.gain, (0.006 + rpmN * 0.022) * (0.55 + load * 0.45), 0.06);
    set(this.clatterBP.frequency, 3200 + rpmN * 2600, 0.08);
    set(this.intakeGain.gain, (0.012 + rpmN * 0.055) * load * load, 0.05);
    set(this.intakeBP.frequency, 1200 + rpmN * 2400, 0.05);

    // --- rev limiter: audio-rate ignition cut ------------------------------
    const atLimit = clamp((rpm - cfg.redline * 0.982) / (cfg.redline * 0.022), 0, 1) * load;
    set(this.limiterOsc.frequency, 52 + atLimit * 14, 0.03);
    set(this.limiterDepth.gain, atLimit * 0.92, 0.012);

    // --- turbo / MGU-H -----------------------------------------------------
    const boostTarget = load * (0.22 + 0.78 * smoothstep(0.15, 0.85, rpmN));
    // The MGU-H keeps the shaft lit, so it spools fast and decays slowly.
    const tau = boostTarget > this._boost ? 0.28 : 0.55;
    this._boost = lerp(this._boost, boostTarget, 1 - Math.exp(-dt / tau));
    const spool = clamp(this._boost, 0, 1);
    const blade = 1050 + spool * 5300;
    set(this.turbo1.frequency, blade, 0.05);
    set(this.turbo2.frequency, blade * 2.02, 0.05);
    set(this.turboGain.gain, Math.pow(spool, 1.4) * 0.048, 0.06);
    set(this.turbo2Gain.gain, Math.pow(spool, 1.8) * 0.022, 0.06);
    set(this.mguh.frequency, 3600 + spool * 7200, 0.06);
    set(this.mguhGain.gain, Math.pow(spool, 2.0) * 0.014, 0.07);
    set(this.rushBP.frequency, blade, 0.05);
    set(this.rushGain.gain, spool * 0.030, 0.06);

    // MGU-K deploy: 8 x crank order, present only while energy is going in.
    const deploying = (v.controls?.ers || load > 0.9) && (v.ers ?? 0) > 0 && rpm > 5000 ? 1 : 0;
    this._ersBlend = lerp(this._ersBlend ?? 0, deploying, 1 - Math.exp(-dt * 6));
    const mgukF = clamp((rpm / 60) * 8, 200, 12000);
    set(this.mguk.frequency, mgukF, 0.04);
    set(this.mgukBP.frequency, mgukF, 0.04);
    set(this.mgukGain.gain, this._ersBlend * 0.020 * (0.4 + rpmN * 0.6), 0.08);

    // Wastegate chatter on a big lift once there is boost to dump.
    if (load < 0.12 && this._boost > 0.34 && this._t - (this._lastGate ?? -9) > 0.35) {
      this._lastGate = this._t;
      this._burst({ freq: 2900, Q: 7, gain: 0.20, decay: 0.26, am: 38 + this._rng() * 26 });
      this._boost *= 0.35;
    }

    // --- overrun crackle ---------------------------------------------------
    this._popTimer -= dt;
    if (overrun > 0.25 && this._popTimer <= 0) {
      const rate = 3 + overrun * 16;
      this._popTimer = (0.35 + this._rng() * 0.9) / rate;
      const hot = this._rng();
      if (hot > 0.86) {
        this._burst({ freq: 260 + this._rng() * 180, Q: 0.9, gain: 0.26 * overrun, decay: 0.13 });
        this._thump({ freq: 74, gain: 0.14 * overrun, decay: 0.08 });
      } else {
        this._burst({ freq: 700 + this._rng() * 1700, Q: 2.5 + this._rng() * 5, gain: 0.10 * overrun, decay: 0.035 + this._rng() * 0.04 });
      }
    }

    // --- gear changes ------------------------------------------------------
    const gear = v.gear ?? 1;
    if (gear !== this._lastGear) {
      this.playShift(gear > this._lastGear ? 1 : -1, rpmN);
      this._lastGear = gear;
    }
    // DRS flap: a hydraulic thunk on open and a heavier one on the snap shut.
    const drs = !!v.drsActive;
    if (drs !== this._lastDrs) {
      this._thump({ freq: drs ? 150 : 110, gain: drs ? 0.16 : 0.24, decay: 0.06, type: 'square' });
      this._burst({ freq: drs ? 1900 : 1300, Q: 1.6, gain: drs ? 0.09 : 0.14, decay: 0.05 });
      this._lastDrs = drs;
    }

    void brake;
    this._rpmN = rpmN;
    this._load = load;
    this._spool = spool;
  }

  _updateDriveline(dt, t) {
    const v = this.vehicle;
    const speed = v.speed ?? 0;
    const set = (p, x, tau) => p.setTargetAtTime(x, t, tau);
    const wheelR = v.cfg?.wheelRadius ?? 0.36;

    // Final-drive mesh: wheel revolutions per second x tooth count.
    const wheelRps = speed / (2 * Math.PI * wheelR);
    const finalMesh = clamp(wheelRps * 38, 40, 9000);
    const clusterMesh = clamp(((v.rpm ?? 0) / 60) * 17, 60, 11000);
    set(this.gearFinal.osc.frequency, finalMesh, 0.03);
    set(this.gearCluster.osc.frequency, clusterMesh, 0.03);

    // Straight-cut gears whine at roughly constant level; the reason you only
    // notice them off throttle is that the engine has stopped shouting.
    const drive = 0.62 + 0.38 * this._load;
    const speedUp = clamp(speed / 24, 0, 1);
    set(this.gearFinal.gain.gain, 0.020 * drive * speedUp, 0.06);
    set(this.gearCluster.gain.gain, 0.013 * drive * speedUp, 0.06);
  }

  _updateTyres(dt, t) {
    const v = this.vehicle;
    const set = (p, x, tau) => p.setTargetAtTime(x, t, tau);
    const sa = v.slipAngle ?? [0, 0, 0, 0];
    const sr = v.slipRatio ?? [0, 0, 0, 0];
    const lk = v.lockup ?? [0, 0, 0, 0];
    const speed = v.speed ?? 0;

    const slipF = (Math.abs(sa[0]) + Math.abs(sa[1])) * 0.5;
    const slipR = (Math.abs(sa[2]) + Math.abs(sa[3])) * 0.5;
    const slipLat = Math.max(slipF, slipR);
    const slipLong = Math.max(Math.abs(sr[0]), Math.abs(sr[1]), Math.abs(sr[2]), Math.abs(sr[3]));
    // ~3.2 deg of slip is where a real slick starts to talk.
    const scrub01 = clamp((Math.max(slipLat, slipLong * 0.55) - 0.056) / 0.16, 0, 1);
    const moving = clamp(speed / 14, 0, 1);
    const grip = this.world?.weather ? 1 - clamp(this.world.weather.wetness ?? 0, 0, 1) * 0.55 : 1;

    set(this.scrubGain.gain, scrub01 * 0.085 * moving, 0.05);
    set(this.scrubBP.frequency, 1050 + scrub01 * 1200, 0.06);

    const squeal = Math.pow(scrub01, 1.6) * moving * grip;
    set(this.squealGain.gain, squeal * 0.075, 0.05);
    set(this.squealBP.frequency, 780 + scrub01 * 1150 + (slipR > slipF ? 180 : 0), 0.05);
    this.squealBP.Q.setTargetAtTime(9 + squeal * 16, t, 0.08);
    set(this.stickSlip.frequency, 24 + scrub01 * 62 + clamp(speed / 3, 0, 24), 0.06);
    set(this.stickSlipDepth.gain, 0.25 + squeal * 0.45, 0.06);

    const lock01 = Math.max(lk[0], lk[1], lk[2], lk[3]);
    set(this.lockGain.gain, clamp(lock01 * 1.4, 0, 1) * 0.075 * moving, 0.04);
    set(this.lockBP.frequency, 1450 + lock01 * 900, 0.05);

    // Carbon brakes: loudest hot and slow, but never fully silent at speed.
    const bt = v.brakeTemp ?? [300, 300, 300, 300];
    const hot = clamp((Math.max(bt[0], bt[1], bt[2], bt[3]) - 340) / 480, 0, 1);
    const brake = clamp(v.controls?.brake ?? 0, 0, 1);
    const shriek = brake * hot * (0.30 + 0.70 * clamp(1 - speed / 72, 0, 1)) * clamp(speed / 6, 0, 1);
    set(this.brakeGain.gain, shriek * 0.045, 0.06);
    set(this.brakeBP.frequency, 2350 + clamp(1 - speed / 80, 0, 1) * 1000 + hot * 350, 0.08);
  }

  _updateSurfaces(dt, t) {
    const v = this.vehicle;
    const set = (p, x, tau) => p.setTargetAtTime(x, t, tau);
    const speed = v.speed ?? 0;
    const hw = this.world?.circuit?.halfWidth ?? 6.7;
    const lat = Math.abs(v.trackLateral ?? 0);
    const off = lat - hw;

    // Kerb: the rib pitch on an F1 kerb is roughly a quarter of a metre.
    const onKerb = off > -0.35 && off < 1.5 && speed > 3;
    const ribF = clamp(speed / 0.24, 6, 240);
    set(this.ribOsc.frequency, ribF, 0.02);
    set(this.kerbGain.gain, onKerb ? clamp(speed / 12, 0, 1) * 0.16 : 0, 0.04);
    set(this.kerbLP.frequency, 400 + clamp(speed / 60, 0, 1) * 1400, 0.06);
    if (onKerb && !this._onKerb) this.playKerb(clamp(speed / 45, 0.3, 1));
    this._onKerb = onKerb;

    // Grass and gravel: same band, different tone and level.
    const grass = clamp((off - 1.4) / 1.2, 0, 1) * (1 - clamp((off - 5.0) / 1.5, 0, 1));
    const gravel = clamp((off - 5.2) / 1.6, 0, 1);
    const rough = Math.max(grass * 0.55, gravel) * clamp(speed / 18, 0, 1);
    set(this.roughGain.gain, rough * 0.13, 0.05);
    set(this.roughBP.frequency, gravel > grass ? 1500 : 3000, 0.08);
    this.roughBP.Q.setTargetAtTime(gravel > grass ? 0.5 : 1.1, t, 0.1);

    // Individual stones flicking off the floor in the trap.
    this._grainTimer -= dt;
    if (gravel > 0.2 && speed > 6 && this._grainTimer <= 0) {
      this._grainTimer = (0.6 + this._rng()) / (4 + gravel * 22);
      this.playGravel(gravel * clamp(speed / 30, 0.2, 1) * (0.4 + this._rng() * 0.6));
    }
    this._offTrack = Math.max(grass, gravel);
  }

  _updateAero(dt, t) {
    const v = this.vehicle;
    const set = (p, x, tau) => p.setTargetAtTime(x, t, tau);
    const speed = v.speed ?? 0;
    const q = clamp(speed / 92, 0, 1.15);
    const wind = q * q;
    set(this.windLowGain.gain, wind * 0.050, 0.08);
    set(this.windLowBP.frequency, 170 + wind * 240, 0.10);
    set(this.windHiGain.gain, wind * 0.042, 0.08);
    set(this.windHiBP.frequency, 1500 + wind * 2100, 0.10);

    const rain = clamp(this.world?.weather?.rain ?? 0, 0, 1);
    set(this.rainGain.gain, rain * (0.030 + wind * 0.045), 0.15);
    set(this.rainBP.frequency, 2600 + rain * 1600, 0.2);

    // Individual drops hammering the bodywork — onboard only, it is a close mic.
    this._rainTimer -= dt;
    if (rain > 0.15 && this.mix === 'onboard' && this._rainTimer <= 0) {
      this._rainTimer = (0.5 + this._rng()) / (8 + rain * 34);
      this._burst({ freq: 3200 + this._rng() * 3600, Q: 2.5, gain: 0.030 * rain, decay: 0.020 });
    }
  }

  // -- opponents -----------------------------------------------------------

  _updateOpponents(dt, t) {
    const cars = this.world?.field?.cars;
    const voices = this.voices;
    if (!cars || !voices?.length || !this._hasListener) return;

    // Rank by squared distance and steal the nearest slots.
    const order = this._order;
    let n = 0;
    for (const c of cars) {
      if (c.vehicle === this.vehicle) continue;
      const p = c.vehicle.position;
      const dx = p.x - this._lx, dy = p.y - this._ly, dz = p.z - this._lz;
      const slot = order[n] ?? (order[n] = { c: null, d2: 0 });
      slot.c = c;
      slot.d2 = dx * dx + dy * dy + dz * dz;
      n++;
    }
    order.length = n;
    order.sort((a, b) => a.d2 - b.d2);

    for (let i = 0; i < voices.length; i++) {
      const voice = voices[i];
      const pick = order[i];
      if (!pick || pick.d2 > 360 * 360) {
        voice.car = null;
        voice.silence(t);
        continue;
      }
      if (voice.car !== pick.c) {
        voice.car = pick.c;
        voice.gain.gain.cancelScheduledValues(t);
        voice.gain.gain.setValueAtTime(0, t);
        voice._hasPrev = false;
      }
      this._updateVoice(voice, pick.c.vehicle, Math.sqrt(pick.d2), dt, t);
    }
  }

  _updateVoice(voice, v, dist, dt, t) {
    const p = v.position;
    voice.setPosition(t, p.x, p.y + 0.5, p.z);

    // Car velocity from the position delta (cheap and always available).
    let vx = 0, vy = 0, vz = 0;
    if (voice._hasPrev && dt > 1e-5) {
      vx = (p.x - voice._px) / dt;
      vy = (p.y - voice._py) / dt;
      vz = (p.z - voice._pz) / dt;
    }
    voice._px = p.x; voice._py = p.y; voice._pz = p.z;
    voice._hasPrev = true;

    // Doppler: radial closing rate of source and listener along the sight line.
    const inv = 1 / Math.max(dist, 0.5);
    const nx = (p.x - this._lx) * inv, ny = (p.y - this._ly) * inv, nz = (p.z - this._lz) * inv;
    const vSrc = vx * nx + vy * ny + vz * nz;          // +ve = receding
    const vLis = this._lvx * nx + this._lvy * ny + this._lvz * nz;
    const doppler = clamp(
      (SPEED_OF_SOUND + vLis) / Math.max(40, SPEED_OF_SOUND + vSrc),
      0.55, 1.9
    );

    const cfg = v.cfg ?? { redline: 15000 };
    const rpmN = clamp((v.rpm ?? 0) / cfg.redline, 0, 1.08);
    const load = clamp(v.controls?.throttle ?? 0, 0, 1);
    const cycle = clamp((v.rpm ?? 0) / 120, 12, 160) * doppler;
    const set = (param, x, tau) => param.setTargetAtTime(x, t, tau);

    set(voice.osc.frequency, cycle, 0.02);
    set(voice.oscGain.gain, (0.16 + rpmN * 0.55) * (0.35 + load * 0.65), 0.05);

    set(voice.turboOsc.frequency, (1050 + rpmN * load * 5300) * doppler, 0.06);
    set(voice.turboGain.gain, rpmN * load * 0.05, 0.07);

    set(voice.exhaustBP.frequency, (260 + rpmN * 620) * doppler, 0.06);
    set(voice.exhaustGain.gain, (0.05 + rpmN * 0.10) * (0.4 + load * 0.6), 0.06);

    const sa = v.slipAngle ?? [0, 0, 0, 0];
    const scrub = clamp((Math.max(Math.abs(sa[0]), Math.abs(sa[2])) - 0.056) / 0.16, 0, 1);
    set(voice.tyreBP.frequency, (900 + scrub * 1100) * doppler, 0.06);
    set(voice.tyreGain.gain, scrub * 0.10 * clamp((v.speed ?? 0) / 14, 0, 1), 0.05);

    // Occlusion: a grandstand between listener and car eats the top end.
    let occluded = false;
    for (const b of this._occBoxes) {
      if (segmentHitsBox(this._lx, this._ly, this._lz, p.x, p.y + 0.5, p.z, b)) { occluded = true; break; }
    }
    // Air absorption on top of occlusion — distant cars are always darker.
    const air = 20000 * Math.exp(-dist / 140) + 1200;
    // A grandstand is a big reflective box, not a vacuum: -8 dB and a hard
    // low-pass reads as "behind the stand", -17 dB read as "switched off".
    set(voice.lp.frequency, occluded ? Math.min(air, 780) : air, occluded ? 0.06 : 0.12);
    set(voice.gain.gain, occluded ? 0.40 : 1.0, 0.08);
    set(voice.send.gain, clamp(0.12 + dist / 220, 0.12, 0.6), 0.15);
  }

  // -- reverb space --------------------------------------------------------

  _updateSpace(dt, t) {
    void dt; void t;
    if (!this.world || this._t - (this._spaceCheck ?? -9) < 0.25) return;
    this._spaceCheck = this._t;

    // Pit lane first: the environment already knows where it is, and a row of
    // open garage boxes is by far the most reflective place on the circuit.
    const env = this.world.environment;
    const v = this.vehicle;
    if (env && v && env.pitFrom !== undefined) {
      const s = v.trackS ?? 0;
      const inS = env.pitFrom < env.pitTo
        ? s >= env.pitFrom && s <= env.pitTo
        : s >= env.pitFrom || s <= env.pitTo;
      const hw = this.world.circuit?.halfWidth ?? 6.7;
      if (inS && (v.trackLateral ?? 0) < -(hw + 2)) { this.setSpace('pit', 1); return; }
    }

    // Otherwise derive enclosure from the grandstand boxes we already have:
    // a wall within ~34 m of the listener means reflections arrive early.
    let near = Infinity;
    for (const b of this._occBoxes) {
      const dx = Math.max(b.x0 - this._lx, 0, this._lx - b.x1);
      const dz = Math.max(b.z0 - this._lz, 0, this._lz - b.z1);
      const d = Math.hypot(dx, dz);
      if (d < near) near = d;
    }
    const enclosed = clamp(1 - near / 34, 0, 1);
    this.setSpace(enclosed > 0.55 ? 'stands' : 'open', 0.35 + enclosed * 0.9);
  }

  // -- diagnostics ---------------------------------------------------------

  /** Live magnitude spectrum in dB (analyser, post-mix pre-limiter). */
  spectrum() {
    if (!this.analyser) return null;
    const a = new Float32Array(this.analyser.frequencyBinCount);
    this.analyser.getFloatFrequencyData(a);
    return { data: a, binHz: this.ctx.sampleRate / this.analyser.fftSize };
  }

  /** Coarse state readout for the debug HUD / tests. */
  levels() {
    return {
      ready: this.ready,
      mix: this.mix,
      space: this.space,
      boost: this._boost,
      rpmNorm: this._rpmN ?? 0,
      load: this._load ?? 0,
      activeVoices: this.voices?.filter((v) => v.car).length ?? 0,
      occluders: this._occBoxes.length,
    };
  }

  dispose() {
    try { this.voices?.forEach((v) => v.dispose()); } catch { /* already gone */ }
    if (!this._externalCtx) {
      try { this.ctx?.close(); } catch { /* already closed */ }
    }
    this.ctx = null;
    this.ready = false;
    this._built = false;
  }
}
