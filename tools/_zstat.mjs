import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME = process.env.HOME;
const EXE = [`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const shot = arg('shot', 'chase');
const b = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal','--ignore-gpu-blocklist','--disable-frame-rate-limit'] });
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
await p.goto('http://localhost:5407', { waitUntil: 'load', timeout: 120000 });
await p.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });
console.log(JSON.stringify(await p.evaluate(async (shotName) => {
  const a = window.__APEX__; a.pause(); await a.capture(shotName, 0);
  for (let i = 0; i < 90; i++) a.renderFrame(i);
  if (a.settle) await a.settle();
  const s = a.stats();
  const gl = (window.APEX_ENGINE ?? a.engine).renderer.getContext();
  const px = new Uint8Array(4);
  const run = () => {
    const t0 = performance.now();
    for (let i = 0; i < 200; i++) a.renderFrame(100 + i);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return (performance.now() - t0) / 200;
  };
  run();
  const ms = Math.min(run(), run());
  return { msPerFrame: +ms.toFixed(2), fps: +(1000 / ms).toFixed(0), drawCalls: s.drawCalls, triangles: s.triangles };
}, shot)));
await b.close();
