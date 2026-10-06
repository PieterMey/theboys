const pg = P.A.page;
const out = {};
out.ui = await pg.evaluate(() => window.__ix?.ui?.());
out.ixKeys = await pg.evaluate(() => Object.keys(window.__ix ?? {}));
// look slightly down / around to see whether any aim finds it
for (const [yaw, pitch] of [[-Math.PI/2, -0.15], [-Math.PI/2, -0.35], [-Math.PI/2 + 0.3, -0.2], [-Math.PI/2 - 0.3, -0.2]]) {
  await pg.evaluate(([y, p]) => window.__game.look(y, p), [yaw, pitch]);
  await h.sleep(400);
  out[`t_${yaw.toFixed(2)}_${pitch}`] = await pg.evaluate(() => window.__ix?.ui?.()?.target ?? null);
}
await pg.evaluate(() => window.__game.look(-Math.PI/2, -0.15));
await h.sleep(300);
await h.tap(pg, 'KeyE');
await h.sleep(1200);
out.screenAfterE = (await h.st(pg)).screen;
await h.shot(pg, '09-A-after-E-mirror');
return out;
