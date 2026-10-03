import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME=process.env.HOME;
const EXE=[`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,`${HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p=>existsSync(p));
const b=await chromium.launch({executablePath:EXE,headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist','--mute-audio']});
const p=await b.newPage({viewport:{width:800,height:400}});
await p.goto('http://localhost:5310',{waitUntil:'load',timeout:180000});
await p.waitForFunction(()=>window.__APEX__?.ready===true,null,{timeout:180000});
console.log(await p.evaluate(async ()=>{
  const e=window.__APEX__.engine, c=e.circuit; e.pause();
  const v=e.field.cars[0].vehicle;
  e.field.cars.forEach((x,i)=>{ if(i) x.vehicle.reset({s:c.wrapS(i*40+2500), lateral:70, speed:0}); });
  const rows=['speed  claimed(corneringLimit)  achievedPeak  achievedSustained  ratio'];
  for (const spd of [30,40,50,60,70,80,90]) {
    let peak=0, sustained=0;
    for (const st of [0.05,0.1,0.15,0.2,0.3,0.4,0.6,0.8,1.0]) {
      v.reset({ s: 0, lateral: 0, speed: spd });
      v.surfaceProbe = () => ({ grip: 1 });
      let mx=0, hold=0, lost=false;
      for (let i=0;i<180;i++){
        // hold speed with throttle/brake; pure steady-state steer
        const thr = v.speed < spd ? 0.7 : 0;
        const brk = v.speed > spd*1.02 ? 0.15 : 0;
        v.setControls({ steer: st, throttle: thr, brake: brk, clutch: 0, autoGearbox: true });
        v.step(1/60);
        const g = Math.abs(v.gLat);
        if (i>60){ mx=Math.max(mx,g); if (g>hold) hold=g; }
        if (v.speed < spd*0.7) { lost=true; break; }
        if (Math.abs(v.slipAngle[2])>0.35) { lost=true; break; }
      }
      if (!lost){ peak=Math.max(peak,mx); sustained=Math.max(sustained,hold); }
    }
    const claimed=v.corneringLimit(spd);
    rows.push(`${spd}  ${claimed.toFixed(2)}  ${(peak*9.81).toFixed(2)}  ${(sustained*9.81).toFixed(2)}  ${(peak*9.81/claimed).toFixed(3)}`);
  }
  rows.push('NOTE: gLat units assumed g; claimed is m/s^2 per contract (corneringLimit -> peak lateral m/s^2)');
  return rows.join('\n');
}));
await b.close();
