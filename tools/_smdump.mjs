// Dump each cascade's shadow map as a PNG (depth remapped) to see what is in it.
import { chromium } from 'playwright-core';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
const HOME = process.env.HOME;
const EXE = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const shot = arg('shot', 'grid');
const url = arg('url', 'http://localhost:5420');
const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });
const imgs = await page.evaluate(async (s) => {
  const THREE = window.APEX_ENGINE.THREE ?? (await import('/node_modules/three/build/three.module.js'));
  const api = window.__APEX__; api.pause(); await api.capture(s, 0);
  for (let i = 0; i < 30; i++) api.renderFrame(i);
  const e = window.APEX_ENGINE, r = e.renderer, L = e.lighting;
  const scene = new THREE.Scene();
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const mat = new THREE.ShaderMaterial({
    uniforms: { t: { value: null } },
    vertexShader: 'varying vec2 v; void main(){ v = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: 'uniform sampler2D t; varying vec2 v; void main(){ float d = texture(t, v).r; gl_FragColor = vec4(vec3(fract(d*40.0)*0.5+ (d<0.999?0.5:0.0)), 1.0); }',
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
  scene.add(quad);
  const out = [];
  const prev = r.getRenderTarget();
  for (const l of L.cascadeLights) {
    const map = l.shadow.map;
    if (!map) { out.push(null); continue; }
    mat.uniforms.t.value = map.depthTexture ?? map.texture;
    r.setRenderTarget(null);
    r.setSize(1024, 1024, false);
    r.clear(true, true, true);
    r.render(scene, cam);
    out.push(r.domElement.toDataURL('image/png'));
  }
  r.setRenderTarget(prev);
  return out;
}, shot);
mkdirSync('shots/sm', { recursive: true });
imgs.forEach((d, i) => { if (d) { writeFileSync(`shots/sm/${shot}_c${i}.png`, Buffer.from(d.split(',')[1], 'base64')); console.log(`shots/sm/${shot}_c${i}.png`); } });
await browser.close(); process.exit(0);
