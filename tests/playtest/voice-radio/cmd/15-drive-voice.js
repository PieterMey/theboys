const ids = h.state.ids;
const st = await h.st(P.Quiet.page);
const aud = await h.ev(P.Quiet.page, () => window.__voiceDebug.aud());
const m = await Promise.all(['Talker', 'Shouter', 'Tone2'].map((n) => h.measure(P.Quiet.page, ids[n], 3000)));
return { phase: st.phase, screen: st.screen, aud, hear: m.map((x) => `max ${x.max.toFixed(3)} gate ${x.maxGain.toFixed(2)}`) };
