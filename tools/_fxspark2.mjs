// Hook emitSparks/emitDust and attribute emission to cars; report ego-car skid state.
import { chromium } from 'playwright-core';
const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const a = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const port = a('port', '5509'), frames = +a('frames', 120);
const shots = a('shots', 'chase,tv,hud').split(',');
const b = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 800, height: 450 } });
p.on('pageerror', e => console.log('PAGEERR', e.message));
await p.goto(`http://localhost:${port}/?ui=0`, { waitUntil: 'load' });
await p.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });
for (const shot of shots) {
  const out = await p.evaluate(async ([shot, frames]) => {
    const A = window.__APEX__;
    A.pause();
    await A.capture(shot, 0);
    const e = A.engine;
    const fx = e.particles;
    const pi = e.field.playerIndex ?? 0;
    const v = e.field.cars[pi].vehicle;
    // hook
    let cur = -1;
    const dfc = fx.driveFromCar.bind(fx);
    const es = fx.emitSparks.bind(fx);
    const ed = fx.emitDust.bind(fx);
    const esm = fx.emitSmoke.bind(fx);
    const tally = { egoSpark: 0, otherSpark: 0, egoDust: 0, egoSmoke: 0 };
    fx.driveFromCar = (car, dt, w) => { cur = car.index; const r = dfc(car, dt, w); cur = -1; return r; };
    fx.emitSparks = (pos, vel, amt, o) => { if (cur === pi) tally.egoSpark += amt; else tally.otherSpark += amt; return es(pos, vel, amt, o); };
    fx.emitDust = (pos, vel, amt, o) => { if (cur === pi) tally.egoDust += amt; return ed(pos, vel, amt, o); };
    fx.emitSmoke = (pos, vel, amt, o) => { if (cur === pi) tally.egoSmoke += amt; return esm(pos, vel, amt, o); };
    const SKID = [
      { wr: 0.186, tr: 0.3125, bite: 0.0194 }, { wr: 0.186, tr: 0.6875, bite: 0.0194 },
      { wr: 0.881, tr: 0.3125, bite: 0.0244 }, { wr: 0.881, tr: 0.6875, bite: 0.0244 },
    ];
    const tr = [[], [], [], []];
    let spd = [];
    for (let i = 0; i < frames; i++) {
      await A.renderFrame(i);
      const s = v.suspension;
      for (let k = 0; k < 4; k++) {
        const S = SKID[k];
        const L = s[0] * (1 - S.wr) + s[2] * S.wr;
        const R = s[1] * (1 - S.wr) + s[3] * S.wr;
        tr[k].push(L * (1 - S.tr) + R * S.tr);
      }
      spd.push(v.speed);
    }
    const pct = (arr, q) => { const s2 = [...arr].sort((x, y) => x - y); return +(s2[Math.min(s2.length - 1, (s2.length * q) | 0)] * 1000).toFixed(2); };
    // live spark distribution relative to camera
    const cam = e.camera;
    const sp = fx.spark; let inFront = 0, live = 0;
    for (let j = 0; j < sp.count; j++) {
      if (sp.life[j] >= 1) continue; live++;
      const x = sp.pos[j * 3], y = sp.pos[j * 3 + 1], z = sp.pos[j * 3 + 2];
      const dx = x - cam.position.x, dy = y - cam.position.y, dz = z - cam.position.z;
      // camera forward
      const m = cam.matrixWorld.elements;
      const fx3 = -m[8], fy3 = -m[9], fz3 = -m[10];
      if (dx * fx3 + dy * fy3 + dz * fz3 > 0.5) inFront++;
    }
    return {
      shot, spd: [pct(spd, 0.1) / 1000, pct(spd, 0.9) / 1000],
      egoSparkPerFrame: +(tally.egoSpark / frames).toFixed(2),
      otherSparkPerFrame: +(tally.otherSpark / frames).toFixed(2),
      egoDustPerFrame: +(tally.egoDust / frames).toFixed(2),
      egoSmokePerFrame: +(tally.egoSmoke / frames).toFixed(2),
      travelMm: tr.map((t, k) => `k${k} p50=${pct(t, 0.5)} p90=${pct(t, 0.9)} bite=${SKID[k].bite * 1000}`),
      sparkLive: live, sparkInFront: inFront,
    };
  }, [shot, frames]);
  console.log(JSON.stringify(out, null, 1));
}
await b.close();
