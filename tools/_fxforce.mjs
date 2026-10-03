// Force a spark shower off the player's plank and screenshot, to separate
// "never emitted" from "emitted but invisible".
import { chromium } from 'playwright-core';
const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const a = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const port = a('port', '5509'), shot = a('shot', 'chase'), out = a('out', 'shots/_fxforce.png');
const frames = +a('frames', 150), rate = +a('rate', 6);
const b = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
p.on('pageerror', e => console.log('PAGEERR', e.message));
await p.goto(`http://localhost:${port}/?ui=0`, { waitUntil: 'load' });
await p.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });
const info = await p.evaluate(async ([shot, frames, rate]) => {
  const A = window.__APEX__;
  A.pause(); await A.capture(shot, 0);
  const e = A.engine, fx = e.particles;
  const pi = e.field.playerIndex ?? 0;
  const car = e.field.cars.find(c => c.index === pi) || e.field.cars[0];
  const v = car.vehicle;
  const dfc = fx.driveFromCar.bind(fx);
  let live = 0;
  fx.driveFromCar = (c, dt, w) => {
    const r = dfc(c, dt, w);
    if (c.index === pi) {
      const yaw = v.yaw;
      const f = { x: -Math.sin(yaw), y: 0, z: -Math.cos(yaw) };
      const g = { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) };
      for (const S of [{ z: -0.95, x: -0.30 }, { z: -0.95, x: 0.30 }, { z: 1.55, x: -0.30 }, { z: 1.55, x: 0.30 }]) {
        const pos = { x: v.position.x - f.x * S.z + g.x * S.x, y: v.position.y + 0.010, z: v.position.z - f.z * S.z + g.z * S.x };
        const vel = { x: f.x * v.u * 0.62 + g.x * v.v * 0.62, y: 0, z: f.z * v.u * 0.62 + g.z * v.v * 0.62 };
        fx.emitSparks(pos, vel, rate, { floor: v.position.y + 0.010, tangent: f, spread: 5, rise: 1.5, jitter: 0.16, stride: v.speed / 60 });
      }
    }
    return r;
  };
  for (let i = 0; i < frames; i++) await A.renderFrame(i);
  const sp = fx.spark;
  for (let j = 0; j < sp.count; j++) if (sp.life[j] < 1) live++;
  return { live, speed: +v.speed.toFixed(1) };
}, [shot, frames, rate]);
console.log(JSON.stringify(info));
await p.screenshot({ path: out });
console.log('wrote', out);
await b.close();
