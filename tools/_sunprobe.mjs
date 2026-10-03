// Sun azimuth vs camera/track heading per shot: are shadows pointing away from
// the lens (invisible) or across it (readable)?
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME = process.env.HOME;
const EXE = [`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const a = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const url = a('url', 'http://localhost:5420');
const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });
for (const shot of ['chase', 'cockpit', 'tv', 'beauty', 'wide', 'grid', 'wheel', 'front', 'hud']) {
  const r = await page.evaluate(async (s) => {
    const api = window.__APEX__; api.pause(); await api.capture(s, 0);
    for (let i = 0; i < 20; i++) api.renderFrame(i);
    const e = window.APEX_ENGINE, cam = e.camera, sun = e.sky.sunDirection;
    const fwd = new (cam.position.constructor)(); cam.getWorldDirection(fwd);
    const fh = Math.hypot(fwd.x, fwd.z);
    // horizontal sun bearing vs camera bearing: 0 = sun straight ahead (back-lit
    // subject, shadow toward lens), 180 = sun behind camera (shadow hidden).
    const dotH = (sun.x * fwd.x + sun.z * fwd.z) / Math.max(1e-4, fh);
    const crossH = (fwd.z * sun.x - fwd.x * sun.z) / Math.max(1e-4, fh);
    return {
      hour: +e.sky.timeOfDay.toFixed(2), el: +e.sky.elevation.toFixed(1),
      sunVsCamDeg: +(Math.atan2(crossH, dotH) * 180 / Math.PI).toFixed(0),
      shadowLenPerM: +(Math.sqrt(Math.max(0, 1 - sun.y * sun.y)) / Math.max(0.02, sun.y)).toFixed(2),
      exposure: +e.renderer.toneMappingExposure.toFixed(3),
    };
  }, shot);
  console.log(shot.padEnd(8), JSON.stringify(r));
}
await browser.close(); process.exit(0);
