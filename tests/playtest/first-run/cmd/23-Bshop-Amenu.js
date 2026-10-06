const A = P.A.page, B = P.B.page;
const out = { B: [] };
// A: close board, open menu with Esc
await h.tap(A, 'Escape'); await h.sleep(600);
out.A_afterEsc1 = (await h.st(A)).screen;
await A.mouse.click(1000, 450); await h.sleep(500);
await h.tap(A, 'Escape'); await h.sleep(900);
out.A_afterEsc2 = (await h.st(A)).screen;
await h.shot(A, '21-A-menu-howto');
// B: walk to the shop
const tgt = () => B.evaluate(() => window.__ix.ui().target);
out.B.push(await h.walkTo(B, 9.0, 9.0, 0.5));
out.B.push(await h.walkTo(B, 15.0, 7.6, 0.5));
out.B.push(await h.walkTo(B, 18.3, 9.0, 0.5));
out.B.push(await h.walkTo(B, 18.3, 13.9, 0.3));
const q = await B.evaluate(() => window.__players.local());
await B.evaluate(([y]) => window.__game.look(y, -0.2), [Math.atan2(17.4 - q.p[0], 13.9 - q.p[2])]);
await h.sleep(500);
out.B_target = await tgt();
out.B_pos = q.p;
await h.shot(B, '22-B-at-shop');
await h.tap(B, 'KeyE'); await h.sleep(1000);
out.B_screen = (await h.st(B)).screen;
if (out.B_screen === 'shop') { await h.shot(B, '23-B-shop'); out.shopText = await B.evaluate(() => document.querySelector('.m-screen')?.innerText?.slice(0, 1500)); }
return out;
