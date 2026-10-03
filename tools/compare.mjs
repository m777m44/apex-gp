#!/usr/bin/env node
/**
 * Regression detector: compares two captures of the SAME shot and reports where
 * the frame measurably changed.
 *
 *   node tools/compare.mjs shots/r4-world-wide.png shots/r5-world-wide.png
 *   node tools/compare.mjs old.png new.png --grid 8 --threshold 8
 *
 * Per grid cell it reports three numbers that map onto how the critics judge:
 *   luma   — mean brightness      (exposure / lighting / shadow changes)
 *   sat    — mean saturation      (hue drift, e.g. carbon going cobalt blue)
 *   edge   — mean gradient energy (detail gained or LOST: tiling, blur, texture)
 *
 * A fix that improves one region while quietly flattening another shows up here
 * as a negative edge delta. Run it before claiming a fix is done.
 *
 * Decoding goes through ffmpeg (no image deps in this project).
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1]; };
// Positional args only: skip both the flag and the value it consumes.
const files = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const GRID = parseInt(opt('grid', '6'), 10);
const THRESH = parseFloat(opt('threshold', '6'));

if (files.length !== 2) {
  console.error('usage: node tools/compare.mjs <before.png> <after.png> [--grid N] [--threshold T]');
  process.exit(2);
}
for (const f of files) if (!existsSync(f)) { console.error(`missing: ${f}`); process.exit(2); }

function load(path) {
  const meta = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path]).toString().trim();
  const [w, h] = meta.split(',').map(Number);
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'rawvideo',
    '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 30 });
  return { w, h, buf };
}

function cellStats(img, cx, cy, cw, ch) {
  const { w, buf } = img;
  let lum = 0, sat = 0, edge = 0, n = 0;
  for (let y = cy; y < cy + ch; y++) {
    for (let x = cx; x < cx + cw; x++) {
      const i = (y * w + x) * 3;
      const r = buf[i], g = buf[i + 1], b = buf[i + 2];
      const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      lum += L;
      sat += mx === 0 ? 0 : (mx - mn) / mx;
      if (x + 1 < cx + cw && y + 1 < cy + ch) {
        const ix = i + 3, iy = i + w * 3;
        const Lx = 0.2126 * buf[ix] + 0.7152 * buf[ix + 1] + 0.0722 * buf[ix + 2];
        const Ly = 0.2126 * buf[iy] + 0.7152 * buf[iy + 1] + 0.0722 * buf[iy + 2];
        edge += Math.abs(L - Lx) + Math.abs(L - Ly);
      }
      n++;
    }
  }
  return { lum: lum / n, sat: (sat / n) * 100, edge: edge / n };
}

const A = load(files[0]);
const B = load(files[1]);
if (A.w !== B.w || A.h !== B.h) {
  console.error(`size mismatch: ${A.w}x${A.h} vs ${B.w}x${B.h} — capture both at the same resolution`);
  process.exit(2);
}

const cw = Math.floor(A.w / GRID), ch = Math.floor(A.h / GRID);
const rows = [];
let gl = 0, gs = 0, ge = 0;
for (let gy = 0; gy < GRID; gy++) {
  for (let gx = 0; gx < GRID; gx++) {
    const a = cellStats(A, gx * cw, gy * ch, cw, ch);
    const b = cellStats(B, gx * cw, gy * ch, cw, ch);
    const d = { cell: `r${gy}c${gx}`, lum: b.lum - a.lum, sat: b.sat - a.sat, edge: b.edge - a.edge,
                edgePct: a.edge > 0.01 ? ((b.edge - a.edge) / a.edge) * 100 : 0 };
    rows.push(d);
    gl += d.lum; gs += d.sat; ge += d.edge;
  }
}
const N = rows.length;

console.log(`BEFORE ${files[0]}\nAFTER  ${files[1]}\n${A.w}x${A.h}, ${GRID}x${GRID} grid\n`);
console.log(`GLOBAL   luma ${(gl / N >= 0 ? '+' : '')}${(gl / N).toFixed(2)}   sat ${(gs / N >= 0 ? '+' : '')}${(gs / N).toFixed(2)}pp   edge ${(ge / N >= 0 ? '+' : '')}${(ge / N).toFixed(3)}`);

const lost = rows.filter((r) => r.edgePct < -15).sort((a, b) => a.edgePct - b.edgePct);
if (lost.length) {
  console.log(`\n!! DETAIL LOST in ${lost.length}/${N} cells (edge energy down >15%) — this is what a "regression" looks like:`);
  for (const r of lost.slice(0, 12)) console.log(`   ${r.cell}  edge ${r.edgePct.toFixed(1)}%  luma ${r.lum >= 0 ? '+' : ''}${r.lum.toFixed(1)}  sat ${r.sat >= 0 ? '+' : ''}${r.sat.toFixed(1)}pp`);
}
const hue = rows.filter((r) => Math.abs(r.sat) > 6).sort((a, b) => Math.abs(b.sat) - Math.abs(a.sat));
if (hue.length) {
  console.log(`\n!! SATURATION SHIFT in ${hue.length}/${N} cells (>6pp):`);
  for (const r of hue.slice(0, 12)) console.log(`   ${r.cell}  sat ${r.sat >= 0 ? '+' : ''}${r.sat.toFixed(1)}pp  luma ${r.lum >= 0 ? '+' : ''}${r.lum.toFixed(1)}`);
}
const big = rows.filter((r) => Math.abs(r.lum) > THRESH).sort((a, b) => Math.abs(b.lum) - Math.abs(a.lum));
if (big.length) {
  console.log(`\n   LUMA SHIFT in ${big.length}/${N} cells (>${THRESH}):`);
  for (const r of big.slice(0, 12)) console.log(`   ${r.cell}  luma ${r.lum >= 0 ? '+' : ''}${r.lum.toFixed(1)}  edge ${r.edgePct.toFixed(1)}%`);
}
if (!lost.length && !hue.length && !big.length) console.log('\nNo significant regression detected.');
