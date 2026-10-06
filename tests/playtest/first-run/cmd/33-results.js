const A = P.A.page;
await h.sleep(1500);
await h.shot(A, '38-A-results');
const out = {};
out.text = await A.evaluate(() => document.querySelector('.m-screen')?.innerText?.slice(0, 2000));
out.buttons = await A.evaluate(() => [...document.querySelectorAll('.m-screen button')].map(b => `${b.textContent.trim()}${b.disabled ? ' (disabled)' : ''}`));
return out;
