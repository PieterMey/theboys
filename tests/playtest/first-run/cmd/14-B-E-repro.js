const pg = P.B.page;
const vel = () => pg.evaluate(() => { const d = window.__game.state().diag.players; const p = window.__players.local(); return `vel=${JSON.stringify(d?.vel)} p=${p.p[0].toFixed(2)},${p.p[2].toFixed(2)} yaw=${p.yaw.toFixed(2)} pitch=${p.pitch.toFixed(2)}`; });
const log = [];
await pg.evaluate(() => window.__game.look(-Math.PI / 2, 0));
await h.sleep(300);
log.push('before looks ' + await vel());
for (const [yaw, pitch] of [[-Math.PI/2, -0.15], [-Math.PI/2, -0.35], [-Math.PI/2 + 0.3, -0.2], [-Math.PI/2 - 0.3, -0.2]]) {
  await pg.evaluate(([y, p]) => window.__game.look(y, p), [yaw, pitch]);
  await h.sleep(400);
  log.push(`look ${yaw.toFixed(2)},${pitch} ` + await vel());
}
await pg.evaluate(() => window.__game.look(-Math.PI/2, -0.15));
await h.sleep(300);
await h.tap(pg, 'KeyE');
await h.sleep(600);
log.push('after E ' + await vel());
await h.hold(pg, 'KeyS', 500);
await h.sleep(200);
log.push('after S ' + await vel());
return log;
