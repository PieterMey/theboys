// Owner: track (d) Meta. v1.3 F5 Company Line v0, RULE MODE (flag companyLine; a missing flag = off).
//   At shift start (hub, contract 0) the van phone rings: the Company's regional manager announces the shift's growth
//   target. Anyone in the van picks up ('meta.phone' answer) and the crew types lines (say); the keyword classifier
//   (company-words.ts) + rule brain answer through the bounded deal engine (deals.ts). The signed term sheet:
//     - quota % on this shift's quota, applied before quotaLocked (flow.ts startDrive / refreshBoard)
//     - payout % on each contract's haul (spendable scrip only, finishContract)
//     - hazard pay through the work orders' EXTRACT_ABOVE Company Request
//     - up to maxConditions harder-site modifier chips on the shift's work orders (DARK, MAZE, ...)
//   Unanswered for ringSec (or the van leaves while it rings) = missed: the opening target stands (+5..10%).
//   CrewSave.companyFile keeps counts and numbers only (calls, misses, insults, mood, promised vs delivered, terms);
//   the call's lines live in memory while the call is on screen and are never saved or logged.
import type { Crew, ServerPlayer } from '../core/types.ts';
import { isObserver } from '../core/crews.ts';
import { makeRng } from '@dead-air/shared/rng.ts';
import type { CompanyFileV1, CompanyTermsV1 } from '@dead-air/shared/saves.ts';
import type { MetaCall, MetaCallLine, MetaShiftTerms, MetaTerms } from '@dead-air/shared/messages/meta.ts';
import type { CompanyRequest, WorkOrder } from '@dead-air/shared/workorder.ts';
import { S, econ, markDirty, runtime, saveCrew } from './flow.ts';
import { playerMult } from './economy.ts';
import {
  clampTerms, dealBounds, dealPay, dealtQuota, legalDecisions, offerText, openCall, ruleDecide, step,
} from './deals.ts';
import type { CallState, CrewRecord, DealBounds, Terms } from './deals.ts';
import { classifyLine, daleLine, replyKey } from './company-words.ts';
import type { DaleKey } from './company-words.ts';
import { cleanText, maskLine, textBlocked } from './safety.ts';

// ---------------------------------------------------------------- config

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
function cfg(): Record<string, unknown> {
  const m = (runtime()?.ctx.balance.meta ?? {}) as Record<string, unknown>;
  return (m.companyLine && typeof m.companyLine === 'object' ? m.companyLine : {}) as Record<string, unknown>;
}
const sec = (k: string, d: number) => Math.max(0, num(cfg()[k], d)) * 1000;
export function bounds(): DealBounds {
  return dealBounds(cfg());
}
/** flags gate behaviour: a missing companyLine flag means off */
export function companyOn(): boolean {
  return runtime()?.ctx.flags.companyLine === true;
}

// ---------------------------------------------------------------- the persisted file (CrewSave.companyFile)

export function emptyCompanyFile(): CompanyFileV1 {
  return { v: 1, calls: 0, missed: 0, insults: 0, mood: 0, promised: null, delivered: null, brokenPromises: 0, terms: null, last: null };
}

function normTerms(raw: unknown): CompanyTermsV1 | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const outcome = t.outcome === 'deal' || t.outcome === 'missed' || t.outcome === 'hung_up' ? t.outcome : 'deal';
  return {
    shift: Math.max(0, Math.round(num(t.shift, 0))),
    quotaPct: num(t.quotaPct, 0), payoutPct: num(t.payoutPct, 0), bonus: Math.max(0, num(t.bonus, 0)),
    conditions: Array.isArray(t.conditions) ? t.conditions.filter((c): c is string => typeof c === 'string').slice(0, 4) : [],
    baseQuota: Math.max(0, num(t.baseQuota, 0)), outcome, at: typeof t.at === 'string' ? t.at : new Date(0).toISOString(),
  };
}

/** a saved companyFile (any older / partial shape) or null when there is none */
export function normalizeCompanyFile(raw: unknown): CompanyFileV1 | null {
  if (!raw || typeof raw !== 'object') return null;
  const f = raw as Record<string, unknown>;
  const n0 = (v: unknown) => Math.max(0, Math.round(num(v, 0)));
  const opt = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null);
  return {
    v: 1, calls: n0(f.calls), missed: n0(f.missed), insults: n0(f.insults), mood: Math.max(-2, Math.min(2, Math.round(num(f.mood, 0)))),
    promised: opt(f.promised), delivered: opt(f.delivered), brokenPromises: n0(f.brokenPromises), terms: normTerms(f.terms), last: normTerms(f.last),
  };
}

const fileOf = (crew: Crew): CompanyFileV1 => (S(crew).company ??= emptyCompanyFile());

// ---------------------------------------------------------------- runtime (memory only)

interface CallRt {
  id: number;
  state: 'ringing' | 'active' | 'ended';
  shift: number;
  ringAt: number;
  answeredAt: number;
  endedAt: number;
  holder: string | null;
  holderName: string | null;
  call: CallState;
  record: CrewRecord;
  /** the opening growth target (what a missed call keeps) */
  open: number;
  baseQuota: number;
  lines: MetaCallLine[];
  /** live player id -> ctx.now() of their last line */
  lastSaid: Record<string, number>;
  promise: number | null;
  outcome: 'deal' | 'missed' | 'hung_up' | null;
  /** lines typed this call (count only, for the log) */
  said: number;
}
interface CompanyRt { call: CallRt | null; hubSince: number; seq: number }
const RTS = new WeakMap<Crew, CompanyRt>();
const rtOf = (crew: Crew): CompanyRt => {
  let r = RTS.get(crew);
  if (!r) RTS.set(crew, (r = { call: null, hubSince: 0, seq: 0 }));
  return r;
};
const now = (): number => runtime()?.ctx.now() ?? 0;
const log = () => runtime()?.ctx.log('meta');
const humans = (crew: Crew): ServerPlayer[] => [...crew.players.values()].filter((p) => p.connected && !isObserver(p));

/** the terms of the shift in progress (flag on, belonging to this shift), else null */
export function shiftTerms(crew: Crew): CompanyTermsV1 | null {
  if (!companyOn() || !crew.slices.meta) return null;
  const t = S(crew).company?.terms ?? null;
  return t && t.shift === S(crew).shift.index ? t : null;
}

/** what the Company knows about the crew at the start of this shift (CrewSave.history + companyFile) */
export function companyRecord(crew: Crew): CrewRecord {
  const s = S(crew);
  const per = econ().contractsPerShift;
  const last = s.history.slice(-per);
  const f = s.company;
  return {
    firstShift: s.history.length === 0,
    metLastQuota: s.shift.index > 0,
    coreLastShift: last.some((h) => h.coreExtracted),
    deathsLastShift: last.reduce((a, h) => a + (h.deaths?.length ?? 0), 0),
    wipedLast: last.length > 0 && (last[last.length - 1].survivors?.length ?? 0) === 0,
    brokenPromise: !!f && f.promised !== null && f.delivered !== null && f.delivered < f.promised,
  };
}

function rngFor(crew: Crew, c: CallRt, k: string) {
  return makeRng(`${crew.code}|${c.shift}|${c.id}|${c.call.turns}|${k}`, 'company');
}

function push(c: CallRt, line: Omit<MetaCallLine, 'at'>): void {
  c.lines.push({ ...line, at: now() });
  if (c.lines.length > 14) c.lines.splice(0, c.lines.length - 14);
}

function offerQuota(c: CallRt, t: Terms = c.call.terms): number {
  return dealtQuota(c.baseQuota, t.quotaPct);
}

function dale(crew: Crew, c: CallRt, key: DaleKey, extra: { cond?: string | null } = {}): void {
  const f = fileOf(crew);
  push(c, {
    who: 'dale',
    name: 'DALE · REGIONAL',
    text: daleLine(key, {
      offer: c.call.terms, quota: offerQuota(c), open: c.open, promised: c.promise ?? f.promised, delivered: f.delivered, cond: extra.cond ?? null,
    }, rngFor(crew, c, key)),
  });
}

function openingKey(crew: Crew, c: CallRt): DaleKey {
  const f = fileOf(crew);
  const r = c.record;
  if (r.firstShift || f.calls === 0) return 'openFirst';
  if (r.brokenPromise) return 'openBroken';
  if (f.insults >= 2 || f.mood <= -2) return 'openRude';
  if (r.wipedLast) return 'openWipe';
  if (r.metLastQuota) return 'openMet';
  if (S(crew).shift.index === 0) return 'openMissed';
  return 'openDefault';
}

// ---------------------------------------------------------------- lifecycle

function startRinging(crew: Crew, t: number): void {
  const s = S(crew);
  const r = rtOf(crew);
  const record = companyRecord(crew);
  const call = openCall(record, fileOf(crew).mood, bounds());
  r.call = {
    id: ++r.seq, state: 'ringing', shift: s.shift.index, ringAt: t, answeredAt: 0, endedAt: 0, holder: null, holderName: null,
    call, record, open: call.terms.quotaPct, baseQuota: s.shift.quota, lines: [], lastSaid: {}, promise: null, outcome: null, said: 0,
  };
  push(r.call, { who: 'system', text: 'THE VAN PHONE IS RINGING · COMPANY LINE' });
  log()?.info(`crew ${crew.code}: company line ringing (shift ${s.shift.index + 1}, opening ${call.terms.quotaPct}%)`);
  markDirty(crew);
}

/** the call ends: the offer on the table becomes the shift's term sheet (applied at once) */
function settle(crew: Crew, outcome: 'deal' | 'missed' | 'hung_up'): void {
  const r = rtOf(crew);
  const c = r.call;
  if (!c || c.state === 'ended') return;
  const s = S(crew);
  const f = fileOf(crew);
  const b = bounds();
  const t = clampTerms(c.call.terms, b);
  c.state = 'ended';
  c.endedAt = now();
  c.outcome = outcome;
  if (outcome === 'missed') f.missed++;
  f.mood = Math.max(-2, Math.min(2, Math.round(c.call.mood)));
  f.insults += c.call.insults;
  // a promise is remembered for the next call (delivered is filled in when this shift ends)
  f.promised = c.promise;
  f.delivered = null;
  // a shift-0 quota still follows crew size until the first drive: the base is the current one
  const base = !s.shift.quotaLocked && s.shift.index === 0 ? s.shift.quota : c.baseQuota;
  c.baseQuota = base;
  f.terms = { shift: c.shift, quotaPct: t.quotaPct, payoutPct: t.payoutPct, bonus: t.bonus, conditions: [...t.conditions], baseQuota: base, outcome, at: new Date().toISOString() };
  s.shift.quota = dealtQuota(base, t.quotaPct);
  applyTermsToOrders(crew, s.orders);
  log()?.info(`crew ${crew.code}: company line ${outcome}: ${offerText(t)} (quota ${base} -> ${s.shift.quota}) after ${c.said} line${c.said === 1 ? '' : 's'}`);
  saveCrew(crew);
  markDirty(crew);
}

function drop(crew: Crew, why: string): void {
  const r = rtOf(crew);
  if (!r.call) return;
  if (r.call.state !== 'ended') log()?.info(`crew ${crew.code}: company line dropped (${why})`);
  r.call = null;
  markDirty(crew);
}

/** every meta tick: ring at shift start, time the call out, let an ended call go, drop it outside the hub */
export function companyTick(crew: Crew): void {
  const r = rtOf(crew);
  if (!companyOn()) {
    if (r.call) drop(crew, 'flag off');
    r.hubSince = 0;
    return;
  }
  const t = now();
  if (crew.phase !== 'hub') {
    if (r.call && r.call.state !== 'ended') drop(crew, `phase ${crew.phase}`);
    else if (r.call && t >= r.call.endedAt + sec('endedShowSec', 12)) drop(crew, 'shown');
    r.hubSince = 0;
    return;
  }
  const s = S(crew);
  const c = r.call;
  if (!c) {
    if (s.shift.contract !== 0 || shiftTerms(crew) || !humans(crew).length) return;
    if (!r.hubSince) r.hubSince = t;
    // ring only once the van has had a moment to load (clients freeze for seconds on a hub join)
    if (t - r.hubSince >= sec('ringDelaySec', 6)) startRinging(crew, t);
    return;
  }
  if (c.state === 'ringing' && t >= c.ringAt + sec('ringSec', 45)) {
    dale(crew, c, 'missed');
    settle(crew, 'missed');
  } else if (c.state === 'active') {
    if (!humans(crew).length) settle(crew, 'hung_up');
    else if (t >= c.answeredAt + sec('maxCallSec', 90)) { dale(crew, c, 'hangUp'); settle(crew, 'hung_up'); }
  } else if (c.state === 'ended' && t >= c.endedAt + sec('endedShowSec', 12)) {
    r.call = null;
    markDirty(crew);
  }
}

/** the van is leaving: a ringing phone counts as missed, a call in progress ends with the offer on the table */
export function companyBeforeDrive(crew: Crew): void {
  const c = rtOf(crew).call;
  if (!c || !companyOn()) return;
  if (c.state === 'ringing') { dale(crew, c, 'missed'); settle(crew, 'missed'); }
  else if (c.state === 'active') { dale(crew, c, 'drive'); settle(crew, 'hung_up'); }
}

/** shift-0 quota before the first drive (it follows crew size): the deal's % on the current base */
export function companyQuota(crew: Crew, base: number): number {
  const t = shiftTerms(crew);
  if (!t) return base;
  t.baseQuota = base;
  return dealtQuota(base, t.quotaPct);
}

/** the shift's quota before the deal (the next shift's quota grows from this, so deals never compound) */
export function companyBaseQuota(crew: Crew): number | null {
  const t = S(crew).company?.terms ?? null;
  return t && t.shift === S(crew).shift.index && t.baseQuota > 0 ? t.baseQuota : null;
}

/** the deal's payout on one contract's haul (0 without a deal / with the flag off) */
export function companyPay(crew: Crew, hauled: number): { payoutPct: number; pay: number } | null {
  const t = shiftTerms(crew);
  if (!t || !t.payoutPct) return null;
  return { payoutPct: t.payoutPct, pay: dealPay(hauled, t.payoutPct) };
}

/** the shift is over (results -> hub with a review): remember what was delivered, file the terms away */
export function companyShiftEnd(crew: Crew, hauled: number): void {
  const f = S(crew).company;
  if (!f) return;
  if (f.promised !== null && f.delivered === null) {
    f.delivered = Math.max(0, Math.round(hauled));
    if (f.delivered < f.promised) f.brokenPromises++;
  }
  if (f.terms) { f.last = f.terms; f.terms = null; }
  drop(crew, 'shift end');
}

// ---------------------------------------------------------------- work orders: conditions + hazard pay

const APPLIED = new WeakSet<WorkOrder>();
export const HAZARD_TAG = 'HAZARD PAY (Company Line):';

/** the threshold an added hazard-pay request uses (core lootBudget maths, like orders.ts) */
function hazardThreshold(crew: Crew, o: WorkOrder): number {
  const core = (runtime()?.ctx.balance.core ?? {}) as Record<string, unknown>;
  const riskMult = (core.riskLootMult as Record<string, number> | undefined)?.[String(o.risk)] ?? 1;
  const n = Math.max(1, humans(crew).length);
  const loot = num(core.lootBudgetBase, 650) * riskMult * playerMult(econ(), n);
  return Math.max(100, Math.round((loot * num(cfg().hazardThresholdFrac, 0.45)) / 10) * 10);
}

/** this shift's conditions and hazard pay on these orders (once per order object) */
export function applyTermsToOrders(crew: Crew, orders: WorkOrder[]): void {
  const t = shiftTerms(crew);
  if (!t) return;
  for (const o of orders) {
    if (APPLIED.has(o)) continue;
    APPLIED.add(o);
    for (const c of t.conditions) if (!o.modifiers.includes(c)) o.modifiers.push(c);
    if (t.bonus > 0) {
      const r = o.requests.find((x) => x.kind === 'EXTRACT_ABOVE');
      if (r) {
        r.reward += t.bonus;
        r.text = `${r.text} ${HAZARD_TAG} +${t.bonus}.`;
      } else {
        const x = hazardThreshold(crew, o);
        const req: CompanyRequest = { kind: 'EXTRACT_ABOVE', param: x, reward: t.bonus, text: `${HAZARD_TAG} haul over ${x} scrip and the Company adds ${t.bonus}.` };
        o.requests.push(req);
      }
    }
  }
}

// ---------------------------------------------------------------- view

export function companyView(crew: Crew): { call: MetaCall | null; terms: MetaShiftTerms | null } {
  if (!companyOn()) return { call: null, terms: null };
  const s = S(crew);
  const t = shiftTerms(crew);
  const terms: MetaShiftTerms | null = t
    ? { quotaPct: t.quotaPct, payoutPct: t.payoutPct, bonus: t.bonus, conditions: [...t.conditions], outcome: t.outcome, baseQuota: t.baseQuota, quota: dealtQuota(t.baseQuota, t.quotaPct) }
    : null;
  const c = rtOf(crew).call;
  if (!c) return { call: null, terms };
  const b = bounds();
  const offer: MetaTerms = { ...c.call.terms, conditions: [...c.call.terms.conditions] };
  const base = c.state !== 'ended' && !s.shift.quotaLocked && s.shift.index === 0 ? s.shift.quota : c.baseQuota;
  const until = c.state === 'ringing' ? c.ringAt + sec('ringSec', 45) : c.state === 'active' ? c.answeredAt + sec('maxCallSec', 90) : c.endedAt + sec('endedShowSec', 12);
  const cool = sec('turnCooldownSec', 4);
  const cooldown: Record<string, number> = {};
  for (const [pid, at] of Object.entries(c.lastSaid)) if (at + cool > now()) cooldown[pid] = at + cool;
  return {
    call: {
      id: c.id, state: c.state, until, holder: c.holder, holderName: c.holderName, lines: c.lines.map((l) => ({ ...l })), offer,
      baseQuota: base, quota: dealtQuota(base, offer.quotaPct), turnsLeft: Math.max(0, b.maxTurns - c.call.turns),
      outcome: c.outcome ?? undefined, cooldown,
    },
    terms,
  };
}

// ---------------------------------------------------------------- requests

/**
 * TODO(ai): next round (e) adds a Company Line route (Haiku 5.5, effort low, output_config.format json_schema
 * {argument, strength, decision, line, promise_haul}) given the persona, the structured crew record, the offer, the
 * legal decisions and the call so far as JSON data. Code keeps every number: an illegal decision falls back to 'hold',
 * strength is re-checked against the record (a contradicted claim = 0), the line must pass textBlocked() and carry no
 * digits outside {{OFFER}}, and a refusal plays "you're breaking up" with the offer unchanged. This round it returns
 * null and the keyword rule brain answers (the same path mock mode, budget and refusals will use).
 */
async function llmTurn(_input: { record: CrewRecord; offer: Terms; legal: readonly string[]; line: string }): Promise<null> {
  return null;
}

type PhoneArgs = { op?: unknown; text?: unknown } | undefined;

export async function phoneReq(crew: Crew, player: ServerPlayer, args: PhoneArgs): Promise<{ ok: boolean; reason?: string }> {
  if (!companyOn()) return { ok: false, reason: 'the line is dead' };
  if (crew.phase !== 'hub') return { ok: false, reason: 'the phone is in the van' };
  if (isObserver(player)) return { ok: false, reason: 'observers cannot take the call' };
  const r = rtOf(crew);
  const c = r.call;
  const op = String(args?.op ?? '');
  if (!c || c.state === 'ended') return { ok: false, reason: 'nobody is calling' };
  if (op === 'answer') {
    if (c.state !== 'ringing') return { ok: true };
    c.state = 'active';
    c.answeredAt = now();
    c.holder = player.id;
    c.holderName = player.name;
    fileOf(crew).calls++;
    push(c, { who: 'system', text: `${player.name} picked up the van phone.` });
    dale(crew, c, openingKey(crew, c));
    markDirty(crew);
    return { ok: true };
  }
  if (c.state !== 'active') return { ok: false, reason: 'answer the phone first' };
  if (op === 'hangup') {
    push(c, { who: 'system', text: `${player.name} hung up.` });
    dale(crew, c, 'crewHangUp');
    settle(crew, 'hung_up');
    return { ok: true };
  }
  const b = bounds();
  if (op === 'accept') {
    step(c.call, 'accept', 0, 'close', 0, b);
    push(c, { who: 'system', text: `${player.name} signed the term sheet.` });
    dale(crew, c, 'close');
    settle(crew, 'deal');
    return { ok: true };
  }
  if (op !== 'say') return { ok: false, reason: 'unknown phone action' };
  const t = now();
  const cool = sec('turnCooldownSec', 4);
  const last = c.lastSaid[player.id] ?? -Infinity;
  if (t - last < cool) return { ok: false, reason: `wait ${Math.ceil((last + cool - t) / 1000)} s` };
  const raw = cleanText(args?.text, Math.max(20, Math.round(num(cfg().maxLineChars, 160))));
  if (!raw) return { ok: false, reason: 'say something' };
  c.lastSaid[player.id] = t;
  c.said++;
  const blocked = textBlocked(raw);
  // the crew hears the line on the speakerphone; a filtered word comes through masked (and the line is an insult)
  push(c, { who: 'crew', name: player.name, text: blocked ? maskLine(raw) : raw });
  const cl = classifyLine(raw, { record: c.record, call: c.call, baseQuota: c.baseQuota, blocked });
  const legal = legalDecisions(c.call, cl.argument, cl.strength, b);
  await llmTurn({ record: c.record, offer: c.call.terms, legal, line: raw });
  // the call may have ended while we waited (the van left, a timeout): this line then changes nothing
  if (r.call !== c || c.state !== 'active') return { ok: true };
  const pick = ruleDecide(c.call, cl.argument, legal, cl.bargain);
  const res = step(c.call, cl.argument, cl.strength, pick, rngFor(crew, c, 'cond').int(0, 9), b);
  if (cl.bargain === 'promise' && cl.promise !== null && (res.decision === 'concede' || res.decision === 'counter')) c.promise = cl.promise;
  dale(crew, c, replyKey(cl, res.decision), { cond: res.condition });
  if (c.call.ended) {
    // out of patience / lines on a turn that also moved the offer: the Company still says goodbye
    if (c.call.endedBy === 'hang_up' && res.decision !== 'hang_up' && cl.argument !== 'meta') dale(crew, c, 'hangUp');
    settle(crew, c.call.endedBy === 'close' ? 'deal' : 'hung_up');
  } else markDirty(crew);
  return { ok: true };
}

// ---------------------------------------------------------------- dev / tests

/** dbg: ring now (skips ringDelaySec); { force } also clears this shift's terms first */
export function dbgRing(crew: Crew, force = false): { ok: boolean; reason?: string } {
  if (!companyOn()) return { ok: false, reason: 'flag companyLine is off' };
  if (crew.phase !== 'hub') return { ok: false, reason: `phase ${crew.phase}` };
  const s = S(crew);
  if (force && s.company?.terms) {
    s.shift.quota = s.company.terms.baseQuota || s.shift.quota;
    s.company.terms = null;
    rtOf(crew).call = null;
  }
  if (shiftTerms(crew)) return { ok: false, reason: 'this shift already has terms' };
  if (rtOf(crew).call) return { ok: false, reason: 'a call is already on' };
  startRinging(crew, now());
  return { ok: true };
}

export function dbgState(crew: Crew): unknown {
  const c = rtOf(crew).call;
  return {
    on: companyOn(), file: S(crew).company, call: c ? { id: c.id, state: c.state, turns: c.call.turns, terms: c.call.terms, record: c.record, said: c.said } : null,
    view: companyView(crew),
  };
}
