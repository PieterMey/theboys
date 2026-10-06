const ids = h.state.ids;
const L = { x: 6.5, z: 19.5 };
const spk = ['Talker', 'Tone2', 'Shouter'];
const rounds = [[2, 8, 20], [8, 20, 2], [20, 2, 8]];
const out = [];
for (const r of rounds) {
  for (let i = 0; i < 3; i++) await h.place(P[spk[i]].page, L.x + r[i], L.z + (i - 1) * 0.6, -Math.PI / 2);
  await h.place(P.Quiet.page, L.x, L.z, Math.PI / 2);
  await h.sleep(2500);
  const m = await Promise.all(spk.map((n) => h.measure(P.Quiet.page, ids[n], 3500)));
  const aud = await h.ev(P.Quiet.page, () => window.__voiceDebug.aud());
  out.push(Object.fromEntries(spk.map((n, i) => [n, `${r[i]} m: aud=${aud[ids[n]]} max=${m[i].max.toFixed(4)} rms=${h.dB(Math.hypot(m[i].l, m[i].r) / Math.SQRT2)} dB gate=${m[i].maxGain.toFixed(2)} band=${m[i].band}`])));
}
return out;
