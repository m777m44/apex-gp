import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME=process.env.HOME;
const EXE=[`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,`${HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`].find(p=>existsSync(p));
const a=(n,d)=>{const i=process.argv.indexOf('--'+n);return i===-1?d:process.argv[i+1];};
const b=await chromium.launch({executablePath:EXE,headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist','--mute-audio']});
const p=await b.newPage({viewport:{width:1920,height:1080}});
await p.goto('http://localhost:5408',{waitUntil:'load',timeout:120000});
await p.waitForFunction(()=>window.__APEX__?.ready===true,null,{timeout:120000});
console.log(await p.evaluate(async (shot)=>{
  const api=window.__APEX__,e=api.engine; api.pause(); await api.capture(shot,0);
  for(let i=0;i<40;i++) api.renderFrame(i);
  const st=api.stats();
  // per-wheel triangle census on the player car
  const car=e.field.cars[e.field.playerIndex??0];
  const ws=car.model.wheels;
  let out=[];
  const tris=(g)=>g?(g.index?g.index.count:g.attributes.position.count)/3:0;
  let total=0, calls=0;
  const w=ws.wheels[0];
  const walk=(o,d=0)=>{ if((o.isMesh||o.isInstancedMesh)){ const t=tris(o.geometry)*(o.isInstancedMesh?o.count:1); total+=t; calls++; out.push('  '.repeat(d)+(o.name||o.material?.name||o.type)+' '+Math.round(t)); } o.children.forEach(c=>walk(c,d+1)); };
  walk(w.travelPivot);
  const linkTris = (w.linkMeshes||[]).reduce((s,m)=>s+tris(m.geometry),0);
  return shot+' fps='+st.fps.toFixed(1)+' calls='+st.drawCalls+' tris='+st.triangles+
    '\none front corner: meshes='+calls+' tris='+Math.round(total)+' (+links '+Math.round(linkTris)+')\n'+out.join('\n');
}, a('shot','front')));
await b.close();
