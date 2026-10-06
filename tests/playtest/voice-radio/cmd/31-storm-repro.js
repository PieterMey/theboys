const ids = h.state.ids;
await h.close('Phone');
const count = (n) => (h.readFileSync(h.join(h.DIR, 'logs', `${n}.console.log`), 'utf8').match(/new remote session -> rebuilding/g) || []).length;
const pre = await h.peers(P.Quiet.page);
const c0 = { Quiet: count('Quiet'), Talker: count('Talker') };
// Talker (smaller id = polite) is busy for 2.5 s (a long frame / shader compile); meanwhile Quiet (impolite) gets two new sessions 600 ms apart
const freeze = P.Talker.page.evaluate(() => { const t = performance.now(); while (performance.now() - t < 2500) { /* busy */ } return true; });
await h.sleep(150);
await h.ev(P.Quiet.page, () => window.__voiceDebug.service().setRelayOnly(true));
await h.sleep(700);
await h.ev(P.Quiet.page, () => window.__voiceDebug.service().setRelayOnly(false));
await freeze;
const tl = [];
for (let i = 0; i < 6; i++) {
  await h.sleep(3000);
  const q = (await h.peers(P.Quiet.page))[ids.Talker];
  const t = (await h.peers(P.Talker.page))[ids.Quiet];
  tl.push(`t+${(i + 1) * 3}s Quiet->Talker ${q ? q.state : '-'} | Talker->Quiet ${t ? t.state : '-'} | rebuilds Q ${count('Quiet') - c0.Quiet} T ${count('Talker') - c0.Talker}`);
}
const qlogs = await h.ev(P.Quiet.page, () => window.__voiceDebug.logs());
return { pre: pre[ids.Talker] && pre[ids.Talker].state, tl, lastQuietLogs: qlogs.slice(-8) };
