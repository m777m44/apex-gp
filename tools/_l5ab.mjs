#!/usr/bin/env node
/**
 * Same-page A/B of lighting calibrations. Fifteen people are editing this tree
 * at once, so two measurements taken five minutes apart are NOT comparable —
 * every variant here is captured, staged and measured inside one page load.
 *
 *   node tools/_l5ab.mjs --shot chase --sets "sunBoost=4.2,env=1.55,bounce=2.1;sunBoost=4.5,env=1.45,bounce=3.0"
 */
import { chromium } from 'playwright-core';
import { existsSync, writeFileSync } from 'node:fs';
const HOME = process.env.HOME;
const EXE = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const shots = arg('shot', 'chase').split(',');
const url = arg('url', 'http://localhost:5606');
const png = arg('png', '');
const sets = arg('sets', '').split(';').filter(Boolean)
  .map((s) => s.split(',').filter(Boolean).map((kv) => kv.split('=')));

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });

// Fifteen agents are editing this tree; vite reloads the page under us.
const run = async (fn, a) => {
  for (let attempt = 0; ; attempt++) {
    try {
      await page.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 180000 });
      return await page.evaluate(fn, a);
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
};

for (const shot of shots) {
  for (let si = 0; si < sets.length; si++) {
    const r = await run(async ({ shotName, set }) => {
      const api = window.__APEX__, eng = window.APEX_ENGINE;
      api.pause();
      await api.capture(shotName, 0);
      const L = eng.lighting;
      for (const [k, v] of set) {
        const n = parseFloat(v);
        if (k === 'sunBoost') L.sunBoost = n;
        else if (k === 'env') { L.baseEnvironmentIntensity = n; L.setEnvironmentIntensity(n); }
        else if (k === 'bounce') L.bounceGain = n;
        else if (k === 'fill') L.fillTrim = n;
      }
      L._envDirty = true;
      L.syncToSky();
      for (let i = 0; i < 40; i++) api.renderFrame(i);
      await api.settle();
      for (let i = 40; i < 52; i++) api.renderFrame(i);
      const c = eng.renderer.domElement;
      const g = c.getContext('webgl2');
      const W = c.width, H = c.height;
      const px = new Uint8Array(W * H * 4);
      g.readPixels(0, 0, W, H, g.RGBA, g.UNSIGNED_BYTE, px);
      let below6 = 0, above192 = 0, sum = 0;
      const n = W * H;
      for (let i = 0; i < n; i++) {
        const o = i * 4;
        const Y = 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2];
        if (Y < 6) below6++;
        if (Y > 192) above192++;
        sum += Y;
      }
      return {
        sunBoost: L.sunBoost, env: +L.environmentIntensity.toFixed(3), bounce: L.bounceGain,
        keyAmbientRatio: +L.keyAmbientRatio.toFixed(2),
        exposure: +eng.renderer.toneMappingExposure.toFixed(4),
        meanY: +(sum / n).toFixed(2),
        pctBelow6: +(100 * below6 / n).toFixed(3),
        pctAbove192: +(100 * above192 / n).toFixed(3),
      };
    }, { shotName: shot, set: sets[si] });
    console.log(JSON.stringify({ shot, variant: si, ...r }));
    if (png) writeFileSync(`${png}-${shot}-${si}.png`, await page.screenshot({ type: 'png' }));
  }
}
await browser.close();
