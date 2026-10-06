// Track ⑤ Players E2E: two browser clients in one crew see each other's avatars (flashlights on), emote,
// proximity chat, LOS ping, and spectating after death. Screenshots in tests/artifacts/players/duo_*.png.
//   node tests/players/duo.e2e.ts   (dev server on PORT, default 3005)
import { screenshot } from '../lib/launch.ts';
import { OUT, assert, joinPlayer, local, testLevel } from './lib.ts';

const crew = 'PDUO';
const A = await joinPlayer('Alpha', crew);
const B = await joinPlayer('Bravo', crew);
const res: Record<string, unknown> = {};
try {
  await testLevel(A.page, 'duo-e2e', 2);
  await B.page.waitForFunction(() => (window.__game!.state() as { phase: string }).phase === 'contract', undefined, { timeout: 15_000 });
  await A.page.waitForTimeout(1500);
  const wall = await A.page.evaluate(() => window.__players!.findWall());
  assert(wall, 'wall cell');
  // A at the spawn lot, B 3.5 m in front of A, facing each other
  const a0 = await local(A.page);
  const [ax, , az] = a0.p;
  await A.page.evaluate(({ ax, az }) => { window.__game!.teleport(ax, az, 0); window.__game!.look(0, -0.05); }, { ax, az });
  await B.page.evaluate(({ ax, az }) => { window.__game!.teleport(ax + 0.4, az + 3.5, Math.PI); window.__game!.look(Math.PI, -0.05); }, { ax, az });
  await A.page.waitForTimeout(1500);
  // a busy GPU can stall rAF for seconds in the contract phase: wait until A's view of B caught up
  await A.page.waitForFunction(() => { const a = window.__players!.avatars()[0]; return !!a && a.light && a.p[2] > 28; }, undefined, { timeout: 45_000, polling: 250 }).catch(() => console.log('A never caught up with B'));
  await B.page.waitForFunction(() => { const a = window.__players!.avatars()[0]; return !!a && a.light; }, undefined, { timeout: 45_000, polling: 250 }).catch(() => console.log('B never caught up with A'));
  const avA = await A.page.evaluate(() => window.__players!.avatars());
  const avB = await B.page.evaluate(() => window.__players!.avatars());
  res.avatarsSeenByA = avA.map((a) => ({ id: a.id, rig: a.rig, light: a.light, plate: Math.round(a.plate * 100) / 100 }));
  res.avatarsSeenByB = avB.map((a) => ({ id: a.id, rig: a.rig, light: a.light }));
  const fl = await A.page.evaluate(() => window.__players!.flashlights());
  res.flashlightsA = fl.map((f) => ({ id: f.id.slice(0, 6), on: f.on, local: f.local, pos: f.pos.map((v) => Math.round(v * 100) / 100) }));
  await screenshot(A.page, `${OUT}/duo_A_sees_B.png`);
  await screenshot(B.page, `${OUT}/duo_B_sees_A.png`);

  // emote: A waves, B sees A's avatar play the wave clip
  await A.page.evaluate(() => window.__players!.emote('wave'));
  await B.page.waitForTimeout(700);
  const avB2 = await B.page.evaluate(() => window.__players!.avatars());
  res.emoteAnimOnB = avB2[0]?.anim;
  await screenshot(B.page, `${OUT}/duo_B_sees_A_wave.png`);

  // proximity chat (3.5 m apart -> within talk radius)
  await A.page.evaluate(() => window.__players!.chat('meet at the boiler'));
  await B.page.waitForTimeout(500);
  res.chatOnB = await B.page.evaluate(() => window.__players!.chatLines());

  // ping: A pings forward (toward B) -> B has LOS -> marker on both
  // aim A's view at B's feet (B's avatar as A sees it), so the ping lands next to B
  const aim = await A.page.evaluate(() => {
    const me = window.__players!.local();
    const b = window.__players!.avatars()[0];
    const dx = b.p[0] - me.p[0], dz = b.p[2] - me.p[2];
    const yaw = Math.atan2(dx, dz);
    const pitch = -Math.atan2(me.eye - 0.05, Math.hypot(dx, dz) - 0.6);
    window.__game!.look(yaw, pitch);
    return { yaw, pitch, b: b.p, me: me.p };
  });
  res.aim = aim;
  await A.page.waitForTimeout(400);
  const pr = await A.page.evaluate(() => window.__players!.ping());
  await B.page.waitForTimeout(400);
  res.ping = { result: pr, markersA: await A.page.evaluate(() => window.__players!.markers()), markersB: await B.page.evaluate(() => window.__players!.markers()) };
  await screenshot(B.page, `${OUT}/duo_B_ping.png`);

  // death -> A spectates B
  await A.page.evaluate(() => window.__game!.dbg('players.kill', { alive: false }));
  await A.page.waitForTimeout(1200);
  res.spectate = await A.page.evaluate(() => window.__players!.spectating());
  await screenshot(A.page, `${OUT}/duo_A_spectating.png`);
  const corpse = await B.page.evaluate(() => window.__players!.avatars());
  res.corpseOnB = corpse.map((c) => ({ anim: c.anim, p: c.p.map((v) => Math.round(v * 10) / 10) }));
  await screenshot(B.page, `${OUT}/duo_B_sees_corpse.png`);
  await A.page.evaluate(() => window.__game!.dbg('players.kill', { alive: true }));

  res.localB = await B.page.evaluate(() => ({ ...window.__players!.local(), screen: (window.__game!.state() as { screen: string }).screen }));
  console.log(JSON.stringify(res, null, 1));
  assert(avA.length === 1 && avB.length === 1, 'each client sees one remote avatar');
  assert(avA[0].light && avB[0].light, 'remote flashlights on');
  assert(fl.length === 2 && fl.some((f) => f.local) && fl.some((f) => !f.local && f.on), 'flashlights() lists local + remote');
  assert(res.emoteAnimOnB === 14, `B sees A wave (anim ${res.emoteAnimOnB})`);
  assert((res.chatOnB as string[]).some((l) => l.includes('meet at the boiler')), 'B got the proximity chat line');
  assert((res.spectate as { on: boolean }).on, 'A spectating after death');
  assert((res.ping as { markersB: number }).markersB >= 1, 'B (line of sight) sees the ping marker');
  console.log('PASS players/duo');
} finally {
  await A.close();
  await B.close();
}
