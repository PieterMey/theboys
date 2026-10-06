const ids = h.state.ids;
// Talker is dead (Listener grab). Put living Quiet and Shouter near the Talker's death spot / camera.
const tal = await h.ev(P.Talker.page, () => { const p = window.__voiceDebug.positions(); return { listener: p.listener, svc: (() => { const s = window.__voiceDebug.service(); return { radio: s.radio(), band: s.band(), tx: s.transmitting() }; })() }; });
const tpose = await h.dbg(P.Talker.page, 'players.pose', {});
await h.place(P.Quiet.page, 10.5, 25.5, 0);
await h.place(P.Shouter.page, 11.5, 25.5, 0);
await h.sleep(2500);
const audQ = (await h.ev(P.Quiet.page, () => window.__voiceDebug.aud()))[ids.Talker];
const qHearsDead = await h.measure(P.Quiet.page, ids.Talker, 3500);
const bandOfDeadAtQ = (await h.peers(P.Quiet.page))[ids.Talker];
// dead Talker hears living Shouter (loud) ?
const talkerHearsShouter = await h.measure(P.Talker.page, ids.Shouter, 3500);
const talkerAud = await h.ev(P.Talker.page, () => window.__voiceDebug.aud());
const talkerPos2 = await h.ev(P.Talker.page, () => window.__voiceDebug.positions().listener);
const shotDead = await h.shot(P.Talker.page, '22-dead-talker-view');
// dead Talker holds Q (walkie?) -> living Shouter (has walkie) must not hear it
const inv = (await h.dbg(P.Quiet.page, 'interaction.state', {})).inventories;
await P.Talker.page.keyboard.down('q');
await h.sleep(700);
const deadTx = await h.ev(P.Talker.page, () => { const s = window.__voiceDebug.service(); return { radio: s.radio(), hud: document.querySelector('[data-testid=ix-radio]')?.textContent ?? null }; });
await h.place(P.Shouter.page, 36.5, 38.5, 0);
await h.sleep(1500);
const shouterHearsDeadRadio = await h.measure(P.Shouter.page, ids.Talker, 3000);
await P.Talker.page.keyboard.up('q');
const fmt = (m) => `max ${m.max.toFixed(4)} L ${h.dB(m.l)} R ${h.dB(m.r)} gate ${m.maxGain.toFixed(2)} band ${m.band}`;
return { talkerBefore: tal, tpose, audQ, livingQuietHearsDeadTalker: fmt(qHearsDead), bandOfDeadAtQ, deadTalkerHearsLivingShouter: fmt(talkerHearsShouter), talkerAudShouter: talkerAud[ids.Shouter], talkerListener: talkerPos2, invTalker: inv[ids.Talker], deadTx, livingShouterHearsDeadRadio: fmt(shouterHearsDeadRadio), shotDead };
