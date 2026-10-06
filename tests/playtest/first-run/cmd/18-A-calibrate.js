const A = P.A.page;
const mons = () => A.evaluate(() => window.__game.state().monsters.map(m => ({ id: m.id, kind: m.kind, p: m.p?.map(v => +(+v).toFixed(2)), st: m.st ?? m.state, anim: m.anim, yaw: m.yaw != null ? +(+m.yaw).toFixed(2) : null })));
const out = { before: await mons() };
await A.getByRole('button', { name: 'START' }).click();
const steps = [];
for (let i = 0; i < 24; i++) {
  await h.sleep(500);
  const t = await A.evaluate(() => document.querySelector('.m-screen .m-sheet:last-child')?.innerText?.replace(/\s+/g, ' ').slice(0, 300));
  const m = await mons();
  steps.push(`${(i * 0.5 + 0.5).toFixed(1)}s ${t} | hound=${JSON.stringify(m[0] ?? null)}`);
  if (i === 5) await h.shot(A, '15-A-calibrating');
}
out.steps = steps;
await h.shot(A, '16-A-calibration-end');
return out;
