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
console.log(patch||'(baseline)', JSON.stringify(await p.evaluate(async (patch)=>{
  const api=window.__APEX__,eng=api.engine;api.pause();await api.capture('chase',0);
  if(patch) eval(patch);
  for(let i=0;i<150;i++) api.renderFrame(i);
  const u=eng.postfx.motionMat.uniforms;
  const foe=u.uRadialCentre.value;
  return { foeU:+foe.x.toFixed(4), foeV:+foe.y.toFixed(4),
           offXpx:+((foe.x-0.5)*1600).toFixed(0), offYpx:+((0.5-foe.y)*900).toFixed(0),
           fov:+eng.camera.fov.toFixed(2), radial:+u.uRadial.value.toFixed(4) };
}, patch)));
await b.close();
