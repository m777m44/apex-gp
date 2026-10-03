// Crop + nearest-neighbour zoom a PNG using a headless canvas in the browser.
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const HOME=process.env.HOME;
const EXE=[`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,`${HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p=>existsSync(p));
const a=(n,d)=>{const i=process.argv.indexOf('--'+n);return i===-1?d:process.argv[i+1];};
const src=a('in'), out=a('out'), x=+a('x',0), y=+a('y',0), w=+a('w',200), h=+a('h',200), z=+a('z',4);
const b64=readFileSync(src).toString('base64');
const br=await chromium.launch({executablePath:EXE,headless:true});
const p=await br.newPage();
const data=await p.evaluate(async ([b64,x,y,w,h,z])=>{
  const img=new Image(); img.src='data:image/png;base64,'+b64; await img.decode();
  const c=document.createElement('canvas'); c.width=w*z; c.height=h*z;
  const g=c.getContext('2d'); g.imageSmoothingEnabled=false;
  g.drawImage(img, x, y, w, h, 0, 0, w*z, h*z);
  return c.toDataURL('image/png').split(',')[1];
}, [b64,x,y,w,h,z]);
writeFileSync(out, Buffer.from(data,'base64'));
console.log('wrote', out);
await br.close();
