import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME = process.env.HOME;
const EXE = [`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const b = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.goto('http://localhost:5507', { waitUntil: 'load', timeout: 180000 });
await p.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 180000 });
console.log(await p.evaluate(async () => {
  const api = window.__APEX__; api.pause(); await api.capture('chase', 0);
  for (let i = 0; i < 150; i++) api.renderFrame(i);
  const e = api.engine, cam = e.camera; cam.updateMatrixWorld(true);
  const g = e.field.cars[0].model.group; g.updateMatrixWorld(true);
  const out = [];
  const V = g.position.constructor;
  const v = new V();
  g.traverse((n) => {
    if (!n.isMesh || !n.visible) return;
    n.geometry.computeBoundingBox();
    const bb = n.geometry.boundingBox;
    let mnx=9,mxx=-9,mny=9,mxy=-9;
    for (let i=0;i<8;i++){ v.set(i&1?bb.max.x:bb.min.x,i&2?bb.max.y:bb.min.y,i&4?bb.max.z:bb.min.z); n.localToWorld(v); v.project(cam);
      mnx=Math.min(mnx,v.x);mxx=Math.max(mxx,v.x);mny=Math.min(mny,v.y);mxy=Math.max(mxy,v.y); }
    out.push(`${n.name||n.material?.name||'?'} x[${mnx.toFixed(2)},${mxx.toFixed(2)}] y[${mny.toFixed(2)},${mxy.toFixed(2)}]`);
  });
  return out.join('\n');
}));
await b.close(); process.exit(0);
