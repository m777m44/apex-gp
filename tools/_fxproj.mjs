// Project live ego-car sparks to screen space; report count, px size, view depth.
import { chromium } from 'playwright-core';
const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const a = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const port = a('port', '5509'), frames = +a('frames', 150);
const shots = a('shots', 'hud,chase').split(',');
const b = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
p.on('pageerror', e => console.log('PAGEERR', e.message));
await p.goto(`http://localhost:${port}/?ui=0`, { waitUntil: 'load' });
await p.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });
for (const shot of shots) {
  const out = await p.evaluate(async ([shot, frames]) => {
    const A = window.__APEX__;
    A.pause();
    await A.capture(shot, 0);
    const e = A.engine;
    const fx = e.particles;
    const pi = e.field.playerIndex ?? 0;
    const sp = fx.spark;
    // tag spawns by car
    let cur = -1;
    const dfc = fx.driveFromCar.bind(fx);
    fx.driveFromCar = (car, dt, w) => { cur = car.index; const r = dfc(car, dt, w); cur = -1; return r; };
    const owner = new Int8Array(sp.count).fill(-1);
    const sw = sp.spawn.bind(sp);
    sp.spawn = (pos, vel, o) => { const before = sp.cursor; const r = sw(pos, vel, o); owner[before % sp.count] = cur; return r; };
    for (let i = 0; i < frames; i++) await A.renderFrame(i);
    const cam = e.camera;
    const W = e.renderer.domElement.width, H = e.renderer.domElement.height;
    const pxScale = H / (2 * Math.tan(cam.fov * Math.PI / 360));
    const rows = [];
    let ego = 0, egoOnScreen = 0, all = 0;
    for (let j = 0; j < sp.count; j++) {
      if (sp.life[j] >= 1) continue;
      all++;
      const isEgo = owner[j] === pi;
      if (isEgo) ego++;
      const px3 = sp.pos[j * 3], py3 = sp.pos[j * 3 + 1], pz3 = sp.pos[j * 3 + 2];
      const xf = (m, x, y, z) => [
        m[0] * x + m[4] * y + m[8] * z + m[12],
        m[1] * x + m[5] * y + m[9] * z + m[13],
        m[2] * x + m[6] * y + m[10] * z + m[14],
        m[3] * x + m[7] * y + m[11] * z + m[15]];
      const vw = xf(cam.matrixWorldInverse.elements, px3, py3, pz3);
      const z = -vw[2];
      if (z <= 0.1) continue;
      const cl = xf(cam.projectionMatrix.elements, vw[0], vw[1], vw[2]);
      const sx = (cl[0] / cl[3] * 0.5 + 0.5) * W, sy = (0.5 - cl[1] / cl[3] * 0.5) * H;
      const on = sx >= 0 && sx < W && sy >= 0 && sy < H;
      if (isEgo && on) {
        egoOnScreen++;
        rows.push({ x: sx | 0, y: sy | 0, z: +z.toFixed(2), sz: +(sp.size[j] * pxScale / z).toFixed(1), life: +sp.life[j].toFixed(2) });
      }
    }
    return { shot, fov: cam.fov, all, ego, egoOnScreen, sample: rows.slice(0, 20),
      bbox: rows.length ? [Math.min(...rows.map(r => r.x)), Math.min(...rows.map(r => r.y)), Math.max(...rows.map(r => r.x)), Math.max(...rows.map(r => r.y))] : null };
  }, [shot, frames]);
  console.log(JSON.stringify(out));
}
await b.close();
