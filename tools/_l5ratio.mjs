#!/usr/bin/env node
/**
 * Scene-referred key:ambient ratio per shot, plus the eclipse-rescue decision
 * and the cost of the probe.
 *
 *   node tools/_l5ratio.mjs --shots grid,tv,wide,beauty,chase --url http://localhost:5606
 *   node tools/_l5ratio.mjs --shots grid --set sunBoost=4.8,env=1.30
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME = process.env.HOME;
const EXE = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const shots = arg('shots', 'grid,tv,wide,beauty,chase').split(',');
const url = arg('url', 'http://localhost:5606');
const set = (arg('set', '') || '').split(',').filter(Boolean).map((kv) => kv.split('='));

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });

const out = await page.evaluate(async ({ shotNames, set }) => {
  const api = window.__APEX__, eng = window.APEX_ENGINE;
  api.pause();
  const rows = [];
  for (const name of shotNames) {
    const L = eng.lighting;
    L._rescueCache.clear();
    L.keyRescueLog = null;
    await api.capture(name, 0);
    for (const [k, v] of set) {
      const n = parseFloat(v);
      if (k === 'sunBoost') L.sunBoost = n;
      else if (k === 'env') { L.baseEnvironmentIntensity = n; L.setEnvironmentIntensity(n); }
      else if (k === 'bounce') L.bounceGain = n;
      else if (k === 'fill') L.fill.intensity = n;
    }
    L.syncToSky();
    const t0 = performance.now();
    api.renderFrame(0);
    const ms1 = performance.now() - t0;
    for (let i = 1; i < 6; i++) api.renderFrame(i);
    const t1 = performance.now();
    for (let i = 6; i < 16; i++) api.renderFrame(i);
    const msSteady = (performance.now() - t1) / 10;
    rows.push({
      shot: name,
      keyAmbientRatio: +L.keyAmbientRatio.toFixed(2),
      sunBoost: L.sunBoost, env: +L.environmentIntensity.toFixed(3),
      fill: +L.fill.intensity.toFixed(4), bounce: L.bounceGain,
      exposure: +eng.renderer.toneMappingExposure.toFixed(3), ev100: +L.ev100.toFixed(3),
      sunElevation: +eng.sky.elevation.toFixed(1), sunAzimuth: +eng.sky.azimuth.toFixed(1),
      rescue: L.keyRescueLog ? {
        blocked: L.keyRescueLog.authoredBlocked,
        authored: L.keyRescueLog.authored,
        chosen: L.keyRescueLog.chosen,
      } : null,
      firstFrameMs: +ms1.toFixed(1), steadyFrameMs: +msSteady.toFixed(2),
    });
  }
  return rows;
}, { shotNames: shots, set });

for (const r of out) console.log(JSON.stringify(r));
await browser.close();
