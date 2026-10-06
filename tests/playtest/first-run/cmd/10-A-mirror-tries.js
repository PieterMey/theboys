const pg = P.A.page;
const res = [];
const tgt = () => pg.evaluate(() => window.__ix.ui().target);
// natural attempts: stand where we can, look at the mirror at eye level, slightly down, way down
for (const spot of [[14.0, 10.6], [13.9, 11.9], [14.3, 11.2]]) {
  const w = await h.walkTo(pg, spot[0], spot[1], 0.2, 6);
  const q = await h.pose(pg);
  const yaw = Math.atan2(13 - q.x, 11.2 - q.z);
  for (const pitch of [0, -0.3, -0.7]) {
    await pg.evaluate(([y, p]) => window.__game.look(y, p), [yaw, pitch]);
    await h.sleep(350);
    const t = await tgt();
    res.push(`at (${q.x.toFixed(2)},${q.z.toFixed(2)}) pitch=${pitch}: target=${t ? t.text ?? JSON.stringify(t) : 'none'} | ${w.slice(0, 40)}`);
  }
}
return res;
