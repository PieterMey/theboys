const A = P.A.page, B = P.B.page;
await h.tap(A, 'Escape'); await h.sleep(600);
const out = { Ascreen: (await h.st(A)).screen };
await B.mouse.click(1000, 450); await h.sleep(300);
out.w = [];
out.w.push(await h.walkTo(B, 18.3, 8.5, 0.5));
out.w.push(await h.walkTo(B, 14.0, 7.4, 0.5));
out.w.push(await h.walkTo(B, 11.6, 8.6, 0.4));
const qa = (await A.evaluate(() => window.__players.local())).p;
const qb = (await B.evaluate(() => window.__players.local())).p;
await B.evaluate(([y]) => window.__game.look(y, -0.05), [Math.atan2(qa[0] - qb[0], qa[2] - qb[2])]);
// A turns to face B
await A.evaluate(([y]) => window.__game.look(y, 0), [Math.atan2(qb[0] - qa[0], qb[2] - qa[2])]);
await h.sleep(1200);
await h.shot(B, '31-B-sees-Ann');
out.dist = Math.hypot(qa[0] - qb[0], qa[2] - qb[2]);
return out;
