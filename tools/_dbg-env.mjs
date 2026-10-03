import { chromium } from 'playwright-core';
const HOME = process.env.HOME;
const exe = `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const b = await chromium.launch({ executablePath: exe, headless: true, args:['--use-angle=metal','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport:{width:800,height:450} });
p.on('pageerror', e => console.log('PAGEERR', e.message, e.stack));
await p.goto('http://localhost:5207', { waitUntil:'load' });
await p.waitForFunction(() => window.__APEX__ && window.__APEX__.ready === true, null, {timeout:120000});
const r = await p.evaluate(async () => {
  const api = window.__APEX__;
  api.pause();
  try { await api.capture('wide', 0); } catch(e){ return 'capture: '+e.message+'\n'+e.stack; }
  try { for (let i=0;i<5;i++) api.renderFrame(i); } catch(e){ return 'render: '+e.message+'\n'+e.stack; }
  return 'ok';
});
console.log(r);
await b.close();
