// Statistics over a masked region of a PNG: mean of pixels passing a predicate.
import { chromium } from 'playwright-core';
import { readFileSync, existsSync } from 'node:fs';
const HOME = process.env.HOME;
const EXE = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  `${HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
].find((p) => existsSync(p));
const a = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const src = a('in');
const box = JSON.parse(a('box', '[0,0,100,100]'));
const minR = +a('minR', 100);
const b64 = readFileSync(src).toString('base64');
const br = await chromium.launch({ executablePath: EXE, headless: true });
const p = await br.newPage();
const out = await p.evaluate(async ([b64, box, minR]) => {
  const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
  const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
  const d = g.getImageData(box[0], box[1], box[2], box[3]).data;
  const n = box[2] * box[3];
  let r = 0, gg = 0, bb = 0, k = 0, clip = 0, maxR = 0, dark = 0;
  const rs = [];
  for (let i = 0; i < n; i++) {
    const R = d[i * 4], G = d[i * 4 + 1], B = d[i * 4 + 2];
    if (R < 60 && G < 60) dark++;
    if (R < minR) continue;
    r += R; gg += G; bb += B; k++; rs.push(R);
    if (R > 252) clip++;
    maxR = Math.max(maxR, R);
  }
  rs.sort((x, y) => x - y);
  return `n=${k}/${n} mean=rgb(${(r / k).toFixed(0)},${(gg / k).toFixed(0)},${(bb / k).toFixed(0)}) ` +
    `sat=${(1 - (gg / k) / (r / k)).toFixed(3)} p50R=${rs[k >> 1]} p95R=${rs[Math.floor(k * 0.95)]} maxR=${maxR} clipR=${(100 * clip / k).toFixed(2)}% darkfrac=${(100 * dark / n).toFixed(1)}%`;
}, [b64, box, minR]);
console.log(out);
await br.close();
