import { chromium } from 'playwright-core';
const b = await chromium.launch({ channel: 'chrome', args: ['--use-angle=metal'] });
const p = await b.newPage();
p.on('pageerror', e => console.log('PAGEERR', e.message));
await p.goto('http://localhost:5209', { waitUntil: 'load' });
await p.waitForFunction('window.__APEX__ && window.__APEX__.ready', null, { timeout: 60000 });
const r = await p.evaluate(async () => {
  const e = window.__APEX__.engine;
  window.__APEX__.pause();
  e.frozen = false;
  const c = e.field.cars[3];
  const snap = [];
  for (let i = 0; i < 240; i++) {
    e.step(1/60);
    if (i % 30 === 0) snap.push({
      i, t: +(c.ai.launchTimer).toFixed(2), launched: c.ai.launched,
      ctl: JSON.parse(JSON.stringify(c.vehicle.controls)),
      u: +c.vehicle.u.toFixed(2), rpm: +c.vehicle.rpm.toFixed(0), gear: c.vehicle.gear,
      om: c.vehicle.wheelOmega.map(v=>+v.toFixed(1)),
      y: +c.vehicle.position.y.toFixed(2),
    });
  }
  return { snap, frozen: e.frozen, phase: e.session.phase };
});
console.log(JSON.stringify(r, null, 1));
await b.close();
