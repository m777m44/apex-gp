// Capture a shot, then re-shoot it from N camera distances behind the grid to
// find at what range car shadows disappear.  node tools/_camsweep.mjs --url ...
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
const HOME = process.env.HOME;
const EXE = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const url = arg('url', 'http://localhost:5420');
const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });
const cdp = await page.context().newCDPSession(page);
mkdirSync('shots/sweep', { recursive: true });
for (const d of [18, 34, 55, 80, 108]) {
  await page.evaluate(async (dist) => {
    const api = window.__APEX__; api.pause(); await api.capture('grid', 0);
    const e = window.APEX_ENGINE, c = e.circuit;
    const g0 = c.gridSlot(0);
    const eye = c.pointAt(c.wrapS(g0.s - dist), 0, 0); eye.y += dist * 0.09 + 1.6;
    const look = c.pointAt(c.wrapS(g0.s + 4), 0, 0); look.y += 0.7;
    e._staticCam = { position: eye, lookAt: look, fov: 34 };
    for (let i = 0; i < 25; i++) api.renderFrame(i);
  }, d);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`shots/sweep/grid_${d}.png`, Buffer.from(data, 'base64'));
  console.log(`shots/sweep/grid_${d}.png`);
}
await browser.close(); process.exit(0);
