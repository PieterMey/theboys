const ids = h.state.ids;
const name = (k) => Object.keys(ids).find((x) => ids[x] === k) || k;
const s = await h.st(P.Quiet.page);
const ix = await h.dbg(P.Quiet.page, 'interaction.state', {});
const mons = await h.dbg(P.Quiet.page, 'monsters.state', {});
return { roster: s.crew.players.map((p) => `${name(p.id)} alive=${p.alive} conn=${p.connected}`), dead: (ix.dead || []).map(name), deaths: ix.deaths, monsters: JSON.stringify(mons).slice(0, 1500) };
