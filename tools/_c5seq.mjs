import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME = process.env.HOME;
const EXE = [`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const shot = process.argv[2] || 'chase';
const b = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.goto('http://localhost:5607', { waitUntil: 'load', timeout: 120000 });
await p.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });
const r = await p.evaluate(async (shot) => {
  const api = window.__APEX__, eng = api.engine, THREE = eng.THREE || null;
  api.pause(); await api.capture(shot, 0);
  const rows = [];
  let pq = eng.camera.quaternion.clone();
  for (let i = 0; i < 150; i++) {
    api.renderFrame(i);
    const dq = pq.clone().invert().multiply(eng.camera.quaternion);
    const e = new (Object.getPrototypeOf(eng.camera.rotation).constructor)().setFromQuaternion(dq, 'YXZ');
    pq = eng.camera.quaternion.clone();
    if (i > 120) rows.push([+(e.y*1000).toFixed(2), +(e.x*1000).toFixed(2), +(e.z*1000).toFixed(2)]);
  }
  const rig = eng.rig;
  return { rows, roadShake: rig.roadShake, shake: rig.shake, mode: rig.mode,
           speed: eng.field.player.vehicle.telemetry.speed, gLat: eng.field.player.vehicle.telemetry.gLat,
           swingUsed: rig.chase.swing, roll: rig.roll };
}, shot);
console.log(JSON.stringify(r.rows.map(x=>x[0])));
console.log('pitch', JSON.stringify(r.rows.map(x=>x[1])));
console.log('roll', JSON.stringify(r.rows.map(x=>x[2])));
console.log('roadShake', r.roadShake.toFixed(3), 'shake', r.shake.toFixed(3), 'speed', r.speed.toFixed(1), 'gLat', r.gLat.toFixed(2), 'roll', r.roll.toFixed(4));
await b.close();
