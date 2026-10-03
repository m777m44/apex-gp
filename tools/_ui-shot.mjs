import { chromium } from 'playwright-core';
const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const b = await chromium.launch({ executablePath: exe, headless: true,
  args: ['--use-angle=metal', '--ignore-gpu-blocklist', '--force-device-scale-factor=1'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
p.on('pageerror', e => console.log('PAGEERR', e.message));
p.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 300)); });
await p.goto('http://localhost:5303/?ui=1', { waitUntil: 'load' });
await p.waitForFunction(() => window.__APEX__?.ready === true, null, { timeout: 120000 });
await p.waitForFunction(() => !!window.__APEX__.engine.session?.frontEnd?._root, null, { timeout: 30000 });
const tag = process.argv[2] ?? 'ui';
const shoot = async (name, prep) => {
  if (prep) await p.evaluate(prep);
  await p.waitForTimeout(1400);
  await p.screenshot({ path: `shots/${tag}-${name}.png` });
  console.log('WROTE', `shots/${tag}-${name}.png`);
};
await shoot('title');
await shoot('setup', () => window.__APEX__.engine.session.frontEnd.show('setup'));
await shoot('settings', () => window.__APEX__.engine.session.frontEnd.show('settings'));
await shoot('pause', () => window.__APEX__.engine.session.frontEnd.show('pause'));
await shoot('results', () => {
  const s = window.__APEX__.engine.session;
  s._bindEngine();
  s.seedReferenceTimes();
  s.state.forEach((st, i) => { st.lapsDone = s.totalLaps; st.finished = true;
    st.finishTime = 100 + st.bestLap * s.totalLaps + i * 1.7; });
  s.raceStart = 100; s.phase = 'finished';
  s.classification = null; s._classify();
  s.frontEnd.show('results');
});
await b.close();
