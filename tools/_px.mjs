import fs from 'fs'; import zlib from 'zlib';
const file = process.argv[2];
const buf = fs.readFileSync(file);
let o = 8, w=0,h=0,bd=0,ct=0; const idat=[];
while (o < buf.length) {
  const len = buf.readUInt32BE(o); const type = buf.toString('ascii', o+4, o+8);
  const data = buf.subarray(o+8, o+8+len);
  if (type==='IHDR'){ w=data.readUInt32BE(0); h=data.readUInt32BE(4); bd=data[8]; ct=data[9]; }
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
const pts = process.argv.slice(3).map(s=>s.split(',').map(Number));
for (const [x,y,r=2] of pts) {
  let R=0,G=0,B=0,n=0;
  for (let dy=-r;dy<=r;dy++) for (let dx=-r;dx<=r;dx++){
    const xx=x+dx, yy=y+dy; if(xx<0||yy<0||xx>=w||yy>=h) continue;
    const i=yy*stride+xx*ch; R+=img[i];G+=img[i+1];B+=img[i+2];n++;
  }
  console.log(`${x},${y}: ${(R/n).toFixed(0)} ${(G/n).toFixed(0)} ${(B/n).toFixed(0)}`);
}
