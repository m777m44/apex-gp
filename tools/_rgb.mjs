import { chromium } from 'playwright-core';
import { readFileSync, existsSync } from 'node:fs';
const HOME=process.env.HOME;
const EXE=[`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,`${HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`].find(p=>existsSync(p));
const a=(n,d)=>{const i=process.argv.indexOf('--'+n);return i===-1?d:process.argv[i+1];};
const src=a('in');
const boxes=JSON.parse(a('boxes','[]'));
const b64=readFileSync(src).toString('base64');
const br=await chromium.launch({executablePath:EXE,headless:true});
const p=await br.newPage();
const out=await p.evaluate(async([b64,boxes])=>{
  const img=new Image(); img.src='data:image/png;base64,'+b64; await img.decode();
  const c=document.createElement('canvas'); c.width=img.width; c.height=img.height;
  const g=c.getContext('2d',{willReadFrequently:true}); g.drawImage(img,0,0);
  return boxes.map(([label,x,y,w,h])=>{
    const d=g.getImageData(x,y,w,h).data; let r=0,gg=0,bb=0,n=w*h,clip=0;
    for(let i=0;i<n;i++){r+=d[i*4];gg+=d[i*4+1];bb+=d[i*4+2]; if(d[i*4]>250)clip++;}
    return `${label}: rgb(${(r/n).toFixed(0)},${(gg/n).toFixed(0)},${(bb/n).toFixed(0)}) clipR=${(100*clip/n).toFixed(1)}%`;
  });
},[b64,boxes]);
console.log(out.join('\n'));
await br.close();
