#!/usr/bin/env node
/**
 * Diagnostic probe: captures a shot like tools/shot.mjs but ALSO reports
 * every console message (not just errors), pool occupancy, frame-time
 * measurements and a luminance histogram of the final framebuffer.
 *
 *   node tools/_probe.mjs --shot tv --url http://localhost:5310 [--w 1920 --h 1080]
 *                         [--eval "expr"] [--out shots/x.png] [--frames 200]
 */
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const HOME = process.env.HOME;
const EXECUTABLES = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  `${HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
function arg(n, d) {
  const i = process.argv.indexOf(`--${n}`);
  if (i === -1) return d;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}
const shot = arg('shot', 'chase');
const width = parseInt(arg('w', '1920'), 10);
const height = parseInt(arg('h', '1080'), 10);
const warm = parseInt(arg('warm', '150'), 10);
const frames = parseInt(arg('frames', '180'), 10);
const url = arg('url', 'http://localhost:5310');
const out = arg('out', null);
const expr = arg('eval', null);

const executablePath = EXECUTABLES.find((p) => existsSync(p));
const browser = await chromium.launch({
  executablePath, headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--enable-gpu-rasterization',
    '--disable-frame-rate-limit', '--hide-scrollbars', '--mute-audio'],
});
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${(e.stack ?? '').split('\n').slice(0, 4).join('\n')}`));

await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__APEX__ && window.__APEX__.ready === true, null, { timeout: 120000 });

const report = await page.evaluate(async ([shotName, warmFrames, perfFrames]) => {
  const api = window.__APEX__;
  const e = api.engine;
  api.pause();
  await api.capture(shotName, 0);
  for (let i = 0; i < warmFrames; i++) {
    api.renderFrame(i);
    if (i % 10 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  await api.settle();

  // ---- frame time: measure sim + render separately over perfFrames ----
  const sim = [], ren = [], tot = [];
  for (let i = 0; i < perfFrames; i++) {
    const t0 = performance.now();
    api.renderFrame(warmFrames + i);
    // force a GPU sync so renderMs is not just submission time
    e.renderer.getContext().finish?.();
    tot.push(performance.now() - t0);
    sim.push(e.stats.simMs); ren.push(e.stats.renderMs);
    if (i % 20 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  const med = (a) => { const b = a.slice().sort((x, y) => x - y); return b[b.length >> 1]; };
  const p95 = (a) => { const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length * 0.95)]; };

  // ---- read the framebuffer back and histogram it ----
  const gl = e.renderer.getContext();
  const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
  api.renderFrame(9999);
  const px = new Uint8Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let sum = 0, white = 0, near = 0, dark = 0;
  const lum = [];
  for (let i = 0; i < px.length; i += 4) {
    const l = (px[i] * 0.2126 + px[i + 1] * 0.7152 + px[i + 2] * 0.0722) / 255;
    sum += l; lum.push(l);
    if (l > 0.98) white++;
    if (l > 0.90) near++;
    if (l < 0.04) dark++;
  }
  lum.sort((a, b) => a - b);
  const n = lum.length;

  const pools = {};
  if (e.particles) {
    for (const k of ['smoke', 'dust', 'spray', 'spark', 'debris', 'haze', 'wind']) {
      const p = e.particles[k];
      if (p) pools[k] = `${p.alive ?? p.live ?? p.count ?? '?'}/${p.count ?? '?'}`;
    }
  }

  return {
    stats: { ...e.stats },
    frame: { totalMedian: med(tot), totalP95: p95(tot), simMedian: med(sim), renderMedian: med(ren) },
    image: {
      mean: sum / n,
      p01: lum[(n * 0.01) | 0], p10: lum[(n * 0.10) | 0], p50: lum[(n * 0.5) | 0],
      p90: lum[(n * 0.90) | 0], p99: lum[(n * 0.99) | 0], max: lum[n - 1],
      pctOver098: (white / n) * 100, pctOver090: (near / n) * 100, pctUnder004: (dark / n) * 100,
    },
    pools,
    weather: { state: e.weather?.state, wetness: e.weather?.wetness, rain: e.weather?.rain },
    exposure: e.renderer.toneMappingExposure,
    fog: e.scene.fog ? { density: e.scene.fog.density } : null,
    race: (() => { try { const s = e.session.snapshot(0); return { phase: e.session.phase, lap: s.lap, flag: e.session.flag, drs: e.session.drsEnabled }; } catch (err) { return String(err); } })(),
    extra: null,
  };
}, [shot, warm, frames]);

if (expr) {
  try { report.extra = await page.evaluate(`(()=>{const e=window.__APEX__.engine;return (${expr});})()`); }
  catch (err) { report.extra = 'EVAL ERROR: ' + err.message; }
}

if (out) {
  const cdp = await page.context().newCDPSession(page);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  await mkdir(dirname(resolve(out)), { recursive: true });
  await writeFile(resolve(out), Buffer.from(data, 'base64'));
}

console.log('SHOT', shot, `${width}x${height}`);
console.log(JSON.stringify(report, null, 2));
if (logs.length) { console.log('--- CONSOLE (' + logs.length + ') ---'); console.log(logs.slice(0, 60).join('\n')); }
else console.log('--- CONSOLE: clean ---');
await browser.close();
