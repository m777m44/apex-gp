/**
 * APEX GP — everything around the racing surface.
 *
 * The corridor model
 * ------------------
 * Every trackside object is placed off ONE per-sample corridor description
 * (`_computeCorridor`). For each circuit sample and each side we solve:
 *
 *     runoff[i]   metres of paved/gravel run-off beyond the road verge
 *     margin[i]   metres of grass between the run-off and the barrier
 *     barrier[i]  lateral distance of the barrier face from the centreline
 *     tail[i]     metres of sculpted grass kept beyond the barrier
 *     carve[i]    lateral extent the open-country terrain is held down to
 *     type[i]     ARMCO | TECPRO | TYRES | WALL
 *
 * The corridor is low-pass filtered along `s`, so the run-off breathes open at
 * fast corners and squeezes shut on the straights exactly like a real circuit,
 * and every consumer (run-off ribbon, grass verge, barrier, hoardings, catch
 * fence, terrain carve, grandstands, marshal posts) reads the same numbers.
 * That is what guarantees there are no gaps, steps or z-fights between them.
 *
 * Orientation rule for trackside furniture: a piece that must FACE the track
 * uses the basis `(-side*tangent, up, -side*right)`. That is right-handed for
 * both sides (a basis of `(tangent, up, -right)` is mirrored and silently
 * corrupts `setFromRotationMatrix`).
 *
 * Everything repeated is instanced or merged; the trackside furniture is cut
 * into arcs (`CHUNKS`) so the frustum can actually reject most of it.
 *
 * PUBLIC API
 *   new Environment(circuit, { detail })
 *   env.build()               -> THREE.Group
 *   env.update(dt)            crowd / flag / grass animation (call per frame)
 *   env.group
 *   env.terrainHeightAt(x, z) -> y
 *   env.corridorAt(s, side)   -> { runoff, margin, barrier, tail, type }
 *   env.setStartLights(n)     0..5 columns lit, 0 = all out (race start)
 *   env.grandstands / env.barriers / env.crowd / env.startLights
 */

import * as THREE from 'three';
import { assets, mergeGeometries, setShadows } from '../core/assets.js';
import {
  grass, gravel, concrete, asphalt, brushedMetal,
  crowdSprite, CROWD_COLS, CROWD_ROWS,
  mapsToMaterial, setRepeat, cloneMaps,
} from '../textures/procedural.js';
import { makeRng, hashSeed, clamp, lerp, smoothstep, fbm, ridged } from '../core/rng.js';
// Read-only: the garage fascias carry the real team names and colours, so a bay
// belongs to a team instead of being a pastel colour swatch. `car/livery.js`
// imports nothing from `track/`, so this adds no cycle.
import { TEAMS } from '../car/livery.js';

const UP = new THREE.Vector3(0, 1, 0);

// Barrier kinds.
const ARMCO = 0, TECPRO = 1, TYRES = 2, WALL = 3;

/** Trackside furniture is split into this many arcs so it can frustum-cull. */
const CHUNKS = 14;

/**
 * Advertising geometry. The board texture is painted as 4:1 panels, so a panel
 * MUST occupy `HOARD_H * 4` metres of world or the typography stretches. Every
 * u scale applied to a board texture is derived from these three numbers.
 */
const HOARD_H = 1.20;
// 15 panels of (on average) 4.8 m = a 72 m repeat. At 8 panels / 38.4 m the
// sequence was legible TWICE inside one `wide` frame.
const HOARD_PANELS = 15;
const HOARD_REPEAT = HOARD_H * 4 * HOARD_PANELS;   // 38.4 m

/** Metres between debris-fence line posts. Real circuits: 10–14 m. */
const FENCE_POST_SPACING = 12.0;
/** Metres of real fence per debris-mesh texture tile. */
const FENCE_TILE = 0.8;
// TecPro element width (1.02 m) plus a 20 mm interlock gap: the pitch a
// continuous run is laid at.
const TECPRO_PITCH = 1.04;

/** Default metres past the barrier that the sculpted grass verge keeps running. */
const VERGE_TAIL = 16;
/** How far below the road the open-country terrain grid sits. */
const CARVE_DEPTH = 0.45;
/** Drop of the verge across its own width — meets the terrain 2 cm proud. */
const VERGE_DROP = CARVE_DEPTH - 0.035;

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _qb = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _fa = new THREE.Vector3();
const _fb = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _one = new THREE.Vector3(1, 1, 1);
const _col = new THREE.Color();

// ---------------------------------------------------------------------------
// Geometry kit
// ---------------------------------------------------------------------------

/**
 * Accumulates transformed primitives into one vertex-coloured geometry, with
 * UVs scaled by world size so a 2 m concrete tile stays a 2 m tile whatever the
 * box dimensions are.
 */
class Kit {
  constructor(uvScale = 0.5) {
    this.pos = []; this.nrm = []; this.uv = []; this.col = []; this.idx = []; this.msk = [];
    this.uvScale = uvScale;
    this.masked = false;
  }

  add(geo, {
    x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, colour = 0xffffff,
    uv = null, uvo = null, dispose = false, mask = 0, scale = null,
  } = {}) {
    const g = geo.index ? geo.toNonIndexed() : geo;
    const m = new THREE.Matrix4()
      .makeRotationFromEuler(new THREE.Euler(rx, ry, rz))
      .setPosition(x, y, z);
    if (scale) m.multiply(_m2.makeScale(scale[0], scale[1], scale[2]));
    if (mask) this.masked = true;
    const p = g.attributes.position.array;
    const na = g.attributes.normal.array;
    const ua = g.attributes.uv ? g.attributes.uv.array : null;
    const base = this.pos.length / 3;
    const nrmM = new THREE.Matrix3().getNormalMatrix(m);
    const c = _col.set(colour);
    const su = uv ? uv[0] : this.uvScale;
    const sv = uv ? uv[1] : this.uvScale;
    // `uvo` picks a cell out of an atlas — used by the garage interior, whose
    // four surfaces (back wall, side, floor, ceiling) share one painted sheet.
    const ou = uvo ? uvo[0] : 0;
    const ov = uvo ? uvo[1] : 0;
    for (let i = 0; i < p.length; i += 3) {
      _v.set(p[i], p[i + 1], p[i + 2]).applyMatrix4(m);
      this.pos.push(_v.x, _v.y, _v.z);
      _v.set(na[i], na[i + 1], na[i + 2]).applyMatrix3(nrmM).normalize();
      this.nrm.push(_v.x, _v.y, _v.z);
      const j = (i / 3) * 2;
      this.uv.push((ua ? ua[j] : 0) * su + ou, (ua ? ua[j + 1] : 0) * sv + ov);
      this.col.push(c.r, c.g, c.b);
      this.msk.push(mask);
    }
    for (let i = 0; i < p.length / 3; i++) this.idx.push(base + i);
    if (g !== geo) g.dispose();
    if (dispose) geo.dispose();
    return this;
  }

  /** Axis-aligned box: UVs proportional to face size. */
  box(w, h, d, o = {}) {
    const g = new THREE.BoxGeometry(w, h, d);
    this.add(g, { ...o, uv: o.uv ?? [Math.max(w, d) * this.uvScale, h * this.uvScale], dispose: true });
    return this;
  }

  cyl(r, h, seg, o = {}) {
    const g = new THREE.CylinderGeometry(r, o.r2 ?? r, h, seg, 1);
    this.add(g, { ...o, uv: o.uv ?? [r * 6 * this.uvScale, h * this.uvScale], dispose: true });
    return this;
  }

  /** Low-poly sphere — heads, hands, TecPro end caps. */
  sph(r, seg, o = {}) {
    const g = new THREE.SphereGeometry(r, seg, Math.max(3, Math.round(seg * 0.7)));
    this.add(g, { ...o, uv: o.uv ?? [r * 6 * this.uvScale, r * 4 * this.uvScale], dispose: true });
    return this;
  }

  build() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nrm, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (this.masked) g.setAttribute('aMask', new THREE.Float32BufferAttribute(this.msk, 1));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }
}

// ---------------------------------------------------------------------------
// Canvas textures — sponsor boards, signage, flags, chain link, grass tufts
// ---------------------------------------------------------------------------

/**
 * Sponsor identities. Each one is a *brand*, not a colour swatch: a wordmark, a
 * strapline, a palette and one of six geometric marks. The board painter below
 * composes them with a real typographic grid, so no two panels on a strip look
 * alike and none of them is ever mirrored.
 *
 * Values are chosen for a board photographed in direct sun — mid-value grounds,
 * near-white (not pure white) inks. Saturated primaries clip the moment the
 * exposure meter sees a bright sky.
 */
const SPONSORS = [
  { n: 'APEX', s: 'MOTORSPORT', bg: '#9e1f28', fg: '#f6f2ec', ac: '#e8bd3a', mark: 0 },
  { n: 'VELOCE', s: 'ENERGY', bg: '#173a63', fg: '#eef3f9', ac: '#f0c23c', mark: 1 },
  { n: 'KRONOS', s: 'CHRONOGRAPH', bg: '#20242a', fg: '#e4e1da', ac: '#d4682e', mark: 2 },
  { n: 'NITRO', s: 'FUELS', bg: '#cbc632', fg: '#20220f', ac: '#20220f', mark: 3 },
  { n: 'HALCYON', s: 'AVIATION', bg: '#15776d', fg: '#eef7f4', ac: '#9adcd0', mark: 4 },
  { n: 'ZENITH', s: 'PRIVATE BANK', bg: '#e3e0d8', fg: '#1d2c4d', ac: '#a8262f', mark: 5 },
  { n: 'OCTANE', s: 'LUBRICANTS', bg: '#4b3072', fg: '#f0ecf6', ac: '#f0aa46', mark: 1 },
  { n: 'AERON', s: 'TYRES', bg: '#1c5f94', fg: '#eef4f9', ac: '#f3f6f8', mark: 4 },
  { n: 'PRIMA', s: 'TELECOM', bg: '#9c2130', fg: '#f4efea', ac: '#eccfa6', mark: 0 },
  { n: 'VORTEX', s: 'SYSTEMS', bg: '#242a30', fg: '#e2e8e4', ac: '#46b478', mark: 2 },
  { n: 'CIRRUS', s: 'CLOUD', bg: '#c8762a', fg: '#241706', ac: '#f7e9d2', mark: 3 },
  { n: 'MERIDIAN', s: 'PETROLEUM', bg: '#143a56', fg: '#d6e6f0', ac: '#6cb4d8', mark: 5 },
  { n: 'STRATA', s: 'COMPOSITES', bg: '#3b4147', fg: '#e9ecee', ac: '#c8a24a', mark: 2 },
  { n: 'LUMEN', s: 'OPTICS', bg: '#dedbd2', fg: '#26303a', ac: '#2f7fb8', mark: 4 },
  { n: 'FORGE', s: 'INDUSTRIES', bg: '#6d3220', fg: '#f2e8de', ac: '#e0a04a', mark: 3 },
  { n: 'ATLAS', s: 'LOGISTICS', bg: '#1f4f3c', fg: '#e8f1ec', ac: '#e6c552', mark: 5 },
];

const DISPLAY = '"Helvetica Neue", "Arial Narrow", Helvetica, Arial, sans-serif';

/** Six geometric brand marks, drawn into a box of side `r*2` centred on cx,cy. */
function drawMark(ctx, kind, cx, cy, r, fill, accent) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'miter';
  if (kind === 0) {                              // stacked chevrons
    ctx.fillStyle = fill;
    for (let i = 0; i < 3; i++) {
      const y = -r + i * r * 0.72;
      ctx.beginPath();
      ctx.moveTo(-r, y + r * 0.44); ctx.lineTo(0, y - r * 0.10); ctx.lineTo(r, y + r * 0.44);
      ctx.lineTo(r, y + r * 0.72); ctx.lineTo(0, y + r * 0.18); ctx.lineTo(-r, y + r * 0.72);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = i === 0 ? accent : fill;
    }
  } else if (kind === 1) {                       // ring with a cut quadrant
    ctx.strokeStyle = fill; ctx.lineWidth = r * 0.30;
    ctx.beginPath(); ctx.arc(0, 0, r * 0.72, -Math.PI * 0.62, Math.PI * 1.24); ctx.stroke();
    ctx.fillStyle = accent;
    ctx.beginPath(); ctx.arc(0, 0, r * 0.30, 0, Math.PI * 2); ctx.fill();
  } else if (kind === 2) {                       // hexagon shield
    ctx.fillStyle = fill;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2 - Math.PI / 2;
      ctx[i ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.moveTo(-r * 0.34, r * 0.30); ctx.lineTo(0, -r * 0.46); ctx.lineTo(r * 0.34, r * 0.30);
    ctx.closePath(); ctx.fill();
  } else if (kind === 3) {                       // speed bars
    ctx.fillStyle = fill;
    for (let i = 0; i < 4; i++) {
      const w = r * (2.0 - i * 0.34);
      ctx.fillRect(-r + i * r * 0.14, -r + i * r * 0.52, w, r * 0.30);
      if (i === 1) ctx.fillStyle = accent;
      if (i === 2) ctx.fillStyle = fill;
    }
  } else if (kind === 4) {                       // delta wing
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(-r, r * 0.8); ctx.lineTo(0, -r); ctx.lineTo(r, r * 0.8);
    ctx.lineTo(r * 0.34, r * 0.8); ctx.lineTo(0, -r * 0.12); ctx.lineTo(-r * 0.34, r * 0.8);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = accent;
    ctx.fillRect(-r * 0.20, r * 0.30, r * 0.40, r * 0.5);
  } else {                                       // compass square
    ctx.strokeStyle = fill; ctx.lineWidth = r * 0.24;
    ctx.strokeRect(-r * 0.80, -r * 0.80, r * 1.6, r * 1.6);
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.52); ctx.lineTo(r * 0.40, 0); ctx.lineTo(0, r * 0.52); ctx.lineTo(-r * 0.40, 0);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
}

/** Shrink a font until the string fits `maxW`; returns the size actually used. */
function fitFont(ctx, text, maxW, weight, px, tracking = 0) {
  let size = px;
  for (let guard = 0; guard < 64; guard++) {
    ctx.letterSpacing = `${(tracking * size).toFixed(2)}px`;
    ctx.font = `${weight} ${size}px ${DISPLAY}`;
    if (ctx.measureText(text).width <= maxW || size <= 7) break;
    size -= Math.max(1, Math.round(size * 0.045));
  }
  return size;
}

/**
 * One sponsor board, painted into (x, y, w, h) with six alternating layouts.
 *
 * Every layout is built on the same grid — a 6 % gutter, a cap-height band in
 * the upper two thirds, a strapline band under it — which is what makes a run
 * of them read as a row of *different* boards rather than as noise.
 */
function drawSponsorPanel(ctx, x, y, w, h, sp, layout, rng) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.translate(x, y);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  const g = w * 0.055;                   // gutter
  ctx.fillStyle = sp.bg;
  ctx.fillRect(0, 0, w, h);

  const text = (str, tx, ty, weight, px, tracking, colour, align = 'left') => {
    const size = fitFont(ctx, str, w - tx - g, weight, px, tracking);
    ctx.fillStyle = colour;
    ctx.textAlign = align;
    ctx.fillText(str, tx, ty);
    ctx.textAlign = 'left';
    ctx.letterSpacing = '0px';
    return size;
  };

  if (layout === 0) {
    // Wordmark over a rule, strapline beneath; ghosted monogram at the right.
    ctx.save();
    ctx.globalAlpha = 0.10;
    ctx.fillStyle = sp.fg;
    ctx.font = `900 ${h * 1.5}px ${DISPLAY}`;
    ctx.textAlign = 'right';
    ctx.fillText(sp.n[0], w - g * 0.4, h * 1.16);
    ctx.restore();
    text(sp.n, g, h * 0.60, 800, h * 0.50, 0.005, sp.fg);
    ctx.fillStyle = sp.ac;
    ctx.fillRect(g, h * 0.68, w * 0.42, Math.max(2, h * 0.035));
    text(sp.s, g, h * 0.90, 600, h * 0.16, 0.22, sp.fg);
  } else if (layout === 1) {
    // Mark, hairline divider, wordmark + strapline stack.
    const r = h * 0.26;
    drawMark(ctx, sp.mark, g + r, h * 0.5, r, sp.fg, sp.ac);
    ctx.fillStyle = sp.fg;
    ctx.globalAlpha = 0.45;
    ctx.fillRect(g + r * 2 + w * 0.035, h * 0.18, Math.max(1, w * 0.004), h * 0.64);
    ctx.globalAlpha = 1;
    const tx = g + r * 2 + w * 0.075;
    text(sp.n, tx, h * 0.58, 800, h * 0.42, 0.01, sp.fg);
    text(sp.s, tx, h * 0.84, 600, h * 0.15, 0.20, sp.ac);
  } else if (layout === 2) {
    // Diagonal accent field behind a left-set wordmark.
    ctx.fillStyle = sp.ac;
    ctx.globalAlpha = 0.92;
    ctx.beginPath();
    ctx.moveTo(w * 0.58, 0); ctx.lineTo(w, 0); ctx.lineTo(w, h); ctx.lineTo(w * 0.42, h);
    ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 1;
    text(sp.n, g, h * 0.64, 800, h * 0.46, 0.005, sp.fg);
    ctx.save();
    ctx.beginPath(); ctx.moveTo(w * 0.58, 0); ctx.lineTo(w, 0); ctx.lineTo(w, h); ctx.lineTo(w * 0.42, h);
    ctx.closePath(); ctx.clip();
    drawMark(ctx, sp.mark, w * 0.78, h * 0.5, h * 0.30, sp.bg, sp.fg);
    ctx.restore();
  } else if (layout === 3) {
    // Framed, centred, wide-tracked wordmark — the classic hoarding.
    ctx.strokeStyle = sp.fg;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = Math.max(2, h * 0.035);
    ctx.strokeRect(g * 0.6, h * 0.11, w - g * 1.2, h * 0.78);
    ctx.globalAlpha = 1;
    text(sp.n, w / 2, h * 0.58, 800, h * 0.42, 0.11, sp.fg, 'center');
    text(sp.s, w / 2, h * 0.80, 600, h * 0.13, 0.30, sp.ac, 'center');
  } else if (layout === 4) {
    // Monogram block on the left, stacked lockup on the right.
    const bw = w * 0.20;
    ctx.fillStyle = sp.ac;
    ctx.fillRect(0, 0, bw, h);
    ctx.fillStyle = sp.bg;
    ctx.font = `900 ${h * 0.66}px ${DISPLAY}`;
    ctx.textAlign = 'center';
    ctx.fillText(sp.n[0], bw / 2, h * 0.72);
    ctx.textAlign = 'left';
    const tx = bw + w * 0.05;
    text(sp.n, tx, h * 0.55, 800, h * 0.40, 0.02, sp.fg);
    text(sp.s, tx, h * 0.82, 600, h * 0.155, 0.18, sp.fg);
  } else {
    // Wordmark over an accent chevron strip.
    text(sp.n, g, h * 0.58, 800, h * 0.48, 0.03, sp.fg);
    const sy = h * 0.72, sh = h * 0.20;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, sy, w, sh); ctx.clip();
    ctx.fillStyle = sp.ac;
    for (let i = -1; i * sh * 1.6 < w + sh * 2; i++) {
      const px = i * sh * 1.6;
      ctx.beginPath();
      ctx.moveTo(px, sy + sh); ctx.lineTo(px + sh * 0.8, sy);
      ctx.lineTo(px + sh * 1.5, sy); ctx.lineTo(px + sh * 0.7, sy + sh);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
    drawMark(ctx, sp.mark, w - g - h * 0.24, h * 0.34, h * 0.22, sp.fg, sp.ac);
  }

  // Shared finishing: soft vertical light, a printed-vinyl sheen, a seam.
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(255,255,255,0.13)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.00)');
  grad.addColorStop(1, 'rgba(0,0,0,0.20)');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  if (rng) {
    ctx.fillStyle = `rgba(0,0,0,${(0.02 + rng() * 0.05).toFixed(3)})`;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.fillStyle = 'rgba(0,0,0,0.42)';
  ctx.fillRect(w - Math.max(2, w * 0.006), 0, Math.max(2, w * 0.006), h);
  ctx.fillStyle = 'rgba(0,0,0,0.30)';
  ctx.fillRect(0, h - Math.max(2, h * 0.03), w, Math.max(2, h * 0.03));
  ctx.restore();
}

/**
 * A strip of `panels` distinct sponsor boards.
 *
 * `aspect` is the WORLD aspect (width / height) of one panel — the caller is
 * responsible for mapping exactly `panels` panels across `panels * aspect *
 * boardHeight` metres, which is what keeps the typography unsquashed. Text is
 * only ever drawn left-to-right; the *geometry* is what has to avoid showing
 * the back face (see `_buildTrackside`).
 */
/**
 * Non-advertising panels. A real barrier run is not an unbroken commercial
 * loop: roughly one panel in six is a bare Armco section, a marshal access
 * gate, a TV camera cut-out or a circuit-identity board. Without them the
 * repeat period of the strip is the repeat period of the *adverts*, which is
 * what made a 7-panel loop legible twice in one `wide` frame.
 */
function drawUtilityPanel(ctx, x, y, w, h, kind, rng) {
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  ctx.translate(x, y);
  if (kind === 0) {
    // Bare Armco: the barrier's own galvanised W-beam showing through.
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, '#9ba2a8'); g.addColorStop(0.5, '#b6bcc2'); g.addColorStop(1, '#7f868c');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(40,46,52,0.42)';
    for (const fy of [0.22, 0.50, 0.78]) ctx.fillRect(0, h * fy, w, Math.max(2, h * 0.045));
    ctx.fillStyle = 'rgba(255,255,255,0.20)';
    for (const fy of [0.30, 0.58, 0.86]) ctx.fillRect(0, h * fy, w, Math.max(1, h * 0.02));
    ctx.fillStyle = 'rgba(30,34,38,0.30)';
    for (let i = 0; i * h * 1.1 < w; i++) ctx.fillRect(i * h * 1.1, 0, Math.max(2, h * 0.02), h);
  } else if (kind === 1) {
    // Marshal access gate: mesh infill in a heavy frame with a hinge stack.
    ctx.fillStyle = '#5a6167'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#3d4349'; ctx.fillRect(w * 0.06, h * 0.10, w * 0.88, h * 0.80);
    ctx.strokeStyle = 'rgba(190,198,206,0.55)'; ctx.lineWidth = Math.max(1, h * 0.014);
    for (let i = 0; i < 26; i++) {
      const px = w * 0.06 + (i / 25) * w * 0.88;
      ctx.beginPath(); ctx.moveTo(px, h * 0.10); ctx.lineTo(px - h * 0.30, h * 0.90); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(px, h * 0.10); ctx.lineTo(px + h * 0.30, h * 0.90); ctx.stroke();
    }
    ctx.strokeStyle = '#c2c8ce'; ctx.lineWidth = Math.max(2, h * 0.055);
    ctx.strokeRect(w * 0.06, h * 0.10, w * 0.88, h * 0.80);
    ctx.fillStyle = '#20242a';
    for (const fy of [0.22, 0.72]) ctx.fillRect(w * 0.03, h * fy, w * 0.05, h * 0.10);
    ctx.fillStyle = '#e8c21c'; ctx.fillRect(w * 0.44, h * 0.40, w * 0.12, h * 0.20);
  } else if (kind === 2) {
    // TV camera cut-out: a black aperture with a lens hood behind it.
    ctx.fillStyle = '#2b3036'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#0b0d10'; ctx.fillRect(w * 0.16, h * 0.16, w * 0.68, h * 0.66);
    ctx.fillStyle = '#171b20';
    ctx.beginPath(); ctx.ellipse(w * 0.5, h * 0.50, h * 0.28, h * 0.28, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(150,160,170,0.5)'; ctx.lineWidth = Math.max(1, h * 0.03);
    ctx.beginPath(); ctx.ellipse(w * 0.5, h * 0.50, h * 0.28, h * 0.28, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(210,220,230,0.16)';
    ctx.beginPath(); ctx.ellipse(w * 0.44, h * 0.40, h * 0.09, h * 0.07, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#c7ccd1'; ctx.fillRect(w * 0.16, h * 0.82, w * 0.68, h * 0.05);
  } else {
    // Circuit identity board — the one non-sponsor panel that carries type.
    const bg = ['#16202b', '#1d2a20', '#2a1e26'][Math.floor(rng() * 3)];
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(230,238,246,0.94)';
    ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'center';
    fitFont(ctx, 'APEX GP', w * 0.80, 800, h * 0.42, 0.16);
    ctx.fillText('APEX GP', w / 2, h * 0.56);
    ctx.letterSpacing = '0px';
    ctx.fillStyle = 'rgba(230,238,246,0.55)';
    ctx.font = `600 ${Math.round(h * 0.15)}px ${DISPLAY}`;
    ctx.fillText('GRAND PRIX CIRCUIT', w / 2, h * 0.80);
    ctx.fillStyle = 'rgba(230,238,246,0.30)';
    ctx.fillRect(w * 0.30, h * 0.62, w * 0.40, Math.max(1, h * 0.02));
  }
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(255,255,255,0.10)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.00)');
  grad.addColorStop(1, 'rgba(0,0,0,0.22)');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(0,0,0,0.42)';
  ctx.fillRect(w - Math.max(2, w * 0.006), 0, Math.max(2, w * 0.006), h);
  ctx.restore();
}

/**
 * PANEL WIDTHS ARE NOT UNIFORM. The strip still covers exactly
 * `panels * aspect * height` metres — the caller's u mapping is untouched — but
 * the width multipliers inside it come from a seeded shuffle of
 * {0.62, 1.0, 1.42} renormalised to sum to `panels`, so the joint rhythm has
 * three sizes in it (≈3 m / 4.8 m / 6.8 m at HOARD_H) instead of one.
 *
 * Note on the review's "mirror a fraction of them": panels are NOT mirrored.
 * Every wordmark on this strip is read from the racing surface, and a mirrored
 * panel is a backwards wordmark — the exact failure the body-UV note in
 * CONTRACT.md is about. The rhythm is broken with widths, layouts, utility
 * panels and a bg/fg swap instead.
 */
function boardTexture(key, opts = {}) {
  return boardTextures(key, opts).map;
}

/**
 * ADVERT BOARDS AND THEIR DISTANCE LOD.
 *
 * Measured failure (`r3-world-wide.png`): the ribbon is ~8 screen pixels tall
 * for a 144-texel board, i.e. ~18 texels per pixel, so every board resolves at
 * mip 4–5. A sponsor panel is a mid ground with LARGE near-white type on it, and
 * the mean of that is *lighter than the ground* — several panels averaged past
 * 0.86 and read as blank white slabs with a smear where the wordmark was. The
 * same texture is perfect in `tv` at 1.6 texels per pixel, which is why the
 * review called it a mip problem and not an art problem.
 *
 * The fix is an explicit LOD target rather than "whatever the box filter does".
 * A second, tiny texture carries ONE flat colour per panel — the panel's own
 * measured mean pushed back toward its dominant hue and clamped in value — and
 * the material cross-fades to it as texel density rises. Close up nothing
 * changes; far away the ribbon is a dense row of saturated colour bands, which
 * is exactly what an advertising hoarding looks like from a helicopter.
 */
function boardTextures(key, opts = {}) {
  return assets.get(`${key}::boards`, () => {
    const { panels = 8, aspect = 4, seed = 7, height = 128, mix = 0 } = opts;
    const pw = Math.round(height * aspect);
    const rngW = makeRng(hashSeed(`${key}-widths`, seed));
    const mult = [];
    let total = 0;
    for (let i = 0; i < panels; i++) {
      const m = mix ? [0.62, 1.0, 1.0, 1.42][Math.floor(rngW() * 4)] : 1;
      mult.push(m); total += m;
    }
    for (let i = 0; i < panels; i++) mult[i] *= panels / total;

    const W = pw * panels;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = height;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const bounds = [];
    {
      const rng = makeRng(hashSeed(key, seed));
      const order = SPONSORS.map((s, i) => ({ s, k: rng() + i * 1e-4 }))
        .sort((a, b) => a.k - b.k).map((o) => o.s);
      const used = [];
      let x = 0, adIdx = 0;
      for (let i = 0; i < panels; i++) {
        const pwi = mult[i] * pw;
        // `mix` is the probability that this slot is NOT an advert.
        if (mix && rng() < mix && i > 0 && i < panels - 1) {
          drawUtilityPanel(ctx, x, 0, pwi, height, Math.floor(rng() * 4), rng);
          used.push(-1);
          bounds.push([x, x + pwi]);
          x += pwi;
          continue;
        }
        const sp = order[adIdx++ % order.length];
        // Never repeat a layout back-to-back — that is what made the old strip
        // read as one texture tiled, rather than as a row of hired boards.
        let lay = Math.floor(rng() * 6);
        if (lay === used[i - 1]) lay = (lay + 1 + Math.floor(rng() * 5)) % 6;
        used.push(lay);
        drawSponsorPanel(ctx, x, 0, pwi, height, sp, lay, rng);
        bounds.push([x, x + pwi]);
        x += pwi;
      }
    }

    /**
     * PER-PANEL GROUND COLOUR — the MODE, not the mean.
     *
     * The mean of a sponsor panel is not its colour. A mid-value ground with
     * large near-white type on it averages LIGHTER than the ground, which is
     * precisely how a hoarding mips itself into a blank white slab and why the
     * previous pass's far-field twin came out as a row of PASTELS (it measured
     * the washed mean and then tried to reconstruct chroma from it, which is
     * information that is no longer there). The MODE is the ground, because the
     * ground is most of the panel's area, and it needs no reconstruction.
     */
    const dom = [];
    for (let i = 0; i < bounds.length; i++) {
      const [x0, x1] = bounds[i];
      const sx = Math.max(0, Math.round(x0) + 2);
      const sw = Math.max(1, Math.round(x1 - x0) - 4);
      const d = ctx.getImageData(sx, 2, sw, height - 4).data;
      const hist = new Map();
      for (let p = 0; p < d.length; p += 4) {
        const q = ((d[p] >> 3) << 10) | ((d[p + 1] >> 3) << 5) | (d[p + 2] >> 3);
        hist.set(q, (hist.get(q) || 0) + 1);
      }
      let best = 0, bestN = -1, second = 0, secondN = -1;
      for (const [q, v] of hist) {
        if (v > bestN) { second = best; secondN = bestN; bestN = v; best = q; }
        else if (v > secondN) { secondN = v; second = q; }
      }
      const meanOf = (bucket) => {
        let r = 0, g = 0, b = 0, nn = 0;
        for (let p = 0; p < d.length; p += 4) {
          const q = ((d[p] >> 3) << 10) | ((d[p + 1] >> 3) << 5) | (d[p + 2] >> 3);
          if (q !== bucket) continue;
          r += d[p]; g += d[p + 1]; b += d[p + 2]; nn++;
        }
        return nn ? [r / nn, g / nn, b / nn] : [128, 128, 128];
      };
      let c0 = meanOf(best);
      // A WHITE-GROUND BOARD IS STILL A BOARD. Some layouts are dark type on a
      // white field; converging those on their ground gives the "big empty white
      // slab right of centre" the review logged. When the ground is near-white,
      // pull it toward the panel's SECOND colour — which is its type — because a
      // white board with a big red wordmark on it does not photograph as paper.
      const lum = (0.2126 * c0[0] + 0.7152 * c0[1] + 0.0722 * c0[2]) / 255;
      if (lum > 0.74) {
        const c1 = meanOf(second);
        const t = clamp((lum - 0.74) / 0.20, 0, 1) * 0.55;
        c0 = [lerp(c0[0], c1[0], t), lerp(c0[1], c1[1], t), lerp(c0[2], c1[2], t)];
      }
      dom.push(`rgb(${Math.round(c0[0])},${Math.round(c0[1])},${Math.round(c0[2])})`);
    }

    const map = new THREE.CanvasTexture(cv);
    map.colorSpace = THREE.SRGBColorSpace;
    map.wrapS = THREE.RepeatWrapping;
    map.wrapT = THREE.ClampToEdgeWrapping;
    map.anisotropy = 16;

    /**
     * EXPLICIT MIP CHAIN. Box-filtering a sponsor panel is a one-way trip to its
     * mean, and the mean is wrong (above). So the chain is authored: levels 0–2
     * are the honest downsample, and from there each level is cross-faded into
     * the flat ground colour, reaching it by level 5. A hoarding therefore goes
     * type -> soft type on colour -> a solid saturated band, and can never
     * average toward white at any distance or any anisotropy.
     */
    const levels = Math.floor(Math.log2(Math.max(W, height))) + 1;
    const mips = [cv];
    let src = cv;
    for (let l = 1; l < levels; l++) {
      const lw = Math.max(1, Math.floor(W / 2 ** l));
      const lh = Math.max(1, Math.floor(height / 2 ** l));
      const outc = document.createElement('canvas');
      outc.width = lw; outc.height = lh;
      const oc = outc.getContext('2d');
      oc.imageSmoothingEnabled = true;
      oc.imageSmoothingQuality = 'high';
      // Halve the PREVIOUS LEVEL, not a parallel pure chain. One chain instead
      // of three is the difference between 12 MB and 35 MB of retained canvas
      // per atlas, and five atlases of the latter is enough to lose the WebGL
      // context on a 1600x900 capture.
      oc.drawImage(src, 0, 0, lw, lh);
      const a = clamp((l - 2) / 2.2, 0, 1);
      if (a > 0) {
        // The ground colours are drawn as rectangles at this level's own scale,
        // so no full-size flat twin ever exists.
        oc.globalAlpha = a;
        for (let i = 0; i < bounds.length; i++) {
          const x0 = (bounds[i][0] / W) * lw, x1 = (bounds[i][1] / W) * lw;
          oc.fillStyle = dom[i];
          oc.fillRect(Math.floor(x0), 0, Math.ceil(x1 - x0) + 1, lh);
        }
        oc.globalAlpha = 1;
      }
      mips.push(outc);
      src = outc;
    }
    map.mipmaps = mips;
    map.generateMipmaps = false;
    map.needsUpdate = true;

    // --- the far-field twin -------------------------------------------------
    const TW = 1024;
    const tv = document.createElement('canvas');
    tv.width = TW; tv.height = 4;
    const tctx = tv.getContext('2d');
    for (let i = 0; i < bounds.length; i++) {
      const [x0, x1] = bounds[i];
      tctx.fillStyle = dom[i];
      tctx.fillRect(Math.round((x0 / W) * TW), 0, Math.ceil(((x1 - x0) / W) * TW) + 1, 4);
    }
    const tint = new THREE.CanvasTexture(tv);
    tint.colorSpace = THREE.SRGBColorSpace;
    tint.wrapS = THREE.RepeatWrapping;
    tint.wrapT = THREE.ClampToEdgeWrapping;
    tint.generateMipmaps = false;
    tint.minFilter = THREE.LinearFilter;
    tint.magFilter = THREE.LinearFilter;
    tint.needsUpdate = true;

    return { map, tint, texels: W, panelTexels: W / panels };
  });
}

/**
 * Standard-material board with the LOD cross-fade wired in. Every advertising
 * surface in the world goes through this, so there is one place where the
 * far-field behaviour of a hoarding is defined.
 */
function boardMaterial(matKey, texKey, opts, extra = {}) {
  return assets.material(matKey, () => {
    const b = boardTextures(texKey, opts);
    const m = new THREE.MeshStandardMaterial({
      map: b.map, roughness: 0.52, metalness: 0.02, envMapIntensity: 0.85,
      side: THREE.FrontSide, ...extra,
    });
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uBoardTint = { value: b.tint };
      shader.uniforms.uBoardPanels = { value: opts.panels ?? 8 };
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform sampler2D uBoardTint;\nuniform float uBoardPanels;')
        .replace('#include <map_fragment>', /* glsl */`
          #include <map_fragment>
          {
            /**
             * THE LOD QUANTITY IS SCREEN PIXELS PER PANEL, not texels per pixel.
             *
             * The previous ramp (2.5 -> 9.0 texels/px on an 11 520-texel strip)
             * put a board fully flat at 3 cm per pixel, i.e. from about 80 m --
             * and half flat at 20 m. That is what turned the pit-wall boards in
             * the grid frame and the whole ribbon in wide into pastel bands. A
             * 768 texel panel at 9 texels/px is still 85 screen pixels wide: the
             * wordmark is perfectly legible there and must not be touched.
             * Measured against the rendered frames, a sponsor panel reads down
             * to ~45 px and is gone by ~20 px, so that is the ramp.
             */
            float apexPx = 1.0 / max( 1e-6,
              length( vec2( dFdx( vMapUv.x ), dFdy( vMapUv.x ) ) ) * uBoardPanels );
            float apexFar = 1.0 - smoothstep( 20.0, 62.0, apexPx );
            vec4 apexTint = texture2D( uBoardTint, vec2( vMapUv.x, 0.5 ) );
            diffuseColor.rgb = mix( diffuseColor.rgb, apexTint.rgb, apexFar );
          }`);
    };
    m.customProgramCacheKey = () => 'apex-board-lod';
    return m;
  });
}

/** Bold single-word run-off / kerb-side sponsor paint, seen from a low angle. */
function trackPaintTexture(key, sp) {
  return canvasTexture(key, 1024, 256, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = sp.fg;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fitFont(ctx, sp.n, w * 0.92, 800, h * 0.72, 0.02);
    ctx.fillText(sp.n, w / 2, h * 0.52);
    ctx.letterSpacing = '0px';
    // Chew the paint up so it reads as sprayed, not decalled.
    const r = makeRng(hashSeed(key, 3));
    ctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 900; i++) {
      const rad = 1 + r() * 7;
      ctx.globalAlpha = 0.06 + r() * 0.35;
      ctx.beginPath();
      ctx.arc(r() * w, r() * h, rad, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }, { wrapS: THREE.ClampToEdgeWrapping });
}

function canvasTexture(key, w, h, draw, o = {}) {
  return assets.texture(key, () => {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    draw(cv.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = o.srgb === false ? THREE.NoColorSpace : THREE.SRGBColorSpace;
    t.wrapS = o.wrapS ?? THREE.RepeatWrapping;
    t.wrapT = o.wrapT ?? THREE.ClampToEdgeWrapping;
    t.anisotropy = 8;
    t.needsUpdate = true;
    return t;
  });
}

/**
 * Debris-fence mesh. One tile = 0.8 m of real fence, so a 512 tile puts the
 * 50 mm chain-link aperture at 32 px and the 3.2 mm wire at just over 2 px.
 *
 * The wire is DARK. Galvanised steel at 12 % screen coverage is a grey haze in
 * a photograph, never a white grid — the old 4.4 px wire at 27 % coverage in a
 * near-white tint is exactly what made this read as a picket fence.
 */
function fenceTexture() {
  return assets.texture('env/fenceTex', () => {
    const S = 512;
    const px = new Uint8Array(S * S * 4);
    const CELL = 32;              // 50 mm aperture
    const wire = 1.45;            // 4 mm wire
    const half = CELL / 2;
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const i = (y * S + x) * 4;
        const a1 = (x + y) % CELL, a2 = (x - y + S * 2) % CELL;
        const d1 = Math.min(a1, CELL - a1);
        const d2 = Math.min(a2, CELL - a2);
        const m1 = clamp(wire - d1 + 0.5, 0, 1);
        const m2 = clamp(wire - d2 + 0.5, 0, 1);
        // Which family sits on top alternates every knuckle — that weave is the
        // only thing that stops a diagonal grid looking printed.
        const over = ((x + y) % (CELL * 2) < CELL) ? 1 : 0;
        // NO TENSION CABLE IN THE TILE. There used to be a 6 mm cable baked at
        // every half tile, i.e. every 0.4 m of fence height. A real run carries
        // two, at the head and the foot of a ~3 m panel — and because the tile
        // repeats nine times over this fence's height, the baked version drew
        // NINE bright horizontal lines. Seen down the barrier they smear under
        // 16x anisotropy into hard stripes that dominate the fence completely:
        // in `wide` the catch fence read as six dark wires with air between
        // them rather than as a screen. The real cables are geometry now
        // (`_fenceRails`), at the two heights they actually occupy.
        const a = Math.max(m1, m2);
        const lit = over ? (m1 > m2 ? 1.0 : 0.62) : (m2 > m1 ? 1.0 : 0.62);
        px[i] = 118 * lit; px[i + 1] = 124 * lit; px[i + 2] = 130 * lit;
        px[i + 3] = Math.round(clamp(a, 0, 1) * 255);
      }
    }
    const t = new THREE.DataTexture(px, S, S, THREE.RGBAFormat);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.magFilter = THREE.LinearFilter;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 16;
    t.needsUpdate = true;
    return t;
  });
}

function signTexture(key, draw) {
  return canvasTexture(key, 512, 256, draw, { wrapS: THREE.ClampToEdgeWrapping });
}

/** 4-cell flag sheet: yellow, blue, chequered, team. */
function flagTexture() {
  return canvasTexture('env/flags', 512, 128, (ctx, w, h) => {
    const cw = w / 4;
    // Dyed nylon in daylight, not screen primaries: the old #1257d8 blue read as
    // a saturated cyan chip on the barrier at any exposure.
    ctx.fillStyle = '#e0c422'; ctx.fillRect(0, 0, cw, h);
    ctx.fillStyle = '#2b53a4'; ctx.fillRect(cw, 0, cw, h);
    ctx.fillStyle = '#eeeeea'; ctx.fillRect(cw * 2, 0, cw, h);
    ctx.fillStyle = '#141414';
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        if ((x + y) % 2) ctx.fillRect(cw * 2 + (x * cw) / 8, (y * h) / 8, cw / 8, h / 8);
      }
    }
    ctx.fillStyle = '#b02b30'; ctx.fillRect(cw * 3, 0, cw, h);
    ctx.fillStyle = '#eeeeea'; ctx.fillRect(cw * 3, h * 0.38, cw, h * 0.24);
    // Hem and hoist band on every cell — the "no hem, no frame" note.
    for (let c = 0; c < 4; c++) {
      const x0 = c * cw;
      ctx.fillStyle = 'rgba(0,0,0,0.22)';
      ctx.fillRect(x0, 0, cw, 4);
      ctx.fillRect(x0, h - 5, cw, 5);
      ctx.fillStyle = 'rgba(0,0,0,0.16)';
      ctx.fillRect(x0, 0, 6, h);
      ctx.fillStyle = 'rgba(250,250,246,0.22)';
      ctx.fillRect(x0 + 6, 0, 2, h);
      // Stitch line inside the hem.
      ctx.fillStyle = 'rgba(255,255,255,0.20)';
      for (let sx = x0 + 3; sx < x0 + cw - 3; sx += 7) {
        ctx.fillRect(sx, 6, 3, 1); ctx.fillRect(sx, h - 8, 3, 1);
      }
    }
  }, { wrapS: THREE.ClampToEdgeWrapping });
}

/**
 * GARAGE INTERIOR SHEET — a 2x2 atlas, one cell per surface of the working bay:
 *
 *   (0, 0.5) back wall: tool cabinets, three monitors, a tyre rack, a wordmark
 *   (0.5, 0.5) side wall: panel joints, cable tray, a fire point, a door
 *   (0, 0) floor: sealed epoxy with a team stripe and drain channel
 *   (0.5, 0) ceiling: strip lights and services
 *
 * This is used as BOTH `map` and `emissiveMap`. A pit garage in daylight is lit
 * from inside and the ambient term alone leaves it a black hole; the emissive
 * pass is what turns the opening from a void into a room. It is deliberately
 * dim — `emissiveIntensity` 0.30 with the brightest pixel (the strip lights) at
 * 0.95 sRGB puts the hottest interior texel at ~0.28 scene-referred, well under
 * the 1.25 bloom threshold, so no part of this can flare.
 */
function garageInteriorTexture() {
  return canvasTexture('env/garageInterior', 1024, 1024, (ctx, W, H) => {
    const S = W / 2;
    const cell = (cx, cy, draw) => {
      ctx.save();
      ctx.beginPath(); ctx.rect(cx, cy, S, S); ctx.clip();
      ctx.translate(cx, cy);
      draw();
      ctx.restore();
    };
    const rng = makeRng(hashSeed('garage-interior'));
    // --- back wall (top-left) ------------------------------------------------
    cell(0, 0, () => {
      const g = ctx.createLinearGradient(0, 0, 0, S);
      g.addColorStop(0, '#c6ccd2'); g.addColorStop(0.62, '#a4abb2'); g.addColorStop(1, '#767c83');
      ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
      // Wall panel joints.
      ctx.strokeStyle = 'rgba(70,78,86,0.45)'; ctx.lineWidth = 2;
      for (let i = 1; i < 8; i++) { ctx.beginPath(); ctx.moveTo(i * S / 8, 0); ctx.lineTo(i * S / 8, S); ctx.stroke(); }
      ctx.beginPath(); ctx.moveTo(0, S * 0.30); ctx.lineTo(S, S * 0.30); ctx.stroke();
      // Overhead services rail.
      ctx.fillStyle = '#5b6268'; ctx.fillRect(0, S * 0.075, S, S * 0.045);
      // Wordmark on the rear wall.
      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = `700 ${Math.round(S * 0.062)}px ${DISPLAY}`;
      ctx.fillText('P I T   G A R A G E', S * 0.5, S * 0.215);
      // Tool cabinets along the base, alternating drawer stacks.
      for (let i = 0; i < 7; i++) {
        const x = S * (0.035 + i * 0.135), w = S * 0.115, y = S * 0.60, h = S * 0.34;
        ctx.fillStyle = i % 2 ? '#3a4048' : '#2c3138';
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = 'rgba(255,255,255,0.10)'; ctx.fillRect(x, y, w, S * 0.012);
        ctx.strokeStyle = 'rgba(190,200,210,0.35)'; ctx.lineWidth = 1.5;
        for (let d = 1; d < 5; d++) {
          ctx.beginPath(); ctx.moveTo(x + 2, y + (d * h) / 5); ctx.lineTo(x + w - 2, y + (d * h) / 5); ctx.stroke();
        }
        ctx.fillStyle = 'rgba(230,238,246,0.5)';
        for (let d = 0; d < 5; d++) ctx.fillRect(x + w * 0.34, y + (d * h) / 5 + h * 0.09, w * 0.32, 3);
      }
      // Monitor bank.
      for (let i = 0; i < 3; i++) {
        const x = S * (0.30 + i * 0.15), y = S * 0.365, w = S * 0.125, h = S * 0.085;
        ctx.fillStyle = '#12161b'; ctx.fillRect(x - 3, y - 3, w + 6, h + 6);
        ctx.fillStyle = '#16303f'; ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = 'rgba(120,220,255,0.75)'; ctx.lineWidth = 1.4;
        ctx.beginPath();
        for (let t = 0; t <= 24; t++) {
          const px = x + (t / 24) * w, py = y + h * (0.5 + 0.34 * Math.sin(t * 0.9 + i) * (rng() * 0.4 + 0.6));
          if (t === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      // Tyre rack on the right: three shelves of stacked slicks.
      ctx.fillStyle = '#4a5158'; ctx.fillRect(S * 0.80, S * 0.32, S * 0.19, S * 0.03);
      for (let r = 0; r < 3; r++) {
        const y = S * (0.36 + r * 0.11);
        ctx.fillStyle = '#4a5158'; ctx.fillRect(S * 0.80, y + S * 0.075, S * 0.19, S * 0.012);
        for (let i = 0; i < 4; i++) {
          const cx2 = S * (0.825 + i * 0.045);
          ctx.fillStyle = '#191b1e';
          ctx.beginPath(); ctx.arc(cx2, y + S * 0.038, S * 0.021, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#585c60';
          ctx.beginPath(); ctx.arc(cx2, y + S * 0.038, S * 0.010, 0, Math.PI * 2); ctx.fill();
        }
      }
    });
    // --- side wall (top-right) ----------------------------------------------
    cell(S, 0, () => {
      const g = ctx.createLinearGradient(0, 0, 0, S);
      g.addColorStop(0, '#b6bcc2'); g.addColorStop(0.7, '#949aa1'); g.addColorStop(1, '#686e75');
      ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
      ctx.strokeStyle = 'rgba(70,78,86,0.40)'; ctx.lineWidth = 2;
      for (let i = 1; i < 6; i++) { ctx.beginPath(); ctx.moveTo(i * S / 6, 0); ctx.lineTo(i * S / 6, S); ctx.stroke(); }
      ctx.fillStyle = '#5b6268'; ctx.fillRect(0, S * 0.10, S, S * 0.035);
      ctx.fillStyle = '#a8291f'; ctx.fillRect(S * 0.12, S * 0.55, S * 0.05, S * 0.11);
      /**
       * THE PERSONNEL DOOR. This was `#2e343a` — a 1.4 x 2.7 m patch at 0.028
       * linear on a surface whose only light is `albedo x fill`, so it rendered
       * at sRGB 0,3,22 and became the black rectangle standing in the middle of
       * every bay in the `grid` frame. It is the void the review is about; the
       * garage shell around it had already been rebuilt.
       *
       * A door in a lit room is a MID-VALUE panel with a dark reveal around it,
       * not a hole. Painted steel, two recessed panels, a kick plate, a lever
       * handle and a lit exit sign over the head.
       */
      const dx = S * 0.70, dy = S * 0.55, dw = S * 0.125, dh = S * 0.45;
      ctx.fillStyle = '#4c535a'; ctx.fillRect(dx - 5, dy - 5, dw + 10, dh + 5);   // frame/reveal
      ctx.fillStyle = '#a9b0b6'; ctx.fillRect(dx, dy, dw, dh);                     // leaf
      ctx.fillStyle = '#949ba2';
      ctx.fillRect(dx + dw * 0.13, dy + dh * 0.07, dw * 0.74, dh * 0.34);
      ctx.fillRect(dx + dw * 0.13, dy + dh * 0.47, dw * 0.74, dh * 0.34);
      ctx.strokeStyle = 'rgba(240,244,248,0.45)'; ctx.lineWidth = 1.5;
      ctx.strokeRect(dx + dw * 0.13, dy + dh * 0.07, dw * 0.74, dh * 0.34);
      ctx.strokeRect(dx + dw * 0.13, dy + dh * 0.47, dw * 0.74, dh * 0.34);
      ctx.fillStyle = '#7e858c'; ctx.fillRect(dx, dy + dh * 0.88, dw, dh * 0.12);  // kick plate
      ctx.fillStyle = '#2c3238'; ctx.fillRect(dx + dw * 0.80, dy + dh * 0.46, dw * 0.14, dh * 0.03);
      ctx.fillStyle = '#2b6b3c'; ctx.fillRect(dx + dw * 0.22, dy - S * 0.055, dw * 0.56, S * 0.042);
      ctx.fillStyle = '#dff2e2';
      ctx.font = `700 ${Math.round(S * 0.026)}px ${DISPLAY}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('EXIT', dx + dw * 0.5, dy - S * 0.034);
      /**
       * The side wall carries the load, not the back wall. A pit garage 40 m
       * down a row is seen at a very oblique angle — the sightline through a
       * 12.6 m opening into a 7.2 m bay lands on the near side wall long before
       * it reaches the back one — so all the detail authored on the back wall
       * (cabinets, monitors, tyre rack) is essentially never in shot from the
       * `grid` camera. Everything below is here for that reason.
       */
      // Parts racking with stock on it.
      ctx.fillStyle = '#565d64';
      for (let r = 0; r < 3; r++) ctx.fillRect(S * 0.05, S * (0.30 + r * 0.13), S * 0.30, S * 0.016);
      for (let r = 0; r < 3; r++) {
        for (let b = 0; b < 4; b++) {
          ctx.fillStyle = ['#8d949b', '#6d747b', '#9aa1a8', '#7c838a'][(r + b) % 4];
          ctx.fillRect(S * (0.055 + b * 0.075), S * (0.30 + r * 0.13) - S * 0.048, S * 0.062, S * 0.048);
        }
      }
      // Cable tray and a conduit drop.
      ctx.fillStyle = '#61686f'; ctx.fillRect(0, S * 0.185, S, S * 0.022);
      ctx.fillStyle = '#787f86'; ctx.fillRect(S * 0.455, S * 0.20, S * 0.014, S * 0.34);
      // Tool cabinets along the base — the single strongest read at distance,
      // because they band the bottom third of the wall in a darker value.
      for (let i = 0; i < 6; i++) {
        const x = S * (0.03 + i * 0.108), w2 = S * 0.094, y = S * 0.74, h2 = S * 0.26;
        ctx.fillStyle = i % 2 ? '#454c53' : '#394047';
        ctx.fillRect(x, y, w2, h2);
        ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(x, y, w2, S * 0.010);
        ctx.strokeStyle = 'rgba(186,196,206,0.32)'; ctx.lineWidth = 1.4;
        for (let d = 1; d < 4; d++) {
          ctx.beginPath(); ctx.moveTo(x + 2, y + (d * h2) / 4); ctx.lineTo(x + w2 - 2, y + (d * h2) / 4); ctx.stroke();
        }
        ctx.fillStyle = 'rgba(226,234,242,0.5)';
        for (let d = 0; d < 4; d++) ctx.fillRect(x + w2 * 0.34, y + (d * h2) / 4 + h2 * 0.10, w2 * 0.32, 3);
      }
      // Engineer's bench with two screens, under the racking.
      ctx.fillStyle = '#2b3138'; ctx.fillRect(S * 0.50, S * 0.44, S * 0.16, S * 0.10);
      for (let i = 0; i < 2; i++) {
        ctx.fillStyle = '#16303f'; ctx.fillRect(S * (0.512 + i * 0.078), S * 0.455, S * 0.062, S * 0.072);
        ctx.strokeStyle = 'rgba(126,222,255,0.7)'; ctx.lineWidth = 1.2;
        ctx.beginPath();
        for (let t = 0; t <= 16; t++) {
          const px = S * (0.512 + i * 0.078) + (t / 16) * S * 0.062;
          const py = S * 0.491 + Math.sin(t * 1.1 + i * 2) * S * 0.020;
          if (t === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }
      // Hose reel and a fire point beside the door.
      ctx.strokeStyle = '#b8bec4'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(S * 0.615, S * 0.60, S * 0.032, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = '#8d949b'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(S * 0.615, S * 0.60, S * 0.018, 0, Math.PI * 2); ctx.stroke();
      // A wide sponsor/team band high on the wall, which is what actually reads
      // from the pit lane once everything else has fallen under a pixel.
      ctx.fillStyle = 'rgba(28,34,40,0.82)'; ctx.fillRect(0, S * 0.235, S * 0.92, S * 0.075);
      ctx.fillStyle = 'rgba(236,242,248,0.86)';
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.font = `700 ${Math.round(S * 0.050)}px ${DISPLAY}`;
      ctx.fillText('T E A M   O P E R A T I O N S', S * 0.035, S * 0.274);
    });
    // --- floor (bottom-left) -------------------------------------------------
    cell(0, S, () => {
      ctx.fillStyle = '#b9bdc1'; ctx.fillRect(0, 0, S, S);
      for (let i = 0; i < 900; i++) {
        ctx.fillStyle = `rgba(${120 + rng() * 60 | 0},${124 + rng() * 60 | 0},${128 + rng() * 60 | 0},0.30)`;
        ctx.fillRect(rng() * S, rng() * S, 2 + rng() * 5, 2 + rng() * 5);
      }
      ctx.fillStyle = 'rgba(60,66,72,0.55)'; ctx.fillRect(0, S * 0.94, S, S * 0.03);
      ctx.fillStyle = 'rgba(255,255,255,0.30)'; ctx.fillRect(S * 0.20, 0, S * 0.02, S);
      ctx.fillStyle = 'rgba(255,255,255,0.30)'; ctx.fillRect(S * 0.78, 0, S * 0.02, S);
    });
    // --- ceiling (bottom-right) ---------------------------------------------
    cell(S, S, () => {
      ctx.fillStyle = '#8d9399'; ctx.fillRect(0, 0, S, S);
      ctx.fillStyle = '#6e747a';
      for (let i = 0; i < 6; i++) ctx.fillRect(0, S * (0.06 + i * 0.16), S, S * 0.02);
      // Strip lights — the brightest thing in the sheet, and still only 0.95.
      ctx.fillStyle = '#f2f4f2';
      for (let i = 0; i < 3; i++) ctx.fillRect(S * 0.10, S * (0.16 + i * 0.30), S * 0.80, S * 0.055);
      ctx.fillStyle = 'rgba(255,255,240,0.35)';
      for (let i = 0; i < 3; i++) ctx.fillRect(S * 0.06, S * (0.13 + i * 0.30), S * 0.88, S * 0.115);
    });
  }, { wrapS: THREE.ClampToEdgeWrapping });
}

/**
 * Garage fascia signage — one row per team, wordmark on the team's own colour
 * with an accent keyline, so the bay reads as "Meridian Works" and not as a
 * pastel colour test.
 */
const GARAGE_SIGN_ROWS = 10;
function garageSignTexture() {
  const RH = 128;
  return canvasTexture('env/garageSign', 1536, RH * GARAGE_SIGN_ROWS, (ctx, W) => {
    for (let i = 0; i < GARAGE_SIGN_ROWS; i++) {
      const t = TEAMS[i % TEAMS.length];
      const y = i * RH;
      // Printed vinyl in daylight: mid value, mid chroma. The car's primary is
      // often a near-primary, so pull it toward the fascia's own value range.
      _col.set(t.primary);
      const hsl = { h: 0, s: 0, l: 0 };
      // sRGB, not the linear working space: this is CSS being written back out.
      _col.getHSL(hsl, THREE.SRGBColorSpace);
      const bg = `hsl(${hsl.h * 360}, ${Math.min(0.52, hsl.s) * 100}%, ${clamp(hsl.l * 0.85 + 0.10, 0.16, 0.44) * 100}%)`;
      ctx.fillStyle = bg; ctx.fillRect(0, y, W, RH);
      const grad = ctx.createLinearGradient(0, y, 0, y + RH);
      grad.addColorStop(0, 'rgba(255,255,255,0.16)');
      grad.addColorStop(0.55, 'rgba(255,255,255,0.0)');
      grad.addColorStop(1, 'rgba(0,0,0,0.22)');
      ctx.fillStyle = grad; ctx.fillRect(0, y, W, RH);
      ctx.fillStyle = t.accent; ctx.fillRect(0, y + RH - 7, W, 7);
      ctx.fillStyle = 'rgba(0,0,0,0.30)'; ctx.fillRect(0, y, W, 4);
      // Mark + wordmark, left third; bay number, right.
      drawMark(ctx, i % 6, RH * 0.62, y + RH * 0.50, RH * 0.30, '#f4f6f8', t.accent);
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillStyle = '#f4f6f8';
      const name = t.name.toUpperCase();
      fitFont(ctx, name, W * 0.56, 800, RH * 0.46, 0.06);
      ctx.fillText(name, RH * 1.10, y + RH * 0.47);
      ctx.letterSpacing = '0px';
      ctx.font = `700 ${Math.round(RH * 0.30)}px ${DISPLAY}`;
      ctx.textAlign = 'right';
      ctx.fillStyle = 'rgba(244,246,248,0.72)';
      ctx.fillText(`BAY ${String(i + 1).padStart(2, '0')}`, W - RH * 0.30, y + RH * 0.50);
    }
  }, { wrapS: THREE.ClampToEdgeWrapping });
}

/**
 * A card of real grass blades — tapered, leaning, individually shaded, in the
 * desaturated yellow-green a mown circuit verge actually is.
 *
 * `dry` slides the whole card from turf toward straw so a scatter can mix the
 * two without a second texture. Blades are drawn as filled tapers rather than
 * strokes so the silhouette keeps a point at the tip when it mips down.
 */
function bladeCardTexture(key, dry) {
  // Wide, so every instance can take its own narrow WINDOW of it. Showing the
  // same 34 blades on all 130 000 cards is what turned a dense verge into a
  // regular knitted corduroy — the cards were geometrically varied but
  // texturally identical, and at 20 m that is what you see.
  return canvasTexture(key, 1024, 256, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    const r = makeRng(hashSeed(key, 17));
    const blades = 150;
    const order = [];
    for (let i = 0; i < blades; i++) order.push(r());
    order.sort();
    for (let i = 0; i < blades; i++) {
      const depth = i / (blades - 1);              // back to front
      // Absolute pixel metrics: the atlas is windowed, so a blade's lean and
      // width must be sized against the WINDOW (about 174 px), not the sheet.
      const x0 = w * (0.02 + r() * 0.96);
      const lean = (r() - 0.5) * 96;
      const len = h * (0.30 + Math.pow(r(), 0.7) * 0.66);
      const wide = 2.4 + r() * 3.6;
      // Yellow-green: G leads, R close behind, B far back. Depth darkens.
      const v = (0.30 + r() * 0.30) * (0.55 + depth * 0.55);
      const d = clamp(dry + (r() - 0.5) * 0.35, 0, 1);
      const cr = Math.round(255 * v * lerp(0.62, 1.02, d));
      const cg = Math.round(255 * v * lerp(1.00, 0.96, d));
      const cb = Math.round(255 * v * lerp(0.34, 0.56, d));
      const tipX = x0 + lean, tipY = h - len;
      const midX = x0 + lean * 0.30, midY = h - len * 0.58;
      const grad = ctx.createLinearGradient(x0, h, tipX, tipY);
      grad.addColorStop(0, `rgb(${Math.round(cr * 0.45)},${Math.round(cg * 0.45)},${Math.round(cb * 0.45)})`);
      grad.addColorStop(0.45, `rgb(${cr},${cg},${cb})`);
      grad.addColorStop(1, `rgb(${Math.min(255, Math.round(cr * 1.25))},${Math.min(255, Math.round(cg * 1.18))},${Math.round(cb * 1.1)})`);
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(x0 - wide, h);
      ctx.quadraticCurveTo(midX - wide * 0.55, midY, tipX, tipY);
      ctx.quadraticCurveTo(midX + wide * 0.55, midY, x0 + wide, h);
      ctx.closePath();
      ctx.fill();
    }
    // A little litter at the base so the card does not float on the ground.
    ctx.globalAlpha = 0.55;
    for (let i = 0; i < 104; i++) {
      const bx = w * r(), by = h - h * 0.05 * r();
      ctx.fillStyle = `rgb(${70 + Math.floor(r() * 40)},${70 + Math.floor(r() * 45)},${36 + Math.floor(r() * 24)})`;
      ctx.fillRect(bx, by, 2 + r() * 5, 1 + r() * 2);
    }
    ctx.globalAlpha = 1;
  }, { wrapS: THREE.ClampToEdgeWrapping });
}

/**
 * AERIAL PERSPECTIVE — the one function that owns distance haze on vegetation.
 *
 * WHY THIS EXISTS AT ALL, GIVEN THERE IS ALREADY SCENE FOG.
 *
 * `scene.fog` is a single exponential tuned so an 8 km skyline reads correctly;
 * at 1 km it delivers 13 % haze, which is right for the *terrain* (a mown field
 * has almost no intrinsic contrast to lose) and badly wrong for a woodland CARD.
 * A card carries baked-in crown-to-shadow contrast and full leaf saturation that
 * a real canopy simply does not deliver through a kilometre of summer air. The
 * measured consequence in `wide`: the 1 km treeline came back at (99,115,73),
 * saturation 0.36 — MORE saturated and with LESS blue than the 200 m trees in
 * front of it, while the 8 km skyline stayed correctly hazed. Depth ordering
 * inverted, and the horizon stopped reading as a horizon.
 *
 * So every vegetation material gets one extra haze term, and — this is the whole
 * point — it is the SAME term with the SAME constant for the near, mid and far
 * bands, the hedgerows and the tree canopies. Monotone in view depth by
 * construction: nothing anyone tunes per band can invert the ordering again.
 * `max()` against the scene fog guarantees it can never haze LESS than the
 * ground the trees stand on.
 *
 * Ladder at K = 6.0e-4, ceiling 0.46 (haze fraction):
 *   200 m 0.01 | 500 m 0.07 | 800 m 0.16 | 1.25 km 0.34 | 2 km 0.61 | 3 km 0.77
 * against scene fog at 0.004 / 0.02 / 0.06 / 0.13 / 0.30 / 0.55 and the city
 * band at 8 km on 1.00. Desaturation runs on the same curve, because scattered
 * light is what removes chroma.
 *
 * IT RIDES ON TOP OF `sky.js`'s CHUNK, IT DOES NOT REPLACE IT. `installAerial-
 * Perspective()` has already swapped three's stock `fog_fragment` for a real
 * ray-integrated in-scattering term, and that term is the correct one — this
 * block APPENDS a second, purely additive mix so the composite is
 * 1-(1-skyHaze)(1-vegHaze): still monotone in depth, and never less haze than
 * the terrain the trees stand on. Note that sky.js's `fog_pars_fragment`
 * declares `vFogWorldPos` and NOT `vFogDepth`, so distance is reconstructed the
 * same way the chunk itself does it.
 *
 * The haze COLOUR is the sky's own zenith/horizon probe — the same pair
 * `apexScatter` is built from — so vegetation fades into exactly the sky behind
 * it. Using `fogColor` here instead would tint the haze twice; see the note in
 * sky.js.
 *
 * Guarded by USE_FOG: `?fog=0` compiles this out rather than referencing
 * uniforms that no longer exist.
 */
const AP_K = 6.0e-4;
function aerialPerspective(mat, { k = AP_K, max = 0.46, desat = 0.42, key }) {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace('#include <fog_fragment>', /* glsl */`
#include <fog_fragment>
#ifdef USE_FOG
  {
    vec3 apRay = vFogWorldPos - cameraPosition;
    float apD = max( length( apRay ), 1e-4 );
    float apT = apD * ${k.toExponential(4)};
    float ap = ( 1.0 - exp( - apT * apT ) ) * ${max.toFixed(4)};
    float apUp = clamp( ( apRay.y / apD ) * 1.8 + 0.12, 0.0, 1.0 );
    vec3 apHaze = mix( apexAerialHorizon, apexAerialZenith, apUp );
    float apL = dot( gl_FragColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
    gl_FragColor.rgb = mix( gl_FragColor.rgb, vec3( apL ), ap * ${desat.toFixed(4)} );
    gl_FragColor.rgb = mix( gl_FragColor.rgb, apHaze, ap );
  }
#endif
`);
  };
  mat.customProgramCacheKey = () => `apex-ap-${key}`;
  return mat;
}

/**
 * A treeline — one card of *woodland mass*, not a tree.
 *
 * At 400 m a copse has no branches and no trunks: it is a lumpy dark silhouette
 * with a lit crown, a shadowed underside and a ragged top edge, and that is
 * exactly what a distant landscape is made of. Drawing that directly (instead
 * of instancing ten thousand tree cards and letting them mip into mush) is what
 * lets the hills carry forest cover for 700 triangles.
 */
function treeMassTexture(key, o = {}) {
  const dark = o.dark ?? [26, 34, 20];
  const litC = o.lit ?? [92, 104, 58];
  // `solid` = fraction of the canopy height that is opaque undergrowth. A field
  // hedge is nearly solid (0.9); a woodland edge is mostly crown (0.4).
  const solid = o.solid ?? 0.42;
  const chew = o.chew ?? 190;
  const blobs = o.blobs ?? 900;
  const relief = o.relief ?? 1.0;
  /**
   * `form` = how hard each crown blob is modelled, 0..1.
   *
   * The radial gradient runs 1.22x at the hot spot to 0.62x at the rim — a full
   * stop across a 10 px blob. On a 34 m near card that is a lit crown. Tiled
   * across a 190 m card sitting on the horizon it is what the review called "a
   * legible mass of identical high-contrast green pebble blobs": at that scale
   * the eye reads the gradient itself, not the foliage, so the whole treeline
   * cobbles. Distant bands turn `form` down and the blob collapses toward a flat
   * tonal patch, which is what a wood at 2 km actually is.
   */
  const form = o.form ?? 1.0;
  // Per-blob hue spread. A wood is oak next to ash next to a dead elm; one
  // palette with a brightness jitter is a hedge, not a forest.
  const hue = o.hue ?? 0.0;
  const gHot = 1 + 0.22 * form, gRim = 1 - 0.38 * form;
  /**
   * `crown` — CROWN SIZE IS THE WHOLE DEFECT, AND IT WAS OFF BY FIVE TIMES.
   *
   * The blob radius was a hard-coded 5-15 px whatever the card was. Work the
   * angles: the mid card is 78 m wide and typically 600 m away, so it lands on
   * screen at very nearly 1 texel per pixel — those blobs rendered as 10-30 px
   * circles. A real tree crown is about 8 m across, which at 600 m subtends
   * 0.76 degrees, i.e. 36 screen pixels at this FOV. The blobs were therefore
   * drawn at a third to a tenth of the angular size of the thing they depict —
   * squarely in the range where the eye stops reading "canopy" and starts
   * reading "aggregate". That is the review's "legible mass of identical
   * high-contrast green pebble blobs" and no amount of contrast or haze
   * tuning fixes it, because the problem is the SCALE, not the shading. (Round
   * 5's first attempt flattened the shading instead and made it worse: flat
   * ovals of uniform size read as pebbles even harder.)
   *
   * `crown` multiplies the radius, and the blob count comes down as its square
   * so the coverage is unchanged. Crowns are ELLIPSES at a random aspect and
   * tilt, not circles, because a field of identical circles is exactly what
   * reads as tiling.
   */
  const crown = o.crown ?? 1.0;
  return canvasTexture(key, 512, 256, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    const r = makeRng(hashSeed(key, 23));
    // Canopy height profile: three octaves so the skyline has both big stands
    // and individual emergent crowns.
    const COLS = 96;
    const prof = new Float32Array(COLS + 1);
    for (let i = 0; i <= COLS; i++) {
      const u = i / COLS;
      prof[i] = 1.0 - relief * (0.50
        - 0.26 * Math.sin(u * 6.283 * 1.7 + 1.1)
        - 0.16 * Math.sin(u * 6.283 * 4.3 + 2.7)
        - 0.10 * Math.sin(u * 6.283 * 9.1 + 0.4));
    }
    const at = (x) => {
      const f = (x / w) * COLS;
      const i = Math.min(COLS - 1, Math.floor(f));
      return lerp(prof[i], prof[i + 1], f - i);
    };
    // Solid trunk/undergrowth mass at the base — a treeline is opaque low down.
    for (let x = 0; x < w; x++) {
      const top = h * (1 - at(x) * solid);
      ctx.fillStyle = `rgb(${dark[0] * 0.72 | 0},${dark[1] * 0.72 | 0},${dark[2] * 0.72 | 0})`;
      ctx.fillRect(x, top, 1, h - top);
    }
    /**
     * CROWNS ARE BUILT IN THREE TIERS, LIKE `crownAtlas` — a single gradient
     * ellipse per crown cannot work at any size.
     *
     * Small, it is a pebble (see the note on `crown`). Large — which is what the
     * angular arithmetic actually demands, a 60-texel radius at the near band —
     * it is a smooth billiard ball, and a slope of them reads as broccoli. What
     * makes foliage read is structure at BRANCH scale inside a crown-scale
     * envelope, so each crown is an envelope ellipse, then 5-9 branch lobes at
     * a third of the radius, then 10-18 twig lobes at a tenth, each with its own
     * value jitter and its own upper-left lit face. That is granular at every
     * viewing distance and mips down to the right mean.
     */
    const nBlobs = Math.max(24, Math.round(blobs / (crown * crown)));
    const tiers = [[5, 0.26, 0.44, 0.86], [11, 0.09, 0.19, 1.02]];
    for (let i = 0; i < nBlobs; i++) {
      const cx = r() * w;
      const ceil = h * (1 - at(cx));
      const cy = ceil + Math.pow(r(), 0.7) * (h - ceil) * 1.05;
      const rad = (5 + r() * 15) * crown;
      // A crown is wider than it is tall, and never twice the same.
      const ecc = 0.62 + r() * 0.72;
      const tilt = (r() - 0.5) * 0.9;
      // Lit toward the crown, shadowed toward the floor.
      const t = clamp(1 - (cy - ceil) / Math.max(1, h - ceil), 0, 1);
      const j = 1 + (0.78 + r() * 0.44 - 1) * (0.45 + 0.55 * form);
      // Species jitter: warm-yellow through cool blue-green about the palette.
      const hj = (r() - 0.5) * 2 * hue;
      const cr = lerp(dark[0], litC[0], t * t) * j * (1 + hj * 0.55);
      const cg = lerp(dark[1], litC[1], t * t) * j * (1 - hj * 0.06);
      const cb = lerp(dark[2], litC[2], t * t) * j * (1 - hj * 0.62);
      const blob = (bx, by, br, be, bt, v) => {
        const g = ctx.createRadialGradient(bx - br * 0.30, by - br * 0.34, br * 0.08, bx, by, br);
        g.addColorStop(0, `rgb(${cr * gHot * v | 0},${cg * gHot * v | 0},${cb * (1 + 0.18 * form) * v | 0})`);
        g.addColorStop(0.62, `rgb(${cr * v | 0},${cg * v | 0},${cb * v | 0})`);
        g.addColorStop(1, `rgb(${cr * gRim * v | 0},${cg * gRim * v | 0},${cb * (1 - 0.34 * form) * v | 0})`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.ellipse(bx, by, br, br * be, bt, 0, Math.PI * 2);
        ctx.fill();
      };
      blob(cx, cy, rad, ecc, tilt, 1);
      for (const [count, sMin, sMax, reach] of tiers) {
        const n2 = count + Math.floor(r() * count * 0.7);
        for (let k = 0; k < n2; k++) {
          const a = r() * Math.PI * 2;
          const rr = Math.pow(r(), 0.5) * reach;
          const bx = cx + Math.cos(a) * rad * rr;
          const by = cy + Math.sin(a) * rad * ecc * rr;
          // Upper lobes catch sky; the ones hanging under the crown do not.
          const up = clamp(1 - (by - (cy - rad * ecc)) / (2 * rad * ecc), 0, 1);
          const v = (0.74 + 0.46 * up * up) * (0.88 + r() * 0.26);
          blob(bx, by, rad * lerp(sMin, sMax, r()), 0.6 + r() * 0.7, r() * 3.14,
            1 + (v - 1) * (0.35 + 0.65 * form));
        }
      }
    }
    // Chew gaps into the crown so the top edge is not a solid felt line. Scaled
    // with the crown, or a 60 px crown swallows a 6 px bite whole.
    ctx.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < chew; i++) {
      const cx = r() * w;
      const cs = 0.55 + 0.45 * crown;
      const cy = h * (1 - at(cx)) - 2 + (r() - 0.5) * 14 * cs;
      ctx.beginPath();
      ctx.ellipse(cx, cy, (3 + r() * 11) * cs, (3 + r() * 11) * cs * 0.8,
        r() * 3.14, 0, Math.PI * 2);
      ctx.fill();
    }
    // Taper the ends to nothing. Without this every card is a hard-edged
    // rectangle and a row of them reads as a chain of dark bricks rather than
    // one continuous boundary — the whole reason to overlap them at all.
    for (let x = 0; x < w; x++) {
      const e = Math.min(x, w - 1 - x) / (w * 0.16);
      if (e >= 1) continue;
      // Ragged, not linear, so the join between two cards is not a straight cut.
      const ragged = e * (0.80 + 0.34 * Math.sin(x * 0.37 + 1.7) * Math.sin(x * 0.11));
      ctx.globalAlpha = clamp(1.0 - ragged, 0, 1);
      ctx.fillRect(x, 0, 1, h);
      ctx.globalAlpha = 1;
    }
    ctx.globalCompositeOperation = 'source-over';
  }, { wrapS: THREE.ClampToEdgeWrapping });
}

/**
 * 2x2 atlas of broadleaf crowns.
 *
 * THIS USED TO BE A PILE OF SHADED SPHERES, AND THAT IS ALL ANYONE SAW.
 *
 * The old build stamped ~240 filled `arc()`s per cell, each one carrying its own
 * three-stop radial gradient — light at the upper-left, dark at the rim. A radial
 * gradient inside a hard circular fill IS a rendered ball: at any size where the
 * blob is more than a few pixels across, the eye reads sphere, and a crown built
 * from them reads as bubble-wrap with hard circular terminators. It capped the
 * `wide` shot on its own.
 *
 * A canopy is not made of balls, and the three things that make one read are:
 *
 *   1. ONE light direction for the WHOLE crown, not one per blob. Shading here
 *      is a function of position in the crown only (`litAt`), so the mass has a
 *      single lit shoulder and a single shadowed underside. Per-mark variation
 *      is value jitter, never a gradient.
 *   2. A silhouette broken at LEAF-CLUSTER scale. The outer 40 % of the crown is
 *      not filled at all — it is built out of ~4 500 small elongated leaf marks
 *      whose density falls off to nothing at the envelope, so `alphaTest` carves
 *      a ragged, perforated edge instead of a circle. There is no filled disc
 *      anywhere near the outline.
 *   3. Structure INSIDE the mass: limbs that fork, and sky holes punched through
 *      the crown so the background shows between the branches. A canopy with no
 *      holes in it is a shrub.
 *
 * The envelope itself is a 3-octave angular wobble on an ellipse, so even the
 * region the marks fill is not round.
 */
function crownAtlas() {
  return canvasTexture('env/crowns', 1024, 1024, (ctx, w, h) => {
    ctx.clearRect(0, 0, w, h);
    const r = makeRng(hashSeed('crowns', 41));
    const C = w / 2;
    // Foliage palette. B/G 0.72 at the base and 0.66 at the lit tip — the same
    // argument as the turf ramp: leaves in sun are a desaturated yellow-green,
    // and the old (34,44,24)/(118,132,66) pair at B/G 0.50 was the acid green
    // the whole world was accused of.
    const base = [34, 43, 32], tip = [104, 116, 77];
    for (let cell = 0; cell < 4; cell++) {
      const ox = (cell % 2) * C, oy = ((cell >> 1) & 1) * C;
      // Envelope: a squashed ellipse with a three-octave angular wobble, so the
      // crown is lumpy before a single leaf is drawn.
      const rx = C * (0.40 + 0.06 * (cell % 2));
      const ry = C * (0.36 + 0.08 * ((cell >> 1) & 1));
      const cx = ox + C * 0.5, cy = oy + C * 0.52;
      const p0 = r() * 6.2832, p1 = r() * 6.2832, p2 = r() * 6.2832;
      const env = (a) => 1 + 0.19 * Math.sin(3 * a + p0) + 0.12 * Math.sin(5 * a + p1)
        + 0.07 * Math.sin(9 * a + p2);
      ctx.save();
      ctx.beginPath();
      ctx.rect(ox, oy, C, C);
      ctx.clip();

      /**
       * ONE light for the crown. `t` runs 0 at the shadowed lower-right to 1 at
       * the lit upper-left shoulder, with a small centre-darkening so the middle
       * of the mass sits behind its own leaves.
       */
      const litAt = (x, y) => {
        const nx = (x - cx) / rx, ny = (y - cy) / ry;
        const dir = clamp(0.52 - ny * 0.62 - nx * 0.20, 0, 1);
        const core = 1 - 0.26 * clamp(1.15 - Math.hypot(nx, ny), 0, 1);
        return clamp(dir * core, 0, 1);
      };
      const inkAt = (x, y, j) => {
        const t = Math.pow(litAt(x, y), 1.35) * j;
        return `rgb(${lerp(base[0], tip[0], t) | 0},${lerp(base[1], tip[1], t) | 0},${lerp(base[2], tip[2], t) | 0})`;
      };

      // --- limbs -------------------------------------------------------------
      // Drawn before the foliage so the leaf marks bury most of them; what
      // survives shows through the sky holes punched at the end.
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgb(46,37,29)';
      const limb = (x, y, ang, len, wid, depth) => {
        const ex = x + Math.cos(ang) * len, ey = y + Math.sin(ang) * len;
        ctx.lineWidth = wid;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.quadraticCurveTo(x + Math.cos(ang - 0.2) * len * 0.6, y + Math.sin(ang - 0.2) * len * 0.6, ex, ey);
        ctx.stroke();
        if (depth <= 0) return;
        for (let k = 0; k < 2; k++) {
          limb(ex, ey, ang + (k ? 0.55 : -0.5) + (r() - 0.5) * 0.4, len * (0.52 + r() * 0.18),
            Math.max(1, wid * 0.55), depth - 1);
        }
      };
      const bx0 = cx + (r() - 0.5) * rx * 0.18;
      for (let i = 0; i < 3; i++) {
        limb(bx0, cy + ry * 0.92, -Math.PI / 2 + (i - 1) * 0.42 + (r() - 0.5) * 0.2,
          ry * (0.62 + r() * 0.22), C * 0.020, 2);
      }

      /**
       * FOLIAGE. Clusters of small elongated marks, never a filled disc. Density
       * is highest at the crown centre and falls to zero at the envelope, which
       * is what makes the alpha-tested outline ragged rather than circular.
       */
      const mark = (x, y, j, alpha) => {
        ctx.globalAlpha = alpha;
        ctx.fillStyle = inkAt(x, y, j);
        ctx.beginPath();
        ctx.ellipse(x, y, C * (0.010 + r() * 0.014), C * (0.005 + r() * 0.008),
          r() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      };
      // 190 clusters; the outer ones get fewer, more scattered marks so the
      // mass thins into the sky instead of ending at a line.
      for (let i = 0; i < 190; i++) {
        const a = r() * Math.PI * 2;
        const rad = Math.pow(r(), 0.52);
        const e = env(a);
        const gx = cx + Math.cos(a) * rx * rad * e;
        const gy = cy + Math.sin(a) * ry * rad * e;
        const spread = C * (0.045 + r() * 0.055) * lerp(1.0, 1.5, rad);
        const n = Math.round(lerp(34, 14, rad));
        const j = 0.82 + r() * 0.36;
        for (let k = 0; k < n; k++) {
          const ma = r() * Math.PI * 2;
          const mr = Math.pow(r(), 0.6) * spread;
          mark(gx + Math.cos(ma) * mr, gy + Math.sin(ma) * mr, j,
            rad > 0.82 ? 0.55 + r() * 0.45 : 1.0);
        }
      }
      ctx.globalAlpha = 1;

      // --- sky holes and bitten outline ---------------------------------------
      // `destination-out` at the same scale as a leaf cluster: holes through the
      // crown, and bites out of the edge. Both are what a real canopy has and a
      // stamped blob does not.
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = '#000';
      for (let i = 0; i < 10; i++) {
        const a = r() * Math.PI * 2;
        const rad = Math.pow(r(), 0.7) * 0.72;
        const hx = cx + Math.cos(a) * rx * rad, hy = cy + Math.sin(a) * ry * rad;
        for (let k = 0; k < 4; k++) {
          ctx.beginPath();
          ctx.ellipse(hx + (r() - 0.5) * C * 0.05, hy + (r() - 0.5) * C * 0.05,
            C * (0.010 + r() * 0.016), C * (0.007 + r() * 0.012), r() * Math.PI, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      for (let i = 0; i < 150; i++) {
        const a = r() * Math.PI * 2;
        const e = env(a);
        const rad = 0.80 + r() * 0.30;
        ctx.beginPath();
        ctx.ellipse(cx + Math.cos(a) * rx * rad * e, cy + Math.sin(a) * ry * rad * e,
          C * (0.014 + r() * 0.030), C * (0.010 + r() * 0.022), r() * Math.PI, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
      ctx.restore();
      // Erode the cell border so neighbouring cells never bleed at low mips.
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = '#000';
      const m = C * 0.035;
      ctx.fillRect(ox, oy, C, m); ctx.fillRect(ox, oy + C - m, C, m);
      ctx.fillRect(ox, oy, m, C); ctx.fillRect(ox + C - m, oy, m, C);
      ctx.restore();
    }
  }, { wrapS: THREE.ClampToEdgeWrapping });
}

/** Simple spectator car: enough silhouette to read at 120 m, 5 boxes. */
function carParkGeometry() {
  return assets.geometry('env/parkcar', () => {
    const k = new Kit(0.5);
    k.box(1.78, 0.62, 4.28, { y: 0.66 });                       // body
    k.box(1.66, 0.52, 2.35, { y: 1.20, z: 0.10, colour: 0x5c6469 }); // glass house
    k.box(1.72, 0.10, 2.10, { y: 1.46, z: 0.10, colour: 0xdadedb }); // roof highlight
    for (const [x, z] of [[-0.82, -1.42], [0.82, -1.42], [-0.82, 1.42], [0.82, 1.42]]) {
      k.cyl(0.31, 0.20, 8, { x, y: 0.31, z, rz: Math.PI / 2, colour: 0x1c1e20 });
    }
    return k.build();
  });
}

/** Team/spectator coach. */
function coachGeometry() {
  return assets.geometry('env/coach', () => {
    const k = new Kit(0.35);
    k.box(2.55, 2.35, 12.0, { y: 1.85 });
    k.box(2.58, 0.90, 9.6, { y: 2.35, z: -0.6, colour: 0x39434a });  // window band
    k.box(2.30, 0.90, 0.10, { y: 2.35, z: -5.95, colour: 0x2f3a42 }); // screen
    k.box(2.62, 0.16, 12.1, { y: 3.02, colour: 0xd6dad6 });
    for (const z of [-4.2, 3.4, 4.6]) {
      k.cyl(0.50, 0.28, 10, { x: -1.15, y: 0.50, z, rz: Math.PI / 2, colour: 0x1a1c1e });
      k.cyl(0.50, 0.28, 10, { x: 1.15, y: 0.50, z, rz: Math.PI / 2, colour: 0x1a1c1e });
    }
    return k.build();
  });
}

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------

const CROWD_VERT = /* glsl */ `
attribute vec2 aCell;
attribute vec3 aTint;
attribute float aPhase;
uniform float uTime;
varying vec2 vUv;
varying vec3 vTint;
varying float vShade;
#include <fog_pars_vertex>
void main() {
  vUv = aCell + uv * vec2( ${(1 / CROWD_COLS).toFixed(6)}, ${(1 / CROWD_ROWS).toFixed(6)} );
  vTint = aTint;
  float t = uTime * 1.9 + aPhase * 6.2831;
  float jump = pow( max( sin( t ), 0.0 ), 3.0 );
  vec3 p = position;
  p.x += sin( uTime * 1.1 + aPhase * 12.0 ) * 0.04;
  vec4 world = instanceMatrix * vec4( p, 1.0 );
  world.y += jump * 0.15;
  vec4 mvPosition = modelViewMatrix * world;
  vShade = 0.66 + 0.34 * uv.y;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const CROWD_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uLight;
varying vec2 vUv;
varying vec3 vTint;
varying float vShade;
#include <fog_pars_fragment>
void main() {
  vec4 t = texture2D( uMap, vUv );
  /**
   * COVERAGE-PRESERVING CUT-OUT.
   *
   * A fixed threshold against a MIPPED alpha is what makes a sprite crowd crawl:
   * a spectator is ~5 px at 100 m, every mip below the top averages its alpha
   * down, and the 0.4 test then erodes each one at a slightly different distance
   * — so the stand fizzes as the camera moves, which is the review's 'noise
   * storm'. Rescaling alpha by its own screen-space gradient before the test
   * puts the cut back where the top mip had it, at every LOD, for one fwidth.
   */
  float a = ( t.a - 0.5 ) / max( fwidth( t.a ), 1e-5 ) + 0.5;
  if ( a < 0.5 ) discard;
  vec3 c = t.rgb * mix( vec3( 1.0 ), vTint, 0.6 );
  gl_FragColor = vec4( c * uLight * vShade, 1.0 );
  #include <fog_fragment>
}
`;

/**
 * FLAGS ARE SHADED CLOTH, NOT A FLAT FILL.
 *
 * The old pair sampled the atlas and multiplied by one constant, which is what
 * put an unshaded, fully saturated rectangle on the barrier in `wide` — it read
 * as a stray UI element composited into the world. The ripple already displaces
 * the surface, so its analytic derivative gives a real normal for nothing:
 * `dz/dw` against the flag's own width. That normal is keyed in VIEW space,
 * deliberately — `track/environment.js` has no handle on the sun (it is
 * `render/lighting.js`'s, and nothing hands it down), and a fixed world-space
 * key would be wrong at three of the nine shot times of day, whereas a camera
 * key always reads and never contradicts the frame.
 */
const FLAG_VERT = /* glsl */ `
attribute float aPhase;
attribute float aCell;
uniform float uTime;
uniform float uWidth;
varying vec2 vUv;
varying vec3 vNrm;
#include <fog_pars_vertex>
void main() {
  vUv = vec2( ( aCell + uv.x ) * 0.25, uv.y );
  vec3 p = position;
  float w = uv.x;
  float th = uTime * 6.0 + aPhase * 6.2831 + w * 7.0;
  p.z += sin( th ) * 0.30 * w * w;
  p.y += sin( uTime * 4.3 + aPhase * 3.1 + w * 5.0 ) * 0.10 * w;
  // d(p.z)/dw of the line above; uWidth is d(p.x)/dw.
  float dz = 0.30 * ( cos( th ) * 7.0 * w * w + sin( th ) * 2.0 * w );
  vec3 nLocal = normalize( vec3( -dz, 0.0, uWidth ) );
  vNrm = normalize( mat3( modelViewMatrix ) * mat3( instanceMatrix ) * nLocal );
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4( p, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const FLAG_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uLight;
varying vec2 vUv;
varying vec3 vNrm;
#include <fog_pars_fragment>
void main() {
  vec4 t = texture2D( uMap, vUv );
  vec3 L = normalize( vec3( -0.42, 0.52, 0.74 ) );
  float nl = abs( dot( normalize( vNrm ), L ) );
  // Cloth: a broad wrap term, a soft sheen on the folds facing the key, and the
  // hem sitting in its own shadow.
  float shade = 0.56 + 0.44 * nl + 0.14 * pow( nl, 6.0 );
  shade *= 0.84 + 0.16 * smoothstep( 0.0, 0.22, vUv.y );
  gl_FragColor = vec4( t.rgb * uLight * shade, 1.0 );
  #include <fog_fragment>
}
`;

/**
 * Instanced grass cards.
 *
 * The card SHRINKS with view distance instead of fading: an alpha ramp on a
 * discard-based material either pops or needs sorting, whereas collapsing the
 * quad toward its own root is free, order-independent, and lets the textured
 * ground take over seamlessly. `uFade = (start, end)` in metres.
 */
const TUFT_VERT = /* glsl */ `
attribute vec3 aTint;
attribute float aPhase;
attribute vec2 aWin;
uniform float uTime;
uniform vec2 uFade;
varying vec2 vUv;
varying vec3 vTint;
varying float vShade;
#include <fog_pars_vertex>
void main() {
  // Per-instance window into a wide blade atlas: aWin = (u0, u1). u1 < u0
  // mirrors the card, which doubles the apparent variety for nothing.
  vUv = vec2( mix( aWin.x, aWin.y, uv.x ), uv.y );
  vec4 root = instanceMatrix * vec4( 0.0, 0.0, 0.0, 1.0 );
  float dist = -( modelViewMatrix * root ).z;
  float keep = 1.0 - smoothstep( uFade.x, uFade.y, dist );
  vec3 p = position;
  float bend = uv.y * uv.y;
  float w = sin( uTime * 1.7 + aPhase * 6.2831 ) * 0.5 + sin( uTime * 3.3 + aPhase * 11.0 ) * 0.2;
  p.x += w * 0.16 * bend;
  p.z += w * 0.10 * bend;
  p *= keep;
  vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4( p, 1.0 );
  // Blades are dark at the root and catch the sky at the tip. The floor used to
  // be 0.34, which made every card's lower half darker than any ground pixel.
  vShade = 0.74 + 0.30 * uv.y;
  vTint = aTint;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

/**
 * The card texture supplies STRUCTURE, the turf ramp supplies COLOUR.
 *
 * This is the same trick `turfGrade` plays on the ground, and it is the reason
 * the cards can no longer read as a rash of dark spots on a bright sheet: both
 * layers are now driven by one pair of turf colours, so a tuft is guaranteed to
 * land inside the ground's own hue and value range whatever the exposure does.
 * `0.115` is the mean linear luminance of the baked blade card — dividing by it
 * makes the ramp lookup unit-mean.
 */
const TUFT_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uLight;
uniform vec3 uTurf;
uniform vec3 uTurfDry;
varying vec2 vUv;
varying vec3 vTint;
varying float vShade;
#include <fog_pars_fragment>
void main() {
  vec4 t = texture2D( uMap, vUv );
  if ( t.a < 0.42 ) discard;
  float bl = dot( t.rgb, vec3( 0.32, 0.55, 0.13 ) ) / 0.115;
  vec3 turf = mix( uTurf, uTurfDry, clamp( ( bl - 0.90 ) * 1.1, 0.0, 1.0 ) );
  gl_FragColor = vec4( turf * clamp( bl, 0.58, 1.20 ) * vTint * uLight * vShade, 1.0 );
  #include <fog_fragment>
}
`;

/** Kills visible tiling by blending the albedo at incommensurate scales. */
function breakTiling(mat, macro = 0.173, low = 0.041, strength = 0.45) {
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      /* glsl */ `
      #include <map_fragment>
      {
        vec3 macroC = texture2D( map, vMapUv * ${macro.toFixed(4)} ).rgb;
        float lowV = texture2D( map, vMapUv * ${low.toFixed(4)} ).g;
        diffuseColor.rgb = mix( diffuseColor.rgb, macroC, ${strength.toFixed(3)} );
        diffuseColor.rgb *= 0.80 + 0.44 * lowV;
      }`
    );
  };
  mat.customProgramCacheKey = () => `env-tilebreak-${macro}-${low}`;
  return mat;
}

/**
 * Turf grade — the single most important thing in the whole trackside frame.
 *
 * The shared `grass()` generator bakes a saturated primary green (albedo ratios
 * around R 0.42 : G 1.00 : B 0.26). Real circuit grass in sun is a *desaturated
 * yellow-green* and it is not one colour: it runs from a cold shadowed olive in
 * the sward to bleached straw on the crowns. So instead of tinting the texture —
 * which only slides the same hue around — this throws the baked albedo's
 * *luminance* through a three-stop turf ramp and keeps only its spatial detail.
 *
 * THE BLUE CHANNEL IS THE WHOLE ARGUMENT, AND ROUND 5 SHIPPED IT MISSING.
 *
 * The ramp used to run at B/G ≈ 0.50 in sRGB, on the reasoning that a photograph
 * of turf "has almost no blue in it". Under round 4's lighting that survived,
 * because the sky IBL was putting the blue back. Round 5 traded IBL for key
 * (`environmentIntensity` 1.55 -> 1.46, sun 4.2 -> 5.1) and the grade behind it
 * pushes saturation further, so the same albedo came out of the pipe at B/G 0.36
 * and 64 % saturation — fluorescent chartreuse in `chase`, `grid` and `wide`.
 * Measured, sunlit verge in `chase`: r4 (84,89,58) s 34.7 -> r5 (93,101,38) s 62.5.
 *
 * A real diffuse turf albedo is about R 0.05 : G 0.10 : B 0.045 in LINEAR light,
 * which is B/G ≈ 0.67 once encoded to sRGB — grass is dark and only mildly green,
 * and dusty mown circuit turf is duller still. Every stop of every ramp below
 * therefore sits at B/G 0.66-0.72. Do not "fix" a washed-out look by pulling the
 * blue back out; if the field reads flat, move `mid` DOWN in value, not toward
 * the primary.
 *
 * On top of that: mown stripes (a mower lays the blades toward or away from you
 * and the reflectance genuinely differs by ~12 %), two octaves of colour macro
 * so a 400 m field is not one flat card, and an optional darkening toward the
 * barrier where the machine cannot reach and the grass sits in shadow.
 *
 *   stripe.x  metres per stripe (0 disables)
 *   stripe.y  0 = stripes run along UV.y (lateral bands), 1 = along UV.x
 */
function turfGrade(mat, o = {}) {
  const shadow = new THREE.Color(o.shadow ?? 0x37402a);
  const mid = new THREE.Color(o.mid ?? 0x636c49);
  const dry = new THREE.Color(o.dry ?? 0x9c9d78);
  const dirt = new THREE.Color(o.dirt ?? 0x6d5f45);
  const stripeM = o.stripeMetres ?? 0;
  const stripeAxis = o.stripeAxis ?? 0;
  const stripeAmt = o.stripeAmount ?? 0.11;
  const uvPerMetre = o.uvPerMetre ?? (1 / 3);
  const stripeWorld = !!o.stripeWorld;
  const stripeAngle = o.stripeAngle ?? 0.0;
  const macroA = o.macroA ?? 0.0135;
  const macroB = o.macroB ?? 0.0018;
  // Field parcels: agricultural land is a mosaic of 80–200 m plots, each cut or
  // grazed on its own schedule. Quantising the far-field tone per cell is the
  // single cheapest thing that stops open country reading as one green card.
  const parcelM = o.parcelMetres ?? 0;
  const parcelAmt = o.parcelAmount ?? 0.0;
  const fine = o.fine ?? 0.10;
  const key = `turf-${o.key ?? 'a'}`;

  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTurfShadow = { value: shadow };
    shader.uniforms.uTurfMid = { value: mid };
    shader.uniforms.uTurfDry = { value: dry };
    shader.uniforms.uTurfDirt = { value: dirt };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTurfW;')
      .replace('#include <project_vertex>', '#include <project_vertex>\n\tvTurfW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec3 uTurfShadow;
uniform vec3 uTurfMid;
uniform vec3 uTurfDry;
uniform vec3 uTurfDirt;
varying vec3 vTurfW;
float turfHash( vec2 i ) {
  return fract( sin( dot( i, vec2( 127.1, 311.7 ) ) ) * 43758.5453 );
}
float turfNoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  vec4 h = fract( sin( vec4(
    dot( i, vec2( 127.1, 311.7 ) ),
    dot( i + vec2( 1.0, 0.0 ), vec2( 127.1, 311.7 ) ),
    dot( i + vec2( 0.0, 1.0 ), vec2( 127.1, 311.7 ) ),
    dot( i + vec2( 1.0, 1.0 ), vec2( 127.1, 311.7 ) ) ) ) * 43758.5453 );
  return mix( mix( h.x, h.y, f.x ), mix( h.z, h.w, f.x ), f.y );
}`)
      .replace('#include <map_fragment>', `#include <map_fragment>
{
  // Spatial detail only — the baked hue is thrown away.
  float turfL = dot( diffuseColor.rgb, vec3( 0.32, 0.55, 0.13 ) );
  // Blend in a far-out-of-phase sample of the same tile: kills the repeat
  // without a second texture and without washing the blade detail out.
  turfL = mix( turfL, dot( texture2D( map, vMapUv * 0.1730 ).rgb, vec3( 0.32, 0.55, 0.13 ) ), 0.42 );
  turfL *= 0.80 + 0.40 * dot( texture2D( map, vMapUv * 0.0410 ).rgb, vec3( 0.32, 0.55, 0.13 ) ) * 3.0;
  // The baked albedo's luminance sits around 0.09; centre the ramp on THAT so
  // the median lands on the mid tone. (It used to be turfL * 3.0, which pinned
  // most of the field to the top of the ramp — the flat chartreuse sheet.)
  float t = clamp( 0.5 + ( turfL - 0.092 ) * 4.6, 0.0, 1.0 );
  vec3 turf = t < 0.5
    ? mix( uTurfShadow, uTurfMid, t * 2.0 )
    : mix( uTurfMid, uTurfDry, ( t - 0.5 ) * 2.0 );

  // Patchiness: parched crowns, damp hollows, mower misses. The two pushes are
  // SYMMETRIC about 0.5 — an asymmetric pair biases the whole field one way.
  float m1 = turfNoise( vTurfW.xz * ${macroA.toFixed(5)} );
  float m2 = turfNoise( vTurfW.xz * ${macroB.toFixed(5)} + 31.7 );
  float m3 = turfNoise( vTurfW.xz * 0.115 + 7.3 );
  float mm = clamp( m1 * 0.58 + m2 * 0.42, 0.0, 1.0 );
  turf = mix( turf, uTurfDry, smoothstep( 0.54, 0.96, mm ) * 0.72 );
  turf = mix( turf, uTurfShadow, smoothstep( 0.46, 0.06, mm ) * 0.58 );
  turf *= 0.88 + 0.24 * m3;
  // Tuft-scale value break (0.6 m and 2 m). Cheap, and it is what keeps the
  // ground from going perfectly smooth the moment the grass cards fade out.
  // Both octaves are sampled on ROTATED axes: value noise on a world-aligned
  // lattice quilts, and at a grazing angle that quilt reads as corduroy.
  // DISTANCE CLAMP on every high-frequency turf term. A stripe or a corduroy
  // whose pitch falls below a couple of pixels does not average away, it beats
  // against the pixel grid — the strong diagonal moire across the mid-distance
  // of the wide shot. Everything periodic below is multiplied by this.
  float turfFar = 1.0 - smoothstep( 130.0, 260.0, length( vTurfW - cameraPosition ) );
  vec2 fr = vec2( vTurfW.x * 0.802 - vTurfW.z * 0.597, vTurfW.x * 0.597 + vTurfW.z * 0.802 );
  float f1 = turfNoise( fr * 1.70 + 4.1 );
  float f2 = turfNoise( fr.yx * 0.52 + 19.3 );
  turf *= 1.0 + ${fine.toFixed(3)} * ( f1 - 0.5 ) * 2.0 + ${(fine * 0.8).toFixed(3)} * ( f2 - 0.5 ) * 2.0;
${parcelM > 0 ? `
  // Parcel mosaic. Each cell gets its own value/dryness, and every fourth-ish
  // one is bare tilled earth, which is what a real aerial of race country is.
  {
    vec2 pq = vTurfW.xz / ${parcelM.toFixed(2)};
    vec2 pi = floor( pq );
    float ph = turfHash( pi );
    float ph2 = turfHash( pi + 71.3 );
    float ph3 = turfHash( pi * 1.37 + 11.9 );
    vec2 pf = abs( fract( pq ) - 0.5 );
    // Soften the seam so the mosaic is not a hard checkerboard from the air.
    float edgeSoft = smoothstep( 0.50, 0.36, max( pf.x, pf.y ) );
    float amt = ${parcelAmt.toFixed(3)} * mix( 0.55, 1.0, edgeSoft );
    float plough = smoothstep( 0.70, 0.97, ph2 );
    turf = mix( turf, uTurfDry, amt * smoothstep( 0.38, 1.0, ph ) );
    turf = mix( turf, uTurfDirt, amt * plough * 0.95 );
    turf *= 1.0 + amt * ( ph2 - 0.5 ) * 0.50;
    // Per-parcel corduroy: every field is cut, drilled or grazed on its own
    // bearing, and it is the CHANGE of bearing across a boundary — not the
    // stripe itself — that reads as farmland from an elevated camera.
    float pang = ph3 * 3.14159;
    float ppitch = mix( 4.6, 9.0, ph );
    float cord = sin( dot( vTurfW.xz, vec2( cos( pang ), sin( pang ) ) ) * 6.28318 / ppitch );
    // Amplitude has to reach zero before the pitch reaches a pixel or the whole
    // mid-distance moires. At 4.6-9 m pitch that is around 250 m.
    turf *= 1.0 + amt * mix( 0.052, 0.105, plough ) * cord * turfFar;
    // A HEDGE ON THE PARCEL BOUNDARY. The change of cutting bearing across a
    // seam has to have a visible cause; without one the boundary reads as a
    // texture seam, which is exactly what the hard tan diagonal was.
    float hedge = smoothstep( 0.4885, 0.4990, max( pf.x, pf.y ) );
    turf = mix( turf, uTurfShadow * 0.66, hedge * 0.80 );
    // A second, much broader land-use scale so the mosaic itself has regions.
    float bh = turfNoise( vTurfW.xz * ${(1 / (parcelM * 4.2)).toFixed(7)} + 5.7 );
    turf *= 0.90 + 0.22 * bh;
  }
` : ''}
  diffuseColor.rgb = turf;
${stripeM > 0 ? `
  float sAxis = ${stripeWorld
        ? `dot( vTurfW.xz, vec2( ${Math.cos(stripeAngle).toFixed(5)}, ${Math.sin(stripeAngle).toFixed(5)} ) )`
        : `${stripeAxis ? 'vMapUv.x' : 'vMapUv.y'} / ${uvPerMetre.toFixed(6)}`};
  // Flattened sine, not a hard band pair. A square wave at a grazing angle
  // aliases into fine corduroy the moment the stripe pitch falls below a few
  // pixels; a rounded profile mips down to its own mean instead.
  float sp = sin( sAxis * ${(Math.PI / stripeM).toFixed(6)} );
  float lit = sign( sp ) * pow( abs( sp ), 0.42 );
  diffuseColor.rgb *= 1.0 + lit * ${stripeAmt.toFixed(3)} * ${stripeWorld ? 'turfFar' : '1.0'};
` : ''}
}`);
  };
  mat.customProgramCacheKey = () => key;
  return mat;
}

function spriteMaterial(map, uTime, light = 1.18) {
  return new THREE.ShaderMaterial({
    uniforms: Object.assign({}, THREE.UniformsLib.fog, {
      uMap: { value: map },
      uLight: { value: new THREE.Color(light, light * 0.98, light * 0.94) },
      uTime,
    }),
    vertexShader: CROWD_VERT,
    fragmentShader: CROWD_FRAG,
    side: THREE.DoubleSide,
    fog: true,
  });
}

/**
 * TRACKSIDE PEOPLE — real geometry, not paper.
 *
 * These used to be camera-facing quads carrying one flat saturated fill each,
 * which at the 40 m of the `grid` shot read exactly as what they were: cut-outs
 * standing on the tarmac, several of them edge-on and therefore invisible. A
 * pit crew is the closest human reference in the frame and it has to have a
 * head, arms, legs and internal shading or nothing else in the pit lane is
 * believable.
 *
 * ~430 triangles, one InstancedMesh per pose. `mask = 1` marks the overall —
 * the parts the per-instance team colour tints; skin, gloves and boots stay
 * where they are painted. Vertex colour inside the overall is *not* flat: the
 * sleeves and legs sit 12–22 % darker than the chest so the figure has its own
 * form shading before a single light hits it.
 *
 * `pose`: 0 standing, 1 crouched over a wheel gun, 2 arms raised (lollipop /
 * marshal signalling).
 */
const SKIN_TONES = [0xc59a74, 0x9a6a45, 0xe0b491, 0x74492c, 0xb07f55];
/**
 * SIX POSES, NOT THREE.
 *
 * The review's crop of the pit lane showed every orange marshal in an identical
 * crouch and every blue crew member in an identical stand — two silhouettes
 * copy-pasted down the whole lane. Yaw was already jittered ±68°, which does
 * nothing when the silhouette itself is the tell, so the fix is more chains:
 * 3 walking, 4 arms-folded/leaning, 5 kneeling at the wheel. Each is one extra
 * ~430-triangle instanced draw, and every placement site now picks from a set.
 */
const FIGURE_POSES = 9;
function figureGeometry(pose) {
  return assets.geometry(`env/figure-${pose}`, () => {
    const k = new Kit(1.1);
    // Skin is `mask 2`, tinted per instance by `aSkin`; the vertex colour on
    // those parts is a shade multiplier only. `mask 1` is the overall.
    const MKIT = 1, MSKIN = 2;
    const dark = 0x1a1c20;
    /**
     * Limbs are drawn between EXPLICIT JOINT POSITIONS in the (y, z) plane at a
     * given x, not from angles: a tapered cylinder from a to b. Deriving segment
     * lengths from the hip height (the obvious way) shortens the whole leg as
     * the figure crouches, which gives a squat 0.34 m leg instead of a folded
     * 0.87 m one.
     */
    const limb = (x, a, b, r0, r1, colour, mask) => {
      const dy = b[0] - a[0], dz = b[1] - a[1];
      const len = Math.max(0.02, Math.hypot(dy, dz));
      k.cyl(r0, len, 5, {
        x, y: (a[0] + b[0]) / 2, z: (a[1] + b[1]) / 2,
        rx: Math.atan2(dz, dy), r2: r1, colour, mask,
      });
    };
    // Joint chains per pose: [y, z]. Standing is 1.78 m to the crown.
    const J = [
      { ankle: [0.075, 0.02], knee: [0.49, 0.03], hip: [0.92, 0.00], sh: [1.50, -0.02],
        elbow: [1.20, 0.04], wrist: [0.93, 0.11], foot: 0.035 },
      { ankle: [0.075, 0.06], knee: [0.50, 0.30], hip: [0.62, -0.06], sh: [1.14, 0.16],
        elbow: [0.94, 0.42], wrist: [0.72, 0.58], foot: 0.035 },
      { ankle: [0.075, 0.02], knee: [0.49, 0.03], hip: [0.92, 0.00], sh: [1.50, -0.02],
        elbow: [1.74, 0.10], wrist: [1.99, 0.04], foot: 0.035 },
      // 3 — walking: legs split fore/aft, opposite arm swing, slight forward lean.
      { ankle: [0.075, -0.30], knee: [0.47, -0.14], hip: [0.90, 0.02], sh: [1.48, -0.06],
        elbow: [1.19, -0.20], wrist: [0.96, -0.34], foot: 0.035,
        split: [0.30, -0.26], armSplit: [-0.34, 0.30] },
      // 4 — stood with arms folded, weight on one hip.
      { ankle: [0.075, 0.02], knee: [0.49, 0.05], hip: [0.92, 0.02], sh: [1.50, -0.04],
        elbow: [1.24, 0.20], wrist: [1.19, -0.02], foot: 0.035, lean: 0.06 },
      // 5 — kneeling at the wheel: one knee down, torso upright, hands forward.
      { ankle: [0.075, 0.10], knee: [0.30, -0.16], hip: [0.60, 0.10], sh: [1.16, 0.02],
        elbow: [0.96, 0.24], wrist: [0.86, 0.50], foot: 0.035, split: [0.0, -0.30] },
      /**
       * 6–8 exist because the review counted TWO silhouettes copy-pasted down
       * the whole pit lane. `armY` offsets each arm's elbow and wrist
       * independently, which is what makes an ASYMMETRIC pose possible at all —
       * every chain above drives both arms off one pair of joints, so a figure
       * could only ever be bilaterally symmetric.
       */
      // 6 — stood with hands on hips, feet apart, weight back.
      { ankle: [0.075, 0.02], knee: [0.49, -0.02], hip: [0.92, -0.04], sh: [1.50, 0.04],
        elbow: [1.20, -0.14], wrist: [0.99, 0.02], foot: 0.035, lean: 0.05,
        armSplit: [-0.05, -0.05] },
      // 7 — talking on the radio: one arm up to the ear, the other hanging.
      { ankle: [0.075, 0.02], knee: [0.49, 0.03], hip: [0.92, 0.00], sh: [1.50, -0.02],
        elbow: [1.19, 0.06], wrist: [0.95, 0.10], foot: 0.035,
        armY: [0, 0.38], armSplit: [0.02, -0.14] },
      // 8 — carrying: torso pitched forward, both arms low and out in front.
      { ankle: [0.075, -0.12], knee: [0.47, -0.02], hip: [0.88, 0.06], sh: [1.42, 0.20],
        elbow: [1.14, 0.36], wrist: [0.99, 0.52], foot: 0.035,
        split: [0.16, -0.14] },
    ][pose];
    const split = J.split ?? [0, 0];
    const armSplit = J.armSplit ?? [0, 0];
    const armY = J.armY ?? [0, 0];
    for (let li = 0; li < 2; li++) {
      const sx = li ? 1 : -1;
      const lx = sx * 0.115;
      const dz = split[li];
      const ank = [J.ankle[0], J.ankle[1] + dz];
      const kne = [J.knee[0], J.knee[1] + dz * 0.55];
      k.box(0.115, 0.075, 0.28, { x: lx, y: J.foot, z: ank[1] + 0.06, colour: dark });
      limb(lx, ank, kne, 0.062, 0.055, 0xffffff, MKIT);
      limb(lx, kne, J.hip, 0.080, 0.070, 0xe2e2e2, MKIT);
    }
    // Torso: hips block, then the spine as one tapered barrel to the shoulders.
    k.box(0.325, 0.20, 0.215, { y: J.hip[0] + 0.04, z: J.hip[1], colour: 0xd2d2d2, mask: MKIT });
    limb(0, [J.hip[0] + 0.06, J.hip[1]], [J.sh[0] - 0.02, J.sh[1]], 0.190, 0.205, 0xffffff, MKIT);
    const shLean = Math.atan2(J.sh[1] - J.hip[1], J.sh[0] - J.hip[0]);
    k.box(0.44, 0.15, 0.24, { y: J.sh[0], z: J.sh[1], rx: shLean, colour: 0xf2f2f2, mask: MKIT });
    // Head: neck, skull, team cap with a peak. The head sits above the shoulder
    // line along the spine, so a crouched figure's head is forward as well as low.
    const hy = J.sh[0] + 0.20, hz = J.sh[1] + Math.sin(shLean) * 0.20;
    limb(0, [J.sh[0] + 0.03, J.sh[1]], [J.sh[0] + 0.11, J.sh[1] + 0.01], 0.052, 0.052, 0xd0d0d0, MSKIN);
    k.sph(0.105, 7, { y: hy, z: hz - 0.01, scale: [1, 1.12, 1.05], colour: 0xffffff, mask: MSKIN });
    k.sph(0.108, 7, { y: hy + 0.035, z: hz - 0.01, scale: [1, 0.62, 1.02], colour: 0xffffff, mask: MKIT });
    k.box(0.17, 0.024, 0.10, { y: hy + 0.025, z: hz + 0.11, colour: 0xe8e8e8, mask: MKIT });
    // Arms. `armSplit` swings them out of phase for the walking chain.
    for (let ai = 0; ai < 2; ai++) {
      const sx = ai ? 1 : -1;
      const ax = sx * 0.225;
      const dz = armSplit[ai];
      const dy = armY[ai];
      const elb = [J.elbow[0] + dy * 0.55, J.elbow[1] + dz];
      const wri = [J.wrist[0] + dy, J.wrist[1] + dz * 1.25];
      limb(ax, J.sh, elb, 0.054, 0.047, 0xe6e6e6, MKIT);
      limb(ax, elb, wri, 0.047, 0.042, 0xdadada, MKIT);
      const gy = wri[0] + (wri[0] - elb[0]) * 0.20;
      const gz = wri[1] + (wri[1] - elb[1]) * 0.20;
      k.box(0.078, 0.115, 0.078, { x: ax, y: gy, z: gz, colour: dark });
    }
    return k.build();
  });
}

/**
 * Material for the figures. `aKit` is the per-instance overall colour and
 * `aMask` says which vertices it applies to, because `instanceColor` would
 * otherwise dye the skin and the boots as well.
 */
function figureMaterial() {
  return assets.material('env/figureMat', () => {
    const m = new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.82, metalness: 0.02, envMapIntensity: 0.8,
      emissive: 0xffffff, emissiveIntensity: 1.0,
    });
    m.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>',
          '#include <common>\nattribute vec3 aKit;\nattribute vec3 aSkin;\nattribute float aMask;\n'
          + 'attribute float aFill;\nvarying float vApexFill;')
        .replace('#include <color_vertex>', /* glsl */`
          #include <color_vertex>
          vApexFill = aFill;
          vColor.xyz *= aMask < 0.5 ? vec3( 1.0 ) : ( aMask < 1.5 ? aKit : aSkin );`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vApexFill;')
        // Emissive is the material's own colour, so a figure lit this way keeps
        // its kit hue instead of turning into a white silhouette.
        .replace('#include <emissivemap_fragment>',
          '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= vApexFill * diffuseColor.rgb;');
    };
    m.customProgramCacheKey = () => 'apex-figure-kit-fill';
    return m;
  });
}

// ---------------------------------------------------------------------------

export class Environment {
  constructor(circuit, o = {}) {
    this.circuit = circuit;
    this.detail = o.detail ?? 'high';
    this.group = new THREE.Group();
    this.group.name = 'Environment';
    this.rng = makeRng(hashSeed('environment'));
    this.grandstands = [];
    this.barriers = [];
    this.animated = [];
    this._people = [];
    this._time = 0;
  }

  build() {
    this._computeBounds();
    this._computeCorridor();
    this._buildBaseField();

    this.group.add(this._buildTerrain());
    this.group.add(this._buildRunOff());
    this.group.add(this._buildVerge());
    this.group.add(this._buildServiceRoad());
    this.group.add(this._buildRunOffPaint());
    this.group.add(this._buildTrackside());
    this.group.add(this._buildTyreWalls());
    this.group.add(this._buildGrandstands());
    this.group.add(this._buildCrowd());
    this.group.add(this._buildPitLane());
    this.group.add(this._buildGantries());
    this.group.add(this._buildSignage());
    this.group.add(this._buildMarshalPosts());
    this.group.add(this._buildTowers());
    // Paddock clutter and the spectator estate. `_buildTracksideFurniture` was
    // written but never wired into build(), which is why the space behind every
    // barrier was bare grass.
    this.group.add(this._buildTracksideFurniture());
    this.group.add(this._buildSpectatorEstate());
    this.group.add(this._buildGrassTufts());
    this.group.add(this._buildTrees());
    this.group.add(this._buildFarLandscape());
    this.group.add(this._buildDistantBuildings());
    // Every human in the world is collected by the builders above and emitted
    // here, so the whole population is FIGURE_POSES draw calls rather than one
    // per site.
    this.group.add(this._buildPeople());
    return this.group;
  }

  /** Crowd bob, flags and grass wind. Deterministic: driven by accumulated dt. */
  update(dt) {
    this._time += dt;
    for (const u of this.animated) u.value = this._time;
  }

  // -- orientation helpers --------------------------------------------------

  /**
   * Quaternion for a trackside object that must face the racing surface.
   * Right-handed on both sides — see the header note.
   */
  _faceTrack(sm, side, q = new THREE.Quaternion()) {
    return q.setFromRotationMatrix(_m2.makeBasis(
      _fa.copy(sm.tangent).multiplyScalar(-side),
      UP,
      _fb.copy(sm.right).multiplyScalar(-side)
    ));
  }

  /** Quaternion for an object aligned with the direction of travel. */
  _alongTrack(sm, q = new THREE.Quaternion()) {
    return q.setFromRotationMatrix(_m2.makeBasis(
      _fa.copy(sm.tangent), UP, _fb.copy(sm.right)
    ));
  }

  // -- corridor -------------------------------------------------------------

  _computeBounds() {
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, sumY = 0;
    for (const s of this.circuit.samples) {
      minX = Math.min(minX, s.position.x); maxX = Math.max(maxX, s.position.x);
      minZ = Math.min(minZ, s.position.z); maxZ = Math.max(maxZ, s.position.z);
      sumY += s.position.y;
    }
    this.trackBox = { minX, maxX, minZ, maxZ };
    this.meanY = sumY / this.circuit.samples.length;
    const pad = 300;
    this.bounds = { minX: minX - pad, maxX: maxX + pad, minZ: minZ - pad, maxZ: maxZ + pad };
    this.centre = new THREE.Vector3((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
    this.radius = Math.hypot(maxX - minX, maxZ - minZ) * 0.5;
  }

  _ci(i, side) { return i * 2 + (side > 0 ? 1 : 0); }

  _computeCorridor() {
    const c = this.circuit;
    const n = c.samples.length;
    const hw = c.halfWidth;
    const runoff = new Float32Array(n * 2);
    const margin = new Float32Array(n * 2);
    const gravelA = new Float32Array(n * 2);
    const paintA = new Float32Array(n * 2);
    const tail = new Float32Array(n * 2);
    const carve = new Float32Array(n * 2);
    const type = new Uint8Array(n * 2);
    const skip = new Uint8Array(n * 2);

    // Corner segmentation, so a whole corner shares a gravel / tyre-wall choice.
    const cornerId = new Int32Array(n).fill(-1);
    let cid = -1, last = -999;
    for (let i = 0; i < n; i++) {
      if (Math.abs(c.samples[i].curvature) > 0.0026) {
        if (i - last > 14) cid++;
        cornerId[i] = cid; last = i;
      }
    }
    // CORNER CHARACTER. `type` was already returned but barely varied: the run
    // was gravel-or-nothing, so every corner exit in the three review frames
    // was grass straight to the barrier. A real circuit picks its run-off by
    // approach speed — paved apron where the cars arrive fast (so they can keep
    // it), gravel where they arrive slow (so they stop) — and the widths are set
    // by what land was available, not by a formula. Both are modelled here.
    const corners = [];
    for (let k = 0; k <= cid; k++) {
      const r = makeRng(hashSeed(`corner-${k}`));
      const roll = r();
      corners.push({
        // paved 45 %, gravel 35 %, plain grass 20 %.
        paved: roll < 0.45, gravel: roll >= 0.45 && roll < 0.80,
        blue: r() < 0.3, tyres: r() < 0.55,
        // Per-corner apron generosity: some corners simply have more room.
        room: 0.72 + r() * 0.62,
      });
    }
    // Low-frequency breathing on the corridor widths, so run-off, verge and
    // barrier are not three perfectly parallel concentric ribbons.
    const breathe = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const u = i / n;
      breathe[i] = 1 + 0.30 * (fbm(u, 0.31, { freq: 7, octaves: 3, seed: 613 }) * 2 - 1)
        + 0.14 * (fbm(u, 0.77, { freq: 19, octaves: 2, seed: 941 }) * 2 - 1);
    }

    // Pit-lane window: no armco / catch fence on the inside, the pit wall does it.
    this.pitFrom = c.wrapS(-430);
    this.pitTo = c.wrapS(250);
    const inPit = (s) => (this.pitFrom < this.pitTo
      ? s >= this.pitFrom && s <= this.pitTo
      : s >= this.pitFrom || s <= this.pitTo);

    for (let i = 0; i < n; i++) {
      const sm = c.samples[i];
      const k = sm.curvature;
      const ak = Math.abs(k);
      const sev = clamp((ak - 0.0016) / 0.0095, 0, 1);
      const corner = cornerId[i] >= 0 ? corners[cornerId[i]] : null;
      const pit = inPit(sm.s);
      for (const side of [-1, 1]) {
        const ix = this._ci(i, side);
        const outside = Math.sign(k) !== side && ak > 0.0016;
        const room = corner ? corner.room : 1;
        const br = breathe[i] * (outside ? room : 1);
        runoff[ix] = (outside ? 4.2 + 21 * sev * sev : 3.4 + 2.5 * sev) * br;
        margin[ix] = (outside ? 3.0 + 5.5 * (1 - sev) : 5.0 + 3.0 * (1 - sev))
          * (2 - clamp(br, 0.6, 1.4));
        gravelA[ix] = outside && corner && corner.gravel ? smoothstep(0.18, 0.55, sev) : 0;
        // Paved apron: only where the corner is a paved one, and it reaches
        // further out than the old blanket ramp did.
        paintA[ix] = outside && corner && corner.paved ? smoothstep(0.06, 0.30, sev) : 0;
        if (corner && corner.blue) paintA[ix] *= -1;   // sign selects blue paint

        if (pit && side < 0) {
          runoff[ix] = 1.8; margin[ix] = 0.6; gravelA[ix] = 0; paintA[ix] = 0;
          skip[ix] = 1;
          type[ix] = WALL;
        } else if (pit) {
          type[ix] = WALL;
        } else if (outside && sev > 0.55 && corner && corner.tyres) type[ix] = TYRES;
        else if (outside && sev > 0.42) type[ix] = TECPRO;
        else type[ix] = ARMCO;
      }
    }

    const smooth = (arr, passes) => {
      const tmp = new Float32Array(arr.length);
      for (let p = 0; p < passes; p++) {
        for (let i = 0; i < n; i++) {
          for (let s = 0; s < 2; s++) {
            const a = arr[((i - 1 + n) % n) * 2 + s], b = arr[((i + 1) % n) * 2 + s];
            tmp[i * 2 + s] = arr[i * 2 + s] * 0.5 + (a + b) * 0.25;
          }
        }
        arr.set(tmp);
      }
    };
    smooth(runoff, 22);
    smooth(margin, 22);
    smooth(gravelA, 10);
    smooth(paintA, 8);

    const barrier = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      for (const side of [-1, 1]) {
        const ix = this._ci(i, side);
        barrier[ix] = hw + 1.15 + runoff[ix] + margin[ix];
        tail[ix] = skip[ix] ? 0.5 : VERGE_TAIL;
        // The pit lane and its garages live under a flat carve.
        carve[ix] = skip[ix] ? hw + 34 : barrier[ix] + tail[ix];
      }
    }

    this.corr = { runoff, margin, barrier, tail, carve, gravel: gravelA, paint: paintA, type, skip, n };
  }

  corridorAt(s, side) {
    const ix = this._ci(this.circuit.sampleIndex(s), side);
    const c = this.corr;
    return { runoff: c.runoff[ix], margin: c.margin[ix], barrier: c.barrier[ix], tail: c.tail[ix], type: c.type[ix] };
  }

  /** Vertical drop of the run-off apron `ck` metres beyond the road verge. */
  _apron(ck) {
    return clamp(ck / 16, 0, 1) * 0.5 + clamp((ck - 16) / 28, 0, 1) * 1.15;
  }

  /**
   * Ground height at a lateral offset from a sample. Matches
   * `circuit._buildRoad` exactly out to the verge (±(hw + 1.1)) and continues
   * smoothly beyond — that is what glues run-off, grass and barriers to the road.
   */
  _edgeY(sm, lat) {
    const hw = this.circuit.halfWidth;
    const a = Math.abs(lat);
    const clamped = Math.min(a, hw + 1.1);
    const sgn = lat < 0 ? -1 : 1;
    const camber = -(clamped / hw) * 0.10 + sm.banking * sgn * clamped * 0.5;
    const verge = 0.09 * clamp((a - hw) / 1.1, 0, 1);
    return sm.position.y + camber - verge - this._apron(Math.max(0, a - (hw + 1.1)));
  }

  /** Height of the sculpted grass verge — the visible ground beside the run-off. */
  _vergeY(i, side, lat) {
    const ix = this._ci(i, side);
    const sm = this.circuit.samples[i];
    const inner = this.circuit.halfWidth + 1.15 + this.corr.runoff[ix];
    const outer = this.corr.barrier[ix] + this.corr.tail[ix];
    const t = clamp((Math.abs(lat) - inner) / Math.max(0.5, outer - inner), 0, 1);
    return this._edgeY(sm, lat) - 0.015 - VERGE_DROP * t * t * t;
  }

  // -- terrain --------------------------------------------------------------

  /**
   * Coarse (30 m) field of track-influenced elevation + distance to the track,
   * so the fine terrain grid needs only a handful of `circuit.nearest` calls.
   */
  _buildBaseField() {
    const b = this.trackBox;
    const pad = 460;
    const step = 30;
    const x0 = b.minX - pad, z0 = b.minZ - pad;
    const nx = Math.ceil((b.maxX - b.minX + pad * 2) / step) + 1;
    const nz = Math.ceil((b.maxZ - b.minZ + pad * 2) / step) + 1;
    const y = new Float32Array(nx * nz);
    const d = new Float32Array(nx * nz);
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) {
        const near = this.circuit.nearest(_v.set(x0 + i * step, 0, z0 + j * step));
        y[j * nx + i] = near.surfaceY;
        d[j * nx + i] = Math.abs(near.lateral);
      }
    }
    this._field = { x0, z0, step, nx, nz, y, d };
  }

  /**
   * Is (x, z) inside a built structure's footprint?
   *
   * Used by the vegetation scatters, which otherwise only ever test against the
   * track corridor and are therefore free to plant a tree in the middle of a
   * grandstand. Cheap on purpose: one circle per stand module, sized to cover a
   * 30 x 24 m module plus a working margin, centred on the deck rather than on
   * the module origin (which sits on the FRONT edge).
   */
  _inStructure(x, z) {
    const list = this._stands;
    if (!list) return false;
    for (let i = 0; i < list.length; i++) {
      const st = list[i];
      // `st.p` sits on the FRONT edge; the deck runs 24 m further outboard,
      // i.e. along +side*right. Centre it 13 m along that.
      const cxp = st.p.x + st.sm.right.x * st.side * 13;
      const czp = st.p.z + st.sm.right.z * st.side * 13;
      const dx = x - cxp, dz = z - czp;
      if (dx * dx + dz * dz < 26 * 26) return true;
    }
    return false;
  }

  _sampleField(x, z) {
    const f = this._field;
    const fx = clamp((x - f.x0) / f.step, 0, f.nx - 1.001);
    const fz = clamp((z - f.z0) / f.step, 0, f.nz - 1.001);
    const i = Math.floor(fx), j = Math.floor(fz);
    const tx = fx - i, tz = fz - j;
    const k = j * f.nx + i;
    const y = lerp(lerp(f.y[k], f.y[k + 1], tx), lerp(f.y[k + f.nx], f.y[k + f.nx + 1], tx), tz);
    const d = lerp(lerp(f.d[k], f.d[k + 1], tx), lerp(f.d[k + f.nx], f.d[k + f.nx + 1], tx), tz);
    const ex = Math.max(f.x0 - x, 0, x - (f.x0 + (f.nx - 1) * f.step));
    const ez = Math.max(f.z0 - z, 0, z - (f.z0 + (f.nz - 1) * f.step));
    return { y, d: d + Math.hypot(ex, ez) };
  }

  /** Rolling countryside relief, growing into hills with distance. */
  _relief(x, z) {
    const far = clamp((Math.hypot(x - this.centre.x, z - this.centre.z) - this.radius * 0.85) / 950, 0, 1);
    const u1 = ((x * 0.00055 + 8) % 1 + 1) % 1, v1 = ((z * 0.00055 + 3) % 1 + 1) % 1;
    const u2 = ((x * 0.0019 + 2) % 1 + 1) % 1, v2 = ((z * 0.0019 + 5) % 1 + 1) % 1;
    const broad = fbm(u1, v1, { freq: 4, octaves: 4, seed: 555 }) - 0.5;
    const ridge = ridged(u2, v2, { freq: 5, octaves: 4, seed: 217 });
    return broad * (24 + 240 * far * far) + ridge * (7 + 60 * far * far) - far * 5;
  }

  terrainHeightAt(x, z) {
    const f = this._sampleField(x, z);
    if (f.d < 150) return this._carvedHeight(this.circuit.nearest(_v.set(x, 0, z)), x, z);
    const blend = clamp((f.d - 150) / 260, 0, 1);
    return lerp(f.y - CARVE_DEPTH, f.y + this._relief(x, z), blend * blend);
  }

  _carvedHeight(near, x, z) {
    const side = near.lateral < 0 ? -1 : 1;
    const i = this.circuit.sampleIndex(near.s);
    const outer = this.corr.carve[this._ci(i, side)];
    const a = Math.abs(near.lateral);
    const sm = this.circuit.samples[i];
    const carved = this._edgeY(sm, side * Math.min(a, outer)) - CARVE_DEPTH;
    const blend = clamp((a - outer) / 200, 0, 1);
    return lerp(carved, near.surfaceY + this._relief(x, z), blend * blend);
  }

  /** Non-uniform axis: uniform near the circuit, geometric out to the horizon. */
  _axis(minV, maxV) {
    const CORE = 13;
    const arr = [];
    for (let v = minV; v <= maxV + CORE; v += CORE) arr.push(v);
    const lo = arr[0], hi = arr[arr.length - 1];
    const left = [];
    let s = CORE, v = lo;
    while (v > lo - 6500) { s *= 1.27; v -= s; left.push(v); }
    left.reverse();
    const right = [];
    s = CORE; v = hi;
    while (v < hi + 6500) { s *= 1.27; v += s; right.push(v); }
    return left.concat(arr, right);
  }

  _buildTerrain() {
    const b = this.bounds;
    const ax = this._axis(b.minX, b.maxX);
    const az = this._axis(b.minZ, b.maxZ);
    const nx = ax.length, nz = az.length;
    const pos = new Float32Array(nx * nz * 3);
    const uv = new Float32Array(nx * nz * 2);
    const col = new Float32Array(nx * nz * 3);
    const idx = [];

    let pi = 0, ui = 0, ci = 0;
    for (let j = 0; j < nz; j++) {
      const z = az[j];
      for (let i = 0; i < nx; i++) {
        const x = ax[i];
        const f = this._sampleField(x, z);
        let y;
        if (f.d < 150) y = this._carvedHeight(this.circuit.nearest(_v.set(x, 0, z)), x, z);
        else {
          const blend = clamp((f.d - 150) / 260, 0, 1);
          y = lerp(f.y - CARVE_DEPTH, f.y + this._relief(x, z), blend * blend);
        }
        pos[pi++] = x; pos[pi++] = y; pos[pi++] = z;
        uv[ui++] = x / 3; uv[ui++] = z / 3;

        const wild = clamp((f.d - 90) / 340, 0, 1);
        const far = clamp((f.d - 750) / 2400, 0, 1);
        const patch = fbm(((x * 0.0042) % 1 + 1) % 1, ((z * 0.0042) % 1 + 1) % 1, { freq: 7, octaves: 3, seed: 91 });
        const patch2 = fbm(((x * 0.00042) % 1 + 1) % 1, ((z * 0.00042) % 1 + 1) % 1, { freq: 3, octaves: 3, seed: 33 });
        const patch3 = fbm(((x * 0.0135) % 1 + 1) % 1, ((z * 0.0135) % 1 + 1) % 1, { freq: 9, octaves: 2, seed: 77 });
        // Vertex colour now carries VALUE ONLY. Hue and saturation belong to
        // `turfGrade`; two independent tint systems fighting each other is what
        // pushed this field to a primary green in the first place.
        const shade = (0.62 + patch * 0.48) * (0.80 + patch2 * 0.42) * (0.90 + patch3 * 0.18);
        // Beyond the mown apron the sward is coarser: a shade drier and lighter.
        const v = shade * lerp(0.96, 1.12, wild);
        const warm = lerp(1.0, 1.06, wild);
        // The far field only loses contrast; the aerial-perspective pass in the
        // fog chunk owns the actual haze colour, so do not tint toward it here.
        col[ci++] = lerp(v * warm, v * 0.86 + 0.13, far);
        col[ci++] = lerp(v, v * 0.86 + 0.13, far);
        col[ci++] = lerp(v * 0.97, v * 0.86 + 0.14, far);
      }
    }
    for (let j = 0; j < nz - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const a = j * nx + i, bb = a + 1, c = a + nx, d = c + 1;
        idx.push(a, c, bb, bb, c, d);
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();

    const maps = assets.get('env/grassMaps', () => setRepeat(cloneMaps(grass({ dry: 0.34 })), 1, 1));
    const mat = assets.material('env/grass', () => turfGrade(new THREE.MeshStandardMaterial({
      ...mapsToMaterial(maps),
      vertexColors: true,
      roughness: 1, metalness: 0,
      envMapIntensity: 0.5,
      dithering: true,
    }), {
      key: 'field',
      // B/G 0.77 / 0.79 / 0.79 — see the ramp note in `turfGrade`.
      shadow: 0x252c22, mid: 0x414b3b, dry: 0x6c6f58, dirt: 0x655840,
      macroA: 0.0125, macroB: 0.0016,
      // AGRICULTURAL MOWER CUT, NOT A GOLF FAIRWAY. `stripeMetres` is the
      // half-period, so 9.5 put 19 m bands across the infield — a golf course.
      // 2.6 gives a 5.2 m cut, and `turfFar` takes the amplitude to zero before
      // the pitch can reach a pixel.
      stripeMetres: 2.6, stripeAmount: 0.048, stripeWorld: true, stripeAngle: 0.62,
      parcelMetres: 158, parcelAmount: 0.85,
      fine: 0.065,
    }));
    mat.normalScale.set(0.85, 0.85);
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = 'Terrain';
    mesh.receiveShadow = true;
    return mesh;
  }

  // -- run-off --------------------------------------------------------------

  _buildRunOff() {
    const c = this.circuit;
    const n = c.samples.length;
    const hw = c.halfWidth;
    const COLS = 9;
    const pos = [], uv = [], col = [], blend = [], edge = [], idx = [];
    let base = 0;

    for (const side of [-1, 1]) {
      const rows = n + 1;
      for (let r = 0; r < rows; r++) {
        const i = r % n;
        const sm = c.samples[i];
        const ix = this._ci(i, side);
        const w = this.corr.runoff[ix];
        const gAmt = this.corr.gravel[ix];
        const pAmt = this.corr.paint[ix];
        // Astroturf follows the kerb, and a kerb follows curvature — the same
        // severity term `_computeCorridor` uses to size the run-off itself.
        const ak = Math.abs(sm.curvature);
        const outside = Math.sign(sm.curvature) !== side && ak > 0.0016;
        const cAstro = outside ? smoothstep(0.0020, 0.0060, ak) : 0.28 * smoothstep(0.0026, 0.0075, ak);
        const macro = fbm(((sm.position.x * 0.006) % 1 + 1) % 1, ((sm.position.z * 0.006) % 1 + 1) % 1, { freq: 6, octaves: 3, seed: 401 });
        for (let cix = 0; cix < COLS; cix++) {
          // Columns must run in order of increasing SIGNED lateral for the
          // ground-ribbon winding rule (right x tangent = +up) to hold.
          const t = side < 0 ? 1 - cix / (COLS - 1) : cix / (COLS - 1);
          const tt = Math.pow(t, 1.35);
          const lat = side * (hw + 1.15 + tt * w);
          _v.copy(sm.position).addScaledVector(sm.right, lat);
          _v.y = this._edgeY(sm, lat);
          pos.push(_v.x, _v.y, _v.z);
          uv.push(lat / 4, (r * c.step) / 4);

          /**
           * COMMIT TO ONE MATERIAL. `gAmt` is low-pass filtered ten times along
           * the arc, so a gravel corner does not start — it *fades in* over a
           * hundred metres, and every metre of that fade rendered as a 50/50 mix
           * of blue-grey asphalt aggregate and warm beige gravel, two
           * uncorrelated high-frequency noises interleaved at pixel scale. That
           * is the "mottled purple-brown noise field that reads as neither
           * gravel, asphalt nor dirt" — the mean is a perfectly reasonable warm
           * grey (measured 96,91,84), the VARIANCE is what reads as pixel dirt.
           * The remap below (0.42..0.58 on the shader side) turns the fade into
           * a ~12 m transition at the trap's mouth and leaves everything else
           * unambiguously one surface or the other.
           */
          const gravelHere = gAmt * smoothstep(0.30, 0.52, tt);
          const paintHere = Math.abs(pAmt) * (1 - smoothstep(3.4, 6.2, tt * w)) * (1 - gravelHere);
          // SCUFF STRIP. The first metre outboard of the white line is where
          // cars actually run wide: it is scrubbed, dusty and rubbered, and its
          // absence is why the apron edge read as a drawn boundary.
          const scuff = (1 - smoothstep(0.20, 1.30, tt * w)) * (0.55 + 0.45 * macro);
          blend.push(gravelHere, paintHere, pAmt < 0 ? 1 : 0, scuff);
          /**
           * ASTROTURF. Every modern circuit runs a 0.5-1 m synthetic green strip
           * immediately outboard of the kerb, and its absence is why the tarmac
           * met the run-off as a drawn line. It lives here rather than in
           * `circuit.js` because this ribbon owns the first metre outboard of
           * the kerb. Only where there is a kerb to sit behind, i.e. on corners:
           * `sev` is carried in through the run-off width.
           */
          const edgeM = tt * w;
          const astro = clamp(cAstro, 0, 1)
            * (1 - smoothstep(0.55, 1.05, edgeM))
            * (0.72 + 0.28 * macro);
          edge.push(astro);

          const dust = clamp(1 - (tt * w) / 6, 0, 1);
          // The apron is dusty asphalt, not concrete: 1.16 x a 1.10 macro put it
          // within a stop of white, and it clipped the moment the meter moved.
          const shade = (0.74 + macro * 0.28) * lerp(1.0, 1.07, dust);
          col.push(shade * 1.02, shade, shade * 0.98);
        }
      }
      for (let r = 0; r < rows - 1; r++) {
        for (let cix = 0; cix < COLS - 1; cix++) {
          const a = base + r * COLS + cix, bb = a + 1, d = a + COLS, e = d + 1;
          idx.push(a, bb, d, bb, e, d);
        }
      }
      base += rows * COLS;
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('aBlend', new THREE.Float32BufferAttribute(blend, 4));
    g.setAttribute('aEdge', new THREE.Float32BufferAttribute(edge, 1));
    g.setIndex(idx);
    g.computeVertexNormals();

    const asphaltMaps = assets.get('env/runoffMaps', () => setRepeat(cloneMaps(asphalt({ wear: 0.75, key: 'runoff' })), 1, 1));
    const gravelMaps = assets.get('env/gravelMaps', () => setRepeat(cloneMaps(gravel({})), 1, 1));

    const mat = assets.material('env/runoff', () => {
      const m = new THREE.MeshStandardMaterial({
        ...mapsToMaterial(asphaltMaps),
        vertexColors: true,
        roughness: 1, metalness: 0,
        envMapIntensity: 0.45,
        polygonOffset: true, polygonOffsetFactor: 2, polygonOffsetUnits: 2,
        dithering: true,
      });
      const K = (4 / 1.5).toFixed(4);   // asphalt worldSize / gravel worldSize
      m.onBeforeCompile = (shader) => {
        shader.uniforms.uGravelMap = { value: gravelMaps.map };
        shader.uniforms.uGravelNrm = { value: gravelMaps.normalMap };
        // Run-off paint is a FLAT, chalky, low-key colour on a rough asphalt
        // apron — it is dust, tyre rubber and two winters of UV. 0x37a04c was a
        // display primary: ten times more green than red in linear, which is
        // why the apron read as a neon strip from a hundred metres.
        shader.uniforms.uPaintA = { value: new THREE.Color(0x4a6b40) };
        shader.uniforms.uPaintB = { value: new THREE.Color(0x2f5580) };
        shader.uniforms.uAstro = { value: new THREE.Color(0x3f5c37) };
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nattribute vec4 aBlend;\nattribute float aEdge;\nvarying vec4 vBlend;\nvarying float vEdge;')
          .replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvBlend = aBlend;\n\tvEdge = aEdge;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', `#include <common>
uniform sampler2D uGravelMap;
uniform sampler2D uGravelNrm;
uniform vec3 uPaintA;
uniform vec3 uPaintB;
uniform vec3 uAstro;
varying vec4 vBlend;
varying float vEdge;`)
          .replace('#include <map_fragment>', `#include <map_fragment>
{
  // See the note by 'gravelHere': a wide crossfade between two uncorrelated
  // high-frequency aggregates is what produced the purple-brown pixel dirt.
  float gv = smoothstep( 0.42, 0.58, vBlend.x );
  vec3 gcol = texture2D( uGravelMap, vMapUv * ${K} ).rgb;
  gcol *= 0.90 + 0.34 * texture2D( uGravelMap, vMapUv * 0.29 ).g;
  /**
   * THE GRAVEL TRAP HAS TO SURVIVE ITS OWN MIP CHAIN.
   *
   * At 1.5 m worldSize the aggregate is gone by ~40 m and the trap renders as
   * the flat untextured beige band the world critic logged against wide. The
   * cure is structure at a wavelength the mip chain cannot reach: 25 m tonal
   * blotches (wet/dry, raked/unraked) and drag ruts. Both are the same texture
   * sampled at a tiny uv scale, so they are MAGNIFIED, never minified, and read
   * identically at 10 m and at 300 m.
   *
   * Ruts run OUTWARD from the track, i.e. along lateral, i.e. along u — hence
   * the 30:1 anisotropic scale.
   */
  float gBlotch = texture2D( uGravelMap, vMapUv * vec2( 0.155, 0.135 ) ).r;
  float gRut = texture2D( uGravelMap, vMapUv * vec2( 0.14, 2.10 ) ).g;
  float gDrag = texture2D( uGravelMap, vMapUv * vec2( 0.10, 5.30 ) ).b;
  gcol *= 0.70 + 0.62 * gBlotch;
  gcol *= 0.74 + 0.54 * gRut;
  // Ploughed ruts: where a car has been through, the rake has turned the wet
  // sub-layer up and it is a good two stops darker than the raked surface.
  gcol *= mix( 1.0, 0.58, smoothstep( 0.62, 0.90, gDrag ) );
  // Washed river gravel, not builder's sand. The bake came back at sRGB
  // 187/161/114 — saturation 0.39, which is a beach. A real trap is rounded
  // grey-brown stone and photographs around 0.16-0.20.
  gcol = mix( gcol, vec3( dot( gcol, vec3( 0.2126, 0.7152, 0.0722 ) ) ), 0.42 )
       * vec3( 1.035, 1.000, 0.960 );
  diffuseColor.rgb = mix( diffuseColor.rgb, gcol, gv );
  float pv = vBlend.y * ( 1.0 - gv ) * 0.88;
  vec3 paint = mix( uPaintA, uPaintB, vBlend.z );
  float luma = dot( diffuseColor.rgb, vec3( 0.333 ) );
  // Keep the aggregate's own light/dark under the paint instead of replacing it.
  diffuseColor.rgb = mix( diffuseColor.rgb, paint * ( 0.62 + 1.9 * luma ), pv );
  // Scuffed, dirt-stained strip where the cars run wide.
  diffuseColor.rgb = mix( diffuseColor.rgb,
    diffuseColor.rgb * vec3( 0.90, 0.82, 0.70 ) + vec3( 0.030, 0.024, 0.014 ),
    clamp( vBlend.w, 0.0, 1.0 ) * 0.85 );
  // Astroturf strip against the kerb. It keeps the asphalt's own light/dark so
  // it reads as a laid mat with dirt on it, not as a painted band, and it is
  // deliberately DARKER than the grass beyond the verge — synthetic turf in
  // full sun is a good stop under real grass.
  {
    float av = clamp( vEdge, 0.0, 1.0 ) * ( 1.0 - gv );
    float pile = 0.70 + 0.60 * texture2D( uGravelMap, vMapUv * vec2( 8.0, 1.4 ) ).g;
    float luma = dot( diffuseColor.rgb, vec3( 0.333 ) );
    diffuseColor.rgb = mix( diffuseColor.rgb, uAstro * pile * ( 0.55 + 1.5 * luma ), av * 0.90 );
  }
}`)
          .replace(
            'vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;',
            `vec3 mapN = mix( texture2D( normalMap, vNormalMapUv ).xyz,
                             texture2D( uGravelNrm, vNormalMapUv * ${K} ).xyz,
                             smoothstep( 0.22, 0.72, vBlend.x ) ) * 2.0 - 1.0;`
          );
      };
      m.customProgramCacheKey = () => 'env-runoff';
      return m;
    });

    const mesh = new THREE.Mesh(g, mat);
    mesh.name = 'RunOff';
    mesh.receiveShadow = true;
    return mesh;
  }

  /**
   * Mown grass verge from the run-off edge out past the barrier. Shares
   * `_edgeY` with its neighbours and lands 2 cm proud of the terrain grid, so
   * it can neither gap nor z-fight.
   */
  _buildVerge() {
    const c = this.circuit;
    const n = c.samples.length;
    const hw = c.halfWidth;
    const COLS = 6;
    const pos = [], uv = [], col = [], idx = [];
    let base = 0;

    for (const side of [-1, 1]) {
      const rows = n + 1;
      for (let r = 0; r < rows; r++) {
        const i = r % n;
        const sm = c.samples[i];
        const ix = this._ci(i, side);
        const inner = hw + 1.15 + this.corr.runoff[ix];
        const outer = this.corr.barrier[ix] + this.corr.tail[ix];
        // A long mowing pass down the verge — the machine turns roughly every
        // 40 m, and the reflectance flip is what a broadcast camera picks up.
        const stripe = 0.965 + 0.07 * (Math.floor(sm.s / 41) % 2);
        const macro = fbm(((sm.position.x * 0.011) % 1 + 1) % 1, ((sm.position.z * 0.011) % 1 + 1) % 1, { freq: 6, octaves: 3, seed: 211 });
        // RAGGED OUTER EDGE. The verge-to-field boundary was a dead-straight
        // line at exactly `barrier + tail` for the whole lap — a hard tonal cut
        // with no cause. Pulling the last column IN by a metre-scale noise
        // exposes the terrain underneath in an irregular fringe, which is what
        // the mower/field boundary actually looks like. Only ever inward, so it
        // can neither overhang the terrain nor gap against the barrier.
        const fray = 0.55 + 2.5 * fbm(
          ((sm.position.x * 0.028) % 1 + 1) % 1, ((sm.position.z * 0.028) % 1 + 1) % 1,
          { freq: 11, octaves: 2, seed: 823 }
        );
        for (let cix = 0; cix < COLS; cix++) {
          const t = side < 0 ? 1 - cix / (COLS - 1) : cix / (COLS - 1);
          const lat = side * (lerp(inner, outer, t) - fray * smoothstep(0.62, 1.0, t));
          _v.copy(sm.position).addScaledVector(sm.right, lat);
          _v.y = this._edgeY(sm, lat) - 0.015 - VERGE_DROP * t * t * t;
          pos.push(_v.x, _v.y, _v.z);
          uv.push(lat / 3, sm.s / 3);
          // Scorched dirt where cars run wide, then mown turf, then a darker
          // unkempt band in the barrier's own shadow — the real gradient.
          const dirt = 1 - smoothstep(0.0, 0.11, t);
          const shadowed = smoothstep(0.62, 1.0, t);
          // Matched to the open field's own vertex-colour mean (~0.86). The
          // verge used to sit ~13 % brighter, which put a hard bright band along
          // every barrier line in any elevated shot.
          const shade = stripe * (0.70 + macro * 0.36)
            * lerp(1.06, 0.93, clamp(t * 1.4, 0, 1))
            * lerp(1.0, 0.74, shadowed);
          col.push(
            shade * lerp(1.0, 1.62, dirt),
            shade * lerp(1.0, 1.40, dirt),
            shade * lerp(1.0, 1.06, dirt)
          );
        }
      }
      for (let r = 0; r < rows - 1; r++) {
        for (let cix = 0; cix < COLS - 1; cix++) {
          const a = base + r * COLS + cix, bb = a + 1, d = a + COLS, e = d + 1;
          idx.push(a, bb, d, bb, e, d);
        }
      }
      base += rows * COLS;
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();

    const maps = assets.get('env/vergeMaps', () => setRepeat(cloneMaps(grass({ dry: 0.16, key: 'verge' })), 1, 1));
    const mat = assets.material('env/verge', () => turfGrade(new THREE.MeshStandardMaterial({
      ...mapsToMaterial(maps),
      vertexColors: true,
      roughness: 1, metalness: 0,
      envMapIntensity: 0.5,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      dithering: true,
    }), {
      key: 'verge',
      // Kept turf: greener and a shade darker than the open field. "Greener"
      // means a touch more green-over-red, NOT less blue — B/G stays at 0.79.
      shadow: 0x232b22, mid: 0x404b3b, dry: 0x6a6e57, dirt: 0x655840,
      // uv.x = lat / 3, so stripes here are lateral bands running ALONG the
      // track: exactly what a ride-on mower driving the verge leaves behind.
      stripeMetres: 2.9, stripeAxis: 1, stripeAmount: 0.150, uvPerMetre: 1 / 3,
      macroA: 0.021, macroB: 0.0028,
      fine: 0.075,
    }));
    mat.normalScale.set(1.4, 1.4);
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = 'Verge';
    mesh.receiveShadow = true;
    return mesh;
  }

  /**
   * Circuit service road — the 4.5 m strip of tired asphalt that runs behind
   * the barrier all the way round, carrying recovery vehicles and marshals.
   *
   * It is one of the highest-value pieces of trackside detail there is: it puts
   * a hard, man-made horizontal line between the barrier and the countryside,
   * which is exactly what stops a circuit looking like a road dropped onto a
   * field. Marshal posts and TV towers stand ON it, which is where they belong.
   */
  _buildServiceRoad() {
    const c = this.circuit;
    const n = c.samples.length;
    const COLS = 3;
    const INNER = 3.2, OUTER = 7.9;
    const pos = [], uv = [], col = [], idx = [];
    let base = 0;

    for (const side of [-1, 1]) {
      // Split at skipped (pit-lane) samples so the ribbon never bridges a gap.
      const runs = [];
      let cur = null;
      for (let r = 0; r <= n; r++) {
        const i = r % n;
        if (this.corr.skip[this._ci(i, side)]) { cur = null; continue; }
        if (!cur) runs.push((cur = []));
        cur.push(i);
      }
      for (const run of runs) {
        if (run.length < 3) continue;
        const b0 = base;
        for (const i of run) {
          const sm = c.samples[i];
          const ix = this._ci(i, side);
          const macro = fbm(((sm.position.x * 0.008) % 1 + 1) % 1, ((sm.position.z * 0.008) % 1 + 1) % 1, { freq: 5, octaves: 3, seed: 617 });
          for (let cix = 0; cix < COLS; cix++) {
            const t = side < 0 ? 1 - cix / (COLS - 1) : cix / (COLS - 1);
            const lat = side * (this.corr.barrier[ix] + lerp(INNER, OUTER, t));
            _v.copy(sm.position).addScaledVector(sm.right, lat);
            _v.y = this._vergeY(i, side, lat) + 0.035;
            pos.push(_v.x, _v.y, _v.z);
            uv.push(lat / 4, sm.s / 4);
            // Grass creeps over both edges and the crown is bleached.
            const edge = 1 - Math.abs(t - 0.5) * 2;
            const sh = (0.72 + macro * 0.44) * lerp(0.82, 1.06, edge);
            col.push(sh * 1.02, sh, sh * 0.97);
          }
        }
        for (let r = 0; r < run.length - 1; r++) {
          for (let cix = 0; cix < COLS - 1; cix++) {
            const a = b0 + r * COLS + cix, bb = a + 1, d = a + COLS, e = d + 1;
            idx.push(a, bb, d, bb, e, d);
          }
        }
        base += run.length * COLS;
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();

    const maps = assets.get('env/serviceMaps', () => setRepeat(cloneMaps(asphalt({ wear: 0.95, coarse: 0.8, key: 'service' })), 1, 1));
    const mat = assets.material('env/serviceRoad', () => new THREE.MeshStandardMaterial({
      ...mapsToMaterial(maps),
      vertexColors: true, color: 0xa8a49c,
      roughness: 1, metalness: 0, envMapIntensity: 0.4,
      polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
      dithering: true,
    }));
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = 'ServiceRoad';
    mesh.receiveShadow = true;
    return mesh;
  }

  /**
   * Sponsor names sprayed across the run-off apron on corner exits, plus a
   * matching kerb-side block. Painted, not decalled: the texture is chewed up
   * with an erase pass so it reads as sprayed vinyl that has had a season of
   * cars over it.
   */
  _buildRunOffPaint() {
    const c = this.circuit;
    const n = c.samples.length;
    const group = new THREE.Group();
    group.name = 'RunOffPaint';
    const hw = c.halfWidth;
    const rng = makeRng(hashSeed('runoff-paint'));

    // Corner exits with real run-off to write on.
    const spots = [];
    for (let i = 0; i < n; i += 3) {
      const k = Math.abs(c.samples[i].curvature);
      const ahead = Math.abs(c.samples[(i + 30) % n].curvature);
      if (k < 0.0032 || ahead > k * 0.75) continue;
      const side = c.samples[i].curvature > 0 ? 1 : -1;
      const ix = this._ci(i, side);
      if (this.corr.skip[ix] || this.corr.runoff[ix] < 9.5) continue;
      if (spots.length && Math.abs(i - spots[spots.length - 1].i) < 45) continue;
      spots.push({ i, side });
    }

    const byTex = new Map();
    for (const spot of spots) {
      const sp = SPONSORS[Math.floor(rng() * SPONSORS.length)];
      const key = `env/paint-${sp.n}`;
      let bucket = byTex.get(key);
      if (!bucket) byTex.set(key, (bucket = { sp, pos: [], uv: [], idx: [], base: 0 }));

      const ROWS = 10;
      const LEN = 26;                            // metres of wordmark along s
      const step = LEN / (ROWS - 1);
      const inner = hw + 4.5, outer = hw + 4.5 + 6.5;
      const b0 = bucket.base;
      for (let r = 0; r < ROWS; r++) {
        const s = c.wrapS(spot.i * c.step - LEN * 0.5 + r * step);
        const sm = c.sampleAt(s);
        const t = r / (ROWS - 1);
        for (let k = 0; k < 2; k++) {
          const lat = spot.side * (k ? outer : inner);
          _v.copy(sm.position).addScaledVector(sm.right, lat);
          _v.y = this._edgeY(sm, lat) + 0.012;
          bucket.pos.push(_v.x, _v.y, _v.z);
          // The wordmark runs ALONG the apron (u) and stands up toward the
          // racing line (v = 1 on the inner edge). u is reversed on the left so
          // that (u_dir x v_dir) keeps pointing at the sky on both sides —
          // otherwise the left-hand apron gets mirror-image lettering.
          bucket.uv.push(spot.side > 0 ? t : 1 - t, k ? 0 : 1);
        }
      }
      for (let r = 0; r < ROWS - 1; r++) {
        const a = b0 + r * 2, bb = a + 1, d = a + 2, e = d + 1;
        // Wind so the face normal is +up on BOTH sides; a downward-facing decal
        // is lit by the ground bounce and comes out black.
        if (spot.side > 0) bucket.idx.push(a, bb, d, bb, e, d);
        else bucket.idx.push(a, d, bb, bb, d, e);
      }
      bucket.base += ROWS * 2;
    }

    for (const [key, b] of byTex) {
      if (!b.idx.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      g.setIndex(b.idx);
      g.computeVertexNormals();
      const mat = assets.material(`${key}-mat`, () => new THREE.MeshStandardMaterial({
        map: trackPaintTexture(key, b.sp),
        transparent: true, depthWrite: false, side: THREE.DoubleSide,
        roughness: 0.72, metalness: 0, envMapIntensity: 0.4, opacity: 0.86,
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      }));
      const mesh = new THREE.Mesh(g, mat);
      mesh.renderOrder = 1;
      group.add(mesh);
    }
    return group;
  }

  // -- barriers, hoardings, catch fence -------------------------------------

  _buildTrackside() {
    const c = this.circuit;
    const n = c.samples.length;
    const group = new THREE.Group();
    group.name = 'Trackside';

    // ARMCO CROSS-SECTION. Three W-beams over a concrete footing kerb. The
    // footing is what stops the whole run reading as a kilometre-long grey
    // ribbon floating on the grass — it grounds the barrier and catches its own
    // shadow line.
    const armco = [[0.27, 0.0], [0.27, 0.19], [0.13, 0.22]];
    for (let k = 0; k < 3; k++) {
      const b0 = 0.30 + k * 0.29;
      armco.push([0.11, b0 - 0.02], [0.02, b0 + 0.03], [0.05, b0 + 0.12], [0.02, b0 + 0.21], [0.11, b0 + 0.26]);
    }
    armco.push([0.11, 1.19]);
    // Concrete wall resampled to the same column count so the two can blend.
    const wallSrc = [[0.30, 0.0], [0.26, 0.16], [0.18, 0.22], [0.11, 0.30], [0.03, 0.74], [0.0, 1.04], [0.0, 1.14], [0.22, 1.16]];
    const wall = [];
    for (let k = 0; k < armco.length; k++) {
      const f = (k / (armco.length - 1)) * (wallSrc.length - 1);
      const a = wallSrc[Math.floor(f)], b = wallSrc[Math.min(wallSrc.length - 1, Math.ceil(f))];
      const t = f - Math.floor(f);
      wall.push([lerp(a[0], b[0], t), lerp(a[1], b[1], t)]);
    }

    const railMaps = assets.get('env/railMaps', () => setRepeat(cloneMaps(brushedMetal({ roughBase: 0.45 })), 1, 1));
    const railMat = assets.material('env/armco', () => {
      const m = new THREE.MeshStandardMaterial({
        ...mapsToMaterial(railMaps),
        vertexColors: true,
        // Galvanised W-beam, not chrome: it must not be the brightest thing in
        // the frame or the eye reads a white fence rather than a steel barrier.
        color: 0xb8bdc2, roughness: 1, metalness: 1, envMapIntensity: 0.85,
        /**
         * DOUBLE SIDED, and this is the other half of "the catch fence renders
         * as bare poles".
         *
         * The ribbon's winding faces the racing surface, and an elevated camera
         * on the OUTSIDE of a corner looks at the near-side barrier from behind
         * — where the Armco, the hoarding and everything else on that line were
         * back-face culled and only the fence masts and Armco posts survived.
         * That is exactly the "row of naked hooked poles standing in the grass
         * with absolutely nothing between them" in the `wide` frame: the mesh
         * was there, the thing it hangs off was not. An Armco run is a physical
         * object with a back, so it renders from both sides.
         */
        side: THREE.DoubleSide,
      });
      // PANEL JOINTS. A W-beam run is bolted up out of 4 m panels and every
      // joint is a 20 mm dark line plus a lap shadow. Without them the ribbon
      // has no longitudinal scale at all, which is most of why it read as one
      // extruded band. `uv.x = s * 1.6`, so one 4 m panel is 6.4 u.
      m.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <map_fragment>', /* glsl */`
            #include <map_fragment>
            float apexPanel = abs( fract( vMapUv.x / 6.4 ) - 0.5 ) * 2.0;
            diffuseColor.rgb *= mix( 1.0, 0.34, smoothstep( 0.955, 1.0, apexPanel ) );
            float apexBolt = abs( fract( vMapUv.x * 1.25 ) - 0.5 ) * 2.0;
            float apexRow = abs( fract( vMapUv.y * 0.539 - 0.30 ) - 0.5 ) * 2.0;
            diffuseColor.rgb *= mix( 1.0, 0.74,
              smoothstep( 0.86, 1.0, apexBolt ) * smoothstep( 0.80, 1.0, apexRow ) );
            /**
             * DIRT AND AGE. The review's last minor: "one flat grey tone, no
             * dents, no dirt streaks, no colour variation". A galvanised W-beam
             * run is anything but uniform — rain sheets off the beam onto the
             * footing, so the bottom 300 mm is permanently soiled, and every
             * panel weathers at its own rate because they are replaced piecemeal
             * after contact. Both are cheap here: vMapUv.y is metres * 3.2 from
             * the ground and vMapUv.x is metres * 1.6 along the run, so a
             * per-panel hash and a height ramp are two lines.
             */
            float apexPnl = floor( vMapUv.x / 6.4 );
            float apexAge = fract( sin( apexPnl * 12.9898 ) * 43758.5453 );
            diffuseColor.rgb *= 0.88 + 0.20 * apexAge;
            float apexSoil = 1.0 - smoothstep( 0.35, 1.35, vMapUv.y );
            float apexStreak = 0.55 + 0.45 * fract( sin( floor( vMapUv.x * 3.1 ) * 78.233 ) * 43758.5453 );
            diffuseColor.rgb = mix( diffuseColor.rgb,
              diffuseColor.rgb * vec3( 0.62, 0.58, 0.52 ), apexSoil * 0.80 * apexStreak );
            // Rust bleed off the through-bolts on the older panels.
            // Rare and low-key: at 0.72/0.42 this read as an orange dashed line
            // down the whole run in the wide frame, because a bolt line repeats
            // every 0.8 m and a quarter of the panels qualified.
            float apexRust = smoothstep( 0.90, 1.0, apexAge )
              * smoothstep( 0.72, 1.0, apexBolt ) * ( 1.0 - smoothstep( 1.4, 2.8, vMapUv.y ) );
            diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.26, 0.16, 0.10 ), apexRust * 0.26 );`);
      };
      m.customProgramCacheKey = () => 'apex-armco-joints-weather';
      return m;
    });
    // ADVERTISING BAND. HOARD_H metres tall, panels of HOARD_H * 4 metres, so
    // the 4:1 texture panels land unstretched. `1 / HOARD_REPEAT` is the only u
    // scale allowed to touch this texture.
    const hoardMat = boardMaterial('env/hoardingMat', 'env/boardTrack', {
      panels: HOARD_PANELS, aspect: 4, seed: 7, height: 192, mix: 0.17,
    });
    // The BACK of the advertising band. It cannot be the same material — the
    // artwork would read mirrored — and it cannot be nothing, or the barrier
    // vanishes when a camera sits outside the corner (see `railMat`). What a
    // hoarding shows from behind is its galvanised support frame on a dull
    // backing sheet, so that is what this is: `BackSide`, sharing the geometry.
    const hoardBackMat = assets.material('env/hoardingBack', () => {
      const t = canvasTexture('env/hoardBack', 128, 128, (ctx, w, h) => {
        ctx.fillStyle = '#8e9399'; ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = '#767c82';
        ctx.fillRect(6, 0, 10, h);                                              // stiffener
        ctx.fillRect(0, h * 0.46, w, 9);                                        // mid rail
        ctx.fillStyle = 'rgba(48,54,60,0.35)';
        ctx.fillRect(16, 0, 4, h);
        /**
         * From an elevated shot OUTSIDE a corner this sheet is a continuous
         * band across the bottom third of frame, and a single flat grey is
         * exactly the "bare grey concrete band" logged against `wide`. A real
         * backing sheet is a bolted composite: panel joints, weather staining
         * down every stiffener and rust bleed off the fixings.
         */
        const r = makeRng(hashSeed('hoard-back', 5));
        ctx.fillStyle = 'rgba(30,34,39,0.55)';
        ctx.fillRect(0, 0, 2, h);                                               // panel joint
        for (let i = 0; i < 26; i++) {                                          // weather streaks
          const x = r() * w;
          ctx.fillStyle = `rgba(${44 + r() * 40 | 0},${48 + r() * 38 | 0},${52 + r() * 36 | 0},${0.06 + r() * 0.16})`;
          ctx.fillRect(x, r() * h * 0.5, 1 + r() * 3, h * (0.4 + r() * 0.6));
        }
        for (let i = 0; i < 7; i++) {                                           // rust off the fixings
          const y = 8 + r() * (h - 30);
          const g2 = ctx.createLinearGradient(0, y, 0, y + 26);
          g2.addColorStop(0, 'rgba(122,74,42,0.42)');
          g2.addColorStop(1, 'rgba(122,74,42,0)');
          ctx.fillStyle = g2;
          ctx.fillRect(7 + r() * 12, y, 5, 26);
        }
        ctx.fillStyle = 'rgba(255,255,255,0.10)';
        ctx.fillRect(0, h * 0.46 - 3, w, 3);                                    // rail highlight
      }, { wrapT: THREE.RepeatWrapping });
      // uv.x spans 1.0 per HOARD_REPEAT (38.4 m); a stiffener every 1.2 m.
      t.repeat.set(HOARD_REPEAT / 1.2, 1);
      return new THREE.MeshStandardMaterial({
        map: t, color: 0xffffff, roughness: 0.78, metalness: 0.25,
        envMapIntensity: 0.6, side: THREE.BackSide,
      });
    });
    const fenceTex = fenceTexture();
    // The fence has to be BLENDED, not alpha-tested, and this is worth being
    // precise about. The mesh's coverage is ~22 %, so every mip below the top
    // one averages to alpha ≈ 0.22: an alphaTest above that erases the fence
    // entirely past ~15 m, and an alphaTest below it turns those same mips into
    // a SOLID grey wall. Neither is a fence. Blending is the only mapping that
    // is right at both ends — 22 % coverage near, a 22 % grey veil far, which
    // is exactly what a debris fence does in a photograph.
    //
    // What was actually wrong before was the texture, not the blend: 4.4 px
    // wire on a 32 px cell in a near-white tint, i.e. a quarter of the screen
    // covered in the brightest value in the frame.
    const fenceMat = assets.material('env/fenceMat', () => {
      const m = new THREE.MeshStandardMaterial({
        // NO alphaMap. `alphaMap` samples the GREEN channel, and this texture's
        // green channel is the wire's *colour* (~0.2 after sRGB decode), so
        // pairing it with `map` multiplied the wire's own alpha by 0.2 and left
        // the whole fence at a fifth of the opacity it was authored for. `map`
        // already carries a correct alpha channel; that is the whole of it.
        map: fenceTex, alphaTest: 0.012,
        transparent: true, depthWrite: false, opacity: 1.0,
        side: THREE.DoubleSide, roughness: 0.66, metalness: 0.35,
        // Galvanised chain-link photographs as a grey-brown SCREEN, not as clear
        // air. 0x6e747a at 22 % coverage over grass is under 2 % contrast — the
        // fence simply was not there past 40 m. Darker wire + the coverage
        // compensation below is what makes it read at every distance.
        color: 0x4a5056, envMapIntensity: 0.30,
      });
      // COVERAGE IS DRIVEN BY THE TEXTURE FOOTPRINT, NOT BY DISTANCE.
      //
      // Both ends of this problem are really the same quantity: how many 50 mm
      // apertures a single pixel covers. `fwidth(vMapUv) * CELLS_PER_TILE` is
      // exactly that, and it is free (the hardware already computes it to pick
      // the mip), self-calibrating across focal lengths, and correct at grazing
      // angles where distance is not.
      //
      // NEAR (cells/px << 1) — a debris fence a few metres in front of a long
      // lens is so far outside the depth of field that a photograph records it
      // as a faint loss of contrast and nothing more; that is the entire reason
      // a world feed reads *through* a fence. The engine's DOF is depth-buffer
      // driven and this material is blended with `depthWrite: false` (per the
      // render-order contract), so every fence pixel carries the depth of the
      // ROAD behind it — in focus. The distance-only version of this ramp used
      // 5..34 m, which is a perfectly reasonable near field for the 40-degree
      // chase lens and completely wrong for the `tv` tower's long one: the fence
      // sat inside the ramp's floor and laid a razor-sharp 55 px lattice across
      // the whole broadcast frame. In footprint terms that frame is 0.018
      // cells/px — two orders of magnitude inside the near field — and it now
      // vanishes, which is what the same shot looks like on television.
      //
      // FAR (cells/px >> 1) — once an aperture drops below a pixel the mip chain
      // returns the AREA average of the tile, ~0.18, and stops there. A real
      // fence does not: the further and the more obliquely you look at it, the
      // more courses of wire a single ray crosses, so its apparent opacity
      // climbs toward a solid screen. Model that as Beer-Lambert over `layers`
      // stacked copies of the tile — `1 - (1-a)^layers` — with `layers` driven
      // by obliquity (1/|dot(view, normal)|) and by the footprint, so at 150 m
      // and 60 degrees off-normal 0.18 coverage becomes ~0.75: a grey screen you
      // cannot see individual wires in, which is the photograph.
      m.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>',
            '#include <common>\nvarying vec3 vApexNrm;\nvarying vec3 vApexView;')
          .replace('#include <project_vertex>',
            '#include <project_vertex>\nvApexView = -mvPosition.xyz;\n'
            + 'vApexNrm = normalize( normalMatrix * normal );');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>',
            '#include <common>\nvarying vec3 vApexNrm;\nvarying vec3 vApexView;')
          .replace('#include <alphatest_fragment>', /* glsl */`
            // One tile is 0.8 m of fence = 16 apertures, so this is cells/pixel.
            float apexCells = max( fwidth( vMapUv.x ), fwidth( vMapUv.y ) ) * 16.0;
            float apexCov = diffuseColor.a;
            apexCov *= smoothstep( 0.028, 0.150, apexCells );
            float apexObl = 1.0 / max( 0.26, abs( dot( normalize( vApexView ), normalize( vApexNrm ) ) ) );
            float apexFar = 1.0 + 2.1 * smoothstep( 0.50, 3.20, apexCells );
            float apexLayers = clamp( apexObl * apexFar, 1.0, 7.0 );
            diffuseColor.a = 1.0 - pow( max( 0.0, 1.0 - apexCov ), apexLayers );
            #include <alphatest_fragment>`);
      };
      m.customProgramCacheKey = () => 'apex-catchfence-footprint';
      return m;
    });
    // The cables themselves — opaque, so they survive to any distance and give
    // the fence a readable structure once the mesh has faded to a veil.
    const fenceRailMat = assets.material('env/fenceRail', () => new THREE.MeshStandardMaterial({
      color: 0x676d73, roughness: 0.58, metalness: 0.80, envMapIntensity: 0.55,
      side: THREE.DoubleSide,
    }));

    const per = Math.ceil(n / CHUNKS);
    const posts = [], tec = [], rails = [];

    for (let ch = 0; ch < CHUNKS; ch++) {
      const i0 = ch * per;
      const i1 = Math.min(n, i0 + per);
      const rail = { pos: [], uv: [], col: [], idx: [], base: 0 };
      const ad = { pos: [], uv: [], idx: [], base: 0 };
      const fen = { pos: [], uv: [], idx: [], base: 0 };
      const frail = { pos: [], uv: [], col: [], idx: [], base: 0 };

      for (const side of [-1, 1]) {
        // Gather the rows for this arc, split into runs of non-skipped samples.
        const runs = [];
        let cur = null;
        let arc = 0;
        for (let i = i0; i <= i1; i++) {
          const idx = i % n;
          const ix = this._ci(idx, side);
          const sm = c.samples[idx];
          if (this.corr.skip[ix]) { cur = null; arc += c.step; continue; }
          const lat = side * this.corr.barrier[ix];
          _v.copy(sm.position).addScaledVector(sm.right, lat);
          _v.y = this._vergeY(idx, side, lat);
          // `s` is the arc within this chunk (fine for a tiling metal rail);
          // `sa` is the ABSOLUTE arc, which is what the advertising band needs
          // so its panel grid stays continuous across a chunk boundary.
          const row = { p: _v.clone(), t: sm.tangent, r: sm.right, s: arc, sa: idx * c.step, type: this.corr.type[ix], i: idx };
          if (!cur) runs.push((cur = []));
          cur.push(row);
          arc += c.step;
        }

        const emit = (target, rows, colsFor, withColour) => {
          if (rows.length < 2) return;
          const b0 = target.base;
          const nc = colsFor(rows[0]).length;
          for (const row of rows) {
            const cols = colsFor(row);
            const outward = _v2.copy(row.r).multiplyScalar(side);
            for (let k = 0; k < nc; k++) {
              const [o, h, u, vv, abs] = cols[k];
              _v.copy(row.p).addScaledVector(outward, o);
              _v.y = row.p.y + h;
              target.pos.push(_v.x, _v.y, _v.z);
              target.uv.push((abs ? row.sa : row.s) * u, vv);
              if (withColour) {
                // Corrugation AO. This was the wrong way round: the term
                // BRIGHTENED the valleys (tone 1.06 at o = 0.02 against 0.80 at
                // the crest), so the beam read as three glowing grooves. A
                // W-beam's crest catches the sky and its valley is occluded.
                const tone = (row.type === WALL ? 1.24 : 1.0)
                  * (0.72 + 0.34 * clamp(o / 0.11, 0, 1)) * (h < 0.24 ? 0.86 : 1.0);
                target.col.push(tone, tone, tone * 1.01);
              }
            }
          }
          for (let r = 0; r < rows.length - 1; r++) {
            for (let k = 0; k < nc - 1; k++) {
              const a = b0 + r * nc + k, bb = a + 1, d = a + nc, e = d + 1;
              // Columns rise (+up), rows advance (+tangent): up x tangent = -right,
              // so this winding faces -right; flip it on the left-hand side.
              if (side > 0) target.idx.push(a, bb, d, bb, e, d);
              else target.idx.push(a, d, bb, bb, d, e);
            }
          }
          target.base += rows.length * nc;
        };

        for (const rows of runs) {
          emit(rail, rows, (row) => {
            const src = row.type === WALL ? wall : armco;
            return src.map((p) => [p[0], p[1], 1.6, p[1] * 3.2]);
          }, true);
          // Sponsor hoarding standing on the barrier.
          //
          // U DIRECTION. A board is read by someone standing on the racing
          // surface looking straight at it. For the RIGHT-hand barrier that
          // viewer faces +right, and their screen-right is
          // `cross(right, up) = -tangent` — so the wordmark has to advance
          // along -tangent, i.e. u must DECREASE with s. The left-hand barrier
          // is the mirror case and takes +u. Winding/FrontSide only decides
          // which face is drawn; it cannot fix a reversed u.
          const uAd = (side > 0 ? -1 : 1) / HOARD_REPEAT;
          emit(ad, rows, () => [
            [-0.03, 1.16, uAd, 0, true],
            [0.05, 1.16 + HOARD_H, uAd, 1, true],
          ], false);
          // Catch fence: vertical panel then a raked head leaning over the
          // track. It starts at the top of the advertising band.
          const uF = 1 / FENCE_TILE;
          const y0 = 1.16 + HOARD_H;
          emit(fen, rows, () => [
            [0.09, y0, uF, y0 / FENCE_TILE],
            [0.09, 4.62, uF, 4.62 / FENCE_TILE],
            [-0.62, 5.92, uF, 6.30 / FENCE_TILE],
          ], false);
          // TENSION CABLES, as geometry rather than as a baked stripe (see
          // `fenceTexture`). Three runs: the foot of the panel, the head of the
          // vertical section where the rake starts, and the lip of the rake.
          // Each is a 45 mm chamfered ribbon standing 30 mm proud of the mesh —
          // one crisp horizontal line per real cable, at the height it is
          // actually at, instead of nine of them every 0.4 m.
          for (const [ho, hy] of [[0.115, y0 + 0.05], [0.115, 4.60], [-0.60, 5.88]]) {
            emit(frail, rows, () => [
              [ho, hy - 0.024, 1.0, 0, true],
              [ho + 0.030, hy, 1.0, 0.5, true],
              [ho, hy + 0.024, 1.0, 1, true],
            ], false);
          }

          for (const row of rows) {
            const sArc = row.i * c.step;
            if (sArc % FENCE_POST_SPACING < c.step) posts.push({ p: row.p, sm: c.samples[row.i], side });
            // Armco line posts on a 2 m pitch — one InstancedMesh, and the only
            // thing in the run that gives the ribbon a rhythm at ground level.
            // `gate` marks the marshal opening every ~34 m: a real run is broken
            // by access gates on heavier end posts, and the review's last minor
            // is precisely that the run had no break and no variation in it.
            if (row.type !== WALL && sArc % 2.0 < c.step) {
              rails.push({
                p: row.p, sm: c.samples[row.i], side, k: row.i,
                gate: (row.i * c.step) % 34 < c.step,
              });
            }
            /**
             * TECPRO PITCH. `sArc % 1.04 < c.step` looked like a 1.04 m pitch
             * and was in fact "every sample": `c.step` is 2.0 m, so the modulo
             * (always < 1.04) always passed. One 1.02 m element every 2.0 m is
             * a row of isolated bollards with a metre of daylight between them,
             * which is exactly how the `wide` foreground read. A TecPro wall is
             * a CONTINUOUS interlocking run, so step along the row instead and
             * lay elements end to end at their own width.
             */
            if (row.type === TECPRO) {
              const nPer = Math.max(1, Math.round(c.step / TECPRO_PITCH));
              for (let t = 0; t < nPer; t++) {
                tec.push({
                  p: row.p, sm: c.samples[row.i], side, k: row.i,
                  along: (t - (nPer - 1) / 2) * (c.step / nPer),
                });
              }
            }
          }
        }
      }

      const mk = (t, mat, colour, name, shadow, alsoMat = null) => {
        if (!t.idx.length) return;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(t.pos, 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(t.uv, 2));
        if (colour) g.setAttribute('color', new THREE.Float32BufferAttribute(t.col, 3));
        g.setIndex(t.idx);
        g.computeVertexNormals();
        const mesh = new THREE.Mesh(g, mat);
        mesh.name = name;
        mesh.castShadow = shadow;
        mesh.receiveShadow = shadow;
        group.add(mesh);
        if (alsoMat) {
          const back = new THREE.Mesh(g, alsoMat);
          back.name = `${name}Back`;
          group.add(back);
        }
        if (colour) this.barriers.push(mesh);
      };
      mk(rail, railMat, true, 'Barrier', true);
      mk(ad, hoardMat, false, 'Hoarding', true, hoardBackMat);
      mk(fen, fenceMat, false, 'CatchFence', false);
      mk(frail, fenceRailMat, false, 'CatchFenceRails', false);
    }

    group.add(this._fencePosts(posts));
    group.add(this._railPosts(rails));
    group.add(this._tecpro(tec));
    return group;
  }

  /**
   * Armco line posts. 150 mm channel section on a 2 m pitch, standing behind
   * the beam with a blockout spacer, plus the bolt boss. Dark, so it reads as a
   * shadow rhythm along the run rather than another bright band.
   */
  _railPosts(list) {
    const geo = assets.geometry('env/railpost', () => new Kit(0.8)
      .box(0.150, 1.24, 0.075, { y: 0.62, colour: 0x6e747a })
      .box(0.055, 1.16, 0.075, { y: 0.60, z: -0.075, colour: 0x5a6066 })
      .box(0.130, 0.240, 0.090, { y: 0.72, z: 0.080, colour: 0x878d93 })
      .box(0.100, 0.100, 0.060, { y: 0.44, z: 0.075, colour: 0x878d93 })
      .build());
    const mat = assets.material('env/railpost', () => new THREE.MeshStandardMaterial({
      color: 0x9aa0a6, vertexColors: true, roughness: 0.72, metalness: 0.85, envMapIntensity: 0.55,
    }));
    // Marshal-opening end post: a doubled-up section with a hinge stile and a
    // yellow/black hazard collar, standing 0.4 m proud of the line posts.
    const gateGeo = assets.geometry('env/railgate', () => new Kit(0.8)
      .box(0.190, 1.62, 0.110, { y: 0.81, colour: 0x767c82 })
      .box(0.075, 1.54, 0.110, { y: 0.79, z: -0.095, colour: 0x5a6066 })
      .box(0.150, 0.260, 0.130, { y: 0.74, z: 0.090, colour: 0x9299a0 })
      .box(0.205, 0.170, 0.145, { y: 1.34, colour: 0xd8b02a })
      .box(0.205, 0.085, 0.150, { y: 1.42, colour: 0x24262a })
      .box(0.100, 0.100, 0.520, { y: 1.02, z: 0.300, colour: 0x878d93 })    // hinge arm
      .build());
    const group = new THREE.Group();
    group.name = 'BarrierPosts';
    const line = list.filter((o) => !o.gate);
    const gates = list.filter((o) => o.gate);
    const rng = makeRng(hashSeed('railpost'));
    const emit = (src, g, name) => {
      if (!src.length) return;
      const inst = new THREE.InstancedMesh(g, mat, src.length);
      inst.castShadow = true; inst.receiveShadow = true;
      for (let i = 0; i < src.length; i++) {
        const o = src[i];
        this._faceTrack(o.sm, o.side, _q);
        // POST SPACING IS NOT A MODULO. The run was laid on an exact 2.000 m
        // pitch with an identical post at every station, which is what the
        // review saw. A real run is set out by eye off a tape: the pitch walks
        // by a few percent and every post is a degree or two out of plumb.
        _qb.copy(_q).multiply(_q2.setFromAxisAngle(UP, (rng() - 0.5) * 0.06));
        _v.copy(o.p).addScaledVector(o.sm.right, o.side * (0.155 + (rng() - 0.5) * 0.035))
          .addScaledVector(o.sm.tangent, (rng() - 0.5) * 0.14);
        _m.compose(_v, _qb, _one);
        inst.setMatrixAt(i, _m);
      }
      inst.instanceMatrix.needsUpdate = true;
      inst.name = name;
      group.add(inst);
    };
    emit(line, geo, 'BarrierPosts');
    emit(gates, gateGeo, 'BarrierGates');
    return group;
  }

  /**
   * Debris-fence line posts.
   *
   * A real one is a 90 mm galvanised RHS on a 12 m pitch with a cranked head —
   * dark, slim and sparse. The previous version was a 140 mm post every 3.9 m
   * with a near-white raking strut, i.e. three times the count at twice the
   * width in the brightest tone in the frame: a picket fence.
   */
  _fencePosts(list) {
    const geo = assets.geometry('env/fencepost', () => new Kit(0.6)
      .box(0.09, 4.62, 0.075, { y: 2.31 })                              // mast
      .box(0.075, 1.42, 0.065, { y: 5.28, z: -0.30, rx: -0.46 })        // cranked head
      .box(0.20, 0.06, 0.09, { y: 4.58, colour: 0xb4b8bc })             // head bracket
      .box(0.26, 0.16, 0.26, { y: 0.08, colour: 0x9a9d9f })             // base plate
      .box(0.055, 0.62, 0.055, { y: 1.44, z: 0.30, rx: 0.72 })          // rear stay
      .box(0.045, 0.045, 0.30, { y: 2.60, z: 0.14 })                    // rail cleats
      .box(0.045, 0.045, 0.30, { y: 4.10, z: 0.14 })
      .build());
    const mat = assets.material('env/fencepost', () => new THREE.MeshStandardMaterial({
      color: 0x5c6268, vertexColors: true, roughness: 0.66, metalness: 0.75, envMapIntensity: 0.55,
    }));
    const inst = new THREE.InstancedMesh(geo, mat, Math.max(1, list.length));
    inst.castShadow = true; inst.receiveShadow = true;
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      this._faceTrack(o.sm, o.side, _q);
      _m.compose(o.p, _q, _one);
      inst.setMatrixAt(i, _m);
    }
    inst.count = list.length;
    inst.instanceMatrix.needsUpdate = true;
    inst.name = 'FencePosts';
    return inst;
  }

  /**
   * TecPro. These were unweathered primary red and blue at full saturation,
   * evenly spaced and yaw-aligned — the most saturated objects in an otherwise
   * desaturated frame, reading as toy building blocks.
   *
   * Fixed three ways: the base colours are pulled ~28 % out of saturation and
   * down in value; a grime ramp on the vertex colour darkens the bottom third
   * and scuffs the leading corners (an element that has been hit is scraped
   * white-grey at the outboard nose); and each block takes ±0.15 m of spacing
   * jitter and ±3 degrees of yaw so the stack is laid by hand rather than by a
   * modulo. The black strap and bolt line that runs across a real stack is on
   * the geometry as its own darker band.
   */
  _tecpro(list) {
    const geo = assets.geometry('env/tecpro', () => {
      const k = new Kit(0.5);
      // Two blow-moulded elements. `mask 1` marks the plastic the per-instance
      // colour tints; the straps and end plates stay their own colour.
      const grime = (y) => 0.60 + 0.40 * clamp((y - 0.10) / 0.55, 0, 1);
      for (const y of [0.32, 0.88]) {
        k.cyl(0.30, 1.02, 12, { y, rz: Math.PI / 2, colour: 0xffffff, mask: 1 });
        // Grime skirt: a slightly larger, darker shell over the bottom of each
        // element, so the block is not one flat value.
        k.cyl(0.302, 0.34, 12, {
          y: y - 0.13, rz: Math.PI / 2,
          colour: _col.setScalar(grime(y - 0.13)).getHex(), mask: 1,
        });
      }
      // Scuffed leading corners — outboard end, both elements.
      for (const y of [0.32, 0.88]) {
        k.cyl(0.305, 0.16, 12, { x: 0.44, y, rz: Math.PI / 2, colour: 0xb8bab8 });
      }
      // Strap / bolt line across the stack.
      k.box(1.06, 0.075, 0.68, { y: 1.20, colour: 0xd6d8da });
      k.box(1.06, 0.055, 0.30, { y: 1.185, colour: 0x2a2d31 });
      k.box(1.06, 0.11, 0.64, { y: 0.60, colour: 0x2a2d31 });
      k.box(0.10, 0.30, 0.72, { x: -0.53, y: 0.60, colour: 0x9ba1a7 });
      k.box(0.10, 0.30, 0.72, { x: 0.53, y: 0.60, colour: 0x9ba1a7 });
      return k.build();
    });
    const mat = assets.material('env/tecproMat', () => {
      const m = new THREE.MeshStandardMaterial({
        color: 0xffffff, vertexColors: true, roughness: 0.62, metalness: 0.0, envMapIntensity: 0.7,
      });
      // Own instanced attribute, not `instanceColor`: three multiplies
      // `instanceColor` into every vertex inside `color_vertex`, which would
      // dye the straps and the scuffed corners as well.
      m.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nattribute vec3 aTec;\nattribute float aMask;')
          .replace('#include <color_vertex>',
            '#include <color_vertex>\nvColor.xyz *= mix( vec3( 1.0 ), aTec, aMask );');
      };
      m.customProgramCacheKey = () => 'apex-tecpro-mask';
      return m;
    });
    const inst = new THREE.InstancedMesh(geo, mat, Math.max(1, list.length));
    const tecCol = new Float32Array(Math.max(1, list.length) * 3);
    inst.castShadow = true; inst.receiveShadow = true;
    const rng = makeRng(hashSeed('tecpro'));
    for (let i = 0; i < list.length; i++) {
      const o = list[i];
      this._faceTrack(o.sm, o.side, _q);
      _q.multiply(_qb.setFromAxisAngle(UP, (rng() - 0.5) * 0.055));
      _v.copy(o.p)
        .addScaledVector(o.sm.right, -o.side * (0.44 + (rng() - 0.5) * 0.055))
        // `along` walks the element down the run at its own width; the jitter on
        // top of it has to stay well inside the 20 mm interlock or the wall
        // opens up again.
        .addScaledVector(o.sm.tangent, (o.along ?? 0) + (rng() - 0.5) * 0.045);
      _m.compose(_v, _q, _one);
      inst.setMatrixAt(i, _m);
      // Weathered polyethylene: 28 % less chroma, darker, and each block sun-
      // bleached by its own amount. Colour runs in blocks of ~6 m, which is how
      // a real installation is delivered and stacked.
      // A polyethylene element that has stood in the sun for three seasons is
      // nothing like the colour it was moulded in — but the previous pass took
      // TWO bites out of the chroma and landed on 0x94494a / 0x3c5480, which is
      // a muddy brick and a slate. That is the "bare grey concrete band" the
      // world critic logged against `wide`: from outside a corner the TecPro run
      // is the only colour in the foreground and it had none left. Back to a
      // credible weathered red/blue, still a long way off the moulding colour,
      // with per-block bleaching doing the desaturation instead of a constant.
      _col.setHex(Math.floor(o.k / 6) % 2 ? 0xba3f42 : 0x2b5ba6);
      _col.offsetHSL(0, -0.16 * rng(), (rng() - 0.5) * 0.09);
      tecCol[i * 3] = _col.r; tecCol[i * 3 + 1] = _col.g; tecCol[i * 3 + 2] = _col.b;
    }
    geo.setAttribute('aTec', new THREE.InstancedBufferAttribute(tecCol, 3));
    inst.count = list.length;
    inst.instanceMatrix.needsUpdate = true;
    inst.name = 'TecPro';
    this.barriers.push(inst);
    return inst;
  }

  _buildTyreWalls() {
    const c = this.circuit;
    const n = c.samples.length;
    const group = new THREE.Group();
    group.name = 'TyreWalls';

    const geo = assets.geometry('env/tyrestack', () => {
      const k = new Kit(1.2);
      // ALTERNATING RADIUS. Four equal cylinders butted together silhouette as
      // one smooth drum, which is exactly what the staged bundles read as in the
      // first wide capture. A real stack scallops, because a tyre is fattest at
      // the shoulder and waisted at the bead.
      for (let i = 0; i < 4; i++) {
        k.cyl(0.365, 0.155, 12, { y: 0.09 + i * 0.25, colour: i % 2 ? 0x2c2c2e : 0x232326 });
        k.cyl(0.315, 0.105, 12, { y: 0.215 + i * 0.25, colour: 0x18191c });
      }
      return k.build();
    });
    const mat = assets.material('env/tyrewall', () => new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.93, metalness: 0.0, envMapIntensity: 0.55,
    }));
    const beltGeo = assets.geometry('env/tyrebelt', () => new Kit(0.5)
      .box(0.84, 1.10, 0.06, { y: 0.56, z: -0.40, colour: 0xf2f3f0 }).build());
    const beltMat = assets.material('env/tyrebeltMat', () => new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.7, metalness: 0.0, envMapIntensity: 0.8,
    }));

    const stacks = [], belts = [], beltCols = [];
    const beltRng = makeRng(hashSeed('tyrebelt'));
    // Real tyre-wall facings are colour-coded conveyor belt, laid in runs — the
    // blue and red the world critic remembers from r2 (they were TecPro then,
    // but this is where that colour actually belongs on a circuit).
    const BELT = [0xd8dbd6, 0x2f63b0, 0xc23a3c, 0xd8dbd6, 0x2f63b0];
    for (const side of [-1, 1]) {
      for (let i = 0; i < n; i++) {
        const ix = this._ci(i, side);
        if (this.corr.type[ix] !== TYRES) continue;
        const sm = c.samples[i];
        const lat = side * this.corr.barrier[ix];
        _v.copy(sm.position).addScaledVector(sm.right, lat);
        _v.y = this._vergeY(i, side, lat);
        const p = _v.clone();
        this._faceTrack(sm, side, _q);
        // Same pitch trap as the TecPro run: `(i * step) % 0.82 >= step` reads
        // as a 0.82 m pitch and is in fact never true, because `c.step` is 2 m.
        // A tyre wall is stacks touching each other, so step along the sample.
        const nPer = Math.max(1, Math.round(c.step / 0.76));
        for (let t = 0; t < nPer; t++) {
          const along = (t - (nPer - 1) / 2) * (c.step / nPer);
          for (let row = 0; row < 2; row++) {
            _v.copy(p).addScaledVector(sm.right, -side * (0.44 + row * 0.74))
              .addScaledVector(sm.tangent, along + (row ? 0.38 : 0));
            _m.compose(_v, _q, _one);
            stacks.push(_m.clone());
          }
          _v.copy(p).addScaledVector(sm.right, -side * 0.44).addScaledVector(sm.tangent, along);
          _m.compose(_v, _q, _one);
          belts.push(_m.clone());
          _col.setHex(BELT[Math.floor(i / 5) % BELT.length], THREE.SRGBColorSpace);
          _col.offsetHSL(0, -0.10 * beltRng(), (beltRng() - 0.5) * 0.06);
          beltCols.push(_col.r, _col.g, _col.b);
        }
      }
    }

    if (stacks.length) {
      const inst = new THREE.InstancedMesh(geo, mat, stacks.length);
      inst.castShadow = inst.receiveShadow = true;
      stacks.forEach((m, i) => inst.setMatrixAt(i, m));
      inst.instanceMatrix.needsUpdate = true;
      group.add(inst);
      this.barriers.push(inst);
    }
    if (belts.length) {
      const inst = new THREE.InstancedMesh(beltGeo, beltMat, belts.length);
      inst.castShadow = inst.receiveShadow = true;
      belts.forEach((m, i) => inst.setMatrixAt(i, m));
      inst.instanceMatrix.needsUpdate = true;
      // `instanceColor`, not a custom attribute: the belt geometry's only vertex
      // colour is the near-white belt itself, so a straight multiply is exactly
      // the tint and needs no shader patch.
      inst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(beltCols), 3);
      inst.instanceColor.needsUpdate = true;
      group.add(inst);
    }
    group.add(this._stagedTyres(geo, mat));
    return group;
  }

  /**
   * STAGED TYRE BUNDLES — the foreground furniture the `wide` frame lost.
   *
   * Every circuit keeps spare bundles racked up behind the barrier next to a
   * marshal opening: three or four stacks, belted, colour-coded, sitting on the
   * verge with the service road behind them. They matter here because an
   * elevated shot from OUTSIDE a corner sees the back of the barrier and
   * nothing else — the tyre wall proper is on the racing side, hidden behind
   * its own advertising band — and that is exactly the "flat beige strip and a
   * bare grey concrete band" the review logged. This puts the colour, the human
   * scale and the barrier rhythm back where the camera can actually see it.
   */
  _stagedTyres(geo, mat) {
    const c = this.circuit;
    const group = new THREE.Group();
    group.name = 'StagedTyres';
    const rng = makeRng(hashSeed('staged-tyres'));
    // A staged bundle is BANDED, not billboarded: the colour is a strap wrapped
    // round the stack, so it reads as a bundle of tyres from every angle. The
    // first version put the tyre-wall's flat facing panel out here and it read
    // as a poster propped up in the grass.
    const bandGeo = assets.geometry('env/tyreband', () => new Kit(1.0)
      .cyl(0.378, 0.145, 12, { y: 0.585, colour: 0xffffff })
      .build());
    const bandMat = assets.material('env/tyrebandMat', () => new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.78, metalness: 0.0, envMapIntensity: 0.55,
    }));
    const BELT = [0x2a568f, 0x9e3335, 0xb9bcb8, 0xb3872a];
    const stacks = [], belts = [], cols = [];
    const PITCH = 88;                                     // metres between clumps
    for (const side of [-1, 1]) {
      for (let s = 0; s < c.length; s += PITCH) {
        const sj = c.wrapS(s + (side > 0 ? PITCH * 0.5 : 0) + (rng() - 0.5) * 22);
        const i = c.sampleIndex(sj);
        const ix = this._ci(i, side);
        if (this.corr.skip[ix] || this.corr.type[ix] === WALL) continue;
        const sm = c.samples[i];
        const q = this._faceTrack(sm, side, new THREE.Quaternion());
        const cell = Math.floor(rng() * BELT.length);
        const rows = 2, per = 3 + Math.floor(rng() * 3);
        for (let r = 0; r < rows; r++) {
          for (let k = 0; k < per; k++) {
            const lat = side * (this.corr.barrier[ix] + 1.05 + r * 0.78);
            const along = (k - (per - 1) / 2) * 0.78 + (rng() - 0.5) * 0.06;
            _v.copy(sm.position).addScaledVector(sm.right, lat)
              .addScaledVector(sm.tangent, along + r * 0.34);
            _v.y = this._vergeY(i, side, lat);
            _qb.copy(q).multiply(_q.setFromAxisAngle(UP, (rng() - 0.5) * 0.10));
            _m.compose(_v, _qb, _one);
            stacks.push(_m.clone());
            // The strap sits at whatever height it was thrown on at, not on one
            // dead-level line across the clump.
            _v.y += (rng() - 0.5) * 0.30;
            _m.compose(_v, _qb, _one);
            belts.push(_m.clone());
            _col.setHex(BELT[(cell + k + r) % BELT.length], THREE.SRGBColorSpace);
            _col.offsetHSL(0, -0.14 * rng(), (rng() - 0.5) * 0.07);
            cols.push(_col.r, _col.g, _col.b);
          }
        }
      }
    }
    if (stacks.length) {
      const inst = new THREE.InstancedMesh(geo, mat, stacks.length);
      inst.castShadow = inst.receiveShadow = true;
      inst.name = 'StagedTyreStacks';
      stacks.forEach((m, i) => inst.setMatrixAt(i, m));
      inst.instanceMatrix.needsUpdate = true;
      group.add(inst);
    }
    if (belts.length) {
      const inst = new THREE.InstancedMesh(bandGeo, bandMat, belts.length);
      inst.castShadow = inst.receiveShadow = true;
      inst.name = 'StagedTyreBands';
      belts.forEach((m, i) => inst.setMatrixAt(i, m));
      inst.instanceMatrix.needsUpdate = true;
      inst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cols), 3);
      inst.instanceColor.needsUpdate = true;
      group.add(inst);
    }
    return group;
  }

  // -- grandstands and crowd ------------------------------------------------

  _standModuleGeometry() {
    return assets.geometry('env/standModule', () => {
      const k = new Kit(0.45);
      const W = 30, ROWS = 20, RISE = 0.48, TREAD = 0.92;
      const H = ROWS * RISE, D = ROWS * TREAD;
      k.box(W, 2.2, 0.7, { y: 1.1, colour: 0xc9cdd2 });
      // FRONT SAFETY BARRIER: a 1.1 m debris wall standing on the front edge of
      // the deck with an advertising band on its face, plus a top rail. Without
      // it the stand's front row floats and the whole structure silhouettes as a
      // bus shelter.
      k.box(W, 1.05, 0.26, { y: 2.72, z: 0.28, colour: 0xd4d8dc });
      k.box(W, 0.09, 0.36, { y: 3.28, z: 0.28, colour: 0x9ba1a7 });
      for (let i = -6; i <= 6; i++) k.box(0.10, 1.02, 0.10, { x: i * (W / 13), y: 2.70, z: 0.14, colour: 0xaeb4ba });
      for (let r = 0; r < ROWS; r++) {
        k.box(W, RISE + 0.18, TREAD, { y: 2.2 + r * RISE - 0.09, z: -0.65 - r * TREAD, colour: 0xbfc4c9 });
        // Riser face darker than the tread: this is what makes the deck read as
        // steps rather than as a ramp with confetti on it.
        k.box(W, RISE * 0.92, 0.06, {
          y: 2.2 + r * RISE + RISE * 0.10, z: -0.65 - r * TREAD + TREAD / 2, colour: 0x8b9298,
        });
        const band = Math.floor(r / 4) % 2;
        k.box(W - 0.8, 0.44, 0.40, {
          y: 2.2 + r * RISE + 0.32, z: -0.65 - r * TREAD - 0.22,
          colour: band ? 0x2f548f : 0x203a6a,
        });
      }
      // Two vertical aisles with a stair run in a different tread colour, so the
      // crowd has visible circulation instead of being one unbroken block.
      for (const ax of [-W / 4, W / 4]) {
        for (let r = 0; r < ROWS; r++) {
          k.box(2.1, RISE + 0.20, TREAD * 0.96, {
            x: ax, y: 2.2 + r * RISE + 0.02, z: -0.65 - r * TREAD, colour: 0x9aa0a6,
          });
          k.box(2.1, 0.05, TREAD * 0.5, {
            x: ax, y: 2.2 + r * RISE + 0.26, z: -0.65 - r * TREAD - TREAD * 0.25, colour: 0xdfe3e7,
          });
        }
      }
      /**
       * THE GANGWAYS HAVE TO LAND ON THE AISLES.
       *
       * These three ramps sat at 0 and +-9.5 while the crowd scatter cuts its
       * aisles at +-W/4 = +-7.5, so two of the three ran straight over the top of
       * seated spectators and photographed as grey slabs laid across the
       * terrace. They belong exactly where the stair treads already are.
       */
      for (const ax of [-W / 4, W / 4]) {
        k.box(1.9, 0.12, D + 0.6, {
          x: ax, y: 2.35 + H * 0.5, z: -0.65 - D * 0.5,
          rx: -Math.atan2(RISE, TREAD), colour: 0xd9dce0,
        });
      }
      k.box(W, H * 0.5, 0.8, { y: 2.2 + H + H * 0.25, z: -0.65 - D - 0.4, colour: 0xb6bbc0 });
      const roofY = 2.2 + H + H * 0.5 + 1.4;
      k.box(W, 0.45, D + 3.6, { y: roofY, z: -0.65 - D * 0.5 - 1.1, colour: 0x9aa0a6 });
      k.box(W, 1.6, 0.5, { y: roofY + 0.95, z: 1.1, colour: 0x8f959b });
      for (let i = -3; i <= 3; i++) {
        k.box(0.24, 0.95, D + 3.6, { x: i * (W / 7), y: roofY + 0.6, z: -0.65 - D * 0.5 - 1.1, colour: 0x8a9096 });
      }
      /**
       * ROOF TRUSS AND PURLINS.
       *
       * A cantilevered stand roof is not a slab: it is a welded lattice, and its
       * underside is the single largest surface a camera at track level looks
       * up into. Without it the whole structure silhouettes as "extruded slab on
       * plain columns" — the review's words — and, measured, the top-right cell
       * of `grid` carries almost no edge energy at all.
       *
       * Cheap version: a leading-edge Warren truss (top chord, bottom chord, and
       * diagonals alternating sign) plus purlins across the soffit. 60 boxes on
       * a geometry that is instanced across every module in the circuit, so it
       * costs one bake and no extra draw call.
       */
      const zFront = 1.1, zBack = -0.65 - D - 2.9;
      const tY = roofY - 0.62;
      for (const zc of [zFront - 0.2, -0.65 - D * 0.5 - 1.1, zBack + 0.4]) {
        const dep = zc === zFront - 0.2 ? 0.30 : 0.24;
        k.box(W, 0.16, dep, { y: tY, z: zc, colour: 0x878d93 });
        k.box(W, 0.16, dep, { y: tY - 1.05, z: zc, colour: 0x7d838a });
        for (let i = 0; i < 14; i++) {
          const x = -W / 2 + (i + 0.5) * (W / 14);
          k.box(0.115, 1.42, dep * 0.6, { x, y: tY - 0.52, z: zc, rz: i % 2 ? 0.62 : -0.62, colour: 0x9198a0 });
        }
      }
      // Purlins under the deck of the roof, running across the cantilever.
      for (let i = 0; i < 9; i++) {
        const z = lerp(zFront - 0.6, zBack + 0.8, i / 8);
        k.box(W, 0.13, 0.19, { y: roofY - 0.30, z, colour: 0x83898f });
      }
      // Front gutter and a fascia shadow gap, so the leading edge has a value
      // break instead of ending in a single flat plane.
      k.box(W, 0.22, 0.34, { y: roofY - 0.34, z: zFront + 0.28, colour: 0x6f757b });
      for (const cx of [-W / 2 + 1.5, 0, W / 2 - 1.5]) {
        k.box(0.55, roofY, 0.55, { x: cx, y: roofY / 2, z: 1.0, colour: 0xaeb4ba });
        k.box(0.32, 3.8, 0.32, { x: cx, y: roofY - 1.7, z: 0.1, rx: 0.72, colour: 0xaeb4ba });
        k.box(0.55, 2.2 + H + H * 0.5, 0.55, { x: cx, y: (2.2 + H + H * 0.5) / 2, z: -0.65 - D - 0.7, colour: 0xaeb4ba });
      }
      return k.build();
    });
  }

  /**
   * WHERE THE STANDS GO.
   *
   * The r3 layout put its two biggest runs at 0.955 L and 0.045 L — 180 m short
   * of the line on one side and 190 m past it on the other — which left a
   * ~370 m hole centred exactly on start/finish. That hole is the entire right
   * third of the `grid` frame, and it is the one frame the product is sold on.
   *
   * A grand prix main straight is walled: the pit building runs one side and an
   * unbroken tiered stand runs the other, from well before the line to well
   * after it. So the main stand is now placed by ARC LENGTH, not by a fraction,
   * as one 12-module 365 m run on the non-pit side straddling s = 0, with a
   * shorter opposing run on the pit side past the end of the garages. `side` is
   * explicit where it matters: deriving it from curvature on a straight always
   * returned +1, which is why nothing ever landed opposite the pits.
   *
   * SETBACK IS A LIGHTING DECISION, NOT A DRESSING ONE.
   *
   * On the `grid` clock the sun sits at azimuth EXACTLY along the straight's
   * `right` axis — measured, `sunDir . right = 1.00` — and 31 degrees up. The
   * main stand's roof fascia tops out at 19.75 m, so it throws a 32.7 m bar of
   * shadow straight across the racing surface. At the old `barrier + 9` setback
   * its front edge sat at lateral +27.5, which put the shadow terminator at
   * lateral -4: every one of the twenty cars, and 85 % of the tarmac, sat in a
   * flat shaded slab (measured 0.042 linear against 0.135 on the lit apron)
   * while the pit lane opposite was the brightest ground in frame. Hiding
   * `StandModules` and re-capturing put raking sun on the whole field, which is
   * the diagnosis, not a fix.
   *
   * `out` is therefore a per-run setback in metres and the main straight carries
   * 16 of it: 27.5 + 16 - 32.7 = +10.8, i.e. the terminator lands 3 m OUTBOARD
   * of the right-hand white line and the grid is lit. A 34 m gap between the
   * track edge and the front row is not artistic licence either — Yas, Jeddah
   * and COTA all run a run-off, a service road and a concourse through exactly
   * that space. Anyone re-timing the `grid` shot must re-check this number.
   */
  _standPlacements() {
    const c = this.circuit;
    const L = c.length;
    const spots = [
      // Main grandstand: 12 modules on the outside of the pit straight, centred
      // 30 m before the line so it fills frame from the back of the grid.
      { s: -30, mods: 12, side: 1, out: 16 },
      // Opposite the pits, past the garage row — the "paddock club" end.
      { s: 300, mods: 4, side: 1, out: 16 },
      // Pit-side stand ahead of the garages, so the left of frame is not just
      // the pit building fading into a field. This one is DOWN-sun of the track
      // and shadows nothing, so it keeps the tight setback.
      { s: 268, mods: 3, side: -1 },
      { f: 0.155, mods: 4 }, { f: 0.335, mods: 3 },
      { f: 0.505, mods: 4 }, { f: 0.665, mods: 3 }, { f: 0.845, mods: 4 },
    ];
    const out = [];
    for (const spot of spots) {
      const s0 = c.wrapS(spot.s !== undefined ? spot.s : spot.f * L);
      const sm0 = c.sampleAt(s0);
      const side = spot.side ?? (Math.abs(sm0.curvature) > 0.001 ? -Math.sign(sm0.curvature) : 1);
      for (let m = 0; m < spot.mods; m++) {
        // 29.2, not 30.4: the module is exactly 30 m wide, and modules are
        // spaced along ARC length while their walls are chords — on any curved
        // run the old 40 cm surplus fanned open into a wedge and photographed as
        // a bright vertical slot of sky straight through the crowd in `beauty`.
        // A 0.8 m overlap is invisible and cannot open however tight the radius.
        const s = c.wrapS(s0 + (m - (spot.mods - 1) / 2) * 29.2);
        const i = c.sampleIndex(s);
        const sm = c.samples[i];
        const dist = this.corr.barrier[this._ci(i, side)] + 9.0 + (spot.out ?? 0);
        _v.copy(sm.position).addScaledVector(sm.right, side * dist);
        _v.y = this._vergeY(i, side, side * dist);
        out.push({ p: _v.clone(), sm, side, s });
      }
    }
    return out;
  }

  _buildGrandstands() {
    const group = new THREE.Group();
    group.name = 'Grandstands';
    const geo = this._standModuleGeometry();
    const concreteMaps = assets.get('env/concreteMaps', () => setRepeat(cloneMaps(concrete({ stain: 0.55 })), 1, 1));
    /**
     * A DEEP STAND IS A CAVE, AND A CAVE NEEDS A BOUNCE TERM.
     *
     * Twenty rows under a 20 m roof see almost no sky and no sun at all on the
     * morning `grid` clock, so the concrete rendered at near-black and the whole
     * structure read as a void with confetti in it. There is no local light in
     * the scene to put there, and adding one costs a shadow-casting light per
     * stand, so the inter-reflection between deck, riser and soffit is stood in
     * for the same way `garage` does it: a fixed fraction of the surface's own
     * albedo, plus a floor. 0.115 puts a shaded riser around 0.09 scene-referred
     * — an f-stop and a half under the sunlit apron, which is what a photograph
     * of a shaded terrace actually measures, and three stops under the bloom
     * threshold so it can never bloom.
     */
    const mat = assets.material('env/stand', () => {
      const m = new THREE.MeshStandardMaterial({
        ...mapsToMaterial(concreteMaps),
        vertexColors: true,
        color: 0xffffff, roughness: 1, metalness: 0, envMapIntensity: 1.05,
        emissive: 0xffffff, emissiveIntensity: 1.0,
      });
      m.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader
          // 0.115 was calibrated against the pre-`49acf27` key light. That commit
          // took the sun to 16.0 and pulled the ambient down to match, which left
          // the main-straight stand — the single biggest object in the `grid`
          // frame — rendering as a black slab with confetti in it (measured: the
          // concrete columns came back at sRGB 8–20 against a 140 apron). The
          // bounce is now 0.30 of the surface's own albedo, which puts a shaded
          // riser at ~0.17 scene-referred: two and a half stops under the sunlit
          // apron, and still three stops under the 1.25 bloom threshold.
          .replace('#include <emissivemap_fragment>', /* glsl */`
            #include <emissivemap_fragment>
            totalEmissiveRadiance = diffuseColor.rgb * vec3( 0.380, 0.384, 0.401 )
                                  + vec3( 0.0230, 0.0242, 0.0272 );`);
      };
      m.customProgramCacheKey = () => 'apex-stand-bounce';
      return m;
    });

    this._stands = this._standPlacements();
    /**
     * ONE DRAW CALL FOR THE WHOLE RING. The main straight needs a dozen modules
     * on its own and the row was one `Mesh` each. `environment.grandstands` is a
     * documented contract (`audio/engine.js` builds its occlusion boxes off it),
     * so the list survives as invisible proxies carrying the same geometry and
     * world matrix — `Box3.setFromObject` does not test visibility, and an
     * invisible child costs nothing to render.
     */
    const stands = new THREE.InstancedMesh(geo, mat, this._stands.length);
    stands.name = 'StandModules';
    stands.castShadow = true;
    stands.receiveShadow = true;
    this._stands.forEach((st, i) => {
      this._faceTrack(st.sm, st.side, _q);
      _m.compose(st.p, _q, _one);
      stands.setMatrixAt(i, _m);
      const proxy = new THREE.Object3D();
      proxy.position.copy(st.p);
      proxy.quaternion.copy(_q);
      proxy.visible = false;
      const shell = new THREE.Mesh(geo, mat);
      shell.visible = false;
      proxy.add(shell);
      group.add(proxy);
      this.grandstands.push(proxy);
    });
    stands.instanceMatrix.needsUpdate = true;
    group.add(stands);

    const ROWS = 20, RISE = 0.48;
    const roofY = 2.2 + ROWS * RISE * 1.5 + 1.4 + 0.95;
    // 30 m of fascia = 5 panels of 6.0 m on a 1.6 m board -> panel aspect 3.75.
    const bannerGeo = new THREE.PlaneGeometry(30, 1.6);
    const bannerMat = boardMaterial('env/standBanner', 'env/boardStand',
      { panels: 5, aspect: 3.75, seed: 19, height: 192 }, { roughness: 0.55 });
    const banners = new THREE.InstancedMesh(bannerGeo, bannerMat, this._stands.length);
    this._stands.forEach((st, i) => {
      this._faceTrack(st.sm, st.side, _q);
      _v.copy(st.p).addScaledVector(UP, roofY).addScaledVector(st.sm.right, -st.side * 1.4);
      _m.compose(_v, _q, _one);
      banners.setMatrixAt(i, _m);
    });
    banners.instanceMatrix.needsUpdate = true;
    group.add(banners);

    // Advertising band on the front debris wall of every stand.
    const frontGeo = new THREE.PlaneGeometry(30, 0.86);
    const frontMat = boardMaterial('env/standFront', 'env/boardStandFront',
      { panels: 7, aspect: 4.3, seed: 53, height: 160, mix: 0.14 }, { roughness: 0.55 });
    const fronts = new THREE.InstancedMesh(frontGeo, frontMat, this._stands.length);
    this._stands.forEach((st, i) => {
      this._faceTrack(st.sm, st.side, _q);
      _v.copy(st.p).addScaledVector(UP, 2.74).addScaledVector(st.sm.right, -st.side * 0.42);
      _m.compose(_v, _q, _one);
      fronts.setMatrixAt(i, _m);
    });
    fronts.instanceMatrix.needsUpdate = true;
    group.add(fronts);

    /**
     * BIG SCREEN. Every grand prix circuit has two or three, they are 12 m
     * across, and their absence is one of the loudest "this is not a race
     * weekend" signals in an establishing shot. The panel is emissive but
     * DELIBERATELY dim — 0.34 on a mid-value image, which puts the brightest
     * screen texel around 0.30 scene-referred, a stop and a half under the 1.25
     * bloom threshold. A daylight LED wall is not a light source in frame.
     */
    const screenGeo = assets.geometry('env/bigscreen', () => new Kit(0.5)
      .box(13.4, 8.2, 0.7, { y: 4.1, colour: 0x22262b })
      .box(14.2, 0.5, 1.0, { y: 8.6, colour: 0x9ba1a7 })
      .box(14.2, 0.5, 1.0, { y: -0.2, colour: 0x9ba1a7 })
      .box(0.9, 6.4, 0.9, { x: -4.6, y: -3.2, z: 0.1, colour: 0x8d9298 })
      .box(0.9, 6.4, 0.9, { x: 4.6, y: -3.2, z: 0.1, colour: 0x8d9298 })
      .box(9.6, 0.5, 0.5, { y: -5.0, z: 0.1, colour: 0x8d9298 })
      .build());
    const screenMat = assets.material('env/bigscreenMat', () => new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.6, metalness: 0.1, envMapIntensity: 0.6,
    }));
    const panelMat = assets.material('env/bigscreenPanel', () => {
      const tex = canvasTexture('env/screenFeed', 512, 320, (ctx, w, h) => {
        ctx.fillStyle = '#0e1216'; ctx.fillRect(0, 0, w, h);
        // A framed onboard shot: sky band, tarmac, a car shape, a timing strap.
        const g = ctx.createLinearGradient(0, 0, 0, h * 0.52);
        g.addColorStop(0, '#54687e'); g.addColorStop(1, '#8b9aa6');
        ctx.fillStyle = g; ctx.fillRect(0, 0, w, h * 0.52);
        ctx.fillStyle = '#3a3d42'; ctx.fillRect(0, h * 0.52, w, h * 0.48);
        ctx.fillStyle = '#4b4e53';
        ctx.beginPath(); ctx.moveTo(w * 0.18, h); ctx.lineTo(w * 0.42, h * 0.52);
        ctx.lineTo(w * 0.58, h * 0.52); ctx.lineTo(w * 0.86, h); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#a8302f';
        ctx.beginPath();
        ctx.moveTo(w * 0.30, h * 0.86); ctx.lineTo(w * 0.44, h * 0.70);
        ctx.lineTo(w * 0.62, h * 0.70); ctx.lineTo(w * 0.70, h * 0.86); ctx.closePath(); ctx.fill();
        ctx.fillStyle = '#15181c'; ctx.fillRect(w * 0.30, h * 0.855, w * 0.40, h * 0.045);
        ctx.fillStyle = 'rgba(12,16,20,0.85)'; ctx.fillRect(0, h * 0.90, w, h * 0.10);
        ctx.fillStyle = '#d8dde2';
        ctx.font = `700 ${Math.round(h * 0.062)}px ${DISPLAY}`;
        ctx.textBaseline = 'middle';
        ctx.fillText('P1  REN   1:22.418', w * 0.03, h * 0.951);
        ctx.fillStyle = '#e8c21c'; ctx.fillRect(0, h * 0.895, w * 0.012, h * 0.105);
        // Scanline / pixel-pitch grid, so it reads as an LED wall.
        ctx.fillStyle = 'rgba(0,0,0,0.16)';
        for (let y = 0; y < h; y += 4) ctx.fillRect(0, y, w, 1);
        for (let x = 0; x < w; x += 4) ctx.fillRect(x, 0, 1, h);
      });
      return new THREE.MeshStandardMaterial({
        map: tex, emissiveMap: tex, emissive: 0xffffff, emissiveIntensity: 0.34,
        roughness: 0.42, metalness: 0.0, envMapIntensity: 0.3,
      });
    });
    // One screen inside the main-straight run (the one a grid shot sees) and one
    // out at a corner stand; indices, not fractions, so re-laying the ring does
    // not silently move them.
    const screenSpots = [this._stands[11], this._stands[24]].filter(Boolean);
    for (const st of screenSpots) {
      const q = this._faceTrack(st.sm, st.side, new THREE.Quaternion());
      _v.copy(st.p).addScaledVector(st.sm.right, -st.side * 26);
      // Stand on the real ground 26 m outboard, not on the stand's own base
      // height — the terrain is carved and the two are not the same.
      _v.y = this.terrainHeightAt(_v.x, _v.z) + 6.4;
      const frame = new THREE.Mesh(screenGeo, screenMat);
      frame.position.copy(_v); frame.quaternion.copy(q);
      frame.castShadow = true;
      frame.name = 'BigScreen';
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(12.6, 7.6), panelMat);
      panel.position.copy(_v).addScaledVector(_v2.copy(st.sm.right).multiplyScalar(-st.side), 0.38)
        .addScaledVector(UP, 4.1);
      panel.quaternion.copy(q);
      group.add(frame, panel);
    }
    return group;
  }

  _buildCrowd() {
    const group = new THREE.Group();
    group.name = 'Crowd';
    const c = this.circuit;
    const rng = this.rng;
    const ROWS = 20, RISE = 0.48, TREAD = 0.92;
    const perRow = this.detail === 'low' ? 24 : 38;
    const seats = [];

    for (const st of this._stands) {
      const q = this._faceTrack(st.sm, st.side, new THREE.Quaternion());
      const basis = new THREE.Matrix4().makeRotationFromQuaternion(q);
      for (let r = 0; r < ROWS; r++) {
        for (let k = 0; k < perRow; k++) {
          if (rng() < 0.09 + 0.18 * (r / ROWS)) continue;
          // Seat pitch, and NOBODY SITS IN THE AISLE. The stand module now has
          // two stair runs at ±W/4; a spectator standing in one reads as a
          // modelling error.
          const seatX = (k - (perRow - 1) / 2) * (29 / perRow) + (rng() - 0.5) * 0.22;
          if (Math.abs(Math.abs(seatX) - 7.5) < 1.15) continue;
          /**
           * SEATED AND STANDING, AND A FRONT-TO-BACK LIGHT GRADIENT.
           *
           * Every card was the same height and every card carried the same flat
           * 0.72 fill, so twenty rows read as one wall of identically-posed
           * clones with no tonal gradation — the review's exact words. Two
           * numbers per instance fix both. `stand` makes roughly a third of them
           * a head and shoulders taller and pushes them a little forward over
           * the row in front, which is what a terrace actually looks like.
           * `lit` is the sky visibility of that row: the front row sees most of
           * the hemisphere over the debris wall, the back row is under twenty
           * metres of roof and sees a slot. That gradient is the only thing in
           * the shot telling you the stand has depth.
           */
          const standing = rng() < 0.34;
          const rowT = r / (ROWS - 1);
          const local = new THREE.Vector3(
            seatX,
            2.2 + r * RISE + 0.74,
            -0.65 - r * TREAD - 0.14 + (rng() - 0.5) * 0.10 + (standing ? 0.30 : 0)
          );
          local.applyMatrix4(basis).add(st.p);
          seats.push({
            p: local, q, flag: rng() < 0.03,
            scale: standing ? 1.24 + rng() * 0.12 : 0.94 + rng() * 0.10,
            lit: 1.14 - 0.48 * Math.pow(rowT, 0.72),
          });
        }
      }
    }

    // Standing crowd on the grass banking. Eight sites, not four: an F1 wide
    // shot has no spectator-free 300 m stretch, and with four the `wide` frame
    // could and did land on one.
    for (const f of [0.09, 0.19, 0.24, 0.35, 0.44, 0.52, 0.60, 0.70, 0.78, 0.90]) {
      const s0 = f * c.length;
      for (let k = 0; k < 700; k++) {
        const s = c.wrapS(s0 + (rng() - 0.5) * 200);
        const i = c.sampleIndex(s);
        const sm = c.samples[i];
        const side = Math.abs(sm.curvature) > 0.001 ? -Math.sign(sm.curvature) : 1;
        if (this.corr.skip[this._ci(i, side)]) continue;
        const lat = side * (this.corr.barrier[this._ci(i, side)] + 2.5 + rng() * 12);
        _v.copy(sm.position).addScaledVector(sm.right, lat);
        _v.addScaledVector(sm.tangent, (rng() - 0.5) * c.step);
        _v.y = this._vergeY(i, side, lat) + 0.02;
        seats.push({ p: _v.clone(), q: this._faceTrack(sm, side, new THREE.Quaternion()), flag: rng() < 0.05, scale: 1.55 });
      }
    }

    if (seats.length) {
      // 0.66 x 1.02 put a seated spectator's whole body inside a metre — from
      // 120 m that is a two-pixel speck, which is what read as confetti. A
      // seated adult with a raised head is ~1.30 m of visible card.
      const geo = new THREE.PlaneGeometry(0.80, 1.30);
      geo.translate(0, 0.60, 0);
      const cells = new Float32Array(seats.length * 2);
      const tints = new Float32Array(seats.length * 3);
      const phase = new Float32Array(seats.length);
      const uTime = { value: 0 };
      this.animated.push(uTime);
      // THE CROWD IS UNLIT AND IT IS SITTING UNDER A ROOF. `CROWD_FRAG` has no
      // light term beyond this constant, so at 1.22 every spectator rendered at
      // full brightness no matter what the sun was doing — in `front` and
      // `beauty` the grandstand structure around them was in deep shade at a
      // 17-20 deg sun while the people inside it glowed, which is most of why
      // the stand read as a lightbox of confetti rather than as part of the
      // scene. A roofed stand sees a slice of sky and no sun at all: 0.72 puts
      // the crowd a stop and a half under open tarmac, which is where the
      // structure they are sitting in already is.
      const inst = new THREE.InstancedMesh(geo, spriteMaterial(crowdSprite({}), uTime, 0.72), seats.length);
      for (let i = 0; i < seats.length; i++) {
        const s = seats[i];
        const sc = s.scale ?? 1;
        _m.compose(s.p, s.q, _v.set(sc, sc, sc));
        inst.setMatrixAt(i, _m);
        const cell = Math.floor(rng() * CROWD_COLS * CROWD_ROWS);
        cells[i * 2] = (cell % CROWD_COLS) / CROWD_COLS;
        cells[i * 2 + 1] = Math.floor(cell / CROWD_COLS) / CROWD_ROWS;
        // TWO FIXES FOUGHT HERE AND THE TINT WON. `crowdSprite` authors a
        // clothing palette per atlas cell; this attribute MULTIPLIES it, and a
        // uniform random HUE at 0.35-0.85 saturation threw that palette away and
        // repainted all ~4000 spectators in pure spectrum — which is why the
        // main stand was the most saturated object in `beauty`, `front` and
        // `wheel`, louder than the car. The tint exists only to stop 60 atlas
        // cells reading as 60 repeated clones, so vary VALUE and let the sprite
        // carry hue; one spectator in eight gets a genuine colour accent, which
        // is roughly what a photograph of a grandstand shows.
        if (rng() < 0.12) _col.setHSL(rng(), 0.42 + rng() * 0.2, 0.50 + rng() * 0.14);
        else _col.setHSL(0.07 + rng() * 0.07, 0.04 + rng() * 0.10, 0.58 + rng() * 0.28);
        // `lit` is the row's sky visibility (see the note where it is set); on
        // the open banking there is no roof, so it defaults to 1.
        const lf = s.lit ?? 1;
        _col.multiplyScalar(lf);
        tints[i * 3] = _col.r; tints[i * 3 + 1] = _col.g; tints[i * 3 + 2] = _col.b;
        phase[i] = rng();
      }
      geo.setAttribute('aCell', new THREE.InstancedBufferAttribute(cells, 2));
      geo.setAttribute('aTint', new THREE.InstancedBufferAttribute(tints, 3));
      geo.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
      inst.instanceMatrix.needsUpdate = true;
      inst.frustumCulled = false;
      inst.name = 'Spectators';
      this.crowd = inst;
      group.add(inst);
    }

    const flagged = seats.filter((s) => s.flag);
    if (flagged.length) group.add(this._flagField(flagged, 0.62, 0.40, 0.31, 1.52, 4));
    return group;
  }

  /** Instanced waving flags (crowd + marshal posts share the shader). */
  _flagField(list, w, h, ox, oy, cells, oz = 0) {
    const g = new THREE.PlaneGeometry(w, h, 5, 1);
    g.translate(ox + w / 2, oy, oz);
    const phase = new Float32Array(list.length);
    const cell = new Float32Array(list.length);
    const uTime = { value: 0 };
    this.animated.push(uTime);
    const mat = new THREE.ShaderMaterial({
      uniforms: Object.assign({}, THREE.UniformsLib.fog, {
        uMap: { value: flagTexture() },
        uLight: { value: new THREE.Color(1.06, 1.04, 0.99) },
        uWidth: { value: w },
        uTime,
      }),
      vertexShader: FLAG_VERT,
      fragmentShader: FLAG_FRAG,
      side: THREE.DoubleSide,
      fog: true,
    });
    const inst = new THREE.InstancedMesh(g, mat, list.length);
    for (let i = 0; i < list.length; i++) {
      _m.compose(list[i].p, list[i].q, _one);
      inst.setMatrixAt(i, _m);
      phase[i] = this.rng();
      cell[i] = list[i].cell ?? Math.floor(this.rng() * cells);
    }
    g.setAttribute('aPhase', new THREE.InstancedBufferAttribute(phase, 1));
    g.setAttribute('aCell', new THREE.InstancedBufferAttribute(cell, 1));
    inst.instanceMatrix.needsUpdate = true;
    inst.frustumCulled = false;
    return inst;
  }

  /**
   * Queue a person. `kit` is the overall colour, `pose` 0/1/2 (see
   * `figureGeometry`), `yaw` an extra spin about the figure's own up axis so a
   * group never stands to attention in a row.
   */
  _person(p, q, kit, pose, yaw = 0, scale = 1, fill = 0) {
    this._people.push({ p: p.clone ? p.clone() : p, q, kit, pose, yaw, scale, fill });
  }

  /** All trackside humans, one InstancedMesh per pose. */
  _buildPeople() {
    const group = new THREE.Group();
    group.name = 'People';
    const mat = figureMaterial();
    const rng = makeRng(hashSeed('people'));
    for (let pose = 0; pose < FIGURE_POSES; pose++) {
      const list = this._people.filter((f) => f.pose === pose);
      if (!list.length) continue;
      const geo = figureGeometry(pose);
      const inst = new THREE.InstancedMesh(geo, mat, list.length);
      inst.castShadow = true;
      inst.receiveShadow = true;
      inst.name = `People-${pose}`;
      const kit = new Float32Array(list.length * 3);
      const skin = new Float32Array(list.length * 3);
      // `aFill` stands in for the strip lighting inside a pit garage. The bay is
      // a closed box in the sun's shadow with no local light source in the
      // scene, so a mechanic standing in one rendered at sRGB 0,4,23 — a black
      // cut-out against a lit back wall. This is the same one-number stand-in
      // for a missing bounce the garage facade uses, applied per instance so the
      // hundred crew out on the sunlit apron are untouched.
      const fill = new Float32Array(list.length);
      for (let i = 0; i < list.length; i++) {
        const f = list[i];
        fill[i] = f.fill ?? 0;
        // A person is 1.62–1.88 m; the geometry is authored at 1.78.
        const sc = f.scale * (0.94 + rng() * 0.10);
        _qb.copy(f.q).multiply(_q.setFromAxisAngle(UP, f.yaw));
        _m.compose(f.p, _qb, _v.set(sc, sc, sc));
        inst.setMatrixAt(i, _m);
        _col.setHex(f.kit, THREE.SRGBColorSpace);
        kit[i * 3] = _col.r; kit[i * 3 + 1] = _col.g; kit[i * 3 + 2] = _col.b;
        _col.setHex(SKIN_TONES[Math.floor(rng() * SKIN_TONES.length)], THREE.SRGBColorSpace);
        skin[i * 3] = _col.r; skin[i * 3 + 1] = _col.g; skin[i * 3 + 2] = _col.b;
      }
      geo.setAttribute('aKit', new THREE.InstancedBufferAttribute(kit, 3));
      geo.setAttribute('aSkin', new THREE.InstancedBufferAttribute(skin, 3));
      geo.setAttribute('aFill', new THREE.InstancedBufferAttribute(fill, 1));
      inst.instanceMatrix.needsUpdate = true;
      group.add(inst);
    }
    return group;
  }

  // -- pit lane -------------------------------------------------------------

  _buildPitLane() {
    const c = this.circuit;
    const group = new THREE.Group();
    group.name = 'PitLane';
    const hw = c.halfWidth;

    const sStart = c.wrapS(-420);
    const laneLength = 640;
    const steps = Math.ceil(laneLength / 5);
    const inner = -(hw + 3.4), outer = -(hw + 21.0);
    // Flat pit apron: pinned to the road edge height, with a gentle crossfall.
    const pitY = (sm, lat) => this._edgeY(sm, -(hw + 2.4)) + 0.03 - 0.012 * (Math.abs(lat) - (hw + 3.4));

    const cols = [outer, outer + 6, inner - 5.5, inner];
    const pos = [], uv = [], col = [], idx = [];
    for (let i = 0; i <= steps; i++) {
      const s = sStart + (i / steps) * laneLength;
      const sm = c.sampleAt(s);
      for (let k = 0; k < cols.length; k++) {
        const lat = cols[k];
        _v.copy(sm.position).addScaledVector(sm.right, lat);
        _v.y = pitY(sm, lat);
        pos.push(_v.x, _v.y, _v.z);
        uv.push(lat / 4, (i / steps) * laneLength / 4);
        // The garage apron was 1.16 on an 0xb0b4b8 base, which measured 0.205
        // linear — the brightest ground anywhere in `grid`, brighter than the
        // sunlit racing surface it sits beside. A pit apron is sealed concrete:
        // lighter than tarmac, not luminous. Bringing it down also buys back the
        // shadow contrast the crew figures need to make contact.
        const apron = k <= 1 ? 1.00 : 0.88;
        col.push(apron, apron, apron * 1.01);
      }
    }
    for (let i = 0; i < steps; i++) {
      for (let k = 0; k < cols.length - 1; k++) {
        const a = i * cols.length + k, bb = a + 1, d = a + cols.length, e = d + 1;
        idx.push(a, bb, d, bb, e, d);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();

    const maps = assets.get('env/pitMaps', () => setRepeat(cloneMaps(asphalt({ wear: 0.2, key: 'pit' })), 1, 1));
    const laneMat = assets.material('env/pitlane', () => breakTiling(new THREE.MeshStandardMaterial({
      ...mapsToMaterial(maps), vertexColors: true, color: 0xb0b4b8,
      roughness: 1, metalness: 0, envMapIntensity: 0.5,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
    }), 0.31, 0.06, 0.3));
    const lane = new THREE.Mesh(g, laneMat);
    lane.name = 'PitSurface';
    lane.receiveShadow = true;
    group.add(lane);

    const nBoxes = 10;
    // The garage row straddles the start/finish line, so it is in shot from the
    // grid and from the pit straight.
    const boxS = (i) => sStart + 296 + i * 17;

    // Lane markings: the white pit-lane boundary and the fast-lane line.
    {
      const lineMat = assets.material('env/pitline', () => new THREE.MeshStandardMaterial({
        color: 0xeeeee8, roughness: 0.6, metalness: 0,
        polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
      }));
      const lp = [], li = [];
      let lb = 0;
      for (const lat0 of [inner - 0.35, inner - 9.0]) {
        for (let i = 0; i <= steps; i++) {
          const s = sStart + (i / steps) * laneLength;
          const sm = c.sampleAt(s);
          for (const lat of [lat0 - 0.12, lat0 + 0.12]) {
            _v.copy(sm.position).addScaledVector(sm.right, lat);
            _v.y = pitY(sm, lat) + 0.012;
            lp.push(_v.x, _v.y, _v.z);
          }
        }
        for (let i = 0; i < steps; i++) {
          const a = lb + i * 2, bb = a + 1, d = a + 2, e = a + 3;
          li.push(a, bb, d, bb, e, d);
        }
        lb += (steps + 1) * 2;
      }
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
      lg.setIndex(li);
      lg.computeVertexNormals();
      group.add(new THREE.Mesh(lg, lineMat));
    }

    /**
     * PIT BOXES.
     *
     * These were a 0.88-alpha plane of flat 0xecece6 — a solid, untextured,
     * near-white rectangle, and measured off `r3-world-grid.png` the brightest
     * thing in the entire frame. Ten sheets of paper laid on the tarmac.
     *
     * A real pit box is a *worn* painted outline, not a filled slab: two thick
     * side lines and a stop line, the box number and the team name stencilled
     * inside it, and the enclosed asphalt only lightly greyed by overspray and
     * bleached rubber. So the box is now an ALPHA-MAPPED decal — the tarmac
     * shows through the middle — with the paint itself at ~0.55 linear rather
     * than 1.0, and one atlas row per team so no two boxes are identical.
     */
    const BOX_ROWS = 10;
    const boxMat = assets.material('env/pitbox', () => {
      const tex = canvasTexture('env/pitboxTex', 512, 256 * BOX_ROWS, (ctx, w, h) => {
        const RH = h / BOX_ROWS;
        const rng = makeRng(hashSeed('pitbox'));
        for (let i = 0; i < BOX_ROWS; i++) {
          const t = TEAMS[i % TEAMS.length];
          const y0 = i * RH;
          ctx.save();
          ctx.beginPath(); ctx.rect(0, y0, w, RH); ctx.clip();
          ctx.translate(0, y0);
          // Interior: the apron itself, only faintly ghosted by overspray.
          ctx.fillStyle = 'rgba(196,198,192,0.20)';
          ctx.fillRect(w * 0.06, RH * 0.05, w * 0.88, RH * 0.90);
          // Painted outline. 0.55 linear ~ sRGB 0xc3 — worn white, not paper.
          const paint = '#c3c2ba';
          ctx.fillStyle = paint;
          const lw = w * 0.055;
          ctx.fillRect(w * 0.055, RH * 0.04, lw, RH * 0.92);           // left line
          ctx.fillRect(w * 0.89, RH * 0.04, lw, RH * 0.92);            // right line
          ctx.fillRect(w * 0.055, RH * 0.86, w * 0.89, RH * 0.10);     // stop line
          // Team band and stencilled identity, read from the garage side.
          ctx.fillStyle = t.primary;
          ctx.globalAlpha = 0.62;
          ctx.fillRect(w * 0.11, RH * 0.08, w * 0.78, RH * 0.055);
          ctx.globalAlpha = 1;
          ctx.fillStyle = 'rgba(206,206,198,0.88)';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.save();
          ctx.translate(w * 0.5, RH * 0.30);
          fitFont(ctx, t.name.toUpperCase(), w * 0.70, 800, RH * 0.115, 0.10);
          ctx.fillText(t.name.toUpperCase(), 0, 0);
          ctx.letterSpacing = '0px';
          ctx.restore();
          ctx.fillStyle = 'rgba(200,200,192,0.72)';
          ctx.font = `800 ${RH * 0.30}px ${DISPLAY}`;
          ctx.fillText(String(i + 1), w * 0.5, RH * 0.52);
          // Chew the paint: scrub marks, tyre rubber, patchy edges.
          ctx.globalCompositeOperation = 'destination-out';
          for (let k = 0; k < 260; k++) {
            ctx.globalAlpha = 0.05 + rng() * 0.45;
            ctx.beginPath();
            ctx.arc(rng() * w, rng() * RH, 2 + rng() * 13, 0, Math.PI * 2);
            ctx.fill();
          }
          ctx.globalAlpha = 1;
          ctx.globalCompositeOperation = 'source-over';
          ctx.restore();
        }
      }, { wrapS: THREE.ClampToEdgeWrapping });
      return new THREE.MeshStandardMaterial({
        // The map's OWN alpha carries the cut-out. `alphaMap` would not: three
        // reads its green channel, and the ghosted interior fill is as green as
        // the paint is, so the whole box would come back as a solid slab.
        map: tex, transparent: true, alphaTest: 0.02,
        color: 0xffffff, roughness: 0.86, metalness: 0,
        depthWrite: false, envMapIntensity: 0.4,
        polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
      });
    });
    // One atlas row per box, so the geometry cannot be instanced: 10 quads
    // merged into a single buffer instead, which is still one draw call.
    const bp = [], buv = [], bidx = [];
    for (let i = 0; i < nBoxes; i++) {
      const sm = c.sampleAt(boxS(i));
      const lat = inner - 4.8;
      const v0 = 1 - (i + 1) / BOX_ROWS, v1 = 1 - i / BOX_ROWS;
      const b = bp.length / 3;
      for (const [dS, vv] of [[-3.7, v0], [3.7, v1]]) {
        const smj = c.sampleAt(boxS(i) + dS);
        for (const [dL, uu] of [[-1.8, 0], [1.8, 1]]) {
          _v.copy(smj.position).addScaledVector(smj.right, lat + dL);
          _v.y = pitY(smj, lat + dL) + 0.02;
          bp.push(_v.x, _v.y, _v.z);
          buv.push(uu, vv);
        }
      }
      bidx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
    }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.Float32BufferAttribute(bp, 3));
    bg.setAttribute('uv', new THREE.Float32BufferAttribute(buv, 2));
    bg.setIndex(bidx);
    bg.computeVertexNormals();
    const boxes = new THREE.Mesh(bg, boxMat);
    boxes.name = 'PitBoxes';
    group.add(boxes);

    // ---------------------------------------------------------------------
    // GARAGES.
    //
    // What was here was ONE SOLID BOX per bay (16.4 x 7.2 x 14) with the
    // "interior" boxes buried inside it, so there was no opening at all: the
    // black rectangles in the `grid` frame were the shaded front face of a
    // closed extrusion. Rebuilt as a real building — a front wall with a door
    // aperture cut into it by construction (two pillars plus a lintel), side
    // and back walls, a roof slab, a set-back upper storey, and a 7.2 m deep
    // lit working bay you can see into.
    //
    // Three materials, because the pieces do different jobs: concrete shell,
    // an EMISSIVE painted interior (a garage is lit from inside; ambient alone
    // leaves the opening a void), and a dark fit-out that silhouettes against
    // it.
    // ---------------------------------------------------------------------
    const GW = 17.0, GD = 15.0, GH = 7.4;     // bay width (= bay pitch), depth, eaves
    const OW = 11.6, OH = 4.70;               // door opening
    const BD = 7.2;                           // depth of the lit working bay
    const IW = OW + 1.0;                      // interior width

    const garageGeo = assets.geometry('env/garageShell', () => {
      const k = new Kit(0.4);
      const pw = (GW - OW) / 2;
      /**
       * FACADE RELIEF IS A VALUE PROBLEM HERE, NOT A GEOMETRY ONE.
       *
       * The pillars below already stood 0.3 m proud of the wall plane, and the
       * facade still read as one flat grey slab — because on the morning `grid`
       * shot this wall faces AWAY from the sun and is lit by nothing but a
       * uniform ambient plus the flat apron-bounce term. Under perfectly
       * directionless light, geometric relief produces no shading difference at
       * all: 0.3 m of projection is worth zero contrast.
       *
       * So the relief has to be carried by ALBEDO. Real pit buildings do
       * exactly this anyway — a painted infill panel between exposed concrete
       * piers, a darker plinth, a recessed reveal. The spread below is a stop
       * and a half from plinth to pier, which is what makes the row read as
       * bays instead of as one extrusion.
       */
      // Front wall with the aperture, 0.55 thick.
      for (const sx of [-1, 1]) {
        k.box(pw, GH, 0.55, { x: sx * (OW / 2 + pw / 2), y: GH / 2, z: -0.275, colour: 0xb7bdc3 });
      }
      k.box(OW, GH - OH, 0.55, { y: OH + (GH - OH) / 2, z: -0.275, colour: 0xaeb4ba });
      // Recessed infill panel over the opening, and a string course under it.
      k.box(OW - 1.2, GH - OH - 1.05, 0.14, { y: OH + (GH - OH) / 2 + 0.10, z: -0.62, colour: 0x9298a0 });
      k.box(GW, 0.20, 0.68, { y: OH + 0.86, z: -0.24, colour: 0xd4d9de });
      // Pillar boxes standing 0.3 m PROUD of the wall plane.
      for (const sx of [-1, 1]) {
        k.box(1.15, GH, 0.34, { x: sx * (OW / 2 + 0.58), y: GH / 2, z: 0.17, colour: 0xe6eaee });
        k.box(0.85, GH, 0.30, { x: sx * (GW / 2 - 0.43), y: GH / 2, z: 0.15, colour: 0xdde2e7 });
        // Reveal into the opening — the darkest thing on the face, which is
        // what gives the aperture a visible thickness.
        k.box(0.34, OH, 0.62, { x: sx * (OW / 2 + 0.17), y: OH / 2, z: -0.31, colour: 0x8b9299 });
        k.box(0.32, GH, GD, { x: sx * (GW / 2 - 0.16), y: GH / 2, z: -GD / 2, colour: 0xd2d7dc });
      }
      // Plinth, and a shadow gap under the roof slab.
      k.box(GW, 0.62, 0.72, { y: 0.31, z: -0.20, colour: 0x8f959b });
      k.box(GW, 0.10, 0.74, { y: 0.64, z: -0.21, colour: 0x767c82 });
      k.box(GW, 0.16, 0.62, { y: GH - 0.10, z: -0.20, colour: 0x7e848a });
      k.box(GW, GH, 0.35, { y: GH / 2, z: -GD + 0.175, colour: 0xd6dae0 });
      // Rolled-up shutter: soffit box plus the drum itself.
      k.box(OW, 0.60, 0.55, { y: OH + 0.30, z: -0.34, colour: 0x2b3036 });
      k.cyl(0.27, OW - 0.3, 8, { y: OH + 0.34, z: -0.72, rz: Math.PI / 2, colour: 0x5a6067 });
      // Roof slab, gutter, signage parapet.
      k.box(GW, 0.34, GD + 0.55, { y: GH + 0.17, z: -GD / 2 + 0.27, colour: 0xccd2d8 });
      k.box(GW, 0.20, 0.32, { y: GH + 0.06, z: 0.30, colour: 0x969ca2 });
      k.box(GW, 1.58, 0.26, { y: GH + 0.79, z: 0.13, colour: 0xc4cad0 });
      // Set-back upper storey with a glazed band — pit-lane hospitality.
      const uz = -GD / 2 - 1.4, ud = GD - 4.2;
      k.box(GW, 3.00, ud, { y: GH + 1.85, z: uz, colour: 0xdadfe4 });
      k.box(GW - 1.0, 1.55, 0.22, { y: GH + 2.05, z: uz + ud / 2 + 0.10, colour: 0x39444d });
      k.box(GW, 0.30, ud + 0.6, { y: GH + 3.45, z: uz, colour: 0xc8ced4 });
      /**
       * GLAZING NEEDS MULLIONS OR IT IS A PAINTED STRIPE.
       *
       * The hospitality band above is one 1.55 m dark box the full width of the
       * bay, and ten of them in a row read as a single unbroken charcoal line
       * across the top of the building — which is a large part of why the whole
       * facade photographs as "untextured flat mid-grey boxes with dark
       * rectangular openings". A curtain wall is a frame: a head rail, a cill,
       * and a mullion every 1.4 m, all of them a stop LIGHTER than the glass so
       * the band reads as windows. 22 boxes, still one instanced draw.
       */
      const gz = uz + ud / 2 + 0.16;
      k.box(GW - 1.0, 0.16, 0.30, { y: GH + 2.82, z: gz, colour: 0xe2e6ea });   // head
      k.box(GW - 1.0, 0.20, 0.34, { y: GH + 1.26, z: gz, colour: 0xd0d5da });   // cill
      for (let i = 0; i < 12; i++) {
        const x = -(GW - 1.2) / 2 + i * ((GW - 1.2) / 11);
        k.box(0.13, 1.55, 0.30, { x, y: GH + 2.05, z: gz, colour: 0xdbe0e5 });
      }
      // A transom and a strip of reflected sky along the head of the glass, so
      // the band is not one flat value even where the mullions do not fall.
      k.box(GW - 1.2, 0.09, 0.27, { y: GH + 2.52, z: gz, colour: 0xb9c1c8 });
      k.box(GW - 1.2, 0.34, 0.26, { y: GH + 2.66, z: gz - 0.02, colour: 0x6d7d8c });
      // Balustrade on the roof terrace in front of the glazing.
      k.box(GW, 0.10, 0.10, { y: GH + 1.02, z: uz + ud / 2 + 1.5, colour: 0xc4cad0 });
      for (let i = 0; i < 8; i++) {
        k.box(0.09, 0.95, 0.09, {
          x: -GW / 2 + 0.6 + i * ((GW - 1.2) / 7), y: GH + 0.55, z: uz + ud / 2 + 1.5, colour: 0xb0b7bd,
        });
      }
      return k.build();
    });
    const concreteMaps = assets.get('env/concreteMaps', () => setRepeat(cloneMaps(concrete({ stain: 0.55 })), 1, 1));
    /**
     * APRON BOUNCE. The pit building faces the racing surface, which on the
     * morning `grid` shot means it faces AWAY from a 22-degree sun: the facade
     * gets no direct light at all and rendered at sRGB 3,14,31 — black. That is
     * not what a photograph shows, and the reason is a real light path this
     * renderer does not have. Twenty metres of sunlit concrete apron sits
     * directly in front of the wall and throws a very large second bounce onto
     * it; the IBL is a PMREM of the SKY, so it knows nothing about the sunlit
     * ground. Measured: irradiance on the wall from a 0.2-albedo apron under
     * this sun is ~0.25, giving ~0.015 of wall radiance.
     *
     * That is what this emissive term is — one number, standing in for one
     * missing bounce. Calibrated by measurement, not by feel: 0.185 puts the
     * shaded facade at sRGB 55-60 (a shaded white wall), against 3 before and
     * against 97 for the strip-lit interior behind the opening. Its linear value
     * is 0.078 — a factor of 16 under the 1.25 bloom threshold — and on the
     * sunlit faces of the same building it is invisible.
     */
    const garageMat = assets.material('env/garage', () => new THREE.MeshStandardMaterial({
      ...mapsToMaterial(concreteMaps),
      vertexColors: true, color: 0xffffff, roughness: 0.74, metalness: 0.04, envMapIntensity: 0.95,
      emissive: 0xa8a294, emissiveIntensity: 0.185,
    }));
    const garages = new THREE.InstancedMesh(garageGeo, garageMat, nBoxes);
    garages.name = 'Garages';
    garages.castShadow = garages.receiveShadow = true;

    // Interior: four painted surfaces off one 2x2 atlas.
    const interiorGeo = assets.geometry('env/garageInterior', () => {
      const k = new Kit(1);
      const zc = -(BD / 2 + 0.55);
      const H = [0.5, 0.5];
      k.box(IW, 0.16, BD, { y: 0.08, z: zc, uv: H, uvo: [0, 0] });          // floor
      k.box(IW, 0.30, BD, { y: OH + 0.15, z: zc, uv: H, uvo: [0.5, 0] });   // ceiling
      k.box(IW, OH, 0.34, { y: OH / 2, z: -(BD + 0.55), uv: H, uvo: [0, 0.5] });
      for (const sx of [-1, 1]) {
        k.box(0.30, OH, BD, { x: sx * (IW / 2 + 0.15), y: OH / 2, z: zc, uv: H, uvo: [0.5, 0.5] });
      }
      return k.build();
    });
    /**
     * INTERIOR LIGHT. There is no light source inside the bay — it is a closed
     * box standing in the building's own shadow — so every interior surface is
     * lit by this term and by nothing else.
     *
     * `emissive = albedo x fill` is the right shape (that IS irradiance times
     * albedo) but it has no floor, so anything painted dark in the sheet fell
     * straight to black: the personnel door at 0.028 albedo rendered sRGB
     * 0,3,22. A real room has bounce, which does not care how dark one surface
     * is. Adding a small constant is the whole difference, and it is cheap.
     *
     * Numbers: 0.135 direct + 0.013 bounce puts the lit back wall at sRGB ~115,
     * the door at ~48 and the shaded facade outside it at ~55 — the interior
     * reads about a stop and a half under the sunlit apron, which is what a
     * garage photographed from the pit lane does. Peak linear 0.093, thirteen
     * times under the 1.25 bloom knee.
     */
    const interiorMat = assets.material('env/garageInteriorMat', () => {
      const tex = garageInteriorTexture();
      const m = new THREE.MeshStandardMaterial({
        map: tex, emissive: 0xffffff, emissiveIntensity: 1.0,
        roughness: 0.86, metalness: 0.0, envMapIntensity: 0.5,
      });
      m.onBeforeCompile = (shader) => {
        // Warm white, not neutral: the interior is lit by 4000 K fluorescent
        // against a 5800 K sun, and a NEUTRAL fill is most of why the opening
        // read as a hole cut to the sky rather than as a room behind a wall.
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <emissivemap_fragment>', /* glsl */`
            #include <emissivemap_fragment>
            totalEmissiveRadiance = diffuseColor.rgb * vec3( 0.142, 0.135, 0.118 )
                                  + vec3( 0.0140, 0.0128, 0.0106 );`);
      };
      m.customProgramCacheKey = () => 'apex-garage-interior-fill';
      return m;
    });
    const interiors = new THREE.InstancedMesh(interiorGeo, interiorMat, nBoxes);
    interiors.name = 'GarageInteriors';
    interiors.receiveShadow = true;

    /**
     * Fit-out: what silhouettes against the lit back wall.
     *
     * This whole assembly rendered at sRGB 0,4,23 — one flat black slab sitting
     * in the middle of a pale grey opening, which is precisely the "black
     * rectangular void" the review is about, just moved 7 m back. The reason is
     * that the bay is a closed box in the sun's shadow and the scene has no
     * light inside it: the only term reaching these surfaces was a flat
     * `emissive 0x24282d`, linear 0.017.
     *
     * The fix is to make the fill proportional to each surface's own albedo
     * (below), which is what a real strip-lit room does, and to stop authoring
     * the fit-out in near-black greys — a fitted car cover is light, and it is
     * the biggest single object in the bay.
     */
    const fitGeo = assets.geometry('env/garageFitout', () => {
      const k = new Kit(0.7);
      // Overhead gantry across the bay.
      k.box(IW - 0.4, 0.16, 0.30, { y: OH - 0.55, z: -2.6, colour: 0xaeb4ba });
      k.box(IW - 0.4, 0.16, 0.30, { y: OH - 0.55, z: -5.2, colour: 0xaeb4ba });
      for (const sx of [-1, 1]) k.box(0.16, 0.9, 0.16, { x: sx * (IW / 2 - 0.6), y: OH - 1.0, z: -3.9, colour: 0x9ba1a7 });
      // Strip lights: the only genuinely bright thing in the room, and what
      // makes the ceiling read as a ceiling rather than as the top of a box.
      // 0.62 albedo x 2.4 fill = 0.55 linear, still under the 1.25 bloom knee.
      for (const z of [-1.9, -4.4, -6.9]) k.box(IW - 2.2, 0.10, 0.26, { y: OH - 0.16, z, colour: 0xffffff, mask: 1 });
      // Workbench along the back, with a leg frame.
      k.box(IW - 2.6, 0.10, 0.70, { y: 0.92, z: -BD - 0.05, colour: 0xc2c8ce });
      for (const sx of [-1, 0, 1]) k.box(0.10, 0.90, 0.10, { x: sx * (IW / 2 - 1.7), y: 0.45, z: -BD + 0.15, colour: 0x8f959b });
      // Two tall tool cabinets and a parts trolley.
      k.box(1.05, 1.55, 0.62, { x: -IW / 2 + 0.9, y: 0.78, z: -5.9, colour: 0x5b626a });
      k.box(1.05, 1.55, 0.62, { x: IW / 2 - 0.9, y: 0.78, z: -5.9, colour: 0x5b626a });
      k.box(0.85, 0.95, 0.55, { x: IW / 2 - 1.1, y: 0.48, z: -2.3, colour: 0x6e757c });
      // A tyre bank against the side wall — five stacks of four.
      for (let t = 0; t < 5; t++) {
        for (let u = 0; u < 4; u++) {
          k.cyl(0.35, 0.25, 10, { x: -IW / 2 + 0.55, y: 0.14 + u * 0.26, z: -2.2 - t * 0.78, colour: 0x4b4d50 });
        }
      }
      // A car under a fitted cover, nose out. Light, because a cover is light.
      k.box(1.75, 0.42, 4.4, { y: 0.34, z: -4.2, colour: 0xbcc2c8 });
      k.box(1.05, 0.36, 2.2, { y: 0.68, z: -4.0, colour: 0xc8ced4 });
      k.box(1.55, 0.14, 0.7, { y: 0.24, z: -1.9, colour: 0xa8aeb4 });
      k.box(1.78, 0.09, 0.55, { y: 0.50, z: -4.2, colour: 0x8a9098 });   // seam over the sidepod
      for (const sx of [-1, 1]) {
        for (const z of [-2.9, -5.5]) k.cyl(0.34, 0.34, 8, { x: sx * 0.78, y: 0.34, z, rz: Math.PI / 2, colour: 0x35383c });
      }
      return k.build();
    });
    /**
     * INTERIOR FILL. `emissive` in three is a flat per-material constant, which
     * is why the previous attempt at this had to be set so low that it did
     * nothing: one value has to serve both a white car cover and a black tyre,
     * and anything that lifts the tyre off black blows the cover out. Multiply
     * it by the surface's own albedo instead and it behaves like a room light —
     * the cover comes up to sRGB ~120, the tyres stay at ~35, and the strip
     * lights (`aMask`, 2.4x) are the brightest thing in the bay by a factor of
     * four. That ratio is the whole difference between "a lit room" and "a grey
     * box".
     */
    const fitMat = assets.material('env/garageFitout', () => {
      const m = new THREE.MeshStandardMaterial({
        color: 0xf2f4f6, vertexColors: true, roughness: 0.8, metalness: 0.15,
        emissive: 0xffffff, emissiveIntensity: 1.0, envMapIntensity: 0.4,
      });
      m.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nattribute float aMask;\nvarying float vApexLamp;')
          .replace('#include <color_vertex>', '#include <color_vertex>\nvApexLamp = aMask;');
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying float vApexLamp;')
          // Same fill and bounce constants as the interior shell, so the
          // fit-out sits in the same room rather than in its own exposure.
          .replace('#include <emissivemap_fragment>', /* glsl */`
            #include <emissivemap_fragment>
            totalEmissiveRadiance = diffuseColor.rgb * vec3( 0.142, 0.135, 0.118 )
                                  * ( 1.0 + 3.0 * vApexLamp )
                                  + vec3( 0.0140, 0.0128, 0.0106 );`);
      };
      m.customProgramCacheKey = () => 'apex-garage-fitout-fill';
      return m;
    });
    const fitouts = new THREE.InstancedMesh(fitGeo, fitMat, nBoxes);
    fitouts.name = 'GarageFitout';
    fitouts.receiveShadow = true;

    // Fascia signage: one merged strip, one atlas row per bay, so each bay
    // carries its team's wordmark instead of a pastel swatch.
    const signMat = assets.material('env/garageSign', () => new THREE.MeshStandardMaterial({
      map: garageSignTexture(), roughness: 0.46, metalness: 0.03, envMapIntensity: 0.9,
      side: THREE.FrontSide,
    }));
    const sp = [], suv = [], sidx = [];

    for (let i = 0; i < nBoxes; i++) {
      const sm = c.sampleAt(boxS(i));
      const lat = outer - 0.6;
      _v.copy(sm.position).addScaledVector(sm.right, lat);
      _v.y = pitY(sm, lat);
      this._alongTrack(sm, _q);
      _m.compose(_v, _q, _one);
      garages.setMatrixAt(i, _m);
      interiors.setMatrixAt(i, _m);
      fitouts.setMatrixAt(i, _m);

      // Fascia quad on the parapet face.
      const b = sp.length / 3;
      const v0 = 1 - (i + 1) / GARAGE_SIGN_ROWS, v1 = 1 - i / GARAGE_SIGN_ROWS;
      const yb = _v.y + GH + 0.20, yt = _v.y + GH + 1.46;
      for (const [ex, u] of [[-GW / 2, 0], [GW / 2, 1]]) {
        _v2.copy(_v).addScaledVector(sm.tangent, ex).addScaledVector(sm.right, 0.28);
        sp.push(_v2.x, yb, _v2.z, _v2.x, yt, _v2.z);
        suv.push(u, v0, u, v1);
      }
      sidx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);

      // People. Three mechanics in the bay, five crew around the pit box, two
      // by the equipment on the apron — 100 figures over the row.
      const team = TEAMS[i % TEAMS.length];
      const kit = _col.set(team.secondary).getHex();
      const rngG = makeRng(hashSeed(`garage-${i}`));
      const place = (dS, dLat, pose, fill = 0) => {
        const smj = c.sampleAt(boxS(i) + dS);
        _v3.copy(smj.position).addScaledVector(smj.right, dLat);
        // Inside the bay the floor slab stands 0.16 m over the apron; a figure
        // pinned to apron height is buried to the ankle in it.
        _v3.y = pitY(smj, dLat) + (fill > 0 ? 0.18 : 0.02);
        this._person(_v3, this._faceTrack(smj, -1, new THREE.Quaternion()),
          rngG() < 0.30 ? kit : _col.set(team.primary).getHex(), pose, (rngG() - 0.5) * 2.4, 1, fill);
      };
      /**
       * EVERY BOX WAS THE SAME BOX. The old block placed five crew at five fixed
       * offsets with five fixed poses, twenty times down the lane — which is
       * literally the review's "two silhouettes copy-pasted across the whole pit
       * lane, all facing the same way". Poses are now drawn from a weighted bag
       * per figure, the offsets carry a metre of scatter, and the headcount
       * itself varies, so no two boxes silhouette alike.
       */
      const BAG = [1, 1, 5, 5, 0, 4, 6, 7, 8, 3];
      const pick = () => BAG[Math.floor(rngG() * BAG.length)];
      // Crew inside the bay carry the strip-light fill (see `aFill`).
      for (let j = 0; j < 3; j++) {
        place((j - 1) * 3.4 + (rngG() - 0.5) * 2, outer - 3.0 - rngG() * 3.4,
          [0, 4, 6, 8, 3][Math.floor(rngG() * 5)], 0.19);
      }
      // Gun/wheel crew around the box: two axles, a jack man, plus loose bodies.
      for (const dS of [-2.6, 2.6, -2.6, 2.6]) {
        place(dS + (rngG() - 0.5) * 1.5,
          (rngG() < 0.5 ? inner - 3.2 : inner - 6.6) + (rngG() - 0.5) * 1.4, pick());
      }
      place(0.4 + (rngG() - 0.5) * 1.6, inner - 8.6 + (rngG() - 0.5) * 1.2, rngG() < 0.55 ? 2 : 7);
      place(-7.0 + (rngG() - 0.5) * 2.4, outer + 4.2 + (rngG() - 0.5) * 2.0, pick());
      place(7.4 + (rngG() - 0.5) * 2.4, outer + 5.4 + (rngG() - 0.5) * 2.0, pick());
      if (rngG() < 0.6) place((rngG() - 0.5) * 12, outer + 2.0 + rngG() * 3.0, pick());
    }
    garages.instanceMatrix.needsUpdate = true;
    interiors.instanceMatrix.needsUpdate = true;
    fitouts.instanceMatrix.needsUpdate = true;
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
    sg.setAttribute('uv', new THREE.Float32BufferAttribute(suv, 2));
    sg.setIndex(sidx);
    sg.computeVertexNormals();
    const signs = new THREE.Mesh(sg, signMat);
    signs.name = 'GarageSigns';
    group.add(garages, interiors, fitouts, signs);

    // Pit wall + its hoarding facing the track.
    const wallGeo = assets.geometry('env/pitwall', () => new Kit(0.5)
      .box(6.1, 1.06, 0.44, { y: 0.53, colour: 0xe4e7ea })
      .box(6.1, 0.13, 0.54, { y: 1.11, colour: 0xbfc4c9 })
      .build());
    const wallMat = assets.material('env/pitwall', () => new THREE.MeshStandardMaterial({
      ...mapsToMaterial(concreteMaps),
      vertexColors: true, color: 0xffffff, roughness: 0.8, metalness: 0, envMapIntensity: 0.8,
    }));
    const wallCount = Math.floor(laneLength / 6.1);
    const wall = new THREE.InstancedMesh(wallGeo, wallMat, wallCount);
    // The pit-wall boards are one merged strip rather than an instanced quad:
    // an instanced quad can only ever show the WHOLE texture, so every segment
    // wore all eight sponsors squeezed into 6.1 m. Merged, each 6.1 m segment
    // gets its own panel of the 6.42:1 atlas at exactly 1:1 scale.
    const PW_PANELS = 8;
    const pwAdMat = boardMaterial('env/pitwallAd', 'env/boardPitwall',
      { panels: PW_PANELS, aspect: 6.1 / 0.95, seed: 41, height: 176 });
    const apos = [], auv = [], aidx = [];
    wall.castShadow = wall.receiveShadow = true;
    for (let i = 0; i < wallCount; i++) {
      const sm = c.sampleAt(sStart + i * 6.1);
      const lat = -(hw + 1.6);
      _v.copy(sm.position).addScaledVector(sm.right, lat);
      _v.y = this._edgeY(sm, lat);
      this._alongTrack(sm, _q);
      _m.compose(_v, _q, _one);
      wall.setMatrixAt(i, _m);

      const smB = c.sampleAt(sStart + (i + 1) * 6.1);
      const u0 = (i % PW_PANELS) / PW_PANELS, u1 = u0 + 1 / PW_PANELS;
      const b = apos.length / 3;
      for (const [smj, u] of [[sm, u0], [smB, u1]]) {
        _v2.copy(smj.position).addScaledVector(smj.right, lat + 0.24);
        const y = this._edgeY(smj, lat);
        apos.push(_v2.x, y + 0.08, _v2.z, _v2.x, y + 1.03, _v2.z);
        auv.push(u, 0, u, 1);
      }
      // Normal must face the racing surface (+right); winding follows.
      aidx.push(b, b + 2, b + 1, b + 1, b + 2, b + 3);
    }
    wall.instanceMatrix.needsUpdate = true;
    const pwG = new THREE.BufferGeometry();
    pwG.setAttribute('position', new THREE.Float32BufferAttribute(apos, 3));
    pwG.setAttribute('uv', new THREE.Float32BufferAttribute(auv, 2));
    pwG.setIndex(aidx);
    pwG.computeVertexNormals();
    group.add(wall, new THREE.Mesh(pwG, pwAdMat));

    // Equipment on the garage apron.
    const stackGeo = assets.geometry('env/pitstack', () => {
      const k = new Kit(0.8);
      for (let i = 0; i < 5; i++) k.cyl(0.34, 0.24, 10, { y: 0.13 + i * 0.25, colour: 0x1e1e20 });
      return k.build();
    });
    // The trolleys were "white cubes with a lid". A real pit trolley has a
    // wheeled base, a drawer stack, a handle, a lid and a team colour band.
    const trolleyGeo = assets.geometry('env/trolley', () => {
      const k = new Kit(0.8);
      k.box(1.52, 0.60, 0.66, { y: 0.52, colour: 0xc9ced3 });
      // Drawer fronts: four dark reveals, so it is not one flat face.
      for (let d = 0; d < 4; d++) k.box(1.42, 0.025, 0.70, { y: 0.26 + d * 0.135, colour: 0x5c6268 });
      k.box(1.56, 0.09, 0.72, { y: 0.87, colour: 0x9aa0a6 });          // worktop
      k.box(1.30, 0.05, 0.54, { y: 0.925, colour: 0x3f454b });         // rubber mat
      k.box(1.44, 0.11, 0.10, { y: 0.795, z: -0.34, colour: 0xd8b23a });  // team band
      k.box(0.075, 0.46, 0.075, { x: -0.72, y: 1.10, colour: 0x8d9298 });  // handle stanchions
      k.box(0.075, 0.46, 0.075, { x: 0.72, y: 1.10, colour: 0x8d9298 });
      k.box(1.58, 0.065, 0.065, { y: 1.32, colour: 0xa8adb2 });        // handle bar
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          k.cyl(0.085, 0.055, 8, { x: sx * 0.60, y: 0.10, z: sz * 0.24, rz: Math.PI / 2, colour: 0x1c1e21 });
        }
      }
      return k.build();
    });
    const kitMat = assets.material('env/pitkit', () => new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.88, metalness: 0.05, envMapIntensity: 0.65,
    }));
    // Tyre blankets: `aMask` marks the blanket band, `aBlanket` is the compound
    // colour for that set — the same split the TecPro run uses, and for the same
    // reason (instanceColor would dye the carcass and the rack too).
    const blanketMat = assets.material('env/pitblanket', () => {
      const m = new THREE.MeshStandardMaterial({
        color: 0xffffff, vertexColors: true, roughness: 0.85, metalness: 0.02, envMapIntensity: 0.6,
      });
      m.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nattribute vec3 aBlanket;\nattribute float aMask;')
          .replace('#include <color_vertex>',
            '#include <color_vertex>\nvColor.xyz *= mix( vec3( 1.0 ), aBlanket, aMask );');
      };
      m.customProgramCacheKey = () => 'apex-pit-blanket';
      return m;
    });

    /**
     * PIT-BOX FURNITURE. The review: "no equipment, no tyre sets, no wheel guns"
     * — the boxes were painted markings on bare tarmac. A box that is about to
     * take a car has the four sets stood on end behind it in their blankets, a
     * gun laid at each corner and the jack trolley on the garage side.
     */
    const blanketGeo = assets.geometry('env/tyreblanket', () => {
      const k = new Kit(0.8);
      // Four tyres on end, leant against each other, in coloured blankets.
      for (let i = 0; i < 4; i++) {
        k.cyl(0.36, 0.30, 12, {
          x: (i - 1.5) * 0.34, y: 0.37, z: 0.02 * i,
          rx: Math.PI / 2, rz: 0.05 * (i % 2 ? 1 : -1),
          colour: i % 2 ? 0x2b2d31 : 0x232529,
        });
        k.cyl(0.365, 0.10, 12, {
          x: (i - 1.5) * 0.34, y: 0.37, z: 0.02 * i,
          rx: Math.PI / 2, rz: 0.05 * (i % 2 ? 1 : -1),
          colour: 0xd8dbdf, mask: 1,
        });
      }
      k.box(1.62, 0.07, 0.42, { y: 0.045, colour: 0x8d9298 });      // the rack
      return k.build();
    });
    const gunGeo = assets.geometry('env/wheelgun', () => new Kit(0.8)
      .box(0.16, 0.17, 0.42, { y: 0.10, colour: 0xcf4a1e })
      .cyl(0.045, 0.30, 8, { y: 0.10, z: 0.32, rx: Math.PI / 2, colour: 0x6e747a })
      .box(0.09, 0.10, 0.10, { y: 0.05, z: -0.24, colour: 0x2a2d31 })
      .cyl(0.02, 1.10, 6, { y: 0.02, z: -0.80, rx: Math.PI / 2, colour: 0x1c1e21 })
      .build());

    const stackM = [], trolleyM = [], blanketM = [], gunM = [];
    const rng = this.rng;
    for (let i = 0; i < nBoxes; i++) {
      const s = boxS(i);
      // Tyre sets stood behind the box, guns laid at the wheel positions.
      for (let j = 0; j < 3; j++) {
        const smj = c.sampleAt(s + (j - 1) * 2.3 + (rng() - 0.5) * 0.5);
        const lat = inner - 7.7 - rng() * 0.5;
        _v.copy(smj.position).addScaledVector(smj.right, lat);
        _v.y = pitY(smj, lat) + 0.02;
        this._alongTrack(smj, _q);
        _q.multiply(_qb.setFromAxisAngle(UP, (rng() - 0.5) * 0.26));
        _m.compose(_v, _q, _one);
        blanketM.push(_m.clone());
      }
      for (const [dS, dL] of [[-1.7, -1.5], [-1.7, 1.5], [1.9, -1.5], [1.9, 1.5]]) {
        const smj = c.sampleAt(s + dS + (rng() - 0.5) * 0.6);
        const lat = inner - 4.8 + dL + (rng() - 0.5) * 0.5;
        _v.copy(smj.position).addScaledVector(smj.right, lat);
        _v.y = pitY(smj, lat) + 0.02;
        this._alongTrack(smj, _q);
        _q.multiply(_qb.setFromAxisAngle(UP, (rng() - 0.5) * 1.9));
        _m.compose(_v, _q, _one);
        gunM.push(_m.clone());
      }
      for (let j = 0; j < 6; j++) {
        // Four sets on the apron, two more inside the bay behind the car.
        const inBay = j >= 4;
        const smj = c.sampleAt(s + (inBay ? (j === 4 ? -5.6 : 5.6) : (j < 2 ? -5.2 : 5.2)));
        const lat = inBay ? outer - 6.4 : outer + 3.4 + (j % 2) * 1.05;
        _v.copy(smj.position).addScaledVector(smj.right, lat);
        _v.y = pitY(smj, lat) + 0.02;
        this._alongTrack(smj, _q);
        _m.compose(_v, _q, _one);
        stackM.push(_m.clone());
      }
      for (let j = 0; j < 2; j++) {
        const smj = c.sampleAt(s + (j ? 7.2 : -7.2));
        const lat = outer + 6.0;
        _v.copy(smj.position).addScaledVector(smj.right, lat);
        _v.y = pitY(smj, lat) + 0.02;
        this._alongTrack(smj, _q);
        _q.multiply(_qb.setFromAxisAngle(UP, (rng() - 0.5) * 0.5));
        _m.compose(_v, _q, _one);
        trolleyM.push(_m.clone());
      }
    }
    const stacks = new THREE.InstancedMesh(stackGeo, kitMat, stackM.length);
    stacks.castShadow = stacks.receiveShadow = true;
    stackM.forEach((m, i) => stacks.setMatrixAt(i, m));
    stacks.instanceMatrix.needsUpdate = true;
    const trolleys = new THREE.InstancedMesh(trolleyGeo, kitMat, trolleyM.length);
    trolleys.castShadow = trolleys.receiveShadow = true;
    trolleyM.forEach((m, i) => trolleys.setMatrixAt(i, m));
    trolleys.instanceMatrix.needsUpdate = true;
    group.add(stacks, trolleys);
    // Blanket colour is per SET, so a box reads as four sets of one compound.
    const blankets = new THREE.InstancedMesh(blanketGeo, blanketMat, blanketM.length);
    blankets.castShadow = blankets.receiveShadow = true;
    const bc = new Float32Array(blanketM.length * 3);
    const bRng = makeRng(hashSeed('pit-blankets'));
    const COMPOUND = [0xc0392b, 0xd8c33a, 0xdadde0];
    blanketM.forEach((m, i) => {
      blankets.setMatrixAt(i, m);
      _col.setHex(COMPOUND[Math.floor(bRng() * COMPOUND.length)], THREE.SRGBColorSpace);
      bc[i * 3] = _col.r; bc[i * 3 + 1] = _col.g; bc[i * 3 + 2] = _col.b;
    });
    blankets.instanceMatrix.needsUpdate = true;
    blankets.geometry.setAttribute('aBlanket', new THREE.InstancedBufferAttribute(bc, 3));
    const guns = new THREE.InstancedMesh(gunGeo, kitMat, gunM.length);
    guns.castShadow = guns.receiveShadow = true;
    gunM.forEach((m, i) => guns.setMatrixAt(i, m));
    guns.instanceMatrix.needsUpdate = true;
    group.add(blankets, guns);
    return group;
  }

  // -- gantries, lights and signage -----------------------------------------

  _buildGantries() {
    const c = this.circuit;
    const group = new THREE.Group();
    group.name = 'Gantries';
    const span = c.halfWidth * 2 + 22;

    const gantryGeo = assets.geometry('env/gantry', () => {
      const k = new Kit(0.35);
      const legH = 9.8;
      for (const dy of [-0.55, 0.55]) {
        for (const dz of [-0.5, 0.5]) k.box(span, 0.20, 0.20, { y: legH + dy, z: dz });
      }
      const bays = 22;
      for (let i = 0; i <= bays; i++) {
        const x = -span / 2 + (i * span) / bays;
        k.box(0.13, 1.35, 0.13, { x, y: legH, z: -0.5, rz: 0.55 * (i % 2 ? 1 : -1) });
        k.box(0.13, 1.35, 0.13, { x, y: legH, z: 0.5, rz: 0.55 * (i % 2 ? -1 : 1) });
        if (i % 2 === 0) k.box(0.13, 0.13, 1.2, { x, y: legH + 0.55 });
      }
      for (const side of [-1, 1]) {
        const lx = side * (span / 2 - 0.6);
        for (const dz of [-0.55, 0.55]) {
          k.box(0.26, legH, 0.26, { x: lx, y: legH / 2, z: dz });
          k.box(0.26, legH, 0.26, { x: lx - side * 1.15, y: legH / 2, z: dz });
        }
        for (let i = 0; i < 7; i++) {
          k.box(1.55, 0.12, 0.12, { x: lx - side * 0.58, y: 0.9 + i * 1.35, z: -0.55 });
          k.box(1.55, 0.12, 0.12, { x: lx - side * 0.58, y: 0.9 + i * 1.35, z: 0.55 });
          k.box(0.12, 1.75, 0.12, { x: lx - side * 0.58, y: 1.5 + i * 1.35, z: -0.55, rz: 0.7 * (i % 2 ? 1 : -1) });
        }
        k.box(2.0, 0.4, 1.7, { x: lx - side * 0.58, y: 0.2, colour: 0xd0d4d8 });
      }
      return k.build();
    });
    const gantryMat = assets.material('env/gantryMat', () => new THREE.MeshStandardMaterial({
      ...mapsToMaterial(assets.get('env/railMaps', () => setRepeat(cloneMaps(brushedMetal({ roughBase: 0.45 })), 1, 1))),
      vertexColors: true, color: 0xd2d6da, roughness: 0.8, metalness: 0.85, envMapIntensity: 1.2,
    }));
    const bannerW = span - 5, bannerH = 2.1;
    const bannerMat = boardMaterial('env/gantryBanner', 'env/boardGantry',
      { panels: 8, aspect: (bannerW / 8) / bannerH, seed: 88, height: 176 },
      { roughness: 0.5, side: THREE.DoubleSide, envMapIntensity: 0.9 });
    const bannerGeo = new THREE.PlaneGeometry(bannerW, bannerH);

    const place = (s) => {
      const sm = c.sampleAt(s);
      // Face the oncoming cars: X = right, Z = -tangent (right-handed).
      const q = new THREE.Quaternion().setFromRotationMatrix(_m2.makeBasis(
        _fa.copy(sm.right), UP, _fb.copy(sm.tangent).negate()
      ));
      const base = sm.position.clone();
      base.y = this._edgeY(sm, 0) - 0.06;
      const m = new THREE.Mesh(gantryGeo, gantryMat);
      m.position.copy(base);
      m.quaternion.copy(q);
      m.castShadow = true;
      group.add(m);
      const b = new THREE.Mesh(bannerGeo, bannerMat);
      b.position.copy(base).addScaledVector(UP, 11.3);
      b.quaternion.copy(q);
      group.add(b);
      return { sm, q, base };
    };

    const sf = place(0);
    for (const z of c.drsZones) place(z.startS);

    const barGeo = assets.geometry('env/lightbar', () => new Kit(0.5)
      .box(9.6, 1.8, 0.36, { colour: 0x0a0b0d })
      .box(10.0, 0.16, 0.5, { y: 0.98, colour: 0x2a2d31 })
      .box(10.0, 0.16, 0.5, { y: -0.98, colour: 0x2a2d31 })
      .build());
    const barMat = assets.material('env/lightbarMat', () => new THREE.MeshStandardMaterial({
      color: 0xffffff, vertexColors: true, roughness: 0.4, metalness: 0.2, envMapIntensity: 0.8,
    }));
    const bar = new THREE.Mesh(barGeo, barMat);
    bar.position.copy(sf.base).addScaledVector(UP, 8.2);
    bar.quaternion.copy(sf.q);
    group.add(bar);

    const lightGeo = new THREE.SphereGeometry(0.26, 12, 8);
    // A LIT LAMP IS AN EMISSIVE LAMP, AND `instanceColor` DOES NOT REACH IT.
    //
    // three folds `instanceColor` into `vColor`, and `vColor` only multiplies
    // `diffuseColor` — `totalEmissiveRadiance` never sees it. So `setStartLights`
    // was dimming the plastic of the lens while all ten lamps kept glowing
    // 0xff2000 at intensity 3 regardless: the gantry could not be switched off,
    // and `race.js` driving the five-red-lights sequence had no visible effect at
    // all. Patch the emissive by the same per-instance colour and the whole
    // sequence — five on, then all out at the green — works as documented.
    const lightMat = assets.material('env/startlight', () => {
      const m = new THREE.MeshStandardMaterial({
        // NO `vertexColors`. The lens is a plain SphereGeometry with no `color`
        // attribute, so `vertexColors: true` defines USE_COLOR, three emits
        // `vColor *= color`, the missing attribute reads as zero and vColor
        // collapses to black. `instanceColor` alone defines USE_INSTANCING_COLOR,
        // which declares the same varying and is the channel `setStartLights`
        // actually writes — asking for both is what put ten dead lamps on the
        // gantry the moment the emissive started respecting vColor.
        color: 0xffffff, roughness: 0.25, metalness: 0.1,
        emissive: new THREE.Color(0xff1a06), emissiveIntensity: 3.6,
      });
      m.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <emissivemap_fragment>',
          // `.rgb` because three declares vColor as a vec4 whenever the alpha
          // variant is in play; the swizzle is valid on a vec3 too.
          '#include <emissivemap_fragment>\n\t#ifdef USE_COLOR\n\ttotalEmissiveRadiance *= vColor.rgb;\n\t#endif',
        );
      };
      m.customProgramCacheKey = () => 'apex-startlight-emissive';
      return m;
    });
    const lights = new THREE.InstancedMesh(lightGeo, lightMat, 10);
    lights.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(30), 3);
    for (let i = 0; i < 10; i++) {
      _v.copy(sf.base)
        .addScaledVector(sf.sm.right, ((i % 5) - 2) * 1.8)
        .addScaledVector(UP, 8.2 + (i < 5 ? 0.44 : -0.44));
      _m.compose(_v, sf.q, _one);
      lights.setMatrixAt(i, _m);
    }
    lights.instanceMatrix.needsUpdate = true;
    group.add(lights);
    this.startLights = lights;
    this.setStartLights(2);
    return group;
  }

  /** Light the first `n` columns of the start gantry (0..5; 0 = all out). */
  setStartLights(n) {
    const inst = this.startLights;
    if (!inst || !inst.instanceColor) return;
    for (let i = 0; i < 10; i++) {
      const on = (i % 5) < n;
      // Multiplies BOTH the lens albedo and (via the shader patch above) the
      // emissive, so an unlit lamp is dark red plastic and a lit one is a lamp.
      _col.setRGB(on ? 1 : 0.055, on ? 0.09 : 0.014, on ? 0.05 : 0.014);
      inst.setColorAt(i, _col);
    }
    inst.instanceColor.needsUpdate = true;
  }

  _buildSignage() {
    const c = this.circuit;
    const group = new THREE.Group();
    group.name = 'Signage';
    const n = c.samples.length;

    const drsDetect = signTexture('env/signDrsDetect', (ctx, w, h) => {
      ctx.fillStyle = '#0b1626'; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#5f7fb0'; ctx.lineWidth = 8; ctx.strokeRect(6, 6, w - 12, h - 12);
      ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '900 118px Helvetica, Arial, sans-serif';
      ctx.fillText('DRS', w / 2, h * 0.38);
      ctx.font = '700 50px Helvetica, Arial, sans-serif';
      ctx.fillStyle = '#9fc4ff';
      ctx.fillText('DETECTION', w / 2, h * 0.76);
    });
    const drsStart = signTexture('env/signDrsStart', (ctx, w, h) => {
      ctx.fillStyle = '#06331c'; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#3fd07a'; ctx.lineWidth = 8; ctx.strokeRect(6, 6, w - 12, h - 12);
      ctx.fillStyle = '#ffffff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '900 128px Helvetica, Arial, sans-serif';
      ctx.fillText('DRS', w / 2, h * 0.40);
      ctx.font = '700 54px Helvetica, Arial, sans-serif';
      ctx.fillStyle = '#8dffbc';
      ctx.fillText('ZONE', w / 2, h * 0.77);
    });
    const distBoards = [50, 100, 150, 200].map((d) => signTexture(`env/signD${d}`, (ctx, w, h) => {
      ctx.fillStyle = '#f2f2ee'; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#20242a'; ctx.lineWidth = 10; ctx.strokeRect(8, 8, w - 16, h - 16);
      ctx.fillStyle = '#15181c'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.font = '900 160px Helvetica, Arial, sans-serif';
      ctx.fillText(String(d), w / 2, h / 2 + 8);
    }));

    // Collect placements per sign face, then one InstancedMesh per face.
    const groups = new Map();
    const posts = [];
    const add = (tex, key, s, side, wide) => {
      const i = c.sampleIndex(s);
      const sm = c.samples[i];
      if (this.corr.skip[this._ci(i, side)]) return;
      const lat = side * Math.min(this.corr.barrier[this._ci(i, side)] - 1.2, c.halfWidth + 11);
      _v.copy(sm.position).addScaledVector(sm.right, lat);
      _v.y = this._vergeY(i, side, lat);
      const q = this._faceTrack(sm, side, new THREE.Quaternion());
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { tex, wide, list: [] }));
      g.list.push({ p: _v.clone(), q });
      posts.push({ p: _v.clone(), q });
    };

    for (const z of c.drsZones) {
      for (const side of [-1, 1]) {
        add(drsDetect, 'drsDetect', z.detectS, side, true);
        add(drsStart, 'drsStart', z.startS, side, true);
      }
    }
    // Braking boards, ONE set per braking zone.
    //
    // The old test fired on every sample that satisfied it, and a corner entry
    // satisfies it for ten or twenty consecutive samples — so each corner got
    // ten or twenty overlapping sets of 50/100/150/200 boards on their white
    // posts, two metres apart. That, not the debris fence, was the white picket
    // fence running the length of the circuit. A braking zone is one EVENT:
    // find its first sample and then refuse to fire again for 200 m.
    let lastBoardI = -1e9;
    for (let i = 0; i < n; i++) {
      const k = Math.abs(c.samples[i].curvature);
      const prev = Math.abs(c.samples[(i - 26 + n) % n].curvature);
      if (k <= 0.0075 || prev >= 0.0018) continue;
      if ((i - lastBoardI) * c.step < 240) continue;
      lastBoardI = i;
      const side = c.samples[i].curvature > 0 ? -1 : 1;
      distBoards.forEach((tex, bi) => add(tex, `d${bi}`, c.wrapS(i * c.step - (50 + bi * 50)), side, false));
    }

    for (const [key, g] of groups) {
      const geo = new THREE.PlaneGeometry(g.wide ? 2.8 : 1.5, g.wide ? 1.4 : 1.5);
      geo.translate(0, g.wide ? 2.3 : 2.0, 0);
      const mat = assets.material(`env/sign-${key}`, () => new THREE.MeshStandardMaterial({
        map: g.tex, roughness: 0.42, metalness: 0.05, side: THREE.DoubleSide, envMapIntensity: 0.9,
      }));
      const inst = new THREE.InstancedMesh(geo, mat, g.list.length);
      g.list.forEach((o, i) => { _m.compose(o.p, o.q, _one); inst.setMatrixAt(i, _m); });
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = true;
      group.add(inst);
    }

    if (posts.length) {
      const postGeo = assets.geometry('env/signpost', () => new Kit(0.6)
        .box(0.10, 2.5, 0.10, { x: -0.55, y: 1.25, colour: 0x8d9298 })
        .box(0.10, 2.5, 0.10, { x: 0.55, y: 1.25, colour: 0x8d9298 })
        .box(0.30, 0.14, 0.30, { x: -0.55, y: 0.07, colour: 0x7d8288 })
        .box(0.30, 0.14, 0.30, { x: 0.55, y: 0.07, colour: 0x7d8288 })
        .build());
      const postMat = assets.material('env/signpost', () => new THREE.MeshStandardMaterial({
        color: 0x5f656b, vertexColors: true, roughness: 0.62, metalness: 0.7, envMapIntensity: 0.5,
      }));
      const inst = new THREE.InstancedMesh(postGeo, postMat, posts.length);
      posts.forEach((o, i) => { _m.compose(o.p, o.q, _one); inst.setMatrixAt(i, _m); });
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = true;
      group.add(inst);
    }
    return group;
  }

  // -- marshals, towers, floodlights ----------------------------------------

  _buildMarshalPosts() {
    const c = this.circuit;
    const group = new THREE.Group();
    group.name = 'MarshalPosts';

    /**
     * MARSHAL POST. This is 3.4 m from the barrier and reads at every camera,
     * and it was a flat dark box with a single-quad roof whose two triangles
     * showed as a value split with a blown highlight. Now: concrete hut with a
     * glazed observation aperture and a frame, a door with a handle, a
     * two-span corrugated roof with a ridge (so no one facet can own the
     * highlight), a fascia, a downpipe, a post-number plate, an extinguisher
     * pair and the flag mast.
     */
    const postGeo = assets.geometry('env/marshal', () => {
      const k = new Kit(0.5);
      const W = 3.4, D = 2.6, H = 2.42;
      // Shell: four walls, so the aperture is a real hole rather than a decal.
      k.box(W, H, 0.22, { y: H / 2, z: -D + 0.11, colour: 0xdfe2e5 });        // back
      for (const sx of [-1, 1]) k.box(0.22, H, D, { x: sx * (W / 2 - 0.11), y: H / 2, z: -D / 2, colour: 0xd8dbde });
      // Front wall: sill below the aperture, header above, plus jambs.
      k.box(W, 1.02, 0.22, { y: 0.51, z: -0.11, colour: 0xe4e7ea });
      k.box(W, 0.50, 0.22, { y: H - 0.25, z: -0.11, colour: 0xe4e7ea });
      k.box(0.66, 0.90, 0.22, { x: -W / 2 + 0.33, y: 1.47, z: -0.11, colour: 0xe0e3e6 });
      // Glazing in the aperture, recessed, with a frame.
      k.box(1.94, 0.90, 0.06, { x: 0.38, y: 1.47, z: -0.20, colour: 0x2c3238 });
      k.box(1.98, 0.06, 0.10, { x: 0.38, y: 1.02, z: -0.16, colour: 0xb4b9be });
      k.box(1.98, 0.06, 0.10, { x: 0.38, y: 1.92, z: -0.16, colour: 0xb4b9be });
      k.box(0.06, 0.90, 0.10, { x: 1.36, y: 1.47, z: -0.16, colour: 0xb4b9be });
      // Door in the left third.
      k.box(0.76, 1.94, 0.07, { x: -W / 2 + 0.55, y: 0.97, z: -0.02, colour: 0x4e565e });
      k.box(0.10, 0.05, 0.05, { x: -W / 2 + 0.22, y: 1.00, z: 0.04, colour: 0xc0c5ca });
      // Two-span corrugated roof with a ridge purlin.
      for (const sx of [-1, 1]) {
        k.box(W / 2 + 0.10, 0.10, D + 0.60, {
          x: sx * (W / 4 + 0.05), y: H + 0.30, z: -D / 2 + 0.05,
          rz: sx * 0.20, colour: sx > 0 ? 0xc8ccd1 : 0xb3b8bd,
        });
        // Corrugation ribs.
        for (let r = 0; r < 6; r++) {
          k.box(0.075, 0.075, D + 0.60, {
            x: sx * (0.16 + r * 0.28), y: H + 0.33 - Math.abs(0.16 + r * 0.28) * 0.20, z: -D / 2 + 0.05,
            colour: sx > 0 ? 0xd2d6da : 0xa9aeb3,
          });
        }
      }
      k.box(0.20, 0.16, D + 0.66, { y: H + 0.40, z: -D / 2 + 0.05, colour: 0xdadee2 });
      k.box(W + 0.24, 0.16, 0.14, { y: H + 0.20, z: 0.28, colour: 0x9ba1a7 });   // fascia/gutter
      k.box(0.09, H, 0.09, { x: -W / 2 - 0.02, y: H / 2, z: 0.20, colour: 0x9ba1a7 }); // downpipe
      // Post number plate + extinguishers.
      k.box(0.62, 0.34, 0.05, { x: W / 2 - 0.45, y: 2.16, z: 0.02, colour: 0xf2c400 });
      for (const sx of [0, 1]) k.cyl(0.09, 0.44, 7, { x: W / 2 - 0.30 - sx * 0.24, y: 0.22, z: 0.34, colour: 0xa8291f });
      // Debris railing on the track side, then the flag mast.
      k.box(3.3, 0.10, 0.10, { y: 1.05, z: 0.62, colour: 0xd0d4d8 });
      k.box(3.3, 0.08, 0.08, { y: 0.60, z: 0.62, colour: 0xc6cacf });
      for (const sx of [-1, 1]) k.box(0.11, 1.10, 0.11, { x: sx * 1.6, y: 0.55, z: 0.62, colour: 0xd0d4d8 });
      k.cyl(0.055, 3.9, 7, { x: 1.82, y: 1.95, z: 0.30, colour: 0xa9aeb3 });
      k.box(0.10, 0.10, 0.10, { x: 1.82, y: 3.90, z: 0.30, colour: 0x8d9298 });
      return k.build();
    });
    const mat = assets.material('env/marshalMat', () => new THREE.MeshStandardMaterial({
      ...mapsToMaterial(assets.get('env/concreteMaps', () => setRepeat(cloneMaps(concrete({ stain: 0.55 })), 1, 1))),
      vertexColors: true, color: 0xffffff, roughness: 0.85, metalness: 0, envMapIntensity: 0.85,
    }));

    const count = Math.max(14, Math.floor(c.length / 165));
    const mats = [], flags = [];
    const rngM = makeRng(hashSeed('marshal-crew'));
    for (let i = 0; i < count; i++) {
      const s = c.wrapS((i + 0.35) * (c.length / count));
      const idx = c.sampleIndex(s);
      const sm = c.samples[idx];
      const side = i % 2 ? 1 : -1;
      if (this.corr.skip[this._ci(idx, side)]) continue;
      const lat = side * (this.corr.barrier[this._ci(idx, side)] + 3.4);
      _v.copy(sm.position).addScaledVector(sm.right, lat);
      _v.y = this._vergeY(idx, side, lat);
      const q = this._faceTrack(sm, side, new THREE.Quaternion());
      _m.compose(_v, q, _one);
      mats.push(_m.clone());
      flags.push({ p: _v.clone(), q, cell: i % 2 });
      // Two marshals in high-vis, one signalling. Orange overalls, not a flat
      // saturated silhouette.
      for (let j = 0; j < 3; j++) {
        const off = new THREE.Vector3((j - 1) * 1.25 + (rngM() - 0.5) * 0.6, 0, 0.95 + rngM() * 0.5)
          .applyQuaternion(q).add(_v);
        this._person(off, q, j === 1 ? 0xd9531e : 0xe8681f,
          [2, 0, 4, 6, 7][j === 2 ? 0 : 1 + Math.floor(rngM() * 4)], (rngM() - 0.5) * 1.6);
      }
    }
    const inst = new THREE.InstancedMesh(postGeo, mat, mats.length);
    inst.castShadow = inst.receiveShadow = true;
    mats.forEach((m, i) => inst.setMatrixAt(i, m));
    inst.instanceMatrix.needsUpdate = true;
    group.add(inst);
    if (flags.length) group.add(this._flagField(flags, 1.15, 0.75, 1.85, 3.72, 2, 0.30));
    return group;
  }

  _buildTowers() {
    const c = this.circuit;
    const group = new THREE.Group();
    group.name = 'Towers';

    /**
     * Broadcast camera scaffold.
     *
     * The old one was a white ladder-box: every member inherited vertex colour
     * 0xffffff on a metalness-0.8 material, so an 11 m tower of 160 mm tube read
     * as a bright solid slab from 200 m. A real one is galvanised tube (mid grey,
     * about 0.42 albedo), the deck is dark ply, the guard rail is open, and the
     * whole thing carries a black shade canopy over the operator. Value is what
     * makes it read as a lattice — not more geometry.
     */
    const tvGeo = assets.geometry('env/tvtower', () => {
      const k = new Kit(0.5);
      const H = 11;
      const TUBE = 0x7c8288, DECK = 0x2e3237, RAIL = 0x6d7379;
      // Concrete ballast under each leg.
      for (const [dx, dz] of [[-0.9, -0.9], [0.9, -0.9], [-0.9, 0.9], [0.9, 0.9]]) {
        k.box(0.16, H, 0.16, { x: dx, y: H / 2, z: dz, colour: TUBE });
        k.box(0.52, 0.22, 0.52, { x: dx, y: 0.11, z: dz, colour: 0x8d8d87 });
      }
      for (let i = 1; i * 1.5 < H; i++) {
        const y = i * 1.5;
        k.box(1.95, 0.09, 0.09, { y, z: -0.9, colour: TUBE });
        k.box(1.95, 0.09, 0.09, { y, z: 0.9, colour: TUBE });
        k.box(0.09, 0.09, 1.95, { y, x: -0.9, colour: TUBE });
        k.box(0.09, 0.09, 1.95, { y, x: 0.9, colour: TUBE });
        // Braces on all four faces, alternating hand — a real scaffold is
        // triangulated on every bay, and the X pattern is its whole silhouette.
        const sgn = i % 2 ? 1 : -1;
        k.box(0.075, 2.3, 0.075, { y: y + 0.75, z: -0.9, rz: 0.62 * sgn, colour: TUBE });
        k.box(0.075, 2.3, 0.075, { y: y + 0.75, z: 0.9, rz: -0.62 * sgn, colour: TUBE });
        k.box(0.075, 2.3, 0.075, { y: y + 0.75, x: -0.9, rx: 0.62 * sgn, colour: TUBE });
        k.box(0.075, 2.3, 0.075, { y: y + 0.75, x: 0.9, rx: -0.62 * sgn, colour: TUBE });
      }
      // Deck + toe boards.
      k.box(2.9, 0.10, 2.9, { y: H, colour: DECK });
      k.box(2.9, 0.22, 0.06, { y: H + 0.14, z: 1.42, colour: 0x3d4147 });
      k.box(2.9, 0.22, 0.06, { y: H + 0.14, z: -1.42, colour: 0x3d4147 });
      // Open guard rail: two rails and four stanchions, not a solid parapet.
      for (const zz of [-1.42, 1.42]) {
        k.box(2.9, 0.07, 0.07, { y: H + 1.05, z: zz, colour: RAIL });
        k.box(2.9, 0.07, 0.07, { y: H + 0.55, z: zz, colour: RAIL });
      }
      for (const xx of [-1.42, 1.42]) {
        k.box(0.07, 0.07, 2.9, { y: H + 1.05, x: xx, colour: RAIL });
        k.box(0.07, 0.07, 2.9, { y: H + 0.55, x: xx, colour: RAIL });
      }
      for (const [dx, dz] of [[-1.42, -1.42], [1.42, -1.42], [-1.42, 1.42], [1.42, 1.42]]) {
        k.box(0.08, 1.12, 0.08, { x: dx, y: H + 0.56, z: dz, colour: RAIL });
      }
      // Black shade canopy on four posts.
      for (const [dx, dz] of [[-1.2, -1.2], [1.2, -1.2], [-1.2, 1.2], [1.2, 1.2]]) {
        k.box(0.07, 1.25, 0.07, { x: dx, y: H + 1.7, z: dz, colour: 0x33373c });
      }
      k.box(3.05, 0.07, 3.05, { y: H + 2.36, colour: 0x1d1f22 });
      // Camera: box body, hood, lens, tripod, plus the operator's stool.
      k.box(0.52, 0.40, 1.00, { y: H + 1.30, z: -0.55, colour: 0x22252a });
      k.box(0.60, 0.10, 0.66, { y: H + 1.53, z: -0.62, colour: 0x191b1e });
      k.cyl(0.135, 0.62, 12, { y: H + 1.28, z: -1.28, rx: Math.PI / 2, colour: 0x101215 });
      k.cyl(0.155, 0.06, 12, { y: H + 1.28, z: -1.60, rx: Math.PI / 2, colour: 0x2b3d4a });
      k.box(0.11, 1.12, 0.11, { y: H + 0.56, z: -0.55, colour: 0x3a3e43 });
      k.box(0.34, 0.06, 0.34, { y: H + 0.62, z: 0.55, colour: 0x2a2d31 });
      k.box(0.05, 0.55, 0.05, { y: H + 0.33, z: 0.55, colour: 0x2a2d31 });
      return k.build();
    });
    const metalMat = assets.material('env/towerMat', () => new THREE.MeshStandardMaterial({
      ...mapsToMaterial(assets.get('env/railMaps', () => setRepeat(cloneMaps(brushedMetal({ roughBase: 0.45 })), 1, 1))),
      vertexColors: true, color: 0xc8ccd0, roughness: 0.82, metalness: 0.8, envMapIntensity: 1.15,
    }));

    const tvSpots = [0.05, 0.12, 0.20, 0.26, 0.33, 0.40, 0.47, 0.54, 0.61, 0.68, 0.75, 0.82, 0.89, 0.96];
    const tvM = [];
    tvSpots.forEach((f, i) => {
      const idx = c.sampleIndex(f * c.length);
      const sm = c.samples[idx];
      const side = i % 2 ? 1 : -1;
      if (this.corr.skip[this._ci(idx, side)]) return;
      const lat = side * (this.corr.barrier[this._ci(idx, side)] + 5.5);
      _v.copy(sm.position).addScaledVector(sm.right, lat);
      _v.y = this._vergeY(idx, side, lat);
      _m.compose(_v, this._faceTrack(sm, side, _q), _one);
      tvM.push(_m.clone());
    });
    if (tvM.length) {
      const tv = new THREE.InstancedMesh(tvGeo, metalMat, tvM.length);
      tv.castShadow = true;
      tvM.forEach((m, i) => tv.setMatrixAt(i, m));
      tv.instanceMatrix.needsUpdate = true;
      group.add(tv);
    }

    const pylonGeo = assets.geometry('env/pylon', () => {
      const k = new Kit(0.4);
      const H = 36;
      for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
        k.box(0.28, H, 0.28, { x: dx * 0.95, y: H / 2, z: dz * 0.95 });
      }
      for (let i = 1; i * 3 < H; i++) {
        const y = i * 3;
        k.box(2.1, 0.13, 0.13, { y, z: -0.95 });
        k.box(2.1, 0.13, 0.13, { y, z: 0.95 });
        k.box(0.13, 0.13, 2.1, { y, x: -0.95 });
        k.box(0.12, 3.5, 0.12, { y: y + 1.5, z: -0.95, rz: 0.5 * (i % 2 ? 1 : -1) });
        k.box(0.12, 3.5, 0.12, { y: y + 1.5, z: 0.95, rz: 0.5 * (i % 2 ? -1 : 1) });
      }
      k.box(8.0, 0.5, 1.5, { y: H + 0.5, colour: 0x9aa0a6 });
      for (let i = -3; i <= 3; i++) {
        k.box(0.95, 0.95, 0.36, { x: i * 1.05, y: H + 1.4, z: 0.45, rx: 0.45, colour: 0xf8f9f4 });
      }
      return k.build();
    });
    const pylonSpots = [0.05, 0.17, 0.28, 0.39, 0.5, 0.62, 0.74, 0.86, 0.95];
    const pylons = new THREE.InstancedMesh(pylonGeo, metalMat, pylonSpots.length);
    pylons.castShadow = true;
    pylonSpots.forEach((f, i) => {
      const idx = c.sampleIndex(f * c.length);
      const sm = c.samples[idx];
      const side = i % 3 === 0 ? -1 : 1;
      const lat = side * (this.corr.barrier[this._ci(idx, side)] + 24);
      _v.copy(sm.position).addScaledVector(sm.right, lat);
      _v.y = this.terrainHeightAt(_v.x, _v.z);
      _m.compose(_v, this._faceTrack(sm, side, _q), _one);
      pylons.setMatrixAt(i, _m);
    });
    pylons.instanceMatrix.needsUpdate = true;
    group.add(pylons);
    return group;
  }

  /**
   * The paddock clutter that actually lives behind an F1 barrier: portable
   * cabins, hospitality marquees, recovery trucks, spare tyre stacks and
   * stacked crash-barrier sections.
   *
   * A race weekend is a temporary town. Without it the space between the
   * barrier and the countryside is empty grass, and empty grass is the single
   * biggest reason a circuit reads as a model rather than a place. Everything
   * here is one instanced draw per archetype and sits on or beside the service
   * road, so it costs six draw calls for the whole lap.
   */
  _buildTracksideFurniture() {
    const c = this.circuit;
    const n = c.samples.length;
    const group = new THREE.Group();
    group.name = 'TracksideFurniture';
    const rng = makeRng(hashSeed('furniture'));

    // Site cabin. This is metres from the barrier and reads at every camera, and
    // it was a plain box with a single-quad roof: two triangles wide enough to
    // own a blown silver highlight between them. Now a ribbed steel cabin with a
    // recessed glazed window in a frame, a real door with a handle and steps, a
    // two-span corrugated roof over a ridge, a fascia, a downpipe and a sign.
    const cabin = assets.geometry('env/cabin', () => {
      const k = new Kit(0.35);
      const W = 6.0, D = 2.9, H = 2.55;
      k.box(W, H, D, { y: 1.28, colour: 0xdfe2e0 });
      // Vertical rib panel lines down both long faces.
      for (let i = 0; i < 11; i++) {
        const x = -W / 2 + 0.30 + i * 0.54;
        k.box(0.07, H - 0.14, 0.06, { x, y: 1.28, z: D / 2 + 0.02, colour: 0xc2c6c4 });
        k.box(0.07, H - 0.14, 0.06, { x, y: 1.28, z: -D / 2 - 0.02, colour: 0xb6bab8 });
      }
      // Two-span corrugated roof with a ridge purlin — no single facet can own
      // the specular.
      for (const sx of [-1, 1]) {
        k.box(W / 2 + 0.14, 0.10, D + 0.34, { x: sx * (W / 4 + 0.06), y: 2.66, rz: sx * 0.16, colour: sx > 0 ? 0xc6cac8 : 0xb0b4b2 });
        for (let r = 0; r < 5; r++) {
          k.box(0.08, 0.08, D + 0.34, {
            x: sx * (0.28 + r * 0.55), y: 2.70 - (0.28 + r * 0.55) * 0.16,
            colour: sx > 0 ? 0xd2d6d4 : 0xa6aaa8,
          });
        }
      }
      k.box(0.22, 0.16, D + 0.40, { y: 2.76, colour: 0xdadedc });
      k.box(W + 0.26, 0.14, 0.12, { y: 2.52, z: D / 2 + 0.16, colour: 0x9ba19b });   // fascia
      k.box(0.08, H, 0.08, { x: -W / 2 - 0.02, y: 1.28, z: D / 2 + 0.10, colour: 0x9ba19b }); // downpipe
      // Door: frame, leaf, handle, two steps.
      k.box(1.02, 2.05, 0.07, { x: -2.0, y: 1.03, z: D / 2 + 0.02, colour: 0xa8b0aa });
      k.box(0.86, 1.92, 0.06, { x: -2.0, y: 1.00, z: D / 2 + 0.06, colour: 0x515b62 });
      k.box(0.10, 0.05, 0.05, { x: -1.66, y: 1.02, z: D / 2 + 0.12, colour: 0xc8ccca });
      k.box(1.20, 0.10, 0.42, { x: -2.0, y: 0.20, z: D / 2 + 0.28, colour: 0x8f9391 });
      k.box(1.20, 0.10, 0.42, { x: -2.0, y: 0.36, z: D / 2 + 0.14, colour: 0x9a9e9c });
      // Window: recessed dark glass with a full frame and a sill.
      k.box(2.68, 1.02, 0.06, { x: 1.2, y: 1.65, z: D / 2 - 0.03, colour: 0x39454c });
      k.box(2.74, 0.07, 0.11, { x: 1.2, y: 1.16, z: D / 2 + 0.04, colour: 0xb0b6b2 });
      k.box(2.74, 0.07, 0.11, { x: 1.2, y: 2.14, z: D / 2 + 0.04, colour: 0xb0b6b2 });
      k.box(0.07, 1.02, 0.11, { x: -0.16, y: 1.65, z: D / 2 + 0.04, colour: 0xb0b6b2 });
      k.box(0.07, 1.02, 0.11, { x: 2.56, y: 1.65, z: D / 2 + 0.04, colour: 0xb0b6b2 });
      k.box(0.05, 1.02, 0.09, { x: 1.20, y: 1.65, z: D / 2 + 0.03, colour: 0xa8aeaa });
      // Signage board over the door, plus a service box.
      k.box(1.55, 0.36, 0.05, { x: -1.9, y: 2.28, z: D / 2 + 0.06, colour: 0xe8a41c });
      k.box(0.42, 0.52, 0.20, { x: 2.62, y: 0.90, z: D / 2 + 0.10, colour: 0x6f7472 });
      k.box(W, 0.16, D, { y: 0.10, colour: 0x8f9391 });
      k.box(0.30, 0.32, 0.30, { x: -2.4, y: 0.16, z: 1.2, colour: 0x6f7472 });
      k.box(0.30, 0.32, 0.30, { x: 2.4, y: 0.16, z: 1.2, colour: 0x6f7472 });
      k.box(0.30, 0.32, 0.30, { x: -2.4, y: 0.16, z: -1.2, colour: 0x6f7472 });
      k.box(0.30, 0.32, 0.30, { x: 2.4, y: 0.16, z: -1.2, colour: 0x6f7472 });
      return k.build();
    });

    const marquee = assets.geometry('env/marquee', () => {
      const k = new Kit(0.3);
      const W = 12, D = 8, H = 2.6, RIDGE = 1.7;
      // Two roof slopes + gable ends + corner legs.
      const pitch = Math.atan2(RIDGE, D / 2);
      const slope = Math.hypot(RIDGE, D / 2);
      k.box(W, 0.10, slope, { y: H + RIDGE / 2, z: -D / 4, rx: pitch, colour: 0xf2f0ea });
      k.box(W, 0.10, slope, { y: H + RIDGE / 2, z: D / 4, rx: -pitch, colour: 0xf2f0ea });
      for (const sx of [-1, 1]) {
        k.box(0.12, H, 0.12, { x: sx * (W / 2 - 0.2), y: H / 2, z: -D / 2 + 0.2, colour: 0xc8ccca });
        k.box(0.12, H, 0.12, { x: sx * (W / 2 - 0.2), y: H / 2, z: D / 2 - 0.2, colour: 0xc8ccca });
        k.box(0.12, H, 0.12, { x: sx * (W / 2 - 0.2), y: H / 2, z: 0, colour: 0xc8ccca });
      }
      k.box(W, H * 0.9, 0.08, { y: H * 0.45, z: -D / 2 + 0.2, colour: 0xeceae4 });
      k.box(0.20, RIDGE, D, { y: H + RIDGE / 2, colour: 0xe6e4de });
      return k.build();
    });

    const truck = assets.geometry('env/recovery', () => new Kit(0.4)
      .box(2.5, 1.5, 5.6, { y: 1.35, z: 0.6, colour: 0xd8d2c4 })     // flatbed body
      .box(2.4, 1.6, 2.2, { y: 1.5, z: -3.2, colour: 0xd05a2a })     // cab
      .box(2.2, 0.7, 2.0, { y: 2.5, z: -3.1, colour: 0x37424c })     // cab glass
      .box(0.35, 0.45, 5.4, { x: -1.28, y: 0.62, z: 0.6, colour: 0x26292c })
      .box(0.35, 0.45, 5.4, { x: 1.28, y: 0.62, z: 0.6, colour: 0x26292c })
      .box(0.5, 0.5, 3.6, { y: 2.6, z: 1.2, ry: 0.0, colour: 0xb8b2a4 })   // crane boom
      .box(2.5, 0.22, 0.5, { y: 2.28, z: -2.0, colour: 0xf0c400 })
      .build());

    const stack = assets.geometry('env/sparetyres', () => {
      const k = new Kit(1.2);
      for (let r = 0; r < 3; r++) {
        for (let i = 0; i < 4; i++) {
          k.cyl(0.35, 0.24, 10, { x: (r - 1) * 0.78, y: 0.13 + i * 0.25, colour: i % 2 ? 0x2b2b2d : 0x232326 });
        }
      }
      return k.build();
    });

    const mat = assets.material('env/furniture', () => new THREE.MeshStandardMaterial({
      ...mapsToMaterial(assets.get('env/concreteMaps', () => setRepeat(cloneMaps(concrete({ stain: 0.55 })), 1, 1))),
      vertexColors: true, color: 0xffffff, roughness: 0.82, metalness: 0.02, envMapIntensity: 0.7,
    }));

    // kind -> matrices. Each site gets a coherent little compound.
    const sets = { cabin: [], marquee: [], truck: [], stack: [] };
    const SITES = 72;
    for (let k = 0; k < SITES; k++) {
      const s = c.wrapS((k + 0.42) * (c.length / SITES) + (rng() - 0.5) * 60);
      const i = c.sampleIndex(s);
      const side = rng() < 0.5 ? -1 : 1;
      if (this.corr.skip[this._ci(i, side)]) continue;
      const sm = c.samples[i];
      const q = this._faceTrack(sm, side, new THREE.Quaternion());
      const basis = new THREE.Matrix4().makeRotationFromQuaternion(q);
      const b = this.corr.barrier[this._ci(i, side)];
      const roll = rng();

      // `out` is metres OUTWARD from the barrier face. The faceTrack basis has
      // local +Z pointing at the track, so outward is -Z.
      const put = (list, dx, out, extraYaw, sc = 1) => {
        const local = _v3.set(dx, 0, -out).applyMatrix4(basis);
        _v.copy(sm.position).addScaledVector(sm.right, side * b).add(local);
        _v.y = this._vergeY(i, side, side * (b + out)) + 0.02;
        _q.copy(q).multiply(_qb.setFromAxisAngle(UP, extraYaw));
        _m.compose(_v, _q, _v2.set(sc, sc, sc));
        list.push(_m.clone());
      };

      if (roll < 0.34) {
        const rows = 2 + Math.floor(rng() * 2);
        for (let r = 0; r < rows; r++) put(sets.cabin, (r - (rows - 1) / 2) * 6.6, 11.5 + rng() * 1.5, (rng() - 0.5) * 0.05);
        put(sets.stack, -10.5, 9.2, rng());
      } else if (roll < 0.62) {
        put(sets.marquee, (rng() - 0.5) * 6, 14.0, (rng() - 0.5) * 0.06);
        put(sets.cabin, 11.5, 12.0, (rng() - 0.5) * 0.1);
      } else if (roll < 0.85) {
        put(sets.truck, (rng() - 0.5) * 4, 6.2, Math.PI * 0.5 + (rng() - 0.5) * 0.2);
        put(sets.stack, 7.5, 6.6, rng());
        put(sets.cabin, -9.0, 10.5, (rng() - 0.5) * 0.1);
      } else {
        for (let r = 0; r < 3; r++) put(sets.stack, (r - 1) * 2.9, 6.4 + rng() * 1.2, rng());
      }
    }

    for (const [name, geo] of [['cabin', cabin], ['marquee', marquee], ['truck', truck], ['stack', stack]]) {
      const list = sets[name];
      if (!list.length) continue;
      const inst = new THREE.InstancedMesh(geo, mat, list.length);
      inst.castShadow = inst.receiveShadow = true;
      list.forEach((m, idx) => inst.setMatrixAt(idx, m));
      inst.instanceMatrix.needsUpdate = true;
      inst.name = `Furniture-${name}`;
      group.add(inst);
    }
    return group;
  }

  // -- vegetation -----------------------------------------------------------

  /**
   * Instanced grass cards along the verge.
   *
   * This used to be 34 000 near-metre-tall crossed cards scattered out to 55 m
   * past the barrier, tinted at up to 60 % saturation and lit at 1.5 — from any
   * elevated camera it read as a rash of luminous green blobs sitting on the
   * field, which is the single loudest "hobby project" tell in the frame.
   *
   * The replacement is a proper near-field detail layer:
   *   - short (0.30–0.55 m), because that is what mown circuit turf is;
   *   - two crossed quads, not three — half the fill for no visible loss;
   *   - concentrated on the verge, thinning fast past the barrier;
   *   - desaturated (S 0.08–0.22), lit at 1.0, so the cards sit INSIDE the
   *     ground's own tonal range instead of floating above it;
   *   - collapsed to nothing between `FADE` metres, so what you see at range is
   *     the graded ground texture and nothing else.
   */
  _buildGrassTufts() {
    const group = new THREE.Group();
    group.name = 'GrassCards';
    if (this.detail === 'low') return group;
    const c = this.circuit;
    const n = c.samples.length;
    const rng = this.rng;
    const tex = bladeCardTexture('env/blade', 0.34);
    const FADE = new THREE.Vector2(26, 52);

    // Two crossed quads. Three at 60° gave the star 60° rotational symmetry, so
    // a random yaw could not change its silhouette at all — every card looked
    // the same and the verge came out as a knitted mat. The per-instance UV
    // window below is what supplies the variety now, so two quads is enough.
    const card = (() => {
      const a = new THREE.PlaneGeometry(0.58, 0.42);
      a.translate(0, 0.21, 0);
      const b = a.clone(); b.rotateY(Math.PI / 2);
      return mergeGeometries([a, b]);
    })();

    const TOTAL = this.detail === 'medium' ? 46000 : 132000;
    // Forty arcs, not twenty: each InstancedMesh culls as one unit, so halving
    // the arc length halves what a chase camera has to push through the vertex
    // stage for the 3/4 of the lap that is behind it.
    const CH = 40;
    const perChunk = Math.ceil(TOTAL / CH);
    for (let ch = 0; ch < CH; ch++) {
      const mats = [], tints = [], phases = [], wins = [];
      for (let k = 0; k < perChunk; k++) {
        const i = Math.floor(((ch + rng()) / CH) * n) % n;
        const sm = c.samples[i];
        const side = rng() < 0.5 ? -1 : 1;
        const ix = this._ci(i, side);
        if (this.corr.skip[ix]) continue;
        const inner = c.halfWidth + 1.15 + this.corr.runoff[ix];
        const barrier = this.corr.barrier[ix];
        const vergeOuter = barrier + this.corr.tail[ix];
        if (vergeOuter - inner < 1.2) continue;
        // Three populations. The verge is mown and dense; a narrow band at the
        // barrier foot is where the machine cannot reach and the grass runs
        // long; the field behind is a texture, not a scatter.
        const roll = rng();
        const foot = roll < 0.14;
        const beyond = !foot && roll > 0.90;
        // SEAM CARDS. The review measured the grass/tarmac boundary as "a single
        // hard pixel line with no grass overhang". The apron edge is a real
        // straight line — it is sawn concrete — so the cure is not to bend it but
        // to break its SILHOUETTE: a band of short blades straddling it, half on
        // the asphalt, so the eye reads an overgrown edge instead of a drawn one.
        const seam = !foot && !beyond && roll > 0.72;
        let lat, tall;
        if (foot) {
          lat = side * (barrier - 0.55 - rng() * 0.9);
          tall = true;
        } else if (seam) {
          lat = side * (inner + (rng() - 0.58) * 0.80);
          tall = false;
        } else if (beyond) {
          lat = side * (vergeOuter + Math.pow(rng(), 1.7) * 20);
          tall = rng() < 0.35;
        } else {
          const t = Math.pow(rng(), 0.70);
          lat = side * lerp(inner + 0.30, vergeOuter - 0.4, t);
          tall = false;
        }
        _v.copy(sm.position).addScaledVector(sm.right, lat);
        // 2.4x the sample pitch: jitter under one step leaves the cards
        // quantised to the sample positions, which is a rib every 2 m.
        _v.addScaledVector(sm.tangent, (rng() - 0.5) * c.step * 2.4);
        _v.y = (beyond ? this.terrainHeightAt(_v.x, _v.z) : this._vergeY(i, side, lat)) - 0.045;
        _q.setFromAxisAngle(UP, rng() * Math.PI * 2);
        const sc = (tall ? 0.95 : (seam ? 0.52 : 0.66)) + rng() * (tall ? 0.75 : 0.78);
        _m.compose(_v, _q, _v2.set(sc, sc * (tall ? 1.30 : 0.82) * (0.78 + rng() * 0.50), sc));
        mats.push(_m.clone());
        // Window into the blade atlas: ~1/6 of it, mirrored half the time.
        const u0 = rng() * (1 - 0.17);
        const flip = rng() < 0.5;
        wins.push(flip ? u0 + 0.17 : u0, flip ? u0 : u0 + 0.17);
        // Value/hue jitter around the turf ramp the fragment shader supplies.
        // Mean 1.0 — anything below reintroduces the dark-spot look.
        const v = 0.80 + rng() * 0.42;
        tints.push(v * (0.96 + rng() * 0.12), v, v * (0.90 + rng() * 0.14));
        phases.push(rng());
      }
      if (!mats.length) continue;
      const g = card.clone();
      g.setAttribute('aTint', new THREE.InstancedBufferAttribute(new Float32Array(tints), 3));
      g.setAttribute('aPhase', new THREE.InstancedBufferAttribute(new Float32Array(phases), 1));
      g.setAttribute('aWin', new THREE.InstancedBufferAttribute(new Float32Array(wins), 2));
      const uT = { value: 0 };
      this.animated.push(uT);
      const inst = new THREE.InstancedMesh(g, new THREE.ShaderMaterial({
        uniforms: Object.assign({}, THREE.UniformsLib.fog, {
          uMap: { value: tex },
          uLight: { value: new THREE.Color(1.0, 1.0, 0.98) },
          // Matched to the verge turf ramp in `_buildVerge` — one grass colour
          // for the ground and the cards on it.
          uTurf: { value: new THREE.Color(0x57634e) },
          uTurfDry: { value: new THREE.Color(0x6f755c) },
          uFade: { value: FADE },
          uTime: uT,
        }),
        vertexShader: TUFT_VERT,
        fragmentShader: TUFT_FRAG,
        side: THREE.DoubleSide,
        fog: true,
      }), mats.length);
      mats.forEach((m, i) => inst.setMatrixAt(i, m));
      inst.instanceMatrix.needsUpdate = true;
      inst.computeBoundingSphere();
      group.add(inst);
    }
    return group;
  }

  _buildTrees() {
    const group = new THREE.Group();
    group.name = 'Trees';
    const c = this.circuit;
    const rng = this.rng;

    const trunkGeo = assets.geometry('env/trunk', () => new Kit(0.7)
      .cyl(0.17, 3.9, 6, { y: 1.95, r2: 0.35 })
      .cyl(0.10, 1.9, 5, { y: 4.3, x: 0.36, rz: -0.42, r2: 0.16 })
      .cyl(0.10, 1.9, 5, { y: 4.2, x: -0.34, rz: 0.45, r2: 0.16 })
      .build());
    const trunkMat = assets.material('env/trunkMat', () => new THREE.MeshStandardMaterial({
      color: 0x4a3a2c, vertexColors: true, roughness: 0.96, metalness: 0, envMapIntensity: 0.45,
    }));

    /**
     * Canopy: four crossed cards, each reading one cell of the crown atlas, so
     * a single tree already shows two different silhouettes and four trees in a
     * row show eight. `cell` selects which atlas quadrant this variant starts
     * from; the four cards inside it walk on from there.
     */
    const canopyGeo = (cell) => assets.geometry(`env/canopy-${cell}`, () => {
      const mk = (w, h, y, ry, c, flip) => {
        const p = new THREE.PlaneGeometry(w, h);
        const uv = p.attributes.uv;
        const ox = (c % 2) * 0.5, oy = ((c >> 1) & 1) * 0.5;
        for (let i = 0; i < uv.count; i++) {
          const u = flip ? 1 - uv.getX(i) : uv.getX(i);
          uv.setXY(i, ox + u * 0.5, oy + uv.getY(i) * 0.5);
        }
        uv.needsUpdate = true;
        p.translate(0, y, 0);
        p.rotateY(ry);
        return p;
      };
      return mergeGeometries([
        mk(7.4, 7.0, 6.0, 0, cell, false),
        mk(6.9, 6.5, 5.7, Math.PI / 2, (cell + 1) & 3, true),
        mk(5.0, 4.5, 7.4, Math.PI / 4, (cell + 2) & 3, false),
        mk(4.6, 4.2, 4.6, -Math.PI / 3, (cell + 3) & 3, true),
      ]);
    });
    const canopyMat = assets.material('env/canopyMat', () => {
      const m = new THREE.MeshStandardMaterial({
        map: crownAtlas(),
        alphaTest: 0.42, side: THREE.DoubleSide,
        roughness: 0.92, metalness: 0, envMapIntensity: 0.8,
        color: 0xffffff,
      });
      /**
       * FAKE SPHERICAL NORMAL. Four crossed VERTICAL cards all have horizontal
       * normals, so every canopy in the frame gets nearly the same N·L and the
       * whole layer reads flat-lit — the reason these looked like broccoli. A
       * crown is optically a ball: take the normal from the local position
       * relative to the crown centre instead of from the card, blended 78 %
       * toward the sphere so the cards still separate slightly. This is a pure
       * normal substitution, no second light and no added radiance.
       */
      m.onBeforeCompile = (shader) => {
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vApexCrown;')
          .replace('#include <begin_vertex>', /* glsl */`
            #include <begin_vertex>
            vec3 apexCrownL = normalize( vec3( position.x, ( position.y - 6.0 ) * 1.45, position.z ) + 1e-4 );
            vApexCrown = normalize( ( modelMatrix * instanceMatrix * vec4( apexCrownL, 0.0 ) ).xyz );`);
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nvarying vec3 vApexCrown;')
          .replace('#include <normal_fragment_begin>', /* glsl */`
            #include <normal_fragment_begin>
            normal = normalize( mix( normal, normalize( vApexCrown ), 0.78 ) );`);
      };
      // Same haze law as the woodland masses, so a 200 m tree and the 1 km
      // treeline behind it can never swap places in depth.
      aerialPerspective(m, { key: 'canopy' });
      m.customProgramCacheKey = () => 'apex-canopy-ball-ap';
      return m;
    });

    const COUNT = this.detail === 'low' ? 500 : 2200;
    const trunkM = [], tints = [];
    let placed = 0, tries = 0;
    while (placed < COUNT && tries < COUNT * 30) {
      tries++;
      const cx = lerp(this.bounds.minX - 400, this.bounds.maxX + 400, rng());
      const cz = lerp(this.bounds.minZ - 400, this.bounds.maxZ + 400, rng());
      const cluster = 5 + Math.floor(rng() * 14);
      const spread = 12 + rng() * 48;
      for (let j = 0; j < cluster && placed < COUNT; j++) {
        const x = cx + (rng() - 0.5) * spread * 2;
        const z = cz + (rng() - 0.5) * spread * 2;
        /**
         * TREES BELONG ON THE TREELINE, NOT IN THE NEAR-MID FIELD.
         *
         * The old test only rejected a tree that landed inside the terrain
         * carve, so a 24 m oak could stand 45 m past the barrier. Measured in
         * `wide`: the nearest canopy in frame sat at 138 m at instance scale
         * 1.23, and the four nearest were 138-204 m — roughly 200 px of crown
         * on a 900 px frame, the first thing the eye landed on and a cap on the
         * whole shot.
         *
         * 300 m was an over-correction and it emptied the mid-ground: measured
         * on `wide` against the round-5 baseline, pushing the trees out that far
         * cost SIX cells more than 15 % of their edge energy (r1c1 -33.3 %,
         * r1c3 -32.3 %, r1c2 -18.3 %, r2c0 -17.4 %, r1c0 -15.6 %, r0c1 -15.3 %)
         * — the whole band between the barrier and the far treeline flattened
         * into haze with no hedgerow or cluster structure left in it.
         *
         * 200 m is the middle that holds both ends: it is comfortably beyond the
         * 138 m nearest-canopy that made a single crown 200 px tall and cap the
         * shot, so that defect does not come back, while the field keeps its
         * clusters and hedgerow lines. Swept and measured, cells losing >15 %
         * edge on `wide`: 300 m -> 6, 240 m -> 4, **200 m -> 4**, 170 m -> 3.
         * 170 recovers one more cell but walks back toward the 138 m case, so
         * 200 is the value that is defensible in both directions.
         *
         * Anything nearer than this is the hedgerow layer's job, and it is
         * already there at 62 m.
         */
        if (this._sampleField(x, z).d < 200) continue;
        // A corridor test is not a building test: it passed every tree that
        // landed BEYOND the barrier, including the one that grew through the
        // main grandstand and photographed as a floating green blob inside the
        // structure in both `grid` and `beauty`. Stands are 30 m wide and 24 m
        // deep and they sit outboard of the corridor by construction, so they
        // need their own rejection.
        if (this._inStructure(x, z)) continue;
        const y = this.terrainHeightAt(x, z) - 0.3;
        // SPECIES SILHOUETTE. One lollipop profile repeated is what made every
        // canopy identical; the atlas already gives four crowns, and a
        // non-uniform per-instance scale turns those four into a poplar (tall,
        // narrow), a spreading oak, a squat willow and a conifer.
        const kind = rng();
        // 0.8 + 1.15 put the crown top of the biggest instance at 9.5 m * 2.63
        // = 25 m. A 25 m specimen oak is real, but four of them in the near-mid
        // field is what "three times the screen size" measured as. Capped so the
        // tallest tree in the wood is ~17 m, which is a mature hedgerow ash.
        const s = 0.68 + rng() * 0.66;
        let sx = s, sy = s * (0.85 + rng() * 0.5);
        if (kind < 0.20) { sx = s * (0.48 + rng() * 0.12); sy = s * (1.55 + rng() * 0.45); }
        else if (kind < 0.34) { sx = s * (1.20 + rng() * 0.30); sy = s * (0.62 + rng() * 0.16); }
        else if (kind < 0.46) { sx = s * (0.66 + rng() * 0.14); sy = s * (1.20 + rng() * 0.30); }
        // Yaw fully, then LEAN up to 6 degrees on a random bearing. A wood in
        // which every trunk is dead plumb reads as instanced, because it is.
        _q.setFromAxisAngle(UP, rng() * Math.PI * 2);
        const lb = rng() * Math.PI * 2;
        _q.multiply(_qb.setFromAxisAngle(
          _v3.set(Math.cos(lb), 0, Math.sin(lb)), (0.02 + rng() * 0.085)
        ));
        _m.compose(_v.set(x, y, z), _q, _v2.set(sx, sy, sx));
        trunkM.push(_m.clone());
        // The crown atlas now carries the colour, so this is a VALUE jitter
        // around 1.0 with a slight hue wander — species variation, not a dye.
        const g = 0.74 + rng() * 0.48;
        tints.push(g * (0.94 + rng() * 0.14), g, g * (0.84 + rng() * 0.22));
        placed++;
      }
    }

    const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, placed);
    trunks.castShadow = true;
    trunks.receiveShadow = true;
    for (let i = 0; i < placed; i++) trunks.setMatrixAt(i, trunkM[i]);
    trunks.instanceMatrix.needsUpdate = true;
    group.add(trunks);

    for (let cell = 0; cell < 4; cell++) {
      const sel = [];
      for (let i = cell; i < placed; i += 4) sel.push(i);
      if (!sel.length) continue;
      const canopies = new THREE.InstancedMesh(canopyGeo(cell), canopyMat, sel.length);
      const tc = new Float32Array(sel.length * 3);
      sel.forEach((src, k) => {
        canopies.setMatrixAt(k, trunkM[src]);
        tc[k * 3] = tints[src * 3]; tc[k * 3 + 1] = tints[src * 3 + 1]; tc[k * 3 + 2] = tints[src * 3 + 2];
      });
      canopies.instanceColor = new THREE.InstancedBufferAttribute(tc, 3);
      canopies.instanceMatrix.needsUpdate = true;
      canopies.instanceColor.needsUpdate = true;
      canopies.castShadow = true;
      canopies.name = `Canopy-${cell}`;
      group.add(canopies);
    }

    // Hedges just beyond the verge.
    const bushGeo = assets.geometry('env/bush', () => {
      // Long-axis card + a short cross card: a hedge section, not a ball.
      const a = new THREE.PlaneGeometry(5.4, 1.7); a.translate(0, 0.85, 0);
      const b = new THREE.PlaneGeometry(1.5, 1.5); b.translate(0, 0.75, 0); b.rotateY(Math.PI / 2);
      return mergeGeometries([a, b]);
    });
    // Hedgerows, not bushes. The old layer put 2.8 m saturated foliage blobs
    // as close as 1 m outside the terrain carve, which from a TV tower is a
    // field of green spots. A hedgerow is a LINE — it follows a field boundary,
    // it is long and low, it is dark, and it starts well back from the circuit.
    const bushMat = assets.material('env/bushMat', () => new THREE.MeshStandardMaterial({
      map: treeMassTexture('env/scrubTex', {
        dark: [33, 41, 30], lit: [80, 90, 64], solid: 0.88, relief: 0.42, chew: 90, blobs: 1200,
      }),
      alphaTest: 0.42, side: THREE.DoubleSide,
      roughness: 0.96, metalness: 0, envMapIntensity: 0.45, color: 0xffffff,
    }));
    const bushes = [];
    const n = c.samples.length;
    for (let clump = 0; clump < 70; clump++) {
      const i0 = Math.floor(rng() * n);
      const side = rng() < 0.5 ? -1 : 1;
      if (this.corr.skip[this._ci(i0, side)]) continue;
      const d0 = this.corr.carve[this._ci(i0, side)] + 60 + rng() * 130;
      const span = 18 + Math.floor(rng() * 26);
      // A hedgerow follows a field boundary, and a field boundary WANDERS. The
      // rows were laid at a fixed lateral offset with ±1.25 m of noise, which
      // from a tower is a set of perfectly parallel dark sausages — an
      // unmistakable instancing pattern. This is a random walk of ±4 m plus
      // gateways: an 8–20 m break every so often, which is where the farm
      // track goes through.
      let walk = 0, gate = -1;
      // One card per 2 m against a 5.4 m card: nearly threefold overlap, which
      // is what turns a row of alpha sprites into one continuous hedge rather
      // than the line of dark blobs a sparser spacing gives.
      for (let j = 0; j < span; j++) {
        walk = clamp(walk + (rng() - 0.5) * 1.5, -4, 4);
        if (gate < 0 && j > 3 && rng() < 0.10) gate = j + 4 + Math.floor(rng() * 6);
        if (gate >= 0 && j < gate) continue;
        if (gate >= 0 && j === gate) gate = -1;
        const i = (i0 + j) % n;
        const sm = c.samples[i];
        const lat = side * (d0 + walk + (rng() - 0.5) * 2.5);
        _v.copy(sm.position).addScaledVector(sm.right, lat);
        _v.addScaledVector(sm.tangent, (rng() - 0.5) * c.step);
        _v.y = this.terrainHeightAt(_v.x, _v.z) - 0.30;
        this._alongTrack(sm, _q);
        const s = 0.8 + rng() * 0.5;
        _m.compose(_v, _q, _v2.set(s, s * (0.62 + rng() * 0.30), s));
        bushes.push(_m.clone());
      }
    }
    if (bushes.length) {
      const bush = new THREE.InstancedMesh(bushGeo, bushMat, bushes.length);
      bush.castShadow = true;
      bushes.forEach((m, i) => bush.setMatrixAt(i, m));
      bush.instanceMatrix.needsUpdate = true;
      group.add(bush);
    }
    return group;
  }

  /**
   * The spectator estate: overflow car parks and coach parks on the grass.
   *
   * A grand prix parks forty thousand cars in the fields around the circuit, in
   * ruler-straight rows on bare turf, and from any elevated camera those rows
   * are the loudest signal in the frame that an *event* is happening. Empty
   * countryside behind the barrier says "test track on a Tuesday".
   *
   * One instanced draw for cars, one for coaches, and the ground under them is
   * the terrain itself — which is exactly how it works in real life.
   */
  _buildSpectatorEstate() {
    const group = new THREE.Group();
    group.name = 'SpectatorEstate';
    if (this.detail === 'low') return group;
    const c = this.circuit;
    const n = c.samples.length;
    const rng = makeRng(hashSeed('estate'));

    const carGeo = carParkGeometry();
    const coachGeo = coachGeometry();
    const bodyMat = assets.material('env/parkBody', () => new THREE.MeshStandardMaterial({
      vertexColors: true, color: 0xffffff, roughness: 0.42, metalness: 0.12, envMapIntensity: 1.0,
    }));
    // Real car-park colour census: 70 % white / silver / grey / black.
    const PAINT = [
      0xd8dade, 0xd8dade, 0xc2c6c9, 0xa8adb1, 0x8e9397, 0x5d6367, 0x2f3336, 0x24262a,
      0x8f2f31, 0x2c4b76, 0x37503a, 0x7b6b4c, 0xb0562c, 0x3f3f52,
    ];

    const cars = [], coaches = [], tints = [], ctints = [];
    const LOTS = 30;
    for (let l = 0; l < LOTS; l++) {
      const i = Math.floor(((l + 0.35 + rng() * 0.3) / LOTS) * n) % n;
      const side = rng() < 0.5 ? -1 : 1;
      const ix = this._ci(i, side);
      if (this.corr.skip[ix]) continue;
      const sm = c.samples[i];
      // Well back from the circuit: past the barrier, the service road and the
      // paddock strip, where the public actually is.
      const out = this.corr.barrier[ix] + 46 + rng() * 120;
      const yaw = rng() * Math.PI * 2;
      const ca = Math.cos(yaw), sa = Math.sin(yaw);
      const cx = sm.position.x + sm.right.x * side * out + sm.tangent.x * (rng() - 0.5) * 90;
      const cz = sm.position.z + sm.right.z * side * out + sm.tangent.z * (rng() - 0.5) * 90;
      const coach = l % 4 === 3;
      const rows = coach ? 2 : 3 + Math.floor(rng() * 3);
      const per = coach ? 5 + Math.floor(rng() * 4) : 14 + Math.floor(rng() * 12);
      const pitch = coach ? 4.4 : 2.62;
      const rowGap = coach ? 15.5 : 6.05;
      for (let r = 0; r < rows; r++) {
        for (let k = 0; k < per; k++) {
          // Local (u along the row, v across the rows) -> world.
          const u = (k - (per - 1) / 2) * pitch + (rng() - 0.5) * 0.20;
          const vv = (r - (rows - 1) / 2) * rowGap + (rng() - 0.5) * 0.5;
          const x = cx + ca * u - sa * vv;
          const z = cz + sa * u + ca * vv;
          const f = this._sampleField(x, z);
          if (f.d < 38) continue;                       // never inside the circuit envelope
          _v.set(x, this.terrainHeightAt(x, z) - 0.05, z);
          // Cars nose in toward the row centre line: alternate rows face out.
          _q.setFromAxisAngle(UP, yaw + (r % 2 ? 0 : Math.PI) + (rng() - 0.5) * 0.06);
          _m.compose(_v, _q, _one);
          if (coach) {
            coaches.push(_m.clone());
            const g = 0.72 + rng() * 0.26;
            ctints.push(g, g * (0.98 + rng() * 0.04), g * (0.96 + rng() * 0.08));
          } else {
            cars.push(_m.clone());
            _col.set(PAINT[Math.floor(rng() * PAINT.length)]);
            tints.push(_col.r, _col.g, _col.b);
          }
        }
      }
    }

    for (const [geo, list, tint, name] of [
      [carGeo, cars, tints, 'ParkedCars'], [coachGeo, coaches, ctints, 'Coaches'],
    ]) {
      if (!list.length) continue;
      const inst = new THREE.InstancedMesh(geo, bodyMat, list.length);
      inst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(tint), 3);
      list.forEach((m, k) => inst.setMatrixAt(k, m));
      inst.instanceMatrix.needsUpdate = true;
      inst.instanceColor.needsUpdate = true;
      inst.castShadow = true;
      inst.name = name;
      group.add(inst);
    }
    return group;
  }

  // -- distant landscape ----------------------------------------------------

  /**
   * Everything between the last piece of circuit furniture and the skyline:
   * hedgerow field boundaries, mid-distance copses and forested ridges.
   *
   * The two jobs are (a) to divide the open country into the parcel mosaic the
   * terrain shader is already painting, so the tone changes have a *reason*, and
   * (b) to put vegetated mass on the hills, which is what stops the skyline
   * reading as cardboard standing in a lawn.
   */
  _buildFarLandscape() {
    const group = new THREE.Group();
    group.name = 'FarLandscape';
    const rng = makeRng(hashSeed('farland'));

    // --- hedgerow field boundaries, on the same 165 m grid as the parcels ----
    const hedgeGeo = assets.geometry('env/hedgeSeg', () => {
      const a = new THREE.PlaneGeometry(8.4, 2.5); a.translate(0, 1.25, 0);
      const b = new THREE.PlaneGeometry(2.3, 2.2); b.translate(0, 1.10, 0); b.rotateY(Math.PI / 2);
      return mergeGeometries([a, b]);
    });
    // A hedge is a nearly solid wall of leaf with a slightly ragged top — a low
    // `relief` and a high `solid` keep the card filled, which is what turns a
    // line of these into a boundary instead of a chain of dark lumps.
    const hedgeMat = assets.material('env/hedgeMat', () => aerialPerspective(
      new THREE.MeshStandardMaterial({
        map: treeMassTexture('env/hedgeTex', {
          dark: [40, 48, 30], lit: [88, 98, 56], solid: 0.94, relief: 0.30, chew: 55, blobs: 1400,
          form: 0.62, hue: 0.16,
        }),
        alphaTest: 0.42, side: THREE.DoubleSide,
        roughness: 0.95, metalness: 0, envMapIntensity: 0.5, color: 0xffffff,
      }), { key: 'hedge' }));

    const P = 158;                                   // parcel pitch (matches turfGrade)
    const b = this.bounds;
    const x0 = Math.floor((b.minX - 700) / P), x1 = Math.ceil((b.maxX + 700) / P);
    const z0 = Math.floor((b.minZ - 700) / P), z1 = Math.ceil((b.maxZ + 700) / P);
    const hedges = [];
    const layHedge = (ax, az, bx, bz) => {
      const len = Math.hypot(bx - ax, bz - az);
      const dir = Math.atan2(bx - ax, bz - az);
      const steps = Math.floor(len / 4.6);
      let gap = 0;
      for (let k = 0; k < steps; k++) {
        const t = k / steps;
        // Real boundaries have gateways and gappy stretches.
        if (gap > 0) { gap--; continue; }
        if (rng() < 0.05) { gap = 2 + Math.floor(rng() * 5); continue; }
        const x = lerp(ax, bx, t) + (rng() - 0.5) * 2.4;
        const z = lerp(az, bz, t) + (rng() - 0.5) * 2.4;
        const f = this._sampleField(x, z);
        if (f.d < 78) continue;                      // keep clear of the circuit
        if (this._inStructure(x, z)) continue;
        const dc = Math.hypot(x - this.centre.x, z - this.centre.z);
        if (dc > this.radius + 1500) continue;
        _v.set(x, this.terrainHeightAt(x, z) - 0.35, z);
        _q.setFromAxisAngle(UP, dir + (rng() - 0.5) * 0.10);
        const s = 0.85 + rng() * 0.45;
        _m.compose(_v, _q, _v2.set(s, s * (0.75 + rng() * 0.5), s));
        hedges.push(_m.clone());
      }
    };
    for (let gx = x0; gx <= x1; gx++) {
      const jx = gx * P + (rng() - 0.5) * 14;
      if (rng() < 0.14) continue;
      layHedge(jx, z0 * P, jx, z1 * P);
    }
    for (let gz = z0; gz <= z1; gz++) {
      const jz = gz * P + (rng() - 0.5) * 14;
      if (rng() < 0.14) continue;
      layHedge(x0 * P, jz, x1 * P, jz);
    }
    if (hedges.length) {
      const inst = new THREE.InstancedMesh(hedgeGeo, hedgeMat, hedges.length);
      hedges.forEach((m, i) => inst.setMatrixAt(i, m));
      inst.instanceMatrix.needsUpdate = true;
      inst.castShadow = true;
      inst.name = 'Hedgerows';
      group.add(inst);
    }

    // --- woodland masses ----------------------------------------------------
    /**
     * `variant` picks a different sub-window of the same canopy texture (and
     * mirrors half of them), so a handful of instanced draws give many distinct
     * silhouettes off one bake. Reusing one window is what made the old ridge
     * read as the same cauliflower stamped forty times.
     *
     * SIX windows, not four, and the aspect of each one differs: a card that is
     * both a different slice AND a different width-to-height ratio cannot be
     * recognised as the same stamp even when it is. The V half-angle varies with
     * it so the wrap is not a constant either.
     */
    const MASS_VARIANTS = 6;
    const massGeo = (w, h, key, variant) => assets.geometry(`env/mass-${key}-${variant}`, () => {
      const u0 = [0.00, 0.26, 0.48, 0.14, 0.36, 0.05][variant];
      const u1 = u0 + [0.44, 0.50, 0.52, 0.62, 0.38, 0.58][variant];
      const hs = [1.00, 0.88, 1.12, 0.94, 1.22, 0.80][variant];
      const bend = [0.28, 0.20, 0.36, 0.24, 0.15, 0.33][variant];
      const flip = variant & 1;
      const win = (g) => {
        const uv = g.attributes.uv;
        for (let i = 0; i < uv.count; i++) {
          const u = uv.getX(i);
          uv.setX(i, flip ? lerp(u1, u0, u) : lerp(u0, u1, u));
        }
        uv.needsUpdate = true;
        return g;
      };
      const a = win(new THREE.PlaneGeometry(w, h * hs)); a.translate(0, h * hs / 2, 0);
      // A shallow V, not a flat card: gives the block a hint of wrap so the
      // silhouette changes as the camera tracks past it.
      const l = a.clone(); l.rotateY(bend); l.translate(-w * 0.42, 0, 0);
      const r = a.clone(); r.rotateY(-bend); r.translate(w * 0.42, 0, 0);
      return mergeGeometries([a, l, r]);
    });
    const massMat = (key, o) => assets.material(`env/massMat-${key}`, () => aerialPerspective(
      new THREE.MeshStandardMaterial({
        map: treeMassTexture(`env/massTex-${key}`, o),
        alphaTest: 0.42, side: THREE.DoubleSide,
        roughness: 0.94, metalness: 0, envMapIntensity: 0.62, color: 0xffffff,
      }), { key: 'mass' }));

    // Two of the three bands are placed relative to the TRACK, not to a ring
    // around the circuit's centroid: a ring at `radius + 200 m` can sit a
    // kilometre from the nearest tarmac on a long circuit, which is why the
    // mid-field stayed empty while the horizon filled up.
    /**
     * DEPTH BANDS MUST BE VALUE-SEPARATED, AND THE OLD LADDER RAN BACKWARDS.
     * Tone means were near 1.01, mid 0.95, far 0.90 — i.e. the *near* wood was
     * the lightest, fighting the aerial perspective instead of setting it up.
     * All three then landed within 0.06 of each other on screen and every depth
     * cue in `wide` collapsed. Aerial perspective LIFTS distance, so the albedo
     * ladder has to descend toward the camera: near 0.66, mid 0.84, far 1.00.
     * The texture palettes desaturate along the same ladder.
     */
    /**
     * `tone` is now a NARROW per-band spread with a wide per-instance jitter on
     * top, not the other way round. The old ladder (near 0.55-0.79, far
     * 0.92-1.10) was doing the aerial perspective's job by hand — badly, because
     * a flat albedo multiplier cannot desaturate and cannot add blue, so lifting
     * the far band only made it a BRIGHTER saturated green. Depth now comes from
     * `aerialPerspective`, which is a function of the actual view distance; the
     * bands only carry the species difference (upland conifer reads cooler and
     * darker than lowland broadleaf) and `form` drops with distance so a
     * horizon wood stops cobbling into pebbles.
     */
    /**
     * `crown` is set so one blob subtends roughly what an 8 m tree crown does at
     * that band's typical viewing distance — see the note on it in
     * `treeMassTexture`. Card metres per texel: near 34/512 = 0.066, mid
     * 78/512 = 0.152, far 132/512 = 0.258, so the same 8 m crown wants radius
     * ~60, ~26 and ~15 texels respectively against a 5-20 base.
     */
    const bands = [
      { mode: 'track', r0: 190, r1: 520, n: 460, w: 34, h: 13, key: 'near', tex: { dark: [34, 43, 31], lit: [92, 103, 71], chew: 130, form: 1.00, hue: 0.13, crown: 2.30 }, tone: [0.60, 0.84] },
      { mode: 'track', r0: 380, r1: 1250, n: 300, w: 78, h: 21, key: 'mid', tex: { dark: [46, 56, 40], lit: [92, 103, 70], chew: 150, form: 0.86, hue: 0.26, crown: 1.70, blobs: 1150 }, tone: [0.62, 0.86] },
      { mode: 'ring', r0: 900, r1: 3400, n: 240, w: 132, h: 38, key: 'far', tex: { dark: [56, 66, 58], lit: [92, 101, 84], chew: 180, form: 0.64, hue: 0.20, crown: 1.35, blobs: 1500 }, tone: [0.68, 0.92] },
    ];
    const c = this.circuit;
    const n = c.samples.length;
    for (const bd of bands) {
      const mat = massMat(bd.key, bd.tex);
      const mats = [], tints = [];
      // Clumped: woods come in runs, so walk in order and keep a moving anchor.
      let ax = 0, az = 0, left = 0;
      for (let i = 0; i < bd.n; i++) {
        let x, z;
        if (left > 0) {
          left--;
          x = ax + (rng() - 0.5) * bd.w * 2.4;
          z = az + (rng() - 0.5) * bd.w * 2.4;
        } else if (bd.mode === 'track') {
          const si = Math.floor(((i + rng()) / bd.n) * n) % n;
          const sm = c.samples[si];
          const side = rng() < 0.5 ? -1 : 1;
          const out = this.corr.barrier[this._ci(si, side)] + lerp(bd.r0, bd.r1, Math.pow(rng(), 0.75));
          x = sm.position.x + sm.right.x * side * out + sm.tangent.x * (rng() - 0.5) * 120;
          z = sm.position.z + sm.right.z * side * out + sm.tangent.z * (rng() - 0.5) * 120;
          ax = x; az = z; left = 1 + Math.floor(rng() * 4);
        } else {
          const a = ((i + rng() * 0.85) / bd.n) * Math.PI * 2;
          const r = this.radius + lerp(bd.r0, bd.r1, Math.pow(rng(), 0.8));
          x = this.centre.x + Math.cos(a) * r;
          z = this.centre.z + Math.sin(a) * r;
          ax = x; az = z; left = 1 + Math.floor(rng() * 3);
        }
        // Clear of the circuit envelope, the paddock strip and the car parks.
        if (this._sampleField(x, z).d < 62) continue;
        if (this._inStructure(x, z)) continue;
        _v.set(x, this.terrainHeightAt(x, z) - bd.h * 0.06, z);
        // Face the circuit centre — the camera always lives inside the ring.
        _q.setFromAxisAngle(UP, Math.atan2(this.centre.x - x, this.centre.z - z) + (rng() - 0.5) * 0.7);
        const s = 0.72 + rng() * 0.66;
        _m.compose(_v, _q, _v2.set(s, s * (0.70 + rng() * 0.55), s));
        mats.push(_m.clone());
        // Per-instance value AND hue. +-9 % on red against -+13 % on blue swings
        // a stand between an autumnal beech and a cool spruce, which is what
        // stops forty cards off one bake reading as forty copies.
        const g = lerp(bd.tone[0], bd.tone[1], Math.pow(rng(), 0.8));
        const hj = (rng() - 0.5) * 2;
        tints.push(g * (1 + hj * 0.090), g * (1 - Math.abs(hj) * 0.020), g * (1 - hj * 0.130));
      }
      if (!mats.length) continue;
      // Round-robin the instances across the silhouette variants.
      for (let vi = 0; vi < MASS_VARIANTS; vi++) {
        const sel = [];
        for (let i = vi; i < mats.length; i += MASS_VARIANTS) sel.push(i);
        if (!sel.length) continue;
        const inst = new THREE.InstancedMesh(massGeo(bd.w, bd.h, bd.key, vi), mat, sel.length);
        const tc = new Float32Array(sel.length * 3);
        sel.forEach((src, k) => {
          inst.setMatrixAt(k, mats[src]);
          tc[k * 3] = tints[src * 3]; tc[k * 3 + 1] = tints[src * 3 + 1]; tc[k * 3 + 2] = tints[src * 3 + 2];
        });
        inst.instanceColor = new THREE.InstancedBufferAttribute(tc, 3);
        inst.instanceMatrix.needsUpdate = true;
        inst.instanceColor.needsUpdate = true;
        inst.name = `Woodland-${bd.key}-${vi}`;
        group.add(inst);
      }
    }
    setShadows(group, false, false);
    return group;
  }

  /**
   * Six real building archetypes, modelled at TRUE metric size.
   *
   * That matters: the old skyline was one unit cube stretched per instance, so
   * every façade sampled the same UV range whatever its size, every silhouette
   * was the same rectangle, and the whole ring collapsed into a single flat
   * cut-out. Modelling at real size means the window grid comes out at a
   * believable 2 m pitch on a 40 m block and on a 130 m tower alike, and the
   * roof clutter is in proportion.
   */
  _cityGeometry(kind) {
    return assets.geometry(`env/city-${kind}`, () => {
      const k = new Kit(1 / 8);
      if (kind === 0) {                                   // office slab
        k.box(34, 52, 22, { y: 26 });
        k.box(35.2, 1.1, 23.2, { y: 52.4, colour: 0xa9b0b6 });
        k.box(14, 3.4, 10, { y: 54.3, x: -5, colour: 0x99a0a6 });
        k.box(1.0, 7.0, 1.0, { y: 56.0, x: 9, colour: 0x8b9298 });
      } else if (kind === 1) {                            // stepped tower
        k.box(30, 34, 26, { y: 17 });
        k.box(24, 30, 21, { y: 49 });
        k.box(17, 26, 15, { y: 77 });
        k.box(18, 1.2, 16, { y: 90.4, colour: 0xa9b0b6 });
        k.cyl(0.55, 16, 6, { y: 98.5, colour: 0x8b9298 });
      } else if (kind === 2) {                            // warehouse / shed
        k.box(62, 11, 34, { y: 5.5, colour: 0xc4c7c2 });
        k.box(63.4, 1.6, 35.4, { y: 11.6, colour: 0x9ba1a5 });
        for (let i = -1; i <= 1; i++) {
          k.box(4.4, 1.1, 33, { x: i * 15, y: 12.5, colour: 0xb6bcc0 });
        }
        k.box(9, 4.2, 7, { x: 24, y: 2.1, colour: 0xb0b4b0 });
      } else if (kind === 3) {                            // silo cluster
        for (let i = 0; i < 4; i++) {
          k.cyl(4.6, 26, 12, { x: (i - 1.5) * 10.2, y: 13, colour: 0xcbcec8 });
          k.cyl(4.8, 1.4, 12, { x: (i - 1.5) * 10.2, y: 26.3, colour: 0x9ea4a8 });
        }
        k.box(44, 6, 12, { y: 3, z: 10, colour: 0xa8aca8 });
      } else if (kind === 4) {                            // chimney
        k.cyl(3.6, 78, 14, { y: 39, r2: 2.2 });
        for (let i = 0; i < 3; i++) k.cyl(2.55 + i * 0.28, 5.0, 14, { y: 66 - i * 18, colour: 0xb4623c });
        k.box(16, 9, 12, { y: 4.5, z: 9, colour: 0xa5a9a5 });
      } else if (kind === 6) {                            // suburban terrace row
        for (let i = 0; i < 7; i++) {
          const w = 8.5 + (i % 3) * 1.4;
          k.box(w, 7.2 + (i % 2) * 1.1, 10.5, { x: (i - 3) * 9.6, y: 3.6, colour: 0xb8b2a6 });
          // Pitched roof as two slabs — a flat-topped house reads as a bunker.
          k.box(w + 0.6, 0.35, 6.0, { x: (i - 3) * 9.6, y: 8.6, z: -2.5, rx: 0.52, colour: 0x7a6a5c });
          k.box(w + 0.6, 0.35, 6.0, { x: (i - 3) * 9.6, y: 8.6, z: 2.5, rx: -0.52, colour: 0x8b7b6c });
          k.box(0.9, 1.6, 0.9, { x: (i - 3) * 9.6 + 2.6, y: 10.6, colour: 0x9c8f80 });
        }
      } else if (kind === 7) {                            // saw-tooth factory
        k.box(74, 9.5, 40, { y: 4.75, colour: 0xb4b8b4 });
        for (let i = 0; i < 6; i++) {
          k.box(74, 0.4, 5.2, { y: 10.9, z: (i - 2.5) * 6.6 - 1.4, rx: 0.62, colour: 0xa2a8ac });
          k.box(74, 3.2, 0.3, { y: 11.1, z: (i - 2.5) * 6.6 + 1.6, colour: 0x6f7c85 });
        }
        k.cyl(2.4, 30, 12, { x: -30, y: 15, z: 16, r2: 1.9, colour: 0xc0bcb2 });
        k.box(16, 4.0, 9, { x: 30, y: 2.0, z: 24, colour: 0xaeb2ae });
      } else {                                            // glass high-rise
        k.box(23, 118, 23, { y: 59, colour: 0x9fb0bd });
        k.box(24.4, 1.4, 24.4, { y: 118.9, colour: 0xa9b0b6 });
        k.box(11, 5.0, 11, { y: 121.8, colour: 0x939aa0 });
        k.cyl(0.5, 22, 6, { y: 135.5, colour: 0x8b9298 });
        // A podium: towers meet the ground on something wider, and that is
        // most of what stops a skyline reading as sticks pushed into fog.
        k.box(38, 13, 34, { y: 6.5, colour: 0xb2b7ba });
      }
      return k.build();
    });
  }

  /** Facade: 4 bays x 4 floors per tile, with spandrels and reveals. */
  _facadeTexture() {
    return canvasTexture('env/facade', 256, 256, (ctx, w, h) => {
      const r = makeRng(hashSeed('facade'));
      ctx.fillStyle = '#b9bcbd';
      ctx.fillRect(0, 0, w, h);
      const bays = 4, floors = 4;
      const bw = w / bays, fh = h / floors;
      for (let f = 0; f < floors; f++) {
        // Spandrel band between floors.
        ctx.fillStyle = `rgb(${152 + Math.floor(r() * 14)},${156 + Math.floor(r() * 14)},${158 + Math.floor(r() * 14)})`;
        ctx.fillRect(0, f * fh, w, fh * 0.30);
        for (let b = 0; b < bays; b++) {
          const gx = b * bw + bw * 0.16, gy = f * fh + fh * 0.34;
          const gw = bw * 0.68, gh = fh * 0.52;
          const lit = 0.30 + r() * 0.42;
          ctx.fillStyle = `rgb(${Math.round(96 * lit + 34)},${Math.round(112 * lit + 40)},${Math.round(132 * lit + 48)})`;
          ctx.fillRect(gx, gy, gw, gh);
          // Reveal: the glass sits back from the frame, so it has a top shadow.
          ctx.fillStyle = 'rgba(0,0,0,0.28)';
          ctx.fillRect(gx, gy, gw, gh * 0.16);
          if (r() < 0.22) {                     // blind pulled down
            ctx.fillStyle = 'rgba(226,224,214,0.62)';
            ctx.fillRect(gx, gy, gw, gh * (0.25 + r() * 0.4));
          }
          ctx.fillStyle = 'rgba(255,255,255,0.14)';
          ctx.fillRect(gx + gw * 0.46, gy, Math.max(1, gw * 0.05), gh);
        }
      }
      // Vertical mullion line at every bay join.
      ctx.fillStyle = 'rgba(255,255,255,0.16)';
      for (let b = 0; b <= bays; b++) ctx.fillRect(b * bw - 1, 0, 2, h);
      // PILASTERS. A 256 px tile of window detail mips to a flat grey by 1 km,
      // so the towers on the horizon had no facade articulation at all. A
      // low-frequency vertical band survives the mip chain and is what reads as
      // "building" at 3 km.
      for (let b = 0; b < bays; b += 2) {
        ctx.fillStyle = 'rgba(255,255,255,0.11)';
        ctx.fillRect(b * bw, 0, bw * 0.30, h);
        ctx.fillStyle = 'rgba(28,34,40,0.13)';
        ctx.fillRect(b * bw + bw * 0.30, 0, bw * 0.14, h);
      }
      // Weathering streaks down the whole tile.
      ctx.globalAlpha = 0.10;
      for (let i = 0; i < 40; i++) {
        ctx.fillStyle = r() < 0.5 ? '#5c6166' : '#e6e8e6';
        ctx.fillRect(r() * w, 0, 1 + r() * 3, h);
      }
      ctx.globalAlpha = 1;
    });
  }

  /**
   * The skyline, in three depth bands.
   *
   * A city on the horizon is not a silhouette — it is a *sequence* of them,
   * each one hazier than the last, and it is the overlap between the bands that
   * reads as distance. One ring at one radius in one grey cannot do that, no
   * matter how good the aerial-perspective shader in front of it is.
   *
   * Everything sits on the real terrain height, sunk 2.5 m so no plinth ever
   * floats over a hillside, and the near band is deliberately close enough
   * (350–950 m) that the fog has not yet eaten its contrast.
   */
  _buildDistantBuildings() {
    const group = new THREE.Group();
    group.name = 'Skyline';
    const rng = this.rng;

    const facade = this._facadeTexture();
    const cityMaps = assets.get('env/cityMaps', () => setRepeat(cloneMaps(concrete({ stain: 0.4, key: 'city' })), 1, 1));
    const mat = assets.material('env/buildingMat', () => new THREE.MeshStandardMaterial({
      map: facade,
      normalMap: cityMaps.normalMap,
      roughnessMap: cityMaps.ormMap,
      normalScale: new THREE.Vector2(0.35, 0.35),
      vertexColors: true, color: 0xffffff,
      roughness: 0.86, metalness: 0.04, envMapIntensity: 0.9,
    }));

    // kinds, count, radius range, scale range, tone
    //
    // Band 0 is placed relative to the TRACK: an industrial estate and a housing
    // fringe 300–1100 m out, close enough that the haze has not eaten its
    // contrast, which is what gives the skyline behind it somewhere to stand.
    const bands = [
      // Wider per-building value spread than before (0.26 -> 0.40): what makes a
      // hazy skyline read as MANY towers rather than one silhouette is towers of
      // different albedo overlapping each other inside a band, not the band
      // means being far apart.
      { mode: 'track', kinds: [2, 7, 3, 6, 2, 6, 4], n: 130, r0: 260, r1: 1050, s0: 0.72, s1: 1.20, tone: [0.16, 0.34] },
      { mode: 'ring', kinds: [2, 2, 3, 4, 6, 7], n: 120, r0: 320, r1: 900, s0: 0.75, s1: 1.30, tone: [0.20, 0.36] },
      { mode: 'ring', kinds: [0, 1, 2, 0, 5, 3, 6], n: 170, r0: 800, r1: 1900, s0: 0.80, s1: 1.55, tone: [0.28, 0.40] },
      { mode: 'ring', kinds: [5, 1, 0, 5, 1], n: 110, r0: 1700, r1: 3600, s0: 1.35, s1: 2.6, tone: [0.40, 0.40] },
    ];
    const c = this.circuit;
    const nS = c.samples.length;

    for (let bi = 0; bi < bands.length; bi++) {
      const b = bands[bi];
      const buckets = new Map();
      for (let i = 0; i < b.n; i++) {
        const kind = b.kinds[Math.floor(rng() * b.kinds.length)];
        if (b.mode === 'track') {
          const si = Math.floor(((i + rng()) / b.n) * nS) % nS;
          const sm = c.samples[si];
          const side = rng() < 0.5 ? -1 : 1;
          const out = this.corr.barrier[this._ci(si, side)] + lerp(b.r0, b.r1, Math.pow(rng(), 0.8));
          _v.set(
            sm.position.x + sm.right.x * side * out + sm.tangent.x * (rng() - 0.5) * 200, 0,
            sm.position.z + sm.right.z * side * out + sm.tangent.z * (rng() - 0.5) * 200
          );
          // Never on top of the circuit, the paddock or a car park.
          if (this._sampleField(_v.x, _v.z).d < 190) continue;
        } else {
          // Jittered angular sequence: clusters and gaps, never a picket ring.
          const a = ((i + rng() * 0.9) / b.n) * Math.PI * 2;
          const r = this.radius + lerp(b.r0, b.r1, Math.pow(rng(), 0.7));
          _v.set(this.centre.x + Math.cos(a) * r, 0, this.centre.z + Math.sin(a) * r);
        }
        _v.y = this.terrainHeightAt(_v.x, _v.z) - 2.5;
        const s = lerp(b.s0, b.s1, Math.pow(rng(), 1.4));
        _v2.set(s * (0.82 + rng() * 0.42), s * (0.78 + rng() * 0.55), s * (0.82 + rng() * 0.42));
        _q.setFromAxisAngle(UP, rng() * Math.PI * 2);
        _m.compose(_v, _q, _v2);
        let list = buckets.get(kind);
        if (!list) buckets.set(kind, (list = { m: [], c: [] }));
        list.m.push(_m.clone());
        // Value spread is what makes a hazy skyline read as many buildings:
        // concrete, glass and rendered brick are two stops apart in real life.
        const g = b.tone[0] + rng() * b.tone[1];
        const cool = 0.94 + rng() * 0.16;
        list.c.push(g * (2.0 - cool) * 0.98, g, g * cool);
      }
      for (const [kind, list] of buckets) {
        const inst = new THREE.InstancedMesh(this._cityGeometry(kind), mat, list.m.length);
        inst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(list.c), 3);
        list.m.forEach((m, i) => inst.setMatrixAt(i, m));
        inst.instanceMatrix.needsUpdate = true;
        inst.instanceColor.needsUpdate = true;
        inst.name = `City${bi}-${kind}`;
        group.add(inst);
      }
    }
    setShadows(group, false, false);
    return group;
  }
}
