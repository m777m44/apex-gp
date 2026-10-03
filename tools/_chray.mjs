// Raycast from the capture camera through screen pixels; report mesh + car-local hit.
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME = process.env.HOME;
const EXE = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  `${HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => existsSync(p));
const a = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const url = a('url', 'http://localhost:5506');
const shot = a('shot', 'front');
const W = +a('w', 1600), H = +a('h', 900);
const pts = a('px', '790,530').split(';').map((s) => s.split(',').map(Number));
const br = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const pg = await br.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
pg.on('console', (m) => { if (m.type() === 'error') console.log('PAGEERR', m.text()); });
await pg.addInitScript(`window.__THREE_PROMISE__ = import('/node_modules/three/build/three.module.js').then(m => { window.THREE = m; });`);
await pg.goto(url, { waitUntil: 'load' });
await pg.waitForFunction(() => window.__APEX__ && window.__APEX__.ready, null, { timeout: 120000 });
const res = await pg.evaluate(async ([shot, pts, W, H]) => {
  const A = window.__APEX__;
  A.pause(); await A.capture(shot, 0); await A.settle();
  for (let i = 0; i < 150; i++) A.renderFrame(i);
  const THREE = A.engine.THREE ?? window.THREE;
  const cam = A.engine.camera;
  const scene = A.engine.scene;
  const rc = new THREE.Raycaster();
  const out = [];
  for (const [x, y] of pts) {
    const ndc = new THREE.Vector2((x / W) * 2 - 1, -(y / H) * 2 + 1);
    rc.setFromCamera(ndc, cam);
    const targets = [];
    scene.traverseVisible((o) => {
      if (o.isMesh && o.geometry && o.geometry.attributes && o.geometry.attributes.position && !o.isInstancedMesh) targets.push(o);
    });
    const hits = [];
    for (const t of targets) { try { rc.intersectObject(t, false, hits); } catch (e) { /* ignore */ } }
    hits.sort((p, q) => p.distance - q.distance);
    const list = hits.slice(0, 4).map((h) => {
      let root = h.object, chain = [];
      while (root) { chain.push(root.name || root.type); root = root.parent; }
      const lp = h.object.worldToLocal(h.point.clone());
      return {
        name: h.object.name, chain: chain.slice(0, 5).join(' < '),
        dist: +h.distance.toFixed(2),
        local: [lp.x, lp.y, lp.z].map((v) => +v.toFixed(3)),
        n: h.face ? [h.face.normal.x, h.face.normal.y, h.face.normal.z].map((v) => +v.toFixed(2)) : null,
        mat: h.object.material.name || h.object.material.type,
        col: h.object.material.color ? '#' + h.object.material.color.getHexString() : null,
      };
    });
    out.push({ px: [x, y], list });
  }
  return out;
}, [shot, pts, W, H]);
for (const r of res) {
  console.log('px', r.px.join(','));
  for (const h of r.list) console.log('   ', h.dist, h.name, '|', h.chain, '| local', h.local.join(','), '| n', h.n && h.n.join(','), '|', h.mat, h.col);
}
await br.close();
