const ids = h.state.ids;
const name = (k) => Object.keys(ids).find((x) => ids[x] === k) || k;
const snap = async () => {
  const out = {};
  for (const n of ['Talker', 'Tone', 'Shouter', 'Quiet']) {
    const pr = await h.peers(P[n].page);
    out[n] = Object.fromEntries(Object.entries(pr).map(([k, v]) => [name(k), `${v.state}/${v.candidate} rx=${v.bytesReceived}`]));
  }
  return out;
};
const timeline = [];
for (let i = 0; i < 8; i++) {
  timeline.push({ t: i * 5, s: await snap() });
  const all = Object.values(timeline[timeline.length - 1].s).every((m) => Object.values(m).length === 3 && Object.values(m).every((v) => v.startsWith('connected')));
  if (all) break;
  await h.sleep(5000);
}
const logsTone = await h.ev(P.Tone.page, () => window.__voiceDebug.logs());
const logsQuiet = await h.ev(P.Quiet.page, () => window.__voiceDebug.logs());
const meshTone = await h.ev(P.Tone.page, () => window.__voiceDebug.mesh());
const meshQuiet = await h.ev(P.Quiet.page, () => window.__voiceDebug.mesh());
return { timeline: timeline.slice(-2), logsTone: logsTone.filter((l) => l.includes(ids.Quiet)), logsQuiet: logsQuiet.filter((l) => l.includes(ids.Tone)), meshTone: meshTone[ids.Quiet], meshQuiet: meshQuiet[ids.Tone] };
