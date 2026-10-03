#!/usr/bin/env node
/** Dump the exact frame the HUD is fed for a given shot. */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const HOME = process.env.HOME;
const EXE = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  `${HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => existsSync(p));

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const shot = arg('shot', 'hud');
const warm = parseInt(arg('warm', '150'), 10);
const url = arg('url', 'http://localhost:5406');

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text()); });
await page.goto(url, { waitUntil: 'load' });
await page.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });
const data = await page.evaluate(async ([s, n]) => {
  const api = window.__APEX__;
  api.pause();
  await api.capture(s, 0);
  for (let i = 0; i < n; i++) { api.renderFrame(i); if (i % 10 === 0) await new Promise((r) => setTimeout(r, 0)); }
  const e = api.engine;
  const tel = e.player.vehicle.telemetry;
  const snap = e.session.snapshot();
  const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]));
  return {
    tel: pick(tel, ['speedKph', 'rpm', 'rpmNorm', 'gear', 'throttle', 'brake', 'drs', 'drsAvailable', 'ers',
      'tyreTemp', 'tyreCore', 'tyreCarcass', 'tyreWear', 'tyreLoad', 'brakeTemp', 'slipAngle', 'slipRatio',
      'fuelKg', 'compound', 'tyreAge', 'trackS']),
    race: pick(snap, ['lap', 'totalLaps', 'currentLapText', 'lastLapText', 'bestLapText', 'sectorStatus',
      'sectorTimes', 'prevSectorTimes', 'delta', 'deltaText', 'flag', 'banner', 'phase', 'bestOverall', 'playerCode']),
    standings: snap.standings.map((x) => [x.position, x.code, x.gap, x.interval, x.compound, x.drs, x.pit]),
    playerIndex: e.playerIndex,
    weather: e.weather?.conditions?.label ?? null,
  };
}, [shot, warm]);
console.log(JSON.stringify(data, null, 1));
await browser.close();
