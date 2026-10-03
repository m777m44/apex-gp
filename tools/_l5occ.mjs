#!/usr/bin/env node
/**
 * Per-root eclipse probe: which named scene child is actually standing between
 * the shadow focus and the sun, and what does each cost to raycast.
 *
 *   node tools/_l5occ.mjs --shot grid --url http://localhost:5606
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const HOME = process.env.HOME;
const EXE = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const shot = arg('shot', 'grid');
const url = arg('url', 'http://localhost:5606');

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });

const out = await page.evaluate(async (shotName) => {
  const api = window.__APEX__;
  const eng = window.APEX_ENGINE;
  api.pause();
  const L = eng.lighting;
  L.keyRescue = false;
  await api.capture(shotName, 0);
  for (let i = 0; i < 6; i++) api.renderFrame(i);
  L.keyRescueDebug = true;

  const names = [];
  eng.scene.traverse((o) => { if (o.name && o.children && o.children.length && o.parent && o.parent.name === 'Environment') names.push(o.name); });
  const rows = [];
  const dir = L.keyDirection.clone();
  for (const n of names) {
    const obj = eng.scene.getObjectByName(n);
    if (!obj) continue;
    L._rescueRoots = [obj];
    const t0 = performance.now();
    const f = L._probeKeyOcclusion(dir);
    const ms = performance.now() - t0;
    rows.push({ name: n, blocked: f, ms: +ms.toFixed(1), sample: (L.keyProbeHits || []).find((h) => h.root) || null });
  }
  L._rescueRoots = null;
  return { focus: L._focus.toArray().map((v) => +v.toFixed(1)), keyDir: dir.toArray().map((v) => +v.toFixed(3)), envChildren: names, rows: rows.filter((r) => r.blocked > 0 || r.ms > 3) };
}, shot);

console.log(JSON.stringify(out, null, 1));
await browser.close();
