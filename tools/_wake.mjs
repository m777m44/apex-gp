import { chromium } from 'playwright-core';
const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const b = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-angle=metal','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
p.on('pageerror', e => console.error('PAGEERR', e.message));
await p.goto('http://localhost:5420/?ui=0', { waitUntil: 'load' });
await p.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });
console.log(JSON.stringify(await p.evaluate(async () => {
  const api = window.__APEX__, e = api.engine;
  api.pause(); await api.capture('hud', 0);
  for (let i = 0; i < 200; i++) e.step(1/60);
  const t = e.player.vehicle.telemetry;
  return {
    playerDirty: +e.player.vehicle.wake.dirty.toFixed(3),
    playerTow: +e.player.vehicle.wake.tow.toFixed(3),
    playerGap: +e.player.vehicle.wake.gap.toFixed(1),
    telemetryDirtyAir: +t.dirtyAir.toFixed(3), telemetrySlip: +t.slipstream.toFixed(3),
    fieldTow: e.field.cars.map(c => +c.vehicle.wake.tow.toFixed(2)).slice(0, 8),
    cdaUntouched: e.field.cars.slice(1,4).map(c => +c.vehicle.cfg.cdA.toFixed(4)),
  };
})));
await b.close(); process.exit(0);
