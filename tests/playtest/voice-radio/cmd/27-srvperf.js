await h.dbg(P.Quiet.page, 'perf', {});
await h.sleep(3000);
const p = await h.dbg(P.Quiet.page, 'perf', {});
const stats = await h.dbg(P.Quiet.page, 'stats', {});
return { eld: p.eventLoopDelayMs, top: Object.entries(p.msPerSec).slice(0, 6), stats };
