// A/B the track material: apply a mutation before the final frame.
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
const HOME = process.env.HOME;
const EXE = [`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,`${HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`].find(p=>existsSync(p));
const a=(n,d)=>{const i=process.argv.indexOf('--'+n);return i===-1?d:process.argv[i+1];};
const out=resolve(a('out','shots/_ab.png')), shot=a('shot','tv'), mut=a('mut','none');
const url=a('url','http://localhost:5502'), W=+a('w',1600), H=+a('h',900), warm=+a('warm',150);
const br=await chromium.launch({executablePath:EXE,headless:true,args:['--use-angle=metal','--hide-scrollbars']});
const p=await br.newPage({viewport:{width:W,height:H},deviceScaleFactor:1});
p.on('pageerror',e=>console.error('[pageerror]',e.message));
p.on('console',m=>{if(m.type()==='error')console.error('[err]',m.text());});
await p.goto(url,{waitUntil:'load',timeout:120000});
await p.waitForFunction(()=>window.__APEX__&&window.__APEX__.ready===true,null,{timeout:120000});
await p.evaluate(async([shot,warm,mut])=>{
  const api=window.__APEX__;
  api.pause(); await api.capture(shot,0);
  for(let i=0;i<warm;i++){api.renderFrame(i); if(i%10===0)await new Promise(r=>setTimeout(r,0));}
  await api.settle();
  let mat=null;
  api.engine.scene.traverse(o=>{if(o.name==='TrackSurface')mat=o.material;});
  window.__MAT__=mat;
  if(mut==='nonrm') mat.normalScale.set(0,0);
  if(mut==='noaniso'){ mat.map.anisotropy=1; mat.normalMap.anisotropy=1; mat.map.needsUpdate=mat.normalMap.needsUpdate=true; }
  if(mut==='nomap') mat.map=null, mat.needsUpdate=true;
  if(mut==='rough1'){ mat.roughness=1; mat.metalness=0; mat.envMapIntensity=0; }
  if(mut==='noshadow'){api.engine.scene.traverse(o=>{if(o.name==='TrackSurface'){o.receiveShadow=false;o.material.needsUpdate=true;}});}
  if(mut==='noshadowmap'){api.engine.renderer.shadowMap.enabled=false;api.engine.scene.traverse(o=>{if(o.material){const m=Array.isArray(o.material)?o.material:[o.material];m.forEach(x=>x.needsUpdate=true);}});}
  if(mut==='basic'){const T=await import('/node_modules/.vite/deps/three.js?v=1').catch(()=>null); api.engine.scene.traverse(o=>{if(o.name==='TrackSurface'){o.material=new (o.material.constructor)({color:0x333333}); }});}
  if(mut==='basicnosm'){api.engine.renderer.shadowMap.enabled=false;api.engine.scene.traverse(o=>{if(o.name==='TrackSurface'){o.material=new (o.material.constructor)({color:0x333333});} if(o.material){const m=Array.isArray(o.material)?o.material:[o.material];m.forEach(x=>x.needsUpdate=true);}});}
  if(mut==='emissive'){api.engine.scene.traverse(o=>{if(o.name==='TrackSurface'){const M=o.material.constructor;const m=new M({color:0x000000});m.emissive&&m.emissive.setRGB(0.2,0.2,0.2);o.material=m;}});}
  if(mut==='nofence'){api.engine.scene.traverse(o=>{if(/Fence|Hoarding/i.test(o.name))o.visible=false;});}
  if(mut==='flat'){ mat.normalScale.set(0,0); mat.envMapIntensity=0; }
  api.renderFrame(warm);
},[shot,warm,mut]);
const cdp=await p.context().newCDPSession(p);
const {data}=await cdp.send('Page.captureScreenshot',{format:'png'});
await mkdir(dirname(out),{recursive:true});
await writeFile(out,Buffer.from(data,'base64'));
console.log('WROTE',out,'mut=',mut);
await br.close();
