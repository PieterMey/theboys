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

test('doors: open/close with noise, locked door needs the keycard, vault refuses hands', async () => {
  const [a] = await crewOf('IXDR', ['Ann']);
  assert.equal(a.full?.phase, 'contract');
  assert.equal(a.ix.doors[14].open, false);
  assert.ok(a.ix.ints['door:14'], 'door interactable registered');
  // too far
  a.pose(11.5, 14);
  let r = await a.req<{ ok: boolean; msg?: string }>('interaction.use', { id: 'door:14' });
  assert.equal(r.ok, false);
  assert.equal(r.msg, 'Too far');
  // in reach (corridor side)
  noises.length = 0;
  a.pose(11.5, 18.4);
  r = await a.req('interaction.use', { id: 'door:14' });
  assert.equal(r.ok, true);
  assert.equal(a.ix.doors[14].open, true, 'patch arrived before the reply');
  assert.equal((crew('IXDR').slices.interaction as { doors: Record<number, { open: boolean }> }).doors[14].open, true, 'slices.interaction.doors[id].open for Net aud');
  assert.ok(noises.some((n) => n.kind === 'door' && n.radiusM === 6), 'door noise 6 m');
  const fx = await a.waitEvent('interaction.fx', (d: { kind: string; door?: number }) => d.kind === 'door' && d.door === 14);
  assert.ok(fx);
  await a.settle(400); // hand cooldown
  r = await a.req('interaction.use', { id: 'door:14' });
  assert.equal(r.ok, true);
  assert.equal(a.ix.doors[14].open, false);
  // locked door 5
  a.pose(25, 8.4);
  r = await a.req('interaction.use', { id: 'door:5' });
  assert.deepEqual(r, { ok: false, msg: 'Locked: needs the keycard' });
  // pick up the keycard in WARDEN and come back
  const kc = Object.values(a.ix.items).find((it) => it.type === 'keycard')!;
  assert.ok(kc && kc.where === 'world');
  a.pose(2.5, 21.0);
  r = await a.req('interaction.use', { id: kc.id });
  assert.equal(r.ok, true);
  assert.ok(invItems(a).some((it) => it.type === 'keycard'));
  a.pose(25, 8.4);
  r = await a.req('interaction.use', { id: 'door:5' });
  assert.equal(r.ok, true);
  assert.equal(a.ix.doors[5].open, true);
  assert.equal(a.ix.doors[5].locked, false);
  // vault door: keypad only; setDoorOpen from the API works
  a.pose(17, 8.4);
  r = await a.req('interaction.use', { id: 'door:34' });
  assert.equal(r.ok, false);
  assert.equal(api.setDoorOpen(crew('IXDR'), 34, true, null), true);
  assert.equal(api.isDoorOpen(crew('IXDR'), 34), true);
  a.close();
});

test('security door: 2 s hold by hand, console toggle with 5 s cooldown and 12 m clank', async () => {
  const [a] = await crewOf('IXSD', ['Sec']);
  assert.equal(a.ix.ints['door:2'].holdMs, 2000);
  a.pose(23.4, 8);
  let r = await a.req<{ ok: boolean; msg?: string }>('interaction.use', { id: 'door:2' });
  assert.equal(r.ok, false, 'tap is refused');
  noises.length = 0;
  r = await a.req('interaction.use', { id: 'door:2', hold: true });
  assert.equal(r.ok, true);
  assert.equal(a.ix.doors[2].open, false);
  assert.ok(noises.some((n) => n.kind === 'securityDoor' && n.radiusM === 12));
  // console: must be at the van console
  let c = await a.req<{ ok: boolean; msg?: string; open?: boolean; cooldownMs?: number }>('interaction.consoleDoor', { id: 2 });
  assert.equal(c.ok, false);
  a.pose(19, 29.8); // inside the van cab
  c = await a.req('interaction.consoleDoor', { id: 2 });
  assert.equal(c.ok, true);
  assert.equal(c.open, true);
  assert.equal(a.ix.doors[2].open, true);
  c = await a.req('interaction.consoleDoor', { id: 2 });
  assert.equal(c.ok, false, 'cooldown');
  assert.ok((c.cooldownMs ?? 0) > 3000);
  c = await a.req('interaction.consoleDoor', { id: 14 });
  assert.equal(c.ok, false, 'not a security door');
  a.close();
});

test('items: pickup, slot select, drop, give; walkies; bottle throw smashes with 15 m noise', async () => {
  const metaWas = E.adapters.meta;
  E.adapters.meta = null; // exercise the company-walkie fallback (meta absent)
  const [a, b] = await crewOf('IXIT', ['Ivy', 'Bo']);
  E.adapters.meta = metaWas;
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
  // throw down the corridor
  a.pose(10, 7.9, Math.PI / 2); // facing +X along corridor 1
  noises.length = 0;
  r = await a.req('interaction.act', { dir: [1, 0.1, 0], eye: [10, 1.62, 7.9] });
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
  assert.ok(sp[0] > 12, `bottle flew down the corridor (x=${sp[0].toFixed(1)})`);
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
  a.pose(loot.p![0], loot.p![2] - 0.5);
  r = await a.req<{ ok: boolean; msg?: string }>('interaction.use', { id: loot.id });
  assert.equal(r.ok, false);
  a.close();
  b.close();
});

test('glowsticks + flashlight cone + room lights drive litAt; switches need power', async () => {
  const [a] = await crewOf('IXLT', ['Lux']);
  const c = crew('IXLT');
  // LOBBY (space 18, power zone 0) is lit at start; FURNACE (space 8, vault wing zone 1) is dark until power
  assert.equal(api.lightsOn(c, 18), true);
  assert.equal(api.lightsOn(c, 8), false);
  assert.equal(api.litAt(c, 13, 21), true, 'lit room');
  // switch off the lobby
  a.pose(12.3, 19.7);
  let r = await a.req<{ ok: boolean; msg?: string }>('interaction.use', { id: 'switch:5' });
  assert.equal(r.ok, true);
  assert.equal(a.ix.lights[18], false);
  assert.equal(api.litAt(c, 13, 21), false);
  // unpowered switch does nothing
  a.pose(8.7, 9.7);
  r = await a.req('interaction.use', { id: 'switch:0' });
  assert.equal(r.ok, false);
  // objectives powers the wing -> furnace lights
  api.setPower(c, 1, true);
  await a.settle();
  assert.equal(a.ix.lights[8], true);
  api.setBlackout(c, true);
  await a.settle();
  assert.equal(a.ix.lights[8], false, 'blackout');
  assert.equal(a.ix.lights[26], true, 'van cab stays lit');
  // glowstick within 2 m
  await a.dbg('interaction.give', { type: 'glowstick' });
  await a.settle();
  const gs = Object.values(a.ix.items).find((it) => it.type === 'glowstick' && it.holder === a.me)!;
  await a.req('interaction.slot', { slot: a.ix.inventories[a.me].indexOf(gs.id) });
  a.pose(11, 23, 0);
  r = await a.req('interaction.act', { dir: [0, 0, 1] });
  assert.equal(r.ok, true);
  assert.equal(Object.keys(a.ix.glows).length, 1);
  assert.equal(a.ix.items[gs.id].count, 4);
  assert.equal(api.litAt(c, 11.5, 22.5), true, 'glowstick within 2 m');
  assert.equal(api.litAt(c, 14.5, 20), false);
  // flashlight cone: facing +X (yaw pi/2), light on
  a.pose(10.5, 20, Math.PI / 2, 1);
  await a.settle(40);
  assert.equal(api.litAt(c, 14.5, 20), true, 'in the flashlight cone');
  a.pose(10.5, 20, -Math.PI / 2, 1);
  await a.settle(40);
  assert.equal(api.litAt(c, 14.5, 20), false, 'behind the flashlight');
  a.close();
});

test('hiding: locker pins the pose (stance hidden), E again leaves', async () => {
  const [a] = await crewOf('IXHD', ['Hid']);
  const c = crew('IXHD');
  a.pose(1.5, 5.8);
  let r = await a.req<{ ok: boolean }>('interaction.use', { id: 'hiding:0' });
  assert.equal(r.ok, true);
  assert.equal(a.ix.hidden[a.me], 'hiding:0');
  assert.equal(api.isHidden(c, a.me), true);
  a.pose(4, 4); // client tries to walk away
  await a.settle(60);
  const pl = c.players.get(a.me)!;
  assert.equal(pl.pose.stance, 3, 'STANCE.hidden');
  assert.ok(Math.abs(pl.pose.p[0] - 1.5) < 0.01 && Math.abs(pl.pose.p[2] - 6.025) < 0.05, `pinned at the locker front ${pl.pose.p}`);
  r = await a.req('interaction.use', { id: 'hiding:0' });
  assert.equal(r.ok, true);
  assert.equal(api.isHidden(c, a.me), false);
  a.close();
});

test('death: card event, roster alive=false, items at the body + badge; medkit revive; badge deposit respawn', async () => {
  const [a, b] = await crewOf('IXDE', ['Dee', 'Med']);
  const c = crew('IXDE');
  await a.dbg('interaction.give', { type: 'crowbar' });
  a.pose(12, 23);
  b.pose(12.8, 23);
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
  const atBody = Object.values(b.ix.items).filter((it) => it.where === 'world' && Math.hypot(it.p![0] - 12, it.p![2] - 23) < 1);
  assert.ok(atBody.some((it) => it.type === 'crowbar'), 'crowbar dropped at the body');
  const badge = atBody.find((it) => it.type === 'badge' && it.owner === a.me);
  assert.ok(badge, 'badge spawned');
  assert.equal(api.kill(c, a.me, { killer: 'X', reason: 'y' }), false, 'already dead');
  // dead player can't interact
  const dr = await a.req<{ ok: boolean }>('interaction.use', { id: 'door:14' });
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
  b.pose(badge2.p![0], badge2.p![2] - 0.4);
  r = await b.req('interaction.use', { id: badge2.id });
  assert.equal(r.ok, true);
  b.pose(19, 29.3); // in the van at the deposit
  r = await b.req('interaction.use', { id: 'deposit:0' });
  assert.equal(r.ok, true);
  assert.ok(b.ix.respawns[a.me] > 0, 'respawn scheduled');
  const rev2 = await a.waitEvent('interaction.revive', (d: { how: string }) => d.how === 'badge', 3000);
  const p2 = (rev2.d as { p: [number, number, number] }).p;
  assert.ok(Math.hypot(p2[0] - 19, p2[2] - 26) < 3, `respawned at the van (${p2})`);
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
  assert.equal(a.ix.ints['lever:0'].enabled, true, 'lever enabled once a handler exists');
  a.pose(19.205 + 0.7, 16.5);
  let r = await a.req<{ ok: boolean; msg?: string }>('interaction.use', { id: 'lever:0' });
  assert.equal(r.ok, true);
  assert.deepEqual(calls, ['Reg:lever:0']);
  api.registerInteractables(c, [{ id: 'lever:0', kind: 'lever', p: [19.205, 1.2, 16.5], prompt: 'Lever cooling down', enabled: false }]);
  await a.settle();
  assert.equal(a.ix.ints['lever:0'].prompt, 'Lever cooling down');
  r = await a.req('interaction.use', { id: 'lever:0' });
  assert.deepEqual(r, { ok: false, msg: 'Lever cooling down' }, 'disabled interactables refuse with their prompt');
  assert.equal(calls.length, 1);
  // keypad denial message
  a.pose(18.35, 8.89 - 0.6);
  r = await a.req('interaction.use', { id: 'keypad:0' });
  assert.deepEqual(r, { ok: false, msg: 'Keypad has no power' });
  // loot -> van via the built-in deposit
  const loot = Object.values(a.ix.items).filter((it) => it.where === 'world' && it.type.startsWith('loot.'))[0];
  a.pose(loot.p![0], loot.p![2] - 0.5);
  r = await a.req('interaction.use', { id: loot.id });
  assert.equal(r.ok, true, 'picked up loot');
  const deposited: number[] = [];
  api.onDeposit((_c, _pid, items) => deposited.push(...items.map((i) => i.value)));
  a.pose(19, 29.3);
  r = await a.req('interaction.use', { id: 'deposit:0' });
  assert.equal(r.ok, true);
  assert.equal(a.ix.items[loot.id].where, 'van');
  assert.deepEqual(deposited, [loot.value]);
  assert.equal(api.vanValue(c), loot.value);
  assert.ok(api.lootTotal(c) > 300, `loot budget spawned (${api.lootTotal(c)})`);
  a.close();
});
