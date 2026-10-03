import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME = process.env.HOME;
const EXE = [`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const b = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
await p.goto('http://localhost:5607', { waitUntil: 'load', timeout: 120000 });
await p.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });
console.log(JSON.stringify(await p.evaluate(async () => {
  const api = window.__APEX__; const eng = api.engine; api.pause();
  await api.capture('chase', 0); for (let i=0;i<150;i++) api.renderFrame(i);
  const u = eng.postfx.motionMat.uniforms;
  return { foe: u.uRadialCentre.value.toArray(), radial: u.uRadial.value, scale: u.uScale.value,
           maxFrac: u.uMaxPixelsFrac.value, radialMaxFrac: u.uRadialMaxFrac.value,
           near: u.uNearFactor.value, far: u.uFarFactor.value, fov: eng.camera.fov,
           mode: eng.rig.mode };
})));
await b.close();
