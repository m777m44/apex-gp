/** Probe: is the HUD glass layer actually live in the capture browser? */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME = process.env.HOME;
const EXE = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  `${HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => existsSync(p));
const url = process.argv[2] ?? 'http://localhost:5608';
const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.__APEX__ && window.__APEX__.ready === true, null, { timeout: 120000 });
await page.evaluate(async () => {
  const api = window.__APEX__;
  api.pause();
  await api.capture('hud', 0);
  for (let i = 0; i < 40; i++) { api.renderFrame(i); if (i % 10 === 0) await new Promise((r) => setTimeout(r, 0)); }
});
const out = await page.evaluate(() => {
  const hud = window.__APEX__.engine?.hud;
  const els = hud ? [...hud._glassPool.entries()].map(([id, el]) => ({
    id, display: el.style.display, filter: el.style.backdropFilter,
    box: el.getBoundingClientRect().toJSON(),
  })) : null;
  return {
    supports: CSS.supports('backdrop-filter', 'blur(4px)'),
    glassOn: hud?.glassOn, count: hud?._glassPool.size, els,
  };
});
console.log(JSON.stringify(out, null, 1));
await browser.close();
