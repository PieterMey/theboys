const p = await h.launch('Relay', 'tone880.wav', { crew: 'VRAD', query: { autojoin: '1', nobright: '1', relay: '1' }, viewport: { width: 960, height: 540 } });
let id = null;
for (let i = 0; i < 200 && !id; i++) { const s = await h.st(p.page).catch(() => null); if (s && s.net === 'joined' && s.me) id = s.me; else await h.sleep(500); }
h.state.ids.Relay = id;
const ids = h.state.ids;
const name = (k) => Object.keys(ids).find((x) => ids[x] === k) || k;
const ice = await h.ev(p.page, () => ({ relayOnly: window.__voiceDebug.relayOnly(), servers: window.__voiceDebug.iceServers() }));
let pr = {};
for (let i = 0; i < 20; i++) {
  pr = await h.peers(p.page);
  const v = Object.values(pr);
  if (v.length >= 4 && v.every((x) => x.state === 'connected' && x.candidate !== 'none')) break;
  await h.sleep(2000);
}
const b0 = await h.peers(p.page);
await h.sleep(3000);
const b1 = await h.peers(p.page);
const st = await h.st(p.page);
const me = st.crew.players.find((x) => x.id === id);
return { id, alive: me && me.alive, phase: st.phase, ice, peers: Object.fromEntries(Object.entries(b1).map(([k, v]) => [name(k), `${v.state}/${v.candidate} rx ${b0[k]?.bytesReceived}->${v.bytesReceived}`])), otherSide: Object.fromEntries(await Promise.all(['Quiet', 'Tone2'].map(async (n) => [n, (await h.peers(P[n].page))[id]]))) };
