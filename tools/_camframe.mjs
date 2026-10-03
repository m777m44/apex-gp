// Measure the player car's projected screen box for a given shot.
// node tools/_camframe.mjs --shot chase --url http://localhost:5507 [--warm 150]
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME = process.env.HOME;
const EXE = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  `${HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const url = arg('url', 'http://localhost:5507');
const shot = arg('shot', 'chase');
const warm = parseInt(arg('warm', '150'), 10);
const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--hide-scrollbars'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 180000 });
await page.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 180000 });
const r = await page.evaluate(async ({ shot, warm }) => {
  const api = window.__APEX__; api.pause();
  await api.capture(shot, 0);
  for (let i = 0; i < warm; i++) api.renderFrame(i);
  const THREE = window.__THREE__ || null;
  const e = api.engine;
  const cam = e.camera;
  cam.updateMatrixWorld(true);
  const car = e.field.cars[0];
  const g = car.model.group;
  g.updateMatrixWorld(true);
  // Analytic car box in CAR-LOCAL space (CONTRACT §0): x +-1.00, y 0..1.05,
  // z -3.00..+2.45. Per-mesh geometry boxes lie (merged buckets + wheel groups).
  let minx = 9, maxx = -9, miny = 9, maxy = -9;
  const V = g.position.constructor;
  const v = new V();
  let groundY = 9;
  for (let i = 0; i < 8; i++) {
    v.set(i & 1 ? 1.00 : -1.00, i & 2 ? 1.05 : 0.0, i & 4 ? 2.45 : -3.00);
    g.localToWorld(v);
    v.project(cam);
    minx = Math.min(minx, v.x); maxx = Math.max(maxx, v.x);
    miny = Math.min(miny, v.y); maxy = Math.max(maxy, v.y);
    if ((i & 2) === 0 && (i & 4)) groundY = Math.min(groundY, v.y);
  }
  const toX = (x) => (x * 0.5 + 0.5);
  const toY = (y) => (0.5 - y * 0.5);   // fraction from TOP
  // horizon: where a point at infinity along the view's horizontal projects
  const fwd = new (g.position.constructor)(0, 0, -1).applyQuaternion(cam.quaternion);
  fwd.y = 0; fwd.normalize();
  const hp = new (g.position.constructor)().copy(cam.position).addScaledVector(fwd, 5000);
  hp.project(cam);
  return {
    mode: e.rig.mode, fov: cam.fov, focus: e.rig.focusDistance,
    camPos: cam.position.toArray().map((n) => +n.toFixed(2)),
    carPos: car.model.group.position.toArray().map((n) => +n.toFixed(2)),
    dist: +cam.position.distanceTo(car.model.group.position).toFixed(2),
    speed: +(car.vehicle.telemetry.speed).toFixed(1),
    boxX: [+toX(minx).toFixed(3), +toX(maxx).toFixed(3)],
    boxY: [+toY(maxy).toFixed(3), +toY(miny).toFixed(3)],
    widthFrac: +((maxx - minx) * 0.5).toFixed(3),
    heightFrac: +((maxy - miny) * 0.5).toFixed(3),
    centreY: +toY((miny + maxy) * 0.5).toFixed(3),
    centreX: +toX((minx + maxx) * 0.5).toFixed(3),
    horizonY: +toY(hp.y).toFixed(3),
    groundLineY: +toY(groundY).toFixed(3),
  };
}, { shot, warm });
console.log(JSON.stringify(r, null, 1));
await browser.close(); process.exit(0);
