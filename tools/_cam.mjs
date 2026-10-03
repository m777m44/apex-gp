import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME=process.env.HOME;
const EXE=[`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,`${HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p=>existsSync(p));
const b=await chromium.launch({executablePath:EXE,headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist','--mute-audio','--disable-frame-rate-limit']});
const p=await b.newPage({viewport:{width:900,height:500}});
await p.goto('http://localhost:5310',{waitUntil:'load',timeout:120000});
await p.waitForFunction(()=>window.__APEX__?.ready===true,null,{timeout:120000});
await p.evaluate(()=>new Promise(r=>setTimeout(r,800)));
const seq=[];
for(let i=0;i<8;i++){
  await p.keyboard.press('KeyC');
  await p.evaluate(()=>new Promise(r=>setTimeout(r,500)));
  seq.push(await p.evaluate(()=>window.__APEX__.engine.rig.mode));
}
console.log('camera cycle:', seq.join(' -> '));
console.log('unique modes seen:', [...new Set(seq)].length);
await b.close();
