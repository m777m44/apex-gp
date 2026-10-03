#!/usr/bin/env node
/**
 * ENGINE diagnostic — the LIVE game, not a capture. Boots the page, lets the
 * rAF loop free-run for a few seconds with no harness intervention, and reports
 * fps, draw calls and any console/page error. This is the check that a change
 * made for the capture path (see DETERMINISTIC CAPTURE in engine.js) did not
 * quietly break the thing people actually play.
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
const url = arg('url', 'http://localhost:5610');
const seconds = parseFloat(arg('seconds', '6'));

const executablePath = EXECUTABLES.find((p) => existsSync(p));
const browser = await chromium.launch({
  executablePath, headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await page.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (protocols === 'vite-hmr' || String(url).includes('vite')) {
      return { addEventListener() {}, removeEventListener() {}, send() {}, close() {}, readyState: 3 };
    }
    return new RealWS(url, protocols);
  };
});
const errs = [];
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__APEX__ && window.__APEX__.ready === true, null, { timeout: 120000 });

const out = await page.evaluate(async (secs) => {
  const api = window.__APEX__;
  const eng = api.engine;
  const t0 = eng.simTime;
  await new Promise((r) => setTimeout(r, secs * 1000));
  const v = eng.player.vehicle;
  const st = api.stats();
  return {
    ranSimSeconds: +(eng.simTime - t0).toFixed(2),
    fps: +st.fps.toFixed(1), drawCalls: st.drawCalls, tris: +(st.triangles / 1e6).toFixed(2),
    simMs: +st.simMs.toFixed(2), renderMs: +st.renderMs.toFixed(2),
    speedKph: +v.speedKph.toFixed(1), gear: v.gear, lap: eng.session.snapshot(0).lap,
    mode: eng.rig.mode, fogDensity: +eng.scene.fog.density.toFixed(6),
  };
}, seconds);

console.log(JSON.stringify(out, null, 1));
if (errs.length) { console.log('--- ERRORS ---'); console.log(errs.slice(0, 12).join('\n')); }
await browser.close();
