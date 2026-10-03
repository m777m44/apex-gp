#!/usr/bin/env node
/** Capture a shot with sky uniform overrides applied after staging. --set uName=val,... */
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
const HOME = process.env.HOME;
const EXE = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
const a = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const out = resolve(a('out', 'shots/_ab.png'));
const shot = a('shot', 'wide');
const W = +a('w', 1600), H = +a('h', 900), warm = +a('warm', 150);
const url = a('url', 'http://localhost:5505');
const sets = (a('set', '') || '').split(',').filter(Boolean).map((s) => s.split('='));

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });
await page.evaluate(async ([shot, warm, sets]) => {
  const api = window.__APEX__;
  api.pause();
  await api.capture(shot, 0);
  const sky = api.engine.sky;
  for (const [k, v] of sets) sky.uniforms[k].value = parseFloat(v);
  api.engine.lighting.refreshEnvironment();
  for (let i = 0; i < warm; i++) { api.renderFrame(i); if (i % 10 === 0) await new Promise((r) => setTimeout(r, 0)); }
  await api.settle();
  api.renderFrame(warm);
}, [shot, warm, sets]);
const cdp = await page.context().newCDPSession(page);
const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
await mkdir(dirname(out), { recursive: true });
await writeFile(out, Buffer.from(data, 'base64'));
console.log('WROTE', out);
await browser.close();
