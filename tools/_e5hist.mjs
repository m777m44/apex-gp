#!/usr/bin/env node
/**
 * ENGINE diagnostic — the three numbers the reviewers keep quoting at us:
 * fraction of pixels below L=6 (crushed blacks), above L=192 (highlight range)
 * and the mean luminance. Decodes through ffmpeg, like tools/compare.mjs.
 *
 *   node tools/_e5hist.mjs shots/a.png shots/b.png ...
 */
import { execFileSync } from 'node:child_process';

for (const path of process.argv.slice(2)) {
  const meta = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path]).toString().trim();
  const [w, h] = meta.split(',').map(Number);
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 1 << 30 });
  let lo = 0, hi = 0, sum = 0;
  const n = w * h;
  for (let i = 0; i < n; i++) {
    const j = i * 3;
    const L = 0.2126 * buf[j] + 0.7152 * buf[j + 1] + 0.0722 * buf[j + 2];
    sum += L;
    if (L < 6) lo++;
    if (L > 192) hi++;
  }
  console.log(`${path}  meanL ${(sum / n).toFixed(1)}  belowL6 ${(100 * lo / n).toFixed(2)}%  aboveL192 ${(100 * hi / n).toFixed(2)}%`);
}
