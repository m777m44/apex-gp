#!/usr/bin/env node
/**
 * Stray-backtick detector for GLSL template literals across src/.
 * Exits 1 and prints file:line for any backtick that appears INSIDE a
 * `/* glsl *\/` template literal — the failure mode that has broken the build
 * twice (a backticked identifier in a shader comment terminates the string).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../src', import.meta.url).pathname;
const files = [];
(function walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js')) files.push(p);
  }
})(root);

let bad = 0;
const OPEN = '/* glsl */ ' + String.fromCharCode(96);
for (const f of files) {
  const lines = readFileSync(f, 'utf8').split('\n');
  let inside = false;
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    if (!inside) { if (L.includes(OPEN)) inside = true; continue; }
    const n = (L.match(new RegExp(String.fromCharCode(96), 'g')) || []).length;
    if (n === 0) continue;
    // A line that is EXACTLY the closer legitimately ends the literal.
    if (L.trim() === String.fromCharCode(96) + ';' || L.trim() === String.fromCharCode(96)) { inside = false; continue; }
    console.log(`${f.replace(root, 'src')}:${i + 1}: stray backtick in GLSL literal -> ${L.trim().slice(0, 90)}`);
    bad++;
    inside = false;
  }
}
if (!bad) console.log('clean');
process.exit(bad ? 1 : 0);
