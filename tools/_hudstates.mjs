#!/usr/bin/env node
/**
 * Drive src/hud/hud.js directly with a hand-authored frame so states that are
 * hard to catch live (limiter flash, DRS open, a red flag in the contextual
 * slot) can be photographed on demand.
 *
 *   node tools/_hudstates.mjs --state limiter --out shots/x.png
 */
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
const out = resolve(arg('out', 'shots/hud-state.png'));
const state = arg('state', 'limiter');
const bg = arg('bg', '/shots/base-chase.png');
const port = arg('port', '5406');

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal', '--mute-audio', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
const errs = [];
page.on('pageerror', (e) => errs.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));
page.on('console', (m) => { if (m.type() === 'error') errs.push(`[console] ${m.text()}`); });
// Land on the HUD's own folder so a relative module import resolves.
await page.goto(`http://localhost:${port}/src/hud/preview.html?t=0`, { waitUntil: 'load' });
await page.setContent(`<style>html,body{margin:0;height:100%;overflow:hidden;background:#05070c}
#stage{position:fixed;inset:0;background:url(${bg}) center/cover no-repeat}</style><div id="stage"></div>`);
await page.addScriptTag({
  type: 'module',
  content: `
import { HUD, formatLapTime } from './hud.js';
const N = 900, samples = [];
for (let i = 0; i < N; i++) {
  const u = (i / N) * Math.PI * 2;
  const r = 620 + 210 * Math.sin(u * 3 + 0.7) + 90 * Math.sin(u * 5);
  samples.push({ s: i * 4, position: { x: Math.cos(u) * r, y: 0, z: Math.sin(u) * r * 0.72 },
    right: { x: Math.cos(u + 1.57), y: 0, z: Math.sin(u + 1.57) } });
}
const circuit = { samples, length: N * 4, step: 4,
  sectorStarts: [0, N * 4 / 3, N * 8 / 3],
  drsZones: [{ startS: 120, endS: 620 }, { startS: 2200, endS: 2600 }],
  sampleIndex: (s) => Math.floor((((s % (N*4)) + N*4) % (N*4)) / 4) % N,
  sampleAt(s) { return this.samples[this.sampleIndex(s)]; } };
const hud = new HUD(document.getElementById('stage'), { circuit });
hud.resize(1600, 900, 1);
const CODES = ['VER','HAL','OKO','REN','VOS','PLN','NOR','PIA','ALO','STR','GAS','TSU','ALB','SAR','BOT','ZHA','MAG','HUL','RIC','DEV'];
const COLS = ['#0b2a6b','#00b3a4','#00b3a4','#d81021','#d81021','#0b2a6b','#f45c0a','#f45c0a','#00594f','#00594f',
  '#1f4fd8','#1f4fd8','#d6dbe2','#d6dbe2','#8a1b6b','#8a1b6b','#2b2f36','#2b2f36','#6ec6f5','#6ec6f5'];
const state = ${JSON.stringify(state)};
const standings = CODES.map((code, i) => ({
  index: i, position: i + 1, code, colour: COLS[i],
  gap: i === 0 ? 0 : 0.6 + i * 1.35, interval: i === 0 ? 0 : 0.45 + (i % 4) * 0.5,
  compound: ['soft','medium','hard'][i % 3], drs: i === 4, pit: i === 7,
  number: [1,44,63,16,55,11,4,81,14,18,10,22,23,2,77,24,20,27,3,21][i],
  gapText: i === 0 ? 'LEADER' : '+' + (i * 1.35).toFixed(3),
}));
const base = {
  dt: 1 / 60,
  telemetry: {
    speedKph: state === 'limiter' ? 318 : 296, rpmNorm: state === 'limiter' ? 1.0 : 0.72,
    gear: 8, throttle: 1, brake: 0, drs: state === 'drs', drsAvailable: true, ers: 0.62,
    tyreTemp: [104, 98, 96, 99], tyreCore: [103, 97, 95, 98], tyreWear: [0.62, 0.41, 0.18, 0.22],
    tyreLoad: [1.2, 0.8, 1.1, 0.9], slipAngle: [0.05, 0.04, 0.03, 0.03], slipRatio: [0.02, 0.02, 0.04, 0.04],
    steer: 0.35, gLat: 2.4, compound: 'medium', tyreAge: 12, trackS: 1200, fuelKg: 62,
  },
  race: {
    phase: 'green', lap: 14, totalLaps: 24, currentLapText: formatLapTime(52.418),
    lastLapText: formatLapTime(89.334), bestLapText: formatLapTime(88.442), bestOverall: 88.442,
    sectorStatus: ['purple', 'green', ''], sectorTimes: [28.442, 31.007, 0], prevSectorTimes: [28.9, 31.4, 29.884],
    delta: -0.284, deltaText: '-0.284', standings, playerCode: 'REN', weatherLabel: 'DRY 31',
    fastestLap: { code: 'REN', time: 88.442 },
    banner: state === 'flag' ? null : null,
    message: state === 'flag' ? { title: 'SAFETY CAR', text: 'SC DEPLOYED' } : null,
  },
  cars: CODES.map((_, i) => ({ index: i, s: (i * 137 + 400) % (N * 4), lateral: Math.sin(i * 2.2) * 3, colour: COLS[i] })),
  playerIndex: 3,
  flag: state === 'flag' ? 'sc' : 'green',
  weather: { label: 'DRY 31°C' },
};
if (state === 'toast') {
  hud._push({ key: 'lap', title: 'FASTEST LAP', value: formatLapTime(88.442), sub: 'REN', colour: '#c264ff', life: 9 });
}
// A fixed number of frames so smoothing settles; the limiter flash phase is
// forced by stamping the clock onto an even 1/12 s bucket.
for (let i = 0; i < 90; i++) hud.render(base);
if (state === 'limiter') { hud.time = 2.0; hud.render(base); }
// Ink coverage: fraction of the frame the HUD actually paints, and the same
// measured with every panel counted as a solid rectangle (the critics' metric).
{
  const cv = hud.canvas, g = cv.getContext('2d');
  const d = g.getImageData(0, 0, cv.width, cv.height).data;
  let ink = 0, solid = 0;
  for (let i = 3; i < d.length; i += 4) { if (d[i] > 6) ink++; if (d[i] > 90) solid++; }
  window.__COVER__ = { ink: ink / (cv.width * cv.height), solid: solid / (cv.width * cv.height) };
}
window.__DONE__ = true;
`,
});
await page.waitForFunction(() => window.__DONE__ === true, null, { timeout: 30000 });
const cover = await page.evaluate(() => window.__COVER__);
console.log(`COVERAGE ink=${(cover.ink * 100).toFixed(2)}%  solid=${(cover.solid * 100).toFixed(2)}%`);
const cdp = await page.context().newCDPSession(page);
const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
await mkdir(dirname(out), { recursive: true });
await writeFile(out, Buffer.from(data, 'base64'));
console.log(`WROTE ${out}`);
if (errs.length) console.error(errs.slice(0, 20).join('\n'));
await browser.close();
