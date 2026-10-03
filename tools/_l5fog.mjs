#!/usr/bin/env node
/** Is the aerial-perspective fog term actually reaching materials? */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME = process.env.HOME;
const EXE = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const url = arg('url', 'http://localhost:5606');
const shot = arg('shot', 'wide');
const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });
const out = await page.evaluate(async (shotName) => {
  const api = window.__APEX__; const eng = window.APEX_ENGINE;
  api.pause(); await api.capture(shotName, 0);
  for (let i = 0; i < 6; i++) api.renderFrame(i);
  const scene = eng.scene;
  const fog = scene.fog ? { type: scene.fog.type ?? scene.fog.constructor.name, density: scene.fog.density, color: scene.fog.color.getHexString() } : null;
  let withFog = 0, noFog = 0; const noFogNames = [];
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of ms) {
      if (!m) continue;
      if (m.fog) withFog++; else { noFog++; if (noFogNames.length < 25) noFogNames.push(`${o.name || o.type}:${m.type}`); }
    }
  });
  // Programs actually compiled with the uniform, and its live value.
  const progs = [];
  for (const p of eng.renderer.info.programs ?? []) {
    let keys = [];
    try { keys = Object.keys(p.getUniforms().map || {}); } catch { /* */ }
    progs.push({
      id: p.id, n: p.usedTimes,
      hasAerialUniform: keys.includes('apexAerialParams'),
      hasFogDensity: keys.includes('fogDensity'),
      cacheKeyFog: !!(p.cacheKey && /fog/i.test(p.cacheKey)),
    });
  }
  const L = eng.lighting;
  L.aerialStrength = 4;
  for (let i = 0; i < 4; i++) api.renderFrame(i);
  const caches = [];
  for (const p of eng.renderer.info.programs ?? []) {
    let m; try { m = p.getUniforms().map; } catch { continue; }
    if (!m || !m.apexAerialParams) continue;
    const c = Array.from(m.apexAerialParams.cache || []);
    if (!c.length) continue;
    caches.push({ id: p.id, used: p.usedTimes, params: c, fogDensity: (m.fogDensity && m.fogDensity.cache) ? Array.from(m.fogDensity.cache) : null });
    if (caches.length >= 6) break;
  }
  return {
    uniformCaches: caches,
    fog,
    withFog, noFog, noFogNames,
    aerialParams: Array.from(window.__APEX_AERIAL__ ?? []),
    lightingAerial: { strength: L.aerialStrength, h: L.aerialHeightScale, glow: L.aerialSunGlow },
    programCount: progs.length,
    withAerialUniform: progs.filter((p) => p.hasAerialUniform).length,
    withFogDensity: progs.filter((p) => p.hasFogDensity).length,
    cacheKeyFog: progs.filter((p) => p.cacheKeyFog).length,
    fogChunkHead: (window.__THREE_CHUNK_FOG__ || '').slice(0, 120),
  };
}, shot);
console.log(JSON.stringify(out, null, 1));
await browser.close();
