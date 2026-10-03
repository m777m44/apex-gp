#!/usr/bin/env node
/**
 * Aerial-perspective sweep. Captures a shot once per `aerialStrength` value and
 * reports mean sRGB + saturation + local contrast (mean |dx| + |dy|) for a set
 * of patches, so "the 3 km treeline sits at full saturation while the 8 km
 * skyline is hazed" is a number rather than an opinion.
 *
 *   node tools/_l5aer.mjs --shot wide --patch "300,180,80,40;900,80,80,30" \
 *     --sweep 0.9,1.2,1.5 --url http://localhost:5606 [--png shots/l5-aer]
 */
import { chromium } from 'playwright-core';
import { existsSync, writeFileSync } from 'node:fs';

const HOME = process.env.HOME;
const EXE = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const shot = arg('shot', 'wide');
const url = arg('url', 'http://localhost:5606');
const png = arg('png', '');
const patches = (arg('patch', '') || '').split(';').filter(Boolean).map((p) => p.split(',').map(Number));
const sweep = (arg('sweep', '0.9') || '').split(',').map(Number);
const field = arg('field', 'aerialStrength');

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });

const rows = [];
for (const v of sweep) {
  const r = await page.evaluate(async ({ shotName, patches, v, field }) => {
    const api = window.__APEX__;
    const eng = window.APEX_ENGINE;
    api.pause();
    await api.capture(shotName, 0);
    const L = eng.lighting;
    if (field === 'fogDensity') eng.scene.fog.density = v;
    else if (field === 'param0') { L._updateAerial(); L.__pin = v; }
    else L[field] = v;
    L._envDirty = true;
    L.syncToSky();
    for (let i = 0; i < 30; i++) api.renderFrame(i);
    await api.settle();
    for (let i = 0; i < 12; i++) api.renderFrame(i);
    const c = eng.renderer.domElement;
    const g = c.getContext('webgl2');
    const W = c.width, H = c.height;
    const px = new Uint8Array(W * H * 4);
    g.readPixels(0, 0, W, H, g.RGBA, g.UNSIGNED_BYTE, px);
    const at = (x, y) => { const o = ((H - 1 - y) * W + x) * 4; return [px[o], px[o + 1], px[o + 2]]; };
    return patches.map(([x, y, w, h]) => {
      let R = 0, G = 0, B = 0, edge = 0, n = 0;
      for (let j = y; j < y + h; j++) {
        for (let i = x; i < x + w; i++) {
          const p = at(i, j); R += p[0]; G += p[1]; B += p[2]; n++;
          const px1 = at(i + 1, j), py1 = at(i, j + 1);
          const l = (q) => 0.2126 * q[0] + 0.7152 * q[1] + 0.0722 * q[2];
          edge += Math.abs(l(px1) - l(p)) + Math.abs(l(py1) - l(p));
        }
      }
      R /= n; G /= n; B /= n;
      const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
      return {
        rgb: [R, G, B].map((q) => +q.toFixed(1)),
        sat: +((mx - mn) / Math.max(mx, 1)).toFixed(3),
        bMinusR: +(B - R).toFixed(1),
        edge: +(edge / n).toFixed(2),
      };
    });
  }, { shotName: shot, patches, v, field });
  rows.push({ [field]: v, patches: r });
  if (png) {
    const buf = await page.screenshot({ type: 'png' });
    writeFileSync(`${png}-${String(v).replace('.', 'p')}.png`, buf);
  }
}
console.log(JSON.stringify(rows, null, 1));
await browser.close();
