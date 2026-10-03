import { chromium } from 'playwright-core';
const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const b = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-angle=metal','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
p.on('pageerror', e => console.log('PAGEERR', e.message));
await p.goto('http://localhost:5303/?ui=0', { waitUntil: 'load' });
await p.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });
console.log(JSON.stringify(await p.evaluate(() => {
  const e = window.__APEX__.engine;
  window.__APEX__.pause();
  // PURE physics. No session, no AI, no race control anywhere near it.
  const v = e.field.cars[5].vehicle;
  const trial = (startSpeed) => {
    v.reset({ s: 1200, lateral: 0, speed: startSpeed });
    const rows = [];
    for (let i = 0; i <= 300; i++) {
      v.setControls({ steer: 0, throttle: 1, brake: 0, autoGearbox: true });
      v.step(1 / 60);
      if (i % 60 === 0) rows.push({ i, spd: +v.speed.toFixed(2), gear: v.gear,
        rpm: Math.round(v.rpm), u: +v.u.toFixed(2),
        load: (v.telemetry?.tyreLoad ?? []).map(x => Math.round(x)).join('/'),
        Fz: (v.wheelLoad ?? v.tyreLoad ?? []).length ? (v.wheelLoad ?? v.tyreLoad).map(x=>Math.round(x)).join('/') : 'n/a',
        slipR: (v.slipRatio ?? []).map(x => +x.toFixed(3)).join('/'),
        om: (v.wheelOmega ?? []).map(x => +x.toFixed(1)).join('/') });
    }
    return rows;
  };
  return { fromRest: trial(0), rolling: trial(40),
    cfgKeys: Object.keys(v.cfg).filter(k=>/mass|torque|redline|idle|gear|clutch/i.test(k)),
    mass: v.cfg.mass, baseMass: v.cfg._baseMass, wear: v.cfg.tyreWearRate, baseWear: v.cfg._baseWear };
}), null, 1));
await b.close();
