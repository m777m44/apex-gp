// Tally live emitSparks() calls per frame for the PLAYER car, so the burst
// structure of the skid-block model can be measured rather than guessed.
import { chromium } from 'playwright-core';
const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const a = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const shot = a('shot', 'hud'), port = a('port', '5410'), frames = +a('frames', 300);
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
  const fx = e.particles ?? e.fx ?? e.particleSystem;
  if (!fx) return { err: 'no particles on engine: ' + Object.keys(e).join(',') };
  const player = e.field.cars[e.field.playerIndex ?? 0].vehicle;
  const per = [], live = [], lat = [];
  let acc = 0;
  const orig = fx.emitSparks.bind(fx);
  fx.emitSparks = function (pos, vel, n, o) {
    // Player car only: within 4 m of its origin.
    if (pos.distanceToSquared(player.position) < 16) {
      acc += n;
      const dx = pos.x - player.position.x, dz = pos.z - player.position.z;
      lat.push(+Math.hypot(dx, dz).toFixed(2));
    }
    return orig(pos, vel, n, o);
  };
  for (let i = 0; i < frames; i++) {
    acc = 0;
    await A.renderFrame(i);
    per.push(+acc.toFixed(2));
    live.push(fx.spark.live);
  }
  // Burst structure over the whole field (every car goes through this emitter).
  let on = 0, bursts = 0, prev = false, runs = [], run = 0;
  for (const x of per) {
    const hit = x > 0.05;
    if (hit) { on++; run++; if (!prev) bursts++; } else { if (run) runs.push(run); run = 0; }
    prev = hit;
  }
  if (run) runs.push(run);
  const s = [...per].sort((x, y) => x - y);
  return {
    frames: per.length, duty: +(on / per.length).toFixed(3), bursts,
    meanRunFrames: runs.length ? +(runs.reduce((x, y) => x + y) / runs.length).toFixed(1) : 0,
    perFrame: { med: s[(s.length * 0.5) | 0], p90: s[(s.length * 0.9) | 0], max: s[s.length - 1], mean: +(per.reduce((x, y) => x + y, 0) / per.length).toFixed(2) },
    liveMax: Math.max(...live), liveMed: [...live].sort((x, y) => x - y)[(live.length * 0.5) | 0],
    sparkCap: fx.spark.count,
    originRadius: lat.length ? { min: Math.min(...lat), max: Math.max(...lat) } : null,
    series: per.slice(0, 150).join(','),
  };
}, [shot, frames]);
console.log(shot, JSON.stringify(out, null, 1));
await b.close();
