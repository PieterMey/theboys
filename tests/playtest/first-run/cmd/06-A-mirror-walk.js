const pg = P.A.page;
await pg.mouse.click(1000, 450);
await h.sleep(500);
const locked = await pg.evaluate(() => !!document.pointerLockElement);
// walk into the van, toward the mirror at (13, 11.2) on the left wall
const w1 = await h.walkTo(pg, 14.9, 10.0, 0.4);
const w2 = await h.walkTo(pg, 13.9, 11.2, 0.35);
await pg.evaluate(() => window.__game.look(-Math.PI / 2, 0));
await h.sleep(600);
const near = await pg.evaluate(() => window.__meta.near());
const prompt = await pg.evaluate(() => [...document.querySelectorAll('.m-prompt, .ix-prompt, [class*=prompt]')].map(e => e.className + ': ' + e.textContent).slice(0, 5));
await h.shot(pg, '08-A-at-mirror');
return { locked, w1, w2, near, prompt };
