const out = {};
for (const n of Object.keys(P)) {
  out[n] = await h.ev(P[n].page, () => { const p = window.__game.perf(); const s = window.__game.state(); return { fps: Math.round(p.fps), frameMs: Math.round(p.frameMs), rtt: s.diag && s.diag.net && s.diag.net.rtt, snapHz: s.diag && s.diag.net && s.diag.net.snapHz, errs: window.__game.errors().length }; });
}
return out;
