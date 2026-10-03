// A/B cascade parameters on one shot without reloading (so time-dependent rigs
// land on the same pose).  node tools/_shadowab.mjs --shot tv
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
const HOME = process.env.HOME;
const EXE = [`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const a = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const url = a('url', 'http://localhost:5420'), shot = a('shot', 'tv'), warm = +a('warm', 150);
const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 675 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });
const cdp = await page.context().newCDPSession(page);
mkdirSync('shots/ab', { recursive: true });
const variants = [
  ['base', {}],
  ['nobias', { bias: 0, normalBias: 0.003 }],
  ['bigradius', { radius: 3.0 }],
  ['nocull', { nocull: true }],
];
for (const [name, v] of variants) {
  const info = await page.evaluate(async ([s, v, warm]) => {
    const api = window.__APEX__, e = window.APEX_ENGINE, L = e.lighting;
    if (L.__origFit) { L._fitCascades = L.__origFit; delete L.__origFit; }
    api.pause(); await api.capture(s, 0);
    if (v.bias !== undefined || v.radius !== undefined) {
      L.__origFit = L._fitCascades;
      const fit = L._fitCascades.bind(L);
      L._fitCascades = function () {
        fit();
        for (const l of this.cascadeLights) {
          if (v.bias !== undefined) { l.shadow.bias = v.bias; l.shadow.normalBias = v.normalBias; }
          if (v.radius !== undefined) l.shadow.radius = v.radius;
        }
      };
    }
    for (let i = 0; i < warm; i++) { api.renderFrame(i); if (i % 10 === 0) await new Promise((r) => setTimeout(r, 0)); }
    if (v.nocull) { e.carLod.forceFull(e.field.cars); e.field.cars.forEach(c => c.model.group.traverse(o => { if (o.isMesh) o.castShadow = true; })); for (let i = 0; i < 3; i++) api.renderFrame(i); }
    const cam = e.camera, p = e.field.cars[0].model.group.position;
    return { d: +p.distanceTo(cam.position).toFixed(1), fov: +cam.fov.toFixed(2) };
  }, [shot, v, warm]);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`shots/ab/${shot}_${name}.png`, Buffer.from(data, 'base64'));
  console.log(`shots/ab/${shot}_${name}.png`, JSON.stringify(info));
}
await browser.close(); process.exit(0);
