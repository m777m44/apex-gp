#!/usr/bin/env node
/** environment round-5 diagnostic: stand geometry vs sun, pit-lane shadow casters. */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME = process.env.HOME;
const EXE = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const url = arg('url', 'http://localhost:5603');
const shot = arg('shot', 'grid');

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });

const out = await page.evaluate(async (shotName) => {
  const api = window.__APEX__;
  api.pause();
  if (api.capture) await api.capture(shotName, 0);
  for (let i = 0; i < 40; i++) api.renderFrame(i);
  const eng = window.APEX_ENGINE;
  const scene = eng.scene;
  const env = eng.environment;
  const c = eng.circuit;
  const sun = eng.lighting.sun;
  const sd = eng.sky.sunDirection;
  const cam = eng.camera;
  const r = {};
  r.sunDir = [sd.x, sd.y, sd.z].map(v => +v.toFixed(3));
  r.camPos = [cam.position.x, cam.position.y, cam.position.z].map(v => +v.toFixed(1));
  const sm = c.sampleAt(0);
  r.s0 = { pos: [sm.position.x, sm.position.y, sm.position.z].map(v => +v.toFixed(1)),
           tan: [sm.tangent.x, sm.tangent.z].map(v => +v.toFixed(3)),
           right: [sm.right.x, sm.right.z].map(v => +v.toFixed(3)) };
  // sun horizontal direction projected on right/tangent
  const hx = sd.x, hz = sd.z; const hl = Math.hypot(hx, hz);
  r.sunAlongRight = +((hx * sm.right.x + hz * sm.right.z) / hl).toFixed(3);
  r.sunAlongTangent = +((hx * sm.tangent.x + hz * sm.tangent.z) / hl).toFixed(3);
  r.sunElevTan = +(sd.y / hl).toFixed(3);
  // stands
  r.stands = (env._stands || []).slice(0, 4).map(st => ({
    s: +st.s.toFixed(1), side: st.side,
    lateral: +(st.p.clone().sub(st.sm.position).dot(st.sm.right)).toFixed(2),
  }));
  r.halfWidth = c.halfWidth;
  // shadow casters by name
  const noCast = [];
  const yesCast = {};
  scene.traverse(o => {
    if (!o.isMesh) return;
    let n = o.name || '(anon)';
    let p = o.parent; const chain = [];
    while (p) { if (p.name) chain.push(p.name); p = p.parent; }
    const key = `${chain.slice(0, 2).reverse().join('/')}/${n}`;
    if (o.castShadow) yesCast[key] = (yesCast[key] || 0) + 1;
    else noCast.push(key);
  });
  r.noCast = noCast.filter(k => /Pit|Garage|People|Crowd/i.test(k));
  r.castPit = Object.keys(yesCast).filter(k => /Pit|Garage/i.test(k));
  // shadow camera
  const sc = sun.shadow.camera;
  r.shadowCam = { l: sc.left, r: sc.right, t: sc.top, b: sc.bottom, n: sc.near, f: sc.far,
                  pos: [sun.position.x, sun.position.y, sun.position.z].map(v => +v.toFixed(1)),
                  tgt: [sun.target.position.x, sun.target.position.y, sun.target.position.z].map(v => +v.toFixed(1)) };
  return r;
}, shot);
console.log(JSON.stringify(out, null, 2));
await browser.close();
