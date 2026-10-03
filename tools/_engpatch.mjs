#!/usr/bin/env node
/**
 * Mean sRGB + linear luma over rectangular patches of a capture.
 *
 *   node tools/_engpatch.mjs shots/grid.png 200,700,300,80 620,560,180,30
 *
 * Patches are `x,y,w,h`. Prints sRGB mean, linear luma and saturation so a
 * "lit tarmac vs shadowed tarmac" ratio can be quoted the way the critics do.
 */
import { execFileSync } from 'node:child_process';

const [file, ...rects] = process.argv.slice(2);
const meta = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
  '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file]).toString().trim();
const [W, H] = meta.split(',').map(Number);
const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo',
  '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 30 });

const toLin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

for (const r of rects) {
  const [x, y, w, h] = r.split(',').map(Number);
  let R = 0, G = 0, B = 0, L = 0, n = 0;
  for (let j = y; j < Math.min(y + h, H); j++) {
    for (let i = x; i < Math.min(x + w, W); i++) {
      const o = (j * W + i) * 3;
      const r8 = buf[o] / 255, g8 = buf[o + 1] / 255, b8 = buf[o + 2] / 255;
      R += r8; G += g8; B += b8;
      L += 0.2126 * toLin(r8) + 0.7152 * toLin(g8) + 0.0722 * toLin(b8);
      n++;
    }
  }
  R /= n; G /= n; B /= n; L /= n;
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
  const sat = mx > 1e-5 ? (mx - mn) / mx : 0;
  console.log(`${r.padEnd(20)} sRGB ${(R * 255).toFixed(1)}/${(G * 255).toFixed(1)}/${(B * 255).toFixed(1)}`
    + `   linear ${L.toFixed(4)}   sat ${sat.toFixed(3)}`);
}
