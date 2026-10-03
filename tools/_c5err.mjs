import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME=process.env.HOME;
const EXE=[`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const b=await chromium.launch({executablePath:EXE,headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist']});
const p=await b.newPage({viewport:{width:1600,height:900}});
const errs=[]; p.on('pageerror',e=>errs.push('pageerror: '+e.message));
p.on('console',m=>{if(m.type()==='error'||m.type()==='warning')errs.push(m.type()+': '+m.text().slice(0,160));});
await p.goto('http://localhost:5607',{waitUntil:'load',timeout:120000});
await p.waitForFunction(()=>window.__APEX__?.ready===true,null,{timeout:120000});
const r=await p.evaluate(async ()=>{
  const api=window.__APEX__,eng=api.engine; api.pause();
  const out={};
  for(const s of ['chase','cockpit','tv','beauty','wide','grid','hud']){
    await api.capture(s,0); for(let i=0;i<40;i++) api.renderFrame(i);
    out[s]={mode:eng.rig.mode, focus:+eng.rig.focusDistance.toFixed(2), fov:+eng.camera.fov.toFixed(1)};
  }
  // exercise every camera mode + replay through the rig
  eng.frozen=false;
  for(const m of ['chase','cockpit','halo','tcam','bumper','tv','hero','wide']){ eng.rig.setMode(m); for(let i=0;i<12;i++) api.renderFrame(i); }
  out.stats = api.stats();
  return out;
});
console.log(JSON.stringify(r,null,1));
console.log('ERRORS/WARNINGS:', errs.length ? errs.slice(0,12) : 'none');
await b.close();
