import { chromium } from 'playwright-core';
const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const b = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-angle=metal','--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
const errs = [];
p.on('pageerror', e => errs.push('PAGEERR ' + e.message));
p.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text().slice(0,200)); });
await p.goto('http://localhost:5420/?ui=0', { waitUntil: 'load' });
await p.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });
const LAPS = parseInt(process.argv[2] ?? '4', 10);
const r = await p.evaluate(async (LAPS) => {
  const api = window.__APEX__, e = api.engine, s = e.session;
  api.pause();
  s.beginSession('race', { laps: LAPS, formationMetres: 400 });
  const log = [], phases = [], flags = [], samples = [];
  let lastPhase = '', lastFlag = '', deployed = false, pitted = false, thrown = false;
  const err = [];
  const MAX = 60 * 60 * 9;
  for (let i = 0; i < MAX; i++) {
    try { e.step(1 / 60); } catch (x) { err.push('step@' + i + ': ' + x.message); break; }
    if (s.phase !== lastPhase) { lastPhase = s.phase; phases.push(`${s.phase}@${s.time.toFixed(1)}`); }
    if (s.flag !== lastFlag) { lastFlag = s.flag; flags.push(`${s.flag}@${s.time.toFixed(1)}`); }
    for (const m of s.messages) if (!log.includes(m.title)) log.push(m.title);
    const lead = s.standings[0];
    // Exercise the interesting paths once the race is properly under way.
    if (!pitted && lead.lapsDone >= 1) { pitted = true; s.requestPit(s.playerIndex, { compound: 'hard' }); }
    if (!deployed && s.time > 90) { deployed = true; s.deployVSC(12); }
    if (!thrown && lead.lapsDone >= 2) { thrown = true; s.localFlag(1, 'double', 5); }
    if (s.phase === 'classified') break;
    if (i % 1800 === 0) {
      const l = s.standings[0], lc = e.field.cars[l.index];
      samples.push({ t: +s.time.toFixed(0), ph: s.phase, fl: s.flag,
        leadCode: l.code, leadLaps: l.lapsDone, leadS: +lc.vehicle.trackS.toFixed(0),
        leadSpd: +lc.vehicle.speed.toFixed(1), leadPace: +(lc.ai?.persona?.paceScale ?? 0).toFixed(4),
        leadRace: lc.ai?.persona?._racePace ?? null, leadBlue: !!lc.ai?.blueFlag,
        leadThr: +(lc.vehicle.controls.throttle ?? 0).toFixed(2),
        leadLaunch: lc.ai?.launched, leadMode: lc.ai?.mode, leadPit: !!lc.inPit,
        leadTgt: lc.ai?.targetSpeedAt ? +lc.ai.targetSpeedAt(lc.vehicle.trackS).toFixed(1) : null,
        pMoving: e.field.cars.filter(c => c.vehicle.speed > 25).length,
        pPit: e.field.cars.filter(c => c.inPit).length,
        plS: +e.field.cars[s.playerIndex].vehicle.trackS.toFixed(0),
        plSpd: +e.field.cars[s.playerIndex].vehicle.speed.toFixed(1),
        plPitSt: s.state[s.playerIndex].pitState?.phase ?? null });
    }
  }
  const cls = s.classification ?? s.classify();
  const ps = s.state[s.playerIndex];
  return { err, samples, phases, flags, messages: log,
    simSeconds: +s.time.toFixed(1), phase: s.phase,
    playerStops: ps.pitStops, playerCompound: ps.compound, playerLaps: ps.lapsDone,
    playerBest: isFinite(ps.bestLap) ? +ps.bestLap.toFixed(3) : null,
    playerWarnings: ps.warnings, playerDeleted: ps.deletedLaps, playerPenalty: ps.penalty,
    fuelLeft: +ps.fuel.toFixed(1),
    fastestLap: s.fastestLap && { code: s.fastestLap.code, t: +s.fastestLap.time.toFixed(3), lap: s.fastestLap.lap },
    top6: cls.slice(0,6).map(x => `P${x.position} ${x.code} ${x.timeText} best=${x.bestText} stops=${x.stops} pts=${x.points}`),
    tail: cls.slice(-3).map(x => `P${x.position} ${x.code} ${x.timeText}`),
    pointsSum: cls.reduce((a,x)=>a+x.points,0),
    lapsSpread: [Math.min(...cls.map(x=>x.laps)), Math.max(...cls.map(x=>x.laps))],
  };
}, LAPS);
console.log(JSON.stringify(r, null, 1));
if (errs.length) console.log('--- PAGE ERRORS ---\n' + [...new Set(errs)].slice(0,12).join('\n'));
await b.close();
