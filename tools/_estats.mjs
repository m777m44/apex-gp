import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME=process.env.HOME;
const EXE=[`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const b=await chromium.launch({executablePath:EXE,headless:true,args:['--use-angle=metal']});
const p=await b.newPage({viewport:{width:1600,height:900}});
await p.goto(process.argv[2]||'http://localhost:5503/',{waitUntil:'load'});
await p.waitForFunction(()=>window.__APEX__?.ready===true,null,{timeout:180000});
for (const s of ['wide','grid','chase']) {
  console.log(s, JSON.stringify(await p.evaluate(async(s)=>{const a=window.__APEX__;a.pause();await a.capture(s,0);
    for(let i=0;i<90;i++){a.renderFrame(i); if(i%10===0)await new Promise(r=>setTimeout(r,0));}
    return a.stats();},s)));
}
await b.close(); process.exit(0);
