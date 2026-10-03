#!/usr/bin/env node
/** Report, per shot, the elevation-angle band of sky actually in frame. */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME = process.env.HOME;
const EXE = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const url = arg('url', 'http://localhost:5505');
const shots = (arg('shots', 'wide,tv,chase')).split(',');

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });

const out = await page.evaluate(async (shots) => {
  const api = window.__APEX__;
  api.pause();
  const eng = window.APEX_ENGINE ?? api.engine;
  const res = [];
  for (const s of shots) {
    if (api.capture) await api.capture(s, 0);
    for (let i = 0; i < 90; i++) api.renderFrame(i);
    const cam = eng.camera;
    cam.updateMatrixWorld();
    const THREE = eng.THREE ?? null;
    // sample NDC grid, get world ray elevation
    const rows = [];
    for (const ny of [1, 0.75, 0.5, 0.25, 0, -0.25, -0.5]) {
      const v = { x: 0, y: ny, z: 0.5 };
      // unproject manually via camera
      const p = new (cam.position.constructor)(0, ny, 0.5);
      p.unproject(cam);
      p.sub(cam.position).normalize();
      rows.push({ ndcY: ny, elevDeg: +(Math.asin(p.y) * 180 / Math.PI).toFixed(2) });
    }
    const sun = eng.sky.sunDirection;
    res.push({
      shot: s,
      camY: +cam.position.y.toFixed(1),
      fov: +cam.fov.toFixed(1),
      rows,
      sunElev: +(Math.asin(sun.y) * 180 / Math.PI).toFixed(1),
      coverage: eng.sky.uniforms.uCloudCoverage.value,
      density: eng.sky.uniforms.uCloudDensity.value,
      cirrus: eng.sky.uniforms.uCirrusAmount.value,
      base: eng.sky.uniforms.uCloudBase.value,
      thickness: eng.sky.uniforms.uCloudThickness.value,
      zenith: eng.sky.uniforms.uSkyZenith.value.toArray().map(v=>+v.toFixed(3)),
      horizon: eng.sky.uniforms.uSkyHorizon.value.toArray().map(v=>+v.toFixed(3)),
    });
  }
  return res;
}, shots);

console.log(JSON.stringify(out, null, 1));
await browser.close();
