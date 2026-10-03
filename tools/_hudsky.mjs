/**
 * Worst-case HUD legibility probe: stage a shot with a lot of OPEN SKY behind
 * the panels, force the overlay on, and screenshot it. Raising PANEL_DIM buys
 * material depth over dark tarmac; the bill for it is paid over a bright sky,
 * which the `hud` shot (a chase down a straight, mostly asphalt and hoardings)
 * never puts behind a panel.
 *
 *   node tools/_hudsky.mjs <shot> <out.png> [url]
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';

const HOME = process.env.HOME;
const EXE = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  `${HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => existsSync(p));

const shot = process.argv[2] ?? 'wide';
const out = process.argv[3] ?? 'shots/_hudsky.png';
const url = process.argv[4] ?? 'http://localhost:5608';

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.__APEX__ && window.__APEX__.ready === true, null, { timeout: 120000 });
await page.evaluate(async ([s]) => {
  const api = window.__APEX__;
  api.pause();
  await api.capture(s, 0);
  for (let i = 0; i < 120; i++) { api.renderFrame(i); if (i % 10 === 0) await new Promise((r) => setTimeout(r, 0)); }
  api.engine.hud.setVisible(true);
  if (api.settle) await api.settle();
  api.renderFrame(121);
  api.renderFrame(122);
}, [shot]);
const cdp = await page.context().newCDPSession(page);
const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
await writeFile(out, Buffer.from(data, 'base64'));
console.log(`WROTE ${out} (shot=${shot}, HUD forced on)`);
await browser.close();
