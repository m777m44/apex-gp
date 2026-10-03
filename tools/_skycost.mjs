#!/usr/bin/env node
/** GPU cost of the sky shader: batch frame time with the cloud/cirrus layers on vs off. */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME = process.env.HOME;
const EXE = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
const a = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const shot = a('shot', 'grid'), url = a('url', 'http://localhost:5505');
const W = +a('w', 1920), H = +a('h', 1080), N = +a('frames', 90);
const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--hide-scrollbars', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });
const out = await page.evaluate(async ([shot, N]) => {
  const api = window.__APEX__; api.pause();
  await api.capture(shot, 0);
  for (let i = 0; i < 90; i++) { api.renderFrame(i); if (i % 10 === 0) await new Promise((r) => setTimeout(r, 0)); }
  await api.settle();
  const sky = api.engine.sky, gl = api.engine.renderer.getContext();
  const bench = () => { const t = performance.now(); for (let i = 0; i < N; i++) api.renderFrame(1000 + i); gl.finish(); return (performance.now() - t) / N; };
  const cov = sky.uniforms.uCloudCoverage.value, cir = sky.uniforms.uCirrusAmount.value;
  const set = (on) => { sky.uniforms.uCloudCoverage.value = on ? cov : 0; sky.uniforms.uCirrusAmount.value = on ? cir : 0; };
  // Interleave: this machine has other agents rebuilding on it, so a single
  // on-then-off pair is dominated by drift. Alternate and take medians.
  const ons = [], offs = [];
  set(true); bench();
  for (let k = 0; k < 7; k++) { set(true); ons.push(bench()); set(false); offs.push(bench()); }
  set(true);
  const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
  const on = med(ons), off = med(offs);
  return { onMs: +on.toFixed(2), offMs: +off.toFixed(2), cloudMs: +(on - off).toFixed(2) };
}, [shot, N]);
console.log(shot, JSON.stringify(out));
await browser.close();
