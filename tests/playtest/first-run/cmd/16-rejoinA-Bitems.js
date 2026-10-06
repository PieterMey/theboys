const A = P.A.page, B = P.B.page;
await A.getByRole('button', { name: 'JOIN CREW' }).click();
const out = { B: [] };
const tgt = () => B.evaluate(() => window.__ix.ui().target);
const tryItem = async (label, stand, item) => {
  const w = await h.walkTo(B, stand[0], stand[1], 0.2, 8);
  const q = await B.evaluate(() => window.__players.local());
  const yaw = Math.atan2(item[0] - q.p[0], item[1] - q.p[2]);
  const hits = [];
  for (const pitch of [0, -0.25, -0.6]) {
    await B.evaluate(([y, p]) => window.__game.look(y, p), [yaw, pitch]);
    await h.sleep(300);
    const t = await tgt();
    hits.push(`${pitch}:${t ? t.text : '-'}`);
  }
  await B.evaluate(([y]) => window.__game.look(y, 0), [yaw]);
  await h.sleep(200);
  await h.tap(B, 'KeyE');
  await h.sleep(900);
  const scr = (await h.st(B)).screen;
  out.B.push(`${label}: at ${q.p[0].toFixed(2)},${q.p[2].toFixed(2)} dist=${Math.hypot(item[0] - q.p[0], item[1] - q.p[2]).toFixed(2)} ${hits.join(' ')} | E(eye level) -> screen=${scr}`);
  if (scr !== 'none') { await h.shot(B, `12-B-${label}-screen`); await h.tap(B, 'Escape'); await h.sleep(600); await B.mouse.click(1000, 450); await h.sleep(300); }
};
await B.mouse.click(1000, 450); await h.sleep(300);
await tryItem('board', [15.5, 11.6], [16.27, 11.6]);
await tryItem('console', [15.0, 11.7], [15.0, 12.645]);
await tryItem('shop', [16.6, 13.4], [17.4, 13.9]);
for (let i = 0; i < 80; i++) { await h.sleep(500); const s = await h.st(A); if (s?.screen !== 'join') break; }
await h.sleep(1500);
out.A = (await h.st(A)).screen;
return out;
