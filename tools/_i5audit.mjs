import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME=process.env.HOME;
const EXE=[`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const b=await chromium.launch({executablePath:EXE,headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist','--hide-scrollbars','--mute-audio']});
const p=await b.newPage({viewport:{width:1280,height:720}});
const logs=[];
p.on('console',m=>logs.push(`[${m.type()}] ${m.text()}`));
p.on('pageerror',e=>logs.push(`[pageerror] ${e.message}`));
await p.goto('http://localhost:5620/?obcaudit=1',{waitUntil:'load',timeout:120000});
await p.waitForFunction(()=>window.__APEX__?.ready===true,null,{timeout:120000});
const r=await p.evaluate(async()=>{
  const e=window.__APEX__.engine;
  window.__APEX__.pause();
  for(const s of ['chase','tv','grid','front','hud']) await window.__APEX__.capture(s,0);
  // render-order + depth audit
  const bad=[]; const ro={};
  e.scene.traverse(o=>{
    if(!o.isMesh&&!o.isPoints&&!o.isLine) return;
    const k=o.renderOrder; ro[k]=(ro[k]||0)+1;
    const m=o.material; if(!m) return;
    const ms=Array.isArray(m)?m:[m];
    for(const mm of ms){
      if(mm.transparent&&mm.depthWrite&&!o.userData.allowDepthWrite) bad.push(`transparent+depthWrite: ${o.name||o.type}`);
      if(mm.polygonOffset&&mm.polygonOffsetFactor===0&&mm.polygonOffsetUnits===0) bad.push(`polygonOffset on with 0/0: ${o.name||o.type}`);
    }
  });
  return {ro, bad:[...new Set(bad)].slice(0,20),
    sky:{ro:e.sky.mesh.renderOrder,dw:e.sky.mesh.material.depthWrite,dt:e.sky.mesh.material.depthTest},
    tone:e.renderer.toneMapping, exposure:e.renderer.toneMappingExposure,
    stats:window.__APEX__.stats()};
});
console.log(JSON.stringify(r,null,1));
console.log('--- CONSOLE ---');
console.log(logs.filter(l=>!l.includes('willReadFrequently')).join('\n')||'(clean)');
await b.close();
