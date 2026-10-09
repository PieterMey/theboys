// Owner: track (b) Interaction. Per-crew interaction engine: interactable registry, doors, items + inventories,
// throws, melee, glowsticks, hiding, light switches, death / bodies / badges / revive. All state lives in
// crew.slices.interaction (an InteractionState plus private fields), so ① Net can read slices.interaction.doors[id].open.
// v1.2 (G3): server-timed hold-E ("ease": quiet doors and drawers, lockpicks, security-door holds), openable containers
// with server-private contents, crafting materials in a per-player salvage pouch (deposited into the van stash), new
// gear (battery, lockpicks, master keycard, overshoes, night vision, flashbulb, curio), the item event bus
// (onItemEvent) and the van upgrades' server effects.
// v1.3 (F3, flags noiseLure / fieldReceiver, missing = off): the noise lure (thrown with a fuse, 3 rattles over 8 s that
// monsters hear 12 m off) and the field receiver (one charge = a 6 s listen; with a closed door: the next room).
import type { Crew, ServerContext, ServerPlayer } from '../core/types.ts';
import type { LayoutDoor, LayoutItem, LevelLayout } from '@dead-air/shared/layout.ts';
import type { InteractableInfo, ItemDef } from '@dead-air/shared/interactables.ts';
import { GEAR_PACKS, INTERACT_RADIUS, INV_SLOTS, ITEM_DEFS, LOOT_NAMES, LOOT_TIER_TYPES, itemDef, itemLabel } from '@dead-air/shared/interactables.ts';
import type {
  BodyState, ContainerState, DeathCause, DoorState, FlashState, InteractionPatch, InteractionState, IxFxKind, IxResult, ItemEvent, ItemState,
} from '@dead-air/shared/messages/interaction.ts';
import { GEAR_V12, PAGE_TYPE, POOL_STACK, POOL_TYPES, POUCH_TYPE, isMaterial, v12Id } from '@dead-air/shared/catalog.ts';
import { containersOf } from '@dead-air/shared/procgen/containers.ts';
import type { ContainerInfo } from '@dead-air/shared/procgen/containers.ts';
import { stealthStance } from '../players/api.ts';
import { CONTAINER_LOOT_DEFAULT, MATERIALS_DEFAULT, planFinds, planMaterials, rollContainers } from './spawns.ts';
import type { ContainerLootCfg, MaterialsCfg, SpawnSpec } from './spawns.ts';
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

export interface Thrown {
  id: string; p: Vec3; v: Vec3; t: number; by: string; item: string;
  /** v1.3 noise lure: seconds from landing to the first rattle */
  fuse?: number;
}

/** v1.3 F3: an armed noise lure lying in the world (keyed by its world item id) */
export interface LureRun {
  id: string;
  /** the thrower */
  by: string;
  /** server ms of the next rattle */
  at: number;
  /** rattles done */
  n: number;
}

/** v1.3 F3: what an 'interaction.act' with the field receiver grants the listener (client: the 6 s listen) */
export interface ListenGrant {
  ms: number;
  /** server ms the listen ends */
  until: number;
  /** ear to a closed door: its id and the space behind it */
  door?: number;
  space?: number;
}

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
  // ---- v1.2 (private: never in publicState)
  /** pid -> the server-timed hold-E in progress (quiet ease, lockpick, security-door force, master-keycard ease) */
  easing: Record<string, EaseRun>;
  /** pid -> server ms of the last ease start (anti-spam) */
  lastEase: Record<string, number>;
  /** container id (host prop id) -> layout info */
  containerInfo: Map<string, ContainerInfo>;
  /** container id -> contents (rolled once per layout; spawned as world items on opening) */
  contents: Map<string, SpawnSpec[]>;
  /** tapped containers: their contents appear once the drawer has slid open */
  pendingSpawns: { at: number; cid: string; by: string }[];
  /** materials deposited at the van this contract (MaterialType -> units) */
  vanMats: Record<string, number>;
  /** item ids that were in someone's inventory this contract (ItemEvent.fresh) */
  heldOnce: Set<string>;
  /** badge owner pid -> hp + filer of the scheduled badge respawn (stretcher upgrade) */
  respawnInfo: Record<string, { hp: number; by: string | null }>;
  /** dev-only test double for containersOf (dbg.interaction.containers) */
  containerOverride: ContainerInfo[] | null;
  // ---- v1.3 F3 (private)
  /** armed noise lures in the world: world item id -> its rattle schedule */
  lures: Map<string, LureRun>;
  /** pid -> server ms their field-receiver listen ends */
  listening: Record<string, number>;
}

/** a server-timed hold-E (v1.2): commits at t0 + ms unless cancelled */
export interface EaseRun {
  /** interactable id ('door:12', 'cont:prop:41') */
  id: string;
  target: 'door' | 'container';
  /** door id / container id */
  ref: number | string;
  /** soft = quiet ease, pick = lockpick (loud, unlocks only), force = security-door hold (loud),
   *  key = master keycard on a locked door (one charge, then a quiet open) */
  mode: 'soft' | 'pick' | 'force' | 'key';
  to: boolean;
  t0: number;
  ms: number;
}

// ---------------------------------------------------------------- module state (bound at install)

let ctx: ServerContext | null = null;
const interactFns = new Map<string, InteractFn[]>();
const deathFns: DeathFn[] = [];
const reviveFns: ReviveFn[] = [];
const meleeFns: MeleeFn[] = [];
const doorFns: DoorFn[] = [];
const depositFns: DepositFn[] = [];
/** v1.2 item event bus (api.onItemEvent) */
const itemEventFns = new Set<(crew: Crew, e: ItemEvent) => void>();

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
export function addItemEventFn(fn: (crew: Crew, e: ItemEvent) => void): () => void {
  itemEventFns.add(fn);
  return () => { itemEventFns.delete(fn); };
}
/** publish an item event (server only, never sent to clients); subscriber errors are logged, never thrown */
export function emitItem(crew: Crew, e: ItemEvent): void {
  for (const fn of itemEventFns) safe('onItemEvent', () => fn(crew, e));
}
/** kinds this track handles itself (hasInteractHandler) */
export function ownsKind(kind: string): boolean {
  return OWN_KINDS.has(kind) || kind === 'container' || kind === 'item';
}

const now = (): number => (ctx ? ctx.now() : performance.timeOrigin + performance.now());

function bal(): Record<string, unknown> {
  return (ctx?.balance.interaction as Record<string, unknown> | undefined) ?? {};
}
export function num(key: string, d: number): number {
  const v = bal()[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}
/** feature flag (config/flags.json; absent = on) */
export function flag(name: string): boolean {
  return ctx?.flags[name] !== false;
}
/** v1.3 feature flag that defaults off (absent = off) */
export function flagOn(name: string): boolean {
  return ctx?.flags[name] === true;
}

/** v1.3 F3 gear -> its flag (missing in config/flags.json = off) */
export const F3_FLAGS = { lure: 'noiseLure', receiver: 'fieldReceiver' } as const;
/** the F3 ITEM_DEFS entries as shared/interactables.ts declares them (kept here: the table loses them while a flag is off) */
const F3_DEFS: Readonly<Record<string, ItemDef>> = Object.fromEntries(Object.keys(F3_FLAGS).filter((t) => !!ITEM_DEFS[t]).map((t) => [t, ITEM_DEFS[t]!]));
/**
 * v1.3 F3: an ITEM_DEFS entry means "interaction implements it" (catalog.ts): the workbench offers its recipe, safes,
 * finds and the collection log list it. So each F3 entry stays in the shared table only while its flag is on; with the
 * flag off the game is exactly v1.2 (15/17 recipes). Runs at install and on every config reload / dbg.setFlags. Flags
 * gate behaviour only: pool units, saves and items people already hold are untouched.
 */
export function syncFlaggedDefs(): void {
  for (const [type, f] of Object.entries(F3_FLAGS)) {
    const def = F3_DEFS[type];
    if (!def) continue;
    if (flagOn(f)) ITEM_DEFS[type] = def;
    else delete ITEM_DEFS[type];
  }
}
/** an object-valued balance key merged over its defaults */
function objBal<T extends object>(key: string, d: T): T {
  const v = bal()[key];
  return v && typeof v === 'object' && !Array.isArray(v) ? ({ ...d, ...(v as object) } as T) : d;
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
  return {
    doors: {}, items: {}, inventories: {}, lights: {}, dead: [], hidden: {}, active: {}, ints: {}, glows: {}, bodies: {}, respawns: {}, hp: {}, flares: {},
    containers: {}, nv: {}, pouches: {}, flashes: {},
  };
}

export function slice(crew: Crew): IxSlice {
  let s = crew.slices[TRACK] as IxSlice | undefined;
  if (!s) {
    s = {
      ...emptyState(), layoutKey: null, grid: null, doorGeom: new Map(), switches: {}, broken: new Set(), powerPush: {},
      blackoutPush: null, thrown: [], patch: {}, nextId: 1, deaths: [], lastAct: {}, lastHand: {}, tickN: 0,
      walkiesGiven: false, extrasPending: 0, layoutItems: new Map(), idolNext: {}, idolN: 0, rng: null,
      easing: {}, lastEase: {}, containerInfo: new Map(), contents: new Map(), pendingSpawns: [], vanMats: {}, heldOnce: new Set(),
      respawnInfo: {}, containerOverride: null, lures: new Map(), listening: {},
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
    containers: contsOf(s), nv: nvOf(s), pouches: pouchesOf(s), flashes: flashesOf(s),
  };
}

const layoutKey = (L: LevelLayout | null): string | null => (L ? `${L.kind}:${L.seed}:${L.hash}` : null);

function markDoor(s: IxSlice, id: number): void {
  const d = s.doors[id];
  (s.patch.doors ??= {})[id] = { ...d, ...(d?.ease ? { ease: { ...d.ease } } : {}) };
}
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
function contsOf(s: IxSlice): Record<string, ContainerState> { return (s.containers ??= {}); }
function markContainer(s: IxSlice, cid: string): void {
  const c = contsOf(s)[cid];
  (s.patch.containers ??= {})[cid] = c ? { ...c, ...(c.ease ? { ease: { ...c.ease } } : {}) } : null;
}
function nvOf(s: IxSlice): Record<string, boolean> { return (s.nv ??= {}); }
function markNv(s: IxSlice, pid: string): void { (s.patch.nv ??= {})[pid] = nvOf(s)[pid] ? true : null; }
function pouchesOf(s: IxSlice): Record<string, Record<string, number>> { return (s.pouches ??= {}); }
function markPouch(s: IxSlice, pid: string): void {
  const p = pouchesOf(s)[pid];
  (s.patch.pouches ??= {})[pid] = p && Object.keys(p).length ? { ...p } : null;
}
function flashesOf(s: IxSlice): Record<string, FlashState> { return (s.flashes ??= {}); }
function markFlash(s: IxSlice, id: string): void { const f = flashesOf(s)[id]; (s.patch.flashes ??= {})[id] = f ? { ...f } : null; }
function luresOf(s: IxSlice): Map<string, LureRun> { return (s.lures ??= new Map()); }
function listeningOf(s: IxSlice): Record<string, number> { return (s.listening ??= {}); }

/** Send pending changes to the crew (call at the end of a request / tick / API mutation batch). */
export function flush(crew: Crew): void {
  const s = crew.slices[TRACK] as IxSlice | undefined;
  if (!s) return;
  const p = s.patch;
  if (!Object.keys(p).length) return;
  s.patch = {};
  ctx?.emit(crew, 'interaction.patch', p);
}

function fx(crew: Crew, kind: IxFxKind, d: { p?: Vec3; pid?: string; id?: string; door?: number; open?: boolean; item?: string; soft?: boolean; count?: number; dir?: Vec3 } = {}): void {
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
  // v1.2: eases, containers, flashes, night vision, pouches and the van stash belong to one layout
  clearObj(s.easing);
  clearObj(contsOf(s));
  s.containerInfo.clear();
  s.contents.clear();
  s.pendingSpawns.length = 0;
  clearObj(flashesOf(s));
  clearObj(nvOf(s));
  clearObj(pouchesOf(s));
  clearObj(s.vanMats);
  clearObj(s.respawnInfo);
  s.heldOnce.clear();
  for (const it of Object.values(s.items)) s.heldOnce.add(it.id);
  // v1.3: armed lures lay in the old layout's world; receiver listens end with it
  luresOf(s).clear();
  clearObj(listeningOf(s));
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
    registerContainers(s, L);
    spawnWorldItems(crew, s, L);
    recomputeLights(crew, s, false);
  }
  s.patch = { reset: publicState(s) };
}

// ---------------------------------------------------------------- v1.2 containers (registry; contents in spawnWorldItems)

const CONTAINER_NAME: Record<string, string> = {
  cabinet: 'cabinet', desk: 'desk', filing: 'filing cabinet', tool_chest: 'tool chest', morgue_drawers: 'morgue drawer',
  counter: 'counter', drawer_chest: 'chest of drawers', nightstand: 'nightstand',
};
export const containerName = (kind: string): string => CONTAINER_NAME[kind] ?? kind.replace(/_/g, ' ');

/** E1's containersOf (or the dev-only test double) */
function containerList(s: IxSlice, L: LevelLayout): readonly ContainerInfo[] {
  if (s.containerOverride) return s.containerOverride;
  try {
    return containersOf(L);
  } catch (e) {
    ctx?.log(TRACK).warn('containersOf failed:', e instanceof Error ? e.message : e);
    return [];
  }
}

/** one interactable per container (flag containers, facilities only): id 'cont:<prop id>', ref = container id */
function registerContainers(s: IxSlice, L: LevelLayout): void {
  if (L.kind !== 'facility' || !flag('containers')) return;
  for (const c of containerList(s, L)) {
    if (!c || typeof c.id !== 'string' || s.containerInfo.has(c.id)) continue;
    s.containerInfo.set(c.id, c);
    const id = v12Id('container', c.id);
    s.ints[id] = {
      id, kind: 'container', p: [Number(c.p[0]) || 0, Number(c.p[1]) || 0.8, Number(c.p[2]) || 0], prompt: `Search the ${containerName(c.kind)}`,
      enabled: true, r: INTERACT_RADIUS.container ?? 0.32, ref: c.id,
    };
  }
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
  const salvage = !hasHandler('loot');
  const budget = salvage ? lootBudget(crew, L) : 0;
  const tierVals = (bal().lootTierValues as [number, number][] | undefined) ?? [[8, 35], [35, 90], [150, 300]];
  // v1.2 containers: contents rolled once, kept private; containerBudgetFrac of the salvage budget goes into drawers as
  // tier 0-1 salvage and the floor gets the rest (flag off: no containers, the whole budget on the floor as in v1.1)
  let spent = 0;
  if (s.containerInfo.size) {
    const roll = rollContainers(L, [...s.containerInfo.values()], budget * Math.max(0, num('containerBudgetFrac', 0.15)), {
      cfg: objBal<ContainerLootCfg>('containerLoot', CONTAINER_LOOT_DEFAULT), materials: flag('materials'), gearV12: flag('gearV12'),
      salvage, tierValues: tierVals, matCfg: matCfg(),
    });
    for (const [cid, list] of roll.contents) s.contents.set(cid, list);
    spent = roll.spent;
  }
  if (!salvage) return;
  const floorBudget = budget - spent;
  const rng = makeRng(`${L.seed}:${L.hash}`, 'interaction.loot');
  const slots = rng.shuffle(L.items.filter((i) => i.kind === 'loot'));
  const used = new Set<string>();
  const maxHeavy = Math.max(1, Math.floor(budget / 450));
  let heavy = 0;
  let total = 0;
  for (const sl of slots) {
    if (total >= floorBudget) break;
    let tier = Math.max(0, Math.min(2, Number(sl.data?.tier ?? 0) | 0));
    if (tier === 2 && heavy >= maxHeavy) tier = 1;
    const [lo, hi] = tierVals[tier] ?? [10, 30];
    let value = rng.int(lo, hi);
    if (total + value > floorBudget * 1.08) {
      if (tier === 0) continue;
      tier = 0;
      value = rng.int(tierVals[0][0], tierVals[0][1]);
      if (total + value > floorBudget * 1.08) continue;
    }
    if (tier === 2) heavy++;
    total += value;
    used.add(sl.id);
    newItem(s, LOOT_TIER_TYPES[tier], { value, tier, name: rng.pick(LOOT_NAMES[tier]), p: [sl.x, 0, sl.z], rot: sl.rot ?? 0 });
  }
}

/** crew size for spawn maths: the connected crew (fallback: the layout's generation size), 1..6 */
function crewSize(crew: Crew, L: LevelLayout): number {
  const connected = [...crew.players.values()].filter((p) => p.connected).length;
  return Math.max(1, Math.min(6, connected || Number(L.metrics?.players ?? 2) | 0));
}
const riskOf = (L: LevelLayout): number => Math.max(1, Math.min(3, Number(L.metrics?.risk ?? 1) | 0));

/** the site's salvage budget: core lootBudgetBase x riskLootMult x playerMult (same maths objectives / meta use) */
function lootBudget(crew: Crew, L: LevelLayout): number {
  const core = ctx?.balance.core ?? {};
  const riskMult = Number((core.riskLootMult as Record<string, number> | undefined)?.[riskOf(L)] ?? 1);
  const playerMult = Number((core.playerMult as Record<string, number> | undefined)?.[crewSize(crew, L)] ?? 1);
  return Number(core.lootBudgetBase ?? 650) * riskMult * playerMult;
}

function matCfg(): MaterialsCfg {
  return objBal<MaterialsCfg>('materials', MATERIALS_DEFAULT);
}

/** v1.2 gear types gated by flag gearV12 in spawns (finds, extras, drawers, safes) */
const V12_SPAWN = new Set<string>([...GEAR_V12, 'loot.curio']);

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
    if (V12_SPAWN.has(type) && !flag('gearV12')) continue;
    for (let i = 0; i < n && k < free.length; i++, k++) {
      const sl = free[k];
      const extra: Partial<ItemState> = { p: [sl.x, 0, sl.z], rot: sl.rot ?? 0 };
      if (type === 'bottle') extra.count = 1;
      if (type === 'glowstick') extra.count = 3;
      if (type === 'battery') extra.count = 1;
      const it = newItem(s, type, extra);
      markItem(s, it.id);
    }
  }
  // v1.2 crafting materials on the slots still free
  if (flag('materials')) {
    for (const sp of planMaterials(L, free.slice(k), crewSize(crew, L), riskOf(L), matCfg())) {
      const it = newItem(s, sp.type, { p: sp.p, rot: sp.rot ?? 0, count: sp.count ?? 1 });
      markItem(s, it.id);
    }
  }
}

/** special finds: rare, only in the deepest rooms (v1.1: syringe, charm, idol; v1.2: lockpicks, overshoes, night vision,
 *  master keycard, a curio), placed by planFinds (spawns.ts) */
function spawnFinds(s: IxSlice, L: LevelLayout, free: LayoutItem[]): Set<string> {
  if (ctx?.flags.specialFinds === false) return new Set<string>();
  const { specs, used } = planFinds(L, free, {
    finds: (bal().specialFinds as Record<string, number> | undefined) ?? { syringe: 0.45, charm: 0.3, 'loot.idol': 0.35 },
    findRooms: bal().findRooms as Record<string, string[]> | undefined,
    minDistFrac: num('findsMinDistFrac', 0.6),
    idolValue: (bal().idolValue as [number, number] | undefined) ?? [350, 500],
    curioValue: (bal().curioValue as [number, number] | undefined) ?? [60, 140],
    gearV12: flag('gearV12'),
  });
  for (const sp of specs) {
    const extra: Partial<ItemState> = { p: sp.p, rot: sp.rot ?? 0 };
    if (sp.value !== undefined) extra.value = sp.value;
    if (sp.tier !== undefined) extra.tier = sp.tier;
    if (sp.name !== undefined) extra.name = sp.name;
    if (sp.count !== undefined) extra.count = sp.count;
    const it = newItem(s, sp.type, extra);
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
  // v1.2 flashbulb: a fired flash lights its cone (flashRangeM, flashConeDeg, LOS) while it lasts. Night vision never
  // counts as light.
  for (const f of Object.values(flashesOf(s))) {
    if (f.until < tNow) continue;
    if (inCone(f.p[0], f.p[2], f.dir[0], f.dir[2], x, z, num('flashRangeM', 14), num('flashConeDeg', 25)) && losClear(s, f.p[0], f.p[2], x, z)) return true;
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

/** (x, z) inside a horizontal cone from (ox, oz) along (dx, dz), range m, half-angle deg (within 0.5 m always) */
function inCone(ox: number, oz: number, dx: number, dz: number, x: number, z: number, range: number, deg: number): boolean {
  const vx = x - ox, vz = z - oz;
  const d = Math.hypot(vx, vz);
  if (d > range) return false;
  if (d < 0.5) return true;
  const hl = Math.hypot(dx, dz) || 1;
  return (vx * dx + vz * dz) / (d * hl) >= Math.cos((deg * Math.PI) / 180);
}

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
  s.heldOnce.add(it.id);
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

export type AcquireVia = NonNullable<ItemEvent['via']>;

export function giveItemTo(crew: Crew, pid: string, type: string, extraIn: Partial<ItemState> & { via?: AcquireVia } = {}): ItemState | null {
  const s = slice(crew);
  const pl = crew.players.get(pid);
  if (!pl) return null;
  const { via: viaIn, ...rest } = extraIn ?? {};
  const via: AcquireVia = viaIn ?? 'api';
  let extra: Partial<ItemState> = rest;
  // v1.2 crafting materials never take a slot: straight into the salvage pouch
  if (isMaterial(type)) {
    const n = Math.max(1, Math.round(Number(extra.count ?? 1)) || 1);
    addToPouch(s, pid, { [type]: n });
    emitItem(crew, { kind: 'acquire', pid, type, id: `pouch:${pid}`, count: n, via });
    return { id: `pouch:${pid}`, type, value: 0, where: 'held', holder: pid, count: n };
  }
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
        emitItem(crew, { kind: 'acquire', pid, type, id: have.id, count: n, via });
        return have;
      }
      extra = { ...extra, count: n };
    }
  }
  const it = newItem(s, type, extra);
  if (!putInInv(s, pid, it)) {
    it.where = 'world';
    it.p = dropPoint(s, pl, 0.4);
    s.heldOnce.add(it.id);
    markItem(s, it.id);
  }
  emitItem(crew, { kind: 'acquire', pid, type, id: it.id, count: it.count ?? 1, ...(it.name ? { name: it.name } : {}), ...(it.value ? { value: it.value } : {}), via });
  return it;
}

/** add units to pid's salvage pouch (materials only) */
function addToPouch(s: IxSlice, pid: string, mats: Record<string, number>): number {
  const pouch = (pouchesOf(s)[pid] ??= {});
  let units = 0;
  for (const [k, v] of Object.entries(mats ?? {})) {
    const n = Math.round(Number(v) || 0);
    if (!isMaterial(k) || n <= 0) continue;
    pouch[k] = (pouch[k] ?? 0) + n;
    units += n;
  }
  if (!Object.keys(pouch).length) delete pouchesOf(s)[pid];
  markPouch(s, pid);
  return units;
}

export function spawnWorldItem(crew: Crew, type: string, p: Vec3, extra: Partial<ItemState> = {}): ItemState {
  const s = slice(crew);
  const it = newItem(s, type, { p: [p[0], Math.max(0, p[1]), p[2]], ...extra });
  markItem(s, it.id);
  return it;
}

// ---------------------------------------------------------------- doors

export function setDoor(
  crew: Crew, id: number, open: boolean, by: string | null,
  opts: { force?: boolean; soft?: boolean; noiseM?: number; noiseKind?: string } = {},
): boolean {
  const s = slice(crew);
  const st = s.doors[id];
  const g = s.doorGeom.get(id);
  if (!st || !g || g.kind === 'open' || g.kind === 'blocked') return false;
  // v1.2: every door change (a tap, the console, a monster, a director slam, the API) cancels a hold-E on it
  if (st.ease) clearDoorEase(s, id);
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
  fx(crew, sec ? 'security' : 'door', { p: [g.cx, 1.1, g.cz], door: id, open, pid: by ?? undefined, ...(opts.soft ? { soft: true } : {}) });
  if (opts.soft) {
    // an eased door: below every monster's hearing threshold (Hound 4 m, Listener 5 m)
    const r = num('doorSoftNoiseM', 1);
    if (r > 0) noise(crew, g.cx, g.cz, r, 'doorSoft', by);
  } else if (opts.noiseM !== undefined) noise(crew, g.cx, g.cz, opts.noiseM, opts.noiseKind ?? 'door', by);
  else noise(crew, g.cx, g.cz, sec ? NOISE_M.securityDoor : NOISE_M.door, sec ? 'securityDoor' : 'door', by);
  for (const fn of doorFns) safe('onDoor', () => fn(crew, id, open, by));
  return true;
}

/** drop a door's ease (and the easer's run) without committing */
function clearDoorEase(s: IxSlice, id: number): void {
  const st = s.doors[id];
  if (!st?.ease) return;
  const by = st.ease.by;
  delete st.ease;
  markDoor(s, id);
  const run = s.easing[by];
  if (run && run.target === 'door' && run.ref === id) delete s.easing[by];
}

/** the master keycard a player carries (with charges left), if any */
function masterKeyOf(s: IxSlice, pid: string): ItemState | null {
  return itemsOfPid(s, pid).find((it) => it.type === 'masterkey' && (it.count ?? 1) > 0) ?? null;
}

/** spend one unit of a held item (lockpick, master keycard charge) with its use + consume events */
function spendOne(crew: Crew, s: IxSlice, pid: string, it: ItemState, p?: Vec3): number {
  const left = Math.max(0, (it.count ?? 1) - 1);
  emitItem(crew, { kind: 'use', pid, type: it.type, id: it.id, ...(p ? { p } : {}) });
  consumeOne(s, it);
  emitItem(crew, { kind: 'consume', pid, type: it.type, id: it.id, count: 1 });
  return left;
}

function hasKeycard(s: IxSlice, pid: string, lock: number): boolean {
  return itemsOfPid(s, pid).some((it) => it.type === 'keycard' && (it.lock ?? 1) === (lock || 1));
}

function handDoor(crew: Crew, s: IxSlice, pl: ServerPlayer, id: number, hold: boolean): IxResult {
  const st = s.doors[id];
  const g = s.doorGeom.get(id);
  if (!st || !g) return { ok: false, msg: 'Nothing there' };
  if (g.kind === 'vault') return { ok: false, msg: 'The vault opens from the keypad' };
  const dp: Vec3 = [g.cx, 1.1, g.cz];
  const t = now();
  const cool = () => t - (s.lastHand[id] ?? 0) < num('handDoorCooldownMs', 350);
  if (st.locked) {
    if (g.kind === 'locked' && hasKeycard(s, pl.id, g.lock)) {
      st.locked = false;
      markDoor(s, id);
      fx(crew, 'unlock', { p: dp, door: id, pid: pl.id });
    } else if (g.kind === 'locked' && masterKeyOf(s, pl.id)) {
      // v1.2 master keycard: any keycard-locked door opens at once (one charge). Never the vault or rubble.
      if (cool()) return { ok: false };
      const left = spendOne(crew, s, pl.id, masterKeyOf(s, pl.id)!, dp);
      st.locked = false;
      markDoor(s, id);
      fx(crew, 'masterkey', { p: dp, door: id, pid: pl.id, count: left });
      s.lastHand[id] = t;
      setDoor(crew, id, true, pl.id, { force: true });
      return { ok: true, msg: `Master keycard: ${left} charge${left === 1 ? '' : 's'} left` };
    } else if (g.kind === 'locked' && hasType(s, pl.id, 'lockpick')) {
      fx(crew, 'deny', { p: dp, door: id, pid: pl.id });
      return { ok: false, msg: 'Hold E: pick the lock (loud)' };
    } else {
      fx(crew, 'deny', { p: dp, door: id, pid: pl.id });
      return { ok: false, msg: 'Locked: needs the keycard' };
    }
  }
  if (g.kind === 'security' && !hold) {
    // v1.2 master keycard: a security door moves at a tap, with a 5 m 'door' noise instead of the 12 m clank (one charge)
    const mk = masterKeyOf(s, pl.id);
    if (!mk) return { ok: false, msg: 'Hold E to force the security door' };
    if (cool()) return { ok: false };
    const left = spendOne(crew, s, pl.id, mk, dp);
    fx(crew, 'masterkey', { p: dp, door: id, pid: pl.id, count: left });
    s.lastHand[id] = t;
    setDoor(crew, id, !st.open, pl.id, { force: true, noiseM: num('masterkeySecurityNoiseM', 5), noiseKind: 'door' });
    return { ok: true, msg: `Master keycard: ${left} charge${left === 1 ? '' : 's'} left` };
  }
  // v1.2: with easeDoors on, the security-door hold is timed by the server (interaction.ease); a hold flag alone is
  // never trusted
  if (g.kind === 'security' && flag('easeDoors')) return { ok: false, msg: 'Hold E to force the security door' };
  if (cool()) return { ok: false };
  s.lastHand[id] = t;
  setDoor(crew, id, !st.open, pl.id, { force: true });
  return { ok: true };
}

// ---------------------------------------------------------------- v1.2 hold-E: quiet ease, lockpick, security force

/** ease time per door kind (ms) */
function easeMsFor(kind: string): number {
  if (kind === 'fire') return num('easeFireMs', 2600);
  if (kind === 'exit') return num('easeExitMs', 2200);
  return num('easeDoorMs', 1800);
}

export type EaseResult = IxResult & { t0?: number; ms?: number; off?: boolean; done?: boolean };

/** 'interaction.ease' {id, on}: on = E has been held easeTapMs; off = released (commits only if the time is up) */
export function easeReq(crew: Crew, pl: ServerPlayer, id: string, on: boolean): EaseResult {
  const s = slice(crew);
  if (!on) {
    const run = s.easing[pl.id];
    if (!run || (id && run.id !== id)) return { ok: true, done: false };
    if (now() >= run.t0 + run.ms) {
      commitEase(crew, s, pl.id, run);
      return { ok: true, done: true };
    }
    cancelEase(s, pl.id);
    return { ok: true, done: false };
  }
  if (!pl.alive || s.dead.includes(pl.id)) return { ok: false, msg: 'You are dead' };
  if (s.hidden[pl.id]) return { ok: false, msg: 'You are hiding' };
  const info = s.ints[String(id)];
  if (!info) return { ok: false, msg: 'Nothing there' };
  if (info.kind !== 'door' && info.kind !== 'container') return { ok: false, msg: 'Nothing to ease' };
  const why = canReach(s, pl, info);
  if (why) return { ok: false, msg: why };
  const t = now();
  if (t - (s.lastEase[pl.id] ?? 0) < num('easeRestartMs', 150)) return { ok: false };
  if (s.easing[pl.id]) cancelEase(s, pl.id);
  return info.kind === 'door' ? easeDoorStart(crew, s, pl, info, t) : easeContainerStart(s, pl, info, t);
}

function easeDoorStart(crew: Crew, s: IxSlice, pl: ServerPlayer, info: InteractableInfo, t: number): EaseResult {
  const did = Number(info.ref);
  const st = s.doors[did];
  const g = s.doorGeom.get(did);
  if (!st || !g || g.kind === 'open' || g.kind === 'blocked') return { ok: false, msg: 'Nothing there' };
  if (g.kind === 'vault') return { ok: false, msg: 'The vault opens from the keypad' };
  if (st.ease) return { ok: false, msg: st.ease.by === pl.id ? undefined : 'Someone is already at that door' };
  if (t - (s.lastHand[did] ?? 0) < num('handDoorCooldownMs', 350)) return { ok: false };
  const soft = flag('easeDoors');
  let mode: EaseRun['mode'];
  let ms: number;
  if (st.locked) {
    if (g.kind !== 'locked') return { ok: false, msg: 'Locked' };
    if (hasKeycard(s, pl.id, g.lock)) {
      if (!soft) return { ok: false, off: true };
      // the keycard beeps first, then the door eases open
      st.locked = false;
      markDoor(s, did);
      fx(crew, 'unlock', { p: [g.cx, 1.1, g.cz], door: did, pid: pl.id });
      mode = 'soft';
      ms = easeMsFor(g.kind);
    } else if (masterKeyOf(s, pl.id)) {
      if (!soft) return { ok: false, off: true };
      mode = 'key';
      ms = easeMsFor(g.kind);
    } else if (hasType(s, pl.id, 'lockpick')) {
      mode = 'pick';
      ms = num('lockpickMs', 5000);
    } else {
      fx(crew, 'deny', { p: [g.cx, 1.1, g.cz], door: did, pid: pl.id });
      return { ok: false, msg: 'Locked: needs the keycard' };
    }
  } else if (g.kind === 'security') {
    if (!soft) return { ok: false, off: true };
    mode = 'force';
    ms = num('securityHoldMs', 2000);
  } else {
    if (!soft) return { ok: false, off: true };
    mode = 'soft';
    ms = easeMsFor(g.kind);
  }
  const to = mode === 'pick' ? st.open : !st.open;
  s.easing[pl.id] = { id: info.id, target: 'door', ref: did, mode, to, t0: t, ms };
  s.lastEase[pl.id] = t;
  st.ease = { by: pl.id, to, t0: t, ms, kind: mode === 'pick' ? 'pick' : mode === 'force' ? 'force' : 'soft' };
  markDoor(s, did);
  return { ok: true, t0: t, ms };
}

function easeContainerStart(s: IxSlice, pl: ServerPlayer, info: InteractableInfo, t: number): EaseResult {
  if (!flag('easeDoors') || !flag('containers')) return { ok: false, off: true };
  const cid = String(info.ref);
  if (!s.containerInfo.has(cid)) return { ok: false, msg: 'Nothing there' };
  const cs = contsOf(s)[cid];
  if (cs?.open) return { ok: false, msg: 'Already searched' };
  if (cs?.ease) return { ok: false, msg: cs.ease.by === pl.id ? undefined : 'Someone is already searching it' };
  const ms = num('easeContainerMs', 1200);
  s.easing[pl.id] = { id: info.id, target: 'container', ref: cid, mode: 'soft', to: true, t0: t, ms };
  s.lastEase[pl.id] = t;
  contsOf(s)[cid] = { ...(cs ?? { open: 0 }), ease: { by: pl.id, to: true, t0: t, ms, kind: 'soft' } };
  markContainer(s, cid);
  return { ok: true, t0: t, ms };
}

/** drop pid's hold-E without committing (release, death, hiding, sprint, out of reach, disconnect) */
export function cancelEase(s: IxSlice, pid: string): void {
  const run = s.easing[pid];
  if (!run) return;
  delete s.easing[pid];
  if (run.target === 'door') {
    const st = s.doors[Number(run.ref)];
    if (st?.ease?.by === pid) {
      delete st.ease;
      markDoor(s, Number(run.ref));
    }
  } else {
    const cid = String(run.ref);
    const cs = contsOf(s)[cid];
    if (cs?.ease?.by === pid) {
      delete cs.ease;
      if (!cs.open) delete contsOf(s)[cid];
      markContainer(s, cid);
    }
  }
}

function commitEase(crew: Crew, s: IxSlice, pid: string, run: EaseRun): void {
  delete s.easing[pid];
  if (run.target === 'container') {
    const cs = contsOf(s)[String(run.ref)];
    if (cs?.ease?.by === pid) delete cs.ease;
    openContainer(crew, s, pid, String(run.ref), true);
    return;
  }
  const did = Number(run.ref);
  const st = s.doors[did];
  const g = s.doorGeom.get(did);
  if (!st || !g) return;
  if (st.ease?.by === pid) {
    delete st.ease;
    markDoor(s, did);
  }
  const dp: Vec3 = [g.cx, 1.1, g.cz];
  const t = now();
  switch (run.mode) {
    case 'pick': {
      // lockpicks: the lock gives (6 m of scraping), one pick is used up, the door stays where it was
      const pick = itemsOfPid(s, pid).find((it) => it.type === 'lockpick');
      if (!pick || !st.locked) return;
      spendOne(crew, s, pid, pick, dp);
      st.locked = false;
      markDoor(s, did);
      const info = s.ints[`door:${did}`];
      if (info) { info.prompt = doorPrompt(g.kind, st.open, false); markInt(s, info.id); }
      fx(crew, 'pick', { p: dp, door: did, pid });
      noise(crew, g.cx, g.cz, num('lockpickNoiseM', 6), 'lockpick', pid);
      return;
    }
    case 'key': {
      const mk = masterKeyOf(s, pid);
      if (!mk || !st.locked) return;
      const left = spendOne(crew, s, pid, mk, dp);
      st.locked = false;
      fx(crew, 'masterkey', { p: dp, door: did, pid, count: left });
      s.lastHand[did] = t;
      setDoor(crew, did, run.to, pid, { force: true, soft: true });
      stat(crew, pid, 'doorsEased');
      return;
    }
    case 'force':
      s.lastHand[did] = t;
      setDoor(crew, did, run.to, pid, { force: true });
      return;
    default:
      s.lastHand[did] = t;
      if (setDoor(crew, did, run.to, pid, { force: true, soft: true })) stat(crew, pid, 'doorsEased');
  }
}

/** per tick: cancel holds whose player died / hid / left / sprinted / walked off; commit the ones whose time is up */
function tickEase(crew: Crew, s: IxSlice, t: number): void {
  for (const [pid, run] of Object.entries(s.easing)) {
    const pl = crew.players.get(pid);
    let cancel = !pl || !pl.connected || !pl.alive || s.dead.includes(pid) || !!s.hidden[pid];
    if (!cancel && pl) {
      const info = s.ints[run.id];
      // sprinting (the server's judged stance, or merely the claim: a client can only make itself louder)
      const sprint = pl.pose.stance === STANCE.sprint || stealthStance(crew, pid) === STANCE.sprint;
      cancel = !info || sprint || canReach(s, pl, info) !== null;
    }
    if (cancel) cancelEase(s, pid);
    else if (t >= run.t0 + run.ms) commitEase(crew, s, pid, run);
  }
}

// ---------------------------------------------------------------- v1.2 containers: open, contents, stock

/** the main part (its slot holds the contents) */
function mainPart(c: ContainerInfo): ContainerInfo['parts'][number] | undefined {
  return c.parts?.find((p) => p.idx === c.main) ?? c.parts?.[c.main] ?? c.parts?.[0];
}

function tapContainer(crew: Crew, s: IxSlice, pl: ServerPlayer, inf: InteractableInfo): IxResult {
  if (!flag('containers')) return { ok: false, msg: 'Nothing happens' };
  const cid = String(inf.ref);
  if (!s.containerInfo.has(cid)) return { ok: false, msg: 'Nothing there' };
  const cs = contsOf(s)[cid];
  if (cs?.open) return { ok: false, msg: 'Already searched' };
  openContainer(crew, s, pl.id, cid, false);
  return { ok: true };
}

/** open a container's main part: tap = a 'drawer' noise (containerNoiseM by kind) and the contents 300 ms later;
 *  soft (an eased open) = 'drawerSoft' 1 m and the contents at once. Searched containers stay open. */
function openContainer(crew: Crew, s: IxSlice, by: string, cid: string, soft: boolean): void {
  const c = s.containerInfo.get(cid);
  if (!c) return;
  const prev = contsOf(s)[cid];
  if (prev?.ease) {
    const run = s.easing[prev.ease.by];
    if (run && run.target === 'container' && run.ref === cid) delete s.easing[prev.ease.by];
  }
  const mask = 1 << Math.max(0, Math.min(15, Math.round(c.main ?? 0)));
  contsOf(s)[cid] = { open: (prev?.open ?? 0) | mask, by };
  markContainer(s, cid);
  const id = v12Id('container', cid);
  const info = s.ints[id];
  if (info) {
    info.enabled = false;
    info.prompt = `Searched ${containerName(c.kind)}`;
    markInt(s, id);
  }
  const p: Vec3 = [c.p[0], c.p[1], c.p[2]];
  if (soft) {
    const r = num('drawerSoftNoiseM', 1);
    if (r > 0) noise(crew, p[0], p[2], r, 'drawerSoft', by);
  } else {
    const table = (bal().containerNoiseM as Record<string, number> | undefined) ?? {};
    noise(crew, p[0], p[2], Number(table[c.kind] ?? table.default ?? 5), 'drawer', by);
  }
  fx(crew, 'container', { p, pid: by, id: cid, open: true, item: c.kind, ...(soft ? { soft: true } : {}) });
  stat(crew, by, 'drawersSearched');
  if (soft) spawnContents(crew, s, cid);
  else s.pendingSpawns.push({ at: now() + num('containerSpawnDelayMs', 300), cid, by });
}

/** the container's private contents become world items in its open part, 0.12 m apart along its width */
function spawnContents(crew: Crew, s: IxSlice, cid: string): void {
  const c = s.containerInfo.get(cid);
  const list = s.contents.get(cid) ?? [];
  s.contents.delete(cid);
  if (!c || !list.length) return;
  const slot = mainPart(c)?.slot ?? [c.p[0], Math.max(0.05, c.p[1] - 0.1), c.p[2]];
  const rot = c.rot ?? 0;
  const ax = Math.cos(rot), az = -Math.sin(rot);
  const gap = num('containerItemGapM', 0.12);
  list.forEach((sp, i) => {
    const off = (i - (list.length - 1) / 2) * gap;
    const extra: Partial<ItemState> = { p: [slot[0] + ax * off, Math.max(0, slot[1]), slot[2] + az * off], rot };
    if (sp.value !== undefined) extra.value = sp.value;
    if (sp.tier !== undefined) extra.tier = sp.tier;
    if (sp.name !== undefined) extra.name = sp.name;
    if (sp.count !== undefined) extra.count = sp.count;
    const it = newItem(s, sp.type, extra);
    markItem(s, it.id);
  });
  void crew;
}

/** a private item into a closed container (fieldguide pages): false if unknown, open or the flag is off */
export function stockContainerItem(crew: Crew, cid: string, spec: { type: string; name?: string; value?: number }): boolean {
  const s = slice(crew);
  if (!flag('containers') || !spec || typeof spec.type !== 'string' || !spec.type) return false;
  const id = s.containerInfo.has(cid) ? cid : cid.startsWith('cont:') ? cid.slice(5) : cid;
  if (!s.containerInfo.has(id) || contsOf(s)[id]?.open) return false;
  const list = s.contents.get(id) ?? [];
  list.push({ type: spec.type, ...(spec.name !== undefined ? { name: String(spec.name) } : {}), ...(spec.value !== undefined ? { value: Number(spec.value) || 0 } : {}) });
  s.contents.set(id, list);
  return true;
}

/** dev-only: container ids with their private contents (tests) */
export function containerPeek(crew: Crew): Record<string, SpawnSpec[]> {
  const s = slice(crew);
  return Object.fromEntries([...s.containerInfo.keys()].map((cid) => [cid, (s.contents.get(cid) ?? []).map((x) => ({ ...x }))]));
}

/** dev-only test double for containersOf (until E1's lands): re-registers containers and re-rolls their contents */
export function overrideContainers(crew: Crew, list: ContainerInfo[] | null): number {
  const s = slice(crew);
  const L = crew.layout;
  s.containerOverride = list && list.length ? list : null;
  for (const id of Object.keys(s.ints)) if (s.ints[id]?.kind === 'container') { delete s.ints[id]; markInt(s, id); }
  for (const cid of Object.keys(contsOf(s))) { delete contsOf(s)[cid]; markContainer(s, cid); }
  s.containerInfo.clear();
  s.contents.clear();
  if (!L) return 0;
  registerContainers(s, L);
  for (const id of Object.keys(s.ints)) if (s.ints[id]?.kind === 'container') markInt(s, id);
  if (s.containerInfo.size) {
    const tierVals = (bal().lootTierValues as [number, number][] | undefined) ?? [[8, 35], [35, 90], [150, 300]];
    const roll = rollContainers(L, [...s.containerInfo.values()], lootBudget(crew, L) * Math.max(0, num('containerBudgetFrac', 0.15)), {
      cfg: objBal<ContainerLootCfg>('containerLoot', CONTAINER_LOOT_DEFAULT), materials: flag('materials'), gearV12: flag('gearV12'),
      salvage: !hasHandler('loot'), tierValues: tierVals, matCfg: matCfg(),
    });
    for (const [cid, l] of roll.contents) s.contents.set(cid, l);
  }
  return s.containerInfo.size;
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
  cancelEase(s, pl.id);
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
  if (s.ints[lockerId]?.kind === 'locker') fx(crew, 'locker', { p: s.ints[lockerId]?.p, pid, id: lockerId, open: false });
  return true;
}

/** v1.2 programmatic hide (players' crawl vents: 'duct:<vent id>'; a locker id hides in that locker): stance hidden,
 *  use / act / drop blocked, flashlight off, monsters and litAt ignore the player until unhide() */
export function hideInSpot(crew: Crew, pid: string, spotId: string): boolean {
  const s = slice(crew);
  const pl = crew.players.get(pid);
  if (!pl || !pl.alive || s.dead.includes(pid) || typeof spotId !== 'string' || !spotId) return false;
  if (s.hidden[pid] === spotId) return true;
  if (s.ints[spotId]?.kind === 'locker') {
    if (s.hidden[pid]) unhidePid(crew, pid);
    return hide(crew, s, pl, spotId).ok;
  }
  if (s.hidden[pid]) unhidePid(crew, pid);
  cancelEase(s, pid);
  s.hidden[pid] = spotId;
  markHidden(s, pid);
  pl.pose.stance = STANCE.hidden;
  pl.pose.light = 0;
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

/** stackable gear (every POOL_STACK type) merges into the stack you already carry when picked up */
const MERGE_ON_PICKUP = new Set(Object.keys(POOL_STACK));

function pickup(crew: Crew, s: IxSlice, pl: ServerPlayer, it: ItemState): IxResult {
  if (it.where !== 'world') return { ok: false, msg: 'Gone' };
  const fresh = !s.heldOnce.has(it.id);
  const p0: Vec3 | undefined = it.p ? [it.p[0], it.p[1], it.p[2]] : undefined;
  const space = p0 ? spaceAtXZ(crew, p0[0], p0[2]) : -1;
  const fxp: Vec3 = [pl.pose.p[0], 1, pl.pose.p[2]];
  const where = { ...(p0 ? { p: p0 } : {}), ...(space >= 0 ? { space } : {}) };
  // v1.2 crafting materials and dropped pouches go into the salvage pouch (no slot)
  if (isMaterial(it.type) || it.type === POUCH_TYPE) {
    const units = addToPouch(s, pl.id, it.type === POUCH_TYPE ? (it.mats ?? {}) : { [it.type]: Math.max(1, it.count ?? 1) });
    deleteItem(s, it.id);
    fx(crew, 'pickup', { p: fxp, pid: pl.id, item: it.type, id: it.id, count: units });
    emitItem(crew, { kind: 'pickup', pid: pl.id, type: it.type, id: it.id, count: units, fresh: it.type !== POUCH_TYPE && fresh, ...(it.name ? { name: it.name } : {}), ...where });
    return { ok: true, msg: it.type === POUCH_TYPE ? `${it.name ?? 'Salvage pouch'}: +${units} into your pouch` : `${itemLabel(it)} · into your pouch` };
  }
  // v1.2 field-note pages are filed, never carried: gone from the world first, then the event (fieldguide files it)
  if (it.type === PAGE_TYPE) {
    deleteItem(s, it.id);
    fx(crew, 'pickup', { p: fxp, pid: pl.id, item: it.type, id: it.id });
    emitItem(crew, { kind: 'pickup', pid: pl.id, type: it.type, id: it.id, fresh, ...(it.name ? { name: it.name } : {}), ...where });
    return { ok: true };
  }
  if (MERGE_ON_PICKUP.has(it.type)) {
    const have = itemsOfPid(s, pl.id).find((x) => x.type === it.type);
    if (have) {
      have.count = (have.count ?? 1) + (it.count ?? 1);
      markItem(s, have.id);
      deleteItem(s, it.id);
      fx(crew, 'pickup', { p: fxp, pid: pl.id, item: it.type, id: have.id });
      emitItem(crew, { kind: 'pickup', pid: pl.id, type: it.type, id: it.id, count: it.count ?? 1, fresh, ...where });
      return { ok: true };
    }
  }
  if (it.armed) delete it.armed;
  if (!putInInv(s, pl.id, it)) return { ok: false, msg: 'Hands full (G to drop)' };
  fx(crew, 'pickup', { p: fxp, pid: pl.id, item: it.type, id: it.id });
  emitItem(crew, {
    kind: 'pickup', pid: pl.id, type: it.type, id: it.id, count: it.count ?? 1, fresh,
    ...(it.name ? { name: it.name } : {}), ...(it.value ? { value: it.value } : {}), ...where,
  });
  return { ok: true };
}

export function dropActive(crew: Crew, pl: ServerPlayer, slot?: number): IxResult {
  const s = slice(crew);
  if (!pl.alive) return { ok: false };
  if (s.hidden[pl.id]) return { ok: false, msg: 'You are hiding' };
  const inv = invOf(s, pl.id);
  const i = slot !== undefined && slot >= 0 && slot < INV_SLOTS ? slot : (s.active[pl.id] ?? 0);
  const id = inv[i];
  const it = id ? s.items[id] : undefined;
  if (!it) return { ok: false, msg: 'Nothing to drop' };
  // v1.2: pool gear dropped in the hub would be handed out again at the next contract (gear-pool dupe)
  if (crew.phase === 'hub' && POOL_TYPES.includes(it.type)) return { ok: false, msg: 'Keep your gear on you in the lot: it is on the books' };
  const p = dropPoint(s, pl);
  dropToWorld(s, it, p);
  it.rot = pl.pose.yaw;
  fx(crew, 'drop', { p, pid: pl.id, item: it.type, id: it.id });
  emitItem(crew, { kind: 'drop', pid: pl.id, type: it.type, id: it.id, count: it.count ?? 1, ...(it.name ? { name: it.name } : {}), ...(it.value ? { value: it.value } : {}), p });
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

/** v1.3 extras of 'interaction.act' (TODO(integrator): add `fuse?: number; door?: number` to the args of
 *  'interaction.act' in messages/interaction.ts; the handler reads them untyped until then) */
export interface ActExtra {
  /** noise lure: the fuse the thrower picked (s, one of lureFuseSec; anything else = on landing) */
  fuse?: unknown;
  /** field receiver: the closed door held to (ear to the door) */
  door?: unknown;
}

export function act(crew: Crew, pl: ServerPlayer, dirIn: Vec3, eyeIn?: Vec3, more: ActExtra = {}): IxResult & { listen?: ListenGrant } {
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
  const type = it.type, iid = it.id;
  const used = (extra: Partial<ItemEvent> = {}) => emitItem(crew, { kind: 'use', pid: pl.id, type, id: iid, p: eye, dir, ...extra });
  const spent = () => {
    consumeOne(s, it);
    emitItem(crew, { kind: 'consume', pid: pl.id, type, id: iid, count: 1 });
  };
  // v1.3 F3 gear (by type: ItemUse is frozen this round)
  if (type === 'lure') return throwLure(crew, s, pl, it, eye, dir, t, more.fuse);
  if (type === 'receiver') return useReceiver(crew, s, pl, it, eye, t, more.door);
  switch (d.use) {
    case 'throw': {
      if (t - (s.lastAct[pl.id] ?? 0) < 400) return { ok: false };
      s.lastAct[pl.id] = t;
      const sp = num('bottleSpeed', 11), up = num('bottleUp', 2.2);
      const p: Vec3 = [eye[0] + dir[0] * 0.35, eye[1] - 0.1, eye[2] + dir[2] * 0.35];
      if (!losClear(s, eye[0], eye[2], p[0], p[2])) { p[0] = eye[0]; p[2] = eye[2]; }
      s.thrown.push({ id: `thrown:${s.nextId++}`, p, v: [dir[0] * sp, dir[1] * sp + up, dir[2] * sp], t: 0, by: pl.id, item: it.type });
      used();
      spent();
      fx(crew, 'throw', { p: eye, pid: pl.id, item: type });
      return { ok: true };
    }
    case 'swing': {
      if (t - (s.lastAct[pl.id] ?? 0) < num('crowbarCooldownMs', 650)) return { ok: false };
      s.lastAct[pl.id] = t;
      used();
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
      used({ p });
      spent();
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
      used();
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
      used();
      spent();
      fx(crew, 'throw', { p: eye, pid: pl.id, item: 'flare' });
      return { ok: true };
    }
    case 'sensor': {
      if (t - (s.lastAct[pl.id] ?? 0) < 400) return { ok: false };
      s.lastAct[pl.id] = t;
      const p = dropPoint(s, pl, 0.7);
      const placed = newItem(s, 'sensor', { p: [p[0], 0, p[2]], rot: pl.pose.yaw, count: 1, armed: true });
      s.heldOnce.add(placed.id);
      markItem(s, placed.id);
      used({ p });
      spent();
      fx(crew, 'sensor', { p, pid: pl.id, id: placed.id });
      return { ok: true, msg: `Motion sensor armed: the van console sees movement within ${num('sensorRangeM', 6)} m` };
    }
    case 'inject': {
      if (t - (s.lastAct[pl.id] ?? 0) < 400) return { ok: false };
      s.lastAct[pl.id] = t;
      used();
      spent();
      // stamina is client-side: the injector's client turns stamina drain off for adrenalineSec (fx 'inject')
      fx(crew, 'inject', { p: eye, pid: pl.id, id: it.id });
      return { ok: true, msg: `ADRENALINE: ${num('adrenalineSec', 15)} s of sprint without getting tired` };
    }
    case 'battery': {
      // v1.2: the flashlight battery is client-side; fx 'battery' tells the owner's client to swap it to 100%
      if (t - (s.lastAct[pl.id] ?? 0) < 400) return { ok: false };
      s.lastAct[pl.id] = t;
      used();
      spent();
      fx(crew, 'battery', { p: eye, pid: pl.id, id: iid, count: s.items[iid]?.count ?? 0 });
      return { ok: true, msg: 'Fresh battery: flashlight at 100%' };
    }
    case 'flash': {
      // v1.2 flashbulb: lights a 14 m / 25 deg cone (LOS) for flashMs, a 6 m pop; monsters subscribe to the use event
      const fk = `${pl.id}:flash`;
      if (t - (s.lastAct[fk] ?? 0) < num('flashCooldownMs', 1200) || t - (s.lastAct[pl.id] ?? 0) < 300) return { ok: false };
      s.lastAct[pl.id] = s.lastAct[fk] = t;
      const id = `flash${s.nextId++}`;
      const hd: Vec3 = norm3([dir[0], 0, dir[2]]);
      flashesOf(s)[id] = { p: [eye[0], eye[1], eye[2]], dir: [hd[0], dir[1], hd[2]], until: t + num('flashMs', 2000), by: pl.id };
      markFlash(s, id);
      used();
      spent();
      fx(crew, 'flash', { p: eye, pid: pl.id, id, dir });
      noise(crew, eye[0], eye[2], num('flashNoiseM', 6), 'flash', pl.id);
      return { ok: true };
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
    if (impact && th.item === 'lure') landLure(crew, s, th, impact);
    else if (impact && th.item === 'flare') {
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

// ---------------------------------------------------------------- v1.3 F3: noise lure + field receiver

/** fx kind of a lure rattle (count = which rattle, open = the first). TODO(integrator): add 'lure' to IxFxKind in
 *  packages/shared/src/messages/interaction.ts (additive); until then the string is cast (only interaction's client
 *  reads interaction.fx). */
export const LURE_FX = 'lure' as string as IxFxKind;

/** the fuse a thrower asked for (s): one of lureFuseSec (default 0 / 5 / 10 / 20), anything else = on landing */
export function lureFuse(v: unknown): number {
  const raw = bal().lureFuseSec;
  const allowed = Array.isArray(raw) && raw.every((x) => typeof x === 'number' && Number.isFinite(x) && x >= 0) ? (raw as number[]) : [0, 5, 10, 20];
  const n = Number(v);
  return Number.isFinite(n) && allowed.includes(n) ? n : 0;
}

/** LMB with a noise lure: thrown like a bottle (lureSpeed / lureUp), landing armed with the thrower's fuse */
function throwLure(crew: Crew, s: IxSlice, pl: ServerPlayer, it: ItemState, eye: Vec3, dir: Vec3, t: number, fuseIn: unknown): IxResult {
  if (!flagOn(F3_FLAGS.lure)) return { ok: false, msg: 'The noise lure is not cleared for site use yet' };
  if (t - (s.lastAct[pl.id] ?? 0) < 400) return { ok: false };
  s.lastAct[pl.id] = t;
  const fuse = lureFuse(fuseIn);
  const sp = num('lureSpeed', 10), up = num('lureUp', 2.2);
  const p: Vec3 = [eye[0] + dir[0] * 0.35, eye[1] - 0.1, eye[2] + dir[2] * 0.35];
  if (!losClear(s, eye[0], eye[2], p[0], p[2])) { p[0] = eye[0]; p[2] = eye[2]; }
  s.thrown.push({ id: `thrown:lure:${s.nextId++}`, p, v: [dir[0] * sp, dir[1] * sp + up, dir[2] * sp], t: 0, by: pl.id, item: 'lure', fuse });
  emitItem(crew, { kind: 'use', pid: pl.id, type: 'lure', id: it.id, p: eye, dir });
  consumeOne(s, it);
  emitItem(crew, { kind: 'consume', pid: pl.id, type: 'lure', id: it.id, count: 1 });
  fx(crew, 'throw', { p: eye, pid: pl.id, item: 'lure' });
  return { ok: true, ...(fuse > 0 ? { msg: `Noise lure: it rattles ${fuse} s after it lands` } : {}) };
}

/** a thrown lure lands: a world item (armed: true, E picks it back up) whose rattles start fuse s later. Off a wall it
 *  drops back 0.35 m towards the thrower (as a flare does). A faint landing knock (lureLandNoiseM, below every
 *  monster's hearing threshold). */
function landLure(crew: Crew, s: IxSlice, th: Thrown, impact: Vec3): void {
  const hv = Math.hypot(th.v[0], th.v[2]);
  if (impact[1] > 0.05 && hv > 0.01) {
    const bx = impact[0] - (th.v[0] / hv) * 0.35, bz = impact[2] - (th.v[2] / hv) * 0.35;
    if (losClear(s, impact[0], impact[2], bx, bz)) { impact[0] = bx; impact[2] = bz; }
  }
  const rot = hv > 0.01 ? Math.atan2(th.v[0], th.v[2]) : 0;
  const it = newItem(s, 'lure', { p: [impact[0], 0, impact[2]], rot, count: 1, armed: true });
  s.heldOnce.add(it.id);
  markItem(s, it.id);
  const fuse = Math.max(0, Number(th.fuse) || 0);
  luresOf(s).set(it.id, { id: it.id, by: th.by, at: now() + fuse * 1000, n: 0 });
  fx(crew, 'drop', { p: [impact[0], 0.05, impact[2]], pid: th.by, item: 'lure', id: it.id, count: fuse });
  const land = num('lureLandNoiseM', 2);
  if (land > 0) noise(crew, impact[0], impact[2], land, 'landThud', it.id);
}

/** per tick: armed lures rattle lureRattles times over lureSpanSec (a lureNoiseM 'lure' noise each, source = the
 *  lure's item id: monsters go to the lure, never to its thrower); a lure picked back up stops; the last rattle uses it
 *  up */
function tickLures(crew: Crew, s: IxSlice, t: number): void {
  const runs = luresOf(s);
  // the flag is the kill switch: armed lures go quiet (they stay armed and pick up where they were if it comes back)
  if (!runs.size || !flagOn(F3_FLAGS.lure)) return;
  const total = Math.max(1, Math.round(num('lureRattles', 3)));
  const gap = total > 1 ? (num('lureSpanSec', 8) * 1000) / (total - 1) : 0;
  for (const [id, run] of runs) {
    const it = s.items[id];
    if (!it || it.where !== 'world' || !it.armed || !it.p) { runs.delete(id); continue; }
    if (t < run.at) continue;
    run.n++;
    const [x, , z] = it.p;
    noise(crew, x, z, num('lureNoiseM', 12), 'lure', id);
    fx(crew, LURE_FX, { p: [x, 0.1, z], pid: run.by, id, count: run.n, open: run.n === 1 });
    if (run.n >= total) {
      runs.delete(id);
      deleteItem(s, id);
    } else run.at += gap;
  }
}

/** the space on the far side of a door from (px, pz): the cell across its edge (-1 = none) */
export function farSpaceOf(crew: Crew, g: DoorGeom, px: number, pz: number): number {
  if (g.dir === 'v') return spaceAtXZ(crew, g.cx + (px < g.cx ? 0.5 : -0.5), g.cz);
  return spaceAtXZ(crew, g.cx, g.cz + (pz < g.cz ? 0.5 : -0.5));
}

/** LMB with the field receiver (one charge = a receiverListenSec listen, contracts only); door = ear to a closed door
 *  within reach: the client also hears what is in the space behind it */
function useReceiver(crew: Crew, s: IxSlice, pl: ServerPlayer, it: ItemState, eye: Vec3, t: number, doorIn: unknown): IxResult & { listen?: ListenGrant } {
  if (!flagOn(F3_FLAGS.receiver)) return { ok: false, msg: 'The field receiver is not cleared for site use yet' };
  if (crew.phase !== 'contract') return { ok: false, msg: 'Nothing on the air here: use it on a site' };
  if ((listeningOf(s)[pl.id] ?? 0) > t) return { ok: false, msg: 'Still listening' };
  if (t - (s.lastAct[pl.id] ?? 0) < 400) return { ok: false };
  let door: number | undefined;
  let space: number | undefined;
  if (doorIn !== undefined && doorIn !== null) {
    const id = Number(doorIn);
    const g = Number.isInteger(id) ? s.doorGeom.get(id) : undefined;
    const st = g ? s.doors[id] : undefined;
    if (!g || !st || g.kind === 'open' || g.kind === 'blocked') return { ok: false, msg: 'Nothing to listen through' };
    if (st.open) return { ok: false, msg: 'It is open: just listen' };
    const why = canReach(s, pl, { kind: 'door', p: [g.cx, 1.1, g.cz], ref: id });
    if (why) return { ok: false, msg: why };
    door = id;
    space = farSpaceOf(crew, g, pl.pose.p[0], pl.pose.p[2]);
  }
  s.lastAct[pl.id] = t;
  const ms = Math.round(Math.max(1, num('receiverListenSec', 6)) * 1000);
  const left = spendOne(crew, s, pl.id, it, eye);
  listeningOf(s)[pl.id] = t + ms;
  const grant: ListenGrant = { ms, until: t + ms, ...(door !== undefined ? { door, space } : {}) };
  const what = door !== undefined ? 'Ear to the door' : 'Listening';
  return { ok: true, msg: `${what}: ${ms / 1000} s · ${left} charge${left === 1 ? '' : 's'} left`, listen: grant };
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
  emitItem(crew, { kind: 'use', pid: pl.id, type: 'medkit', id: kit.id, p: body.p });
  deleteItem(s, kit.id);
  emitItem(crew, { kind: 'consume', pid: pl.id, type: 'medkit', id: kit.id, count: 1 });
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
  cancelEase(s, pid);
  if (nvOf(s)[pid]) { delete nvOf(s)[pid]; markNv(s, pid); }
  delete listeningOf(s)[pid];
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
  // v1.2: the salvage pouch drops as one item (it merges into whoever picks it up)
  dropPouch(crew, s, pid, [p[0] + 0.3, 0, p[2] - 0.25]);
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

/** pid's salvage pouch as a world item (death, leaving mid-contract); its contents in ItemState.mats */
function dropPouch(crew: Crew, s: IxSlice, pid: string, at: Vec3): ItemState | null {
  const pouch = pouchesOf(s)[pid];
  delete pouchesOf(s)[pid];
  markPouch(s, pid);
  if (!pouch || !Object.values(pouch).some((n) => n > 0) || crew.phase !== 'contract') return null;
  const name = crew.players.get(pid)?.name;
  const it = newItem(s, POUCH_TYPE, { p: [at[0], 0, at[2]], mats: { ...pouch }, ...(name ? { name: `${name}'s salvage pouch` } : {}) });
  s.heldOnce.add(it.id);
  markItem(s, it.id);
  return it;
}

/** pid's pouch into the van stash: fx 'stash' and one 'stash' item event per material (never the deposit listeners) */
function stashPouch(crew: Crew, s: IxSlice, pid: string): number {
  const pouch = pouchesOf(s)[pid];
  if (!pouch) return 0;
  delete pouchesOf(s)[pid];
  markPouch(s, pid);
  let units = 0;
  const moved: [string, number][] = [];
  for (const [k, n] of Object.entries(pouch)) {
    if (!isMaterial(k) || !(n > 0)) continue;
    s.vanMats[k] = (s.vanMats[k] ?? 0) + n;
    units += n;
    moved.push([k, n]);
  }
  if (!units) return 0;
  const pl = crew.players.get(pid);
  fx(crew, 'stash', { p: pl ? [pl.pose.p[0], 1, pl.pose.p[2]] : undefined, pid, count: units });
  for (const [k, n] of moved) emitItem(crew, { kind: 'stash', pid, type: k, id: `pouch:${pid}`, count: n });
  return units;
}

/** materials in the van: the deposited stash + mat.* / pouch items in the cargo rect (+-0.6 m) + the pouches of living
 *  players inside it (the timeout path skips the deposit). take = remove them (G5 at contract end). */
export function vanMaterialsOf(crew: Crew, take: boolean): Record<string, number> {
  const s = slice(crew);
  const out: Record<string, number> = {};
  const add = (k: string, n: unknown) => {
    const v = Math.round(Number(n) || 0);
    if (isMaterial(k) && v > 0) out[k] = (out[k] ?? 0) + v;
  };
  for (const [k, n] of Object.entries(s.vanMats)) add(k, n);
  const c = crew.layout?.van?.cab;
  const inRect = (x: number, z: number, pad: number) => !!c && x >= c.x - pad && x <= c.x + c.w + pad && z >= c.y - pad && z <= c.y + c.h + pad;
  for (const it of Object.values(s.items)) {
    if (it.where !== 'world' || !it.p || !inRect(it.p[0], it.p[2], 0.6)) continue;
    if (isMaterial(it.type)) add(it.type, it.count ?? 1);
    else if (it.type === POUCH_TYPE) for (const [k, n] of Object.entries(it.mats ?? {})) add(k, n);
    else continue;
    if (take) deleteItem(s, it.id);
  }
  for (const pl of crew.players.values()) {
    const pouch = pouchesOf(s)[pl.id];
    if (!pouch || !pl.alive || s.dead.includes(pl.id) || !inRect(pl.pose.p[0], pl.pose.p[2], 0.3)) continue;
    for (const [k, n] of Object.entries(pouch)) add(k, n);
    if (take) { delete pouchesOf(s)[pl.id]; markPouch(s, pl.id); }
  }
  if (take) clearObj(s.vanMats);
  return out;
}

/** meta's recordStat (guarded: meta absent / throwing is fine) */
export function stat(crew: Crew, pid: string, key: string, n = 1): void {
  const fn = adapters.meta?.recordStat;
  if (typeof fn === 'function') safe('recordStat', () => (fn as (c: Crew, p: string, k: string, n?: number) => void)(crew, pid, key, n));
}

/** van upgrade owned by the crew (meta unlocks; workshop) */
export function unlocked(crew: Crew, id: string): boolean {
  const fn = adapters.meta?.unlocks;
  if (typeof fn !== 'function') return false;
  const r = safe('unlocks', () => (fn as (c: Crew) => unknown)(crew));
  return Array.isArray(r) && r.includes(id);
}

/** 'interaction.nv': night vision on/off (needs a night-vision module in any slot; flag nightVision) */
export function setNightVision(crew: Crew, pl: ServerPlayer, on: boolean): IxResult & { on?: boolean } {
  const s = slice(crew);
  const p: Vec3 = [pl.pose.p[0], 1.5, pl.pose.p[2]];
  if (on) {
    if (!flag('nightVision')) return { ok: false, msg: 'Night vision is offline', on: false };
    if (!pl.alive || s.dead.includes(pl.id)) return { ok: false, on: false };
    const nvg = itemsOfPid(s, pl.id).find((it) => it.type === 'nvg');
    if (!nvg) return { ok: false, msg: 'Needs a night-vision module', on: false };
    if (!nvOf(s)[pl.id]) {
      nvOf(s)[pl.id] = true;
      markNv(s, pl.id);
      fx(crew, 'nv', { p, pid: pl.id, open: true });
      emitItem(crew, { kind: 'use', pid: pl.id, type: 'nvg', id: nvg.id, p });
    }
  } else if (nvOf(s)[pl.id]) {
    delete nvOf(s)[pl.id];
    markNv(s, pl.id);
    fx(crew, 'nv', { p, pid: pl.id, open: false });
  }
  return { ok: true, on: !!nvOf(s)[pl.id] };
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
  // v1.2: the salvage pouch goes into the van stash (materials never reach the deposit listeners / the haul)
  stashPouch(crew, s, pid);
  if (out.length) {
    const pl = crew.players.get(pid);
    fx(crew, 'deposit', { p: pl ? [pl.pose.p[0], 1, pl.pose.p[2]] : undefined, pid });
    if (bonus > 0) fx(crew, 'lucky', { p: pl ? [pl.pose.p[0], 1.2, pl.pose.p[2]] : undefined, pid, item: String(bonus) });
    for (const it of out) emitItem(crew, { kind: 'deposit', pid, type: it.type, id: it.id, ...(it.name ? { name: it.name } : {}), value: it.value ?? 0 });
    for (const fn of depositFns) safe('onDeposit', () => fn(crew, pid, out));
  }
  return out;
}

function deposit(crew: Crew, s: IxSlice, pl: ServerPlayer, intId: string): IxResult {
  let did = false;
  const t = now();
  // v1.2 stretcher (van upgrade): a filed badge brings them back sooner and in better shape
  const stretcher = unlocked(crew, 'stretcher');
  for (const it of itemsOfPid(s, pl.id)) {
    if (it.type !== 'badge' || !it.owner) continue;
    removeFromInv(s, it.id);
    it.where = 'van';
    delete it.p;
    markItem(s, it.id);
    if (s.dead.includes(it.owner)) {
      s.respawns[it.owner] = t + (stretcher ? num('stretcherReviveSec', 8) : num('badgeReviveSec', 20)) * 1000;
      s.respawnInfo[it.owner] = { hp: stretcher ? num('stretcherReviveHp', 75) : num('reviveHp', 50), by: pl.id };
      markRespawn(s, it.owner);
    }
    // the badge filer (meta badgesFiled)
    emitItem(crew, { kind: 'deposit', pid: pl.id, type: 'badge', id: it.id, ...(it.name ? { name: it.name } : {}), value: 0 });
    did = true;
  }
  if (did) fx(crew, 'deposit', { p: [pl.pose.p[0], 1, pl.pose.p[2]], pid: pl.id });
  const mats = stashPouch(crew, s, pl.id);
  const r = runHandlers(crew, pl, 'deposit', intId);
  if (r && r.ok) return r;
  const loot = depositLootOf(crew, pl.id);
  const matMsg = mats ? ` · ${mats} material${mats > 1 ? 's' : ''} to the stash` : '';
  if (loot.length) {
    const v = loot.reduce((a, it) => a + (it.value ?? 0), 0);
    return { ok: true, msg: `Deposited ${loot.length} item${loot.length > 1 ? 's' : ''} ($${v})${matMsg}` };
  }
  if (did) return { ok: true, msg: `Badge filed: they respawn at the van shortly${matMsg}` };
  if (mats) return { ok: true, msg: `Stashed ${mats} material${mats > 1 ? 's' : ''} for the workbench` };
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
    // a locker: E leaves it; a programmatic spot (crawl vent) is left through its owner (players)
    if (s.ints[s.hidden[pl.id]]?.kind !== 'locker') return { ok: false };
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
    case 'container':
      return tapContainer(crew, s, pl, inf);
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

/** held item types that survive the end of a contract (pool gear: meta's GEAR_TYPES; overshoes wear out) */
const CARRY_OVER_TYPES = new Set<string>(POOL_TYPES);

/** v1.2 per-contract state: hold-E runs, pouches, the van stash, night vision, flashes, pending drawer spawns */
function resetContractState(s: IxSlice): void {
  for (const pid of Object.keys(s.easing)) cancelEase(s, pid);
  for (const pid of Object.keys(pouchesOf(s))) { delete pouchesOf(s)[pid]; markPouch(s, pid); }
  for (const pid of Object.keys(nvOf(s))) { delete nvOf(s)[pid]; markNv(s, pid); }
  for (const id of Object.keys(flashesOf(s))) { delete flashesOf(s)[id]; markFlash(s, id); }
  clearObj(s.vanMats);
  clearObj(s.respawnInfo);
  s.pendingSpawns.length = 0;
  // v1.3: no lure keeps rattling and no listen carries over into the next contract
  luresOf(s).clear();
  clearObj(listeningOf(s));
}

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
  resetContractState(s);
  ctx?.crews.broadcastRoster(crew);
}

export function onPhase(crew: Crew, from: string, to: string): void {
  const before = (crew.slices[TRACK] as IxSlice | undefined)?.layoutKey ?? null;
  const s = slice(crew); // rebuilds on a layout change (patch.reset)
  const relayout = before !== s.layoutKey;
  // leaving the contract, or a new facility while still in 'contract' (dbg restart): nobody stays dead
  if (from === 'contract' && (to !== 'contract' || relayout)) endContract(crew, s);
  // v1.2: pouches and the van stash start empty every contract
  if (to === 'contract' && from !== 'contract') {
    resetContractState(s);
    s.heldOnce.clear();
    for (const it of Object.values(s.items)) if (it.where === 'held') s.heldOnce.add(it.id);
  }
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
  cancelEase(s, pl.id);
  if (nvOf(s)[pl.id]) { delete nvOf(s)[pl.id]; markNv(s, pl.id); }
  dropPouch(crew, s, pl.id, [pl.pose.p[0], 0, pl.pose.p[2]]);
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
    if (s.ints[l]?.kind === 'locker' || s.layoutItems.get(l)?.kind === 'hiding') {
      const f = lockerFront(s, l);
      if (f) pose.p = [f[0], pose.p[1], f[2]];
    } else (pose as { light?: number }).light = 0; // a crawl vent (players moves them): no flashlight in a duct
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
  tickLures(crew, s, t);
  for (const [pid, at] of Object.entries(s.respawns)) {
    if (t >= at) {
      delete s.respawns[pid];
      markRespawn(s, pid);
      const info = s.respawnInfo[pid];
      delete s.respawnInfo[pid];
      reviveSelf(crew, pid, null, { how: 'badge', by: null, ...(info ? { hp: info.hp } : {}) });
    }
  }
  // v1.2: hold-E runs, tapped drawers' contents, night vision without a module, burnt-out flashes
  tickEase(crew, s, t);
  if (s.pendingSpawns.length) {
    const due = s.pendingSpawns.filter((x) => t >= x.at);
    if (due.length) {
      s.pendingSpawns = s.pendingSpawns.filter((x) => t < x.at);
      for (const x of due) spawnContents(crew, s, x.cid);
    }
  }
  for (const pid of Object.keys(nvOf(s))) {
    const pl = crew.players.get(pid);
    if (!pl || !pl.connected || !pl.alive || s.dead.includes(pid) || !hasType(s, pid, 'nvg') || !flag('nightVision')) {
      delete nvOf(s)[pid];
      markNv(s, pid);
    }
  }
  for (const [id, f] of Object.entries(flashesOf(s))) if (t >= f.until) { delete flashesOf(s)[id]; markFlash(s, id); }
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

/** v1.3 F3 (dev / tests): the armed lures' schedules and the receiver listens */
export function f3Peek(crew: Crew): { lures: LureRun[]; listening: Record<string, number> } {
  const s = slice(crew);
  return { lures: [...luresOf(s).values()].map((r) => ({ ...r })), listening: { ...listeningOf(s) } };
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
