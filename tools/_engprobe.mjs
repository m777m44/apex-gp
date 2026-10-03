import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME = process.env.HOME;
const EXE = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
const url = process.argv[2] || 'http://localhost:5610';
const shot = process.argv[3] || 'chase';
const b = await chromium.launch({ executablePath: EXE, headless:true, args:['--use-angle=metal','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport:{width:1600,height:900} });
p.on('pageerror', e => console.log('PAGEERR', e.message));
await p.goto(url, { waitUntil:'load', timeout:120000 });
await p.waitForFunction(() => window.__APEX__ && window.__APEX__.ready, null, { timeout:120000 });
await p.evaluate(async (s) => { window.__APEX__.pause(); await window.__APEX__.capture(s,0); for(let i=0;i<150;i++) window.__APEX__.renderFrame(i); }, shot);
const out = await p.evaluate(() => {
  const e = window.__APEX__.engine;
  return {
    stats: JSON.parse(JSON.stringify(e.stats)),
    fog: { color: e.scene.fog.color.getHexString(), density: e.scene.fog.density },
    exposure: e.renderer.toneMappingExposure,
    camera: { fov: e.camera.fov, pos: e.camera.position.toArray().map(v=>+v.toFixed(1)) },
    rigMode: e.rig.mode,
    shutter: e.postfx.settings.motionBlur ? JSON.parse(JSON.stringify(e.postfx.settings.motionBlur)) : null,
    dof: JSON.parse(JSON.stringify(e.postfx.settings.dof)),
    envIntensity: e.scene.environmentIntensity,
    lodTiers: e.carLod.tiers, offscreen: e.carLod.offscreen,
    sun: { el: e.sky.elevation, dir: e.sky.sunDirection.toArray().map(v=>+v.toFixed(3)) },
  };
});
console.log(JSON.stringify(out,null,1));
await b.close();
