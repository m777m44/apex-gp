#!/usr/bin/env node
/**
 * Diagnostic probe: reports live shadow/lighting state for a given shot so we can
 * tell a broken shadow pass from a shot whose sun simply sits behind the camera.
 *
 *   node tools/probe.mjs --shot grid --url http://localhost:5173
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const HOME = process.env.HOME;
const EXE = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const shot = arg('shot', 'grid');
const url = arg('url', 'http://localhost:5173');

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));

await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });

const report = await page.evaluate(async (shotName) => {
  const api = window.__APEX__;
  api.pause();
  if (api.capture) await api.capture(shotName, 0);
  for (let i = 0; i < 60; i++) api.renderFrame(i);

  const eng = window.APEX_ENGINE;
  const r = eng?.renderer;
  const scene = eng?.scene;
  const out = {
    shadowMapEnabled: r?.shadowMap?.enabled ?? null,
    shadowMapType: r?.shadowMap?.type ?? null,
    toneMapping: r?.toneMapping ?? null,
    toneMappingExposure: r?.toneMappingExposure ?? null,
    lights: [],
    castCount: 0, receiveCount: 0, meshCount: 0, shadowSideDouble: 0,
    camera: null, sun: null,
  };
  const cam = eng?.rig?.camera ?? eng?.camera;
  if (cam) out.camera = { pos: cam.position.toArray().map((v) => +v.toFixed(1)), fov: cam.fov };

  scene?.traverse((o) => {
    if (o.isLight) {
      out.lights.push({
        type: o.type, intensity: +(o.intensity ?? 0).toFixed(3), castShadow: !!o.castShadow,
        pos: o.position ? o.position.toArray().map((v) => +v.toFixed(1)) : null,
        mapSize: o.shadow?.mapSize ? [o.shadow.mapSize.x, o.shadow.mapSize.y] : null,
      });
      if (o.isDirectionalLight && !out.sun) {
        const d = o.position.clone().normalize();
        out.sun = { dir: d.toArray().map((v) => +v.toFixed(3)), elevationDeg: +(Math.asin(d.y) * 180 / Math.PI).toFixed(1) };
      }
    }
    if (o.isMesh) {
      out.meshCount++;
      if (o.castShadow) out.castCount++;
      if (o.receiveShadow) out.receiveCount++;
      const m = Array.isArray(o.material) ? o.material[0] : o.material;
      if (m && m.shadowSide === 2) out.shadowSideDouble++;
    }
  });

  // Sample the framebuffer: if shadows exist there must be a population of dark
  // pixels on the ground plane, not just a single flat luminance.
  const c = r?.domElement;
  if (c) {
    const g = c.getContext('webgl2');
    const w = c.width, h = c.height;
    const px = new Uint8Array(w * h * 4);
    g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, px);
    // bottom third of frame = ground
    const lums = [];
    for (let y = 0; y < Math.floor(h / 3); y++) {
      for (let x = 0; x < w; x += 3) {
        const i = (y * w + x) * 4;
        lums.push(0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]);
      }
    }
    lums.sort((a, b) => a - b);
    const q = (p) => +lums[Math.floor(lums.length * p)].toFixed(1);
    out.groundLuma = { p01: q(0.01), p05: q(0.05), p25: q(0.25), p50: q(0.5), p75: q(0.75), p95: q(0.95) };
    out.groundContrastRatio = +(q(0.75) / Math.max(1, q(0.05))).toFixed(2);
  }
  return out;
}, shot);

console.log(JSON.stringify(report, null, 2));
await browser.close();
process.exit(0);
