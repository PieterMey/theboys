const A = P.A.page;
const out = {};
out.withB = Math.round(await A.evaluate(() => window.__game.perf().fps));
out.diagA = await A.evaluate(() => { const d = window.__game.state().diag; return { renderPreset: d.renderPreset, gpu: d.gpu, level: d.level }; });
await P.B.browser.close();
delete P.B;
const s = [];
for (let i = 0; i < 6; i++) { await h.sleep(1500); s.push(Math.round(await A.evaluate(() => window.__game.perf().fps))); }
out.soloFps = s;
out.perf = await A.evaluate(() => window.__game.perf());
await h.shot(A, '39-A-contract2-solo');
return out;
