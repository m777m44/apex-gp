// Row-mean luma profile of the top of frame + dark-pixel fraction per band.
import { execFileSync } from 'node:child_process';
const files = process.argv.slice(2);
for (const f of files) {
  const raw = execFileSync('ffmpeg',['-v','error','-i',f,'-vf','scale=1600:900','-pix_fmt','gray','-f','rawvideo','-'],{maxBuffer:1<<28});
  const W=1600,H=900;
  // first row whose mean luma exceeds 24 -> the bottom of the opaque band
  let firstBright=-1; const prof=[];
  for(let y=0;y<300;y++){let s=0;for(let x=0;x<W;x++)s+=raw[y*W+x];const m=s/W;if(y%10===0)prof.push(m.toFixed(0));if(firstBright<0&&m>24)firstBright=y;}
  let dark=0,tot=0;
  for(let y=0;y<225;y++)for(let x=0;x<W;x++){tot++;if(raw[y*W+x]<6)dark++;}
  console.log(`${f}  bandEnds(y where rowmean>24)=${firstBright}  darkFrac(top25%)=${(dark/tot*100).toFixed(2)}%  rowmean@0,10,..=${prof.slice(0,16).join(',')}`);
}
