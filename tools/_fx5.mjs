#!/usr/bin/env node
/**
 * Round-5 fx spark harness.
 *
 *   node tools/_fx5.mjs --shot hud --url http://localhost:5609 [--stats] [--out shots/x.png]
 *
 * Stages a shot exactly as tools/shot.mjs does, then reports live spark-pool
 * statistics (alive count, projected radius in px, streak length in px) so the
 * shower can be tuned against numbers instead of guesses.
 */
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const HOME = process.env.HOME;
const EXE = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };

const shot = arg('shot', 'hud');
const url = arg('url', 'http://localhost:5609');
const W = parseInt(arg('w', '1600'), 10);
const H = parseInt(arg('h', '900'), 10);
const warm = parseInt(arg('warm', '150'), 10);
const out = arg('out', null);

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text()); });

await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });

const js = arg('js', '');

await page.evaluate(async ([shotName, frames, code]) => {
  const api = window.__APEX__;
  api.pause();
  await api.capture(shotName, 0);
  if (code) {
    const eng = api.engine;
    const P = eng.particles;
    const S = P.spark;
    const U = S.material.uniforms;
    // eslint-disable-next-line no-new-func
    new Function('eng', 'P', 'S', 'U', 'THREE', code)(eng, P, S, U, window.THREE);
  }
  for (let i = 0; i < frames; i++) {
    api.renderFrame(i);
    if (i % 10 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  if (api.settle) await api.settle();
  api.renderFrame(frames);
}, [shot, warm, js]);

const res = await page.evaluate(() => {
  const api = window.__APEX__;
  const eng = api.engine;
  const P = eng.particles;
  const pool = P.spark;
  const cam = eng.camera;
  const u = pool.material.uniforms;
  const pixelScale = u.uPixelScale.value;
  const stretch = u.uStretch.value;
  const maxStreak = u.uMaxStreak.value;
  const camVel = u.uCamVel.value;
  const halfRes = u.uHalfRes.value;

  const proj = cam.projectionMatrix;
  const mv = new (cam.matrixWorldInverse.constructor)();
  mv.copy(cam.matrixWorldInverse);

  let alive = 0;
  const rad = [], len = [], lifes = [], onScreen = [];
  const V = eng.particles.constructor;
  const tmp = { x: 0, y: 0, z: 0 };
  for (let i = 0; i < pool.count; i++) {
    if (pool.life[i] >= 1) continue;
    alive++;
    const i3 = i * 3;
    // view-space z
    const e = mv.elements;
    const x = pool.pos[i3], y = pool.pos[i3 + 1], z = pool.pos[i3 + 2];
    const vz = e[2] * x + e[6] * y + e[10] * z + e[14];
    const vx = e[0] * x + e[4] * y + e[8] * z + e[12];
    const vy = e[1] * x + e[5] * y + e[9] * z + e[13];
    const dist = Math.max(-vz, 0.35);
    if (-vz <= 0.3) continue;
    const px = pool.size[i] * pixelScale / dist;
    // streak
    const sv = [pool.vel[i3] - camVel.x, pool.vel[i3 + 1] - camVel.y, pool.vel[i3 + 2] - camVel.z];
    const p = proj.elements;
    const projPt = (ax, ay, az) => {
      const cw = p[3] * ax + p[7] * ay + p[11] * az + p[15];
      const cx = p[0] * ax + p[4] * ay + p[8] * az + p[12];
      const cy = p[1] * ax + p[5] * ay + p[9] * az + p[13];
      return [cx / Math.max(cw, 1e-4) * halfRes.x, cy / Math.max(cw, 1e-4) * halfRes.y];
    };
    const eh = mv.elements;
    const tx = x - sv[0] * stretch, ty = y - sv[1] * stretch, tz = z - sv[2] * stretch;
    const tvz = eh[2] * tx + eh[6] * ty + eh[10] * tz + eh[14];
    const tvx = eh[0] * tx + eh[4] * ty + eh[8] * tz + eh[12];
    const tvy = eh[1] * tx + eh[5] * ty + eh[9] * tz + eh[13];
    const A = projPt(vx, vy, vz), B = projPt(tvx, tvy, tvz);
    const L = Math.min(Math.hypot(A[0] - B[0], A[1] - B[1]), maxStreak);
    rad.push(px); len.push(L); lifes.push(pool.life[i]);
    // on screen?
    if (Math.abs(A[0]) < halfRes.x && Math.abs(A[1]) < halfRes.y) onScreen.push([px, L]);
  }
  const q = (a, f) => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(f * (s.length - 1))]; };
  const mean = (a) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0;
  return {
    carPos: [eng.field.cars[0].position.x, eng.field.cars[0].position.y, eng.field.cars[0].position.z],
    camPos: [cam.position.x, cam.position.y, cam.position.z],
    exposure: eng.lighting?.exposure ?? null,
    poolCount: pool.count, alive,
    onScreen: onScreen.length,
    radPx: { mean: mean(rad), p10: q(rad, 0.1), p50: q(rad, 0.5), p90: q(rad, 0.9), max: q(rad, 1) },
    streakPx: { mean: mean(len), p50: q(len, 0.5), p90: q(len, 0.9), max: q(len, 1) },
    pixelScale, stretch, maxStreak,
    camVel: [camVel.x, camVel.y, camVel.z],
    glow: eng.particles._glow
      ? eng.particles._glow.slots.map((m) => ({ vis: m.visible, i: m.material.uniforms.uIntensity.value }))
      : null,
  };
});

console.log(JSON.stringify(res, null, 1));

if (out) {
  const cdp = await page.context().newCDPSession(page);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const abs = resolve(out);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, Buffer.from(data, 'base64'));
  console.log('WROTE', abs);
}
await browser.close();
