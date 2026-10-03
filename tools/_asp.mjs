// Dump a baked MaterialMaps channel straight out of the texture library, so the
// asphalt can be inspected at 1:1 texels without going through a render.
import { chromium } from 'playwright-core';
import { writeFileSync, existsSync } from 'node:fs';
const HOME = process.env.HOME;
const EXE = [`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`, `${HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p => existsSync(p));
const a = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const out = a('out', 'shots/_asp.png');
const which = a('map', 'map');           // map | normalMap | ormMap
const size = +a('size', 2048);
const coarse = +a('coarse', 2.1);
const wear = +a('wear', 0.24);
const crop = +a('crop', 0);              // 0 = whole tile, else NxN crop from 0,0
const zoom = +a('z', 1);
const url = a('url', 'http://localhost:5502');

const br = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal'] });
const p = await br.newPage({ viewport: { width: 256, height: 256 } });
p.on('pageerror', e => console.error('[pageerror]', e.message));
await p.goto(url, { waitUntil: 'domcontentloaded' });
const data = await p.evaluate(async ([which, size, coarse, wear, crop, zoom]) => {
  const mod = await import('/src/textures/procedural.js');
  const t0 = performance.now();
  const m = mod.asphalt({ size, coarse, wear, key: `probe:${size}:${coarse}:${wear}` });
  const bakeMs = performance.now() - t0;
  const tex = m[which];
  const S = tex.image.width;
  const src = tex.image.data;
  const N = crop || S;
  const c = document.createElement('canvas');
  c.width = N * zoom; c.height = N * zoom;
  const g = c.getContext('2d');
  const id = g.createImageData(N, N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = ((y % S) * S + (x % S)) * 4, j = (y * N + x) * 4;
    id.data[j] = src[i]; id.data[j + 1] = src[i + 1]; id.data[j + 2] = src[i + 2]; id.data[j + 3] = 255;
  }
  const tmp = document.createElement('canvas'); tmp.width = N; tmp.height = N;
  tmp.getContext('2d').putImageData(id, 0, 0);
  g.imageSmoothingEnabled = false;
  g.drawImage(tmp, 0, 0, N * zoom, N * zoom);
  return { png: c.toDataURL('image/png').split(',')[1], bakeMs: Math.round(bakeMs), S };
}, [which, size, coarse, wear, crop, zoom]);
writeFileSync(out, Buffer.from(data.png, 'base64'));
console.log(`wrote ${out}  (${which}, tile ${data.S}px, bake ${data.bakeMs} ms)`);
await br.close();
