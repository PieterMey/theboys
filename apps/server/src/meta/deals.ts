// Owner: track (d) Meta. v1.3 F5 Company Line v0: the bounded deal engine (pure: no ctx, no I/O, unit-tested in
// tests/meta/deals.test.ts with a 100k-call bounds fuzz). Ported from the v1.3 ai-design prototype (not in the
// repo): code owns every number. A "brain" (the keyword rule brain here;
// an LLM next round, see company.ts TODO(ai)) only classifies the crew's argument and picks one decision from the list
// legalDecisions() offers; step() applies it inside the bounds of config/balance/meta.json companyLine.
//
// Term sheet for one shift: quota % (applied before quotaLocked), payout % on the shift's hauls (spendable scrip only),
// a hazard bonus paid through an EXTRACT_ABOVE Company Request, and up to maxConditions harder-site modifiers.

export const ARGUMENTS = ['performance', 'hardship', 'bargain', 'flattery', 'threat_quit', 'joke', 'insult', 'meta', 'accept', 'reject', 'nonsense'] as const;
export type Argument = (typeof ARGUMENTS)[number];
export const DECISIONS = ['concede', 'counter', 'hold', 'squeeze', 'hang_up', 'close'] as const;
export type Decision = (typeof DECISIONS)[number];

export interface DealBounds {
  /** quota change limits in % (the term sheet never leaves them) */
  quotaPctMin: number;
  quotaPctMax: number;
  payoutPctMin: number;
  payoutPctMax: number;
  /** hazard bonus (scrip, per contract, paid through an EXTRACT_ABOVE request) */
  bonusMax: number;
  maxTurns: number;
  maxConditions: number;
  /** quota % one concession / one squeeze moves */
  stepPct: number;
  squeezePct: number;
  /** a counter (hazard pay for a harder site) adds these */
  counterBonus: number;
  counterPayoutPct: number;
  /** opening growth target: first shift of a crew / later shifts (ignoring the call keeps it) */
  openFirstPct: number;
  openPct: number;
  /** harder-site modifier chips a counter may attach (procgen MODIFIER_SLUG keys) */
  conditions: readonly string[];
}

export const DEFAULT_BOUNDS: DealBounds = {
  quotaPctMin: -10, quotaPctMax: 15, payoutPctMin: -10, payoutPctMax: 20, bonusMax: 150, maxTurns: 8, maxConditions: 2,
  stepPct: 5, squeezePct: 5, counterBonus: 50, counterPayoutPct: 5, openFirstPct: 5, openPct: 10,
  conditions: ['DARK', 'LONG CORRIDORS', 'MAZE', 'CLUTTERED'],
};

const fin = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

/** bounds from meta.json companyLine (sanitized: min <= max, the opening inside the quota bounds) */
export function dealBounds(raw: unknown): DealBounds {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_BOUNDS;
  const qMin = Math.min(0, fin(o.quotaPctMin, d.quotaPctMin));
  const qMax = Math.max(0, fin(o.quotaPctMax, d.quotaPctMax));
  const pMin = Math.min(0, fin(o.payoutPctMin, d.payoutPctMin));
  const pMax = Math.max(0, fin(o.payoutPctMax, d.payoutPctMax));
  const conds = Array.isArray(o.conditions) ? o.conditions.filter((c): c is string => typeof c === 'string' && !!c.trim()).map((c) => c.trim().toUpperCase()) : [...d.conditions];
  return {
    quotaPctMin: qMin, quotaPctMax: qMax, payoutPctMin: pMin, payoutPctMax: pMax,
    bonusMax: Math.max(0, fin(o.bonusMax, d.bonusMax)),
    maxTurns: Math.max(1, Math.round(fin(o.maxTurns, d.maxTurns))),
    maxConditions: Math.max(0, Math.min(4, Math.round(fin(o.maxConditions, d.maxConditions)))),
    stepPct: Math.max(1, fin(o.stepPct, d.stepPct)),
    squeezePct: Math.max(0, fin(o.squeezePct, d.squeezePct)),
    counterBonus: Math.max(0, fin(o.counterBonus, d.counterBonus)),
    counterPayoutPct: Math.max(0, fin(o.counterPayoutPct, d.counterPayoutPct)),
    openFirstPct: Math.max(qMin, Math.min(qMax, fin(o.openFirstPct, d.openFirstPct))),
    openPct: Math.max(qMin, Math.min(qMax, fin(o.openPct, d.openPct))),
    conditions: conds.length ? conds : [...d.conditions],
  };
}

/** what the Company knows about the crew (code-computed from CrewSave.history / companyFile) */
export interface CrewRecord {
  /** no finished shift yet: every performance claim is a bluff */
  firstShift: boolean;
  metLastQuota: boolean;
  coreLastShift: boolean;
  deathsLastShift: number;
  wipedLast: boolean;
  brokenPromise: boolean;
}

export interface Terms { quotaPct: number; payoutPct: number; bonus: number; conditions: string[] }

export interface CallState {
  leverage: number;
  patience: number;
  /** Dale's mood -2..2 (a good mood lowers the bar) */
  mood: number;
  /** concessions + counters granted */
  steps: number;
  cap: number;
  rejects: number;
  turns: number;
  /** a hardship plea counts once per call */
  hardshipUsed: boolean;
  /** insult / prompt-game lines this call (counts only) */
  insults: number;
  terms: Terms;
  ended: boolean;
  /** how it ended: 'close' (deal signed), 'hang_up' (Dale), null while open */
  endedBy: 'close' | 'hang_up' | null;
}

export function leverageOf(r: CrewRecord): number {
  let l = 0;
  if (r.metLastQuota) l++;
  if (r.coreLastShift) l++;
  if (!r.firstShift && r.deathsLastShift === 0) l++;
  if (r.wipedLast) l--;
  if (r.brokenPromise) l--;
  return Math.max(0, Math.min(3, l));
}

export function openingPct(r: CrewRecord, b: DealBounds): number {
  return r.firstShift ? b.openFirstPct : b.openPct;
}

export function openCall(r: CrewRecord, mood: number, b: DealBounds): CallState {
  const leverage = leverageOf(r);
  return {
    leverage,
    patience: 5 + leverage,
    mood: Math.max(-2, Math.min(2, Math.round(mood) || 0)),
    steps: 0,
    // a crew with nothing to show still gets two steps (a believable promise, a real hardship, a trade)
    cap: 2 + leverage,
    rejects: 0,
    turns: 0,
    hardshipUsed: false,
    insults: 0,
    // the Company always opens with a growth target and keeps something to give
    terms: clampTerms({ quotaPct: openingPct(r, b), payoutPct: 0, bonus: 0, conditions: [] }, b),
    ended: false,
    endedBy: null,
  };
}

/**
 * argument strength a concession needs: the first step of a call is goodwill (1: any honest argument), later ones
 * need a real one (2); a good mood lowers the bar, a bad one raises it. A bluff (strength 0) never persuades.
 */
export function needOf(s: Pick<CallState, 'steps' | 'mood'>): number {
  return Math.max(1, (s.steps === 0 ? 1 : 2) - Math.sign(s.mood));
}

/** what the engine allows this turn, given the classified argument: a brain may only pick from this list */
export function legalDecisions(s: CallState, arg: Argument, strength: number, b: DealBounds): Decision[] {
  if (s.ended) return [];
  if (arg === 'meta') return ['hang_up', 'squeeze'];
  if (arg === 'accept') return ['close'];
  if (s.patience <= 0 || s.turns >= b.maxTurns) return ['hang_up'];
  const out: Decision[] = ['hold'];
  const persuasive = (arg === 'performance' || arg === 'hardship' || arg === 'bargain') && strength >= needOf(s);
  if (persuasive && s.steps < s.cap) out.push('concede');
  // a trade that costs the crew a condition (hazard pay for a harder site)
  if (s.steps < s.cap + 1 && s.terms.conditions.length < b.maxConditions) out.push('counter');
  if (arg === 'insult' || (arg === 'threat_quit' && s.leverage === 0) || s.rejects >= 2) out.push('squeeze');
  return out;
}

export function clampTerms(t: Terms, b: DealBounds): Terms {
  const conds: string[] = [];
  for (const c of t.conditions) if (b.conditions.includes(c) && !conds.includes(c) && conds.length < b.maxConditions) conds.push(c);
  return {
    quotaPct: Math.max(b.quotaPctMin, Math.min(b.quotaPctMax, Math.round(t.quotaPct))),
    payoutPct: Math.max(b.payoutPctMin, Math.min(b.payoutPctMax, Math.round(t.payoutPct))),
    bonus: Math.max(0, Math.min(b.bonusMax, Math.round(t.bonus))),
    conditions: conds,
  };
}

export interface StepResult { decision: Decision; overridden: boolean; condition: string | null }

/**
 * Apply one turn. `pick` is the brain's decision; an illegal pick falls back to 'hold' (or the only legal one).
 * `condIdx` chooses the condition a counter attaches (the first unused one from there). A prompt game ('meta')
 * always squeezes and ends the call.
 */
export function step(s: CallState, arg: Argument, strength: number, pick: Decision, condIdx: number, b: DealBounds): StepResult {
  const legal = legalDecisions(s, arg, strength, b);
  if (!legal.length) return { decision: 'hold', overridden: pick !== 'hold', condition: null };
  let d: Decision = legal.includes(pick) ? pick : legal.length === 1 ? legal[0] : 'hold';
  const overridden = d !== pick;
  s.turns++;
  s.patience -= arg === 'insult' || arg === 'meta' ? 2 : 1;
  if (arg === 'flattery' || arg === 'joke') s.mood = Math.min(2, s.mood + 1);
  if (arg === 'insult' || arg === 'meta') { s.mood = Math.max(-2, s.mood - 1); s.insults++; }
  if (arg === 'reject') s.rejects++;
  if (arg === 'hardship') s.hardshipUsed = true;
  const t: Terms = { ...s.terms, conditions: [...s.terms.conditions] };
  let condition: string | null = null;
  switch (d) {
    case 'concede': // one step off the quota (or more payout once the quota is at its floor)
      s.steps++;
      if (t.quotaPct - b.stepPct >= b.quotaPctMin) t.quotaPct -= b.stepPct;
      else t.payoutPct += b.stepPct;
      break;
    case 'counter': {
      const free = b.conditions.filter((c) => !t.conditions.includes(c));
      if (free.length && t.conditions.length < b.maxConditions) {
        condition = free[((Math.round(condIdx) % free.length) + free.length) % free.length];
        s.steps++;
        t.conditions.push(condition);
        t.bonus += b.counterBonus;
        t.payoutPct += b.counterPayoutPct;
      } else d = 'hold';
      break;
    }
    case 'squeeze':
      t.quotaPct += b.squeezePct;
      break;
    case 'close':
      s.ended = true;
      s.endedBy = 'close';
      break;
    case 'hang_up':
      s.ended = true;
      s.endedBy = 'hang_up';
      break;
    default:
      break;
  }
  if (arg === 'meta' && !s.ended) { s.ended = true; s.endedBy = 'hang_up'; }
  s.terms = clampTerms(t, b);
  if (!s.ended && (s.patience <= 0 || s.turns >= b.maxTurns)) { s.ended = true; s.endedBy = 'hang_up'; }
  return { decision: d, overridden, condition };
}

/**
 * The rule brain (mock mode, refusals, no AI): the Company's policy over the legal moves. Persuasive arguments get a
 * concession, a bargain gets a trade, insults / repeated refusals get squeezed, everything else holds.
 */
export function ruleDecide(s: CallState, arg: Argument, legal: readonly Decision[], bargain: 'hazard' | 'promise' | null = null): Decision {
  if (legal.length === 1) return legal[0];
  if (arg === 'accept') return 'close';
  if (arg === 'meta') return 'squeeze';
  if (legal.includes('squeeze') && (arg === 'insult' || arg === 'threat_quit' || (arg === 'reject' && s.rejects >= 1))) return 'squeeze';
  if (arg === 'bargain' && bargain === 'hazard' && legal.includes('counter')) return 'counter';
  if (legal.includes('concede')) return 'concede';
  if (arg === 'bargain' && legal.includes('counter')) return 'counter';
  return 'hold';
}

/** the shift quota with a deal applied (pure; never below 1) */
export function dealtQuota(base: number, quotaPct: number): number {
  return Math.max(1, Math.round(Math.max(0, base) * (1 + quotaPct / 100)));
}

/** payout on one contract's haul (spendable scrip only, never the quota); negative = the Company docks pay */
export function dealPay(hauled: number, payoutPct: number): number {
  return Math.round(Math.max(0, hauled) * payoutPct / 100);
}

/** 'quota -5% · payout +5% · hazard pay +50 · DARK' */
export function offerText(t: Terms): string {
  const pct = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n)}%`;
  const parts = [`quota ${pct(t.quotaPct)}`];
  if (t.payoutPct) parts.push(`payout ${pct(t.payoutPct)}`);
  if (t.bonus) parts.push(`hazard pay +${t.bonus}`);
  if (t.conditions.length) parts.push(t.conditions.join(' + '));
  return parts.join(' · ');
}
