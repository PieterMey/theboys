const p = P.Talker;
await p.page.getByRole('button', { name: 'JOIN CREW' }).click();
const t0 = Date.now();
let s;
for (let i = 0; i < 120; i++) {
  s = await h.st(p.page);
  if (s && s.net === 'joined' && s.screen !== 'join') break;
  await h.sleep(500);
}
await h.sleep(1500);
s = await h.st(p.page);
const shot = await h.shot(p.page, '03-after-join');
return { t: (Date.now() - t0) / 1000, net: s.net, screen: s.screen, phase: s.phase, me: s.me, crew: s.crew && s.crew.code, voice: s.diag && s.diag.voice, errors: p.console.filter((l) => !/\[render\]/.test(l)).slice(-10) };
