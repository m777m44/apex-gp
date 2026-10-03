#!/usr/bin/env node
/**
 * Sky patch meter. Reports mean RGB / luma / saturation for a set of named
 * rectangles inside a capture, so a sky change can be argued with numbers.
 *
 *   node tools/_sky5px.mjs shots/a.png shots/b.png
 */
import { execFileSync } from 'node:child_process';

function load(path) {
  const meta = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path]).toString().trim();
  const [w, h] = meta.split(',').map(Number);
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'rawvideo',
    '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 30 });
  return { w, h, buf };
}

function patch(img, x, y, w, h) {
  let r = 0, g = 0, b = 0, sat = 0, n = 0;
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const i = (yy * img.w + xx) * 3;
      const R = img.buf[i], G = img.buf[i + 1], B = img.buf[i + 2];
      r += R; g += G; b += B;
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
      sat += mx === 0 ? 0 : (mx - mn) / mx;
      n++;
    }
  }
  r /= n; g /= n; b /= n; sat /= n;
  return { r, g, b, L: 0.2126 * r + 0.7152 * g + 0.0722 * b, sat };
}

// name, x, y, w, h  — tuned for 1600x900 captures
const PRESETS = {
  grid: [
    ['blueHigh  ', 210, 110, 220, 50],
    ['blueMid   ', 430, 175, 200, 40],
    ['blueLow   ', 430, 225, 180, 25],
    ['cloudBig  ', 700, 40, 200, 50],
    ['cloudFar  ', 250, 210, 120, 22],
  ],
  chase: [
    ['blueHigh  ', 300, 30, 200, 40],
    ['blueMid   ', 620, 60, 200, 40],
    ['blueLow   ', 620, 130, 200, 30],
    ['cloudBig  ', 1000, 20, 200, 50],
    ['cloudFar  ', 1330, 95, 120, 26],
  ],
  tv: [
    ['skyBand   ', 200, 60, 300, 40],
    ['skyBand2  ', 900, 60, 300, 40],
  ],
  wide: [
    ['skyBand   ', 200, 20, 300, 40],
    ['skyBand2  ', 900, 20, 300, 40],
  ],
};

const argv = process.argv.slice(2);
const si = argv.indexOf('--shot');
const RECTS = si === -1 ? PRESETS.grid : PRESETS[argv[si + 1]];
const files = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const imgs = files.map(load);
console.log('patch        ' + files.map((f) => f.split('/').pop().padEnd(30)).join(''));
for (const [name, x, y, w, h] of RECTS) {
  const cells = imgs.map((im) => {
    const p = patch(im, x, y, w, h);
    return `${p.r.toFixed(0)}/${p.g.toFixed(0)}/${p.b.toFixed(0)} L${p.L.toFixed(1)} s${(p.sat * 100).toFixed(1)}`.padEnd(30);
  });
  console.log(name + ' ' + cells.join(''));
}
