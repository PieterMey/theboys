// Owner: workshop (v1.2). Stash, upgrades, scrap, stash locker. Keep every export/signature.
//   hub: E at the van workbench opens the 'workbench' screen (craft / upgrades / locker tabs; meta.workbench, meta.craft,
//        meta.upgrade); E at the crew locker opens it on the locker tab.
//   contract: hold E at the workbench scraps the salvage in your active slot into materials (pending until the contract
//        ends; a wipe loses them). craftContractEnd commits the van materials + the pending scrap to the crew stash.
// The 8 hooks are called by meta (flow.ts) only. flow.ts imports this file back: call flow.ts / api.ts functions only
// inside function bodies (never at module top level).
import type { Crew, ReqHandler, ServerContext, ServerPlayer } from '../core/types.ts';
import { SYSTEM_ORDER } from '../core/types.ts';
import type { ReqName } from '@dead-air/shared/messages/index.ts';
import type { InteractableInfo } from '@dead-air/shared/interactables.ts';
import { GEAR_PACKS, ITEM_DEFS, itemDef } from '@dead-air/shared/interactables.ts';
import { CURIO_TYPE, MATERIAL_LABEL, MATERIAL_TYPES, VAN_UPGRADES, isMaterial, v12Id } from '@dead-air/shared/catalog.ts';
import type { MaterialType } from '@dead-air/shared/catalog.ts';
import { stationOf } from '@dead-air/shared/procgen/van.ts';
import type { MetaRecipe, MetaUpgrade, MetaWorkbench } from '@dead-air/shared/messages/meta.ts';
import * as IX from '../interaction/api.ts';
import * as A from './adapters.ts';
import { S, markDirty, runtime, saveCrew, shopItems } from './flow.ts';
import { playerSave, poolAdd, poolView, recordStat } from './api.ts';

export interface CraftSave { stash: Record<string, number>; unlocks: string[] }

// ---------------------------------------------------------------- config (config/balance/crafting.json, re-read on use)

interface Recipe { id: string; name: string; desc: string; tier: 1 | 2; out: string; qty: number; cost: Record<string, number>; scrip: number }
interface Upgrade { id: string; name: string; desc: string; scrip: number; cost: Record<string, number> }

let CTX: ServerContext | null = null;
const SLICE = 'workshop';
/** the materials a name-hashed tierFallback yield picks from (relic only ever comes from the table: the idol) */
const COMMON: readonly MaterialType[] = ['mat.scrap', 'mat.wiring', 'mat.chem', 'mat.optics', 'mat.cells'];
const WB_PROMPT_HUB = 'Van workbench: craft gear';
const WB_PROMPT_CONTRACT = 'Hold E: scrap the salvage in your hand for parts';
const WB_HELD_NOTE = '{item} · no longer counts toward the quota';
const STASH_PROMPT = 'Crew locker: stash & loadout';

const cfg = (): Record<string, unknown> => (CTX?.balance.crafting ?? {}) as Record<string, unknown>;
const numOr = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const enabled = (): boolean => CTX?.flags.crafting !== false;
const benchRange = (): number => numOr(cfg().benchRangeM, 3);
const scrapHoldMs = (): number => Math.max(0, Math.round(numOr(cfg().scrapHoldMs, 1200)));
const firedWipes = (): boolean => cfg().firedWipes !== false;
const bondsName = (): string => {
  const v = (CTX?.balance.safes as Record<string, unknown> | undefined)?.rewardName;
  return typeof v === 'string' && v ? v : 'Company bearer bonds';
};

/** MaterialType -> positive whole units (anything else dropped) */
function cleanMats(o: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!o || typeof o !== 'object') return out;
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (!isMaterial(k)) continue;
    const n = Math.round(numOr(v, 0));
    if (n > 0) out[k] = n;
  }
  return out;
}

function cleanUnlocks(a: unknown): string[] {
  if (!Array.isArray(a)) return [];
  const ok = new Set<string>(VAN_UPGRADES);
  return [...new Set(a.filter((x): x is string => typeof x === 'string' && ok.has(x)))];
}

function recipes(): Recipe[] {
  const list = cfg().recipes;
  if (!Array.isArray(list)) return [];
  const out: Recipe[] = [];
  for (const r of list as Record<string, unknown>[]) {
    if (!r || typeof r.id !== 'string' || typeof r.out !== 'string') continue;
    out.push({
      id: r.id, out: r.out, name: typeof r.name === 'string' ? r.name : itemDef(r.out).name, desc: typeof r.desc === 'string' ? r.desc : '',
      tier: r.tier === 2 ? 2 : 1, qty: Math.max(1, Math.round(numOr(r.qty, 1))), cost: cleanMats(r.cost), scrip: Math.max(0, Math.round(numOr(r.scrip, 0))),
    });
  }
  return out;
}

function upgrades(): Upgrade[] {
  const list = cfg().upgrades;
  if (!Array.isArray(list)) return [];
  const ok = new Set<string>(VAN_UPGRADES);
  const out: Upgrade[] = [];
  for (const u of list as Record<string, unknown>[]) {
    if (!u || typeof u.id !== 'string' || !ok.has(u.id) || out.some((x) => x.id === u.id)) continue;
    out.push({
      id: u.id, name: typeof u.name === 'string' ? u.name : u.id, desc: typeof u.desc === 'string' ? u.desc : '',
      scrip: Math.max(0, Math.round(numOr(u.scrip, 0))), cost: cleanMats(u.cost),
    });
  }
  return out;
}

const upgradeName = (id: string): string => upgrades().find((u) => u.id === id)?.name ?? id;

/** a recipe is shown only when interaction implements its output (ITEM_DEFS) or it is a shop pack id */
export function implemented(out: string): boolean {
  return Object.prototype.hasOwnProperty.call(ITEM_DEFS, out) || Object.prototype.hasOwnProperty.call(GEAR_PACKS, out);
}

/** recipes the bench offers (config order), unimplemented outputs omitted */
export function visibleRecipes(): Recipe[] {
  return recipes().filter((r) => implemented(r.out));
}

/** pool item type + units for a recipe output (a shop pack id becomes its real type) */
function poolTarget(out: string, qty: number): { type: string; units: number } {
  const pack = GEAR_PACKS[out];
  return pack ? { type: pack.type, units: qty * (pack.count ?? 1) } : { type: out, units: qty };
}

/** shop price per unit of each real item type (shop packs unpacked), for the bench's price comparison */
function shopUnitPrices(): Record<string, number> {
  const out: Record<string, number> = {};
  try {
    for (const it of shopItems()) {
      const raw = it.type ?? it.id;
      const pack = GEAR_PACKS[raw];
      const type = pack?.type ?? raw;
      const units = Math.max(1, (it.qty ?? 1) * (pack?.count ?? 1));
      if (typeof it.price === 'number' && it.price > 0 && !(type in out)) out[type] = it.price / units;
    }
  } catch { /* meta not installed (unit tests) */ }
  return out;
}

/** FNV-1a 32 (deterministic name hash for the tierFallback material) */
function hash32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const tierOfType = (type: string): number => (type === 'loot.heavy' ? 2 : type === 'loot.medium' ? 1 : type === 'loot.idol' ? 2 : 0);

/** the salvage display name crafting.json 'salvage' is keyed by (LOOT_NAMES flavour; the idol is 'Cursed idol') */
function salvageName(it: { type: string; name?: string }): string {
  return it.name ?? itemDef(it.type).name;
}

/** materials one scrapped salvage item yields: crafting.json salvage by flavour name, else tierFallback (1/2/4) units
 *  of a name-hashed common material */
export function salvageYield(it: { type: string; name?: string; tier?: number }): Record<string, number> {
  const table = (cfg().salvage ?? {}) as Record<string, unknown>;
  const name = salvageName(it);
  const hit = Object.prototype.hasOwnProperty.call(table, name) ? cleanMats(table[name]) : null;
  if (hit && Object.keys(hit).length) return hit;
  if (it.type === 'loot.idol') {
    const idol = cleanMats(table['Cursed idol']);
    return Object.keys(idol).length ? idol : { 'mat.relic': 2 };
  }
  const fb = Array.isArray(cfg().tierFallback) ? (cfg().tierFallback as unknown[]) : [1, 2, 4];
  const tier = Math.max(0, Math.min(2, Math.round(numOr(it.tier, tierOfType(it.type)))));
  const units = Math.max(1, Math.round(numOr(fb[tier], [1, 2, 4][tier])));
  return { [COMMON[hash32(name) % COMMON.length]]: units };
}

// ---------------------------------------------------------------- per-crew slice

interface CraftSlice {
  stash: Record<string, number>;
  unlocks: string[];
  /** this contract's scrap: committed at craftContractEnd unless wiped/voided */
  pending: { mats: Record<string, number>; scrapped: number };
  loaded: boolean;
}

const sliceOf = (crew: Crew): CraftSlice | null => {
  const s = crew.slices[SLICE] as CraftSlice | undefined;
  return s?.loaded ? s : null;
};

/** the crew's slice. meta's S() restores it via loadCraft; until that is wired (or for a crew S() has not seen),
 *  restore once from the crew save so a request never starts from an empty stash. */
function ensure(crew: Crew): CraftSlice {
  try { S(crew); } catch { /* meta not installed (unit tests) */ }
  const have = sliceOf(crew);
  if (have) return have;
  const saved = runtime()?.store.crew(crew.code) ?? null;
  loadCraft(crew, saved ? { stash: saved.stash ?? {}, unlocks: saved.unlocks ?? [] } : null);
  return sliceOf(crew)!;
}

function addMats(into: Record<string, number>, add: Record<string, number>): void {
  for (const [k, n] of Object.entries(add)) if (n > 0) into[k] = (into[k] ?? 0) + n;
}

function negate(o: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, n] of Object.entries(o)) if (n) out[k] = -n;
  return out;
}

/** first material the stash lacks, as 'Wiring (1/2)'; null = affordable */
function shortfall(stash: Record<string, number>, cost: Record<string, number>): string | null {
  for (const [k, n] of Object.entries(cost)) {
    const have = stash[k] ?? 0;
    if (have < n) return `${MATERIAL_LABEL[k as MaterialType] ?? k} (${have}/${n})`;
  }
  return null;
}

function deduct(stash: Record<string, number>, cost: Record<string, number>): void {
  for (const [k, n] of Object.entries(cost)) {
    const left = (stash[k] ?? 0) - n;
    if (left > 0) stash[k] = left;
    else delete stash[k];
  }
}

const matsText = (m: Record<string, number>): string =>
  Object.entries(m).map(([k, n]) => `+${n} ${(MATERIAL_LABEL[k as MaterialType] ?? k).toLowerCase()}`).join(', ');

function persist(crew: Crew): void {
  try {
    markDirty(crew);
    saveCrew(crew);
  } catch { /* meta not installed */ }
}

function emitStash(crew: Crew, delta: Record<string, number>, by: string | null, reason: 'scrap' | 'deposit' | 'craft' | 'upgrade' | 'contract' | 'fired'): void {
  if (!CTX || !Object.keys(delta).length) return;
  CTX.emit(crew, 'meta.stash', { delta, by, reason });
}

// ---------------------------------------------------------------- bench view + checks

/** null = the player may use the bench now (hub, within benchRangeM of the van workbench) */
function benchDenial(crew: Crew, player: ServerPlayer): string | null {
  if (!enabled()) return 'The workbench is closed tonight';
  if (crew.phase !== 'hub') return 'The workbench only works in the van between contracts';
  const wb = crew.layout ? stationOf(crew.layout, 'workbench') : null;
  if (!wb) return 'No workbench in this van';
  const d = Math.hypot(player.pose.p[0] - wb.p[0], player.pose.p[2] - wb.p[2]);
  if (d > benchRange()) return 'Too far from the workbench';
  return null;
}

function metaRecipe(r: Recipe, s: CraftSlice, prices: Record<string, number>): MetaRecipe {
  const { type, units } = poolTarget(r.out, r.qty);
  const unit = prices[type];
  const m: MetaRecipe = { id: r.id, name: r.name, desc: r.desc, tier: r.tier, out: r.out, qty: r.qty, cost: { ...r.cost } };
  if (r.scrip) m.scrip = r.scrip;
  if (unit) m.shopPrice = Math.round(unit * units);
  if (r.tier === 2 && !s.unlocks.includes('bench_tools')) m.locked = `Needs: ${upgradeName('bench_tools')}`;
  return m;
}

function safePool(crew: Crew, pid: string): { units: Record<string, number>; slots: number; maxSlots: number } {
  try {
    const v = poolView(crew, pid);
    return { units: { ...(v?.units ?? {}) }, slots: numOr(v?.slots, 0), maxSlots: numOr(v?.maxSlots, 8) };
  } catch {
    return { units: {}, slots: 0, maxSlots: 8 };
  }
}

function balanceOf(crew: Crew): number {
  try { return S(crew).shift.balance; } catch { return 0; }
}

/** MetaWorkbench for one player (stash, offered recipes, upgrades, scrip, their pool + hand-out order) */
export function benchView(crew: Crew, player: ServerPlayer): MetaWorkbench {
  const s = ensure(crew);
  const prices = shopUnitPrices();
  const pool = safePool(crew, player.id);
  let loadout: string[] = [];
  try { loadout = (playerSave(crew, player.id)?.loadout ?? []).filter((x) => typeof x === 'string'); } catch { /* no save */ }
  return {
    stash: { ...s.stash },
    recipes: visibleRecipes().map((r) => metaRecipe(r, s, prices)),
    upgrades: upgrades().map((u): MetaUpgrade => ({ id: u.id, name: u.name, desc: u.desc, scrip: u.scrip, cost: { ...u.cost }, owned: s.unlocks.includes(u.id) })),
    balance: balanceOf(crew),
    pool: pool.units, poolSlots: pool.slots, maxPoolSlots: pool.maxSlots,
    loadout,
  };
}

function craft(crew: Crew, player: ServerPlayer, recipeId: string): { ok: boolean; reason?: string; bench: MetaWorkbench } {
  const deny = (reason: string) => ({ ok: false, reason, bench: benchView(crew, player) });
  const why = benchDenial(crew, player);
  if (why) return deny(why);
  const s = ensure(crew);
  const r = visibleRecipes().find((x) => x.id === recipeId);
  if (!r) return deny('No such recipe');
  if (r.tier === 2 && !s.unlocks.includes('bench_tools')) return deny(`Needs: ${upgradeName('bench_tools')}`);
  const short = shortfall(s.stash, r.cost);
  if (short) return deny(`Not enough ${short}`);
  const balance = balanceOf(crew);
  if (r.scrip > balance) return deny(`Not enough scrip (${balance}/${r.scrip})`);
  const { type, units } = poolTarget(r.out, r.qty);
  let res: { ok: boolean; reason?: string };
  try { res = poolAdd(crew, player.id, type, units) ?? { ok: false }; } catch (e) { res = { ok: false, reason: e instanceof Error ? e.message : String(e) }; }
  if (!res.ok) return deny(res.reason ?? 'Your locker is full');
  // only now: the pool took it (never touch s.gear here: the pool is meta's)
  deduct(s.stash, r.cost);
  if (r.scrip) S(crew).shift.balance -= r.scrip;
  CTX?.notice(crew, `${player.name} crafted ${r.name} (into their locker)`);
  emitStash(crew, negate(r.cost), player.id, 'craft');
  try {
    recordStat(crew, player.id, 'crafted', 1);
    if (r.scrip) recordStat(crew, player.id, 'scripSpent', r.scrip);
  } catch { /* recorder optional */ }
  persist(crew);
  return { ok: true, bench: benchView(crew, player) };
}

function buyUpgrade(crew: Crew, player: ServerPlayer, id: string): { ok: boolean; reason?: string; bench: MetaWorkbench } {
  const deny = (reason: string) => ({ ok: false, reason, bench: benchView(crew, player) });
  const why = benchDenial(crew, player);
  if (why) return deny(why);
  const s = ensure(crew);
  const u = upgrades().find((x) => x.id === id);
  if (!u) return deny('No such upgrade');
  if (s.unlocks.includes(u.id)) return deny(`The ${u.name} is already installed`);
  const balance = balanceOf(crew);
  if (balance < u.scrip) return deny(`Not enough scrip (${balance}/${u.scrip})`);
  const short = shortfall(s.stash, u.cost);
  if (short) return deny(`Not enough ${short}`);
  S(crew).shift.balance -= u.scrip;
  deduct(s.stash, u.cost);
  s.unlocks.push(u.id);
  CTX?.notice(crew, `${player.name} installed the ${u.name} in the van (${u.scrip} scrip)`);
  emitStash(crew, negate(u.cost), player.id, 'upgrade');
  try { if (u.scrip) recordStat(crew, player.id, 'scripSpent', u.scrip); } catch { /* recorder optional */ }
  persist(crew);
  return { ok: true, bench: benchView(crew, player) };
}

// ---------------------------------------------------------------- contract: scrap at the workbench

function scrap(crew: Crew, player: ServerPlayer): string | { ok: boolean; msg?: string } {
  if (A.call<unknown>('objectives', 'carrying', crew, player.id) === 'core') return 'The Core belongs to the Company: it is not scrap';
  const st = IX.state(crew);
  const slot = st.active[player.id] ?? 0;
  const id = st.inventories[player.id]?.[slot] ?? null;
  const it = id ? st.items[id] : undefined;
  if (!it) return 'Hold the salvage you want to scrap in your hand';
  if (it.type === 'core' || it.type === 'loot.core') return 'The Core belongs to the Company: it is not scrap';
  const name = salvageName(it);
  if (it.name === bondsName()) return `${bondsName()} go back to the Company: deposit them in the van`;
  if (it.type === CURIO_TYPE) return `${name} is one of a kind: the Company wants it intact`;
  if (!it.type.startsWith('loot.')) return `Only salvage can be scrapped (${name} is gear)`;
  const y = salvageYield(it);
  if (!Object.keys(y).length) return 'Nothing usable in that';
  const s = ensure(crew);
  IX.removeItem(crew, it.id);
  addMats(s.pending.mats, y);
  s.pending.scrapped++;
  emitStash(crew, y, player.id, 'scrap');
  try { recordStat(crew, player.id, 'scrapped', 1); } catch { /* recorder optional */ }
  return { ok: true, msg: `Scrapped the ${name}: ${matsText(y)} (stashed when the van gets home)` };
}

// ---------------------------------------------------------------- interactables (+ self-registration safety net)

/** hubInteractables (hub + contract): the workbench (hub: craft; contract: hold E to scrap) and the crew locker (hub) */
export function workbenchInteractables(crew: Crew): InteractableInfo[] {
  const L = crew.layout;
  if (!enabled() || !L) return [];
  const hub = L.kind === 'hub';
  const out: InteractableInfo[] = [];
  const wb = stationOf(L, 'workbench');
  if (wb) {
    const base = { id: v12Id('workbench', wb.itemId), kind: 'workbench', p: [wb.p[0], wb.p[1], wb.p[2]] as [number, number, number], r: 0.45, enabled: true, ref: wb.itemId };
    out.push(hub
      ? { ...base, prompt: WB_PROMPT_HUB, holdMs: undefined, heldNote: undefined }
      : { ...base, prompt: WB_PROMPT_CONTRACT, holdMs: scrapHoldMs(), heldNote: WB_HELD_NOTE });
  }
  const st = hub ? stationOf(L, 'stash') : null;
  if (st) out.push({ id: v12Id('stash', st.itemId), kind: 'stash', p: [st.p[0], st.p[1], st.p[2]], r: 0.45, prompt: STASH_PROMPT, enabled: true, ref: st.itemId });
  return out;
}

/** per crew: interactable list for the current layout / flag state, and the ids we registered for it */
const REG = new WeakMap<Crew, { key: string; list: InteractableInfo[] }>();

/** meta's hubInteractables registers our interactables after each rebuild; this keeps them present even when it has not
 *  run yet (a crew created in the hub, restored crews, a rebuild without a phase change). Idempotent upserts. */
function syncInteractables(crew: Crew): void {
  const L = crew.layout;
  if (!L) return;
  const key = `${L.kind}:${L.seed}:${L.hash}:${enabled() ? 1 : 0}:${scrapHoldMs()}`;
  let reg = REG.get(crew);
  const st = IX.state(crew);
  if (!reg || reg.key !== key) {
    const list = workbenchInteractables(crew);
    for (const old of reg?.list ?? []) if (!list.some((x) => x.id === old.id) && st.ints[old.id]) IX.removeInteractable(crew, old.id);
    reg = { key, list };
    REG.set(crew, reg);
    if (list.length) IX.registerInteractables(crew, list);
    return;
  }
  const missing = reg.list.filter((x) => !st.ints[x.id]);
  if (missing.length) IX.registerInteractables(crew, missing);
}

// ---------------------------------------------------------------- install

/** meta install: meta.workbench/craft/upgrade, IX.onInteract('workbench' | 'stash'), dbg.workshop.* */
export function installCrafting(ctx: ServerContext): void {
  CTX = ctx;
  const log = ctx.log('workshop');
  const req = <R extends ReqName>(name: R, h: ReqHandler<R>): void => {
    try { ctx.registerReq(name, h); } catch (e) { log.warn(`request ${name} not registered: ${e instanceof Error ? e.message : e}`); }
  };

  req('meta.workbench', (crew, player) => {
    const why = benchDenial(crew, player);
    if (why) throw new Error(why);
    return benchView(crew, player);
  });
  req('meta.craft', (crew, player, args) => craft(crew, player, String(args?.recipe ?? '')));
  req('meta.upgrade', (crew, player, args) => buyUpgrade(crew, player, String(args?.id ?? '')));

  IX.onInteract('workbench', (crew, player) => {
    if (!enabled()) return 'The workbench is closed tonight';
    if (crew.phase === 'hub') {
      ctx.emit(crew, 'meta.open', { screen: 'workbench', props: { tab: 'craft' } }, { to: [player.id] });
      return true;
    }
    if (crew.phase === 'contract') return scrap(crew, player);
    return false;
  });
  IX.onInteract('stash', (crew, player) => {
    if (!enabled()) return 'The crew locker is shut tonight';
    if (crew.phase !== 'hub') return false;
    ctx.emit(crew, 'meta.open', { screen: 'workbench', props: { tab: 'locker' } }, { to: [player.id] });
    return true;
  });

  ctx.registerSystem({
    name: 'workshop',
    order: SYSTEM_ORDER.meta + 1,
    tick(_dt, crew) {
      if (crew.tick % 3 !== 0 || !crew.layout) return;
      try { syncInteractables(crew); } catch (e) { log.warn('interactables:', e instanceof Error ? e.message : e); }
    },
  });

  // ---- dev-only test controls
  ctx.registerDbg('workshop.give', (crew, _p, args) => {
    const a = (args ?? {}) as { mats?: unknown; pending?: boolean };
    const s = ensure(crew);
    const add = cleanMats(a.mats);
    if (a.pending) addMats(s.pending.mats, add);
    else {
      addMats(s.stash, add);
      emitStash(crew, add, null, 'deposit');
    }
    persist(crew);
    return { stash: { ...s.stash }, pending: { mats: { ...s.pending.mats }, scrapped: s.pending.scrapped } };
  });
  ctx.registerDbg('workshop.unlock', (crew, _p, args) => {
    const a = (args ?? {}) as { id?: unknown; remove?: boolean };
    const s = ensure(crew);
    const ids = a.id === 'all' ? [...VAN_UPGRADES] : cleanUnlocks([a.id]);
    if (!ids.length) throw new Error(`unknown upgrade ${String(a.id)} (one of ${VAN_UPGRADES.join(', ')} or 'all')`);
    s.unlocks = a.remove ? s.unlocks.filter((x) => !ids.includes(x)) : cleanUnlocks([...s.unlocks, ...ids]);
    persist(crew);
    return { unlocks: s.unlocks.slice() };
  });
  ctx.registerDbg('workshop.reset', (crew) => {
    const s = ensure(crew);
    s.stash = {};
    s.unlocks = [];
    s.pending = { mats: {}, scrapped: 0 };
    persist(crew);
    return { ok: true };
  });
  ctx.registerDbg('workshop.state', (crew, player) => {
    const raw = crew.slices[SLICE] as CraftSlice | undefined;
    const L = crew.layout;
    return {
      loaded: !!raw?.loaded, stash: raw?.stash ?? null, unlocks: raw?.unlocks ?? null, pending: raw?.pending ?? null,
      interactables: workbenchInteractables(crew).map((i) => ({ id: i.id, kind: i.kind, p: i.p, holdMs: i.holdMs ?? null })),
      workbench: L ? stationOf(L, 'workbench') : null, stashStation: L ? stationOf(L, 'stash') : null,
      pose: player.pose.p, recipes: visibleRecipes().map((r) => r.id), hidden: recipes().filter((r) => !implemented(r.out)).map((r) => r.id),
    };
  });
  log.info(`workshop installed: ${visibleRecipes().length}/${recipes().length} recipes offered, ${upgrades().length} upgrades`);
}

// ---------------------------------------------------------------- the 8 hooks (meta/flow.ts)

/** S(crew) restore (null = new crew) */
export function loadCraft(crew: Crew, saved: CraftSave | null): void {
  const prev = crew.slices[SLICE] as CraftSlice | undefined;
  const slice: CraftSlice = {
    stash: cleanMats(saved?.stash),
    unlocks: cleanUnlocks(saved?.unlocks),
    pending: prev?.pending ?? { mats: {}, scrapped: 0 },
    loaded: true,
  };
  crew.slices[SLICE] = slice;
}
/** saveCrew: fields to write; null = inactive -> meta keeps the previous save's stash/unlocks */
export function craftSave(crew: Crew): CraftSave | null {
  const s = sliceOf(crew);
  return s ? { stash: { ...s.stash }, unlocks: s.unlocks.slice() } : null;
}
/** view(): MetaState.stash/unlocks (null = omit) */
export function craftView(crew: Crew): CraftSave | null {
  return craftSave(crew);
}
export function craftContractStart(crew: Crew): void {
  ensure(crew).pending = { mats: {}, scrapped: 0 };
}
/** finishContract, before results: commit van materials + scrap unless wiped/voided */
export function craftContractEnd(crew: Crew, outcome: string, participated: readonly string[]): { materials: Record<string, number>; scrapped: number } {
  const s = ensure(crew);
  const pending = s.pending;
  s.pending = { mats: {}, scrapped: 0 };
  // takeVanMaterials returns and clears: take it on every outcome so nothing leaks into the next contract
  let van: Record<string, number> = {};
  try { van = cleanMats(IX.takeVanMaterials(crew)); } catch { /* interaction stub */ }
  if (outcome === 'wiped' || outcome === 'voided' || !participated?.length) return { materials: {}, scrapped: pending.scrapped };
  const gains: Record<string, number> = {};
  addMats(gains, van);
  addMats(gains, cleanMats(pending.mats));
  addMats(s.stash, gains);
  emitStash(crew, gains, null, 'contract');
  try { markDirty(crew); } catch { /* meta not installed */ }
  return { materials: gains, scrapped: pending.scrapped };
}
/** continueFromResults when fired (crafting.json firedWipes true) */
export function craftFired(crew: Crew): void {
  if (!firedWipes()) return;
  const s = ensure(crew);
  const lost = negate(s.stash);
  s.stash = {};
  s.unlocks = [];
  s.pending = { mats: {}, scrapped: 0 };
  emitStash(crew, lost, null, 'fired');
  try { markDirty(crew); } catch { /* meta not installed */ }
}

// pure helpers for tests
export const _test = { cleanMats, shortfall, hash32, COMMON, recipes, upgrades, materials: MATERIAL_TYPES };
