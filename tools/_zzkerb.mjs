import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME=process.env.HOME;
const EXE=[`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p=>existsSync(p));
const b=await chromium.launch({executablePath:EXE,headless:true,args:['--use-angle=metal','--ignore-gpu-blocklist']});
const p=await b.newPage({viewport:{width:600,height:340}});
p.on('pageerror',e=>console.log('[e]',e.message));
await p.goto('http://localhost:5407',{waitUntil:'load',timeout:180000});
await p.waitForFunction(()=>window.__APEX__?.ready===true,null,{timeout:180000});
console.log(JSON.stringify(await p.evaluate(()=>{
  const sc = window.__APEX__.engine.scene;
  const out = {};
  for (const nm of ['KerbsPainted','KerbsSausage','KerbsNegative','KerbsAstroturf','TrackSurface','TrackLines','GridBoxes']) {
    const m = sc.getObjectByName(nm);
    out[nm] = m ? { verts: m.geometry.attributes.position.count, tris: m.geometry.index.count/3, cast: m.castShadow } : null;
  }
  // colour transition sanity: walk the first 40 rows of KerbsPainted (8 verts per row)
  const kp = sc.getObjectByName('KerbsPainted');
  const col = kp.geometry.attributes.color, pos = kp.geometry.attributes.position;
  const rowsOut = [];
  for (let r = 0; r < 14; r++) {
    const i = r*8 + 3;   // crown vertex
    rowsOut.push([+col.getX(i).toFixed(3), +col.getY(i).toFixed(3), +pos.getY(i).toFixed(3)]);
  }
  out.rows = rowsOut;
  return out;
}), null, 1));
await b.close();
