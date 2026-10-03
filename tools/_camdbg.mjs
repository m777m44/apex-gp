#!/usr/bin/env node
/**
 * Camera-owned diagnostic: how much of the chase frame's screen velocity is
 * ROTATION (yaw swing + shake) versus TRANSLATION (the thing that radiates from
 * the focus of expansion).  Reports, per frame and per probe point, the two
 * contributions in pixels.
 *
 *   node tools/_camdbg.mjs --shot chase --url http://localhost:5607
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const HOME = process.env.HOME;
const EXE = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const shot = arg('shot', 'chase');
const url = arg('url', 'http://localhost:5607');
const frames = parseInt(arg('frames', '150'), 10);

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });

const out = await page.evaluate(async ({ shotName, frames }) => {
  const api = window.__APEX__;
  const eng = api.engine;
  api.pause();
  if (api.capture) await api.capture(shotName, 0);
  const cam = eng.camera;
  const rig = eng.rig;
  const THREE = window.THREE_NS || null;

  const rec = [];
  let prevQ = cam.quaternion.clone();
  let prevP = cam.position.clone();
  let prevVP = cam.projectionMatrix.clone().multiply(cam.matrixWorldInverse.clone());

  for (let i = 0; i < frames; i++) {
    api.renderFrame(i);
    cam.updateMatrixWorld(true);
    // relative rotation prev -> now, in the camera's own frame
    const dq = prevQ.clone().invert().multiply(cam.quaternion);
    const e = new (dq.constructor === Object ? Object : Object)();
    // extract yaw/pitch/roll from dq by rotating the basis
    const f0 = { x: 0, y: 0, z: -1 };
    const v = new cam.position.constructor(0, 0, -1).applyQuaternion(dq);
    const yaw = Math.atan2(-v.x, -v.z);
    const pitch = Math.asin(Math.max(-1, Math.min(1, v.y)));
    const rv = new cam.position.constructor(1, 0, 0).applyQuaternion(dq);
    const roll = Math.atan2(rv.y, rv.x);
    const dp = cam.position.clone().sub(prevP);

    // the car's own yaw rate — the part of the pan that is physically required
    const t = rig.target;
    const cf = new cam.position.constructor(0, 0, -1).applyQuaternion(t.quaternion);
    const carYaw = Math.atan2(-cf.x, -cf.z);
    let dCar = carYaw - (window.__prevCarYaw ?? carYaw);
    while (dCar > Math.PI) dCar -= 2 * Math.PI;
    while (dCar < -Math.PI) dCar += 2 * Math.PI;
    window.__prevCarYaw = carYaw;

    if (i > 4) {
      // pixels of screen shift from pure rotation, at frame centre
      const h = 900, w = 1600;
      const tanV = Math.tan(cam.fov * Math.PI / 360);
      const pxPerRad = h / (2 * tanV);
      rec.push({
        i,
        fov: +cam.fov.toFixed(2),
        yawPx: +(yaw * pxPerRad).toFixed(2),
        carYawPx: +(dCar * pxPerRad).toFixed(2),
        excessPx: +((yaw - dCar) * pxPerRad).toFixed(2),
        pitchPx: +(pitch * pxPerRad).toFixed(2),
        rollPx: +(roll * (w / 2)).toFixed(2),   // roll at the frame edge
        transM: +dp.length().toFixed(3),
        speed: +(rig.velocity ? rig.velocity.length() : 0).toFixed(1),
        roadShake: +rig.roadShake.toFixed(3),
        shake: +rig.shake.toFixed(3),
      });
    }
    prevQ.copy(cam.quaternion);
    prevP.copy(cam.position);
  }

  // Only the frames the harness actually photographs (warm = 150).
  const win = rec.filter((r) => r.i >= 90);
  const stat = (k, src = win) => {
    const a = src.map((r) => r[k]);
    const mean = a.reduce((s, x) => s + Math.abs(x), 0) / a.length;
    // frame-to-frame jitter: how much of the signal is NOT a smooth pan
    let jit = 0;
    for (let i = 1; i < a.length; i++) jit += Math.abs(a[i] - a[i - 1]);
    jit /= Math.max(1, a.length - 1);
    return { mean: +mean.toFixed(2), max: +Math.max(...a.map(Math.abs)).toFixed(2), jitter: +jit.toFixed(3) };
  };
  return {
    n: win.length,
    fov: rec[rec.length - 1].fov,
    yawPx: stat('yawPx'), carYawPx: stat('carYawPx'), excessPx: stat('excessPx'),
    pitchPx: stat('pitchPx'), rollPx: stat('rollPx'),
    transM: stat('transM'),
    roadShake: stat('roadShake'), shake: stat('shake'),
    allYawPx: stat('yawPx', rec),
  };
}, { shotName: shot, frames });

console.log(JSON.stringify(out, null, 1));
await browser.close();
