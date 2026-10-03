// Probe the live wheel materials/geometry.
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME = process.env.HOME;
const EXE = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  `${HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
].find((p) => existsSync(p));
const a = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const url = a('url', 'http://localhost:5408');
const br = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal', '--enable-unsafe-webgpu'] });
const pg = await br.newPage({ viewport: { width: 800, height: 450 } });
pg.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
await pg.goto(url + '?fx=1', { waitUntil: 'load' });
await pg.waitForFunction(() => window.__APEX__ && window.__APEX__.ready, null, { timeout: 90000 });
const out = await pg.evaluate(() => {
  const e = window.__APEX__.engine;
  const car = e.field?.cars?.[e.field.playerIndex ?? 0];
  const ws = car?.model?.wheelSet ?? car?.model?.wheels;
  const r = [];
  const w = ws?.wheels?.[0];
  if (!w) return ['no wheelset', Object.keys(car?.model ?? {})];
  const cov = w.spinGroup.children.find((o) => o.material === ws._coverMat);
  r.push('cover colour linear ' + JSON.stringify(ws._coverMat?.color));
  r.push('cover verts ' + cov?.geometry.attributes.position.count);
  r.push('disc colour ' + JSON.stringify(ws.discMaterials[0].color));
  r.push('duct mat ' + ws.ductMaterials[0].color.getHexString() + ' rough ' + ws.ductMaterials[0].roughness);
  r.push('link mat ' + ws._linkMat?.color.getHexString());
  return r;
});
console.log(out.join('\n'));
await br.close();
