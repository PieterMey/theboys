const A = await h.launch('A', 'talk_en.wav');
const t0 = Date.now();
await h.sleep(3000);
const s1 = await h.shot(A.page, '01-A-join-3s');
// wait until Join screen has the form
await A.page.waitForSelector('form.join', { timeout: 60000 });
const tForm = Date.now() - t0;
await h.sleep(4000);
const s2 = await h.shot(A.page, '02-A-join-screen');
const st = await h.st(A.page);
const html = await A.page.evaluate(() => document.querySelector('form.join')?.innerText);
return { tForm, st: st && { phase: st.phase, net: st.net, screen: st.screen, pending: st.pending }, html, console: A.console.slice(0, 30) };
