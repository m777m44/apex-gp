import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME=process.env.HOME;
const EXE=[`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,`${HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p=>existsSync(p));
const b=await chromium.launch({executablePath:EXE,headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist','--mute-audio']});
const p=await b.newPage({viewport:{width:900,height:500}});
await p.goto('http://localhost:5310',{waitUntil:'load',timeout:180000});
await p.waitForFunction(()=>window.__APEX__?.ready===true,null,{timeout:180000});
console.log(await p.evaluate(async ()=>{
  const e=window.__APEX__.engine, c=e.circuit; e.pause();
  const car=e.field.cars[0], v=car.vehicle;
  e.field.cars.forEach((x,i)=>{ if(i) x.vehicle.reset({s:c.wrapS(i*40+2500), lateral: 60, speed:0}); });
  v.reset({ s: 0, lateral: c.racingLineOffset(0), speed: 55 });
  const ai=new (e.field.cars[1].ai.constructor)({ vehicle:v, circuit:c, profile:e.field.profile, skill:0.98, seed:7, name:'T' });
  const rows=[];
  for(let i=0;i<60*22;i++){
    ai.update(1/60,[v]);
    v.step(1/60);
    if(i%20===0){
      const idx=c.sampleIndex(v.trackS);
      rows.push(`${(i/60).toFixed(2)}s s=${v.trackS.toFixed(0)} lat=${v.trackLateral.toFixed(2)} line=${c.racingLineOffset(v.trackS).toFixed(2)} spd=${v.speed.toFixed(1)} tgt=${e.field.profile[idx].toFixed(1)} k=${(c.curvatureAt(v.trackS)*1000).toFixed(2)}e-3 steer=${v.controls.steer.toFixed(3)} thr=${v.controls.throttle.toFixed(2)} brk=${v.controls.brake.toFixed(2)} sa=[${v.slipAngle.map(x=>x.toFixed(2)).join(',')}] gLat=${v.gLat.toFixed(2)} yawR=${(v.yawRate??0).toFixed(3)}`);
    }
  }
  rows.push('profile min/max = '+Math.min(...e.field.profile).toFixed(1)+'/'+Math.max(...e.field.profile).toFixed(1));
  rows.push('corneringLimit(60) = '+v.corneringLimit(60).toFixed(1)+' m/s^2 ; maxSteer cfg='+(v.cfg.maxSteerAngle??v.cfg.steerLock??'?'));
  return rows.join('\n');
}));
await b.close();
