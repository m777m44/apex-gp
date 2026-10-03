#!/usr/bin/env node
/**
 * ENGINE diagnostic — is `capture()` actually reproducible?
 *
 * Captures the same shot TWICE inside ONE page load and diffs the two frames
 * pixel-for-pixel, then reports a few live state values that a wall-clock
 * dependency would smear. If the two frames inside one load agree but two
 * separate `tools/shot.mjs` runs disagree, the nondeterminism is in BOOT (the
 * free-running rAF frames between `ready` and the harness's `pause()`), not in
 * the fixed-step loop.
 *
 *   node tools/_e5det.mjs --shot chase --url http://localhost:5610
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
const shot = arg('shot', 'chase');
const url = arg('url', 'http://localhost:5610');
const warm = parseInt(arg('warm', '150'), 10);

const executablePath = EXECUTABLES.find((p) => existsSync(p));
const browser = await chromium.launch({ executablePath, headless: true, args: ['--use-angle=metal', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
// Another specialist editing a file mid-run makes vite HMR reload the page and
// the evaluate() below dies with "execution context destroyed". Stop the HMR
// socket from ever connecting; nothing in a capture needs it.
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

const out = await page.evaluate(async ([shotName, frames]) => {
  const api = window.__APEX__;
  const eng = api.engine;
  const gl = eng.renderer.getContext();
  const w = eng.renderer.domElement.width, h = eng.renderer.domElement.height;
  const grab = () => {
    const px = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return px;
  };
  const run = async () => {
    api.pause();
    await api.capture(shotName, 0);
    for (let i = 0; i < frames; i++) { api.renderFrame(i); if (i % 10 === 0) await new Promise((r) => setTimeout(r, 0)); }
    await api.settle();
    api.renderFrame(frames);
    const v = eng.player.vehicle;
    return {
      px: grab(),
      state: {
        s: +v.trackS.toFixed(4), lat: +v.trackLateral.toFixed(4), speed: +v.speed.toFixed(4),
        camX: +eng.camera.position.x.toFixed(4), camY: +eng.camera.position.y.toFixed(4),
        camZ: +eng.camera.position.z.toFixed(4), fov: +eng.camera.fov.toFixed(4),
        exposure: +eng.renderer.toneMappingExposure.toFixed(5),
        simTime: +eng.simTime.toFixed(4),
      },
    };
  };
  const a = await run();
  const b = await run();
  let diff = 0, maxd = 0, sum = 0;
  for (let i = 0; i < a.px.length; i += 4) {
    const d = Math.abs(a.px[i] - b.px[i]) + Math.abs(a.px[i + 1] - b.px[i + 1]) + Math.abs(a.px[i + 2] - b.px[i + 2]);
    if (d) { diff++; sum += d; if (d > maxd) maxd = d; }
  }
  return { pixels: w * h, differing: diff, pctDiffering: +(100 * diff / (w * h)).toFixed(3), meanDelta: +(sum / (w * h)).toFixed(3), maxDelta: maxd, a: a.state, b: b.state };
}, [shot, warm]);

console.log(JSON.stringify(out, null, 1));
await browser.close();
