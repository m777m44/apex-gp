// Player lateral / kerb-band occupancy + per-skid travel + intrusion vs bite.
import { chromium } from 'playwright-core';
const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const a = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const port = a('port', '5509'), frames = +a('frames', 150);
const shots = a('shots', 'chase,tv,hud').split(',');
const b = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 800, height: 450 } });
p.on('pageerror', e => console.log('PAGEERR', e.message));
await p.goto(`http://localhost:${port}/?ui=0`, { waitUntil: 'load' });
await p.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });
for (const shot of shots) {
  const out = await p.evaluate(async ([shot, frames]) => {
    const A = window.__APEX__;
    A.pause(); await A.capture(shot, 0);
    const e = A.engine;
    const pi = e.field.playerIndex ?? 0;
    const v = (e.field.cars.find(c => c.index === pi) || e.field.cars[0]).vehicle;
    const hw = v.circuit.halfWidth;
    const SKID = [
      { wr: 0.186, tr: 0.3125 }, { wr: 0.186, tr: 0.6875 },
      { wr: 0.881, tr: 0.3125 }, { wr: 0.881, tr: 0.6875 },
    ];
    const lat = [], tr = [[], [], [], []], sus = [[], [], [], []];
    let kerbF = 0, spd = [];
    for (let i = 0; i < frames; i++) {
      await A.renderFrame(i);
      const L = v.trackLateral ?? 0;
      lat.push(L);
      const al = Math.abs(L);
      if (al > hw - 0.2 && al < hw + 1.5) kerbF++;
      const s = v.suspension;
      for (let k = 0; k < 4; k++) {
        const S = SKID[k];
        const cl = s[0] * (1 - S.wr) + s[2] * S.wr, cr = s[1] * (1 - S.wr) + s[3] * S.wr;
        tr[k].push(cl * (1 - S.tr) + cr * S.tr);
      }
      for (let k = 0; k < 4; k++) sus[k].push(s[k]);
      spd.push(v.speed);
    }
    const q = (arr, x) => { const s2 = [...arr].sort((m, n) => m - n); return +(s2[Math.min(s2.length - 1, (s2.length * x) | 0)]).toFixed(4); };
    const mm = (arr, x) => +(q(arr, x) * 1000).toFixed(2);
    return {
      shot, hw: +hw.toFixed(2), kerbFrac: +(kerbF / frames).toFixed(2),
      lat: [q(lat, 0.05), q(lat, 0.5), q(lat, 0.95)],
      spd: [q(spd, 0.1), q(spd, 0.9)],
      travelMm: tr.map((t, k) => `k${k} p10=${mm(t, 0.1)} p50=${mm(t, 0.5)} p90=${mm(t, 0.9)} max=${mm(t, 0.99)}`),
      corner: sus.map((t, k) => `w${k} p50=${mm(t, 0.5)} p90=${mm(t, 0.9)}`),
    };
  }, [shot, frames]);
  console.log(JSON.stringify(out, null, 1));
}
await b.close();
