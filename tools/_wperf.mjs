import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME=process.env.HOME;
const EXE=[`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,`${HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`].find(p=>existsSync(p));
const b=await chromium.launch({executablePath:EXE,headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist','--mute-audio']});
const p=await b.newPage({viewport:{width:1920,height:1080}});
await p.goto('http://localhost:5408',{waitUntil:'load',timeout:120000});
await p.waitForFunction(()=>window.__APEX__?.ready===true,null,{timeout:120000});
for (const shot of ['wheel','chase','grid']) {
  const r = await p.evaluate(async (shot)=>{
    const api=window.__APEX__,e=api.engine; api.pause(); await api.capture(shot,0);
    const t0=performance.now(); for(let i=0;i<60;i++) api.renderFrame(i); const ms=(performance.now()-t0)/60;
    const s=api.stats();
    return `${shot}: calls=${s.drawCalls} tris=${(s.triangles/1e6).toFixed(2)}M frame=${ms.toFixed(1)}ms`;
  }, shot);
  console.log(r);
}
await b.close();
