#!/usr/bin/env node
/**
 * Reads the G-buffer VELOCITY texture for a staged shot and decomposes it, per
 * grid cell, into the pure-translation (radial from the focus of expansion)
 * component and the residual — which for a rigid camera is exactly the
 * rotational contribution (yaw swing, roll, shake).
 *
 *   node tools/_vel.mjs --shot chase --url http://localhost:5607 --grid 6
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
  const api = window.__APEX__; const eng = api.engine;
  api.pause();
  await api.capture(shotName, 0);
  for (let i = 0; i < 150; i++) api.renderFrame(i);

  const fx = eng.postfx, r = eng.renderer;
  const rt = fx.gbuffer;
  const W = rt.width, H = rt.height;
  const buf = new Float32Array(W * H * 4);
  // texture index 1 of the MRT = screen velocity, uv units
  r.readRenderTargetPixels(rt, 0, 0, W, H, buf, 1);

  const foe = fx.motionMat.uniforms.uRadialCentre.value;
  const cw = Math.floor(W / GRID), ch = Math.floor(H / GRID);
  const cells = [];
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      let n = 0, sumMag = 0, sumRad = 0, sumTan = 0, sumPx = 0;
      for (let y = gy * ch; y < (gy + 1) * ch; y += 3) {
        for (let x = gx * cw; x < (gx + 1) * cw; x += 3) {
          const i = ((H - 1 - y) * W + x) * 4;   // readPixels is bottom-up
          const vx = buf[i], vy = buf[i + 1];
          // to pixels
          const px = vx * W, py = vy * H;
          const u = x / W, v = 1 - y / H;
          let rx = u - foe.x, ry = v - foe.y;
          const rl = Math.hypot(rx, ry);
          if (rl < 1e-4) continue;
          rx /= rl; ry /= rl;
          // radial basis in pixels needs the same aspect handling: work in uv
          const radial = vx * rx + vy * ry;
          const tang = -vx * ry + vy * rx;
          sumRad += Math.abs(radial) * W; sumTan += Math.abs(tang) * W;
          sumMag += Math.hypot(px, py); sumPx += Math.hypot(px, py);
          n++;
        }
      }
      cells.push({ gx, gy, n, mag: sumMag / n, rad: sumRad / n, tan: sumTan / n });
    }
  }
  return { W, H, foe: foe.toArray(), cells, GRID };
}, { shotName: shot, GRID });

console.log(`velocity buffer ${out.W}x${out.H}  FOE uv=(${out.foe[0].toFixed(3)},${out.foe[1].toFixed(3)})`);
console.log('per cell: |v| px/frame, radial, tangential(=rotational contamination), tan%');
for (let gy = 0; gy < out.GRID; gy++) {
  const row = [];
  for (let gx = 0; gx < out.GRID; gx++) {
    const c = out.cells[gy * out.GRID + gx];
    const pct = c.mag > 1e-4 ? (c.tan / c.mag * 100) : 0;
    row.push(`${gx},${gy}:${c.mag.toFixed(1).padStart(6)}|${c.rad.toFixed(1).padStart(6)}|${c.tan.toFixed(1).padStart(5)}|${pct.toFixed(0).padStart(3)}%`);
  }
  console.log('  ' + row.join('  '));
}
await browser.close();
