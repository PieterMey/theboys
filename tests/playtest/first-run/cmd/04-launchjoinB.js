const B = await h.launch('B', 'shout.wav');
const pg = B.page;
await pg.waitForSelector('form.join', { timeout: 60000 });
await h.sleep(1500);
const name = pg.locator('form.join label:has-text("CALLSIGN") input');
await name.click({ clickCount: 3 });
await pg.keyboard.type('Bob', { delay: 50 });
const t0 = Date.now();
await pg.getByRole('button', { name: 'JOIN CREW' }).click();
const samples = [];
let last = '';
for (let i = 0; i < 120; i++) {
  await h.sleep(250);
  const s = await pg.evaluate(() => { const g = window.__game.state(); return { net: g.net, screen: g.screen, btn: document.querySelector('form.join button[type=submit]')?.textContent ?? null, fps: Math.round(window.__game.perf().fps) }; });
  const k = `${s.net}/${s.screen}/${s.btn}`;
  if (k !== last) { samples.push(`${((Date.now()-t0)/1000).toFixed(2)}s net=${s.net} screen=${s.screen} btn=${s.btn} fps=${s.fps}`); last = k; }
  if (s.screen !== 'join') break;
}
await h.sleep(2500);
const s2 = await h.st(pg);
const hasMic = await pg.evaluate(() => { const v = window.__voiceDebug; return { band: v?.band?.(), mic: v?.micSettings?.() }; });
await h.shot(pg, '06-B-after-join');
return { samples, screenAfter: s2.screen, pose: await h.pose(pg), hasMic, console: B.console.slice(0, 20) };
