import { chromium } from 'playwright-core';
const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const b = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-angle=metal'] });
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
await p.goto('http://localhost:5509/?ui=0', { waitUntil: 'load' });
await p.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });
for (const shot of ['chase','tv','hud']) {
  const r = await p.evaluate(async (shot) => {
    const A = window.__APEX__; A.pause(); await A.capture(shot, 0);
    const e = A.engine, pi = e.field.playerIndex ?? 0;
    const v = (e.field.cars.find(c=>c.index===pi)||e.field.cars[0]).vehicle;
    const c = v.circuit; const rows=[];
    for (let i=0;i<150;i++){ await A.renderFrame(i);
      const w = c.samples[c.sampleIndex(v.trackS)].width;
      rows.push([Math.abs(v.trackLateral), w]); }
    const q=(a,x)=>{const s=[...a].sort((m,n)=>m-n);return +s[(s.length*x)|0].toFixed(3);};
    return {shot, lat:[q(rows.map(r=>r[0]),0.1),q(rows.map(r=>r[0]),0.5),q(rows.map(r=>r[0]),0.9)],
      w:[q(rows.map(r=>r[1]),0.1),q(rows.map(r=>r[1]),0.5),q(rows.map(r=>r[1]),0.9)],
      margin:q(rows.map(r=>r[1]-r[0]),0.1)};
  }, shot);
  console.log(JSON.stringify(r));
}
await b.close();
