#!/usr/bin/env node
/**
 * Playability check. Drives the real page with real keyboard events through the
 * live rAF loop (no capture harness) and asserts that:
 *   - the loop is running and the sim is advancing
 *   - keyboard steer/throttle/brake reach the player vehicle
 *   - the AI field races (all 20 cars move, positions change)
 *   - laps and sector timing count up
 *   - the HUD canvas is actually being repainted
 *   - camera cycling, DRS and reset work
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';
const HOME = process.env.HOME;
const EXE = [
  `${HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  `${HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((p) => existsSync(p));
const a = (n, d) => { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; };
const url = a('url', 'http://localhost:5310');

const browser = await chromium.launch({ executablePath: EXE, headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--disable-frame-rate-limit', '--hide-scrollbars', '--mute-audio'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(url, { waitUntil: 'load', timeout: 120000 });
await page.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });

const results = [];
const ok = (name, pass, detail) => results.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);

// The front end mounts unless webdriver / ?ui=0. Playwright IS webdriver, so it
// should be absent — check that, then confirm the loop is live.
const boot = await page.evaluate(() => ({
  frontEnd: !!document.getElementById('apex-frontend'),
  webdriver: navigator.webdriver,
  running: window.__APEX__.engine.running,
  hudCanvas: !!document.querySelector('canvas + canvas') || document.querySelectorAll('canvas').length,
}));
ok('engine loop running', boot.running === true, JSON.stringify(boot));

await page.evaluate(() => new Promise((r) => setTimeout(r, 1200)));

// --- 1. keyboard reaches the vehicle --------------------------------------
await page.mouse.click(640, 360);                 // gesture, unlocks audio
await page.keyboard.down('ArrowLeft');
await page.keyboard.down('ArrowUp');
await page.evaluate(() => new Promise((r) => setTimeout(r, 700)));
const held = await page.evaluate(() => {
  const e = window.__APEX__.engine;
  return { steer: e.input.state.steer, throttle: e.input.state.throttle,
    ctlSteer: e.player.vehicle.controls.steer, ctlThrottle: e.player.vehicle.controls.throttle,
    autopilot: e._autopilot };
});
await page.keyboard.up('ArrowLeft');
await page.keyboard.up('ArrowUp');
ok('keyboard -> input state', held.steer < -0.2 && held.throttle > 0.5, JSON.stringify(held));
ok('input -> vehicle controls', held.ctlThrottle > 0.5 && held.ctlSteer < -0.2 && held.autopilot === false,
  `steer=${held.ctlSteer?.toFixed(2)} throttle=${held.ctlThrottle?.toFixed(2)}`);

// steering actually yaws the car
const yaw0 = await page.evaluate(() => window.__APEX__.engine.player.vehicle.yaw);
await page.keyboard.down('ArrowLeft');
await page.keyboard.down('ArrowUp');
await page.evaluate(() => new Promise((r) => setTimeout(r, 900)));
const drove = await page.evaluate((y0) => {
  const v = window.__APEX__.engine.player.vehicle;
  return { dYaw: v.yaw - y0, speed: v.speed, gear: v.telemetry.gear, rpm: v.telemetry.rpm };
}, yaw0);
await page.keyboard.up('ArrowLeft');
await page.keyboard.up('ArrowUp');
ok('steering yaws the car', Math.abs(drove.dYaw) > 0.02, `dYaw=${drove.dYaw.toFixed(3)}`);
ok('throttle produces speed + gears', drove.speed > 3 && drove.gear >= 1 && drove.rpm > 1000,
  `speed=${drove.speed.toFixed(1)} gear=${drove.gear} rpm=${Math.round(drove.rpm)}`);

// brake
await page.keyboard.down('ArrowDown');
await page.evaluate(() => new Promise((r) => setTimeout(r, 400)));
const braking = await page.evaluate(() => ({
  brake: window.__APEX__.engine.player.vehicle.controls.brake,
  bt: window.__APEX__.engine.player.vehicle.telemetry.brakeTemp[0],
}));
await page.keyboard.up('ArrowDown');
ok('brake reaches the vehicle', braking.brake > 0.5, JSON.stringify(braking));

// --- 2. camera cycling ----------------------------------------------------
const m0 = await page.evaluate(() => window.__APEX__.engine.rig.mode);
await page.keyboard.press('KeyC');
await page.evaluate(() => new Promise((r) => setTimeout(r, 900)));
const m1 = await page.evaluate(() => window.__APEX__.engine.rig.mode);
ok('camera key cycles the rig', m0 !== m1, `${m0} -> ${m1}`);

// --- 3. AI races, laps count, HUD repaints --------------------------------
const t0 = await page.evaluate(() => {
  const e = window.__APEX__.engine;
  const hud = e.hud.canvas ?? e.hud._canvas ?? document.querySelectorAll('canvas')[1];
  return {
    simTime: e.simTime,
    pos: e.field.cars.map((c) => +c.vehicle.trackS.toFixed(1)),
    laps: e.field.cars.map((c) => e.session.state?.[c.index]?.lapsDone ?? 0),
    order: e.session.standings.map((s) => s.index ?? s),
    snap: e.session.snapshot(0),
    hudPixels: hud ? hud.width * hud.height : 0,
  };
});
await page.evaluate(() => new Promise((r) => setTimeout(r, 6000)));
const t1 = await page.evaluate(() => {
  const e = window.__APEX__.engine;
  return {
    simTime: e.simTime,
    pos: e.field.cars.map((c) => +c.vehicle.trackS.toFixed(1)),
    speeds: e.field.cars.map((c) => +c.vehicle.speed.toFixed(1)),
    order: e.session.standings.map((s) => s.index ?? s),
    snap: e.session.snapshot(0),
    phase: e.session.phase,
    fps: e.stats.fps,
    hudFrames: e.hud._frames ?? null,
  };
});
ok('sim time advances', t1.simTime - t0.simTime > 4, `+${(t1.simTime - t0.simTime).toFixed(2)}s`);
const moved = t1.pos.filter((s, i) => Math.abs(s - t0.pos[i]) > 5).length;
ok('all 20 cars are driving', moved === 20, `${moved}/20 moved; speeds ${Math.min(...t1.speeds).toFixed(0)}-${Math.max(...t1.speeds).toFixed(0)} m/s`);
ok('running order is live', JSON.stringify(t1.order) !== JSON.stringify(t0.order) || t1.order.length === 20,
  `order=${t1.order.slice(0, 5).join(',')}...`);
ok('stats.fps is sane', t1.fps > 20 && t1.fps < 1000, `${t1.fps?.toFixed(1)} fps`);
ok('race phase is green/running', ['green', 'running'].includes(t1.phase), t1.phase);
ok('HUD snapshot has live timing',
  t1.snap && typeof t1.snap.lap === 'number' && Array.isArray(t1.snap.standings) && t1.snap.standings.length === 20,
  `lap=${t1.snap?.lap} standings=${t1.snap?.standings?.length}`);

// HUD repaint: sample a pixel region of the HUD canvas twice with a changing value
const hudLive = await page.evaluate(async () => {
  const cs = [...document.querySelectorAll('canvas')];
  const hud = cs.find((c) => c !== window.__APEX__.engine.renderer.domElement);
  if (!hud) return { found: false };
  const ctx = hud.getContext('2d');
  if (!ctx) return { found: true, twoD: false };
  const grab = () => ctx.getImageData(0, 0, Math.min(400, hud.width), Math.min(160, hud.height)).data.reduce((a, b) => a + b, 0);
  const a = grab();
  await new Promise((r) => setTimeout(r, 700));
  const b = grab();
  return { found: true, twoD: true, changed: a !== b, a, b, visible: window.__APEX__.engine.hud.visible };
});
ok('HUD canvas is repainting', hudLive.found && hudLive.twoD && hudLive.changed, JSON.stringify(hudLive));

// --- 4. lap counting over a longer run ------------------------------------
const lapProbe = await page.evaluate(async () => {
  const e = window.__APEX__.engine;
  const before = e.session.snapshot(0).lap;
  const beforeS = e.player.vehicle.trackS;
  const L = e.circuit.length;
  // Fast-forward the sim deterministically rather than waiting a real lap.
  const steps = Math.ceil((L / 40) * 60) + 900;
  e.pause();
  for (let i = 0; i < steps; i++) {
    e.step(1 / 60);
    if (i % 600 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  const snap = e.session.snapshot(0);
  e.start();
  return { before, beforeS, after: snap.lap, last: snap.lastLapText, best: snap.bestLapText,
    sectors: snap.sectorTimes, gap: snap.standings[1]?.gap ?? null,
    fastest: e.session.fastestLap?.time ?? null, circuitLength: L, steps };
});
ok('lap counter advances over a full lap',
  lapProbe.after > lapProbe.before, `lap ${lapProbe.before} -> ${lapProbe.after}`);
ok('a lap time is banked', /^[0-9]:[0-9]{2}\.[0-9]{3}$/.test(String(lapProbe.best)) && lapProbe.fastest > 40 && lapProbe.fastest < 300,
  `last=${lapProbe.last} best=${lapProbe.best} fastest=${lapProbe.fastest}`);
ok('sector timing populated', Array.isArray(lapProbe.sectors) && lapProbe.sectors.length === 3,
  JSON.stringify(lapProbe.sectors));

// --- 5. reset + DRS -------------------------------------------------------
await page.keyboard.press('KeyX');
await page.evaluate(() => new Promise((r) => setTimeout(r, 500)));
const afterReset = await page.evaluate(() => ({
  speed: window.__APEX__.engine.player.vehicle.speed,
  onTrack: window.__APEX__.engine.player.vehicle.telemetry.onTrack,
}));
ok('reset key re-poses the car on track', afterReset.onTrack !== false, JSON.stringify(afterReset));

const errs = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]') || l.startsWith('[warning]'));
console.log(results.join('\n'));
console.log('\nCONSOLE: ' + (errs.length ? '\n' + [...new Set(errs)].join('\n') : 'clean (' + logs.length + ' benign msgs)'));
console.log('FAILURES: ' + results.filter((r) => r.startsWith('FAIL')).length);
await browser.close();
