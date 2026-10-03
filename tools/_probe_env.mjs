import { chromium } from 'playwright-core';
const b = await chromium.launch({ args: ['--use-gl=angle','--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1600, height: 900 } });
p.on('pageerror', e => console.log('ERR', e.message));
p.on('console', m => { if (m.type()==='error') console.log('C', m.text()); });
await p.goto('http://localhost:5403/?shot=grid', { waitUntil: 'load' });
await p.waitForFunction(() => window.__APEX__ && window.__APEX__.ready, null, { timeout: 180000 });
const out = await p.evaluate(async () => {
  const A = window.__APEX__, e = A.engine;
  await A.capture('grid', 0);
  for (let i=0;i<150;i++) A.renderFrame(i);
  const cv = e.renderer.domElement;
  const c2 = document.createElement('canvas'); c2.width = cv.width; c2.height = cv.height;
  const ctx = c2.getContext('2d'); ctx.drawImage(cv, 0, 0);
  const sx = cv.width/1600, sy = cv.height/900;
  const at = (x,y) => { const d = ctx.getImageData(Math.round(x*sx), Math.round(y*sy), 1,1).data; return [d[0],d[1],d[2]]; };
  // facade pillar, interior, fascia, pit wall, right barrier hoarding, tarmac
  const pts = { facade: [230,430], facade2: [430,420], interior: [380,470], fascia: [300,372],
    pitwall: [430,660], rightBoard: [1300,540], tarmac: [800,700], grassR: [1450,470] };
  const res = {};
  for (const k in pts) res[k] = at(pts[k][0], pts[k][1]);
  // concrete ORM AO channel
  const g = e.scene.getObjectByName('Garages');
  res.aoMapImg = null;
  if (g && g.material.aoMap && g.material.aoMap.image) {
    const im = g.material.aoMap.image;
    const cc = document.createElement('canvas'); cc.width = 32; cc.height = 32;
    const cx = cc.getContext('2d');
    try { cx.drawImage(im, 0, 0, 32, 32); const d = cx.getImageData(0,0,32,32).data;
      let r=0,gg=0,bb=0; for(let i=0;i<d.length;i+=4){r+=d[i];gg+=d[i+1];bb+=d[i+2];}
      const n=d.length/4; res.aoMapImg=[r/n|0,gg/n|0,bb/n|0]; } catch(err) { res.aoErr = String(err); }
  }
  res.aoIntensity = g ? g.material.aoIntensity : null;
  res.vc = g ? g.material.vertexColors : null;
  return res;
});
console.log(JSON.stringify(out));
await b.close();
