import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME=process.env.HOME;
const EXE=[`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const br=await chromium.launch({executablePath:EXE,headless:true,args:['--use-angle=metal']});
const p=await br.newPage({viewport:{width:800,height:450}});
await p.goto('http://localhost:5503',{waitUntil:'load',timeout:120000});
await p.waitForFunction(()=>window.__APEX__?.ready===true,null,{timeout:120000});
const out=await p.evaluate(()=>{
 const eng=window.APEX_ENGINE||window.__APEX__.engine; const c=eng.circuit, env=eng.environment;
 const rows=[];
 for(let s=4200;s<=4800;s+=20){
  const i=c.sampleIndex(s); const sm=c.samples[i];
  const ixm=i*2, ixp=i*2+1;
  rows.push([Math.round(s), +sm.curvature.toFixed(5), env.corr.type[ixm], env.corr.type[ixp], +env.corr.runoff[ixm].toFixed(1), +env.corr.barrier[ixm].toFixed(1), +env.corr.gravel[ixm].toFixed(2)]);
 }
 return {rows, draws: eng.renderer.info.render.calls, tris: eng.renderer.info.render.triangles};
});
console.log(JSON.stringify(out.rows));
console.log('draws',out.draws,'tris',out.tris);
await br.close();
