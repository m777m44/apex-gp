/**
 * APEX GP — shared procedural texture library.
 *
 * EVERYTHING in the game is generated here; there are no downloaded assets.
 * All generators are deterministic (seeded through `src/core/rng.js`) and
 * memoised, so calling `asphalt()` from five modules costs one bake.
 *
 * ---------------------------------------------------------------------------
 * THE MATERIAL-MAPS CONTRACT
 * ---------------------------------------------------------------------------
 * Surface generators return a `MaterialMaps` object:
 *
 *   {
 *     map:          THREE.DataTexture   // albedo, SRGBColorSpace
 *     normalMap:    THREE.DataTexture   // tangent-space normal, NoColorSpace
 *     ormMap:       THREE.DataTexture   // R=AO  G=roughness  B=metalness
 *     aoMap:        === ormMap          // (glTF ORM packing — one texture,
 *     roughnessMap: === ormMap          //  three slots, one sampler)
 *     metalnessMap: === ormMap
 *     normalScale:  THREE.Vector2
 *     size:         number              // pixels per side
 *     worldSize:    number              // metres the texture covers at repeat=1
 *   }
 *
 * Feed it straight into a standard/physical material:
 *
 *   const m = asphalt();
 *   const mat = new THREE.MeshStandardMaterial({ ...mapsToMaterial(m) });
 *   setRepeat(m, 12, 12);   // mutates the shared textures — see below
 *
 * TILING RULE: the textures are SHARED between callers, so `texture.repeat` is
 * shared too. If you need a different tiling, call `cloneMaps(maps)` first (a
 * cheap Texture clone that reuses the same GPU image) and set repeat on the
 * clone. `setRepeat` is only safe on a clone or on a generator result you
 * requested with a unique `key` option.
 *
 * Sprite/decal generators (`crowdSprite`, `decalAtlas`, `smokeSprite`, ...)
 * return a single THREE.Texture instead, documented per function.
 *
 * All noise tiles seamlessly: u,v are treated as periodic in [0,1).
 */

import * as THREE from 'three';
import { fbm, worley, valueNoise, makeRng, hashSeed, clamp, lerp, smoothstep } from '../core/rng.js';

// ---------------------------------------------------------------------------
// Infrastructure
// ---------------------------------------------------------------------------

const _cache = new Map();
let _anisotropy = 8;

// ---------------------------------------------------------------------------
// Pre-planned noise, for the bakes big enough that the cache lookup dominates
// ---------------------------------------------------------------------------
//
// `rng.js`'s `fbm` and `worley` build a TEMPLATE-STRING cache key on every call
// (`lattice()` does it once per octave). At 1024^2 nobody notices; at 2048^2 the
// asphalt bake makes ~50 M throwaway strings and spends 3.1 s in the garbage
// collector instead of ~0.9 s doing arithmetic. These resolve the lattice and
// the feature-point table ONCE and are otherwise bit-identical to the originals,
// so the baked surface is unchanged — this is a speed fix, not a look change.

const _latPlan = new Map();
function latticeFor(n, seed) {
  const k = n * 131071 + seed;
  let l = _latPlan.get(k);
  if (!l) {
    const r = makeRng(seed);
    l = new Float32Array(n * n);
    for (let i = 0; i < l.length; i++) l[i] = r();
    _latPlan.set(k, l);
  }
  return l;
}

/** Hoist an `fbm` option bag into a plan you can evaluate per pixel. */
function fbmPlan({ freq = 8, octaves = 5, gain = 0.5, lacunarity = 2, seed = 1 } = {}) {
  const ls = [], ns = [], amps = [];
  let amp = 1, norm = 0, f = freq;
  for (let o = 0; o < octaves; o++) {
    const n = Math.max(2, Math.round(f));
    ns.push(n); ls.push(latticeFor(n, seed + o * 7919)); amps.push(amp);
    norm += amp; amp *= gain; f *= lacunarity;
  }
  return { ls, ns, amps, inv: 1 / norm };
}

function fbmAt(p, x, y) {
  let sum = 0;
  for (let o = 0; o < p.ns.length; o++) {
    const n = p.ns[o];
    sum += p.amps[o] * valueNoise(p.ls[o], n, x * n, y * n);
  }
  return sum * p.inv;
}

// ---------------------------------------------------------------------------
// Chip fields — Worley with a per-cell RADIUS and TONE
// ---------------------------------------------------------------------------
//
// A plain Worley grid has one feature point per cell and therefore a hard
// spectral spike at the cell frequency. Minify that spike — which is exactly
// what a mip chain does to a 13 mm aggregate seen from a TV tower — and it
// beats against the texel grid into a REGULAR DIAMOND CROSSHATCH. That weave
// was the road surface's worst artifact.
//
// Two things fix it at the source: give every cell its own radius so the chip
// pitch is a distribution rather than a frequency, and give every cell its own
// albedo so the surface still carries contrast after the relief has mipped
// away. Real surface course is a graded mix of light quartzite and dark basalt;
// that salt-and-pepper is most of what you actually see from three metres.
//
// Layout is stride 4: jitterX, jitterY, tone, 1/radius^2 (in cell units).

const _chipPlan = new Map();
function chipPlan(cells, seed) {
  const k = cells * 1000003 + seed * 7919;
  let p = _chipPlan.get(k);
  if (!p) {
    const r = makeRng((seed ^ 0x9e3779b9) >>> 0);
    p = new Float32Array(cells * cells * 4);
    for (let i = 0; i < p.length; i += 4) {
      p[i] = r(); p[i + 1] = r(); p[i + 2] = r();
      // Grading curve: mostly small chips, a long tail of big ones (0.55..1.65
      // cells). `r()*r()` is the cheapest thing shaped like a sieve curve.
      const rad = 0.55 + 1.10 * r() * r();
      p[i + 3] = 1 / (rad * rad);
    }
    _chipPlan.set(k, p);
  }
  return p;
}

/** `out[0]` = normalised distance to the nearest chip, `out[1]` = its tone. */
function chipAt(pts, cells, x, y, out) {
  const cx = Math.floor(x * cells), cy = Math.floor(y * cells);
  let best = 1e9, bi = 2;
  for (let dy = -1; dy <= 1; dy++) {
    const gy = ((cy + dy) % cells + cells) % cells;
    const row = gy * cells;
    for (let dx = -1; dx <= 1; dx++) {
      const gx = ((cx + dx) % cells + cells) % cells;
      const i = (row + gx) * 4;
      const px = (cx + dx + pts[i]) / cells - x;
      const py = (cy + dy + pts[i + 1]) / cells - y;
      const d = (px * px + py * py) * pts[i + 3];
      if (d < best) { best = d; bi = i + 2; }
    }
  }
  out[0] = Math.min(1, Math.sqrt(best) * cells);
  out[1] = pts[bi];
}

const _chipA = new Float32Array(2);
const _chipB = new Float32Array(2);

/** Called once by the engine after the renderer exists. */
export function setTextureAnisotropy(a) {
  _anisotropy = a;
  for (const v of _cache.values()) {
    if (v && v.isTexture) v.anisotropy = a;
    else if (v && v.map) { v.map.anisotropy = a; v.normalMap.anisotropy = a; v.ormMap.anisotropy = a; }
  }
}

function cached(key, make) {
  let v = _cache.get(key);
  if (v === undefined) { v = make(); _cache.set(key, v); }
  return v;
}

/** Free every baked texture. Only the engine teardown should call this. */
export function disposeAll() {
  for (const v of _cache.values()) {
    if (v && v.isTexture) v.dispose();
    else if (v && v.map) { v.map.dispose(); v.normalMap.dispose(); v.ormMap.dispose(); }
  }
  _cache.clear();
}

function dataTexture(bytes, size, colorSpace) {
  const t = new THREE.DataTexture(bytes, size, size, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.colorSpace = colorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = _anisotropy;
  t.needsUpdate = true;
  return t;
}

/** sRGB byte from a 0..1 linear-ish authoring value (we author perceptually). */
const b = (v) => clamp(Math.round(v * 255), 0, 255);

/** sRGB byte -> linear 0..1, the exact transfer the GPU applies on an sRGB texture. */
const _srgbLut = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  _srgbLut[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const srgbToLinear = (byte) => _srgbLut[byte];

/**
 * Bakes one surface. `fn(u, v, out)` fills `out`:
 *   out.r/g/b  albedo 0..1 (perceptual/sRGB)
 *   out.h      height 0..1 (drives the normal map)
 *   out.ao     ambient occlusion 0..1 (1 = open)
 *   out.rough  roughness 0..1
 *   out.metal  metalness 0..1
 */
function bakeSurface(size, normalStrength, worldSize, fn) {
  const albedo = new Uint8Array(size * size * 4);
  const orm = new Uint8Array(size * size * 4);
  const height = new Float32Array(size * size);
  const out = { r: 0.5, g: 0.5, b: 0.5, h: 0.5, ao: 1, rough: 0.8, metal: 0 };
  let mr = 0, mg = 0, mb = 0;
  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      out.r = out.g = out.b = 0.5; out.h = 0.5; out.ao = 1; out.rough = 0.8; out.metal = 0;
      fn(u, v, out);
      const i = (y * size + x) * 4;
      albedo[i] = b(out.r); albedo[i + 1] = b(out.g); albedo[i + 2] = b(out.b); albedo[i + 3] = 255;
      orm[i] = b(out.ao); orm[i + 1] = b(out.rough); orm[i + 2] = b(out.metal); orm[i + 3] = 255;
      height[y * size + x] = out.h;
      // Accumulate the LINEAR mean: the albedo texture is tagged sRGB, so the
      // sampler hands the shader a decoded value and a stochastic-tiling blend
      // has to re-centre around the mean in that same space.
      mr += srgbToLinear(albedo[i]);
      mg += srgbToLinear(albedo[i + 1]);
      mb += srgbToLinear(albedo[i + 2]);
    }
  }
  const inv = 1 / (size * size);
  return {
    map: dataTexture(albedo, size, THREE.SRGBColorSpace),
    normalMap: normalFromHeight(height, size, normalStrength),
    ormMap: dataTexture(orm, size, THREE.NoColorSpace),
    size,
    worldSize,
    normalScale: new THREE.Vector2(1, 1),
    // Tile-average albedo, in the SAME (sRGB byte / 255) space the texture is
    // stored in. A variance-preserving stochastic-tiling blend needs the mean
    // it is re-centring around; measuring it here is exact and free.
    meanColor: new THREE.Vector3(mr * inv, mg * inv, mb * inv),
    get aoMap() { return this.ormMap; },
    get roughnessMap() { return this.ormMap; },
    get metalnessMap() { return this.ormMap; },
  };
}

/** Sobel height -> tangent-space normal map (OpenGL +Y convention). */
function normalFromHeight(h, size, strength = 2) {
  const px = new Uint8Array(size * size * 4);
  const at = (x, y) => h[(((y % size) + size) % size) * size + (((x % size) + size) % size)];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx =
        (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) -
        (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
      const dy =
        (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) -
        (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
      let nx = -dx * strength, ny = -dy * strength, nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      nx *= inv; ny *= inv; nz *= inv;
      const i = (y * size + x) * 4;
      px[i] = b(nx * 0.5 + 0.5); px[i + 1] = b(ny * 0.5 + 0.5); px[i + 2] = b(nz * 0.5 + 0.5); px[i + 3] = 255;
    }
  }
  return dataTexture(px, size, THREE.NoColorSpace);
}

/** Spread a MaterialMaps into MeshStandardMaterial constructor args. */
export function mapsToMaterial(m, extra = {}) {
  return {
    map: m.map,
    normalMap: m.normalMap,
    normalScale: m.normalScale.clone(),
    aoMap: m.ormMap,
    roughnessMap: m.ormMap,
    metalnessMap: m.ormMap,
    roughness: 1,
    metalness: 1,
    ...extra,
  };
}

/** Set tiling on every map of a MaterialMaps (mutates shared textures). */
export function setRepeat(m, x, y = x) {
  m.map.repeat.set(x, y);
  m.normalMap.repeat.set(x, y);
  m.ormMap.repeat.set(x, y);
  return m;
}

/** Tiling derived from world extent, using the generator's declared worldSize. */
export function repeatForMetres(m, widthM, lengthM) {
  return setRepeat(m, widthM / m.worldSize, lengthM / m.worldSize);
}

/** Cheap clone: new Texture objects sharing the same GPU upload. */
export function cloneMaps(m) {
  const c = {
    map: m.map.clone(),
    normalMap: m.normalMap.clone(),
    ormMap: m.ormMap.clone(),
    size: m.size,
    worldSize: m.worldSize,
    normalScale: m.normalScale.clone(),
    meanColor: (m.meanColor ?? new THREE.Vector3(0.5, 0.5, 0.5)).clone(),
    get aoMap() { return this.ormMap; },
    get roughnessMap() { return this.ormMap; },
    get metalnessMap() { return this.ormMap; },
  };
  c.map.needsUpdate = c.normalMap.needsUpdate = c.ormMap.needsUpdate = true;
  return c;
}

// ---------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------

/**
 * Race-surface asphalt. 4 m of world per tile.
 *
 * FOUR THINGS ARE CALIBRATED HERE, NOT ART-DIRECTED — leave them alone unless
 * you have measured a real surface course.
 *
 * 1. AGGREGATE SIZE. `cells` counts chippings across the 4 m tile, so the chip
 *    pitch is `4 / (143 * coarse)`. The race surface asks for `coarse: 2.1`,
 *    which lands on 300 cells = 13 mm — an SMA 0/11 surface course — with a
 *    second, finer 8 mm layer at 485 cells. At the old 48 cells a chip was 4 cm
 *    across: gravel, not asphalt, and countable from three metres away.
 * 2. AGGREGATE CONTRAST IS BIMODAL, NOT A RAMP. Round 3 gave every chip the
 *    same albedo `+0.055` over the bitumen, which is what a mip filter erases
 *    first: three metres from the lens the tarmac had literally zero visible
 *    structure and at TV range the only thing left was the Worley cell grid
 *    beating against the texel grid — a diamond crosshatch. A surface course is
 *    a GRADED MIX of dark basalt and light quartzite bedded in near-black
 *    bitumen, so the per-chip albedo is drawn from a two-lobe distribution
 *    (`chipTone`) spanning 0.07..0.29. That salt-and-pepper is most of what a
 *    camera records, and unlike relief it survives minification: mip level n
 *    averages a random subset of chips, so the variance falls as 1/N instead of
 *    collapsing to a constant.
 * 3. NO LOW-FREQUENCY CONTENT LIVES IN THE TILE. Anything below ~1/4 of the
 *    tile is a 4 m blob that repeats, and a repeating blob is exactly what reads
 *    as a tiling seam down a straight. Macro tone, patches, tar seams and the
 *    racing line are all laid on in WORLD space by `track/circuit.js`; this
 *    function bakes material, not story. `chipAt` (per-cell radius AND tone)
 *    replaces `worleyAt` for the same reason — one feature point per cell at a
 *    fixed radius is a spectral spike at the cell frequency.
 * 4. NORMAL STRENGTH (the `bakeSurface` argument). `normalFromHeight`'s Sobel
 *    returns `8 * dh/dtexel` in height units, so a PHYSICAL slope needs
 *    `strength = H * size / (8 * worldSize)` where H is the metres of relief the
 *    0..1 height field spans. Surface texture depth here is ~4 mm, giving 0.128
 *    at 1024 px; 0.30 is a deliberate 2.3x exaggeration so the chips still read
 *    under a flat sky. The old 1.6 was 12x physical, which is why every chip
 *    shaded like a boulder and the mid-distance boiled.
 *
 * No tar seams: isotropic ridged noise makes wandering closed loops, and a
 * crack seal is a nearly straight line. `track/circuit.js` lays real ones.
 * @param {{size?:number, wear?:number, coarse?:number, key?:string}} o
 */
export function asphalt(o = {}) {
  const { size = 1024, wear = 0.45, coarse = 1 } = o;
  const cells = Math.max(8, Math.round(143 * coarse));            // 13 mm
  const cellsF = Math.max(10, Math.round(cells * 1.618));         // 8 mm, incommensurate
  const pCoarse = chipPlan(cells, 11), pFine = chipPlan(cellsF, 29);
  const pGrit = fbmPlan({ freq: 190, octaves: 3, seed: 41 });
  const pLay = fbmPlan({ freq: 26, octaves: 2, seed: 67 });
  const pBind = fbmPlan({ freq: 46, octaves: 3, seed: 91 });

  // Two-lobe aggregate albedo. 44 % dark basalt / gabbro, 56 % light quartzite
  // and granite — the split a graded 0/11 mix actually comes out of the plant.
  const chipTone = (tn) => (tn < 0.44
    ? 0.070 + tn * 0.150            // 0.070..0.136  basalt
    : 0.150 + (tn - 0.44) * 0.250); // 0.150..0.290  quartzite

  return cached(o.key ?? `asphalt:${size}:${wear}:${coarse}`, () =>
    bakeSurface(size, 0.30 * (size / 1024), 4, (u, v, t) => {
      chipAt(pCoarse, cells, u, v, _chipA);
      const dC = _chipA[0], toneC = _chipA[1];
      chipAt(pFine, cellsF, u, v, _chipB);
      const dF = _chipB[0], toneF = _chipB[1];

      const grit = fbmAt(pGrit, u, v);
      // Bitumen-rich vs stone-rich pockets — 9 cm scale, well above the chip
      // pitch and well below the tile, so it adds body without adding a repeat.
      const bind = fbmAt(pBind, u, v);
      // The screed leaves faint streaks ALONG the laying direction, which on the
      // race surface is the direction of travel (v in the circuit's road UV).
      const lay = fbmAt(pLay, u, v * 0.09);

      // Chips are flat-topped with a hard shoulder, not cones: the roller irons
      // the surface course, and the top face of a chip is a polished plane.
      const topC = smoothstep(0.94, 0.42, dC);
      const topF = smoothstep(0.97, 0.52, dF) * (1 - topC * 0.85);

      // Mastic: near-black, glossy where it is bitumen-rich, dusty where it is
      // filler-rich.
      const matrix = 0.058 + bind * 0.030 + grit * 0.020;

      let l = matrix;
      let h = 0.06 + grit * 0.10 + bind * 0.08;
      l = lerp(l, chipTone(toneF), topF);
      h = lerp(h, 0.40 + toneF * 0.14, topF);
      l = lerp(l, chipTone(toneC), topC);
      h = lerp(h, 0.66 + toneC * 0.26, topC);

      // Oxidised, sun-bleached wear lifts the exposed chip faces only — the
      // voids stay black, which is why an old surface reads LIGHTER and
      // GRAINIER at once instead of just paler.
      l *= 1 + wear * 0.30 * Math.max(topC, topF);
      l += (lay - 0.5) * 0.012;

      // Quartzite runs warm, basalt runs cold-blue. Tie the hue to the value so
      // the salt-and-pepper carries a little chroma too.
      const warm = clamp((l - 0.075) * 4.2, 0, 1);
      t.r = l * (0.980 + warm * 0.050);
      t.g = l;
      t.b = l * (1.090 - warm * 0.090);

      t.h = clamp(h + (lay - 0.5) * 0.05, 0, 1);
      // Voids between the chips are self-shadowing pits.
      t.ao = 1 - (1 - Math.max(topC, topF * 0.7)) * 0.34;
      // Polished chip faces are the only smooth thing on a dry track; the
      // per-chip spread is what makes the surface sparkle instead of sheening.
      t.rough = clamp(
        0.985 - topC * (0.14 + toneC * 0.20) - topF * 0.10 - wear * 0.05 * topC,
        0.52, 1,
      );
      t.metal = 0;
    })
  );
}

/** Twill-weave carbon fibre. 0.25 m per tile (tow pitch reads correctly). */
export function carbonFibre(o = {}) {
  const { size = 512, tows = 12, tint = 0.0 } = o;
  return cached(o.key ?? `carbon:${size}:${tows}:${tint}`, () =>
    bakeSurface(size, 1.1, 0.25, (u, v, t) => {
      const su = u * tows, sv = v * tows;
      const cu = Math.floor(su), cv = Math.floor(sv);
      const fu = su - cu, fv = sv - cv;
      // 2x2 twill: the warp floats over two picks then under two.
      const over = ((cu + cv) & 2) === 0;
      const along = over ? fv : fu;      // along-tow coordinate
      const across = over ? fu : fv;     // across-tow coordinate
      const bulge = Math.sin(Math.PI * clamp(across, 0, 1));
      // Fibre filaments run along the tow.
      const fil = fbm(over ? u : v, over ? v * 0.06 : u * 0.06, { freq: 220, octaves: 2, seed: 9 });
      const shade = 0.045 + bulge * 0.055 + fil * 0.03;
      t.r = shade * (1 + tint * 0.8); t.g = shade; t.b = shade * (1 + tint * 0.2 + 0.10);
      t.h = bulge * 0.8 + fil * 0.08 + (over ? 0.12 : 0);
      t.ao = 0.55 + bulge * 0.45;
      // Anisotropic-ish: smoother along the filament, rougher at tow edges.
      t.rough = clamp(0.26 + (1 - bulge) * 0.26 + fil * 0.05, 0.15, 0.75);
      t.metal = 0.0;
      void along;
    })
  );
}

/** Tyre rubber — matte, granular, faint mould flow lines. 0.5 m per tile. */
export function rubber(o = {}) {
  const { size = 512, scuff = 0.3 } = o;
  return cached(o.key ?? `rubber:${size}:${scuff}`, () =>
    bakeSurface(size, 1.0, 0.5, (u, v, t) => {
      const grain = fbm(u, v, { freq: 140, octaves: 3, seed: 31 });
      const blotch = fbm(u, v, { freq: 6, octaves: 4, seed: 57 });
      const flow = Math.abs(Math.sin((v + fbm(u, v, { freq: 8, seed: 3 }) * 0.1) * Math.PI * 60));
      const l = 0.032 + grain * 0.022 + blotch * 0.018 + flow * 0.006;
      t.r = l; t.g = l * 0.99; t.b = l * 1.02;
      t.h = grain * 0.5 + flow * 0.2 + blotch * 0.3;
      t.ao = 0.85 + grain * 0.15;
      t.rough = clamp(0.86 - blotch * scuff * 0.35 + grain * 0.06, 0.35, 1);
      t.metal = 0;
    })
  );
}

/** Brushed / machined metal for rims, uprights, wishbone hardware. 0.3 m tile. */
export function brushedMetal(o = {}) {
  const { size = 512, roughBase = 0.28, anisotropy = 1 } = o;
  return cached(o.key ?? `metal:${size}:${roughBase}:${anisotropy}`, () =>
    bakeSurface(size, 0.6, 0.3, (u, v, t) => {
      const streak = fbm(u, v * 0.02, { freq: 300, octaves: 3, seed: 13 });
      const macro = fbm(u, v, { freq: 5, octaves: 3, seed: 71 });
      const l = 0.62 + streak * 0.14 + macro * 0.06;
      t.r = l; t.g = l * 0.995; t.b = l * 0.98;
      t.h = streak * 0.6 + macro * 0.4;
      t.ao = 1;
      t.rough = clamp(roughBase + streak * 0.22 * anisotropy + macro * 0.08, 0.05, 0.9);
      t.metal = 1;
    })
  );
}

/** Poured/precast concrete for walls, pit buildings, run-off. 2 m tile. */
export function concrete(o = {}) {
  const { size = 512, stain = 0.5 } = o;
  return cached(o.key ?? `concrete:${size}:${stain}`, () =>
    bakeSurface(size, 1.0, 2, (u, v, t) => {
      const pits = 1 - worley(u, v, 40, 19);
      const macro = fbm(u, v, { freq: 4, octaves: 5, seed: 61 });
      const grime = fbm(u * 0.5, v * 3, { freq: 6, octaves: 4, seed: 83 });
      let l = 0.46 + macro * 0.14 - pits * 0.16;
      l = lerp(l, l * 0.72, stain * smoothstep(0.55, 0.95, grime));
      t.r = l * 1.01; t.g = l; t.b = l * 0.96;
      t.h = macro * 0.5 - pits * 0.5 + 0.5;
      t.ao = 1 - pits * 0.5;
      t.rough = clamp(0.88 - macro * 0.1 + pits * 0.08, 0.5, 1);
      t.metal = 0;
    })
  );
}

/** Mown circuit grass with clumping and dry patches. 3 m tile. */
export function grass(o = {}) {
  const { size = 512, dry = 0.25 } = o;
  return cached(o.key ?? `grass:${size}:${dry}`, () =>
    bakeSurface(size, 1.4, 3, (u, v, t) => {
      const blades = fbm(u, v, { freq: 190, octaves: 3, seed: 101 });
      const clump = fbm(u, v, { freq: 9, octaves: 4, seed: 113 });
      const macro = fbm(u, v, { freq: 2.5, octaves: 3, seed: 127 });
      const dryness = clamp(dry + macro * 0.5 - 0.2, 0, 1);
      const g = 0.20 + clump * 0.16 + blades * 0.10;
      t.r = lerp(g * 0.42, g * 0.95, dryness);
      t.g = lerp(g * 1.05, g * 0.88, dryness * 0.5);
      t.b = lerp(g * 0.26, g * 0.42, dryness);
      t.h = blades * 0.6 + clump * 0.4;
      t.ao = 0.7 + clump * 0.3;
      t.rough = clamp(0.92 - clump * 0.08, 0.6, 1);
      t.metal = 0;
    })
  );
}

/** Run-off gravel trap. 1.5 m tile. */
export function gravel(o = {}) {
  const { size = 512 } = o;
  return cached(o.key ?? `gravel:${size}`, () =>
    bakeSurface(size, 2.6, 1.5, (u, v, t) => {
      const s1 = 1 - worley(u, v, 26, 5);
      const s2 = 1 - worley(u, v, 55, 17);
      const s3 = fbm(u, v, { freq: 150, octaves: 2, seed: 29 });
      const stone = clamp(s1 * 0.7 + s2 * 0.45, 0, 1);
      const l = 0.34 + stone * 0.24 + s3 * 0.06;
      t.r = l * 1.06; t.g = l; t.b = l * 0.86;
      t.h = stone * 0.85 + s3 * 0.15;
      t.ao = 0.5 + stone * 0.5;
      t.rough = clamp(0.9 - stone * 0.12, 0.6, 1);
      t.metal = 0;
    })
  );
}

/**
 * Painted track line — worn white paint over asphalt. 2 m tile, U ACROSS the
 * stripe (so u = 0 and u = 1 are the two paint edges).
 *
 * Track paint is sprayed onto open-textured asphalt, so it never has a clean
 * edge: the last 1–2 cm is a broken fringe where the bead only caught the tops
 * of the chippings, and dirt collects in that fringe. `edgeDirt` renders that,
 * and it is what stops an edge line reading as vinyl tape.
 */
export function paintedLine(o = {}) {
  const { size = 256, colour = [0.92, 0.92, 0.90], wear = 0.35, edgeDirt = 1 } = o;
  return cached(o.key ?? `line:${size}:${colour.join()}:${wear}:${edgeDirt}`, () =>
    bakeSurface(size, 0.8, 2, (u, v, t) => {
      const chip = fbm(u, v, { freq: 40, octaves: 4, seed: 137 });
      const grit = fbm(u, v, { freq: 200, octaves: 2, seed: 151 });
      const fray = fbm(u, v, { freq: 90, octaves: 3, seed: 163 });
      const worn = smoothstep(0.45, 0.8, chip) * wear;
      // 0 in the middle of the stripe, 1 at either paint edge.
      const rim = smoothstep(0.40, 0.50, Math.abs(u - 0.5));
      const dirt = clamp(edgeDirt * rim * (0.45 + fray * 0.85), 0, 1);
      const l = (1 - worn * 0.65) * (0.94 + grit * 0.1);
      const asph = 0.115;
      t.r = lerp(colour[0] * l, asph * 1.02, dirt);
      t.g = lerp(colour[1] * l, asph, dirt);
      t.b = lerp(colour[2] * l, asph * 1.06, dirt);
      t.h = (0.6 - worn * 0.4 + grit * 0.1) * (1 - dirt * 0.8);
      t.ao = 1 - worn * 0.2 - dirt * 0.25;
      t.rough = clamp(0.55 + worn * 0.35 + grit * 0.08 + dirt * 0.30, 0.3, 1);
      t.metal = 0;
    })
  );
}

/**
 * Kerb surface. U runs ALONG the kerb, v across it. 4 m per tile.
 *
 * `bands: true` alternates the two colours every `4 / blocks` metres in the
 * albedo (used for sausage kerbs). `bands: false` bakes a NEUTRAL cast-concrete
 * surface and leaves the red/white to vertex colour, which is the only way to
 * get a hard paint edge — a texture band is mip-filtered into a 5 px gradient
 * the moment the kerb is more than ten metres away.
 *
 * SERRATIONS. `ribCycles` transverse ribs per tile: 44 over 4 m = a 91 mm pitch
 * with ~12 mm of relief, which is a real FIA kerb casting. The old form was
 * `|sin(u·π·18)|^0.6` — a 22 cm pitch (twice too coarse) whose cusped
 * derivative aliased into a diagonal lattice, and it was baked with a 6.9x
 * over-strong normal, which is what made a foreground kerb read as a quilted
 * rubber mat. The rib is now a raised cosine (C1 everywhere) and the bake
 * strength is the physical `H * size / (8 * worldSize)` for H = 20 mm of relief.
 */
export function kerbStripe(o = {}) {
  const {
    size = 512, a = [0.72, 0.10, 0.12], c = [0.90, 0.90, 0.88],
    blocks = 8, ribs = 1, bands = true, ribCycles = 44,
  } = o;
  const key = o.key ?? `kerb:${size}:${a.join()}:${c.join()}:${blocks}:${ribs}:${bands}:${ribCycles}`;
  return cached(key, () =>
    bakeSurface(size, 0.02 * size / (8 * 4), 4, (u, v, t) => {
      const band = Math.floor(u * blocks);
      const red = (band & 1) === 0;
      const col = bands ? (red ? a : c) : [1, 1, 1];
      const grime = fbm(u, v, { freq: 12, octaves: 4, seed: 173 });
      // 180 was a 2.8 px feature at 512: pure Nyquist mush in the normal map.
      const grit = fbm(u, v, { freq: 46, octaves: 3, seed: 191 });
      const rubberMark = smoothstep(0.55, 0.95, fbm(u * 0.7, v, { freq: 7, octaves: 3, seed: 199 }));
      const rib = ribs ? 0.5 - 0.5 * Math.cos(u * Math.PI * 2 * ribCycles) : 0.5;
      // The casting's own arris: the outer 4 cm of the top face rolls off.
      const edge = smoothstep(0.0, 0.06, v) * smoothstep(0.0, 0.10, 1 - v);
      const base = bands ? 0.85 : 0.90;
      let l = base + grit * 0.09 - grime * 0.16;
      l *= lerp(1, 0.62, rubberMark * 0.8);
      t.r = col[0] * l; t.g = col[1] * l; t.b = col[2] * l;
      t.h = rib * 0.62 * edge + edge * 0.26 + grit * 0.12;
      t.ao = 0.72 + 0.28 * edge - rib * 0.10;
      t.rough = clamp(0.62 + grime * 0.25 + rubberMark * 0.1, 0.35, 1);
      t.metal = 0;
    })
  );
}

/** Woven fabric for team kit, garage banners, marshal flags, awnings. 1 m tile. */
export function fabric(o = {}) {
  const { size = 256, colour = [0.8, 0.8, 0.82] } = o;
  return cached(o.key ?? `fabric:${size}:${colour.join()}`, () =>
    bakeSurface(size, 0.9, 1, (u, v, t) => {
      const wu = Math.abs(Math.sin(u * Math.PI * 90));
      const wv = Math.abs(Math.sin(v * Math.PI * 90));
      const weave = (wu + wv) * 0.5;
      const fuzz = fbm(u, v, { freq: 120, octaves: 2, seed: 211 });
      const l = 0.78 + weave * 0.2 + fuzz * 0.1;
      t.r = colour[0] * l; t.g = colour[1] * l; t.b = colour[2] * l;
      t.h = weave * 0.7 + fuzz * 0.3;
      t.ao = 0.7 + weave * 0.3;
      t.rough = clamp(0.9 - weave * 0.06, 0.6, 1);
      t.metal = 0;
    })
  );
}

// ---------------------------------------------------------------------------
// Sprites & atlases (single RGBA textures, sRGB, with alpha)
// ---------------------------------------------------------------------------

function canvas2d(w, h) {
  const c = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });
  c.width = w; c.height = h;
  return { c, x: c.getContext('2d', { willReadFrequently: false }) };
}

function canvasTexture(c, { srgb = true, repeat = false, mips = true } = {}) {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.wrapS = t.wrapT = repeat ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.generateMipmaps = mips;
  t.minFilter = mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = _anisotropy;
  t.needsUpdate = true;
  return t;
}

/**
 * Grandstand crowd atlas: `cols x rows` seated/standing spectator silhouettes,
 * each cell transparent outside the figure. Use with an InstancedMesh of quads
 * and per-instance UV offset (see `crowdSpriteUV`).
 * Returns THREE.Texture (RGBA, sRGB, transparent).
 */
export const CROWD_COLS = 8;
export const CROWD_ROWS = 4;

export function crowdSprite(o = {}) {
  const { cell = 64 } = o;
  return cached(`crowd:${cell}`, () => {
    const W = cell * CROWD_COLS, H = cell * CROWD_ROWS;
    const { c, x } = canvas2d(W, H);
    x.clearRect(0, 0, W, H);
    const rng = makeRng(hashSeed('crowd'));
    // A GRANDSTAND IS NOT A BAG OF SKITTLES. Ten equally-weighted fully
    // saturated primaries, picked uniformly, put a pure hue on every one of the
    // 4000-odd instanced sprites; through a look grade that lifts saturation to
    // 1.10 the main stand came out as rainbow confetti and was the loudest thing
    // in `beauty`, `front` and `wheel`. A photograph of a real crowd is mostly
    // denim, grey, black, white and skin, with team colour as the ACCENT — so
    // weight the neutrals by repeating them (rng.pick is uniform) and desaturate
    // what is left. The stand still reads as a crowd, and as team colour from
    // 200 m, without competing with the car.
    const shirts = [
      '#2b3140', '#2b3140', '#39404e', '#39404e', '#1b1f28', '#1b1f28',
      '#565f6d', '#565f6d', '#7b8494', '#9aa1ac',
      '#d8d5cd', '#d8d5cd', '#b9b4a8', '#8c8578',
      '#3a4f7a', '#3a4f7a', '#2f5d8c', '#6b7f9e',
      '#a33a35', '#a33a35', '#7d2a28', '#c25a4a',
      '#c9a63c', '#8a7b3a', '#3f7a52', '#2f5d43',
      '#8a4a2a', '#6d4a7a', '#2f7c8a', '#b06a8a',
    ];
    const skins = ['#f0c8a0', '#d8a074', '#a86b45', '#6b4326', '#f7d9bd'];
    for (let r = 0; r < CROWD_ROWS; r++) {
      for (let cix = 0; cix < CROWD_COLS; cix++) {
        const ox = cix * cell, oy = r * cell;
        const shirt = rng.pick(shirts), skin = rng.pick(skins);
        const cx = ox + cell * 0.5;
        const lean = rng.range(-0.06, 0.06) * cell;
        const armsUp = rng() < 0.28;
        // torso
        x.fillStyle = shirt;
        x.beginPath();
        x.moveTo(cx - cell * 0.20 + lean, oy + cell * 0.42);
        x.lineTo(cx + cell * 0.20 + lean, oy + cell * 0.42);
        x.lineTo(cx + cell * 0.26, oy + cell * 0.98);
        x.lineTo(cx - cell * 0.26, oy + cell * 0.98);
        x.closePath();
        x.fill();
        // arms
        x.strokeStyle = shirt;
        x.lineWidth = cell * 0.11;
        x.lineCap = 'round';
        x.beginPath();
        if (armsUp) {
          x.moveTo(cx - cell * 0.18, oy + cell * 0.5); x.lineTo(cx - cell * 0.30, oy + cell * 0.18);
          x.moveTo(cx + cell * 0.18, oy + cell * 0.5); x.lineTo(cx + cell * 0.30, oy + cell * 0.18);
        } else {
          x.moveTo(cx - cell * 0.20, oy + cell * 0.48); x.lineTo(cx - cell * 0.30, oy + cell * 0.80);
          x.moveTo(cx + cell * 0.20, oy + cell * 0.48); x.lineTo(cx + cell * 0.30, oy + cell * 0.80);
        }
        x.stroke();
        // head
        x.fillStyle = skin;
        x.beginPath();
        x.arc(cx + lean, oy + cell * 0.30, cell * 0.145, 0, Math.PI * 2);
        x.fill();
        // cap / hair
        x.fillStyle = rng() < 0.5 ? shirt : '#2a2f38';
        x.beginPath();
        x.arc(cx + lean, oy + cell * 0.28, cell * 0.15, Math.PI, Math.PI * 2);
        x.fill();
      }
    }
    return canvasTexture(c);
  });
}

/** UV offset+scale for crowd atlas cell `i` (wraps). */
export function crowdSpriteUV(i) {
  const n = CROWD_COLS * CROWD_ROWS;
  const k = ((i % n) + n) % n;
  return {
    offset: new THREE.Vector2((k % CROWD_COLS) / CROWD_COLS, 1 - Math.floor(k / CROWD_COLS + 1) / CROWD_ROWS),
    scale: new THREE.Vector2(1 / CROWD_COLS, 1 / CROWD_ROWS),
  };
}

/**
 * Sponsor / marking decal atlas — a 4x4 grid of transparent wordmarks and
 * marks used by liveries, barriers and trackside boards.
 * Look up a cell rect with `decalAtlasUV(name)`.
 */
export const DECAL_NAMES = [
  'apex', 'volt', 'nitron', 'kappa',
  'orbit', 'zenith', 'hydra', 'quantum',
  'tyreLogo', 'fia', 'drs', 'pirelli',
  'arrowL', 'arrowR', 'chevron', 'star',
];
const DECAL_GRID = 4;

export function decalAtlas(o = {}) {
  const { cell = 256 } = o;
  return cached(`decals:${cell}`, () => {
    const S = cell * DECAL_GRID;
    const { c, x } = canvas2d(S, S);
    x.clearRect(0, 0, S, S);
    const draw = (i, fn) => {
      x.save();
      x.translate((i % DECAL_GRID) * cell, Math.floor(i / DECAL_GRID) * cell);
      x.beginPath(); x.rect(0, 0, cell, cell); x.clip();
      fn(x, cell);
      x.restore();
    };
    const word = (ctx, s, text, colour, weight = 900, italic = false, spacing = 0.04) => {
      ctx.fillStyle = colour;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.letterSpacing = `${Math.round(s * spacing)}px`;
      ctx.font = `${italic ? 'italic ' : ''}${weight} ${Math.round(s * 0.30)}px Helvetica, Arial, sans-serif`;
      ctx.fillText(text, s * 0.5, s * 0.5);
    };
    draw(0, (ctx, s) => word(ctx, s, 'APEX', '#ffffff', 900, true, 0.02));
    draw(1, (ctx, s) => {
      word(ctx, s, 'VOLT', '#ffffff');
      ctx.strokeStyle = '#ffd400'; ctx.lineWidth = s * 0.035;
      ctx.beginPath(); ctx.moveTo(s * 0.18, s * 0.70); ctx.lineTo(s * 0.82, s * 0.70); ctx.stroke();
    });
    draw(2, (ctx, s) => word(ctx, s, 'NITRON', '#ffffff', 800, true, 0.0));
    draw(3, (ctx, s) => {
      ctx.fillStyle = '#ffffff';
      ctx.font = `900 ${Math.round(s * 0.5)}px Helvetica, Arial, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('K', s * 0.34, s * 0.5);
      word(ctx, s, '', '#fff');
      ctx.font = `700 ${Math.round(s * 0.2)}px Helvetica, Arial, sans-serif`;
      ctx.fillText('APPA', s * 0.64, s * 0.54);
    });
    draw(4, (ctx, s) => {
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = s * 0.05;
      ctx.beginPath(); ctx.ellipse(s * 0.5, s * 0.5, s * 0.34, s * 0.16, -0.5, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(s * 0.5, s * 0.5, s * 0.11, 0, Math.PI * 2); ctx.fill();
    });
    draw(5, (ctx, s) => word(ctx, s, 'ZENITH', '#ffffff', 300, false, 0.10));
    draw(6, (ctx, s) => word(ctx, s, 'HYDRA', '#ffffff', 900, false, 0.0));
    draw(7, (ctx, s) => word(ctx, s, 'QUANTUM', '#ffffff', 600, false, 0.02));
    draw(8, (ctx, s) => {
      ctx.fillStyle = '#ffffff';
      ctx.font = `900 ${Math.round(s * 0.26)}px Helvetica, Arial, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('APEX', s * 0.5, s * 0.38);
      ctx.fillStyle = '#e10600';
      ctx.fillText('P ZERO', s * 0.5, s * 0.66);
    });
    draw(9, (ctx, s) => word(ctx, s, 'FIA', '#ffffff', 800, false, 0.06));
    draw(10, (ctx, s) => word(ctx, s, 'DRS', '#00e05a', 900, false, 0.06));
    draw(11, (ctx, s) => word(ctx, s, 'SOFT', '#e10600', 900, false, 0.05));
    draw(12, (ctx, s) => {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.moveTo(s * 0.75, s * 0.2); ctx.lineTo(s * 0.25, s * 0.5); ctx.lineTo(s * 0.75, s * 0.8); ctx.closePath(); ctx.fill();
    });
    draw(13, (ctx, s) => {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.moveTo(s * 0.25, s * 0.2); ctx.lineTo(s * 0.75, s * 0.5); ctx.lineTo(s * 0.25, s * 0.8); ctx.closePath(); ctx.fill();
    });
    draw(14, (ctx, s) => {
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = s * 0.12; ctx.lineJoin = 'miter';
      ctx.beginPath(); ctx.moveTo(s * 0.2, s * 0.7); ctx.lineTo(s * 0.5, s * 0.3); ctx.lineTo(s * 0.8, s * 0.7); ctx.stroke();
    });
    draw(15, (ctx, s) => {
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
        const r = i % 2 ? s * 0.16 : s * 0.38;
        ctx[i ? 'lineTo' : 'moveTo'](s * 0.5 + Math.cos(a) * r, s * 0.5 + Math.sin(a) * r);
      }
      ctx.closePath(); ctx.fill();
    });
    return canvasTexture(c);
  });
}

/** `{ offset: Vector2, scale: Vector2 }` for a named decal cell. */
export function decalAtlasUV(name) {
  const i = Math.max(0, DECAL_NAMES.indexOf(name));
  const s = 1 / DECAL_GRID;
  return {
    offset: new THREE.Vector2((i % DECAL_GRID) * s, 1 - (Math.floor(i / DECAL_GRID) + 1) * s),
    scale: new THREE.Vector2(s, s),
  };
}

/** Soft radial alpha blob — tyre smoke, dust, spray. Greyscale RGBA. */
export function smokeSprite(o = {}) {
  const { size = 256, wisp = 1 } = o;
  return cached(`smoke:${size}:${wisp}`, () => {
    const px = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = (x + 0.5) / size - 0.5, v = (y + 0.5) / size - 0.5;
        const r = Math.hypot(u, v) * 2;
        const n = fbm(x / size, y / size, { freq: 6, octaves: 5, seed: 307 });
        let a = smoothstep(1.0, 0.15, r);
        a *= lerp(1, 0.35 + n * 0.9, wisp);
        const i = (y * size + x) * 4;
        const l = b(0.75 + n * 0.25);
        px[i] = l; px[i + 1] = l; px[i + 2] = l;
        px[i + 3] = b(clamp(a, 0, 1));
      }
    }
    const t = dataTexture(px, size, THREE.SRGBColorSpace);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  });
}

/** Hot-white streak used for sparks and small debris. */
export function sparkSprite(o = {}) {
  const { size = 64 } = o;
  return cached(`spark:${size}`, () => {
    const px = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = (x + 0.5) / size - 0.5, v = (y + 0.5) / size - 0.5;
        const d = Math.hypot(u * 1.0, v * 3.2) * 2;
        const a = Math.pow(clamp(1 - d, 0, 1), 1.6);
        const i = (y * size + x) * 4;
        px[i] = 255; px[i + 1] = b(0.72 + a * 0.28); px[i + 2] = b(0.30 + a * 0.5);
        px[i + 3] = b(a);
      }
    }
    const t = dataTexture(px, size, THREE.SRGBColorSpace);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  });
}

/** Lens-flare / bloom ghost element: soft disc with a chromatic ring. */
export function flareSprite(o = {}) {
  const { size = 128, ring = 0.55 } = o;
  return cached(`flare:${size}:${ring}`, () => {
    const px = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = (x + 0.5) / size - 0.5, v = (y + 0.5) / size - 0.5;
        const r = Math.hypot(u, v) * 2;
        const core = Math.pow(clamp(1 - r, 0, 1), 3);
        const rim = Math.exp(-Math.pow((r - ring) * 9, 2));
        const i = (y * size + x) * 4;
        px[i] = b(core + rim * 0.9);
        px[i + 1] = b(core * 0.9 + rim * 0.55);
        px[i + 2] = b(core * 0.8 + rim * 0.25);
        px[i + 3] = b(clamp(core + rim * 0.8, 0, 1));
      }
    }
    const t = dataTexture(px, size, THREE.SRGBColorSpace);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  });
}

/** Tree/foliage billboard card (RGBA, alpha-tested). */
export function foliageSprite(o = {}) {
  const { size = 256, hue = 0.28 } = o;
  return cached(`foliage:${size}:${hue}`, () => {
    const px = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = (x + 0.5) / size, v = (y + 0.5) / size;
        const r = Math.hypot((u - 0.5) * 2.05, (v - 0.44) * 1.85);
        const n = fbm(u, v, { freq: 14, octaves: 4, seed: 401 });
        const n2 = fbm(u, v, { freq: 60, octaves: 3, seed: 409 });
        const a = smoothstep(1.05, 0.55, r + (n - 0.5) * 0.75) > 0.5 && n2 > 0.36 ? 1 : 0;
        const shade = 0.30 + n * 0.5 + n2 * 0.2 - v * 0.15;
        const i = (y * size + x) * 4;
        px[i] = b(shade * (0.30 + hue * 0.5));
        px[i + 1] = b(shade * 0.72);
        px[i + 2] = b(shade * 0.26);
        px[i + 3] = a * 255;
      }
    }
    const t = dataTexture(px, size, THREE.SRGBColorSpace);
    t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    return t;
  });
}

export const COMPOUND_COLOURS = {
  soft: '#e10600',
  medium: '#f5d000',
  hard: '#efefef',
  inter: '#2fbf3f',
  wet: '#1d6fe0',
};

/**
 * FULL TYRE PROFILE MAP — designed for a lathed tyre (car/wheels.js).
 *   u = around the circumference (repeats)
 *   v = across the profile: 0 = inner bead, 0.5 = tread crown, 1 = outer bead
 * Sidewall lettering, the compound colour band and (for wet compounds) tread
 * grooves are all baked in the correct places.
 * @param {{compound?:keyof COMPOUND_COLOURS, size?:number, repeats?:number, wear?:number}} o
 * @returns {THREE.CanvasTexture} sRGB
 */
export function tyreProfileMap(o = {}) {
  const { compound = 'soft', size = 1024, repeats = 5 } = o;
  return cached(`tyremap:${compound}:${size}:${repeats}`, () => {
    const H = size, W = size;
    const { c, x } = canvas2d(W, H);
    const Y = (v) => (1 - v) * H;   // texture v -> canvas y (three flips Y)

    x.fillStyle = '#0d0d0f';
    x.fillRect(0, 0, W, H);

    // Slightly lighter, scrubbed tread band across the crown.
    const treadGrad = x.createLinearGradient(0, Y(0.78), 0, Y(0.22));
    treadGrad.addColorStop(0, '#0a0a0b');
    treadGrad.addColorStop(0.5, '#1a1a1c');
    treadGrad.addColorStop(1, '#0a0a0b');
    x.fillStyle = treadGrad;
    x.fillRect(0, Y(0.78), W, Y(0.22) - Y(0.78));

    // Compound colour band on both sidewalls.
    const band = COMPOUND_COLOURS[compound] ?? '#e10600';
    x.fillStyle = band;
    x.fillRect(0, Y(0.145), W, H * 0.030);
    x.fillRect(0, Y(0.885), W, H * 0.030);

    // Wet/inter compounds carry visible grooves.
    if (compound === 'inter' || compound === 'wet') {
      x.strokeStyle = '#050506';
      x.lineWidth = H * (compound === 'wet' ? 0.020 : 0.013);
      for (let i = 0; i < 4; i++) {
        const v = 0.30 + i * 0.135;
        x.beginPath();
        for (let px = 0; px <= W; px += 8) {
          const wobble = Math.sin((px / W) * Math.PI * 2 * repeats * 2) * H * 0.012;
          const y = Y(v) + wobble;
          px === 0 ? x.moveTo(px, y) : x.lineTo(px, y);
        }
        x.stroke();
      }
    }

    // LETTERING — THE SAME TWO-FLIP TRAP AS THE BODY'S RIGHT FLANK.
    //
    // Two independent flips stack on a sidewall and fixing only one is what
    // makes moulded text read backwards:
    //   * v flip. The glyph's top must point AWAY from the crown, so the patch
    //     on the far bead is drawn upside down (`vScale`).
    //   * u flip. u wraps the circumference. An observer standing off the inner
    //     bead sees that circumference running the opposite way across their
    //     screen from an observer off the outer bead, so ONE of the two patches
    //     must be mirrored in u (`uScale`).
    // Get both right here and a single un-mirrored lathe reads correctly on both
    // flanks of the car — do NOT also mirror the geometry's u, or the flip
    // happens twice on one side and once on the other.
    for (let i = 0; i < repeats; i++) {
      const cx = (i + 0.5) * (W / repeats);
      // The glyph top must point AWAY from the hub — i.e. toward the bead, not
      // toward the tread. Captured at `wheel`, the previous pair of vScales put
      // it the other way up: 'APEX' at the bottom of the near tyre read upright
      // with its tops pointing at the wheel centre, which is upside down for
      // every instance around the circumference at once.
      for (const [v, vScale, uScale] of [[0.09, -1, -1], [0.91, 1, 1]]) {
        const flip = vScale;
        x.save();
        x.translate(cx, Y(v));
        x.scale(uScale, flip);
        x.textAlign = 'center'; x.textBaseline = 'middle';
        x.fillStyle = '#e6e6e6';
        x.letterSpacing = `${Math.round(W * 0.004)}px`;
        x.font = `900 ${Math.round(H * 0.052)}px Helvetica, Arial, sans-serif`;
        x.fillText('APEX', 0, 0);
        x.font = `700 ${Math.round(H * 0.028)}px Helvetica, Arial, sans-serif`;
        x.fillStyle = '#b8b8b8';
        x.fillText(compound.toUpperCase(), 0, H * 0.045);
        x.restore();
      }
    }

    const tex = canvasTexture(c, { repeat: true });
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  });
}

/** @deprecated use tyreProfileMap — kept so older call sites keep working. */
export const tyreSidewall = tyreProfileMap;

/**
 * A 1-D gradient strip (Nx1) useful for HUD bars, heat ramps, ERS gauges.
 * `stops` is [[t, '#rrggbb'], ...].
 */
export function gradientStrip(stops, o = {}) {
  const { width = 256, key } = o;
  return cached(key ?? `grad:${JSON.stringify(stops)}:${width}`, () => {
    const { c, x } = canvas2d(width, 4);
    const g = x.createLinearGradient(0, 0, width, 0);
    for (const [t, col] of stops) g.addColorStop(clamp(t, 0, 1), col);
    x.fillStyle = g;
    x.fillRect(0, 0, width, 4);
    const t = canvasTexture(c, { mips: false });
    return t;
  });
}

/** Blue-noise-ish RGBA tile for dithering, TAA jitter, grain. NoColorSpace. */
export function noiseTile(o = {}) {
  const { size = 128 } = o;
  return cached(`noise:${size}`, () => {
    const rng = makeRng(hashSeed('noiseTile'));
    const px = new Uint8Array(size * size * 4);
    for (let i = 0; i < px.length; i++) px[i] = Math.floor(rng() * 256);
    const t = dataTexture(px, size, THREE.NoColorSpace);
    t.minFilter = t.magFilter = THREE.NearestFilter;
    t.generateMipmaps = false;
    return t;
  });
}

/** Every surface generator, addressable by name (used by the asset registry). */
export const SURFACES = {
  asphalt, carbonFibre, rubber, brushedMetal, concrete, grass, gravel,
  paintedLine, kerbStripe, fabric,
};
