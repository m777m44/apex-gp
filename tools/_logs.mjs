// Every console line the page emits for one shot — not just errors.
import { chromium } from 'playwright-core';
const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const b = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-angle=metal','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
const logs = [];
p.on('console', m => logs.push(`[${m.type()}] ${m.text().slice(0,220)}`));
p.on('pageerror', e => logs.push(`[pageerror] ${e.message}`));
await p.goto('http://localhost:5420/', { waitUntil: 'load' });
await p.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });
for (const s of ['chase','cockpit','tv','beauty','wide','grid','wheel','front','hud']) {
  await p.evaluate(async (s) => { const a = window.__APEX__; a.pause(); await a.capture(s,0);
    for (let i=0;i<150;i++){ a.renderFrame(i); if(i%10===0) await new Promise(r=>setTimeout(r,0)); } }, s);
}
await p.evaluate(() => window.__APEX__.resume());
await p.evaluate(() => new Promise(r => setTimeout(r, 4000)));
console.log(logs.length ? logs.join('\n') : 'NO CONSOLE OUTPUT AT ALL');
await b.close(); process.exit(0);
