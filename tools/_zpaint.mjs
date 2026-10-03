// Live A/B of car paint material scalars: one browser, N variants.
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
const HOME=process.env.HOME;
const EXE=[`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,`${HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p=>existsSync(p));
const a=(n,d)=>{const i=process.argv.indexOf('--'+n);return i===-1?d:process.argv[i+1];};
const shot=a('shot','front'), tag=a('tag','v'), port=a('port','5405');
const variants=JSON.parse(a('vars','[["base",""]]'));
const b=await chromium.launch({executablePath:EXE,headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist','--mute-audio','--hide-scrollbars']});
const p=await b.newPage({viewport:{width:+a('w',1600),height:+a('h',900)},deviceScaleFactor:1});
const logs=[];p.on('console',m=>logs.push(`[${m.type()}] ${m.text()}`));p.on('pageerror',e=>logs.push('[pageerror] '+e.message));
await p.goto('http://localhost:'+port,{waitUntil:'load',timeout:180000});
await p.waitForFunction(()=>window.__APEX__?.ready===true,null,{timeout:180000});
await p.evaluate(async (s)=>{ const api=window.__APEX__; api.pause(); await api.capture(s,0);
  for(let i=0;i<150;i++){api.renderFrame(i); if(i%20===0)await new Promise(r=>setTimeout(r,0));} await api.settle(); }, shot);
const cdp=await p.context().newCDPSession(p);
await mkdir('shots',{recursive:true});
for(const [name,code] of variants){
  await p.evaluate(async ([code])=>{
    const e=window.__APEX__.engine;
    const mats=e.field.cars.map(c=>c.model.materials);
    if(code) (new Function('mats','THREE', code))(mats, window.THREE ?? {});
    for(let i=0;i<3;i++) window.__APEX__.renderFrame(200+i);
  },[code]);
  const {data}=await cdp.send('Page.captureScreenshot',{format:'png'});
  const out=`shots/${tag}-${shot}-${name}.png`;
  await writeFile(out,Buffer.from(data,'base64'));
  console.log('WROTE',out);
}
const errs=logs.filter(l=>l.startsWith('[error]')||l.startsWith('[pageerror]'));
if(errs.length) console.log("LOGS:", [...new Set(errs)].join("\n").slice(0,2000)); else console.log('logs clean');
await b.close();
