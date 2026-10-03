import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME=process.env.HOME;
const EXE=[`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,`${HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p=>existsSync(p));
const b=await chromium.launch({executablePath:EXE,headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist','--mute-audio']});
const p=await b.newPage({viewport:{width:1000,height:600}});
const logs=[];p.on('console',m=>logs.push(`[${m.type()}] ${m.text()}`));p.on('pageerror',e=>logs.push('[pageerror] '+e.message));
await p.goto('http://localhost:5310',{waitUntil:'load',timeout:180000});
await p.waitForFunction(()=>window.__APEX__?.ready===true,null,{timeout:180000});
console.log(await p.evaluate(async (mins)=>{
  const e=window.__APEX__.engine, S=e.session, c=e.circuit; e.pause();
  const rows=[];
  // Rolling start: the normal racing state.
  S.beginSession('race',{lights:false, formation:false});
  S.phase='green'; S.flag='green';
  e.field.cars.forEach((car,i)=>{ car.vehicle.reset({ s: c.wrapS(-i*24), lateral: c.racingLineOffset(c.wrapS(-i*24)) + (i%2?1.2:-1.2), speed: 55 }); });
  e._autopilot=true; e._autoDriver=null;
  const N=Math.round(60*60*mins);
  for(let i=0;i<N;i++){
    e.step(1/60);
    if(i%(60*30)===0){
      const sp=e.field.cars.map(x=>x.vehicle.speed).sort((a,b)=>a-b);
      const offs=e.field.cars.filter(x=>{const w=c.sampleAt(x.vehicle.trackS).width; return Math.abs(x.vehicle.trackLateral)>w+1.2;}).length;
      const laps=S.state.map(x=>x.lapsDone);
      rows.push(`t=${(i/60).toFixed(0)}s spd p5/med/p95=${sp[1].toFixed(0)}/${sp[10].toFixed(0)}/${sp[18].toFixed(0)} off=${offs} laps=${Math.min(...laps)}-${Math.max(...laps)} P1=${S.standings[0].code} flag=${S.flag}`);
    }
    if(i%900===0) await new Promise(r=>setTimeout(r,0));
  }
  const sn=S.snapshot(0);
  rows.push(`FINAL lap=${sn.lap} last=${sn.lastLapText} best=${sn.bestLapText} fastest=${sn.fastestLap?.code} ${sn.fastestLap?.time?.toFixed(3)}s sectors=${JSON.stringify(sn.sectorTimes.map(x=>+x.toFixed(2)))} drs=${sn.drsEnabled} sectorStatus=${JSON.stringify(sn.sectorStatus)}`);
  rows.push('TOWER: '+sn.standings.slice(0,8).map(s=>`P${s.position} ${s.code} ${s.gapText||''}`).join(' | '));
  const lapTimes=S.state.map(x=>x.bestLap).filter(x=>x>0).map(x=>+x.toFixed(2)).sort((a,b)=>a-b);
  rows.push(`best laps across field (n=${lapTimes.length}): ${lapTimes[0]} .. ${lapTimes[lapTimes.length-1]}  circuitLength=${c.length.toFixed(0)}m => avg ${(c.length/lapTimes[0]*3.6).toFixed(0)} km/h`);
  return rows.join('\n');
}, 4));
if(logs.length) console.log('LOGS:\n'+[...new Set(logs)].filter(l=>!l.includes('[vite]')).slice(0,10).join('\n'));
await b.close();
