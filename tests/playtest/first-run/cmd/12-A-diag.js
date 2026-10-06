const pg = P.A.page;
await pg.keyboard.down('KeyW');
await h.sleep(400);
const d1 = await pg.evaluate(() => JSON.parse(JSON.stringify(window.__game.state().diag.players ?? null)));
await pg.keyboard.up('KeyW');
const keys = await pg.evaluate(() => Object.keys(window.__players ?? {}));
const pose = await pg.evaluate(() => { try { return window.__players?.pose?.() ?? window.__players?.local?.() ?? null; } catch (e) { return String(e); } });
return { d1, keys, pose };
