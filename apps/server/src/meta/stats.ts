// Owner: meta-records (v1.2). Stats + collection-log recorder. Keep recordStat's signature. Counters only: never
// transcripts, quotes or chat text (an utterance only bumps chatLines).
//   - per-contract buffers keyed by SAVE id (observers skipped), committed once in finishContract (commitContract)
//   - outside a contract (hub crafting, store purchases) a counter goes straight into the save
//   - collection log: first find per save -> PlayerSave.collection + 'meta.collection' (private to the finder)
// flow.ts imports this file and this file imports flow.ts back: flow functions are only used inside function bodies.
import type { Crew, ServerPlayer } from '../core/types.ts';
import { isObserver } from '../core/crews.ts';
import { STANCE } from '@dead-air/shared/state.ts';
import { emptyStats } from '@dead-air/shared/progress.ts';
import type { CrewRecords, PlayerStatsV1, ShiftStatLine } from '@dead-air/shared/progress.ts';
import type { PlayerSave } from '@dead-air/shared/saves.ts';
import { ACHIEVEMENTS, collectionCatalog, collectionKey, collectionLabel } from '@dead-air/shared/messages/meta.ts';
import type { MetaDeathCard, MetaPlayerLine, MetaXpLine } from '@dead-air/shared/messages/meta.ts';
import type { ItemEvent } from '@dead-air/shared/messages/interaction.ts';
import type { MonsterEvent } from '@dead-air/shared/messages/monsters.ts';
import { CURIO_TYPE, isMaterial } from '@dead-air/shared/catalog.ts';
import { P, S, awardXp, markDirty, runtime, saveCrew } from './flow.ts';
import * as A from './adapters.ts';

// ---------------------------------------------------------------- keys

const NUM_KEYS: ReadonlySet<string> = new Set(
  Object.entries(emptyStats('')).filter(([k, v]) => typeof v === 'number' && k !== 'v').map(([k]) => k),
);
/** computed by meta at commit: other modules' recordStat calls for these are ignored */
const DERIVED: ReadonlySet<string> = new Set([
  'contracts', 'extracted', 'wipes', 'survived', 'deaths', 'leftBehind', 'shifts', 'quotasMet', 'fired', 'bestHaul',
  'cleanStreak', 'bestCleanStreak', 'coresExtracted',
]);
const MONSTER_KILLERS: ReadonlySet<string> = new Set(['HOUND', 'LISTENER', 'MANNEQUIN', 'SNATCHER']);
export const LEFT_BEHIND = 'LEFT BEHIND';

/** death-card killer -> killedBy key: uppercased; the Company and the van (left behind at 04:00) are LEFT BEHIND */
export function killerKey(k: string | null | undefined): string {
  const u = String(k ?? 'UNKNOWN').toUpperCase().replace(/\s+/g, ' ').trim().slice(0, 24) || 'UNKNOWN';
  return u === 'COMPANY' || u === 'THE COMPANY' || u === 'VAN' || u === 'THE VAN' || u === LEFT_BEHIND ? LEFT_BEHIND : u;
}

function validKey(key: string): boolean {
  if (NUM_KEYS.has(key)) return !DERIVED.has(key);
  return /^itemsUsed\.[A-Za-z0-9_.-]{1,40}$/.test(key) || /^killedBy\.[A-Za-z .'-]{1,24}$/.test(key);
}

// ---------------------------------------------------------------- slice

export interface StatBuf {
  n: Record<string, number>;
  itemsUsed: Record<string, number>;
  killedBy: Record<string, number>;
  /** collection keys first found this contract */
  finds: string[];
}

interface StatsSlice {
  /** S(crew).contractId the buffers belong to */
  contract: number;
  bufs: Map<string, StatBuf>;
  /** live pid -> last sampled floor position */
  last: Map<string, [number, number]>;
  tickN: number;
  /** first death of the contract (FIRST TO VOLUNTEER) */
  firstDeath: { pid: string; at: number } | null;
  lastSwing: Map<string, number>;
  lastUse: Map<string, number>;
  lastBadge: Map<string, number>;
}

const emptyBuf = (): StatBuf => ({ n: {}, itemsUsed: {}, killedBy: {}, finds: [] });

function slice(crew: Crew): StatsSlice {
  let st = crew.slices.metaStats as StatsSlice | undefined;
  const cid = crew.slices.meta ? S(crew).contractId : 0;
  if (!st || st.contract !== cid) {
    st = { contract: cid, bufs: new Map(), last: new Map(), tickN: 0, firstDeath: null, lastSwing: new Map(), lastUse: new Map(), lastBadge: new Map() };
    crew.slices.metaStats = st;
  }
  return st;
}

/** a new contract: fresh buffers (startContract) */
export function beginContractStats(crew: Crew): void {
  delete crew.slices.metaStats;
  slice(crew);
}

/** voided contract: nothing it counted is kept */
export function discardContractStats(crew: Crew): void {
  delete crew.slices.metaStats;
}

function bufOf(crew: Crew, sid: string): StatBuf {
  const st = slice(crew);
  let b = st.bufs.get(sid);
  if (!b) st.bufs.set(sid, (b = emptyBuf()));
  return b;
}

/** buffered counters of a save this contract (results lines, tests) */
export function contractBuf(crew: Crew, sid: string): StatBuf | null {
  const st = crew.slices.metaStats as StatsSlice | undefined;
  return st?.bufs.get(sid) ?? null;
}

const nowIso = (): string => new Date().toISOString();
const mb = (): Record<string, unknown> => (runtime()?.ctx.balance.meta ?? {}) as Record<string, unknown>;
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** statsV12 gates the recorder (never persistence: saved stats stay readable) */
export function statsOn(): boolean {
  return runtime()?.ctx.flags.statsV12 !== false;
}

function playerOf(crew: Crew, pid: string | null | undefined): ServerPlayer | null {
  if (!pid) return null;
  const p = crew.players.get(pid);
  return p && !isObserver(p) ? p : null;
}

function sidOf(crew: Crew, pid: string | null | undefined): string | null {
  const p = playerOf(crew, pid);
  return p ? P(p).saveId : null;
}

function add(crew: Crew, pid: string | null | undefined, key: string, n = 1): void {
  const sid = sidOf(crew, pid);
  if (!sid || !n) return;
  const b = bufOf(crew, sid);
  if (key.startsWith('itemsUsed.')) {
    const t = key.slice(10);
    b.itemsUsed[t] = (b.itemsUsed[t] ?? 0) + n;
  } else if (key.startsWith('killedBy.')) {
    const k = killerKey(key.slice(9));
    b.killedBy[k] = (b.killedBy[k] ?? 0) + n;
  } else b.n[key] = (b.n[key] ?? 0) + n;
}

// ---------------------------------------------------------------- public recorder

/** add n to pid's counter this contract: a numeric PlayerStatsV1 key, 'itemsUsed.<type>' or 'killedBy.<KILLER>';
 *  buffered, committed in finishContract; unknown keys ignored */
export function recordStat(crew: Crew, pid: string, key: string, n = 1): void {
  try {
    if (!crew || !statsOn()) return;
    const v = Number(n);
    if (!Number.isFinite(v) || v === 0 || typeof key !== 'string' || !validKey(key)) return;
    const player = playerOf(crew, pid);
    if (!player) return;
    if (crew.phase === 'contract') add(crew, pid, key, v);
    else applyNow(crew, player, key, v);
  } catch (e) {
    runtime()?.ctx.log('meta').warn('recordStat failed:', e instanceof Error ? e.message : e);
  }
}

const SHIFT_KEYS: Readonly<Record<string, keyof ShiftStatLine>> = { crafted: 'crafted', scrapped: 'scrapped', revivesGiven: 'revives' };

export function emptyShiftLine(): ShiftStatLine {
  return { contracts: 0, survived: 0, deaths: 0, hauled: 0, revives: 0, crafted: 0, scrapped: 0 };
}

/** outside a contract (hub crafting, purchases): straight into the save, then commendations */
function applyNow(crew: Crew, player: ServerPlayer, key: string, v: number): void {
  const rt = runtime();
  const sid = P(player).saveId;
  const sv = rt?.store.playerById(sid);
  if (!rt || !sv) return;
  const st = (sv.stats ??= emptyStats(nowIso()));
  if (key.startsWith('itemsUsed.')) st.itemsUsed[key.slice(10)] = (st.itemsUsed[key.slice(10)] ?? 0) + v;
  else if (key.startsWith('killedBy.')) st.killedBy[killerKey(key.slice(9))] = (st.killedBy[killerKey(key.slice(9))] ?? 0) + v;
  else (st as unknown as Record<string, number>)[key] = ((st as unknown as Record<string, number>)[key] ?? 0) + v;
  st.lastAt = nowIso();
  rt.store.putPlayer(sv);
  const sk = SHIFT_KEYS[key];
  if (sk && crew.slices.meta) {
    const line = (S(crew).shiftStats[sid] ??= emptyShiftLine());
    line[sk] += v;
    saveCrew(crew);
  }
  for (const name of checkAchievements(sv)) {
    awardXp(crew, player.id, achievementXp(), `commendation: ${name}`);
    rt.ctx.notice(crew, `${player.name} earned a Company commendation: ${name.toUpperCase()}`);
  }
  markDirty(crew);
}

// ---------------------------------------------------------------- commendations

export function achievementXp(): number {
  return num(mb().achievementXp, 50);
}

function achievementAt(name: string, d: number): number {
  const o = mb().achievements as Record<string, unknown> | undefined;
  return num(o?.[name], d);
}

/** distinct monsters that killed this player (LEFT BEHIND excluded) */
export function monsterKinds(st: PlayerStatsV1): number {
  return Object.entries(st.killedBy ?? {}).filter(([k, n]) => n > 0 && MONSTER_KILLERS.has(k)).length;
}

/** add every commendation the save now qualifies for; returns the new names (caller awards the XP) */
export function checkAchievements(sv: PlayerSave): string[] {
  const st = sv.stats;
  if (!st) return [];
  const out: string[] = [];
  for (const a of ACHIEVEMENTS) {
    if (sv.achievements.includes(a.name)) continue;
    const v = a.stat === 'monsterKinds' ? monsterKinds(st)
      : a.stat === 'curioFinds' ? Object.keys(sv.collection ?? {}).filter((k) => k.startsWith('curio:')).length
        : Number((st as unknown as Record<string, unknown>)[a.stat] ?? 0);
    if (v >= achievementAt(a.name, a.at)) {
      sv.achievements.push(a.name);
      out.push(a.name);
    }
  }
  return out;
}

// ---------------------------------------------------------------- collection log

/** first find of a catalog entry for this player's save (any phase): log it and tell the finder */
export function noteFind(crew: Crew, pid: string, type: string, name?: string | null): string | null {
  const rt = runtime();
  if (!rt || !statsOn()) return null;
  const key = collectionKey(type, name);
  const player = playerOf(crew, pid);
  if (!key || !player) return null;
  const sid = P(player).saveId;
  const sv = rt.store.playerById(sid);
  if (!sv) return null;
  const col = (sv.collection ??= {});
  if (col[key]) return null;
  const order = crew.slices.meta ? S(crew).active : null;
  const site = crew.phase === 'contract' && order ? order.siteName : crew.phase === 'hub' ? 'VAN 9' : (order?.siteName ?? 'VAN 9');
  col[key] = { at: nowIso(), site, crew: crew.code };
  rt.store.putPlayer(sv);
  const cat = collectionCatalog();
  const keys = new Set(cat.map((d) => d.key));
  const total = Object.keys(col).filter((k) => keys.has(k)).length;
  rt.ctx.emit(crew, 'meta.collection', { key, label: collectionLabel(key), total, of: cat.length }, { to: [player.id] });
  if (crew.phase === 'contract') bufOf(crew, sid).finds.push(key);
  return key;
}

/** collection-log entries a save holds that are in the catalog */
export function collectionCount(sv: PlayerSave | null | undefined): number {
  const keys = new Set(collectionCatalog().map((d) => d.key));
  return Object.keys(sv?.collection ?? {}).filter((k) => keys.has(k)).length;
}

// ---------------------------------------------------------------- event subscriptions (wired in index.ts)

const inContract = (crew: Crew): boolean => crew.phase === 'contract' && statsOn();
const ms = (): number => runtime()?.ctx.now() ?? Date.now();

/** interaction onDeath (meta's recordDeath runs too): every death counts, killer per death */
export function statDeath(crew: Crew, pid: string, killer: string): void {
  if (!inContract(crew) || !playerOf(crew, pid)) return;
  add(crew, pid, 'deaths', 1);
  add(crew, pid, `killedBy.${killerKey(killer)}`, 1);
  const st = slice(crew);
  if (!st.firstDeath) st.firstDeath = { pid, at: ms() };
}

/** interaction onDeposit: loot carried into the van */
export function statDeposit(crew: Crew, pid: string, items: readonly { type: string; value?: number; name?: string }[]): void {
  if (!inContract(crew) || !Array.isArray(items)) return;
  for (const it of items) {
    if (!it || typeof it.type !== 'string') continue;
    if (!it.type.startsWith('loot.')) continue;
    add(crew, pid, 'lootItems', 1);
    add(crew, pid, 'lootValue', Math.max(0, Math.round(Number(it.value) || 0)));
    if (it.type === 'loot.heavy') add(crew, pid, 'heavyItems', 1);
    else if (it.type === 'loot.idol') add(crew, pid, 'idols', 1);
    else if (it.type === CURIO_TYPE) add(crew, pid, 'curios', 1);
  }
}

/** interaction onRevive: a badge filing is the filer's badgesFiled; a medkit the reviver's revivesGiven */
export function statRevive(crew: Crew, pid: string, how: string, by: string | null): void {
  if (!inContract(crew)) return;
  add(crew, pid, 'revivedTimes', 1);
  if (!by || by === pid || !playerOf(crew, by)) return;
  if (how === 'badge') {
    const t = slice(crew).lastBadge.get(by) ?? -1e9;
    if (ms() - t > 2500) add(crew, by, 'badgesFiled', 1);
  } else add(crew, by, 'revivesGiven', 1);
}

export function statDoor(crew: Crew, _id: number, open: boolean, by: string | null): void {
  if (!inContract(crew) || !open || !by) return;
  add(crew, by, 'doorsOpened', 1);
}

/** interaction onMelee: every swing (returns nothing: never claims a hit) */
export function statMelee(crew: Crew, pid: string): void {
  if (!inContract(crew)) return;
  add(crew, pid, 'crowbarSwings', 1);
  slice(crew).lastSwing.set(pid, ms());
}

/** interaction onItemEvent */
export function statItemEvent(crew: Crew, e: ItemEvent): void {
  if (!e || typeof e.pid !== 'string' || typeof e.type !== 'string') return;
  if ((e.kind === 'pickup' && e.fresh) || e.kind === 'acquire') noteFind(crew, e.pid, e.type, e.name);
  if (!inContract(crew)) return;
  const st = slice(crew);
  switch (e.kind) {
    case 'use':
      add(crew, e.pid, `itemsUsed.${e.type}`, 1);
      if (e.id) st.lastUse.set(e.id, ms());
      break;
    case 'consume': {
      // a use that also consumes the item emits both: count it once
      const t = e.id ? st.lastUse.get(e.id) : undefined;
      if (t === undefined || ms() - t > 1500) add(crew, e.pid, `itemsUsed.${e.type}`, 1);
      break;
    }
    case 'deposit':
      if (e.type === 'badge') {
        add(crew, e.pid, 'badgesFiled', 1);
        st.lastBadge.set(e.pid, ms());
      }
      break;
    case 'stash':
      if (isMaterial(e.type)) add(crew, e.pid, 'materials', Math.max(1, Math.round(Number(e.count) || 1)));
      break;
    default:
      break;
  }
}

/** monsters onMonsterEvent */
export function statMonsterEvent(crew: Crew, e: MonsterEvent): void {
  if (!inContract(crew) || !e) return;
  const v = e.victim;
  const by = typeof e.by === 'string' && playerOf(crew, e.by) ? e.by : null;
  switch (e.event) {
    case 'alert': if (e.monster === 'hound') add(crew, v, 'houndAlerts', 1); break;
    case 'grab': add(crew, v, 'grabbed', 1); break;
    case 'knockdown': add(crew, v, 'knockdowns', 1); break;
    case 'snatch': add(crew, v, 'snatched', 1); break;
    case 'escaped': add(crew, v, 'escapes', 1); break;
    case 'freed':
    case 'rescued':
      add(crew, v, 'escapes', 1);
      if (by && by !== v) {
        add(crew, by, 'rescues', 1);
        const sw = slice(crew).lastSwing.get(by);
        if (e.event === 'freed' && sw !== undefined && ms() - sw < 1200) add(crew, by, 'crowbarHits', 1);
      }
      break;
    default:
      break;
  }
}

/** monsters listener.onDecision: the Listener acted on something this player said */
export function statDecision(crew: Crew, d: { valid?: boolean; action?: string; speakerId?: string | null }): void {
  if (!inContract(crew) || !d || d.valid === false || d.action === 'ignore' || !d.speakerId) return;
  add(crew, d.speakerId, 'listenerUsedYourWords', 1);
}

/** ai onUtterance: counted, never stored */
export function statUtterance(crew: Crew, speaker: string): void {
  if (!inContract(crew)) return;
  add(crew, speaker, 'chatLines', 1);
}

/** hooks.loud: a rising edge into band 4 is a scream */
export function statLoud(crew: Crew, player: ServerPlayer, prevBand: number): void {
  if (!inContract(crew)) return;
  if (prevBand < 4 && player.band >= 4) add(crew, player.id, 'screams', 1);
}

/** paranormal onPhenomenon: one per witness */
export function statPhenomenon(crew: Crew, rec: { witnesses?: readonly string[] }): void {
  if (!inContract(crew)) return;
  for (const w of rec?.witnesses ?? []) add(crew, w, 'phenomenaSeen', 1);
}

// ---------------------------------------------------------------- tick sampler (contract phase, 30 Hz)

export function statsTick(crew: Crew, dt: number): void {
  if (!inContract(crew)) return;
  const st = slice(crew);
  const every6 = ++st.tickN % 6 === 0;
  for (const p of crew.players.values()) {
    if (!p.connected || isObserver(p)) {
      st.last.delete(p.id);
      continue;
    }
    const alive = A.isAlive(crew, p.id) ?? p.alive;
    if (!alive) {
      st.last.delete(p.id);
      continue;
    }
    const pos = p.pose?.p;
    if (!pos) continue;
    add(crew, p.id, 'timeOnSiteSec', dt);
    const stance = A.stealthStance(crew, p.id);
    const prev = st.last.get(p.id);
    st.last.set(p.id, [pos[0], pos[2]]);
    if (prev) {
      const d = Math.hypot(pos[0] - prev[0], pos[2] - prev[1]);
      if (d > 0.002 && d <= 3) {
        add(crew, p.id, 'distanceM', d);
        if (stance === STANCE.sprint) add(crew, p.id, 'sprintM', d);
        else if (stance === STANCE.crouch) add(crew, p.id, 'crouchM', d);
      }
    }
    if (stance === STANCE.crouch) add(crew, p.id, 'crouchSec', dt);
    if (p.pose.light) add(crew, p.id, 'flashlightSec', dt);
    if (p.radio === 1) add(crew, p.id, 'radioSec', dt);
    if (every6) {
      if (A.call<boolean>('interaction', 'isHidden', crew, p.id) === true) add(crew, p.id, 'hiddenSec', dt * 6);
      if (nvOn(crew, p.id)) add(crew, p.id, 'nvSec', dt * 6);
    }
  }
}

function nvOn(crew: Crew, pid: string): boolean {
  if (A.has('interaction', 'nightVision')) return A.call<boolean>('interaction', 'nightVision', crew, pid) === true;
  const s = A.call<{ nv?: Record<string, boolean> }>('interaction', 'state', crew);
  return !!s?.nv?.[pid];
}

// ---------------------------------------------------------------- commit (finishContract, after XP, before flush)

export interface CommitInput {
  outcome: string;
  participants: readonly ServerPlayer[];
  /** live pid -> death card (died this contract, incl. left behind) */
  cards: ReadonlyMap<string, MetaDeathCard>;
  coreExtracted: boolean;
  /** crew haul this contract */
  hauled: number;
  siteName: string;
  /** contract seconds from start to the first death (FIRST TO VOLUNTEER label) */
  startedAt: number;
  /** finishContract's XP lines: commendations add their +XP and an unlock line here */
  xpLines: MetaXpLine[];
}

export interface CommitOutput {
  players: MetaPlayerLine[];
  superlatives: { title: string; player: string; name: string; why: string }[];
}

export function emptyRecords(): CrewRecords {
  return { bestHaul: 0, bestHaulSite: '', bestHaulAt: '', quotaStreak: 0, bestQuotaStreak: 0, cores: 0, contracts: 0, wipes: 0 };
}

export function commitContract(crew: Crew, inp: CommitInput): CommitOutput {
  const rt = runtime();
  const out: CommitOutput = { players: [], superlatives: [] };
  if (!rt) return out;
  const s = S(crew);
  const now = nowIso();
  // crew records
  const rec = (s.records ??= emptyRecords());
  rec.contracts++;
  if (inp.outcome === 'wiped') rec.wipes++;
  if (inp.coreExtracted) rec.cores++;
  if (inp.hauled > rec.bestHaul) {
    rec.bestHaul = inp.hauled;
    rec.bestHaulSite = inp.siteName;
    rec.bestHaulAt = now;
  }
  const on = statsOn();
  const st = slice(crew);
  const seen = new Set<string>();
  const lines: { p: ServerPlayer; sid: string; b: StatBuf; lived: boolean }[] = [];
  for (const p of inp.participants) {
    if (isObserver(p)) continue;
    const sid = P(p).saveId;
    if (seen.has(sid)) continue;
    seen.add(sid);
    const sv = rt.store.playerById(sid);
    const b = (on ? st.bufs.get(sid) : null) ?? emptyBuf();
    const card = inp.cards.get(p.id);
    const lived = !card;
    lines.push({ p, sid, b, lived });
    // shift line (HR memo, every build): persisted in CrewSave.shiftStats
    const sl = (s.shiftStats[sid] ??= emptyShiftLine());
    sl.contracts++;
    if (lived) sl.survived++;
    else sl.deaths++;
    sl.hauled += Math.round(b.n.lootValue ?? 0);
    sl.revives += b.n.revivesGiven ?? 0;
    sl.scrapped += b.n.scrapped ?? 0;
    sl.crafted += b.n.crafted ?? 0;
    if (!sv || !on) continue;
    const ps = (sv.stats ??= emptyStats(now));
    const rec2 = ps as unknown as Record<string, number>;
    for (const [k, v] of Object.entries(b.n)) {
      if (!NUM_KEYS.has(k) || !Number.isFinite(v)) continue;
      rec2[k] = (rec2[k] ?? 0) + v;
    }
    for (const [t, v] of Object.entries(b.itemsUsed)) ps.itemsUsed[t] = (ps.itemsUsed[t] ?? 0) + v;
    for (const [k, v] of Object.entries(b.killedBy)) ps.killedBy[k] = (ps.killedBy[k] ?? 0) + v;
    // a death the bus never reported (left behind at 04:00, dbg results): one, by the card's killer
    if (card && !(b.n.deaths > 0)) {
      ps.deaths++;
      const k = killerKey(card.killer);
      ps.killedBy[k] = (ps.killedBy[k] ?? 0) + 1;
    }
    if (card && killerKey(card.killer) === LEFT_BEHIND) ps.leftBehind++;
    ps.contracts++;
    if (lived) ps.survived++;
    if (lived && inp.outcome === 'extracted') ps.extracted++;
    if (inp.outcome === 'wiped') ps.wipes++;
    if (inp.coreExtracted) ps.coresExtracted++;
    ps.bestHaul = Math.max(ps.bestHaul, Math.round(b.n.lootValue ?? 0));
    ps.cleanStreak = lived ? ps.cleanStreak + 1 : 0;
    ps.bestCleanStreak = Math.max(ps.bestCleanStreak, ps.cleanStreak);
    // round the float accumulators so the file stays readable
    for (const k of ['timeOnSiteSec', 'distanceM', 'sprintM', 'crouchM', 'crouchSec', 'hiddenSec', 'flashlightSec', 'nvSec', 'radioSec'] as const) {
      ps[k] = Math.round(ps[k] * 10) / 10;
    }
    ps.lastAt = now;
    const fresh = checkAchievements(sv);
    rt.store.putPlayer(sv);
    for (const name of fresh) {
      const xp = awardXp(crew, p.id, achievementXp(), `commendation: ${name}`);
      const line = inp.xpLines.find((x) => x.player === p.id);
      if (line) {
        line.gained += achievementXp();
        line.reasons.push({ text: `commendation: ${name}`, xp: achievementXp() });
        line.unlocks.push(`commendation: ${name}`);
        if (xp) {
          line.xp = xp.xp;
          line.level = xp.level;
          line.levelUp = line.levelUp || xp.levelUp;
          for (const u of xp.unlocks) if (!line.unlocks.includes(u)) line.unlocks.push(u);
        }
      }
    }
  }
  if (!on) {
    discardContractStats(crew);
    return out;
  }
  // per-player result lines
  for (const { p, b } of lines) {
    out.players.push({
      player: p.id, name: p.name, hauled: Math.round(b.n.lootValue ?? 0), items: Math.round(b.n.lootItems ?? 0),
      deaths: Math.max(b.n.deaths ?? 0, inp.cards.has(p.id) ? 1 : 0), revives: Math.round(b.n.revivesGiven ?? 0),
      creptM: Math.round(b.n.crouchM ?? 0), finds: b.finds.map((k) => collectionLabel(k)),
    });
  }
  out.superlatives = superlatives(crew, lines.map((l) => ({ id: l.p.id, name: l.p.name, b: l.b })), inp, st);
  discardContractStats(crew);
  return out;
}

const clockAt = (crew: Crew, startedAt: number, at: number): string => {
  const real = num(runtime()?.ctx.balance.core.contractRealSec, 900);
  const min = Math.max(0, Math.min(359, Math.floor(((at - startedAt) / 1000 / Math.max(1, real)) * 360)));
  const t = (22 * 60 + min) % (24 * 60);
  void crew;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

function superlatives(crew: Crew, ps: { id: string; name: string; b: StatBuf }[], inp: CommitInput, st: StatsSlice): CommitOutput['superlatives'] {
  const n = (x: StatBuf, k: string) => x.n[k] ?? 0;
  const best = (score: (b: StatBuf) => number, min: number) => {
    let top: { id: string; name: string; v: number } | null = null;
    for (const p of ps) {
      const v = score(p.b);
      if (v >= min && (!top || v > top.v)) top = { id: p.id, name: p.name, v };
    }
    return top;
  };
  const cands: { title: string; pick: { id: string; name: string; v: number } | null; why: (v: number) => string }[] = [
    { title: 'EMPLOYEE OF THE CONTRACT', pick: best((b) => n(b, 'lootValue'), 1), why: (v) => `hauled ${Math.round(v)} scrip of salvage` },
    { title: 'QUIETEST FEET', pick: best((b) => n(b, 'crouchM'), 15), why: (v) => `crept ${Math.round(v)} m` },
    { title: 'FIELD MEDIC', pick: best((b) => n(b, 'revivesGiven'), 1), why: (v) => `${v} revive${v === 1 ? '' : 's'}` },
    { title: 'SCRAPPER', pick: best((b) => n(b, 'scrapped'), 1), why: (v) => `scrapped ${v} item${v === 1 ? '' : 's'} for parts` },
    { title: 'COLLECTOR', pick: best((b) => b.finds.length, 2), why: (v) => `${v} new finds for the collection log` },
    {
      title: 'FIRST TO VOLUNTEER',
      pick: st.firstDeath && ps.some((p) => p.id === st.firstDeath!.pid) ? { id: st.firstDeath.pid, name: ps.find((p) => p.id === st.firstDeath!.pid)!.name, v: st.firstDeath.at } : null,
      why: (v) => `first to die (for science), ${clockAt(crew, inp.startedAt, v)}`,
    },
    {
      title: 'MOST AUDIBLE',
      pick: best((b) => n(b, 'screams') * 5 + n(b, 'chatLines') + n(b, 'radioSec') / 5, 6),
      why: () => '',
    },
  ];
  const out: CommitOutput['superlatives'] = [];
  const used = new Set<string>();
  const solo = ps.length <= 1;
  for (const c of cands) {
    if (out.length >= 3) break;
    if (!c.pick || (!solo && used.has(c.pick.id))) continue;
    used.add(c.pick.id);
    let why = c.why(c.pick.v);
    if (c.title === 'MOST AUDIBLE') {
      const b = ps.find((p) => p.id === c.pick!.id)!.b;
      const bits = [n(b, 'screams') ? `${n(b, 'screams')} scream${n(b, 'screams') === 1 ? '' : 's'}` : '', n(b, 'chatLines') ? `${n(b, 'chatLines')} lines said` : '', n(b, 'radioSec') >= 5 ? `${Math.round(n(b, 'radioSec'))} s on the radio` : ''].filter(Boolean);
      why = bits.join(', ') || 'heard all over the site';
    }
    out.push({ title: c.title, player: c.pick.id, name: c.pick.name, why });
  }
  return out;
}

// ---------------------------------------------------------------- shift end (buildShiftReview)

/** every save in this shift's lines: shifts, quotasMet / fired; crew quota streak */
export function commitShift(crew: Crew, met: boolean): void {
  const rt = runtime();
  if (!rt) return;
  const s = S(crew);
  const rec = (s.records ??= emptyRecords());
  rec.quotaStreak = met ? rec.quotaStreak + 1 : 0;
  rec.bestQuotaStreak = Math.max(rec.bestQuotaStreak, rec.quotaStreak);
  for (const sid of Object.keys(s.shiftStats)) {
    const sv = rt.store.playerById(sid);
    if (!sv) continue;
    const ps = (sv.stats ??= emptyStats(nowIso()));
    ps.shifts++;
    if (met) ps.quotasMet++;
    else ps.fired++;
    ps.lastAt = nowIso();
    rt.store.putPlayer(sv);
  }
}
