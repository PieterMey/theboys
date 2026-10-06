const out = {};
for (let i = 0; i < 6; i++) {
  await h.sleep(1500);
  const r = [];
  for (const [k, p] of Object.entries(P)) r.push(`${k}:${Math.round(await p.page.evaluate(() => window.__game.perf().fps))}fps`);
  out[`t${i}`] = r.join(' ');
}
const A = P.A;
out.errCount = A.console.filter(l => /linearRamp/.test(l)).length;
out.firstErr = A.console.find(l => /linearRamp/.test(l));
out.lastErr = [...A.console].reverse().find(l => /linearRamp/.test(l));
out.diag = await A.page.evaluate(() => { const d = window.__game.state().diag; return { players: d.players, keys: Object.keys(d) }; });
return out;
