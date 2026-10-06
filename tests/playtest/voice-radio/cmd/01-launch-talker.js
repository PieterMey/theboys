const p = await h.launch('Talker', 'talk_en.wav', { crew: 'VRAD' });
await p.page.waitForSelector('.voice-join', { timeout: 60000 });
await h.sleep(2500);
const s1 = await h.shot(p.page, '01-join-screen');
// what does the join-screen mic section show before any click?
const pre = await p.page.evaluate(() => document.querySelector('.voice-join')?.textContent);
return { s1, pre, errors: p.console.slice(-10) };
