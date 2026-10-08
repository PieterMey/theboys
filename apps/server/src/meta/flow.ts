// Owner: track (d) Meta. Phase orchestration + economy + careers + saves (PLAN §1, §3.6, §4.11).
//   hub (board, ready, shop, creator) -> drive (6 s, rule cards) -> contract (② layout, (a) objectives, (c) monsters)
//   -> results (on (a) onContractEnd; per-contract results) -> hub; after 3 contracts: quota check + HR memo.
import type { Crew, ServerContext, ServerPlayer } from '../core/types.ts';
import { isObserver, playerIdFromKey } from '../core/crews.ts';
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import type { WorkOrder } from '@dead-air/shared/workorder.ts';
import type { ContractResult, CrewSave, PlayerSave } from '@dead-air/shared/saves.ts';
import type { CrewRecords, ShiftStatLine } from '@dead-air/shared/progress.ts';
import type { Profile } from '@dead-air/shared/profile.ts';
import { HELMET_UNLOCK_LEVEL, PROFILE_LIMITS, VISOR_COLORS } from '@dead-air/shared/profile.ts';
import type {
  MetaContractResults, MetaDeathCard, MetaHeardDid, MetaShiftReview, MetaShopItem, MetaState, MetaXpLine,
} from '@dead-air/shared/messages/meta.ts';
import { INV_SLOTS } from '@dead-air/shared/interactables.ts';
import type { InteractableInfo } from '@dead-air/shared/interactables.ts';
import { v12Id } from '@dead-air/shared/catalog.ts';
import { stationOf } from '@dead-air/shared/procgen/van.ts';
import {
  badgeFines, economyFrom, firstQuota, levelFor, nextLevelXp, nextQuota, overtime, playerMult, quotaMet,
} from './economy.ts';
import type { Economy } from './economy.ts';
import { makeBoard, refreshAvailability } from './orders.ts';
import { DRIVE_CHATTER, ruleCards } from './templates.ts';
import { mergeAiReview, templateReview } from './review.ts';
import type { ReviewInput } from './review.ts';
import { SaveStore, hashPin, newPin } from './saves.ts';
import * as A from './adapters.ts';
import {
  addUnits, allot, handoutOrder, isCarryType, isPoolType, migrateOwners, normalizeUnits, poolSlots, realType, stackOf, stacks,
} from './pool.ts';
import type { Units } from './pool.ts';
import {
  LEFT_BEHIND, beginContractStats, commitContract, commitShift, discardContractStats, emptyShiftLine, killerKey, recordStat, statsTick,
} from './stats.ts';
import {
  craftContractEnd, craftContractStart, craftFired, craftSave, craftView, loadCraft, workbenchInteractables,
} from './crafting.ts';
import type { CraftSave } from './crafting.ts';

// ---------------------------------------------------------------- types

export interface MetaCrew {
  shift: CrewSave['shift'] & { quotaLocked: boolean };
  /** v1.2: SAVE id ('crew' = company gear) -> item type -> units (key order = recency, newest last) */
  gear: Record<string, Record<string, number>>;
  /** v1.2: this contract's hand-out: save id -> units held back in the locker (merged back by collectGear) */
  handout: { keep: Record<string, Units> } | null;
  orders: WorkOrder[];
  boardSeq: number;
  picked: string | null;
  active: WorkOrder | null;
  pendingLayout: LevelLayout | null;
  driveEndsAt: number;
  contractId: number;
  contractStartedAt: number;
  ended: boolean;
  results: MetaContractResults | null;
  review: MetaShiftReview | null;
  resultsEndsAt: number;
  history: ContractResult[];
  contractsDone: number;
  recentSites: string[];
  holdUntil: number;
  holdBy: string | null;
  /** live speaker id -> lines the Listener overheard this shift (memory only, never saved) */
  quotes: Record<string, string[]>;
  /** v1.2: running shift per SAVE id (persisted as CrewSave.shiftStats: the HR memo survives a restart) */
  shiftStats: Record<string, ShiftStatLine>;
  /** v1.2: crew records (persisted as CrewSave.records) */
  records: CrewRecords | null;
  deaths: MetaDeathCard[];
  members: string[];
  /** players connected when the current contract started */
  participants: string[];
  dirty: boolean;
  hubStarted: boolean;
  /** our own setPhase is running (phase hook ignores it) */
  transition: boolean;
}

export interface MetaPlayer {
  saveId: string;
  /** plaintext PIN known this session (only its hash is stored) */
  pin: string | null;
  claimFails: number[];
}

type ShiftEndFn = (crew: Crew, review: MetaShiftReview) => void;

// ---------------------------------------------------------------- runtime

export interface MetaRuntime {
  ctx: ServerContext;
  store: SaveStore;
  shiftEndFns: ShiftEndFn[];
}

let RT: MetaRuntime | null = null;
export function runtime(): MetaRuntime | null {
  return RT;
}
export function setRuntime(r: MetaRuntime): void {
  RT = r;
}

const ctxOf = (): ServerContext => {
  if (!RT) throw new Error('meta not installed');
  return RT.ctx;
};

const mb = (): Record<string, unknown> => (ctxOf().balance.meta ?? {}) as Record<string, unknown>;
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
export const econ = (): Economy => economyFrom(ctxOf().balance.core, mb());

export function shopItems(): MetaShopItem[] {
  const list = mb().shop;
  if (Array.isArray(list) && list.length) return list as MetaShopItem[];
  return [
    { id: 'walkie', name: 'Walkie-talkie', price: 40, type: 'walkie', qty: 1, desc: 'Radio channel. Hold Q.' },
    { id: 'crowbar', name: 'Crowbar', price: 30, type: 'crowbar', qty: 1, desc: 'Frees a grabbed teammate.' },
    { id: 'bottles', name: 'Bottles x3', price: 15, type: 'bottle', qty: 3, desc: 'Hound bait.' },
    { id: 'glowsticks', name: 'Glowsticks x5', price: 10, type: 'glowstick', qty: 5, desc: 'Keeps a Mannequin lit.' },
    { id: 'medkit', name: 'Medkit', price: 45, type: 'medkit', qty: 1, desc: 'Revive within 30 s.' },
  ];
}

// v1.2 gear pool: GEAR_TYPES = POOL_TYPES (carry-over, see pool.ts isCarryType), GEAR_STACK = POOL_STACK (pool.ts
// stackOf). Shop packs ('pro-flashlight', 'flares', 'motion-sensors') enter the pool as their real item types.
const VISOR_NAMES = ['CYAN', 'RED', 'ACID', 'AMBER', 'PINK', 'WHITE'];

/** hand-out cap per player (inventory slots; plan check #21: 3 of the 4 so a pickup always fits) */
export function handoutSlots(): number {
  return Math.max(0, Math.min(INV_SLOTS, Math.round(num(mb().handoutSlots, 3))));
}
/** locker cap per player (slot-equivalents, POOL_STACK) */
export function maxPoolSlots(): number {
  return Math.max(1, Math.round(num(mb().maxPoolSlots, 8)));
}
export function loadoutMax(): number {
  return Math.max(1, Math.round(num(mb().loadoutMax, 12)));
}

export function visorUnlockLevel(i: number): number {
  const t = mb().visorUnlockLevel;
  const arr = Array.isArray(t) ? (t as number[]) : [1, 1, 1, 2, 3, 4];
  return num(arr[i], 1);
}

// ---------------------------------------------------------------- slices

export function S(crew: Crew): MetaCrew {
  let s = crew.slices.meta as MetaCrew | undefined;
  if (s) return s;
  const e = econ();
  const saved = RT?.store.crew(crew.code) ?? null;
  s = {
    shift: saved
      ? { ...saved.shift, gear: saved.shift.gear ?? {}, quotaLocked: saved.shift.contract > 0 || saved.shift.index > 0 }
      : { index: 0, contract: 0, quota: firstQuota(e, 1), hauled: 0, balance: e.startScrip, gear: {}, quotasMet: 0, quotaLocked: false },
    gear: {},
    handout: null,
    orders: [],
    boardSeq: 0,
    picked: null,
    active: null,
    pendingLayout: null,
    driveEndsAt: 0,
    contractId: 0,
    contractStartedAt: 0,
    ended: true,
    results: null,
    review: null,
    resultsEndsAt: 0,
    history: saved?.history ?? [],
    contractsDone: saved?.history?.length ?? 0,
    recentSites: (saved?.history ?? []).slice(-6).map((h) => h.orderId.split('|')[1] ?? '').filter(Boolean),
    holdUntil: 0,
    holdBy: null,
    quotes: {},
    shiftStats: saved?.shiftStats && typeof saved.shiftStats === 'object' ? restoreShiftStats(saved.shiftStats) : {},
    records: saved?.records && typeof saved.records === 'object' ? { ...saved.records } : null,
    deaths: [],
    members: saved?.members ?? [],
    participants: [],
    dirty: true,
    hubStarted: false,
    transition: false,
  };
  // gear persisted as CrewSave.shift.gear: 'owner|type' -> units. v1.1 owners were live ids: re-keyed to save ids
  // (playerIdFromKey of each save key), shop packs to real units
  const raw: Record<string, Units> = {};
  for (const [k, n] of Object.entries(s.shift.gear)) {
    const [owner, type] = k.includes('|') ? k.split('|') : ['crew', k];
    (raw[owner] ??= {})[type] = n;
  }
  const owners = RT ? migrateOwners(raw, RT.store.allPlayers(), playerIdFromKey) : raw;
  for (const [owner, units] of Object.entries(owners)) {
    const u = normalizeUnits(units);
    if (Object.keys(u).length) s.gear[owner] = u;
  }
  if (!saved) (s.gear.crew ??= {}).walkie = num(mb().freeWalkiesPerShift, 2);
  crew.slices.meta = s;
  // v1.2 workshop: stash + unlocks (null = a brand-new crew)
  try {
    loadCraft(crew, saved ? { stash: { ...(saved.stash ?? {}) }, unlocks: [...(saved.unlocks ?? [])] } : null);
  } catch (err) {
    RT?.ctx.log('meta').warn('loadCraft threw:', err instanceof Error ? err.message : err);
  }
  return s;
}

function restoreShiftStats(saved: Record<string, ShiftStatLine>): Record<string, ShiftStatLine> {
  const out: Record<string, ShiftStatLine> = {};
  for (const [sid, l] of Object.entries(saved)) {
    if (!l || typeof l !== 'object') continue;
    const z = emptyShiftLine();
    for (const k of Object.keys(z) as (keyof ShiftStatLine)[]) z[k] = num(l[k], 0);
    out[sid] = z;
  }
  return out;
}

export function P(player: ServerPlayer): MetaPlayer {
  let p = player.slices.meta as MetaPlayer | undefined;
  if (!p) player.slices.meta = p = { saveId: player.id, pin: null, claimFails: [] };
  return p;
}

const connected = (crew: Crew): ServerPlayer[] => [...crew.players.values()].filter((p) => p.connected);

export function saveOf(player: ServerPlayer): PlayerSave | null {
  return RT?.store.playerById(P(player).saveId) ?? null;
}

function avgLevel(crew: Crew): number {
  const ps = connected(crew);
  if (!ps.length) return 1;
  return ps.reduce((a, p) => a + (p.level || 1), 0) / ps.length;
}

function crewAchievements(crew: Crew): string[] {
  const set = new Set<string>();
  for (const p of crew.players.values()) for (const a of saveOf(p)?.achievements ?? []) set.add(a);
  return [...set];
}

// ---------------------------------------------------------------- view + broadcast

export function view(crew: Crew, player: ServerPlayer | null): MetaState {
  const s = S(crew);
  const e = econ();
  const careers: MetaState['careers'] = {};
  for (const p of crew.players.values()) {
    const sv = saveOf(p);
    careers[p.id] = { xp: sv?.xp ?? 0, level: sv?.level ?? p.level ?? 1 };
  }
  // the gear pool is keyed by save id: clients read it by live id (board.tsx, plan check #24h)
  const gear: Record<string, Record<string, number>> = {};
  if (s.gear.crew) gear.crew = s.gear.crew;
  for (const p of crew.players.values()) {
    const g = s.gear[P(p).saveId];
    if (g) gear[p.id] = g;
  }
  const flags = ctxOf().flags;
  const st: MetaState = {
    shift: {
      index: s.shift.index, contract: s.shift.contract, quota: s.shift.quota, hauled: s.shift.hauled,
      balance: s.shift.balance, quotasMet: s.shift.quotasMet, contractsPerShift: e.contractsPerShift,
    },
    careers,
    shop: shopItems().map((i) => ({ id: i.id, name: i.name, price: i.price, desc: i.desc })),
    picked: s.picked,
    gear,
    drive: crew.phase === 'drive' && s.active
      ? {
          orderId: s.active.id, siteName: s.active.siteName, endsAt: s.driveEndsAt,
          rules: ruleCards(s.active.risk, s.active.risk >= 2 || s.shift.contract >= 2, {
            fair: flags.listenerFairV12 !== false,
            snatcher: flags.snatcher !== false && (s.active.risk >= 2 || s.shift.contract >= 1),
          }),
          chatter: DRIVE_CHATTER.map((l) => l
            .replace('{{SITE}}', s.active!.siteName.toUpperCase())
            .replace('{{QUOTA}}', String(s.shift.quota))
            .replace('{{HAULED}}', String(s.shift.hauled))
            .replace('{{CONTRACT}}', `${s.shift.contract + 1}/${e.contractsPerShift}`)),
        }
      : null,
    results: crew.phase === 'results' ? s.results : null,
    review: crew.phase === 'results' ? s.review : null,
    resultsEndsAt: crew.phase === 'results' ? s.resultsEndsAt : 0,
    avgLevel: Math.round(avgLevel(crew) * 10) / 10,
    achievements: crewAchievements(crew),
    serverInteract: A.has('interaction', 'onInteract'),
    contractsDone: s.contractsDone,
    continued: continuedIds(crew),
    holdUntil: s.holdUntil > ctxOf().now() ? s.holdUntil : 0,
  };
  // v1.2 workshop: crew stash + van upgrades (null = omit)
  let cv: CraftSave | null = null;
  try { cv = craftView(crew); } catch { cv = null; }
  if (cv) {
    st.stash = { ...cv.stash };
    st.unlocks = [...cv.unlocks];
  }
  // v1.2 personnel file: this shift so far (counters only)
  const lines = Object.entries(s.shiftStats);
  if (lines.length) {
    const live = new Map<string, ServerPlayer>();
    for (const p of crew.players.values()) live.set(P(p).saveId, p);
    st.shiftLines = lines.map(([sid, l]) => ({
      saveId: sid, player: live.get(sid)?.id ?? null, name: live.get(sid)?.name ?? RT?.store.playerById(sid)?.name ?? 'Contractor', ...l,
    }));
  }
  if (player) {
    const sv = saveOf(player);
    const p = P(player);
    const lvl = sv?.level ?? 1;
    st.you = {
      saveId: p.saveId,
      claim: p.pin && sv ? `${sv.profile.badge}-${p.pin}` : null,
      xp: sv?.xp ?? 0,
      level: lvl,
      nextLevelXp: nextLevelXp(e, lvl),
      achievements: sv?.achievements ?? [],
    };
  }
  return st;
}

export function markDirty(crew: Crew): void {
  S(crew).dirty = true;
}

export function flushUpdates(crew: Crew): void {
  const s = S(crew);
  if (!s.dirty) return;
  s.dirty = false;
  const ctx = ctxOf();
  for (const p of connected(crew)) {
    ctx.emit(crew, 'meta.update', { meta: view(crew, p), workOrders: s.orders, activeOrder: s.active }, { to: [p.id] });
  }
}

// ---------------------------------------------------------------- saves

/**
 * Persist the crew. v1.2: starts from the previous save ({...prev, ...rebuilt}), so fields this build does not know (a
 * newer build, a flag that is off, a stub) survive; craftSave null keeps prev.stash/prev.unlocks. New data never goes
 * into `shift` (an older build rebuilds that object): shiftStats and records are top-level.
 */
export function saveCrew(crew: Crew): void {
  if (!RT) return;
  const s = S(crew);
  const gear: Record<string, number> = {};
  for (const [owner, types] of Object.entries(s.gear)) for (const [t, n] of Object.entries(types)) if (n > 0) gear[`${owner}|${t}`] = n;
  const members = new Set(s.members);
  for (const p of crew.players.values()) if (!isObserver(p)) members.add(P(p).saveId);
  s.members = [...members];
  const { quotaLocked: _q, ...shift } = s.shift;
  void _q;
  const prev = RT.store.crew(crew.code);
  const rebuilt: CrewSave = {
    code: crew.code,
    members: s.members,
    shift: { ...shift, gear },
    history: s.history.slice(-50),
    updatedAt: new Date().toISOString(),
    shiftStats: s.shiftStats,
  };
  if (s.records) rebuilt.records = s.records;
  let craft: CraftSave | null = null;
  try { craft = craftSave(crew); } catch (err) { RT.ctx.log('meta').warn('craftSave threw:', err instanceof Error ? err.message : err); }
  if (craft) {
    rebuilt.stash = { ...craft.stash };
    rebuilt.unlocks = [...craft.unlocks];
  }
  RT.store.putCrew({ ...(prev ?? {}), ...rebuilt });
}

function sanitizeProfile(p: Profile, level: number, prev: Profile): Profile {
  const hex = (v: unknown, d: string) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : d);
  const name = String(p?.name ?? prev.name).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, PROFILE_LIMITS.nameMax) || prev.name;
  let helmet = p?.helmet === 'box' || p?.helmet === 'diver' || p?.helmet === 'dome' ? p.helmet : prev.helmet;
  if ((HELMET_UNLOCK_LEVEL[helmet] ?? 1) > level) helmet = 'dome';
  let visorColor = hex(p?.visor?.color, prev.visor.color);
  const vi = (VISOR_COLORS as readonly string[]).indexOf(visorColor);
  if (vi >= 0 && visorUnlockLevel(vi) > level) visorColor = VISOR_COLORS[0];
  return {
    name,
    body: p?.body === 'f' ? 'f' : p?.body === 'm' ? 'm' : prev.body,
    suit: [hex(p?.suit?.[0], prev.suit[0]), hex(p?.suit?.[1], prev.suit[1])],
    helmet,
    visor: { glyphs: String(p?.visor?.glyphs ?? prev.visor.glyphs).replace(/[\u0000-\u001f<>]/g, '').slice(0, PROFILE_LIMITS.glyphsMax), color: visorColor },
    // the badge is canonical on the host (claim codes); clients cannot change it
    badge: prev.badge,
  };
}

/** join/resume: bind the browser key to a PlayerSave (create on first sight), apply saved profile + level */
export function attachPlayer(crew: Crew, player: ServerPlayer): void {
  if (!RT) return;
  const store = RT.store;
  const p = P(player);
  let sv = store.playerById(p.saveId) ?? store.playerByKey(player.key) ?? store.playerById(player.id);
  if (!sv) {
    const pin = newPin();
    const now = new Date().toISOString();
    sv = {
      id: player.id, keys: [player.key], name: player.name, pinHash: hashPin(player.id, pin), profile: { ...player.profile },
      xp: 0, level: 1, achievements: [], createdAt: now, updatedAt: now,
    };
    // badge numbers should be unique among saves (claim codes)
    const used = new Set(store.allPlayers().map((x) => x.profile.badge));
    let badge = sv.profile.badge;
    for (let i = 0; used.has(badge) && i < 2000; i++) badge = 100 + ((badge * 7 + 13 + i) % 9900);
    sv.profile.badge = badge;
    p.pin = pin;
    store.putPlayer(sv);
  }
  p.saveId = sv.id;
  if (!sv.keys.includes(player.key)) store.bindKey(player.key, sv);
  const prof = sanitizeProfile({ ...player.profile, badge: sv.profile.badge }, sv.level, { ...sv.profile, name: player.name });
  // distinct visor colours on join: if a crewmate already wears this one, take the first free colour this level allows
  const taken = new Set([...crew.players.values()].filter((o) => o.id !== player.id).map((o) => o.profile?.visor?.color));
  if (taken.has(prof.visor.color)) {
    const free = VISOR_COLORS.find((c, i) => !taken.has(c) && visorUnlockLevel(i) <= sv.level);
    if (free) prof.visor = { ...prof.visor, color: free };
  }
  player.profile = { ...prof, name: player.name };
  player.level = sv.level;
  if (sv.name !== player.name || JSON.stringify(sv.profile) !== JSON.stringify(player.profile)) {
    sv.name = player.name;
    sv.profile = { ...player.profile };
    store.putPlayer(sv);
  }
}

export function setProfile(crew: Crew, player: ServerPlayer, profile: Profile): { ok: boolean; profile: Profile; reason?: string } {
  const sv = saveOf(player);
  const level = sv?.level ?? player.level ?? 1;
  const want = profile as Partial<Profile>;
  const next = sanitizeProfile(profile, level, player.profile);
  let reason: string | undefined;
  if (want.helmet && want.helmet !== next.helmet) reason = `${String(want.helmet).toUpperCase()} helmet unlocks at level ${HELMET_UNLOCK_LEVEL[want.helmet as Profile['helmet']] ?? '?'}`;
  player.profile = next;
  player.name = next.name;
  if (sv) {
    sv.profile = { ...next };
    sv.name = next.name;
    RT?.store.putPlayer(sv);
  }
  ctxOf().crews.broadcastRoster(crew);
  return { ok: !reason, profile: next, reason };
}

/** 'claim': badge (or name) + 4-digit PIN -> rebind that saved profile to this browser's key */
export function claim(crew: Crew, player: ServerPlayer, who: string, pin0: string): { ok: boolean; level?: number; reason?: string; name?: string } {
  if (!RT) return { ok: false, reason: 'saves offline' };
  const p = P(player);
  const now = Date.now();
  p.claimFails = p.claimFails.filter((t) => now - t < 60_000);
  if (p.claimFails.length >= 5) return { ok: false, reason: 'too many attempts: wait a minute' };
  let id = String(who ?? '').trim();
  let pin = String(pin0 ?? '').trim();
  const m = /^#?(\d{1,5})\s*[-\s]\s*(\d{4})$/.exec(id);
  if (m && !pin) [id, pin] = [m[1], m[2]];
  if (!/^\d{4}$/.test(pin)) return { ok: false, reason: 'PIN is 4 digits' };
  const badge = /^#?\d{1,5}$/.test(id) ? Number(id.replace('#', '')) : null;
  const lname = id.toLowerCase();
  const cands = RT.store.allPlayers().filter((s) => (badge !== null ? s.profile.badge === badge : s.name.toLowerCase() === lname));
  const hit = cands.find((s) => s.pinHash === hashPin(s.id, pin));
  if (!hit) {
    p.claimFails.push(now);
    return { ok: false, reason: 'no profile matches that badge/name and PIN' };
  }
  if (hit.id === p.saveId) return { ok: true, level: hit.level, name: hit.name };
  for (const c of ctxOf().crews.list()) {
    for (const other of c.players.values()) {
      if (other !== player && other.connected && P(other).saveId === hit.id) return { ok: false, reason: `that profile is in use by ${other.name} right now` };
    }
  }
  RT.store.bindKey(player.key, hit);
  p.saveId = hit.id;
  p.pin = pin;
  player.level = hit.level;
  player.name = hit.name;
  player.profile = { ...hit.profile, name: hit.name };
  ctxOf().crews.broadcastRoster(crew);
  ctxOf().notice(crew, `${hit.name} reclaimed their badge (#${hit.profile.badge}, level ${hit.level})`);
  refreshBoard(crew);
  markDirty(crew);
  return { ok: true, level: hit.level, name: hit.name };
}

export function regenPin(player: ServerPlayer): string {
  const sv = saveOf(player);
  if (!sv || !RT) throw new Error('no save');
  const pin = newPin();
  sv.pinHash = hashPin(sv.id, pin);
  RT.store.putPlayer(sv);
  P(player).pin = pin;
  return `${sv.profile.badge}-${pin}`;
}

// ---------------------------------------------------------------- careers

export function awardXp(crew: Crew, pid: string, xp: number, reason: string): MetaXpLine | null {
  const player = crew.players.get(pid);
  if (!player || !RT) return null;
  const sv = saveOf(player);
  if (!sv) return null;
  const e = econ();
  const before = sv.level;
  sv.xp = Math.max(0, Math.round(sv.xp + xp));
  sv.level = levelFor(e, sv.xp);
  player.level = sv.level;
  RT.store.putPlayer(sv);
  const unlocks: string[] = [];
  for (const [h, lv] of Object.entries(HELMET_UNLOCK_LEVEL)) if (lv > before && lv <= sv.level) unlocks.push(`${h.toUpperCase()} helmet`);
  VISOR_COLORS.forEach((c, i) => {
    const lv = visorUnlockLevel(i);
    if (lv > before && lv <= sv.level) unlocks.push(`${VISOR_NAMES[i] ?? c} visor`);
  });
  if (before < 2 && sv.level >= 2) unlocks.push('RISK 2 eligibility');
  markDirty(crew);
  return { player: pid, name: player.name, gained: Math.round(xp), reasons: [{ text: reason, xp: Math.round(xp) }], xp: sv.xp, level: sv.level, levelUp: sv.level > before, unlocks };
}

function addAchievement(player: ServerPlayer, a: string): boolean {
  const sv = saveOf(player);
  if (!sv || sv.achievements.includes(a)) return false;
  sv.achievements.push(a);
  RT?.store.putPlayer(sv);
  return true;
}

// ---------------------------------------------------------------- board

/** board inputs that decide order ids/seeds (default: the crew's current shift position) */
export interface BoardAt { shiftIndex: number; contract: number; boardSeq: number }

function boardFor(crew: Crew, at?: BoardAt): WorkOrder[] {
  const s = S(crew);
  const ctx = ctxOf();
  const e = econ();
  const core = ctx.balance.core as Record<string, unknown>;
  const n = Math.max(1, connected(crew).length);
  const pos = at ?? { shiftIndex: s.shift.index, contract: s.shift.contract, boardSeq: s.boardSeq };
  return makeBoard({
    crewCode: crew.code, shiftIndex: pos.shiftIndex, contract: pos.contract, boardSeq: pos.boardSeq, players: n,
    avgLevel: avgLevel(crew), achievements: crewAchievements(crew),
    payoutMult: (mb().payoutMult as Record<string, number>) ?? { 1: 1, 2: 1.4, 3: 1.9 },
    riskLootMult: (core.riskLootMult as Record<string, number>) ?? { 1: 1, 2: 1.4, 3: 1.9 },
    playerMult: playerMult(e, n), lootBudgetBase: num(core.lootBudgetBase, 650),
    risk2MinAvgLevel: num(mb().risk2MinAvgLevel, 2), risk2Achievement: String(mb().risk2Achievement ?? 'Core Business'),
    recentSites: s.recentSites,
  });
}

export function newBoard(crew: Crew): void {
  const s = S(crew);
  s.boardSeq++;
  s.orders = boardFor(crew);
  s.picked = null;
  markDirty(crew);
  requestBriefs(crew);
}

/** availability + provisional quota follow crew size / levels while in the hub */
export function refreshBoard(crew: Crew): void {
  const s = S(crew);
  refreshAvailability(s.orders, avgLevel(crew), crewAchievements(crew), num(mb().risk2MinAvgLevel, 2), String(mb().risk2Achievement ?? 'Core Business'));
  if (!s.shift.quotaLocked && s.shift.index === 0) s.shift.quota = firstQuota(econ(), Math.max(1, connected(crew).length));
  if (s.picked && !s.orders.find((o) => o.id === s.picked)?.available) s.picked = null;
  markDirty(crew);
}

/** true when (e) runs real (or replayed) AI; mock text never replaces the handwritten templates */
export function aiReal(): boolean {
  const st = A.call<{ mode?: string; enabled?: boolean }>('ai', 'aiStatus');
  return !!st && st.mode !== 'mock' && st.enabled !== false;
}

function requestBriefs(crew: Crew): void {
  const ctx = ctxOf();
  if (ctx.flags.briefsAi === false || !A.has('ai', 'briefFor') || !aiReal()) return;
  const s = S(crew);
  // tonight's first contract always uses templates (PLAN 4.8)
  if (s.contractsDone === 0 && s.shift.index === 0 && s.shift.contract === 0) return;
  const seq = s.boardSeq;
  const wait = num(mb().briefAiWaitSec, 25) * 1000;
  for (const order of s.orders) {
    void A.briefFor(order, wait).then((ai) => {
      if (!ai || (ai as { source?: string }).source === 'template' || S(crew).boardSeq !== seq || s.active?.id === order.id) return;
      let changed = false;
      const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
      const h = str(ai.history, 900);
      if (h && h !== order.history) { order.history = h; changed = true; }
      const m = str(ai.memo, 900);
      if (m && m !== order.memo) { order.memo = m; changed = true; }
      const sn = str(ai.siteName, 60);
      if (sn && sn !== order.siteName && !s.orders.some((o) => o !== order && o.siteName.toLowerCase() === sn.toLowerCase())) { order.siteName = sn; changed = true; }
      if (Array.isArray(ai.notes) && ai.notes.length === order.notes.length) {
        const notes = ai.notes.filter((n) => n && typeof n.title === 'string' && typeof n.body === 'string');
        if (notes.length === order.notes.length && JSON.stringify(notes) !== JSON.stringify(order.notes)) {
          order.notes = notes.map((n, i) => ({ ...order.notes[i], title: n.title.slice(0, 80), body: n.body.slice(0, 600) }));
          changed = true;
        }
      }
      if (Array.isArray(ai.requests)) {
        ai.requests.forEach((r, i) => {
          const t = order.requests.find((x) => x.kind === r?.kind) ?? order.requests[i];
          // a brief prefetched at contract start was written for that crew size: keep the template line if the
          // threshold moved since (someone joined/left), so the text never shows a stale number
          if (t && r?.param === t.param && typeof r?.text === 'string' && r.text.trim() && r.text !== t.text) { t.text = r.text.trim().slice(0, 240); changed = true; }
        });
      }
      if (changed) {
        order.source = 'ai';
        markDirty(crew);
      }
    });
  }
}

/**
 * Opus briefs take a while, so the board the van shows AFTER this contract is built now (same ids/seeds as the one
 * enterHub -> newBoard builds later) and (e) briefFor is asked for its orders right away: (e) caches per order id + seed,
 * so by results time the AI text is ready and requestBriefs at hub entry lands it at once. A shift's last contract
 * prefetches at results instead (the next board depends on the quota verdict). Same gates as requestBriefs.
 */
export function prefetchBriefs(crew: Crew, at: BoardAt): number {
  const ctx = ctxOf();
  if (ctx.flags.briefsAi === false || !A.has('ai', 'briefFor') || !aiReal()) return 0;
  const wait = num(mb().briefAiWaitSec, 25) * 1000;
  const orders = boardFor(crew, at);
  for (const order of orders) void A.briefFor(order, wait);
  return orders.length;
}

// ---------------------------------------------------------------- phase transitions

function setPhase(crew: Crew, phase: Crew['phase'], layout?: LevelLayout | null): void {
  const s = S(crew);
  s.transition = true;
  try {
    ctxOf().setPhase(crew, phase, layout);
  } finally {
    s.transition = false;
  }
}

/** aim heights (m) for hub interactables whose layout y is the floor (same values as (b)'s KIND_Y) */
const HUB_ITEM_Y: Record<string, number> = { console: 0.95, board: 1.4, shop: 1.0, mirror: 1.4, kennel: 1.0 };

function hubInteractables(crew: Crew): void {
  const L = crew.layout;
  if (!L) return;
  const prompts: Record<string, string> = {
    board: 'Work orders', shop: 'Company store', mirror: 'Locker mirror: change your look', kennel: 'Training kennel: calibrate your mic', console: 'Van console',
  };
  const list: InteractableInfo[] = L.items
    .filter((it) => it.kind in prompts && (L.kind === 'hub' || it.kind === 'console'))
    .map((it) => ({ id: it.id, kind: it.kind, p: [it.x, it.y && it.y > 0 ? it.y : (HUB_ITEM_Y[it.kind] ?? 1.1), it.z] as [number, number, number], prompt: prompts[it.kind], enabled: true }));
  // v1.2 workshop (G5): the van workbench (hub craft, contract scrap) and the stash locker (hub)
  try {
    const wb = workbenchInteractables(crew);
    if (Array.isArray(wb)) list.push(...wb);
  } catch (err) {
    ctxOf().log('meta').warn('workbenchInteractables threw:', err instanceof Error ? err.message : err);
  }
  // v1.2: the records board on the hub facade opens the personnel file (virtual until env-layout's prop lands)
  if (L.kind === 'hub') {
    const st = stationOf(L, 'records');
    if (st) list.push({ id: v12Id('records', st.itemId), kind: 'records', p: [st.p[0], st.p[1], st.p[2]], r: st.r, prompt: 'Personnel file: read your record', enabled: true, ref: st.itemId });
  }
  if (list.length) A.call('interaction', 'registerInteractables', crew, list);
}

export function enterHub(crew: Crew): void {
  const s = S(crew);
  s.active = null;
  s.picked = null;
  s.pendingLayout = null;
  s.ended = true;
  s.holdUntil = 0;
  s.holdBy = null;
  s.hubStarted = false;
  for (const p of crew.players.values()) p.ready = false;
  newBoard(crew);
  refreshBoard(crew);
  setPhase(crew, 'hub', A.generateHubLayout());
  saveCrew(crew);
  markDirty(crew);
}

export function canPick(crew: Crew, player: ServerPlayer): string | null {
  if (crew.phase !== 'hub') return 'not in the van';
  if (!player.isLeader && connected(crew).length > 1) return 'only the crew leader picks the work order';
  return null;
}

export function pick(crew: Crew, player: ServerPlayer, orderId: string): { ok: boolean; reason?: string } {
  const why = canPick(crew, player);
  if (why) return { ok: false, reason: why };
  const s = S(crew);
  const o = s.orders.find((x) => x.id === orderId);
  if (!o) return { ok: false, reason: 'no such work order' };
  if (!o.available) return { ok: false, reason: 'requirements not met: crew avg level 2 or the Core Business achievement' };
  s.picked = o.id;
  markDirty(crew);
  const waiting = connected(crew).filter((p) => !p.ready);
  ctxOf().notice(crew, waiting.length ? `${player.name} picked ${o.siteName}. Waiting for ${waiting.map((p) => p.name).join(', ')} to ready up.` : `${player.name} picked ${o.siteName}.`);
  return { ok: true };
}

export function startDrive(crew: Crew, order: WorkOrder): void {
  const s = S(crew);
  const ctx = ctxOf();
  const e = econ();
  if (crew.phase !== 'hub') return;
  if (!s.shift.quotaLocked) {
    if (s.shift.index === 0) s.shift.quota = firstQuota(e, Math.max(1, connected(crew).length));
    s.shift.quotaLocked = true;
  }
  s.active = order;
  s.picked = order.id;
  s.holdUntil = 0;
  s.holdBy = null;
  s.recentSites = [...s.recentSites, order.siteName].slice(-6);
  for (const p of crew.players.values()) p.ready = false;
  try {
    s.pendingLayout = A.generateFacilityLayout(crew, facilityParams(crew, order));
  } catch (err) {
    ctx.log('meta').error('facility generation failed:', err instanceof Error ? err.message : err);
    ctx.notice(crew, 'Dispatch could not find the site. Pick another work order.', 'error');
    s.active = null;
    return;
  }
  A.call('monsters', 'stopMonsters', crew);
  // the drive screen is where the monster rules are taught: the crew's very first contract gets longer to read them
  const firstEver = s.shift.index === 0 && s.shift.contract === 0;
  s.driveEndsAt = ctx.now() + (firstEver ? num(mb().firstDriveSec, 16) : num(mb().driveSec, 12)) * 1000;
  setPhase(crew, 'drive');
  saveCrew(crew);
  markDirty(crew);
}

/** generator params of a work order: v1.2 theme + modifier chips unless flags.siteThemes is off */
export function facilityParams(crew: Crew, order: WorkOrder): A.FacilityParams {
  const p: A.FacilityParams = { seed: order.seed, players: Math.max(1, connected(crew).length), risk: order.risk };
  if (ctxOf().flags.siteThemes !== false) {
    p.theme = order.siteTheme ?? 'facility';
    p.modifiers = [...(order.modifiers ?? [])];
  }
  return p;
}

export function startContract(crew: Crew): void {
  const s = S(crew);
  const ctx = ctxOf();
  const order = s.active;
  if (!order) return enterHub(crew);
  const layout = s.pendingLayout ?? A.generateFacilityLayout(crew, facilityParams(crew, order));
  s.pendingLayout = null;
  s.contractId++;
  s.contractStartedAt = ctx.now();
  s.ended = false;
  s.deaths = [];
  s.results = null;
  s.participants = connected(crew).filter((p) => !isObserver(p)).map((p) => p.id);
  for (const p of crew.players.values()) p.ready = false;
  setPhase(crew, 'contract', layout);
  beginContractStats(crew);
  A.call('objectives', 'startContract', crew, order, { contractIndex: s.shift.contract });
  A.call('monsters', 'startMonsters', crew, { risk: order.risk, contractIndex: s.shift.contract });
  try { craftContractStart(crew); } catch (err) { ctx.log('meta').warn('craftContractStart threw:', err instanceof Error ? err.message : err); }
  handOutGear(crew);
  hubInteractables(crew);
  markDirty(crew);
  // AI text for the next board (same shift): ready by results time
  if (s.shift.contract + 1 < econ().contractsPerShift) {
    prefetchBriefs(crew, { shiftIndex: s.shift.index, contract: s.shift.contract + 1, boardSeq: s.boardSeq + 1 });
  }
}

interface HeldItem { id: string; type: string; count: number }

/** items a player carries (stacks count their units), or null when (b) can't tell */
function heldItems(crew: Crew, pid: string): HeldItem[] | null {
  if (!A.has('interaction', 'itemsOf')) return null;
  const r = A.call<unknown>('interaction', 'itemsOf', crew, pid);
  if (!Array.isArray(r)) return null;
  const out: HeldItem[] = [];
  for (const it of r) {
    const o = it && typeof it === 'object' ? (it as { id?: unknown; type?: unknown; count?: unknown }) : null;
    const t = typeof it === 'string' ? it : String(o?.type ?? '');
    if (!t) continue;
    out.push({ id: String(o?.id ?? ''), type: t, count: o && Number(o.count) > 0 ? Math.round(Number(o.count)) : 1 });
  }
  return out;
}

function giveUnits(crew: Crew, pid: string, type: string, units: number): void {
  if (!(units > 0)) return;
  const stack = stackOf(type) > 1;
  for (const c of stacks(type, units)) A.call('interaction', 'giveItem', crew, pid, type, stack ? { count: c, via: 'handout' } : { via: 'handout' });
}

/**
 * v1.2 hand-out at contract start (plan check #21 + critic #4/#5/#14/#23). Each connected player gets at most
 * handoutSlots inventory slots from their OWN locker (save id), in PlayerSave.loadout order (newest first when unset);
 * the rest is held back and merged back by collectGear. Delivery is a delta against what they already carry: a type
 * whose held units equal the allotment is left alone, anything else held of a pool type is taken back and re-issued
 * in full stacks (so gear picked up in the hub can never duplicate a locker). An absent owner's gear stays in their
 * locker; only company walkies are dealt, one each to players without one who still have a free hand-out slot.
 */
function handOutGear(crew: Crew): void {
  const s = S(crew);
  s.handout = null;
  const ps = connected(crew).filter((p) => !isObserver(p)).sort((a, b) => a.joinedAt - b.joinedAt);
  if (!ps.length || !A.has('interaction', 'giveItem')) return;
  const cap = handoutSlots();
  const canTake = A.has('interaction', 'itemsOf') && A.has('interaction', 'removeItem');
  const keepAll: Record<string, Units> = {};
  const freeSlots = new Map<string, number>();
  const hasWalkie = new Set<string>();
  for (const p of ps) {
    const sid = P(p).saveId;
    if (keepAll[sid]) continue;
    const pool = s.gear[sid] ?? {};
    const { give: want, keep, slots } = allot(pool, handoutOrder(pool, saveOf(p)?.loadout), cap);
    keepAll[sid] = keep;
    freeSlots.set(p.id, cap - slots);
    if ((want.walkie ?? 0) > 0) hasWalkie.add(p.id);
    if (canTake) {
      const byType = new Map<string, HeldItem[]>();
      for (const it of heldItems(crew, p.id) ?? []) if (isPoolType(it.type)) byType.set(it.type, [...(byType.get(it.type) ?? []), it]);
      for (const [t, items] of byType) {
        const h = items.reduce((a, it) => a + it.count, 0);
        if (h === (want[t] ?? 0) && items.length === stacks(t, h).length) {
          delete want[t];
          continue;
        }
        for (const it of items) if (it.id) A.call('interaction', 'removeItem', crew, it.id);
      }
    }
    for (const [t, n] of Object.entries(want)) giveUnits(crew, p.id, t, n);
  }
  const crewGear = s.gear.crew;
  let w = Math.max(0, Math.round(crewGear?.walkie ?? 0));
  for (const p of ps) {
    if (w <= 0) break;
    if (hasWalkie.has(p.id) || (freeSlots.get(p.id) ?? 0) <= 0) continue;
    giveUnits(crew, p.id, 'walkie', 1);
    hasWalkie.add(p.id);
    w--;
  }
  if (crewGear) {
    if (w > 0) crewGear.walkie = w;
    else delete crewGear.walkie;
    if (!Object.keys(crewGear).length) delete s.gear.crew;
  }
  s.handout = { keep: keepAll };
}

/**
 * Contract end: a player who made it back keeps what they carry (carry-over types only: overshoes wear out), plus what
 * was held back in their locker; the dead and the left-behind keep only the held-back part. Lockers of players who were
 * not handed out (absent, or joined mid-contract) stay as they are. Only when (b) can tell us what people hold.
 */
function collectGear(crew: Crew, keepers: Set<string>): void {
  const s = S(crew);
  const ho = s.handout;
  s.handout = null;
  if (!A.has('interaction', 'itemsOf')) return;
  const next: Record<string, Units> = {};
  for (const [owner, units] of Object.entries(s.gear)) if (!ho?.keep[owner]) next[owner] = { ...units };
  for (const [sid, keep] of Object.entries(ho?.keep ?? {})) next[sid] = { ...keep };
  for (const p of crew.players.values()) {
    if (!keepers.has(p.id) || isObserver(p)) continue;
    const items = heldItems(crew, p.id);
    if (!items) return; // unknown -> keep the pool as it was
    const mine = (next[P(p).saveId] ??= {});
    for (const it of items) if (isCarryType(it.type)) mine[it.type] = (mine[it.type] ?? 0) + it.count;
  }
  for (const [owner, units] of Object.entries(next)) {
    for (const [t, n] of Object.entries(units)) if (!(n > 0)) delete units[t];
    if (!Object.keys(units).length) delete next[owner];
  }
  s.gear = next;
}

// ---------------------------------------------------------------- v1.2 gear pool API (meta/api.ts poolAdd/poolView)

function playerSaveId(crew: Crew, pid: string): string | null {
  const p = crew.players.get(pid);
  return p ? P(p).saveId : null;
}

/** add crafted units to pid's locker (shop pack ids become their real items); refuses past maxPoolSlots */
export function poolAddUnits(crew: Crew, pid: string, type: string, units: number): { ok: boolean; reason?: string } {
  const sid = playerSaveId(crew, pid);
  if (!sid) return { ok: false, reason: 'no such player' };
  const r = realType(String(type ?? ''));
  if (!r) return { ok: false, reason: `${String(type).slice(0, 24)} does not go in the gear locker` };
  const n = Math.round(Number(units) || 0) * r[1];
  if (!(n > 0)) return { ok: false, reason: 'nothing to add' };
  const s = S(crew);
  const mine = s.gear[sid] ?? {};
  const max = maxPoolSlots();
  if (poolSlots({ ...mine, [r[0]]: (mine[r[0]] ?? 0) + n }) > max) return { ok: false, reason: `Gear locker full (${max} slots): use or scrap something first` };
  addUnits((s.gear[sid] = mine), r[0], n);
  saveCrew(crew);
  markDirty(crew);
  return { ok: true };
}

/**
 * Gear used up outside a contract (a bottle thrown in the van lot): the locker loses it too, or the next hand-out would
 * re-issue it. During a contract collectGear settles everything from what people carry at the end.
 */
export function poolConsumed(crew: Crew, pid: string, type: string, count: number): void {
  if (crew.phase === 'contract' || !isPoolType(type)) return;
  const sid = playerSaveId(crew, pid);
  const mine = sid ? S(crew).gear[sid] : undefined;
  if (!mine || !(mine[type] > 0)) return;
  mine[type] = Math.max(0, mine[type] - Math.max(1, Math.round(count) || 1));
  if (!(mine[type] > 0)) delete mine[type];
  saveCrew(crew);
  markDirty(crew);
}

export function poolViewOf(crew: Crew, pid: string): { units: Record<string, number>; slots: number; maxSlots: number } {
  const sid = playerSaveId(crew, pid);
  const units = sid ? { ...(S(crew).gear[sid] ?? {}) } : {};
  return { units, slots: poolSlots(units), maxSlots: maxPoolSlots() };
}

// ---------------------------------------------------------------- contract end -> results

export function recordDeath(crew: Crew, pid: string, cause: Partial<A.DeathCause> | string | undefined): void {
  const s = S(crew);
  if (crew.phase !== 'contract') return;
  const player = crew.players.get(pid);
  const c = typeof cause === 'string' ? { killer: cause, reason: '' } : (cause ?? {});
  const card: MetaDeathCard = {
    player: pid,
    name: player?.name ?? pid,
    killer: String(c.killer ?? 'UNKNOWN').toUpperCase().slice(0, 24),
    reason: String(c.reason ?? '').slice(0, 120),
    detail: c.detail ? String(c.detail).slice(0, 200) : undefined,
  };
  s.deaths = s.deaths.filter((d) => d.player !== pid).concat(card);
}

export function recordUtterance(crew: Crew, speaker: string, text: string): void {
  const s = S(crew);
  const t = String(text ?? '').trim();
  if (!t) return;
  const list = (s.quotes[speaker] ??= []);
  list.push(t.slice(0, 200));
  if (list.length > 40) list.shift();
}

const INTENT_TEXT: Record<string, string> = {
  investigate_room: 'went to look in', ambush_room: 'waited for you in', stalk_player: 'stalked', radio_lure: 'faked a radio call to',
  retreat: 'backed off', ignore: 'ignored it',
};

function heardDid(crew: Crew): MetaHeardDid[] {
  // (c) decisionEntries(crew): structured { heard, speaker, action, target, line }; decisionLog(crew): 'heard -> did' lines
  const log = A.call<unknown>('monsters', 'decisionEntries', crew) ?? A.call<unknown>('monsters', 'decisionLog', crew);
  if (!Array.isArray(log)) return [];
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const names = new Map([...crew.players.values()].map((p) => [p.id, p.name]));
  const out: MetaHeardDid[] = [];
  for (const e of log) {
    if (typeof e === 'string') {
      const m = /^(.*?)\s*(?:->|→|=>)\s*(.+)$/.exec(e.replace(/^heard\s*:?\s*/i, ''));
      if (m) out.push({ heard: m[1].replace(/^["“]|["”]$/g, '').slice(0, 140), did: m[2].slice(0, 100) });
      continue;
    }
    if (!e || typeof e !== 'object') continue;
    const o = e as Record<string, unknown>;
    if (o.valid === false) continue;
    const inp = (o.input && typeof o.input === 'object' ? o.input : {}) as Record<string, unknown>;
    let heard = str(o.heard) ?? str(o.text) ?? str(o.utterance) ?? str(o.quote) ?? str(inp.text);
    const who = typeof o.speaker === 'string' ? (names.get(o.speaker) ?? o.speaker) : null;
    let did = str(o.did);
    if (!did) {
      const intent = str(o.intent) ?? str(o.action) ?? str((o.decision as Record<string, unknown> | undefined)?.intent);
      const tgt = str(o.target) ?? str((o.decision as Record<string, unknown> | undefined)?.target) ?? '';
      const target = tgt && names.has(tgt) ? names.get(tgt)! : tgt;
      if (intent) did = `${INTENT_TEXT[intent] ?? intent.replace(/_/g, ' ')}${target && intent !== 'retreat' && intent !== 'ignore' ? ` ${target}` : ''}`;
    }
    if (heard && did) out.push({ heard: heard.slice(0, 140), did: `${did.slice(0, 100)}${who ? ` (heard from ${who})` : ''}`, at: str(o.at) ?? undefined });
  }
  return out.slice(-6);
}

export interface RawResult {
  orderId?: string;
  hauled?: number;
  lootTotal?: number;
  survivors?: string[];
  deaths?: { player: string; cause?: unknown; killer?: string; reason?: string; detail?: string; badgeRecovered?: boolean }[];
  coreExtracted?: boolean;
  requestsMet?: string[];
  outcome?: string;
  badgesRecovered?: string[];
  /** (a) ObjContractResult extras */
  reason?: 'departure' | 'leave' | 'wipe' | 'abort' | string;
  leftBehind?: string[];
  requests?: { kind: string; done: boolean; reward?: number }[];
  requestsReward?: number;
  /** (a) false = left at once with nothing hauled: reduced XP (no completion/survival XP) */
  participated?: boolean;
}

const REASON_OUTCOME: Record<string, MetaContractResults['outcome']> = { departure: 'extracted', leave: 'left_early', wipe: 'wiped', abort: 'voided' };

/** 'HOUND: heard your SPRINT, 9 m' -> { killer, reason } */
function splitCause(c: string): { killer: string; reason: string } {
  const m = /^([A-Z][A-Z .'-]{1,22}?)(?::\s*|\s+-\s+|\s+)(.+)$/.exec(c.trim());
  return m ? { killer: m[1].trim(), reason: m[2].trim() } : { killer: c.trim().split(/\s+/)[0] ?? 'UNKNOWN', reason: c.trim() };
}

const OUTCOMES = new Set(['extracted', 'left_early', 'wiped', 'voided', 'timeout']);

export function finishContract(crew: Crew, raw: RawResult, outcome0?: string): boolean {
  const s = S(crew);
  const ctx = ctxOf();
  if (crew.phase !== 'contract' || s.ended || !s.active) return false;
  s.ended = true;
  if (!outcome0 && raw.reason && REASON_OUTCOME[raw.reason]) outcome0 = REASON_OUTCOME[raw.reason];
  if (outcome0 === 'voided') return voidContract(crew);
  const e = econ();
  const xpCfg = (mb().xp ?? {}) as Record<string, number>;
  const order = s.active;
  const obj = (A.call<Record<string, unknown>>('objectives', 'state', crew) ?? {}) as Record<string, unknown>;
  const part = new Set(s.participants);
  const participants = [...crew.players.values()].filter((p) => (part.has(p.id) || p.connected) && !isObserver(p));

  const hauled = Math.max(0, Math.round(num(raw.hauled, num(obj.hauled, 0))));
  const lootTotal = Math.max(0, Math.round(num(raw.lootTotal, num(obj.lootTotal, 0))));
  const coreExtracted = !!(raw.coreExtracted ?? obj.coreState === 'van');
  const met = new Set(Array.isArray(raw.requestsMet) ? raw.requestsMet.map(String) : []);
  const objReqs = Array.isArray(raw.requests) ? raw.requests : Array.isArray(obj.requests) ? (obj.requests as { kind?: string; done?: boolean }[]) : [];
  const requests = order.requests.map((r, i) => ({
    kind: r.kind, text: r.text, reward: r.reward,
    done: met.has(r.kind) || objReqs[i]?.done === true || objReqs.some((x) => x?.kind === r.kind && x.done === true),
  }));
  const requestScrip = requests.reduce((a, r) => a + (r.done ? r.reward : 0), 0);

  // deaths: (b) onDeath cards first, then the result's list
  const cards = new Map<string, MetaDeathCard>();
  for (const d of s.deaths) cards.set(d.player, { ...d });
  for (const d of raw.deaths ?? []) {
    if (!d || typeof d.player !== 'string') continue;
    const prev = cards.get(d.player);
    const causeObj: Record<string, unknown> = d.cause && typeof d.cause === 'object' ? (d.cause as Record<string, unknown>) : typeof d.cause === 'string' ? { ...splitCause(d.cause) } : {};
    const killer = String(prev?.killer && prev.killer !== 'UNKNOWN' ? prev.killer : (d.killer ?? causeObj.killer ?? 'UNKNOWN'));
    cards.set(d.player, {
      player: d.player,
      name: crew.players.get(d.player)?.name ?? prev?.name ?? d.player,
      killer: killer.toUpperCase().slice(0, 24),
      reason: String(prev?.reason || d.reason || causeObj.reason || '').slice(0, 120),
      detail: (d.detail ?? causeObj.detail ?? prev?.detail) ? String(d.detail ?? causeObj.detail ?? prev?.detail).slice(0, 200) : undefined,
      badgeRecovered: d.badgeRecovered ?? prev?.badgeRecovered,
    });
  }
  // anyone (b) still reports dead counts too
  for (const p of participants) {
    if (!cards.has(p.id) && A.isAlive(crew, p.id) === false) cards.set(p.id, { player: p.id, name: p.name, killer: 'UNKNOWN', reason: 'did not make it back' });
  }
  if (Array.isArray(raw.survivors)) {
    const sv = new Set(raw.survivors);
    for (const p of participants) if (!sv.has(p.id) && !cards.has(p.id) && p.connected) cards.set(p.id, { player: p.id, name: p.name, killer: 'VAN', reason: 'left behind at 04:00' });
  }
  for (const id of raw.leftBehind ?? []) {
    if (!cards.has(id) && crew.players.has(id)) cards.set(id, { player: id, name: crew.players.get(id)!.name, killer: 'THE VAN', reason: 'left behind at 04:00' });
  }
  for (const id of raw.badgesRecovered ?? []) { const c = cards.get(id); if (c) c.badgeRecovered = true; }
  // (b) knows which badges were carried back (only for deaths it recorded)
  const unrecovered = A.call<unknown>('interaction', 'unrecoveredBadges', crew);
  const ixDeaths = A.call<unknown>('interaction', 'deaths', crew);
  if (Array.isArray(unrecovered) && Array.isArray(ixDeaths)) {
    const known = new Set(ixDeaths.map((d) => String((d as { pid?: unknown })?.pid ?? '')));
    for (const c of cards.values()) if (c.badgeRecovered === undefined && known.has(c.player)) c.badgeRecovered = !unrecovered.includes(c.player);
  }
  const deaths = [...cards.values()].filter((d) => crew.players.has(d.player));
  const dead = new Set(deaths.map((d) => d.player));
  const survivors = participants.filter((p) => !dead.has(p.id)).map((p) => p.id);
  const outcome = (outcome0 && OUTCOMES.has(outcome0) ? outcome0 : raw.outcome && OUTCOMES.has(raw.outcome) ? raw.outcome
    : survivors.length === 0 ? 'wiped' : 'extracted') as MetaContractResults['outcome'];

  // economy
  const balanceBefore = s.shift.balance;
  s.shift.hauled += hauled;
  s.shift.balance += hauled + requestScrip;
  const unrec = deaths.filter((d) => !d.badgeRecovered);
  const fineAmts = badgeFines(e, s.shift.balance, unrec.length);
  const fines = unrec.map((d, i) => ({ player: d.player, name: d.name, amount: fineAmts[i] ?? 0 })).filter((f) => f.amount > 0);
  s.shift.balance -= fines.reduce((a, f) => a + f.amount, 0);

  // careers
  const xpLines: MetaXpLine[] = [];
  const share = participants.length ? hauled / participants.length : 0;
  for (const p of participants) {
    const lived = !dead.has(p.id);
    // (a) participation gate: leaving at once with an empty van earns only a token clock-in
    const idle = raw.participated === false;
    const parts: { text: string; xp: number }[] = idle
      ? [{ text: 'clocked in (left early, nothing hauled)', xp: num(xpCfg.idle, 5) }]
      : [{ text: 'contract completed', xp: num(xpCfg.contract, 25) }];
    if (!idle || !lived) parts.push(lived ? { text: 'survived', xp: num(xpCfg.survive, 40) } : { text: 'died (for science)', xp: num(xpCfg.death, 10) });
    if (share > 0) parts.push({ text: 'salvage share', xp: Math.round(share * num(xpCfg.perScrip, 0.12)) });
    if (coreExtracted) parts.push({ text: 'Core extracted', xp: num(xpCfg.core, 60) });
    const done = requests.filter((r) => r.done).length;
    if (done) parts.push({ text: `${done} Company Request${done > 1 ? 's' : ''}`, xp: done * num(xpCfg.request, 25) });
    const total = parts.reduce((a, x) => a + x.xp, 0);
    const line = awardXp(crew, p.id, total, 'contract');
    if (line) xpLines.push({ ...line, reasons: parts });
    if (coreExtracted && addAchievement(p, String(mb().risk2Achievement ?? 'Core Business')) && line) line.unlocks.push('achievement: Core Business');
  }

  // v1.2 workshop: van materials + this contract's scrap into the stash (before results; it always clears pending)
  let salvage: { materials: Record<string, number>; scrapped: number } | undefined;
  try {
    const r = craftContractEnd(crew, outcome, participants.map((p) => p.id));
    if (r && typeof r === 'object') salvage = { materials: { ...(r.materials ?? {}) }, scrapped: num(r.scrapped, 0) };
  } catch (err) {
    ctx.log('meta').warn('craftContractEnd threw:', err instanceof Error ? err.message : err);
  }

  // v1.2 stats: commit the contract's counters once (after XP, before the flush), shift lines + crew records
  const commit = commitContract(crew, {
    outcome, participants, cards, coreExtracted, hauled, siteName: order.siteName, startedAt: s.contractStartedAt, xpLines,
  });

  // gear: whoever made it back alive keeps what they carry (the left-behind and the dead do not)
  const keepers = new Set(participants.filter((p) => {
    const c = cards.get(p.id);
    if (c && killerKey(c.killer) === LEFT_BEHIND) return false;
    const alive = A.isAlive(crew, p.id);
    return alive === null ? !dead.has(p.id) : alive;
  }).map((p) => p.id));
  collectGear(crew, keepers);

  s.shift.contract++;
  s.contractsDone++;
  const shiftEnd = s.shift.contract >= e.contractsPerShift;
  const history: ContractResult = {
    orderId: `${order.id}|${order.siteName}`, risk: order.risk, hauled, survivors,
    deaths: deaths.map((d) => ({ player: d.player, cause: `${d.killer}: ${d.reason}` })),
    coreExtracted, requestsMet: requests.filter((r) => r.done).map((r) => r.kind), at: new Date().toISOString(),
  };
  s.history.push(history);
  if (s.history.length > 50) s.history.shift();

  s.results = {
    orderId: order.id, siteName: order.siteName, risk: order.risk, outcome, hauled, lootTotal, coreExtracted,
    requests, requestScrip, survivors, deaths, fines, balanceBefore, balanceAfter: s.shift.balance,
    shiftHauled: s.shift.hauled, quota: s.shift.quota, contract: s.shift.contract, contractsPerShift: e.contractsPerShift,
    xp: xpLines, heardDid: heardDid(crew), shiftEnd,
  };
  if (salvage) s.results.salvage = salvage;
  if (commit.players.length) s.results.players = commit.players;
  if (commit.superlatives.length) s.results.superlatives = commit.superlatives;
  if (shiftEnd) buildShiftReview(crew);

  A.call('monsters', 'stopMonsters', crew);
  s.resultsEndsAt = ctx.now() + num(shiftEnd ? mb().shiftEndResultsSec : mb().resultsSec, shiftEnd ? 150 : 60) * 1000;
  saveCrew(crew);
  RT?.store.flush();
  setPhase(crew, 'results');
  ctx.crews.broadcastRoster(crew); // levels changed
  markDirty(crew);
  return true;
}

/** aborted contract (restart / dbg / phase change): no haul, no penalty, no shift progress */
function voidContract(crew: Crew): boolean {
  const s = S(crew);
  const order = s.active!;
  const e = econ();
  s.results = {
    orderId: order.id, siteName: order.siteName, risk: order.risk, outcome: 'voided', hauled: 0, lootTotal: 0, coreExtracted: false,
    requests: order.requests.map((r) => ({ kind: r.kind, text: r.text, done: false, reward: r.reward })), requestScrip: 0,
    survivors: [...crew.players.keys()], deaths: [], fines: [], balanceBefore: s.shift.balance, balanceAfter: s.shift.balance,
    shiftHauled: s.shift.hauled, quota: s.shift.quota, contract: s.shift.contract, contractsPerShift: e.contractsPerShift,
    xp: [], heardDid: [], shiftEnd: false,
  };
  // nothing a voided contract counted is kept; the workshop drops its pending scrap; lockers stay as they were
  discardContractStats(crew);
  try { craftContractEnd(crew, 'voided', []); } catch { /* workshop optional */ }
  s.handout = null;
  A.call('monsters', 'stopMonsters', crew);
  s.resultsEndsAt = ctxOf().now() + 12_000;
  setPhase(crew, 'results');
  markDirty(crew);
  return true;
}

/** a save that is not in the crew right now still gets its shift XP (HR memo players after a restart) */
function awardXpSave(sid: string, xp: number): void {
  const sv = RT?.store.playerById(sid);
  if (!sv || !RT) return;
  sv.xp = Math.max(0, Math.round(sv.xp + xp));
  sv.level = levelFor(econ(), sv.xp);
  RT.store.putPlayer(sv);
}

function buildShiftReview(crew: Crew): void {
  const s = S(crew);
  const e = econ();
  const xpCfg = (mb().xp ?? {}) as Record<string, number>;
  const met = quotaMet(s.shift.hauled, s.shift.quota);
  const ot = overtime(e, s.shift.hauled, s.shift.quota);
  const nextQ = met ? nextQuota(e, s.shift.quota, s.shift.index + 1, crew.code) : null;
  if (met) s.shift.balance += ot;
  // every save that worked this shift (CrewSave.shiftStats survives a restart), present or not
  const live = new Map<string, ServerPlayer>();
  for (const p of crew.players.values()) if (!isObserver(p)) live.set(P(p).saveId, p);
  const players = Object.entries(s.shiftStats).filter(([, st]) => st.contracts > 0).map(([sid, st]) => {
    const p = live.get(sid);
    const sv = RT?.store.playerById(sid) ?? null;
    return {
      id: p?.id ?? sid, saveId: sid, name: p?.name ?? sv?.name ?? 'Contractor', level: sv?.level ?? p?.level ?? 1,
      deaths: st.deaths, survived: st.survived, contracts: st.contracts, hauled: st.hauled, quotes: (p ? s.quotes[p.id] : null) ?? [],
    };
  });
  for (const pl of players) {
    const xp = met ? num(xpCfg.quotaMet, 100) : num(xpCfg.fired, 30);
    if (live.get(pl.saveId)) awardXp(crew, pl.id, xp, met ? 'quota met' : 'severance experience');
    else awardXpSave(pl.saveId, xp);
  }
  commitShift(crew, met);
  const input: ReviewInput = { crew: crew.code, shiftIndex: s.shift.index, quota: s.shift.quota, hauled: s.shift.hauled, overtime: ot, met, nextQuota: nextQ, players };
  const review = templateReview(input);
  s.review = review;
  // the next shift's first board (continueFromResults: promoted -> index + 1, fired -> 0): briefs during the HR memo
  prefetchBriefs(crew, { shiftIndex: met ? s.shift.index + 1 : 0, contract: 0, boardSeq: s.boardSeq + 1 });
  for (const fnc of RT?.shiftEndFns ?? []) {
    try { fnc(crew, review); } catch (err) { ctxOf().log('meta').warn('onShiftEnd listener threw:', err instanceof Error ? err.message : err); }
  }
  if (ctxOf().flags.reviewAi !== false && A.has('ai', 'reviewFor') && aiReal()) {
    const wait = num(mb().reviewAiWaitSec, 60) * 1000;
    const contracts = s.history.slice(-e.contractsPerShift).map((h) => ({
      site: h.orderId.split('|')[1] ?? '', hauled: h.hauled, deaths: h.deaths.length, coreExtracted: h.coreExtracted,
    }));
    const summary = {
      crew: crew.code, index: s.shift.index, quota: s.shift.quota, hauled: s.shift.hauled, fired: !met,
      players: players.map((p) => ({
        id: p.id, name: p.name, deaths: p.deaths, level: crew.players.get(p.id)?.level ?? p.level,
        // v1.2: what this player actually deposited this shift (no extra AI calls)
        hauled: Math.round(p.hauled),
        xp: RT?.store.playerById(p.saveId)?.xp ?? 0,
        causes: s.history.slice(-e.contractsPerShift).flatMap((h) => h.deaths.filter((d) => d.player === p.id).map((d) => d.cause)).slice(0, 4),
      })),
      contracts,
      template: review,
    };
    review.pending = true;
    void A.reviewFor(summary, wait).then((ai) => {
      if (S(crew).review !== review) return;
      if (ai) mergeAiReview(review, ai);
      review.pending = false; // AI version or (timeout / failure) the template: final either way
      markDirty(crew);
    });
  }
}

/** per-player 'back to the van' votes, keyed by the results phase (resultsEndsAt) they were cast in */
const VOTES = new WeakMap<Crew, { at: number; ids: string[] }>();

export function continuedIds(crew: Crew): string[] {
  const v = VOTES.get(crew);
  return v && crew.phase === 'results' && v.at === S(crew).resultsEndsAt ? v.ids : [];
}

/** one player is done reading: move on once every connected player has continued (the countdown still ends it) */
export function continueVote(crew: Crew, player: ServerPlayer): { ok: boolean; reason?: string; waiting?: number } {
  if (crew.phase !== 'results') return { ok: false, reason: 'no results to close' };
  const s = S(crew);
  let v = VOTES.get(crew);
  if (!v || v.at !== s.resultsEndsAt) { v = { at: s.resultsEndsAt, ids: [] }; VOTES.set(crew, v); }
  if (!v.ids.includes(player.id)) v.ids.push(player.id);
  const waiting = connected(crew).filter((p) => !v.ids.includes(p.id)).length;
  if (waiting === 0) {
    continueFromResults(crew);
    return { ok: true, waiting: 0 };
  }
  markDirty(crew);
  return { ok: true, waiting };
}

export function continueFromResults(crew: Crew): void {
  const s = S(crew);
  const e = econ();
  if (crew.phase !== 'results') return;
  if (s.review) {
    const free = num(mb().freeWalkiesPerShift, 2);
    if (s.review.verdict === 'promoted') {
      s.shift = {
        index: s.shift.index + 1, contract: 0, quota: s.review.nextQuota ?? nextQuota(e, s.shift.quota, s.shift.index + 1, crew.code),
        hauled: 0, balance: s.shift.balance, gear: {}, quotasMet: s.shift.quotasMet + 1, quotaLocked: true,
      };
    } else {
      s.shift = { index: 0, contract: 0, quota: firstQuota(e, Math.max(1, connected(crew).length)), hauled: 0, balance: e.startScrip, gear: {}, quotasMet: 0, quotaLocked: false };
      s.gear = {};
      // v1.2 workshop: a fired crew loses its stash and van upgrades (crafting.json firedWipes); the personnel file, XP,
      // levels, cosmetics and the collection log are untouched
      try { craftFired(crew); } catch (err) { ctxOf().log('meta').warn('craftFired threw:', err instanceof Error ? err.message : err); }
    }
    const crewGear = (s.gear.crew ??= {});
    crewGear.walkie = Math.max(crewGear.walkie ?? 0, free);
    s.review = null;
    s.shiftStats = {};
    s.quotes = {};
  }
  s.results = null;
  enterHub(crew);
}

// ---------------------------------------------------------------- shop

export function buy(crew: Crew, player: ServerPlayer, itemId: string): { ok: boolean; reason?: string; balance: number } {
  const s = S(crew);
  if (crew.phase !== 'hub') return { ok: false, reason: 'the store is in the van', balance: s.shift.balance };
  const item = shopItems().find((i) => i.id === itemId);
  if (!item) return { ok: false, reason: 'not stocked', balance: s.shift.balance };
  if (s.shift.balance < item.price) return { ok: false, reason: `not enough scrip (${s.shift.balance}/${item.price})`, balance: s.shift.balance };
  const type = item.type ?? item.id;
  const sid = P(player).saveId;
  const mine = s.gear[sid] ?? {};
  // v1.2: the locker holds real items (packs unpacked) up to maxPoolSlots slot-equivalents
  const r = realType(type);
  const units = Math.max(1, Math.round(item.qty ?? 1)) * (r?.[1] ?? 1);
  const real = r?.[0] ?? type;
  const max = maxPoolSlots();
  if (r && poolSlots({ ...mine, [real]: (mine[real] ?? 0) + units }) > max) {
    return { ok: false, reason: `Your gear locker is full (${max} slots). Use or scrap something first.`, balance: s.shift.balance };
  }
  s.shift.balance -= item.price;
  addUnits((s.gear[sid] = mine), real, units);
  ctxOf().notice(crew, `${player.name} bought ${item.name} (${item.price} scrip)`);
  recordStat(crew, player.id, 'scripSpent', item.price);
  saveCrew(crew);
  markDirty(crew);
  return { ok: true, balance: s.shift.balance };
}

// ---------------------------------------------------------------- tick

export function allReady(crew: Crew): boolean {
  const ps = connected(crew);
  return ps.length > 0 && ps.every((p) => p.ready);
}

/** v1.1 drive -> contract: true when no connected player is still building the pending facility. Clients ask for it
 *  with 'net.preload' and report 'net.loaded' (apps/server/src/net/loading.ts writes player.slices.loading); players
 *  that never asked (bots, old clients) are not waited for. */
function crewLoaded(crew: Crew, s: MetaCrew): boolean {
  const hash = s.pendingLayout?.hash;
  if (!hash) return true;
  return connected(crew).every((p) => {
    const l = p.slices.loading as { want?: string | null; loaded?: string | null } | undefined;
    return !l || l.want !== hash || l.loaded === hash;
  });
}

export function tickCrew(crew: Crew): void {
  const s = S(crew);
  const ctx = ctxOf();
  const now = ctx.now();
  switch (crew.phase) {
    case 'hub': {
      if (!crew.layout || crew.layout.kind !== 'hub') {
        s.transition = true;
        crew.layout = A.generateHubLayout();
        s.transition = false;
      }
      if (!s.orders.length) newBoard(crew);
      if (!s.hubStarted && connected(crew).length) {
        s.hubStarted = true;
        A.call('monsters', 'startHub', crew);
        hubInteractables(crew);
      }
      if (s.holdUntil && now > s.holdUntil + 1500) {
        s.holdUntil = 0;
        s.holdBy = null;
        markDirty(crew);
      }
      if (s.picked && allReady(crew)) {
        const o = s.orders.find((x) => x.id === s.picked);
        if (o?.available) startDrive(crew, o);
      }
      break;
    }
    case 'drive':
      if (!s.active) enterHub(crew);
      // v1.1: the van arrives once every client that preloads the site during the drive has built it (the contract
      // clock starts with the contract), at most driveLoadWaitSec past the drive timer
      else if (now >= s.driveEndsAt && (crewLoaded(crew, s) || now >= s.driveEndsAt + num(mb().driveLoadWaitSec, 30) * 1000)) startContract(crew);
      break;
    case 'contract': {
      if (!s.active) {
        // phase set by someone else (dbg) without an order: adopt the picked/first order
        s.active = s.orders.find((o) => o.id === s.picked) ?? s.orders[0] ?? null;
        if (!s.active) break;
        s.contractStartedAt = now;
        s.ended = false;
      }
      if (s.ended) break;
      // v1.2 stats: distance / stance / light / radio sampler
      try { statsTick(crew, 1 / 30); } catch (err) { ctx.log('meta').warn('statsTick threw:', err instanceof Error ? err.message : err); }
      // safety net when (a) objectives is missing or never ends the contract
      const sec = num(ctx.balance.core.contractRealSec, 900);
      const grace = A.has('objectives', 'onContractEnd') ? 90 : 2;
      if (now - s.contractStartedAt > (sec + grace) * 1000) finishContract(crew, {}, 'timeout');
      break;
    }
    case 'results':
      if (now >= s.resultsEndsAt && s.resultsEndsAt > 0) continueFromResults(crew);
      break;
  }
  flushUpdates(crew);
}

/** phase changed by someone else (core dbg.setPhase, net restore): keep our slice consistent */
export function onForeignPhase(crew: Crew, from: Crew['phase'], to: Crew['phase']): void {
  const s = S(crew);
  if (s.transition) return;
  if (to === 'hub') {
    if (!crew.layout || crew.layout.kind !== 'hub') crew.layout = A.generateHubLayout();
    s.active = null;
    s.picked = null;
    s.ended = true;
    s.hubStarted = false;
    s.results = null;
    if (!s.orders.length) newBoard(crew);
  } else if (to === 'contract' && from !== 'contract') {
    if (!s.active) s.active = s.orders.find((o) => o.id === s.picked) ?? s.orders[0] ?? null;
    if (s.active && (!crew.layout || crew.layout.kind !== 'facility')) {
      try {
        crew.layout = A.generateFacilityLayout(crew, facilityParams(crew, s.active));
      } catch { /* keep */ }
    }
    s.contractStartedAt = ctxOf().now();
    s.ended = false;
    s.deaths = [];
    s.contractId++;
    beginContractStats(crew);
    const order = s.active;
    if (order) setImmediate(() => {
      A.call('objectives', 'startContract', crew, order);
      A.call('monsters', 'startMonsters', crew, { risk: order.risk, contractIndex: s.shift.contract });
    });
  } else if (to === 'results' && !s.results) {
    s.resultsEndsAt = ctxOf().now() + 15_000;
  }
  markDirty(crew);
}
