const out = {};
for (const [k, p] of Object.entries(P)) {
  out[k] = { console: p.console.filter(l => !/16-sampler|KTX2Loader/.test(l)).slice(-25), gameErrors: await p.page.evaluate(() => window.__game.errors().slice(-15)), perf: await p.page.evaluate(() => window.__game.perf()), pose: await p.page.evaluate(() => window.__players.local().p) };
}
return out;
