#!/usr/bin/env node
/**
 * Round-5 car sweep harness.
 *
 *   node tools/_r5.mjs --shot tv --patch 620,540,200,90 --var "name=<js>" ...
 *
 * Each `--var` is `label=<javascript>` evaluated in the page with `M` bound to
 * the player car's material bundle and `W` to its wheel set. After each variant
 * the frame is re-rendered and the named patch measured; `--png <dir>` also
 * writes a PNG per variant.
 */
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const HOME = process.env.HOME;
const EXE = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i === -1 ? d : process.argv[i + 1]; };
const all = (n) => process.argv.reduce((a, v, i) => (v === `--${n}` ? [...a, process.argv[i + 1]] : a), []);

const shot = arg('shot', 'tv');
const url = arg('url', 'http://localhost:5600');
const W = parseInt(arg('w', '1600'), 10);
const H = parseInt(arg('h', '900'), 10);
const warm = parseInt(arg('warm', '150'), 10);
const pngDir = arg('png', null);
const patches = all('patch').map((p) => p.split(',').map(Number));
const colArg = arg('col', null) ? arg('col').split(',').map(Number) : null;
const vars = all('var').map((v) => { const i = v.indexOf('='); return [v.slice(0, i), v.slice(i + 1)]; });
if (!vars.length) vars.push(['base', '0']);

const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.error('[console]', m.text()); });

await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });

await page.evaluate(() => { window.__APEX__.pause(); });

const cdp = await page.context().newCDPSession(page);
if (pngDir) await mkdir(pngDir, { recursive: true });

for (const [label, js] of vars) {
  const res = await page.evaluate(async ([code, n, ps, s, col]) => {
    const api = window.__APEX__;
    const eng = api.engine ?? window.APEX_ENGINE;
    const car = eng.field.cars[0];
    const M = car.model.materials;
    const Wh = car.model.wheels;
    let err = null;
    // THE OVERRIDE MUST LAND AFTER `capture()`, NOT BEFORE IT. `capture()` runs
    // the weather state through `carMaterials.setWetness()`, which rewrites
    // `paint`/`carbonMatte`/`tyre`/`metal` `userData.envGain` outright — so a
    // sweep that pokes the uniform first measures five identical frames and
    // concludes, wrongly, that the gain does nothing.
    // ONE VARIANT PER BROWSER: the hero rig integrates `orbitAngle` and the tv
    // rig advances its camera plan, so re-staging inside one page walks the
    // framing between samples. Run this tool once per variant instead.
    await api.capture(s, 0);
    for (let i = 0; i < n; i++) { api.renderFrame(i); if (i % 12 === 0) await new Promise((r) => setTimeout(r, 0)); }
    await api.settle();
    api.renderFrame(n);
    try { (new Function('M', 'W', 'eng', 'THREE', code))(M, Wh, eng, window.THREE); } catch (e) { err = String(e); }
    api.renderFrame(n + 1);
    // read back
    const c = eng.renderer.domElement;
    const g = c.getContext('webgl2');
    const w = c.width, h = c.height;
    const px = new Uint8Array(w * h * 4);
    g.readPixels(0, 0, w, h, g.RGBA, g.UNSIGNED_BYTE, px);
    const dpr = w / window.innerWidth;
    const out = ps.map(([x0, y0, pw, ph]) => {
      let r = 0, gg = 0, b = 0, n2 = 0, mxL = 0, mnL = 1e9;
      for (let y = y0; y < y0 + ph; y++) {
        for (let x = x0; x < x0 + pw; x++) {
          const sx = Math.round(x * dpr), sy = Math.round((window.innerHeight - 1 - y) * dpr);
          const i = (sy * w + sx) * 4;
          r += px[i]; gg += px[i + 1]; b += px[i + 2];
          const L = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
          if (L > mxL) mxL = L; if (L < mnL) mnL = L;
          n2++;
        }
      }
      r /= n2; gg /= n2; b /= n2;
      const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
      return { r: +r.toFixed(1), g: +gg.toFixed(1), b: +b.toFixed(1),
        BR: +(b - r).toFixed(1), sat: +(mx ? (mx - mn) / mx : 0).toFixed(3),
        Ymax: +mxL.toFixed(1), Ymin: +mnL.toFixed(1) };
    });
    // Vertical profile: mean RGB of each scanline of a narrow column. This is
    // the acceptance test for a flank reflection — a sky band, a horizon step
    // and a darker track band are three legible runs in this list or they do
    // not exist.
    let prof = null;
    if (col) {
      const [x0, y0, y1, cwid] = col;
      prof = [];
      for (let y = y0; y < y1; y++) {
        let r = 0, gg = 0, b = 0;
        for (let x = x0; x < x0 + cwid; x++) {
          const sx = Math.round(x * dpr), sy = Math.round((window.innerHeight - 1 - y) * dpr);
          const i = (sy * w + sx) * 4;
          r += px[i]; gg += px[i + 1]; b += px[i + 2];
        }
        prof.push([y, +(r / cwid).toFixed(0), +(gg / cwid).toFixed(0), +(b / cwid).toFixed(0)]);
      }
    }
    return { err, out, prof };
  }, [js, warm, patches, shot, colArg]);
  if (res.err) console.error(`  !! ${label}: ${res.err}`);
  console.log(`${label.padEnd(16)} ${res.out.map((p) => `[${p.r}/${p.g}/${p.b} B-R ${p.BR} sat ${p.sat} Ymax ${p.Ymax} Ymin ${p.Ymin}]`).join(' ')}`);
  if (res.prof) for (const [y, r, g, b] of res.prof) console.log(`   y=${y}  ${String(r).padStart(3)} ${String(g).padStart(3)} ${String(b).padStart(3)}   L=${(0.2126*r+0.7152*g+0.0722*b).toFixed(0)}`);
  if (pngDir) {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(`${pngDir}/${shot}-${label}.png`, Buffer.from(data, 'base64'));
  }
}

await browser.close();
process.exit(0);
