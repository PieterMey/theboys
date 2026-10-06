const s = await h.dbg(P.Quiet.page, 'state', {});
const vs = await h.dbg(P.Quiet.page, 'voice.state', {});
const st = await h.st(P.Quiet.page);
const noise = await h.dbg(P.Quiet.page, 'players.noise', {});
const mons = await h.dbg(P.Quiet.page, 'monsters.state', {});
const shot = await h.shot(P.Quiet.page, '30-quiet-with-voicetest-in-crew');
return {
  players: s.players.map((p) => ({ id: p.id, name: p.name, alive: p.alive, connected: p.connected, band: p.band, pos: p.pose.p.map((v) => Math.round(v * 10) / 10) })),
  roster: st.crew.players.map((p) => `${p.name} alive=${p.alive}`),
  voiceState: vs.players.map((p) => `${p.name} band=${p.band} alive=${p.alive}`),
  recentVoiceNoise: (Array.isArray(noise) ? noise : []).filter((n) => n.kind === 'voice').slice(-6),
  hound: mons.agents.filter((a) => a.kind === 'hound').map((a) => ({ state: a.state, lastNoiseKind: a.lastNoiseKind, x: a.x, z: a.z })),
  shot,
};
