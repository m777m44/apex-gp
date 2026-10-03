// Region stats on a PNG: mean/p99/max luma + %clipped, in 0..255 sRGB.
import { chromium } from 'playwright-core';
import { readFileSync, existsSync } from 'node:fs';
const HOME = process.env.HOME;
const EXE = [`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const a = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const files = a('in').split(',');
const x = +a('x', 0), y = +a('y', 0), w = +a('w', 0), h = +a('h', 0);
const br = await chromium.launch({ executablePath: EXE, headless: true });
const p = await br.newPage();
for (const f of files) {
  const b64 = readFileSync(f).toString('base64');
  const r = await p.evaluate(async ([b64, x, y, w, h]) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const W = w || img.width, H = h || img.height;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d'); g.drawImage(img, x, y, W, H, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data;
    const lum = []; let clip = 0;
    for (let i = 0; i < d.length; i += 4) {
      const L = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      lum.push(L);
      if (d[i] > 250 && d[i + 1] > 250 && d[i + 2] > 250) clip++;
    }
    lum.sort((a, b) => a - b);
    const mean = lum.reduce((s, v) => s + v, 0) / lum.length;
    // gradient energy over the region (sharpness proxy)
    let ge = 0, n = 0;
    const px = g.getImageData(0, 0, W, H).data;
    for (let yy = 1; yy < H - 1; yy++) for (let xx = 1; xx < W - 1; xx++) {
      const i = (yy * W + xx) * 4;
      const l = (v) => 0.2126 * px[v] + 0.7152 * px[v + 1] + 0.0722 * px[v + 2];
      ge += Math.abs(l(i) - l(i + 4)) + Math.abs(l(i) - l(i + W * 4)); n++;
    }
    return { mean: +mean.toFixed(2), p50: lum[(lum.length * 0.5) | 0], p99: lum[(lum.length * 0.99) | 0], max: lum[lum.length - 1] | 0, clipPct: +(100 * clip / lum.length).toFixed(3), grad: +(ge / n).toFixed(2) };
  }, [b64, x, y, w, h]);
  console.log(f.padEnd(44), JSON.stringify(r));
}
await br.close();
