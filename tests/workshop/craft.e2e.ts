// Owner: workshop (v1.2). ws-bot test of the van workbench in the hub (no browser):
//   interactables + E routing, the 3 m bench range and hub-only rule, hidden unimplemented recipes, costs deducted only
//   after poolAdd accepts, the tier II lock (bench_tools), upgrades (scrip + materials, one of each), the pool cap.
// Run: node tests/workshop/craft.e2e.ts   (boots the server in-process on PORT, default 3805, temp SAVES_DIR)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Bot, bootServer, check, crewCode, note, sleep, standAt, summary, tempSaves, toContract } from './lib.ts';
import { GEAR_PACKS, ITEM_DEFS } from '../../packages/shared/src/interactables.ts';
import { POOL_TYPES, HANDOUT_ONLY } from '../../packages/shared/src/catalog.ts';
import type { MetaWorkbench } from '../../packages/shared/src/messages/meta.ts';
import type { Station } from '../../packages/shared/src/procgen/van.ts';

const REPO = join(import.meta.dirname, '../..');
const t0 = performance.now();
const step = (s: string) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const cfg = JSON.parse(readFileSync(join(REPO, 'config/balance/crafting.json'), 'utf8')) as {
  recipes: { id: string; out: string; tier: number; qty: number; cost: Record<string, number> }[];
  upgrades: { id: string; scrip: number; cost: Record<string, number> }[];
};
const implemented = (out: string) => out in ITEM_DEFS || out in GEAR_PACKS;

const { srv, url } = await bootServer(tempSaves('craft'));
const IX = await import('../../apps/server/src/interaction/api.ts');
const metaApi = await import('../../apps/server/src/meta/api.ts');
let code = 1;
const bots: Bot[] = [];
try {
  const crew = crewCode('W');
  const a = new Bot('Ann');
  bots.push(a);
  await a.connect(url, crew);
  await sleep(500);
  step(`joined ${crew} as ${a.me}; phase ${a.phase}`);
  check('phase hub', a.phase === 'hub', a.phase);

  // ---------- install + interactables
  // the contract stub answers false for every kind (meta's own 'console' / 'board' handlers included)
  if (IX.hasInteractHandler('console') || IX.hasInteractHandler('board')) {
    check("hasInteractHandler('workbench')", IX.hasInteractHandler('workbench'));
    check("hasInteractHandler('stash')", IX.hasInteractHandler('stash'));
  } else note('hasInteractHandler is still the contract stub (G3 not landed): skipped');
  const st = await a.dbg<{ workbench: Station | null; stashStation: Station | null; interactables: { id: string; kind: string }[]; recipes: string[]; hidden: string[] }>('workshop.state');
  check('hub has a workbench station', !!st.workbench, st.workbench && { itemId: st.workbench.itemId, virtual: !!st.workbench.virtual });
  check('hub has a stash station', !!st.stashStation, st.stashStation?.itemId);
  const wb = st.workbench!;
  const wbInt = Object.values(a.ix.ints).find((i) => i.kind === 'workbench');
  const stashInt = Object.values(a.ix.ints).find((i) => i.kind === 'stash');
  check('workbench interactable registered (wb:<itemId>, r 0.45, hub prompt, no hold)', !!wbInt && wbInt.id === `wb:${wb.itemId}` && wbInt.r === 0.45 && wbInt.prompt === 'Van workbench: craft gear' && !wbInt.holdMs, wbInt);
  check('stash interactable registered (stash:<itemId>)', !!stashInt && stashInt.id === `stash:${st.stashStation?.itemId}` && stashInt.prompt === 'Crew locker: stash & loadout', stashInt);

  // ---------- range: far (spawn behind the van) -> denied
  await a.place(wb.p[0], wb.p[2] - 6);
  const far = await a.reqErr('meta.workbench');
  check('meta.workbench beyond 3 m is denied', far === 'Too far from the workbench', far);
  const farCraft = await a.req<{ ok: boolean; reason?: string }>('meta.craft', { recipe: 'glowsticks' });
  check('meta.craft beyond 3 m is denied', !farCraft.ok && farCraft.reason === 'Too far from the workbench', farCraft.reason);
  // 2.9 m ok, 3.2 m denied (measured from the bench aim point)
  await a.place(wb.p[0], wb.p[2] - 2.9);
  check('2.9 m from the bench is in range', (await a.reqErr('meta.workbench')) === null);
  await a.place(wb.p[0], wb.p[2] - 3.2);
  check('3.2 m from the bench is out of range', (await a.reqErr('meta.workbench')) === 'Too far from the workbench');

  // ---------- E at the bench / locker
  const [sx, sz] = standAt(wb);
  await a.place(sx, sz);
  if (wbInt) {
    const ev = a.waitEvent('meta.open', () => true, 3000).catch(() => null);
    const r = await a.req<{ ok: boolean; msg?: string }>('interaction.use', { id: wbInt.id });
    const e = await ev;
    const d = e?.d as { screen?: string; props?: { tab?: string } } | undefined;
    check('E at the workbench opens the workbench screen (craft tab)', r.ok && d?.screen === 'workbench' && d.props?.tab === 'craft', { r, d });
  }
  if (stashInt && st.stashStation) {
    const [lx, lz] = standAt(st.stashStation, 0.8);
    await a.place(lx, lz);
    const ev = a.waitEvent('meta.open', () => true, 3000).catch(() => null);
    const r = await a.req<{ ok: boolean; msg?: string }>('interaction.use', { id: stashInt.id });
    const e = await ev;
    const d = e?.d as { screen?: string; props?: { tab?: string } } | undefined;
    check('E at the crew locker opens the locker tab', r.ok && d?.screen === 'workbench' && d.props?.tab === 'locker', { r, d });
    await a.place(sx, sz);
  }

  // ---------- the bench view: hidden unimplemented recipes, tier II locked
  let bench = await a.req<MetaWorkbench>('meta.workbench');
  const want = cfg.recipes.filter((r) => implemented(r.out)).map((r) => r.id);
  const hidden = cfg.recipes.filter((r) => !implemented(r.out)).map((r) => r.id);
  check('bench offers exactly the implemented recipes (config order)', JSON.stringify(bench.recipes.map((r) => r.id)) === JSON.stringify(want), { offered: bench.recipes.map((r) => r.id) });
  check('no offered recipe lacks ITEM_DEFS / GEAR_PACKS', bench.recipes.every((r) => implemented(r.out)));
  note(`hidden (no ITEM_DEFS yet): ${hidden.join(', ') || 'none'}`);
  check('tier II recipes are locked behind the Soldering station', bench.recipes.filter((r) => r.tier === 2).every((r) => r.locked === 'Needs: Soldering station') && bench.recipes.filter((r) => r.tier === 1).every((r) => !r.locked));
  const glow = bench.recipes.find((r) => r.id === 'glowsticks');
  check('shop price comparison (glowsticks x5 = 10 scrip in the store)', glow?.shopPrice === 10, glow);
  check('4 upgrades, none owned', bench.upgrades.length === 4 && bench.upgrades.every((u) => !u.owned), bench.upgrades.map((u) => u.id));
  check('bench balance = crew scrip', bench.balance === a.meta?.shift.balance, { bench: bench.balance, meta: a.meta?.shift.balance });

  // ---------- costs: empty stash -> denied, nothing changes
  const poor = await a.req<{ ok: boolean; reason?: string; bench: MetaWorkbench }>('meta.craft', { recipe: 'glowsticks' });
  check('craft with an empty stash is denied', !poor.ok && /^Not enough Chemicals \(0\/1\)$/.test(poor.reason ?? ''), poor.reason);

  await a.dbg('workshop.give', { mats: { 'mat.chem': 12, 'mat.scrap': 40, 'mat.wiring': 12, 'mat.optics': 6, 'mat.cells': 6, 'mat.relic': 2 } });
  bench = await a.req<MetaWorkbench>('meta.workbench');
  check('dbg.workshop.give fills the stash', bench.stash['mat.chem'] === 12 && bench.stash['mat.scrap'] === 40, bench.stash);

  const poolBefore = metaApi.poolView(srv.ctx.crews.get(crew)!, a.me);
  const stashEv = a.waitEvent('meta.stash', (d: { reason: string }) => d.reason === 'craft', 3000).catch(() => null);
  const c1 = await a.req<{ ok: boolean; reason?: string; bench: MetaWorkbench }>('meta.craft', { recipe: 'glowsticks' });
  const poolReal = c1.ok || c1.reason !== 'Gear pool not ready';
  if (!poolReal) {
    note('poolAdd is still the contract stub (G4 not landed): crafting is refused and must not deduct');
    check('stub poolAdd refusal keeps the stash (cost only after poolAdd ok)', c1.bench.stash['mat.chem'] === 12, c1.bench.stash);
  } else {
    check('craft glowsticks ok', c1.ok, c1.reason);
    check('cost deducted (chem 12 -> 11)', c1.bench.stash['mat.chem'] === 11, c1.bench.stash);
    const e = await stashEv;
    check("meta.stash {reason 'craft', delta chem -1}", (e?.d as { delta?: Record<string, number> } | undefined)?.delta?.['mat.chem'] === -1, e?.d);
    const pool = c1.bench.pool;
    check('the pool gained 5 glowsticks', (pool.glowstick ?? 0) === (poolBefore.units.glowstick ?? 0) + 5, { before: poolBefore.units, after: pool });
    await sleep(200); // meta.update is flushed on meta's next tick
    if (a.meta?.stash) check('MetaState.stash follows (craftView wired)', a.meta.stash['mat.chem'] === 11, a.meta.stash);
    else note('MetaState.stash absent: G4 has not wired craftView into view() yet');
  }

  // ---------- tier II lock
  const t2 = await a.req<{ ok: boolean; reason?: string; bench: MetaWorkbench }>('meta.craft', { recipe: 'adrenaline' });
  check('tier II craft without bench_tools is refused', !t2.ok && t2.reason === 'Needs: Soldering station', t2.reason);
  check('refused tier II craft costs nothing', t2.bench.stash['mat.chem'] === (poolReal ? 11 : 12), t2.bench.stash);

  // ---------- hidden recipe cannot be crafted by id
  if (hidden.length) {
    const h = await a.req<{ ok: boolean; reason?: string }>('meta.craft', { recipe: hidden[0] });
    check(`hidden recipe '${hidden[0]}' cannot be crafted`, !h.ok && h.reason === 'No such recipe', h.reason);
  }

  // ---------- upgrades: scrip + materials, one of each
  await a.dbg('meta.shift', { balance: 100 });
  await sleep(80);
  const u0 = await a.req<{ ok: boolean; reason?: string; bench: MetaWorkbench }>('meta.upgrade', { id: 'bench_tools' });
  check('upgrade without enough scrip is refused', !u0.ok && u0.reason === 'Not enough scrip (100/150)', u0.reason);
  await a.dbg('meta.shift', { balance: 1000 });
  await sleep(80);
  const u1 = await a.req<{ ok: boolean; reason?: string; bench: MetaWorkbench }>('meta.upgrade', { id: 'bench_tools' });
  const bt = cfg.upgrades.find((u) => u.id === 'bench_tools')!;
  check('buy the Soldering station', u1.ok, u1.reason);
  check('upgrade cost: scrip 150 + scrap 4 + wiring 3', u1.bench.balance === 1000 - bt.scrip && u1.bench.stash['mat.scrap'] === 40 - 4 && u1.bench.stash['mat.wiring'] === 12 - 3, { balance: u1.bench.balance, stash: u1.bench.stash });
  check('owned tick', u1.bench.upgrades.find((u) => u.id === 'bench_tools')?.owned === true);
  const u2 = await a.req<{ ok: boolean; reason?: string }>('meta.upgrade', { id: 'bench_tools' });
  check('one of each upgrade', !u2.ok && /already installed/.test(u2.reason ?? ''), u2.reason);
  const u3 = await a.req<{ ok: boolean; reason?: string }>('meta.upgrade', { id: 'nope' });
  check('unknown upgrade refused', !u3.ok && u3.reason === 'No such upgrade', u3.reason);
  bench = await a.req<MetaWorkbench>('meta.workbench');
  check('tier II unlocked after bench_tools', bench.recipes.filter((r) => r.tier === 2).every((r) => !r.locked));
  await sleep(150);
  if (a.meta?.unlocks) check('MetaState.unlocks has bench_tools', a.meta.unlocks.includes('bench_tools'), a.meta.unlocks);
  else note('MetaState.unlocks absent: G4 has not wired craftView into view() yet');
  check('meta api unlocks(crew) has bench_tools', metaApi.unlocks(srv.ctx.crews.get(crew)!).includes('bench_tools'));

  if (poolReal) {
    const c2 = await a.req<{ ok: boolean; reason?: string; bench: MetaWorkbench }>('meta.craft', { recipe: 'adrenaline' });
    check('tier II craft after bench_tools (adrenaline: chem 4)', c2.ok && c2.bench.stash['mat.chem'] === 7, { reason: c2.reason, stash: c2.bench.stash });
    // overshoes: soles are HANDOUT_ONLY (never carried over) but poolAdd must still take them (plan check #11)
    if (implemented('soles')) {
      check('soles is a hand-out type (POOL_TYPES + HANDOUT_ONLY)', [...POOL_TYPES, ...HANDOUT_ONLY].includes('soles'));
      const os = await a.req<{ ok: boolean; reason?: string; bench: MetaWorkbench }>('meta.craft', { recipe: 'overshoes' });
      check('craft overshoes: poolAdd accepts soles', os.ok && (os.bench.pool.soles ?? 0) === 1 && os.bench.stash['mat.chem'] === 5, { reason: os.reason, pool: os.bench.pool, stash: os.bench.stash });
    }
    // ---------- pool cap via poolAdd: crowbars (1 slot each) until the pool refuses; the refused craft costs nothing
    let refused: { ok: boolean; reason?: string; bench: MetaWorkbench } | null = null;
    let made = 0;
    for (let i = 0; i < 12; i++) {
      const r = await a.req<{ ok: boolean; reason?: string; bench: MetaWorkbench }>('meta.craft', { recipe: 'crowbar' });
      if (!r.ok) { refused = r; break; }
      made++;
    }
    check('the pool cap stops crafting (poolAdd refuses)', !!refused && /Not enough/.test(refused.reason ?? '') === false, { made, reason: refused?.reason, slots: refused?.bench.poolSlots, max: refused?.bench.maxPoolSlots });
    if (refused) {
      const scrapLeft = 36 - 3 * made;
      check('refused craft keeps its cost (scrap)', refused.bench.stash['mat.scrap'] === scrapLeft, { want: scrapLeft, stash: refused.bench.stash });
      check('slots never exceed maxPoolSlots', refused.bench.poolSlots <= refused.bench.maxPoolSlots, { slots: refused.bench.poolSlots, max: refused.bench.maxPoolSlots });
    }
  }

  // ---------- flag 'crafting' off: no bench, no locker, requests refused; the stash itself is untouched
  const flags = srv.ctx.flags as Record<string, boolean>;
  const stashBeforeFlag = (await a.req<MetaWorkbench>('meta.workbench')).stash;
  flags.crafting = false;
  try {
    await sleep(400);
    check('flag off: workbench + locker interactables removed', !Object.values(a.ix.ints).some((i) => i.kind === 'workbench' || i.kind === 'stash'), Object.values(a.ix.ints).filter((i) => i.kind === 'workbench' || i.kind === 'stash').map((i) => i.id));
    check('flag off: meta.workbench refused', (await a.reqErr('meta.workbench')) === 'The workbench is closed tonight');
  } finally {
    flags.crafting = true;
  }
  await sleep(400);
  check('flag back on: interactables return', Object.values(a.ix.ints).some((i) => i.kind === 'workbench') && Object.values(a.ix.ints).some((i) => i.kind === 'stash'));
  check('flag never touches the stash', JSON.stringify((await a.req<MetaWorkbench>('meta.workbench')).stash) === JSON.stringify(stashBeforeFlag));

  // ---------- hub only
  await a.dbg('workshop.give', { mats: { 'mat.chem': 3 } });
  await toContract([a]);
  step(`contract started (layout ${a.full?.layout?.kind})`);
  const inC = await a.reqErr('meta.workbench');
  check('meta.workbench outside the hub is denied', inC === 'The workbench only works in the van between contracts', inC);
  const cC = await a.req<{ ok: boolean; reason?: string }>('meta.craft', { recipe: 'medkit' });
  check('meta.craft outside the hub is denied', !cC.ok && cC.reason === 'The workbench only works in the van between contracts', cC.reason);
  const stashC = Object.values(a.ix.ints).find((i) => i.kind === 'stash');
  check('no crew-locker interactable on a contract', !stashC, stashC);

  code = summary();
} catch (e) {
  console.error('FAIL (exception)', e instanceof Error ? (e.stack ?? e.message) : e);
  code = 1;
} finally {
  for (const b of bots) b.close();
  await srv.close().catch(() => {});
  process.exitCode = code;
  setTimeout(() => process.exit(code), 300).unref();
}
