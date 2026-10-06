// Owner: track (a) Objectives. Per-crew contract runtime: twin levers -> power -> keypad -> vault -> Core carry,
// salvage pickup/deposit, clock (22:00 -> 04:00, blackout 03:00, horn 03:30, departure 04:00), leave-now lever,
// Company Requests and the contract result. State lives in crew.slices.objectives (ContractRt).
import type { Crew, ServerContext, ServerPlayer } from '../core/types.ts';
import type { LevelLayout, LayoutItem } from '@dead-air/shared/layout.ts';
import type { Snapshot, Vec3 } from '@dead-air/shared/state.ts';
import type { CompanyRequest, ClueNote, WorkOrder } from '@dead-air/shared/workorder.ts';
import type { InteractableInfo } from '@dead-air/shared/interactables.ts';
import type {
  LeverResult, LootClass, ObjContractResult, ObjCore, ObjKeypad, ObjLever, ObjLoot, ObjRequest, ObjectivesState,
} from '@dead-air/shared/messages/objectives.ts';
import { CLOCK, NOISE_M, PLAYER } from '@dead-air/shared/constants.ts';
import { makeRng } from '@dead-air/shared/rng.ts';
import * as deps from './deps.ts';
import { lootBudget, rollLoot } from './loot.ts';
import type { LootTuning } from './loot.ts';
import { makeCode, resolveNotes } from './notes.ts';

export const TRACK = 'objectives';

/** Work order fields objectives reads (a full WorkOrder fits; bots/dbg may pass a partial one). */
export type OrderLike = Partial<Pick<WorkOrder, 'id' | 'seed' | 'risk' | 'siteName' | 'payoutMult'>> & {
  requests?: CompanyRequest[];
  notes?: ClueNote[];
};

export interface StartOpts {
  /** override balance.core.contractRealSec (tests: 180) */
  realSec?: number;
  /** dev/test: fields merged over the work order (e.g. requests) */
  orderPatch?: OrderLike;
  /** contract index within the shift (0..2), informational */
  contractIndex?: number;
}

export interface ContractRt {
  st: ObjectivesState;
  layout: LevelLayout;
  order: OrderLike;
  startedPerf: number;
  pending: Map<string, { by: string; at: number }>;
  carried: Map<string, string[]>;
  dedupe: Map<string, number>;
  keypadWrong: number;
  leashSince: number;
  fired: { blackout: boolean; horn: boolean; reminder: boolean; departure: boolean };
  deaths: { player: string; cause: string }[];
  lureDone: boolean;
  dirty: boolean;
  lastSent: number;
  regDirty: boolean;
  result: ObjContractResult | null;
  endFallbackAt: number;
  playersAtStart: string[];
}

type EndListener = (crew: Crew, result: ObjContractResult) => void;
const endListeners: EndListener[] = [];

let ctxRef: ServerContext | null = null;
let log: ReturnType<ServerContext['log']> | null = null;

export function bindContext(ctx: ServerContext): void {
  ctxRef = ctx;
  log = ctx.log(TRACK);
}

function ctx(): ServerContext {
  if (!ctxRef) throw new Error('objectives not installed');
  return ctxRef;
}

// ---------------- balance ----------------
function bal(): Record<string, unknown> {
  return (ctx().balance.objectives ?? {}) as Record<string, unknown>;
}
function num(key: string, d: number): number {
  const v = bal()[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}
function lootTuning(): LootTuning {
  const b = bal();
  return {
    lootValue: (b.lootValue as LootTuning['lootValue']) ?? { small: [8, 35], medium: [35, 90], heavy: [150, 300] },
    lootClassByTier: (b.lootClassByTier as LootTuning['lootClassByTier']) ?? [{ small: 1, medium: 0, heavy: 0 }],
    lootSlotWeightByTier: (b.lootSlotWeightByTier as number[]) ?? [1, 1.6, 2.4],
    lootMaxPerSpace: num('lootMaxPerSpace', 3),
    lootMaxHeavy: num('lootMaxHeavy', 2),
    lootFragileChance: num('lootFragileChance', 0.2),
  };
}
function requestReward(kind: string, d: number): number {
  const r = bal().requests as Record<string, number> | undefined;
  return typeof r?.[kind] === 'number' ? r[kind] : d;
}

// ---------------- access ----------------
export function rt(crew: Crew): ContractRt | null {
  return (crew.slices[TRACK] as ContractRt | undefined) ?? null;
}
function activeRt(crew: Crew): ContractRt | null {
  const r = rt(crew);
  return r && r.st.active && !r.st.ended && crew.phase === 'contract' ? r : null;
}

export function clockMinOf(r: ContractRt, now = ctx().now()): number {
  const sec = (now - r.st.startedAt) / 1000;
  return Math.max(0, Math.min(CLOCK.totalGameMin, (sec / Math.max(1, r.st.realSec)) * CLOCK.totalGameMin));
}

export function onContractEnd(fn: EndListener): () => void {
  endListeners.push(fn);
  return () => {
    const i = endListeners.indexOf(fn);
    if (i >= 0) endListeners.splice(i, 1);
  };
}

// ---------------- geometry helpers ----------------
const d2 = (ax: number, az: number, bx: number, bz: number) => Math.hypot(ax - bx, az - bz);
const pos = (p: ServerPlayer): [number, number] => [p.pose.p[0], p.pose.p[2]];

function vanRect(r: ContractRt): { x0: number; z0: number; x1: number; z1: number } | null {
  const v = r.st.van;
  if (!v) return null;
  const m = num('vanMarginM', 0.6);
  return { x0: v.x - m, z0: v.y - m, x1: v.x + v.w + m, z1: v.y + v.h + m };
}

/** "inside the van": cargo rect + margin, or within reach of the deposit point / rear doors. */
export function inVan(r: ContractRt, x: number, z: number): boolean {
  const R = vanRect(r);
  if (R && x >= R.x0 && x <= R.x1 && z >= R.z0 && z <= R.z1) return true;
  const dep = r.st.deposit;
  if (dep && d2(x, z, dep.p[0], dep.p[2]) <= dep.r + num('vanRearM', 1.4) * 0.5) return true;
  return false;
}

/** Core extraction zone: the van plus a strip behind the rear doors (two carriers can't both fit inside). */
function inVanZone(r: ContractRt, x: number, z: number): boolean {
  if (inVan(r, x, z)) return true;
  const dep = r.st.deposit;
  return !!dep && d2(x, z, dep.p[0], dep.p[2]) <= dep.r + num('vanRearM', 1.4);
}

function inReach(p: ServerPlayer, x: number, z: number, extra = 0): boolean {
  const [px, pz] = pos(p);
  return d2(px, pz, x, z) <= PLAYER.interactRange + num('interactSlackM', 0.8) + extra;
}

function spaceContains(L: LevelLayout, space: number, x: number, z: number): boolean {
  const cx = Math.floor(x), cz = Math.floor(z);
  if (cx < 0 || cz < 0 || cx >= L.W || cz >= L.H) return false;
  return L.owner[cz * L.W + cx] === space;
}

function livingPlayers(crew: Crew): ServerPlayer[] {
  return [...crew.players.values()].filter((p) => deps.isAlive(crew, p));
}

/** one living connected player (solo host test): twin objectives degrade to one-person versions (balance.soloAssist) */
function solo(crew: Crew): boolean {
  if (bal().soloAssist === false) return false;
  return livingPlayers(crew).filter((p) => p.connected).length <= 1;
}

// ---------------- state sync ----------------
function markDirty(r: ContractRt, reg = false): void {
  r.dirty = true;
  if (reg) r.regDirty = true;
}

export function publicState(crew: Crew): ObjectivesState | null {
  const r = rt(crew);
  // a different layout (hub after results): the old contract no longer describes this crew's world
  if (!r || crew.layout !== r.layout) return null;
  r.st.clockMin = Math.round(clockMinOf(r) * 10) / 10;
  return r.st;
}

function flush(crew: Crew, r: ContractRt, force = false): void {
  const now = ctx().now();
  if (!r.dirty && !force) return;
  if (!force && now - r.lastSent < num('stateMinIntervalMs', 200)) return;
  r.dirty = false;
  r.lastSent = now;
  const st = publicState(crew);
  if (st) ctx().emit(crew, 'objectives.state', st);
}

function msg(crew: Crew, p: ServerPlayer, text: string, kind: 'info' | 'warn' = 'info'): void {
  ctx().emit(crew, 'objectives.msg', { text, kind }, { to: [p.id] });
}

function pa(crew: Crew, key: string, text: string): void {
  ctx().emit(crew, 'objectives.pa', { key, text });
}

function dedupe(r: ContractRt, pid: string, id: string, ms = 400): boolean {
  const k = `${pid}|${id}`;
  const now = performance.now();
  const last = r.dedupe.get(k) ?? -Infinity;
  if (now - last < ms) return true;
  r.dedupe.set(k, now);
  return false;
}

// ---------------- interactables for (b) ----------------
function interactables(r: ContractRt): InteractableInfo[] {
  const st = r.st;
  const out: InteractableInfo[] = [];
  const now = ctx().now();
  for (const l of st.levers) {
    const powered = !!st.power[l.zone];
    const cool = st.leverCooldownUntil > now;
    out.push({ id: l.id, kind: 'lever', p: l.p, prompt: powered ? 'Breaker (power restored)' : cool ? 'Breaker tripped: wait' : 'Pull breaker (partner pulls the other within 1 s)', enabled: !powered && !cool });
  }
  if (st.keypad) {
    const k = st.keypad;
    out.push({ id: k.id, kind: 'keypad', p: k.p, prompt: st.vaultOpen ? 'Vault open' : k.enabled ? 'Enter vault code' : 'Keypad (no power)', enabled: k.enabled && !st.vaultOpen });
  }
  if (st.core && st.core.state !== 'van') {
    const c = st.core;
    const prompt = c.state === 'carried' ? 'Core: let go (drops it, -15%)' : c.carriers.length ? 'Grab the other Core handle' : 'Grab a Core handle (needs 2)';
    out.push({ id: c.id, kind: 'core', p: [c.p[0], c.state === 'carried' ? 0.9 : 0.6, c.p[2]], prompt, enabled: st.vaultOpen || c.state !== 'vault' });
  }
  if (st.lootMode === 'objectives') {
    for (const l of st.loot) if (l.where === 'world') out.push({ id: l.id, kind: 'loot', p: [l.p[0], 0.3, l.p[2]], prompt: `Pick up ${l.name} (${l.value})`, enabled: true });
    if (st.deposit) out.push({ id: 'deposit:0', kind: 'deposit', p: st.deposit.p, prompt: 'Deposit salvage', enabled: true });
  }
  for (const n of st.notes) out.push({ id: n.id, kind: 'note', p: n.p, prompt: `Read: ${n.title}`, enabled: true });
  if (st.leaveLever) out.push({ id: st.leaveLever.id, kind: 'leave_lever', p: st.leaveLever.p, prompt: 'Leave now (everyone alive must be in the van)', enabled: true });
  return out;
}

function syncInteractables(crew: Crew, r: ContractRt): void {
  if (!r.regDirty) return;
  r.regDirty = false;
  const list = interactables(r);
  // (b) upserts by id: after the contract, disable ours instead of removing them
  if (!r.st.active || r.st.ended) for (const it of list) it.enabled = false;
  deps.registerInteractables(crew, list);
}

// ---------------- start ----------------
function defaultRequests(budget: number): CompanyRequest[] {
  const frac = Number((bal().requests as Record<string, number> | undefined)?.EXTRACT_ABOVE_frac ?? 0.55);
  const x = Math.max(50, Math.round((budget * frac) / 10) * 10);
  return [
    { kind: 'ALL_SURVIVE', reward: requestReward('ALL_SURVIVE', 100), text: 'Bring the whole crew home. Paperwork for replacements is expensive.' },
    { kind: 'EXTRACT_ABOVE', param: x, reward: requestReward('EXTRACT_ABOVE', 75), text: `Haul more than ${x} scrip of salvage.` },
    { kind: 'LURE_IT_WITH_A_LIE', reward: requestReward('LURE_IT_WITH_A_LIE', 150), text: 'Name a room out loud, then make sure nobody is in it when IT arrives.' },
  ];
}

const nextOpts = new WeakMap<Crew, StartOpts>();
/** options for the next startContract of this crew (dbg: meta starts the contract, we keep the test overrides) */
export function setNextStartOpts(crew: Crew, o: StartOpts): void {
  nextOpts.set(crew, o);
}

export function startContract(crew: Crew, order: OrderLike, opts: StartOpts = {}): ObjectivesState {
  const c = ctx();
  const pend = nextOpts.get(crew);
  if (pend) {
    nextOpts.delete(crew);
    opts = { ...pend, ...Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined)) };
  }
  if (opts.orderPatch) order = { ...order, ...opts.orderPatch };
  const layout = crew.layout;
  if (!layout || layout.kind !== 'facility') throw new Error('startContract: crew has no facility layout (setPhase(contract, layout) first)');
  void deps.loadDeps();
  deps.resetLocal(crew);
  const orderId = String(order.id ?? `dbg-${layout.seed}`);
  const seedKey = `${layout.seed}|${layout.hash}|${orderId}`;
  const risk = Math.max(1, Math.min(3, Number(order.risk ?? 1)));
  const players = Math.max(1, [...crew.players.values()].filter((p) => p.connected).length || crew.players.size);
  const budget = lootBudget(c.balance.core, risk, players);
  // (b) spawns the world loot on layout load: mirror it. Without (b) objectives rolls and owns its own.
  const ix = deps.ixLoot(crew);
  const lootMode: ObjectivesState['lootMode'] = ix && ix.length ? 'interaction' : 'objectives';
  const loot = lootMode === 'interaction' ? mirrorLoot(layout, ix!) : rollLoot(layout, seedKey, budget, lootTuning());
  const lootTotal = loot.reduce((s, l) => s + l.value, 0);
  const code = makeCode(seedKey);
  const notes = resolveNotes({ layout, code, seedKey, siteName: order.siteName, orderNotes: order.notes });
  const rng = makeRng(seedKey, 'objectives.core');
  const coreItem = layout.items.find((i) => i.kind === 'core');
  const cv = (bal().coreValue as [number, number] | undefined) ?? [300, 500];
  const core: ObjCore | null = coreItem ? {
    id: coreItem.id, value: 0, baseValue: 0, state: 'vault', carriers: [], p: [coreItem.x, 0, coreItem.z], yaw: coreItem.rot ?? 0, drops: 0,
  } : null;
  if (core) { core.value = core.baseValue = rng.int(cv[0], cv[1]); }
  const kp = layout.items.find((i) => i.kind === 'keypad');
  const vaultDoor = Number(kp?.data?.door ?? coreItem?.data?.door ?? layout.metrics.vaultDoor ?? -1);
  const keypad: ObjKeypad | null = kp ? {
    id: kp.id, p: [kp.x, kp.y ?? 1.35, kp.z], rot: kp.rot ?? 0, space: kp.space, zone: Number(kp.data?.zone ?? layout.metrics.vaultPowerZone ?? 1), door: vaultDoor, enabled: false, lockedUntil: 0,
  } : null;
  const levers: ObjLever[] = layout.items.filter((i) => i.kind === 'lever').map((i: LayoutItem) => ({
    id: i.id, p: [i.x, i.y ?? 1.2, i.z], rot: i.rot ?? 0, space: i.space, zone: Number(i.data?.zone ?? keypad?.zone ?? 1), down: false,
  }));
  const power: Record<number, boolean> = {};
  for (const s of layout.spaces) if (power[s.powerZone] === undefined) power[s.powerZone] = s.powerZone === 0;
  for (const l of levers) power[l.zone] = false;
  const dep = layout.items.find((i) => i.kind === 'deposit');
  const ll = layout.items.find((i) => i.kind === 'leave_lever');
  const reqs = (order.requests && order.requests.length ? order.requests : defaultRequests(lootTotal)).map((q): ObjRequest => ({
    kind: q.kind, done: false, failed: false, reward: Number(q.reward ?? 0), ...(q.param !== undefined ? { param: q.param } : {}), text: String(q.text ?? q.kind),
  }));
  const realSec = Math.max(10, Number(opts.realSec ?? c.balance.core.contractRealSec ?? CLOCK.realSec));
  const st: ObjectivesState = {
    power, vaultOpen: false, coreState: core ? 'vault' : 'none', hauled: 0, lootTotal, requests: reqs, blackout: false, ended: false,
    active: true, orderId, risk, startedAt: c.now(), realSec, clockMin: 0, horn: false, code, keypad, levers, leverCooldownUntil: 0,
    core, loot, notes, salvage: { count: 0, total: loot.length, value: 0 },
    van: layout.van?.cab ? { ...layout.van.cab } : null,
    deposit: dep ? { p: [dep.x, dep.y ?? 0, dep.z], r: Number(dep.data?.r ?? 0.9) } : null,
    leaveLever: ll ? { id: ll.id, p: [ll.x, ll.y ?? 1.15, ll.z], rot: ll.rot ?? 0 } : null,
    dead: [],
    lootMode,
  };
  const r: ContractRt = {
    st, layout, order, startedPerf: performance.now(), pending: new Map(), carried: new Map(), dedupe: new Map(), keypadWrong: 0,
    leashSince: 0, fired: { blackout: false, horn: false, reminder: false, departure: false }, deaths: [], lureDone: false,
    dirty: true, lastSent: 0, regDirty: true, result: null, endFallbackAt: 0,
    playersAtStart: [...crew.players.values()].map((p) => p.id),
  };
  crew.slices[TRACK] = r;
  // the vault wing starts dark until the breakers are thrown
  deps.setBlackout(crew, false);
  for (const zone of new Set(levers.map((l) => l.zone))) {
    if (zone === 0) continue;
    deps.setZonePower(crew, zone, false, layout.spaces.filter((s) => s.powerZone === zone).map((s) => s.id));
  }
  if (keypad && keypad.door >= 0) deps.setDoorOpen(crew, keypad.door, false, null);
  for (const p of crew.players.values()) p.slices[TRACK] = undefined;
  log?.info(`crew ${crew.code}: contract ${orderId} started (risk ${risk}, ${players}p, loot ${loot.length} items = ${lootTotal}/${budget} [${lootMode}], core ${core?.value ?? 0}, ${realSec}s)`);
  syncInteractables(crew, r);
  flush(crew, r, true);
  pa(crew, 'vo.pa_welcome', 'Welcome to your shift. The van departs at 04:00.');
  return st;
}

// ---------------- levers ----------------
function leverById(r: ContractRt, id: string): ObjLever | undefined {
  return r.st.levers.find((l) => l.id === id);
}

export function pullLever(crew: Crew, p: ServerPlayer, id: string): { ok: boolean; msg?: string; result?: LeverResult } {
  const r = activeRt(crew);
  if (!r) return { ok: false, msg: 'No contract running' };
  const lever = leverById(r, id);
  if (!lever) return { ok: false, msg: 'No such breaker' };
  if (!deps.isAlive(crew, p)) return { ok: false, msg: 'You are dead' };
  if (!inReach(p, lever.p[0], lever.p[2])) return { ok: false, msg: 'Too far from the breaker' };
  const c = ctx();
  const now = c.now();
  if (r.st.power[lever.zone]) return { ok: false, msg: 'Power is already on', result: 'success' };
  if (r.st.leverCooldownUntil > now) {
    const s = Math.ceil((r.st.leverCooldownUntil - now) / 1000);
    return { ok: false, msg: `Breakers tripped. Reset in ${s} s`, result: 'cooldown' };
  }
  if (dedupe(r, p.id, id)) return { ok: true, result: 'waiting' };
  const windowMs = num('leverWindowSec', 1.0) * 1000;
  // partner pull on another breaker of the same zone, by someone else, within the window?
  for (const other of r.st.levers) {
    if (other.id === lever.id || other.zone !== lever.zone) continue;
    const pend = r.pending.get(other.id);
    if (pend && pend.by !== p.id && now - pend.at <= windowMs) {
      r.pending.delete(other.id);
      lever.down = true;
      lever.by = p.id;
      powerOn(crew, r, lever.zone, [pend.by, p.id]);
      c.emit(crew, 'objectives.lever', { id: lever.id, by: p.id, result: 'success', zone: lever.zone, p: lever.p });
      return { ok: true, result: 'success', msg: 'Power restored' };
    }
  }
  if (solo(crew)) {
    lever.down = true;
    powerOn(crew, r, lever.zone, [p.id]);
    c.emit(crew, 'objectives.lever', { id: lever.id, by: p.id, result: 'success', zone: lever.zone, p: lever.p });
    return { ok: true, result: 'success', msg: 'Power restored (solo: one breaker is enough)' };
  }
  r.pending.set(lever.id, { by: p.id, at: now });
  lever.down = true;
  lever.by = p.id;
  markDirty(r);
  c.emit(crew, 'objectives.lever', { id: lever.id, by: p.id, result: 'waiting', zone: lever.zone, p: lever.p });
  return { ok: true, result: 'waiting', msg: 'Breaker down: the other one must follow within 1 s' };
}

function powerOn(crew: Crew, r: ContractRt, zone: number, by: string[]): void {
  const c = ctx();
  r.st.power[zone] = true;
  for (const l of r.st.levers) if (l.zone === zone) { l.down = true; delete l.by; }
  if (r.st.keypad && r.st.keypad.zone === zone) r.st.keypad.enabled = true;
  const spaces = r.layout.spaces.filter((s) => s.powerZone === zone).map((s) => s.id);
  if (!r.st.blackout) deps.setZonePower(crew, zone, true, spaces);
  c.emit(crew, 'objectives.power', { zone, on: true, spaces });
  markDirty(r, true);
  log?.info(`crew ${crew.code}: power zone ${zone} on (by ${by.join(' + ')})`);
}

function tickLevers(crew: Crew, r: ContractRt): void {
  if (!r.pending.size) return;
  const c = ctx();
  const now = c.now();
  const windowMs = num('leverWindowSec', 1.0) * 1000;
  for (const [id, pend] of r.pending) {
    if (now - pend.at <= windowMs) continue;
    r.pending.delete(id);
    const lever = leverById(r, id);
    if (!lever || r.st.power[lever.zone]) continue;
    lever.down = false;
    delete lever.by;
    r.st.leverCooldownUntil = now + num('leverCooldownSec', 20) * 1000;
    deps.emitNoise(crew, { x: lever.p[0], z: lever.p[2], radiusM: NOISE_M.leverAlarm, kind: 'leverAlarm', source: lever.id }, c);
    c.emit(crew, 'objectives.lever', { id, by: pend.by, result: 'fail', zone: lever.zone, p: lever.p, cooldownUntil: r.st.leverCooldownUntil });
    markDirty(r, true);
    log?.info(`crew ${crew.code}: breaker ${id} single pull -> alarm + cooldown`);
  }
}

// ---------------- keypad / vault ----------------
export function enterCode(crew: Crew, p: ServerPlayer, code: string): { ok: boolean; msg?: string } {
  const r = activeRt(crew);
  if (!r || !r.st.keypad) return { ok: false, msg: 'No keypad' };
  const k = r.st.keypad;
  const c = ctx();
  if (!deps.isAlive(crew, p)) return { ok: false, msg: 'You are dead' };
  if (!inReach(p, k.p[0], k.p[2])) return { ok: false, msg: 'Too far from the keypad' };
  if (r.st.vaultOpen) return { ok: true, msg: 'The vault is already open' };
  const deny = (reason: string, m: string) => {
    c.emit(crew, 'objectives.keypad', { id: k.id, by: p.id, ok: false, reason, p: k.p });
    return { ok: false, msg: m };
  };
  if (!k.enabled) return deny('nopower', 'The keypad is dead: restore power first');
  const now = c.now();
  if (k.lockedUntil > now) return deny('locked', `Keypad locked (${Math.ceil((k.lockedUntil - now) / 1000)} s)`);
  const clean = String(code ?? '').replace(/\D/g, '').slice(0, 8);
  if (clean !== r.st.code) {
    r.keypadWrong++;
    if (r.keypadWrong >= num('keypadWrongLimit', 3)) {
      r.keypadWrong = 0;
      k.lockedUntil = now + num('keypadLockoutSec', 10) * 1000;
      markDirty(r);
      deps.emitNoise(crew, { x: k.p[0], z: k.p[2], radiusM: NOISE_M.door, kind: 'keypadAlarm', source: k.id }, c);
    }
    return deny('wrong', 'Wrong code');
  }
  r.keypadWrong = 0;
  r.st.vaultOpen = true;
  if (k.door >= 0) deps.setDoorOpen(crew, k.door, true, p.id);
  deps.emitNoise(crew, { x: k.p[0], z: k.p[2], radiusM: NOISE_M.securityDoor, kind: 'securityDoor', source: k.id }, c);
  c.emit(crew, 'objectives.keypad', { id: k.id, by: p.id, ok: true, p: k.p });
  c.emit(crew, 'objectives.vault', { open: true, door: k.door, by: p.id, p: k.p });
  markDirty(r, true);
  log?.info(`crew ${crew.code}: vault opened by ${p.name}`);
  return { ok: true, msg: 'Vault unlocked' };
}

// ---------------- Core ----------------
export function coreAction(crew: Crew, p: ServerPlayer, action: 'grab' | 'release'): { ok: boolean; msg?: string; state?: ObjCore['state'] } {
  const r = activeRt(crew);
  const core = r?.st.core;
  if (!r || !core) return { ok: false, msg: 'No Core here' };
  const c = ctx();
  // E routed through (b) right after a direct objectives.core request must not toggle the handle back
  r.dedupe.set(`${p.id}|${core.id}`, performance.now());
  const holding = core.carriers.includes(p.id);
  if (action === 'release') {
    if (!holding) return { ok: false, msg: 'Not holding the Core', state: core.state };
    releaseCore(crew, r, p.id, 'released');
    return { ok: true, state: core.state };
  }
  if (holding) return { ok: true, msg: 'Already holding a handle', state: core.state };
  if (!deps.isAlive(crew, p)) return { ok: false, msg: 'You are dead' };
  if (core.state === 'van') return { ok: false, msg: 'The Core is already in the van', state: core.state };
  if (core.state === 'vault' && !r.st.vaultOpen) return { ok: false, msg: 'The vault is sealed', state: core.state };
  if (core.carriers.length >= 2) return { ok: false, msg: 'Both handles are taken', state: core.state };
  const [px, pz] = pos(p);
  if (d2(px, pz, core.p[0], core.p[2]) > num('coreGrabRangeM', 2.2) + num('interactSlackM', 0.8)) return { ok: false, msg: 'Too far from the Core', state: core.state };
  core.carriers.push(p.id);
  if (core.carriers.length === 2 || solo(crew)) {
    core.state = 'carried';
    r.st.coreState = 'carried';
    r.leashSince = 0;
    c.emit(crew, 'objectives.core', { state: 'carried', by: p.id, value: core.value, p: core.p, carriers: core.carriers.slice() });
    log?.info(`crew ${crew.code}: Core lifted (${core.carriers.join(' + ')})`);
  } else {
    c.emit(crew, 'objectives.core', { state: core.state, by: p.id, value: core.value, p: core.p, carriers: core.carriers.slice() });
    msg(crew, p, 'Holding one handle: the Core needs a second carrier');
  }
  markDirty(r, true);
  return { ok: true, state: core.state };
}

function releaseCore(crew: Crew, r: ContractRt, pid: string, why: 'released' | 'leash' | 'dead' | 'left'): void {
  const core = r.st.core;
  if (!core) return;
  const c = ctx();
  const wasCarried = core.state === 'carried';
  core.carriers = core.carriers.filter((x) => x !== pid);
  if (wasCarried) {
    // dropping a lifted Core: value loss + loud clang
    const loss = Math.round(core.value * num('coreDropLossFrac', 0.15));
    core.value -= loss;
    core.drops++;
    core.state = 'dropped';
    r.st.coreState = 'dropped';
    core.carriers = [];
    core.p = [core.p[0], 0, core.p[2]];
    deps.emitNoise(crew, { x: core.p[0], z: core.p[2], radiusM: NOISE_M.coreDrop, kind: 'coreDrop', source: core.id }, c);
    c.emit(crew, 'objectives.core', { state: 'dropped', by: pid, value: core.value, lost: loss, p: core.p, carriers: [] });
    log?.info(`crew ${crew.code}: Core dropped (${why}), -${loss}`);
  } else {
    c.emit(crew, 'objectives.core', { state: core.state, by: pid, value: core.value, p: core.p, carriers: core.carriers.slice() });
  }
  markDirty(r, true);
}

function tickCore(crew: Crew, r: ContractRt, dt: number): void {
  const core = r.st.core;
  if (!core || core.state === 'van') return;
  const c = ctx();
  // carriers that died / disconnected / walked off let go
  for (const pid of core.carriers.slice()) {
    const pl = crew.players.get(pid);
    if (!pl || !pl.connected || !deps.isAlive(crew, pl)) { releaseCore(crew, r, pid, pl && pl.connected ? 'dead' : 'left'); continue; }
    if (core.state !== 'carried') {
      const [px, pz] = pos(pl);
      if (d2(px, pz, core.p[0], core.p[2]) > num('coreGrabRangeM', 2.2) + 1.5) releaseCore(crew, r, pid, 'left');
    }
  }
  if (core.state !== 'carried') return;
  if (core.carriers.length < 2 && !(core.carriers.length === 1 && solo(crew))) {
    // partner gone (left / died) while lifted: it drops
    if (core.carriers.length) releaseCore(crew, r, core.carriers[0], 'left');
    return;
  }
  const a = crew.players.get(core.carriers[0])!;
  const b = crew.players.get(core.carriers[1] ?? core.carriers[0])!;
  const [ax, az] = pos(a);
  const [bx, bz] = pos(b);
  const sep = d2(ax, az, bx, bz);
  if (sep > num('coreLeashM', 3.2)) {
    r.leashSince += dt;
    if (r.leashSince >= num('coreLeashGraceSec', 0.5)) {
      releaseCore(crew, r, a.id, 'leash');
      return;
    }
  } else r.leashSince = 0;
  let mx = (ax + bx) / 2, mz = (az + bz) / 2;
  core.yaw = Math.atan2(bx - ax, bz - az);
  if (a === b) {
    // solo carry: hugged in front of the carrier
    const yaw = a.pose.yaw;
    mx = ax + Math.sin(yaw) * 0.55;
    mz = az + Math.cos(yaw) * 0.55;
    core.yaw = yaw + Math.PI / 2;
  }
  core.p = [mx, 0.55, mz];
  if (crew.tick % 8 === 0) r.regDirty = true; // keep the Core's E point under the carriers
  if (inVanZone(r, mx, mz) || (inVan(r, ax, az) && inVan(r, bx, bz))) {
    core.state = 'van';
    r.st.coreState = 'van';
    core.carriers = [];
    const dep = r.st.deposit;
    core.p = dep ? [dep.p[0], 0, dep.p[2]] : [mx, 0, mz];
    recomputeHaul(r);
    c.emit(crew, 'objectives.core', { state: 'van', value: core.value, p: core.p, carriers: [] });
    markDirty(r, true);
    log?.info(`crew ${crew.code}: Core extracted (+${core.value})`);
  }
}

// ---------------- loot ----------------
const TIER_CLS: LootClass[] = ['small', 'medium', 'heavy'];

/** (b)'s loot items as ObjLoot (ids are (b)'s item ids) */
function mirrorLoot(L: LevelLayout, items: deps.IxItem[]): ObjLoot[] {
  return items.map((it): ObjLoot => {
    const tier = Math.max(0, Math.min(2, Number(it.tier ?? (it.type === 'loot.heavy' ? 2 : it.type === 'loot.medium' ? 1 : 0))));
    const t = it.type.split('.')[1];
    const cls: LootClass = t === 'small' || t === 'medium' || t === 'heavy' ? t : TIER_CLS[tier];
    const p: Vec3 = it.p ? [it.p[0], it.p[1], it.p[2]] : [0, 0, 0];
    const cx = Math.floor(p[0]), cz = Math.floor(p[2]);
    const space = cx >= 0 && cz >= 0 && cx < L.W && cz < L.H ? L.owner[cz * L.W + cx] : -1;
    return { id: it.id, type: it.type, cls, name: it.name ?? 'Salvage', value: Number(it.value ?? 0), fragile: false, where: it.where, ...(it.holder ? { holder: it.holder } : {}), p, rot: it.rot ?? 0, space, tier };
  }).sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
}

/** salvage in the van (deposited, or dropped inside the van rect) + the extracted Core */
function recomputeHaul(r: ContractRt): boolean {
  let count = 0, value = 0;
  for (const l of r.st.loot) {
    if (l.where === 'van' || (l.where === 'world' && inVan(r, l.p[0], l.p[2]))) { count++; value += l.value; }
  }
  const core = r.st.core;
  const hauled = value + (core && core.state === 'van' ? core.value : 0);
  const changed = hauled !== r.st.hauled || count !== r.st.salvage.count || value !== r.st.salvage.value;
  r.st.salvage.count = count;
  r.st.salvage.value = value;
  r.st.hauled = hauled;
  return changed;
}

function tickMirror(crew: Crew, r: ContractRt, force = false): void {
  if (r.st.lootMode !== 'interaction') return;
  if (!force && crew.tick % 6 !== 0) return;
  const items = deps.ixLoot(crew);
  if (!items) return;
  const next = mirrorLoot(r.layout, items);
  const sig = (l: ObjLoot[]) => l.map((x) => `${x.id}:${x.where}:${x.holder ?? ''}:${x.value}:${x.p[0].toFixed(1)},${x.p[2].toFixed(1)}`).join('|');
  if (sig(next) !== sig(r.st.loot)) {
    r.st.loot = next;
    r.st.salvage.total = next.length;
    markDirty(r);
  }
  if (recomputeHaul(r)) markDirty(r);
}

/** (b) deposited loot: floating "+scrip" feedback for everyone */
export function onIxDeposit(crew: Crew, pid: string, items: deps.IxItem[]): void {
  const r = activeRt(crew);
  if (!r) return;
  tickMirror(crew, r, true);
  const dep = r.st.deposit;
  for (const it of items) {
    ctx().emit(crew, 'objectives.loot', { id: it.id, by: pid, action: 'deposit', value: Number(it.value ?? 0), p: dep?.p ?? [0, 0, 0], hauled: r.st.hauled });
  }
}

function units(cls: LootClass): number {
  const u = bal().carryUnits as Record<LootClass, number> | undefined;
  return u?.[cls] ?? (cls === 'heavy' ? 2 : 1);
}

function heldBy(r: ContractRt, pid: string): ObjLoot[] {
  return (r.carried.get(pid) ?? []).map((id) => r.st.loot.find((l) => l.id === id)).filter((l): l is ObjLoot => !!l);
}

export function pickLoot(crew: Crew, p: ServerPlayer, id: string): { ok: boolean; msg?: string } {
  const r = activeRt(crew);
  if (!r) return { ok: false, msg: 'No contract running' };
  if (r.st.lootMode === 'interaction') return { ok: false, msg: 'Salvage is picked up with interaction.use' };
  const item = r.st.loot.find((l) => l.id === id);
  if (!item || item.where !== 'world') return { ok: false, msg: 'Nothing to pick up' };
  if (!deps.isAlive(crew, p)) return { ok: false, msg: 'You are dead' };
  if (!inReach(p, item.p[0], item.p[2])) return { ok: false, msg: 'Too far away' };
  const held = heldBy(r, p.id);
  const used = held.reduce((s, l) => s + units(l.cls), 0);
  if (used + units(item.cls) > num('carryCapacity', 2)) return { ok: false, msg: 'Hands full: deposit in the van or drop (G)' };
  item.where = 'held';
  item.holder = p.id;
  r.carried.set(p.id, [...(r.carried.get(p.id) ?? []), item.id]);
  ctx().emit(crew, 'objectives.loot', { id, by: p.id, action: 'pick', value: item.value, p: item.p, hauled: r.st.hauled });
  markDirty(r, true);
  return { ok: true, msg: `${item.name} (${item.value})` };
}

function depositItem(crew: Crew, r: ContractRt, item: ObjLoot, by: string): void {
  item.where = 'van';
  delete item.holder;
  const dep = r.st.deposit;
  if (dep) {
    const k = r.st.salvage.count;
    item.p = [dep.p[0] + ((k % 3) - 1) * 0.35, 0, dep.p[2] + 0.5 + Math.floor(k / 3) * 0.3];
  }
  recomputeHaul(r);
  ctx().emit(crew, 'objectives.loot', { id: item.id, by, action: 'deposit', value: item.value, p: item.p, hauled: r.st.hauled });
  markDirty(r, true);
}

function removeHeld(r: ContractRt, pid: string, id: string): void {
  const list = (r.carried.get(pid) ?? []).filter((x) => x !== id);
  if (list.length) r.carried.set(pid, list);
  else r.carried.delete(pid);
}

export function dropLoot(crew: Crew, p: ServerPlayer, id?: string, soft = false): { ok: boolean; msg?: string; deposited?: boolean } {
  const r = activeRt(crew);
  if (!r) return { ok: false, msg: 'No contract running' };
  if (r.st.lootMode === 'interaction') return { ok: false, msg: 'Salvage is dropped with interaction.drop' };
  const held = heldBy(r, p.id);
  const item = id ? held.find((l) => l.id === id) : held[held.length - 1];
  if (!item) return { ok: false, msg: 'Not carrying salvage' };
  removeHeld(r, p.id, item.id);
  const [px, pz] = pos(p);
  if (inVan(r, px, pz)) {
    depositItem(crew, r, item, p.id);
    return { ok: true, deposited: true, msg: `+${item.value} scrip` };
  }
  const yaw = p.pose.yaw;
  let x = px + Math.sin(yaw) * 0.45, z = pz + Math.cos(yaw) * 0.45;
  const L = r.layout;
  const cx = Math.floor(x), cz = Math.floor(z);
  if (cx < 0 || cz < 0 || cx >= L.W || cz >= L.H || L.owner[cz * L.W + cx] < 0) { x = px; z = pz; }
  item.where = 'world';
  delete item.holder;
  item.p = [x, 0, z];
  item.rot = yaw;
  let action: 'drop' | 'break' = 'drop';
  if (item.fragile && !soft) {
    const loss = Math.max(1, Math.round(item.value * num('fragileLossFrac', 0.1)));
    item.value = Math.max(1, item.value - loss);
    action = 'break';
  }
  ctx().emit(crew, 'objectives.loot', { id: item.id, by: p.id, action, value: item.value, p: item.p, hauled: r.st.hauled });
  markDirty(r, true);
  return { ok: true, deposited: false, msg: action === 'break' ? `${item.name} cracked (now ${item.value})` : undefined };
}

export function depositAll(crew: Crew, p: ServerPlayer): { ok: boolean; msg?: string; value: number } {
  const r = activeRt(crew);
  if (!r) return { ok: false, msg: 'No contract running', value: 0 };
  const [px, pz] = pos(p);
  const dep = r.st.deposit;
  const near = inVan(r, px, pz) || (!!dep && inReach(p, dep.p[0], dep.p[2]));
  if (!near) return { ok: false, msg: 'Get inside the van to deposit', value: 0 };
  if (r.st.lootMode === 'interaction') {
    const items = deps.ixDepositLoot(crew, p.id);
    deps.ixFlush(crew);
    const v = items.reduce((s, it) => s + Number(it.value ?? 0), 0);
    tickMirror(crew, r, true);
    return items.length ? { ok: true, value: v, msg: `+${v} scrip` } : { ok: false, msg: 'Nothing to deposit', value: 0 };
  }
  const held = heldBy(r, p.id);
  if (!held.length) return { ok: false, msg: 'Nothing to deposit', value: 0 };
  let v = 0;
  for (const item of held) { removeHeld(r, p.id, item.id); depositItem(crew, r, item, p.id); v += item.value; }
  return { ok: true, value: v, msg: `+${v} scrip` };
}

function dropAllOf(crew: Crew, r: ContractRt, p: ServerPlayer): void {
  for (const item of heldBy(r, p.id)) dropLoot(crew, p, item.id, true);
}

// ---------------- leave lever / end ----------------
export function pullLeave(crew: Crew, p: ServerPlayer): { ok: boolean; msg?: string } {
  const r = activeRt(crew);
  if (!r) return { ok: false, msg: 'No contract running' };
  const ll = r.st.leaveLever;
  if (ll && !inReach(p, ll.p[0], ll.p[2], 0.6) && !inVan(r, ...pos(p))) return { ok: false, msg: 'Too far from the lever' };
  if (!deps.isAlive(crew, p)) return { ok: false, msg: 'You are dead' };
  const outside = livingPlayers(crew).filter((q) => q.connected && !inVan(r, ...pos(q)));
  if (outside.length) {
    const m = `${outside.length} crew still outside the van: ${outside.map((q) => q.name).join(', ')}`;
    msg(crew, p, m, 'warn');
    return { ok: false, msg: m };
  }
  endContract(crew, 'leave');
  return { ok: true, msg: 'The van is leaving' };
}

export function endContract(crew: Crew, reason: ObjContractResult['reason']): ObjContractResult | null {
  const r = rt(crew);
  if (!r || r.st.ended) return r?.result ?? null;
  const c = ctx();
  const st = r.st;
  const leftBehind: string[] = [];
  if (reason === 'departure') {
    for (const p of crew.players.values()) {
      if (!deps.isAlive(crew, p)) continue;
      if (!inVan(r, ...pos(p))) {
        leftBehind.push(p.id);
        dropAllOf(crew, r, p);
        if (r.st.core?.carriers.includes(p.id)) releaseCore(crew, r, p.id, 'left');
        deps.kill(crew, p, { killer: 'company', reason: 'left behind', detail: 'The van left at 04:00' });
        recordDeath(crew, r, p.id, 'left behind');
      }
    }
    c.emit(crew, 'objectives.departure', { lost: leftBehind });
  }
  // salvage still in the hands of players inside the van counts
  for (const p of crew.players.values()) {
    if (!deps.isAlive(crew, p) || !inVan(r, ...pos(p))) continue;
    if (st.lootMode === 'interaction') deps.ixDepositLoot(crew, p.id);
    else for (const item of heldBy(r, p.id)) { removeHeld(r, p.id, item.id); depositItem(crew, r, item, p.id); }
  }
  tickMirror(crew, r, true);
  // a Core carried into the van zone at the buzzer counts
  const core = st.core;
  if (core && core.state === 'carried' && inVanZone(r, core.p[0], core.p[2])) {
    core.state = 'van';
    st.coreState = 'van';
  }
  recomputeHaul(r);
  const survivors = [...crew.players.values()].filter((p) => deps.isAlive(crew, p) && !leftBehind.includes(p.id)).map((p) => p.id);
  const wipe = survivors.length === 0;
  const realReason: ObjContractResult['reason'] = wipe && reason !== 'abort' ? 'wipe' : reason;
  const coreExtracted = !!core && core.state === 'van';
  const hauled = wipe ? 0 : st.hauled;
  // requests
  for (const q of st.requests) {
    if (q.kind === 'ALL_SURVIVE') {
      // everyone who started the shift comes home alive (a revived teammate counts as home)
      const all = r.playersAtStart.every((pid) => survivors.includes(pid));
      q.done = !wipe && all && leftBehind.length === 0;
      q.failed = !q.done;
    }
    else if (q.kind === 'EXTRACT_ABOVE') { q.done = hauled > Number(q.param ?? 0); q.failed = !q.done; }
    else if (q.kind === 'LURE_IT_WITH_A_LIE') { q.done = r.lureDone; q.failed = !q.done; }
    else if (!q.done) q.failed = true;
  }
  const requestsMet = st.requests.filter((q) => q.done).map((q) => q.kind);
  const result: ObjContractResult = {
    orderId: st.orderId,
    risk: st.risk,
    hauled,
    survivors,
    deaths: r.deaths.slice(),
    coreExtracted,
    requestsMet,
    at: new Date().toISOString(),
    crew: crew.code,
    lootTotal: st.lootTotal,
    salvage: wipe ? 0 : st.salvage.value,
    coreValue: coreExtracted && core ? core.value : 0,
    requestsReward: st.requests.filter((q) => q.done).reduce((s, q) => s + q.reward, 0),
    requests: st.requests.map((q) => ({ ...q })),
    reason: realReason,
    leftBehind,
    durationSec: Math.round((performance.now() - r.startedPerf) / 100) / 10,
  };
  st.ended = true;
  r.result = result;
  r.pending.clear();
  markDirty(r, true);
  syncInteractables(crew, r);
  flush(crew, r, true);
  log?.info(`crew ${crew.code}: contract ended (${realReason}): hauled ${hauled}, core ${coreExtracted}, survivors ${survivors.length}, requests ${requestsMet.join(',') || '-'}`);
  if (reason === 'abort') return result;
  c.emit(crew, 'objectives.end', { result });
  let handled = 0;
  for (const fn of endListeners.slice()) {
    try { fn(crew, result); handled++; } catch (e) { log?.warn('onContractEnd listener threw', e instanceof Error ? (e.stack ?? e.message) : e); }
  }
  // no meta yet: move the crew to 'results' ourselves so the flow never hangs
  if (!handled) r.endFallbackAt = performance.now() + 2500;
  return result;
}

function recordDeath(crew: Crew, r: ContractRt, pid: string, cause: string): void {
  if (r.st.dead.includes(pid)) return;
  r.st.dead.push(pid);
  r.deaths.push({ player: pid, cause });
  markDirty(r);
}

export function onPlayerDeath(crew: Crew, pid: string, cause: unknown): void {
  const r = activeRt(crew);
  if (!r) return;
  const p = crew.players.get(pid);
  const c = cause as { killer?: string; reason?: string } | string | undefined;
  const text = typeof c === 'string' ? c : c ? [c.killer, c.reason].filter(Boolean).join(': ') : 'unknown';
  recordDeath(crew, r, pid, text || 'unknown');
  if (p) {
    dropAllOf(crew, r, p);
    if (r.st.core?.carriers.includes(pid)) releaseCore(crew, r, pid, 'dead');
  }
}

/** (c) listener decision: LURE_IT_WITH_A_LIE is met when it goes for a named room nobody is in. */
export function onListenerDecision(args: unknown[]): void {
  let crew: Crew | null = null;
  let d: Record<string, unknown> | null = null;
  for (const a of args) {
    if (!a || typeof a !== 'object') continue;
    const o = a as Record<string, unknown>;
    if (o.players instanceof Map && typeof o.code === 'string') crew = a as Crew;
    else if (!d) d = o;
  }
  if (!crew || !d) return;
  const r = activeRt(crew);
  if (!r || r.lureDone) return;
  const intent = (d.intent && typeof d.intent === 'object' ? d.intent : d) as Record<string, unknown>;
  const action = String(intent.action ?? intent.kind ?? intent.type ?? d.action ?? '');
  if (!/investigate|ambush/.test(action)) return;
  // only server-validated decisions that came from something the crew SAID (a named room)
  if (d.valid === false || intent.valid === false) return;
  if ('heard' in d && !d.heard && !d.room) return;
  const raw = intent.target ?? intent.room ?? intent.space ?? d.target ?? d.room ?? d.space ?? d.targetSpace;
  const L = r.layout;
  let space = -1;
  if (typeof raw === 'number') space = raw;
  else if (typeof raw === 'string') {
    const m = /^(?:space|room):?(\d+)$/i.exec(raw);
    if (m) space = Number(m[1]);
    else {
      const up = raw.toUpperCase().replace(/[^A-Z]/g, '');
      space = L.spaces.find((s) => s.callsign && s.callsign.replace(/[^A-Z]/g, '') === up)?.id ?? -1;
    }
  } else if (raw && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    space = typeof o.space === 'number' ? o.space : typeof o.id === 'number' ? o.id : -1;
  }
  if (space < 0 || !L.spaces[space]) return;
  const occupied = livingPlayers(crew).some((p) => spaceContains(L, space, p.pose.p[0], p.pose.p[2]));
  if (occupied) return;
  r.lureDone = true;
  for (const q of r.st.requests) {
    if (q.kind === 'LURE_IT_WITH_A_LIE' && !q.done) {
      q.done = true;
      ctx().emit(crew, 'objectives.request', { ...q });
      ctx().notice(crew, `Company Request met: it went to ${L.spaces[space].callsign ?? 'an empty room'} and found nobody.`);
    }
  }
  markDirty(r);
}

// ---------------- generic interact (E) ----------------
export function interact(crew: Crew, p: ServerPlayer, id: string): { ok: boolean; msg?: string; open?: 'keypad' | 'note' } {
  const r = activeRt(crew);
  if (!r) return { ok: false, msg: 'No contract running' };
  const kind = id.split(':')[0];
  switch (kind) {
    case 'lever': return pullLever(crew, p, id);
    case 'keypad': {
      const k = r.st.keypad;
      if (!k || !inReach(p, k.p[0], k.p[2])) return { ok: false, msg: 'Too far from the keypad' };
      ctx().emit(crew, 'objectives.open', { ui: 'keypad', id }, { to: [p.id] });
      return { ok: true, open: 'keypad' };
    }
    case 'note': {
      const n = r.st.notes.find((x) => x.id === id);
      if (!n) return { ok: false, msg: 'Nothing to read' };
      ctx().emit(crew, 'objectives.open', { ui: 'note', id }, { to: [p.id] });
      return { ok: true, open: 'note' };
    }
    case 'core': {
      if (dedupe(r, p.id, id)) return { ok: true };
      return coreAction(crew, p, r.st.core?.carriers.includes(p.id) ? 'release' : 'grab');
    }
    case 'loot': {
      if (dedupe(r, p.id, id)) return { ok: true };
      return pickLoot(crew, p, id);
    }
    case 'deposit': {
      if (dedupe(r, p.id, id)) return { ok: true };
      return depositAll(crew, p);
    }
    case 'leave_lever': {
      if (dedupe(r, p.id, id, 800)) return { ok: true };
      return pullLeave(crew, p);
    }
    default: return { ok: false, msg: `Not an objectives interactable: ${id}` };
  }
}

// ---------------- clock / tick ----------------
function tickClock(crew: Crew, r: ContractRt): void {
  const c = ctx();
  const m = clockMinOf(r);
  if (!r.fired.reminder && m >= num('coreReminderMin', 240) && r.st.core && r.st.core.state !== 'van') {
    r.fired.reminder = true;
    pa(crew, 'vo.pa_core_reminder', 'Reminder: the Core does not extract itself.');
  }
  if (!r.fired.blackout && m >= CLOCK.blackoutMin) {
    r.fired.blackout = true;
    r.st.blackout = true;
    deps.setBlackout(crew, true);
    c.emit(crew, 'objectives.blackout', { clockMin: Math.round(m) });
    pa(crew, 'vo.pa_blackout', 'Grid failure. Facility power is offline.');
    markDirty(r, true);
    log?.info(`crew ${crew.code}: 03:00 blackout`);
  }
  if (!r.fired.horn && m >= CLOCK.hornMin) {
    r.fired.horn = true;
    r.st.horn = true;
    const v = r.layout.van;
    c.emit(crew, 'objectives.horn', { clockMin: Math.round(m), p: [v.x, 1.2, v.z] });
    pa(crew, 'vo.pa_departure_warning', 'Thirty minutes to departure. The van will not wait.');
    markDirty(r);
  }
  if (!r.fired.departure && m >= CLOCK.totalGameMin) {
    r.fired.departure = true;
    pa(crew, 'vo.pa_van_leaving', 'The van is leaving.');
    endContract(crew, 'departure');
  }
}

function tickDeaths(crew: Crew, r: ContractRt): void {
  let anyAlive = false;
  let anyone = false;
  for (const p of crew.players.values()) {
    if (!r.playersAtStart.includes(p.id) && !p.connected) continue;
    anyone = true;
    const alive = deps.isAlive(crew, p);
    if (alive) {
      anyAlive = true;
      if (r.st.dead.includes(p.id)) { r.st.dead = r.st.dead.filter((x) => x !== p.id); markDirty(r); }
    } else if (!r.st.dead.includes(p.id)) onPlayerDeath(crew, p.id, 'unknown');
  }
  if (anyone && !anyAlive) endContract(crew, 'wipe');
}

function tickRequests(crew: Crew, r: ContractRt): void {
  for (const q of r.st.requests) {
    if (q.kind === 'EXTRACT_ABOVE' && !q.done && r.st.hauled > Number(q.param ?? 0)) {
      q.done = true;
      ctx().emit(crew, 'objectives.request', { ...q });
      markDirty(r);
    }
  }
}

function tickCarriers(crew: Crew, r: ContractRt): void {
  for (const [pid] of r.carried) {
    const p = crew.players.get(pid);
    if (!p) { r.carried.delete(pid); continue; }
    if (!p.connected) dropAllOf(crew, r, p);
  }
}

export function tick(dt: number, crew: Crew): void {
  const r = rt(crew);
  if (!r) return;
  if (r.endFallbackAt && performance.now() >= r.endFallbackAt) {
    r.endFallbackAt = 0;
    if (crew.phase === 'contract') ctx().setPhase(crew, 'results');
  }
  if (crew.phase !== 'contract' || !r.st.active) return;
  if (!r.st.ended) {
    tickLevers(crew, r);
    tickMirror(crew, r);
    tickCarriers(crew, r);
    tickCore(crew, r, dt);
    tickDeaths(crew, r);
    tickRequests(crew, r);
    if (!r.st.ended) tickClock(crew, r);
  }
  syncInteractables(crew, r);
  flush(crew, r);
}

// ---------------- hooks ----------------
export function onPhase(crew: Crew, from: string, to: string): void {
  const r = rt(crew);
  if (!r) return;
  if (from === 'contract' && to !== 'contract') {
    if (!r.st.ended) endContract(crew, 'abort');
    r.st.active = false;
    r.regDirty = true;
    syncInteractables(crew, r);
  } else if (to === 'contract' && crew.layout !== r.layout) {
    // a new facility without startContract (yet): forget the old contract
    crew.slices[TRACK] = undefined;
  }
}

export function fillSnapshot(crew: Crew, snap: Snapshot): void {
  const r = rt(crew);
  if (!r || !r.st.active || crew.phase !== 'contract') return;
  const core = r.st.core;
  if (core) {
    snap.dyn.push({ id: core.id, p: core.p, yaw: core.yaw });
    if (core.state === 'carried') for (const sp of snap.players) if (core.carriers.includes(sp.id)) sp.carry = core.id;
  }
  for (const [pid, ids] of r.carried) {
    const sp = snap.players.find((x) => x.id === pid);
    if (!sp || !ids.length) continue;
    const s = Math.sin(sp.yaw), co = Math.cos(sp.yaw);
    ids.forEach((id, i) => {
      const side = i === 0 ? 0.22 : -0.22;
      const p: Vec3 = [sp.p[0] + s * 0.38 + co * side, 0.95, sp.p[2] + co * 0.38 - s * side];
      snap.dyn.push({ id, p, yaw: sp.yaw });
    });
    sp.carry ??= ids[ids.length - 1];
  }
}

/** Carry state of a player (for ⑤ speed clamps / animations). */
export function carrying(crew: Crew, pid: string): 'core' | 'loot' | null {
  const r = rt(crew);
  if (!r || !r.st.active || r.st.ended) return null;
  if (r.st.core?.state === 'carried' && r.st.core.carriers.includes(pid)) return 'core';
  if ((r.carried.get(pid) ?? []).length) return 'loot';
  return null;
}

/** Debug: jump the contract clock to in-game minute `min` and/or change its real length. */
export function setClock(crew: Crew, opts: { min?: number; realSec?: number }): ObjectivesState | null {
  const r = rt(crew);
  if (!r) return null;
  const c = ctx();
  const cur = clockMinOf(r);
  if (opts.realSec && opts.realSec > 0) {
    r.st.realSec = opts.realSec;
    r.st.startedAt = c.now() - (cur / CLOCK.totalGameMin) * opts.realSec * 1000;
  }
  if (typeof opts.min === 'number') {
    const m = Math.max(0, Math.min(CLOCK.totalGameMin, opts.min));
    r.st.startedAt = c.now() - (m / CLOCK.totalGameMin) * r.st.realSec * 1000;
    if (m < CLOCK.blackoutMin) r.fired.blackout = false;
    if (m < CLOCK.hornMin) r.fired.horn = false;
  }
  markDirty(r);
  flush(crew, r, true);
  return r.st;
}
