// Find the periodic multi-hundred-ms hitch: time step/visuals/render and count programs.
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME = process.env.HOME;
const EXE = [`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const a = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const shot = a('shot', 'chase'), url = a('url', 'http://localhost:5420');
const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--hide-scrollbars', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });
const out = await page.evaluate(async ([shotName]) => {
  const api = window.__APEX__, e = api.engine;
  api.pause(); await api.capture(shotName, 0);
  for (let i = 0; i < 120; i++) { api.renderFrame(i); if (i % 10 === 0) await new Promise((r) => setTimeout(r, 0)); }
  await api.settle();
  const gl = e.renderer.getContext();
  const rows = [];
  const marks = {};
  const wrap = (obj, name, key) => { const o = obj[name].bind(obj); obj[name] = function (...args) { const t = performance.now(); const v = o(...args); marks[key] = (marks[key] || 0) + performance.now() - t; return v; }; return () => { obj[name] = o; }; };
  const un = [
    wrap(e, 'step', 'step'), wrap(e, 'updateVisuals', 'visuals'),
    wrap(e.lighting, 'refreshEnvironment', 'env'), wrap(e.lighting, 'update', 'light'),
    wrap(e.postfx, 'render', 'post'), wrap(e.weather, 'update', 'weather'),
    wrap(e.particles, 'update', 'particles'), wrap(e.environment, 'update', 'envUpd'),
    wrap(e.sky, 'update', 'sky'), wrap(e.hud, 'render', 'hud'),
  ];
  for (let i = 0; i < 150; i++) {
    for (const k in marks) marks[k] = 0;
    const p0 = e.renderer.info.programs.length;
    const t0 = performance.now();
    api.renderFrame(2000 + i); gl.finish();
    const ms = performance.now() - t0;
    rows.push({ i, ms: +ms.toFixed(1), progs: e.renderer.info.programs.length - p0, ...Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, +v.toFixed(1)])) });
    if (i % 25 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  for (const f of un) f();
  const sorted = rows.slice().sort((x, y) => y.ms - x.ms);
  return { worst: sorted.slice(0, 6), typical: rows.filter(r => r.ms < 15).slice(0, 3), totalPrograms: e.renderer.info.programs.length };
}, [shot]);
console.log(shot, JSON.stringify(out, null, 1));
await browser.close(); process.exit(0);
