// Freeze the sim and park a camera beside a kerb so kerb micro-detail can be
// judged without the chase camera's motion blur.
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
const HOME = process.env.HOME;
const EXE = [`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const out = arg('out', 'shots/kerbcam.png');
const back = +arg('back', 9);
const height = +arg('height', 1.5);
const lat = +arg('lat', 4);
const fov = +arg('fov', 32);
const b = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
p.on('pageerror', e => console.error('[pageerror]', e.message));
await p.goto('http://localhost:5407', { waitUntil: 'load', timeout: 120000 });
await p.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });
const info = await p.evaluate(async ([back, height, lat, fov]) => {
  const a = window.__APEX__; a.pause(); await a.capture('beauty', 0);
  const eng = window.APEX_ENGINE ?? a.engine;
  const c = eng.circuit;
  // Find the s of the longest painted-kerb apex on a slow corner.
  const corner = c.corners.filter(x => x.kerb !== 'none' && x.radius < 120).sort((x, y) => x.radius - y.radius)[2];
  const s = corner.sApex;
  const sm = c.sampleAt(s);
  const eye = c.pointAt(c.wrapS(s - back), -corner.side * lat, height);
  const look = c.pointAt(s, corner.side * (sm.width + 0.5), 0.02);
  eng.frozen = true;
  eng._staticCam = { position: eye, lookAt: look, fov };
  eng.postfx.settings.dof.enabled = false;
  eng.postfx.settings.motionBlur.enabled = false;
  eng.postfx.applySettings();
  for (let i = 0; i < 40; i++) a.renderFrame(i);
  if (a.settle) await a.settle();
  a.renderFrame(41);
  return { corner: corner.name, radius: corner.radius, s: +s.toFixed(1) };
}, [back, height, lat, fov]);
const cdp = await p.context().newCDPSession(p);
const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
mkdirSync('shots', { recursive: true });
writeFileSync(out, Buffer.from(data, 'base64'));
console.log('WROTE', out, JSON.stringify(info));
await b.close();
