import { chromium } from 'playwright-core';
import { readFileSync, existsSync } from 'node:fs';
const HOME=process.env.HOME;
const EXE=[`${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,`${HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(p=>existsSync(p));
const src=process.argv[2];
const rects=JSON.parse(process.argv[3]); // [[name,x,y,w,h],...]
const b64=readFileSync(src).toString('base64');
const br=await chromium.launch({executablePath:EXE,headless:true});
const p=await br.newPage();
const out=await p.evaluate(async ([b64,rects])=>{
  const img=new Image(); img.src='data:image/png;base64,'+b64; await img.decode();
  const c=document.createElement('canvas'); c.width=img.width; c.height=img.height;
  const g=c.getContext('2d'); g.drawImage(img,0,0);
  return rects.map(([n,x,y,w,h])=>{
    const d=g.getImageData(x,y,w,h).data; let r=0,gg=0,b=0,mx=0,n2=0;
    const lum=[];
    for(let i=0;i<d.length;i+=4){r+=d[i];gg+=d[i+1];b+=d[i+2];n2++;const L=0.2126*d[i]+0.7152*d[i+1]+0.0722*d[i+2];lum.push(L);mx=Math.max(mx,L);}
    lum.sort((a,b)=>a-b);
    const mean=lum.reduce((a,b)=>a+b,0)/lum.length;
    const sd=Math.sqrt(lum.reduce((a,b)=>a+(b-mean)**2,0)/lum.length);
    const mr=r/n2,mg=gg/n2,mb=b/n2;
    const mxc=Math.max(mr,mg,mb),mnc=Math.min(mr,mg,mb);
    return {n, rgb:[mr|0,mg|0,mb|0], sat:+((mxc-mnc)/(mxc||1)).toFixed(3), lum:+mean.toFixed(1), sd:+sd.toFixed(1), p95:+lum[Math.floor(lum.length*0.95)].toFixed(0), max:mx|0};
  });
},[b64,rects]);
console.log(JSON.stringify(out,null,1));
await br.close();
