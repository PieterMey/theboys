const ids = h.state.ids;
// Shouter near Quiet, then killed by dbg
await h.place(P.Shouter.page, 30.5, 38.5, Math.PI / 2);
await h.place(P.Quiet.page, 31.6, 38.5, -Math.PI / 2);
await h.sleep(1500);
const before = await h.measure(P.Quiet.page, ids.Shouter, 2500);
const k = await h.dbg(P.Quiet.page, 'interaction.kill', { pid: ids.Shouter, killer: 'HOUND', reason: 'playtest kill' });
await h.sleep(4000);
const sShot = await h.shot(P.Shouter.page, '23-shouter-death-card');
const after = await h.measure(P.Quiet.page, ids.Shouter, 3000);
// dead Talker (far away, following someone) hears dead Shouter in 2D?
const tPos = await h.ev(P.Talker.page, () => window.__voiceDebug.positions().listener.pos.map((v) => Math.round(v * 10) / 10));
const sPos = await h.ev(P.Shouter.page, () => window.__voiceDebug.positions().listener.pos.map((v) => Math.round(v * 10) / 10));
const dd = await h.measure(P.Talker.page, ids.Shouter, 3500);
const dd2 = await h.measure(P.Shouter.page, ids.Talker, 3500);
// living Tone2 must hear neither
const t2a = await h.measure(P.Tone2.page, ids.Shouter, 2000);
const fmt = (m) => `max ${m.max.toFixed(4)} L ${h.dB(m.l)} R ${h.dB(m.r)} gate ${m.maxGain.toFixed(2)}`;
return { kill: k, livingQuietHearsShouter: { alive: fmt(before), dead: fmt(after) }, deadTalkerPos: tPos, deadShouterPos: sPos, deadTalkerHearsDeadShouter: fmt(dd), deadShouterHearsDeadTalker: fmt(dd2), livingTone2HearsDeadShouter: fmt(t2a), sShot };
