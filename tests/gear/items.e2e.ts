// v1.2 (G3) gear MUST items, ws bots against a full dev server: battery, lockpick, master keycard (locked +
// security, charges), vault / rubble refusals, overshoes (worn out at contract end, pool gear kept), night vision,
// flashbulb (litAt cone, 6 m), curios in finds, the hub drop refusal, the death-card reasons kept as sent.
// Run: node tests/gear/items.e2e.ts [port]   (no port: spawns a temporary dev server)
import { Bot } from '../interaction/bot.ts';
import { doorSpot } from '../interaction/spots.ts';
import { noisesSince, place, reporter, serverNow, sleep, testServer } from '../interaction/v12lib.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import type { ItemState } from '../../packages/shared/src/messages/interaction.ts';
import { CURIOS } from '../../packages/shared/src/catalog.ts';

const srv = await testServer();
const { ok, fails } = reporter();
const url = `ws://127.0.0.1:${srv.port}/ws`;
const crew = `GEAR${Date.now() % 100000}`;
const a = new Bot('Gearhead');
const inv = (): ItemState[] => (a.ix.inventories[a.me] ?? []).filter(Boolean).map((id) => a.ix.items[id!]).filter(Boolean);
const slotOf = (type: string) => (a.ix.inventories[a.me] ?? []).findIndex((id) => !!id && a.ix.items[id]?.type === type);
const freeHands = async () => {
  for (let i = 0; i < 4; i++) if ((a.ix.inventories[a.me] ?? [])[i]) { await a.req('interaction.slot', { slot: i }); await a.req('interaction.drop', {}); }
  await a.settle();
};
const gen = async (seed: string) => {
  await a.dbg('level.generate', { seed, players: 2 });
  await a.settle(700);
  await a.dbg('monsters.freeze', { on: true }).catch(() => undefined);
  return a.full!.layout as LevelLayout;
};
try {
  await a.connect(url, crew);
  let L = await gen('g3-items-1');
  // ---------------- battery
  await a.dbg('interaction.give', { type: 'battery' });
  await a.settle();
  ok(inv().find((it) => it.type === 'battery')?.count === 2, 'battery x2 (one slot)');
  await a.req('interaction.slot', { slot: slotOf('battery') });
  let r = await a.req<{ ok: boolean; msg?: string }>('interaction.act', { dir: [0, 0, 1] });
  await a.settle();
  ok(r.ok && inv().find((it) => it.type === 'battery')?.count === 1, `LMB swaps one in (${r.msg})`);
  ok(a.events.some((ev) => ev.e === 'interaction.fx' && (ev.d as { kind: string; pid?: string }).kind === 'battery' && (ev.d as { pid?: string }).pid === a.me), 'fx battery to the owner (client sets 100%)');
  await freeHands();
  // ---------------- lockpick on the keycard door
  const lk = doorSpot(L, 'locked');
  if (lk) {
    await place(a, lk.stand[0], lk.stand[1]);
    await a.dbg('interaction.give', { type: 'lockpick' });
    await a.settle(200);
    r = await a.req('interaction.use', { id: lk.id });
    ok(!r.ok && /pick the lock/.test(r.msg ?? ''), `tap: "${r.msg}"`);
    const t = serverNow(a);
    const e = await a.req<{ ok: boolean; ms?: number }>('interaction.ease', { id: lk.id, on: true });
    ok(e.ok && e.ms === 5000, `hold: a 5 s pick (${e.ms})`);
    await sleep(5300);
    ok(a.ix.doors[lk.door.id]!.locked === false, 'picked: unlocked');
    const ns = (await noisesSince(a, t)).filter((n) => n.kind === 'lockpick');
    ok(ns.length === 1 && ns[0]!.radiusM === 6, `6 m lockpick noise (${JSON.stringify(ns.map((n) => n.radiusM))})`);
    ok(inv().find((it) => it.type === 'lockpick')?.count === 2, 'one pick used');
    await freeHands();
  } else ok(false, 'no keycard door on this site');
  // ---------------- vault + rubble refuse picks and keys
  await a.dbg('interaction.give', { type: 'masterkey' });
  await a.dbg('interaction.give', { type: 'lockpick' });
  await a.settle();
  const vault = doorSpot(L, 'vault');
  if (vault) {
    await place(a, vault.stand[0], vault.stand[1]);
    await a.settle(200);
    r = await a.req('interaction.use', { id: vault.id });
    const e = await a.req<{ ok: boolean }>('interaction.ease', { id: vault.id, on: true });
    ok(!r.ok && !e.ok && !a.ix.doors[vault.door.id]!.open, 'vault: no master keycard, no lockpick');
  }
  const rubble = L.doors.find((d) => d.kind === 'blocked');
  if (rubble) {
    r = await a.req('interaction.use', { id: `door:${rubble.id}` });
    const e = await a.req<{ ok: boolean }>('interaction.ease', { id: `door:${rubble.id}`, on: true });
    ok(!r.ok && !e.ok, 'rubble: no master keycard, no lockpick');
  }
  ok(inv().find((it) => it.type === 'masterkey')?.count === 3, 'refusals cost no charges');
  await freeHands();
  // ---------------- master keycard on a fresh site: the locked door at once, a security door quietly
  L = await gen('g3-items-2');
  await a.dbg('interaction.give', { type: 'masterkey' });
  await a.settle();
  const lk2 = doorSpot(L, 'locked');
  if (lk2) {
    await place(a, lk2.stand[0], lk2.stand[1]);
    await a.settle(200);
    r = await a.req('interaction.use', { id: lk2.id });
    await a.settle();
    ok(r.ok && a.ix.doors[lk2.door.id]!.open && inv().find((it) => it.type === 'masterkey')?.count === 2, `locked door opens at once (${r.msg})`);
  }
  const sec = doorSpot(L, 'security');
  if (sec) {
    await place(a, sec.stand[0], sec.stand[1]);
    await a.settle(500);
    const was = a.ix.doors[sec.door.id]!.open;
    const t = serverNow(a);
    r = await a.req('interaction.use', { id: sec.id });
    await a.settle();
    const ns = (await noisesSince(a, t)).filter((n) => Math.hypot(n.x - sec.look[0], n.z - sec.look[2]) < 2);
    ok(r.ok && a.ix.doors[sec.door.id]!.open === !was, 'security door moves at a tap');
    ok(ns.length === 1 && ns[0]!.kind === 'door' && ns[0]!.radiusM === 5, `5 m door noise, no 12 m clank (${JSON.stringify(ns.map((n) => [n.kind, n.radiusM]))})`);
  }
  // ---------------- overshoes wear out at contract end; pool gear (the keycard charges, a crowbar) stays
  await a.dbg('interaction.give', { type: 'soles' });
  await a.dbg('interaction.give', { type: 'crowbar' });
  await a.settle();
  const left = inv().find((it) => it.type === 'masterkey')?.count;
  L = await gen('g3-items-3');
  ok(!inv().some((it) => it.type === 'soles'), 'overshoes deleted at contract end');
  ok(inv().some((it) => it.type === 'crowbar') && inv().find((it) => it.type === 'masterkey')?.count === left, `pool gear kept (master keycard ${left} charges)`);
  await freeHands();
  // ---------------- night vision
  r = await a.req('interaction.nv', { on: true });
  ok(!r.ok, 'NV needs the module');
  await a.dbg('interaction.give', { type: 'nvg' });
  await a.settle();
  r = await a.req<{ ok: boolean; on?: boolean }>('interaction.nv', { on: true });
  await a.settle();
  ok(r.ok && a.ix.nv?.[a.me] === true, 'NV on (patched)');
  r = await a.req('interaction.nv', { on: false });
  await a.settle();
  ok(!a.ix.nv?.[a.me], 'NV off');
  await freeHands();
  // ---------------- flashbulb
  const run = L.spaces.filter((s) => s.kind === 'corridor').sort((x, y) => Math.max(y.rect.w, y.rect.h) - Math.max(x.rect.w, x.rect.h))[0]!;
  const horiz = run.rect.w >= run.rect.h;
  const x0 = horiz ? run.rect.x + 0.7 : run.rect.x + run.rect.w / 2, z0 = horiz ? run.rect.y + run.rect.h / 2 : run.rect.y + 0.7;
  const dir: [number, number, number] = horiz ? [1, 0, 0] : [0, 0, 1];
  const far = horiz ? { x: x0 + 6, z: z0 } : { x: x0, z: z0 + 6 };
  await place(a, x0, z0, horiz ? Math.PI / 2 : 0);
  await a.dbg('interaction.setLights', { on: false });
  await a.dbg('interaction.give', { type: 'flashbulb' });
  await a.settle();
  const dark = await a.dbg<{ lit: boolean }>('interaction.litAt', far);
  await a.req('interaction.slot', { slot: slotOf('flashbulb') });
  const t = serverNow(a);
  r = await a.req('interaction.act', { dir, eye: [x0, 1.62, z0] });
  const lit = await a.dbg<{ lit: boolean }>('interaction.litAt', far);
  const ns = (await noisesSince(a, t)).filter((n) => n.kind === 'flash');
  ok(r.ok && !dark.lit && lit.lit, `flash lights the cone 6 m ahead (dark before: ${!dark.lit})`);
  ok(ns.length === 1 && ns[0]!.radiusM === 6, `6 m flash noise (${ns.map((n) => n.radiusM)})`);
  await sleep(2200);
  ok(!(await a.dbg<{ lit: boolean }>('interaction.litAt', far)).lit, 'dark again after 2 s');
  ok(a.ix.flashes && Object.keys(a.ix.flashes).length === 0, 'flash expired in the patch');
  await freeHands();
  // ---------------- curios in the special finds (rare, one per site, value 60-140, a CURIOS name)
  let curios = 0;
  for (let i = 0; i < 6 && curios < 2; i++) {
    await a.dbg('level.generate', { seed: `g3-curio-${i}`, players: 2 });
    await a.settle(900);
    const s = await a.dbg<{ items: Record<string, ItemState> }>('interaction.state');
    const cs = Object.values(s.items).filter((it) => it.type === 'loot.curio');
    ok(cs.length <= 1, `g3-curio-${i}: ${cs.length} curio`);
    for (const c of cs) { curios++; ok(c.value >= 60 && c.value <= 140 && CURIOS.includes(c.name ?? ''), `curio "${c.name}" $${c.value}`); }
  }
  ok(curios >= 1, `curios found over the seeds (${curios})`);
  // ---------------- hub: pool gear can't be dropped
  await a.dbg('level.hub');
  await a.settle(700);
  await a.dbg('interaction.give', { type: 'crowbar' });
  await a.settle();
  await a.req('interaction.slot', { slot: slotOf('crowbar') });
  r = await a.req('interaction.drop', {});
  ok(!r.ok, `hub: no dropping pool gear (${r.msg})`);
  const errs = await a.dbg<unknown>('interaction.state').then(() => 'ok').catch((e) => String(e));
  ok(errs === 'ok', 'server still answers');
} catch (e) {
  ok(false, `threw: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
} finally {
  a.close();
  srv.stop();
}
console.log(fails() ? `FAILED (${fails()})` : 'ALL PASS');
process.exit(fails() ? 1 : 0);
