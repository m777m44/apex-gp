// Live particle-pool occupancy + skid strike state per shot.
import { chromium } from 'playwright-core';
const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const a = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const port = a('port', '5509'), frames = +a('frames', 150);
const shots = a('shots', 'chase,tv,hud,wheel').split(',');
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
    const fx = e.particles || e.fx;
    if (!fx) return { shot, err: 'no particles' };
    const names = ['smoke', 'dust', 'spark', 'spray', 'debris', 'haze', 'wind'];
    const acc = {}; for (const n of names) acc[n] = { live: 0, maxLive: 0, px: 0, maxPx: 0 };
    const v = e.field.cars[e.field.playerIndex ?? 0].vehicle;
    let strike = 0, spd = 0;
    for (let i = 0; i < frames; i++) {
      await A.renderFrame(i);
      for (const n of names) {
        const pool = fx[n]; if (!pool) continue;
        let live = 0;
        for (let j = 0; j < pool.count; j++) if (pool.life[j] > 0 && pool.life[j] < 1) live++;
        acc[n].live += live; acc[n].maxLive = Math.max(acc[n].maxLive, live);
      }
      const st = null;
      if (st && st.strike) strike = Math.max(strike, Math.max(...st.strike));
      spd = v.speed;
    }
    const r = { shot, spd: +spd.toFixed(1), strike: +strike.toFixed(3) };
    for (const n of names) r[n] = `${(acc[n].live / frames).toFixed(0)}/${acc[n].maxLive}`;
    return r;
  }, [shot, frames]);
  console.log(JSON.stringify(out));
}
await b.close();
