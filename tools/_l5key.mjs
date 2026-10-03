#!/usr/bin/env node
/**
 * Report the key-eclipse-rescue decision for each shot: what the shot author
 * asked for, how much of the probe bundle that bearing was blocked by, and what
 * the sun ended up at.
 *
 *   node tools/_l5key.mjs --shots grid,tv,wide,beauty,chase --url http://localhost:5606
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const HOME = process.env.HOME;
const EXE = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const shots = arg('shots', 'grid,tv,wide,beauty,chase').split(',');
const url = arg('url', 'http://localhost:5606');

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });

const out = await page.evaluate(async (shotNames) => {
  const api = window.__APEX__;
  const eng = window.APEX_ENGINE;
  api.pause();
  const rows = [];
  for (const name of shotNames) {
    const L = eng.lighting;
    L.keyRescueLog = null;
    L.keyRescueDebug = true;
    L._rescueCache.clear();
    await api.capture(name, 0);
    const t0 = performance.now();
    api.renderFrame(0);
    const ms = performance.now() - t0;
    for (let i = 1; i < 10; i++) api.renderFrame(i);
    rows.push({
      shot: name,
      log: L.keyRescueLog,
      liveSun: { el: +eng.sky.elevation.toFixed(2), az: +eng.sky.azimuth.toFixed(2) },
      firstFrameMs: +ms.toFixed(1),
      rootsUsed: (L._rescueRoots || []).map((r) => r.name),
    });
  }
  return rows;
}, shots);

console.log(JSON.stringify(out, null, 1));
await browser.close();
