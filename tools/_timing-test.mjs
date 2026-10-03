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
  s.beginSession('practice', { minutes: 9 });
  // `physics/vehicle.js` cannot accelerate from low speed, so any car that slows
  // is stuck for ever. Top the field back up to the AI's own target each frame so
  // race control's TIMING can be validated independently of that fault.
  const prof = e.field.profile, c = e.circuit;
  const laps = [];
  const seen = new Map();
  for (let i = 0; i < 60 * 60 * 10; i++) {
    for (const car of e.field.cars) {
      const v = car.vehicle;
      const tgt = (prof[c.sampleIndex(v.trackS)] ?? 55) * 0.94;
      if (v.speed < tgt * 0.9) { const k = tgt / Math.max(0.2, v.speed); v.u *= k; v.v *= k; }
    }
    e.step(1 / 60);
    for (const st of s.state) {
      const key = st.index + ':' + st.lapsDone;
      if (st.lapsDone > 0 && st.lastLap > 0 && !seen.has(key)) {
        seen.set(key, 1);
        if (st.index === 3) laps.push({ lap: st.lapsDone, t: +st.lastLap.toFixed(3),
          sec: st.lastSectors.map(x => +x.toFixed(3)),
          sum: +st.lastSectors.reduce((a,x)=>a+x,0).toFixed(3),
          status: st.lastSectorStatus.join('|'), valid: !st.lastLapDeleted });
      }
    }
    if (s.phase === 'classified') break;
  }
  const cls = s.classification ?? s.classify();
  const sn = s.snapshot(3);
  const gaps = s.standings.map(x => +x.gap.toFixed(3));
  const ints = s.standings.map(x => +x.interval.toFixed(3));
  // Do the intervals telescope into the gaps?
  let maxTelescopeErr = 0, run = 0;
  for (let i = 0; i < gaps.length; i++) { run += ints[i]; maxTelescopeErr = Math.max(maxTelescopeErr, Math.abs(run - gaps[i])); }
  return {
    lapsOfOKO: laps.slice(0, 8),
    totalLapsRun: s.state.reduce((a,x)=>a+x.lapsDone,0),
    bestSectors: s.bestSectors.map(t => isFinite(t) ? +t.toFixed(3) : null),
    bestSectorSum: +s.bestSectors.reduce((a,x)=>a+(isFinite(x)?x:0),0).toFixed(3),
    bestLapOverall: +s.bestLapOverall.toFixed(3),
    fastestLap: s.fastestLap && { code: s.fastestLap.code, t: +s.fastestLap.time.toFixed(3), lap: s.fastestLap.lap },
    top5: cls.slice(0,5).map(x => `P${x.position} ${x.code} ${x.timeText} gap=${isFinite(x.gap)?x.gap.toFixed(3):'--'} laps=${x.laps}`),
    gapsMonotonic: gaps.every((g,i) => i === 0 || g >= gaps[i-1] - 1e-9),
    maxTelescopeErr: +maxTelescopeErr.toFixed(6),
    anyNegativeInterval: ints.some(x => x < -1e-9),
    deleted: s.state.reduce((a,x)=>a+x.deletedLaps,0),
    warnings: s.state.reduce((a,x)=>a+x.warnings,0),
    snapshotSample: { lap: sn.lap, best: sn.bestLapText, last: sn.lastLapText, sect: sn.sectorTimes.map(x=>+x.toFixed(3)), status: sn.sectorStatus.join('|'), delta: sn.deltaText },
  };
});
console.log(JSON.stringify(r, null, 1));
if (errs.length) console.log('--- ERRORS ---\n' + [...new Set(errs)].slice(0,8).join('\n'));
await b.close();
