const A = P.A; const pg = A.page;
const name = pg.locator('form.join label:has-text("CALLSIGN") input');
await name.click({ clickCount: 3 });
await pg.keyboard.type('Ann', { delay: 60 });
await pg.getByRole('button', { name: 'ALLOW MICROPHONE' }).click();
await h.sleep(1500);
const note = await pg.evaluate(() => document.querySelector('.m-join')?.innerText);
await h.shot(pg, '03-A-after-allow-mic');
const t0 = Date.now();
await pg.getByRole('button', { name: 'JOIN CREW' }).click();
const samples = [];
for (let i = 0; i < 60; i++) {
  await h.sleep(500);
  const s = await h.st(pg);
  const btn = await pg.evaluate(() => document.querySelector('form.join button[type=submit]')?.textContent ?? null);
  samples.push(`${((Date.now()-t0)/1000).toFixed(1)} net=${s?.net} screen=${s?.screen} btn=${btn}`);
  if (i === 2) await h.shot(pg, '04-A-joining-1.5s');
  if (s?.screen && s.screen !== 'join') break;
}
await h.sleep(800);
await h.shot(pg, '05-A-first-screen-after-join');
const s = await h.st(pg);
return { note, samples, screen: s?.screen, phase: s?.phase, crew: s?.crew?.code, players: s?.crew?.players?.map(p => p.name), console: A.console.slice(0, 30) };
