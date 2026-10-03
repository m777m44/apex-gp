#!/usr/bin/env node
/**
 * Measures the DIRECTION of motion-blur streaks per grid cell (structure tensor)
 * and compares it with the pure-translation radial direction from a focus of
 * expansion.  Output per cell: streak angle (deg, 0 = horizontal, +ve = down-right
 * in image coords), the ideal radial angle, the signed error, and coherence.
 *
 *   node tools/_streak.mjs shots/x.png --foe 0.72,0.37 --grid 6
 */
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(`--${n}`); return i === -1 ? d : args[i + 1]; };
const files = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const GRID = parseInt(opt('grid', '6'), 10);
const foe = opt('foe', '0.5,0.5').split(',').map(Number);

function load(path) {
  const meta = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path]).toString().trim();
  const [w, h] = meta.split(',').map(Number);
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'rawvideo',
    '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 30 });
  return { w, h, buf };
}

function cell(img, cx, cy, cw, ch) {
  const { w, buf } = img;
  let jxx = 0, jxy = 0, jyy = 0;
  for (let y = cy + 1; y < cy + ch - 1; y++) {
    for (let x = cx + 1; x < cx + cw - 1; x++) {
      const i = y * w + x;
      const gx = (buf[i + 1] - buf[i - 1]) * 0.5;
      const gy = (buf[i + w] - buf[i - w]) * 0.5;
      jxx += gx * gx; jxy += gx * gy; jyy += gy * gy;
    }
  }
  const n = (cw - 2) * (ch - 2);
  jxx /= n; jxy /= n; jyy /= n;
  const tr = jxx + jyy;
  const d = Math.sqrt((jxx - jyy) * (jxx - jyy) + 4 * jxy * jxy);
  const l1 = (tr + d) / 2, l2 = (tr - d) / 2;
  // dominant GRADIENT direction; streak runs perpendicular to it
  const ga = 0.5 * Math.atan2(2 * jxy, jxx - jyy);
  let sa = ga + Math.PI / 2;
  // fold into (-90, 90]
  while (sa > Math.PI / 2) sa -= Math.PI;
  while (sa <= -Math.PI / 2) sa += Math.PI;
  return { ang: sa * 180 / Math.PI, coh: tr > 1e-6 ? (l1 - l2) / (l1 + l2) : 0, energy: tr };
}

for (const f of files) {
  const img = load(f);
  const cw = Math.floor(img.w / GRID), ch = Math.floor(img.h / GRID);
  console.log(`${f}  ${img.w}x${img.h}  FOE=(${foe[0]},${foe[1]})`);
  console.log('cell        streak   ideal    err   coh');
  for (let gy = 0; gy < GRID; gy++) {
    const row = [];
    for (let gx = 0; gx < GRID; gx++) {
      const c = cell(img, gx * cw, gy * ch, cw, ch);
      const px = (gx + 0.5) * cw, py = (gy + 0.5) * ch;
      const dx = px - foe[0] * img.w, dy = py - foe[1] * img.h;
      let ideal = Math.atan2(dy, dx) * 180 / Math.PI;
      while (ideal > 90) ideal -= 180;
      while (ideal <= -90) ideal += 180;
      let err = c.ang - ideal;
      while (err > 90) err -= 180;
      while (err <= -90) err += 180;
      row.push(`${String(gx) + ',' + gy}: ${c.ang.toFixed(0).padStart(4)}/${ideal.toFixed(0).padStart(4)} e${err.toFixed(0).padStart(4)} c${c.coh.toFixed(2)}`);
    }
    console.log('  ' + row.join(' | '));
  }
}
