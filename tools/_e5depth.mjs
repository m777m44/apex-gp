#!/usr/bin/env node
/**
 * ENGINE diagnostic — what is actually AT each part of the frame, and how far.
 *
 * Stages a shot exactly like tools/shot.mjs, then raycasts the live scene
 * through a list of NDC points and reports the hit object name + distance.
 * That is the ground truth the aerial-perspective (fog) curve has to be tuned
 * against: "the treeline is 340 m away" is a number, "the far field looks flat"
 * is not.
 *
 *   node tools/_e5depth.mjs --shot chase --pts "0.2,0.62 -0.6,0.60" --url ...
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const HOME = process.env.HOME;
const EXECUTABLES = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  `${HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
const arg = (n, d) => {
  const i = process.argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
};

const shot = arg('shot', 'chase');
const url = arg('url', 'http://localhost:5610');
const warm = parseInt(arg('warm', '90'), 10);
// Screen points as "x,y" pairs in PIXELS of a 1600x900 frame.
const pts = String(arg('pts', '800,300 300,250 1250,150 800,700'))
  .split(/\s+/).map((p) => p.split(',').map(Number));

const executablePath = EXECUTABLES.find((p) => existsSync(p));
const browser = await chromium.launch({ executablePath, headless: true, args: ['--use-angle=metal', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
// Another specialist editing a file mid-run makes vite HMR reload the page and
// the evaluate() below dies with "execution context destroyed". Stop the HMR
// socket from ever connecting; nothing in a capture needs it.
await page.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (protocols === 'vite-hmr' || String(url).includes('vite')) {
      return { addEventListener() {}, removeEventListener() {}, send() {}, close() {}, readyState: 3 };
    }
    return new RealWS(url, protocols);
  };
});
page.on('pageerror', (e) => console.error('[pageerror]', e.message));

await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__APEX__ && window.__APEX__.ready === true, null, { timeout: 120000 });

const res = await page.evaluate(async ([shotName, frames, points]) => {
  const api = window.__APEX__;
  api.pause();
  await api.capture(shotName, 0);
  for (let i = 0; i < frames; i++) { api.renderFrame(i); if (i % 10 === 0) await new Promise((r) => setTimeout(r, 0)); }
  api.renderFrame(frames);
  const eng = api.engine;
  const THREE = api.THREE;
  const cam = eng.camera;
  const rc = new THREE.Raycaster();
  rc.far = 20000;
  const out = [];
  for (const [px, py] of points) {
    const ndc = new THREE.Vector2((px / 1600) * 2 - 1, -((py / 900) * 2 - 1));
    rc.setFromCamera(ndc, cam);
    const hits = [];
    eng.scene.traverseVisible((o) => {
      if (!o.isMesh && !o.isInstancedMesh) return;
      if (!o.geometry || !o.geometry.attributes || !o.geometry.attributes.position) return;
      if (o.userData && o.userData.excludeFromGBuffer) return;
      if (o.material && o.material.transparent) return;
      try { o.raycast(rc, hits); } catch { /* exotic geometry */ }
    });
    hits.sort((a, b) => a.distance - b.distance);
    const h = hits.find((x) => x.distance > 0.1);
    out.push({
      px, py,
      dist: h ? +h.distance.toFixed(1) : null,
      name: h ? (h.object.name || h.object.parent?.name || '?') : 'sky',
      y: h ? +h.point.y.toFixed(1) : null,
    });
  }
  return {
    fogDensity: eng.scene.fog ? eng.scene.fog.density : null,
    fogColour: eng.scene.fog ? eng.scene.fog.color.toArray().map((v) => +v.toFixed(3)) : null,
    aerialStrength: eng.lighting.aerialStrength,
    aerialHeight: eng.lighting.aerialHeightScale,
    exposure: eng.renderer.toneMappingExposure,
    camY: +eng.camera.position.y.toFixed(2),
    fov: eng.camera.fov,
    hits: out,
  };
}, [shot, warm, pts]);

console.log(JSON.stringify(res, null, 1));
await browser.close();
