const p = P.Talker;
await p.page.getByText('ALLOW MICROPHONE', { exact: false }).first().click();
await h.sleep(3500);
const s = await h.shot(p.page, '02-join-after-allow');
const txt = await p.page.evaluate(() => document.querySelector('.voice-join')?.textContent);
const lvl = await h.ev(p.page, () => (window as any).__voiceDebug?.level?.());
const allowBtn = await p.page.evaluate(() => [...document.querySelectorAll('button')].map((b) => b.textContent));
return { s, txt, lvl, allowBtn, errors: p.console.slice(-10) };
