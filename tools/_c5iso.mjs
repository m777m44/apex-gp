#!/usr/bin/env node
/**
 * ISOLATION A/B for the round-5 camera changes. Captures the named shot twice in
 * one browser session: once as shipped, once with every r5 camera edit reverted
 * at RUNTIME (glove/sleeve/cuff knit maps + roughness + cuff value, and the
 * helmet-aperture brow + lid tone). Comparing those two frames is the only way
 * to see MY delta — four other modules have landed since the r4 captures.
 *
 *   node tools/_c5iso.mjs --shot cockpit --a shots/x-mine.png --b shots/x-r4.png
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
const HOME=process.env.HOME;
const EXE=[`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const arg=(n,d)=>{const i=process.argv.indexOf('--'+n);return i===-1?d:process.argv[i+1];};
const shot=arg('shot','cockpit'), A=arg('a','shots/_iso-mine.png'), B=arg('b','shots/_iso-old.png');
const b=await chromium.launch({executablePath:EXE,headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist']});
const p=await b.newPage({viewport:{width:1600,height:900}});
p.on('pageerror',e=>console.error('[pageerror]',e.message));
await p.goto('http://localhost:5607',{waitUntil:'load',timeout:120000});
await p.waitForFunction(()=>window.__APEX__?.ready===true,null,{timeout:120000});

const stage = async (revert) => p.evaluate(async ({shot,revert})=>{
  const api=window.__APEX__,eng=api.engine;api.pause();
  await api.capture(shot,0);
  for(let i=0;i<10;i++) api.renderFrame(i);
  if(revert) eng.rig.chase.outside = 0.90;   // r4 cross-corner offset
  const it=eng.rig.interior;
  if(revert && it){
    const m=it.mats;
    for(const [k,rough,col] of [['glove',0.84,0x272b34],['suit',0.88,0x22262e],['cuff',0.66,0x596273]]){
      m[k].normalMap=null; m[k].roughnessMap=null; m[k].roughness=rough; m[k].color.setHex(col);
      m[k].needsUpdate=true;
    }
    // r4 helmet aperture: flat 0x04040a, brow 0.905, ramp 0.085
    m.visor.map=null; m.visor.color.setHex(0x04040a); m.visor.needsUpdate=true;
    const cv=it.visorTex.image, size=cv.width, g=cv.getContext('2d');
    const img=g.createImageData(size,size), d=img.data;
    const cl=(v,a,b)=>Math.max(a,Math.min(b,v));
    for(let y=0;y<size;y++){const up=1-y/(size-1);
      for(let x=0;x<size;x++){const u=x/(size-1);const lat=Math.abs(u-0.5)*2;
        const brow=0.905-lat*lat*0.075;let a=cl((up-brow)/0.085,0,1);
        const corner=cl((up-0.74)/0.24,0,1)*cl((lat-0.80)/0.20,0,1);
        a=Math.max(a,corner*corner*0.9);
        const o=(y*size+x)*4;const v=Math.round(cl(a,0,1)*255);
        d[o]=d[o+1]=d[o+2]=v;d[o+3]=255;}}
    g.putImageData(img,0,0); it.visorTex.needsUpdate=true;
  }
  for(let i=10;i<150;i++) api.renderFrame(i);
  return { reverted: !!revert, hasInterior: !!it, outside: eng.rig.chase.outside };
},{shot,revert});

console.log('mine :', JSON.stringify(await stage(false)));
await writeFile(A, await p.locator('canvas').first().screenshot());
console.log('WROTE', A);
console.log('r4   :', JSON.stringify(await stage(true)));
await writeFile(B, await p.locator('canvas').first().screenshot());
console.log('WROTE', B);
await b.close();
