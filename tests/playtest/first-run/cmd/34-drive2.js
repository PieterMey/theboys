const A = P.A.page, B = P.B.page;
const out = { log: [] };
const t0 = Date.now();
const L = (s) => out.log.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s}`);
await A.getByRole('button', { name: /BACK TO THE VAN/ }).click().catch((e) => L('A back err ' + e.message));
await B.getByRole('button', { name: /BACK TO THE VAN/ }).click().catch((e) => L('B back err ' + e.message));
for (let i = 0; i < 40; i++) { await h.sleep(250); const s = await h.st(A); if (s.phase === 'hub' && s.screen === 'none') break; }
L('A in hub: ' + (await h.st(A)).screen);
await h.sleep(1500);
L('A hub screen after 1.5s: ' + (await h.st(A)).screen);
await h.tap(A, 'KeyB'); await h.sleep(1000);
await A.mouse.click(420, 225); await h.sleep(800);
await h.tap(A, 'Escape'); await h.sleep(400);
await h.tap(A, 'KeyR'); await h.sleep(300);
await h.tap(B, 'KeyR');
const texts = [];
let first = 0, last = 0;
for (let i = 0; i < 120; i++) {
  await h.sleep(250);
  const s = await A.evaluate(() => ({ ph: window.__game.state().phase, scr: window.__game.state().screen, txt: document.querySelector('.m-drive')?.innerText ?? null }));
  if (s.scr === 'drive') { if (!first) first = Date.now(); last = Date.now(); if (texts.length === 0 || i % 4 === 0) texts.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${s.txt?.replace(/\n+/g, ' | ').slice(0, 1600)}`); }
  if (s.ph === 'contract' && s.scr === 'none') break;
}
out.driveVisibleSec = first ? ((last - first) / 1000).toFixed(1) : 'never';
out.texts = texts.slice(0, 3).concat(texts.slice(-1));
return out;
