import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME=process.env.HOME;
const EXE=[`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,`${HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p=>existsSync(p));
const b=await chromium.launch({executablePath:EXE,headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist','--mute-audio']});
const p=await b.newPage({viewport:{width:800,height:450}});
await p.goto('http://localhost:5405',{waitUntil:'load',timeout:180000});
await p.waitForFunction(()=>window.__APEX__?.ready===true,null,{timeout:180000});
const r=await p.evaluate(async ()=>{
  const api=window.__APEX__, e=api.engine; api.pause(); await api.capture('front',0);
  for(let i=0;i<40;i++) api.renderFrame(i); await api.settle();
  const m=e.field.cars[0].model.materials;
  const sc=e.scene;
  const out={ sceneEnv: !!sc.environment, envInt: sc.environmentIntensity,
    paintEnvMap: !!m.paint.envMap, paintEnvInt: m.paint.envMapIntensity,
    paintCC: m.paint.clearcoat, paintCCR: m.paint.clearcoatRoughness,
    paintRough: m.paint.roughness, paintMetal: m.paint.metalness,
    carbonEnvInt: m.carbon.envMapIntensity, lightingEnvInt: e.lighting?.environmentIntensity,
    envRT: !!e.lighting?.envRT, mapping: sc.environment?.mapping,
    layers: m.paint.layers, wet: e.weather?.wetness };
  // measure env radiance by reading the PMREM? just report
  return out;
});
console.log(JSON.stringify(r,null,1));
await b.close();
