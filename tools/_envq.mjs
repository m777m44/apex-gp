#!/usr/bin/env node
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME = process.env.HOME;
const EXE = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const url = arg('url', 'http://localhost:5503');
const shot = arg('shot', 'grid');
const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });
const out = await page.evaluate(async (shotName) => {
  const api = window.__APEX__; api.pause();
  if (api.capture) await api.capture(shotName, 0);
  for (let i = 0; i < 20; i++) api.renderFrame(i);
  const eng = window.APEX_ENGINE || api.engine;
  const c = eng.circuit; const env = eng.environment;
  const cam = eng.camera;
  const r = {
    length: c.length, step: c.step, halfWidth: c.halfWidth,
    grid0: c.gridSlot(0).s,
    camPos: cam.position.toArray().map(v => +v.toFixed(1)),
    nearest: (() => { const n = c.nearest(cam.position); return { s: +n.s.toFixed(1), lateral: +n.lateral.toFixed(1) }; })(),
    stands: (env._stands || []).map(st => ({ s: +st.s.toFixed(0), side: st.side })),
    corrTypes: (() => {
      const counts = {};
      const t = env.corr.type;
      for (let i = 0; i < t.length; i++) counts[t[i]] = (counts[t[i]] || 0) + 1;
      return counts;
    })(),
    tyreWallSpans: (() => {
      const spans = [];
      const n = c.samples.length;
      for (const side of [-1, 1]) {
        let start = -1;
        for (let i = 0; i < n; i++) {
          const ix = i * 2 + (side > 0 ? 1 : 0);
          const isT = env.corr.type[ix] === 2;
          if (isT && start < 0) start = i;
          if (!isT && start >= 0) { spans.push([side, Math.round(start * c.step), Math.round(i * c.step)]); start = -1; }
        }
        if (start >= 0) spans.push([side, Math.round(start * c.step), Math.round(n * c.step)]);
      }
      return spans;
    })(),
    names: (() => { const o = []; eng.scene.traverse(x => { if (x.name) o.push(x.name); }); return [...new Set(o)]; })(),
  };
  return r;
}, shot);
console.log(JSON.stringify(out, null, 1));
await browser.close();
