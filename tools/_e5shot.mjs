#!/usr/bin/env node
/**
 * tools/shot.mjs + an HMR guard (ENGINE). Byte-identical capture flow.
 *
 * Deterministic screenshot harness for the APEX GP renderer.
 *
 * Usage:
 *   node tools/shot.mjs --out shots/foo.png [--shot cockpit] [--w 1920] [--h 1080]
 *                       [--warm 90] [--url http://localhost:5173] [--headed]
 *
 * The page is expected to expose window.__APEX__ with:
 *   ready: boolean                 — set true once assets/env are loaded
 *   pause()                        — halt the rAF loop so frames are driven manually
 *   capture(shotName, frameIndex)  — optional; place camera/sim in a deterministic pose
 *   renderFrame(frameIndex)        — advance the sim by a fixed dt and render one frame
 */
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const HOME = process.env.HOME;
const EXECUTABLES = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  `${HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : true;
}

const out = resolve(arg('out', 'shots/shot.png'));
const shot = arg('shot', 'default');
const width = parseInt(arg('w', '1920'), 10);
const height = parseInt(arg('h', '1080'), 10);
const warm = parseInt(arg('warm', '90'), 10);
const url = arg('url', 'http://localhost:5173');
const headed = !!arg('headed', false);
const timeout = parseInt(arg('timeout', '120000'), 10);

const { existsSync } = await import('node:fs');
const executablePath = EXECUTABLES.find((p) => existsSync(p));
if (!executablePath) {
  console.error('No Chromium found. Checked:\n' + EXECUTABLES.join('\n'));
  process.exit(2);
}

const browser = await chromium.launch({
  executablePath,
  headless: !headed,
  args: [
    '--use-angle=metal',
    '--enable-unsafe-webgpu',
    '--ignore-gpu-blocklist',
    '--enable-gpu-rasterization',
    '--enable-webgl-draft-extensions',
    '--disable-frame-rate-limit',
    '--hide-scrollbars',
    '--mute-audio',
  ],
});

const page = await browser.newPage({
  viewport: { width, height },
  deviceScaleFactor: 1,
});

// HMR GUARD. Fifteen specialists share this tree; the moment one of them saves
// a file, vite reloads every open page and a capture in flight dies with
// "execution context destroyed" (or, worse, screenshots a half-booted world).
// Nothing in a capture needs the HMR socket, so never let it connect.
await page.addInitScript(() => {
  const RealWS = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (protocols === 'vite-hmr' || String(url).includes('vite')) {
      return { addEventListener() {}, removeEventListener() {}, send() {}, close() {}, readyState: 3 };
    }
    return new RealWS(url, protocols);
  };
});

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));

let failed = false;
try {
  await page.goto(url, { waitUntil: 'load', timeout });
  await page.waitForFunction(() => window.__APEX__ && window.__APEX__.ready === true, null, { timeout });

  // Deterministic warm-up: drive the sim frame-by-frame at a fixed dt so the
  // screenshot is reproducible regardless of machine speed.
  await page.evaluate(
    async ([shotName, frames]) => {
      const api = window.__APEX__;
      if (api.pause) api.pause();
      if (api.capture) await api.capture(shotName, 0);
      for (let i = 0; i < frames; i++) {
        api.renderFrame(i);
        // Yield periodically so the GPU can flush and async resources (env maps,
        // shader compiles) can resolve mid-warmup.
        if (i % 10 === 0) await new Promise((r) => setTimeout(r, 0));
      }
      if (api.settle) await api.settle();
      api.renderFrame(frames);
    },
    [shot, warm]
  );

  // CDP capture rather than page.screenshot(): the latter waits for compositor
  // stability, which a continuously-rendering WebGL page never reaches.
  const cdp = await page.context().newCDPSession(page);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, Buffer.from(data, 'base64'));
  console.log(`WROTE ${out} (${width}x${height}, shot=${shot}, warm=${warm})`);
} catch (err) {
  failed = true;
  console.error('CAPTURE FAILED:', err.message);
} finally {
  const errs = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'));
  if (errs.length) {
    console.error('--- PAGE ERRORS (' + errs.length + ') ---');
    console.error(errs.slice(0, 30).join('\n'));
  }
  const gl = await page.evaluate(() => {
    try {
      const c = document.createElement('canvas');
      const g = c.getContext('webgl2');
      const d = g.getExtension('WEBGL_debug_renderer_info');
      return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'unknown';
    } catch { return 'none'; }
  }).catch(() => 'n/a');
  console.log('RENDERER:', gl);
  await browser.close();
  process.exit(failed ? 1 : 0);
}
