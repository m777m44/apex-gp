// Capture a shot on the frame where the player's skid sparks are actually
// showering, so the LOOK of a burst can be inspected. Also reports, for the
// whole warm-up window, on what fraction of frames a burst is visible.
import { chromium } from 'playwright-core';
import { writeFileSync } from 'node:fs';
const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const a = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const shot = a('shot', 'hud'), port = a('port', '5410'), out = a('out', 'shots/fx-burst.png');
const warm = +a('warm', 150), extra = +a('extra', 120), W = +a('w', 1600), H = +a('h', 900);
const b = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu'] });
const p = await b.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
p.on('pageerror', e => console.log('PAGEERR', e.message));
p.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
await p.goto(`http://localhost:${port}/?ui=0`, { waitUntil: 'load' });
await p.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 180000 });
await p.evaluate(async ([shot, warm]) => {
  const A = window.__APEX__;
  A.pause();
  await A.capture(shot, 0);
  await A.settle();
  const e = A.engine;
  const fx = e.particles;
  const player = e.field.cars[e.field.playerIndex ?? 0].vehicle;
  window.__FXTALLY = { acc: 0, hist: [] };
  const orig = fx.emitSparks.bind(fx);
  fx.emitSparks = function (pos, vel, n, o) {
    if (pos.distanceToSquared(player.position) < 16) window.__FXTALLY.acc += n;
    return orig(pos, vel, n, o);
  };
  for (let i = 0; i < warm; i++) {
    window.__FXTALLY.acc = 0;
    await A.renderFrame(i);
    window.__FXTALLY.hist.push(+window.__FXTALLY.acc.toFixed(2));
  }
}, [shot, warm]);
// Hunt forward for a frame that is mid-shower AND has sparks in flight.
let found = -1;
for (let i = 0; i < extra; i++) {
  const r = await p.evaluate(async ([i]) => {
    const A = window.__APEX__;
    window.__FXTALLY.acc = 0;
    await A.renderFrame(1000 + i);
    window.__FXTALLY.hist.push(+window.__FXTALLY.acc.toFixed(2));
    return { emit: window.__FXTALLY.acc, live: A.engine.particles.spark.live };
  }, [i]);
  if (r.emit > 1.0 && r.live > 40) { found = i; break; }
}
const hist = await p.evaluate(() => window.__FXTALLY.hist);
const on = hist.filter(x => x > 0.05).length;
await p.screenshot({ path: out });
console.log(`${out} shot=${shot} burstFrame=+${found} framesScanned=${hist.length} nonZeroFrac=${(on / hist.length).toFixed(2)} peak=${Math.max(...hist)}`);
await b.close();
