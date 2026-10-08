// ws-bot tests for track (b) Interaction: doors, keycards, security doors + console, items/inventory, throws,
// glowsticks/litAt, hiding, light switches, death -> body/badge -> medkit / badge revive.
// Run: node --test tests/interaction/server.test.ts   (boots its own dev server on a random port, interaction track only)
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from '../../apps/server/src/core/boot.ts';
import { setQuiet } from '../../apps/server/src/core/log.ts';
import { install } from '../../apps/server/src/interaction/index.ts';
import * as E from '../../apps/server/src/interaction/engine.ts';
import * as api from '../../apps/server/src/interaction/api.ts';
import { Bot } from './bot.ts';
import type { LayoutDoor, LayoutItem, LayoutSpace, LevelLayout } from '../../packages/shared/src/layout.ts';
import type { ItemState } from '../../packages/shared/src/messages/interaction.ts';

let srv: Awaited<ReturnType<typeof boot>>;
let url = '';
const noises: { x: number; z: number; radiusM: number; kind: string; source: string | null }[] = [];

before(async () => {
  setQuiet(true);
  srv = await boot({ mode: 'development', port: 0, tracks: [['interaction', install]], strict: true });
  url = `ws://127.0.0.1:${srv.port}/ws`;
  E.adapters.noise = { emitNoise: (_c, n) => { noises.push(n); } };
});

after(async () => {
  await srv?.close();
  setTimeout(() => process.exit(0), 300).unref();
});

async function crewOf(code: string, names: string[]): Promise<Bot[]> {
  const bots = names.map((n) => new Bot(n));
  for (const b of bots) await b.connect(url, code);
  await bots[0].dbg('interaction.loadLayout', { name: 'facility_s1_p2' });
  await bots[0].settle(120);
  return bots;
}

const crew = (code: string) => srv.ctx.crews.get(code)!;
const invItems = (b: Bot): ItemState[] => (b.ix.inventories[b.me] ?? []).filter(Boolean).map((id) => b.ix.items[id!]);

// ---- layout lookups. Every door, room, item and stand spot below comes from the layout the server loaded (by kind and
// data), never from fixture ids or coordinates: tests/fixtures/layouts gets regenerated with the generator (gate L1).
type XZ = [number, number];

const layoutOf = (code: string): LevelLayout => {
  const L = crew(code).layout;
  if (!L) throw new Error(`crew ${code} has no layout`);
  return L;
};
const spaceAt = (L: LevelLayout, x: number, z: number): number => {
  const cx = Math.floor(x), cz = Math.floor(z);
  return cx < 0 || cz < 0 || cx >= L.W || cz >= L.H ? -1 : (L.owner[cz * L.W + cx] ?? -1);
};
const centreOf = (L: LevelLayout, space: number): XZ => {
  const r = L.spaces[space].rect;
  return [r.x + r.w / 2, r.y + r.h / 2];
};
/** `dist` m in front of a wall / floor item (front = its rot direction) */
const front = (it: LayoutItem, dist: number): XZ => [it.x + Math.sin(it.rot ?? 0) * dist, it.z + Math.cos(it.rot ?? 0) * dist];
/** inside the van cab: the console and the deposit are in reach */
const inVan = (L: LevelLayout): XZ => [L.van.cab.x + L.van.cab.w / 2, L.van.cab.y + L.van.cab.h / 2];

function itemOf(L: LevelLayout, kind: LayoutItem['kind'], pred: (i: LayoutItem) => boolean = () => true): LayoutItem {
  const it = L.items.find((i) => i.kind === kind && pred(i));
  if (!it) throw new Error(`${L.seed}: no ${kind} item`);
  return it;
}

function doorOf(L: LevelLayout, kind: LayoutDoor['kind'], pred: (d: LayoutDoor) => boolean = () => true): LayoutDoor {
  const d = L.doors.find((x) => x.kind === kind && pred(x));
  if (!d) throw new Error(`${L.seed}: no ${kind} door`);
  return d;
}

/** a closed plain door off the entrance room (LOBBY); any closed plain door if it has none */
const plainDoor = (L: LevelLayout): LayoutDoor =>
  L.doors.find((d) => d.kind === 'door' && !d.initiallyOpen && (d.a === L.entrance || d.b === L.entrance)) ?? doorOf(L, 'door', (d) => !d.initiallyOpen);

/** `dist` m out from a door's centre, square to it, on its walkable side (the corridor side if it has one) */
function doorSide(L: LevelLayout, d: LayoutDoor, dist = 0.6): XZ {
  const cx = d.dir === 'v' ? d.x : d.x + d.len / 2;
  const cz = d.dir === 'v' ? d.y + d.len / 2 : d.y;
  const nx = d.dir === 'v' ? 1 : 0, nz = 1 - nx;
  const spaceOn = (s: number) => spaceAt(L, cx + s * nx * 0.6, cz + s * nz * 0.6);
  const sides = [-1, 1].filter((s) => spaceOn(s) >= 0);
  const s = sides.find((q) => L.spaces[spaceOn(q)].kind === 'corridor') ?? sides[0];
  if (s === undefined) throw new Error(`${L.seed}: door ${d.id} has no walkable side`);
  return [cx + s * nx * dist, cz + s * nz * dist];
}

/** `d` m off a floor spot in the same room (nothing in between): -z, +z, -x or +x, the first that stays in the room */
function beside(L: LevelLayout, x: number, z: number, d = 0.5): XZ {
  const sp = spaceAt(L, x, z);
  return ([[x, z - d], [x, z + d], [x - d, z], [x + d, z]] as XZ[]).find(([px, pz]) => spaceAt(L, px, pz) === sp) ?? [x, z];
}

const isLit = (sp: LayoutSpace): boolean => sp.light === 'on' || sp.light === 'flicker';

/** a lit room of at least 5 x 5 m on the always-powered zone 0, with its light switch (the entrance room if it is one) */
function litRoom(L: LevelLayout): { room: LayoutSpace; sw: LayoutItem } {
  for (const sp of [L.spaces[L.entrance], ...L.spaces]) {
    if (!sp || sp.kind === 'corridor' || sp.kind === 'outside' || sp.type === 'van' || sp.powerZone !== 0 || !isLit(sp)) continue;
    if (sp.rect.w < 5 || sp.rect.h < 5) continue;
    const sw = L.items.find((i) => i.kind === 'switch' && i.space === sp.id && Number(i.data?.space ?? i.space) === sp.id);
    if (sw) return { room: sp, sw };
  }
  throw new Error(`${L.seed}: no lit 5 x 5 m room with a switch on power zone 0`);
}

/** a light switch of a working room off the zone-0 power (the vault wing): dark until objectives power its zone */
function unpoweredSwitch(L: LevelLayout): { room: LayoutSpace; sw: LayoutItem } {
  for (const sw of L.items) {
    if (sw.kind !== 'switch') continue;
    const sp = L.spaces[Number(sw.data?.space ?? sw.space)];
    if (!sp || sp.id !== sw.space || sp.powerZone === 0 || sp.kind === 'outside' || sp.type === 'van' || !isLit(sp)) continue;
    return { room: sp, sw };
  }
  throw new Error(`${L.seed}: no switch of a working room off the zone-0 power`);
}

/** the longest straight corridor: a thrower 2 m in from one end and the axis down it */
function corridorThrow(L: LevelLayout): { from: XZ; axis: XZ } {
  let best: LayoutSpace | null = null;
  const len = (sp: LayoutSpace | null) => (sp ? Math.max(sp.rect.w, sp.rect.h) : 0);
  for (const sp of L.spaces) if (sp.kind === 'corridor' && len(sp) > len(best)) best = sp;
  if (!best) throw new Error(`${L.seed}: no corridor`);
  const r = best.rect;
  return r.w >= r.h ? { from: [r.x + 2, r.y + r.h / 2], axis: [1, 0] } : { from: [r.x + r.w / 2, r.y + 2], axis: [0, 1] };
}

/** the middle of the van-side player spawns (where a badge respawn puts you) */
function spawnArea(L: LevelLayout): XZ {
  const sp = L.items.filter((i) => i.kind === 'spawn_player');
  if (!sp.length) return [L.van.x, L.van.z + 2.5];
  return [sp.reduce((a, i) => a + i.x, 0) / sp.length, sp.reduce((a, i) => a + i.z, 0) / sp.length];
}

test('doors: open/close with noise, locked door needs the keycard, vault refuses hands', async () => {
  const [a] = await crewOf('IXDR', ['Ann']);
  const L = layoutOf('IXDR');
  assert.equal(a.full?.phase, 'contract');
  // a closed plain door off the entrance room, used from its corridor side
  const door = plainDoor(L);
  const did = `door:${door.id}`;
  assert.equal(a.ix.doors[door.id].open, false);
  assert.ok(a.ix.ints[did], 'door interactable registered');
  // too far (5 m out)
  a.pose(...doorSide(L, door, 5));
  let r = await a.req<{ ok: boolean; msg?: string }>('interaction.use', { id: did });
  assert.equal(r.ok, false);
  assert.equal(r.msg, 'Too far');
  // in reach (corridor side)
  noises.length = 0;
  a.pose(...doorSide(L, door));
  r = await a.req('interaction.use', { id: did });
  assert.equal(r.ok, true);
  assert.equal(a.ix.doors[door.id].open, true, 'patch arrived before the reply');
  assert.equal((crew('IXDR').slices.interaction as { doors: Record<number, { open: boolean }> }).doors[door.id].open, true, 'slices.interaction.doors[id].open for Net aud');
  assert.ok(noises.some((n) => n.kind === 'door' && n.radiusM === 6), 'door noise 6 m');
  const fx = await a.waitEvent('interaction.fx', (d: { kind: string; door?: number }) => d.kind === 'door' && d.door === door.id);
  assert.ok(fx);
  await a.settle(400); // hand cooldown
  r = await a.req('interaction.use', { id: did });
  assert.equal(r.ok, true);
  assert.equal(a.ix.doors[door.id].open, false);
  // the keycard-locked door
  const locked = doorOf(L, 'locked');
  a.pose(...doorSide(L, locked));
  r = await a.req('interaction.use', { id: `door:${locked.id}` });
  assert.deepEqual(r, { ok: false, msg: 'Locked: needs the keycard' });
  // pick up its keycard and come back
  const kc = Object.values(a.ix.items).find((it) => it.type === 'keycard' && (it.lock ?? 1) === (locked.lock || 1))!;
  assert.ok(kc && kc.where === 'world');
  a.pose(...beside(L, kc.p![0], kc.p![2]));
  r = await a.req('interaction.use', { id: kc.id });
  assert.equal(r.ok, true);
  assert.ok(invItems(a).some((it) => it.type === 'keycard'));
  a.pose(...doorSide(L, locked));
  r = await a.req('interaction.use', { id: `door:${locked.id}` });
  assert.equal(r.ok, true);
  assert.equal(a.ix.doors[locked.id].open, true);
  assert.equal(a.ix.doors[locked.id].locked, false);
  // vault door: keypad only; setDoorOpen from the API works
  const vault = doorOf(L, 'vault');
  a.pose(...doorSide(L, vault));
  r = await a.req('interaction.use', { id: `door:${vault.id}` });
  assert.equal(r.ok, false);
  assert.equal(r.msg, 'The vault opens from the keypad', 'refused by hand, not out of reach');
  assert.equal(api.setDoorOpen(crew('IXDR'), vault.id, true, null), true);
  assert.equal(api.isDoorOpen(crew('IXDR'), vault.id), true);
  a.close();
});

test('security door: 2 s hold by hand, console toggle with 5 s cooldown and 12 m clank', async () => {
  const [a] = await crewOf('IXSD', ['Sec']);
  const L = layoutOf('IXSD');
  const sec = doorOf(L, 'security');
  const sid = `door:${sec.id}`;
  // every move toggles it: the state as generated, then the flipped one (the fixtures' security doors start open)
  const open0 = a.ix.doors[sec.id].open;
  assert.equal(a.ix.ints[sid].holdMs, 2000);
  a.pose(...doorSide(L, sec));
  let r = await a.req<{ ok: boolean; msg?: string }>('interaction.use', { id: sid });
  assert.equal(r.ok, false, 'tap is refused');
  // v1.2 (easeDoors on): the hold is server-timed; a client's hold flag alone no longer moves it
  r = await a.req('interaction.use', { id: sid, hold: true });
  assert.equal(r.ok, false, 'use {hold:true} alone is not trusted');
  noises.length = 0;
  const e = await a.req<{ ok: boolean; t0?: number; ms?: number }>('interaction.ease', { id: sid, on: true });
  assert.equal(e.ok, true);
  assert.equal(e.ms, 2000);
  await a.settle(2150);
  assert.equal(a.ix.doors[sec.id].open, !open0, 'the server committed the 2 s hold');
  assert.ok(noises.some((n) => n.kind === 'securityDoor' && n.radiusM === 12));
  // v1.1 path with the flag off: the client-timed hold
  srv.ctx.flags.easeDoors = false;
  await a.settle(400);
  noises.length = 0;
  r = await a.req('interaction.use', { id: sid, hold: true });
  assert.equal(r.ok, true, 'easeDoors off: v1.1 trusts the hold flag');
  assert.equal(a.ix.doors[sec.id].open, open0);
  assert.ok(noises.some((n) => n.kind === 'securityDoor' && n.radiusM === 12));
  srv.ctx.flags.easeDoors = true;
  await a.settle(400);
  await a.req('interaction.ease', { id: sid, on: true });
  await a.settle(2150);
  assert.equal(a.ix.doors[sec.id].open, !open0);
  // console: must be at the van console
  let c = await a.req<{ ok: boolean; msg?: string; open?: boolean; cooldownMs?: number }>('interaction.consoleDoor', { id: sec.id });
  assert.equal(c.ok, false);
  a.pose(...inVan(L)); // inside the van cab
  c = await a.req('interaction.consoleDoor', { id: sec.id });
  assert.equal(c.ok, true);
  assert.equal(c.open, open0);
  assert.equal(a.ix.doors[sec.id].open, open0);
  c = await a.req('interaction.consoleDoor', { id: sec.id });
  assert.equal(c.ok, false, 'cooldown');
  assert.ok((c.cooldownMs ?? 0) > 3000);
  c = await a.req('interaction.consoleDoor', { id: plainDoor(L).id });
  assert.equal(c.ok, false, 'not a security door');
  a.close();
});

test('items: pickup, slot select, drop, give; walkies; bottle throw smashes with 15 m noise', async () => {
  const metaWas = E.adapters.meta;
  E.adapters.meta = null; // exercise the company-walkie fallback (meta absent)
  const [a, b] = await crewOf('IXIT', ['Ivy', 'Bo']);
  E.adapters.meta = metaWas;
  const L = layoutOf('IXIT');
  // fallback company walkies (meta absent): 2 walkies on contract start
  await a.settle(100);
  const walkies = Object.values(a.ix.items).filter((it) => it.type === 'walkie');
  assert.equal(walkies.length, 2, 'two company walkies');
  assert.equal(api.hasWalkie(crew('IXIT'), a.me), true);
  assert.equal(api.hasWalkie(crew('IXIT'), b.me), true);
  // give + slots
  const bottle = await a.dbg<ItemState>('interaction.give', { type: 'bottle', count: 2 });
  await a.settle();
  assert.equal(a.ix.items[bottle.id].where, 'held');
  const slotOf = (id: string) => a.ix.inventories[a.me].indexOf(id);
  let r = await a.req<{ ok: boolean }>('interaction.slot', { slot: slotOf(bottle.id) });
  assert.equal(r.ok, true);
  assert.equal(a.ix.active[a.me], slotOf(bottle.id));
  // throw down the longest corridor
  const run = corridorThrow(L);
  const [tx, tz] = run.from;
  a.pose(tx, tz, Math.atan2(run.axis[0], run.axis[1])); // facing down the corridor (+X: yaw pi/2, +Z: yaw 0)
  noises.length = 0;
  r = await a.req('interaction.act', { dir: [run.axis[0], 0.1, run.axis[1]], eye: [tx, 1.62, tz] });
  assert.equal(r.ok, true);
  assert.equal(a.ix.items[bottle.id].count, 1);
  const snapWithBottle = await new Promise<boolean>((res) => {
    const t0 = Date.now();
    const poll = () => {
      if (a.lastSnap?.dyn.some((d) => d.id.startsWith('thrown:'))) return res(true);
      if (Date.now() - t0 > 1500) return res(false);
      setTimeout(poll, 20);
    };
    poll();
  });
  assert.ok(snapWithBottle, 'thrown bottle in snapshot dyn');
  const smash = await a.waitEvent('interaction.fx', (d: { kind: string }) => d.kind === 'smash', 4000);
  const sp = (smash.d as { p: [number, number, number] }).p;
  const along = (sp[0] - tx) * run.axis[0] + (sp[2] - tz) * run.axis[1];
  assert.ok(along > 2, `bottle flew down the corridor (${along.toFixed(1)} m)`);
  assert.ok(noises.some((n) => n.kind === 'bottle' && n.radiusM === 15));
  // drop the last bottle, pick it up again
  r = await a.req('interaction.drop', {});
  assert.equal(r.ok, true);
  assert.equal(a.ix.items[bottle.id].where, 'world');
  r = await a.req('interaction.use', { id: bottle.id });
  assert.equal(r.ok, true);
  assert.equal(a.ix.items[bottle.id].where, 'held');
  // full inventory refuses pickup
  for (let i = 0; i < 4; i++) await a.dbg('interaction.give', { type: 'crowbar' });
  await a.settle();
  const loot = Object.values(a.ix.items).find((it) => it.where === 'world' && it.type.startsWith('loot.'))!;
  a.pose(...beside(L, loot.p![0], loot.p![2]));
  const full = await a.req<{ ok: boolean; msg?: string }>('interaction.use', { id: loot.id });
  assert.equal(full.ok, false);
  assert.equal(full.msg, 'Hands full (G to drop)', 'refused for the full inventory, not out of reach');
  a.close();
  b.close();
});

test('glowsticks + flashlight cone + room lights drive litAt; switches need power', async () => {
  const [a] = await crewOf('IXLT', ['Lux']);
  const c = crew('IXLT');
  const L = layoutOf('IXLT');
  // a lit room on power zone 0 (the entrance LOBBY) is lit at start; a room of the vault wing (another power zone) is
  // dark until power
  const { room, sw } = litRoom(L);
  const wing = unpoweredSwitch(L);
  const van = L.spaces.find((sp) => sp.type === 'van');
  if (!van) throw new Error(`${L.seed}: no van cab space`);
  const mid = centreOf(L, room.id);
  assert.equal(api.lightsOn(c, room.id), true);
  assert.equal(api.lightsOn(c, wing.room.id), false);
  assert.equal(api.litAt(c, ...mid), true, 'lit room');
  // switch off the room
  a.pose(...front(sw, 0.6));
  let r = await a.req<{ ok: boolean; msg?: string }>('interaction.use', { id: sw.id });
  assert.equal(r.ok, true);
  assert.equal(a.ix.lights[room.id], false);
  assert.equal(api.litAt(c, ...mid), false);
  // unpowered switch does nothing
  a.pose(...front(wing.sw, 0.6));
  r = await a.req('interaction.use', { id: wing.sw.id });
  assert.equal(r.ok, false);
  assert.equal(r.msg, 'Click. No power in this wing', 'refused for the power, not out of reach');
  // objectives powers the wing -> its lights come on
  api.setPower(c, wing.room.powerZone, true);
  await a.settle();
  assert.equal(a.ix.lights[wing.room.id], true);
  api.setBlackout(c, true);
  await a.settle();
  assert.equal(a.ix.lights[wing.room.id], false, 'blackout');
  assert.equal(a.ix.lights[van.id], true, 'van cab stays lit');
  // glowstick within 2 m: dropped near one corner of the (now dark) room; the opposite corner stays dark
  const { x, y, w, h } = room.rect;
  const corner: XZ = [x + w - 0.5, y + 1];
  await a.dbg('interaction.give', { type: 'glowstick' });
  await a.settle();
  const gs = Object.values(a.ix.items).find((it) => it.type === 'glowstick' && it.holder === a.me)!;
  await a.req('interaction.slot', { slot: a.ix.inventories[a.me].indexOf(gs.id) });
  a.pose(x + 1, y + h - 1, 0); // facing +Z: it lands 0.5 m ahead
  r = await a.req('interaction.act', { dir: [0, 0, 1] });
  assert.equal(r.ok, true);
  assert.equal(Object.keys(a.ix.glows).length, 1);
  assert.equal(a.ix.items[gs.id].count, 4);
  assert.equal(api.litAt(c, x + 1.5, y + h - 1.5), true, 'glowstick within 2 m');
  assert.equal(api.litAt(c, ...corner), false);
  // flashlight cone from 4 m: facing +X (yaw pi/2), light on
  a.pose(corner[0] - 4, corner[1], Math.PI / 2, 1);
  await a.settle(40);
  assert.equal(api.litAt(c, ...corner), true, 'in the flashlight cone');
  a.pose(corner[0] - 4, corner[1], -Math.PI / 2, 1);
  await a.settle(40);
  assert.equal(api.litAt(c, ...corner), false, 'behind the flashlight');
  a.close();
});

test('hiding: locker pins the pose (stance hidden), E again leaves', async () => {
  const [a] = await crewOf('IXHD', ['Hid']);
  const c = crew('IXHD');
  const locker = itemOf(layoutOf('IXHD'), 'hiding');
  a.pose(...front(locker, 0.85));
  let r = await a.req<{ ok: boolean }>('interaction.use', { id: locker.id });
  assert.equal(r.ok, true);
  assert.equal(a.ix.hidden[a.me], locker.id);
  assert.equal(api.isHidden(c, a.me), true);
  a.pose(...front(locker, 2.5)); // client tries to walk away
  await a.settle(60);
  const pl = c.players.get(a.me)!;
  assert.equal(pl.pose.stance, 3, 'STANCE.hidden');
  const [fx, fz] = front(locker, 0.62); // the locker front
  assert.ok(Math.abs(pl.pose.p[0] - fx) < 0.01 && Math.abs(pl.pose.p[2] - fz) < 0.05, `pinned at the locker front ${pl.pose.p}`);
  r = await a.req('interaction.use', { id: locker.id });
  assert.equal(r.ok, true);
  assert.equal(api.isHidden(c, a.me), false);
  a.close();
});

test('death: card event, roster alive=false, items at the body + badge; medkit revive; badge deposit respawn', async () => {
  const [a, b] = await crewOf('IXDE', ['Dee', 'Med']);
  const c = crew('IXDE');
  const L = layoutOf('IXDE');
  const [dx, dz] = centreOf(L, L.entrance); // dies in the middle of the entrance room
  await a.dbg('interaction.give', { type: 'crowbar' });
  a.pose(dx, dz);
  b.pose(dx + 0.8, dz);
  await a.settle();
  const deathP = b.waitEvent('interaction.death');
  const ok = api.kill(c, a.me, { killer: 'HOUND', reason: 'heard your SPRINT (9 m)' });
  assert.equal(ok, true);
  const death = await deathP;
  assert.deepEqual((death.d as { cause: unknown }).cause, { killer: 'HOUND', reason: 'heard your SPRINT (9 m)' });
  await b.settle();
  assert.equal(b.crew!.players.find((p) => p.id === a.me)!.alive, false, 'roster alive=false');
  assert.equal(c.players.get(a.me)!.alive, false);
  assert.ok(b.ix.dead.includes(a.me));
  assert.ok(b.ix.bodies[a.me]);
  assert.ok(b.ix.ints[`body:${a.me}`]);
  assert.equal((a.ix.inventories[a.me] ?? []).filter(Boolean).length, 0, 'inventory emptied');
  const atBody = Object.values(b.ix.items).filter((it) => it.where === 'world' && Math.hypot(it.p![0] - dx, it.p![2] - dz) < 1);
  assert.ok(atBody.some((it) => it.type === 'crowbar'), 'crowbar dropped at the body');
  const badge = atBody.find((it) => it.type === 'badge' && it.owner === a.me);
  assert.ok(badge, 'badge spawned');
  assert.equal(api.kill(c, a.me, { killer: 'X', reason: 'y' }), false, 'already dead');
  // dead player can't interact
  const dr = await a.req<{ ok: boolean }>('interaction.use', { id: `door:${plainDoor(L).id}` });
  assert.equal(dr.ok, false);
  // medkit revive at the body
  let r = await b.req<{ ok: boolean; msg?: string }>('interaction.use', { id: `body:${a.me}` });
  assert.deepEqual(r, { ok: false, msg: 'Needs a medkit' });
  await b.dbg('interaction.give', { type: 'medkit' });
  const revP = a.waitEvent('interaction.revive');
  r = await b.req('interaction.use', { id: `body:${a.me}` });
  assert.equal(r.ok, true);
  const rev = await revP;
  assert.equal((rev.d as { how: string; hp: number }).how, 'medkit');
  assert.equal((rev.d as { hp: number }).hp, 50);
  assert.equal(c.players.get(a.me)!.alive, true);
  assert.equal(b.ix.items[badge!.id], undefined, 'badge removed on revive');
  assert.ok(!invItems(b).some((it) => it.type === 'medkit'), 'medkit consumed');
  // second death -> badge to the van -> respawn after badgeReviveSec
  await a.dbg('interaction.tune', { badgeReviveSec: 0.5 });
  api.kill(c, a.me, { killer: 'MANNEQUIN', reason: 'moved while nobody watched' });
  await b.settle();
  const badge2 = Object.values(b.ix.items).find((it) => it.type === 'badge' && it.owner === a.me)!;
  b.pose(...beside(L, badge2.p![0], badge2.p![2], 0.4));
  r = await b.req('interaction.use', { id: badge2.id });
  assert.equal(r.ok, true);
  b.pose(...inVan(L)); // in the van at the deposit
  r = await b.req('interaction.use', { id: itemOf(L, 'deposit').id });
  assert.equal(r.ok, true);
  assert.ok(b.ix.respawns[a.me] > 0, 'respawn scheduled');
  const rev2 = await a.waitEvent('interaction.revive', (d: { how: string }) => d.how === 'badge', 3000);
  const p2 = (rev2.d as { p: [number, number, number] }).p;
  const [sx, sz] = spawnArea(L);
  assert.ok(Math.hypot(p2[0] - sx, p2[2] - sz) < 3, `respawned at the van (${p2})`);
  assert.equal(api.isAlive(c, a.me), true);
  assert.equal(api.deaths(c).length, 2);
  await a.dbg('interaction.tune', { badgeReviveSec: 20 });
  a.close();
  b.close();
});

test('registry: other tracks register handlers + interactables; deposit falls back to loot', async () => {
  const calls: string[] = [];
  api.onInteract('lever', (_c, p, id) => { calls.push(`${p.name}:${id}`); return true; });
  api.onInteract('keypad', () => 'Keypad has no power');
  const [a] = await crewOf('IXRG', ['Reg']);
  const c = crew('IXRG');
  const L = layoutOf('IXRG');
  const lever = itemOf(L, 'lever');
  assert.equal(a.ix.ints[lever.id].enabled, true, 'lever enabled once a handler exists');
  a.pose(...front(lever, 0.7));
  let r = await a.req<{ ok: boolean; msg?: string }>('interaction.use', { id: lever.id });
  assert.equal(r.ok, true);
  assert.deepEqual(calls, [`Reg:${lever.id}`]);
  api.registerInteractables(c, [{ id: lever.id, kind: 'lever', p: [lever.x, lever.y ?? 1.2, lever.z], prompt: 'Lever cooling down', enabled: false }]);
  await a.settle();
  assert.equal(a.ix.ints[lever.id].prompt, 'Lever cooling down');
  r = await a.req('interaction.use', { id: lever.id });
  assert.deepEqual(r, { ok: false, msg: 'Lever cooling down' }, 'disabled interactables refuse with their prompt');
  assert.equal(calls.length, 1);
  // keypad denial message
  const keypad = itemOf(L, 'keypad');
  a.pose(...front(keypad, 0.6));
  r = await a.req('interaction.use', { id: keypad.id });
  assert.deepEqual(r, { ok: false, msg: 'Keypad has no power' });
  // loot -> van via the built-in deposit
  const loot = Object.values(a.ix.items).filter((it) => it.where === 'world' && it.type.startsWith('loot.'))[0];
  a.pose(...beside(L, loot.p![0], loot.p![2]));
  r = await a.req('interaction.use', { id: loot.id });
  assert.equal(r.ok, true, 'picked up loot');
  const deposited: number[] = [];
  api.onDeposit((_c, _pid, items) => deposited.push(...items.map((i) => i.value)));
  a.pose(...inVan(L));
  r = await a.req('interaction.use', { id: itemOf(L, 'deposit').id });
  assert.equal(r.ok, true);
  assert.equal(a.ix.items[loot.id].where, 'van');
  assert.deepEqual(deposited, [loot.value]);
  assert.equal(api.vanValue(c), loot.value);
  assert.ok(api.lootTotal(c) > 300, `loot budget spawned (${api.lootTotal(c)})`);
  a.close();
});
