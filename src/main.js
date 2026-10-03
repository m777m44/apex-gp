/**
 * APEX GP — entry point.
 *
 * Boots the engine, installs the loading overlay, and starts the loop.
 * Everything interesting lives in src/core/engine.js; see CONTRACT.md for the
 * module map and the public API of each subsystem.
 */

import * as THREE from 'three';
import { Engine } from './core/engine.js';

// ── `onBeforeCompile` SINGLE-SLOT AUDIT (`?obcaudit=1`) ─────────────────────
//
// `Material.onBeforeCompile` is ONE slot. Thirteen modules in this tree inject
// GLSL through it (livery, wheels, circuit, environment x13, weather, sky), and
// a plain `mat.onBeforeCompile = fn` on a material somebody else already hooked
// silently deletes the earlier injection — no error, no warning, just a shader
// that quietly stops doing half its job. `weather.js` and `wheels.js` chain
// correctly; this flag is how you PROVE the rest do, on the live scene, instead
// of grepping and hoping.
//
// Install a property hook on the prototype BEFORE the engine builds anything,
// so every assignment in the whole boot is seen. Reports every material that was
// written more than once, with both writers' source heads.
if (new URLSearchParams(location.search).get('obcaudit') === '1') {
  const KEY = Symbol('apexOBC');
  // three CALLS `material.onBeforeCompile(...)` unconditionally, so the getter
  // must still hand back the no-op the prototype used to provide.
  const NOOP = THREE.Material.prototype.onBeforeCompile;
  Object.defineProperty(THREE.Material.prototype, 'onBeforeCompile', {
    configurable: true,
    get() { return this[KEY]?.fn ?? NOOP; },
    set(fn) {
      const rec = this[KEY];
      if (rec && rec.fn && fn && !String(fn).includes(String(rec.fn).slice(0, 40))) {
        const chained = String(fn).includes('prev') || String(fn).includes('chained');
        (chained ? console.info : console.error)(
          `[obcaudit] ${chained ? 'chained' : 'CLOBBERED'} on "${this.name || this.type}" (${this.uuid.slice(0, 8)})\n`
          + `  first: ${String(rec.fn).replace(/\s+/g, ' ').slice(0, 110)}\n`
          + `  then : ${String(fn).replace(/\s+/g, ' ').slice(0, 110)}`);
      }
      Object.defineProperty(this, KEY, { value: { fn }, configurable: true, writable: true });
    },
  });
}

const app = document.getElementById('app');

const overlay = document.createElement('div');
overlay.id = 'apex-loading';
Object.assign(overlay.style, {
  position: 'absolute', inset: '0', display: 'flex', zIndex: '50',
  alignItems: 'center', justifyContent: 'center', flexDirection: 'column',
  background: 'radial-gradient(circle at 50% 45%, #131a24 0%, #05070c 70%)',
  color: '#e8edf3', font: '600 13px/1.6 "Helvetica Neue", Helvetica, Arial, sans-serif',
  letterSpacing: '3px', transition: 'opacity 500ms ease',
});
overlay.innerHTML = `
  <div style="font:800 34px/1 Helvetica,Arial,sans-serif;letter-spacing:10px;margin-bottom:14px">APEX GP</div>
  <div style="opacity:.55">BUILDING CIRCUIT…</div>
`;
app.appendChild(overlay);

const engine = new Engine(app, {
  timeOfDay: 15.2,
  weather: 'dry',
  laps: 24,
  detail: 'high',
});

engine.init().then(() => {
  engine.start();
  overlay.style.opacity = '0';
  setTimeout(() => overlay.remove(), 550);

  // Lightweight on-screen diagnostics: hold TAB.
  const dbg = document.createElement('div');
  Object.assign(dbg.style, {
    position: 'absolute', left: '8px', bottom: '8px', zIndex: '20', display: 'none',
    font: '500 11px/1.5 ui-monospace, Menlo, monospace', color: '#9fe8ff',
    background: 'rgba(5,8,14,.7)', padding: '6px 9px', borderRadius: '4px',
    pointerEvents: 'none', whiteSpace: 'pre',
  });
  app.appendChild(dbg);
  addEventListener('keydown', (e) => { if (e.code === 'Tab') { e.preventDefault(); dbg.style.display = 'block'; } });
  addEventListener('keyup', (e) => { if (e.code === 'Tab') dbg.style.display = 'none'; });
  setInterval(() => {
    if (dbg.style.display === 'none') return;
    const s = engine.stats;
    dbg.textContent =
      `fps      ${s.fps.toFixed(1)}\n` +
      `draws    ${s.drawCalls}\n` +
      `tris     ${(s.triangles / 1000).toFixed(0)}k\n` +
      `sim      ${s.simMs.toFixed(2)} ms\n` +
      `render   ${s.renderMs.toFixed(2)} ms\n` +
      `camera   ${engine.rig.mode}`;
  }, 250);
}).catch((err) => {
  overlay.innerHTML = `<div style="color:#ff6b6b;font:600 13px/1.6 monospace;white-space:pre-wrap;max-width:70ch">${err.stack ?? err}</div>`;
  console.error(err);
});

// Handy for debugging from the console.
window.APEX_ENGINE = engine;
