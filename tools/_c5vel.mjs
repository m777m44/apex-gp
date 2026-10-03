#!/usr/bin/env node
/**
 * cameras.js diagnostic — decompose the G-buffer velocity field into the
 * pure-translation (radial from the focus of expansion) part and the residual,
 * which for a rigid camera is the ROTATIONAL contribution (follow-yaw swing,
 * roll, shake).  Also reports the camera's own per-frame rotation in pixels.
 *
 *   node tools/_c5vel.mjs --shot chase --url http://localhost:5607 --grid 6
 *
 * The g-buffer is HalfFloatType, so pixels come back as Uint16 and are decoded
 * here (tools/_vel.mjs read it into a Float32Array and got all zeros).
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
const GRID = parseInt(arg('grid', '6'), 10);

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });

const out = await page.evaluate(async ({ shotName, GRID }) => {
  const half = (h) => {
    const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, f = h & 0x3ff;
    if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
    if (e === 31) return f ? NaN : s * Infinity;
    return s * Math.pow(2, e - 15) * (1 + f / 1024);
  };
  const api = window.__APEX__; const eng = api.engine;
  api.pause();
  await api.capture(shotName, 0);

  // --- camera rigid motion over the last frames -----------------------------
  const rot = [];
  let prevQ = eng.camera.quaternion.clone(), prevP = eng.camera.position.clone();
  for (let i = 0; i < 150; i++) {
    api.renderFrame(i);
    if (i > 130) {
      const q = eng.camera.quaternion, p = eng.camera.position;
      const dq = prevQ.clone().invert().multiply(q);
      const ang = 2 * Math.acos(Math.min(1, Math.abs(dq.w)));
      // decompose into camera-local yaw/pitch/roll
      const e = new (Object.getPrototypeOf(eng.camera.rotation).constructor)().setFromQuaternion(dq, 'YXZ');
      if (i > 131) rot.push({ ang, yaw: e.y, pitch: e.x, roll: e.z, dpos: p.distanceTo(prevP) });
      prevQ = q.clone(); prevP = p.clone();
    }
  }

  const fx = eng.postfx, r = eng.renderer;
  const rt = fx.gbuffer;
  const W = rt.width, H = rt.height;
  const buf = new Uint16Array(W * H * 4);
  r.readRenderTargetPixels(rt, 0, 0, W, H, buf, 0, 1);

  const foe = fx.motionMat.uniforms.uRadialCentre.value;
  const cw = Math.floor(W / GRID), ch = Math.floor(H / GRID);
  const cells = [];
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      let n = 0, sumMag = 0, sumRad = 0, sumTan = 0, sx = 0, sy = 0;
      for (let y = gy * ch; y < (gy + 1) * ch; y += 3) {
        for (let x = gx * cw; x < (gx + 1) * cw; x += 3) {
          const i = ((H - 1 - y) * W + x) * 4;
          const vx = half(buf[i]) * W, vy = half(buf[i + 1]) * H;   // pixels
          if (!Number.isFinite(vx) || !Number.isFinite(vy)) continue;
          const u = x, v = H - y;
          let rx = u - foe.x * W, ry = v - foe.y * H;
          const rl = Math.hypot(rx, ry);
          if (rl < 1e-3) continue;
          rx /= rl; ry /= rl;
          const radial = vx * rx + vy * ry;
          const tang = -vx * ry + vy * rx;
          sumRad += Math.abs(radial); sumTan += Math.abs(tang);
          sumMag += Math.hypot(vx, vy);
          sx += vx; sy += vy;
          n++;
        }
      }
      cells.push({ gx, gy, n, mag: sumMag / n, rad: sumRad / n, tan: sumTan / n, mx: sx / n, my: sy / n });
    }
  }
  return { W, H, foe: foe.toArray(), cells, GRID, rot, fov: eng.camera.fov, mode: eng.rig.mode };
}, { shotName: shot, GRID });

const f = (out.H / 2) / Math.tan(out.fov * Math.PI / 360);   // px per radian at centre
console.log(`shot=${shot} mode=${out.mode} fov=${out.fov.toFixed(2)}  focal=${f.toFixed(0)} px/rad  FOE uv=(${out.foe[0].toFixed(3)},${out.foe[1].toFixed(3)})`);
const mean = (k) => out.rot.reduce((a, r) => a + Math.abs(r[k]), 0) / out.rot.length;
console.log(`camera per-frame motion (last 19 frames, |mean|): yaw ${(mean('yaw') * 1000).toFixed(2)} mrad = ${(mean('yaw') * f).toFixed(1)} px | pitch ${(mean('pitch') * f).toFixed(1)} px | roll ${(mean('roll') * 1000).toFixed(2)} mrad | dpos ${mean('dpos').toFixed(3)} m`);
console.log('per cell: |v| px/frame | radial | tangential(rotational) | tan%');
for (let gy = 0; gy < out.GRID; gy++) {
  const row = [];
  for (let gx = 0; gx < out.GRID; gx++) {
    const c = out.cells[gy * out.GRID + gx];
    const pct = c.mag > 1e-4 ? (c.tan / c.mag * 100) : 0;
    row.push(`${c.mag.toFixed(1).padStart(5)}|${c.rad.toFixed(1).padStart(5)}|${c.tan.toFixed(1).padStart(5)}|${pct.toFixed(0).padStart(3)}%`);
  }
  console.log('  ' + row.join(' '));
}
await browser.close();
