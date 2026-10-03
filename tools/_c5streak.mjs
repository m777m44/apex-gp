#!/usr/bin/env node
/**
 * Measure the DOMINANT STREAK ORIENTATION of a rendered frame, per grid cell,
 * and compare it to the direction a pure-translation blur would take (radial
 * from the focus of expansion).
 *
 *   node tools/_c5streak.mjs shots/x.png --foe 0.617,0.721 --grid 6
 *
 * Method: structure tensor on the luma gradient.  A motion streak has almost no
 * gradient ALONG itself and a strong one ACROSS it, so the tensor's minor
 * eigenvector is the streak direction.  `coh` (0..1) is how anisotropic the cell
 * is — a cell with coh < ~0.3 has no dominant direction and its angle is noise.
 */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const file = process.argv[2];
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const GRID = parseInt(arg('grid', '6'), 10);
const foeArg = (arg('foe', '0.5,0.5')).split(',').map(Number);

// decode via ffmpeg to raw grey
const W = parseInt(arg('w', '1600'), 10), H = parseInt(arg('h', '900'), 10);
const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `scale=${W}:${H}`, '-pix_fmt', 'gray', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28 });
const g = new Float32Array(W * H);
for (let i = 0; i < W * H; i++) g[i] = raw[i] / 255;

const foeX = foeArg[0] * W, foeY = (1 - foeArg[1]) * H;   // uv v is bottom-up
const cw = Math.floor(W / GRID), ch = Math.floor(H / GRID);
console.log(`${file}  FOE px=(${foeX.toFixed(0)},${foeY.toFixed(0)})`);
console.log('per cell: streakDeg | radialDeg | err | coh   (deg measured CCW from +x, wrapped to 0..180)');
for (let gy = 0; gy < GRID; gy++) {
  const row = [];
  for (let gx = 0; gx < GRID; gx++) {
    let jxx = 0, jyy = 0, jxy = 0;
    const x0 = gx * cw + 2, x1 = (gx + 1) * cw - 2, y0 = gy * ch + 2, y1 = (gy + 1) * ch - 2;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = y * W + x;
        const gxv = (g[i + 1] - g[i - 1]) * 0.5;
        const gyv = (g[i + W] - g[i - W]) * 0.5;
        jxx += gxv * gxv; jyy += gyv * gyv; jxy += gxv * gyv;
      }
    }
    const n = (x1 - x0) * (y1 - y0);
    jxx /= n; jyy /= n; jxy /= n;
    const tr = jxx + jyy, d = Math.sqrt((jxx - jyy) * (jxx - jyy) + 4 * jxy * jxy);
    const l1 = (tr + d) / 2, l2 = (tr - d) / 2;
    const coh = tr > 1e-12 ? (l1 - l2) / (l1 + l2) : 0;
    // major eigenvector = gradient direction; streak is perpendicular to it
    let ang = 0.5 * Math.atan2(2 * jxy, jxx - jyy);       // gradient orientation
    let streak = ang + Math.PI / 2;
    // radial direction from FOE (image coords, y down)
    const px = x0 + cw / 2, py = y0 + ch / 2;
    let rad = Math.atan2(py - foeY, px - foeX);
    const norm = (a) => { a = a % Math.PI; if (a < 0) a += Math.PI; return a; };
    const sD = norm(streak) * 180 / Math.PI, rD = norm(rad) * 180 / Math.PI;
    let err = Math.abs(sD - rD); if (err > 90) err = 180 - err;
    row.push(`${sD.toFixed(0).padStart(3)}|${rD.toFixed(0).padStart(3)}|${err.toFixed(0).padStart(3)}|${coh.toFixed(2)}`);
  }
  console.log('  ' + row.join('  '));
}
void readFileSync;
