const A = P.A.page;
await A.mouse.click(1000, 450); await h.sleep(300);
const out = {};
const st = await h.st(A);
out.van = st.objectives?.van ?? null;
out.deposit = st.objectives?.deposit ?? null;
const items = await A.evaluate(() => window.__meta.layoutItems().filter(i => /spawn_player|console|van|deposit|leave/.test(i.kind)));
out.items = items;
for (const [name, yaw] of [['N', 0], ['E', Math.PI / 2], ['W', -Math.PI / 2]]) {
  await A.evaluate(([y]) => window.__game.look(y, 0), [yaw]);
  await h.sleep(700);
  await h.shot(A, `36-A-arrival-look-${name}`);
}
return out;
