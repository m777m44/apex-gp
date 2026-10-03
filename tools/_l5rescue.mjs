#!/usr/bin/env node
/**
 * Proof rig for the key-eclipse rescue. Stages a shot, then walks the sun down
 * in elevation on the authored bearing and reports, per step, how much of the
 * probe bundle the circuit's architecture blocks and what bearing the guard
 * picks instead. That maps the shot's real eclipse geometry AND proves the
 * machinery fires, without needing the world to be broken at the time.
 *
 *   node tools/_l5rescue.mjs --shot grid --url http://localhost:5606
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME = process.env.HOME;
const EXE = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const shot = arg('shot', 'grid');
const url = arg('url', 'http://localhost:5606');
const elevs = (arg('elev', '38,30,24,20,16,12') || '').split(',').map(Number);

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });

const out = await page.evaluate(async ({ shotName, elevs }) => {
  const api = window.__APEX__, eng = window.APEX_ENGINE;
  api.pause();
  await api.capture(shotName, 0);
  for (let i = 0; i < 4; i++) api.renderFrame(i);
  const L = eng.lighting;
  const az0 = eng.sky.azimuth;
  const rows = [];
  for (const el of elevs) {
    L._rescueCache.clear();
    L.keyRescueLog = null;
    L.keyRescue = false;
    eng.sky.setSun(el, az0);
    L.syncToSky();
    api.renderFrame(0);                 // keyDirection now follows the sky
    L.keyRescue = true;
    const t0 = performance.now();
    api.renderFrame(1);                 // the guard runs here
    const ms = performance.now() - t0;
    const log = L.keyRescueLog;
    rows.push({
      elevation: el,
      authoredBlocked: log ? log.authoredBlocked : null,
      chosen: log ? log.chosen : null,
      liveAz: +eng.sky.azimuth.toFixed(1), liveEl: +eng.sky.elevation.toFixed(1),
      probeMs: +ms.toFixed(1),
    });
  }
  return { shot: shotName, authoredAzimuth: +az0.toFixed(2), rows };
}, { shotName: shot, elevs });

console.log(JSON.stringify(out, null, 1));
await browser.close();
