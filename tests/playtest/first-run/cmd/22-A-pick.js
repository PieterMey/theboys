const A = P.A.page, B = P.B.page;
await A.mouse.click(420, 225);
await h.sleep(1200);
await h.shot(A, '20-A-board-picked');
const out = {};
out.footer = await A.evaluate(() => [...document.querySelectorAll('.m-screen button')].map(b => `${b.textContent.trim()}${b.disabled ? ' (disabled)' : ''}`));
out.metaPicked = await A.evaluate(() => window.__meta.meta()?.picked);
// B's hub HUD
out.Bhud = await B.evaluate(() => document.querySelector('.m-hud-crew')?.innerText);
// Try clicking a locked card
await A.mouse.click(780, 225);
await h.sleep(800);
out.afterLocked = await A.evaluate(() => window.__meta.meta()?.picked);
out.toasts = await A.evaluate(() => [...document.querySelectorAll('[class*=toast]')].map(t => t.textContent).slice(0, 5));
return out;
