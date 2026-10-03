import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME=process.env.HOME;
const EXE=[`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,`${HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`].find(p=>existsSync(p));
const b=await chromium.launch({executablePath:EXE,headless:true,args:['--use-angle=metal']});
const p=await b.newPage({viewport:{width:1280,height:720}});
await p.goto('http://localhost:5408',{waitUntil:'load',timeout:120000});
await p.waitForFunction(()=>window.__APEX__?.ready===true,null,{timeout:120000});
console.log(await p.evaluate(()=>{
  const e=window.__APEX__.engine; const bad=[]; let vc=0, discs=0, ducts=0;
  e.scene.traverse(o=>{
    const m=o.material; if(!m||!o.geometry) return;
    if(m.vertexColors){ vc++; if(!o.geometry.attributes.color) bad.push('NO COLOR ATTR: '+(o.name||o.type)); }
    if(m.customProgramCacheKey&&m.customProgramCacheKey()==='apex-brakedisc'){ discs++; if(!m.userData.heatUniforms) bad.push('disc not compiled'); }
    if(m.customProgramCacheKey&&m.customProgramCacheKey()==='apex-brakeduct') ducts++;
  });
  return JSON.stringify({vertexColorMeshes:vc, discMats:discs, ductMats:ducts, problems:bad});
}));
await b.close();
