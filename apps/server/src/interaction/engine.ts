// Owner: track (b) Interaction. Per-crew interaction engine: interactable registry, doors, items + inventories,
// throws, melee, glowsticks, hiding, light switches, death / bodies / badges / revive. All state lives in
// crew.slices.interaction (an InteractionState plus private fields), so ① Net can read slices.interaction.doors[id].open.
import type { Crew, ServerContext, ServerPlayer } from '../core/types.ts';
import type { LayoutDoor, LayoutItem, LevelLayout } from '@dead-air/shared/layout.ts';
import type { InteractableInfo } from '@dead-air/shared/interactables.ts';
import { GEAR_PACKS, INTERACT_RADIUS, INV_SLOTS, ITEM_DEFS, LOOT_NAMES, LOOT_TIER_TYPES, itemDef } from '@dead-air/shared/interactables.ts';
import type {
  BodyState, DeathCause, DoorState, InteractionPatch, InteractionState, IxFxKind, IxResult, ItemState,
} from '@dead-air/shared/messages/interaction.ts';
import { buildEdgeGrid, los } from '@dead-air/shared/nav/index.ts';
import type { EdgeGrid } from '@dead-air/shared/nav/index.ts';
import { NOISE_M, PLAYER, WORLD } from '@dead-air/shared/constants.ts';
import { STANCE } from '@dead-air/shared/state.ts';
import { ANIM } from '@dead-air/shared/anim.ts';
import type { Vec3 } from '@dead-air/shared/state.ts';
import { makeRng } from '@dead-air/shared/rng.ts';
import type { Rng } from '@dead-air/shared/rng.ts';

export const TRACK = 'interaction';

// ---------------------------------------------------------------- types

export interface DoorGeom { id: number; kind: string; lock: number; a: number; b: number; x0: number; z0: number; x1: number; z1: number; cx: number; cz: number; dir: 'v' | 'h' }

export interface Thrown { id: string; p: Vec3; v: Vec3; t: number; by: string; item: string }

export interface DeathRecord { pid: string; name: string; cause: DeathCause; at: number; p: Vec3; revived?: 'medkit' | 'badge' | 'api' }

/** handler for kinds owned by other tracks; truthy = handled. A string = denial message shown in the HUD. */
export type InteractFn = (crew: Crew, player: ServerPlayer, targetId: string) => boolean | string | void | { ok: boolean; msg?: string };
export type DeathFn = (crew: Crew, pid: string, cause: DeathCause, p: Vec3) => void;
export type ReviveFn = (crew: Crew, pid: string, how: 'medkit' | 'badge' | 'api', by: string | null) => void;
export type MeleeFn = (crew: Crew, pid: string, pos: Vec3, dir: Vec3) => boolean | void;
export type DoorFn = (crew: Crew, id: number, open: boolean, by: string | null) => void;
export type DepositFn = (crew: Crew, pid: string, items: ItemState[]) => void;

export interface IxSlice extends InteractionState {
  layoutKey: string | null;
  grid: EdgeGrid | null;
  doorGeom: Map<number, DoorGeom>;
  /** space -> switch on */
  switches: Record<number, boolean>;
  broken: Set<number>;
  /** pushed power overrides (setPower) */
  powerPush: Record<number, boolean>;
  /** pushed blackout (setBlackout); null = ask objectives */
  blackoutPush: boolean | null;
  thrown: Thrown[];
  patch: InteractionPatch;
  nextId: number;
  deaths: DeathRecord[];
  /** pid -> server ms of the last act (cooldowns) */
  lastAct: Record<string, number>;
  lastHand: Record<number, number>;
  tickN: number;
  walkiesGiven: boolean;
  /** tool extras (bottles, glowsticks, ...) wait until objectives rolled its loot (so slots don't collide) */
  extrasPending: number;
  /** layout item lookups */
  layoutItems: Map<string, LayoutItem>;
  /** v1.1: cursed idol whisper timers (pid -> next server ms), whisper counter, deterministic stream per layout */
  idolNext: Record<string, number>;
  idolN: number;
  rng: Rng | null;
}

// ---------------------------------------------------------------- module state (bound at install)

let ctx: ServerContext | null = null;
const interactFns = new Map<string, InteractFn[]>();
const deathFns: DeathFn[] = [];
const reviveFns: ReviveFn[] = [];
const meleeFns: MeleeFn[] = [];
const doorFns: DoorFn[] = [];
const depositFns: DepositFn[] = [];

interface NoiseApi { emitNoise?: (crew: Crew, n: { x: number; z: number; radiusM: number; kind: string; source: string | null }) => void }
interface ObjApi { state?: (crew: Crew) => { power?: Record<number, boolean>; blackout?: boolean } | null | undefined }
export const adapters: { noise: NoiseApi | null; obj: ObjApi | null; meta: Record<string, unknown> | null } = { noise: null, obj: null, meta: null };

export function bindCtx(c: ServerContext): void { ctx = c; }
export function getCtx(): ServerContext | null { return ctx; }

export function onInteractKind(kind: string, fn: InteractFn): void {
  const l = interactFns.get(kind) ?? [];
  l.push(fn);
  interactFns.set(kind, l);
}
export const hasHandler = (kind: string): boolean => (interactFns.get(kind)?.length ?? 0) > 0;
export function addDeathFn(fn: DeathFn): void { deathFns.push(fn); }
export function addReviveFn(fn: ReviveFn): void { reviveFns.push(fn); }
export function addMeleeFn(fn: MeleeFn): void { meleeFns.push(fn); }
export function addDoorFn(fn: DoorFn): void { doorFns.push(fn); }
export function addDepositFn(fn: DepositFn): void { depositFns.push(fn); }

const now = (): number => (ctx ? ctx.now() : performance.timeOrigin + performance.now());

function bal(): Record<string, unknown> {
  return (ctx?.balance.interaction as Record<string, unknown> | undefined) ?? {};
}
export function num(key: string, d: number): number {
  const v = bal()[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

function safe<T>(what: string, fn: () => T): T | undefined {
  try {
    return fn();
  } catch (e) {
    ctx?.log(TRACK).warn(`${what} threw:`, e instanceof Error ? (e.stack ?? e.message) : e);
    return undefined;
  }
}

// ---------------------------------------------------------------- slice + patches

function emptyState(): InteractionState {
  return { doors: {}, items: {}, inventories: {}, lights: {}, dead: [], hidden: {}, active: {}, ints: {}, glows: {}, bodies: {}, respawns: {}, hp: {}, flares: {} };
}

export function slice(crew: Crew): IxSlice {
  let s = crew.slices[TRACK] as IxSlice | undefined;
  if (!s) {
    s = {
      ...emptyState(), layoutKey: null, grid: null, doorGeom: new Map(), switches: {}, broken: new Set(), powerPush: {},
      blackoutPush: null, thrown: [], patch: {}, nextId: 1, deaths: [], lastAct: {}, lastHand: {}, tickN: 0,
      walkiesGiven: false, extrasPending: 0, layoutItems: new Map(), idolNext: {}, idolN: 0, rng: null,
    };
    crew.slices[TRACK] = s;
  }
  if (s.layoutKey !== layoutKey(crew.layout)) rebuild(crew, s);
  return s;
}

export function publicState(s: IxSlice): InteractionState {
  return {
    doors: s.doors, items: s.items, inventories: s.inventories, lights: s.lights, dead: s.dead, hidden: s.hidden,
    active: s.active, ints: s.ints, glows: s.glows, bodies: s.bodies, respawns: s.respawns, hp: s.hp, flares: s.flares,
  };
}

const layoutKey = (L: LevelLayout | null): string | null => (L ? `${L.kind}:${L.seed}:${L.hash}` : null);

function markDoor(s: IxSlice, id: number): void { (s.patch.doors ??= {})[id] = { ...s.doors[id] }; }
function markItem(s: IxSlice, id: string): void { (s.patch.items ??= {})[id] = s.items[id] ? { ...s.items[id] } : null; }
function markInv(s: IxSlice, pid: string): void {
  (s.patch.inventories ??= {})[pid] = s.inventories[pid] ? [...s.inventories[pid]] : null;
  (s.patch.active ??= {})[pid] = s.active[pid] ?? null;
}
function markInt(s: IxSlice, id: string): void { (s.patch.ints ??= {})[id] = s.ints[id] ? { ...s.ints[id] } : null; }
function markHidden(s: IxSlice, pid: string): void { (s.patch.hidden ??= {})[pid] = s.hidden[pid] ?? null; }
function markGlow(s: IxSlice, id: string): void { (s.patch.glows ??= {})[id] = s.glows[id] ?? null; }
function flaresOf(s: IxSlice): NonNullable<InteractionState['flares']> { return (s.flares ??= {}); }
function markFlare(s: IxSlice, id: string): void { (s.patch.flares ??= {})[id] = flaresOf(s)[id] ? { ...flaresOf(s)[id]! } : null; }
function markBody(s: IxSlice, pid: string): void { (s.patch.bodies ??= {})[pid] = s.bodies[pid] ? { ...s.bodies[pid] } : null; }
function markRespawn(s: IxSlice, pid: string): void { (s.patch.respawns ??= {})[pid] = s.respawns[pid] ?? null; }
function markHp(s: IxSlice, pid: string): void { (s.patch.hp ??= {})[pid] = s.hp[pid] ?? null; }
function markDead(s: IxSlice): void { s.patch.dead = [...s.dead]; }

/** Send pending changes to the crew (call at the end of a request / tick / API mutation batch). */
export function flush(crew: Crew): void {
  const s = crew.slices[TRACK] as IxSlice | undefined;
  if (!s) return;
  const p = s.patch;
  if (!Object.keys(p).length) return;
  s.patch = {};
  ctx?.emit(crew, 'interaction.patch', p);
}

function fx(crew: Crew, kind: IxFxKind, d: { p?: Vec3; pid?: string; id?: string; door?: number; open?: boolean; item?: string } = {}): void {
  ctx?.emit(crew, 'interaction.fx', { kind, ...d });
}

export function noise(crew: Crew, x: number, z: number, radiusM: number, kind: string, source: string | null): void {
  const fn = adapters.noise?.emitNoise;
  if (typeof fn === 'function') safe('emitNoise', () => fn(crew, { x, z, radiusM, kind, source }));
}

// ---------------------------------------------------------------- layout rebuild

const DEFAULT_PROMPTS: Record<string, string> = {
  lever: 'Pull lever (needs a partner)', keypad: 'Use keypad', core: 'Lift the Core (needs two)', note: 'Read note',
  intercom: 'Press intercom', console: 'Use console', board: 'Work orders', shop: 'Shop', mirror: 'Change your look',
  kennel: 'Training kennel', leave_lever: 'Leave now (everyone in the van)', deposit: 'Deposit loot',
  locker: 'Hide in locker', switch: 'Light switch',
};
/** layout slot kinds that become interactables (slot kind -> interactable kind) */
const SLOT_TO_KIND: Record<string, string> = {
  lever: 'lever', keypad: 'keypad', core: 'core', note: 'note', intercom: 'intercom', console: 'console', board: 'board',
  shop: 'shop', mirror: 'mirror', kennel: 'kennel', leave_lever: 'leave_lever', deposit: 'deposit', hiding: 'locker', switch: 'switch',
};
/** kinds this track handles itself (always enabled) */
const OWN_KINDS = new Set(['door', 'locker', 'switch', 'body', 'deposit']);
/** interaction point height (m) when the layout item has no y */
const KIND_Y: Record<string, number> = { locker: 1.0, console: 0.95, board: 1.4, shop: 1.0, mirror: 1.4, deposit: 0.4, kennel: 1.0, core: 0.6 };

function doorGeom(d: LayoutDoor): DoorGeom {
  const x0 = d.x, z0 = d.y;
  const x1 = d.dir === 'v' ? d.x : d.x + d.len;
  const z1 = d.dir === 'v' ? d.y + d.len : d.y;
  return { id: d.id, kind: d.kind, lock: d.lock, a: d.a, b: d.b, x0, z0, x1, z1, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, dir: d.dir };
}

function doorPrompt(kind: string, open: boolean, locked: boolean): string {
  if (kind === 'vault') return open ? 'Vault door (open)' : 'Vault door: use the keypad';
  if (locked) return 'Locked: needs the keycard';
  if (kind === 'security') return open ? 'Hold: close security door' : 'Hold: open security door';
  return open ? 'Close door' : 'Open door';
}

function clearObj(o: Record<string | number, unknown>): void {
  for (const k of Object.keys(o)) delete o[k];
}

/** (Re)build doors, interactables, switches and world items for crew.layout. Keeps held items (inventories). */
function rebuild(crew: Crew, s: IxSlice): void {
  const L = crew.layout;
  s.layoutKey = layoutKey(L);
  s.grid = null;
  s.doorGeom.clear();
  s.layoutItems.clear();
  clearObj(s.doors);
  clearObj(s.ints);
  clearObj(s.lights);
  clearObj(s.switches);
  clearObj(s.glows);
  clearObj(flaresOf(s));
  clearObj(s.idolNext);
  s.idolN = 0;
  s.rng = L ? makeRng(`${L.seed}:${L.hash}`, 'interaction.gear') : null;
  s.broken.clear();
  s.thrown.length = 0;
  for (const [id, it] of Object.entries(s.items)) if (it.where !== 'held') delete s.items[id];
  for (const pid of Object.keys(s.hidden)) delete s.hidden[pid];
  if (L) {
    try {
      s.grid = buildEdgeGrid(L);
    } catch (e) {
      ctx?.log(TRACK).warn('buildEdgeGrid failed:', e instanceof Error ? e.message : e);
    }
    for (const d of L.doors) {
      const g = doorGeom(d);
      s.doorGeom.set(d.id, g);
      const locked = d.kind === 'locked' || d.kind === 'vault' || d.kind === 'blocked';
      const open = d.kind === 'open' ? true : d.kind === 'blocked' ? false : !!d.initiallyOpen && !locked;
      s.doors[d.id] = { open, locked, kind: d.kind };
      if (d.kind === 'open' || d.kind === 'blocked') continue;
      s.ints[`door:${d.id}`] = {
        id: `door:${d.id}`, kind: 'door', p: [g.cx, 1.1, g.cz], prompt: doorPrompt(d.kind, open, locked), enabled: d.kind !== 'vault',
        holdMs: d.kind === 'security' ? num('securityHoldMs', 2000) : undefined, ref: d.id,
      };
    }
    for (const sp of L.spaces) {
      s.switches[sp.id] = sp.light !== 'off';
      if (sp.light === 'broken') s.broken.add(sp.id);
    }
    for (const it of L.items) {
      s.layoutItems.set(it.id, it);
      const kind = SLOT_TO_KIND[it.kind];
      if (!kind) continue;
      const y = it.y && kind !== 'locker' && kind !== 'deposit' ? it.y : (KIND_Y[kind] ?? 1.1);
      const enabled = OWN_KINDS.has(kind) || hasHandler(kind);
      const info: InteractableInfo = { id: it.id, kind, p: [it.x, y, it.z], prompt: DEFAULT_PROMPTS[kind] ?? kind, enabled, ref: it.id };
      if (kind === 'switch') info.ref = Number(it.data?.space ?? it.space);
      if (INTERACT_RADIUS[kind]) info.r = INTERACT_RADIUS[kind];
      s.ints[it.id] = info;
    }
    spawnWorldItems(crew, s, L);
    recomputeLights(crew, s, false);
  }
  s.patch = { reset: publicState(s) };
}

function newItem(s: IxSlice, type: string, extra: Partial<ItemState> = {}): ItemState {
  const id = `it${s.nextId++}`;
  const d = itemDef(type);
  const it: ItemState = { id, type, value: 0, where: 'world', ...(d.stack ? { count: d.stack } : {}), ...extra };
  s.items[id] = it;
  return it;
}

function spawnWorldItems(crew: Crew, s: IxSlice, L: LevelLayout): void {
  if (L.kind !== 'facility') return;
  for (const kc of L.items.filter((i) => i.kind === 'keycard')) {
    newItem(s, 'keycard', { lock: Number(kc.data?.lock ?? 1), name: 'Keycard', p: [kc.x, kc.y ?? 0.85, kc.z], rot: kc.rot ?? 0 });
  }
  s.extrasPending = 1;
  // objectives (a) owns salvage when it handles 'loot' (its own registry + deposit); otherwise we roll the budget
  if (hasHandler('loot')) return;
  const core = ctx?.balance.core ?? {};
  const risk = Math.max(1, Math.min(3, Number(L.metrics?.risk ?? 1) | 0));
  // same multiplier objectives / meta use: the connected crew (fallback: the layout's generation size)
  const connected = [...crew.players.values()].filter((p) => p.connected).length;
  const players = Math.max(1, Math.min(6, connected || Number(L.metrics?.players ?? 2) | 0));
  const riskMult = Number((core.riskLootMult as Record<string, number> | undefined)?.[risk] ?? 1);
  const playerMult = Number((core.playerMult as Record<string, number> | undefined)?.[players] ?? 1);
  const budget = Number(core.lootBudgetBase ?? 650) * riskMult * playerMult;
  const tierVals = (bal().lootTierValues as [number, number][] | undefined) ?? [[8, 35], [35, 90], [150, 300]];
  const rng = makeRng(`${L.seed}:${L.hash}`, 'interaction.loot');
  const slots = rng.shuffle(L.items.filter((i) => i.kind === 'loot'));
  const used = new Set<string>();
  const maxHeavy = Math.max(1, Math.floor(budget / 450));
  let heavy = 0;
  let total = 0;
  for (const sl of slots) {
    if (total >= budget) break;
    let tier = Math.max(0, Math.min(2, Number(sl.data?.tier ?? 0) | 0));
    if (tier === 2 && heavy >= maxHeavy) tier = 1;
    const [lo, hi] = tierVals[tier] ?? [10, 30];
    let value = rng.int(lo, hi);
    if (total + value > budget * 1.08) {
      if (tier === 0) continue;
      tier = 0;
      value = rng.int(tierVals[0][0], tierVals[0][1]);
      if (total + value > budget * 1.08) continue;
    }
    if (tier === 2) heavy++;
    total += value;
    used.add(sl.id);
    newItem(s, LOOT_TIER_TYPES[tier], { value, tier, name: rng.pick(LOOT_NAMES[tier]), p: [sl.x, 0, sl.z], rot: sl.rot ?? 0 });
  }
}

/** tool extras in loot slots nobody uses (ours or objectives' loot) */
function spawnExtras(crew: Crew, s: IxSlice): void {
  const L = crew.layout;
  s.extrasPending = 0;
  if (!L || L.kind !== 'facility') return;
  const objLoot = adapters.obj?.state ? safe('objectives.state', () => (adapters.obj!.state!(crew) as { loot?: { id: string; p?: Vec3 }[] } | null)?.loot) : undefined;
  const taken: [number, number][] = [];
  for (const l of objLoot ?? []) {
    const sl = s.layoutItems.get(l.id);
    if (sl) taken.push([sl.x, sl.z]);
    if (l.p) taken.push([l.p[0], l.p[2]]);
  }
  for (const it of Object.values(s.items)) if (it.p) taken.push([it.p[0], it.p[2]]);
  const rng = makeRng(`${L.seed}:${L.hash}`, 'interaction.extras');
  const shuffled = rng.shuffle(L.items.filter((i) => i.kind === 'loot' && !taken.some(([x, z]) => Math.hypot(x - i.x, z - i.z) < 0.6)));
  // special finds get the first pick of the deep slots, the tool extras take what is left
  const usedByFinds = spawnFinds(s, L, shuffled);
  const free = shuffled.filter((sl) => !usedByFinds.has(sl.id));
  const extras = (bal().worldExtras as Record<string, number> | undefined) ?? {};
  let k = 0;
  for (const [type, n] of Object.entries(extras)) {
    if (!ITEM_DEFS[type]) continue;
    for (let i = 0; i < n && k < free.length; i++, k++) {
      const sl = free[k];
      const extra: Partial<ItemState> = { p: [sl.x, 0, sl.z], rot: sl.rot ?? 0 };
      if (type === 'bottle') extra.count = 1;
      if (type === 'glowstick') extra.count = 3;
      const it = newItem(s, type, extra);
      markItem(s, it.id);
    }
  }
}

/** v1.1 special finds: rare, only in the deepest rooms (adrenaline syringe, lucky charm, cursed idol) */
function spawnFinds(s: IxSlice, L: LevelLayout, free: LayoutItem[]): Set<string> {
  const used = new Set<string>();
  if (ctx?.flags.specialFinds === false) return used;
  const finds = (bal().specialFinds as Record<string, number> | undefined) ?? { syringe: 0.45, charm: 0.3, 'loot.idol': 0.35 };
  const maxD = Math.max(0, ...L.spaces.map((sp) => sp.dist ?? 0));
  const minD = maxD * num('findsMinDistFrac', 0.6);
  const deep = free.filter((sl) => (L.spaces[sl.space]?.dist ?? 0) >= minD && L.spaces[sl.space]?.kind !== 'corridor').slice();
  const rng = makeRng(`${L.seed}:${L.hash}`, 'interaction.finds');
  rng.shuffle(deep);
  for (const [type, chance] of Object.entries(finds)) {
    if (!ITEM_DEFS[type] || !deep.length) continue;
    if (!rng.chance(Math.max(0, Math.min(1, Number(chance) || 0)))) continue;
    const sl = deep.shift()!;
    used.add(sl.id);
    const extra: Partial<ItemState> = { p: [sl.x, 0, sl.z], rot: sl.rot ?? 0 };
    if (type === 'loot.idol') {
      const [lo, hi] = (bal().idolValue as [number, number] | undefined) ?? [350, 500];
      Object.assign(extra, { value: rng.int(lo, hi), tier: 2, name: 'Cursed idol' });
    }
    const it = newItem(s, type, extra);
    markItem(s, it.id);
  }
  return used;
}

// ---------------------------------------------------------------- lights / power

/** objectives' public state, memoised per tick (state() may build a fresh object per call) */
const objMemo = new WeakMap<Crew, { tick: number; st: { power?: Record<number, boolean>; blackout?: boolean } | null | undefined }>();
function objState(crew: Crew): { power?: Record<number, boolean>; blackout?: boolean } | null | undefined {
  if (!adapters.obj?.state) return undefined;
  const m = objMemo.get(crew);
  if (m && m.tick === crew.tick) return m.st;
  const st = safe('objectives.state', () => adapters.obj!.state!(crew));
  objMemo.set(crew, { tick: crew.tick, st });
  return st;
}

function poweredZone(crew: Crew, s: IxSlice, zone: number): boolean {
  if (s.powerPush[zone] !== undefined) return s.powerPush[zone];
  const st = objState(crew);
  const v = st?.power?.[zone];
  if (typeof v === 'boolean') return v;
  const L = crew.layout;
  if (!L || L.kind !== 'facility') return true;
  return zone === 0;
}

function blackoutNow(crew: Crew, s: IxSlice): boolean {
  if (s.blackoutPush !== null) return s.blackoutPush;
  const st = objState(crew);
  return !!st?.blackout;
}

function computeLight(crew: Crew, s: IxSlice, space: number, blackout: boolean): boolean {
  const sp = crew.layout?.spaces[space];
  if (!sp) return false;
  if (s.broken.has(space)) return false;
  if (!s.switches[space]) return false;
  if (sp.kind === 'outside' || sp.type === 'van') return true; // lot lamps + van cab run off the van
  if (blackout) return false;
  return poweredZone(crew, s, sp.powerZone);
}

export function recomputeLights(crew: Crew, s: IxSlice, mark = true): void {
  const L = crew.layout;
  if (!L) return;
  const blackout = blackoutNow(crew, s);
  for (const sp of L.spaces) {
    const on = computeLight(crew, s, sp.id, blackout);
    if (s.lights[sp.id] !== on) {
      s.lights[sp.id] = on;
      if (mark) (s.patch.lights ??= {})[sp.id] = on;
    }
  }
}

export function spaceAtXZ(crew: Crew, x: number, z: number): number {
  const L = crew.layout;
  if (!L) return -1;
  const cx = Math.floor(x), cz = Math.floor(z);
  if (cx < 0 || cz < 0 || cx >= L.W || cz >= L.H) return -1;
  return L.owner[cz * L.W + cx] ?? -1;
}

/** Mannequin rule: is (x, z) lit by a room light, a glowstick within 2 m, or a flashlight cone (12 m, 25 deg, LOS)? */
export function litAtXZ(crew: Crew, x: number, z: number): boolean {
  const s = slice(crew);
  const sp = spaceAtXZ(crew, x, z);
  if (sp >= 0 && s.lights[sp]) return true;
  const gr = num('glowRadiusM', 2);
  for (const g of Object.values(s.glows)) if ((g[0] - x) ** 2 + (g[2] - z) ** 2 <= gr * gr) return true;
  // burning flares: a red area light (walls block it)
  const fr = num('flareLitRadiusM', 5);
  const tNow = now();
  for (const f of Object.values(flaresOf(s))) {
    if (f.until < tNow || (f.p[0] - x) ** 2 + (f.p[2] - z) ** 2 > fr * fr) continue;
    if (losClear(s, f.p[0], f.p[2], x, z)) return true;
  }
  const range0 = num('flashlightRangeM', 12);
  const cone0 = num('flashlightConeDeg', 25);
  for (const pl of crew.players.values()) {
    if (!pl.connected || !pl.alive || !pl.pose.light || s.hidden[pl.id]) continue;
    // Pro Flashlight (tier II): a longer, wider beam
    const pro = hasType(s, pl.id, 'flashlight_pro');
    const range = range0 * (pro ? num('proRangeMult', 1.3) : 1);
    const cosCone = Math.cos(((cone0 * (pro ? num('proConeMult', 1.25) : 1)) * Math.PI) / 180);
    const dx = x - pl.pose.p[0], dz = z - pl.pose.p[2];
    const d = Math.hypot(dx, dz);
    if (d > range) continue;
    if (d < 0.5) return true;
    const fx = Math.sin(pl.pose.yaw), fz = Math.cos(pl.pose.yaw);
    if ((dx * fx + dz * fz) / d < cosCone) continue;
    if (s.grid && !los(s.grid, pl.pose.p[0], pl.pose.p[2], x, z, doorOpenFn(s))) continue;
    return true;
  }
  return false;
}

// ---------------------------------------------------------------- geometry helpers

export const doorOpenFn = (s: IxSlice) => (id: number): boolean => s.doors[id]?.open ?? false;

function xz(pl: ServerPlayer): [number, number] {
  return [pl.pose.p[0], pl.pose.p[2]];
}

function losClear(s: IxSlice, ax: number, az: number, bx: number, bz: number): boolean {
  if (!s.grid) return true;
  if (Math.floor(ax) === Math.floor(bx) && Math.floor(az) === Math.floor(bz)) return true;
  return los(s.grid, ax, az, bx, bz, doorOpenFn(s));
}

function reach(): number {
  return PLAYER.interactRange + num('rangeSlackM', 0.5);
}

/** nearest point on the door segment, nudged 0.3 m towards (px, pz) */
function doorTarget(g: DoorGeom, px: number, pz: number): [number, number, number] {
  const vx = g.x1 - g.x0, vz = g.z1 - g.z0;
  const len2 = vx * vx + vz * vz || 1;
  let t = ((px - g.x0) * vx + (pz - g.z0) * vz) / len2;
  t = Math.max(0.05, Math.min(0.95, t));
  const qx = g.x0 + vx * t, qz = g.z0 + vz * t;
  const d = Math.hypot(px - qx, pz - qz);
  const nx = g.dir === 'v' ? Math.sign(px - qx) || 1 : 0;
  const nz = g.dir === 'h' ? Math.sign(pz - qz) || 1 : 0;
  return [qx + nx * 0.3, qz + nz * 0.3, d];
}

function canReach(s: IxSlice, pl: ServerPlayer, info: { p: Vec3; r?: number; kind: string; ref?: string | number }): string | null {
  const [px, pz] = xz(pl);
  if (info.kind === 'door') {
    const g = s.doorGeom.get(Number(info.ref));
    if (!g) return 'Nothing there';
    const [tx, tz, d] = doorTarget(g, px, pz);
    if (d > reach()) return 'Too far';
    if (!losClear(s, px, pz, tx, tz)) return "Can't reach that";
    return null;
  }
  const d = Math.hypot(info.p[0] - px, info.p[2] - pz);
  if (d > reach() + (info.r ?? 0.3)) return 'Too far';
  if (!losClear(s, px, pz, info.p[0], info.p[2])) return "Can't reach that";
  return null;
}

// ---------------------------------------------------------------- inventory

export function invOf(s: IxSlice, pid: string): (string | null)[] {
  let inv = s.inventories[pid];
  if (!inv) {
    inv = s.inventories[pid] = new Array<string | null>(INV_SLOTS).fill(null);
    s.active[pid] ??= 0;
    markInv(s, pid);
  }
  return inv;
}

export function itemsOfPid(s: IxSlice, pid: string): ItemState[] {
  return (s.inventories[pid] ?? []).filter((id): id is string => !!id && !!s.items[id]).map((id) => s.items[id]);
}

export function hasType(s: IxSlice, pid: string, type: string): boolean {
  return itemsOfPid(s, pid).some((it) => it.type === type || (type === 'loot' && !!itemDef(it.type).loot && it.type.startsWith('loot')));
}

function activeItem(s: IxSlice, pid: string): ItemState | null {
  const inv = invOf(s, pid);
  const id = inv[s.active[pid] ?? 0];
  return id ? (s.items[id] ?? null) : null;
}

function removeFromInv(s: IxSlice, itemId: string): void {
  const it = s.items[itemId];
  const holder = it?.holder;
  if (holder && s.inventories[holder]) {
    const inv = s.inventories[holder];
    const i = inv.indexOf(itemId);
    if (i >= 0) {
      inv[i] = null;
      markInv(s, holder);
    }
  }
  if (it) delete it.holder;
}

export function deleteItem(s: IxSlice, itemId: string): void {
  if (!s.items[itemId]) return;
  removeFromInv(s, itemId);
  delete s.items[itemId];
  markItem(s, itemId);
}

/** put an item into pid's inventory (active slot if free, else first free). false = full */
function putInInv(s: IxSlice, pid: string, it: ItemState): boolean {
  const inv = invOf(s, pid);
  const a = s.active[pid] ?? 0;
  const slot = inv[a] === null ? a : inv.indexOf(null);
  if (slot < 0) return false;
  inv[slot] = it.id;
  it.where = 'held';
  it.holder = pid;
  delete it.p;
  markInv(s, pid);
  markItem(s, it.id);
  return true;
}

/** floor point ~dist m in front of a player (falls back to the feet if a wall is in the way) */
function dropPoint(s: IxSlice, pl: ServerPlayer, dist = 0.6): Vec3 {
  const [px, pz] = xz(pl);
  const fx = Math.sin(pl.pose.yaw), fz = Math.cos(pl.pose.yaw);
  const tx = px + fx * dist, tz = pz + fz * dist;
  if (losClear(s, px, pz, tx, tz)) return [tx, 0, tz];
  return [px, 0, pz];
}

function dropToWorld(s: IxSlice, it: ItemState, p: Vec3): void {
  removeFromInv(s, it.id);
  it.where = 'world';
  it.p = [p[0], Math.max(0, p[1]), p[2]];
  markItem(s, it.id);
}

export function giveItemTo(crew: Crew, pid: string, type: string, extra: Partial<ItemState> = {}): ItemState | null {
  const s = slice(crew);
  const pl = crew.players.get(pid);
  if (!pl) return null;
  const pack = GEAR_PACKS[type];
  if (pack) {
    // a shop pack (meta hands out one unit per purchase): the real item, merged into a stack the player already has
    type = pack.type;
    if (pack.count && itemDef(type).stack) {
      const n = pack.count * Math.max(1, Math.round(Number(extra.count ?? 1)) || 1);
      const have = itemsOfPid(s, pid).find((x) => x.type === type);
      if (have) {
        have.count = (have.count ?? 1) + n;
        markItem(s, have.id);
        return have;
      }
      extra = { ...extra, count: n };
    }
  }
  const it = newItem(s, type, extra);
  if (!putInInv(s, pid, it)) {
    it.where = 'world';
    it.p = dropPoint(s, pl, 0.4);
    markItem(s, it.id);
  }
  return it;
}

export function spawnWorldItem(crew: Crew, type: string, p: Vec3, extra: Partial<ItemState> = {}): ItemState {
  const s = slice(crew);
  const it = newItem(s, type, { p: [p[0], Math.max(0, p[1]), p[2]], ...extra });
  markItem(s, it.id);
  return it;
}

// ---------------------------------------------------------------- doors

export function setDoor(crew: Crew, id: number, open: boolean, by: string | null, opts: { force?: boolean } = {}): boolean {
  const s = slice(crew);
  const st = s.doors[id];
  const g = s.doorGeom.get(id);
  if (!st || !g || g.kind === 'open' || g.kind === 'blocked') return false;
  if (st.open === open && !(open && st.locked)) return true;
  if (open && st.locked) {
    if (!opts.force && by !== null && g.kind === 'locked' && !hasKeycard(s, by, g.lock)) return false;
    st.locked = false;
  }
  st.open = open;
  markDoor(s, id);
  const info = s.ints[`door:${id}`];
  if (info) {
    info.prompt = doorPrompt(g.kind, open, st.locked);
    info.enabled = g.kind !== 'vault' || open;
    markInt(s, info.id);
  }
  const sec = g.kind === 'security' || g.kind === 'vault';
  fx(crew, sec ? 'security' : 'door', { p: [g.cx, 1.1, g.cz], door: id, open, pid: by ?? undefined });
  noise(crew, g.cx, g.cz, sec ? NOISE_M.securityDoor : NOISE_M.door, sec ? 'securityDoor' : 'door', by);
  for (const fn of doorFns) safe('onDoor', () => fn(crew, id, open, by));
  return true;
}

function hasKeycard(s: IxSlice, pid: string, lock: number): boolean {
  return itemsOfPid(s, pid).some((it) => it.type === 'keycard' && (it.lock ?? 1) === (lock || 1));
}

function handDoor(crew: Crew, s: IxSlice, pl: ServerPlayer, id: number, hold: boolean): IxResult {
  const st = s.doors[id];
  const g = s.doorGeom.get(id);
  if (!st || !g) return { ok: false, msg: 'Nothing there' };
  if (g.kind === 'vault') return { ok: false, msg: 'The vault opens from the keypad' };
  if (st.locked) {
    if (g.kind === 'locked' && hasKeycard(s, pl.id, g.lock)) {
      st.locked = false;
      markDoor(s, id);
      fx(crew, 'unlock', { p: [g.cx, 1.1, g.cz], door: id, pid: pl.id });
    } else {
      fx(crew, 'deny', { p: [g.cx, 1.1, g.cz], door: id, pid: pl.id });
      return { ok: false, msg: 'Locked: needs the keycard' };
    }
  }
  if (g.kind === 'security' && !hold) return { ok: false, msg: 'Hold E to force the security door' };
  const t = now();
  if (t - (s.lastHand[id] ?? 0) < num('handDoorCooldownMs', 350)) return { ok: false };
  s.lastHand[id] = t;
  setDoor(crew, id, !st.open, pl.id, { force: true });
  return { ok: true };
}

/** Console operator toggles a security door. */
export function consoleDoor(crew: Crew, pl: ServerPlayer, id: number, open?: boolean): IxResult & { open?: boolean; cooldownMs?: number } {
  const s = slice(crew);
  const st = s.doors[id];
  const g = s.doorGeom.get(id);
  if (!st || !g || g.kind !== 'security') return { ok: false, msg: 'Not a security door' };
  if (!atConsole(crew, s, pl)) return { ok: false, msg: 'Use the van console' };
  const t = now();
  if (st.cooldownUntil && t < st.cooldownUntil) return { ok: false, msg: 'Door motor cooling down', open: st.open, cooldownMs: Math.ceil(st.cooldownUntil - t) };
  const want = open ?? !st.open;
  st.cooldownUntil = t + num('consoleDoorCooldownMs', 5000);
  if (want !== st.open) setDoor(crew, id, want, pl.id, { force: true });
  else markDoor(s, id);
  return { ok: true, open: st.open, cooldownMs: num('consoleDoorCooldownMs', 5000) };
}

function atConsole(crew: Crew, s: IxSlice, pl: ServerPlayer): boolean {
  if (ctx?.env.dev && (pl.slices[TRACK] as { consoleAnywhere?: boolean } | undefined)?.consoleAnywhere) return true;
  const [px, pz] = xz(pl);
  const L = crew.layout;
  if (L?.van?.cab) {
    const c = L.van.cab;
    if (px >= c.x - 0.25 && px <= c.x + c.w + 0.25 && pz >= c.y - 0.25 && pz <= c.y + c.h + 0.25) return true;
  }
  const r = num('consoleRangeM', 4);
  for (const it of s.layoutItems.values()) if (it.kind === 'console' && Math.hypot(it.x - px, it.z - pz) <= r) return true;
  return false;
}

// ---------------------------------------------------------------- hiding

function lockerFront(s: IxSlice, lockerId: string): Vec3 | null {
  const it = s.layoutItems.get(lockerId);
  const info = s.ints[lockerId];
  if (!it && !info) return null;
  const x = it?.x ?? info!.p[0], z = it?.z ?? info!.p[2];
  const rot = it?.rot ?? 0;
  return [x + Math.sin(rot) * 0.62, 0, z + Math.cos(rot) * 0.62];
}

function hide(crew: Crew, s: IxSlice, pl: ServerPlayer, lockerId: string): IxResult {
  for (const [pid, l] of Object.entries(s.hidden)) if (l === lockerId && pid !== pl.id) return { ok: false, msg: 'Someone is already in there' };
  s.hidden[pl.id] = lockerId;
  markHidden(s, pl.id);
  const f = lockerFront(s, lockerId);
  if (f) {
    pl.pose.p = [f[0], 0, f[2]];
    pl.pose.stance = STANCE.hidden;
  }
  fx(crew, 'locker', { p: s.ints[lockerId]?.p, pid: pl.id, id: lockerId, open: true });
  return { ok: true };
}

export function unhidePid(crew: Crew, pid: string): boolean {
  const s = slice(crew);
  const lockerId = s.hidden[pid];
  if (!lockerId) return false;
  delete s.hidden[pid];
  markHidden(s, pid);
  const pl = crew.players.get(pid);
  if (pl && pl.pose.stance === STANCE.hidden) pl.pose.stance = STANCE.stand;
  fx(crew, 'locker', { p: s.ints[lockerId]?.p, pid, id: lockerId, open: false });
  return true;
}

// ---------------------------------------------------------------- switches

function toggleSwitch(crew: Crew, s: IxSlice, pl: ServerPlayer, info: InteractableInfo): IxResult {
  const space = Number(info.ref);
  const sp = crew.layout?.spaces[space];
  if (!sp) return { ok: false };
  fx(crew, 'switch', { p: info.p, pid: pl.id, id: info.id });
  if (s.broken.has(space)) return { ok: false, msg: 'Click. The fixture is dead' };
  const powered = sp.kind === 'outside' || sp.type === 'van' || (poweredZone(crew, s, sp.powerZone) && !blackoutNow(crew, s));
  if (!powered) return { ok: false, msg: 'Click. No power in this wing' };
  s.switches[space] = !s.switches[space];
  recomputeLights(crew, s);
  return { ok: true };
}

export function setSwitch(crew: Crew, space: number | 'all', on: boolean): void {
  const s = slice(crew);
  const L = crew.layout;
  if (!L) return;
  for (const sp of L.spaces) if (space === 'all' || sp.id === space) s.switches[sp.id] = on;
  recomputeLights(crew, s);
}

// ---------------------------------------------------------------- items: pickup / drop / act

/** stackable v1.1 gear merges into the stack you already carry when picked up */
const MERGE_ON_PICKUP = new Set(['flare', 'sensor']);

function pickup(crew: Crew, s: IxSlice, pl: ServerPlayer, it: ItemState): IxResult {
  if (it.where !== 'world') return { ok: false, msg: 'Gone' };
  if (MERGE_ON_PICKUP.has(it.type)) {
    const have = itemsOfPid(s, pl.id).find((x) => x.type === it.type);
    if (have) {
      have.count = (have.count ?? 1) + (it.count ?? 1);
      markItem(s, have.id);
      deleteItem(s, it.id);
      fx(crew, 'pickup', { p: [pl.pose.p[0], 1, pl.pose.p[2]], pid: pl.id, item: it.type, id: have.id });
      return { ok: true };
    }
  }
  if (it.armed) delete it.armed;
  if (!putInInv(s, pl.id, it)) return { ok: false, msg: 'Hands full (G to drop)' };
  fx(crew, 'pickup', { p: [pl.pose.p[0], 1, pl.pose.p[2]], pid: pl.id, item: it.type, id: it.id });
  return { ok: true };
}

export function dropActive(crew: Crew, pl: ServerPlayer, slot?: number): IxResult {
  const s = slice(crew);
  if (!pl.alive) return { ok: false };
  const inv = invOf(s, pl.id);
  const i = slot !== undefined && slot >= 0 && slot < INV_SLOTS ? slot : (s.active[pl.id] ?? 0);
  const id = inv[i];
  const it = id ? s.items[id] : undefined;
  if (!it) return { ok: false, msg: 'Nothing to drop' };
  const p = dropPoint(s, pl);
  dropToWorld(s, it, p);
  it.rot = pl.pose.yaw;
  fx(crew, 'drop', { p, pid: pl.id, item: it.type, id: it.id });
  return { ok: true };
}

export function selectSlot(crew: Crew, pl: ServerPlayer, slot: number): IxResult {
  const s = slice(crew);
  if (!Number.isInteger(slot) || slot < 0 || slot >= INV_SLOTS) return { ok: false };
  invOf(s, pl.id);
  if (s.active[pl.id] === slot) return { ok: true };
  s.active[pl.id] = slot;
  markInv(s, pl.id);
  return { ok: true };
}

function consumeOne(s: IxSlice, it: ItemState): void {
  const c = (it.count ?? 1) - 1;
  if (c <= 0) deleteItem(s, it.id);
  else {
    it.count = c;
    markItem(s, it.id);
  }
}

const norm3 = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};

function eyeOf(pl: ServerPlayer, eye?: Vec3): Vec3 {
  const base: Vec3 = [pl.pose.p[0], pl.pose.p[1] + (pl.pose.stance === STANCE.crouch ? PLAYER.crouchEye : PLAYER.eye), pl.pose.p[2]];
  if (eye && eye.every(Number.isFinite) && Math.hypot(eye[0] - base[0], eye[2] - base[2]) < 1.2 && Math.abs(eye[1] - base[1]) < 1.2) return eye;
  return base;
}

export function act(crew: Crew, pl: ServerPlayer, dirIn: Vec3, eyeIn?: Vec3): IxResult {
  const s = slice(crew);
  if (!pl.alive || s.dead.includes(pl.id)) return { ok: false };
  if (s.hidden[pl.id]) return { ok: false, msg: 'You are hiding' };
  const it = activeItem(s, pl.id);
  if (!it) return { ok: false };
  const dir = Array.isArray(dirIn) && dirIn.length === 3 && dirIn.every(Number.isFinite)
    ? norm3(dirIn) : norm3([Math.sin(pl.pose.yaw), 0, Math.cos(pl.pose.yaw)]);
  const eye = eyeOf(pl, eyeIn);
  const t = now();
  const d = itemDef(it.type);
  switch (d.use) {
    case 'throw': {
      if (t - (s.lastAct[pl.id] ?? 0) < 400) return { ok: false };
      s.lastAct[pl.id] = t;
      const sp = num('bottleSpeed', 11), up = num('bottleUp', 2.2);
      const p: Vec3 = [eye[0] + dir[0] * 0.35, eye[1] - 0.1, eye[2] + dir[2] * 0.35];
      if (!losClear(s, eye[0], eye[2], p[0], p[2])) { p[0] = eye[0]; p[2] = eye[2]; }
      s.thrown.push({ id: `thrown:${s.nextId++}`, p, v: [dir[0] * sp, dir[1] * sp + up, dir[2] * sp], t: 0, by: pl.id, item: it.type });
      consumeOne(s, it);
      fx(crew, 'throw', { p: eye, pid: pl.id, item: it.type });
      return { ok: true };
    }
    case 'swing': {
      if (t - (s.lastAct[pl.id] ?? 0) < num('crowbarCooldownMs', 650)) return { ok: false };
      s.lastAct[pl.id] = t;
      fx(crew, 'swing', { p: eye, pid: pl.id, item: it.type });
      let hit = false;
      for (const fn of meleeFns) if (safe('onMelee', () => fn(crew, pl.id, eye, dir)) === true) hit = true;
      if (hit) {
        const hp: Vec3 = [eye[0] + dir[0] * 1.2, eye[1] + dir[1] * 1.2, eye[2] + dir[2] * 1.2];
        fx(crew, 'hit', { p: hp, pid: pl.id });
        noise(crew, hp[0], hp[2], NOISE_M.crowbar, 'crowbar', pl.id);
      }
      return { ok: true, msg: hit ? 'Hit!' : undefined };
    }
    case 'glow': {
      if (t - (s.lastAct[pl.id] ?? 0) < 300) return { ok: false };
      s.lastAct[pl.id] = t;
      const p = dropPoint(s, pl, 0.5);
      const id = `glow${s.nextId++}`;
      s.glows[id] = [p[0], 0.03, p[2]];
      markGlow(s, id);
      consumeOne(s, it);
      fx(crew, 'glow', { p, pid: pl.id, id });
      return { ok: true };
    }
    case 'revive': {
      const target = nearestRevivableBody(s, pl);
      if (!target) return { ok: false, msg: 'No one to revive here' };
      return medkitRevive(crew, s, pl, target);
    }
    case 'horn': {
      if (t - (s.lastAct[pl.id] ?? 0) < num('airhornCooldownMs', 2500)) return { ok: false };
      s.lastAct[pl.id] = t;
      fx(crew, 'horn', { p: eye, pid: pl.id });
      noise(crew, pl.pose.p[0], pl.pose.p[2], NOISE_M.airhorn, 'airhorn', pl.id);
      return { ok: true };
    }
    case 'flare': {
      if (t - (s.lastAct[pl.id] ?? 0) < 500) return { ok: false };
      s.lastAct[pl.id] = t;
      const sp = num('flareSpeed', 9), up = num('flareUp', 2.4);
      const p: Vec3 = [eye[0] + dir[0] * 0.35, eye[1] - 0.1, eye[2] + dir[2] * 0.35];
      if (!losClear(s, eye[0], eye[2], p[0], p[2])) { p[0] = eye[0]; p[2] = eye[2]; }
      s.thrown.push({ id: `thrown:flare:${s.nextId++}`, p, v: [dir[0] * sp, dir[1] * sp + up, dir[2] * sp], t: 0, by: pl.id, item: 'flare' });
      consumeOne(s, it);
      fx(crew, 'throw', { p: eye, pid: pl.id, item: 'flare' });
      return { ok: true };
    }
    case 'sensor': {
      if (t - (s.lastAct[pl.id] ?? 0) < 400) return { ok: false };
      s.lastAct[pl.id] = t;
      const p = dropPoint(s, pl, 0.7);
      const placed = newItem(s, 'sensor', { p: [p[0], 0, p[2]], rot: pl.pose.yaw, count: 1, armed: true });
      markItem(s, placed.id);
      consumeOne(s, it);
      fx(crew, 'sensor', { p, pid: pl.id, id: placed.id });
      return { ok: true, msg: `Motion sensor armed: the van console sees movement within ${num('sensorRangeM', 6)} m` };
    }
    case 'inject': {
      if (t - (s.lastAct[pl.id] ?? 0) < 400) return { ok: false };
      s.lastAct[pl.id] = t;
      consumeOne(s, it);
      // stamina is client-side: the injector's client turns stamina drain off for adrenalineSec (fx 'inject')
      fx(crew, 'inject', { p: eye, pid: pl.id, id: it.id });
      return { ok: true, msg: `ADRENALINE: ${num('adrenalineSec', 15)} s of sprint without getting tired` };
    }
    case 'radio':
      return { ok: false, msg: 'Hold Q to talk on the walkie' };
    default:
      return { ok: false };
  }
}

function tickThrown(crew: Crew, s: IxSlice, dt: number): void {
  if (!s.thrown.length) return;
  const g = num('gravity', 9.8);
  const maxT = num('bottleMaxSec', 3);
  const ceil = (crew.layout?.wallH ?? WORLD.wallH) - 0.12;
  const keep: Thrown[] = [];
  for (const th of s.thrown) {
    th.t += dt;
    th.v[1] -= g * dt;
    const n: Vec3 = [th.p[0] + th.v[0] * dt, th.p[1] + th.v[1] * dt, th.p[2] + th.v[2] * dt];
    let impact: Vec3 | null = null;
    if (!losClear(s, th.p[0], th.p[2], n[0], n[2])) impact = [th.p[0], Math.max(0.05, th.p[1]), th.p[2]];
    else if (n[1] <= 0.05) impact = [n[0], 0.05, n[2]];
    else {
      const sp = spaceAtXZ(crew, n[0], n[2]);
      const open = sp >= 0 && !!crew.layout?.spaces[sp]?.open;
      if (!open && n[1] >= ceil) {
        n[1] = ceil;
        th.v[1] = -Math.abs(th.v[1]) * 0.3;
      }
      th.p = n;
      if (th.t >= maxT) impact = [n[0], Math.max(0.05, n[1]), n[2]];
    }
    if (impact && th.item === 'flare') {
      // a flare lands and burns: red area light for flareBurnSec (litAt), a faint hiss. Off a wall it drops back
      // 0.35 m towards the thrower (never inside the wall's thickness, where neither the light nor the glow would show)
      const hv = Math.hypot(th.v[0], th.v[2]);
      if (impact[1] > 0.05 && hv > 0.01) {
        const bx = impact[0] - (th.v[0] / hv) * 0.35, bz = impact[2] - (th.v[2] / hv) * 0.35;
        if (losClear(s, impact[0], impact[2], bx, bz)) { impact[0] = bx; impact[2] = bz; }
      }
      const id = `flare${s.nextId++}`;
      flaresOf(s)[id] = { p: [impact[0], 0.04, impact[2]], until: now() + num('flareBurnSec', 60) * 1000, by: th.by };
      markFlare(s, id);
      fx(crew, 'flare', { p: [impact[0], 0.1, impact[2]], pid: th.by, id });
      noise(crew, impact[0], impact[2], num('flareNoiseM', 3), 'flare', th.by);
    } else if (impact) {
      fx(crew, 'smash', { p: impact, pid: th.by, item: th.item, id: th.id });
      noise(crew, impact[0], impact[2], NOISE_M.bottle, 'bottle', th.by);
    } else keep.push(th);
  }
  s.thrown = keep;
}

// ---------------------------------------------------------------- death / revive

function nearestRevivableBody(s: IxSlice, pl: ServerPlayer): BodyState | null {
  const [px, pz] = xz(pl);
  const t = now();
  let best: BodyState | null = null, bd = Infinity;
  for (const b of Object.values(s.bodies)) {
    if (b.pid === pl.id || t > b.reviveBy) continue;
    const d = Math.hypot(b.p[0] - px, b.p[2] - pz);
    if (d <= reach() + 0.6 && d < bd && losClear(s, px, pz, b.p[0], b.p[2])) { best = b; bd = d; }
  }
  return best;
}

function medkitRevive(crew: Crew, s: IxSlice, pl: ServerPlayer, body: BodyState): IxResult {
  if (now() > body.reviveBy) return { ok: false, msg: 'Too late. Bring their badge to the van' };
  const kit = itemsOfPid(s, pl.id).find((it) => it.type === 'medkit');
  if (!kit) return { ok: false, msg: 'Needs a medkit' };
  deleteItem(s, kit.id);
  fx(crew, 'medkit', { p: body.p, pid: pl.id, id: body.pid });
  reviveSelf(crew, body.pid, body.p, { by: pl.id, how: 'medkit' });
  return { ok: true };
}

export function killPid(crew: Crew, pid: string, cause: DeathCause): boolean {
  const s = slice(crew);
  const pl = crew.players.get(pid);
  if (!pl || !pl.alive || s.dead.includes(pid)) return false;
  const c: DeathCause = {
    killer: String(cause?.killer ?? 'SOMETHING').slice(0, 40),
    reason: String(cause?.reason ?? 'got you').slice(0, 120),
    ...(cause?.detail ? { detail: String(cause.detail).slice(0, 160) } : {}),
  };
  if (s.hidden[pid]) unhidePid(crew, pid);
  const t = now();
  const p: Vec3 = [pl.pose.p[0], 0, pl.pose.p[2]];
  pl.alive = false;
  // snapshots carry the corpse right away (the victim's client may not send another pose for a while)
  pl.pose = { ...pl.pose, stance: STANCE.dead, anim: (ANIM as Record<string, number>).death ?? pl.pose.anim, light: 0 };
  s.dead.push(pid);
  markDead(s);
  s.hp[pid] = 0;
  markHp(s, pid);
  // drop the inventory around the body
  const held = itemsOfPid(s, pid);
  held.forEach((it, i) => {
    const a = (i / Math.max(1, held.length)) * Math.PI * 2 + 0.6;
    let q: Vec3 = [p[0] + Math.sin(a) * 0.5, 0, p[2] + Math.cos(a) * 0.5];
    if (!losClear(s, p[0], p[2], q[0], q[2])) q = [p[0], 0, p[2]];
    dropToWorld(s, it, q);
  });
  // badge
  for (const it of Object.values(s.items)) if (it.type === 'badge' && it.owner === pid) deleteItem(s, it.id);
  const badge = newItem(s, 'badge', { owner: pid, name: `${pl.name}'s badge`, p: [p[0] - 0.25, 0, p[2] + 0.2], rot: pl.pose.yaw });
  markItem(s, badge.id);
  const body: BodyState = { pid, name: pl.name, p, yaw: pl.pose.yaw, at: t, reviveBy: t + num('medkitWindowSec', 30) * 1000, cause: c };
  s.bodies[pid] = body;
  markBody(s, pid);
  s.ints[`body:${pid}`] = { id: `body:${pid}`, kind: 'body', p: [p[0], 0.3, p[2]], prompt: `Revive ${pl.name} (medkit)`, enabled: true, r: INTERACT_RADIUS.body, ref: pid };
  markInt(s, `body:${pid}`);
  s.deaths.push({ pid, name: pl.name, cause: c, at: t, p });
  flush(crew);
  ctx?.emit(crew, 'interaction.death', { pid, name: pl.name, cause: c, p });
  ctx?.crews.broadcastRoster(crew);
  ctx?.log(TRACK).info(`crew ${crew.code}: ${pl.name} killed by ${c.killer}: ${c.reason}`);
  for (const fn of deathFns) safe('onDeath', () => fn(crew, pid, c, p));
  return true;
}

function vanSpawn(crew: Crew, pid: string): { p: Vec3; yaw: number } {
  const L = crew.layout;
  if (!L) return { p: [0, 0, 0], yaw: 0 };
  const spawns = L.items.filter((i) => i.kind === 'spawn_player');
  if (spawns.length) {
    const idx = Math.max(0, [...crew.players.keys()].indexOf(pid)) % spawns.length;
    const sp = spawns[idx];
    return { p: [sp.x, 0, sp.z], yaw: sp.rot ?? 0 };
  }
  return { p: [L.van.x, 0, L.van.z + 2.5], yaw: L.van.yaw };
}

export function reviveSelf(crew: Crew, pid: string, at?: Vec3 | null, opts: { by?: string | null; how?: 'medkit' | 'badge' | 'api'; hp?: number; silent?: boolean } = {}): boolean {
  const s = slice(crew);
  const pl = crew.players.get(pid);
  if (!pl || (!s.dead.includes(pid) && pl.alive)) return false;
  const body = s.bodies[pid];
  let p: Vec3, yaw: number;
  if (at && at.every(Number.isFinite)) { p = [at[0], 0, at[2]]; yaw = pl.pose.yaw; }
  else if (opts.how === 'badge' || !body) ({ p, yaw } = vanSpawn(crew, pid));
  else { p = body.p; yaw = body.yaw; }
  pl.alive = true;
  s.dead = s.dead.filter((x) => x !== pid);
  markDead(s);
  if (s.bodies[pid]) { delete s.bodies[pid]; markBody(s, pid); }
  if (s.ints[`body:${pid}`]) { delete s.ints[`body:${pid}`]; markInt(s, `body:${pid}`); }
  if (s.respawns[pid] !== undefined) { delete s.respawns[pid]; markRespawn(s, pid); }
  for (const it of Object.values(s.items)) if (it.type === 'badge' && it.owner === pid) deleteItem(s, it.id);
  s.hp[pid] = opts.hp ?? num('reviveHp', 50);
  markHp(s, pid);
  if (!opts.silent) {
    pl.pose.p = [p[0], 0, p[2]];
    pl.pose.yaw = yaw;
    pl.pose.stance = STANCE.stand;
    pl.poseAt = performance.now();
  }
  const rec = [...s.deaths].reverse().find((d) => d.pid === pid && !d.revived);
  const how = opts.how ?? 'api';
  if (rec) rec.revived = how;
  flush(crew);
  if (!opts.silent) {
    ctx?.emit(crew, 'interaction.revive', { pid, by: opts.by ?? null, how, p, yaw, hp: s.hp[pid] });
    ctx?.crews.broadcastRoster(crew);
    for (const fn of reviveFns) safe('onRevive', () => fn(crew, pid, how, opts.by ?? null));
  }
  return true;
}

// ---------------------------------------------------------------- deposit (badges here, loot via handlers / fallback)

export function depositLootOf(crew: Crew, pid: string): ItemState[] {
  const s = slice(crew);
  const out: ItemState[] = [];
  // Lucky charm: loot deposited by the charm's carrier counts +charmBonus (once per item)
  const lucky = hasType(s, pid, 'charm');
  let bonus = 0;
  for (const it of itemsOfPid(s, pid)) {
    if (!itemDef(it.type).loot) continue;
    if (lucky && !it.bonus && (it.value ?? 0) > 0) {
      const b = Math.max(1, Math.round(it.value * num('charmBonus', 0.1)));
      it.bonus = b;
      it.value += b;
      bonus += b;
    }
    removeFromInv(s, it.id);
    it.where = 'van';
    delete it.p;
    markItem(s, it.id);
    out.push(it);
  }
  if (out.length) {
    const pl = crew.players.get(pid);
    fx(crew, 'deposit', { p: pl ? [pl.pose.p[0], 1, pl.pose.p[2]] : undefined, pid });
    if (bonus > 0) fx(crew, 'lucky', { p: pl ? [pl.pose.p[0], 1.2, pl.pose.p[2]] : undefined, pid, item: String(bonus) });
    for (const fn of depositFns) safe('onDeposit', () => fn(crew, pid, out));
  }
  return out;
}

function deposit(crew: Crew, s: IxSlice, pl: ServerPlayer, intId: string): IxResult {
  let did = false;
  const t = now();
  for (const it of itemsOfPid(s, pl.id)) {
    if (it.type !== 'badge' || !it.owner) continue;
    removeFromInv(s, it.id);
    it.where = 'van';
    delete it.p;
    markItem(s, it.id);
    if (s.dead.includes(it.owner)) {
      s.respawns[it.owner] = t + num('badgeReviveSec', 20) * 1000;
      markRespawn(s, it.owner);
    }
    did = true;
  }
  if (did) fx(crew, 'deposit', { p: [pl.pose.p[0], 1, pl.pose.p[2]], pid: pl.id });
  const r = runHandlers(crew, pl, 'deposit', intId);
  if (r && r.ok) return r;
  const loot = depositLootOf(crew, pl.id);
  if (loot.length) {
    const v = loot.reduce((a, it) => a + (it.value ?? 0), 0);
    return { ok: true, msg: `Deposited ${loot.length} item${loot.length > 1 ? 's' : ''} ($${v})` };
  }
  if (did) return { ok: true, msg: 'Badge filed: they respawn at the van shortly' };
  return r ?? { ok: false, msg: 'Nothing to deposit' };
}

// ---------------------------------------------------------------- dispatch

function runHandlers(crew: Crew, pl: ServerPlayer, kind: string, id: string): IxResult | null {
  const list = interactFns.get(kind);
  if (!list?.length) return null;
  let last: IxResult = { ok: false };
  for (const fn of list) {
    const r = safe(`onInteract(${kind})`, () => fn(crew, pl, id));
    if (r === true) return { ok: true };
    if (typeof r === 'string') last = { ok: false, msg: r };
    else if (r && typeof r === 'object') {
      if (r.ok) return { ok: true, msg: r.msg };
      last = { ok: false, msg: r.msg };
    }
  }
  return last;
}

export function use(crew: Crew, pl: ServerPlayer, id: string, hold: boolean): IxResult {
  const s = slice(crew);
  if (!pl.alive || s.dead.includes(pl.id)) return { ok: false, msg: 'You are dead' };
  if (s.hidden[pl.id]) {
    unhidePid(crew, pl.id);
    return { ok: true };
  }
  const info = s.ints[String(id)];
  const it = info ? undefined : s.items[String(id)];
  if (!info && !(it && it.where === 'world' && it.p)) return { ok: false, msg: 'Nothing there' };
  const target = info ?? { p: it!.p as Vec3, kind: 'item', r: INTERACT_RADIUS.item };
  const why = canReach(s, pl, target);
  if (why) return { ok: false, msg: why };
  if (it) return pickup(crew, s, pl, it);
  const inf = info!;
  if (inf.holdMs && !hold && inf.kind !== 'door') return { ok: false, msg: 'Hold E' };
  switch (inf.kind) {
    case 'door':
      return handDoor(crew, s, pl, Number(inf.ref), hold);
    case 'locker':
      return hide(crew, s, pl, inf.id);
    case 'switch':
      return toggleSwitch(crew, s, pl, inf);
    case 'body': {
      const b = s.bodies[String(inf.ref)];
      if (!b) return { ok: false };
      return medkitRevive(crew, s, pl, b);
    }
    case 'deposit':
      return deposit(crew, s, pl, inf.id);
    default: {
      if (!inf.enabled) return { ok: false, msg: inf.prompt };
      return runHandlers(crew, pl, inf.kind, inf.id) ?? { ok: false, msg: 'Nothing happens' };
    }
  }
}

// ---------------------------------------------------------------- registry API for other tracks

export function upsertInteractables(crew: Crew, list: InteractableInfo[]): void {
  const s = slice(crew);
  for (const raw of list ?? []) {
    if (!raw || typeof raw.id !== 'string') continue;
    const prev = s.ints[raw.id];
    const p = Array.isArray(raw.p) ? [Number(raw.p[0]) || 0, Number(raw.p[1]) || 0, Number(raw.p[2]) || 0] as Vec3 : prev?.p ?? [0, 0, 0] as Vec3;
    s.ints[raw.id] = { ...prev, ...raw, p, enabled: raw.enabled ?? prev?.enabled ?? true, prompt: raw.prompt ?? prev?.prompt ?? raw.kind };
    markInt(s, raw.id);
  }
}

export function patchInteractable(crew: Crew, id: string, patch: Partial<InteractableInfo>): boolean {
  const s = slice(crew);
  const cur = s.ints[id];
  if (!cur) return false;
  s.ints[id] = { ...cur, ...patch, id };
  markInt(s, id);
  return true;
}

export function dropInteractable(crew: Crew, id: string): void {
  const s = slice(crew);
  if (!s.ints[id]) return;
  delete s.ints[id];
  markInt(s, id);
}

// ---------------------------------------------------------------- lifecycle hooks

/** held item types that survive the end of a contract (bought / company gear; matches meta's GEAR_TYPES) */
const CARRY_OVER_TYPES = new Set(['walkie', 'crowbar', 'bottle', 'glowstick', 'medkit', 'flashlight_pro', 'flare', 'sensor', 'syringe', 'charm']);

/** contract ended / phase left 'contract': everyone alive again, bodies/badges/respawns/glows gone, loot left behind */
export function endContract(crew: Crew, s: IxSlice): void {
  for (const pid of [...s.dead]) reviveSelf(crew, pid, null, { how: 'api', hp: 100, silent: true });
  for (const pl of crew.players.values()) if (!pl.alive) pl.alive = true;
  for (const pid of Object.keys(s.hidden)) unhidePid(crew, pid);
  for (const it of Object.values(s.items)) {
    // only company gear leaves a site in someone's pockets: keycards, badges, salvage, airhorns etc. stay behind
    if (it.type === 'badge' || it.where === 'van' || (it.where === 'held' && !CARRY_OVER_TYPES.has(it.type))) deleteItem(s, it.id);
  }
  for (const pid of Object.keys(s.hp)) { s.hp[pid] = 100; markHp(s, pid); }
  for (const pid of Object.keys(s.respawns)) { delete s.respawns[pid]; markRespawn(s, pid); }
  s.deaths.length = 0;
  ctx?.crews.broadcastRoster(crew);
}

export function onPhase(crew: Crew, from: string, to: string): void {
  const before = (crew.slices[TRACK] as IxSlice | undefined)?.layoutKey ?? null;
  const s = slice(crew); // rebuilds on a layout change (patch.reset)
  const relayout = before !== s.layoutKey;
  // leaving the contract, or a new facility while still in 'contract' (dbg restart): nobody stays dead
  if (from === 'contract' && (to !== 'contract' || relayout)) endContract(crew, s);
  if (to === 'contract' && !s.walkiesGiven && !adapters.meta) {
    // fallback while meta (d) is absent: the crew gets its 2 company walkies on the first contract
    s.walkiesGiven = true;
    let n = num('companyWalkies', 2);
    for (const pl of crew.players.values()) {
      if (n <= 0) break;
      if (!pl.connected || hasType(s, pl.id, 'walkie')) continue;
      giveItemTo(crew, pl.id, 'walkie', { name: 'Company walkie' });
      n--;
    }
  }
  // the 'phase' event sent right after this hook carries the full InteractionState: drop the pending patch
  s.patch = {};
}

export function onJoin(crew: Crew, pl: ServerPlayer): void {
  const s = slice(crew);
  invOf(s, pl.id);
  if (s.hp[pl.id] === undefined) { s.hp[pl.id] = pl.alive ? 100 : 0; markHp(s, pl.id); }
  if (s.dead.includes(pl.id)) pl.alive = false;
}

export function onLeaveFinal(crew: Crew, pl: ServerPlayer): void {
  const s = slice(crew);
  const items = itemsOfPid(s, pl.id);
  for (const it of items) {
    if (crew.phase === 'contract' && crew.layout) dropToWorld(s, it, [pl.pose.p[0], 0, pl.pose.p[2]]);
    else deleteItem(s, it.id);
  }
  delete s.inventories[pl.id];
  delete s.active[pl.id];
  markInv(s, pl.id);
  if (s.hidden[pl.id]) unhidePid(crew, pl.id);
  if (s.dead.includes(pl.id)) {
    s.dead = s.dead.filter((x) => x !== pl.id);
    markDead(s);
  }
  if (s.bodies[pl.id]) { delete s.bodies[pl.id]; markBody(s, pl.id); }
  if (s.ints[`body:${pl.id}`]) { delete s.ints[`body:${pl.id}`]; markInt(s, `body:${pl.id}`); }
  for (const it of Object.values(s.items)) if (it.type === 'badge' && it.owner === pl.id) deleteItem(s, it.id);
  delete s.hp[pl.id];
  markHp(s, pl.id);
  flush(crew);
}

/** pose hook: hidden players are pinned in front of their locker; dead players report stance dead */
export function onPose(crew: Crew, pl: ServerPlayer, pose: { p: Vec3; stance: number }): void {
  const s = crew.slices[TRACK] as IxSlice | undefined;
  if (!s) return;
  const l = s.hidden[pl.id];
  if (l) {
    const f = lockerFront(s, l);
    if (f) pose.p = [f[0], pose.p[1], f[2]];
    pose.stance = STANCE.hidden;
  } else if (!pl.alive || s.dead.includes(pl.id)) pose.stance = STANCE.dead;
}

export function tick(crew: Crew, dt: number): void {
  const s = slice(crew);
  s.tickN++;
  if (s.extrasPending) {
    const objReady = !hasHandler('loot') || !!(adapters.obj?.state && (safe('objectives.state', () => adapters.obj!.state!(crew)) as { loot?: unknown[] } | null | undefined)?.loot?.length);
    if (objReady || ++s.extrasPending > 45) spawnExtras(crew, s);
  }
  tickThrown(crew, s, dt);
  const t = now();
  for (const [pid, at] of Object.entries(s.respawns)) {
    if (t >= at) {
      delete s.respawns[pid];
      markRespawn(s, pid);
      reviveSelf(crew, pid, null, { how: 'badge', by: null });
    }
  }
  for (const b of Object.values(s.bodies)) {
    const info = s.ints[`body:${b.pid}`];
    if (info && info.enabled && t > b.reviveBy) {
      info.enabled = false;
      info.prompt = `${b.name}'s body (take the badge to the van)`;
      markInt(s, info.id);
    }
  }
  if (s.tickN % Math.max(1, num('lightsRecomputeTicks', 6)) === 0) recomputeLights(crew, s);
  for (const [id, f] of Object.entries(flaresOf(s))) if (t >= f.until) { delete flaresOf(s)[id]; markFlare(s, id); }
  if (s.tickN % 5 === 0) tickIdol(crew, s, t);
  flush(crew);
}

/** Cursed idol: while a living player carries it in a contract it whispers every few seconds (a noise at the carrier:
 *  the Hound comes to investigate, the Listener learns where they are); every Nth whisper is a wail heard much further. */
function tickIdol(crew: Crew, s: IxSlice, t: number): void {
  if (crew.phase !== 'contract' || crew.layout?.kind !== 'facility') return;
  const rng = (s.rng ??= makeRng('idol', 'interaction.gear'));
  const [lo, hi] = (bal().idolWhisperSec as [number, number] | undefined) ?? [6, 9];
  const delay = () => (lo + rng.next() * Math.max(0, hi - lo)) * 1000;
  for (const pl of crew.players.values()) {
    const carrying = pl.connected && pl.alive && !s.dead.includes(pl.id) && hasType(s, pl.id, 'loot.idol');
    if (!carrying) { delete s.idolNext[pl.id]; continue; }
    const next = s.idolNext[pl.id];
    if (next === undefined) { s.idolNext[pl.id] = t + Math.min(2500, delay()); continue; }
    if (t < next) continue;
    s.idolN++;
    const wail = s.idolN % Math.max(1, Math.round(num('idolWailEvery', 4))) === 0;
    const r = wail ? num('idolWailRadiusM', 22) : num('idolWhisperRadiusM', 10);
    noise(crew, pl.pose.p[0], pl.pose.p[2], r, wail ? 'idolWail' : 'idolWhisper', pl.id);
    fx(crew, 'whisper', { p: [pl.pose.p[0], 1.3, pl.pose.p[2]], pid: pl.id, open: wail });
    s.idolNext[pl.id] = t + delay();
  }
}

export function thrownDyn(crew: Crew): { id: string; p: Vec3; yaw: number }[] {
  const s = crew.slices[TRACK] as IxSlice | undefined;
  if (!s?.thrown.length) return [];
  return s.thrown.map((th) => ({ id: th.id, p: [th.p[0], th.p[1], th.p[2]] as Vec3, yaw: th.t * 14 }));
}

export function setPowerPush(crew: Crew, zone: number, on: boolean): void {
  const s = slice(crew);
  s.powerPush[zone] = on;
  recomputeLights(crew, s);
}

export function setBlackoutPush(crew: Crew, on: boolean): void {
  const s = slice(crew);
  s.blackoutPush = on;
  recomputeLights(crew, s);
}

export function doorPromptFor(kind: string, open: boolean, locked: boolean): string {
  return doorPrompt(kind, open, locked);
}

export type { DoorState };
