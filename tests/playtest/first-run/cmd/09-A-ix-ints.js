const pg = P.A.page;
return await pg.evaluate(() => {
  const st = window.__ix.state();
  const ints = st.ints;
  const arr = Array.isArray(ints) ? ints : Object.entries(ints).map(([k, v]) => ({ key: k, ...v }));
  const pose = window.__game.state().players.find(p => p.id === window.__game.me());
  return { n: arr.length, sample: arr.slice(0, 30), pose };
});
