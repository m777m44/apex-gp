import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME=process.env.HOME;
const EXE=[`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const b=await chromium.launch({executablePath:EXE,headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist']});
const p=await b.newPage({viewport:{width:1600,height:900}});
await p.goto('http://localhost:5607',{waitUntil:'load',timeout:120000});
await p.waitForFunction(()=>window.__APEX__?.ready===true,null,{timeout:120000});
console.log(JSON.stringify(await p.evaluate(async ()=>{
  const api=window.__APEX__,eng=api.engine;api.pause();await api.capture('chase',0);
  for(let i=0;i<150;i++) api.renderFrame(i);
  const rig=eng.rig,t=rig.target,c=eng.circuit;
  const s=t.telemetry.trackS, speedN=Math.min(1,t.speed/rig.topSpeed);
  const aheadD=26+speedN*46;
  const kA=c.curvatureAt(c.wrapS(s+aheadD*0.62));
  // where is the camera relative to the car, in TRACK lateral terms?
  const camN=c.nearest(eng.camera.position, s);
  const carN=c.nearest(t.position, s);
  return { s:+s.toFixed(1), speedN:+speedN.toFixed(3), aheadD:+aheadD.toFixed(1), kA:+kA.toFixed(5),
           offsetApplied:+Math.max(-rig.chase.outside,Math.min(rig.chase.outside,kA*260)).toFixed(3),
           carLateral:+carN.lateral.toFixed(2), camLateral:+camN.lateral.toFixed(2),
           camMinusCar:+(camN.lateral-carN.lateral).toFixed(2),
           kHere:+c.curvatureAt(s).toFixed(5) };
})));
await b.close();
