import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME=process.env.HOME;
const EXE=[`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,`${HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`].find(p=>existsSync(p));
const br=await chromium.launch({executablePath:EXE,headless:true});
const p=await br.newPage();
p.on('pageerror',e=>console.error(e.message));
await p.goto('http://localhost:5502',{waitUntil:'domcontentloaded'});
const r=await p.evaluate(async()=>{
  const mod=await import('/src/textures/procedural.js');
  const m=mod.asphalt({size:1024,coarse:2.1,wear:0.24,key:'mean-probe'});
  const d=m.map.image.data; let s=0,mn=255,mx=0;
  for(let i=0;i<d.length;i+=4){s+=d[i+1];mn=Math.min(mn,d[i+1]);mx=Math.max(mx,d[i+1]);}
  const o=m.ormMap.image.data; let ro=0;
  for(let i=0;i<o.length;i+=4)ro+=o[i+1];
  return {meanG:s/(d.length/4), min:mn, max:mx, meanRough:ro/(o.length/4)/255, meanColor:m.meanColor};
});
console.log(r);
await br.close();
