#!/usr/bin/env node
/**
 * True GPU-bound frame time. Two independent measurements:
 *   batch  — N frames submitted back to back, one gl.finish() at the end
 *   raf    — the real engine loop, sampled from stats.fps after it settles
 * Optionally reports a WebGL2 disjoint-timer-query breakdown of the post stack.
 */
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
const W = +a('w', 1920), H = +a('h', 1080), N = +a('frames', 120);
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
  for (let i = 0; i < 100; i++) { api.renderFrame(i); if (i % 10 === 0) await new Promise((r) => setTimeout(r, 0)); }
  await api.settle();
  const gl = e.renderer.getContext();

  const batch = (count) => {
    gl.finish();
    const t0 = performance.now();
    for (let i = 0; i < count; i++) api.renderFrame(5000 + i);
    gl.finish();
    return (performance.now() - t0) / count;
  };
  batch(20);                       // prime
  const batchMs = Math.min(batch(n), batch(n));

  const isolate={};


  return { batchMs: +batchMs.toFixed(2), fpsFromBatch: +(1000 / batchMs).toFixed(1),
    calls: e.stats.drawCalls, tris: e.stats.triangles, isolate };
}, [shot, N]);

// real rAF loop
const raf = await page.evaluate(async () => {
  const api = window.__APEX__;
  api.resume();
  await new Promise((r) => setTimeout(r, 3500));
  const f = api.stats().fps;
  api.pause();
  return +f.toFixed(1);
});

console.log(shot, JSON.stringify({ ...r, rafFps: raf }, null, 1));
if (logs.length) console.log('CONSOLE(' + logs.length + '):', [...new Set(logs)].slice(0, 20).join('\n'));
await browser.close();
