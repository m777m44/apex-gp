/**
 * HUD ink audit. Splits a crop into PLATE (dark, the panel material) and INK
 * (bright, the type and graphics) and reports each separately.
 *
 * The point: `compare.mjs` measures saturation as (max-min)/max, which on a
 * near-black blue-tinted plate is enormous and meaningless — (13,17,22) scores
 * 0.41. Letting more world through a panel therefore LOWERS mean saturation
 * without any hue moving at all. Ink saturation is the number that would change
 * if a colour had actually drifted.
 *
 *   node tools/_hudink.mjs a.png b.png [lumaSplit]
 */
import { execFileSync } from 'node:child_process';

const [A, B, SPLIT = '70'] = process.argv.slice(2);
const split = parseFloat(SPLIT);

function load(path) {
  const meta = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path]).toString().trim();
  const [w, h] = meta.split(',').map(Number);
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-f', 'rawvideo',
    '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 30 });
  return { w, h, buf };
}

function stats(img) {
  const out = { plate: { r: 0, g: 0, b: 0, s: 0, n: 0 }, ink: { r: 0, g: 0, b: 0, s: 0, n: 0 } };
  for (let i = 0; i < img.buf.length; i += 3) {
    const r = img.buf[i], g = img.buf[i + 1], b = img.buf[i + 2];
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const t = L >= split ? out.ink : out.plate;
    t.r += r; t.g += g; t.b += b; t.s += mx === 0 ? 0 : (mx - mn) / mx; t.n++;
  }
  for (const k of ['plate', 'ink']) {
    const t = out[k];
    const n = t.n || 1;
    out[k] = { rgb: [t.r / n, t.g / n, t.b / n].map((v) => v.toFixed(1)).join('/'), sat: ((t.s / n) * 100).toFixed(1), pct: ((t.n / (img.buf.length / 3)) * 100).toFixed(1) };
  }
  return out;
}

for (const [tag, p] of [['BEFORE', A], ['AFTER ', B]]) {
  const s = stats(load(p));
  console.log(`${tag} ${p}`);
  console.log(`   plate  rgb ${s.plate.rgb}  sat ${s.plate.sat}%  area ${s.plate.pct}%`);
  console.log(`   ink    rgb ${s.ink.rgb}  sat ${s.ink.sat}%  area ${s.ink.pct}%`);
}
