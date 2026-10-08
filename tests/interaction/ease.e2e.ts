// v1.2 (G3) quiet hold-E on doors, ws bots against a full dev server (real players noise bus, monsters frozen):
//   stop at 0.9 s = unchanged + silent; held 1.9 s = open with {doorSoft, 1} and no 6 m noise; walking away cancels;
//   a teammate's tap is 6 m and cancels; hold:true on a normal door is still 6 m; a modified client cannot open a door
//   silently (fast on/off, restart spam, from too far, forged flags); fire doors take 2.6 s.
// Run: node tests/interaction/ease.e2e.ts [port]   (no port: spawns a temporary dev server)
import { Bot } from './bot.ts';
import { doorSpot } from './spots.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import { noisesSince, place, reporter, serverNow, sleep, testServer } from './v12lib.ts';

const srv = await testServer();
const { ok, fails } = reporter();
const url = `ws://127.0.0.1:${srv.port}/ws`;
const crew = `EASE${Date.now() % 100000}`;
const a = new Bot('Easer');
const b = new Bot('Tapper');
try {
  await a.connect(url, crew);
  await b.connect(url, crew);
  await a.dbg('level.generate', { seed: 'g3-ease-e2e', players: 2 });
  await a.settle(600);
  await a.dbg('monsters.freeze', { on: true }).catch(() => undefined);
  const L = a.full!.layout as LevelLayout;
  ok(L?.kind === 'facility', `facility ${L?.seed}`);
  const closed = L.doors.filter((d) => d.kind === 'door' && !d.initiallyOpen).map((d) => doorSpot(L, 'door', d.id)).find((x) => !!x)!;
  ok(!!closed, `a closed door: ${closed?.id}`);
  const did = closed.door.id;
  const near = (n: { x: number; z: number }) => Math.hypot(n.x - closed.look[0], n.z - closed.look[2]) < 2.5;
  const doorNoises = async (t: number) => (await noisesSince(a, t)).filter(near).map((n) => `${n.kind}:${n.radiusM}`);
  await place(a, closed.stand[0], closed.stand[1]);
  await place(b, closed.stand[0], closed.stand[1]);
  await a.settle(300);

  // 1) released at 0.9 s
  let t = serverNow(a);
  let r = await a.req<{ ok: boolean; ms?: number; msg?: string }>('interaction.ease', { id: closed.id, on: true });
  ok(r.ok && r.ms === 1800, `ease started (${r.ms} ms) ${r.msg ?? ''}`);
  await sleep(900);
  await a.req('interaction.ease', { id: closed.id, on: false });
  await a.settle(150);
  ok(a.ix.doors[did]!.open === false && !a.ix.doors[did]!.ease, 'released at 0.9 s: door unchanged');
  ok((await doorNoises(t)).length === 0, 'released at 0.9 s: no noise');

  // 2) held 1.9 s
  await sleep(400);
  t = serverNow(a);
  await a.req('interaction.ease', { id: closed.id, on: true });
  await sleep(1900);
  ok(a.ix.doors[did]!.open === true, 'held 1.9 s: open');
  let ns = await doorNoises(t);
  ok(ns.includes('doorSoft:1') && !ns.some((x) => x.startsWith('door:')), `held 1.9 s: ${JSON.stringify(ns)} (doorSoft 1 m, no 6 m)`);
  ok(a.events.some((ev) => ev.e === 'interaction.fx' && (ev.d as { kind: string; soft?: boolean; door?: number }).kind === 'door' && !!(ev.d as { soft?: boolean }).soft), 'fx door {soft}');

  // 3) walking away cancels (the door is open now: easing it shut)
  await sleep(400);
  t = serverNow(a);
  await a.req('interaction.ease', { id: closed.id, on: true });
  await sleep(500);
  const away: [number, number] = closed.door.dir === 'v'
    ? [closed.stand[0] + (closed.stand[0] < closed.door.x ? -3.5 : 3.5), closed.stand[1]]
    : [closed.stand[0], closed.stand[1] + (closed.stand[1] < closed.door.y ? -3.5 : 3.5)];
  await place(a, away[0], away[1]);
  await sleep(1700);
  ok(a.ix.doors[did]!.open === true && !a.ix.doors[did]!.ease, 'walked away: cancelled, door still open');
  ok((await doorNoises(t)).length === 0, 'walked away: no noise');

  // 4) a teammate's tap
  await place(a, closed.stand[0], closed.stand[1]);
  await sleep(400);
  t = serverNow(a);
  await a.req('interaction.ease', { id: closed.id, on: true });
  await sleep(600);
  r = await b.req('interaction.use', { id: closed.id });
  await sleep(1500);
  ns = await doorNoises(t);
  ok(r.ok && a.ix.doors[did]!.open === false && !a.ix.doors[did]!.ease, 'a teammate tapped it shut: the ease is gone');
  ok(ns.filter((x) => x === 'door:6').length === 1 && !ns.includes('doorSoft:1'), `teammate tap: ${JSON.stringify(ns)} (one 6 m door noise)`);

  // 5) hold:true on a normal door
  await sleep(400);
  t = serverNow(a);
  r = await a.req('interaction.use', { id: closed.id, hold: true, soft: true, quiet: true });
  ns = await doorNoises(t);
  ok(r.ok && a.ix.doors[did]!.open === true && ns.includes('door:6'), `use {hold:true} (+ forged flags): ${JSON.stringify(ns)}`);

  // 6) a modified client: fast on/off, restart spam, from too far
  await sleep(400);
  t = serverNow(a);
  for (let i = 0; i < 8; i++) {
    await a.req('interaction.ease', { id: closed.id, on: true });
    await sleep(150);
    await a.req('interaction.ease', { id: closed.id, on: false });
  }
  await a.req('interaction.ease', { id: closed.id, on: true });
  await sleep(1000);
  await a.req('interaction.ease', { id: closed.id, on: false });
  await sleep(1200);
  ok(a.ix.doors[did]!.open === true && (await doorNoises(t)).length === 0, 'on/off spam never commits a silent door');
  await place(a, closed.stand[0] + 5, closed.stand[1] + 5);
  r = await a.req('interaction.ease', { id: closed.id, on: true });
  ok(!r.ok, `from 5 m away: refused (${r.msg})`);
  // 7) a fire door takes longer
  const fire = doorSpot(L, 'fire');
  if (fire) {
    await place(a, fire.stand[0], fire.stand[1]);
    await sleep(300);
    r = await a.req('interaction.ease', { id: fire.id, on: true });
    ok(r.ok && r.ms === 2600, `fire door: ${r.ms} ms`);
    await a.req('interaction.ease', { id: fire.id, on: false });
  }
} catch (e) {
  ok(false, `threw: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
} finally {
  a.close();
  b.close();
  srv.stop();
}
console.log(fails() ? `FAILED (${fails()})` : 'ALL PASS');
process.exit(fails() ? 1 : 0);
