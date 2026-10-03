/**
 * APEX GP — deterministic randomness.
 *
 * Every random value in the game must come from here so captures are
 * byte-reproducible. `Math.random` is banned outside this module.
 *
 * Coordinate/unit conventions live in CONTRACT.md.
 */

/** Global master seed. Change it and the whole world regenerates identically. */
export const MASTER_SEED = 0x5f1a17;

/** mulberry32 — small, fast, good enough for asset generation. */
export function makeRng(seed = MASTER_SEED) {
  let a = seed >>> 0;
  const rng = function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.range = (lo, hi) => lo + (hi - lo) * rng();
  rng.int = (lo, hi) => Math.floor(lo + (hi - lo + 1) * rng()) ;
  rng.pick = (arr) => arr[Math.min(arr.length - 1, Math.floor(rng() * arr.length))];
  rng.sign = () => (rng() < 0.5 ? -1 : 1);
  /** Box-Muller, unit variance. */
  rng.gauss = () => {
    const u = Math.max(1e-9, rng());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
  };
  return rng;
}

/** Stable string -> 32-bit seed, so `rngFor('kerb')` is repeatable. */
export function hashSeed(str, salt = MASTER_SEED) {
  let h = salt >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Convenience: a named, reproducible generator. */
export function rngFor(name) {
  return makeRng(hashSeed(name));
}

// ---------------------------------------------------------------------------
// Noise — value noise + fbm on a seeded lattice. CPU only (texture baking).
// ---------------------------------------------------------------------------

const _latticeCache = new Map();

/** Periodic value-noise lattice of `n` x `n` floats in [0,1). Cached per key. */
export function lattice(n, seed) {
  const key = `${n}:${seed}`;
  let l = _latticeCache.get(key);
  if (l) return l;
  const rng = makeRng(seed);
  l = new Float32Array(n * n);
  for (let i = 0; i < l.length; i++) l[i] = rng();
  _latticeCache.set(key, l);
  return l;
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);

/** Tiling value noise sampled at (x,y) in lattice space. */
export function valueNoise(l, n, x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const x0 = ((xi % n) + n) % n, y0 = ((yi % n) + n) % n;
  const x1 = (x0 + 1) % n, y1 = (y0 + 1) % n;
  const u = fade(xf), v = fade(yf);
  const a = l[y0 * n + x0], b = l[y0 * n + x1];
  const c = l[y1 * n + x0], d = l[y1 * n + x1];
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

/**
 * Tiling fractal noise in [0,1]. `freq` is cycles across the unit square, so the
 * result tiles seamlessly when sampled over u,v in [0,1).
 */
export function fbm(x, y, { freq = 8, octaves = 5, gain = 0.5, lacunarity = 2, seed = 1 } = {}) {
  let sum = 0, amp = 1, norm = 0, f = freq;
  for (let o = 0; o < octaves; o++) {
    const n = Math.max(2, Math.round(f));
    sum += amp * valueNoise(lattice(n, seed + o * 7919), n, x * n, y * n);
    norm += amp;
    amp *= gain;
    f *= lacunarity;
  }
  return sum / norm;
}

/** Ridged variant — good for cracks, rock, cloud edges. */
export function ridged(x, y, opts = {}) {
  const n = fbm(x, y, opts);
  return 1 - Math.abs(n * 2 - 1);
}

/**
 * Tiling Worley / cellular noise. Returns distance to the nearest feature point
 * normalised to roughly [0,1]. Used for gravel, chipping, puddles.
 */
export function worley(x, y, cells = 8, seed = 3) {
  const rng = makeRng(seed);
  // Feature points are regenerated per call from a cached jitter table.
  const key = `w:${cells}:${seed}`;
  let pts = _latticeCache.get(key);
  if (!pts) {
    pts = new Float32Array(cells * cells * 2);
    for (let i = 0; i < pts.length; i++) pts[i] = rng();
    _latticeCache.set(key, pts);
  }
  const cx = Math.floor(x * cells), cy = Math.floor(y * cells);
  let best = 1e9;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const gx = ((cx + dx) % cells + cells) % cells;
      const gy = ((cy + dy) % cells + cells) % cells;
      const i = (gy * cells + gx) * 2;
      const px = (cx + dx + pts[i]) / cells;
      const py = (cy + dy + pts[i + 1]) / cells;
      const d = (px - x) * (px - x) + (py - y) * (py - y);
      if (d < best) best = d;
    }
  }
  return Math.min(1, Math.sqrt(best) * cells);
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
