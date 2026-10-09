// v1.3 F3 (G3) noise lure + field receiver, in-process (interaction track only, a fake noise adapter):
// - flags noiseLure / fieldReceiver, missing = off: the two ITEM_DEFS entries leave the shared table (the bench hides
//   the recipes, as in v1.2) and LMB with one is refused; held items stay (flags never touch persistence);
// - a lure is thrown (snapshot dyn 'thrown:lure:*'), lands armed with the picked fuse (0 / 5 / 10 / 20 s, anything else
//   = on landing), rattles lureRattles times over lureSpanSec (a 12 m 'lure' noise each, source = the lure's item id,
//   fx 'lure' 1..3), and is used up by the last rattle; picked back up it stops (and merges into the stack); with the
//   flag switched off an armed lure goes quiet (and stays armed);
// - the receiver: one charge = a 6 s listen (contracts only, never two at once), ear to a closed door within reach =
//   the same listen plus the space behind that door; an open, missing or far door is refused.
// Run: node --test tests/interaction/f3.test.ts   (boots the interaction track on IX_TEST_PORT, default 3803)
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from '../../apps/server/src/core/boot.ts';
import { setQuiet } from '../../apps/server/src/core/log.ts';
import { install } from '../../apps/server/src/interaction/index.ts';
import * as E from '../../apps/server/src/interaction/engine.ts';
import * as api from '../../apps/server/src/interaction/api.ts';
import { ITEM_DEFS, itemLabel } from '../../packages/shared/src/interactables.ts';
import type { Crew } from '../../apps/server/src/core/types.ts';
import type { ItemEvent, ItemState } from '../../packages/shared/src/messages/interaction.ts';
import type { LayoutDoor, LevelLayout } from '../../packages/shared/src/layout.ts';
import { Bot } from './bot.ts';

let srv: Awaited<ReturnType<typeof boot>>;
let url = '';
interface N { x: number; z: number; radiusM: number; kind: string; source: string | null }
const noises: N[] = [];
const events: ItemEvent[] = [];
const PORT = Number(process.env.IX_TEST_PORT ?? 3803);

before(async () => {
  setQuiet(true);
  srv = await boot({ mode: 'development', port: PORT, tracks: [['interaction', install]], strict: true });
  url = `ws://127.0.0.1:${srv.port}/ws`;
  E.adapters.noise = { emitNoise: (_c, n) => { noises.push(n); } };
  api.onItemEvent((_c, e) => { events.push(e); });
});

after(async () => {
  await srv?.close();
  setTimeout(() => process.exit(0), 300).unref();
});

type XZ = [number, number];
const crewOf = (code: string): Crew => srv.ctx.crews.get(code)!;
let seq = 0;
async function crew(names: string[], phase?: 'hub' | 'contract'): Promise<{ bots: Bot[]; code: string; L: LevelLayout }> {
  const code = `F3${++seq}${Date.now() % 1000}`;
  const bots = names.map((n) => new Bot(n));
  for (const b of bots) await b.connect(url, code);
  await bots[0]!.dbg('interaction.loadLayout', { name: 'facility_s1_p2', ...(phase ? { phase } : {}) });
  await bots[0]!.settle(150);
  return { bots, code, L: crewOf(code).layout! };
}
async function setFlags(b: Bot, set: Record<string, boolean>): Promise<void> {
  await b.dbg('setFlags', { set });
}
const inv = (b: Bot): ItemState[] => (b.ix.inventories[b.me] ?? []).filter(Boolean).map((id) => b.ix.items[id!]!).filter(Boolean);
const place = (b: Bot, x: number, z: number, yaw = 0) => b.dbg('interaction.pose', { x, z, yaw });
const spaceAt = (L: LevelLayout, x: number, z: number): number => {
  const cx = Math.floor(x), cz = Math.floor(z);
  return cx < 0 || cz < 0 || cx >= L.W || cz >= L.H ? -1 : (L.owner[cz * L.W + cx] ?? -1);
};
async function waitFor(pred: () => boolean, ms = 3000, step = 20): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return pred();
}
async function holdActive(b: Bot, type: string, count?: number): Promise<ItemState> {
  const it = await b.dbg<ItemState>('interaction.give', { type, ...(count !== undefined ? { count } : {}) });
  await b.settle(60);
  const slot = (b.ix.inventories[b.me] ?? []).indexOf(it.id);
  await b.req('interaction.slot', { slot });
  await b.settle(40);
  return it;
}
/** a room cell centre of the layout's biggest room (a clear floor to throw at) */
function bigRoom(L: LevelLayout): XZ {
  const room = [...L.spaces].filter((s) => s.kind === 'room' && s.type !== 'van').sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h)[0]!;
  return [room.rect.x + room.rect.w / 2, room.rect.y + room.rect.h / 2];
}
/** a closed plain door and a stand spot `dist` m off its centre on a walkable side */
function closedDoor(L: LevelLayout, dist = 0.6): { d: LayoutDoor; stand: XZ } {
  for (const d of L.doors) {
    if (d.kind !== 'door' || d.initiallyOpen) continue;
    const cx = d.dir === 'v' ? d.x : d.x + d.len / 2, cz = d.dir === 'v' ? d.y + d.len / 2 : d.y;
    const nx = d.dir === 'v' ? 1 : 0, nz = 1 - nx;
    for (const s of [-1, 1]) {
      const x = cx + s * nx * dist, z = cz + s * nz * dist;
      const there = spaceAt(L, x, z), across = spaceAt(L, cx - s * nx * 0.5, cz - s * nz * 0.5);
      if (there >= 0 && across >= 0 && there !== across) return { d, stand: [x, z] };
    }
  }
  throw new Error(`${L.seed}: no closed plain door between two spaces`);
}

test('flags off (missing): no lure / receiver defs, LMB refused, held items untouched; on: both defs back', async () => {
  // at boot the defs follow config/flags.json (a missing flag = off)
  assert.equal('lure' in ITEM_DEFS, srv.ctx.flags.noiseLure === true, 'boot: lure def follows its flag');
  assert.equal('receiver' in ITEM_DEFS, srv.ctx.flags.fieldReceiver === true, 'boot: receiver def follows its flag');
  const { bots: [a] } = await crew(['Fia']);
  await setFlags(a!, { noiseLure: false, fieldReceiver: false });
  assert.equal('lure' in ITEM_DEFS, false, 'flag off: the lure is not an implemented item (the bench hides its recipe)');
  assert.equal('receiver' in ITEM_DEFS, false);
  // a crafted stack from an earlier flag-on night is still a held item (never deleted by a flag)
  const lure = await holdActive(a!, 'lure', 2);
  let r = await a!.req<{ ok: boolean; msg?: string }>('interaction.act', { dir: [0, -1, 0] });
  assert.equal(r.ok, false);
  assert.match(r.msg ?? '', /not cleared/);
  assert.equal(a!.ix.items[lure.id]?.count, 2, 'nothing thrown, nothing consumed');
  const rc = await holdActive(a!, 'receiver', 5);
  r = await a!.req('interaction.act', { dir: [0, 0, 1] });
  assert.equal(r.ok, false);
  assert.equal(a!.ix.items[rc.id]?.count, 5);
  await setFlags(a!, { noiseLure: true, fieldReceiver: true });
  assert.ok(ITEM_DEFS.lure && ITEM_DEFS.receiver, 'flags on: both registered again (config hook)');
  assert.equal(ITEM_DEFS.lure!.use, 'throw');
  assert.equal(ITEM_DEFS.receiver!.unit, 'charge');
  assert.equal(itemLabel({ type: 'receiver', count: 5 }), 'Field receiver (5 charges)');
  assert.equal(itemLabel({ type: 'lure', count: 2 }), 'Noise lure x2');
  // one flag on its own
  await setFlags(a!, { fieldReceiver: false });
  assert.ok(ITEM_DEFS.lure && !ITEM_DEFS.receiver);
  await setFlags(a!, { fieldReceiver: true });
  a!.close();
});

test('lure fuse values: 0 / 5 / 10 / 20 s, anything else lands rattling', () => {
  assert.deepEqual([0, 5, 10, 20, '10', 7, -5, 'x', null, undefined, 1e9].map((v) => E.lureFuse(v)), [0, 5, 10, 20, 10, 0, 0, 0, 0, 0, 0]);
});

test('a thrown lure flies, lands armed and rattles 3 times (12 m, at the lure, 4 s apart), then is used up', async () => {
  const { bots: [a], code, L } = await crew(['Lou']);
  await setFlags(a!, { noiseLure: true });
  const lure = await holdActive(a!, 'lure', 2);
  const [x, z] = bigRoom(L);
  await place(a!, x, z, 0);
  noises.length = 0;
  events.length = 0;
  const r = await a!.req<{ ok: boolean }>('interaction.act', { dir: [0, 0.15, 1], eye: [x, 1.62, z], fuse: 0 });
  assert.equal(r.ok, true);
  await a!.settle(60);
  assert.equal(a!.ix.items[lure.id]?.count, 1, 'one of the two thrown');
  assert.deepEqual(events.filter((e) => e.type === 'lure').map((e) => e.kind), ['use', 'consume']);
  assert.ok(await waitFor(() => !!a!.lastSnap?.dyn.some((d) => d.id.startsWith('thrown:lure:')), 1500), 'in flight in the snapshot dyn');
  const land = await a!.waitEvent('interaction.fx', (d: { kind: string; item?: string }) => d.kind === 'drop' && d.item === 'lure', 4000);
  const lp = (land.d as { p: [number, number, number]; id: string }).p;
  const lid = (land.d as { id: string }).id;
  assert.ok(lp[2] > z + 1, `it flew forward (${(lp[2] - z).toFixed(1)} m)`);
  await a!.settle(60);
  const world = a!.ix.items[lid]!;
  assert.equal(world.type, 'lure');
  assert.equal(world.where, 'world');
  assert.equal(world.armed, true, 'armed (E picks it back up)');
  assert.ok(noises.some((n) => n.kind === 'landThud' && n.radiusM === 2), 'a 2 m landing knock (under every hearing threshold)');
  // fuse 0: the first rattle on landing, the next ones 4 s apart (lureSpanSec 8 over 3 rattles)
  assert.ok(await waitFor(() => noises.some((n) => n.kind === 'lure'), 600), 'first rattle at landing');
  const first = noises.find((n) => n.kind === 'lure')!;
  assert.equal(first.radiusM, 12);
  assert.equal(first.source, lid, 'source = the lure itself (monsters go to the lure, never to the thrower)');
  assert.ok(Math.hypot(first.x - lp[0], first.z - lp[2]) < 0.05, 'at the lure');
  const run = E.f3Peek(crewOf(code)).lures.find((q) => q.id === lid)!;
  assert.equal(run.n, 1);
  const fx1 = a!.events.filter((ev) => ev.e === 'interaction.fx' && (ev.d as { kind: string }).kind === 'lure');
  assert.equal(fx1.length, 1);
  assert.equal((fx1[0]!.d as { count: number; open: boolean }).count, 1);
  assert.equal((fx1[0]!.d as { open: boolean }).open, true);
  const firstAt = Number(fx1[0]!.t);
  assert.ok(Math.abs(run.at - firstAt - 4000) < 120, `the next rattle 4 s later (${run.at - firstAt} ms)`);
  // speed the rest up (balance is read live)
  await a!.dbg('interaction.tune', { lureSpanSec: 0.6 });
  try {
    const s = E.slice(crewOf(code));
    s.lures.get(lid)!.at = srv.ctx.now(); // due now
    assert.ok(await waitFor(() => noises.filter((n) => n.kind === 'lure').length >= 3, 2000), 'three rattles');
    await a!.settle(80);
    const fx = a!.events.filter((ev) => ev.e === 'interaction.fx' && (ev.d as { kind: string }).kind === 'lure').map((ev) => (ev.d as { count: number }).count);
    assert.deepEqual(fx, [1, 2, 3]);
    assert.equal(a!.ix.items[lid], undefined, 'used up by the last rattle');
    assert.equal(E.f3Peek(crewOf(code)).lures.length, 0);
    await a!.settle(300);
    assert.equal(noises.filter((n) => n.kind === 'lure').length, 3, 'no fourth rattle');
  } finally {
    await a!.dbg('interaction.tune', { lureSpanSec: 8 });
  }
  a!.close();
});

test('a lure with a fuse waits; picked back up it stops and merges into the stack', async () => {
  const { bots: [a], code, L } = await crew(['Fuse']);
  await setFlags(a!, { noiseLure: true });
  const lure = await holdActive(a!, 'lure', 2);
  const [x, z] = bigRoom(L);
  await place(a!, x, z, 0);
  noises.length = 0;
  let r = await a!.req<{ ok: boolean; msg?: string }>('interaction.act', { dir: [0, -1, 0.05], eye: [x, 1.62, z], fuse: 10 });
  assert.equal(r.ok, true);
  assert.match(r.msg ?? '', /10 s after it lands/);
  const land = await a!.waitEvent('interaction.fx', (d: { kind: string; item?: string }) => d.kind === 'drop' && d.item === 'lure', 4000);
  const lid = (land.d as { id: string }).id;
  assert.equal((land.d as { count: number }).count, 10, 'the landing fx carries the fuse');
  const run = E.f3Peek(crewOf(code)).lures.find((q) => q.id === lid)!;
  assert.ok(run.at - Number(land.t) > 9800 && run.at - Number(land.t) < 10200, `first rattle 10 s after landing (${run.at - Number(land.t)} ms)`);
  await a!.settle(400);
  assert.equal(noises.filter((n) => n.kind === 'lure').length, 0, 'quiet while the fuse runs');
  // disarm: E on the armed lure
  const wp = a!.ix.items[lid]!.p!;
  await place(a!, wp[0], wp[2] - 0.5, 0);
  r = await a!.req('interaction.use', { id: lid });
  assert.equal(r.ok, true);
  await a!.settle(80);
  assert.equal(a!.ix.items[lid], undefined, 'merged into the held stack');
  assert.equal(a!.ix.items[lure.id]?.count, 2, 'two lures again');
  assert.equal(E.f3Peek(crewOf(code)).lures.length, 0, 'schedule dropped');
  // an invalid fuse lands rattling
  noises.length = 0;
  r = await a!.req('interaction.act', { dir: [0, -1, 0.05], eye: [wp[0], 1.62, wp[2] - 0.5], fuse: 7 });
  assert.equal(r.ok, true);
  assert.ok(await waitFor(() => noises.some((n) => n.kind === 'lure'), 3000), 'fuse 7 is not offered: rattles on landing');
  a!.close();
});

test('the noiseLure flag is the kill switch: an armed lure goes quiet while it is off and goes on after', async () => {
  const { bots: [a], code, L } = await crew(['Kill']);
  await setFlags(a!, { noiseLure: true });
  await holdActive(a!, 'lure', 1);
  const [x, z] = bigRoom(L);
  await place(a!, x, z, 0);
  noises.length = 0;
  const r = await a!.req<{ ok: boolean }>('interaction.act', { dir: [0, -1, 0.05], eye: [x, 1.62, z], fuse: 20 });
  assert.equal(r.ok, true);
  const land = await a!.waitEvent('interaction.fx', (d: { kind: string; item?: string }) => d.kind === 'drop' && d.item === 'lure', 4000);
  const lid = (land.d as { id: string }).id;
  await setFlags(a!, { noiseLure: false });
  E.slice(crewOf(code)).lures.get(lid)!.at = srv.ctx.now(); // due now
  await a!.settle(400);
  assert.equal(noises.filter((n) => n.kind === 'lure').length, 0, 'switched off: no rattle');
  assert.equal(a!.ix.items[lid]?.armed, true, 'it stays armed in the world (flags never delete things)');
  await setFlags(a!, { noiseLure: true });
  assert.ok(await waitFor(() => noises.some((n) => n.kind === 'lure' && n.source === lid), 1500), 'back on: it rattles');
  a!.close();
});

test('field receiver: a charge buys a 6 s listen, never two at once, contracts only', async () => {
  const { bots: [a], code } = await crew(['Rex']);
  await setFlags(a!, { fieldReceiver: true });
  const rc = await holdActive(a!, 'receiver', 5);
  events.length = 0;
  noises.length = 0;
  const r = await a!.req<{ ok: boolean; msg?: string; listen?: E.ListenGrant }>('interaction.act', { dir: [0, 0, 1] });
  assert.equal(r.ok, true);
  assert.equal(r.listen?.ms, 6000);
  assert.equal(r.listen?.door, undefined, 'no door: the plain listen');
  assert.match(r.msg ?? '', /Listening: 6 s · 4 charges left/);
  await a!.settle(60);
  assert.equal(a!.ix.items[rc.id]?.count, 4);
  assert.deepEqual(events.filter((e) => e.type === 'receiver').map((e) => e.kind), ['use', 'consume']);
  assert.equal(noises.length, 0, 'listening makes no noise');
  assert.ok((E.f3Peek(crewOf(code)).listening[a!.me] ?? 0) > 0);
  const again = await a!.req<{ ok: boolean; msg?: string }>('interaction.act', { dir: [0, 0, 1] });
  assert.equal(again.ok, false);
  assert.equal(again.msg, 'Still listening');
  assert.equal(a!.ix.items[rc.id]?.count, 4, 'no second charge spent');
  // the last charge uses the receiver up
  const s = E.slice(crewOf(code));
  s.items[rc.id]!.count = 1;
  s.listening[a!.me] = 0;
  s.lastAct[a!.me] = 0;
  const last = await a!.req<{ ok: boolean; msg?: string }>('interaction.act', { dir: [0, 0, 1] });
  assert.equal(last.ok, true);
  assert.match(last.msg ?? '', /0 charges left/);
  await a!.settle(60);
  assert.equal(a!.ix.items[rc.id], undefined, 'the empty receiver is gone');
  a!.close();
  // outside a contract it keeps its charges
  const { bots: [h] } = await crew(['Hub'], 'hub');
  const hr = await holdActive(h!, 'receiver', 5);
  const no = await h!.req<{ ok: boolean; msg?: string }>('interaction.act', { dir: [0, 0, 1] });
  assert.equal(no.ok, false);
  assert.match(no.msg ?? '', /use it on a site/);
  assert.equal(h!.ix.items[hr.id]?.count, 5);
  h!.close();
});

test('ear to a closed door: the listen plus the space behind it; open, missing or far doors are refused', async () => {
  const { bots: [a], code, L } = await crew(['Ear']);
  await setFlags(a!, { fieldReceiver: true });
  const rc = await holdActive(a!, 'receiver', 5);
  const { d, stand } = closedDoor(L);
  await place(a!, stand[0], stand[1], 0);
  const mine = spaceAt(L, stand[0], stand[1]);
  const r = await a!.req<{ ok: boolean; listen?: E.ListenGrant; msg?: string }>('interaction.act', { dir: [0, 0, 1], door: d.id });
  assert.equal(r.ok, true, r.msg);
  assert.equal(r.listen?.door, d.id);
  assert.ok(r.listen?.space !== undefined && r.listen.space >= 0, 'the space behind the door');
  assert.notEqual(r.listen!.space, mine, 'not the room you stand in');
  assert.ok(r.listen!.space === d.a || r.listen!.space === d.b, `one of the door's two spaces (${d.a} / ${d.b})`);
  assert.match(r.msg ?? '', /Ear to the door/);
  await a!.settle(60);
  assert.equal(a!.ix.items[rc.id]?.count, 4);
  // the far side from the other side is the room we stood in
  const g = E.slice(crewOf(code)).doorGeom.get(d.id)!;
  const other = d.dir === 'v' ? [g.cx + (stand[0] < g.cx ? 0.6 : -0.6), g.cz] : [g.cx, g.cz + (stand[1] < g.cz ? 0.6 : -0.6)];
  assert.equal(E.farSpaceOf(crewOf(code), g, other[0]!, other[1]!), mine);
  const s = E.slice(crewOf(code));
  const reset = () => { s.listening[a!.me] = 0; s.lastAct[a!.me] = 0; };
  // an open door
  reset();
  s.doors[d.id]!.open = true;
  let no = await a!.req<{ ok: boolean; msg?: string }>('interaction.act', { dir: [0, 0, 1], door: d.id });
  assert.equal(no.ok, false);
  assert.match(no.msg ?? '', /open/);
  s.doors[d.id]!.open = false;
  // a door that does not exist
  no = await a!.req('interaction.act', { dir: [0, 0, 1], door: 99999 });
  assert.equal(no.ok, false);
  // too far from it
  await place(a!, stand[0] + (d.dir === 'v' ? Math.sign(stand[0] - g.cx) * 4 : 0), stand[1] + (d.dir === 'h' ? Math.sign(stand[1] - g.cz) * 4 : 0), 0);
  no = await a!.req<{ ok: boolean; msg?: string }>('interaction.act', { dir: [0, 0, 1], door: d.id });
  assert.equal(no.ok, false);
  assert.match(no.msg ?? '', /Too far|reach/);
  await a!.settle(40);
  assert.equal(a!.ix.items[rc.id]?.count, 4, 'refusals spend nothing');
  a!.close();
});
