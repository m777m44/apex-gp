// Honest GPU frame time: yield to the event loop every frame so gl.finish()
// actually drains, then time renderFrame+finish.  Optional --off a,b,c disables
// postfx stages to attribute cost.
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME = process.env.HOME;
const EXE = [`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const a = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const url = a('url', 'http://localhost:5420');
const W = +a('w', 1920), H = +a('h', 1080), N = +a('frames', 90);
const shots = a('shot', 'chase').split(',');
const off = a('off', '').split(',').filter(Boolean);
const browser = await chromium.launch({ executablePath: EXE, headless: true, args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--hide-scrollbars', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: W, height: H } });
page.on('pageerror', (e) => console.error('[pageerror]', e.message));
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });
for (const shot of shots) {
  const r = await page.evaluate(async ([shotName, n, offList]) => {
    const api = window.__APEX__, e = api.engine;
    api.pause(); await api.capture(shotName, 0);
    for (const k of offList) {
      if (k === 'shadow') e.renderer.shadowMap.enabled = false;
      else if (k === 'sky') e.sky.mesh.visible = false;
      else if (k === 'clouds') e.sky.uniforms.uCloudSteps && (e.sky.uniforms.uCloudSteps.value = 1);
      else if (k === 'dof') e.postfx.settings.dof.enabled = false;
      else if (k === 'gbuffer') e.postfx._renderGBuffer = () => {};
      else if (k === 'lod') e.lodEnabled = false;
      else if (k === 'cars') { e.field.cars.slice(6).forEach(c => { c.model.group.visible = false; c.model.group.traverse(o => { o.visible = false; }); }); e.lodEnabled = false; }
      else if (k === 'post') e.postfx.render = () => { e.renderer.setRenderTarget(null); e.renderer.render(e.scene, e.camera); };
      else if (k === 'ao') e.postfx.aoPass.enabled = false;
      else if (k === 'smaa') e.postfx.smaaPass.enabled = false;
      else if (e.postfx._enabled[k] !== undefined) e.postfx._enabled[k] = false;
      else if (e.postfx.settings[k]) e.postfx.settings[k].enabled = false;
    }
    for (let i = 0; i < 60; i++) { api.renderFrame(i); if (i % 10 === 0) await new Promise((r) => setTimeout(r, 0)); }
    await api.settle();
    const gl = e.renderer.getContext();
    // Throughput: total wall time for n frames, drained at the end of each
    // batch. setTimeout(0) alone does not drain the Metal queue, so a per-frame
    // reading is meaningless; the batch average is the honest number.
    const ms = [];
    for (let b = 0; b < 5; b++) {
      await new Promise((r) => setTimeout(r, 30));
      const t0 = performance.now();
      for (let i = 0; i < n; i++) api.renderFrame(3000 + b * n + i);
      gl.finish();
      ms.push((performance.now() - t0) / n);
    }
    ms.sort((x, y) => x - y);
    return { median: +ms[2].toFixed(2), p90: +ms[4].toFixed(2), p99: +ms[0].toFixed(2), calls: e.stats.drawCalls, tris: +(e.stats.triangles / 1e6).toFixed(2) };
  }, [shot, N, off]);
  console.log(`${shot.padEnd(8)} ${W}x${H} off=[${off}] avg=${r.median}ms (best ${r.p99} worst ${r.p90}) calls=${r.calls} tris=${r.tris}M`);
  if (off.length) break;
}
await browser.close(); process.exit(0);
