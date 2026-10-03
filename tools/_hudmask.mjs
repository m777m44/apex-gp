/**
 * Captures the `hud` shot TWICE from one browser — once with the overlay on and
 * once with it off — so the HUD's exact pixel footprint can be isolated.
 *
 * Why: on a tree fifteen people are editing, `compare.mjs` against last round's
 * baseline mixes every module's delta together. Diffing on-vs-off at the SAME
 * instant, same sim state, same scene, leaves only the pixels this module is
 * responsible for. Anything outside that footprint provably is not the HUD's.
 *
 *   node tools/_hudmask.mjs <onOut.png> <offOut.png> [url] [shot]
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

const [onOut, offOut, url = 'http://localhost:5608', shot = 'hud'] = process.argv.slice(2);

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.__APEX__ && window.__APEX__.ready === true, null, { timeout: 120000 });
await page.evaluate(async ([s]) => {
  const api = window.__APEX__;
  api.pause();
  await api.capture(s, 0);
  for (let i = 0; i < 150; i++) { api.renderFrame(i); if (i % 10 === 0) await new Promise((r) => setTimeout(r, 0)); }
  if (api.settle) await api.settle();
  api.engine.frozen = true;             // hold the sim so both frames are identical
  api.renderFrame(150);
}, [shot]);

const cdp = await page.context().newCDPSession(page);
const grab = async (out) => {
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await writeFile(out, Buffer.from(data, 'base64'));
};
await grab(onOut);
// NO re-render between the two grabs. `renderFrame` advances motion blur, the
// particle pools and the shift-light phase even with `frozen` set, so a second
// render made the two frames differ across the whole windscreen and swamped the
// thing being measured. Hiding is a pure DOM change; the WebGL image underneath
// is untouched.
await page.evaluate(() => { window.__APEX__.engine.hud.setVisible(false); });
await grab(offOut);
console.log(`WROTE ${onOut} (overlay ON) and ${offOut} (overlay OFF), same frame`);
await browser.close();
