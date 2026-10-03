import { chromium } from 'playwright-core';
const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const b = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-angle=metal','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
p.on('pageerror', e => console.log('PAGEERR', e.message));
await p.goto('http://localhost:5509/?ui=0', { waitUntil: 'load' });
await p.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });
for (const shot of ['hud','chase']) {
  const r = await p.evaluate(async (shot) => {
    const A = window.__APEX__; A.pause(); await A.capture(shot, 0);
    for (let i=0;i<120;i++) await A.renderFrame(i);
    const t0 = performance.now();
    for (let i=0;i<180;i++) await A.renderFrame(i);
    const ms = (performance.now()-t0)/180;
    const s = A.stats();
    const fx = A.engine.particles;
    let live = 0; for (const pool of fx.pools) for (let j=0;j<pool.count;j++) if (pool.life[j]<1) live++;
    return { shot, msPerFrame:+ms.toFixed(2), drawCalls:s.drawCalls, tris:s.triangles, particlesLive:live };
  }, shot);
  console.log(JSON.stringify(r));
}
await b.close();
