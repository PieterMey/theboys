const ids = h.state.ids;
const out = {};
// 1) Tone2 (no walkie) holds Q near nobody: any radio?
await P.Tone2.page.keyboard.down('q');
await h.sleep(800);
out.tone2 = await h.ev(P.Tone2.page, () => { const s = window.__voiceDebug.service(); return { radio: s.radio(), hud: document.querySelector('[data-testid=ix-radio]')?.textContent ?? null, meter: document.querySelector('[data-testid=band-meter]')?.textContent, hint: [...document.querySelectorAll('*')].filter((e) => e.childElementCount === 0 && /radio|walkie/i.test(e.textContent || '')).map((e) => e.textContent).slice(0, 5) }; });
const m = await h.measure(P.Shouter.page, ids.Tone2, 2500);
out.shouterHearsTone2 = `max ${m.max.toFixed(4)} gate ${m.maxGain.toFixed(2)}`;
out.tone2Shot = await h.shot(P.Tone2.page, '20-tone2-noWalkie-Q');
await P.Tone2.page.keyboard.up('q');
// 2) Talker: hold Q, press Escape (menu), release Q inside the menu, close menu
const t = P.Talker.page;
await t.keyboard.down('q');
await h.sleep(500);
const r0 = await h.ev(t, () => window.__voiceDebug.service().radio());
await h.tap(t, 'Escape');
await h.sleep(800);
const scr = (await h.st(t)).screen;
const menuShot = await h.shot(t, '20-talker-menu-while-tx');
await t.keyboard.up('q');
await h.sleep(500);
const r1 = await h.ev(t, () => ({ radio: window.__voiceDebug.service().radio(), hud: document.querySelector('[data-testid=ix-radio]')?.textContent }));
await h.tap(t, 'Escape');
await h.sleep(800);
const r2 = await h.ev(t, () => ({ radio: window.__voiceDebug.service().radio(), hud: document.querySelector('[data-testid=ix-radio]')?.textContent, screen: window.__game.state().screen }));
out.escWhileTx = { beforeEsc: r0, screenAfterEsc: scr, afterReleaseInMenu: r1, afterMenuClosed: r2, menuShot };
// 3) Talker: hold Q then window blur (alt-tab)
await t.keyboard.down('q');
await h.sleep(400);
await t.evaluate(() => window.dispatchEvent(new Event('blur')));
await h.sleep(400);
const b1 = await h.ev(t, () => ({ radio: window.__voiceDebug.service().radio(), hud: document.querySelector('[data-testid=ix-radio]')?.textContent }));
await t.keyboard.up('q');
out.blurWhileTx = b1;
return out;
