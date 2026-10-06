const pg = P.B.page;
await pg.mouse.click(1000, 450);
await h.sleep(400);
const vel = () => pg.evaluate(() => { const d = window.__game.state().diag.players; const p = window.__players.local(); return `vel=${JSON.stringify(d?.vel)} p=${p.p[0].toFixed(2)},${p.p[2].toFixed(2)} yaw=${p.yaw.toFixed(2)}`; });
const log = [];
log.push('start ' + await vel());
log.push(await h.walkTo(pg, 14.9, 10.0, 0.4));
log.push('mid ' + await vel());
// step toward the mirror in small presses, sampling velocity each time
for (let i = 0; i < 8; i++) {
  const q = await pg.evaluate(() => window.__players.local());
  const yaw = Math.atan2(13.9 - q.p[0], 11.2 - q.p[2]);
  await pg.evaluate(([y]) => window.__game.look(y, 0), [yaw]);
  await pg.keyboard.down('KeyW');
  await h.sleep(250);
  log.push(`press${i} during ` + await vel());
  await pg.keyboard.up('KeyW');
  await h.sleep(150);
  log.push(`press${i} after ` + await vel());
}
return log;
