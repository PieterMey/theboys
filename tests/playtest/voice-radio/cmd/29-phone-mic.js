const p = P.Phone.page;
const lv = [];
for (let i = 0; i < 30; i++) { lv.push(await h.ev(p, () => { const l = window.__voiceDebug.level(); return l ? Math.round(l.db) : null; })); await h.sleep(150); }
const ms = await h.ev(p, () => window.__voiceDebug.micSettings());
const logs = await h.ev(p, () => window.__voiceDebug.logs());
const ac = await h.ev(p, () => { try { return document.querySelector('audio') ? 'has audio el' : 'no audio el'; } catch (e) { return String(e); } });
// how does the Talker (game) see the phone?
const tp = (await h.peers(P.Quiet.page));
return { lv, ms, logs: logs.slice(-12), ac, quietSees: Object.fromEntries(Object.entries(tp).map(([k, v]) => [k, `${v.state}/${v.candidate} band ${v.band} rms ${v.rmsL.toFixed(3)}`])) };
