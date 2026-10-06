const A = P.A.page, B = P.B.page;
const out = { w: [] };
await B.mouse.click(1000, 450); await h.sleep(300);
const [wa, wb] = await Promise.all([
  (async () => { const r = []; r.push(await h.walkTo(A, 18.0, 27.5, 0.3)); r.push(await h.walkTo(A, 17.9, 29.4, 0.3)); return r; })(),
  (async () => { const r = []; r.push(await h.walkTo(B, 18.6, 27.5, 0.3)); r.push(await h.walkTo(B, 18.5, 28.8, 0.3)); return r; })(),
]);
out.w = [wa, wb];
const q = await A.evaluate(() => window.__players.local());
await A.evaluate(([y]) => window.__game.look(y, -0.2), [Math.atan2(17.18 - q.p[0], 29.75 - q.p[2])]);
await h.sleep(500);
out.target = await A.evaluate(() => window.__ix.ui().target);
await h.shot(A, '37-A-leave-lever');
await h.tap(A, 'KeyE');
await h.sleep(800);
out.afterE = await A.evaluate(() => ({ target: window.__ix.ui().target, msg: document.querySelector('.ix-msg')?.textContent ?? null, screen: window.__game.state().screen, phase: window.__game.state().phase }));
// hold E too in case it is a hold interaction
if (out.afterE.phase === 'contract') { await h.hold(A, 'KeyE', 2500); await h.sleep(800); out.afterHold = await A.evaluate(() => ({ msg: document.querySelector('.ix-msg')?.textContent ?? null, screen: window.__game.state().screen, phase: window.__game.state().phase })); }
return out;
