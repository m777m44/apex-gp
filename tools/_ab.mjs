import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
const HOME=process.env.HOME;
const EXE=[`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,`${HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p=>existsSync(p));
const a=(n,d)=>{const i=process.argv.indexOf('--'+n);return i===-1?d:process.argv[i+1];};
const shot=a('shot','tv'), out=a('out','shots/ab.png'), pre=a('pre','');
const b=await chromium.launch({executablePath:EXE,headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist','--mute-audio','--hide-scrollbars']});
const p=await b.newPage({viewport:{width:+a('w',1600),height:+a('h',900)},deviceScaleFactor:1});
const logs=[];p.on('console',m=>logs.push(`[${m.type()}] ${m.text()}`));p.on('pageerror',e=>logs.push('[pageerror] '+e.message));
await p.goto('http://localhost:5310',{waitUntil:'load',timeout:120000});
await p.waitForFunction(()=>window.__APEX__?.ready===true,null,{timeout:120000});
const info=await p.evaluate(async ([shotName,preCode])=>{
  const api=window.__APEX__,e=api.engine; api.pause(); await api.capture(shotName,0);
  if(preCode) (new Function('e', preCode))(e);
  for(let i=0;i<150;i++){api.renderFrame(i); if(i%10===0)await new Promise(r=>setTimeout(r,0));}
  await api.settle(); api.renderFrame(151);
  return {lights:(()=>{const l=e.environment.startLights;const a=[];for(let i=0;i<10;i++){const c=new (window.__APEX__.engine.constructor?Object:Object)();}return Array.from(e.environment.startLights.instanceColor.array).map(x=>+x.toFixed(2)).join(',');})(), phase:e.session.phase, pools:Object.fromEntries(['smoke','dust','spark','haze','debris','spray'].map(k=>[k,e.particles[k].live+'/'+e.particles[k].count])), calls:e.stats.drawCalls, tris:e.stats.triangles};
},[shot,pre]);
const cdp=await p.context().newCDPSession(p);
const {data}=await cdp.send('Page.captureScreenshot',{format:'png'});
await mkdir('shots',{recursive:true}); await writeFile(out,Buffer.from(data,'base64'));
console.log(out, JSON.stringify(info));
const errs=logs.filter(l=>l.startsWith('[error]')||l.startsWith('[pageerror]')||l.startsWith('[warning]'));
if(errs.length) console.log("LOGS:", [...new Set(errs)].join("\n").slice(0,4000)); else console.log('logs clean');
await b.close();
