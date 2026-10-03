import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME=process.env.HOME;
const EXE=[`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,`${HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`].find(p=>existsSync(p));
const br=await chromium.launch({executablePath:EXE,headless:true,args:['--use-gl=angle','--enable-unsafe-swiftshader']});
const p=await br.newPage();
await p.goto('http://localhost:5408/?brakes=0.9',{waitUntil:'load'});
await p.waitForFunction(()=>window.__APEX__ && window.__APEX__.ready, null, {timeout:120000});
const out = await p.evaluate(()=>{
  const bad=[];
  window.__APEX__.engine.scene.traverse(o=>{
    const g=o.geometry; if(!g||!g.attributes||!g.attributes.position) return;
    const a=g.attributes.position; const arr=a.array;
    for(let i=0;i<arr.length;i++){ if(!Number.isFinite(arr[i])){ bad.push({name:o.name||o.type, parent:o.parent&&o.parent.name, mat:o.material&&o.material.name, count:a.count, at:i}); break; } }
  });
  return bad;
});
console.log(JSON.stringify(out,null,1));
await br.close();
