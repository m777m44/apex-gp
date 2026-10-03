#!/usr/bin/env node
/** Per-frame timing trace: finds WHICH frames spike and what ran on them. */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME = process.env.HOME;
const EXE = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  `${HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => existsSync(p));
const a = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const shot = a('shot', 'chase'), url = a('url', 'http://localhost:5310');
const W = +a('w', 1920), H = +a('h', 1080), N = +a('frames', 300);
const browser = await chromium.launch({ executablePath: EXE, headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--hide-scrollbars', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });
const r = await page.evaluate(async ([shotName, n]) => {
  const api = window.__APEX__, e = api.engine;
  api.pause(); await api.capture(shotName, 0);
  for (let i = 0; i < 120; i++) { api.renderFrame(i); if (i % 10 === 0) await new Promise((r) => setTimeout(r, 0)); }
  await api.settle();
  const gl = e.renderer.getContext();
  const rows = [];
  let envRefreshes = 0;
  const orig = e.lighting.refreshEnvironment.bind(e.lighting);
  e.lighting.refreshEnvironment = function () { envRefreshes++; const t = performance.now(); const v = orig(); gl.finish(); rows.envLast = performance.now() - t; return v; };
  for (let i = 0; i < n; i++) {
    const before = envRefreshes;
    const t0 = performance.now();
    api.renderFrame(1000 + i); gl.finish();
    rows.push({ i, ms: +(performance.now() - t0).toFixed(2), env: envRefreshes > before ? +(rows.envLast || 0).toFixed(2) : 0 });
    if (i % 30 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  e.lighting.refreshEnvironment = orig;
  const ms = rows.map((x) => x.ms).sort((x, y) => x - y);
  const q = (p) => ms[Math.min(ms.length - 1, Math.floor(ms.length * p))];
  return {
    median: q(0.5), p90: q(0.9), p95: q(0.95), p99: q(0.99), max: ms[ms.length - 1],
    envRefreshes,
    worst: rows.slice().sort((x, y) => y.ms - x.ms).slice(0, 12),
    calls: e.stats.drawCalls, tris: e.stats.triangles,
  };
}, [shot, N]);
console.log(shot, JSON.stringify(r, null, 1));
if (logs.length) console.log('CONSOLE:', logs.slice(0, 20).join('\n'));
await browser.close();
