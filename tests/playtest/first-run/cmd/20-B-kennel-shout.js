const B = P.B.page;
await h.tap(B, 'Escape'); await h.sleep(500);
const out = { scr: (await h.st(B)).screen };
await B.mouse.click(1000, 450); await h.sleep(400);
out.w = [];
out.w.push(await h.walkTo(B, 15.0, 8.0, 0.4));
out.w.push(await h.walkTo(B, 9.0, 9.5, 0.5));
out.w.push(await h.walkTo(B, 5.6, 12.6, 0.4));
const q = await B.evaluate(() => window.__players.local());
await B.evaluate(([y]) => window.__game.look(y, -0.1), [Math.atan2(5.13 - q.p[0], 17.19 - q.p[2])]);
const samp = [];
for (let i = 0; i < 10; i++) {
  await h.sleep(400);
  const m = await B.evaluate(() => window.__game.state().monsters.map(m => `${m.anim}/${(+m.yaw).toFixed(2)}/${m.p.map(v => (+v).toFixed(1)).join(',')}`).join(';'));
  samp.push(`band=${await B.evaluate(() => window.__voiceDebug.band())} hound=${m}`);
  if (i === 4) await h.shot(B, '18-B-shouting-at-kennel');
}
out.samp = samp;
return out;
