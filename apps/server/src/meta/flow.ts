// Owner: track (d) Meta. Phase orchestration + economy + careers + saves (PLAN §1, §3.6, §4.11).
//   hub (board, ready, shop, creator) -> drive (6 s, rule cards) -> contract (② layout, (a) objectives, (c) monsters)
//   -> results (on (a) onContractEnd; per-contract results) -> hub; after 3 contracts: quota check + HR memo.
import type { Crew, ServerContext, ServerPlayer } from '../core/types.ts';
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import type { WorkOrder } from '@dead-air/shared/workorder.ts';
import type { ContractResult, CrewSave, PlayerSave } from '@dead-air/shared/saves.ts';
import type { Profile } from '@dead-air/shared/profile.ts';
import { HELMET_UNLOCK_LEVEL, PROFILE_LIMITS, VISOR_COLORS } from '@dead-air/shared/profile.ts';
import type {
  MetaContractResults, MetaDeathCard, MetaHeardDid, MetaShiftReview, MetaShopItem, MetaState, MetaXpLine,
} from '@dead-air/shared/messages/meta.ts';
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

// ---------------------------------------------------------------- types

export interface MetaCrew {
  shift: CrewSave['shift'] & { quotaLocked: boolean };
  /** owner player id ('crew' = company gear) -> item type -> count */
  gear: Record<string, Record<string, number>>;
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
  quotes: Record<string, string[]>;
  shiftStats: Record<string, { deaths: number; survived: number; contracts: number }>;
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

const GEAR_TYPES = new Set(['walkie', 'crowbar', 'bottle', 'glowstick', 'medkit']);
const VISOR_NAMES = ['CYAN', 'RED', 'ACID', 'AMBER', 'PINK', 'WHITE'];

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
    shiftStats: {},
    deaths: [],
    members: saved?.members ?? [],
    participants: [],
    dirty: true,
    hubStarted: false,
    transition: false,
  };
  // gear persisted as CrewSave.shift.gear: 'owner|type' -> count
  for (const [k, n] of Object.entries(s.shift.gear)) {
    const [owner, type] = k.includes('|') ? k.split('|') : ['crew', k];
    (s.gear[owner] ??= {})[type] = n;
  }
  if (!saved) (s.gear.crew ??= {}).walkie = num(mb().freeWalkiesPerShift, 2);
  crew.slices.meta = s;
  return s;
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
  const st: MetaState = {
    shift: {
      index: s.shift.index, contract: s.shift.contract, quota: s.shift.quota, hauled: s.shift.hauled,
      balance: s.shift.balance, quotasMet: s.shift.quotasMet, contractsPerShift: e.contractsPerShift,
    },
    careers,
    shop: shopItems().map((i) => ({ id: i.id, name: i.name, price: i.price, desc: i.desc })),
    picked: s.picked,
    gear: s.gear,
    drive: crew.phase === 'drive' && s.active
      ? {
          orderId: s.active.id, siteName: s.active.siteName, endsAt: s.driveEndsAt,
          rules: ruleCards(s.active.risk, s.active.risk >= 2 || s.shift.contract >= 2),
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

export function saveCrew(crew: Crew): void {
  if (!RT) return;
  const s = S(crew);
  const gear: Record<string, number> = {};
  for (const [owner, types] of Object.entries(s.gear)) for (const [t, n] of Object.entries(types)) if (n > 0) gear[`${owner}|${t}`] = n;
  const members = new Set(s.members);
  for (const p of crew.players.values()) members.add(P(p).saveId);
  s.members = [...members];
  const { quotaLocked: _q, ...shift } = s.shift;
  void _q;
  const save: CrewSave = {
    code: crew.code,
    members: s.members,
    shift: { ...shift, gear },
    history: s.history.slice(-50),
    updatedAt: new Date().toISOString(),
  };
  RT.store.putCrew(save);
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
  const list = L.items
    .filter((it) => it.kind in prompts && (L.kind === 'hub' || it.kind === 'console'))
    .map((it) => ({ id: it.id, kind: it.kind, p: [it.x, it.y && it.y > 0 ? it.y : (HUB_ITEM_Y[it.kind] ?? 1.1), it.z] as [number, number, number], prompt: prompts[it.kind], enabled: true }));
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
    s.pendingLayout = A.generateFacilityLayout(crew, { seed: order.seed, players: Math.max(1, connected(crew).length), risk: order.risk });
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

export function startContract(crew: Crew): void {
  const s = S(crew);
  const ctx = ctxOf();
  const order = s.active;
  if (!order) return enterHub(crew);
  const layout = s.pendingLayout ?? A.generateFacilityLayout(crew, { seed: order.seed, players: Math.max(1, connected(crew).length), risk: order.risk });
  s.pendingLayout = null;
  s.contractId++;
  s.contractStartedAt = ctx.now();
  s.ended = false;
  s.deaths = [];
  s.results = null;
  s.participants = connected(crew).map((p) => p.id);
  for (const p of crew.players.values()) p.ready = false;
  setPhase(crew, 'contract', layout);
  A.call('objectives', 'startContract', crew, order, { contractIndex: s.shift.contract });
  A.call('monsters', 'startMonsters', crew, { risk: order.risk, contractIndex: s.shift.contract });
  handOutGear(crew);
  hubInteractables(crew);
  markDirty(crew);
  // AI text for the next board (same shift): ready by results time
  if (s.shift.contract + 1 < econ().contractsPerShift) {
    prefetchBriefs(crew, { shiftIndex: s.shift.index, contract: s.shift.contract + 1, boardSeq: s.boardSeq + 1 });
  }
}

/** stack sizes of stackable gear (s.gear counts UNITS: 'Bottles x3' = 3 bottles = one stack) */
const GEAR_STACK: Record<string, number> = { bottle: 3, glowstick: 5 };

/** gear units a player already carries (stacks count their items), or null when (b) can't tell */
function heldUnits(crew: Crew, pid: string): Record<string, number> | null {
  if (!A.has('interaction', 'itemsOf')) return null;
  const r = A.call<unknown>('interaction', 'itemsOf', crew, pid);
  if (!Array.isArray(r)) return null;
  const out: Record<string, number> = {};
  for (const it of r) {
    const o = it && typeof it === 'object' ? (it as { type?: unknown; count?: unknown }) : null;
    const t = typeof it === 'string' ? it : String(o?.type ?? '');
    if (!t) continue;
    const n = o && Number(o.count) > 0 ? Math.round(Number(o.count)) : 1;
    out[t] = (out[t] ?? 0) + n;
  }
  return out;
}

/** top-up hand-out: everyone ends up with exactly their pool (what they kept + what they bought), never duplicates
 *  of what they still carry; the crew's free walkies go one per player who has none */
function handOutGear(crew: Crew): void {
  const s = S(crew);
  const ps = connected(crew).sort((a, b) => a.joinedAt - b.joinedAt);
  if (!ps.length || !A.has('interaction', 'giveItem')) return;
  const held = new Map(ps.map((p) => [p.id, heldUnits(crew, p.id) ?? {}]));
  const give = (pid: string, type: string, units: number): void => {
    if (units <= 0) return;
    const h = held.get(pid);
    if (h) h[type] = (h[type] ?? 0) + units;
    const stack = GEAR_STACK[type];
    if (!stack) { for (let i = 0; i < units; i++) A.giveItem(crew, pid, type); return; }
    for (let left = units; left > 0; left -= stack) A.call('interaction', 'giveItem', crew, pid, type, { count: Math.min(stack, left) });
  };
  let rr = 0;
  for (const [owner, types] of Object.entries(s.gear)) {
    const target = crew.players.get(owner);
    for (const [type, n0] of Object.entries(types)) {
      const n = Math.max(0, Math.round(Number(n0) || 0));
      if (target?.connected) { give(target.id, type, n - (held.get(target.id)?.[type] ?? 0)); continue; }
      if (type === 'walkie') {
        // company walkies: at most one per player, only to those without one
        let left = n;
        for (const p of ps) { if (left <= 0) break; if ((held.get(p.id)?.walkie ?? 0) > 0) continue; give(p.id, 'walkie', 1); left--; }
        continue;
      }
      // an absent owner's gear goes round-robin
      for (let i = 0; i < n; i++) give(ps[rr++ % ps.length].id, type, 1);
    }
  }
}

/** survivors keep the gear they carry; the dead lose theirs (only when (b) can tell us what people hold) */
function collectGear(crew: Crew, survivors: Set<string>): void {
  if (!A.has('interaction', 'itemsOf')) return;
  const s = S(crew);
  const next: Record<string, Record<string, number>> = {};
  for (const p of crew.players.values()) {
    if (!survivors.has(p.id)) continue;
    const units = heldUnits(crew, p.id);
    if (!units) return; // unknown -> keep the pool as it was
    for (const [t, n] of Object.entries(units)) {
      if (!GEAR_TYPES.has(t)) continue;
      const mine = (next[p.id] ??= {});
      mine[t] = (mine[t] ?? 0) + n;
    }
  }
  s.gear = next;
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
  const participants = [...crew.players.values()].filter((p) => part.has(p.id) || p.connected);

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
    const st = (s.shiftStats[p.id] ??= { deaths: 0, survived: 0, contracts: 0 });
    st.contracts++;
    if (lived) st.survived++;
    else st.deaths++;
  }

  // gear: survivors keep what they carry
  collectGear(crew, new Set(survivors));

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
  A.call('monsters', 'stopMonsters', crew);
  s.resultsEndsAt = ctxOf().now() + 12_000;
  setPhase(crew, 'results');
  markDirty(crew);
  return true;
}

function buildShiftReview(crew: Crew): void {
  const s = S(crew);
  const e = econ();
  const xpCfg = (mb().xp ?? {}) as Record<string, number>;
  const met = quotaMet(s.shift.hauled, s.shift.quota);
  const ot = overtime(e, s.shift.hauled, s.shift.quota);
  const nextQ = met ? nextQuota(e, s.shift.quota, s.shift.index + 1, crew.code) : null;
  if (met) s.shift.balance += ot;
  const players = [...crew.players.values()].filter((p) => s.shiftStats[p.id]).map((p) => {
    const st = s.shiftStats[p.id] ?? { deaths: 0, survived: 0, contracts: 0 };
    return { id: p.id, name: p.name, level: p.level, deaths: st.deaths, survived: st.survived, contracts: st.contracts, quotes: s.quotes[p.id] ?? [] };
  });
  for (const p of crew.players.values()) {
    if (!s.shiftStats[p.id]) continue;
    if (met) awardXp(crew, p.id, num(xpCfg.quotaMet, 100), 'quota met');
    else awardXp(crew, p.id, num(xpCfg.fired, 30), 'severance experience');
  }
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
        hauled: Math.round(s.shift.hauled / Math.max(1, players.length)),
        xp: saveOf(crew.players.get(p.id)!)?.xp ?? 0,
        causes: s.history.slice(-e.contractsPerShift).flatMap((h) => h.deaths.filter((d) => d.player === p.id).map((d) => d.cause)).slice(0, 4),
      })),
      contracts,
      template: review,
    };
    void A.reviewFor(summary, wait).then((ai) => {
      if (ai && S(crew).review === review && mergeAiReview(review, ai)) markDirty(crew);
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
  s.shift.balance -= item.price;
  const type = item.type ?? item.id;
  const mine = (s.gear[player.id] ??= {});
  mine[type] = (mine[type] ?? 0) + (item.qty ?? 1);
  ctxOf().notice(crew, `${player.name} bought ${item.name} (${item.price} scrip)`);
  saveCrew(crew);
  markDirty(crew);
  return { ok: true, balance: s.shift.balance };
}

// ---------------------------------------------------------------- tick

export function allReady(crew: Crew): boolean {
  const ps = connected(crew);
  return ps.length > 0 && ps.every((p) => p.ready);
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
      else if (now >= s.driveEndsAt) startContract(crew);
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
        crew.layout = A.generateFacilityLayout(crew, { seed: s.active.seed, players: Math.max(1, connected(crew).length), risk: s.active.risk });
      } catch { /* keep */ }
    }
    s.contractStartedAt = ctxOf().now();
    s.ended = false;
    s.deaths = [];
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
