import { chromium } from 'playwright-core';
const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const b = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-angle=metal','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
const errs = [];
p.on('pageerror', e => errs.push('PAGEERR ' + e.message));
p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text().slice(0,200)); });
await p.goto('http://localhost:5303/?ui=0', { waitUntil: 'load' });
await p.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });
const r = await p.evaluate(() => {
  const api = window.__APEX__, e = api.engine, s = e.session;
  api.pause();
  const out = { sessions: [], vscCheck: null };
  s.beginWeekend('grandPrix');
  for (let seg = 0; seg < 4; seg++) {                 // FP, Q1, Q2, Q3
    const type = s.sessionType;
    let guard = 0;
    while (s.phase !== 'classified' && guard++ < 60 * 60 * 14) e.step(1 / 60);
    const cls = s.classification ?? s.classify();
    out.sessions.push({ type, label: s.def.label, phase: s.phase,
      simMin: +(s.sessionTime / 60).toFixed(2),
      eliminated: [...s.eliminated].length,
      pole: `${cls[0].code} ${cls[0].timeText}`,
      p2: `${cls[1].code} ${cls[1].timeText} ${cls[1].gap.toFixed(3)}`,
      last: `${cls[cls.length-1].code} ${cls[cls.length-1].timeText}`,
      noTime: cls.filter(x => x.timeText === 'NO TIME').length,
      bestSectors: s.bestSectors.map(t => isFinite(t) ? +t.toFixed(3) : null),
      deleted: s.state.reduce((a,x)=>a+x.deletedLaps,0),
      warnings: s.state.reduce((a,x)=>a+x.warnings,0),
      lapsRun: s.state.map(x=>x.lapsDone).reduce((a,b)=>a+b,0),
      gridAfter: s.gridOrder.slice(0,6).map(i => s.state[i].code).join(','),
    });
    if (!s.advanceWeekend()) break;
  }
  // VSC regression: pace must come back after it ends.
  s.beginSession('practice');
  for (let i = 0; i < 300; i++) e.step(1/60);
  const before = e.field.cars[3].ai.persona.paceScale;
  s.deployVSC(2);
  for (let i = 0; i < 60 * 12; i++) e.step(1/60);
  out.vscCheck = { before: +before.toFixed(5), after: +e.field.cars[3].ai.persona.paceScale.toFixed(5),
    vscActive: s.vsc.active, restored: Math.abs(before - e.field.cars[3].ai.persona.paceScale) < 1e-6 };
  return out;
});
console.log(JSON.stringify(r, null, 1));
if (errs.length) console.log('--- ERRORS ---\n' + [...new Set(errs)].slice(0,10).join('\n'));
await b.close();
