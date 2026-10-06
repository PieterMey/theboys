const pg = P.A.page;
await h.sleep(3000);
const s = await h.st(pg);
const items = await pg.evaluate(() => (window).__meta.layoutItems());
const pose = await h.pose(pg);
const ls = await pg.evaluate(() => { const o = {}; for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); o[k] = localStorage.getItem(k).slice(0, 200); } return o; });
const lay = await pg.evaluate(() => { const g = window.__game.state(); return g.layout; });
return { screen: s.screen, phase: s.phase, pose, items, ls, lay, perf: await pg.evaluate(() => window.__game.perf()) };
