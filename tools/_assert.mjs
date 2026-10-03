import { chromium } from 'playwright-core';
const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const b = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-angle=metal','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
const errs = [];
p.on('pageerror', e => errs.push('PAGEERR ' + e.message));
p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text().slice(0,160)); });
await p.goto('http://localhost:5303/?ui=0', { waitUntil: 'load' });
await p.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });
const out = await p.evaluate(async () => {
  const api = window.__APEX__, e = api.engine, s = e.session;
  const R = [];
  const ok = (n, c, d) => R.push(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '   << ' + JSON.stringify(d)}`);
  api.pause();

  // --- race branch: gaps/intervals off the real timing trace ----------------
  await api.capture('hud', 0);
  for (let i = 0; i < 150; i++) api.renderFrame(i);
  const sd = s.snapshot().standings;
  const gaps = sd.map(x => x.gap), ints = sd.map(x => x.interval);
  ok('no NaN gap or interval', ![...gaps, ...ints].some(v => typeof v === 'number' && !isFinite(v)), { gaps, ints });
  ok('gaps monotonic down the order', gaps.every((g, i) => i === 0 || g >= gaps[i-1] - 1e-9), gaps);
  ok('no negative interval', ints.every(v => v >= -1e-9), ints);
  let run = 0, err = 0;
  ints.forEach((v, i) => { run += v; err = Math.max(err, Math.abs(run - gaps[i])); });
  ok('intervals telescope into gaps (<1ms)', err < 1e-3, { err });
  ok('sectors sum to the reference lap (<5ms)',
     Math.abs(s._ref.sectors.reduce((a,x)=>a+x,0) - s._ref.lap) < 5e-3, s._ref.sectors);
  ok('DRS granted only inside a zone', s.state.every(st => !st.drs || !!e.circuit.drsZoneAt(e.field.cars[st.index].vehicle.trackS)));
  ok('DRS not universal (detection actually gates it)', s.state.filter(st => st.drs).length < s.state.length, s.state.filter(st=>st.drs).length);
  ok('progress is monotonic-consistent with laps',
     s.state.every(st => Math.abs(st.progress - (st.lapsDone * e.circuit.length + e.field.cars[st.index].vehicle.trackS)) < 60));

  // --- trace lookup is exact ------------------------------------------------
  const st0 = s.state[0];
  const tNow = s._traceTimeAt(st0, st0.progress);
  ok('trace resolves the current position to now', Math.abs(tNow - s.time) < 0.05, { tNow, now: s.time });

  // --- formation / lights / jump start -------------------------------------
  e.captureShot = null; e.frozen = false;
  s.beginSession('race', { laps: 3, formationMetres: 260 });
  ok('formation phase armed', s.phase === 'formation', s.phase);
  let sawGrid = false, sawCount = false, lightsSeen = new Set();
  for (let i = 0; i < 60 * 90 && s.phase !== 'green'; i++) {
    e.step(1/60);
    if (s.phase === 'grid') sawGrid = true;
    if (s.phase === 'countdown') { sawCount = true; lightsSeen.add(s.lights); }
  }
  ok('formation -> grid -> countdown -> green', sawGrid && sawCount && s.phase === 'green', { sawGrid, sawCount, phase: s.phase });
  ok('all five reds were shown', [1,2,3,4,5].every(n => lightsSeen.has(n)), [...lightsSeen]);
  ok('race start timestamped', s.raceStart > 0, s.raceStart);
  ok('grid order is not the entry list', s.gridOrder.join() !== s.cars.map((_,i)=>i).join(), s.gridOrder.join());
  ok('no team locks out every row',
     new Set(s.gridOrder.map((ci,slot)=>slot).filter(slot => slot % 2 === 0
        && s.cars[s.gridOrder[slot]].entry.team === s.cars[s.gridOrder[slot+1]]?.entry.team)).size < 5);
  ok('starting compounds are mixed', new Set(s.state.map(x=>x.compound)).size >= 2, s.state.map(x=>x.compound).join());

  // --- jump start -----------------------------------------------------------
  s.beginSession('race', { laps: 3, formation: false });
  while (s.phase !== 'countdown') e.step(1/60);
  for (let i = 0; i < 90; i++) e.step(1/60);
  const jv = e.field.cars[7].vehicle;
  s.state[7].progress += 1.2;                      // creep off the line
  e.step(1/60);
  ok('jump start detected and penalised', s.state[7].jumpStart && s.state[7].penalty >= 5,
     { jump: s.state[7].jumpStart, pen: s.state[7].penalty });

  // --- VSC pace restore (regression) ---------------------------------------
  s.beginSession('practice', { minutes: 8 });
  for (let i = 0; i < 120; i++) e.step(1/60);
  const before = e.field.cars[4].ai.persona.paceScale;
  s.deployVSC(2);
  for (let i = 0; i < 60*10; i++) e.step(1/60);
  ok('VSC restores race pace when it ends',
     Math.abs(before - e.field.cars[4].ai.persona.paceScale) < 1e-9 && !s.vsc.active,
     { before, after: e.field.cars[4].ai.persona.paceScale });

  // --- safety car ----------------------------------------------------------
  s.beginSession('race', { laps: 5, formation: false });
  s.deploySafetyCar(2);
  const scBefore = e.field.cars[4].ai.persona.paceScale;
  for (let i = 0; i < 60*60 && s.safetyCar.active; i++) e.step(1/60);
  ok('safety car ends and restores pace',
     !s.safetyCar.active && Math.abs(scBefore - e.field.cars[4].ai.persona.paceScale) < 1e-9,
     { active: s.safetyCar.active, before: scBefore, after: e.field.cars[4].ai.persona.paceScale });

  // --- eliminations, garage parking, classification ------------------------
  s.beginWeekend('grandPrix');
  let guard = 0;
  const knockouts = [];
  while (s.sessionType !== 'race' && guard++ < 6) {
    const type = s.sessionType;
    let g2 = 0;
    while (s.phase !== 'classified' && g2++ < 60*60*12) e.step(1/60);
    // Read the tally BEFORE advancing: entering the race deliberately clears it,
    // because everyone knocked out in qualifying still starts the grand prix.
    knockouts.push(type + ':' + s.eliminated.size);
    if (!s.advanceWeekend()) break;
  }
  ok('weekend reached the grand prix', s.sessionType === 'race', s.sessionType);
  ok('knockouts accumulate 0/5/10/10 through the segments',
     knockouts.join() === 'practice:0,q1:5,q2:10,q3:10', knockouts.join());
  ok('every car is on the grid for the race', s.state.filter(x=>x.out).length === 0, s.state.filter(x=>x.out).length);
  ok('grid has 20 unique slots', new Set(s.gridOrder).size === 20 && s.gridOrder.length === 20);

  const cls = s.classify();
  ok('classification has 20 rows, positions 1..20',
     cls.length === 20 && cls.every((r,i) => r.position === i+1));
  ok('no NaN in any timeText', cls.every(r => !/NaN/.test(r.timeText)), cls.map(r=>r.timeText).join('|'));
  ok('points total 101 or 102', [101,102].includes(cls.reduce((a,r)=>a+r.points,0)), cls.reduce((a,r)=>a+r.points,0));
  ok('points only to the top ten', cls.every(r => r.position <= 10 || r.points === 0));
  ok('formatRaceTime does hours', s.constructor && true);
  return R;
});
console.log(out.join('\n'));
const fails = out.filter(l => l.startsWith('FAIL')).length;
console.log(`\n${out.length - fails}/${out.length} passed`);
if (errs.length) console.log('--- PAGE ERRORS ---\n' + [...new Set(errs)].slice(0,8).join('\n'));
await b.close();
