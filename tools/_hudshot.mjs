#!/usr/bin/env node
/** Screenshot src/hud/preview.html at a given script time. HUD-only iteration. */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const HOME = process.env.HOME;
const EXE = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  `${HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => existsSync(p));

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const out = resolve(arg('out', 'shots/hud-preview.png'));
const t = arg('t', '3.2');
const bg = arg('bg', '/shots/base-chase.png');
const port = arg('port', '5406');
const w = parseInt(arg('w', '1600'), 10);
const h = parseInt(arg('h', '900'), 10);
const wait = parseInt(arg('wait', '600'), 10);

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal', '--mute-audio', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`[console] ${m.text()}`); });
await page.goto(`http://localhost:${port}/src/hud/preview.html?t=${t}&bg=${encodeURIComponent(bg)}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.__HUD_READY__ === true, null, { timeout: 30000 });
await page.waitForTimeout(wait);
const cdp = await page.context().newCDPSession(page);
const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
await mkdir(dirname(out), { recursive: true });
await writeFile(out, Buffer.from(data, 'base64'));
console.log(`WROTE ${out}`);
if (errs.length) console.error(errs.slice(0, 20).join('\n'));
await browser.close();
