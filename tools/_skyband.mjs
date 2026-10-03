#!/usr/bin/env node
/** Mean RGB + saturation of horizontal bands of a PNG (sky profiling). */
import { execFileSync } from 'node:child_process';
const files = process.argv.slice(2);
for (const path of files) {
  const meta = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path]).toString().trim();
  const [w, h] = meta.split(',').map(Number);
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'rawvideo',
    '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 30 });
  console.log(`\n${path}  ${w}x${h}`);
  const BANDS = 10;
  const bh = Math.floor(h / 2 / BANDS); // top half only
  for (let b = 0; b < BANDS; b++) {
    let r = 0, g = 0, bl = 0, s = 0, n = 0;
    for (let y = b * bh; y < (b + 1) * bh; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        r += buf[i]; g += buf[i + 1]; bl += buf[i + 2];
        const mx = Math.max(buf[i], buf[i + 1], buf[i + 2]);
        const mn = Math.min(buf[i], buf[i + 1], buf[i + 2]);
        s += mx === 0 ? 0 : (mx - mn) / mx;
        n++;
      }
    }
    const L = (0.2126 * r + 0.7152 * g + 0.0722 * bl) / n;
    console.log(`  y${String(b * bh).padStart(4)}-${String((b + 1) * bh).padStart(4)}  rgb ${(r / n).toFixed(0).padStart(3)},${(g / n).toFixed(0).padStart(3)},${(bl / n).toFixed(0).padStart(3)}  L ${L.toFixed(1).padStart(5)}  sat ${((s / n) * 100).toFixed(1)}%`);
  }
}
