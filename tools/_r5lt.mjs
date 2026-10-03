#!/usr/bin/env node
/**
 * Lighting round-5 measurement rig.
 *
 * Measures the DIRECT:AMBIENT split on a real surface by capturing the same
 * staged frame twice, once with the key light at zero. Because the override is
 * applied AFTER `capture()` has staged the shot (capture() re-runs weather,
 * which rewrites lighting state), the lever is live — the mistake that made two
 * earlier sweeps report "identical" frames.
 *
 *   node tools/_r5lt.mjs --shot grid --patch 780,840,60,40 --url http://...
 *   node tools/_r5lt.mjs --shot chase --stats --set sunBoost=5.2,env=1.55
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const HOME = process.env.HOME;
const EXE = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const has = (n) => process.argv.includes(`--${n}`);
const shot = arg('shot', 'grid');
const url = arg('url', 'http://localhost:5606');
const patches = (arg('patch', '') || '').split(';').filter(Boolean).map((p) => p.split(',').map(Number));
const set = (arg('set', '') || '').split(',').filter(Boolean).map((kv) => kv.split('='));

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });

const out = await page.evaluate(async ({ shotName, patches, set }) => {
  const api = window.__APEX__;
  const eng = window.APEX_ENGINE;
  api.pause();
  await api.capture(shotName, 0);
  const L = eng.lighting;
  for (const [k, v] of set) {
    const n = parseFloat(v);
    if (k === 'sunBoost') L.sunBoost = n;
    else if (k === 'env') { L.baseEnvironmentIntensity = n; L.setEnvironmentIntensity(n); }
    else if (k === 'fill') L.fill.intensity = n;
    else if (k === 'aerial') L.aerialStrength = n;
    else if (k === 'bounce') L.bounceGain = n;
    else if (k === 'bias') L.exposureBias = n;
  }
  L._envDirty = true;
  L.syncToSky();
  for (let i = 0; i < 40; i++) api.renderFrame(i);
  await api.settle();
  for (let i = 0; i < 20; i++) api.renderFrame(i);

  const r = eng.renderer;
  const c = r.domElement;
  const g = c.getContext('webgl2');
  const W = c.width, H = c.height;
  const read = () => {
    const px = new Uint8Array(W * H * 4);
    g.readPixels(0, 0, W, H, g.RGBA, g.UNSIGNED_BYTE, px);
    return px;
  };
  const s2l = (v) => { const u = v / 255; return u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4); };
  const patchStats = (px, [x, y, w, h]) => {
    // readPixels origin is bottom-left; patches are given in image coords.
    let lr = 0, lg = 0, lb = 0, n = 0;
    for (let j = y; j < y + h; j++) {
      const yy = H - 1 - j;
      for (let i = x; i < x + w; i++) {
        const o = (yy * W + i) * 4;
        lr += s2l(px[o]); lg += s2l(px[o + 1]); lb += s2l(px[o + 2]); n++;
      }
    }
    return { r: lr / n, g: lg / n, b: lb / n, Y: (0.2126 * lr + 0.7152 * lg + 0.0722 * lb) / n };
  };
  const frameStats = (px) => {
    let below6 = 0, above192 = 0, sum = 0, n = 0;
    const hist = new Float64Array(256);
    for (let i = 0; i < W * H; i++) {
      const o = i * 4;
      const Y = 0.2126 * px[o] + 0.7152 * px[o + 1] + 0.0722 * px[o + 2];
      if (Y < 6) below6++;
      if (Y > 192) above192++;
      sum += Y; n++;
      hist[Math.min(255, Math.round(Y))]++;
    }
    let acc = 0, p99 = 255;
    for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= n * 0.99) { p99 = i; break; } }
    return { meanY: +(sum / n).toFixed(2), pctBelow6: +(100 * below6 / n).toFixed(3), pctAbove192: +(100 * above192 / n).toFixed(3), p99 };
  };

  const px1 = read();
  const lit = patches.map((p) => patchStats(px1, p));
  const frame = frameStats(px1);

  // Ambient-only pass: kill the key, keep everything else.
  const keep = L.cascadeLights.map((l) => l.intensity);
  for (const l of L.cascadeLights) l.intensity = 0;
  L._lastApplied = 0;
  const applyKey = L._applyKeyIntensity.bind(L);
  L._applyKeyIntensity = () => { for (const l of L.cascadeLights) l.intensity = 0; };
  for (let i = 0; i < 8; i++) api.renderFrame(i);
  const px2 = read();
  const amb = patches.map((p) => patchStats(px2, p));
  L._applyKeyIntensity = applyKey;
  L.cascadeLights.forEach((l, i) => { l.intensity = keep[i]; });

  return {
    exposure: +r.toneMappingExposure.toFixed(4),
    sunBoost: L.sunBoost, env: +L.environmentIntensity.toFixed(3), fill: +L.fill.intensity.toFixed(4),
    keyIntensity: +(L.keyIntensity ?? 0).toFixed(3), ev100: +(L.ev100 ?? 0).toFixed(3),
    frame,
    patches: patches.map((p, i) => ({
      patch: p.join(','),
      litY: +lit[i].Y.toFixed(5), ambY: +amb[i].Y.toFixed(5),
      ratio: +(lit[i].Y / Math.max(amb[i].Y, 1e-6)).toFixed(2),
      directOverAmbient: +((lit[i].Y - amb[i].Y) / Math.max(amb[i].Y, 1e-6)).toFixed(2),
      litSRGB: +(255 * Math.pow(lit[i].Y, 1 / 2.2)).toFixed(1),
      ambSRGB: +(255 * Math.pow(amb[i].Y, 1 / 2.2)).toFixed(1),
    })),
  };
}, { shotName: shot, patches, set });

console.log(JSON.stringify(out, null, 1));
await browser.close();
