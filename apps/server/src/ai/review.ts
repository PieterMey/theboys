// Owner: track (e) AI. Route shift.review (PLAN §1.6, §4.8): the Company Performance Review after a shift.
// One writer call (MODEL_WRITER, Haiku 5.5 at balance reviewEffort) per player (title + 2 lines + which overheard
// quote to print, by index) and one for 8 "employee comments" + the termination letter when fired; all in parallel,
// template per part on any failure, whole thing resolves within ~60 s. Quotes are verbatim RAM transcripts of
// CONSENTING players only; the model picks an index, code prints the text (it never echoes speech it was handed).
import type { PlayerMemo, ShiftReview, ShiftSummary, ShiftSummaryPlayer } from '@dead-air/shared/messages/ai.ts';
import { claudeJson, writerEffort } from './gateway.ts';
import type { ClaudeResult, MockMessage } from './gateway.ts';
import { WRITER_SYSTEM } from './brief.ts';
import { clampWords, wordCount } from './text.ts';
import { balNum, flagOn, log, quotesOf } from './hub.ts';
import type { Quote } from './hub.ts';

const MEMO_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    line1: { type: 'string' },
    line2: { type: 'string' },
    quote_index: { type: 'integer' },
  },
  required: ['title', 'line1', 'line2', 'quote_index'],
  additionalProperties: false,
} as const;

const COMMENTS_SCHEMA = {
  type: 'object',
  properties: {
    comments: { type: 'array', items: { type: 'string' } },
    letter: { type: 'string' },
  },
  required: ['comments', 'letter'],
  additionalProperties: false,
} as const;

/** Up to 5 quote candidates: Listener-heard + meaningful first, 3..18 words, newest last. */
export function quoteCandidates(crew: string, pid: string): Quote[] {
  const all = quotesOf(crew, pid).filter((q) => {
    const w = wordCount(q.text);
    return w >= 2 && w <= 18;
  });
  const score = (q: Quote) => (q.heardByListener ? 4 : 0) + (q.meaningful ? 2 : 0) + (q.band >= 3 ? 1 : 0) + Math.min(wordCount(q.text), 10) / 10;
  return [...all].sort((a, b) => score(b) - score(a)).slice(0, 5);
}

function templateMemo(p: ShiftSummaryPlayer, s: ShiftSummary, quote: string | null): PlayerMemo {
  const deaths = p.deaths ?? 0;
  const hauled = p.hauled ?? 0;
  let title = 'Adequate Contributor';
  if (deaths >= 2) title = 'Repeat Liability Event';
  else if (deaths === 1) title = 'Employee of the Month (Posthumous)';
  else if (hauled >= 300) title = 'Synergy Champion';
  else if (hauled === 0) title = 'Valued Observer';
  const line1 = deaths
    ? `Records show ${deaths} unscheduled loss${deaths > 1 ? 'es' : ''} of life this shift. Your badge has been reissued at cost.`
    : `Returned alive with ${hauled} scrip of salvage. The Company acknowledges this with a firm, distant nod.`;
  const line2 = s.fired
    ? 'Your position is under review, as is the concept of your position.'
    : 'Keep chatter professional. Something in the walls is taking notes too.';
  return { title, lines: [line1, line2], quote };
}

const COMMENT_TEMPLATES = [
  'Someone keeps answering the radio before it rings.',
  'Requesting a second flashlight. Or a first friend.',
  'The van smelled like fear again. Please fix the air freshener.',
  'Who keeps saying the room names out loud? Asking for a monster.',
  'Five stars for the Core. One star for the dog.',
  'I heard my own voice in the vents. It sounded tired.',
  'Can the quota please stop growing when nobody is looking?',
  'Mandatory fun was mandatory. Fun was not.',
];

function templateLetter(s: ShiftSummary): string | null {
  if (!s.fired) return null;
  return `Dear contractors, the shift quota was ${s.quota} scrip and you delivered ${s.hauled}. Effective immediately your employment is terminated. Please return your badges, your walkies and any voices you may have picked up on site. Warm regards, Human Resources.`;
}

export function templateReview(s: ShiftSummary): ShiftReview {
  const memos: Record<string, PlayerMemo> = {};
  for (const p of s.players) {
    const c = quoteCandidates(s.crew, p.id);
    memos[p.id] = templateMemo(p, s, c[0]?.text ?? null);
  }
  return { crew: s.crew, memos, comments: COMMENT_TEMPLATES.slice(), letter: templateLetter(s), source: 'template' };
}

function crewFacts(s: ShiftSummary): Record<string, unknown> {
  return {
    quota: s.quota,
    hauled: s.hauled,
    quota_met: !s.fired,
    contracts: (s.contracts ?? []).map((c) => ({ site: c.site ?? null, hauled: c.hauled ?? null, deaths: c.deaths ?? 0, core_extracted: !!c.coreExtracted })),
    crew: s.players.map((p) => ({ name: p.name, deaths: p.deaths ?? 0, hauled: p.hauled ?? 0 })),
  };
}

function memoUser(s: ShiftSummary, p: ShiftSummaryPlayer, cands: Quote[]): string {
  return JSON.stringify({
    task: 'Write this employee\'s line in the Company Performance Review. Roast level: mild, about in-game behaviour only.',
    limits: {
      title: 'a mock award or job title, at most 6 words',
      line1: 'at most 22 words, about their performance this shift',
      line2: 'at most 22 words, a deadpan HR remark or warning',
      quote_index: 'index into overheard_quotes of the funniest or dumbest line to print, or -1 for none',
    },
    employee: { name: p.name, deaths: p.deaths ?? 0, death_causes: (p.causes ?? []).slice(0, 4), hauled: p.hauled ?? 0, xp: p.xp ?? 0, level: p.level ?? 1 },
    shift: crewFacts(s),
    overheard_quotes: cands.map((q, i) => ({ index: i, text: q.text })),
  });
}

function commentsUser(s: ShiftSummary): string {
  return JSON.stringify({
    task: s.fired
      ? 'Write 8 anonymous employee comments from the suggestion box, and a short termination letter for the whole crew.'
      : 'Write 8 anonymous employee comments from the suggestion box. The crew met quota: letter must be an empty string.',
    limits: { comments: 'exactly 8 strings, at most 16 words each', letter: s.fired ? 'at most 90 words, signed by Human Resources' : 'empty string' },
    shift: crewFacts(s),
  });
}

function mockMemo(p: ShiftSummaryPlayer, n: number): MockMessage {
  const out = { title: (p.deaths ?? 0) > 0 ? 'Most Improved Ghost' : 'Quota Whisperer', line1: `Hauled ${p.hauled ?? 0} scrip and most of their dignity.`, line2: 'Please stop narrating your route to the walls.', quote_index: n > 0 ? 0 : -1 };
  return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(out) }], usage: { input_tokens: 800, output_tokens: 300 } };
}

function mockComments(s: ShiftSummary): MockMessage {
  const out = { comments: COMMENT_TEMPLATES.map((c) => `(mock) ${c}`), letter: s.fired ? 'Your services are no longer required. Leave the walkies. Human Resources.' : '' };
  return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(out) }], usage: { input_tokens: 600, output_tokens: 400 } };
}

function validMemo(d: unknown, cands: Quote[]): PlayerMemo | null {
  const o = (d ?? {}) as { title?: unknown; line1?: unknown; line2?: unknown; quote_index?: unknown };
  if (typeof o.title !== 'string' || typeof o.line1 !== 'string' || typeof o.line2 !== 'string') return null;
  const title = clampWords(o.title.replace(/["“”{}]/g, ''), 7, 60);
  const l1 = clampWords(o.line1, 28, 220);
  const l2 = clampWords(o.line2, 28, 220);
  if (!title || !l1 || !l2) return null;
  const qi = typeof o.quote_index === 'number' && Number.isInteger(o.quote_index) ? o.quote_index : -1;
  const quote = qi >= 0 && qi < cands.length ? cands[qi].text : null;
  return { title, lines: [l1, l2], quote };
}

function validComments(d: unknown, fired: boolean): { comments: string[] | null; letter: string | null | undefined } {
  const o = (d ?? {}) as { comments?: unknown; letter?: unknown };
  let comments: string[] | null = null;
  if (Array.isArray(o.comments)) {
    const c = o.comments.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => clampWords(x, 20, 160));
    if (c.length >= 6) comments = c.slice(0, 8);
  }
  let letter: string | null | undefined;
  if (fired) letter = typeof o.letter === 'string' && o.letter.trim() ? clampWords(o.letter, 110, 900) : undefined;
  else letter = null;
  return { comments, letter };
}

async function writer(route: string, user: string, schema: Record<string, unknown>, mock: () => MockMessage, writerModel: string, fast: string): Promise<ClaudeResult> {
  const common = { system: WRITER_SYSTEM, user, schema, mock, maxInFlight: 8 };
  let res = await claudeJson({ ...common, route, model: writerModel, effort: writerEffort('review'), maxTokens: balNum('writerMaxTokens', 16000), expectedOut: balNum('writerExpectedOutTokens', 3000), timeoutMs: balNum('reviewTimeoutMs', 55_000) });
  // refusal: retry once on the retry model (MODEL_RETRY), unless it is the writer itself (then the template stays)
  if (!res.ok && res.reason === 'refusal' && fast !== writerModel) {
    res = await claudeJson({ ...common, route: 'writer.haiku', model: fast, maxTokens: balNum('haikuRetryMaxTokens', 2500), expectedOut: 600, timeoutMs: balNum('refusalRetryTimeoutMs', 20_000) });
  }
  return res;
}

let reviews = 0;

/** Test helper */
export function resetReviews(): void {
  reviews = 0;
}

/** api.ts reviewFor: always resolves; AI parts swap in where they succeeded. */
export async function review(s: ShiftSummary, writerModel: string, fast: string): Promise<ShiftReview> {
  const base = templateReview(s);
  if (!flagOn('ai') || !flagOn('reviewAi') || reviews >= balNum('reviewMaxPerSession', 4)) return base;
  reviews++;
  try {
    const memoJobs = s.players.map(async (p) => {
      const cands = quoteCandidates(s.crew, p.id);
      const res = await writer('review.memo', memoUser(s, p, cands), MEMO_SCHEMA as unknown as Record<string, unknown>, () => mockMemo(p, cands.length), writerModel, fast);
      return { id: p.id, memo: res.ok ? validMemo(res.data, cands) : null };
    });
    const commentsJob = writer('review.comments', commentsUser(s), COMMENTS_SCHEMA as unknown as Record<string, unknown>, () => mockComments(s), writerModel, fast);
    const [memos, comments] = await Promise.all([Promise.all(memoJobs), commentsJob]);
    const out: ShiftReview = { ...base, memos: { ...base.memos } };
    let ai = 0;
    let parts = 0;
    for (const m of memos) {
      parts++;
      if (m.memo) { out.memos[m.id] = m.memo; ai++; }
    }
    parts++;
    if (comments.ok) {
      const v = validComments(comments.data, s.fired);
      if (v.comments) { out.comments = v.comments; ai++; }
      if (v.letter !== undefined) out.letter = v.letter;
    }
    out.source = ai === 0 ? 'template' : ai === parts ? 'ai' : 'mixed';
    return out;
  } catch (e) {
    log().warn(`review failed: ${e instanceof Error ? e.message : e}`);
    return base;
  }
}
