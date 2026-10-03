import { chromium } from 'playwright-core';
import { readFileSync, existsSync } from 'node:fs';
const HOME=process.env.HOME;
const EXE=[`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,`${HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p=>existsSync(p));
const src=process.argv[2];
const b64=readFileSync(src).toString('base64');
const br=await chromium.launch({executablePath:EXE,headless:true});
const p=await br.newPage();
const out=await p.evaluate(async ([b64])=>{
  const img=new Image(); img.src='data:image/png;base64,'+b64; await img.decode();
  const c=document.createElement('canvas'); c.width=img.width; c.height=img.height;
  const g=c.getContext('2d'); g.drawImage(img,0,0);
  const d=g.getImageData(0,0,c.width,c.height).data;
  const lum=(x,y)=>{const i=(y*c.width+x)*4;return (d[i]*0.3+d[i+1]*0.59+d[i+2]*0.11)/255;};
  const scan=(y,thr)=>{let l=-1,r=-1;for(let x=300;x<1300;x++){if(lum(x,y)<thr){if(l<0)l=x;r=x;}}return [l,r,r-l];};
  const rows={};
  for(const y of [400,410,420,430,440,500,510,520,530,540,550,560])
    rows[y]=scan(y,0.16);
  return rows;
},[b64]);
console.log(src); for(const [k,v] of Object.entries(out)) console.log(' y='+k, v.join(' '));
await br.close();
