// Crop + integer upscale a PNG.  node tools/_icrop.mjs in.png out.png x y w h [scale]
import fs from 'fs'; import zlib from 'zlib';
import { decode } from './_istat.mjs';
const [inF, outF, X, Y, W, H, S = '1'] = process.argv.slice(2);
const x0 = +X, y0 = +Y, cw = +W, chh = +H, sc = +S;
const { w, h, ch, stride, img } = decode(inF);
const ow = cw * sc, oh = chh * sc;
const ostride = ow * 3;
const raw = Buffer.alloc(oh * (ostride + 1));
let p = 0;
for (let y = 0; y < oh; y++) {
  raw[p++] = 0;
  for (let x = 0; x < ow; x++) {
    const sx = Math.min(w - 1, Math.max(0, x0 + Math.floor(x / sc)));
    const sy = Math.min(h - 1, Math.max(0, y0 + Math.floor(y / sc)));
    const i = sy * stride + sx * ch;
    raw[p++] = img[i]; raw[p++] = img[i + 1]; raw[p++] = img[i + 2];
  }
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}
let T = null;
function crc32(buf) {
  if (!T) { T = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; T[n] = c; } }
  let c = -1; for (let i = 0; i < buf.length; i++) c = T[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return c ^ -1;
}
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(ow, 0); ihdr.writeUInt32BE(oh, 4); ihdr[8] = 8; ihdr[9] = 2;
fs.writeFileSync(outF, Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
]));
console.log(`WROTE ${outF} ${ow}x${oh}`);
