const A = P.A.page;
await h.tap(A, 'KeyB');
await h.sleep(1200);
const out = { screen: (await h.st(A)).screen };
await h.shot(A, '19-A-board');
out.text = await A.evaluate(() => document.querySelector('.m-screen')?.innerText?.slice(0, 3000));
out.buttons = await A.evaluate(() => [...document.querySelectorAll('.m-screen button')].map(b => `${b.textContent.trim()}${b.disabled ? ' (disabled)' : ''}`));
return out;
