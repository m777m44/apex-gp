// Image stats: mean luma, %white, %black, per-quadrant means, and optional crop write.
import fs from 'fs'; import zlib from 'zlib';
export function decode(file) {
  const buf = fs.readFileSync(file);
  let o = 8, w=0,h=0,ct=0; const idat=[];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o); const type = buf.toString('ascii', o+4, o+8);
    const data = buf.subarray(o+8, o+8+len);
    if (type==='IHDR'){ w=data.readUInt32BE(0); h=data.readUInt32BE(4); ct=data[9]; }
    if (type==='IDAT') idat.push(data);
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const ch = ct===6?4:ct===2?3:1; const stride = w*ch;
  const img = Buffer.alloc(h*stride);
  let p=0;
  for (let y=0;y<h;y++){
    const f = raw[p++]; const line = raw.subarray(p, p+stride); p+=stride;
    const cur = img.subarray(y*stride, (y+1)*stride);
    const prev = y? img.subarray((y-1)*stride, y*stride) : Buffer.alloc(stride);
    for (let x=0;x<stride;x++){
      const a = x>=ch? cur[x-ch]:0, b = prev[x], c = x>=ch? prev[x-ch]:0; let v=line[x];
      if (f===1) v+=a; else if (f===2) v+=b; else if (f===3) v+=(a+b)>>1;
      else if (f===4){ const pp=a+b-c; const pa=Math.abs(pp-a),pb=Math.abs(pp-b),pc=Math.abs(pp-c);
        v += (pa<=pb&&pa<=pc)?a:(pb<=pc?b:c); }
      cur[x]=v&255;
    }
  }
  return { w, h, ch, stride, img };
}
if (process.argv[1].endsWith('_istat.mjs')) {
  for (const file of process.argv.slice(2)) {
    const { w,h,ch,stride,img } = decode(file);
    let sum=0, white=0, black=0, n=0; const q=[0,0,0,0], qn=[0,0,0,0];
    let satSum=0;
    for (let y=0;y<h;y++) for (let x=0;x<w;x++){
      const i=y*stride+x*ch; const R=img[i],G=img[i+1],B=img[i+2];
      const L=0.2126*R+0.7152*G+0.0722*B;
      sum+=L; n++;
      if (R>250&&G>250&&B>250) white++;
      if (L<6) black++;
      const mx=Math.max(R,G,B), mn=Math.min(R,G,B);
      satSum += mx>0 ? (mx-mn)/mx : 0;
      const k=(y<h/2?0:2)+(x<w/2?0:1); q[k]+=L; qn[k]++;
    }
    console.log(`${file.split('/').pop()}  ${w}x${h} meanL=${(sum/n).toFixed(1)} white%=${(100*white/n).toFixed(2)} black%=${(100*black/n).toFixed(2)} sat=${(satSum/n).toFixed(3)} quads=[${q.map((v,i)=>(v/qn[i]).toFixed(0)).join(' ')}]`);
  }
}
