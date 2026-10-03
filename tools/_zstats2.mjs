import fs from 'fs'; import zlib from 'zlib';
function load(file){
  const buf=fs.readFileSync(file); let o=8,w=0,h=0,ct=0; const idat=[];
  while(o<buf.length){const len=buf.readUInt32BE(o);const type=buf.toString('ascii',o+4,o+8);
    const data=buf.subarray(o+8,o+8+len);
    if(type==='IHDR'){w=data.readUInt32BE(0);h=data.readUInt32BE(4);ct=data[9];}
    if(type==='IDAT')idat.push(data); o+=12+len;}
  const raw=zlib.inflateSync(Buffer.concat(idat));
  const ch=ct===6?4:ct===2?3:1;const stride=w*ch;const img=Buffer.alloc(h*stride);let p=0;
  for(let y=0;y<h;y++){const f=raw[p++];const line=raw.subarray(p,p+stride);p+=stride;
    const cur=img.subarray(y*stride,(y+1)*stride);const prev=y?img.subarray((y-1)*stride,y*stride):Buffer.alloc(stride);
    for(let x=0;x<stride;x++){const a=x>=ch?cur[x-ch]:0,b=prev[x],c=x>=ch?prev[x-ch]:0;let v=line[x];
      if(f===1)v+=a;else if(f===2)v+=b;else if(f===3)v+=(a+b)>>1;
      else if(f===4){const pp=a+b-c;const pa=Math.abs(pp-a),pb=Math.abs(pp-b),pc=Math.abs(pp-c);v+=(pa<=pb&&pa<=pc)?a:(pb<=pc?b:c);}
      cur[x]=v&255;}}
  return {img,w,h,ch};
}
const [file,...rest]=process.argv.slice(2);
const im=load(file);
for(const spec of rest){
  const [x0,y0,w,h]=spec.split(',').map(Number);
  let R=0,G=0,B=0,n=0,gr=0,mn=255,mx=0;
  for(let y=y0;y<y0+h;y++)for(let x=x0;x<x0+w;x++){
    const i=(y*im.w+x)*im.ch;R+=im.img[i];G+=im.img[i+1];B+=im.img[i+2];n++;
    const l=im.img[i+1];mn=Math.min(mn,l);mx=Math.max(mx,l);
    const ix=((y)*im.w+x+1)*im.ch, iy=((y+1)*im.w+x)*im.ch;
    gr+=Math.abs(im.img[ix+1]-l)+Math.abs(im.img[iy+1]-l);
  }
  console.log(`${spec}  rgb=${(R/n).toFixed(1)},${(G/n).toFixed(1)},${(B/n).toFixed(1)}  lum=${(G/n).toFixed(1)} min=${mn} max=${mx} grad=${(gr/n).toFixed(2)}`);
}
