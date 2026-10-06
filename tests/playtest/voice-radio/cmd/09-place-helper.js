h.place = async (page, x, z, yaw) => {
  await h.tp(page, x, z, yaw);
  await h.ev(page, ([x, z, yaw]) => window.__game.teleport(x, z, yaw), [x, z, yaw]);
  await h.ev(page, ([yaw]) => window.__game.look(yaw, 0), [yaw]);
  await h.sleep(600);
  return h.ev(page, () => { const p = window.__voiceDebug.positions(); return p.listener ? { pos: p.listener.pos.map((v) => Math.round(v * 100) / 100), fwd: p.listener.fwd.map((v) => Math.round(v * 100) / 100), src: p.listener.src } : null; });
};
const a = await h.place(P.Quiet.page, 6.5, 19.5, Math.PI / 2);
const b = await h.place(P.Talker.page, 8.5, 19.5, -Math.PI / 2);
await h.sleep(1500);
const posQ = await h.ev(P.Quiet.page, () => window.__voiceDebug.positions());
const aud = await h.ev(P.Quiet.page, () => window.__voiceDebug.aud());
return { a, b, voicesQ: posQ.voices, aud, ids: h.state.ids };
