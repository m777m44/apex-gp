/**
 * APEX GP — input.
 *
 * Produces a single normalised control state that the vehicle model consumes:
 *
 *   steer     -1 (full left) .. +1 (full right)
 *   throttle   0 .. 1
 *   brake      0 .. 1
 *   clutch     0 .. 1
 *   drs / ers  booleans (edge-triggered actions live in `actions`)
 *
 * Keyboard input is ramped so it behaves like an analog axis; a gamepad axis
 * bypasses the ramp and is used raw (with a deadzone + gamma curve).
 *
 * Deterministic capture: `setVirtual(partial)` overrides the state entirely,
 * which is how `__APEX__.capture()` poses the car without touching hardware.
 */

const KEYMAP = {
  left: ['ArrowLeft', 'KeyA'],
  right: ['ArrowRight', 'KeyD'],
  throttle: ['ArrowUp', 'KeyW'],
  brake: ['ArrowDown', 'KeyS'],
  shiftUp: ['KeyE', 'ShiftRight'],
  shiftDown: ['KeyQ', 'ShiftLeft'],
  drs: ['KeyF'],
  ers: ['KeyR'],
  camera: ['KeyC'],
  reset: ['KeyX'],
  pause: ['KeyP'],
  look: ['KeyV'],
};

export class Input {
  constructor(target = window, opts = {}) {
    this.target = target;
    this.keys = new Set();
    this.enabled = true;
    this.virtual = null;

    this.steerRate = opts.steerRate ?? 3.4;    // units/s toward the key target
    this.steerReturn = opts.steerReturn ?? 6.0;
    this.pedalRate = opts.pedalRate ?? 6.0;
    this.deadzone = opts.deadzone ?? 0.08;

    this.state = {
      steer: 0, throttle: 0, brake: 0, clutch: 0,
      drs: false, ers: false, lookBack: false,
      gamepad: false,
    };

    /** Edge-triggered actions, cleared at the end of every update(). */
    this.actions = { shiftUp: false, shiftDown: false, camera: false, reset: false, pause: false, drsToggle: false };
    this._listeners = new Map();
    this._prevKeys = new Set();
    /**
     * Codes that went DOWN since the last `update()`, latched by the DOM handler.
     *
     * Edge detection cannot live purely in `update()`. `_pressed()` diffs `keys`
     * against `_prevKeys`, both sampled inside `update()`, and `update()` only
     * runs on a FIXED 1/60 simulation step — so on any display faster than 60 Hz
     * there are render frames with no step at all, and a keydown/keyup pair that
     * completes between two steps was never visible to the diff. Measured before
     * this: eight taps of C advanced the camera four times, and every other
     * gearshift, DRS press and reset was silently swallowed. Latching at the event
     * makes a tap impossible to miss regardless of frame rate.
     */
    this._tapped = new Set();

    this._onKeyDown = (e) => {
      if (!this.enabled) return;
      if (!this.keys.has(e.code)) this._tapped.add(e.code);
      this.keys.add(e.code);
      if (e.code === 'Space' || e.code.startsWith('Arrow')) e.preventDefault();
    };
    this._onKeyUp = (e) => { this.keys.delete(e.code); };
    this._onBlur = () => { this.keys.clear(); this._tapped.clear(); };

    target.addEventListener('keydown', this._onKeyDown);
    target.addEventListener('keyup', this._onKeyUp);
    target.addEventListener('blur', this._onBlur);
  }

  isDown(action) {
    const codes = KEYMAP[action];
    return codes ? codes.some((c) => this.keys.has(c)) : this.keys.has(action);
  }

  _pressed(action) {
    const codes = KEYMAP[action] ?? [action];
    // `_tapped` catches presses that began AND ended between two fixed steps;
    // the `_prevKeys` diff still catches a key that is being held down.
    return codes.some((c) => this._tapped.has(c) || (this.keys.has(c) && !this._prevKeys.has(c)));
  }

  /** Register a callback for an edge-triggered action name. */
  on(name, cb) {
    if (!this._listeners.has(name)) this._listeners.set(name, []);
    this._listeners.get(name).push(cb);
    return this;
  }

  _emit(name) {
    const l = this._listeners.get(name);
    if (l) for (const cb of l) cb();
  }

  /**
   * Force the control state (capture, replays, AI-driven player car).
   * Pass `null` to hand control back to the hardware.
   */
  setVirtual(partial) {
    this.virtual = partial ? { ...this.state, ...partial } : null;
  }

  _readGamepad() {
    if (typeof navigator === 'undefined' || !navigator.getGamepads) return null;
    const pads = navigator.getGamepads();
    for (const p of pads) if (p && p.connected) return p;
    return null;
  }

  _curve(v) {
    const dz = this.deadzone;
    const s = Math.sign(v);
    const a = Math.abs(v);
    if (a < dz) return 0;
    const n = (a - dz) / (1 - dz);
    return s * n * n * 0.65 + s * n * 0.35; // mild expo around centre
  }

  update(dt) {
    const s = this.state;

    if (this.virtual) {
      Object.assign(s, this.virtual);
      for (const k of Object.keys(this.actions)) this.actions[k] = false;
      // Drop latched taps too, or a key pressed during a capture fires the
      // instant the game hands control back to the hardware.
      this._tapped.clear();
      return s;
    }

    const pad = this._readGamepad();
    s.gamepad = !!pad;

    if (pad) {
      s.steer = this._curve(pad.axes[0] ?? 0);
      // Triggers: prefer analog buttons 6/7, fall back to axes on some pads.
      const rt = pad.buttons[7]?.value ?? 0;
      const lt = pad.buttons[6]?.value ?? 0;
      s.throttle = rt;
      s.brake = lt;
      if (pad.buttons[0]?.pressed) s.throttle = Math.max(s.throttle, 1);
      s.drs = !!pad.buttons[2]?.pressed;
      s.ers = !!pad.buttons[3]?.pressed;
      if (pad.buttons[5]?.pressed && !this._padUp) this.actions.shiftUp = true;
      if (pad.buttons[4]?.pressed && !this._padDown) this.actions.shiftDown = true;
      this._padUp = pad.buttons[5]?.pressed;
      this._padDown = pad.buttons[4]?.pressed;
    } else {
      // Keyboard: ramp toward the commanded value so it feels analog.
      const want = (this.isDown('right') ? 1 : 0) - (this.isDown('left') ? 1 : 0);
      if (want !== 0) {
        s.steer += Math.sign(want - s.steer) * Math.min(Math.abs(want - s.steer), this.steerRate * dt);
      } else {
        const d = Math.min(Math.abs(s.steer), this.steerReturn * dt);
        s.steer -= Math.sign(s.steer) * d;
      }
      const tTarget = this.isDown('throttle') ? 1 : 0;
      const bTarget = this.isDown('brake') ? 1 : 0;
      s.throttle += Math.sign(tTarget - s.throttle) * Math.min(Math.abs(tTarget - s.throttle), this.pedalRate * dt);
      s.brake += Math.sign(bTarget - s.brake) * Math.min(Math.abs(bTarget - s.brake), this.pedalRate * dt);
      s.drs = this.isDown('drs');
      s.ers = this.isDown('ers');
      s.lookBack = this.isDown('look');
    }

    s.steer = Math.max(-1, Math.min(1, s.steer));
    s.throttle = Math.max(0, Math.min(1, s.throttle));
    s.brake = Math.max(0, Math.min(1, s.brake));

    this.actions.shiftUp = this.actions.shiftUp || this._pressed('shiftUp');
    this.actions.shiftDown = this.actions.shiftDown || this._pressed('shiftDown');
    this.actions.camera = this._pressed('camera');
    this.actions.reset = this._pressed('reset');
    this.actions.pause = this._pressed('pause');

    for (const [name, on] of Object.entries(this.actions)) if (on) this._emit(name);

    this._prevKeys = new Set(this.keys);
    this._tapped.clear();
    return s;
  }

  /** Call after the sim step consumed `actions`. */
  endFrame() {
    for (const k of Object.keys(this.actions)) this.actions[k] = false;
  }

  dispose() {
    this.target.removeEventListener('keydown', this._onKeyDown);
    this.target.removeEventListener('keyup', this._onKeyUp);
    this.target.removeEventListener('blur', this._onBlur);
  }
}
