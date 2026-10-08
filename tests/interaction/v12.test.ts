// v1.2 (G3) interaction server tests, in-process (interaction track only, fake meta + noise adapters):
// flags-off identity with v1.1, the server-timed hold-E, containers (containersOf or a test double), materials and the
// salvage pouch, the v1.2 gear, item events, hideIn / hasInteractHandler / stockContainer and the van upgrades.
// Run: node --test tests/interaction/v12.test.ts
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boot } from '../../apps/server/src/core/boot.ts';
import { setQuiet } from '../../apps/server/src/core/log.ts';
import { install } from '../../apps/server/src/interaction/index.ts';
import * as E from '../../apps/server/src/interaction/engine.ts';
import * as api from '../../apps/server/src/interaction/api.ts';
import type { Crew } from '../../apps/server/src/core/types.ts';
import type { ItemEvent, ItemState } from '../../packages/shared/src/messages/interaction.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import { containersOf } from '../../packages/shared/src/procgen/containers.ts';
import type { ContainerInfo } from '../../packages/shared/src/procgen/containers.ts';
import { Bot } from './bot.ts';
import { doorSpot } from './spots.ts';
import { ROOT, containerStand, fakeContainers } from './v12lib.ts';

let srv: Awaited<ReturnType<typeof boot>>;
let url = '';
interface N { x: number; z: number; radiusM: number; kind: string; source: string | null }
const noises: N[] = [];
const events: ItemEvent[] = [];
const stats: [string, string, number][] = [];
let unlocks: string[] = [];
const FLAGS = ['containers', 'easeDoors', 'materials', 'gearV12', 'nightVision'] as const;

before(async () => {
  setQuiet(true);
  srv = await boot({ mode: 'development', port: 0, tracks: [['interaction', install]], strict: true });
  url = `ws://127.0.0.1:${srv.port}/ws`;
  E.adapters.noise = { emitNoise: (_c, n) => { noises.push(n); } };
  E.adapters.meta = {
    recordStat: (_c: Crew, pid: string, key: string, n = 1) => { stats.push([pid, key, n]); },
    unlocks: () => unlocks.slice(),
  };
  api.onItemEvent((_c, e) => { events.push(e); });
});

after(async () => {
  await srv?.close();
  setTimeout(() => process.exit(0), 300).unref();
});

const crewOf = (code: string) => srv.ctx.crews.get(code)!;
const setFlags = (on: boolean) => { for (const f of FLAGS) srv.ctx.flags[f] = on; };
const inv = (b: Bot): ItemState[] => (b.ix.inventories[b.me] ?? []).filter(Boolean).map((id) => b.ix.items[id!]).filter(Boolean);
const place = (b: Bot, x: number, z: number, yaw = 0) => b.dbg('interaction.pose', { x, z, yaw });
let seq = 0;
async function crew(names: string[], layout: { name?: string; dir?: string; seed?: string } = { name: 'facility_s1_p2' }): Promise<{ bots: Bot[]; code: string; L: LevelLayout }> {
  const code = `V12${++seq}${Date.now() % 1000}`;
  const bots = names.map((n) => new Bot(n));
  for (const b of bots) await b.connect(url, code);
  await bots[0]!.dbg('interaction.loadLayout', layout);
  await bots[0]!.settle(200);
  return { bots, code, L: crewOf(code).layout! };
}
const norm = (items: Record<string, ItemState>) => Object.values(items).filter((it) => it.where === 'world')
  .map((it) => [it.type, +(it.p![0]).toFixed(3), +(it.p![1]).toFixed(3), +(it.p![2]).toFixed(3), it.value, it.count ?? null, it.name ?? null, it.tier ?? null, it.lock ?? null, +(it.rot ?? 0).toFixed(3)])
  .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

test('flags off: world spawns on the frozen v1.1 identity layouts are exactly v1.1; on: materials, batteries, no drift in salvage', async () => {
  const base = JSON.parse(readFileSync(join(ROOT, 'tests/interaction/fixtures/v11-spawns.json'), 'utf8')).layouts as Record<string, { items: unknown[]; ints: string[] }>;
  setFlags(false);
  try {
    for (const name of Object.keys(base)) {
      const { bots: [b], code } = await crew(['Ida'], { dir: 'identity-v11', name });
      const st = await b!.dbg<{ items: Record<string, ItemState>; ints: Record<string, { kind: string }> }>('interaction.state');
      assert.deepEqual(norm(st.items), base[name]!.items, `${name}: v1.1 spawns`);
      assert.deepEqual(Object.keys(st.ints).sort(), base[name]!.ints, `${name}: v1.1 interactables`);
      assert.equal(Object.keys(crewOf(code).slices.interaction ? E.slice(crewOf(code)).containers ?? {} : {}).length, 0);
      b!.close();
    }
  } finally {
    setFlags(true);
  }
  // flags on: the v1.1 floor salvage is unchanged while containersOf has no containers; materials + 2 batteries appear
  for (const name of Object.keys(base)) {
    const { bots: [b] } = await crew(['Ivo'], { dir: 'identity-v11', name });
    const st = await b!.dbg<{ items: Record<string, ItemState> }>('interaction.state');
    const v11Loot = (base[name]!.items as unknown[][]).filter((r) => String(r[0]).startsWith('loot.') && r[0] !== 'loot.idol');
    const loot = norm(st.items).filter((r) => String(r[0]).startsWith('loot.') && r[0] !== 'loot.idol' && r[0] !== 'loot.curio');
    if (!containersOf(b!.full!.layout as LevelLayout).length) assert.deepEqual(loot, v11Loot, `${name}: floor salvage unchanged`);
    const mats = Object.values(st.items).filter((it) => it.type.startsWith('mat.'));
    assert.ok(mats.length >= 6, `${name}: ${mats.length} material pickups`);
    assert.ok(mats.every((m) => (m.count ?? 0) >= 1 && (m.count ?? 0) <= 2), 'materials 1-2 units');
    assert.equal(Object.values(st.items).filter((it) => it.type === 'battery' && it.where === 'world').length, 2, `${name}: 2 world batteries`);
    b!.close();
  }
});

test('hold-E ease: release early = nothing, held = quiet open, walking away cancels, a teammate tap is loud and cancels', async () => {
  const { bots: [a, b], L } = await crew(['Ease', 'Mate']);
  const closed = L.doors.filter((d) => d.kind === 'door' && !d.initiallyOpen).map((d) => doorSpot(L, 'door', d.id)).find((x) => !!x);
  const sp = closed!;
  const did = sp.door.id;
  assert.equal(a!.ix.doors[did]!.open, false);
  await place(a!, sp.stand[0], sp.stand[1]);
  // 1) released at 0.9 s: unchanged, no noise
  noises.length = 0;
  let r = await a!.req<{ ok: boolean; t0?: number; ms?: number }>('interaction.ease', { id: sp.id, on: true });
  assert.equal(r.ok, true);
  assert.equal(r.ms, 1800, 'easeDoorMs');
  await a!.settle(60);
  assert.equal(a!.ix.doors[did]!.ease?.by, a!.me, 'everyone sees the ease (ring / door progress)');
  await a!.settle(840);
  const stop = await a!.req<{ ok: boolean; done?: boolean }>('interaction.ease', { id: sp.id, on: false });
  assert.equal(stop.done, false);
  await a!.settle(80);
  assert.equal(a!.ix.doors[did]!.open, false, 'released at 0.9 s: still closed');
  assert.equal(a!.ix.doors[did]!.ease, undefined);
  assert.equal(noises.length, 0, 'no noise');
  // 2) held 1.9 s: open, {doorSoft, 1}, no 6 m noise
  await a!.settle(200);
  noises.length = 0;
  stats.length = 0;
  r = await a!.req('interaction.ease', { id: sp.id, on: true });
  assert.equal(r.ok, true);
  await a!.settle(1900);
  assert.equal(a!.ix.doors[did]!.open, true, 'opened at 1.8 s');
  assert.deepEqual(noises.map((n) => [n.kind, n.radiusM]), [['doorSoft', 1]], 'one doorSoft 1 m noise');
  assert.ok(a!.events.some((ev) => ev.e === 'interaction.fx' && (ev.d as { kind: string; soft?: boolean; door?: number }).kind === 'door' && (ev.d as { soft?: boolean }).soft && (ev.d as { door?: number }).door === did), 'fx door {soft}');
  assert.ok(stats.some(([pid, k]) => pid === a!.me && k === 'doorsEased'), 'recordStat doorsEased');
  // 3) walking away mid-ease cancels
  await a!.settle(400);
  noises.length = 0;
  await a!.req('interaction.ease', { id: sp.id, on: true });
  await a!.settle(400);
  await place(a!, sp.stand[0] + (sp.door.dir === 'v' ? (sp.stand[0] < sp.door.x ? -3.5 : 3.5) : 0), sp.stand[1] + (sp.door.dir === 'h' ? (sp.stand[1] < sp.door.y ? -3.5 : 3.5) : 0));
  await a!.settle(1700);
  assert.equal(a!.ix.doors[did]!.open, true, 'walked off: the door stays open');
  assert.equal(a!.ix.doors[did]!.ease, undefined, 'ease cancelled');
  assert.equal(noises.length, 0);
  // 4) a teammate's tap: loud 6 m, cancels the ease
  await place(a!, sp.stand[0], sp.stand[1]);
  await place(b!, sp.stand[0], sp.stand[1]);
  await a!.settle(400);
  noises.length = 0;
  await a!.req('interaction.ease', { id: sp.id, on: true });
  await a!.settle(600);
  r = await b!.req('interaction.use', { id: sp.id });
  assert.equal(r.ok, true, 'the teammate tapped it shut');
  await a!.settle(1500);
  assert.equal(a!.ix.doors[did]!.open, false, 'the tap won');
  assert.equal(a!.ix.doors[did]!.ease, undefined, 'and cancelled the ease');
  assert.deepEqual(noises.map((n) => [n.kind, n.radiusM]), [['door', 6]], 'only the 6 m tap');
  // 5) use {hold:true} on a normal door is still 6 m (a client cannot make it quiet)
  await a!.settle(400);
  noises.length = 0;
  r = await a!.req('interaction.use', { id: sp.id, hold: true, soft: true });
  assert.equal(r.ok, true);
  assert.deepEqual(noises.map((n) => [n.kind, n.radiusM]), [['door', 6]], 'hold:true + a forged soft flag: still 6 m');
  // 6) a modified client: on/off in 50 ms, or from too far away, never commits
  await a!.settle(400);
  noises.length = 0;
  await a!.req('interaction.ease', { id: sp.id, on: true });
  await a!.settle(50);
  await a!.req('interaction.ease', { id: sp.id, on: false });
  await a!.req('interaction.ease', { id: sp.id, on: true });
  await a!.settle(300);
  await a!.req('interaction.ease', { id: sp.id, on: false });
  await a!.settle(1800);
  assert.equal(a!.ix.doors[did]!.open, true, 'never committed');
  assert.equal(noises.length, 0);
  await place(a!, sp.stand[0] + 6, sp.stand[1] + 6);
  r = await a!.req('interaction.ease', { id: sp.id, on: true });
  assert.equal(r.ok, false, 'from 6 m away: refused');
  // flag off: tap only
  srv.ctx.flags.easeDoors = false;
  await place(a!, sp.stand[0], sp.stand[1]);
  const off = await a!.req<{ ok: boolean; off?: boolean }>('interaction.ease', { id: sp.id, on: true });
  assert.deepEqual([off.ok, off.off], [false, true], 'easeDoors off: the client falls back to a tap');
  srv.ctx.flags.easeDoors = true;
  // fire doors ease slower
  const fire = doorSpot(L, 'fire');
  if (fire) {
    await place(a!, fire.stand[0], fire.stand[1]);
    await a!.settle(200);
    r = await a!.req('interaction.ease', { id: fire.id, on: true });
    assert.equal(r.ms, 2600, 'easeFireMs');
    await a!.req('interaction.ease', { id: fire.id, on: false });
  }
  a!.close();
  b!.close();
});

test('gear: lockpick (5 s, 6 m, unlocks), master keycard (locked + security, 3 charges), vault and rubble refused', async () => {
  const { bots: [a], L } = await crew(['Pick']);
  const lk = doorSpot(L, 'locked')!;
  const did = lk.door.id;
  await place(a!, lk.stand[0], lk.stand[1]);
  await a!.dbg('interaction.give', { type: 'lockpick' });
  await a!.settle();
  let r = await a!.req<{ ok: boolean; msg?: string; ms?: number }>('interaction.use', { id: lk.id });
  assert.deepEqual(r, { ok: false, msg: 'Hold E: pick the lock (loud)' });
  noises.length = 0;
  events.length = 0;
  r = await a!.req('interaction.ease', { id: lk.id, on: true });
  assert.equal(r.ms, 5000, 'lockpickMs');
  assert.equal(a!.ix.doors[did]!.ease?.kind ?? 'pick', 'pick');
  await a!.settle(2500);
  assert.equal(a!.ix.doors[did]!.locked, true, 'still picking at 2.5 s');
  await a!.settle(2700);
  assert.equal(a!.ix.doors[did]!.locked, false, 'unlocked at 5 s');
  assert.equal(a!.ix.doors[did]!.open, false, 'the door stays shut');
  assert.deepEqual(noises.map((n) => [n.kind, n.radiusM]), [['lockpick', 6]]);
  assert.equal(inv(a!).find((it) => it.type === 'lockpick')?.count, 2, 'one pick used');
  assert.ok(events.some((e) => e.kind === 'use' && e.type === 'lockpick') && events.some((e) => e.kind === 'consume' && e.type === 'lockpick'));
  // the vault and rubble are never picked / keyed
  const vault = doorSpot(L, 'vault')!;
  await place(a!, vault.stand[0], vault.stand[1]);
  await a!.dbg('interaction.give', { type: 'masterkey' });
  await a!.settle();
  r = await a!.req('interaction.use', { id: vault.id });
  assert.equal(r.ok, false, 'master keycard on the vault: refused');
  r = await a!.req('interaction.ease', { id: vault.id, on: true });
  assert.equal(r.ok, false, 'lockpick on the vault: refused');
  assert.equal(a!.ix.doors[vault.door.id]!.open, false);
  const rubble = L.doors.find((d) => d.kind === 'blocked');
  if (rubble) {
    r = await a!.req('interaction.use', { id: `door:${rubble.id}` });
    assert.equal(r.ok, false, 'rubble: refused');
    r = await a!.req('interaction.ease', { id: `door:${rubble.id}`, on: true });
    assert.equal(r.ok, false, 'rubble: no lockpick');
  }
  // master keycard: a fresh locked layout opens at once, a security door moves at a tap with a 5 m 'door' noise
  const { bots: [k], L: L2 } = await crew(['Key']);
  const lk2 = doorSpot(L2, 'locked')!;
  await k!.dbg('interaction.give', { type: 'masterkey' });
  await place(k!, lk2.stand[0], lk2.stand[1]);
  await k!.settle();
  const mk = () => inv(k!).find((it) => it.type === 'masterkey');
  assert.equal(mk()?.count, 3, '3 charges');
  noises.length = 0;
  r = await k!.req('interaction.use', { id: lk2.id });
  assert.equal(r.ok, true, `opened: ${r.msg}`);
  assert.equal(k!.ix.doors[lk2.door.id]!.open, true);
  assert.equal(k!.ix.doors[lk2.door.id]!.locked, false);
  assert.equal(mk()?.count, 2);
  const sec = doorSpot(L2, 'security')!;
  await place(k!, sec.stand[0], sec.stand[1]);
  await k!.settle(400);
  const was = k!.ix.doors[sec.door.id]!.open;
  noises.length = 0;
  r = await k!.req('interaction.use', { id: sec.id });
  assert.equal(r.ok, true);
  assert.equal(k!.ix.doors[sec.door.id]!.open, !was, 'security door moved at a tap');
  assert.deepEqual(noises.map((n) => [n.kind, n.radiusM]), [['door', 5]], 'a 5 m door noise, no 12 m clank');
  assert.equal(mk()?.count, 1);
  await k!.settle(400);
  r = await k!.req('interaction.use', { id: sec.id });
  assert.equal(r.ok, true);
  assert.equal(mk(), undefined, 'out of charges: the keycard is gone');
  r = await k!.req('interaction.use', { id: sec.id });
  assert.equal(r.ok, false, 'no charges: hold again');
  a!.close();
  k!.close();
});

test('gear: battery, night vision (module, auto-off, flag), flashbulb cone + 6 m + use event, overshoes, hub drop refusal', async () => {
  const { bots: [a], code, L } = await crew(['Nina']);
  const c = crewOf(code);
  // battery: LMB = one used, fx battery to the owner
  await a!.dbg('interaction.give', { type: 'battery' });
  await a!.settle();
  const bat = inv(a!).find((it) => it.type === 'battery')!;
  assert.equal(bat.count, 2, 'stack 2');
  await a!.req('interaction.slot', { slot: a!.ix.inventories[a!.me]!.indexOf(bat.id) });
  let r = await a!.req<{ ok: boolean; msg?: string; on?: boolean }>('interaction.act', { dir: [0, 0, 1] });
  assert.equal(r.ok, true);
  assert.equal(a!.ix.items[bat.id]!.count, 1);
  assert.ok((await a!.waitEvent('interaction.fx', (d: { kind: string; pid?: string }) => d.kind === 'battery' && d.pid === a!.me)).d);
  // night vision
  r = await a!.req('interaction.nv', { on: true });
  assert.deepEqual([r.ok, r.on], [false, false], 'needs the module');
  await a!.dbg('interaction.give', { type: 'nvg' });
  await a!.settle();
  r = await a!.req('interaction.nv', { on: true });
  assert.deepEqual([r.ok, r.on], [true, true]);
  await a!.settle();
  assert.equal(a!.ix.nv?.[a!.me], true, 'nv[pid] in the patch');
  assert.equal(api.nightVision(c, a!.me), true);
  // never light: a dark spot stays dark
  srv.ctx.flags.nightVision = false;
  await a!.settle(80);
  assert.equal(a!.ix.nv?.[a!.me], undefined, 'flag off: switched off');
  srv.ctx.flags.nightVision = true;
  r = await a!.req('interaction.nv', { on: true });
  assert.equal(r.on, true);
  const nvg = inv(a!).find((it) => it.type === 'nvg')!;
  await a!.req('interaction.slot', { slot: a!.ix.inventories[a!.me]!.indexOf(nvg.id) });
  await a!.req('interaction.drop', {});
  await a!.settle(80);
  assert.equal(a!.ix.nv?.[a!.me], undefined, 'dropping the module switches it off');
  // flashbulb: cone 14 m / 25 deg with LOS for 2 s, 6 m pop, use event with p + dir
  const run = L.spaces.filter((s) => s.kind === 'corridor').sort((x, y) => Math.max(y.rect.w, y.rect.h) - Math.max(x.rect.w, x.rect.h))[0]!;
  const horiz = run.rect.w >= run.rect.h;
  const x0 = horiz ? run.rect.x + 0.7 : run.rect.x + run.rect.w / 2, z0 = horiz ? run.rect.y + run.rect.h / 2 : run.rect.y + 0.7;
  const dir: [number, number, number] = horiz ? [1, 0, 0] : [0, 0, 1];
  const far: [number, number] = horiz ? [x0 + 6, z0] : [x0, z0 + 6];
  await place(a!, x0, z0, horiz ? Math.PI / 2 : 0);
  await a!.dbg('interaction.setLights', { on: false });
  assert.equal(api.litAt(c, far[0], far[1]), false, 'dark corridor');
  await a!.dbg('interaction.give', { type: 'flashbulb' });
  await a!.settle();
  const fb = inv(a!).find((it) => it.type === 'flashbulb')!;
  await a!.req('interaction.slot', { slot: a!.ix.inventories[a!.me]!.indexOf(fb.id) });
  noises.length = 0;
  events.length = 0;
  r = await a!.req('interaction.act', { dir, eye: [x0, 1.62, z0] });
  assert.equal(r.ok, true);
  assert.equal(api.litAt(c, far[0], far[1]), true, 'lit inside the cone');
  assert.equal(api.litAt(c, x0 - dir[0] * 4, z0 - dir[2] * 4), false, 'not behind the flash');
  assert.deepEqual(noises.map((n) => [n.kind, n.radiusM]), [['flash', 6]]);
  const use = events.find((e) => e.kind === 'use' && e.type === 'flashbulb');
  assert.ok(use?.p && use.dir, 'use event carries p and dir (monsters flinch)');
  r = await a!.req('interaction.act', { dir, eye: [x0, 1.62, z0] });
  assert.equal(r.ok, false, '1.2 s cooldown');
  await a!.settle(2100);
  assert.equal(api.litAt(c, far[0], far[1]), false, 'after 2 s: dark again');
  // overshoes are read by players through holding()
  await a!.dbg('interaction.give', { type: 'soles' });
  await a!.settle();
  assert.equal(api.holding(c, a!.me, 'soles'), true);
  a!.close();
  // hub: pool gear cannot be dropped (gear-pool dupe), other things can
  const { bots: [h] } = await crew(['Hub'], { name: 'hub' });
  await h!.dbg('interaction.give', { type: 'crowbar' });
  await h!.settle();
  const bar = inv(h!).find((it) => it.type === 'crowbar')!;
  await h!.req('interaction.slot', { slot: h!.ix.inventories[h!.me]!.indexOf(bar.id) });
  r = await h!.req('interaction.drop', {});
  assert.equal(r.ok, false, `hub drop refused: ${r.msg}`);
  await h!.dbg('interaction.give', { type: 'soles' });
  await h!.settle();
  const so = inv(h!).find((it) => it.type === 'soles')!;
  await h!.req('interaction.slot', { slot: h!.ix.inventories[h!.me]!.indexOf(so.id) });
  r = await h!.req('interaction.drop', {});
  assert.equal(r.ok, true, 'overshoes are not pool gear');
  h!.close();
});

test('containers: interactables, private contents, tap (noise + 300 ms), ease (1 m), second open denied, stocked page consumed on pickup', async () => {
  const { bots: [a], code, L } = await crew(['Desk']);
  const c = crewOf(code);
  let list: readonly ContainerInfo[] = containersOf(L);
  if (!list.length) {
    list = fakeContainers(L);
    await a!.dbg('interaction.containers', { list });
    await a!.settle(120);
  }
  assert.ok(list.length >= 3, `${list.length} containers`);
  const ints = Object.values(a!.ix.ints).filter((i) => i.kind === 'container');
  assert.deepEqual(ints.map((i) => i.id).sort(), list.map((x) => `cont:${x.id}`).sort(), 'one interactable per container');
  assert.ok(ints.every((i) => i.r === 0.32 && /^Search the /.test(i.prompt)));
  // contents are private: rolled (peek), but no world item in any closed container's slot
  const peek = await a!.dbg<{ contents: Record<string, { type: string; name?: string }[]> }>('interaction.peek');
  assert.ok(Object.values(peek.contents).some((l) => l.length > 0), 'some containers hold something');
  assert.ok(Object.values(peek.contents).some((l) => l.length === 0), 'some are empty');
  for (const x of list) {
    const sl = (x.parts.find((p) => p.idx === x.main) ?? x.parts[0])!.slot;
    assert.ok(!Object.values(a!.ix.items).some((it) => it.where === 'world' && it.p && Math.hypot(it.p[0] - sl[0], it.p[2] - sl[2]) < 0.2 && it.p[1] > 0.3), `nothing visible in ${x.id}`);
  }
  // stock a page into the first container (fieldguide), tap it open
  const c0 = list[0]!;
  assert.equal(api.stockContainer(c, c0.id, { type: 'page', name: 'hound.2' }), true);
  assert.equal(api.stockContainer(c, 'nope', { type: 'page', name: 'x' }), false);
  const [sx, sz] = containerStand(c0);
  await place(a!, sx, sz);
  noises.length = 0;
  stats.length = 0;
  const patches0 = a!.events.length;
  let r = await a!.req<{ ok: boolean; msg?: string }>('interaction.use', { id: `cont:${c0.id}` });
  assert.equal(r.ok, true, `tap: ${r.msg}`);
  assert.equal(a!.ix.containers?.[c0.id]?.open, 1 << c0.main, 'main part open');
  assert.equal(noises.length, 1);
  assert.equal(noises[0]!.kind, 'drawer');
  assert.ok(noises[0]!.radiusM >= 4 && noises[0]!.radiusM <= 6, `drawer noise ${noises[0]!.radiusM} m`);
  assert.ok(stats.some(([, k]) => k === 'drawersSearched'));
  const pageNow = () => Object.values(a!.ix.items).find((it) => it.type === 'page' && it.name === 'hound.2');
  await a!.settle(60);
  assert.equal(pageNow(), undefined, 'contents wait for the drawer to open');
  await a!.settle(400);
  const page = pageNow();
  assert.ok(page && page.where === 'world', 'the stocked page appears in the drawer');
  const slot = (c0.parts.find((p) => p.idx === c0.main) ?? c0.parts[0])!.slot;
  assert.ok(Math.hypot(page!.p![0] - slot[0], page!.p![2] - slot[2]) < 0.5, 'in the main part slot');
  // contents never in a patch before the opening
  const early = a!.events.slice(0, patches0).filter((ev) => ev.e === 'interaction.patch').map((ev) => JSON.stringify(ev.d)).join('');
  assert.ok(!early.includes('hound.2'), 'page id never sent before the opening');
  r = await a!.req('interaction.use', { id: `cont:${c0.id}` });
  assert.equal(r.ok, false, 'a second open is denied');
  r = await a!.req('interaction.ease', { id: `cont:${c0.id}`, on: true });
  assert.equal(r.ok, false, 'no ease on a searched container');
  // the page is filed on pickup: no slot, gone from the world, event after the state change
  events.length = 0;
  let seen: { inWorld: boolean } | null = null;
  const off = api.onItemEvent((cc, e) => { if (e.type === 'page') seen = { inWorld: !!E.slice(cc).items[e.id] }; });
  r = await a!.req('interaction.use', { id: page!.id });
  off();
  assert.equal(r.ok, true);
  assert.equal(inv(a!).some((it) => it.type === 'page'), false, 'no slot used');
  assert.deepEqual(seen, { inWorld: false }, 'pickup event after the page left the world');
  assert.ok(events.some((e) => e.kind === 'pickup' && e.type === 'page' && e.name === 'hound.2' && e.fresh === true));
  // ease: a quiet open (1 m) and the contents at once
  const c1 = list.find((x) => x.id !== c0.id && Math.hypot(containerStand(x)[0] - sx, containerStand(x)[1] - sz) > 0.1)!;
  api.stockContainer(c, c1.id, { type: 'page', name: 'listener.1' });
  await place(a!, ...containerStand(c1));
  await a!.settle(200);
  noises.length = 0;
  r = await a!.req('interaction.ease', { id: `cont:${c1.id}`, on: true });
  assert.equal(r.ok, true);
  assert.equal((r as { ms?: number }).ms, 1200, 'easeContainerMs');
  await a!.settle(60);
  assert.equal(a!.ix.containers?.[c1.id]?.ease?.by, a!.me, 'ease visible (progress)');
  await a!.settle(1300);
  assert.equal(a!.ix.containers?.[c1.id]?.open, 1 << c1.main);
  assert.deepEqual(noises.map((n) => [n.kind, n.radiusM]), [['drawerSoft', 1]]);
  assert.ok(Object.values(a!.ix.items).some((it) => it.type === 'page' && it.name === 'listener.1'), 'contents at once');
  assert.ok(a!.events.some((ev) => ev.e === 'interaction.fx' && (ev.d as { kind: string; soft?: boolean }).kind === 'container' && (ev.d as { soft?: boolean }).soft));
  // flag off: no containers, the loot budget back on the floor
  srv.ctx.flags.containers = false;
  const { bots: [o] } = await crew(['Off']);
  await o!.dbg('interaction.containers', { list: fakeContainers(o!.full!.layout as LevelLayout) });
  await o!.settle(100);
  assert.equal(Object.values(o!.ix.ints).filter((i) => i.kind === 'container').length, 0, 'containers off: none');
  srv.ctx.flags.containers = true;
  assert.equal(api.hasInteractHandler('container'), true);
  a!.close();
  o!.close();
});

test('materials: pouch pickup (no slot), death drop + merge, deposit -> stash events, takeVanMaterials (deposit, van floor, living in van), buzzer', async () => {
  const { bots: [a, b], code, L } = await crew(['Mat', 'Pal']);
  const c = crewOf(code);
  const mats = Object.values(a!.ix.items).filter((it) => it.type.startsWith('mat.') && it.where === 'world');
  assert.ok(mats.length >= 6, `${mats.length} material pickups on the site`);
  const m = mats[0]!;
  await place(a!, m.p![0], m.p![2] - 0.5);
  events.length = 0;
  let r = await a!.req<{ ok: boolean; msg?: string }>('interaction.use', { id: m.id });
  assert.equal(r.ok, true, `pickup: ${r.msg}`);
  assert.equal(inv(a!).length, 0, 'no slot used');
  assert.equal(a!.ix.pouches?.[a!.me]?.[m.type], m.count, 'into the pouch');
  assert.deepEqual(api.pouchOf(c, a!.me), { [m.type]: m.count });
  const pe = events.find((e) => e.kind === 'pickup' && e.type === m.type);
  assert.ok(pe && pe.fresh === true && pe.count === m.count, 'pickup event (fresh)');
  // death drops the pouch as one item; a teammate's pickup merges it
  await place(a!, 12, 23);
  api.kill(c, a!.me, { killer: 'HOUND', reason: 'heard your SPRINT (9 m)' });
  await a!.settle();
  const pouch = Object.values(b!.ix.items).find((it) => it.type === 'mat.pouch')!;
  assert.ok(pouch && pouch.mats?.[m.type] === m.count, 'pouch item with the mats');
  assert.equal(a!.ix.pouches?.[a!.me], undefined);
  await b!.dbg('interaction.give', { type: 'mat.scrap', count: 1 });
  await place(b!, pouch.p![0], pouch.p![2] - 0.4);
  r = await b!.req('interaction.use', { id: pouch.id });
  assert.equal(r.ok, true);
  const want: Record<string, number> = { 'mat.scrap': 1 };
  want[m.type] = (want[m.type] ?? 0) + m.count!;
  assert.deepEqual(b!.ix.pouches?.[b!.me], want, 'merged into the picker pouch');
  // deposit at the van: pouch -> stash, fx stash + one stash event per type, never the deposit listeners
  const dep = Object.values(b!.ix.ints).find((i) => i.kind === 'deposit')!;
  await place(b!, dep.p[0], dep.p[2] + 0.4);
  const deposited: unknown[] = [];
  api.onDeposit((_c, _p, items) => deposited.push(...items));
  events.length = 0;
  r = await b!.req('interaction.use', { id: dep.id });
  assert.equal(r.ok, true, `deposit: ${r.msg}`);
  assert.equal(b!.ix.pouches?.[b!.me], undefined, 'pouch emptied');
  assert.deepEqual(api.vanMaterials(c), want, 'in the van stash');
  assert.equal(deposited.length, 0, 'materials never reach onDeposit');
  assert.deepEqual(events.filter((e) => e.kind === 'stash').map((e) => [e.type, e.count]).sort(), Object.entries(want).sort());
  assert.ok(b!.events.some((ev) => ev.e === 'interaction.fx' && (ev.d as { kind: string }).kind === 'stash'));
  // the timeout path: a material dropped on the van floor + a living player's pouch inside the van
  const van = L.van.cab;
  api.spawnItem(c, 'mat.optics', [van.x + 0.5, 0, van.y + 0.5], { count: 2 });
  await b!.dbg('interaction.give', { type: 'mat.chem', count: 3 });
  await place(b!, van.x + van.w / 2, van.y + van.h / 2);
  await b!.settle();
  const take = api.takeVanMaterials(c);
  const total: Record<string, number> = { ...want };
  total['mat.optics'] = (total['mat.optics'] ?? 0) + 2;
  total['mat.chem'] = (total['mat.chem'] ?? 0) + 3;
  assert.deepEqual(take, total, 'deposited + van floor + the pouch of a living player in the van');
  assert.deepEqual(api.takeVanMaterials(c), {}, 'cleared');
  assert.deepEqual(api.pouchOf(c, b!.me), {});
  // the buzzer path (depositLoot) also stashes the pouch
  await b!.dbg('interaction.give', { type: 'mat.wiring', count: 2 });
  api.depositLoot(c, b!.me);
  assert.deepEqual(api.vanMaterials(c), { 'mat.wiring': 2 });
  // a contract ending clears pouches and the stash
  await b!.dbg('interaction.give', { type: 'mat.cells', count: 1 });
  await b!.dbg('interaction.loadLayout', { name: 'hub' });
  await b!.settle(150);
  assert.deepEqual(api.vanMaterials(c), {});
  assert.deepEqual(api.pouchOf(c, b!.me), {});
  a!.close();
  b!.close();
});

test('item events (acquire via, pickup fresh/not, drop, deposit with name + value, filed badge), stretcher upgrade, hideIn', async () => {
  const { bots: [a, b], code } = await crew(['Evt', 'Bud']);
  const c = crewOf(code);
  events.length = 0;
  api.giveItem(c, a!.me, 'flare', { count: 3, via: 'craft' });
  await a!.dbg('interaction.give', { type: 'loot.small', value: 40, name: 'Pocket watch', via: 'safe' });
  assert.ok(events.some((e) => e.kind === 'acquire' && e.type === 'flare' && e.via === 'craft' && e.count === 3));
  assert.ok(events.some((e) => e.kind === 'acquire' && e.type === 'loot.small' && e.via === 'safe'));
  await a!.settle();
  const fl = inv(a!).find((it) => it.type === 'flare')!;
  await a!.req('interaction.slot', { slot: a!.ix.inventories[a!.me]!.indexOf(fl.id) });
  await a!.req('interaction.drop', {});
  assert.ok(events.some((e) => e.kind === 'drop' && e.type === 'flare' && e.count === 3));
  await a!.settle();
  events.length = 0;
  const dropped = a!.ix.items[fl.id]!;
  await place(a!, dropped.p![0], dropped.p![2] - 0.4);
  await a!.req('interaction.use', { id: fl.id });
  assert.ok(events.some((e) => e.kind === 'pickup' && e.type === 'flare' && e.fresh === false), 'a dropped item is not fresh');
  // deposit: each loot item with name and value
  const dep = Object.values(a!.ix.ints).find((i) => i.kind === 'deposit')!;
  await place(a!, dep.p[0], dep.p[2] + 0.4);
  events.length = 0;
  await a!.req('interaction.use', { id: dep.id });
  assert.ok(events.some((e) => e.kind === 'deposit' && e.type === 'loot.small' && e.name === 'Pocket watch' && e.value === 40));
  // stretcher: a filed badge respawns in 8 s at 75 hp (fast-forward via tune), the filer gets a badge deposit event
  unlocks = ['stretcher'];
  await a!.dbg('interaction.tune', { stretcherReviveSec: 0.4 });
  await place(b!, 12, 23);
  api.kill(c, b!.me, { killer: 'HOUND', reason: 'heard your FOOTSTEPS (5 m)' });
  await a!.settle();
  const badge = Object.values(a!.ix.items).find((it) => it.type === 'badge' && it.owner === b!.me)!;
  await place(a!, badge.p![0], badge.p![2] - 0.4);
  await a!.req('interaction.use', { id: badge.id });
  await place(a!, dep.p[0], dep.p[2] + 0.4);
  events.length = 0;
  await a!.req('interaction.use', { id: dep.id });
  assert.ok(events.some((e) => e.kind === 'deposit' && e.type === 'badge' && e.pid === a!.me), 'badge filer event');
  const rev = await b!.waitEvent('interaction.revive', (d: { how: string }) => d.how === 'badge', 3000);
  assert.equal((rev.d as { hp: number }).hp, 75, 'stretcher: 75 hp');
  unlocks = [];
  await a!.dbg('interaction.tune', { stretcherReviveSec: 8 });
  // hideIn: a duct spot hides (stance hidden, no light, use/act/drop blocked), unhide() ends it
  assert.equal(api.hideIn(c, a!.me, 'duct:vent:0'), true);
  assert.equal(api.isHidden(c, a!.me), true);
  assert.equal(api.hiddenIn(c, a!.me), 'duct:vent:0');
  const pl = c.players.get(a!.me)!;
  assert.equal(pl.pose.stance, 3);
  assert.equal((await a!.req<{ ok: boolean }>('interaction.use', { id: dep.id })).ok, false, 'use blocked in a duct');
  assert.equal((await a!.req<{ ok: boolean }>('interaction.act', { dir: [0, 0, 1] })).ok, false, 'act blocked');
  assert.equal(api.unhide(c, a!.me), true);
  assert.equal(api.isHidden(c, a!.me), false);
  // gate checks
  for (const k of ['container', 'door', 'locker', 'deposit']) assert.equal(api.hasInteractHandler(k), true, k);
  assert.equal(api.hasInteractHandler('workbench-nobody'), false);
  a!.close();
  b!.close();
});
