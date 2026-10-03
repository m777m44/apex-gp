import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME=process.env.HOME;
const EXE=[`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,`${HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p=>existsSync(p));
const a=(n,d)=>{const i=process.argv.indexOf('--'+n);return i===-1?d:process.argv[i+1];};
const tc=parseFloat(a('tc','0.5'));
const b=await chromium.launch({executablePath:EXE,headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist','--mute-audio']});
const p=await b.newPage({viewport:{width:900,height:500}});
await p.goto('http://localhost:5310',{waitUntil:'load',timeout:180000});
await p.waitForFunction(()=>window.__APEX__?.ready===true,null,{timeout:180000});
console.log('tc='+tc+'  '+await p.evaluate(async (tcVal)=>{
  const e=window.__APEX__.engine, c=e.circuit; e.pause();
  const car=e.field.cars[0], v=car.vehicle;
  v.cfg.assists={...v.cfg.assists, traction:tcVal};
  e.field.cars.forEach((x,i)=>{ if(i) x.vehicle.reset({s:c.wrapS(i*40+2500), lateral: 70, speed:0}); });
  v.reset({ s: 0, lateral: c.racingLineOffset(0), speed: 55 });
  const ai=new (e.field.cars[1].ai.constructor)({ vehicle:v, circuit:c, profile:e.field.profile, skill:0.98, seed:7, name:'T' });
  let off=0, worst=0, laps=0, lastS=0, t=0, times=[], firstOff=-1;
  for(let i=0;i<60*240;i++){
    ai.update(1/60,[v]); v.step(1/60); t+=1/60;
    const w=c.sampleAt(v.trackS).width;
    if(Math.abs(v.trackLateral)>w+0.8){ off++; if(firstOff<0) firstOff=i/60; }
    worst=Math.max(worst,Math.abs(v.trackLateral));
    if(lastS - v.trackS > c.length*0.5){ laps++; times.push(+t.toFixed(2)); t=0; }
    lastS=v.trackS;
    if(i%1200===0) await new Promise(r=>setTimeout(r,0));
  }
  return `laps=${laps} times=[${times.join(', ')}] off=${off}/14400 firstOffAt=${firstOff.toFixed(1)}s worst|lat|=${worst.toFixed(1)}`;
}, tc));
await b.close();
