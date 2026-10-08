// Owner: meta-records (v1.2). Gear pool: unit maths (pool.ts) + an in-process ws-bot run of the hand-out:
//   at most handoutSlots (3) slots each, loadout order, held-back units survive the contract, the locker cap refuses
//   purchases, the hub-pickup dupe is gone, a claimed badge keeps its locker, the dead keep only the held-back part.
// Run: node --test tests/meta/pool.test.ts   (boots its own server on a random port; temp SAVES_DIR + SESSION_FILE)
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { allot, handoutOrder, migrateOwners, normalizeUnits, poolSlots, stacks, validateLoadout } from '../../apps/server/src/meta/pool.ts';
import { playerIdFromKey } from '../../apps/server/src/core/crews.ts';
import { Bot } from './bot.ts';

test('slot maths follow POOL_STACK; packs unpack into real units', () => {
  assert.equal(poolSlots({ bottle: 3 }), 1);
  assert.equal(poolSlots({ bottle: 4 }), 2);
  assert.equal(poolSlots({ glowstick: 5, crowbar: 1, masterkey: 3 }), 3);
  assert.deepEqual(stacks('bottle', 7), [3, 3, 1]);
  assert.deepEqual(stacks('crowbar', 2), [1, 1]);
  assert.deepEqual(normalizeUnits({ flares: 1, 'motion-sensors': 2, 'pro-flashlight': 1, bogus: 4, walkie: 0 }), { flare: 3, sensor: 4, flashlight_pro: 1 });
  assert.deepEqual(normalizeUnits({ soles: 2 }), { soles: 2 }, 'HANDOUT_ONLY overshoes are pool gear');
});

test('allot: cap in slots, loadout first, then newest first; the rest stays in the locker', () => {
  const pool = { walkie: 1, crowbar: 1, bottle: 5, medkit: 2 }; // key order = recency: medkit newest
  assert.deepEqual(handoutOrder(pool, null), ['medkit', 'bottle', 'crowbar', 'walkie']);
  assert.deepEqual(handoutOrder(pool, ['crowbar', 'nvg', 'walkie']), ['crowbar', 'walkie', 'medkit', 'bottle']);
  const a = allot(pool, handoutOrder(pool, ['crowbar', 'walkie']), 3);
  assert.deepEqual(a.give, { crowbar: 1, walkie: 1, medkit: 1 });
  assert.deepEqual(a.keep, { bottle: 5, medkit: 1 });
  assert.equal(a.slots, 3);
  const b = allot({ bottle: 5 }, ['bottle'], 1);
  assert.deepEqual(b.give, { bottle: 3 }, 'a partial stack type gives whole stacks only');
  assert.deepEqual(b.keep, { bottle: 2 });
});

test('loadout validation: POOL_TYPES + HANDOUT_ONLY, max 12, packs normalised, no duplicates', () => {
  assert.deepEqual(validateLoadout(['soles', 'flares', 'crowbar', 'crowbar']), { ok: true, loadout: ['soles', 'flare', 'crowbar'] });
  assert.equal(validateLoadout(['loot.small']).ok, false);
  assert.equal(validateLoadout('crowbar').ok, false);
  assert.equal(validateLoadout(new Array(13).fill('walkie')).ok, false);
});

test('v1.1 live-id owners move to save ids via playerIdFromKey', () => {
  const saves = [{ id: 'pSAVEaaaaaa', keys: ['k-old', 'k-new'] }, { id: 'pBob0000000', keys: ['k-bob'] }];
  const liveNew = playerIdFromKey('k-new');
  const g = migrateOwners({ [liveNew]: { crowbar: 1 }, pSAVEaaaaaa: { bottle: 3 }, pBob0000000: { walkie: 1 }, crew: { walkie: 2 }, pGhost00000: { medkit: 1 } }, saves, playerIdFromKey);
  assert.deepEqual(g.pSAVEaaaaaa, { bottle: 3, crowbar: 1 });
  assert.deepEqual(g.pBob0000000, { walkie: 1 });
  assert.deepEqual(g.crew, { walkie: 2 });
  assert.deepEqual(g.pGhost00000, { medkit: 1 }, 'unknown owners are kept');
  assert.equal(g[liveNew], undefined);
});

// ---------------------------------------------------------------- live server

type IxState = { inventories: Record<string, (string | null)[]>; items: Record<string, { id: string; type: string; count?: number; where: string; holder?: string }> };
type MetaDbg = { gear: Record<string, Record<string, number>>; saveId: string };

function held(st: IxState, pid: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of st.inventories[pid] ?? []) {
    if (!id) continue;
    const it = st.items[id];
    if (it) out[it.type] = (out[it.type] ?? 0) + (it.count ?? 1);
  }
  return out;
}
const slotsUsed = (st: IxState, pid: string) => (st.inventories[pid] ?? []).filter(Boolean).length;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('hand-out, held-back units, locker cap, hub-pickup dupe, claimed badge', async () => {
  const saves = mkdtempSync(join(tmpdir(), 'deadair-meta-pool-'));
  process.env.SAVES_DIR = saves;
  process.env.SESSION_FILE = join(saves, 'session.json');
  process.env.NODE_ENV = 'development';
  process.env.AI_MODE = 'mock';
  const { boot } = await import('../../apps/server/src/core/boot.ts');
  const { setQuiet } = await import('../../apps/server/src/core/log.ts');
  const tracks = await Promise.all(
    ['net', 'level', 'players', 'voice', 'objectives', 'interaction', 'monsters', 'meta', 'ai'].map(async (n) => {
      const m = (await import(`../../apps/server/src/${n}/index.ts`)) as { install: (ctx: never) => unknown };
      return [n, m.install] as [string, (ctx: never) => unknown];
    }),
  );
  if (!process.env.VERBOSE) setQuiet(true);
  const srv = await boot({ mode: 'development', port: 0, tracks: tracks as never });
  const url = `ws://127.0.0.1:${srv.port}/ws`;
  const bots: Bot[] = [];
  try {
    const crew = 'POOL';
    const a = new Bot('Ann');
    const b = new Bot('Bob');
    bots.push(a, b);
    await a.join(url, crew);
    await b.join(url, crew);
    await sleep(150);
    await a.req('dbg.meta.shift', { balance: 5000 });
    for (const item of ['crowbar', 'bottles', 'medkit', 'glowsticks', 'walkie', 'walkie', 'walkie', 'walkie']) {
      const r = await a.req<{ ok: boolean; reason?: string }>('meta.buy', { item });
      assert.equal(r.ok, true, `buy ${item}: ${r.reason ?? ''}`);
    }
    const capped = await a.req<{ ok: boolean; reason?: string }>('meta.buy', { item: 'crowbar' });
    assert.equal(capped.ok, false, 'the 9th slot-equivalent is refused');
    assert.match(capped.reason ?? '', /locker is full/i);
    const lo = await a.req<{ ok: boolean; loadout: string[] }>('meta.loadout', { order: ['medkit', 'crowbar', 'walkie'] });
    assert.deepEqual(lo, { ok: true, loadout: ['medkit', 'crowbar', 'walkie'] });
    const bad = await a.req<{ ok: boolean; reason?: string }>('meta.loadout', { order: ['crowbar', 'loot.heavy'] });
    assert.equal(bad.ok, false);
    // Bob picks up a crowbar in the van (as if Ann dropped hers there): not in his locker
    await b.req('dbg.interaction.give', { type: 'crowbar' });

    // ---- contract 1: hand-out
    const order = a.state!.workOrders[0];
    await a.req('meta.pick', { orderId: order.id });
    const drive = a.nextPhase('drive');
    await a.req('meta.ready', { ready: true });
    await b.req('meta.ready', { ready: true });
    await drive;
    const contract = a.nextPhase('contract', 10_000);
    await a.req('dbg.meta.skipDrive');
    await contract;
    await sleep(200);
    let st = await a.req<IxState>('dbg.interaction.state');
    assert.deepEqual(held(st, a.me), { medkit: 1, crowbar: 1, walkie: 1 }, 'Ann: 3 slots in loadout order');
    assert.ok(slotsUsed(st, a.me) <= 3 && slotsUsed(st, b.me) <= 3, 'at most handoutSlots each, a slot stays free');
    assert.equal(held(st, b.me).crowbar ?? 0, 0, 'the hub pickup is taken back: no duplicate crowbar');
    assert.equal(held(st, b.me).walkie, 1, 'Bob gets a company walkie');
    // (the site may have its own crowbar lying around: count what the crew holds)
    const crowbars = Object.values(st.items).filter((it) => it.type === 'crowbar' && it.where === 'held').length;
    assert.equal(crowbars, 1, 'one crowbar held in the whole crew');

    // ---- end: both alive -> Ann keeps the carried 3 + the held-back rest
    const res1 = a.nextPhase('results');
    await a.req('dbg.meta.endContract', { hauled: 100 });
    await res1;
    let m = await a.req<MetaDbg>('dbg.meta.stats');
    assert.deepEqual(m.gear[m.saveId], { crowbar: 1, bottle: 3, medkit: 1, glowstick: 5, walkie: 4 }, 'held-back units survive');
    const bobSave = (await b.req<MetaDbg>('dbg.meta.stats')).saveId;
    assert.deepEqual(m.gear[bobSave], { walkie: 1 }, 'the company walkie Bob carried back is his now');
    const hub = a.nextPhase('hub');
    await a.req('meta.continue');
    await hub;

    // ---- contract 2: Ann dies -> keeps only the held-back part
    const o2 = a.state!.workOrders[0];
    await a.req('meta.pick', { orderId: o2.id });
    const d2 = a.nextPhase('drive');
    await a.req('meta.ready', { ready: true });
    await b.req('meta.ready', { ready: true });
    await d2;
    const c2 = a.nextPhase('contract', 10_000);
    await a.req('dbg.meta.skipDrive');
    await c2;
    await sleep(200);
    st = await a.req<IxState>('dbg.interaction.state');
    assert.deepEqual(held(st, a.me), { medkit: 1, crowbar: 1, walkie: 1 }, 'same allotment again');
    await a.req('dbg.interaction.kill', { pid: a.me, killer: 'HOUND' });
    const res2 = a.nextPhase('results');
    await a.req('dbg.meta.endContract', { hauled: 50 });
    await res2;
    m = await a.req<MetaDbg>('dbg.meta.stats');
    assert.deepEqual(m.gear[m.saveId], { bottle: 3, glowstick: 5, walkie: 3 }, 'the dead lose what they carried, not their locker');
    const hub2 = a.nextPhase('hub');
    await a.req('meta.continue');
    await hub2;
    // gear used up in the van lot leaves the locker too (no free refill at the next hand-out)
    await a.req('dbg.meta.itemEvent', { kind: 'consume', type: 'bottle', count: 1 });
    m = await a.req<MetaDbg>('dbg.meta.stats');
    assert.equal(m.gear[m.saveId].bottle, 2, 'hub consumption');

    // ---- a claimed badge keeps its locker
    const c = new Bot('Cat');
    bots.push(c);
    const cw = await c.join(url, crew);
    const claimCode = cw.state.meta.you!.claim!;
    await a.req('dbg.meta.shift', { balance: 5000 });
    assert.equal((await c.req<{ ok: boolean }>('meta.buy', { item: 'crowbar' })).ok, true);
    c.close();
    await sleep(250);
    const c2b = new Bot('Cat-laptop');
    bots.push(c2b);
    await c2b.join(url, crew);
    const [badge, pin] = claimCode.split('-');
    await c2b.req('claim', { name: badge, pin });
    await sleep(200);
    const view = await c2b.req<{ meta: { gear?: Record<string, Record<string, number>> } }>('meta.state');
    assert.deepEqual(view.meta.gear?.[c2b.me], { crowbar: 1 }, 'the locker follows the save id, shown under the new live id');
  } finally {
    for (const x of bots) x.close();
    await srv.close().catch(() => {});
  }
});
