import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME=process.env.HOME;
const EXE=[`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const patch=process.argv[2]||'';
const b=await chromium.launch({executablePath:EXE,headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist']});
const p=await b.newPage({viewport:{width:1600,height:900}});
p.on('pageerror',e=>console.error('[pageerror]',e.message));
await p.goto('http://localhost:5607',{waitUntil:'load',timeout:120000});
await p.waitForFunction(()=>window.__APEX__?.ready===true,null,{timeout:120000});
const r = await p.evaluate(async (patch)=>{
  const api=window.__APEX__,eng=api.engine;api.pause();await api.capture('chase',0);
  if(patch) eval(patch);
  const foes=[],lat=[];
  const rig=eng.rig, st=rig._states.get('chase');
  let prev=null;
  for(let i=0;i<150;i++){
    api.renderFrame(i);
    const f=eng.postfx.motionMat.uniforms.uRadialCentre.value;
    if(i>128) foes.push([+((f.x-0.5)*1600).toFixed(1), +((0.5-f.y)*900).toFixed(1)]);
    // desired-position lateral term
    if(i>128){ const v=rig.velocity; lat.push(+v.length().toFixed(2)); }
  }
  void prev;
  return {foes, lat};
}, patch);
const xs=r.foes.map(f=>f[0]), ys=r.foes.map(f=>f[1]);
const sd=a=>{const m=a.reduce((x,y)=>x+y,0)/a.length;return Math.sqrt(a.reduce((s,v)=>s+(v-m)*(v-m),0)/a.length);};
const mean=a=>a.reduce((x,y)=>x+y,0)/a.length;
console.log((patch||'(baseline)'));
console.log('  FOE x px: mean',mean(xs).toFixed(1),'sd',sd(xs).toFixed(1),'range',Math.min(...xs).toFixed(0),'..',Math.max(...xs).toFixed(0));
console.log('  FOE y px: mean',mean(ys).toFixed(1),'sd',sd(ys).toFixed(1));
console.log('  |camVel| m/s: mean',mean(r.lat).toFixed(2),'sd',sd(r.lat).toFixed(2));
console.log('  seq x:',xs.map(v=>v.toFixed(0)).join(','));
await b.close();
