// Log the player's suspension travel / ride-height collapse over a staged shot,
// so plank-strike thresholds can be chosen from measured numbers.
import { chromium } from 'playwright-core';
const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const a = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const shot = a('shot', 'hud'), port = a('port', '5410'), frames = +a('frames', 240);
const b = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
p.on('pageerror', e => console.log('PAGEERR', e.message));
await p.goto(`http://localhost:${port}/?ui=0`, { waitUntil: 'load' });
await p.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });
const out = await p.evaluate(async ([shot, frames]) => {
  const A = window.__APEX__;
  A.pause();
  await A.capture(shot, 0);
  const e = A.engine;
  const v = e.field.cars[e.field.playerIndex ?? 0].vehicle;
  const rows = [];
  for (let i = 0; i < frames; i++) {
    await A.renderFrame(i);
    const s = v.suspension;
    rows.push([+v.speed.toFixed(1), +s[0].toFixed(4), +s[1].toFixed(4), +s[2].toFixed(4), +s[3].toFixed(4),
      +(v.heave ?? 0).toFixed(4), +(v.heaveVel ?? 0).toFixed(3), +(v._rideFront ?? 0).toFixed(4), +(v._rideRear ?? 0).toFixed(4)]);
  }
  const col = (k) => rows.map(r => r[k]);
  const stat = (k) => { const c = col(k); const s = [...c].sort((x, y) => x - y); return { min: s[0], p10: s[(c.length * 0.1) | 0], med: s[(c.length * 0.5) | 0], p90: s[(c.length * 0.9) | 0], max: s[s.length - 1] }; };
  // Duty cycle + burst structure for candidate strike thresholds.
  const duty = (k1, k2, thr) => {
    let on = 0, bursts = 0, prev = false, runs = [];
    let run = 0;
    for (const r of rows) {
      const x = (r[k1] + r[k2]) * 0.5;
      const hit = x > thr;
      if (hit) { on++; run++; if (!prev) bursts++; } else { if (run) runs.push(run); run = 0; }
      prev = hit;
    }
    if (run) runs.push(run);
    return { thr, duty: +(on / rows.length).toFixed(3), bursts, meanRunFrames: runs.length ? +(runs.reduce((a, b) => a + b) / runs.length).toFixed(1) : 0 };
  };
  return {
    speed: stat(0), susF: stat(1), susR: stat(3),
    heave: stat(5), heaveVel: stat(6), rideF: stat(7), rideR: stat(8),
    cfg: { rhF: v.cfg.rideHeightFront, rhR: v.cfg.rideHeightRear, droop: v.cfg.droopLimit },
    frontGate: [0.018, 0.0195, 0.021, 0.0225].map(t => duty(1, 2, t)),
    rearGate: [0.022, 0.024, 0.025, 0.026].map(t => duty(3, 4, t)),
  };
}, [shot, frames]);
console.log(shot, JSON.stringify(out, null, 1));
await b.close();
