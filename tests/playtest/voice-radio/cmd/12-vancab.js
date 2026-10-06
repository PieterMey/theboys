const ids = h.state.ids;
await h.place(P.Tone2.page, 27.5, 22.5, 0);
// Quiet inside the van cargo area, facing the open rear door (-Z); Talker outside 2 m away, Shouter inside next to Quiet
await h.place(P.Quiet.page, 15.0, 11.6, Math.PI);
await h.place(P.Talker.page, 15.0, 9.4, 0);
await h.place(P.Shouter.page, 14.5, 12.4, Math.PI);
await h.sleep(2500);
const aud = await h.ev(P.Quiet.page, () => window.__voiceDebug.aud());
const [t, s] = await Promise.all([h.measure(P.Quiet.page, ids.Talker, 4000), h.measure(P.Quiet.page, ids.Shouter, 4000)]);
const shotIn = await h.shot(P.Quiet.page, '12-van-inside-looking-out');
// reverse: Talker hears Quiet? (Quiet is silent) -> check what the outside player hears from the inside Shouter
const audT = await h.ev(P.Talker.page, () => window.__voiceDebug.aud());
const sOut = await h.measure(P.Talker.page, ids.Shouter, 4000);
const shotOut = await h.shot(P.Talker.page, '12-van-outside-looking-in');
return {
  audAtQuiet: { Talker_outside: aud[ids.Talker], Shouter_inside: aud[ids.Shouter] },
  QuietHears: { Talker_outside_2m: `max ${t.max.toFixed(4)} gate ${t.maxGain.toFixed(2)}`, Shouter_inside_1m: `max ${s.max.toFixed(4)} gate ${s.maxGain.toFixed(2)}` },
  TalkerOutsideHearsShouterInside: { aud: audT[ids.Shouter], max: sOut.max.toFixed(4), gate: sOut.maxGain.toFixed(2) },
  shotIn, shotOut,
};
