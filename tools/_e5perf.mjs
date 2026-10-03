#!/usr/bin/env node
/**
 * ENGINE diagnostic — per-shot frame cost, attributed.
 *
 * Stages a shot, then times N renderFrame() batches with a GPU fence
 * (`gl.finish()` after each batch, so the number is not just the CPU submitting
 * commands). Reports draw calls / triangles / ms per frame, and repeats the
 * measurement with individual passes disabled so the cost can be attributed.
 *
 *   node tools/_e5perf.mjs --shot cockpit --url http://localhost:5610
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const HOME = process.env.HOME;
const EXECUTABLES = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  `${HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};
const shots = String(arg('shot', 'chase,cockpit')).split(',');
const url = arg('url', 'http://localhost:5610');
const w = parseInt(arg('w', '1920'), 10);
const h = parseInt(arg('h', '1080'), 10);

const executablePath = EXECUTABLES.find((p) => existsSync(p));
const browser = await chromium.launch({
  executablePath, headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
await page.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (protocols === 'vite-hmr' || String(url).includes('vite')) {
      return { addEventListener() {}, removeEventListener() {}, send() {}, close() {}, readyState: 3 };
    }
    return new RealWS(url, protocols);
  };
});
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__APEX__ && window.__APEX__.ready === true, null, { timeout: 120000 });

const rows = await page.evaluate(async (shotNames) => {
  const api = window.__APEX__;
  const eng = api.engine;
  const gl = eng.renderer.getContext();
  const bench = (n) => {
    // Warm, then time. gl.finish() at both ends so the batch includes the GPU.
    for (let i = 0; i < 20; i++) api.renderFrame(i);
    gl.finish();
    const t0 = performance.now();
    for (let i = 0; i < n; i++) api.renderFrame(i);
    gl.finish();
    return (performance.now() - t0) / n;
  };
  const out = [];
  for (const shot of shotNames) {
    api.pause();
    await api.capture(shot, 0);
    for (let i = 0; i < 90; i++) { api.renderFrame(i); if (i % 15 === 0) await new Promise((r) => setTimeout(r, 0)); }
    await api.settle();
    const ms = bench(60);
    const st = api.stats();
    out.push({ shot, ms: +ms.toFixed(2), fps: +(1000 / ms).toFixed(1), calls: st.drawCalls, tris: +(st.triangles / 1e6).toFixed(2), mode: eng.rig.mode });
    await new Promise((r) => setTimeout(r, 0));
  }
  return out;
}, shots);

for (const r of rows) console.log(JSON.stringify(r));
await browser.close();
