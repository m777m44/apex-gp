/**
 * APEX GP — circuit geometry and the track sampling API.
 *
 * "Vallonde International" is an original 5.7 km Grand Prix layout with the
 * character of Spa / Silverstone / Suzuka: a long pit straight, a plunge into a
 * compression followed by a steep uphill sweep, a 700 m back straight, a banked
 * right-hander and a slow-corner sector.
 *
 * The layout is authored as a closed polygon of named corner vertices, each
 * rounded with a tangent circular fillet — exactly how a real layout is drawn —
 * so the loop always closes and every corner has a plausible radius. That
 * polyline is resampled at a fixed arc-length step into `samples[]`, which is
 * THE source of truth for physics, AI, cameras, HUD and environment placement.
 *
 * COORDINATES: metres, +Y up, right-handed. For a sample, `tangent` is the
 * direction of travel, `right` = tangent x up (the driver's right hand), `s` is
 * arc length in metres from the start/finish line, and `curvature` is positive
 * when the track turns right.
 *
 * CROSS-SLOPE. The surface height at a lateral offset is
 *     dy = -|lateral| / halfWidth * CROWN + banking * lateral * 0.5
 * `banking` is NEGATIVE in a right-hand corner, so the outside edge rises.
 * `environment.js` duplicates this expression for the run-off apron and the
 * carved terrain — keep the two in step.
 *
 * PUBLIC API — see CONTRACT.md §3. Everything the old API promised still holds;
 * `widthAt`, `surfaceAt`, `corners`, `cornerAt`, `brakingAt`, `speedAt`,
 * `elevationAt` and `gradientAt` are additions.
 */

import * as THREE from 'three';
import { assets } from '../core/assets.js';
import {
  asphalt, kerbStripe, paintedLine, concrete, grass,
  mapsToMaterial, setRepeat, cloneMaps,
} from '../textures/procedural.js';
import { clamp, lerp, smoothstep, makeRng, hashSeed } from '../core/rng.js';

const UP = new THREE.Vector3(0, 1, 0);

/** Track crown: the drop from the centreline to the edge, in metres. */
const CROWN = 0.10;

/**
 * The layout. Order = direction of travel; the loop closes from the last entry
 * back to the first, and that closing leg is the pit straight.
 *
 *   r        fillet radius, metres (the corner's geometric radius)
 *   y        elevation of the corner, metres
 *   width    FULL racing-surface width through the corner, metres (12 - 15.2)
 *   bank     banking in degrees, positive = banked into the corner
 *   kerb     'none' | 'standard' | 'apex' | 'negative'
 *   sausage  add sausage kerbs on the exit
 */
const LAYOUT = [
  { name: 'Ascari',       x: 1080, z:   24, y:  6, r:  72, width: 14.6, kerb: 'standard' },
  { name: 'Grand Courbe', x: 1296, z:  240, y: 17, r: 228, width: 15.2, bank: 2.4, kerb: 'apex', negative: true },
  { name: 'Le Sommet',    x: 1344, z:  516, y: 27, r: 108, width: 14.0, bank: 1.8, kerb: 'standard' },
  { name: 'Belvedere',    x: 1176, z:  708, y: 29, r: 240, width: 15.2, bank: 2.2, kerb: 'apex' },
  { name: 'Epingle',      x: 1224, z:  948, y: 26, r:  50, width: 12.6, kerb: 'standard', sausage: true },
  { name: 'La Cuvette',   x: 1020, z: 1032, y:  0, r: 360, width: 15.2, kerb: 'apex' },
  { name: 'Raidillon',    x:  912, z: 1236, y: 22, r: 132, width: 13.6, bank: 3.0, kerb: 'standard' },
  { name: 'Le Toit',      x:  996, z: 1452, y: 34, r: 130, width: 13.8, bank: 2.0, kerb: 'standard' },
  { name: 'Renault',      x:  300, z: 1596, y: 27, r:  45, width: 12.4, kerb: 'standard', sausage: true },
  { name: 'Bosquet',      x:  120, z: 1300, y: 22, r: 144, width: 13.8, bank: 1.6, kerb: 'standard' },
  { name: 'Le Bol',       x: -168, z: 1236, y: 15, r: 130, width: 14.4, bank: 5.0, kerb: 'standard' },
  { name: 'Farine',       x: -120, z:  996, y: 11, r: 150, width: 14.6, bank: 1.6, kerb: 'apex' },
  { name: 'Chicane Nord', x: -330, z:  900, y: 13, r:  32, width: 12.4, kerb: 'standard' },
  { name: 'Chicane Sud',  x: -300, z:  760, y: 14, r:  38, width: 12.6, kerb: 'standard', sausage: true },
  { name: 'Les Combes',   x: -480, z:  576, y: 18, r: 168, width: 14.4, bank: 1.8, kerb: 'standard' },
  { name: 'Blanchard',    x: -396, z:  276, y: 15, r: 216, width: 15.0, bank: 1.4, kerb: 'apex', negative: true },
  { name: 'La Source',    x: -216, z:   60, y: 10, r:  92, width: 14.2, kerb: 'standard' },
  { name: 'Kink',         x:   60, z:  -34, y:  8, r: 620, width: 15.2, kerb: 'none' },
];

/** Which corner the start/finish line sits in front of, and by how far. */
const START_CORNER = 0;
const START_BEFORE = 700;

export const TRACK_WIDTH = 15.2;        // widest racing surface (= 2 * halfWidth)
const SAMPLE_STEP = 2.0;                // metres between stored samples
const VERGE = 1.10;                     // paved shoulder outside halfWidth
const KERB_TILE = 4.0;                  // metres per kerbStripe tile (worldSize)

// ---------------------------------------------------------------------------
// Layout solving
// ---------------------------------------------------------------------------

/**
 * Rounds every vertex of a closed polygon with a tangent circular fillet and
 * returns a dense polyline. `owner[i]` is the LAYOUT index whose arc produced
 * point i, or -1 on the straights between them. Radii are clamped so
 * neighbouring fillets can never overlap.
 */
function filletPolygon(verts) {
  const n = verts.length;

  const corners = verts.map((cur, i) => {
    const prev = verts[(i - 1 + n) % n];
    const next = verts[(i + 1) % n];
    const inDir = new THREE.Vector2(cur.x - prev.x, cur.z - prev.z);
    const outDir = new THREE.Vector2(next.x - cur.x, next.z - cur.z);
    const lenIn = inDir.length(), lenOut = outDir.length();
    inDir.divideScalar(lenIn); outDir.divideScalar(lenOut);

    const turn = Math.acos(clamp(inDir.x * outDir.x + inDir.y * outDir.y, -1, 1));
    let radius = cur.r;
    let tan = radius * Math.tan(turn / 2);
    const maxT = Math.min(lenIn, lenOut) * 0.46;
    if (tan > maxT) { tan = maxT; radius = tan / Math.tan(Math.max(turn, 1e-4) / 2); }

    const start = new THREE.Vector2(cur.x, cur.z).addScaledVector(inDir, -tan);
    const end = new THREE.Vector2(cur.x, cur.z).addScaledVector(outDir, tan);
    // In the (x, z) plane a positive cross product means the path turns to the
    // driver's right, which is also the sign convention for `curvature`.
    const sign = inDir.x * outDir.y - inDir.y * outDir.x >= 0 ? 1 : -1;
    const perp = new THREE.Vector2(-inDir.y, inDir.x).multiplyScalar(sign);
    const centre = start.clone().addScaledVector(perp, radius);
    const a0 = Math.atan2(start.y - centre.y, start.x - centre.x);
    const a1 = Math.atan2(end.y - centre.y, end.x - centre.x);
    let sweep = a1 - a0;
    while (sweep > Math.PI) sweep -= Math.PI * 2;
    while (sweep < -Math.PI) sweep += Math.PI * 2;
    return { cur, start, end, centre, radius, a0, sweep, turn, side: sign };
  });

  const pts = [], owner = [];
  for (let i = 0; i < n; i++) {
    const c = corners[i];
    const steps = Math.max(6, Math.ceil((Math.abs(c.sweep) * c.radius) / 4));
    for (let k = 0; k <= steps; k++) {
      const a = c.a0 + c.sweep * (k / steps);
      pts.push(new THREE.Vector2(c.centre.x + Math.cos(a) * c.radius, c.centre.y + Math.sin(a) * c.radius));
      owner.push(i);
    }
    const nx = corners[(i + 1) % n];
    const segLen = c.end.distanceTo(nx.start);
    const straightSteps = Math.max(1, Math.ceil(segLen / 10));
    for (let k = 1; k < straightSteps; k++) {
      const t = k / straightSteps;
      pts.push(new THREE.Vector2(lerp(c.end.x, nx.start.x, t), lerp(c.end.y, nx.start.y, t)));
      owner.push(-1);
    }
  }
  // Cumulative polyline length — the arcs are sampled far more densely than the
  // straights, so index is a useless proxy for distance.
  const cum = new Float32Array(pts.length + 1);
  for (let i = 1; i <= pts.length; i++) cum[i] = cum[i - 1] + pts[i - 1].distanceTo(pts[i % pts.length]);
  return { pts, owner, corners, cum, perimeter: cum[pts.length] };
}

/** Circular 1-D blur over `arr`, `radius` samples wide, `passes` times. */
function smoothLoop(arr, radius, passes = 1) {
  const n = arr.length;
  let src = arr;
  for (let p = 0; p < passes; p++) {
    const out = new Float32Array(n);
    let acc = 0;
    for (let k = -radius; k <= radius; k++) acc += src[((k % n) + n) % n];
    const inv = 1 / (radius * 2 + 1);
    for (let i = 0; i < n; i++) {
      out[i] = acc * inv;
      acc += src[(i + radius + 1) % n] - src[((i - radius) % n + n) % n];
    }
    src = out;
  }
  return src;
}

// ---------------------------------------------------------------------------
// Procedural textures owned by this module
// ---------------------------------------------------------------------------

function makeCanvas(w, h) {
  const c = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });
  c.width = w; c.height = h;
  return c;
}

/**
 * Large-scale asphalt "story" mask, mapped in WORLD XZ so it never lines up
 * with the track's own UVs.
 *   R = tar snakes (crack-sealant lines)   G = resurfacing patches   B = tone
 * 48 m of world per tile.
 */
export const DETAIL_WORLD_SIZE = 48;

function asphaltDetailTexture() {
  // 2048 over 48 m = 23 mm per pixel, which is the coarsest tile that can hold
  // a 50 mm crack seal without filtering it into a 20 cm smudge.
  const S = 2048;
  const cv = makeCanvas(S, S);
  const g = cv.getContext('2d');
  const rng = makeRng(hashSeed('track/detail'));

  const PX = S / DETAIL_WORLD_SIZE;           // pixels per metre
  const m = (metres) => metres * PX;

  g.fillStyle = '#000060';
  g.fillRect(0, 0, S, S);
  g.globalCompositeOperation = 'lighter';

  // Draw every element nine times so the tile wraps seamlessly.
  const wrap = (fn) => {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        g.save(); g.translate(dx * S, dy * S); fn(); g.restore();
      }
    }
  };

  // B — smooth macro tone drift.
  for (let i = 0; i < 70; i++) {
    const x = rng() * S, y = rng() * S, r = rng.range(m(3.3), m(14));
    const a = rng.range(0.05, 0.30);
    wrap(() => {
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, `rgba(0,0,255,${a})`);
      grd.addColorStop(1, 'rgba(0,0,255,0)');
      g.fillStyle = grd;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    });
  }

  // G — resurfaced patches: soft-edged slabs at shallow angles, plus a family
  // of small dug-out repairs. 16 big slabs alone put roughly one patch per 140
  // square metres, which from an establishing shot is one event per half a
  // kilometre of road — nothing to look at. A used circuit carries both scales.
  try { g.filter = `blur(${Math.round(m(0.14))}px)`; } catch { /* older canvas */ }
  for (let i = 0; i < 20; i++) {
    const x = rng() * S, y = rng() * S;
    const w = rng.range(m(7), m(24)), h = rng.range(m(4), m(12));
    const rot = rng.range(-0.5, 0.5);
    const a = rng.range(0.45, 0.95);
    wrap(() => {
      g.save();
      g.translate(x, y); g.rotate(rot);
      g.fillStyle = `rgba(0,255,0,${a})`;
      g.fillRect(-w / 2, -h / 2, w, h);
      g.restore();
    });
  }
  try { g.filter = `blur(${Math.round(m(0.05))}px)`; } catch { /* older canvas */ }
  for (let i = 0; i < 34; i++) {
    const x = rng() * S, y = rng() * S;
    const w = rng.range(m(0.8), m(3.4)), h = rng.range(m(0.6), m(2.6));
    const rot = rng.range(-0.6, 0.6);
    const a = rng.range(0.55, 1.0);
    wrap(() => {
      g.save();
      g.translate(x, y); g.rotate(rot);
      g.fillStyle = `rgba(0,255,0,${a})`;
      g.fillRect(-w / 2, -h / 2, w, h);
      g.restore();
    });
  }
  try { g.filter = 'none'; } catch { /* ignore */ }

  // R — CRACK SEAL. A crack in a bound layer is a nearly straight fracture: it
  // propagates along the stress field, not at random. The old walk turned up to
  // 48 deg per SEGMENT (~20-45 deg per metre) and drew 5-8 cm-wide loops and
  // figure-eights, which is what made the tarmac look doodled on in biro.
  // Cap the turn at 5 deg/m and run the cracks long and straight.
  //
  // WIDTH IS THE SEALANT BAND, NOT THE CRACK. A 40-90 mm line is 2-4 px on this
  // tile and about a fifth of a pixel from an establishing camera: it mips into
  // nothing, which is why r3's tarmac had no seam network left at wide and tv
  // range at all. Overband crack sealing lays a 100-200 mm band of bitumen over
  // the fracture and that is what you actually see from a helicopter. Each run
  // is drawn twice — a wide, weak weathering halo that survives to any mip, and
  // the sharp band inside it — and branches off the trunk the way a reflective
  // crack network really propagates.
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const MAX_TURN_PER_M = (5 * Math.PI) / 180;
  const runs = [];
  for (let i = 0; i < 22; i++) {
    let x = rng() * S, y = rng() * S;
    // Cracks reflect off the paving grid, so start them near an axis.
    let dir = (rng() < 0.55 ? 0 : Math.PI / 2) + rng.range(-0.5, 0.5) + (rng() < 0.5 ? 0 : Math.PI);
    const segs = rng.int(5, 11);
    const path = [[x, y]];
    for (let k = 0; k < segs; k++) {
      const lenM = rng.range(2.2, 5.5);
      dir += rng.range(-1, 1) * MAX_TURN_PER_M * lenM;
      x += Math.cos(dir) * m(lenM); y += Math.sin(dir) * m(lenM);
      path.push([x, y]);
    }
    runs.push({ path, lw: rng.range(m(0.10), m(0.20)), a: rng.range(0.55, 0.95) });
    // Branches: a reflective crack forks at a shallow angle off the trunk.
    if (rng() < 0.75) {
      const j = rng.int(1, path.length - 1);
      let bx = path[j][0], by = path[j][1];
      let bdir = Math.atan2(path[j][1] - path[j - 1][1], path[j][0] - path[j - 1][0])
        + rng.range(0.5, 1.1) * (rng() < 0.5 ? -1 : 1);
      const bp = [[bx, by]];
      for (let k = 0, n2 = rng.int(2, 5); k < n2; k++) {
        const lenM = rng.range(1.4, 3.6);
        bdir += rng.range(-1, 1) * MAX_TURN_PER_M * lenM * 1.6;
        bx += Math.cos(bdir) * m(lenM); by += Math.sin(bdir) * m(lenM);
        bp.push([bx, by]);
      }
      runs.push({ path: bp, lw: rng.range(m(0.06), m(0.13)), a: rng.range(0.40, 0.80) });
    }
  }
  const stroke = (r, widthScale, alphaScale) => wrap(() => {
    g.strokeStyle = `rgba(255,0,0,${Math.min(1, r.a * alphaScale)})`;
    g.lineWidth = r.lw * widthScale;
    g.beginPath();
    g.moveTo(r.path[0][0], r.path[0][1]);
    for (let k = 1; k < r.path.length; k++) g.lineTo(r.path[k][0], r.path[k][1]);
    g.stroke();
  });
  for (const r of runs) stroke(r, 2.9, 0.26);   // weathering halo
  for (const r of runs) stroke(r, 1.0, 1.0);    // sealant band

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

/**
 * 4 x 5 atlas of painted starting-grid boxes, one per grid slot, drawn as worn
 * paint on transparent. Each cell covers GRID_BOX_W x GRID_BOX_L metres, and
 * v = 0 is the AHEAD end of the cell (the texture is used with flipY = false).
 *
 * Grid paint is an OUTLINE, never a fill: a filled 2 x 6 m rectangle at 0.9
 * albedo reads as a sheet of A4 dropped on the road. It is also the most abused
 * paint on the circuit — twenty cars sit on it, dump the clutch on it and drop
 * rubber on it — so the alpha is punched through with scuffs and the ink is a
 * grey-white, not white.
 */
const GRID_COLS = 4, GRID_ROWS = 5;
const GRID_BOX_W = 3.4, GRID_BOX_L = 8.4;
const GRID_PPM = 64;                    // atlas pixels per metre

function gridBoxAtlas() {
  const CW = Math.round(GRID_BOX_W * GRID_PPM), CH = Math.round(GRID_BOX_L * GRID_PPM);
  const cv = makeCanvas(CW * GRID_COLS, CH * GRID_ROWS);
  const g = cv.getContext('2d');
  const P = GRID_PPM;
  const rng = makeRng(hashSeed('track/gridbox'));

  const BOX_W = 2.0, BOX_L = 6.0;       // painted box, metres
  const AHEAD = 2.0;                    // stop line, metres ahead of the slot

  for (let i = 0; i < 20; i++) {
    const cx = (i % GRID_COLS) * CW, cy = Math.floor(i / GRID_COLS) * CH;
    g.save();
    g.translate(cx, cy);
    g.beginPath(); g.rect(0, 0, CW, CH); g.clip();

    const x0 = (CW - BOX_W * P) / 2;
    const y0 = (GRID_BOX_L / 2 - AHEAD) * P;      // front edge of the box
    const y1 = y0 + BOX_L * P;                    // rear (open) end

    g.strokeStyle = 'rgba(222,220,208,0.94)';
    g.lineJoin = 'miter';
    g.lineCap = 'butt';

    // 15 cm outline, open at the rear: two flanks and the stop line.
    g.lineWidth = 0.15 * P;
    g.beginPath();
    g.moveTo(x0, y1); g.lineTo(x0, y0);
    g.lineTo(x0 + BOX_W * P, y0); g.lineTo(x0 + BOX_W * P, y1);
    g.stroke();

    // 10 cm lateral start bar, stubbing out past each front corner.
    g.lineWidth = 0.10 * P;
    g.beginPath();
    g.moveTo(x0 - 0.55 * P, y0); g.lineTo(x0, y0);
    g.moveTo(x0 + BOX_W * P, y0); g.lineTo(x0 + (BOX_W + 0.55) * P, y0);
    g.stroke();

    // Position number, painted ahead of the box and read from behind.
    g.fillStyle = 'rgba(222,220,208,0.90)';
    g.font = `700 ${Math.round(1.30 * P)}px Helvetica, Arial, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(String(i + 1), CW / 2, y0 - 1.05 * P);

    // WEAR. Punch the alpha out where tyres, kerosene and rubber have taken the
    // paint off, so the outline is broken and grubby rather than freshly masked.
    g.globalCompositeOperation = 'destination-out';
    for (let k = 0; k < 260; k++) {
      const bx = rng() * CW, by = rng() * CH;
      const r = rng.range(0.02, 0.13) * P;
      g.fillStyle = `rgba(0,0,0,${rng.range(0.25, 0.85)})`;
      g.beginPath(); g.ellipse(bx, by, r, r * rng.range(0.5, 2.0), rng() * 3.14, 0, Math.PI * 2); g.fill();
    }
    // Two tyre-width scrub bands across the box: this is where the rear tyres
    // sit and spin up, and the paint there is simply gone.
    for (const off of [-0.62, 0.62]) {
      const bx = CW / 2 + off * P * 1.0;
      const grd = g.createLinearGradient(0, y0 + 2.6 * P, 0, y1);
      grd.addColorStop(0, 'rgba(0,0,0,0)');
      grd.addColorStop(0.5, 'rgba(0,0,0,0.55)');
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd;
      g.fillRect(bx - 0.20 * P, y0 + 2.6 * P, 0.40 * P, y1 - y0 - 2.6 * P);
    }
    g.globalCompositeOperation = 'source-over';
    g.restore();
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.flipY = false;                     // v = 0 is the top of the cell = ahead
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------------------------

export class Circuit {
  constructor(opts = {}) {
    this.halfWidth = (opts.width ?? TRACK_WIDTH) / 2;
    this.group = new THREE.Group();
    this.group.name = 'Circuit';
    this.samples = [];
    this.corners = [];
    this.length = 0;
    this.drsZones = [];
    this._grid = new Map();
    this._built = false;
  }

  // -- construction ---------------------------------------------------------

  build() {
    if (this._built) return this.group;
    this._buildPath();
    this._computeRacingLine();
    this._computeSpeedProfile();
    this._findDrsZones();
    this.group.add(this._buildRoad());
    this.group.add(this._buildKerbs());
    this.group.add(this._buildLines());
    this.group.add(this._buildStartLine());
    this._built = true;
    return this.group;
  }

  _buildPath() {
    const { pts, owner, corners, cum, perimeter } = filletPolygon(LAYOUT);

    // Dense polyline -> closed centripetal spline: rounds the arc/straight
    // junctions into something like a transition spiral.
    const ctrl = pts.map((p) => new THREE.Vector3(p.x, 0, p.y));
    const curve = new THREE.CatmullRomCurve3(ctrl, true, 'centripetal', 0.5);
    this.curve = curve;

    // Uniform arc-length resampling.
    const probe = 12000;
    const raw = [];
    let total = 0;
    let prev = curve.getPoint(0);
    raw.push({ s: 0, p: prev.clone() });
    for (let i = 1; i <= probe; i++) {
      const p = curve.getPoint(i / probe);
      total += p.distanceTo(prev);
      raw.push({ s: total, p: p.clone() });
      prev = p;
    }
    this.length = total;

    const count = Math.floor(total / SAMPLE_STEP);
    this.step = total / count;
    const samples = new Array(count);
    let ri = 0;
    for (let i = 0; i < count; i++) {
      const s = i * this.step;
      while (ri < raw.length - 2 && raw[ri + 1].s < s) ri++;
      const a = raw[ri], b = raw[ri + 1];
      const t = b.s > a.s ? (s - a.s) / (b.s - a.s) : 0;
      samples[i] = {
        s,
        position: a.p.clone().lerp(b.p, t),
        tangent: new THREE.Vector3(),
        right: new THREE.Vector3(),
        up: new THREE.Vector3(0, 1, 0),
        curvature: 0, banking: 0, racing: 0,
        width: this.halfWidth, corner: -1,
      };
    }

    this._assignCorners(samples, pts, owner, cum, perimeter);
    this._buildElevation(samples, corners);
    this._buildFrames(samples);
    this._buildWidthAndBanking(samples, corners);

    this.samples = samples;
    this._rotateStart(corners);
    this._buildCornerTable(corners);
    this._buildSpatialIndex();

    this.sectorLengths = [this.length / 3, this.length / 3, this.length / 3];
    this.sectorStarts = [0, this.length / 3, (2 * this.length) / 3];
  }

  /**
   * Tag every sample with the LAYOUT corner it belongs to. The spline and the
   * source polyline share a parametrisation to within a fraction of a percent,
   * so a proportional guess refined by a short local search is exact enough.
   */
  _assignCorners(samples, pts, owner, cum, perimeter) {
    const m = pts.length;
    const n = samples.length;
    let cursor = 0;
    for (let i = 0; i < n; i++) {
      // Walk the polyline in step with arc length, then refine locally.
      const want = (i / n) * perimeter;
      while (cursor < m - 1 && cum[cursor + 1] < want) cursor++;
      const guess = cursor;
      let best = guess, bestD = Infinity;
      for (let d = -20; d <= 20; d++) {
        const j = ((guess + d) % m + m) % m;
        const dx = pts[j].x - samples[i].position.x;
        const dz = pts[j].y - samples[i].position.z;
        const dd = dx * dx + dz * dz;
        if (dd < bestD) { bestD = dd; best = j; }
      }
      samples[i].corner = owner[best];
    }
  }

  /**
   * Elevation is a piecewise-linear profile through the corner elevations,
   * blurred over ~60 m of arc length. That keeps the authored gradients but
   * rounds crests and compressions the way earth-moving actually does.
   */
  _buildElevation(samples, corners) {
    const n = samples.length;
    // Arc position of each corner = the midpoint of the samples it owns.
    const keyS = new Array(LAYOUT.length).fill(0);
    const keyY = new Array(LAYOUT.length).fill(0);
    for (let c = 0; c < LAYOUT.length; c++) {
      let first = -1, last = -1;
      for (let i = 0; i < n; i++) if (samples[i].corner === c) { if (first < 0) first = i; last = i; }
      // A corner too short to own a sample falls back to a proportional guess.
      keyS[c] = first < 0 ? (c / LAYOUT.length) * this.length : ((first + last) / 2) * this.step;
      keyY[c] = LAYOUT[c].y;
    }
    void corners;

    const raw = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const s = i * this.step;
      // Find the bracketing pair of corner keys on the circle.
      let a = LAYOUT.length - 1;
      for (let c = 0; c < LAYOUT.length; c++) if (keyS[c] <= s) a = c;
      const b = (a + 1) % LAYOUT.length;
      let span = keyS[b] - keyS[a];
      if (span <= 0) span += this.length;
      let d = s - keyS[a];
      if (d < 0) d += this.length;
      raw[i] = lerp(keyY[a], keyY[b], clamp(d / span, 0, 1));
    }

    const blurred = smoothLoop(raw, Math.round(30 / this.step), 3);
    for (let i = 0; i < n; i++) samples[i].position.y = blurred[i];
  }

  _buildFrames(samples) {
    const n = samples.length;
    for (let i = 0; i < n; i++) {
      const p0 = samples[(i - 1 + n) % n].position;
      const p1 = samples[(i + 1) % n].position;
      samples[i].tangent.subVectors(p1, p0).normalize();
    }
    const k = new Float32Array(n);
    const tmp = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      samples[i].right.crossVectors(samples[i].tangent, UP).normalize();
      const tPrev = samples[(i - 1 + n) % n].tangent;
      const tNext = samples[(i + 1) % n].tangent;
      tmp.subVectors(tNext, tPrev).divideScalar(2 * this.step);
      k[i] = tmp.dot(samples[i].right);
    }
    // Finite differences are noisy, and a real corner has a transition in and
    // out of the constant-radius arc — a ~24 m blur delivers both.
    const ks = smoothLoop(k, Math.round(6 / this.step), 2);
    for (let i = 0; i < n; i++) samples[i].curvature = ks[i];
  }

  _buildWidthAndBanking(samples, corners) {
    const n = samples.length;
    const halfRaw = new Float32Array(n);
    const bankRaw = new Float32Array(n);

    for (let i = 0; i < n; i++) {
      const ci = samples[i].corner;
      const spec = ci >= 0 ? LAYOUT[ci] : null;
      halfRaw[i] = (spec?.width ?? TRACK_WIDTH) / 2;

      const k = samples[i].curvature;
      // Default: gentle drainage camber that leans with the corner. A corner
      // flagged `bank` overrides it with real banking.
      let banking = -clamp(k * 8, -0.075, 0.075);
      if (spec?.bank) {
        const authored = 2 * Math.tan((spec.bank * Math.PI) / 180);
        const side = corners[ci].side;
        banking = -side * authored;
      }
      bankRaw[i] = banking;
    }

    const halfS = smoothLoop(halfRaw, Math.round(26 / this.step), 3);
    const bankS = smoothLoop(bankRaw, Math.round(34 / this.step), 3);
    for (let i = 0; i < n; i++) {
      samples[i].width = Math.min(halfS[i], this.halfWidth);
      samples[i].banking = bankS[i];
      samples[i].up.set(0, 1, 0).addScaledVector(samples[i].right, -bankS[i] * 0.5).normalize();
    }
  }

  /**
   * Rotate the sample array so s = 0 sits START_BEFORE metres in front of
   * START_CORNER. Authored rather than detected, so the grid, the pit lane and
   * the first braking zone all land where the layout intends.
   */
  _rotateStart(corners) {
    const s = this.samples;
    const n = s.length;
    let first = -1;
    for (let i = 0; i < n; i++) if (s[i].corner === START_CORNER) { first = i; break; }
    if (first < 0) return;
    const offset = ((first - Math.round(START_BEFORE / this.step)) % n + n) % n;
    if (offset === 0) return;
    const rotated = s.slice(offset).concat(s.slice(0, offset));
    for (let i = 0; i < n; i++) rotated[i].s = i * this.step;
    this.samples = rotated;
    this.startIndexOffset = offset;
    void corners;
  }

  /** Named corner table: arc-length extents, apex, radius and turn direction. */
  _buildCornerTable(corners) {
    const s = this.samples;
    const n = s.length;
    this.corners = [];
    for (let c = 0; c < LAYOUT.length; c++) {
      // Find the (possibly wrapped) run of samples owned by this corner.
      let start = -1;
      for (let i = 0; i < n; i++) {
        const prev = s[(i - 1 + n) % n].corner;
        if (s[i].corner === c && prev !== c) { start = i; break; }
      }
      if (start < 0) continue;
      let len = 0;
      while (len < n && s[(start + len) % n].corner === c) len++;

      let peak = start, peakK = 0;
      for (let d = 0; d < len; d++) {
        const k = Math.abs(s[(start + d) % n].curvature);
        if (k > peakK) { peakK = k; peak = start + d; }
      }
      const spec = LAYOUT[c];
      const geom = corners[c];
      this.corners.push({
        index: this.corners.length,
        layoutIndex: c,
        name: spec.name,
        number: this.corners.length + 1,
        sIn: this.wrapS(start * this.step),
        sOut: this.wrapS((start + len) * this.step),
        sApex: this.wrapS((start + len * 0.58) * this.step),
        length: len * this.step,
        radius: geom.radius,
        side: geom.side,                  // +1 = right-hander
        peakCurvature: peakK,
        bank: spec.bank ?? 0,
        width: spec.width ?? TRACK_WIDTH,
        kerb: spec.kerb ?? 'standard',
        sausage: !!spec.sausage,
        negative: !!spec.negative,
      });
    }
    this.corners.sort((a, b) => a.sIn - b.sIn);
    this.corners.forEach((c, i) => { c.index = i; c.number = i + 1; });
  }

  _buildSpatialIndex() {
    this._cell = 40;
    this._grid.clear();
    for (let i = 0; i < this.samples.length; i++) {
      const p = this.samples[i].position;
      const key = `${Math.floor(p.x / this._cell)},${Math.floor(p.z / this._cell)}`;
      let arr = this._grid.get(key);
      if (!arr) this._grid.set(key, (arr = []));
      arr.push(i);
    }
  }

  /**
   * Minimum-curvature racing line under the track-width constraint.
   *
   * Writing the line as `centre(s) + right(s) * o(s)`, the world-space
   * curvature of the line is (to second order) `k(s) + o''(s)`. Relaxing
   * `o` toward `-k * step^2 / 2` while clamping to the usable width therefore
   * straightens the path — which is exactly the out-in-out a driver takes.
   */
  _computeRacingLine() {
    const n = this.samples.length;
    const h2 = (this.step * this.step) / 2;
    const limit = new Float32Array(n);
    for (let i = 0; i < n; i++) limit[i] = Math.max(1.0, this.samples[i].width - 1.15);

    let off = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const k = this.samples[i].curvature;
      off[i] = clamp(Math.sign(k) * Math.abs(k) * 900, -limit[i], limit[i]);
    }
    const next = new Float32Array(n);
    for (let pass = 0; pass < 2600; pass++) {
      for (let i = 0; i < n; i++) {
        const a = off[(i - 1 + n) % n], b = off[(i + 1) % n];
        const target = (a + b) * 0.5 + h2 * this.samples[i].curvature;
        next[i] = clamp(off[i] + 0.42 * (target - off[i]), -limit[i], limit[i]);
      }
      off.set(next);
    }
    // A driver sacrifices a little entry for exit: bias the line marginally
    // late by shifting it against the direction of travel.
    const shift = Math.round(6 / this.step);
    const biased = new Float32Array(n);
    for (let i = 0; i < n; i++) biased[i] = off[(i - shift + n) % n] * 0.35 + off[i] * 0.65;
    off = smoothLoop(biased, 2, 1);

    for (let i = 0; i < n; i++) this.samples[i].racing = clamp(off[i], -limit[i], limit[i]);
  }

  /**
   * Quasi-static speed profile along the racing line, used to place rubber
   * build-up in the braking zones and exported for the AI and the HUD.
   */
  _computeSpeedProfile() {
    const n = this.samples.length;
    const A_LAT = 29, A_BRAKE = 44, A_ACCEL = 11.5, V_MAX = 87;
    const step = this.step;

    // Curvature of the racing line, not of the centreline.
    const kLine = new Float32Array(n);
    const p = (i) => {
      const sm = this.samples[((i % n) + n) % n];
      return { x: sm.position.x + sm.right.x * sm.racing, z: sm.position.z + sm.right.z * sm.racing };
    };
    for (let i = 0; i < n; i++) {
      const a = p(i - 3), b = p(i), c = p(i + 3);
      const d1x = b.x - a.x, d1z = b.z - a.z, d2x = c.x - b.x, d2z = c.z - b.z;
      const cross = d1x * d2z - d1z * d2x;
      const l1 = Math.hypot(d1x, d1z), l2 = Math.hypot(d2x, d2z);
      kLine[i] = Math.abs(cross) / Math.max(1e-4, l1 * l2 * ((l1 + l2) * 0.5));
    }
    const kS = smoothLoop(kLine, Math.round(8 / step), 2);

    const v = new Float32Array(n);
    for (let i = 0; i < n; i++) v[i] = Math.min(V_MAX, Math.sqrt(A_LAT / Math.max(1e-5, kS[i])));
    for (let pass = 0; pass < 3; pass++) {
      for (let i = n - 1; i >= 0; i--) {
        const j = (i + 1) % n;
        v[i] = Math.min(v[i], Math.sqrt(v[j] * v[j] + 2 * A_BRAKE * step));
      }
      for (let i = 0; i < n; i++) {
        const j = (i - 1 + n) % n;
        v[i] = Math.min(v[i], Math.sqrt(v[j] * v[j] + 2 * A_ACCEL * step));
      }
    }
    this.speedProfile = v;

    const brake = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const decel = (v[i] * v[i] - v[j] * v[j]) / (2 * step);
      brake[i] = clamp(decel / A_BRAKE, 0, 1);
    }
    this.brakeProfile = smoothLoop(brake, Math.round(6 / step), 2);
  }

  _findDrsZones() {
    const n = this.samples.length;
    const straight = (i) => Math.abs(this.samples[i % n].curvature) < 0.0026;
    const runs = [];
    let start = -1;
    for (let i = 0; i < n * 2; i++) {
      if (straight(i)) { if (start < 0) start = i; }
      else if (start >= 0) {
        if (i - start > 4) runs.push({ a: start % n, len: (i - start) * this.step });
        start = -1;
        if (i >= n) break;
      }
    }
    const seen = new Set();
    const unique = runs.filter((r) => (seen.has(r.a) ? false : (seen.add(r.a), true)));
    unique.sort((a, b) => b.len - a.len);
    const circDist = (a, bb) => { const d = Math.abs(this.wrapS(a - bb)); return Math.min(d, this.length - d); };
    for (const r of unique) {
      if (r.len < 260) continue;
      const sStart = this.wrapS(r.a * this.step + 70);
      const sEnd = this.wrapS(r.a * this.step + r.len - 55);
      if (this.drsZones.some((z) => circDist(z.startS, sStart) < 420 || circDist(z.endS, sEnd) < 420)) continue;
      this.drsZones.push({
        detectS: this.wrapS(sStart - 150),
        startS: sStart,
        endS: sEnd,
        length: r.len,
      });
      if (this.drsZones.length >= 3) break;
    }
    this.drsZones.sort((a, b) => a.startS - b.startS);
  }

  // -- shared surface maths -------------------------------------------------

  /**
   * Height of the racing surface at a lateral offset, relative to the
   * centreline. `environment.js` inlines this same expression — see the file
   * header before changing it.
   */
  _crossSlope(sample, lateral) {
    return -Math.abs(lateral / this.halfWidth) * CROWN + sample.banking * lateral * 0.5;
  }

  // -- meshes ---------------------------------------------------------------

  _trackMaterial() {
    return assets.material('track/asphalt', () => {
      const maps = assets.get('track/asphaltMaps', () => {
        // 2048, NOT 1024. `coarse: 2.1` asks for 300 chippings across the 4 m
        // tile = a 13 mm SMA surface course. At 1024 that chip is 3.3 texels —
        // below what a worley cell can resolve, so the aggregate mipped away to
        // a flat grey felt and there was no visible surface texture at all three
        // metres from the lens. At 2048 it is 6.6 texels and reads.
        const m = cloneMaps(asphalt({ size: 2048, wear: 0.24, coarse: 2.1, key: 'track/asphalt-race' }));
        setRepeat(m, 1, 1);
        return m;
      });
      const detail = assets.texture('track/detail', asphaltDetailTexture);

      const mat = new THREE.MeshStandardMaterial({
        ...mapsToMaterial(maps),
        vertexColors: true,
        roughness: 1,
        metalness: 0,
        envMapIntensity: 0.8,
        dithering: true,
      });
      mat.normalScale.set(0.9, 0.9);

      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uDetail = { value: detail };
        shader.uniforms.uDetailScale = { value: 1 / DETAIL_WORLD_SIZE };
        // Hue drift now lives in the macro block (`age`), so the global tint is
        // only a nudge; anything stronger here fights it.
        shader.uniforms.uTint = { value: new THREE.Color(0.965, 1.0, 1.045) };
        // Tile-average albedo in LINEAR space — the centre the hex-tiling blend
        // restores variance around. `procedural.js` measures it at bake time.
        shader.uniforms.uMeanAlbedo = {
          value: (maps.meanColor ?? new THREE.Vector3(0.02, 0.02, 0.02)).clone(),
        };
        // Arc-length window of the resurfaced section, metres (see _buildRoad).
        shader.uniforms.uRepave = { value: new THREE.Vector2(this._repaveA ?? 0, this._repaveB ?? 0) };

        shader.vertexShader = shader.vertexShader
          .replace('void main() {', /* glsl */`
            attribute vec4 aWear;
            varying vec4 vWear;
            varying vec3 vWorld;
            void main() {
          `)
          .replace('#include <begin_vertex>', /* glsl */`
            #include <begin_vertex>
            vWear = aWear;
            vWorld = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
          `);

        shader.fragmentShader = shader.fragmentShader
          .replace('void main() {', /* glsl */`
            uniform sampler2D uDetail;
            uniform float uDetailScale;
            uniform vec3 uTint;
            uniform vec3 uMeanAlbedo;
            uniform vec2 uRepave;
            varying vec4 vWear;
            varying vec3 vWorld;
            vec3 apexNrmTexel = vec3( 0.5, 0.5, 1.0 );
            float apexRough = 1.0;
            float apexAO = 1.0;

            float apexHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
            vec2 apexHash2( vec2 p ) {
              return fract( sin( vec2( dot( p, vec2( 127.1, 311.7 ) ),
                                       dot( p, vec2( 269.5, 183.3 ) ) ) ) * 43758.5453 );
            }
            float apexNoise( vec2 p ) {
              vec2 i = floor( p ), f = fract( p );
              f = f * f * ( 3.0 - 2.0 * f );
              float a = apexHash( i ), b = apexHash( i + vec2( 1.0, 0.0 ) );
              float c = apexHash( i + vec2( 0.0, 1.0 ) ), d = apexHash( i + vec2( 1.0, 1.0 ) );
              return mix( mix( a, b, f.x ), mix( c, d, f.x ), f.y );
            }
            float apexFbm( vec2 p ) {
              return apexNoise( p ) * 0.55 + apexNoise( p * 2.17 + 4.7 ) * 0.28
                   + apexNoise( p * 4.73 + 11.3 ) * 0.17;
            }

            // ---- HEX STOCHASTIC TILING ------------------------------------
            // Three triangular-lattice taps of the SAME tile, each at its own
            // random offset and axis flip, blended by sharpened barycentric
            // weights. That is what removes the 4 m repeat outright, instead of
            // hiding it under a second rotated copy (which only turns one
            // periodicity into a longer one, and cost the aggregate half its
            // contrast on the way).
            //
            // The flips are +-1 per axis, never a free rotation: a sign flip
            // leaves the derivative MAGNITUDE untouched, so the anisotropic
            // filter footprint is identical for all three taps and there is no
            // mip discontinuity at a cell boundary.
            void apexHex( vec2 st, out vec2 c1, out vec2 c2, out vec2 c3, out vec3 w ) {
              vec2 sk = st * mat2( 1.0, 0.0, -0.57735027, 1.15470054 );
              vec2 base = floor( sk );
              vec3 t3 = vec3( fract( sk ), 0.0 );
              t3.z = 1.0 - t3.x - t3.y;
              if ( t3.z > 0.0 ) {
                w  = vec3( t3.z, t3.y, t3.x );
                c1 = base; c2 = base + vec2( 0.0, 1.0 ); c3 = base + vec2( 1.0, 0.0 );
              } else {
                w  = vec3( -t3.z, 1.0 - t3.y, 1.0 - t3.x );
                c1 = base + vec2( 1.0 ); c2 = base + vec2( 1.0, 0.0 ); c3 = base + vec2( 0.0, 1.0 );
              }
            }
            void main() {
          `)
          // Two rotated, differently scaled samples of the same asphalt tile,
          // cross-faded by world-space noise. Kills the 4 m periodicity that
          // otherwise reads as a chequerboard down a straight.
          .replace('#include <map_fragment>', /* glsl */`
            // Road-frame metres. The ribbon is UV'd as (lateral/4, s/4) and the
            // maps are at repeat = 1, so this is exact.
            float latM = vMapUv.x * 4.0;
            float sM   = vMapUv.y * 4.0;
            float footLat = max( fwidth( latM ), 1e-5 );
            float footS   = max( fwidth( sM ),   1e-5 );

            // ---- AGGREGATE, HEX-TILED --------------------------------------
            // One hex cell is ~1.8 tiles = 7 m, so the crossfades are macro
            // scale and the aggregate inside each cell is never blurred against
            // itself. Explicit gradients: adjacent pixels can land in different
            // cells, and the implicit derivative across that boundary is a
            // whole tile wide, which would blur one texel-thin line to the
            // coarsest mip along every cell edge.
            //
            // THE AGGREGATE IS A NARROW-BAND SIGNAL AND IT MUST NOT BE SAMPLED
            // AT ITS OWN FREQUENCY. A jittered cell grid still has a spectral
            // peak at the cell pitch (13 mm here). A broadcast lens at 70 m
            // puts one pixel's MINOR footprint at ~16 mm, so the mip the GPU
            // picks has texels the same size as a chipping, and the two beat
            // into a stationary diamond lattice about a metre across — the
            // "periodic crosshatch weave" the whole surface was failing on. No
            // amount of anisotropy fixes it; the sampling rate is the problem.
            // Bias the LOD up as the effective (anisotropy-clamped) footprint
            // approaches the chip pitch, so the aggregate is always filtered to
            // below Nyquist and hands over to the world-space macro layers
            // instead of aliasing. Under ~8 mm/pixel — which is everything
            // inside about 12 m of a chase camera — the bias is exactly 1.
            vec2 apexDwx = dFdx( vWorld.xz ), apexDwy = dFdy( vWorld.xz );
            float apexFmin = min( length( apexDwx ), length( apexDwy ) );
            float apexFmax = max( length( apexDwx ), length( apexDwy ) );
            float apexEff = max( apexFmin, apexFmax * 0.125 );
            float apexLod = 1.0 + smoothstep( 0.0065, 0.026, apexEff ) * 1.75;

            vec2 apexDx = dFdx( vMapUv ) * apexLod, apexDy = dFdy( vMapUv ) * apexLod;
            vec2 hc1, hc2, hc3; vec3 hw;
            apexHex( vMapUv * 0.55, hc1, hc2, hc3, hw );
            hw = hw * hw * hw;  hw *= hw;                       // sharpen (^6)
            hw /= ( hw.x + hw.y + hw.z );

            vec2 ho1 = apexHash2( hc1 ), ho2 = apexHash2( hc2 + 7.3 ), ho3 = apexHash2( hc3 + 19.1 );
            vec2 hf1 = step( vec2( 0.5 ), apexHash2( hc1 + 41.7 ) ) * 2.0 - 1.0;
            vec2 hf2 = step( vec2( 0.5 ), apexHash2( hc2 + 63.9 ) ) * 2.0 - 1.0;
            vec2 hf3 = step( vec2( 0.5 ), apexHash2( hc3 + 88.1 ) ) * 2.0 - 1.0;
            vec2 hu1 = vMapUv * hf1 + ho1 * 37.0;
            vec2 hu2 = vMapUv * hf2 + ho2 * 37.0;
            vec2 hu3 = vMapUv * hf3 + ho3 * 37.0;

            vec3 ta = textureGrad( map, hu1, apexDx * hf1, apexDy * hf1 ).rgb;
            vec3 tb = textureGrad( map, hu2, apexDx * hf2, apexDy * hf2 ).rgb;
            vec3 tc = textureGrad( map, hu3, apexDx * hf3, apexDy * hf3 ).rgb;
            // Variance-preserving blend. A plain weighted sum of three taps has
            // 1/sqrt(3) of the contrast of one tap wherever they meet, which is
            // exactly the "flat featureless wash" a naive crossfade produces.
            float hgain = inversesqrt( dot( hw, hw ) );
            vec4 sampledDiffuseColor = vec4(
              max( ( ta * hw.x + tb * hw.y + tc * hw.z - uMeanAlbedo ) * hgain + uMeanAlbedo, 0.0 ), 1.0 );

            vec3 na = textureGrad( normalMap, hu1, apexDx * hf1, apexDy * hf1 ).xyz;
            vec3 nb = textureGrad( normalMap, hu2, apexDx * hf2, apexDy * hf2 ).xyz;
            vec3 nc = textureGrad( normalMap, hu3, apexDx * hf3, apexDy * hf3 ).xyz;
            na.xy = ( na.xy - 0.5 ) * hf1;  nb.xy = ( nb.xy - 0.5 ) * hf2;  nc.xy = ( nc.xy - 0.5 ) * hf3;
            apexNrmTexel = vec3(
              ( na.xy * hw.x + nb.xy * hw.y + nc.xy * hw.z ) * hgain + 0.5,
              na.z * hw.x + nb.z * hw.y + nc.z * hw.z );
            // ORM is low contrast and never carries a recognisable feature, so
            // one tap is enough; taking it from the dominant cell keeps it
            // registered with the aggregate that actually won the albedo blend.
            vec2 ormRG = textureGrad( roughnessMap, hu1, apexDx * hf1, apexDy * hf1 ).rg;
            apexAO = ormRG.r;
            apexRough = ormRG.g;

            vec4 det = texture2D( uDetail, vWorld.xz * uDetailScale );
            vec4 det2 = texture2D( uDetail, vWorld.xz * uDetailScale * 0.379 + vec2( 0.37, 0.81 ) );

            // ---- MACRO TONE, WORLD SPACE -----------------------------------
            // The tile carries NO low-frequency content by construction (see
            // procedural.js), so every metre-and-up variation has to be laid on
            // here, from sources that do not repeat. Four incommensurate octaves
            // from 120 m down to 1.4 m plus the 48 m mask's own blue channel at
            // two scales. Round 3 ran this at +-12 % and the result was a flat
            // wash; a photograph of a race surface runs about +-25 %.
            float macro = apexNoise( vWorld.xz * 0.0083 ) * 0.40
                        + apexNoise( vWorld.xz * 0.0261 + 13.1 ) * 0.29
                        + apexNoise( vWorld.xz * 0.0930 + 47.9 ) * 0.19
                        + apexNoise( vWorld.xz * 0.7100 + 91.3 ) * 0.12;
            sampledDiffuseColor.rgb *= 0.585 + macro * 0.44;
            sampledDiffuseColor.rgb *= 0.88 + det.b * 0.17 + det2.b * 0.10;

            // ---- THE MISSING OCTAVES: 0.20 m and 0.70 m --------------------
            // Between the 13 mm chipping baked into the tile and the 12-120 m
            // macro wash there was NOTHING, which is the whole of "one noise
            // frequency": a surface with a grain and a tone and no body. A
            // finished surface course carries binder-rich and stone-rich
            // pockets at roughly a hand's width, and roller passes that run
            // ALONG the laying direction at roughly a metre. Both are analytic
            // in world space, so neither can tile.
            //
            // Both fade out on the pixel footprint. These are the two scales
            // that pass through Nyquist inside the frame — a 0.20 m feature is
            // five pixels at 25 m and half a pixel at 250 m — and an unfaded
            // half-pixel noise is exactly the crawling shimmer the review
            // predicted the single aggregate frequency would produce.
            float efA = 1.0 - smoothstep( 0.050, 0.150, apexEff );
            float efB = 1.0 - smoothstep( 0.018, 0.060, apexEff );
            float mid = ( apexNoise( vWorld.xz * 1.42 ) - 0.5 ) * efA
                      + ( apexNoise( vWorld.xz * 4.85 + 21.7 ) - 0.5 ) * 0.55 * efB;
            // Roller passes: strongly anisotropic, 1.6 m across and tens of
            // metres long, because that is the width of a screed pass.
            float roller = ( apexNoise( vec2( latM * 0.62, sM * 0.035 ) ) - 0.5 ) * efA;
            sampledDiffuseColor.rgb *= 1.0 + mid * 0.36 + roller * 0.13;
            apexRough = clamp( apexRough - mid * 0.15 - roller * 0.06, 0.30, 1.0 );

            // ---- LOOSE GRIT AND RUBBER CRUMB, ~8 cm ------------------------
            // The 13 mm chipping in the tile HAS to be LOD-biased away as the
            // footprint approaches the chip pitch or it beats against the pixel
            // grid into a diamond lattice (see above), which leaves a broadcast
            // frame with no high-frequency content on the road at all — and a
            // gradient-energy measurement says so. An 8 cm crumb field is four
            // to five pixels at broadcast range and half a metre of texture at
            // walking distance, so it is always resolved and never aliased; a
            // real racing surface is covered in exactly this, shed rubber and
            // stone dust swept into every low spot.
            float crumbFade = 1.0 - smoothstep( 0.013, 0.040, apexEff );
            float crumb = ( apexNoise( vWorld.xz * 12.6 + 5.3 ) - 0.5 ) * crumbFade;
            sampledDiffuseColor.rgb *= 1.0 + crumb * 0.26;
            apexRough = clamp( apexRough + crumb * 0.12, 0.30, 1.0 );
            // Age drifts the hue as well as the value: fresh binder is blue-black,
            // an oxidised, bleached surface is neutral grey. TARMAC IS NEVER
            // BROWN — the sun at 15:20 is already warm and the grade lifts red
            // again, so anything warm authored here lands as wet sand.
            float age = clamp( macro * 0.75 + det2.b * 0.5, 0.0, 1.0 );
            sampledDiffuseColor.rgb *= mix( vec3( 0.93, 0.98, 1.11 ), vec3( 1.02, 1.00, 0.98 ), age );

            // Local repairs. A fresh patch is DARKER than the oxidised surface
            // around it and an old one is lighter, so the sign has to vary or
            // every repair on the circuit reads as the same grey rectangle.
            float patchAmt = max( det.g, det2.g * 0.6 );
            float patchAge = step( 0.5, apexNoise( vWorld.xz * 0.019 + 27.0 ) );
            sampledDiffuseColor.rgb *= mix( 1.0, mix( 0.82, 1.22, patchAge ), patchAmt );
            apexRough = mix( apexRough, 1.0, patchAmt * 0.34 );
            // A REPAIR IS DEFINED BY ITS JOINT, not by its tone. The saw cut is
            // filled with bitumen and reads as a dark rectangle OUTLINE from a
            // helicopter long after the patch itself has weathered to the same
            // grey as the road. The mask is soft-edged by construction, so its
            // 0.5 iso-contour is exactly that outline and costs no extra taps.
            // Take it off det.g ALONE, never the max with the 126 m rescale:
            // that second copy's iso-contour is a slow, curving surface and its
            // outline photographs as a damp patch, not as a saw cut.
            float patchEdge = smoothstep( 0.26, 0.46, det.g ) * smoothstep( 0.74, 0.54, det.g );
            sampledDiffuseColor.rgb *= mix( 1.0, 0.60, patchEdge );
            apexRough = mix( apexRough, 0.74, patchEdge * 0.8 );

            // ---- PAVING JOINTS ---------------------------------------------
            // A racing surface is laid in 3.75 m screed passes, so it carries
            // longitudinal cold joints roughly parallel to the direction of
            // travel, plus a transverse construction joint wherever the paving
            // train stopped. Both are analytic in road-frame metres, and both
            // use a coverage term (line width over pixel footprint) so a joint
            // fades out with distance instead of aliasing into a dashed line.
            //
            // A JOINT IS NOT A RULED LINE. Round 3 drew them at an exact 3.75 m
            // pitch with no lateral wander and 0.56 of the surrounding value,
            // and two of them ran dead straight clean across the frame — read,
            // correctly, as texture tile seams. A screed wanders a hand's width
            // over a hundred metres, the pass width varies, and most of the
            // joint length is invisible.
            float laneF = ( latM + 1.35 ) / 3.75;
            float laneI = floor( laneF + 0.5 );
            float wander = ( apexHash( vec2( laneI, 5.0 ) ) - 0.5 ) * 1.10
                         + ( apexNoise( vec2( sM * 0.017, laneI * 3.3 ) ) - 0.5 ) * 0.75;
            float dLong = abs( latM + 1.35 - laneI * 3.75 - wander );
            // 26 mm of sealed joint, not 11: a cold joint is a saw cut plus an
            // overband, and at 11 mm it was a sub-pixel line everywhere past
            // twenty metres, so the surface lost its longitudinal structure at
            // exactly the range where a broadcast lens spends its time.
            float covLong = clamp( ( 0.026 - dLong ) / footLat + 0.5, 0.0, 1.0 )
                          * smoothstep( 0.30, 0.66, apexNoise( vec2( sM * 0.0125, laneI * 7.1 ) ) );

            float segT = floor( sM / 57.0 );
            float jitT = ( apexHash( vec2( segT, 17.0 ) ) - 0.5 ) * 22.0;
            float dTrans = abs( sM - ( segT * 57.0 + 28.5 + jitT ) );
            float covTrans = clamp( ( 0.016 - dTrans ) / footS + 0.5, 0.0, 1.0 );

            // ---- RESURFACED SECTION ----------------------------------------
            // One stretch of the lap was relaid: a different asphalt age, darker
            // and finer than the oxidised majority, with a hard transverse joint
            // at each end. uRepave is (sStart, sEnd) in metres.
            float inRep = step( uRepave.x, sM ) * step( sM, uRepave.y );
            float dRep = min( abs( sM - uRepave.x ), abs( sM - uRepave.y ) );
            float covRep = clamp( ( 0.026 - dRep ) / footS + 0.5, 0.0, 1.0 );
            sampledDiffuseColor.rgb *= mix( 1.0, 0.90, inRep );
            apexRough = mix( apexRough, apexRough - 0.05, inRep );

            float joint = max( max( covLong * 0.62, covTrans * 0.92 ), covRep );
            sampledDiffuseColor.rgb *= mix( 1.0, 0.68, joint );
            apexRough = mix( apexRough, 0.80, joint * 0.7 );

            // ---- EDGE LINE, ANALYTIC LOD -----------------------------------
            // The painted edge line is real geometry (0.14 m wide, see
            // _buildLines) and at 200 m that quad is a third of a pixel across:
            // it rasterises into a DASHED line, which reads as a lane divider
            // rather than a track limit. Same coverage term as the paving joints,
            // drawn UNDER the geometry — the mesh carries a negative polygon
            // offset and wins wherever it is actually resolved — so the line
            // hands over to a correctly anti-aliased grey instead of breaking up.
            float dEdge = abs( vWear.w + 0.16 );
            float covEdge = clamp( ( 0.07 - dEdge ) / footLat + 0.5, 0.0, 1.0 );
            sampledDiffuseColor.rgb = mix( sampledDiffuseColor.rgb, vec3( 0.52, 0.515, 0.495 ), covEdge );
            apexRough = mix( apexRough, 0.78, covEdge );

            // Tar snakes: near-black sealant, glossier than the aggregate — but
            // 0.42 is a near-mirror. On a horizontal plane seen at the grazing
            // angles a track spends its screen area at, a 0.42 lobe hands the
            // sealant the whole sky and each snake blows out to a bright white
            // ribbon on dark tarmac. Sealant is smooth ASPHALT, not glass.
            // A 150 mm sealant band is a fifth of a pixel from an establishing
            // camera, so the mip chain averages it away to nothing and the whole
            // crack network vanishes exactly where it is doing the most work —
            // a wide shot of a race track is mostly tarmac and it cannot be
            // blank. Once the footprint is wider than the band, det.r IS the
            // coverage fraction, so scaling it back up recovers the average
            // darkening the crack should be contributing to that pixel; the
            // line goes soft with distance instead of disappearing.
            float tarGain = 1.25 + smoothstep( 0.05, 0.55, apexEff ) * 2.6;
            float tar = clamp( max( det.r, det2.r * 0.55 ) * tarGain, 0.0, 1.0 );
            sampledDiffuseColor.rgb = mix( sampledDiffuseColor.rgb, vec3( 0.034, 0.032, 0.033 ), tar * 0.78 );
            apexRough = mix( apexRough, 0.72, tar * 0.8 );
            apexNrmTexel.xy = mix( apexNrmTexel.xy, vec2( 0.5 ), tar * 0.7 );

            // ---- THE RACING LINE -------------------------------------------
            // THIS IS THE TRUE LINE, NOT THE CENTRELINE. vWear.z carries the
            // minimum-curvature line's own signed lateral offset (in units of
            // 8 m), interpolated exactly along the ribbon, so the band swings
            // out to the kerb at every apex and back across the road between
            // corners — the single most legible feature of a real circuit from
            // a broadcast tower, and the one this surface has never had.
            //
            // Evaluating it PER PIXEL rather than in vertex colour is what gives
            // it an edge: the ribbon's 0.42 m column pitch cannot resolve a
            // transition, so a vertex-baked band is a wash by construction. The
            // vertex attribute stays as a low-frequency gate (it knows where the
            // paved surface is, and where the grid's launch rubber goes); the
            // shape and the contrast are built here.
            float dLine = latM - vWear.z * 8.0;
            // The edge of a rubbered band is never a ruled line: twenty cars
            // scallop it over tens of metres.
            float wob = ( apexNoise( vec2( sM * 0.028, 11.0 ) ) - 0.5 ) * 1.7
                      + ( apexNoise( vec2( sM * 0.130, 27.0 ) ) - 0.5 ) * 0.55;
            float aLine = abs( dLine - wob );
            // Three lobes at three widths. The polished core is what a slow
            // camera sees; the halo is a low-frequency 11 m-wide gradient that
            // is the only part of this guaranteed to survive a 1/60 s motion
            // smear, which is what keeps the line readable in the chase shot.
            float lCore = smoothstep( 1.30, 0.12, aLine );
            float lBand = smoothstep( 3.20, 1.00, aLine );
            float lHalo = smoothstep( 5.60, 2.60, aLine );
            // Traffic weight. Everybody brakes in the same forty metres, so a
            // braking zone is several times blacker than a flat-out kink, and
            // the start-line launch box blacker still.
            float traffic = clamp( 0.50 + vWear.y * 1.60 + vWear.x * 0.55, 0.0, 1.45 );
            float lay = clamp( ( lCore * 0.60 + lBand * 0.28 + lHalo * 0.14 ) * traffic, 0.0, 1.0 );
            // Deposited by tyres, not sprayed: mottle it, and stop it dead at
            // the track limit.
            lay *= 0.66 + 0.62 * apexFbm( vWorld.xz * 0.085 );
            lay *= smoothstep( 0.55, -0.25, vWear.w );
            // NEARLY NEUTRAL. Laid rubber is a black-grey and it is tempting to
            // give it the blue cast fresh bitumen has, but the racing line
            // covers a third of the road and the launch box covers all of it:
            // a 0.05 blue lift measured as a 3.7 pp global desaturation on the
            // grid frame, which is a hue regression on twenty cars' worth of
            // tarmac to buy a tint nobody can see.
            sampledDiffuseColor.rgb *= mix( vec3( 1.0 ), vec3( 0.618, 0.621, 0.634 ), lay );
            // ONLY THE CORE IS POLISHED. Rubber fills the voids where it is
            // millimetres thick, which is the 2.6 m a car actually tracks over;
            // out in the halo it is a stain, and the aggregate is still bare.
            // Flattening the normal and the roughness across the whole 11 m
            // band is a measurable loss of surface detail over a third of the
            // road — it cost 12 % of the edge energy in the tv frame's road
            // cells the first time this was written that way.
            float polish = lCore * traffic * 0.62;
            apexRough = mix( apexRough, 0.56, polish );
            apexNrmTexel.xy = mix( apexNrmTexel.xy, vec2( 0.5 ), polish * 0.55 );

            // ---- MARBLES AND THE DIRTY SHOULDER ----------------------------
            // Shed rubber and dust sweep to the outside of the racing surface and
            // stop AT the white line. Both used to be baked into vertex colour
            // off ramps 0.4 m wide — narrower than the 0.42 m column pitch — so
            // Gouraud interpolation turned them into a razor-straight tonal STEP
            // running diagonally across the road. vWear.w is signed metres
            // outboard of the track limit and is exactly linear in lateral, so
            // evaluating the bands here instead is both smooth and free.
            float outM = vWear.w;
            float marb = smoothstep( -3.6, -1.2, outM ) * smoothstep( 0.12, -0.42, outM )
                       * ( 1.0 - lay * 0.80 );
            marb *= 0.45 + 0.55 * apexFbm( vWorld.xz * 0.26 );
            // A MARBLE IS A PELLET, NOT A TINT. The band itself is dust and
            // clippings and reads LIGHTER; the marbles are 4-8 cm shreds of
            // rubber lying ON it and read black, so they need their own
            // frequency or the whole thing is an airbrushed highlight. Faded
            // out once a pellet is under ~3 px, since a pellet field is the
            // easiest thing on the road to alias.
            float pellet = smoothstep( 0.60, 0.90, apexNoise( vWorld.xz * 16.0 ) )
                         * marb * ( 1.0 - smoothstep( 0.012, 0.040, apexEff ) );
            sampledDiffuseColor.rgb *= vec3( 1.0 ) + marb * vec3( 0.22, 0.18, 0.08 );
            sampledDiffuseColor.rgb *= 1.0 - pellet * 0.40;
            apexRough = mix( apexRough, 1.0, marb * 0.85 );
            // Outside the line is DIRTY asphalt — dust, marbles and clippings, a
            // couple of stops down and desaturated.
            float sho = smoothstep( -0.05, 0.95, outM );
            sampledDiffuseColor.rgb *= mix( 1.0, 0.90, sho );

            // ---- LOCK-UP STREAKS -------------------------------------------
            // Every braking zone on the calendar is written on in black. Three
            // candidate streaks per 9 m of a braking zone, scattered about the
            // racing line, each present only ~55 % of the time; the width is
            // grown by the pixel footprint so a 12 cm streak dissolves into the
            // surface at range instead of aliasing into a dashed line.
            float skid = 0.0;
            float brake = vWear.y;
            if ( brake > 0.02 ) {
              float lineLat = vWear.z * 8.0;
              for ( int k = 0; k < 3; k ++ ) {
                float fk = float( k );
                float sc = sM / 9.0 - fk * 0.37;
                float cell = floor( sc );
                vec2 hid = vec2( cell, fk * 31.0 + 5.0 );
                if ( apexHash( hid ) > 0.45 ) {
                  float h2 = apexHash( hid + 19.0 );
                  float h3 = apexHash( hid + 47.0 );
                  float lat0 = lineLat + ( h2 - 0.5 ) * 5.6;
                  float wob = ( apexNoise( vec2( sM * 0.5, cell ) ) - 0.5 ) * 0.12;
                  float wdt = mix( 0.075, 0.150, h3 );
                  float d = abs( latM - lat0 - wob );
                  float f = fract( sc );
                  float along = smoothstep( 0.0, 0.07, f ) * smoothstep( 0.66, 0.34, f );
                  skid = max( skid, smoothstep( wdt + footLat, wdt * 0.3, d )
                                  * along * ( 0.5 + 0.5 * h3 ) );
                }
              }
              skid *= smoothstep( 0.02, 0.30, brake );
            }
            sampledDiffuseColor.rgb *= mix( 1.0, 0.44, skid );
            apexRough = mix( apexRough, 0.68, skid * 0.85 );
            apexNrmTexel.xy = mix( apexNrmTexel.xy, vec2( 0.5 ), skid * 0.5 );

            // SPECULAR ANTI-ALIASING, DRY. weather.js does this in the wet
            // branch and documents why; the dry surface needs it for the same
            // reason. The bands above are metre-scale, and a long-lens broadcast
            // camera views the road at 10-15 deg, which stretches one pixel's
            // world footprint across the road by ~1/sin(depression). A smooth band
            // integrated over that footprint hands back a single sky sample and
            // reads as a painted line. Widening the lobe with the footprint keeps
            // the sheen where it is resolved and folds it back into the aggregate
            // where it is not.
            vec2 apexFoot = fwidth( vWorld.xz );
            apexRough = clamp( apexRough + clamp( length( apexFoot ) * 1.6, 0.0, 0.32 ), 0.0, 1.0 );

            sampledDiffuseColor.rgb *= uTint;
            diffuseColor *= sampledDiffuseColor;
          `)
          .replace('#include <roughnessmap_fragment>', /* glsl */`
            float roughnessFactor = roughness * apexRough;
          `)
          .replace('#include <normal_fragment_maps>', /* glsl */`
            vec3 mapN = apexNrmTexel * 2.0 - 1.0;
            mapN.xy *= normalScale;
            normal = normalize( tbn * mapN );
          `)
          // THE AO CHANNEL WAS THE DIAMOND CROSSHATCH.
          //
          // `aoMap` is the same ORM texture as `roughnessMap`, but three samples
          // it in its own chunk with a PLAIN `texture2D( aoMap, vAoMapUv )` — no
          // LOD bias, no stochastic tiling, none of the care the albedo and the
          // normal get here. The AO channel is the deepest-contrast thing in the
          // whole tile (it goes to 0.66 in the voids between chippings) and it is
          // periodic at the 13 mm chip pitch, so from a broadcast tower it beat
          // against the pixel grid into a regular diamond lattice about a metre
          // across, painted over the tarmac, the racing line and everything else
          // on the road. It survived a flat albedo, a flat normal, a constant
          // roughness and `receiveShadow = false`, which is how it went three
          // rounds being blamed on the aggregate.
          //
          // Route it through the same hex-tiled, LOD-biased tap as the rest.
          .replace('#include <aomap_fragment>', /* glsl */`
            float ambientOcclusion = ( apexAO - 1.0 ) * aoMapIntensity + 1.0;
            reflectedLight.indirectDiffuse *= ambientOcclusion;
            #if defined( USE_ENVMAP ) && defined( STANDARD )
              float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
              reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
            #endif
          `);
      };
      mat.customProgramCacheKey = () => 'apex-track-asphalt';
      return mat;
    });
  }

  _buildRoad() {
    const n = this.samples.length;
    const hw = this.halfWidth;
    const brake = this.brakeProfile;
    const L = this.length;

    // The relaid section: 15 % of the lap, a different asphalt age. Read by the
    // shader as a uniform in metres of arc length; must not straddle s = 0.
    this._repaveA = L * 0.40;
    this._repaveB = L * 0.55;

    // 33 columns across the paved envelope, a verge column each side, and an
    // OVERHANG column 0.5 m further out sloping 4.5 cm down.
    //
    // The overhang exists to kill the 1-2 px olive line that ran along the whole
    // outboard track edge: the environment's run-off apron picks the surface up
    // at exactly hw + VERGE, and any sub-pixel disagreement between the two
    // ribbons there let the green verge behind them show through on the
    // highest-contrast edge in the frame. Tucking my own asphalt under theirs
    // means the worst case is asphalt-on-asphalt, never grass.
    const INNER = 33;
    const cols = new Float32Array(INNER + 4);
    cols[0] = -(hw + VERGE + 0.5);
    cols[1] = -(hw + VERGE);
    for (let c = 0; c < INNER; c++) cols[c + 2] = (-1 + (2 * c) / (INNER - 1)) * hw;
    cols[INNER + 2] = hw + VERGE;
    cols[INNER + 3] = hw + VERGE + 0.5;
    const cc = cols.length;
    const rows = n + 1;

    const pos = new Float32Array(rows * cc * 3);
    const uv = new Float32Array(rows * cc * 2);
    const col = new Float32Array(rows * cc * 3);
    const wear = new Float32Array(rows * cc * 4);
    const idx = [];

    let pi = 0, ui = 0, ci = 0, wi = 0;
    const tmp = new THREE.Vector3();
    for (let r = 0; r < rows; r++) {
      const sm = this.samples[r % n];
      const s = r * this.step;
      const w = sm.width;
      const bk = brake[r % n];

      // Signed arc-length distance from the start/finish line, so the launch
      // rubber the whole grid lays down every start can be placed on it.
      const ds = s > L * 0.5 ? s - L : s;
      const launch = smoothstep(-182, -140, ds) * smoothstep(78, 34, ds);

      for (let c = 0; c < cc; c++) {
        const lat = cols[c];
        const al = Math.abs(lat);
        tmp.copy(sm.position).addScaledVector(sm.right, lat);
        // The verge matches the run-off apron's own drop profile so there is no
        // step where environment.js picks the surface up; the overhang column
        // continues past it, deliberately lower so it always loses the depth
        // test to whatever the environment lays on top.
        const droop = clamp(VERGE / 22, 0, 1) * 0.85 * clamp((al - hw) / VERGE, 0, 1)
          + (al > hw + VERGE ? 0.045 : 0);
        tmp.y += this._crossSlope(sm, lat) - droop;
        pos[pi++] = tmp.x; pos[pi++] = tmp.y; pos[pi++] = tmp.z;
        uv[ui++] = lat / 4; uv[ui++] = s / 4;

        const dRacing = Math.abs(lat - sm.racing);
        // Rubber: a tight glossy core on the line, widening into a fan under
        // braking where twenty cars lock up in the same forty metres.
        // 2.4 m half-width, not 3.3: a 6.6 m band is wider than the racing
        // surface either side of the line, so it washed the whole road instead
        // of reading as a laid-in strip you could point at.
        const core = smoothstep(2.4, 0.5, dRacing);
        const fan = smoothstep(5.2, 1.2, dRacing) * bk;
        const onSurface = smoothstep(w + 0.7, w - 0.6, al);
        const rub = clamp(core * 0.82 + fan * 0.85 + launch * 0.55, 0, 1) * onSurface;

        // TRACK-WEAR CONTRAST IS A NARROW BAND, NOT A PAINT JOB.
        //
        // Only the rubber band is carried in vertex colour, and only because it
        // is 2.4-5.2 m wide — six to twelve columns, which Gouraud can actually
        // interpolate. `dust` (marbles) and `shoulder` used to live here too, on
        // ramps 0.4 m wide against a 0.42 m column pitch: one vertex resolved
        // the whole transition, so what should have been a soft dusty strip came
        // out as a razor-straight tonal STEP running diagonally across the road
        // just inboard of the white line. Both now come off `vWear.w` in the
        // fragment shader, where the ramp is exact at any distance.
        //
        // A photograph of an off-line strip is maybe 8-12 % lighter than the
        // rubbered-in line and a lot DULLER, so most of that contrast is
        // roughness, not albedo.
        // A GENTLE gate, not the effect. Round 4 baked the whole 34 % of the
        // racing line's contrast into vertex colour across a 0.42 m column
        // pitch, which is why it came out as a soft tonal gradient nobody could
        // point at — six columns cannot resolve an edge. The band's shape and
        // contrast are now built per pixel off `aWear.z` (see _trackMaterial);
        // this only carries the part that has to know about the mesh: where the
        // paved surface actually is, and the launch box off the start line.
        const shade = lerp(1, 0.88, rub);
        col[ci++] = shade;
        col[ci++] = shade;
        col[ci++] = shade * (1 + rub * 0.04);
        // aWear: x = rubber build-up, y = braking-zone intensity (lock-up
        // streaks), z = the racing line's own lateral offset / 8 (so the streaks
        // can be scattered about it), w = signed metres outboard of the track
        // limit — used for the analytic edge line AND the marble band.
        wear[wi++] = rub;
        wear[wi++] = bk * onSurface;
        wear[wi++] = sm.racing / 8;
        wear[wi++] = al - w;
      }
    }
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cc - 1; c++) {
        const a = r * cc + c, b = a + 1, d = a + cc, e = d + 1;
        // Columns run along +right, rows along +tangent, right x tangent = +up,
        // so this is the winding that makes the road face the sky.
        idx.push(a, b, d, b, e, d);
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('aWear', new THREE.BufferAttribute(wear, 4));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();

    const mesh = new THREE.Mesh(g, this._trackMaterial());
    mesh.name = 'TrackSurface';
    mesh.receiveShadow = true;
    mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  // -- kerbs ----------------------------------------------------------------

  /**
   * Painted kerbs, sausage kerbs, negative kerbs and astroturf, one merged mesh
   * each. Kerbs exist only where a corner asks for one, and always sit on the
   * racing surface's own edge (which varies with `sample.width`).
   *
   * A KERB IS PRECAST UNITS, NOT A PAINTED RIBBON. This used to be one smooth
   * ribbon with a red/white texture, and it read as exactly that: a flat painted
   * strip with 5 px soft stripe edges, because a mip-filtered colour band cannot
   * be sharp and a smooth ribbon has no shadow line anywhere on it. It is now
   * ~0.9 m concrete units laid end to end with a real recessed joint between
   * them, the red and white carried by VERTEX COLOUR (infinitely sharp at any
   * distance, any mip level) and a per-unit settle so no two units sit exactly
   * flush. The 150 mm serrations are real rows in the ribbon, the outboard face
   * is a 58 deg wall rather than an apron, and the mesh casts shadow so the
   * serrations shadow themselves.
   *
   * EXTENTS. Real circuits kerb the apex and the first 30-60 m of exit and leave
   * everything else as a white line on tarmac. Laying an apex kerb across a full
   * 300 m fillet plus a 190 m exit kerb, as this did, put an unbroken candy
   * stripe down both sides of every wide shot and made it the dominant graphic
   * element in the frame. The apex kerb is now a <=115 m window around the apex,
   * the exit kerb is clamp(len*0.3 + 25, 25, 70), entry kerbs are chicane- and
   * hairpin-only, and corners above a 300 m radius get no kerb at all.
   */
  _buildKerbs() {
    const group = new THREE.Group();
    group.name = 'Kerbs';
    const n = this.samples.length;
    const hw = this.halfWidth;
    const rng = makeRng(hashSeed('track/kerb-units'));

    const painted = { pos: [], uv: [], col: [], idx: [], base: 0 };
    const sausage = { pos: [], uv: [], col: [], idx: [], base: 0 };
    const negative = { pos: [], uv: [], col: [], idx: [], base: 0 };
    const astro = { pos: [], uv: [], col: [], idx: [], base: 0 };
    const tmp = new THREE.Vector3();
    const scratch = {
      position: new THREE.Vector3(), tangent: new THREE.Vector3(),
      right: new THREE.Vector3(), up: new THREE.Vector3(),
    };

    // Drop of the road ribbon below the crown baseline at |lat|. MUST match
    // _buildRoad's `droop` or the kerb's outer flange floats above the asphalt
    // and you can see under it at grazing angles.
    const droopAt = (al) => clamp(VERGE / 22, 0, 1) * 0.85 * clamp((al - hw) / VERGE, 0, 1);

    /**
     * Extrude `profile` (lateral offset from the track edge, height above it)
     * along the arc from sA to sB on `side`. `tint` shades the paint where the
     * cars actually run over it.
     */
    const ribbon = (buf, sA, sB, side, profile, tileMetres, tintFn) => {
      const iA = Math.round(this.wrapS(sA) / this.step);
      let span = Math.round((this.wrapS(sB) - this.wrapS(sA) + this.length) % this.length / this.step);
      if (span < 5) return;
      span = Math.min(span, n - 2);
      const pc = profile.length;
      const fadeRows = Math.min(9, Math.floor(span / 3));

      for (let r = 0; r <= span; r++) {
        const sm = this.samples[(iA + r) % n];
        const dist = (iA + r) * this.step;
        const fade = clamp(Math.min(r, span - r) / Math.max(1, fadeRows), 0, 1);
        const smoothFade = fade * fade * (3 - 2 * fade);
        const t = tintFn ? tintFn(r / span) : 1;
        for (let c = 0; c < pc; c++) {
          const p = profile[c];
          const lat = side * (sm.width + p.lat);
          tmp.copy(sm.position).addScaledVector(sm.right, lat);
          tmp.y += this._crossSlope(sm, lat) + p.h * smoothFade;
          buf.pos.push(tmp.x, tmp.y, tmp.z);
          buf.uv.push(dist / tileMetres, p.v);
          buf.col.push(t, t, t);
        }
      }
      for (let r = 0; r < span; r++) {
        for (let c = 0; c < pc - 1; c++) {
          const i0 = buf.base + r * pc + c;
          const i1 = i0 + 1, i2 = i0 + pc, i3 = i2 + 1;
          if (side > 0) buf.idx.push(i0, i1, i2, i1, i3, i2);
          else buf.idx.push(i0, i2, i1, i1, i2, i3);
        }
      }
      buf.base += (span + 1) * pc;
    };

    // One precast unit's cross-section. `tint` darkens the faces that are not
    // painted (the outer face and the flange), `skirt` means "follow the road
    // surface at this lateral offset, this far below it".
    //
    // The inner edge runs 5 cm UNDER the road ribbon at +4 mm with the material
    // on a negative polygonOffset, so the asphalt/kerb junction cannot open a
    // sliver: an earlier profile ended 30 cm outboard at h = -75 mm, which dips
    // below the asphalt plane, and the green verge behind it showed through the
    // undercut as a lime line along the highest-contrast edge in the frame.
    //
    // THE OUTBOARD FACE IS THE WHOLE POINT AND IT MUST BE NEARLY VERTICAL.
    // Round 4's profile fell from the top face to the run-off over 120 mm — a
    // 20 deg apron, which is a RAMP, not a kerb. Every camera angle that matters
    // (broadcast tower, chase, hero orbit) sees the kerb from outside the corner,
    // so that apron was the largest thing on it and it lit almost exactly like
    // the tarmac beside it: a red-and-white decal at road height, three rounds
    // running. Columns 4 and 5 now drop 80 % of the kerb's height over 25 mm —
    // a 58 deg face that is in shadow whenever the sun is not directly on it,
    // carries its own dark tint, and puts a hard step at the outer edge that the
    // silhouette can break against.
    const kerbProfile = (width, height) => ([
      // 0  inner lip, tucked UNDER the road ribbon
      { lat: -0.05, h: 0.004, v: 0.00, tint: 0.80 },
      // 1  chamfered leading arris — what a tyre actually climbs
      { lat: 0.045, h: height * 0.42, v: 0.06, tint: 1 },
      // 2  top of the climb
      { lat: 0.165, h: height * 0.96, v: 0.17, tint: 1 },
      // 3  top face, crowned so it sheds water outboard
      { lat: width * 0.60, h: height, v: 0.54, tint: 1 },
      // 4  outer arris = the TOP of the vertical face
      { lat: width, h: height * 0.93, v: 0.88, tint: 0.97 },
      // 5  foot of the vertical face: 80 % of the height over 25 mm
      { lat: width + 0.025, h: height * 0.13, v: 0.99, tint: 0.50 },
      // 6  concrete haunch, tucked under the run-off apron
      { lat: width + 0.155, skirt: -0.010, v: 0.94, tint: 0.32 },
    ]);

    /**
     * Astroturf: the strip that terminates a kerb run at each end, so the kerb
     * stops instead of being cut off square. `taperAt` is which end runs out to
     * nothing (-1 = the sA end, +1 = the sB end).
     *
     * This is deliberately NOT a `ribbon`: a constant-width strip of flat green
     * abutting the tarmac reads as a painted rectangle three metres from the
     * lens, which is what the chase frame showed. It has to narrow to a point
     * away from the kerb, and it has to carry the grass tile at its real world
     * scale (u AND v in units of the 3 m `grass()` tile) or it magnifies into an
     * untextured slab.
     */
    const astroRun = (sA, sB, side, width, taperAt) => {
      const spanM = (this.wrapS(sB) - this.wrapS(sA) + this.length) % this.length;
      if (spanM < 2 || spanM > 60) return;
      const steps = Math.max(4, Math.round(spanM / 1.5));
      for (let r = 0; r <= steps; r++) {
        const t = r / steps;
        const d = spanM * t;
        const sm = this.sampleAt(this.wrapS(sA + d), scratch);
        // 1 at the kerb end, 0 at the open end.
        const k = taperAt > 0 ? 1 - t : t;
        const wr = width * (k * k * (3 - 2 * k)) * 0.98 + 0.02;
        for (const p of [
          { lat: -0.02, h: 0.006 },
          { lat: wr * 0.5, h: 0.010 },
          { lat: wr, h: 0.004 },
        ]) {
          const lat = side * (sm.width + p.lat);
          tmp.copy(sm.position).addScaledVector(sm.right, lat);
          tmp.y += this._crossSlope(sm, lat) + p.h;
          astro.pos.push(tmp.x, tmp.y, tmp.z);
          astro.uv.push((sA + d) / 3, (0.02 + p.lat) / 3);
          astro.col.push(1, 1, 1);
        }
      }
      for (let r = 0; r < steps; r++) {
        for (let c = 0; c < 2; c++) {
          const i0 = astro.base + r * 3 + c;
          const i1 = i0 + 1, i2 = i0 + 3, i3 = i2 + 1;
          if (side > 0) astro.idx.push(i0, i1, i2, i1, i3, i2);
          else astro.idx.push(i0, i2, i1, i1, i2, i3);
        }
      }
      astro.base += (steps + 1) * 3;
    };

    // SERRATIONS ARE GEOMETRY, NOT A NORMAL MAP.
    //
    // A normal map cannot self-shadow and cannot break a silhouette, so a
    // normal-mapped serration on a 5 cm kerb disappears the moment the sun is
    // anywhere but side-on: the kerb goes back to reading as a flat painted
    // ribbon, which is exactly what the review saw. A real FIA kerb is a line of
    // precast units whose top face is cut into transverse ribs at a ~125 mm
    // pitch with ~16 mm of relief, with a recessed expansion joint every unit.
    // Both are now rows in the extruded ribbon, so every rib throws a real
    // shadow, breaks the outer edge line, and stays hard at every mip level.
    //
    // EVERY LONGITUDINAL STRIP IS ITS OWN PAIR OF ROWS. This is the whole trick,
    // and getting it wrong is why the first cut of this still looked flat:
    // `computeVertexNormals` averages the faces meeting at a vertex, and on a
    // triangle wave the up-slope and down-slope either side of a crest average to
    // *straight up*. Share the rows and every normal on the kerb comes back
    // vertical — perfect geometry, perfectly flat shading. Duplicating the rows
    // costs vertices but no extra triangles, and it is the only way the facets
    // shade as facets.
    //
    // THE RIB IS AN ASYMMETRIC SAWTOOTH, NOT A SYMMETRIC ONE. A symmetric
    // triangle wave presents two facets tilted the same amount either side of
    // vertical, so under a high sun both shade almost identically and the kerb
    // greys out into a smooth hump — which is what round 4's 17 mm groove on a
    // 180 mm pitch did. The casting has a steep leading flank and a long shallow
    // run-out: 26 mm of relief dropped over 42 mm (32 deg) and recovered over
    // 108 mm (14 deg) puts 46 deg between the two facet normals, so one is
    // always markedly darker than the other, and once the sun is below ~35 deg
    // along the kerb the steep flank shadows the trough outright.
    //
    // COST. ~16 rows/m x 7 columns over ~1.8 km of kerb is ~410 k vertices and
    // ~350 k triangles in ONE merged, static mesh.
    const RIB = 0.15;                  // serration pitch, metres (FIA casting)
    const RIBS_PER_UNIT = 6;
    const UNIT = RIB * RIBS_PER_UNIT;  // 0.90 m precast unit
    const JOINT = 0.026;               // expansion joint between two units
    const PITCH = UNIT + JOINT;
    const GROOVE = 0.026;              // serration depth, metres
    const RIB_STEEP = 0.28;            // fraction of the pitch the steep flank uses
    const JOINT_DROP = 0.028;          // expansion-joint recess, metres
    const TAPER = 4.0;                 // metres over which a run grows/dies
    // How much of the groove each profile column sees. The inner lip (under the
    // road) and the outer haunch (under the run-off) must stay put or the kerb
    // opens a sliver against its neighbours. Everything from the climb to the
    // FOOT of the vertical face is cut, so the serrations notch the outer edge
    // as well as the top — that notched edge is what breaks the silhouette and
    // stops the kerb reading as an extruded ribbon from a broadcast lens.
    const TOP = [0, 0.28, 0.92, 1, 1, 0.80, 0];
    // Albedo of PAINTED CONCRETE IN SUNLIGHT, not of paper. At the old values
    // (0.89 white over a 0.90 texture base) every kerb pixel in `chase` measured
    // 249-251 in the red channel — clipped, so all the relief shading was thrown
    // away before it reached the tonemap and the kerb read as flat plastic.
    const RED = [0.44, 0.074, 0.072];
    const WHITE = [0.70, 0.688, 0.665];
    const MORTAR = [0.26, 0.254, 0.250];
    // What lives in the bottom of a trough: tyre-rubber dust, brake dust and the
    // grit that blows off the run-off. Nearly neutral, VERY dark, and it is the
    // only thing keeping the ribs countable at 40 m once their shading has gone
    // sub-pixel.
    const GRIME = [0.052, 0.048, 0.044];
    // Laid rubber where the cars actually put a wheel on. Rubber on white paint
    // goes brown-grey; on red it goes near-black maroon.
    const RUBBER = [0.075, 0.062, 0.060];

    /**
     * Lay a kerb as discrete precast units from sA to sB on `side`.
     * Rows land on rib crests, rib troughs and joint recesses, so every colour
     * change, every serration and every joint is a hard geometric edge.
     */
    const kerbRun = (sA, sB, side, wantW, wantH) => {
      const spanM = (this.wrapS(sB) - this.wrapS(sA) + this.length) % this.length;
      // A reversed pair of arc positions wraps into a span of nearly a whole
      // lap, which lays the kerb over itself three times over and turns every
      // hard paint edge into z-fighting mush. Nothing on this circuit wants more
      // than ~70 m of kerb in one run.
      if (spanM < PITCH * 3 || spanM > 120) return;
      const units = Math.max(3, Math.round(spanM / PITCH));
      const total = units * PITCH;
      const rubPhase = rng() * Math.PI * 2;

      // (distance along the run, height multiplier, groove depth, colour) per row.
      const rows = [];
      for (let k = 0; k < units; k++) {
        const d0 = k * PITCH;
        const col = (k & 1) === 0 ? RED : WHITE;
        // Settle: a real kerb line is laid by hand and no two units are flush.
        const settle = 1 + (rng() - 0.5) * 0.10;
        // Weathering: the paint on a unit is sun-bleached and scrubbed by a
        // different amount from its neighbours'. Without this the alternation is
        // a perfect square wave and the kerb reads as printed.
        const bleach = 0.86 + rng() * 0.20;
        for (let j = 0; j < RIBS_PER_UNIT; j++) {
          // Crest, then the trough at 28 % of the pitch — the steep flank. The
          // shallow run-out back up to the next crest is the remaining 72 %.
          // Grooves collect rubber dust and grit, so they are darker than the
          // crest even in flat light: that is the hard line that keeps the ribs
          // countable at 40 m where the shading has gone sub-pixel.
          rows.push({ d: d0 + j * RIB, drop: 0, m: settle, col, shade: bleach, dirt: 0.06 });
          rows.push({ d: d0 + (j + RIB_STEEP) * RIB, drop: GROOVE, m: settle, col, shade: bleach * 0.82, dirt: 0.62 });
        }
        rows.push({ d: d0 + UNIT, drop: 0, m: settle, col, shade: bleach, dirt: 0.06 });
        rows.push({ d: d0 + UNIT + 0.005, drop: JOINT_DROP, m: settle, col: MORTAR, shade: 0.9, dirt: 0.55 });
        rows.push({ d: d0 + PITCH - 0.005, drop: JOINT_DROP, m: settle, col: MORTAR, shade: 0.9, dirt: 0.55 });
      }
      rows.push({ d: total, drop: 0, m: 1, col: (units & 1) === 0 ? RED : WHITE, shade: 1, dirt: 0.06 });

      const pc = 7;
      const emitRow = (row) => {
        const sm = this.sampleAt(this.wrapS(sA + row.d), scratch);
        const taper = smoothstep(0, TAPER, row.d) * smoothstep(0, TAPER, total - row.d);
        // Never let the kerb reach past the paved envelope: everything outboard
        // of hw + VERGE belongs to environment.js and is usually green.
        const room = hw + VERGE - 0.14 - sm.width;
        const w = clamp(wantW, 0.50, Math.max(0.50, room)) * lerp(0.42, 1, taper);
        const h = wantH * row.m * taper;
        const profile = kerbProfile(w, h);
        // LAID RUBBER AT THE APEX. The minimum-curvature line is computed as
        // signed lateral metres, so "how close does the racing line come to this
        // kerb" is exact — no authored per-corner numbers, and it lands on the
        // apex of every corner on any layout. Where the line runs to the track
        // limit the whole top face is black with rubber; a metre or two out it
        // is clean paint.
        // PATCHY ALONG THE RUN. Tyres do not lay rubber evenly, and the
        // straight-line 0.76 this term returns over the whole apex-and-exit
        // window greys the entire kerb to one dull tone — which throws away the
        // red/white that makes a kerb readable at any distance at all. Roughly
        // 7 m of blackened kerb alternating with 7 m of dirty-but-legible paint
        // is what a photograph of a used apex shows.
        const patchy = 0.40 + 0.60 * (0.5 - 0.5 * Math.cos(row.d * 0.9 + rubPhase));
        const rubber = smoothstep(3.0, 0.3, Math.abs(side * sm.width - sm.racing)) * patchy;
        for (let c = 0; c < pc; c++) {
          const p = profile[c];
          const lat = side * (sm.width + p.lat);
          const al = Math.abs(lat);
          // A groove may never cut a column below a quarter of its own height,
          // or the notch on the vertical face would punch through the run-off.
          const gd = p.skirt !== undefined ? 0
            : Math.min(row.drop * TOP[c] * taper, Math.max(0, p.h) * 0.7);
          tmp.copy(sm.position).addScaledVector(sm.right, lat);
          tmp.y += this._crossSlope(sm, lat)
            + (p.skirt !== undefined ? p.skirt - droopAt(al) : p.h - gd);
          painted.pos.push(tmp.x, tmp.y, tmp.z);
          painted.uv.push((sA + row.d) / KERB_TILE, p.v);
          const t = p.tint * row.shade;
          // Dirt lives in the troughs and the joints; rubber sits on the top
          // face and the leading chamfer only — the vertical face and the
          // haunch never see a tyre.
          const onTop = c >= 1 && c <= 4 ? 1 : 0.25;
          const grime = clamp(row.dirt + rubber * 0.30 * onTop, 0, 0.92);
          const rub = rubber * 0.55 * onTop;
          for (let ch = 0; ch < 3; ch++) {
            const paint = row.col[ch] * t;
            painted.col.push(lerp(lerp(paint, GRIME[ch], grime), RUBBER[ch], rub));
          }
        }
      };
      for (let r = 0; r < rows.length - 1; r++) {
        emitRow(rows[r]); emitRow(rows[r + 1]);
        const b0 = painted.base + r * 2 * pc;
        for (let c = 0; c < pc - 1; c++) {
          const i0 = b0 + c, i1 = i0 + 1, i2 = i0 + pc, i3 = i2 + 1;
          if (side > 0) painted.idx.push(i0, i1, i2, i1, i3, i2);
          else painted.idx.push(i0, i2, i1, i1, i2, i3);
        }
      }
      painted.base += (rows.length - 1) * 2 * pc;
    };

    // NEGATIVE KERB. The drainage gutter a fast corner gets instead of a ramp,
    // and it is a CASTING with two near-vertical walls, not a dish: the inner
    // wall drops 105 mm over 60 mm so the shadow it throws across the gutter
    // floor is the thing that tells you there is a hole in the road at all. The
    // old profile fell away over 220 mm at 25 deg and photographed as a grey
    // smear painted just outboard of the white line.
    const negProfile = [
      { lat: -0.02, h: 0.004, v: 0.00 },   // flush with the asphalt
      { lat: 0.10, h: -0.012, v: 0.05 },   // the arris the tyre drops over
      { lat: 0.16, h: -0.108, v: 0.13 },   // near-vertical inner wall
      { lat: 0.62, h: -0.124, v: 0.40 },   // gutter floor, falling outboard
      { lat: 1.14, h: -0.118, v: 0.66 },
      { lat: 1.22, h: -0.024, v: 0.76 },   // near-vertical outer wall
      { lat: 1.40, h: 0.028, v: 0.88 },    // raised outer nose
      { lat: 1.72, h: -0.034, v: 1.00 },   // back down onto the run-off
    ];

    /**
     * One sausage hump: a 4.2 m ramped block outboard of the exit kerb.
     *
     * Six columns, not four, and 33 rows, not 11. A sausage is a 150 mm-tall
     * extrusion with a flat crown, a chamfer each side and a near-vertical
     * outboard face, and it carries the same transverse ribbing as a kerb — at
     * 11 rows a 4.2 m hump had one vertex every 420 mm, which is coarser than
     * the rib pitch, so there was nothing on it but a smooth yellow loaf.
     */
    const humpRun = (sA, len, side, latIn, height) => {
      const ROWS = 33;
      const RIB_M = 0.21;                 // sausage rib pitch, metres
      const prof = [
        { lat: latIn, dh: 0.03, v: 0.00 },
        { lat: latIn + 0.11, dh: 0.58, v: 0.12 },
        { lat: latIn + 0.30, dh: 1.00, v: 0.32 },
        { lat: latIn + 0.80, dh: 1.00, v: 0.66 },
        { lat: latIn + 1.00, dh: 0.60, v: 0.86 },
        { lat: latIn + 1.06, dh: 0.05, v: 1.00 },
      ];
      const pc = prof.length;
      for (let r = 0; r < ROWS; r++) {
        const t = r / (ROWS - 1);
        const sm = this.sampleAt(this.wrapS(sA + len * t), scratch);
        const rise = smoothstep(0, 0.16, t) * smoothstep(1, 0.84, t);
        // Transverse ribs, cut into the crown only (the chamfers keep their
        // line so the silhouette stays a clean loaf end-on).
        const rib = 0.5 - 0.5 * Math.cos((len * t / RIB_M) * Math.PI * 2);
        for (const p of prof) {
          const lat = side * (sm.width + p.lat);
          const cut = 0.014 * rib * Math.min(1, p.dh * 1.6) * rise;
          tmp.copy(sm.position).addScaledVector(sm.right, lat);
          tmp.y += this._crossSlope(sm, lat) + 0.004 + height * p.dh * rise - cut;
          sausage.pos.push(tmp.x, tmp.y, tmp.z);
          sausage.uv.push((sA + len * t) / 2.6, p.v);
          const sh = lerp(1, 0.66, rib * Math.min(1, p.dh * 1.6));
          sausage.col.push(sh, sh, sh);
        }
      }
      for (let r = 0; r < ROWS - 1; r++) {
        for (let c = 0; c < pc - 1; c++) {
          const i0 = sausage.base + r * pc + c;
          const i1 = i0 + 1, i2 = i0 + pc, i3 = i2 + 1;
          if (side > 0) sausage.idx.push(i0, i1, i2, i1, i3, i2);
          else sausage.idx.push(i0, i2, i1, i1, i2, i3);
        }
      }
      sausage.base += ROWS * pc;
    };

    for (const corner of this.corners) {
      if (corner.kerb === 'none') continue;
      const inside = corner.side;                     // +1 right-hander
      const slow = corner.radius < 90;
      const chicane = corner.radius < 55;             // hairpins and chicanes
      // A fast curve is taken flat and nobody puts a wheel on the inside of it:
      // a white line is the whole story there.
      if (corner.radius >= 300 && !corner.negative) continue;
      // 190 m-plus: apex kerb only, no exit kerb. This is what breaks the
      // unbroken candy stripe — the review measured a red/white ribbon running
      // 300 m down BOTH sides of the `wide` frame, because a 218 m fillet was
      // getting a 115 m apex kerb inboard and a 70 m exit kerb outboard, which
      // then joined onto the next corner's.
      const fast = corner.radius >= 190;
      const kw = slow ? 1.18 : 0.98;
      const kh = slow ? 0.068 : 0.052;

      // Apex kerb, a window centred on the apex. Real apex kerbs are 40-60 m
      // however long the corner is; this used to run to 115 m.
      const toIn = Math.min(this.wrapS(corner.sApex - corner.sIn), 200);
      const toOut = Math.min(this.wrapS(corner.sOut - corner.sApex), 200);
      const inA = this.wrapS(corner.sApex - Math.min(toIn + 4, 34));
      const inB = this.wrapS(corner.sApex + Math.min(toOut + 8, 40));
      if (corner.negative) {
        // Gutter through the corner, a short run of raised kerb either side of
        // it. Do NOT express these as (apexWindow -> gutterStart): on a long
        // fillet the apex window opens well after turn-in and the pair reverses.
        const gA = this.wrapS(corner.sIn - 10), gB = this.wrapS(corner.sOut + 16);
        ribbon(negative, gA, gB, inside, negProfile, 3, null);
        kerbRun(this.wrapS(gA - 24), gA, inside, kw, kh);
        kerbRun(gB, this.wrapS(gB + 24), inside, kw, kh);
      } else {
        kerbRun(inA, inB, inside, kw, kh);
        // Astroturf where the kerb stops, inboard side.
        astroRun(this.wrapS(inA - 9), inA, inside, kw * 0.85, +1);
        astroRun(inB, this.wrapS(inB + 9), inside, kw * 0.85, -1);
      }

      // Exit kerb on the outside — where the car is actually unloaded. A fast
      // corner gets a token one; a slow one gets the full 40 m.
      {
        const exitLen = fast ? 22 : clamp(corner.length * 0.22 + 14, 14, 42);
        const exA = this.wrapS(corner.sApex + 6);
        const exB = this.wrapS(corner.sApex + 6 + exitLen);
        kerbRun(exA, exB, -inside, kw * 0.92, kh * 0.85);
        astroRun(exB, this.wrapS(exB + 9), -inside, kw * 0.78, -1);
      }

      // Entry kerb on the outside of a chicane or a hairpin, which is the only
      // place a driver actually clips the outside kerb turning in.
      if (chicane) {
        kerbRun(this.wrapS(corner.sIn - 20), this.wrapS(corner.sIn + 4), -inside, 0.92, 0.050);
      }

      // Sausage kerbs: discrete humps just beyond the exit kerb.
      //
      // These have to be built off INTERPOLATED samples. A hump is 4.2 m long
      // and the sample step is 2 m, so routing them through `ribbon` (which
      // steps whole samples and bails under five of them) emitted precisely
      // nothing — there has never been a sausage kerb on this circuit.
      if (corner.sausage) {
        const base = clamp(kw * 0.92, 0.5, hw + VERGE - 1.4 - this.sampleAt(corner.sApex).width);
        for (let hI = 0; hI < 4; hI++) {
          humpRun(this.wrapS(corner.sApex + 18 + hI * 6.4), 4.2, -inside, base, 0.155);
        }
      }
    }

    const finish = (buf, mat, name, cast = true) => {
      if (!buf.idx.length) return null;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(buf.col, 3));
      g.setIndex(buf.idx);
      g.computeVertexNormals();
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, mat);
      mesh.name = name;
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      return mesh;
    };

    const kerbMat = assets.material('track/kerb', () => {
      const maps = assets.get('track/kerbMaps', () => {
        // NEUTRAL, not banded: the red/white is vertex colour on the unit
        // geometry, so it stays a hard edge at every distance and mip level.
        // `ribs: 0` — the serrations are real rows in the ribbon now, and a
        // normal-mapped rib at a different pitch on top of them beats against
        // the geometry into a moire.
        const m = cloneMaps(kerbStripe({
          size: 512, blocks: 6, ribs: 0, bands: false, ribCycles: 44,
          key: 'track/kerb-f1',
        }));
        setRepeat(m, 1, 1);
        return m;
      });
      const mat = new THREE.MeshStandardMaterial({
        ...mapsToMaterial(maps),
        vertexColors: true,
        roughness: 1, metalness: 0,
        envMapIntensity: 0.85,
        dithering: true,
        // The kerb's inner edge deliberately overlaps the road ribbon by 10 cm.
        polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      });
      // The bake is now physically scaled (see kerbStripe), so this is 1:1.
      mat.normalScale.set(1, 1);
      return mat;
    });

    const astroMat = assets.material('track/astroturf', () => {
      const maps = assets.get('track/astroMaps', () => {
        const m = cloneMaps(grass({ size: 512, dry: 0.02, key: 'track/astro' }));
        setRepeat(m, 1, 1);
        return m;
      });
      // Real kerb astroturf is a DULL, blue-shifted synthetic green — nothing
      // like mown grass, and a long way off the 0x4e7a3a it used to be, which
      // photographed as a flat emerald rectangle painted on the tarmac.
      const mat = new THREE.MeshStandardMaterial({
        ...mapsToMaterial(maps),
        vertexColors: true,
        color: 0x3c5a34,
        roughness: 1, metalness: 0, envMapIntensity: 0.40,
        polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
      });
      mat.normalScale.set(1.1, 1.1);
      return mat;
    });

    const sausageMat = assets.material('track/sausage', () => {
      const maps = assets.get('track/sausageMaps', () => {
        const m = cloneMaps(kerbStripe({
          size: 256, blocks: 3, ribs: 0,
          a: [0.78, 0.55, 0.04], c: [0.10, 0.10, 0.10],
          key: 'track/kerb-sausage',
        }));
        setRepeat(m, 1, 1);
        return m;
      });
      const mat = new THREE.MeshStandardMaterial({
        ...mapsToMaterial(maps),
        vertexColors: true,
        roughness: 1, metalness: 0, envMapIntensity: 0.7,
      });
      mat.normalScale.set(0.4, 0.4);
      return mat;
    });

    const negMat = assets.material('track/negativekerb', () => {
      const maps = assets.get('track/negMaps', () => {
        const m = cloneMaps(concrete({ size: 512, stain: 0.6, key: 'track/neg-concrete' }));
        setRepeat(m, 1, 1);
        return m;
      });
      const mat = new THREE.MeshStandardMaterial({
        ...mapsToMaterial(maps),
        vertexColors: true,
        color: 0x9d9c98,
        roughness: 1, metalness: 0, envMapIntensity: 0.6,
      });
      mat.normalScale.set(0.7, 0.7);
      return mat;
    });

    // SHADOW BUDGET. Round 4 turned the painted kerb's shadow off on the
    // argument that a 5 cm step throws a 5 cm shadow nobody can see. That is
    // true of the kerb's own footprint and completely wrong about the thing that
    // actually matters: a shadow caster SELF-shadows, and a 26 mm serration on a
    // 150 mm pitch throws a hard black bar into every trough whenever the sun is
    // below ~35 deg to the kerb's axis, which is most of a lap. Without it the
    // ribs are lit purely by their facet normals under an open sky, the two
    // flanks come out four values apart, and the whole run flattens into the
    // painted ribbon three consecutive reviews called it. It is one extra static
    // draw into a cascade that already gates by chunk.
    for (const m of [
      finish(painted, kerbMat, 'KerbsPainted', true),
      finish(sausage, sausageMat, 'KerbsSausage', true),
      finish(negative, negMat, 'KerbsNegative', true),
      finish(astro, astroMat, 'KerbsAstroturf', false),
    ]) if (m) group.add(m);

    return group;
  }

  // -- painted lines --------------------------------------------------------

  /**
   * Every flat painted marking except the grid: both edge lines, the pit entry
   * taper and the blue pit-exit line, merged into one mesh.
   */
  _buildLines() {
    const n = this.samples.length;
    const buf = { pos: [], uv: [], col: [], idx: [], base: 0 };
    const tmp = new THREE.Vector3();

    /**
     * A painted stripe of `width` metres whose centre follows `latAt(s)`.
     * `rgb` may be a function (t, sm, lat) -> [r,g,b] so brightness can be
     * modulated along the lap.
     */
    const stripe = (sA, sB, latAt, width, rgb, everySample = 1) => {
      const iA = Math.round(this.wrapS(sA) / this.step);
      const span = Math.max(2, Math.round(((this.wrapS(sB) - this.wrapS(sA) + this.length) % this.length) / this.step));
      const rowsUsed = [];
      for (let r = 0; r <= span; r += everySample) rowsUsed.push(r);
      if (rowsUsed[rowsUsed.length - 1] !== span) rowsUsed.push(span);

      for (const r of rowsUsed) {
        const sm = this.samples[(iA + r) % n];
        const s = (iA + r) * this.step;
        const centre = latAt(r / span, sm);
        const ink = typeof rgb === 'function' ? rgb(r / span, sm, centre) : rgb;
        for (const side of [-0.5, 0.5]) {
          const lat = centre + side * width;
          tmp.copy(sm.position).addScaledVector(sm.right, lat);
          tmp.y += this._crossSlope(sm, lat) + 0.006;
          buf.pos.push(tmp.x, tmp.y, tmp.z);
          buf.uv.push(side + 0.5, s / 2);
          buf.col.push(ink[0], ink[1], ink[2]);
        }
      }
      for (let r = 0; r < rowsUsed.length - 1; r++) {
        const i0 = buf.base + r * 2, i1 = i0 + 1, i2 = i0 + 2, i3 = i0 + 3;
        // Faces up whichever way the stripe runs; both windings are emitted for
        // the two-triangle quad by ordering on the +right column.
        buf.idx.push(i0, i1, i2, i1, i3, i2);
      }
      buf.base += rowsUsed.length * 2;
    };

    const WHITE = [1, 1, 1];
    const BLUE = [0.20, 0.36, 0.86];

    // Continuous edge lines, their outer edge exactly on the track limit.
    //
    // WHITE PAINT IS NOT ONE VALUE. Where the racing line runs out to the track
    // limit — every corner exit — twenty cars a lap drive across the paint and
    // scrub it back toward the tarmac; everywhere else it stays bright. Driving
    // the ink off the racing line's own proximity to the edge gets that for free
    // and puts the variation in the right places on any layout.
    for (const side of [-1, 1]) {
      const ink = (t, sm) => {
        const edge = side * (sm.width - 0.16);
        const crossed = smoothstep(2.8, 0.4, Math.abs(edge - sm.racing));
        const k = lerp(1, 0.66, crossed);
        return [k, k, k * 0.985];
      };
      // 16 cm in from the track limit, not 7: the kerb's inner lip lands at
      // `width - 0.04`, so at the old offset the kerb covered the edge line
      // completely and every kerbed corner had a kerb growing straight out of
      // bare tarmac with no track-limit line anywhere near it.
      stripe(0, this.length - 0.001, (t, sm) => side * (sm.width - 0.16), 0.14, ink, 1);
    }

    // Pit entry: the racing surface's edge line peels away to the pit lane,
    // which environment.js starts at s = -420 and lat = -(halfWidth + 4).
    const entryA = this.wrapS(-640), entryB = this.wrapS(-430);
    stripe(entryA, entryB, (t, sm) => lerp(-(sm.width - 0.07), -(this.halfWidth + 4.0), smoothstep(0, 1, t)), 0.16, WHITE, 1);
    // Hatching between the two: three chevron-ish stripes.
    for (let hI = 0; hI < 3; hI++) {
      const a = this.wrapS(-620 + hI * 62);
      stripe(a, this.wrapS(a + 44),
        (t, sm) => lerp(-(sm.width - 0.4), -(this.halfWidth + 3.0), smoothstep(0, 1, (hI + t) / 3.4)), 0.10, WHITE, 1);
    }
    // Pit exit: the blue line cars must not cross on their way back out.
    stripe(this.wrapS(150), this.wrapS(360),
      (t, sm) => lerp(-(this.halfWidth + 4.0), -(sm.width + 0.4), smoothstep(0, 1, t)), 0.18, BLUE, 1);

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(buf.col, 3));
    g.setIndex(buf.idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();

    const mat = assets.material('track/line', () => {
      const maps = assets.get('track/lineMaps', () => {
        const m = cloneMaps(paintedLine({ size: 512, wear: 0.58, edgeDirt: 1, key: 'track/line-worn' }));
        setRepeat(m, 1, 1);
        return m;
      });
      const mm = new THREE.MeshStandardMaterial({
        ...mapsToMaterial(maps),
        vertexColors: true,
        roughness: 1, metalness: 0,
        envMapIntensity: 0.7,
        polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
      });
      mm.normalScale.set(0.4, 0.4);
      return mm;
    });

    const mesh = new THREE.Mesh(g, mat);
    mesh.name = 'TrackLines';
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    return mesh;
  }

  // -- start / finish -------------------------------------------------------

  _buildStartLine() {
    const g = new THREE.Group();
    g.name = 'StartFinish';
    const n = this.samples.length;
    const tmp = new THREE.Vector3();

    // The line itself: a 0.6 m band across the full racing surface. It is
    // shorter than the sample step, so it has to be sampled continuously.
    {
      const pos = [], uv = [], idx = [];
      const rows = 3, COLS = 13;
      for (let r = 0; r < rows; r++) {
        const s = this.wrapS(-0.3 + (r / (rows - 1)) * 0.6);
        const sm = this.sampleAt(s);
        for (let c = 0; c < COLS; c++) {
          const lat = (-1 + (2 * c) / (COLS - 1)) * sm.width;
          tmp.copy(sm.position).addScaledVector(sm.right, lat).addScaledVector(UP, 0.007);
          tmp.y += this._crossSlope(sm, lat);
          pos.push(tmp.x, tmp.y, tmp.z);
          uv.push(c / (COLS - 1), r / (rows - 1));
        }
      }
      for (let r = 0; r < rows - 1; r++) {
        for (let c = 0; c < COLS - 1; c++) {
          const a = r * COLS + c, b = a + 1, d = a + COLS, e = d + 1;
          idx.push(a, b, d, b, e, d);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const mat = assets.material('track/startline', () => new THREE.MeshStandardMaterial({
        color: 0xf4f4ee, roughness: 0.66, metalness: 0,
        envMapIntensity: 0.8,
        polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -5,
      }));
      const m = new THREE.Mesh(geo, mat);
      m.name = 'StartLine';
      m.receiveShadow = true;
      g.add(m);
    }

    // Painted grid boxes, one atlas cell per slot, merged into a single mesh.
    //
    // ROWS MUST ADVANCE WITH s. They used to run the other way (`slot.s - along`
    // with `along` increasing), which reversed the triangle winding against the
    // road's, so all twenty boxes faced DOWN into the tarmac and were back-face
    // culled: the grid shot had twenty cars sitting on completely unmarked
    // asphalt. v is flipped instead, since v = 0 is the ahead end of the cell.
    {
      const atlas = assets.texture('track/gridAtlas', gridBoxAtlas);
      const pos = [], uv = [], idx = [];
      let base = 0;
      const ROWS = 11, COLS = 7;
      for (let i = 0; i < 20; i++) {
        const slot = this.gridSlot(i);
        const cu = (i % GRID_COLS) / GRID_COLS, cv = Math.floor(i / GRID_COLS) / GRID_ROWS;
        for (let r = 0; r < ROWS; r++) {
          const t = r / (ROWS - 1);
          const s = this.wrapS(slot.s + (t - 0.5) * GRID_BOX_L);
          const sm = this.sampleAt(s);
          for (let c = 0; c < COLS; c++) {
            const across = (c / (COLS - 1) - 0.5) * GRID_BOX_W;
            const lat = slot.lateral + across;
            tmp.copy(sm.position).addScaledVector(sm.right, lat);
            tmp.y += this._crossSlope(sm, lat) + 0.009;
            pos.push(tmp.x, tmp.y, tmp.z);
            uv.push(cu + (c / (COLS - 1)) / GRID_COLS, cv + (1 - t) / GRID_ROWS);
          }
        }
        for (let r = 0; r < ROWS - 1; r++) {
          for (let c = 0; c < COLS - 1; c++) {
            const a = base + r * COLS + c, b = a + 1, d = a + COLS, e = d + 1;
            idx.push(a, b, d, b, e, d);
          }
        }
        base += ROWS * COLS;
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx);
      geo.computeVertexNormals();
      const mat = assets.material('track/gridbox', () => new THREE.MeshStandardMaterial({
        map: atlas,
        transparent: true,
        depthWrite: false,
        roughness: 0.7, metalness: 0,
        envMapIntensity: 0.7,
        polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6,
      }));
      const m = new THREE.Mesh(geo, mat);
      m.name = 'GridBoxes';
      m.receiveShadow = true;
      g.add(m);
    }

    return g;
  }

  // -- sampling API ---------------------------------------------------------

  /** Wrap an arc-length value into [0, length). */
  wrapS(s) {
    const L = this.length;
    return ((s % L) + L) % L;
  }

  /** Nearest stored sample (no interpolation). */
  sampleIndex(s) {
    return Math.floor(this.wrapS(s) / this.step) % this.samples.length;
  }

  /**
   * Interpolated sample at arc length `s`.
   * @returns {{s:number, position:THREE.Vector3, tangent:THREE.Vector3, right:THREE.Vector3, up:THREE.Vector3, curvature:number, banking:number, racing:number, width:number}}
   */
  sampleAt(s, out) {
    const n = this.samples.length;
    const w = this.wrapS(s);
    const f = w / this.step;
    const i = Math.floor(f) % n;
    const t = f - Math.floor(f);
    const a = this.samples[i], b = this.samples[(i + 1) % n];
    const o = out ?? {
      position: new THREE.Vector3(), tangent: new THREE.Vector3(),
      right: new THREE.Vector3(), up: new THREE.Vector3(),
    };
    o.s = w;
    o.position.copy(a.position).lerp(b.position, t);
    o.tangent.copy(a.tangent).lerp(b.tangent, t).normalize();
    o.right.copy(a.right).lerp(b.right, t).normalize();
    o.up.copy(a.up).lerp(b.up, t).normalize();
    o.curvature = lerp(a.curvature, b.curvature, t);
    o.banking = lerp(a.banking, b.banking, t);
    o.racing = lerp(a.racing, b.racing, t);
    o.width = lerp(a.width, b.width, t);
    o.corner = a.corner;
    return o;
  }

  frameAt(s) { return this.sampleAt(s); }

  /** World point at (arc length, lateral offset, height above the surface). */
  pointAt(s, lateral = 0, lift = 0, out = new THREE.Vector3()) {
    const sm = this.sampleAt(s);
    out.copy(sm.position).addScaledVector(sm.right, lateral).addScaledVector(sm.up, lift);
    out.y += this._crossSlope(sm, lateral);
    return out;
  }

  curvatureAt(s) { return this.sampleAt(s).curvature; }
  racingLineOffset(s) { return this.sampleAt(s).racing; }
  racingLinePoint(s, lift = 0, out = new THREE.Vector3()) {
    const sm = this.sampleAt(s);
    return this.pointAt(s, sm.racing, lift, out);
  }

  /** Half-width of the racing surface at `s`, metres. */
  widthAt(s) { return this.sampleAt(s).width; }

  /** Centreline elevation at `s`, metres. */
  elevationAt(s) { return this.sampleAt(s).position.y; }

  /** Longitudinal gradient at `s` (rise over run; +ve = uphill). */
  gradientAt(s) {
    const t = this.sampleAt(s).tangent;
    return t.y / Math.max(1e-4, Math.hypot(t.x, t.z));
  }

  /** 0..1 braking demand at `s` from the quasi-static speed profile. */
  brakingAt(s) { return this.brakeProfile ? this.brakeProfile[this.sampleIndex(s)] : 0; }

  /** Reference speed at `s`, m/s (the line an ideal car would run). */
  speedAt(s) { return this.speedProfile ? this.speedProfile[this.sampleIndex(s)] : 80; }

  /**
   * What is under the wheels.
   * @returns {{type:string, grip:number, drag:number, rumble:number}}
   *   type is 'track' | 'kerb' | 'sausage' | 'verge' | 'runoff'
   */
  surfaceAt(s, lateral) {
    const sm = this.sampleAt(s);
    const al = Math.abs(lateral);
    if (al <= sm.width) return { type: 'track', grip: 1, drag: 0, rumble: 0 };
    const corner = this.cornerAt(s, 40);
    const kerbSide = corner ? (lateral > 0 ? 1 : -1) : 0;
    const onKerb = corner && al <= sm.width + 1.35;
    if (onKerb) {
      const sausage = corner.sausage && kerbSide === -corner.side && al > sm.width + 0.9;
      return sausage
        ? { type: 'sausage', grip: 0.55, drag: 0.30, rumble: 1.0 }
        : { type: 'kerb', grip: 0.88, drag: 0.05, rumble: 0.75 };
    }
    if (al <= this.halfWidth + VERGE) return { type: 'verge', grip: 0.94, drag: 0.02, rumble: 0.15 };
    return { type: 'runoff', grip: 0.72, drag: 0.10, rumble: 0.10 };
  }

  /** The corner whose arc contains `s`, within `slack` metres. */
  cornerAt(s, slack = 0) {
    const w = this.wrapS(s);
    for (const c of this.corners) {
      const a = this.wrapS(c.sIn - slack);
      const b = this.wrapS(c.sOut + slack);
      if (a < b ? (w >= a && w <= b) : (w >= a || w <= b)) return c;
    }
    return null;
  }

  /** The next corner at or after `s`. */
  nextCorner(s) {
    const w = this.wrapS(s);
    let best = null, bestD = Infinity;
    for (const c of this.corners) {
      const d = this.wrapS(c.sIn - w);
      if (d < bestD) { bestD = d; best = c; }
    }
    return best;
  }

  /**
   * Project a world position onto the track.
   * @param {THREE.Vector3} p
   * @param {number} [hintS] previous s — makes the search O(1)
   */
  nearest(p, hintS) {
    const n = this.samples.length;
    let bestI = 0, bestD = Infinity;

    if (hintS !== undefined) {
      const centre = this.sampleIndex(hintS);
      const span = 40; // +-80 m
      for (let d = -span; d <= span; d++) {
        const i = (centre + d + n) % n;
        const q = this.samples[i].position;
        const dd = (q.x - p.x) ** 2 + (q.z - p.z) ** 2;
        if (dd < bestD) { bestD = dd; bestI = i; }
      }
    } else {
      const cx = Math.floor(p.x / this._cell), cz = Math.floor(p.z / this._cell);
      let found = false;
      for (let r = 0; r <= 4 && !found; r++) {
        for (let dz = -r; dz <= r; dz++) {
          for (let dx = -r; dx <= r; dx++) {
            if (r > 0 && Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
            const arr = this._grid.get(`${cx + dx},${cz + dz}`);
            if (!arr) continue;
            for (const i of arr) {
              const q = this.samples[i].position;
              const dd = (q.x - p.x) ** 2 + (q.z - p.z) ** 2;
              if (dd < bestD) { bestD = dd; bestI = i; found = true; }
            }
          }
        }
      }
      if (!found) {
        for (let i = 0; i < n; i++) {
          const q = this.samples[i].position;
          const dd = (q.x - p.x) ** 2 + (q.z - p.z) ** 2;
          if (dd < bestD) { bestD = dd; bestI = i; }
        }
      }
    }

    // Refine within the segment for a continuous s.
    const sm = this.samples[bestI];
    const d = _v.subVectors(p, sm.position);
    const along = d.dot(sm.tangent);
    const lateral = d.dot(sm.right);
    const s = this.wrapS(sm.s + along);
    const surface = this.pointAt(s, lateral, 0, _p);
    return { s, lateral, height: p.y - surface.y, surfaceY: surface.y, sample: sm };
  }

  /** True if a lateral offset is on the racing surface (excluding kerbs). */
  onTrack(lateral, s) {
    const hw = s === undefined ? this.halfWidth : this.sampleAt(s).width;
    return Math.abs(lateral) <= hw;
  }

  sectorOf(s) {
    const w = this.wrapS(s);
    if (w < this.sectorStarts[1]) return 0;
    if (w < this.sectorStarts[2]) return 1;
    return 2;
  }

  /** Is DRS permitted at this point for a car within a second of the one ahead? */
  drsZoneAt(s) {
    const w = this.wrapS(s);
    for (const z of this.drsZones) {
      if (z.startS < z.endS ? (w >= z.startS && w <= z.endS) : (w >= z.startS || w <= z.endS)) return z;
    }
    return null;
  }

  /** Starting grid slot `i` (0 = pole). Staggered, 8 m apart, alternating sides. */
  gridSlot(i) {
    const row = Math.floor(i / 2);
    const side = i % 2 === 0 ? -1 : 1;
    const s = this.wrapS(-18 - row * 8.4);
    const lateral = side * 3.0;
    const sm = this.sampleAt(s);
    return {
      s, lateral,
      position: this.pointAt(s, lateral, 0),
      heading: Math.atan2(-sm.tangent.x, -sm.tangent.z),
      tangent: sm.tangent.clone(),
    };
  }

  /** Sample the surface height under an arbitrary world XZ (for terrain blend). */
  surfaceHeightAt(x, z) {
    return this.nearest(_q.set(x, 0, z)).surfaceY;
  }
}

// Module-level scratch — never allocate inside the per-frame query path.
const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
