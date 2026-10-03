#!/usr/bin/env node
// Toggle named scene children off and capture, to identify what a pixel is.
import { chromium } from 'playwright-core';
import { existsSync, writeFileSync } from 'node:fs';
const HOME = process.env.HOME;
const EXE = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const shot = arg('shot', 'grid');
const hide = (arg('hide', '') || '').split(',').filter(Boolean);
const out = arg('out', 'shots/_toggle.png');
const url = arg('url', 'http://localhost:5403');
const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text()); });
await page.goto(url, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 180000 });
const names = await page.evaluate(async ({ shotName, hideList }) => {
  const api = window.__APEX__;
  api.pause();
  const eng = api.engine;
  const found = [];
  eng.scene.traverse((o) => { if (hideList.includes(o.name)) { o.visible = false; found.push(o.name); } });
  if (api.capture) await api.capture(shotName, 0);
  eng.scene.traverse((o) => { if (hideList.includes(o.name)) o.visible = false; });
  await api.settle?.();
  for (let i = 0; i < 150; i++) api.renderFrame(i);
  return found;
}, { shotName: shot, hideList: hide });
console.log('hidden:', names.join(',') || '(none)');
const buf = await page.locator('canvas').first().screenshot();
writeFileSync(out, buf);
console.log('WROTE', out);
await browser.close();
