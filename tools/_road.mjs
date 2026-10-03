// Road-surface analysis: local gradient energy + 2D autocorrelation of a crop,
// so "is there texture" and "is it periodic" are measured, not eyeballed.
import { decode } from './_istat.mjs';

const a = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const file = a('in');
const X = +a('x', 0), Y = +a('y', 0), W = +a('w', 256), H = +a('h', 256);
const { w, stride, ch, img } = decode(file);

const L = new Float32Array(W * H);
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  const i = (Y + y) * stride + (X + x) * ch;
  L[y * W + x] = 0.2126 * img[i] + 0.7152 * img[i + 1] + 0.0722 * img[i + 2];
}

let mean = 0; for (let i = 0; i < L.length; i++) mean += L[i]; mean /= L.length;
let vari = 0; for (let i = 0; i < L.length; i++) vari += (L[i] - mean) ** 2; vari /= L.length;

// mean |gradient| (the "is there any structure" number the reviewers quote)
let g = 0, gn = 0;
for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
  const dx = L[y * W + x + 1] - L[y * W + x - 1];
  const dy = L[(y + 1) * W + x] - L[(y - 1) * W + x];
  g += Math.hypot(dx, dy) * 0.5; gn++;
}

// autocorrelation over +-24 px, high-pass first so macro shading doesn't win
const HP = new Float32Array(W * H);
const R = 6;
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
  let s = 0, n = 0;
  for (let j = -R; j <= R; j += 2) for (let i = -R; i <= R; i += 2) {
    const yy = Math.min(H - 1, Math.max(0, y + j)), xx = Math.min(W - 1, Math.max(0, x + i));
    s += L[yy * W + xx]; n++;
  }
  HP[y * W + x] = L[y * W + x] - s / n;
}
const K = 24;
const peaks = [];
let a00 = 0; for (let i = 0; i < HP.length; i++) a00 += HP[i] * HP[i];
for (let dy = 0; dy <= K; dy++) for (let dx = -K; dx <= K; dx++) {
  if (dx === 0 && dy === 0) continue;
  let s = 0, n = 0;
  for (let y = 0; y < H - dy; y++) for (let x = Math.max(0, -dx); x < Math.min(W, W - dx); x++) {
    s += HP[y * W + x] * HP[(y + dy) * W + x + dx]; n++;
  }
  peaks.push({ dx, dy, r: (s / n) / (a00 / HP.length) });
}
peaks.sort((p, q) => q.r - p.r);
console.log(`${file.split('/').pop()} [${X},${Y} ${W}x${H}]  mean=${mean.toFixed(1)} sd=${Math.sqrt(vari).toFixed(2)} grad=${(g / gn).toFixed(3)}`);
console.log('  top autocorr peaks (offset -> r):', peaks.slice(0, 6).map(p => `(${p.dx},${p.dy})=${p.r.toFixed(3)}`).join(' '));
