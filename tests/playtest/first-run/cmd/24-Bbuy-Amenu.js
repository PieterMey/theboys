const A = P.A.page, B = P.B.page;
const out = {};
// B buys bottles
const buys = B.locator('.m-screen button', { hasText: 'BUY' });
out.nBuy = await buys.count();
await buys.nth(2).click();
await h.sleep(1200);
out.afterBuy = await B.evaluate(() => document.querySelector('.m-screen')?.innerText?.match(/SPENDABLE SCRIP\s*\n?\s*(\d+)/)?.[1] + ' | gear: ' + (document.querySelector('.m-screen')?.innerText?.split('YOUR GEAR')[1]?.split('COMPANY ISSUE')[0]?.trim()));
await h.shot(B, '24-B-shop-after-buy');
out.Btoasts = await B.evaluate(() => [...document.querySelectorAll('.toast, .toasts > *')].map(t => t.textContent).slice(-3));
await h.tap(B, 'Escape'); await h.sleep(500);
// A: real-browser Esc = pointer lock released
await A.evaluate(() => document.exitPointerLock());
await h.sleep(1000);
out.A_screen = (await h.st(A)).screen;
await h.shot(A, '25-A-menu');
out.A_menuText = await A.evaluate(() => document.querySelector('.m-screen')?.innerText?.slice(0, 600));
return out;
