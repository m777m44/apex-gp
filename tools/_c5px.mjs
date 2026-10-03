import { execFileSync } from 'node:child_process';
const f=process.argv[2];
const raw=execFileSync('ffmpeg',['-v','error','-i',f,'-vf','scale=1600:900','-pix_fmt','rgb24','-f','rawvideo','-'],{maxBuffer:1<<28});
const W=1600;
for(const spec of process.argv.slice(3)){
  const [x,y,w,h]=spec.split(',').map(Number);
  let r=0,g=0,b=0,n=0,lmax=0;
  for(let j=y;j<y+h;j++)for(let i=x;i<x+w;i++){const o=(j*W+i)*3;r+=raw[o];g+=raw[o+1];b+=raw[o+2];n++;const l=0.299*raw[o]+0.587*raw[o+1]+0.114*raw[o+2];if(l>lmax)lmax=l;}
  const R=r/n,G=g/n,B=b/n,mx=Math.max(R,G,B),mn=Math.min(R,G,B);
  console.log(`${f} [${spec}] rgb ${R.toFixed(1)}/${G.toFixed(1)}/${B.toFixed(1)}  Y ${(0.299*R+0.587*G+0.114*B).toFixed(1)}  sat ${(mx>0?(mx-mn)/mx:0).toFixed(3)}  Lmax ${lmax.toFixed(0)}`);
}
