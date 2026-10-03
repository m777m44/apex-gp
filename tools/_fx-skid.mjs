// Per-skid-point travel statistics + duty cycle at candidate bite thresholds.
import { chromium } from 'playwright-core';
const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const a = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const port = a('port', '5410'), frames = +a('frames', 300);
const b = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
p.on('pageerror', e => console.log('PAGEERR', e.message));
await p.goto(`http://localhost:${port}/?ui=0`, { waitUntil: 'load' });
await p.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });
for (const shot of ['hud', 'chase', 'tv', 'wheel']) {
  const out = await p.evaluate(async ([shot, frames]) => {
    const A = window.__APEX__;
    A.pause();
    await A.capture(shot, 0);
    const e = A.engine;
    const v = e.field.cars[e.field.playerIndex ?? 0].vehicle;
    const SKID = [
      { wr: 0.186, tr: 0.3125 }, { wr: 0.186, tr: 0.6875 },
      { wr: 0.881, tr: 0.3125 }, { wr: 0.881, tr: 0.6875 },
    ];
    const rows = [];
    for (let i = 0; i < frames; i++) {
      await A.renderFrame(i);
      const s = v.suspension;
      const t = SKID.map(S => {
        const L = s[0] * (1 - S.wr) + s[2] * S.wr;
        const R = s[1] * (1 - S.wr) + s[3] * S.wr;
        return L * (1 - S.tr) + R * S.tr;
      });
      const hw = v.circuit ? v.circuit.halfWidth : 6.7;
      rows.push({ t, spd: v.speed, lat: v.trackLateral ?? 0, kerb: Math.abs(v.trackLateral ?? 0) > hw - 0.2 && Math.abs(v.trackLateral ?? 0) < hw + 1.5 });
    }
    const pct = (arr, q) => { const s = [...arr].sort((x, y) => x - y); return +s[Math.min(s.length - 1, (s.length * q) | 0)].toFixed(4); };
    const duty = (k, thr) => {
      let on = 0, bursts = 0, prev = false;
      for (const r of rows) { const h = r.t[k] > thr; if (h) { on++; if (!prev) bursts++; } prev = h; }
      return `${(on / rows.length).toFixed(2)}/${bursts}`;
    };
    const front = [0, 1], rear = [2, 3];
    return {
      shot, spd: [pct(rows.map(r => r.spd), 0.1), pct(rows.map(r => r.spd), 0.9)],
      kerbFrac: +(rows.filter(r => r.kerb).length / rows.length).toFixed(2),
      skid: [0, 1, 2, 3].map(k => ({ k, p50: pct(rows.map(r => r.t[k]), 0.5), p90: pct(rows.map(r => r.t[k]), 0.9), max: pct(rows.map(r => r.t[k]), 0.999) })),
      frontDuty: [0.0180, 0.0186, 0.0194].map(t => `${t}:${front.map(k => duty(k, t)).join('|')}`),
      rearDuty: [0.0225, 0.0232, 0.0244].map(t => `${t}:${rear.map(k => duty(k, t)).join('|')}`),
    };
  }, [shot, frames]);
  console.log(JSON.stringify(out));
}
await b.close();
