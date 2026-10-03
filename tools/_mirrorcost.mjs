// A/B the cockpit mirror pass: batch frame time with it on and off.
// node tools/_mirrorcost.mjs --url http://localhost:5507
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
const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 180000 });
const r = await page.evaluate(async () => {
  const api = window.__APEX__; api.pause();
  await api.capture('cockpit', 0);
  for (let i = 0; i < 120; i++) api.renderFrame(i);
  const gl = api.engine.renderer.getContext();
  const run = (on, n) => {
    api.engine.rig.interior.mirror = on;
    for (let i = 0; i < 20; i++) api.renderFrame(i);
    gl.finish();
    const t0 = performance.now();
    for (let i = 0; i < n; i++) api.renderFrame(i);
    gl.finish();
    return (performance.now() - t0) / n;
  };
  run(true, 30);
  // Interleaved, min-of-blocks: the machine has other tenants, so the MINIMUM
  // block is the only honest estimate of the cost.
  const onS = [], offS = [];
  for (let k = 0; k < 8; k++) { onS.push(run(true, 40)); offS.push(run(false, 40)); }
  const f = (a) => a.map((v) => +v.toFixed(2));
  return { on: f(onS), off: f(offS), onMin: +Math.min(...onS).toFixed(2), offMin: +Math.min(...offS).toFixed(2) };
});
console.log(JSON.stringify(r));
await browser.close(); process.exit(0);
