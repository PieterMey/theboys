const A = P.A.page, B = P.B.page;
const out = {};
const sw = A.locator('.m-swatches').nth(0).locator('button');
await sw.nth(2).click(); // primary blue
await h.sleep(300);
await A.locator('.m-swatches').nth(1).locator('button').nth(0).click(); // secondary yellow
await h.sleep(300);
const glyph = A.locator('.m-field:has(label:text("VISOR GLYPHS")) input');
await glyph.click({ clickCount: 3 });
await A.keyboard.type('ann', { delay: 60 });
await h.sleep(300);
await A.locator('.m-swatches').nth(2).locator('button').nth(1).click(); // visor red
await h.sleep(300);
// try a locked helmet
const box = A.locator('.m-opt', { hasText: 'BOX' });
out.boxDisabled = await box.isDisabled();
// typing E/B/R in the glyph field must not trigger game keys
await glyph.click();
await A.keyboard.press('End');
await h.sleep(1500);
await h.shot(A, '30-A-mirror-edited');
out.Aprofile = await A.evaluate(() => { const s = window.__game.state(); return s.crew.players.find(p => p.id === s.me).profile; });
out.BseesA = await B.evaluate(() => { const s = window.__game.state(); return s.crew.players.find(p => p.name === 'Ann')?.profile; });
// B: look at Ann's avatar
const qa = (await A.evaluate(() => window.__players.local())).p;
const qb = (await B.evaluate(() => window.__players.local())).p;
out.posA = qa; out.posB = qb;
return out;
