import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME=process.env.HOME;
const EXE=[`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const b=await chromium.launch({executablePath:EXE,headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist']});
const p=await b.newPage({viewport:{width:1600,height:900}});
p.on('pageerror',e=>console.error('[pageerror]',e.message));
await p.goto('http://localhost:5607',{waitUntil:'load',timeout:120000});
await p.waitForFunction(()=>window.__APEX__?.ready===true,null,{timeout:120000});
console.log(JSON.stringify(await p.evaluate(async ()=>{
  const api=window.__APEX__,eng=api.engine;api.pause();await api.capture('chase',0);
  const rig=eng.rig, st=rig._states.get('chase');
  const rows=[]; let pCar=null,pBasis=null,pCam=eng.camera.quaternion.clone();
  for(let i=0;i<150;i++){
    api.renderFrame(i);
    const carYaw=rig._carYaw, basis=st.yaw.x, aux=st.aux.x;
    const e=new (Object.getPrototypeOf(eng.camera.rotation).constructor)().setFromQuaternion(pCam.clone().invert().multiply(eng.camera.quaternion),'YXZ');
    pCam=eng.camera.quaternion.clone();
    if(i>135&&pCar!==null){
      const wrap=a=>{while(a>Math.PI)a-=2*Math.PI;while(a<-Math.PI)a+=2*Math.PI;return a;};
      rows.push({car:+(wrap(carYaw-pCar)*1000).toFixed(2), basis:+(wrap(basis-pBasis)*1000).toFixed(2), cam:+(e.y*1000).toFixed(2), aux:+(aux*1000).toFixed(1), lag:+(wrap(basis-carYaw)*1000).toFixed(1)});
    }
    pCar=carYaw; pBasis=basis;
  }
  const m=k=>rows.reduce((a,r)=>a+r[k],0)/rows.length;
  return {n:rows.length, carRate:m('car'), basisRate:m('basis'), camRate:m('cam'), aux:m('aux'), lag:m('lag'), sample:rows.slice(0,6)};
})));
await b.close();
