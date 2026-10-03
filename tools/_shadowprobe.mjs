// Cascade diagnosis: dump cascade fits + shadow-map occupancy for a shot.
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME = process.env.HOME;
const EXE = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const shot = arg('shot', 'grid');
const url = arg('url', 'http://localhost:5420');
const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') console.error(`[${m.type()}]`, m.text()); });
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });
const rep = await page.evaluate(async (s) => {
  const api = window.__APEX__; api.pause(); await api.capture(s, 0);
  for (let i = 0; i < 40; i++) api.renderFrame(i);
  const e = window.APEX_ENGINE, L = e.lighting, cam = e.camera;
  const out = { splits: Array.from(L._splits), cascades: [], cars: [], camPos: cam.position.toArray().map(v => +v.toFixed(1)), fov: cam.fov };
  for (let i = 0; i < L.cascadeLights.length; i++) {
    const l = L.cascadeLights[i], c = l.shadow.camera;
    out.cascades.push({
      i, radius: +c.right.toFixed(1), near: c.near, far: +c.far.toFixed(1),
      pos: l.position.toArray().map(v => +v.toFixed(1)),
      target: l.target.position.toArray().map(v => +v.toFixed(1)),
      normalBias: +l.shadow.normalBias.toFixed(4), bias: l.shadow.bias.toExponential(2),
      mapSize: l.shadow.mapSize.x, hasMap: !!l.shadow.map,
      intensity: +l.intensity.toFixed(2), shadowIntensity: l.shadow.intensity,
    });
  }
  // per-car: distance, tier, caster count actually flagged
  for (const car of e.field.cars.slice(0, 6)) {
    const g = car.model.group;
    let casters = 0, visible = 0;
    g.traverse((o) => { if (o.isMesh) { if (o.castShadow) casters++; if (o.visible) visible++; } });
    out.cars.push({ d: +g.position.distanceTo(cam.position).toFixed(1), tier: car.model.__lodTier, casters, visible, groupVisible: g.visible });
  }
  // Which cascade box actually contains car 0?
  const p = e.field.cars[0].model.group.position;
  out.carInBox = L.cascadeLights.map((l) => +p.distanceTo(l.target.position).toFixed(1) + '/' + l.shadow.camera.right.toFixed(1));
  return out;
}, shot);
console.log(JSON.stringify(rep, null, 2));
await browser.close(); process.exit(0);
