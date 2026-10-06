await h.close('Tone');
await h.sleep(20000);
const c0 = (h.readFileSync(h.join(h.DIR, 'logs', 'Quiet.console.log'), 'utf8').match(/rebuilding the connection/g) || []).length;
await h.sleep(3000);
const c1 = (h.readFileSync(h.join(h.DIR, 'logs', 'Quiet.console.log'), 'utf8').match(/rebuilding the connection/g) || []).length;
const p = await h.launch('Tone2', 'tone440.wav', { crew: 'VRAD', query: { autojoin: '1', nobright: '1' }, viewport: { width: 1280, height: 720 } });
let id = null;
for (let i = 0; i < 180 && !id; i++) { const s = await h.st(p.page).catch(() => null); if (s && s.net === 'joined' && s.me) id = s.me; else await h.sleep(500); }
h.state.ids.Tone2 = id;
delete h.state.ids.Tone;
const ids = h.state.ids;
const name = (k) => Object.keys(ids).find((x) => ids[x] === k) || k;
const tl = [];
for (let i = 0; i < 12; i++) {
  const out = {};
  for (const n of ['Talker', 'Tone2', 'Shouter', 'Quiet']) {
    const pr = await h.peers(P[n].page);
    out[n] = Object.fromEntries(Object.entries(pr).map(([k, v]) => [name(k), `${v.state}/${v.candidate}`]));
  }
  tl.push(out);
  const all = Object.values(out).every((m) => Object.values(m).length === 3 && Object.values(m).every((v) => v.startsWith('connected')));
  if (all) break;
  await h.sleep(4000);
}
return { stormAfterToneLeft: { c0, c1 }, id, last: tl[tl.length - 1], rounds: tl.length };
