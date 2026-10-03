import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME=process.env.HOME;
const EXE=[`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const b=await chromium.launch({executablePath:EXE,headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist']});
const p=await b.newPage({viewport:{width:1600,height:900}});
await p.goto('http://localhost:5607',{waitUntil:'load',timeout:120000});
await p.waitForFunction(()=>window.__APEX__?.ready===true,null,{timeout:120000});
console.log(JSON.stringify(await p.evaluate(async ()=>{
  const api=window.__APEX__,eng=api.engine;api.pause();
  const m=await import('/src/textures/procedural.js');
  let t=performance.now(); m.fabric({size:512,key:'cost/probe'}); const bake=performance.now()-t;
  await api.capture('cockpit',0);
  t=performance.now(); api.renderFrame(0); const first=performance.now()-t;
  t=performance.now(); for(let i=1;i<21;i++) api.renderFrame(i); const steady=(performance.now()-t)/20;
  return { fabricBakeMs:+bake.toFixed(1), firstCockpitFrameMs:+first.toFixed(1), steadyMs:+steady.toFixed(2) };
})));
await b.close();
