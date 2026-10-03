// Dump the cockpit mirror render target as a coarse luminance grid.
// node tools/_mirror.mjs --url http://localhost:5507 [--warm 150]
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME = process.env.HOME;
const EXE = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  `${HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const url = arg('url', 'http://localhost:5507');
const warm = parseInt(arg('warm', '150'), 10);
const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 180000 });
const r = await page.evaluate(async ({ warm }) => {
  const api = window.__APEX__; api.pause();
  await api.capture('cockpit', 0);
  for (let i = 0; i < warm; i++) api.renderFrame(i);
  const e = api.engine;
  const it = e.rig.interior;
  if (!it) return { err: 'no interior' };
  const rt = it.mirrorRT;
  if (!rt) return { err: 'no mirrorRT (renderer missing?)' };
  const W = rt.width, H = rt.height;
  const raw = new Uint16Array(W * H * 4);
  e.renderer.readRenderTargetPixels(rt, 0, 0, W, H, raw);
  const half = (h) => {
    const s = (h & 0x8000) ? -1 : 1, ex = (h >> 10) & 0x1f, m = h & 0x3ff;
    if (ex === 0) return s * m * 5.9604644775390625e-8;
    if (ex === 31) return s * (m ? NaN : Infinity);
    return s * Math.pow(2, ex - 15) * (1 + m / 1024);
  };
  const buf = new Float32Array(W * H * 4);
  for (let i = 0; i < buf.length; i++) buf[i] = half(raw[i]);
  // 12 x 7 grid of mean luminance. Row 0 = TOP of the image.
  const gx = 12, gy = 7;
  const rows = [];
  for (let j = 0; j < gy; j++) {
    const row = [];
    for (let i = 0; i < gx; i++) {
      let s = 0, n = 0;
      for (let y = Math.floor(j * H / gy); y < (j + 1) * H / gy; y++) {
        for (let x = Math.floor(i * W / gx); x < (i + 1) * W / gx; x++) {
          const o = ((H - 1 - y) * W + x) * 4;   // flip: readRenderTargetPixels is bottom-up
          s += buf[o] * 0.2126 + buf[o + 1] * 0.7152 + buf[o + 2] * 0.0722; n++;
        }
      }
      row.push(+(s / n).toFixed(3));
    }
    rows.push(row);
  }
  return {
    size: [W, H],
    camPos: it.mirrorCam.position.toArray().map((n) => +n.toFixed(2)),
    fov: it.mirrorCam.fov, gain: it.mats.mirror.emissiveIntensity,
    rows,
  };
}, { warm });
if (r.err) { console.log(r.err); } else {
  console.log('rt', r.size.join('x'), 'cam', r.camPos.join(','), 'fov', r.fov, 'gain', r.gain);
  for (const row of r.rows) console.log(row.map((v) => String(v).padStart(6)).join(''));
}
await browser.close(); process.exit(0);
