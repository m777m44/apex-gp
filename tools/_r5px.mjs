#!/usr/bin/env node
/** Patch statistics straight off a PNG: node tools/_r5px.mjs file.png x,y,w,h ... */
import { execFileSync } from 'node:child_process';
const [file, ...rects] = process.argv.slice(2);
const meta = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim();
const [W] = meta.split(',').map(Number);
const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
  { maxBuffer: 1 << 30 });
for (const rect of rects) {
  const [x0, y0, w, h] = rect.split(',').map(Number);
  let r = 0, g = 0, b = 0, n = 0, sat = 0;
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    const i = (y * W + x) * 3;
    r += buf[i]; g += buf[i + 1]; b += buf[i + 2];
    const mx = Math.max(buf[i], buf[i + 1], buf[i + 2]), mn = Math.min(buf[i], buf[i + 1], buf[i + 2]);
    sat += mx ? (mx - mn) / mx : 0;
    n++;
  }
  r /= n; g /= n; b /= n;
  const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  console.log(`${file} ${rect}  rgb ${r.toFixed(1)}/${g.toFixed(1)}/${b.toFixed(1)}  B-R ${(b - r).toFixed(1)}  sat ${(sat / n).toFixed(3)}  Y ${Y.toFixed(1)}`);
}
