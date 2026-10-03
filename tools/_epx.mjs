import { chromium } from 'playwright-core';
import { readFileSync, existsSync } from 'node:fs';
const HOME=process.env.HOME;
const EXE=[`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
const src=process.argv[2];
const rects=JSON.parse(process.argv[3]);
const b64=readFileSync(src).toString('base64');
const br=await chromium.launch({executablePath:EXE,headless:true});
const p=await br.newPage();
console.log(await p.evaluate(async ([b64,rects])=>{
  const img=new Image(); img.src='data:image/png;base64,'+b64; await img.decode();
  const c=document.createElement('canvas'); c.width=img.width; c.height=img.height;
  const g=c.getContext('2d'); g.drawImage(img,0,0);
  return rects.map(r=>{
    const d=g.getImageData(r[0],r[1],r[2],r[3]).data;
    let R=0,G=0,B=0,n=0,mx=0;
    for(let i=0;i<d.length;i+=4){R+=d[i];G+=d[i+1];B+=d[i+2];n++;mx=Math.max(mx,d[i],d[i+1],d[i+2]);}
    return `${r.join(',')} mean=${(R/n).toFixed(1)},${(G/n).toFixed(1)},${(B/n).toFixed(1)} max=${mx}`;
  }).join('\n');
},[b64,rects]));
await br.close();
