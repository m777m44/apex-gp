/**
 * APEX GP — broadcast HUD and timing graphics.
 *
 * THE EDIT (read this before adding a panel)
 *   A world feed is not a telemetry dashboard. This overlay is deliberately five
 *   pieces of furniture and one transient slot, and nothing is allowed to say the
 *   same thing twice:
 *
 *     tower      top-left      position, code, compound, interval + THE lap counter
 *     timing     top-right     current lap, this lap's sectors, LAST, BEST, delta
 *     cluster    bottom-centre position/driver, pedals, speed, gear, DRS, ERS, revs
 *     minimap    bottom-left   where the field is
 *     tyres      bottom-right  four corners, three bands each, wear, compound
 *     slot       top-centre    ONE contextual chip: flag, race-control call, or a
 *                              personal-best / sector toast. Empty when idle.
 *
 *   Total ink is ~12.5% of a 1600x900 frame (F1 24 sits at 12-14%). Every panel
 *   is anchored to `LAYOUT.inset` and sized from `LAYOUT`, so the right-hand
 *   margins agree to the pixel and every gap is a multiple of `LAYOUT.U`.
 *
 * DESIGN LANGUAGE
 *   ONE corner treatment: a single 45 degree chamfer, `LAYOUT.cut` px, on the
 *   corner that faces the middle of the screen (`_shape`, `_chip`). ONE pill:
 *   `_chip`. Colour is rationed:
 *     C.cyan          ONLY the live speed/gear group. Nothing else, ever.
 *     C.green         the single green: personal best, DRS, throttle.
 *     C.purple        session best. An F1 graphic without purple is not one.
 *     C.slate/steel   every other data colour (minimap, ERS, tyre wear).
 *   Type: labels never below `LABEL_SIZE` px and never tracked past 1.0 px, and
 *   every baseline is snapped to a device pixel (`_snap`) so stems stay crisp.
 *
 * HOW IT IS COMPOSITED
 *   Two DOM layers sit above the WebGL canvas inside the engine's container:
 *     z-index 9   `glass` layer — a pool of empty divs whose only job is
 *                 `backdrop-filter: blur()`, so panels genuinely frost the 3D
 *                 image behind them. Chamfered outlines come from `clip-path`.
 *     z-index 10  `canvas`      — every pixel of artwork, drawn with Canvas2D at
 *                 device resolution so type stays razor sharp.
 *
 * DESIGN SPACE
 *   All layout maths is written against a 1600x900 design space. `render()`
 *   installs a transform of `dpr * k` (k = viewport / design), so the same code
 *   is pixel-exact at 900p and at 4K — nothing is ever resampled.
 *
 * PUBLIC API
 *   new HUD(container, { circuit })
 *   hud.resize(width, height, dpr)
 *   hud.setVisible(bool)
 *   hud.setGlass(bool)                 // frosted backdrop on/off (perf switch)
 *   hud.dispose()
 *   hud.render(frame)
 *
 *   frame = {
 *     dt,                  // seconds since the last HUD frame (default 1/60)
 *     telemetry,           // Vehicle.telemetry
 *     race,                // RaceSession.snapshot()
 *     cars,                // RaceSession.carDots(): [{ index, s, lateral, colour }]
 *     playerIndex,
 *     banner, flag, weather
 *   }
 *
 *   Optional, consumed when present, synthesised when not:
 *     race.standings[i].{ gap, interval, compound, tyreAge, pit, drs, name, number }
 *     race.sectorTimes[3], race.prevSectorTimes[3], race.fastestLap { code, time }
 *     race.weatherLabel
 *     telemetry.{ tyreWear[4], tyreCore[4], fuelKg, compound, tyreAge }
 *
 *   formatLapTime(seconds) / formatGap(seconds)
 */

// ── type ────────────────────────────────────────────────────────────────────
// Two technical grotesques that ship with macOS/most desktops. DIN Condensed
// carries the numerals (tight, tabular, motorsport); DIN Alternate the labels.
const F_NUM = '"DIN Condensed", "Oswald", "Avenir Next Condensed", "Arial Narrow", "Helvetica Neue", sans-serif';
const F_UI = '"DIN Alternate", "Roboto Condensed", "Helvetica Neue", Helvetica, Arial, sans-serif';

/** The label tier floor. Below this an all-caps grotesque goes soft at 1080p. */
const LABEL_SIZE = 14;
/** Tracking ceiling for labels. Past ~1 px the word gaps collapse. */
const LABEL_TRACK = 1.0;

// ── palette ─────────────────────────────────────────────────────────────────
const C = {
  text: '#f2f6fa',
  dim: 'rgba(222,232,242,0.66)',
  faint: 'rgba(222,232,242,0.38)',
  edge: 'rgba(255,255,255,0.15)',
  ink: '#0b1a22',            // dark type on a light data block
  slate: '#9db4c9',          // the neutral data colour
  steel: '#5f8ba8',          // slate's darker partner (bars, casings)
  purple: '#c264ff',         // sessionBest
  green: '#22e07c',          // personalBest / DRS / throttle — the ONE green
  yellow: '#ffd21e',
  red: '#ff3b30',
  cyan: '#33ccff',           // RESERVED: the live speed/gear group
  amber: '#ff9a17',
};

/**
 * PANEL MATERIAL — three numbers, and they are a set.
 *   PANEL_R     softens every corner the chamfer does not claim. 3 px: enough
 *               that a panel is not a stamped rectangle, not enough to read as
 *               a rounded button.
 *   PANEL_BLUR  backdrop blur, design px. 13 was a frost you could not see
 *               through at all; 6 leaves the world legible behind the glass.
 *   PANEL_DIM   the brightness the backdrop is knocked down to. This, not the
 *               ink alpha, is what gives white numerals their contrast over a
 *               sunlit sky — which is the whole reason the ink can be light.
 *
 * HOW MUCH WORLD ACTUALLY GETS THROUGH is the number to tune, and it is the
 * PRODUCT of the two — `PANEL_DIM * (1 - bodyAlpha)` — not either one alone.
 * At 0.52 x (1 - 0.72) the glass passed 14.6 % of the scene: measured on `hud`,
 * a panel over 130-luma hillside sat at 19 L, which is a black rectangle with a
 * blur nobody can see. A broadcast overlay runs 75-85 % opaque, so the target is
 * 15-25 % transmission WITHOUT the second knockdown eating most of it. 0.62 x
 * (1 - 0.63) = 23 %, i.e. a 77 %-opaque plate: the hoardings and the horizon
 * read through the tower, and white numerals still hold >8:1 over the brightest
 * sky this shot has. Raise one of the pair and you must lower the other.
 */
const PANEL_R = 3;
const PANEL_BLUR = 6;
const PANEL_DIM = 0.62;

/** 8 px base unit, one safe-area inset, one chamfer. Everything derives here. */
const LAYOUT = {
  U: 8,
  inset: 24,
  cut: 10,
  towerW: 264,
  towerHead: 26,
  towerCol: 15,              // the POS / DRIVER / INTERVAL column header
  towerRow: 21,
  towerRows: 5,              // window of rows around the player (+ the leader)
  timingW: 252,
  timingH: 160,
  barW: 660,
  barH: 88,
  mini: 168,
  tyreW: 188,
  tyreH: 114,
};

const COMPOUNDS = {
  soft: { colour: '#ff2d37', letter: 'S' },
  medium: { colour: '#ffd21e', letter: 'M' },
  hard: { colour: '#eef2f6', letter: 'H' },
  inter: { colour: '#22e07c', letter: 'I' },
  wet: { colour: '#3399ff', letter: 'W' },
};
const COMPOUND_CYCLE = ['soft', 'medium', 'hard', 'medium', 'soft', 'hard'];
const CORNERS = ['FL', 'FR', 'RL', 'RR'];

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
/** Frame-rate independent approach: fraction of the remaining distance per second. */
const approach = (cur, target, rate, dt) => lerp(cur, target, 1 - Math.exp(-rate * dt));

export class HUD {
  constructor(container, { circuit } = {}) {
    this.circuit = circuit;
    this.container = container;

    this.glassRoot = document.createElement('div');
    Object.assign(this.glassRoot.style, {
      position: 'absolute', inset: '0', pointerEvents: 'none', zIndex: '9', overflow: 'hidden',
    });
    container.appendChild(this.glassRoot);

    this.canvas = document.createElement('canvas');
    Object.assign(this.canvas.style, {
      position: 'absolute', inset: '0', width: '100%', height: '100%',
      pointerEvents: 'none', zIndex: '10',
    });
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');

    this.visible = true;
    this.glassOn = typeof CSS !== 'undefined' && CSS.supports?.('backdrop-filter', 'blur(4px)');
    this.w = 0; this.h = 0; this.dpr = 1; this.k = 1; this.uw = 1600; this.uh = 900;
    this.time = 0;

    // animation / event state
    this._glassPool = new Map();
    this._glassUsed = new Set();
    this._rows = new Map();          // driver index -> tower row animation
    this._prevSectors = ['', '', ''];
    this._sectorMark = 0;
    this._prevLap = 0;
    this._toasts = [];               // the ONE contextual slot's queue
    this._personalBest = Infinity;
    this._wear = [0, 0, 0, 0];
    this._shownSpeed = 0;
    this._shownRpm = 0;
    this._shownErs = 0;
    this._deltaSmooth = 0;
    this._drsGlow = 0;
    this._slotOpen = 0;              // 0..1 reveal of the contextual chip
    this._miniPath = null;

    this.resize(container.clientWidth || 1600, container.clientHeight || 900, 1);
  }

  /**
   * COMING BACK FROM HIDDEN, THE TOWER SNAPS.
   *
   * `this.time` only advances inside `render()`, so the "this row has just
   * scrolled into the window, put it straight into its slot" guard
   * (`time - seen > 0.5`) can never fire across a stretch when nothing was
   * drawn: as far as the animation is concerned no time passed, while the field
   * behind it re-ordered itself completely. Every row then flies in from a slot
   * it last held minutes ago, through the rows it is passing. `capture()` hides
   * the overlay for every shot and re-arms it only for `hud`, so this sits on
   * the screenshot path as well as on the pause menu.
   *
   * Queued toasts go with it: a personal-best card the driver earned while the
   * overlay was down is not news by the time it comes back up.
   */
  setVisible(v) {
    const was = this.visible;
    this.visible = v;
    this.canvas.style.display = v ? 'block' : 'none';
    this.glassRoot.style.display = v ? 'block' : 'none';
    if (v && !was) {
      this._rows.clear();
      this._toasts.length = 0;
      this._slotOpen = 0;
    }
  }

  /** Frosted backdrop panels. Cheap on desktop GPUs; switchable for low-end. */
  setGlass(on) {
    this.glassOn = !!on;
    if (!on) for (const g of this._glassPool.values()) g.style.display = 'none';
  }

  resize(width, height, dpr = Math.min(devicePixelRatio || 1, 2)) {
    this.w = width; this.h = height; this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.floor(width * dpr));
    this.canvas.height = Math.max(1, Math.floor(height * dpr));
    // Design space is 1600x900; letterbox-fit so the HUD keeps its proportions
    // and simply gains room on wider aspects.
    this.k = Math.min(width / 1600, height / 900);
    this.uw = width / this.k;
    this.uh = height / this.k;
    this._miniPath = null;
  }

  dispose() {
    this.canvas.remove();
    this.glassRoot.remove();
    this._glassPool.clear();
  }

  // ── primitives ────────────────────────────────────────────────────────────

  /** Design units for exactly `n` DEVICE pixels — hairlines and UI strokes. */
  _dev(n) { return n / (this.dpr * this.k); }

  /** Snap a design coordinate to a device-pixel boundary. */
  _snap(v) { const s = this.dpr * this.k; return Math.round(v * s) / s; }

  /**
   * Chamfered rectangle. `cut` = { tl, tr, br, bl } in design px; `r` softens
   * every corner that carries NO chamfer.
   *
   * The chamfer is still the signature — `r` is 3 px, a bevel you read as
   * "not stamped out of card" rather than as a rounded button. Traced into an
   * abstract sink so the identical geometry can go into the live path
   * (`_shape`) or into a `Path2D` (`_path`) for clip/fill reuse.
   */
  _trace(p, x, y, w, h, cut = {}, r = 0) {
    const tl = cut.tl || 0, tr = cut.tr || 0, br = cut.br || 0, bl = cut.bl || 0;
    const R = Math.max(0, Math.min(r, w / 2, h / 2));
    p.moveTo(x + Math.max(tl, R), y);
    if (tr) { p.lineTo(x + w - tr, y); p.lineTo(x + w, y + tr); }
    else if (R) { p.lineTo(x + w - R, y); p.arcTo(x + w, y, x + w, y + R, R); }
    else p.lineTo(x + w, y);
    if (br) { p.lineTo(x + w, y + h - br); p.lineTo(x + w - br, y + h); }
    else if (R) { p.lineTo(x + w, y + h - R); p.arcTo(x + w, y + h, x + w - R, y + h, R); }
    else p.lineTo(x + w, y + h);
    if (bl) { p.lineTo(x + bl, y + h); p.lineTo(x, y + h - bl); }
    else if (R) { p.lineTo(x + R, y + h); p.arcTo(x, y + h, x, y + h - R, R); }
    else p.lineTo(x, y + h);
    if (tl) { p.lineTo(x, y + tl); p.lineTo(x + tl, y); }
    else if (R) { p.lineTo(x, y + R); p.arcTo(x, y, x + R, y, R); }
    else p.lineTo(x, y);
    p.closePath();
  }

  _shape(x, y, w, h, cut = {}, r = 0) {
    this.ctx.beginPath();
    this._trace(this.ctx, x, y, w, h, cut, r);
  }

  _path(x, y, w, h, cut = {}, r = 0) {
    const p = new Path2D();
    this._trace(p, x, y, w, h, cut, r);
    return p;
  }

  /**
   * THE pill. One shape for every chip in the HUD (DRS, PIT, compound, toast
   * accent): a rectangle with a single 45 degree chamfer on the leading corner,
   * scaled down from `LAYOUT.cut` only when the chip is too short to take it.
   */
  _chip(x, y, w, h) {
    this._shape(x, y, w, h, { tl: Math.min(LAYOUT.cut, h * 0.42) });
  }

  /** A 1-device-pixel rule. Snapped, so it never lands as a 2 px grey smear. */
  _hair(x, y, w, h, colour = 'rgba(255,255,255,0.10)') {
    const c = this.ctx;
    c.fillStyle = colour;
    c.fillRect(this._snap(x), this._snap(y), w > h ? w : this._dev(1), h > w ? h : this._dev(1));
  }

  _glass(id, x, y, w, h, cut = {}, blur = PANEL_BLUR, r = 0) {
    if (!this.glassOn) return;
    let el = this._glassPool.get(id);
    if (!el) {
      el = document.createElement('div');
      el.style.position = 'absolute';
      el.style.left = '0'; el.style.top = '0';
      el.style.willChange = 'transform';
      this.glassRoot.appendChild(el);
      this._glassPool.set(id, el);
    }
    const k = this.k;
    const tl = cut.tl || 0, tr = cut.tr || 0, br = cut.br || 0, bl = cut.bl || 0;
    const px = (a, b) => `${(a / w * 100).toFixed(3)}% ${(b / h * 100).toFixed(3)}%`;
    el.style.clipPath = `polygon(${[
      px(tl, 0), px(w - tr, 0), px(w, tr), px(w, h - br), px(w - br, h), px(bl, h), px(0, h - bl), px(0, tl),
    ].join(',')})`;
    el.style.transform = `translate(${(x * k).toFixed(1)}px,${(y * k).toFixed(1)}px)`;
    el.style.width = `${(w * k).toFixed(1)}px`;
    el.style.height = `${(h * k).toFixed(1)}px`;
    el.style.borderRadius = r ? `${(r * k).toFixed(1)}px` : '0';
    // `brightness` is what buys the type its contrast, so the CANVAS ink above
    // can stay genuinely translucent. Dropping the ink alone would have put
    // white numerals on a sunlit sky; darkening the plate behind them instead
    // keeps the contrast and still lets the world read through.
    const f = `blur(${(blur * k).toFixed(1)}px) saturate(1.16) brightness(${PANEL_DIM})`;
    el.style.backdropFilter = f;
    el.style.webkitBackdropFilter = f;
    el.style.display = 'block';
    this._glassUsed.add(id);
  }

  /**
   * A frosted panel: DOM blur behind, translucent tint + hairline edge on the
   * canvas, optional coloured accent rule along the top.
   *
   * WHY THE SHADOW IS MASKED. A canvas shadow is painted behind the WHOLE
   * shape, not just outside it — so the old single shadowed fill stacked 0.55
   * of flat black *under* an already 0.70-alpha wash, and every panel came out
   * effectively opaque (measured: the timing block over open sky and the
   * minimap over dark tarmac landed within 0.5 L of each other, which is the
   * definition of "pasted on"). The shadow is now drawn through an even-odd
   * clip of (bleed rect XOR body), so only the halo outside the panel survives
   * and the body's own alpha is the alpha you asked for.
   */
  _panel(id, x, y, w, h, o = {}) {
    const c = this.ctx;
    const cut = o.cut ?? { br: LAYOUT.cut };
    const alpha = o.alpha ?? 1;
    const r = o.radius ?? PANEL_R;
    this._glass(id, x, y, w, h, cut, o.blur ?? PANEL_BLUR, r);
    const body = this._path(x, y, w, h, cut, r);
    c.save();
    c.globalAlpha = alpha;

    // ── cast shadow, outside the silhouette only
    const ring = new Path2D();
    ring.rect(x - 24, y - 24, w + 48, h + 48);
    ring.addPath(body);
    c.save();
    c.clip(ring, 'evenodd');
    c.shadowColor = 'rgba(0,0,0,0.52)';
    c.shadowBlur = 8;
    c.shadowOffsetY = 2;
    c.fillStyle = '#000';
    c.fill(body);
    c.restore();

    // ── body
    if (o.flat) {
      c.fillStyle = o.fill ?? 'rgba(13,17,24,0.66)';
    } else {
      const g = c.createLinearGradient(0, y, 0, y + h);
      g.addColorStop(0, o.top ?? 'rgba(14,19,28,0.55)');
      g.addColorStop(1, o.bottom ?? 'rgba(4,7,12,0.71)');
      c.fillStyle = g;
    }
    c.fill(body);

    // Inner top highlight: a 1px lift that reads as a bevelled edge. A `flat`
    // panel skips it AND the gradient — a bevel plus a light-to-dark wash is the
    // one treatment this HUD does not otherwise use anywhere, so a panel wearing
    // it reads as a button from a different game.
    c.save();
    c.clip(body);
    if (!o.flat) {
      c.fillStyle = 'rgba(255,255,255,0.13)';
      c.fillRect(x, y, w, this._dev(1));
    }
    if (o.accent) {
      c.fillStyle = o.accent;
      if (o.accentSide === 'left') c.fillRect(x, y, o.accentH ?? 3, h);
      else c.fillRect(x, y, w, o.accentH ?? 2);
    }
    c.restore();
    c.strokeStyle = o.edge ?? C.edge;
    c.lineWidth = this._dev(1);
    c.stroke(this._path(x + this._dev(0.5), y + this._dev(0.5), w - this._dev(1), h - this._dev(1), cut, r));
    c.restore();
  }

  _text(str, x, y, o = {}) {
    const c = this.ctx;
    const size = o.size ?? LABEL_SIZE;
    c.save();
    x = this._snap(x); y = this._snap(y);
    if (o.slant) {
      c.translate(x, y);
      c.transform(1, 0, -Math.tan((o.slant * Math.PI) / 180), 1, 0, 0);
      x = 0; y = 0;
    }
    c.font = `${o.weight ?? 600} ${size}px ${o.font ?? F_UI}`;
    c.textAlign = o.align ?? 'left';
    c.textBaseline = o.baseline ?? 'middle';
    c.letterSpacing = `${o.spacing ?? 0}px`;
    if (o.shadow) {
      c.shadowColor = o.shadow;
      c.shadowBlur = o.shadowBlur ?? 6;
      c.shadowOffsetY = o.shadowY ?? 1;
    }
    if (o.glow) { c.shadowColor = o.glow; c.shadowBlur = o.glowBlur ?? 14; }
    c.fillStyle = o.colour ?? C.text;
    c.fillText(str, x, y);
    c.restore();
    c.letterSpacing = '0px';
  }

  _measure(str, o = {}) {
    const c = this.ctx;
    c.save();
    c.font = `${o.weight ?? 600} ${o.size ?? LABEL_SIZE}px ${o.font ?? F_UI}`;
    c.letterSpacing = `${o.spacing ?? 0}px`;
    const w = c.measureText(str).width;
    c.restore();
    return w;
  }

  /** All-caps label. Floored at LABEL_SIZE, tracking capped at LABEL_TRACK. */
  _label(str, x, y, o = {}) {
    this._text(str, x, y, {
      size: Math.max(LABEL_SIZE, o.size ?? LABEL_SIZE), weight: 700,
      colour: o.colour ?? C.faint,
      spacing: Math.min(LABEL_TRACK, o.spacing ?? LABEL_TRACK),
      align: o.align, font: F_UI, baseline: 'middle',
    });
  }

  _labelW(str, o = {}) {
    return this._measure(str, {
      size: Math.max(LABEL_SIZE, o.size ?? LABEL_SIZE), weight: 700,
      spacing: Math.min(LABEL_TRACK, o.spacing ?? LABEL_TRACK),
    });
  }

  _bar(x, y, w, h, t, colour, o = {}) {
    const c = this.ctx;
    c.fillStyle = o.track ?? 'rgba(255,255,255,0.09)';
    c.fillRect(x, y, w, h);
    const fill = clamp(t, 0, 1) * w;
    if (fill > 0.5) {
      if (o.glow) { c.save(); c.shadowColor = colour; c.shadowBlur = 10; }
      c.fillStyle = colour;
      c.fillRect(x, y, fill, h);
      if (o.glow) c.restore();
    }
  }

  // ── timing tower ──────────────────────────────────────────────────────────

  /**
   * Five rows around the player, plus the leader — which is the whole of what a
   * world feed shows between full-tower stings. Returns its height so the
   * caller can stack under it.
   */
  _tower(x, y, race, playerIndex, dt) {
    const c = this.ctx;
    const w = LAYOUT.towerW;
    const rowH = LAYOUT.towerRow;
    const headH = LAYOUT.towerHead;
    const standings = race.standings ?? [];
    const n = standings.length;

    // The window: the player plus two either side, clamped into the field, with
    // the leader always present (broadcast never drops P1).
    const win = LAYOUT.towerRows;
    let rows = standings;
    let split = -1;
    if (n > win + 1) {
      const p = Math.max(0, standings.findIndex((s) => s.index === playerIndex));
      const a = clamp(p - ((win - 1) >> 1), 0, n - win);
      rows = standings.slice(a, a + win);
      if (a > 0) { rows = [standings[0], ...rows]; split = a > 1 ? 0 : -1; }
    }
    const colH = LAYOUT.towerCol;
    const bodyH = rows.length * rowH + 5;
    const cut = { br: LAYOUT.cut };

    this._panel('tower', x, y, w, headH + colH + bodyH, { cut, top: 'rgba(15,20,28,0.55)', bottom: 'rgba(5,8,13,0.72)' });

    // Header — the lap counter lives HERE and nowhere else on the HUD.
    // Clipped to a region that runs PAST the header's bottom edge, so the panel
    // radius rounds the two corners it shares with the panel and the two that
    // are interior stay square.
    c.save();
    this._shape(x, y, w, headH + 20, {}, PANEL_R);
    c.clip();
    const hg = c.createLinearGradient(x, 0, x + w, 0);
    hg.addColorStop(0, 'rgba(196,32,44,0.92)');
    hg.addColorStop(0.62, 'rgba(120,16,26,0.52)');
    hg.addColorStop(1, 'rgba(10,14,20,0.18)');
    c.fillStyle = hg;
    c.fillRect(x, y, w, headH);
    c.restore();
    this._text('APEX GP', x + 11, y + headH / 2, { size: 14, weight: 700, spacing: 1.0, colour: '#ffffff' });

    const lapStr = `${race.lap ?? 1}`;
    const totStr = `/${race.totalLaps ?? 1}`;
    let cursor = x + w - 11;
    this._text(totStr, cursor, y + headH / 2 + 1, {
      size: 15, weight: 600, align: 'right', colour: 'rgba(255,255,255,0.62)', font: F_NUM,
    });
    cursor -= this._measure(totStr, { size: 15, font: F_NUM }) + 1;
    this._text(lapStr, cursor, y + headH / 2 + 1, {
      size: 19, weight: 700, align: 'right', font: F_NUM,
    });
    cursor -= this._measure(lapStr, { size: 19, weight: 700, font: F_NUM }) + LAYOUT.U * 0.5;
    this._label('LAP', cursor, y + headH / 2, { align: 'right', colour: 'rgba(255,255,255,0.62)' });

    // Column header. The right-hand number is the INTERVAL to the car in front,
    // not the gap to the leader — unlabelled it reads as a gap column, and a
    // gap column that is not monotonic is impossible, which is what made the
    // tower look invented. One 11 px word removes the ambiguity for good.
    c.fillStyle = 'rgba(255,255,255,0.045)';
    c.fillRect(x + 1, y + headH, w - 2, colH);
    this._hair(x + 1, y + headH + colH - this._dev(1), w - 2, this._dev(1), 'rgba(255,255,255,0.10)');
    this._text('POS', x + 30, y + headH + colH / 2, {
      size: 11, weight: 700, align: 'right', spacing: 0.6, colour: C.faint,
    });
    this._text('DRIVER', x + 48, y + headH + colH / 2, {
      size: 11, weight: 700, spacing: 0.6, colour: C.faint,
    });
    this._text('INTERVAL', x + w - 10, y + headH + colH / 2, {
      size: 11, weight: 700, align: 'right', spacing: 0.6, colour: C.faint,
    });

    c.save();
    this._shape(x, y + headH + colH - 20, w, bodyH + 20, { br: LAYOUT.cut }, PANEL_R);
    c.clip();

    const top = y + headH + colH + 3;
    const gapNums = rows.map((s) => (typeof s.gap === 'number' ? s.gap : parseGap(s.gapText)));

    // Row animation: rows chase their slot, and flash on a place change.
    const order = [];
    for (let i = 0; i < rows.length; i++) {
      const e = rows[i];
      const targetY = top + i * rowH;
      let r = this._rows.get(e.index);
      if (!r) {
        r = { y: targetY, pos: e.position ?? i + 1, flash: 0, dir: 0, seen: this.time };
        this._rows.set(e.index, r);
      }
      // A row that has just scrolled into the window must not fly in from its
      // old slot — snap it, then animate only genuine position changes.
      if (this.time - r.seen > 0.5) r.y = targetY;
      r.seen = this.time;
      const pos = e.position ?? i + 1;
      if (r.pos !== pos) {
        r.dir = pos < r.pos ? 1 : -1;
        r.flash = 1;
        r.pos = pos;
      }
      r.y = approach(r.y, targetY, 13, dt);
      if (Math.abs(r.y - targetY) < 0.05) r.y = targetY;
      r.flash = Math.max(0, r.flash - dt / 2.4);
      order.push({ e, r, i, gap: gapNums[i], prev: i > 0 ? gapNums[i - 1] : 0 });
    }
    // Moving rows draw last so they pass over their neighbours cleanly.
    order.sort((a, b) => (a.r.flash > 0 ? 1 : 0) - (b.r.flash > 0 ? 1 : 0));
    for (const item of order) this._towerRow(x, item, w, rowH, playerIndex);

    // A non-contiguous window gets an explicit break, so P1 over P6 never reads
    // as "the leader is one place ahead of me".
    if (split >= 0) {
      const by = top + rowH - 1.5;
      c.fillStyle = 'rgba(255,255,255,0.16)';
      for (let dx = 6; dx < w - 6; dx += 6) c.fillRect(x + dx, this._snap(by), 3, this._dev(1));
    }
    c.restore();

    return headH + colH + bodyH;
  }

  _towerRow(x, { e, r, i, gap, prev }, w, rowH, playerIndex) {
    const c = this.ctx;
    const ry = this._snap(r.y);
    const isPlayer = e.index === playerIndex;
    const colour = e.colour ?? '#888';
    const mid = ry + rowH / 2;

    // Row plate.
    c.fillStyle = isPlayer ? 'rgba(255,255,255,0.13)' : i % 2 ? 'rgba(255,255,255,0.022)' : 'rgba(0,0,0,0.10)';
    c.fillRect(x + 1, ry, w - 2, rowH - 1.5);
    if (isPlayer) {
      const g = c.createLinearGradient(x, 0, x + w * 0.7, 0);
      g.addColorStop(0, hexA(colour, 0.55));
      g.addColorStop(1, hexA(colour, 0));
      c.fillStyle = g;
      c.fillRect(x + 1, ry, w - 2, rowH - 1.5);
    }
    if (r.flash > 0) {
      const f = Math.pow(r.flash, 0.7);
      const g = c.createLinearGradient(x, 0, x + 90, 0);
      g.addColorStop(0, hexA(r.dir > 0 ? C.green : C.red, 0.55 * f));
      g.addColorStop(1, hexA(r.dir > 0 ? C.green : C.red, 0));
      c.fillStyle = g;
      c.fillRect(x + 1, ry, w - 2, rowH - 1.5);
    }

    // Team colour flash — dark gutter behind it so dark liveries still read.
    c.fillStyle = 'rgba(255,255,255,0.09)';
    c.fillRect(x + 1, ry, 6, rowH - 1.5);
    c.fillStyle = colour;
    c.fillRect(x + 1, ry + 1, 5, rowH - 3.5);

    this._text(String(e.position ?? i + 1), x + 30, mid, {
      size: 15.5, weight: 700, align: 'right', colour: isPlayer ? '#ffffff' : C.text, font: F_NUM,
    });

    // Movement arrow.
    if (r.flash > 0.35) {
      const a = clamp((r.flash - 0.35) * 3.2, 0, 1);
      c.save();
      c.globalAlpha = a;
      c.fillStyle = r.dir > 0 ? C.green : C.red;
      const ax = x + 38, ay = mid;
      c.beginPath();
      if (r.dir > 0) { c.moveTo(ax, ay - 3.6); c.lineTo(ax + 4.4, ay + 2.6); c.lineTo(ax - 4.4, ay + 2.6); }
      else { c.moveTo(ax, ay + 3.6); c.lineTo(ax + 4.4, ay - 2.6); c.lineTo(ax - 4.4, ay - 2.6); }
      c.closePath(); c.fill();
      c.restore();
    }

    this._text(e.code ?? '---', x + 48, mid, {
      size: 15, weight: 700, spacing: 0.6, colour: isPlayer ? '#ffffff' : C.text, font: F_UI,
    });

    // Tyre compound — the same filled disc as the tyre panel's badge.
    const comp = COMPOUNDS[e.compound ?? compoundFor(e.index)] ?? COMPOUNDS.medium;
    this._compound(x + 108, mid, 6.8, comp);

    // DRS / PIT state — only when it is actually happening, as on TV.
    const inPit = e.pit ?? false;
    if (inPit || e.drs) {
      const col = inPit ? C.amber : C.green;
      this._chip(x + 122, ry + 4.5, 28, rowH - 10);
      c.fillStyle = hexA(col, 0.92);
      c.fill();
      this._text(inPit ? 'PIT' : 'DRS', x + 136, mid, {
        size: 10, weight: 700, align: 'center', colour: C.ink, spacing: 0.4,
      });
    }

    // Interval to the car ahead (falls back to the leader gap when unknown).
    let gapText;
    if ((e.position ?? i + 1) === 1) gapText = 'LEADER';
    else if (typeof e.interval === 'number') gapText = `+${e.interval.toFixed(3)}`;
    else if (isFinite(gap) && isFinite(prev)) gapText = `+${Math.max(0, gap - prev).toFixed(3)}`;
    else gapText = e.gapText ?? '--';
    this._text(gapText, x + w - 10, mid, {
      size: 14, weight: (e.position ?? i + 1) === 1 ? 700 : 600, align: 'right', font: F_NUM,
      colour: (e.position ?? i + 1) === 1 || isPlayer ? C.text : C.dim,
    });
  }

  /** The one compound badge: filled disc, dark letter. Tower and tyre panel. */
  _compound(cx, cy, r, comp) {
    const c = this.ctx;
    c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2);
    c.fillStyle = comp.colour; c.fill();
    this._text(comp.letter, cx, cy + 0.5, {
      size: r * 1.45, weight: 700, align: 'center', colour: C.ink,
    });
  }

  // ── bottom cluster ────────────────────────────────────────────────────────

  _cluster(tel, race, playerIndex, dt, flag = 'green') {
    const c = this.ctx;
    const barW = LAYOUT.barW, barH = LAYOUT.barH;
    const barX = Math.round((this.uw - barW) / 2);
    const barY = this.uh - LAYOUT.inset - barH;

    const rpm = tel.rpmNorm ?? 0;
    this._shownRpm = approach(this._shownRpm, rpm, 30, dt);
    const limiter = this._shownRpm > 0.985;

    this._rpmStrip(barX, barY, barW, limiter);

    this._panel('bar', barX, barY, barW, barH, {
      cut: { tl: LAYOUT.cut, tr: LAYOUT.cut },
      top: 'rgba(14,19,27,0.58)', bottom: 'rgba(5,8,13,0.76)',
    });

    const rule = (rx) => this._hair(rx, barY + LAYOUT.U * 2, this._dev(1), barH - LAYOUT.U * 4);

    // ── position + driver, folded INTO the bar (there is no separate POS pill)
    const me = race.standings?.find((s) => s.index === playerIndex);
    const teamCol = me?.colour ?? '#ffffff';
    this._text(String(me?.position ?? 1), barX + 48, barY + 58, {
      size: 46, weight: 700, align: 'right', font: F_NUM, slant: 11, baseline: 'alphabetic',
      shadow: 'rgba(0,0,0,0.55)', shadowBlur: 8,
    });
    c.fillStyle = hexA(teamCol, 0.95);
    c.fillRect(barX + 56, barY + 20, 3, barH - 40);
    this._text(me?.code ?? '---', barX + 66, barY + 43, {
      size: 20, weight: 700, spacing: 0.8, baseline: 'alphabetic',
    });
    if (me?.number != null) {
      this._text(`#${me.number}`, barX + 66, barY + 62, {
        size: 14, weight: 600, font: F_NUM, baseline: 'alphabetic', colour: C.dim,
      });
    }
    rule(barX + 124);

    // ── pedals ───────────────────────────────────────────────────────────────
    // Two labelled horizontal traces, the way a pit-wall trace and every
    // broadcast telemetry inset draw them. The previous pair of 10 px vertical
    // slivers under a single-letter T / B carried the same information in about
    // a tenth of the readable area: at 1080p the fill was six pixels across and
    // the letters were the smallest ink in the frame, so nobody parsed either.
    // The word sits INSIDE the track's left end, which costs no extra width.
    const pedX = barX + 138, pedW = 78;
    this._pedalBar(pedX, barY + 24, pedW, 17, tel.throttle ?? 0, C.green, 'THR');
    this._pedalBar(pedX, barY + 47, pedW, 17, tel.brake ?? 0, C.red, 'BRK');
    rule(barX + 228);

    // ── speed: the cyan group starts here and ends at the gear box
    this._shownSpeed = approach(this._shownSpeed, tel.speedKph ?? 0, 22, dt);
    const spdX = barX + 350;
    this._text(String(Math.round(this._shownSpeed)), spdX, barY + 60, {
      size: 58, weight: 700, align: 'right', font: F_NUM, slant: 11,
      baseline: 'alphabetic', spacing: -0.5, shadow: 'rgba(0,0,0,0.6)', shadowBlur: 10,
    });
    this._label('KM/H', spdX - 1, barY + barH - 16, { align: 'right', colour: hexA(C.cyan, 0.80) });

    // ── gear
    const gear = tel.gear ?? 0;
    const gearStr = gear <= 0 ? (gear === 0 ? 'N' : 'R') : String(gear);
    const gx = barX + 362, gw = 74;
    c.save();
    this._shape(gx, barY + 12, gw, barH - 24, { tl: LAYOUT.cut, br: LAYOUT.cut });
    const gg = c.createLinearGradient(0, barY, 0, barY + barH);
    gg.addColorStop(0, hexA(C.cyan, limiter ? 0.30 : 0.14));
    gg.addColorStop(1, hexA(C.cyan, 0.02));
    c.fillStyle = gg; c.fill();
    c.strokeStyle = hexA(C.cyan, limiter ? 0.9 : 0.42);
    c.lineWidth = this._dev(1); c.stroke();
    c.restore();
    this._text(gearStr, gx + gw / 2 + 4, barY + 65, {
      size: 62, weight: 700, align: 'center', font: F_NUM, slant: 11,
      baseline: 'alphabetic', colour: limiter ? '#ffffff' : C.text,
      glow: limiter ? C.cyan : 'rgba(0,0,0,0.55)', glowBlur: limiter ? 20 : 10,
    });
    rule(barX + 448);

    // ── DRS + ERS + FUEL
    const rX = barX + 462;
    const rW = barW - (rX - barX) - 22;
    // DRS is disabled the moment the race is not green, so the pill must go dark
    // under a yellow / SC / VSC even while the entitlement is still latched — an
    // armed DRS pill under a safety car is a rules error on screen. It reads the
    // RESOLVED flag passed in from `render()`, not `race.flag`: `frame.flag`
    // overrides the session's own, the slot and the wash already honour it, and
    // three pieces of the same overlay disagreeing about the flag is worse than
    // any of them being wrong alone.
    const racing = flag === 'green';
    const drsActive = !!tel.drs && racing;
    const drsAvail = !!tel.drsAvailable && racing;
    this._drsGlow = approach(this._drsGlow, drsActive ? 1 : 0, 12, dt);
    c.save();
    this._chip(rX, barY + 14, 58, 24);
    if (drsActive) {
      c.fillStyle = hexA(C.green, 0.92);
      c.shadowColor = C.green; c.shadowBlur = 18 * this._drsGlow;
      c.fill(); c.shadowBlur = 0;
    } else {
      c.fillStyle = drsAvail ? hexA(C.green, 0.16) : 'rgba(255,255,255,0.04)';
      c.fill();
    }
    c.lineWidth = this._dev(1);
    c.strokeStyle = drsActive ? '#ffffff' : drsAvail ? hexA(C.green, 0.75) : 'rgba(255,255,255,0.13)';
    c.stroke();
    c.restore();
    this._text('DRS', rX + 29, barY + 27, {
      size: 16, weight: 700, align: 'center', spacing: 0.8,
      colour: drsActive ? C.ink : drsAvail ? C.green : 'rgba(230,240,250,0.30)',
    });

    // ── ERS: mode, store, and the per-lap deployment allowance ──────────────
    // Steel, not cyan: cyan is the speed group's. #8fd0ff was a light cyan
    // sitting 40 px from the reserved speed/gear cyan and eating its priority.
    // Deploy is the BRIGHT end of the slate ramp, not a second accent hue;
    // harvest is the one green; holding is steel.
    //
    // The MODE is a real state read off the car, not a driver-selected map this
    // sim does not have: `ersPower` is the MGU-K actually pushing, the harvest
    // test is the same one `vehicle.js` uses, and `ersDeployedLap` is the
    // regulation 4 MJ per lap — which is why the store bar alone was never the
    // whole story and a full battery can still read HOLD.
    const ers = clamp(tel.ers ?? 0, 0, 1);
    this._shownErs = approach(this._shownErs, ers, 10, dt);
    const harvesting = (tel.brake ?? 0) > 0.12 && (tel.speedKph ?? 0) > 45 && ers < 0.995;
    const deploying = !harvesting && ((tel.ersPower ?? 0) > 1000
      || ((tel.throttle ?? 0) > 0.85 && ers > 0.02));
    const ersCol = deploying ? '#a9c6dc' : harvesting ? C.green : C.steel;
    const mode = deploying ? 'DEPLOY' : harvesting ? 'HARVEST' : 'HOLD';

    const mX = rX + 64, mW = rW - 64;
    c.save();
    this._chip(mX, barY + 14, mW, 24);
    c.fillStyle = deploying || harvesting ? hexA(ersCol, 0.14) : 'rgba(255,255,255,0.04)';
    c.fill();
    c.lineWidth = this._dev(1);
    c.strokeStyle = deploying || harvesting ? hexA(ersCol, 0.62) : 'rgba(255,255,255,0.13)';
    c.stroke();
    c.restore();
    this._label('ERS', mX + 10, barY + 27, { colour: C.faint });
    this._text(mode, mX + mW - 9, barY + 27, {
      size: 15, weight: 700, align: 'right', spacing: 0.7,
      colour: deploying || harvesting ? ersCol : hexA(C.slate, 0.62),
    });

    const eX = rX, eY = barY + 46, eW = rW, eH = 12;
    c.fillStyle = 'rgba(0,0,0,0.35)';
    c.fillRect(eX, eY, eW, eH);
    this._bar(eX + 1.5, eY + 1.5, eW - 3, eH - 3, this._shownErs, ersCol, {
      glow: deploying || harvesting, track: 'rgba(255,255,255,0.07)',
    });
    // The per-lap deployment allowance, as a lit ceiling INSIDE the store bar:
    // a hairline at how much of this lap's 4 MJ has already gone.
    const used = clamp(tel.ersDeployedLap ?? 0, 0, 1);
    if (used > 0.01) this._hair(eX + 1.5 + (eW - 3) * used, eY + 1.5, this._dev(1.5), eH - 3, hexA(C.amber, 0.85));
    c.strokeStyle = 'rgba(255,255,255,0.20)'; c.lineWidth = this._dev(1);
    c.strokeRect(eX + 0.5, eY + 0.5, eW - 1, eH - 1);
    for (let i = 1; i < 4; i++) this._hair(eX + (eW * i) / 4, eY + 1.5, this._dev(1), eH - 3, 'rgba(5,8,13,0.85)');
    this._text(`${Math.round(this._shownErs * 100)}%`, eX, barY + barH - 16, {
      size: 15, weight: 700, font: F_NUM, colour: ersCol,
    });

    // ── FUEL. Kilograms is what a pit wall says on the radio; the colour is the
    // margin, so the number carries its own verdict without a second field.
    const fuelKg = tel.fuelKg;
    const margin = tel.fuelLapsMargin;
    const short = isFinite(margin) && margin < 0;
    let fx = rX + rW;
    if (isFinite(fuelKg) && fuelKg > 0) {
      this._label('KG', fx, barY + barH - 16, { size: 11, align: 'right', colour: C.faint });
      fx -= this._labelW('KG', { size: 11 }) + 4;
      const fstr = fuelKg.toFixed(1);
      this._text(fstr, fx, barY + barH - 16, {
        size: 17, weight: 700, align: 'right', font: F_NUM,
        colour: short ? C.amber : C.text,
      });
      fx -= this._measure(fstr, { size: 17, weight: 700, font: F_NUM }) + 6;
    } else {
      this._text('--', fx, barY + barH - 16, {
        size: 17, weight: 700, align: 'right', font: F_NUM, colour: C.faint,
      });
      fx -= this._measure('--', { size: 17, weight: 700, font: F_NUM }) + 6;
    }
    this._label('FUEL', fx, barY + barH - 16, { align: 'right', colour: C.faint });
  }

  /**
   * The shift-light strip: a true annulus (one `arc` stroke per segment, so the
   * outer edge is analytically smooth), on its own dark shelf so it never sits
   * on live scene pixels, ramped green -> amber -> red.
   *
   * LIMITER. The prescription was "all segments flashing violet at the
   * limiter". Taken literally that is wrong for this frame: the `hud` shot is a
   * DRS run in top gear at `rpmNorm` 1.03, i.e. permanently on the limiter, so
   * a whole-strip flash erases the ramp for a third of every second and the
   * showcase capture lands in the ON phase. A real wheel keeps the ramp lit and
   * blinks only the top band — which is also the more glanceable cue, because
   * the violet then means "this end of the strip", not "the strip". So the ramp
   * holds and the last `LIMIT_SEGS` segments blink violet over the top of it.
   */
  _rpmStrip(barX, barY, barW, limiter) {
    const c = this.ctx;
    const cx = barX + barW / 2;
    const R = 1180;
    const chord = Math.min(barW - 200, 360);
    const half = Math.asin(chord / 2 / R);
    // The ARC SAGS at its ends. Offsetting only by a constant put the outer
    // segments inside the bar's top edge, which is what swallowed them.
    const sag = R - Math.sqrt(R * R - (chord / 2) * (chord / 2));
    // The strip TUCKS INTO the panel: its shelf overlaps the bar's top edge by a
    // couple of px, so the two read as one piece of furniture rather than a row
    // of lights hovering over the tarmac.
    const cy = barY + 3 - sag + R;
    const segs = 21;
    const LIMIT_SEGS = 5;
    const segA = (half * 2) / segs;
    const gapA = segA * 0.20;
    const rpm = clamp(this._shownRpm, 0, 1.2);
    const flash = limiter && Math.floor(this.time * 9) % 2 === 0;

    c.save();
    c.lineCap = 'butt';
    // The shelf: a wide, soft, dark stroke under the whole arc extent.
    c.beginPath();
    c.arc(cx, cy, R, -Math.PI / 2 - half - 0.012, -Math.PI / 2 + half + 0.012);
    c.strokeStyle = 'rgba(5,8,13,0.80)';
    c.lineWidth = 21;
    c.shadowColor = 'rgba(0,0,0,0.55)';
    c.shadowBlur = 9;
    c.stroke();
    c.shadowBlur = 0;
    c.strokeStyle = 'rgba(255,255,255,0.09)';
    c.lineWidth = this._dev(1);
    for (const rr of [R - 10, R + 10]) {
      c.beginPath();
      c.arc(cx, cy, rr, -Math.PI / 2 - half - 0.012, -Math.PI / 2 + half + 0.012);
      c.stroke();
    }
    for (let i = 0; i < segs; i++) {
      const p = i / (segs - 1);
      // The strip covers the top of the range: first LED at 45%, last at 99.5%.
      const thr = 0.45 + p * 0.545;
      const lit = rpm >= thr;
      const top = i >= segs - LIMIT_SEGS;
      const col = flash && top ? C.purple
        : !lit ? 'rgba(190,210,230,0.13)'
          : thr < 0.80 ? C.green : thr < 0.92 ? C.amber : C.red;
      c.beginPath();
      c.arc(cx, cy, R, -Math.PI / 2 - half + i * segA + gapA * 0.5, -Math.PI / 2 - half + (i + 1) * segA - gapA * 0.5);
      c.strokeStyle = col;
      c.lineWidth = 11;
      if (lit || (flash && top)) { c.shadowColor = col; c.shadowBlur = 9; } else { c.shadowBlur = 0; }
      c.stroke();
      c.shadowBlur = 0;
    }
    c.restore();
  }

  /**
   * One labelled pedal trace. The word is set INSIDE the left end of the track,
   * in the tyre panel's dark ink where the fill has reached it and in the
   * pedal's own colour where it has not — so the label is legible against both
   * states without a second swatch of screen area.
   */
  _pedalBar(x, y, w, h, t, colour, label) {
    const c = this.ctx;
    const v = clamp(t, 0, 1);
    c.fillStyle = 'rgba(255,255,255,0.07)';
    c.fillRect(x, y, w, h);
    const fw = v * w;
    if (fw > 0.5) {
      c.save();
      c.shadowColor = colour; c.shadowBlur = 8;
      c.fillStyle = colour;
      c.fillRect(x, y, fw, h);
      c.restore();
    }
    // Quarter ticks, so a partial pedal is readable as a fraction — but never
    // through the word. The 25 % tick lands 19.5 px in and `THR` is 20 px wide,
    // so the first tick drew a dark rule straight down the R. A tick the label
    // reaches is simply not drawn: the other three still carry the scale.
    const lw = this._labelW(label, { size: 11 });
    const labelEnd = 5 + lw + 2;
    for (let i = 1; i < 4; i++) {
      const tx = (w * i) / 4;
      if (tx < labelEnd) continue;
      this._hair(x + tx, y + 1, this._dev(1), h - 2, 'rgba(5,8,13,0.45)');
    }
    c.strokeStyle = 'rgba(255,255,255,0.16)'; c.lineWidth = this._dev(1);
    c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

    // THE WORD IS DRAWN TWICE AND SPLIT AT THE FILL EDGE. One colour for the
    // whole label is right at 0 % and at 100 % and wrong at every value in
    // between, which is where a throttle trace spends its life: at 22 % the
    // fill had swallowed `TH` and the label was being painted in the fill's own
    // green on top of it, so the bar read `R`. Dark ink inside the fill, the
    // pedal's colour outside it, clipped at exactly `fw`.
    const half = (colr, cx, cw) => {
      if (cw <= 0.25) return;
      c.save();
      c.beginPath(); c.rect(cx, y, cw, h); c.clip();
      this._text(label, x + 5, y + h / 2 + 0.5, { size: 11, weight: 700, spacing: 0.5, colour: colr });
      c.restore();
    };
    half(C.ink, x, fw);
    half(hexA(colour, 0.95), x + fw, w - fw);
  }

  // ── timing block (lap / sectors / delta) ──────────────────────────────────

  _timing(x, y, race, frame, dt) {
    const c = this.ctx;
    const w = LAYOUT.timingW, h = LAYOUT.timingH;
    const U = LAYOUT.U;
    this._panel('timing', x, y, w, h, { cut: { bl: LAYOUT.cut }, top: 'rgba(16,21,30,0.56)' });

    // Header: the label, and the conditions (the only place they appear).
    this._label('LAP TIME', x + 12, y + 15);
    const cond = String(frame.weather?.label ?? race.weatherLabel ?? 'DRY').toUpperCase();
    this._label(cond, x + w - 12, y + 15, { align: 'right', colour: C.dim });

    // Current lap, the loudest numeral in the block.
    this._text(race.currentLapText ?? '--:--.---', x + w - 12, y + 48, {
      size: 34, weight: 700, align: 'right', font: F_NUM, slant: 8,
      baseline: 'alphabetic', shadow: 'rgba(0,0,0,0.5)',
    });

    // ── sector strip ────────────────────────────────────────────────────────
    // ONE LAP RECORD, and it is the lap in progress. Splits already banked read
    // in their status colour; the sector being driven runs live; the ones still
    // to come are dashes. That is the only arrangement in which the three cells
    // add up to the big numeral directly above them — mixing in the previous
    // lap's splits (which is what used to happen) put three numbers on screen
    // whose sum matched neither LAST nor BEST.
    //
    // A RUNNING SECTOR IS NOT A SECTOR TIME, and it must never be able to read
    // as one. A live S2 of 15.594 beside a banked S1 of 28.237 is an impossible
    // *timesheet* and a perfectly ordinary *stopwatch*; drawn in the same white
    // at the same weight, a reader has no way to tell which they are looking at.
    // So the live cell now differs on four axes at once — its tag is lit and
    // carries a running caret, its numeral is dim slate instead of white, its
    // bar is a hollow outline with a bright leading edge rather than a solid
    // fill, and it is the only cell that moves. Banked cells alone are solid.
    //
    // Every cell that HAS a time gets a bar, filled against the longest sector
    // of the lap, so a bar length is a real comparison between sectors rather
    // than a binary "banked / not banked" that reads as broken rendering.
    const st = race.sectorStatus ?? ['', '', ''];
    const times = race.sectorTimes;
    const liveIdx = race.sectorIndex ?? -1;
    const liveT = race.sectorLive ?? 0;
    const val = (i) => (i === liveIdx && liveT > 0.05 ? liveT
      : isFinite(times?.[i]) && times[i] > 0 ? times[i] : 0);
    // The reference is the longest BANKED split, so the bars already on screen
    // hold still while the live one grows past them (and clamps full).
    let ref = 0;
    for (let i = 0; i < 3; i++) if (isFinite(times?.[i]) && times[i] > 0) ref = Math.max(ref, times[i]);
    if (ref <= 0) ref = liveIdx >= 0 ? val(liveIdx) : 0;
    const cell = (w - 24 - U) / 3;
    const sby = y + 71;
    for (let i = 0; i < 3; i++) {
      const sx = x + 12 + i * (cell + U / 2);
      const banked = isFinite(times?.[i]) && times[i] > 0;
      const running = !banked && i === liveIdx && liveT > 0.05;
      const t = val(i);

      // Tag. The live one is white with a caret; everything else is faint or
      // carries its banked status colour.
      const tagCol = banked ? sectorColour(st[i]) : running ? 'rgba(255,255,255,0.92)' : C.faint;
      let tagX = sx + 1;
      if (running) {
        c.save();
        c.fillStyle = tagCol;
        c.globalAlpha = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(this.time * 5.2));
        c.beginPath();
        c.moveTo(tagX, y + 58.5); c.lineTo(tagX + 4.4, y + 62); c.lineTo(tagX, y + 65.5);
        c.closePath(); c.fill();
        c.restore();
        tagX += 6.5;
      }
      this._text(`S${i + 1}`, tagX, y + 62, {
        size: 11, weight: 700, spacing: 0.4, colour: tagCol, baseline: 'middle',
      });

      // Numeral. Slate for the stopwatch, status colour for a banked split.
      //
      // AND THE STOPWATCH IS QUOTED TO A TENTH, NOT A THOUSANDTH. Colour,
      // weight and a caret all survive a glance badly; PRECISION does not. A
      // timing screen prints a split to the millisecond because the split is
      // final — three decimals ARE the claim "this sector is over". So the live
      // cell now reads `15.6` beside a banked `28.237`, and the two can no
      // longer be mistaken for entries in the same column, which is the whole
      // of what made a 15.594 next to a 28.237 read as an impossible timesheet
      // rather than as an ordinary clock a third of the way through S2.
      this._text(t <= 0 ? '--.---' : running ? t.toFixed(1) : t.toFixed(3), sx + cell - 2, y + 66, {
        size: 14, weight: 700, align: 'right', font: F_NUM, baseline: 'alphabetic',
        colour: banked ? sectorColour(st[i]) : running ? hexA(C.slate, 0.78) : C.faint,
      });

      c.fillStyle = 'rgba(255,255,255,0.10)';
      c.fillRect(sx, sby, cell, 4);
      if (t > 0 && ref > 0) {
        const fw = cell * clamp(t / ref, 0.02, 1);
        if (banked) {
          c.fillStyle = sectorColour(st[i]);
          c.fillRect(sx, sby, fw, 4);
        } else {
          // Hollow + a lit leading edge: a bar that is still being drawn.
          c.fillStyle = hexA(C.slate, 0.20);
          c.fillRect(sx, sby, fw, 4);
          c.fillStyle = 'rgba(255,255,255,0.85)';
          c.fillRect(this._snap(sx + fw - 1.5), sby, 1.5, 4);
        }
      }
    }

    this._hair(x + 12, y + 86, w - 24, this._dev(1));

    // LAST / BEST. This is the only place either appears on the HUD.
    const bestT = parseTime(race.bestLapText);
    const hasBest = isFinite(bestT);
    const sessionBest = race.bestOverall;
    const isSessionBest = hasBest && isFinite(sessionBest) && Math.abs(bestT - sessionBest) < 1e-3;
    this._label('LAST', x + 12, y + 102);
    this._text(race.lastLapText ?? '--:--.---', x + w - 12, y + 102, {
      size: 17, weight: 600, align: 'right', font: F_NUM, baseline: 'middle',
      colour: isFinite(parseTime(race.lastLapText)) ? C.text : C.faint,
    });
    this._label('BEST', x + 12, y + 124);
    this._text(race.bestLapText ?? '--:--.---', x + w - 12, y + 124, {
      size: 17, weight: 700, align: 'right', font: F_NUM, baseline: 'middle',
      colour: !hasBest ? C.faint : isSessionBest ? C.purple : C.green,
    });

    // Delta to the driver's own best, as a signed number and a centre-zero rule
    // along the panel's bottom edge.
    const delta = race.delta ?? 0;
    this._deltaSmooth = approach(this._deltaSmooth, delta, 6, dt);
    const d = this._deltaSmooth;
    const live = isFinite(d) && (race.deltaText || Math.abs(d) > 1e-4);
    const col = d < 0 ? C.green : C.red;
    this._label('DELTA', x + 12, y + h - 17);
    if (live) {
      this._text(`${d >= 0 ? '+' : '-'}${Math.abs(d).toFixed(3)}`, x + w - 12, y + h - 16, {
        size: 19, weight: 700, align: 'right', font: F_NUM, baseline: 'middle', colour: col,
      });
    } else {
      this._text('--.---', x + w - 12, y + h - 16, {
        size: 19, weight: 700, align: 'right', font: F_NUM, baseline: 'middle', colour: C.faint,
      });
    }
    const bx = x + 12, bw = w - 24, by = y + h - 6;
    c.fillStyle = 'rgba(255,255,255,0.07)';
    c.fillRect(bx, by, bw, 3);
    if (live) {
      const mid = bx + bw / 2;
      const t = clamp(d / 1.5, -1, 1);
      c.fillStyle = hexA(col, 0.92);
      if (t >= 0) c.fillRect(mid, by, (bw / 2) * t, 3);
      else c.fillRect(mid + (bw / 2) * t, by, (bw / 2) * -t, 3);
    }
    this._hair(bx + bw / 2, by - 1, this._dev(1), 5, 'rgba(255,255,255,0.7)');
    return h;
  }

  // ── tyres ─────────────────────────────────────────────────────────────────

  /**
   * Four corners. ONE tyre silhouette each — a rounded slab seen head-on, the
   * way a tyre actually presents itself — carrying ONE temperature fill, with
   * the wear ring stroked around its outside and the numeral set in white on the
   * dark panel beside it.
   *
   * WHY IT IS NOT THREE BANDS ANY MORE. The three-band version had a 1 px seam
   * through the middle of every corner, so a tyre read as three swatches; the
   * digits sat in dark ink on saturated green, straddling a seam; and 4 x 74 x 32
   * px of the most chromatic pixels in the frame made tyre temperature — the
   * least important number on the HUD — out-shout the speed, the gear and DRS.
   * The fill area is now ~1/6th of that and the ramp is desaturated 40 %
   * (`TEMP_STOPS`), so it reads as a status colour rather than a highlight, and
   * the inference the bands used to carry (camber, shoulder loading) is folded
   * into the single surface temperature the fill shows.
   *
   * The numeral is the CORE temperature — what a pit wall quotes, and what stays
   * inside the 90-110 window on a straight while the surface cools into the air.
   */
  _tyres(x, y, tel, race) {
    const c = this.ctx;
    const w = LAYOUT.tyreW, h = LAYOUT.tyreH;
    this._panel('tyres', x, y, w, h, { cut: { tl: LAYOUT.cut } });

    const compound = tel.compound ?? 'soft';
    const comp = COMPOUNDS[compound] ?? COMPOUNDS.soft;
    this._label('TYRES', x + 12, y + 15);
    this._compound(x + w - 22, y + 15, 8.5, comp);
    const age = tel.tyreAge ?? Math.max(0, (race.lap ?? 1) - 1);
    this._text(`${age}L`, x + w - 36, y + 15, {
      size: 15, weight: 700, align: 'right', font: F_NUM, colour: C.dim,
    });

    const wear = tel.tyreWear ?? this._estimateWear(tel);
    const cw = (w - 24 - LAYOUT.U) / 2, ch = 38, gy = 2;
    const ox = x + 12;
    const oy = y + 28;

    // Steering tells us which shoulder the corner is loading (positive steer =
    // right, so a right-hander loads the car's LEFT shoulders); it biases the
    // surface temperature of the corner that is doing the work.
    const shoulder = -clamp((tel.steer ?? 0) * 2.4, -1, 1);
    const work = clamp(Math.abs(tel.gLat ?? 0) / 3.2, 0, 1);

    for (let i = 0; i < 4; i++) {
      const tx = ox + (i % 2) * (cw + LAYOUT.U);
      const ty = oy + (i < 2 ? 0 : ch + gy);
      const core = tel.tyreCore?.[i] ?? tel.tyreTemp?.[i] ?? 92;
      const longHeat = i < 2 ? (tel.brake ?? 0) * 5 : (tel.throttle ?? 0) * 4;
      const load = clamp(tel.tyreLoad?.[i] ?? 1, 0, 2);
      const side = i % 2 === 0 ? 1 : -1;             // which side loads first
      const surf = core + longHeat + (load - 1) * 4 + side * shoulder * work * 9;
      const life = 1 - clamp(wear[i] ?? 0, 0, 1);

      this._tyreGlyph(tx + 3, ty + 2, 21, ch - 6, tyreTempColour(surf), life);

      this._text(CORNERS[i], tx + 34, ty + 10, {
        size: 12, weight: 700, spacing: 0.7, colour: C.faint,
      });
      const temp = String(Math.round(core));
      this._text(temp, tx + 34, ty + 33, {
        size: 21, weight: 700, font: F_NUM, baseline: 'alphabetic', colour: C.text,
      });
      // The degree mark is DRAWN, not set. At 13 px a condensed grotesque's `°`
      // renders as a 2 px blob sitting near the x-height, which at 1080p is
      // indistinguishable from a full stop — `85°` read as `85.`. A stroked ring
      // at cap height is font-independent and unambiguous at any size.
      const degW = this._measure(temp, { size: 21, weight: 700, font: F_NUM });
      const dcx = this._snap(tx + 37.5 + degW), dcy = this._snap(ty + 33 - 12.6);
      c.beginPath();
      c.arc(dcx, dcy, 2.4, 0, Math.PI * 2);
      c.strokeStyle = hexA(C.slate, 0.72);
      c.lineWidth = Math.max(this._dev(1), 1.3);
      c.stroke();
    }
  }

  /**
   * One tyre: a rounded slab of rubber with a temperature fill, and the wear
   * ring stroked around its outside as a dashed perimeter (dash = life, gap =
   * the rest, so the ring literally empties as the tyre wears out).
   */
  _tyreGlyph(x, y, w, h, tempCol, life) {
    const c = this.ctx;
    const r = 6;
    const round = (rx, ry, rw, rh, rr) => {
      const p = new Path2D();
      p.moveTo(rx + rr, ry);
      p.lineTo(rx + rw - rr, ry); p.arcTo(rx + rw, ry, rx + rw, ry + rr, rr);
      p.lineTo(rx + rw, ry + rh - rr); p.arcTo(rx + rw, ry + rh, rx + rw - rr, ry + rh, rr);
      p.lineTo(rx + rr, ry + rh); p.arcTo(rx, ry + rh, rx, ry + rh - rr, rr);
      p.lineTo(rx, ry + rr); p.arcTo(rx, ry, rx + rr, ry, rr);
      p.closePath();
      return p;
    };

    // Carcass + temperature fill. A vertical shade keeps it reading as rubber
    // rather than as a flat swatch, without adding chroma.
    const body = round(x, y, w, h, r);
    const g = c.createLinearGradient(x, y, x + w, y);
    g.addColorStop(0, hexA(tempCol, 0.55));
    g.addColorStop(0.42, hexA(tempCol, 0.98));
    g.addColorStop(1, hexA(tempCol, 0.62));
    c.save();
    c.fillStyle = 'rgba(6,9,13,0.9)';
    c.fill(body);
    c.fillStyle = g;
    c.fill(body);
    // Tread grooves: two dark hairlines down the crown. They cost nothing and
    // they are what stops the shape reading as a rounded rectangle.
    c.clip(body);
    c.fillStyle = 'rgba(6,10,14,0.30)';
    c.fillRect(x + w * 0.36, y, this._dev(1), h);
    c.fillRect(x + w * 0.64, y, this._dev(1), h);
    c.restore();

    // Wear ring, outside the carcass. Dash length = the tyre's remaining life
    // along the perimeter; the rest of the ring is the dark track.
    const ir = 2.5;
    const ring = round(x - ir, y - ir, w + ir * 2, h + ir * 2, r + ir);
    const perim = 2 * (w + ir * 2 - 2 * (r + ir)) + 2 * (h + ir * 2 - 2 * (r + ir)) + 2 * Math.PI * (r + ir);
    c.save();
    c.lineWidth = this._dev(1.6);
    c.strokeStyle = 'rgba(255,255,255,0.10)';
    c.stroke(ring);
    // A fresh tyre is not news: the ring only brightens as it is used up.
    c.strokeStyle = life < 0.2 ? C.red : life < 0.4 ? C.amber : hexA(C.slate, 0.28 + (1 - life) * 0.5);
    c.setLineDash([perim * clamp(life, 0, 1), perim]);
    c.lineDashOffset = 0;
    c.stroke(ring);
    c.setLineDash([]);
    c.restore();
  }

  _estimateWear(tel) {
    const slipR = tel.slipRatio, slipA = tel.slipAngle;
    for (let i = 0; i < 4; i++) {
      const s = Math.abs(slipR?.[i] ?? 0) + Math.abs(slipA?.[i] ?? 0) * 1.6;
      this._wear[i] = clamp(this._wear[i] + (0.0004 + s * 0.0022) / 60, 0, 1);
    }
    return this._wear;
  }

  // ── minimap ───────────────────────────────────────────────────────────────

  /**
   * No title, no footer, no glow. A 2-device-pixel trace, DRS zones stroked
   * UNDER it so a dot pile can never hide them, and a de-clutter rule that fans
   * a train of cars out perpendicular to the track instead of stacking them
   * into a bead necklace.
   */
  _minimap(x, y, size, cars, playerIndex, race) {
    const c = this.ctx;
    const circuit = this.circuit;
    if (!circuit) return;
    if (!this._miniPath || this._miniSize !== size) this._buildMiniPath(size);

    this._panel('mini', x, y, size, size, { cut: { tr: LAYOUT.cut } });

    c.save();
    c.translate(this._snap(x), this._snap(y));
    c.lineJoin = 'round'; c.lineCap = 'round';

    // Casing, DRS zones, then the trace on top. The DRS band is stroked from
    // the SAME spline at a narrower width than the casing, so its edges are
    // parallel to the road instead of overshooting it, and butt-capped so it
    // stops exactly at the detection/end line.
    c.strokeStyle = 'rgba(4,7,11,0.82)'; c.lineWidth = this._dev(8); c.stroke(this._miniPath);
    c.save();
    c.lineCap = 'butt';
    for (const path of this._miniDrs) {
      c.strokeStyle = hexA(C.steel, 0.95);
      c.lineWidth = this._dev(6);
      c.stroke(path);
    }
    c.restore();

    // The trace, split at the sector boundaries and coloured by the player's
    // sector status — which is how the map carries purple/green/yellow without
    // a second widget. An unset sector is just the road.
    const st = race?.sectorStatus ?? ['', '', ''];
    for (let i = 0; i < this._miniSectorPaths.length; i++) {
      c.strokeStyle = st[i] ? sectorColour(st[i]) : 'rgba(216,226,235,0.94)';
      c.lineWidth = this._dev(2);
      c.stroke(this._miniSectorPaths[i]);
    }

    // Start/finish as a single bar; sector boundaries as short perpendicular
    // ticks (the local `right` vector, which is perpendicular by construction),
    // each with its S1/S2/S3 tag set outboard of the trace.
    for (let i = 0; i < this._miniSectorMarks.length; i++) {
      const m = this._miniSectorMarks[i];
      const len = i === 0 ? 6 : 4.5;
      c.strokeStyle = i === 0 ? '#ffffff' : 'rgba(255,255,255,0.5)';
      c.lineWidth = this._dev(i === 0 ? 2 : 1);
      c.beginPath();
      c.moveTo(m.x - m.nx * len, m.y - m.ny * len);
      c.lineTo(m.x + m.nx * len, m.y + m.ny * len);
      c.stroke();
      const lx = m.x + m.nx * m.out * (len + 8);
      const ly = m.y + m.ny * m.out * (len + 8);
      this._text(`S${i + 1}`, lx, ly, {
        size: 10, weight: 700, align: 'center', spacing: 0.3,
        colour: st[i] ? sectorColour(st[i]) : 'rgba(222,232,242,0.52)',
        shadow: 'rgba(4,7,11,0.9)', shadowBlur: 3, shadowY: 0,
      });
    }

    // Dots. Base positions first, then fan out any train.
    const R = 3.0;
    const posOf = race?.standings?.length
      ? new Map(race.standings.map((s) => [s.index, s.position ?? 99])) : null;
    const dots = [];
    for (const car of cars ?? []) {
      const p = circuit.sampleAt(car.s);
      const nx = p.right.x, nz = p.right.z;
      const nl = Math.hypot(nx, nz) || 1;
      dots.push({
        s: car.s,
        bx: this._mini.ox + (p.position.x + p.right.x * car.lateral) * this._mini.scale,
        by: this._mini.oy + (p.position.z + p.right.z * car.lateral) * this._mini.scale,
        nx: nx / nl, ny: nz / nl,
        me: car.index === playerIndex,
        colour: car.colour,
        pos: posOf?.get(car.index) ?? 99,
      });
    }
    dots.sort((a, b) => a.s - b.s);
    // De-clutter, BOUNDED. An unbounded ladder (`tier++` forever) is worse than
    // the bead necklace it replaces: a 14-car train threw dots 40 px clear of
    // the trace and the map read as confetti. The fan is therefore a 5-slot
    // cycle — centre, +1, -1, +2, -2 — so no dot is ever more than
    // `2 * FAN` px off the road, and a longer train simply overlaps, which is
    // what a real broadcast map does.
    const FAN = R * 1.15;
    const OFFSET = [0, 1, -1, 2, -2];
    let tier = 0, prev = null;
    for (const d of dots) {
      if (prev && Math.hypot(d.bx - prev.bx, d.by - prev.by) < R * 1.5) tier++;
      else tier = 0;
      const mag = OFFSET[tier % OFFSET.length] * FAN;
      d.x = d.bx + d.nx * mag;
      d.y = d.by + d.ny * mag;
      prev = d;
    }
    // Z-ORDER BY POSITION. A dozen dots in a train overlap however hard the fan
    // works, so the one that ends up on top has to be the one that matters:
    // draw from the back of the field forwards, and the player last of all.
    const painted = dots.slice().sort((a, b) => b.pos - a.pos);
    for (const d of painted) {
      if (d.me) continue;
      c.beginPath(); c.arc(d.x, d.y, R, 0, Math.PI * 2);
      c.fillStyle = d.colour; c.fill();
      c.strokeStyle = 'rgba(4,7,11,0.92)'; c.lineWidth = this._dev(1.5); c.stroke();
    }
    const meDot = dots.find((d) => d.me);
    if (meDot) {
      c.beginPath(); c.arc(meDot.x, meDot.y, R * 1.6, 0, Math.PI * 2);
      c.fillStyle = '#ffffff'; c.fill();
      c.strokeStyle = '#ffffff'; c.lineWidth = this._dev(2);
      c.beginPath(); c.arc(meDot.x, meDot.y, R * 1.6 + this._dev(2), 0, Math.PI * 2);
      c.stroke();
    }
    c.restore();
  }

  _buildMiniPath(size) {
    const circuit = this.circuit;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const s of circuit.samples) {
      minX = Math.min(minX, s.position.x); maxX = Math.max(maxX, s.position.x);
      minZ = Math.min(minZ, s.position.z); maxZ = Math.max(maxZ, s.position.z);
    }
    const pad = 18;
    const avail = size - pad * 2;
    const scale = Math.min(avail / (maxX - minX), avail / (maxZ - minZ));
    this._mini = {
      scale,
      ox: pad + (avail - (maxX - minX) * scale) / 2 - minX * scale,
      oy: pad + (avail - (maxZ - minZ) * scale) / 2 - minZ * scale,
    };
    // NEVER SNAP THE VERTICES. At map scale (~0.03 px/m) consecutive circuit
    // samples land 0.06 px apart, so rounding each one to a device pixel
    // quantised the curve into a staircase — that, and not the sample density,
    // is what made the outline read as a faceted polyline with straight kinks.
    // The whole map is snapped once, at the translate in `_minimap`.
    const P = (s) => [
      this._mini.ox + s.position.x * this._mini.scale,
      this._mini.oy + s.position.z * this._mini.scale,
    ];

    // Decimate to ~0.7 px spacing (a few hundred points instead of a few
    // thousand) and then run the stroke through midpoint quadratics, which is a
    // C1 spline through the decimated set: no kinks, and cheap to stroke.
    const pts = [];
    for (const s of circuit.samples) {
      const p = P(s);
      p[2] = s.s;                                   // keep the arc length for idxOf
      const q = pts[pts.length - 1];
      if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 0.7) pts.push(p);
    }
    const n = pts.length;
    /** Smooth stroke over pts[i0..i1] (inclusive, wrapping); `loop` closes it. */
    const spline = (i0, i1, loop) => {
      const path = new Path2D();
      const at = (i) => pts[((i % n) + n) % n];
      const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const count = ((i1 - i0 + n) % n) + 1;
      if (count < 2) return path;
      const start = loop ? mid(at(i0 - 1), at(i0)) : at(i0);
      path.moveTo(start[0], start[1]);
      for (let k = loop ? 0 : 1; k < count - 1; k++) {
        const cur = at(i0 + k), nxt = at(i0 + k + 1);
        const m = mid(cur, nxt);
        path.quadraticCurveTo(cur[0], cur[1], m[0], m[1]);
      }
      const last = at(i1);
      if (loop) path.closePath();
      else path.lineTo(last[0], last[1]);
      return path;
    };
    /** Circuit distance -> nearest index in the decimated point list. */
    const idxOf = (s) => {
      const L = circuit.length || 1;
      const target = circuit.wrapS ? circuit.wrapS(s) : ((s % L) + L) % L;
      let lo = 0, hi = n - 1;
      while (lo < hi) {
        const m = (lo + hi) >> 1;
        if (pts[m][2] < target) lo = m + 1; else hi = m;
      }
      return lo % n;
    };

    this._miniPath = spline(0, n - 1, true);

    this._miniDrs = (circuit.drsZones ?? []).map((z) => spline(idxOf(z.startS), idxOf(z.endS), false));

    const starts = circuit.sectorStarts ?? [0];
    this._miniSectorPaths = starts.map((s, i) => {
      const a = idxOf(s);
      const b = (idxOf(starts[(i + 1) % starts.length]) - 1 + n) % n;
      return spline(a, b, false);
    });

    // The tick normal is the circuit's `right`, which points inboard on half the
    // lap. A tag hung off it lands ON the trace (or on the dot train) whenever
    // it does — so the LABEL always goes to the side facing away from the middle
    // of the map, which is empty by construction.
    this._miniSectorMarks = starts.map((s) => {
      const sm = circuit.sampleAt(s);
      const [px, py] = P(sm);
      const len = Math.hypot(sm.right.x, sm.right.z) || 1;
      const nx = sm.right.x / len, ny = sm.right.z / len;
      const out = (px - size / 2) * nx + (py - size / 2) * ny >= 0 ? 1 : -1;
      return { x: px, y: py, nx, ny, out };
    });
    this._miniSize = size;
  }

  // ── the contextual slot ───────────────────────────────────────────────────

  /**
   * ONE slot, top centre. A flag or a race-control call owns it while it is
   * true; otherwise the newest personal-best / sector toast gets it for ~3 s.
   * Nothing is drawn when there is nothing to say — which is most of the time,
   * and is exactly why a broadcast package does not feel like a dashboard.
   */
  _pumpEvents(race, dt) {
    const st = race.sectorStatus ?? ['', '', ''];
    const lap = race.lap ?? 1;
    if (lap !== this._prevLap) {
      this._prevLap = lap;
      this._prevSectors = ['', '', ''];
      this._sectorMark = this.time;
      const last = parseTime(race.lastLapText);
      if (isFinite(last) && last > 0) {
        const best = race.bestOverall;
        const session = isFinite(best) && last <= best + 1e-3;
        const personal = last <= (this._personalBest ?? Infinity) + 1e-3;
        this._personalBest = Math.min(this._personalBest, last);
        if (session || personal) {
          this._push({
            key: 'lap',
            title: session ? 'FASTEST LAP' : 'PERSONAL BEST',
            value: formatLapTime(last),
            sub: (session ? race.fastestLap?.code : null) ?? race.playerCode ?? '',
            colour: session ? C.purple : C.green,
            life: session ? 4 : 3,
          });
        }
      }
    }
    for (let i = 0; i < 3; i++) {
      if (st[i] && st[i] !== this._prevSectors[i]) {
        this._prevSectors[i] = st[i];
        const t = race.sectorTimes?.[i] ?? this.time - this._sectorMark;
        this._sectorMark = this.time;
        if (st[i] === 'purple' || st[i] === 'green') {
          this._push({
            key: 'sector',
            title: `SECTOR ${i + 1}`,
            value: t > 0 && t < 300 ? t.toFixed(3) : '--.---',
            sub: st[i] === 'purple' ? 'SESSION BEST' : 'PERSONAL BEST',
            colour: sectorColour(st[i]),
            life: 3,
          });
        }
      }
    }
    for (const t of this._toasts) t.age += dt;
    this._toasts = this._toasts.filter((t) => t.age < t.life);
  }

  _push(toast) {
    toast.age = 0;
    this._toasts = this._toasts.filter((t) => t.key !== toast.key);
    this._toasts.push(toast);
  }

  _slot(frame, race, dt) {
    const c = this.ctx;
    const flag = frame.flag ?? race.flag ?? 'green';
    const banner = frame.banner ?? race.banner ?? null;
    let item = null;
    if (flag !== 'green' || banner) {
      // A flag owns its colour; an informational race-control call is neutral,
      // because green in this HUD means personal best and DRS, nothing else.
      const flagCol = flag === 'yellow' || flag === 'double' ? C.yellow
        : flag === 'red' ? C.red : flag === 'sc' || flag === 'vsc' ? C.amber
          : flag === 'blue' ? '#4aa3ff' : C.slate;
      item = {
        title: banner ?? (flag === 'sc' ? 'SAFETY CAR' : flag === 'vsc' ? 'VIRTUAL SAFETY CAR'
          : flag === 'red' ? 'RED FLAG' : flag === 'blue' ? 'BLUE FLAG' : 'YELLOW FLAG'),
        value: '', sub: race.message?.text ?? '', colour: flagCol, urgent: flag !== 'green',
      };
    } else if (this._toasts.length) {
      item = this._toasts[this._toasts.length - 1];
    }

    this._slotOpen = approach(this._slotOpen, item ? 1 : 0, 16, dt);
    if (this._slotOpen < 0.01 || !item) return;
    const e = this._slotOpen;

    const titleW = this._labelW(item.title, { size: 15 });
    const valW = item.value ? this._measure(item.value, { size: 24, weight: 700, font: F_NUM }) : 0;
    const subW = item.sub ? this._labelW(item.sub) : 0;
    // The rule between title and sub is positioned from the MEASURED width of
    // the run before it plus a fixed gutter — never from the panel's own edge,
    // which is what drove a 1 px separator through the O of `LAPS TO GO`.
    const GUT = LAYOUT.U * 1.5;
    const inner = titleW + (subW ? subW + GUT * 2 : 0) + (valW ? valW + LAYOUT.U * 2 : 0);
    // 2U of pad on each side — the chip used to carry 2U left and 3U right —
    // plus the width of the accent edge on the left.
    const ACC = 3;
    const w = Math.round(inner + LAYOUT.U * 4 + ACC);
    const h = 34;
    const x = Math.round((this.uw - w) / 2);
    const y = LAYOUT.inset - (1 - e) * (h + LAYOUT.U);

    c.save();
    c.globalAlpha = clamp(e, 0, 1);
    // Same furniture as the tower and the timing block: flat #10141a-ish at 85%,
    // one hairline, no gradient and no bevel. The flag / call colour rides a
    // 3 px edge on the left — the same device the tower uses for team colour —
    // instead of a glossy top rule, and the label is full white so it is not the
    // lowest-contrast type in the frame.
    this._panel('slot', x, y, w, h, {
      cut: { tl: LAYOUT.cut }, flat: true, fill: 'rgba(16,20,26,0.80)',
      accent: item.colour, accentH: ACC, accentSide: 'left',
      edge: hexA(item.colour, 0.34),
    });
    let cx = x + LAYOUT.U * 2 + ACC;
    this._label(item.title, cx, y + h / 2 + 1, { size: 15, colour: '#ffffff' });
    cx += titleW;
    if (item.sub) {
      this._hair(cx + GUT, y + 10, this._dev(1), h - 20, 'rgba(255,255,255,0.22)');
      cx += GUT * 2;
      this._label(item.sub, cx, y + h / 2 + 1, { colour: C.dim });
      cx += subW;
    }
    if (item.value) {
      this._text(item.value, x + w - LAYOUT.U * 2, y + h - 9, {
        size: 24, weight: 700, align: 'right', font: F_NUM, slant: 8,
        baseline: 'alphabetic', colour: '#ffffff',
      });
    }
    c.restore();
  }

  // ── main ──────────────────────────────────────────────────────────────────

  render(frame) {
    if (!this.visible) return;
    const c = this.ctx;
    const dt = Math.min(frame.dt ?? 1 / 60, 0.1);
    this.time += dt;

    const s = this.dpr * this.k;
    c.setTransform(s, 0, 0, s, 0, 0);
    c.clearRect(0, 0, this.uw, this.uh);
    this._glassUsed.clear();

    const tel = frame.telemetry ?? {};
    const race = frame.race ?? EMPTY_RACE;
    const playerIndex = frame.playerIndex ?? 0;
    const L = LAYOUT;

    this._pumpEvents(race, dt);

    // ONE resolved flag for the whole frame — the cluster, the slot and the wash
    // must never disagree about what the race is doing.
    const flag = frame.flag ?? race.flag ?? 'green';

    this._tower(L.inset, L.inset, race, playerIndex, dt);
    this._timing(this.uw - L.inset - L.timingW, L.inset, race, frame, dt);
    this._minimap(L.inset, this.uh - L.inset - L.mini, L.mini, frame.cars, playerIndex, race);
    this._tyres(this.uw - L.inset - L.tyreW, this.uh - L.inset - L.tyreH, tel, race);
    this._cluster(tel, race, playerIndex, dt, flag);
    this._slot(frame, race, dt);

    // Countdown / phase overlay.
    if (race.phase === 'countdown' && (race.countdown ?? 0) > 0) {
      const n = Math.ceil(race.countdown);
      this._text(String(n), this.uw / 2, this.uh / 2 + 40, {
        size: 130, weight: 700, align: 'center', font: F_NUM, slant: 10,
        baseline: 'alphabetic', glow: 'rgba(0,0,0,0.8)', glowBlur: 30,
      });
    }

    // Flag wash.
    if (flag && flag !== 'green') {
      const col = flag === 'yellow' || flag === 'double' ? C.yellow : flag === 'red' ? C.red : C.amber;
      const g = c.createLinearGradient(0, 0, 0, this.uh);
      g.addColorStop(0, hexA(col, 0.14));
      g.addColorStop(0.35, hexA(col, 0.0));
      g.addColorStop(0.65, hexA(col, 0.0));
      g.addColorStop(1, hexA(col, 0.14));
      c.fillStyle = g;
      c.fillRect(0, 0, this.uw, this.uh);
    }

    // Retire unused glass panels.
    for (const [id, el] of this._glassPool) {
      if (!this._glassUsed.has(id) && el.style.display !== 'none') el.style.display = 'none';
    }
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

const EMPTY_RACE = {
  lap: 1, totalLaps: 1, currentLapText: '--:--.---', lastLapText: '--:--.---',
  bestLapText: '--:--.---', sectorStatus: ['', '', ''], delta: 0, deltaText: '',
  standings: [], phase: 'green',
};

/** Two tokens and one hold colour: sessionBest (purple), personalBest (green). */
function sectorColour(status) {
  return status === 'purple' ? C.purple : status === 'green' ? C.green
    : status === 'yellow' ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.13)';
}

/**
 * Cold blue → working green → amber → red, keyed to real slick temperatures.
 *
 * DESATURATED 40 % toward luminance. At full chroma these were the most
 * saturated pixels in the entire frame, which inverted the HUD's hierarchy: the
 * least important readout on screen was out-shouting the speed and gear group.
 * A status colour only has to be *identifiable*, not loud.
 */
const DESAT = 0.40;
const TEMP_STOPS = [
  [55, 60, 130, 235],
  [80, 62, 200, 190],
  [95, 46, 214, 96],
  [108, 214, 196, 40],
  [118, 255, 148, 26],
  [132, 255, 58, 44],
].map(([t, r, g, b]) => {
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const m = (v) => Math.round(v + (y - v) * DESAT);
  return [t, m(r), m(g), m(b)];
});
function tyreTempColour(temp) {
  const s = TEMP_STOPS;
  if (temp <= s[0][0]) return `rgb(${s[0][1]},${s[0][2]},${s[0][3]})`;
  for (let i = 1; i < s.length; i++) {
    if (temp <= s[i][0] || i === s.length - 1) {
      const u = clamp((temp - s[i - 1][0]) / (s[i][0] - s[i - 1][0]), 0, 1);
      return `rgb(${Math.round(lerp(s[i - 1][1], s[i][1], u))},${Math.round(lerp(s[i - 1][2], s[i][2], u))},${Math.round(lerp(s[i - 1][3], s[i][3], u))})`;
    }
  }
  return '#ffffff';
}

function compoundFor(index) {
  return COMPOUND_CYCLE[(index * 7 + 3) % COMPOUND_CYCLE.length];
}

function parseGap(text) {
  if (!text || text === 'LEADER') return 0;
  const v = parseFloat(String(text).replace('+', ''));
  return isFinite(v) ? v : NaN;
}

function parseTime(text) {
  if (!text || text.indexOf('-') === 0 || text.indexOf(':') < 0) return NaN;
  const [m, s] = String(text).split(':');
  const v = parseInt(m, 10) * 60 + parseFloat(s);
  return isFinite(v) ? v : NaN;
}

/** '#rrggbb' + alpha -> 'rgba()'. Falls back to the input for non-hex colours. */
function hexA(hex, a) {
  if (typeof hex !== 'string' || hex[0] !== '#') return hex;
  let h = hex.slice(1);
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const n = parseInt(h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/** mm:ss.mmm — the canonical lap-time format used across the HUD and race UI. */
export function formatLapTime(seconds) {
  if (!isFinite(seconds) || seconds <= 0) return '--:--.---';
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(3)}`;
}

export function formatGap(seconds) {
  if (!isFinite(seconds)) return '--';
  if (seconds === 0) return 'LEADER';
  return `+${seconds.toFixed(3)}`;
}
