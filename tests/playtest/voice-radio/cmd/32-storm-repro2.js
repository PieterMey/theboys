const ids = h.state.ids;
const count = (n) => (h.readFileSync(h.join(h.DIR, 'logs', `${n}.console.log`), 'utf8').match(/new remote session -> rebuilding/g) || []).length;
const c0 = { Quiet: count('Quiet'), Talker: count('Talker') };
// Quiet (impolite) replaces its PC while the answer to its last offer is still in flight (a 400 ms long frame).
const r = await h.ev(P.Quiet.page, (tid) => new Promise((res) => {
  const s = window.__voiceDebug.service();
  s.setRelayOnly(true);
  const t0 = performance.now();
  const poll = () => {
    const m = window.__voiceDebug.mesh()[tid];
    if (m && m.sig === 'have-local-offer') {
      const t = performance.now(); while (performance.now() - t < 400) { /* long frame */ }
      s.setRelayOnly(false);
      res({ ok: true, ms: Math.round(performance.now() - t0) });
    } else if (performance.now() - t0 > 5000) res({ ok: false });
    else setTimeout(poll, 0);
  };
  poll();
}), ids.Talker);
const tl = [];
for (let i = 0; i < 6; i++) {
  await h.sleep(4000);
  const q = (await h.peers(P.Quiet.page))[ids.Talker];
  const t = (await h.peers(P.Talker.page))[ids.Quiet];
  tl.push(`t+${(i + 1) * 4}s Quiet->Talker ${q ? q.state : '-'} | Talker->Quiet ${t ? t.state : '-'} | rebuilds Quiet ${count('Quiet') - c0.Quiet} Talker ${count('Talker') - c0.Talker}`);
}
const qlogs = await h.ev(P.Quiet.page, () => window.__voiceDebug.logs());
return { r, tl, lastQuietLogs: qlogs.slice(-9) };
