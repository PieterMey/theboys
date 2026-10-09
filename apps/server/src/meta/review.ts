// Owner: track (d) Meta. Template Company Performance Review (per shift) + termination letter. Instant; (e) reviewFor
// may swap AI text in later (up to reviewAiWaitSec).
import { makeRng } from '@dead-air/shared/rng.ts';
import type { MetaShiftReview } from '@dead-air/shared/messages/meta.ts';
import { MEMO_BODIES, NO_QUOTE_LINES, QUOTE_LINES, REVIEW_COMMENTS, REVIEW_RATINGS, TERMINATION_LETTERS } from './templates.ts';
import { textBlocked } from './safety.ts';

export interface ReviewPlayer {
  id: string;
  name: string;
  level: number;
  deaths: number;
  survived: number;
  contracts: number;
  /** things the Listener overheard from this player this shift */
  quotes: string[];
}

export interface ReviewInput {
  crew: string;
  shiftIndex: number;
  quota: number;
  hauled: number;
  overtime: number;
  met: boolean;
  nextQuota: number | null;
  players: ReviewPlayer[];
}

const fill = (s: string, v: Record<string, string | number>) => s.replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => (k in v ? String(v[k]) : m));

/** "dumbest" quote heuristic: prefer lines with plan words / digits / room-ish words, mid length. v1.3 P1c: a line the
 *  name filter blocks (names.ts, through safety.ts) is never printed in a memo; `blocked` is injectable for tests */
export function pickQuote(quotes: readonly string[], blocked: (text: string) => boolean = textBlocked): string | null {
  const plan = /\b(meet|go|wait|vault|code|left|right|behind|run|come|here|there|help|now|quick|stop|where|who|what)\b/i;
  let best: string | null = null;
  let bestScore = -1;
  for (const q0 of quotes) {
    const q = q0.trim().replace(/\s+/g, ' ');
    if (q.length < 6) continue;
    if (blocked(q)) continue;
    let s = Math.min(q.length, 70) / 10;
    if (plan.test(q)) s += 3;
    if (/\d/.test(q)) s += 2;
    if (/[!?]/.test(q)) s += 1;
    if (q.length > 110) s -= 4;
    if (s > bestScore) {
      bestScore = s;
      best = q.length > 110 ? `${q.slice(0, 107)}...` : q;
    }
  }
  return best;
}

export function templateReview(inp: ReviewInput): MetaShiftReview {
  const rng = makeRng(`${inp.crew}|${inp.shiftIndex}`, 'review');
  const memos = inp.players.map((p) => {
    const key: keyof typeof REVIEW_RATINGS =
      p.contracts > 0 && p.survived === 0 ? 'dead'
        : p.deaths === 0 ? 'star'
          : p.deaths === 1 ? 'good'
            : p.deaths <= p.contracts / 2 + 0.5 ? 'meh' : 'bad';
    const v = { NAME: p.name, DEATHS: p.deaths, SURVIVED: p.survived, CONTRACTS: p.contracts, LEVEL: p.level };
    const quote = pickQuote(p.quotes);
    const body = [fill(rng.pick(MEMO_BODIES[key]), v), quote ? fill(rng.pick(QUOTE_LINES), { QUOTE: quote }) : fill(rng.pick(NO_QUOTE_LINES), v)].join('\n\n');
    return {
      player: p.id,
      name: p.name,
      title: `Performance Review: ${p.name} (Contractor, Level ${p.level})`,
      body,
      quote: quote ?? undefined,
      rating: REVIEW_RATINGS[key],
    };
  });
  const v = { QUOTA: inp.quota, HAUL: inp.hauled, OVERTIME: inp.overtime, NEXT: inp.nextQuota ?? '-' };
  const comments = fill(rng.pick(inp.met ? REVIEW_COMMENTS.promoted : REVIEW_COMMENTS.fired), v);
  const names = inp.players.map((p) => p.name);
  const nameList = names.length <= 1 ? (names[0] ?? 'Contractor') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const letter = inp.met
    ? null
    : fill(rng.pick(TERMINATION_LETTERS), { NAMES: nameList, CREW: inp.crew, HAUL: inp.hauled, QUOTA: inp.quota, DATE: new Date().toDateString() });
  return {
    shiftIndex: inp.shiftIndex,
    quota: inp.quota,
    hauled: inp.hauled,
    met: inp.met,
    overtime: inp.overtime,
    verdict: inp.met ? 'promoted' : 'fired',
    memos,
    comments,
    letter,
    source: 'template',
    nextQuota: inp.nextQuota,
  };
}

/**
 * merge an AI review ((e) ShiftReview: { memos: Record<pid, { title, lines: [a, b], quote }>, comments: string[], letter,
 * source }) into the template; also accepts { memos: [{ player, body, ... }], comments: string }. True if anything changed.
 */
export function mergeAiReview(base: MetaShiftReview, ai: Record<string, unknown>): boolean {
  if (ai.source === 'template') return false;
  let changed = false;
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  if (typeof ai.comments === 'string') {
    const c = str(ai.comments, 1200);
    if (c) { base.comments = c; changed = true; }
  } else if (Array.isArray(ai.comments)) {
    const list = (ai.comments as unknown[]).map((x) => str(x, 200)).filter((x): x is string => !!x).slice(0, 8);
    if (list.length) { base.employeeComments = list; changed = true; }
  }
  const l = str(ai.letter, 2400);
  if (l && !base.met) { base.letter = l; changed = true; }
  const apply = (target: MetaShiftReview['memos'][number] | undefined, m: Record<string, unknown>) => {
    if (!target) return;
    const lines = Array.isArray(m.lines) ? (m.lines as unknown[]).map((x) => str(x, 300)).filter((x): x is string => !!x) : [];
    let body = lines.length ? lines.join(' ') : str(m.body, 1600);
    let quote = str(m.quote, 160);
    // v1.3 P1c: (e) prints the overheard quote verbatim; a blocked one is dropped (and a body that carries it too)
    if (quote && textBlocked(quote)) quote = null;
    if (body && textBlocked(body)) body = null;
    if (body) {
      target.body = quote ? `${body}

Overheard on site: "${quote}"` : body;
      changed = true;
    }
    if (quote) target.quote = quote;
    const title = str(m.title, 120);
    if (title) target.title = title;
    const rating = str(m.rating, 60);
    if (rating) target.rating = rating;
  };
  if (Array.isArray(ai.memos)) {
    for (const m of ai.memos as Record<string, unknown>[]) {
      if (m && typeof m === 'object') apply(base.memos.find((x) => x.player === m.player || (typeof m.name === 'string' && x.name === m.name)), m);
    }
  } else if (ai.memos && typeof ai.memos === 'object') {
    for (const [pid, m] of Object.entries(ai.memos as Record<string, Record<string, unknown>>)) {
      if (m && typeof m === 'object') apply(base.memos.find((x) => x.player === pid), m);
    }
  }
  if (changed) base.source = 'ai';
  return changed;
}
