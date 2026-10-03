import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME=process.env.HOME;
const EXE=[`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,`${HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p=>existsSync(p));
const a=(n,d)=>{const i=process.argv.indexOf('--'+n);return i===-1?d:process.argv[i+1];};
const b=await chromium.launch({executablePath:EXE,headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist','--mute-audio']});
const p=await b.newPage({viewport:{width:1920,height:1080}});
await p.goto('http://localhost:5310',{waitUntil:'load',timeout:120000});
await p.waitForFunction(()=>window.__APEX__?.ready===true,null,{timeout:120000});
console.log(await p.evaluate(async (shot)=>{
  const api=window.__APEX__,e=api.engine; api.pause(); await api.capture(shot,0);
  for(let i=0;i<60;i++) api.renderFrame(i);
  const base={calls:e.stats.drawCalls,tris:e.stats.triangles};
  const rows=[];
  const groups=[['circuit',e.circuit.group],...e.environment.group.children.map(c=>[c.name||c.type,c]),['cars',{visible:true,set v(x){e.field.cars.forEach(c=>c.model.group.visible=x);}}]];
  for(const [name,g] of groups){
    let restore;
    if(g.set!==undefined||name==='cars'){ e.field.cars.forEach(c=>c.model.group.visible=false); restore=()=>e.field.cars.forEach(c=>c.model.group.visible=true); }
    else { g.visible=false; restore=()=>{g.visible=true;}; }
    api.renderFrame(999); api.renderFrame(999);
    rows.push([name, base.calls-e.stats.drawCalls, Math.round((base.tris-e.stats.triangles)/1000)]);
    restore(); api.renderFrame(999);
  }
  // shadow-caster census
  let casters=0, castTris=0;
  const byName={};
  e.scene.traverse(o=>{ if(o.castShadow&&(o.isMesh||o.isInstancedMesh)){ casters++;
    let top=o; while(top.parent&&top.parent!==e.scene) top=top.parent;
    const g=o.name||top.name||o.type; byName[g]=(byName[g]||0)+1;} });
  rows.sort((x,y)=>y[1]-x[1]);
  return shot+' base='+JSON.stringify(base)+'\ncalls saved by hiding (name, calls, kTris):\n'+rows.map(r=>'  '+r[0]+' '+r[1]+' '+r[2]+'k').join('\n')
    +'\nshadow casters='+casters+' '+JSON.stringify(Object.entries(byName).sort((a,b)=>b[1]-a[1]).slice(0,18));
}, a('shot','front')));
await b.close();
