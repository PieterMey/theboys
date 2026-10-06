const pg = P.A.page;
const res = [];
const lp = () => pg.evaluate(() => { const s = window.__game.state(); const me = s.players.find(p => p.id === s.me); return me.p.map(v => +v.toFixed(2)).join(','); });
const localPose = () => pg.evaluate(() => { try { const pl = window.__render?.three ? null : null; } catch {} return null; });
await pg.evaluate(() => window.__game.look(0, 0));
for (const k of ['KeyW', 'KeyS', 'KeyA', 'KeyD']) {
  const before = await lp();
  await h.hold(pg, k, 700);
  await h.sleep(300);
  res.push(`${k}: ${before} -> ${await lp()}`);
}
res.push('locked=' + await pg.evaluate(() => !!document.pointerLockElement));
res.push('screen=' + (await h.st(pg)).screen);
await pg.evaluate(() => window.__game.look(-Math.PI / 2 + 0.6, -0.1));
await h.sleep(400);
await h.shot(pg, '10-A-stuck-view');
return res;
