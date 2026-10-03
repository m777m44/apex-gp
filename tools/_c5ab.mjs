import { chromium } from 'playwright-core';
import { existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
const HOME = process.env.HOME;
const EXE = [`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const arg=(n,d)=>{const i=process.argv.indexOf('--'+n);return i===-1?d:process.argv[i+1];};
const shot=arg('shot','cockpit'), out=arg('out','shots/_ab.png'), patch=arg('patch',null), warm=parseInt(arg('warm','150'),10);
const b = await chromium.launch({ executablePath: EXE, headless: true, args:['--use-angle=metal','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport:{width:1600,height:900} });
p.on('pageerror',e=>console.error('[pageerror]',e.message));
await p.goto('http://localhost:5607',{waitUntil:'load',timeout:120000});
await p.waitForFunction(()=>window.__APEX__?.ready===true,null,{timeout:120000});
const info = await p.evaluate(async ({shot,patch,warm})=>{
  const api=window.__APEX__, eng=api.engine; api.pause();
  await api.capture(shot,0);
  if (patch) { try { eval(patch); } catch(e){ return {err:String(e)}; } }
  for(let i=0;i<warm;i++) api.renderFrame(i);
  const r=eng.rig;
  return { mode:r.mode, fov:eng.camera.fov, focus:r.focusDistance, dof:JSON.parse(JSON.stringify(eng.postfx.settings.dof)),
           pos:eng.camera.position.toArray().map(v=>+v.toFixed(2)) };
},{shot,patch,warm});
console.log(JSON.stringify(info));
mkdirSync('shots',{recursive:true});
await writeFile(out, await p.locator('canvas').first().screenshot());
console.log('WROTE',out);
await b.close();
