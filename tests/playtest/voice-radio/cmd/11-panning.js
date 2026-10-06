const ids = h.state.ids;
await h.place(P.Shouter.page, 27.5, 6.5, 0);
await h.place(P.Talker.page, 20.5, 21.5, Math.PI);
await h.place(P.Tone2.page, 20.5, 17.5, 0);
const lp = await h.place(P.Quiet.page, 20.5, 19.5, Math.PI / 2);
await h.sleep(2000);
const [t, o] = await Promise.all([h.measure(P.Quiet.page, ids.Talker, 4000), h.measure(P.Quiet.page, ids.Tone2, 4000)]);
const res1 = { listener: lp, Talker_right: `L ${h.dB(t.l)} R ${h.dB(t.r)} diff(R-L) ${(h.dB(t.r) - h.dB(t.l)).toFixed(1)} dB`, Tone2_left: `L ${h.dB(o.l)} R ${h.dB(o.r)} diff(L-R) ${(h.dB(o.l) - h.dB(o.r)).toFixed(1)} dB` };
// turn the listener around (face -X): sides must swap
await h.ev(P.Quiet.page, () => window.__game.look(-Math.PI / 2, 0));
await h.sleep(1500);
const [t2, o2] = await Promise.all([h.measure(P.Quiet.page, ids.Talker, 4000), h.measure(P.Quiet.page, ids.Tone2, 4000)]);
const res2 = { Talker_now_left: `L ${h.dB(t2.l)} R ${h.dB(t2.r)} diff(L-R) ${(h.dB(t2.l) - h.dB(t2.r)).toFixed(1)} dB`, Tone2_now_right: `L ${h.dB(o2.l)} R ${h.dB(o2.r)} diff(R-L) ${(h.dB(o2.r) - h.dB(o2.l)).toFixed(1)} dB` };
return { res1, res2 };
