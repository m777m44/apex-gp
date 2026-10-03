#!/usr/bin/env node
/** Vertical RGB profile of a narrow column: node tools/_c6col.mjs f.png x,y0,y1,width */
import { execFileSync } from 'node:child_process';
const [file, spec] = process.argv.slice(2);
const meta = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim();
const [W] = meta.split(',').map(Number);
const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
  { maxBuffer: 1 << 30 });
const [x0, y0, y1, cw] = spec.split(',').map(Number);
for (let y = y0; y < y1; y++) {
  let r = 0, g = 0, b = 0;
  for (let x = x0; x < x0 + cw; x++) { const i = (y * W + x) * 3; r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; }
  r /= cw; g /= cw; b /= cw;
  console.log(`y=${y}  ${r.toFixed(0).padStart(3)} ${g.toFixed(0).padStart(3)} ${b.toFixed(0).padStart(3)}  L=${(0.2126 * r + 0.7152 * g + 0.0722 * b).toFixed(0).padStart(3)}`);
}
