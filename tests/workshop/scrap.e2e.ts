// Owner: workshop (v1.2). ws-bot test of scrapping at the van workbench during a contract (no browser):
//   the contract prompt (hold E 1200 ms, heldNote), interaction.use {hold:true} removes the active-slot salvage and
//   lowers the haul, yields by flavour name / tierFallback / the idol, bonds + curios + gear refused, a wipe loses the
//   pending scrap, craftContractEnd adds the van materials (IX.takeVanMaterials) + the pending scrap to the stash.
// Run: node tests/workshop/scrap.e2e.ts   (boots the server in-process on PORT, default 3805, temp SAVES_DIR)
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Bot, bootServer, check, crewCode, note, sleep, standAt, summary, tempSaves, toContract } from './lib.ts';
import type { ItemState } from '../../packages/shared/src/messages/interaction.ts';
import type { MetaContractResults } from '../../packages/shared/src/messages/meta.ts';
import type { Station } from '../../packages/shared/src/procgen/van.ts';

const REPO = join(import.meta.dirname, '../..');
const flowSrc = readFileSync(join(REPO, 'apps/server/src/meta/flow.ts'), 'utf8');
/** G4 calls the crafting hooks from finishContract (else this test calls them itself, before the phase change) */
const endWired = flowSrc.includes('craftContractEnd(');
const startWired = flowSrc.includes('craftContractStart(');

const { srv, url } = await bootServer(tempSaves('scrap'));
const IX = await import('../../apps/server/src/interaction/api.ts');
const W = await import('../../apps/server/src/meta/crafting.ts');
let code = 1;
const bots: Bot[] = [];
type St = { stash: Record<string, number> | null; pending: { mats: Record<string, number>; scrapped: number } | null; workbench: Station | null };

try {
  const crewId = crewCode('X');
  const a = new Bot('Sal');
  bots.push(a);
  await a.connect(url, crewId);
  await sleep(400);
  const crew = () => srv.ctx.crews.get(crewId)!;
  note(`G4 wiring: craftContractStart ${startWired ? 'wired' : 'NOT wired'}, craftContractEnd ${endWired ? 'wired' : 'NOT wired'}`);

  await a.dbg('workshop.give', { mats: { 'mat.scrap': 1 } });
  await toContract([a]);
  check('contract on a facility layout', a.phase === 'contract' && a.full?.layout?.kind === 'facility', { phase: a.phase, kind: a.full?.layout?.kind });

  let st = await a.dbg<St>('workshop.state');
  const wb = st.workbench!;
  check('the facility van has a workbench station', !!wb, wb && { itemId: wb.itemId, virtual: !!wb.virtual });
  const wbInt = Object.values(a.ix.ints).find((i) => i.kind === 'workbench');
  check("contract prompt: 'Hold E: scrap…', holdMs 1200, heldNote", !!wbInt && wbInt.prompt === 'Hold E: scrap the salvage in your hand for parts' && wbInt.holdMs === 1200 && wbInt.heldNote === '{item} · no longer counts toward the quota', wbInt);
  let id = wbInt?.id ?? `wb:${wb.itemId}`;
  const [sx, sz] = standAt(wb);
  await a.place(sx, sz);

  /** give an item, make it the active slot */
  const hold = async (type: string, opts: { name?: string; value?: number } = {}): Promise<ItemState> => {
    const it = await a.dbg<ItemState>('interaction.give', { type, ...opts });
    await sleep(120);
    const slot = a.inv().indexOf(it.id);
    if (slot >= 0) await a.req('interaction.slot', { slot });
    await sleep(80);
    return it;
  };
  const clearHands = async () => {
    for (const iid of IX.itemsOf(crew(), a.me).map((x) => x.id)) IX.removeItem(crew(), iid);
    IX.flushNow(crew());
    await sleep(100);
  };
  const use = (holdE: boolean) => a.req<{ ok: boolean; msg?: string }>('interaction.use', { id, hold: holdE });
  await clearHands();

  // ---------- scrap a Circuit board: wiring 2
  const board = await hold('loot.small', { name: 'Circuit board', value: 25 });
  const tap = await use(false);
  check('a tap is not enough (hold E)', !tap.ok && tap.msg === 'Hold E', tap);
  const lootBefore = IX.lootTotal(crew());
  const ev = a.waitEvent('meta.stash', (d: { reason: string }) => d.reason === 'scrap', 3000).catch(() => null);
  const r1 = await use(true);
  check('hold E scraps the salvage', r1.ok && /Scrapped the Circuit board: \+2 wiring/.test(r1.msg ?? ''), r1);
  await sleep(150);
  check('the item is gone (inventory + items)', !a.ix.items[board.id] && !a.inv().includes(board.id), a.inv());
  check('the haul drops (lootTotal -25)', IX.lootTotal(crew()) === lootBefore - 25, { before: lootBefore, after: IX.lootTotal(crew()) });
  const e1 = await ev;
  const d1 = e1?.d as { delta?: Record<string, number>; by?: string; reason?: string } | undefined;
  check("meta.stash {reason 'scrap', +2 wiring, by me}", d1?.delta?.['mat.wiring'] === 2 && d1.by === a.me, d1);
  st = await a.dbg<St>('workshop.state');
  check('pending scrap holds +2 wiring (not in the stash yet)', st.pending?.mats['mat.wiring'] === 2 && st.pending.scrapped === 1 && !st.stash?.['mat.wiring'], { pending: st.pending, stash: st.stash });

  // ---------- refusals
  const bonds = await hold('loot.medium', { name: 'Company bearer bonds', value: 150 });
  const rb = await use(true);
  check('Company bearer bonds are refused', !rb.ok && /go back to the Company/.test(rb.msg ?? ''), rb);
  check('refused bonds stay in hand', a.inv().includes(bonds.id));
  await clearHands();
  const curio = await hold('loot.curio', { name: 'Porcelain doll', value: 90 });
  const rc = await use(true);
  check('a curio is refused', !rc.ok && /one of a kind/.test(rc.msg ?? ''), rc);
  check('refused curio stays in hand', a.inv().includes(curio.id));
  await clearHands();
  await hold('crowbar');
  const rg = await use(true);
  check('gear is refused', !rg.ok && /Only salvage can be scrapped/.test(rg.msg ?? ''), rg);
  await clearHands();
  const re = await use(true);
  check('empty hand is refused', !re.ok && re.msg === 'Hold the salvage you want to scrap in your hand', re);

  // ---------- yields: idol 2 relic, unknown names tierFallback (1/2/4) of a name-hashed common material
  await hold('loot.idol', { value: 400 });
  const ri = await use(true);
  check('the Cursed idol gives 2 relic', ri.ok && /\+2 relic/.test(ri.msg ?? ''), ri);
  await clearHands();
  await hold('loot.heavy', { name: 'Mystery crate', value: 120 });
  const want = W._test.COMMON[W._test.hash32('Mystery crate') % W._test.COMMON.length];
  const ev2 = a.waitEvent('meta.stash', (d: { reason: string }) => d.reason === 'scrap', 3000).catch(() => null);
  const rf = await use(true);
  const d2 = (await ev2)?.d as { delta?: Record<string, number> } | undefined;
  check(`unknown heavy salvage: 4 ${want} (tierFallback)`, rf.ok && d2?.delta?.[want] === 4 && Object.keys(d2.delta).length === 1, { rf, delta: d2?.delta });
  check('salvageYield: every LOOT_NAMES flavour has a table entry', (await import('../../packages/shared/src/interactables.ts')).LOOT_NAMES.flat().every((n) => {
    const y = W.salvageYield({ type: 'loot.small', name: n });
    return Object.keys(y).length > 0 && Object.keys(JSON.parse(readFileSync(join(REPO, 'config/balance/crafting.json'), 'utf8')).salvage).includes(n);
  }));
  check('salvageYield: Server blade rack = wiring 4 + cells 2', JSON.stringify(W.salvageYield({ type: 'loot.heavy', name: 'Server blade rack' })) === JSON.stringify({ 'mat.wiring': 4, 'mat.cells': 2 }));
  check('salvageYield: Cryo canister = chem 4 + cells 1', JSON.stringify(W.salvageYield({ type: 'loot.heavy', name: 'Cryo canister' })) === JSON.stringify({ 'mat.chem': 4, 'mat.cells': 1 }));
  st = await a.dbg<St>('workshop.state');
  const pend1 = { ...(st.pending?.mats ?? {}) };
  check('pending accumulates (wiring 2, relic 2, fallback 4)', pend1['mat.wiring'] === 2 + (want === 'mat.wiring' ? 4 : 0) && pend1['mat.relic'] === 2 && st.pending?.scrapped === 3, st.pending);
  const stashBefore = { ...(st.stash ?? {}) };

  // ---------- a wipe loses the pending scrap
  let res: MetaContractResults | null = null;
  if (endWired) {
    const ph = a.waitPhase('results', 15_000);
    const end = await a.dbg<{ ok: boolean; results: MetaContractResults | null }>('meta.endContract', { outcome: 'wiped', hauled: 0 });
    await ph;
    res = end.results;
    check('wiped: results.salvage has no materials', !!res?.salvage && Object.keys(res.salvage.materials).length === 0, res?.salvage);
  } else {
    const out = W.craftContractEnd(crew(), 'wiped', [a.me]);
    check('wiped: craftContractEnd returns no materials', Object.keys(out.materials).length === 0 && out.scrapped === 3, out);
    const ph = a.waitPhase('results', 15_000);
    await a.dbg('meta.endContract', { outcome: 'wiped', hauled: 0 });
    await ph;
  }
  st = await a.dbg<St>('workshop.state');
  check('wipe: the stash is unchanged and pending cleared', JSON.stringify(st.stash) === JSON.stringify(stashBefore) && st.pending?.scrapped === 0 && Object.keys(st.pending.mats).length === 0, { stash: st.stash, before: stashBefore, pending: st.pending });

  // voided / no participants: nothing committed either (direct hook calls on the live crew)
  await a.dbg('workshop.give', { mats: { 'mat.chem': 2 }, pending: true });
  const v = W.craftContractEnd(crew(), 'voided', [a.me]);
  await a.dbg('workshop.give', { mats: { 'mat.chem': 2 }, pending: true });
  const np = W.craftContractEnd(crew(), 'extracted', []);
  st = await a.dbg<St>('workshop.state');
  check('voided and no-participant contracts commit nothing', !Object.keys(v.materials).length && !Object.keys(np.materials).length && JSON.stringify(st.stash) === JSON.stringify(stashBefore), { v, np, stash: st.stash });

  // ---------- back to the van, second contract: scrap + van materials are committed
  const hub = a.waitPhase('hub', 20_000);
  await a.dbg('meta.resultsNow');
  await hub;
  await sleep(300);
  await toContract([a]);
  const wb2 = (await a.dbg<St>('workshop.state')).workbench!;
  id = Object.values(a.ix.ints).find((i) => i.kind === 'workbench')?.id ?? `wb:${wb2.itemId}`;
  check('second contract: the workbench is re-registered for the new van', id === `wb:${wb2.itemId}`, id);
  const [x2, z2] = standAt(wb2);
  await a.place(x2, z2);
  await clearHands();
  await hold('loot.medium', { name: 'Radio set', value: 60 });
  const r2 = await use(true);
  check('scrap a Radio set (wiring 2 + cells 1)', r2.ok && /\+2 wiring, \+1 battery cells/.test(r2.msg ?? ''), r2);
  // materials lying in the van cargo bay: interaction's takeVanMaterials picks them up at contract end
  const L = crew().layout!;
  const cab = L.van?.cab;
  if (cab) await a.dbg('interaction.spawn', { type: 'mat.optics', x: cab.x + cab.w / 2, z: cab.y + cab.h / 2, count: 3 });
  await sleep(150);
  const vanNow = IX.vanMaterials(crew());
  const ixReal = Object.keys(vanNow).length > 0;
  if (!ixReal) note('IX.vanMaterials/takeVanMaterials still the contract stub (G3 not landed): only the pending scrap is committed');
  st = await a.dbg<St>('workshop.state');
  const before2 = { ...(st.stash ?? {}) };
  let gains: Record<string, number> = {};
  if (endWired) {
    const ph = a.waitPhase('results', 15_000);
    const end = await a.dbg<{ ok: boolean; results: MetaContractResults | null }>('meta.endContract', { outcome: 'extracted', hauled: 0 });
    await ph;
    gains = end.results?.salvage?.materials ?? {};
    check('extracted: results.salvage reports the gains + scrapped count', !!end.results?.salvage && end.results.salvage.scrapped === 1, end.results?.salvage);
  } else {
    gains = W.craftContractEnd(crew(), 'extracted', [a.me]).materials;
    const ph = a.waitPhase('results', 15_000);
    await a.dbg('meta.endContract', { outcome: 'extracted', hauled: 0 });
    await ph;
  }
  check('gains include the pending scrap (wiring 2, cells 1)', gains['mat.wiring'] === 2 && gains['mat.cells'] === 1, gains);
  if (ixReal) check('gains include the van materials (optics 3)', gains['mat.optics'] === 3, gains);
  st = await a.dbg<St>('workshop.state');
  const okStash = Object.entries(gains).every(([k, n]) => (st.stash?.[k] ?? 0) === (before2[k] ?? 0) + n);
  check('the stash grew by exactly the gains', okStash, { before: before2, gains, after: st.stash });
  check('pending cleared after the contract', st.pending?.scrapped === 0 && Object.keys(st.pending.mats).length === 0, st.pending);

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
