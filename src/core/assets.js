/**
 * APEX GP — procedural asset registry.
 *
 * There are no files to load: every geometry, material and texture is baked in
 * JS. This registry exists so those bakes happen exactly once and can be
 * disposed as a unit. ALWAYS go through it for anything shared between modules
 * (a rim geometry used by 20 cars, the asphalt maps used by track + pit lane).
 *
 *   const geo = assets.geometry('wheel/rim', () => buildRim());
 *   const mat = assets.material('car/carbon', () => new THREE.MeshPhysicalMaterial(...));
 *
 * Keys are namespaced with '/'. Use your module's name as the first segment.
 */

import * as THREE from 'three';
import { setTextureAnisotropy, disposeAll as disposeTextures } from '../textures/procedural.js';

export class AssetRegistry {
  constructor() {
    this.items = new Map();
    this.timings = new Map();
    this.renderer = null;
  }

  /** Wire the renderer so texture anisotropy matches hardware limits. */
  attachRenderer(renderer) {
    this.renderer = renderer;
    setTextureAnisotropy(Math.min(8, renderer.capabilities.getMaxAnisotropy()));
  }

  /** Memoised factory. `factory` runs at most once per key. */
  get(key, factory) {
    let v = this.items.get(key);
    if (v === undefined) {
      const t0 = (typeof performance !== 'undefined' ? performance.now() : 0);
      v = factory();
      this.timings.set(key, (typeof performance !== 'undefined' ? performance.now() : 0) - t0);
      this.items.set(key, v);
    }
    return v;
  }

  geometry(key, factory) { return this.get(`geo:${key}`, factory); }
  material(key, factory) { return this.get(`mat:${key}`, factory); }
  texture(key, factory) { return this.get(`tex:${key}`, factory); }

  has(key) { return this.items.has(key); }

  /** Bakes that took longer than `ms`, slowest first — for load-time budgeting. */
  slowest(n = 10) {
    return [...this.timings.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
      .map(([k, ms]) => ({ key: k, ms: +ms.toFixed(1) }));
  }

  stats() {
    let geo = 0, mat = 0, tex = 0, other = 0;
    for (const k of this.items.keys()) {
      if (k.startsWith('geo:')) geo++;
      else if (k.startsWith('mat:')) mat++;
      else if (k.startsWith('tex:')) tex++;
      else other++;
    }
    return { total: this.items.size, geo, mat, tex, other };
  }

  dispose() {
    for (const v of this.items.values()) {
      if (!v) continue;
      if (v.isBufferGeometry || v.isMaterial || v.isTexture) v.dispose?.();
      else if (Array.isArray(v)) v.forEach((x) => x?.dispose?.());
    }
    this.items.clear();
    this.timings.clear();
    disposeTextures();
  }
}

/** The one registry the game uses. */
export const assets = new AssetRegistry();

// ---------------------------------------------------------------------------
// Small geometry helpers shared by car/track/environment builders.
// ---------------------------------------------------------------------------

/**
 * Lofts a surface through an ordered list of cross-sections.
 * Every section must contain the SAME number of points, ordered consistently.
 *
 * @param {THREE.Vector3[][]} sections  world-space rings, front to back
 * @param {{closed?:boolean, caps?:boolean, uvScale?:THREE.Vector2}} o
 * @returns {THREE.BufferGeometry}
 */
export function loft(sections, o = {}) {
  const { closed = false, caps = false } = o;
  const rows = sections.length;
  const cols = sections[0].length;
  const ringClosed = closed;
  const colCount = ringClosed ? cols + 1 : cols;

  const pos = new Float32Array(rows * colCount * 3);
  const uv = new Float32Array(rows * colCount * 2);
  let p = 0, t = 0;
  for (let r = 0; r < rows; r++) {
    const sec = sections[r];
    for (let c = 0; c < colCount; c++) {
      const v = sec[c % cols];
      pos[p++] = v.x; pos[p++] = v.y; pos[p++] = v.z;
      uv[t++] = c / (colCount - 1);
      uv[t++] = r / (rows - 1);
    }
  }

  const idx = [];
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < colCount - 1; c++) {
      const a = r * colCount + c;
      const b = a + 1;
      const d = a + colCount;
      const e = d + 1;
      // Winding: (ring tangent) x (row direction) must point OUT of the surface.
      idx.push(a, b, d, b, e, d);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(idx);

  if (caps) {
    // Fan-cap the first and last rings around their centroid.
    const extra = [];
    const positions = [...pos];
    const uvs = [...uv];
    const addCap = (ringStart, reverse) => {
      const cx = new THREE.Vector3();
      for (let c = 0; c < cols; c++) {
        cx.x += pos[(ringStart + c) * 3];
        cx.y += pos[(ringStart + c) * 3 + 1];
        cx.z += pos[(ringStart + c) * 3 + 2];
      }
      cx.divideScalar(cols);
      const ci = positions.length / 3;
      positions.push(cx.x, cx.y, cx.z);
      uvs.push(0.5, 0.5);
      for (let c = 0; c < cols; c++) {
        const a = ringStart + c;
        const b = ringStart + ((c + 1) % cols);
        if (reverse) extra.push(ci, a, b); else extra.push(ci, b, a);
      }
    };
    addCap(0, true);
    addCap((rows - 1) * colCount, false);
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex([...idx, ...extra]);
  }

  g.computeVertexNormals();
  return g;
}

/**
 * Builds a closed ring of points for a superellipse ("squircle") cross-section.
 * The workhorse for F1 bodywork: n=2 is an ellipse, n=4 is a rounded box,
 * n=8 is nearly rectangular.
 */
export function superellipse(count, halfWidth, halfHeight, n = 3, {
  centre = new THREE.Vector3(), yScaleTop = 1, yScaleBottom = 1, flatBottom = 0,
} = {}) {
  const pts = [];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    const ca = Math.cos(a), sa = Math.sin(a);
    const x = Math.sign(ca) * Math.pow(Math.abs(ca), 2 / n) * halfWidth;
    let y = Math.sign(sa) * Math.pow(Math.abs(sa), 2 / n) * halfHeight;
    y *= y >= 0 ? yScaleTop : yScaleBottom;
    if (y < 0) y = Math.max(y, -halfHeight * yScaleBottom * (1 - flatBottom));
    pts.push(new THREE.Vector3(centre.x + x, centre.y + y, centre.z));
  }
  return pts;
}

/** Merge a list of BufferGeometries that share an attribute layout. */
export function mergeGeometries(list) {
  const merged = [];
  let indexOffset = 0;
  const positions = [], normals = [], uvs = [], indices = [];
  for (const g of list) {
    // Both branches below already handle an indexed AND a non-indexed source,
    // so nothing needs converting. The old `g.index ? g : g.toNonIndexed()`
    // had the test inverted: it de-indexed the geometries that were ALREADY
    // non-indexed, which cloned every attribute for nothing and made three
    // log "BufferGeometry is already non-indexed" once per merged part.
    const gg = g;
    const pos = gg.getAttribute('position');
    const nor = gg.getAttribute('normal');
    const uv = gg.getAttribute('uv');
    for (let i = 0; i < pos.count; i++) {
      positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
      if (nor) normals.push(nor.getX(i), nor.getY(i), nor.getZ(i));
      if (uv) uvs.push(uv.getX(i), uv.getY(i));
      else uvs.push(0, 0);
    }
    const idx = gg.index;
    if (idx) for (let i = 0; i < idx.count; i++) indices.push(idx.getX(i) + indexOffset);
    else for (let i = 0; i < pos.count; i++) indices.push(i + indexOffset);
    indexOffset += pos.count;
    merged.push(gg);
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (normals.length) out.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  out.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  out.setIndex(indices);
  if (!normals.length) out.computeVertexNormals();
  return out;
}

/** Recursively enable shadow casting/receiving on a subtree. */
export function setShadows(root, cast = true, receive = true) {
  root.traverse((o) => {
    if (o.isMesh || o.isInstancedMesh) { o.castShadow = cast; o.receiveShadow = receive; }
  });
  return root;
}
