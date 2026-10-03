#!/usr/bin/env node
/**
 * Red-bodywork clip census.
 *   node tools/_c6clip.mjs shots/x.png [x0,y0,w,h]
 * "Red bodywork pixel" = r > 90 && r - max(g,b) > 45  (saturated red, any brightness)
 */
import { execFileSync } from 'node:child_process';
const [file, rect] = process.argv.slice(2);
const meta = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim();
const [W, H] = meta.split(',').map(Number);
const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
  { maxBuffer: 1 << 30 });
const [x0, y0, w, h] = rect ? rect.split(',').map(Number) : [0, 0, W, H];
let n = 0, r250 = 0, g6 = 0, sr = 0, sg = 0, sb = 0;
const rs = [];
for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
  const i = (y * W + x) * 3;
  const R = buf[i], G = buf[i + 1], B = buf[i + 2];
  if (!(R > 90 && R - Math.max(G, B) > 45)) continue;
  n++; sr += R; sg += G; sb += B;
  if (R >= 250) r250++;
  if (G <= 6) g6++;
  rs.push(R);
}
rs.sort((a, b) => a - b);
// Break the clipped population down: a red pixel with a lot of green in it is the
// accent pinstripe / a sponsor edge, not the base coat.
let clipYellow = 0, clipBase = 0;
for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
  const i = (y * W + x) * 3;
  const R = buf[i], G = buf[i + 1], B = buf[i + 2];
  if (!(R > 90 && R - Math.max(G, B) > 45) || R < 250) continue;
  if (G > 0.42 * R) clipYellow++; else clipBase++;
}
const q = (p) => rs.length ? rs[Math.floor((rs.length - 1) * p)] : 0;
console.log(`${file} ${x0},${y0},${w},${h}`);
console.log(`  red pixels        ${n}  (${(100 * n / (w * h)).toFixed(2)}% of patch)`);
console.log(`  R >= 250          ${(100 * r250 / Math.max(1, n)).toFixed(2)}%`);
console.log(`  G <= 6            ${(100 * g6 / Math.max(1, n)).toFixed(2)}%`);
console.log(`  mean rgb          ${(sr / n).toFixed(1)}/${(sg / n).toFixed(1)}/${(sb / n).toFixed(1)}`);
console.log(`  R percentiles     p05 ${q(0.05)}  p50 ${q(0.5)}  p95 ${q(0.95)}  p99 ${q(0.99)}
  of the clipped:   base coat ${(100 * clipBase / Math.max(1, n)).toFixed(2)}%  accent/edge ${(100 * clipYellow / Math.max(1, n)).toFixed(2)}%`);
