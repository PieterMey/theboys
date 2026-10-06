const q = { autojoin: '1', nobright: '1' };
const vp = { width: 1280, height: 720 };
const [a, b, c] = await Promise.all([
  h.launch('Tone', 'tone440.wav', { crew: 'VRAD', query: q, viewport: vp }),
  h.launch('Shouter', 'shout.wav', { crew: 'VRAD', query: q, viewport: vp }),
  h.launch('Quiet', 'silence.wav', { crew: 'VRAD', query: q, viewport: { width: 1600, height: 900 } }),
]);
const ids = {};
for (const p of [a, b, c]) {
  for (let i = 0; i < 180; i++) {
    const s = await h.st(p.page).catch(() => null);
    if (s && s.net === 'joined' && s.me) { ids[p.name] = s.me; break; }
    await h.sleep(500);
  }
}
ids.Talker = await h.me(P.Talker.page);
h.state.ids = ids;
await h.sleep(6000);
const out = {};
for (const n of ['Talker', 'Tone', 'Shouter', 'Quiet']) {
  const pr = await h.peers(P[n].page);
  out[n] = Object.fromEntries(Object.entries(pr).map(([k, v]) => [Object.keys(ids).find((x) => ids[x] === k) || k, `${v.state}/${v.candidate} rx=${v.bytesReceived} band=${v.band}`]));
}
return { ids, out };
