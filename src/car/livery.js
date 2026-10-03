/**
 * APEX GP — team liveries, body surface maps, numbers and decals.
 *
 * A livery is a 2048x1024 canvas painted in BODY-UV SPACE and used as the
 * `map` of the paint material. Because the chassis loft is unwrapped
 * consistently, painting here lands exactly where you expect on the car.
 *
 * BODY-UV SPACE
 *   u (canvas X, 0..1)  longitudinal: 0 = nose tip, 1 = rear crash structure.
 *                       Use `bodyU(z)` to convert a local Z into u.
 *   v (canvas Y, 0..1)  circumferential: 0.00 = car's RIGHT flank (mid-height)
 *                       0.25 = TOP, 0.50 = LEFT flank, 0.75 = FLOOR, 1.00 = right again.
 *
 * TWO THINGS THAT WILL BITE YOU
 *  1. v is a fraction of the SECTION PERIMETER, and the perimeter varies from
 *     ~0.2 m at the nose to ~1.9 m at the sidepods. So a band of constant dv is
 *     nine times wider mid-car than at the tail. `circumferenceAt(u)` exists so
 *     graphics and text can be sized in METRES and stay isotropic.
 *  2. THE RIGHT FLANK IS ROTATED 180 deg, NOT MIRRORED. Two independent flips
 *     stack there and it is very easy to fix only one of them:
 *       - v is the ring angle measured UP from +X, so on the right flank
 *         increasing v climbs the car while increasing canvas Y goes down:
 *         the texture is upside down on that side.
 *       - an observer on the right sees the nose on their right, so increasing
 *         u (nose -> tail) runs right-to-left on their screen.
 *     Two flips = a 180 deg rotation, so `face: 'right'` draws with
 *     `scale(-1, -1)`. Mirroring u alone leaves the glyphs vertically flipped,
 *     which is what "the sponsor reads backwards" actually looks like.
 *     `face: 'left'` is drawn as-is (v climbs with canvas Y there, and u runs
 *     left-to-right). `face: 'top'` is rotated -90 deg and reads from behind.
 *     `mirrorPoly` reflects v about 0.25, which is already correct for both.
 *
 * Beyond colour, this module bakes the SHARED body surface maps every team uses
 * — panel-line normals, an ORM with baked cavity AO plus dust/rubber pickup in
 * roughness, and a clearcoat map carrying swirl scratches and fingerprints.
 * Uniform roughness is what makes a render look like injection-moulded plastic.
 *
 * A specialist adding a new team only needs to append to `TEAMS`; supply
 * `team.paint(ctx, W, H, team, driver)` only for a fully bespoke design.
 */

import * as THREE from 'three';
import { assets, loft } from '../core/assets.js';
import { decalAtlas, decalAtlasUV } from '../textures/procedural.js';
import { fbm, makeRng, clamp, lerp, smoothstep } from '../core/rng.js';

/** Local Z of the nose tip and the tail — the ends of the u axis. */
export const BODY_Z0 = -3.00;
export const BODY_Z1 = 2.45;
export const BODY_LENGTH = BODY_Z1 - BODY_Z0;
export const bodyU = (z) => (z - BODY_Z0) / BODY_LENGTH;

/** v coordinates of the four cardinal points around a body section. */
export const BODY_V = { right: 0.0, top: 0.25, left: 0.5, bottom: 0.75 };

/** Livery canvas size. */
export const LIVERY_W = 2048;
export const LIVERY_H = 1024;

/**
 * The paint wraps from the right flank over the top to the left flank; below
 * `V_CARBON_LO` (left) / above `V_CARBON_HI` (right) the surface is exposed
 * carbon. The two limits are mirror images about v = 0.25.
 */
const V_CARBON_LO = 0.620;
const V_CARBON_HI = 0.880;

/** 2x supersample for the livery bake — see `buildLiveryTexture`. */
const LIVERY_SS = 2;

/**
 * Perimeter of the visible body section at a given u, in metres. Sampled off
 * the chassis lofts (monocoque up to the sidepod inlet, then the sidepod, which
 * is the surface you actually see from trackside).
 */
const CIRC_TABLE = [
  [0.00, 0.16], [0.08, 0.32], [0.16, 0.58], [0.25, 0.92], [0.33, 1.30],
  [0.44, 1.62], [0.52, 1.86], [0.62, 1.90], [0.72, 1.68], [0.80, 1.32],
  [0.88, 0.92], [0.94, 0.52], [1.00, 0.24],
];

export function circumferenceAt(u) {
  const t = clamp(u, 0, 1);
  for (let i = 1; i < CIRC_TABLE.length; i++) {
    if (t <= CIRC_TABLE[i][0]) {
      const [u0, c0] = CIRC_TABLE[i - 1];
      const [u1, c1] = CIRC_TABLE[i];
      return lerp(c0, c1, (t - u0) / (u1 - u0));
    }
  }
  return CIRC_TABLE[CIRC_TABLE.length - 1][1];
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------
//
// Ten fictional constructors. `style` selects one of the painters below;
// `tone` carries the per-team knobs that painter reads.

export const TEAMS = [
  {
    id: 'apex', name: 'Apex Grand Prix', short: 'APX',
    primary: '#c8102e', basecoat: '#7e1f27', secondary: '#0e1014', accent: '#ffd400', metallic: 0.30,
    style: 'flash', tone: { nose: '#0e1014', spine: 0.95, pinstripe: 0.020, tail: '#c8102e' },
    drivers: [{ name: 'RENZO', code: 'REN', number: 16 }, { name: 'VOSS', code: 'VOS', number: 55 }],
  },
  {
    id: 'meridian', name: 'Meridian Works', short: 'MER',
    primary: '#00b3a4', secondary: '#101418', accent: '#d8ff3a', metallic: 0.42,
    style: 'wave', tone: { nose: '#101418', crest: 0.34, tail: '#101418' },
    drivers: [{ name: 'HALVORSEN', code: 'HAL', number: 44 }, { name: 'OKORO', code: 'OKO', number: 63 }],
  },
  {
    id: 'oryx', name: 'Oryx Motorsport', short: 'ORX',
    primary: '#0a1f52', secondary: '#0a0d14', accent: '#e8232a', metallic: 0.26,
    style: 'wedge', tone: { nose: '#e8232a', wedge: '#132f77', tail: '#0a1f52' },
    drivers: [{ name: 'VERSTRAETE', code: 'VER', number: 1 }, { name: 'PEREZ-LIN', code: 'PLN', number: 11 }],
  },
  {
    id: 'sierra', name: 'Sierra Corse', short: 'SIE',
    primary: '#f45c0a', secondary: '#15181d', accent: '#f2f4f7', metallic: 0.24,
    style: 'split', tone: { nose: '#f45c0a', split: 0.63, tail: '#15181d' },
    drivers: [{ name: 'NORVILLE', code: 'NOR', number: 4 }, { name: 'PIASTRE', code: 'PIA', number: 81 }],
  },
  {
    id: 'astra', name: 'Astra Racing', short: 'AST',
    primary: '#00544a', secondary: '#0b1412', accent: '#c6ff2e', metallic: 0.36,
    style: 'panel', tone: { nose: '#0b1412', panel: '#00544a', tail: '#00544a' },
    drivers: [{ name: 'ALONZO', code: 'ALO', number: 14 }, { name: 'STROUD', code: 'STR', number: 18 }],
  },
  {
    id: 'volta', name: 'Volta Squadra', short: 'VLT',
    primary: '#1141c8', secondary: '#0a0f1c', accent: '#f2c200', metallic: 0.30,
    style: 'chevron', tone: { nose: '#0a0f1c', chevron: '#ff2e88', tail: '#1141c8' },
    drivers: [{ name: 'GASTON', code: 'GAS', number: 10 }, { name: 'TSUKI', code: 'TSU', number: 22 }],
  },
  {
    id: 'nimbus', name: 'Nimbus F1', short: 'NIM',
    primary: '#e3e7ec', secondary: '#12233f', accent: '#0aa3ff', metallic: 0.34,
    style: 'split', tone: { nose: '#12233f', split: 0.40, invert: true, tail: '#12233f' },
    drivers: [{ name: 'ALBIN', code: 'ALB', number: 23 }, { name: 'SARGENT', code: 'SAR', number: 2 }],
  },
  {
    id: 'kestrel', name: 'Kestrel Racing', short: 'KES',
    primary: '#a3186f', secondary: '#12080f', accent: '#ff8fd0', metallic: 0.32,
    style: 'chevron', tone: { nose: '#12080f', chevron: '#ff8fd0', tail: '#a3186f' },
    drivers: [{ name: 'BOTTOMLEY', code: 'BOT', number: 77 }, { name: 'ZHAO', code: 'ZHA', number: 24 }],
  },
  {
    id: 'halcyon', name: 'Halcyon Motors', short: 'HAL',
    primary: '#30343c', secondary: '#0b0d10', accent: '#ff5c00', metallic: 0.55,
    style: 'panel', tone: { nose: '#ff5c00', panel: '#4a5058', tail: '#30343c' },
    drivers: [{ name: 'MAGNUS', code: 'MAG', number: 20 }, { name: 'HULKE', code: 'HUL', number: 27 }],
  },
  {
    id: 'zephyr', name: 'Zephyr GP', short: 'ZEP',
    primary: '#4fb2ee', secondary: '#0c1116', accent: '#122f6b', metallic: 0.38,
    style: 'wave', tone: { nose: '#f2f4f7', crest: 0.30, tail: '#122f6b' },
    drivers: [{ name: 'RICCI', code: 'RIC', number: 3 }, { name: 'DEVRIES', code: 'DEV', number: 21 }],
  },
];

export function teamById(id) { return TEAMS.find((t) => t.id === id) ?? TEAMS[0]; }

/** All 20 entries in championship order: { team, driver, number, index, seat }. */
export function fullGrid() {
  const out = [];
  TEAMS.forEach((team, ti) => {
    team.drivers.forEach((driver, di) => {
      out.push({ team, driver, number: driver.number, index: ti * 2 + di, seat: di });
    });
  });
  return out;
}

// Fictional sponsor wordmarks. Two tiers: a title partner that gets the big
// sidepod block, and fillers for the small patches.
const TITLE_SPONSORS = ['NITRON', 'ORBIT DYNAMICS', 'KAPPA', 'HELIOS', 'VANTA', 'QUARTZ', 'ZENITH', 'ARGON', 'MERIDIAN OIL', 'CRUX'];
const FILL_SPONSORS = ['VOLT', 'HYDRA', 'AXION', 'PRIME', 'NOVA', 'DELTA', 'FLUX', 'CIRRUS', 'ONYX', 'RIFT', 'SABLE', 'TERRA'];

// ---------------------------------------------------------------------------
// Canvas helpers
// ---------------------------------------------------------------------------

function makeCanvas(w, h) {
  const c = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });
  c.width = w; c.height = h;
  return c;
}

function dataTex(bytes, w, h, colorSpace) {
  const t = new THREE.DataTexture(bytes, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = colorSpace;
  t.wrapS = THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 16;
  t.flipY = false;   // authored in body-UV space, same as the livery canvas
  t.needsUpdate = true;
  return t;
}

/** Sobel a height field into a tangent-space normal map (OpenGL +Y). */
function heightToNormal(h, w, hh, strength) {
  const px = new Uint8Array(w * hh * 4);
  const at = (x, y) => h[(((y % hh) + hh) % hh) * w + (((x % w) + w) % w)];
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
               - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))
               - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      let nx = -dx * strength, ny = -dy * strength, nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      const i = (y * w + x) * 4;
      px[i] = (nx * inv * 0.5 + 0.5) * 255;
      px[i + 1] = (ny * inv * 0.5 + 0.5) * 255;
      px[i + 2] = (nz * inv * 0.5 + 0.5) * 255;
      px[i + 3] = 255;
    }
  }
  return px;
}

/** Unit-height gaussian falloff; `d` is a signed distance, `s` the half width. */
const gauss = (d, s) => Math.exp(-(d / s) * (d / s));

/** Bilinear lookup into a small float grid — cheap large-scale noise. */
function gridSample(grid, gw, gh, u, v) {
  const x = u * gw - 0.5, y = v * gh - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const wrap = (a, n) => ((a % n) + n) % n;
  const i00 = wrap(y0, gh) * gw + wrap(x0, gw);
  const i10 = wrap(y0, gh) * gw + wrap(x0 + 1, gw);
  const i01 = wrap(y0 + 1, gh) * gw + wrap(x0, gw);
  const i11 = wrap(y0 + 1, gh) * gw + wrap(x0 + 1, gw);
  return lerp(lerp(grid[i00], grid[i10], fx), lerp(grid[i01], grid[i11], fx), fy);
}

// ---------------------------------------------------------------------------
// The painter — everything is expressed in (u, v), sized in metres
// ---------------------------------------------------------------------------

/**
 * Wraps a 2D context with body-UV drawing primitives.
 *
 * Every draw is emitted three times (v, v-1, v+1) so shapes that straddle the
 * right-flank seam at v = 0 appear on both halves of the canvas.
 */
function makePainter(ctx, W, H) {
  const X = (u) => u * W;
  const Y = (v) => v * H;
  // Derived from the PASSED width, not from LIVERY_W: the bake runs the painter
  // at 2x into an offscreen canvas and downsamples, so every metres-to-pixels
  // conversion has to follow the canvas it is actually drawing on. A module-level
  // constant here silently halves `squash` under supersampling and stretches
  // every wordmark on the car.
  const pxPerMU = W / BODY_LENGTH;

  const wrapped = (fn) => { for (const dy of [0, -H, H]) { ctx.save(); ctx.translate(0, dy); fn(); ctx.restore(); } };

  const path = (pts) => {
    ctx.beginPath();
    pts.forEach(([u, v], i) => (i ? ctx.lineTo(X(u), Y(v)) : ctx.moveTo(X(u), Y(v))));
    ctx.closePath();
  };

  return {
    ctx, W, H, X, Y,
    /** Axis-aligned band in (u, v). */
    band(u0, u1, v0, v1, fill) {
      ctx.fillStyle = fill;
      wrapped(() => ctx.fillRect(X(u0), Y(v0), X(u1) - X(u0), Y(v1) - Y(v0)));
    },
    /** Polygon in (u, v). */
    poly(pts, fill) {
      ctx.fillStyle = fill;
      wrapped(() => { path(pts); ctx.fill(); });
    },
    /** Polygon plus its mirror image about the top centreline (v = 0.25). */
    mirrorPoly(pts, fill) {
      this.poly(pts, fill);
      this.poly(pts.map(([u, v]) => [u, 0.5 - v]), fill);
    },
    /** Soft longitudinal gradient band — used for shading, never for hard edges. */
    gradientBand(u0, u1, v0, v1, stops) {
      const g = ctx.createLinearGradient(X(u0), 0, X(u1), 0);
      for (const [t, c] of stops) g.addColorStop(t, c);
      this.band(u0, u1, v0, v1, g);
    },
    /** Vertical (circumferential) gradient — the shoulder-to-underside falloff. */
    gradientV(u0, u1, v0, v1, stops) {
      const g = ctx.createLinearGradient(0, Y(v0), 0, Y(v1));
      for (const [t, c] of stops) g.addColorStop(t, c);
      this.band(u0, u1, Math.min(v0, v1), Math.max(v0, v1), g);
    },
    /**
     * Text on the body. `face` picks the orientation fix-up:
     *   'right' rotated 180 deg (see the header — u AND v are both flipped
     *   there), 'left' as drawn, 'top' rotated -90 deg.
     * `metres` is the CAP HEIGHT in real metres, so text stays the same
     * physical size wherever it lands on a wildly anisotropic unwrap.
     *
     * `maxMetres` is the width budget ALONG THE SURFACE. Pass it for anything
     * whose length depends on data (a driver surname, a constructor name, a
     * sponsor wordmark inside a patch) and the cap height shrinks to fit instead
     * of running off the end of its block. A wordmark that overflows its white
     * patch is exactly what reads as garbled or clipped lettering — 'ORBIT
     * DYNAMICS' at 14 characters needed 0.64 m inside a 0.62 m patch.
     */
    text(u, v, str, o = {}) {
      const { face = 'left', metres = 0.10, colour = '#ffffff', weight = 800,
        spacing = 0, align = 'center', italic = false, alpha = 1, maxMetres = 0 } = o;
      const pxV = H / circumferenceAt(u);
      let size = face === 'top' ? metres * pxPerMU : metres * pxV;
      const squash = face === 'top' ? pxV / pxPerMU : pxPerMU / pxV;
      const font = (s) => `${italic ? 'italic ' : ''}${weight} ${s.toFixed(1)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
      ctx.save();
      ctx.letterSpacing = `${(spacing * size).toFixed(1)}px`;
      ctx.font = font(size);
      if (maxMetres > 0) {
        // Drawn extent runs along u for the flanks and along v on the top deck;
        // after `scale(squash, 1)` a measured px width lands on the surface as
        // measure * squash / (px per metre in the drawn direction).
        const perM = face === 'top' ? pxV : pxPerMU;
        const drawnM = (ctx.measureText(str).width * squash) / perM;
        if (drawnM > maxMetres) {
          size *= maxMetres / drawnM;
          ctx.letterSpacing = `${(spacing * size).toFixed(1)}px`;
          ctx.font = font(size);
        }
      }
      ctx.globalAlpha = alpha;
      ctx.textAlign = align;
      ctx.textBaseline = 'middle';
      ctx.fillStyle = colour;
      wrapped(() => {
        ctx.translate(X(u), Y(v));
        // 'right' needs BOTH flips (u reversed by the viewpoint, v reversed by
        // the ring winding) — that is a 180 deg rotation, not a mirror.
        if (face === 'right') ctx.scale(-1, -1);
        else if (face === 'top') ctx.rotate(-Math.PI / 2);
        ctx.scale(squash, 1);
        ctx.fillText(str, 0, 0);
      });
      ctx.restore();
    },
    /** Symmetric pair of flank marks (right mirrored, left as drawn). */
    flankText(u, dv, str, o = {}) {
      this.text(u, 0.25 - dv, str, { ...o, face: 'right' });
      this.text(u, 0.25 + dv, str, { ...o, face: 'left' });
    },
    /** Sponsor patch: a rounded block with a wordmark, sized in metres. */
    patch(u, v, wM, hM, label, o = {}) {
      const { bg = '#f2f4f7', fg = '#101216', face = 'left', weight = 800 } = o;
      const pxV = H / circumferenceAt(u);
      const dv = (hM * pxV) / H / 2;
      const du = (wM * pxPerMU) / W / 2;
      const r = Math.min(du, dv) * 0.28;
      ctx.save();
      ctx.fillStyle = bg;
      wrapped(() => {
        ctx.beginPath();
        ctx.roundRect(X(u - du), Y(v - dv), X(2 * du), Y(2 * dv), [X(r), Y(r)]);
        ctx.fill();
      });
      ctx.restore();
      this.text(u, v, label, {
        face, metres: hM * 0.46, colour: fg, weight, spacing: 0.04,
        maxMetres: wM * 0.86,
      });
    },
    /** Same patch on both flanks. */
    flankPatch(u, dv, wM, hM, label, o = {}) {
      this.patch(u, 0.25 - dv, wM, hM, label, { ...o, face: 'right' });
      this.patch(u, 0.25 + dv, wM, hM, label, { ...o, face: 'left' });
    },
  };
}

// ---------------------------------------------------------------------------
// Style painters — the base coat and secondary graphics
// ---------------------------------------------------------------------------

const STYLES = {
  /** Single strong colour, dark spine, thin accent pinstripe along the shoulder. */
  flash(p, team) {
    const { primary, secondary, accent, tone } = team;
    p.band(0, 1, 0, 1, primary);
    p.band(0, 0.115, 0, 1, tone.nose ?? secondary);
    p.gradientBand(0.10, 0.20, 0, 1, [[0, tone.nose ?? secondary], [1, primary]]);
    // Dark engine-cover spine, tapering out over the airbox.
    p.mirrorPoly([[0.55, 0.250], [0.63, 0.190], [0.86, 0.166], [1.00, 0.180],
      [1.00, 0.250]], secondary);
    // Accent pinstripe running the length of the shoulder line.
    p.mirrorPoly([[0.11, 0.176], [0.42, 0.128], [0.72, 0.120], [1.00, 0.150],
      [1.00, 0.150 + tone.pinstripe], [0.72, 0.120 + tone.pinstripe],
      [0.42, 0.128 + tone.pinstripe], [0.11, 0.176 + tone.pinstripe]], accent);
    p.mirrorPoly([[0.00, 0.24], [0.09, 0.14], [0.09, 0.36], [0.00, 0.26]], accent);
  },

  /** Dark upper "cape" with a wavy lower boundary, accent crest line. */
  wave(p, team) {
    const { primary, secondary, accent, tone } = team;
    p.band(0, 1, 0, 1, primary);
    p.band(0, 0.10, 0, 1, tone.nose ?? secondary);
    p.gradientBand(0.09, 0.19, 0, 1, [[0, tone.nose ?? secondary], [1, primary]]);
    const c = tone.crest ?? 0.32;
    const cape = [
      [0.10, 0.250], [0.20, 0.196], [0.32, 0.150], [0.46, 0.128],
      [0.58, 0.152], [0.70, 0.118], [0.84, 0.150], [1.00, 0.182], [1.00, 0.250],
    ];
    p.mirrorPoly(cape, secondary);
    p.mirrorPoly(cape.map(([u, v], i) => (i < cape.length - 2 ? [u, v + 0.016] : [u, v])), accent);
    p.mirrorPoly(cape, secondary === accent ? primary : secondary);
    // Accent flick off the sidepod leading edge.
    p.mirrorPoly([[0.42, 0.02], [0.56, 0.05], [0.62, 0.10], [0.56, 0.09], [0.42, 0.06]], accent);
    void c;
  },

  /** Dark base with a big saturated wedge across the sidepod. */
  wedge(p, team) {
    const { primary, secondary, accent, tone } = team;
    p.band(0, 1, 0, 1, primary);
    p.band(0, 1, 0.16, 0.34, secondary);
    p.band(0, 0.13, 0, 1, tone.nose ?? accent);
    p.gradientBand(0.12, 0.22, 0, 1, [[0, tone.nose ?? accent], [1, primary]]);
    p.mirrorPoly([[0.30, 0.250], [0.52, 0.030], [0.74, 0.060], [0.80, 0.250]], tone.wedge ?? primary);
    p.mirrorPoly([[0.44, 0.250], [0.56, 0.075], [0.62, 0.086], [0.56, 0.250]], accent);
    p.mirrorPoly([[0.66, 0.250], [0.72, 0.098], [0.76, 0.104], [0.74, 0.250]], accent);
    p.mirrorPoly([[0.86, 0.250], [0.90, 0.150], [1.00, 0.170], [1.00, 0.250]], accent);
  },

  /** Front/rear colour split on a swept diagonal. */
  split(p, team) {
    const { primary, secondary, accent, tone } = team;
    const front = tone.invert ? secondary : primary;
    const rear = tone.invert ? primary : secondary;
    p.band(0, 1, 0, 1, front);
    const s = tone.split ?? 0.55;
    p.mirrorPoly([[s - 0.10, 0.250], [s + 0.02, 0.02], [1.00, 0.02], [1.00, 0.250]], rear);
    p.mirrorPoly([[s - 0.115, 0.250], [s + 0.005, 0.02], [s + 0.030, 0.02], [s - 0.090, 0.250]], accent);
    p.band(0, 0.10, 0, 1, tone.nose ?? primary);
    p.gradientBand(0.09, 0.18, 0, 1, [[0, tone.nose ?? primary], [1, front]]);
    // Rear-wing-adjacent flash so the tail is not a dead slab.
    p.mirrorPoly([[0.88, 0.250], [0.92, 0.150], [1.00, 0.170], [1.00, 0.250]], accent);
  },

  /** Dark base with a lighter structural panel over the sidepod and cover. */
  panel(p, team) {
    const { primary, secondary, accent, tone } = team;
    p.band(0, 1, 0, 1, secondary);
    p.band(0, 1, 0.19, 0.31, primary);
    p.mirrorPoly([[0.36, 0.250], [0.44, 0.055], [0.78, 0.070], [0.82, 0.250]], tone.panel ?? primary);
    p.band(0, 0.12, 0, 1, tone.nose ?? primary);
    p.gradientBand(0.11, 0.21, 0, 1, [[0, tone.nose ?? primary], [1, secondary]]);
    p.mirrorPoly([[0.44, 0.055], [0.78, 0.070], [0.78, 0.088], [0.44, 0.073]], accent);
    p.mirrorPoly([[0.12, 0.20], [0.36, 0.176], [0.36, 0.192], [0.12, 0.216]], accent);
  },

  /** Bold chevrons marching down the sidepod. */
  chevron(p, team) {
    const { primary, secondary, accent, tone } = team;
    p.band(0, 1, 0, 1, primary);
    p.band(0, 0.12, 0, 1, tone.nose ?? secondary);
    p.gradientBand(0.11, 0.20, 0, 1, [[0, tone.nose ?? secondary], [1, primary]]);
    p.mirrorPoly([[0.52, 0.250], [0.62, 0.020], [1.00, 0.020], [1.00, 0.250]], secondary);
    const ch = tone.chevron ?? accent;
    for (let i = 0; i < 3; i++) {
      const u0 = 0.30 + i * 0.075;
      p.mirrorPoly([
        [u0, 0.250], [u0 + 0.10, 0.045], [u0 + 0.145, 0.045], [u0 + 0.045, 0.250],
      ], i === 1 ? accent : ch);
    }
    p.mirrorPoly([[0.70, 0.250], [0.76, 0.100], [0.80, 0.104], [0.76, 0.250]], accent);
  },
};

// ---------------------------------------------------------------------------
// Shared markings: numbers, driver identity, sponsors, panel breaks
// ---------------------------------------------------------------------------

function paintMarkings(p, team, driver, seat) {
  const A = team.accent;
  const number = String(driver?.number ?? team.drivers[0].number);
  const light = pickReadable(team, ['#ffffff', '#f2f4f7']);
  const rng = makeRng(`livery/${team.id}`);

  // Exposed carbon underside: the paint stops at the floor line. Painted here
  // rather than in the style painters so every team gets it.
  p.band(0, 1, V_CARBON_LO, V_CARBON_HI, '#111318');
  p.gradientV(0, 1, V_CARBON_LO - 0.055, V_CARBON_LO + 0.004,
    [[0, 'rgba(12,13,17,0)'], [1, 'rgba(12,13,17,0.92)']]);
  p.gradientV(0, 1, V_CARBON_HI + 0.055, V_CARBON_HI - 0.004,
    [[0, 'rgba(12,13,17,0)'], [1, 'rgba(12,13,17,0.92)']]);

  // Car number — sidepod flank (the big trackside read) and engine-cover top.
  //
  // LAYOUT IS LOAD BEARING HERE, and it was wrong twice. A 260 mm numeral is
  // 0.057 of u wide and 0.137 of v tall, so it collides with anything nearby:
  //   - the flank number sat at u = 0.505 and the title-sponsor patch at 0.573
  //     spanned 0.516..0.630, so the patch was painted straight over the second
  //     digit. That is the "clipped decal" in the review — not a UV bug, just two
  //     graphics on top of each other, with the patch drawn last.
  //   - the top-deck number at u = 0.775 spanned 0.751..0.799 and the constructor
  //     wordmark at 0.800 spanned 0.755..0.845, so they crossed as well.
  // The number moves forward on both faces and the sponsors move aft. Every
  // wordmark below now also carries a `maxMetres` budget, so a longer team or
  // driver name shrinks instead of growing back into these gaps.
  p.flankText(0.480, 0.235, number, { metres: 0.26, colour: light, weight: 900 });
  p.text(0.715, BODY_V.top, number, { face: 'top', metres: 0.26, colour: light, weight: 900 });

  // Driver identity. Surname above the sidepod inlet, code by the cockpit.
  // `maxMetres` everywhere the string is data: PEREZ-LIN and VERSTRAETE are
  // nearly twice the width of ZHAO at the same cap height.
  p.flankText(0.470, 0.108, driver?.name ?? team.short, {
    metres: 0.056, colour: light, weight: 700, spacing: 0.10, maxMetres: 0.62,
  });
  // The three-letter code sat at dv 0.126, which puts it at v = 0.376 — exactly
  // where the `flash` accent pinstripe runs (v 0.377..0.397 at this u) and where
  // the `wave` cape edge crosses. It was accent-coloured text drawn on top of an
  // accent-coloured stripe, i.e. invisible, and the fragments that did show
  // through the antialiasing is what read as garbled lettering. dv 0.098 sits it
  // just above the shoulder line on every style, next to the surname.
  p.flankText(0.628, 0.098, driver?.code ?? team.short, {
    metres: 0.072, colour: A, weight: 900, spacing: 0.06, italic: true, maxMetres: 0.30,
  });

  // Seat marker: F1 distinguishes team-mates by the onboard-camera colour, so
  // mirror that with a coloured tab on the airbox shoulder.
  p.mirrorPoly([[0.60, 0.212], [0.68, 0.206], [0.68, 0.226], [0.60, 0.232]],
    seat === 0 ? '#111318' : '#f2c200');

  // Constructor wordmark along the engine cover. Budget is short here — u = 0.80
  // is already inside the coke-bottle taper, so anything wider wraps around onto
  // a surface the camera cannot see and reads as truncated.
  p.flankText(0.800, 0.075, team.name.toUpperCase(), {
    metres: 0.048, colour: light, weight: 700, spacing: 0.10, maxMetres: 0.66,
  });

  // Sponsors. Title partner on the sidepod, fillers scattered on real estate a
  // photographer would actually see.
  // BY ID, NOT BY IDENTITY. `buildLiveryTexture` hands the painters a derived
  // team (see `basecoatTeam`), so an `indexOf` here returns -1, the modulo of a
  // negative index returns undefined and every sponsor patch on the car paints
  // the literal word "undefined".
  const ti = Math.max(0, TEAMS.findIndex((t) => t.id === team.id));
  const title = TITLE_SPONSORS[(ti * 3 + 1) % TITLE_SPONSORS.length];
  p.flankPatch(0.605, 0.196, 0.60, 0.155, title, { bg: light, fg: '#101216' });
  // Nose top. `maxMetres` on a 'top' face is measured around the CIRCUMFERENCE,
  // and at u = 0.15 the whole section perimeter is only 0.55 m — 'ORBIT DYNAMICS'
  // at 75 mm cap wanted 0.69 m and wrapped right over both flanks and back onto
  // itself, which is the scrambled-letters failure the review saw.
  p.text(0.150, BODY_V.top, title, { face: 'top', metres: 0.075, colour: light, weight: 800, spacing: 0.06, maxMetres: 0.34 });

  const fills = [0, 1, 2, 3, 4].map((i) => FILL_SPONSORS[Math.floor(rng() * FILL_SPONSORS.length + i * 2.7) % FILL_SPONSORS.length]);
  p.flankPatch(0.712, 0.196, 0.34, 0.090, fills[0], { bg: '#101216', fg: light });
  p.flankPatch(0.398, 0.176, 0.30, 0.085, fills[1], { bg: A, fg: '#101216' });
  p.text(0.885, BODY_V.top, fills[2], { face: 'top', metres: 0.055, colour: light, weight: 800, spacing: 0.05, maxMetres: 0.30 });
  p.flankText(0.290, 0.128, fills[3], { metres: 0.052, colour: light, weight: 800, spacing: 0.06, maxMetres: 0.36 });
  p.flankText(0.800, 0.150, fills[4], { metres: 0.045, colour: light, weight: 800, spacing: 0.06, maxMetres: 0.32 });

  // Statutory-looking small print, the kind of thing that fills a real car. 26 mm
  // of cap height is 14 texels at 2048 — below what a rasteriser can keep clean
  // even supersampled — so it goes to 32 mm and loses the letter spacing that was
  // pushing it 1.1 m along a nose section only 0.9 m of perimeter wide.
  p.flankText(0.245, 0.060, 'APEX GP WORLD CHAMPIONSHIP', {
    metres: 0.032, colour: 'rgba(255,255,255,0.55)', weight: 600, spacing: 0.05,
    maxMetres: 0.86,
  });

  // Painted panel breaks. Thin, low contrast — the normal map carries the
  // actual relief; this is just the shadow line in the paint.
  p.ctx.save();
  p.ctx.globalAlpha = 0.20;
  p.ctx.strokeStyle = '#05070a';
  p.ctx.lineWidth = Math.max(1.5, p.W * 0.0011);
  for (const u of PANEL_LINES) {
    p.ctx.beginPath();
    p.ctx.moveTo(p.X(u), 0);
    p.ctx.lineTo(p.X(u), p.H);
    p.ctx.stroke();
  }
  p.ctx.restore();
}

/** The longitudinal panel joints, shared by the albedo and the normal bake. */
const PANEL_LINES = [0.108, 0.253, 0.428, 0.560, 0.712, 0.868, 0.938];

/** Choose whichever of `options` contrasts best with the team's base coat. */
function pickReadable(team, options) {
  const lum = (hex) => {
    const n = parseInt(hex.slice(1), 16);
    return (0.2126 * (n >> 16 & 255) + 0.7152 * (n >> 8 & 255) + 0.0722 * (n & 255)) / 255;
  };
  return lum(team.primary) > 0.62 ? '#12161c' : options[0];
}

/** Default painter: base style, then the markings every car must carry. */
function paintDefault(ctx, W, H, team, driver, seat = 0) {
  const p = makePainter(ctx, W, H);
  (STYLES[team.style] ?? STYLES.flash)(p, team);
  paintMarkings(p, team, driver, seat);
}

// ---------------------------------------------------------------------------
// Livery texture
// ---------------------------------------------------------------------------

/**
 * Build (and cache) the livery albedo for a team/driver pair.
 * @returns {THREE.CanvasTexture} sRGB, flipY = false, ClampToEdge u / Repeat v.
 */
/**
 * THE BRAND COLOUR IS NOT A REFLECTANCE, and conflating the two is what has made
 * the flank read as flat vector art for three rounds.
 *
 * `team.primary` is a display colour. It is the right thing for the HUD dot, the
 * timing tower, the front end and the trackside hoardings, and every one of those
 * consumers reads it directly. It is the WRONG thing to paint a car with:
 * #c8102e is 0.578 linear in red against 0.005 in green, and once a sunlit
 * diffuse term and a metallic-basecoat specular are stacked on top of it the red
 * channel leaves the top of the range and the green channel never leaves the
 * bottom. Measured on `tv`, sidepod flank (560,480,400,100), of the pixels that
 * are recognisably red bodywork:
 *
 *     r5 shipped        70.2 % at R >= 250, 73.1 % at G <= 6, mean 229.8/17.2/15.8
 *
 * A specular highlight is then MATHEMATICALLY INVISIBLE — there is no headroom
 * above the base colour for the sky band to occupy and no room below it for the
 * inverted-tarmac band — which is why retuning `envMapIntensity`, `metalness`
 * and the clearcoat in turn each moved the flank by about one code value.
 *
 * `basecoat` is the paint's actual reflectance: the same hue, taken down to
 * ~0.36 of the linear red so the specular has somewhere to go, with the green
 * lifted 2.6x off zero so the dark half of the reflection has somewhere to go
 * too. Only the BASE COAT is trimmed — sponsor whites, the black spine and the
 * accent yellow are unchanged, because those are not what is clipping.
 *
 * Teams without a `basecoat` are painted exactly as before.
 */
function basecoatTeam(team) {
  if (!team.basecoat) return team;
  const t = { ...team, primary: team.basecoat };
  if (team.tone) {
    t.tone = { ...team.tone };
    // A `tone` slot that repeated the brand colour is base coat too (apex's
    // `tail`); one that names its own colour is a graphic and is left alone.
    for (const k of Object.keys(t.tone)) {
      if (t.tone[k] === team.primary) t.tone[k] = team.basecoat;
    }
  }
  return t;
}

export function buildLiveryTexture(team, driver, seat) {
  const key = `livery/${team.id}/${driver?.number ?? 0}`;
  const s = seat ?? Math.max(0, team.drivers.indexOf(driver));
  return assets.texture(key, () => {
    // SUPERSAMPLE. Canvas2D antialiases a glyph against its own destination
    // pixels only, so 26 mm statutory small print — 14 px of cap height at 2048
    // wide, squashed 0.70 in x on the flanks — came out of the rasteriser already
    // fringed, and then went through mip generation and anisotropic filtering on
    // top. Painting at 2x and box-downsampling gives every edge on the car
    // (glyphs, patch corners, chevron diagonals) 4 samples per output texel for
    // the cost of one transient canvas per bake and ZERO extra VRAM — which is
    // why this is the fix rather than doubling LIVERY_W/H, at 20 cars x 32 MB.
    const SW = LIVERY_W * LIVERY_SS, SH = LIVERY_H * LIVERY_SS;
    const big = makeCanvas(SW, SH);
    (team.paint ?? paintDefault)(big.getContext('2d'), SW, SH, basecoatTeam(team), driver, s);

    const canvas = makeCanvas(LIVERY_W, LIVERY_H);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(big, 0, 0, SW, SH, 0, 0, LIVERY_W, LIVERY_H);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.flipY = false;   // canvas Y maps straight to v; see BODY-UV SPACE above
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 16;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.needsUpdate = true;
    return tex;
  });
}

// ---------------------------------------------------------------------------
// Shared body surface maps
// ---------------------------------------------------------------------------

/**
 * Grime layer: swirl scratches, fingerprints, dust wash and rubber pickup,
 * painted once and shared by every car. White = dirty/damaged.
 */
function paintGrime(W, H) {
  const canvas = makeCanvas(W, H);
  // Returned as raw pixels (getImageData at the end), so hint the readback.
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const rng = makeRng('livery/grime');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, W, H);

  // Swirl marks from polishing — short arcs, clustered where crews reach.
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
  ctx.lineWidth = 1.1;
  for (let i = 0; i < 2600; i++) {
    const cx = rng() * W;
    const cy = rng() * H;
    const r = 4 + rng() * 34;
    const a0 = rng() * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, a0, a0 + 0.7 + rng() * 1.6);
    ctx.stroke();
  }

  // Straight micro-scratches along the airflow direction.
  ctx.strokeStyle = 'rgba(255,255,255,0.13)';
  ctx.lineWidth = 0.9;
  for (let i = 0; i < 900; i++) {
    const x = rng() * W, y = rng() * H;
    const len = 18 + rng() * 150;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + len, y + (rng() - 0.5) * 7);
    ctx.stroke();
  }

  // Fingerprints / hand smears where mechanics push the car.
  for (let i = 0; i < 46; i++) {
    const cx = (0.16 + rng() * 0.72) * W;
    const cy = (rng() < 0.5 ? 0.14 + rng() * 0.24 : 0.62 + rng() * 0.30) * H;
    const r = 16 + rng() * 44;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, 'rgba(255,255,255,0.34)');
    g.addColorStop(0.6, 'rgba(255,255,255,0.12)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.ellipse(cx, cy, r * 1.5, r, rng() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
  }

  // Rubber pickup and track spray: streaks trailing back off both axles.
  ctx.lineCap = 'round';
  for (let i = 0; i < 420; i++) {
    const front = rng() < 0.55;
    const u0 = front ? 0.27 + rng() * 0.22 : 0.72 + rng() * 0.22;
    const v = rng() < 0.5 ? 0.50 + rng() * 0.14 : 0.86 + rng() * 0.14;
    const len = (0.03 + rng() * 0.16) * W;
    ctx.strokeStyle = `rgba(255,255,255,${(0.06 + rng() * 0.20).toFixed(3)})`;
    ctx.lineWidth = 1 + rng() * 5;
    ctx.beginPath();
    ctx.moveTo(u0 * W, v * H);
    ctx.lineTo(u0 * W + len, v * H + (rng() - 0.5) * 14);
    ctx.stroke();
  }

  // Edge wear along the panel joints — paint is thinnest and gets chipped.
  for (const u of PANEL_LINES) {
    const g = ctx.createLinearGradient(u * W - 7, 0, u * W + 7, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.42)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(u * W - 7, 0, 14, H);
  }
  // Nose leading edge takes stone chips.
  const chip = ctx.createLinearGradient(0, 0, 0.06 * W, 0);
  chip.addColorStop(0, 'rgba(255,255,255,0.55)');
  chip.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = chip;
  ctx.fillRect(0, 0, 0.06 * W, H);

  return ctx.getImageData(0, 0, W, H).data;
}

/** Height field for the body relief: panel steps, shutlines, gills, rivets. */
function paintRelief(W, H) {
  const canvas = makeCanvas(W, H);
  // Read back once with getImageData below; the hint keeps Chrome from putting
  // this canvas on the GPU and then warning about the readback stall.
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, W, H);

  const X = (u) => u * W, Y = (v) => v * H;

  // Longitudinal panel joints: a groove with a proud lip on the aft side.
  for (const u of PANEL_LINES) {
    ctx.fillStyle = '#5c5c5c';
    ctx.fillRect(X(u) - 2, 0, 4, H);
    ctx.fillStyle = '#8f8f8f';
    ctx.fillRect(X(u) + 2, 0, 2, H);
  }

  // Paint-to-floor step, both sides.
  for (const v of [V_CARBON_LO, V_CARBON_HI]) {
    ctx.fillStyle = '#5a5a5a';
    ctx.fillRect(0, Y(v) - 2, W, 4);
    ctx.fillStyle = '#909090';
    ctx.fillRect(0, Y(v) + (v === V_CARBON_LO ? 2 : -4), W, 2);
  }

  // Cockpit opening shutline.
  ctx.strokeStyle = '#565656';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.roundRect(X(0.430), Y(0.185), X(0.185), Y(0.130), 26);
  ctx.stroke();

  // Engine-cover cooling gills.
  for (const sign of [-1, 1]) {
    for (let i = 0; i < 6; i++) {
      const u = 0.735 + i * 0.021;
      const v = 0.25 + sign * (0.055 + i * 0.004);
      ctx.fillStyle = '#4e4e4e';
      ctx.fillRect(X(u), Y(v) - 16, X(0.011), 32);
      ctx.fillStyle = '#9a9a9a';
      ctx.fillRect(X(u) + X(0.011), Y(v) - 16, 3, 32);
    }
  }

  // Fastener rows along the joints.
  ctx.fillStyle = '#6e6e6e';
  for (const u of PANEL_LINES) {
    for (let k = 0; k < 26; k++) {
      const v = (k + 0.5) / 26;
      ctx.beginPath();
      ctx.arc(X(u), Y(v), 3.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  const px = ctx.getImageData(0, 0, W, H).data;
  const height = new Float32Array(W * H);

  // PANEL WAVINESS — THE ONE NUMBER THAT DECIDES WHETHER THIS IS PAINT.
  //
  // This term used to be fbm(freq 7, octaves 3) at amplitude 0.09. Body u spans
  // BODY_LENGTH = 5.45 m, so freq 7 is a 0.78 m fundamental and the third octave
  // lands at ~0.20 m; v spans a ~1.9 m circumference so its finest octave was
  // ~0.09 m. Pushed through heightToNormal(..., 3.4) and only attenuated to 0.65
  // by normalScale, that is an effective slope near 0.2 — and the whole car wore
  // a golf-ball dimple at 20-35 cm pitch, which is what makes clearcoat read as
  // textured plastic or hammered metal.
  //
  // A real autoclaved carbon panel is flat to about 0.2 mm over 300 mm: a slope
  // of 0.0007, roughly 300x less. So waviness here is ONE long octave only —
  // freq 2.5 is a 2.2 m fundamental, the scale at which a real bonded panel
  // actually bows between its bond lines — at 0.006 amplitude, which lands the
  // final slope at ~3e-4. Anything you can SEE at this scale is wrong.
  //
  // The sub-millimetre surface story (orange peel, flake) does not belong in a
  // base normal at all: it lives on `flakeNormalMap()` in materials.js, wired to
  // paint.clearcoatNormalMap, so it only ever shows inside the specular lobe.
  const GW = 64, GH = 32;
  const wob = new Float32Array(GW * GH);
  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      wob[y * GW + x] = fbm(x / GW, y / GH, { freq: 2.5, octaves: 1, seed: 613 }) - 0.5;
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      height[i] = px[i * 4] / 255 + gridSample(wob, GW, GH, x / W, y / H) * 0.006;
    }
  }
  return height;
}

/**
 * The body surface maps every team shares.
 * @returns {{normalMap:THREE.Texture, ormMap:THREE.Texture, clearcoatMap:THREE.Texture}}
 *   ormMap:       R = AO, G = base roughness, B = metalness mask
 *   clearcoatMap: R = clearcoat strength, G = clearcoat roughness
 */
export function bodySurfaceMaps() {
  return assets.get('livery/bodySurface', () => {
    const NW = 2048, NH = 1024;
    const normalMap = dataTex(heightToNormal(paintRelief(NW, NH), NW, NH, 3.4), NW, NH, THREE.NoColorSpace);

    const W = 1024, H = 512;
    const grime = paintGrime(W, H);
    const orm = new Uint8Array(W * H * 4);
    const cc = new Uint8Array(W * H * 4);

    for (let y = 0; y < H; y++) {
      const v = (y + 0.5) / H;
      // Which surface are we on? 1 inside the exposed-carbon underside band.
      const under = smoothstep(V_CARBON_LO - 0.012, V_CARBON_LO + 0.012, v)
                  * (1 - smoothstep(V_CARBON_HI - 0.012, V_CARBON_HI + 0.012, v));
      // Distance up from the floor line on each flank, 0 at the line.
      const lowLeft = v > 0.30 && v < V_CARBON_LO ? 1 - clamp((V_CARBON_LO - v) / 0.20, 0, 1) : 0;
      const lowRight = v > V_CARBON_HI ? 1 - clamp((v - V_CARBON_HI) / 0.20, 0, 1) : 0;
      const low = Math.max(lowLeft, lowRight);
      // Horizontal upper surfaces collect dust from above.
      const upper = gauss(v - 0.25, 0.075);

      for (let x = 0; x < W; x++) {
        const u = (x + 0.5) / W;
        const i = (y * W + x) * 4;
        const g = grime[i] / 255;

        // Cavity AO: the floor joint, the cockpit surround and the coke-bottle
        // pinch behind the sidepods all sit in shadow.
        let ao = 1
          - under * 0.30
          - low * 0.22
          - 0.16 * gauss(v - V_CARBON_LO, 0.045)
          - 0.16 * gauss(v - V_CARBON_HI, 0.045)
          - 0.20 * gauss(u - 0.52, 0.055) * gauss(v - 0.25, 0.055)
          - g * 0.10;

        // Roughness. Clearcoated paint is smooth; dust, rubber pickup and
        // scratches are what break it up.
        const dust = low * smoothstep(0.18, 0.85, u) * 0.55 + upper * 0.14 * smoothstep(0.3, 1.0, u);
        let rough = under ? 0.48 : 0.36;
        rough += dust * 0.34 + g * 0.20;
        // Roughness breakup, at PAINT scale not PANEL scale. This was
        // fbm(u*3, v*3, {freq: 9, octaves: 3}) — 27 cycles over 5.45 m, a 0.20 m
        // blotch that beat in step with the old normal-map waviness and doubled
        // the golf-ball read. freq 90 puts it at ~60 mm, which is dirt and
        // polish-cloth scale: it breaks the specular up without ever silhouetting
        // as a shape.
        rough += 0.04 * (fbm(u, v, { freq: 90, octaves: 2, seed: 91 }) - 0.5);

        // Clearcoat: full strength on paint, thinner on exposed weave, worn
        // away entirely where grit has blasted it.
        //
        // ccRough was pushed UP from 0.045 to 0.085 to kill what read as a
        // "laboratory mirror". That was the wrong diagnosis. F1 paint IS a
        // laboratory mirror — it is wet-sanded and machine-polished between every
        // session. What actually looked wrong was that the IBL had no sharp
        // content to reflect (the PMREM is built from `sky.envMesh` alone, so a
        // sharp coat had nothing but a sky gradient to show), and blurring the
        // coat to hide an empty reflection just costs you the reflection.
        //
        // So the floor goes to 0.030 and the DIRT owns the falloff: `g` (swirl
        // marks and hand smears), `dust` (the low flanks and the horizontal top
        // deck) and `upper` all still open the lobe up locally, which is what
        // gives a real car its patchy, wiped-a-hundred-times highlight instead of
        // one uniform satin sheet. Ceiling 0.55, not 0.7 — above ~0.55 clearcoat
        // stops being a coat and starts being a second diffuse layer.
        const ccAmt = clamp((under ? 0.55 : 0.94) - g * 0.35 - dust * 0.30 - upper * 0.14, 0.12, 1);
        const ccRough = clamp((under ? 0.15 : 0.030) + g * 0.34 + dust * 0.26 + upper * 0.115, 0.030, 0.55);

        orm[i] = clamp(ao, 0, 1) * 255;
        orm[i + 1] = clamp(rough, 0.05, 1) * 255;
        orm[i + 2] = (1 - under) * 255;
        orm[i + 3] = 255;
        cc[i] = ccAmt * 255;
        cc[i + 1] = ccRough * 255;
        cc[i + 2] = 0;
        cc[i + 3] = 255;
      }
    }

    return {
      normalMap,
      ormMap: dataTex(orm, W, H, THREE.NoColorSpace),
      clearcoatMap: dataTex(cc, W, H, THREE.NoColorSpace),
    };
  });
}

// ---------------------------------------------------------------------------
// Driver helmet
// ---------------------------------------------------------------------------

/**
 * Helmets are the one part of an F1 car that is NOT team-liveried, and getting
 * that wrong is very visible: a helmet painted in the team's `secondary` (which
 * for most of this grid is near-black) disappears into the cockpit shadow and
 * the car reads as driverless.
 *
 * The texture is authored for `THREE.SphereGeometry`'s own unwrap:
 *   u = phi / 2pi    (0 and 1 meet at the BACK of the helmet)
 *   v = 1 - theta/pi (1 = crown, 0 = chin)
 * The visor aperture sits at u 0.25..0.75, v 0.25..0.66 — the same window
 * `chassis.buildVisor()` cuts the glass from. The bottom `HELMET_UV_SPARE` of
 * the texture is a flat strip reserved for parts whose UVs get remapped into it
 * (the aero fin and the chin bar), so they share the helmet's material and cost
 * no extra draw call.
 */
export const HELMET_UV_SPARE = 0.06;

/** Eight plausible personal helmet colourways, chosen by driver number. */
const HELMET_BASES = [
  ['#f2f4f7', '#101319'], ['#0b1d4d', '#f2c200'], ['#c81432', '#f2f4f7'],
  ['#f5f5f5', '#0aa3ff'], ['#111318', '#e8232a'], ['#0e6b4f', '#f5e400'],
  ['#e85d00', '#111318'], ['#5a2a8f', '#f2f4f7'],
];

export function helmetTexture(team, driver) {
  const key = `livery/helmet/${team.id}/${driver?.number ?? 0}`;
  return assets.texture(key, () => {
    const W = 1024, H = 512;
    const canvas = makeCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const n = driver?.number ?? 0;
    const [base, second] = HELMET_BASES[n % HELMET_BASES.length];
    const X = (u) => u * W, Y = (v) => (1 - v) * H;   // v = 1 is the crown

    ctx.fillStyle = base;
    ctx.fillRect(0, 0, W, H);

    // Crown banding. The band between v = 0.80 and v = 0.90 is the ONLY part of
    // the helmet a head-on camera sees over the halo hoop, so it carries the
    // high-contrast colour; a dark cap all the way down to 0.84 (the obvious
    // choice) puts black on black and the car reads as driverless.
    ctx.fillStyle = second;
    ctx.fillRect(0, 0, W, Y(0.885));
    ctx.fillStyle = team.accent;
    ctx.fillRect(0, Y(0.885), W, Y(0.800) - Y(0.885));
    ctx.fillStyle = base;
    ctx.fillRect(0, Y(0.800), W, Y(0.775) - Y(0.800));

    // Chevrons over the temples, one pair either side of the aperture.
    for (const c of [0.13, 0.87]) {
      ctx.fillStyle = team.accent;
      ctx.beginPath();
      ctx.moveTo(X(c - 0.085), Y(0.79));
      ctx.lineTo(X(c + 0.085), Y(0.79));
      ctx.lineTo(X(c + 0.028), Y(0.33));
      ctx.lineTo(X(c - 0.028), Y(0.33));
      ctx.closePath();
      ctx.fill();
    }

    // Visor aperture surround: matte black with a gasket highlight.
    ctx.fillStyle = '#0a0c10';
    ctx.beginPath();
    ctx.roundRect(X(0.235), Y(0.665), X(0.53), Y(0.235) - Y(0.665), 26);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    ctx.lineWidth = 4;
    ctx.stroke();

    // Visor band painted UNDER the glass mesh (u 0.34..0.66, v 0.40..0.59), so
    // the eye slot still reads as a tinted visor even where the tiny glass patch
    // does not cover it, and so the tear-off tabs have something to sit on.
    const vg = ctx.createLinearGradient(0, Y(0.60), 0, Y(0.38));
    vg.addColorStop(0, '#182a3c');
    vg.addColorStop(0.55, '#0d1620');
    vg.addColorStop(1, '#060a10');
    ctx.fillStyle = vg;
    ctx.beginPath();
    ctx.roundRect(X(0.325), Y(0.605), X(0.35), Y(0.375) - Y(0.605), 16);
    ctx.fill();
    // Two tear-off tabs on the driver's left.
    ctx.fillStyle = 'rgba(240,244,248,0.55)';
    for (const t of [0.345, 0.362]) ctx.fillRect(X(t), Y(0.60), X(0.008), Y(0.39) - Y(0.60));

    // Chin bar, with the driver code across it.
    ctx.fillStyle = second;
    ctx.fillRect(X(0.25), Y(0.235), X(0.50), Y(0.115) - Y(0.235));
    ctx.fillStyle = base;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.letterSpacing = `${H * 0.012}px`;
    ctx.font = `900 ${H * 0.052}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
    ctx.fillText(driver?.code ?? team.short, X(0.5), (Y(0.235) + Y(0.115)) / 2);

    // Number on the crown — the halo camera looks straight down at this.
    ctx.fillStyle = base;
    ctx.font = `900 ${H * 0.075}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
    ctx.fillText(String(n), X(0.5), Y(0.952));

    // Flat strip reserved for the fin / chin-bar UV remap.
    ctx.fillStyle = second;
    ctx.fillRect(0, Y(HELMET_UV_SPARE), W, H - Y(HELMET_UV_SPARE));

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = 16;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.needsUpdate = true;
    return tex;
  });
}

/**
 * Per-driver helmet material. A helmet is the glossiest object on the car and
 * the only part of the driver a camera ever resolves, so it gets a full
 * clearcoat lobe over a solid base.
 * @returns {THREE.MeshPhysicalMaterial}
 */
export function createHelmetMaterial(team, driver) {
  return new THREE.MeshPhysicalMaterial({
    map: helmetTexture(team, driver),
    roughness: 0.34,
    metalness: 0.0,
    clearcoat: 1.0,
    clearcoatRoughness: 0.055,
    // 1.0, not 1.1, because 1.1 would be a lie: nothing on the car binds its own
    // `envMap`, so three overwrites `envMapIntensity` with
    // `scene.environmentIntensity` before every draw (see `envResponse` in
    // car/materials.js, which patches around it). A helmet wants unity anyway;
    // importing the helper here would close a livery -> materials -> livery cycle.
    envMapIntensity: 1.0,
  });
}

// ---------------------------------------------------------------------------
// Rear-wing number panel and halo tip
// ---------------------------------------------------------------------------

/**
 * The mandatory rear-wing endplate number panel: white block, black number,
 * driver code underneath. Returned as a straight sRGB CanvasTexture.
 */
export function numberPanelTexture(team, driver) {
  return assets.texture(`livery/panel/${team.id}/${driver?.number ?? 0}`, () => {
    const W = 256, H = 256;
    const canvas = makeCanvas(W, H);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f4f6f8';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = team.accent;
    ctx.fillRect(0, H * 0.80, W, H * 0.20);
    ctx.fillStyle = '#0d0f13';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `900 ${H * 0.62}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
    ctx.fillText(String(driver?.number ?? team.drivers[0].number), W / 2, H * 0.40);
    ctx.font = `800 ${H * 0.13}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
    ctx.letterSpacing = `${H * 0.02}px`;
    ctx.fillStyle = '#0d0f13';
    ctx.fillText(driver?.code ?? team.short, W / 2, H * 0.90);
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 16;
    tex.needsUpdate = true;
    return tex;
  });
}

/**
 * The halo hoop centreline. **This list is the same spline as
 * `chassis.HALO_SPINE`** — the coloured tip is a sleeve that slides over the
 * hoop, so if the two ever disagree you get two visibly separate arcs floating
 * inside each other (which is exactly what a previous build shipped).
 * chassis.js cannot be imported here (livery must not depend on chassis), so the
 * numbers are duplicated and asserted by eye in the `cockpit` capture.
 */
const HALO_SPINE = [
  new THREE.Vector3(-0.352, 0.512, 0.216),
  new THREE.Vector3(-0.378, 0.606, -0.130),
  new THREE.Vector3(-0.320, 0.694, -0.470),
  new THREE.Vector3(-0.160, 0.742, -0.690),
  new THREE.Vector3(0.000, 0.752, -0.752),
  new THREE.Vector3(0.160, 0.742, -0.690),
  new THREE.Vector3(0.320, 0.694, -0.470),
  new THREE.Vector3(0.378, 0.606, -0.130),
  new THREE.Vector3(0.352, 0.512, 0.216),
];

/**
 * Halo cross-section, in (across, vertical) metres.
 *
 * A real halo is a DEEP teardrop: ~30 mm across but 90-100 mm front-to-back. The
 * section used to be 34 x 60 mm, which is a blade, not a teardrop — head-on the
 * hoop nearly vanished, and along its length there was no width for a terminator
 * to sit in, so a 700 px span of it carried no shading gradient at all and read
 * as a foam pool noodle.
 *
 * 94 mm total now, and split 50 up / 44 down rather than the review's 58/36. The
 * constraint the review could not see from a screenshot is `chassis.buildHalo`'s
 * comment: the hoop crown is y = 0.752 and the helmet crown is 0.839, so every
 * millimetre added to the UPPER half eats the driver's head. 50/44 keeps the full
 * 94 mm depth and still leaves 37 mm of helmet standing clear of the hoop.
 *
 * The taper thins the upper trailing edge only, in the ACROSS axis — that is what
 * puts a hard bright edge along the top of the hoop and a long dark flank under
 * it. Up from 0.44 to 0.58 so the teardrop is unmistakable in silhouette.
 *
 * @param {number} grow  extra half-thickness, metres (the tip sleeve's clearance)
 */
export function haloProfile(n, grow = 0) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const taper = 1 - 0.58 * Math.max(0, sa);       // thin the upper trailing edge
    pts.push(new THREE.Vector2(
      ca * (0.017 * taper + grow),
      sa * (sa > 0 ? 0.050 + grow : 0.044 + grow),
    ));
  }
  return pts;
}

/**
 * Sweep a closed 2-D profile along a curve using an UP-LOCKED frame
 * (normal = up x tangent) rather than Frenet frames. Frenet normals rotate with
 * the curve's torsion, which twists a halo section by tens of degrees between
 * the front arc and the rear mounts; an up-locked frame keeps the teardrop's
 * deep axis vertical everywhere, which is how the part is actually made.
 */
export function sweepUpLocked(curve, profile, segments) {
  const up = new THREE.Vector3(0, 1, 0);
  const T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3();
  const sections = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const p = curve.getPointAt(t);
    curve.getTangentAt(t, T);
    N.crossVectors(up, T).normalize();
    B.crossVectors(T, N).normalize();
    sections.push(profile.map((q) => new THREE.Vector3(
      p.x + N.x * q.x + B.x * q.y,
      p.y + N.y * q.x + B.y * q.y,
      p.z + N.z * q.x + B.z * q.y,
    )));
  }
  const g = loft(sections, { closed: true, caps: true });
  g.computeVertexNormals();
  return { geometry: g, sections };
}

/** The halo spline as a curve — shared by the hoop and the coloured tip. */
export function haloCurve() {
  return new THREE.CatmullRomCurve3(HALO_SPINE, false, 'catmullrom', 0.5);
}

/**
 * Per-car decoration that cannot live in the merged, shared chassis buckets:
 * the rear-wing number panels and the coloured halo tip.
 *
 * @param {{team:object, driver:object, seat:number}} entry
 * @param {object} materials  the bundle from createCarMaterials
 * @returns {THREE.Group} in car-local space
 */
export function buildTeamDecals(entry, materials) {
  const group = new THREE.Group();
  group.name = 'teamDecals';

  // Rear-wing endplate number panels (one per side, facing outboard).
  const panelGeo = assets.geometry('livery/panelGeo', () => new THREE.PlaneGeometry(0.20, 0.17));
  const panelMat = new THREE.MeshPhysicalMaterial({
    map: numberPanelTexture(entry.team, entry.driver),
    roughness: 0.34, metalness: 0.0,
    clearcoat: 0.8, clearcoatRoughness: 0.10,
    envMapIntensity: 1.0,
  });
  materials.extra.push(panelMat);
  for (const side of [-1, 1]) {
    const m = new THREE.Mesh(panelGeo, panelMat);
    m.position.set(side * 0.5335, 0.655, 2.275);
    m.rotation.y = side * Math.PI / 2;
    m.castShadow = false;
    m.receiveShadow = true;
    group.add(m);
  }

  // HALO TIP SLEEVE — the quickest way to tell cars apart on TV, and the fastest
  // way to ruin the cockpit frame if it is too big.
  //
  // Two things were wrong. (1) It spanned the middle 28% of the spline — which is
  // exactly the forward arc, i.e. the ENTIRE hoop a head-on or onboard camera
  // sees. CONTRACT §5 says "coloured TIP sleeve"; in practice the whole halo read
  // as one butter-yellow tube with no carbon anywhere. 16% still gives the car a
  // clear team flash at the nose while leaving the shoulders — the parts that
  // frame a cockpit shot — as bare structural carbon.
  // (2) It was a constant-section banana, 3 mm proud all the way to two hard butt
  // ends where the colour simply stopped mid-tube. `grow` now ramps from 0.6 mm
  // at each end (just enough to beat z-fighting against the hoop) to 3 mm in the
  // middle, so the sleeve fairs into the black section the way a masked-off paint
  // edge on a real hoop does.
  const haloGeo = assets.geometry('livery/haloTip', () => {
    const full = haloCurve();
    const T0 = 0.420, T1 = 0.580;
    const N = 44;
    const up = new THREE.Vector3(0, 1, 0);
    const T = new THREE.Vector3(), Nv = new THREE.Vector3(), B = new THREE.Vector3();
    const sections = [];
    for (let i = 0; i <= N; i++) {
      const f = i / N;
      const t = T0 + f * (T1 - T0);
      // sin^0.4 rises fast then plateaus: full thickness over the middle 70% of
      // the sleeve, a short fair-in at each end rather than a lens shape.
      const grow = 0.0006 + 0.0024 * Math.pow(Math.sin(Math.PI * f), 0.4);
      const p = full.getPointAt(t);
      full.getTangentAt(t, T);
      Nv.crossVectors(up, T).normalize();
      B.crossVectors(T, Nv).normalize();
      sections.push(haloProfile(16, grow).map((q) => new THREE.Vector3(
        p.x + Nv.x * q.x + B.x * q.y,
        p.y + Nv.y * q.x + B.y * q.y,
        p.z + Nv.z * q.x + B.z * q.y,
      )));
    }
    const g = loft(sections, { closed: true, caps: true });
    g.computeVertexNormals();
    return g;
  });
  const halo = new THREE.Mesh(haloGeo, materials.haloTip);
  halo.castShadow = true;
  group.add(halo);

  return group;
}

// ---------------------------------------------------------------------------

/**
 * A flat decal quad using the shared decal atlas — for endplates, barge boards
 * and trackside boards. Material must be the shared `materials.decal`.
 * @returns {THREE.Mesh}
 */
export function makeDecalPlane(name, width, height, material) {
  const geo = assets.geometry(`decal/${name}/${width}x${height}`, () => {
    const g = new THREE.PlaneGeometry(width, height);
    const uv = g.getAttribute('uv');
    const { offset, scale } = decalAtlasUV(name);
    for (let i = 0; i < uv.count; i++) {
      uv.setXY(i, offset.x + uv.getX(i) * scale.x, offset.y + uv.getY(i) * scale.y);
    }
    uv.needsUpdate = true;
    return g;
  });
  const m = material.clone();
  m.map = decalAtlas();
  m.transparent = true;
  return new THREE.Mesh(geo, m);
}
