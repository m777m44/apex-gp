#!/usr/bin/env node
/** Environment round-5 helper: sun vector + grandstand/track geometry for a shot. */
import { chromium } from 'playwright-core';
const HOME = process.env.HOME;
const EXECUTABLES = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  `${HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const url = arg('url', 'http://localhost:5603');
const shot = arg('shot', 'grid');
const { existsSync } = await import('node:fs');
const executablePath = EXECUTABLES.find((p) => existsSync(p));
const browser = await chromium.launch({
  executablePath, headless: true,
  args: ['--use-angle=metal', '--enable-unsafe-webgpu', '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization', '--enable-webgl-draft-extensions',
    '--disable-frame-rate-limit', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width: 800, height: 450 } });
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__APEX__ && window.__APEX__.ready === true, null, { timeout: 120000 });
const res = await page.evaluate(async (shotName) => {
  const api = window.__APEX__; const e = window.APEX_ENGINE || api.engine;
  api.pause(); await api.capture(shotName, 0); for (let i = 0; i < 40; i++) api.renderFrame(i);
  const sun = e.sky.sunDirection;
  const c = e.circuit; const env = e.environment;
  const out = { sun: [sun.x, sun.y, sun.z], elevDeg: Math.asin(sun.y) * 180 / Math.PI };
  out.cam = [e.camera.position.x, e.camera.position.y, e.camera.position.z];
  const sm = c.samples[0];
  out.s0 = { pos: [sm.position.x, sm.position.y, sm.position.z], right: [sm.right.x, sm.right.y, sm.right.z], tan: [sm.tangent.x, sm.tangent.y, sm.tangent.z] };
  out.halfWidth = c.halfWidth;
  // sun lateral component along the sample's `right` at s=0
  out.sunAlongRight = sun.x * sm.right.x + sun.z * sm.right.z;
  out.sunHoriz = Math.hypot(sun.x, sun.z);
  // grandstand proxies near s=0
  out.stands = (env.grandstands || []).map((p) => {
    const d = p.position.clone().sub(sm.position);
    return { lat: d.x * sm.right.x + d.z * sm.right.z, along: d.x * sm.tangent.x + d.z * sm.tangent.z, y: p.position.y };
  }).filter((s) => Math.abs(s.along) < 260).sort((a, b) => a.along - b.along);
  const corr = env.corridorAt(0, 1);
  out.corridor = corr;
  return out;
}, shot);
console.log(JSON.stringify(res, null, 1));
await browser.close();
