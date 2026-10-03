#!/usr/bin/env node
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME = process.env.HOME;
const EXE = [`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const url = process.argv[2] || 'http://localhost:5403';
const b = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal'] });
const p = await b.newPage({ viewport: { width: 800, height: 450 } });
await p.goto(url, { waitUntil: 'load', timeout: 180000 });
await p.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 180000 });
console.log(JSON.stringify(await p.evaluate(() => {
  const out = [];
  window.__APEX__.engine.scene.traverse((o) => {
    if (!o.isMesh) return;
    const tri = (o.geometry?.index ? o.geometry.index.count : o.geometry?.attributes?.position?.count ?? 0) / 3;
    const n = o.isInstancedMesh ? o.count : 1;
    out.push({ name: o.name || o.parent?.name || '?', inst: n, tris: Math.round(tri * n) });
  });
  out.sort((a, b2) => b2.tris - a.tris);
  return { total: out.reduce((s, x) => s + x.tris, 0), meshes: out.length, top: out.slice(0, 22) };
}), null, 1));
await b.close();
