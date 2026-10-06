const A = P.A.page, B = P.B.page;
const out = { log: [] };
const t0 = Date.now();
const L = (s) => out.log.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);
await h.tap(A, 'KeyR'); await h.sleep(600);
L('A ready: ' + JSON.stringify((await h.st(A)).crew.players.map(p => `${p.name}:${p.ready}`)));
await h.tap(B, 'KeyR');
let shotDrive = 0, lastPh = '';
for (let i = 0; i < 160; i++) {
  await h.sleep(250);
  const s = await h.st(A);
  const k = `${s.phase}/${s.screen}`;
  if (k !== lastPh) { L(`A ${k}`); lastPh = k; }
  if (s.screen === 'drive' && shotDrive === 0) { shotDrive = 1; await h.sleep(800); await h.shot(A, '32-A-drive-1'); L('drive shot1'); out.driveText = await A.evaluate(() => document.querySelector('.m-screen')?.innerText?.slice(0, 2500)); }
  else if (s.screen === 'drive' && shotDrive === 1 && Date.now() - t0 > 9000) { shotDrive = 2; await h.shot(A, '33-A-drive-2'); L('drive shot2'); }
  if (s.phase === 'contract' && s.screen === 'none') break;
}
L('arrived');
await h.sleep(1500);
await h.shot(A, '34-A-arrival');
await h.shot(B, '35-B-arrival');
const sa = await h.st(A);
out.arrA = { phase: sa.phase, screen: sa.screen, pose: (await A.evaluate(() => window.__players.local())), layout: sa.layout };
out.arrB = await B.evaluate(() => window.__players.local());
out.hud = await A.evaluate(() => [...document.querySelectorAll('.o-hud, [class*=checklist], [class*=o-check], [data-testid*=check]')].map(e => e.innerText).slice(0, 3));
return out;
