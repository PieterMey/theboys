const A = P.A.page, B = P.B.page;
const t0 = Date.now();
await A.reload({ waitUntil: 'domcontentloaded' });
const out = { B: [] };
// B: approach the mirror from other angles
const tgt = () => B.evaluate(() => window.__ix.ui().target);
for (const spot of [[13.6, 10.0], [13.6, 12.4], [14.2, 10.3]]) {
  const w = await h.walkTo(B, spot[0], spot[1], 0.15, 8);
  const q = await B.evaluate(() => window.__players.local());
  const yaw = Math.atan2(13 - q.p[0], 11.2 - q.p[2]);
  const hits = [];
  for (const pitch of [0, -0.4, -0.8]) {
    await B.evaluate(([y, p]) => window.__game.look(y, p), [yaw, pitch]);
    await h.sleep(300);
    const t = await tgt();
    hits.push(`${pitch}:${t ? t.text : '-'}`);
  }
  out.B.push(`spot ${spot} -> at ${q.p[0].toFixed(2)},${q.p[2].toFixed(2)} dist=${Math.hypot(13 - q.p[0], 11.2 - q.p[2]).toFixed(2)} ${hits.join(' ')}`);
}
// A: what does a reload look like?
await A.waitForSelector('form.join', { timeout: 60000 }).catch(() => {});
out.A_joinFormAfter = Date.now() - t0;
const st = await h.st(A);
out.A = { screen: st?.screen, net: st?.net };
await h.shot(A, '11-A-after-reload');
return out;
