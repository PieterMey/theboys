// Owner: track (c) Monsters. The Listener's RULE BRAIN (always available) + intent validation.
// "It hunts information, not noise": only transcripts with callsigns, player names, digits or plan words are
// meaningful; everything else is loudness. Every intent (rule or AI) is validated against what it actually heard.
import { extractDigitRuns, findCallsigns, normalizeUtterance, withinOneEdit } from '@dead-air/shared/callsign.ts';
import type { HeardLine, ListenerAction } from './types.ts';

/** EN + NL plan words (normalized, lower case). Movement/meeting words carry the most weight. */
export const PLAN_WORDS: Readonly<Record<string, 'meet' | 'move' | 'wait' | 'help' | 'code' | 'place'>> = {
  meet: 'meet', meeting: 'meet', regroup: 'meet', together: 'meet', samen: 'meet', verzamelen: 'meet', afspreken: 'meet', treffen: 'meet',
  go: 'move', going: 'move', goes: 'move', come: 'move', coming: 'move', head: 'move', heading: 'move', run: 'move', follow: 'move', move: 'move',
  ga: 'move', gaan: 'move', gaat: 'move', kom: 'move', komen: 'move', komt: 'move', loop: 'move', lopen: 'move', rennen: 'move', ren: 'move', volg: 'move', naar: 'move',
  wait: 'wait', hold: 'wait', stay: 'wait', hide: 'wait', hiding: 'wait', wacht: 'wait', wachten: 'wait', blijf: 'wait', verstop: 'wait', schuil: 'wait',
  help: 'help', hulp: 'help', save: 'help', rescue: 'help', stuck: 'help', vast: 'help',
  code: 'code', vault: 'code', kluis: 'code', keypad: 'code', password: 'code', wachtwoord: 'code', combination: 'code',
  here: 'place', there: 'place', hier: 'place', daar: 'place', left: 'place', right: 'place', behind: 'place', links: 'place', rechts: 'place', achter: 'place', inside: 'place', binnen: 'place',
};

export interface TextFacts {
  norm: string;
  callsigns: string[];
  names: string[];
  plan: string[];
  digits: string[];
  meaningful: boolean;
}

/** Tokens that look like a name (for fuzzy name matching) */
function nameTokens(name: string): string[] {
  return normalizeUtterance(name).split(' ').filter((t) => t.length >= 3 && !/^\d+$/.test(t));
}

export function analyzeText(text: string, callsigns: readonly string[], players: readonly { id: string; name: string }[]): TextFacts {
  const norm = normalizeUtterance(text);
  const toks = norm ? norm.split(' ') : [];
  const cs = norm ? findCallsigns(text, callsigns) : [];
  const names: string[] = [];
  for (const p of players) {
    const nt = nameTokens(p.name);
    if (!nt.length) continue;
    const hit = nt.some((n) => toks.some((t) => t === n || (n.length >= 5 && t.length >= 4 && t[0] === n[0] && withinOneEdit(t, n))));
    if (hit && !names.includes(p.id)) names.push(p.id);
  }
  const plan: string[] = [];
  for (const t of toks) {
    const k = PLAN_WORDS[t];
    if (k && !plan.includes(t)) plan.push(t);
  }
  const digits = norm ? extractDigitRuns(text).filter((d) => d.length >= 2) : [];
  const meaningful = cs.length > 0 || names.length > 0 || digits.length > 0 || plan.length > 0;
  return { norm, callsigns: cs, names, plan, digits, meaningful };
}

export interface RuleIntent {
  action: ListenerAction;
  /** target space id (rooms) */
  space: number;
  /** target player id */
  player: string | null;
  note: string;
  /** the line the intent is based on */
  basis: HeardLine | null;
}

export interface BrainWorld {
  /** callsign -> space id */
  callsignSpace: ReadonlyMap<string, number>;
  /** vault space (keypad codes) or -1 */
  vaultSpace: number;
  /** crew time (s) */
  now: number;
  lureReady: boolean;
  /** player ids it can currently locate (heard/seen recently) */
  locatable: ReadonlySet<string>;
  /** relaxed director phase: no hunts */
  relaxed: boolean;
}

const kindsOf = (line: HeardLine) => new Set(line.plan.map((w) => PLAN_WORDS[w]));

/** Picks an intent from the newest meaningful unused line (most recent first). */
export function ruleBrain(memory: readonly HeardLine[], w: BrainWorld): RuleIntent | null {
  const recent = memory.filter((l) => !l.used && w.now - l.t <= 60).sort((a, b) => b.t - a.t);
  const line = recent.find((l) => l.meaningful) ?? null;
  if (!line) {
    const loud = recent[0];
    if (!loud) return null;
    return { action: 'investigate_room', space: loud.room, player: null, note: 'something moved there', basis: loud };
  }
  const k = kindsOf(line);
  const room = line.callsigns.length ? (w.callsignSpace.get(line.callsigns[line.callsigns.length - 1]) ?? -1) : -1;
  if (line.digits.length && w.vaultSpace >= 0 && (k.has('code') || line.digits.some((d) => d.length >= 3))) {
    return { action: w.relaxed ? 'investigate_room' : 'ambush_room', space: w.vaultSpace, player: null, note: `they said the code ${line.digits[0]}`, basis: line };
  }
  if (room >= 0) {
    const plan = k.has('meet') || k.has('move') || k.has('wait');
    if (plan && !w.relaxed) return { action: 'ambush_room', space: room, player: null, note: `they will be in ${line.callsigns[line.callsigns.length - 1]}`, basis: line };
    return { action: 'investigate_room', space: room, player: null, note: `someone mentioned ${line.callsigns[line.callsigns.length - 1]}`, basis: line };
  }
  if (line.names.length) {
    const named = line.names.find((n) => n !== line.speaker) ?? line.names[0];
    if (w.lureReady && !w.relaxed && (k.has('help') || k.has('move') || k.has('meet'))) {
      return { action: 'radio_lure', space: line.room, player: named, note: `${named} is being called`, basis: line };
    }
    if (w.locatable.has(named) && !w.relaxed) return { action: 'stalk_player', space: -1, player: named, note: 'a name was spoken', basis: line };
    if (line.speaker && w.locatable.has(line.speaker) && !w.relaxed) return { action: 'stalk_player', space: -1, player: line.speaker, note: 'the caller', basis: line };
  }
  if (line.speaker && (k.has('move') || k.has('wait') || k.has('meet') || k.has('help')) && w.locatable.has(line.speaker) && !w.relaxed) {
    return { action: 'stalk_player', space: -1, player: line.speaker, note: 'they have a plan', basis: line };
  }
  return { action: 'investigate_room', space: line.room, player: null, note: 'voices there', basis: line };
}

export interface IntentLike {
  action: string;
  room?: string | number | null;
  player?: string | null;
  note?: string | null;
}

export interface ValidWorld extends BrainWorld {
  memory: readonly HeardLine[];
  /** space id -> callsign */
  spaceCallsign: ReadonlyMap<number, string>;
  /** player id -> name */
  names: ReadonlyMap<string, string>;
  spaces: number;
}

const ACTIONS: readonly ListenerAction[] = ['investigate_room', 'ambush_room', 'stalk_player', 'radio_lure', 'retreat', 'ignore'];

/**
 * Validates an intent against what was actually heard (never omniscient):
 *  - room: a callsign spoken in a heard line (fuzzy normalizer), or the room a heard speaker was in / its doorway
 *  - player: a speaker it heard, or a name it heard spoken
 * Invalid targets degrade to investigate_room(source room of the newest line) (or ignore).
 */
export function validateIntent(raw: IntentLike, w: ValidWorld): { intent: RuleIntent; valid: boolean } {
  // newest first: targets are justified by the most recent line that supports them
  const recent = w.memory.filter((l) => w.now - l.t <= 90).sort((a, b) => b.t - a.t);
  const newest = recent[0] ?? null;
  const fallback = (): { intent: RuleIntent; valid: boolean } => (newest && newest.room >= 0
    ? { intent: { action: 'investigate_room', space: newest.room, player: null, note: 'degraded', basis: newest }, valid: false }
    : { intent: { action: 'ignore', space: -1, player: null, note: 'degraded', basis: null }, valid: false });
  const action = ACTIONS.includes(raw.action as ListenerAction) ? (raw.action as ListenerAction) : null;
  if (!action) return fallback();
  const note = String(raw.note ?? '').split(/\s+/).slice(0, 8).join(' ');
  if (action === 'ignore' || action === 'retreat') return { intent: { action, space: -1, player: null, note, basis: newest }, valid: true };
  // resolve room
  let space = -1;
  if (raw.room !== undefined && raw.room !== null && raw.room !== '') {
    const r = raw.room;
    if (typeof r === 'number' || /^\d+$/.test(String(r))) space = Number(r);
    else {
      const up = String(r).toUpperCase().replace(/[^A-Z]/g, '');
      space = w.callsignSpace.get(up) ?? -1;
    }
    if (!(space >= 0 && space < w.spaces)) space = -1;
  }
  let basis: HeardLine | null = null;
  if (space >= 0) {
    const cs = w.spaceCallsign.get(space);
    basis = recent.find((l) => (cs && l.callsigns.includes(cs)) || l.room === space) ?? null;
    if (!basis && space === w.vaultSpace) basis = recent.find((l) => l.digits.length > 0) ?? null;
    if (!basis) return fallback();
  }
  // resolve player (id or name)
  let player: string | null = null;
  if (raw.player) {
    const pr = String(raw.player);
    if (w.names.has(pr)) player = pr;
    else {
      const lower = pr.toLowerCase();
      for (const [id, name] of w.names) if (name.toLowerCase() === lower) player = id;
    }
    if (player) {
      const pb = recent.find((l) => l.speaker === player || l.names.includes(player!)) ?? null;
      if (!pb) return fallback();
      basis ??= pb;
    } else return fallback();
  }
  if ((action === 'investigate_room' || action === 'ambush_room') && space < 0) {
    if (player) {
      const pl = recent.find((l) => l.speaker === player && l.room >= 0);
      if (pl) space = pl.room;
    }
    if (space < 0) return fallback();
  }
  if (action === 'stalk_player' && !player) return fallback();
  if (action === 'radio_lure' && !player && space < 0) return fallback();
  return { intent: { action, space, player, note, basis }, valid: true };
}

/** "…BOILER…" style excerpt for the console intercept line */
export function interceptQuote(line: HeardLine): string {
  const words = line.text.replace(/\s+/g, ' ').trim().split(' ');
  if (line.callsigns.length) return `…${line.callsigns[line.callsigns.length - 1]}…`;
  if (line.digits.length) return `…${line.digits[0].split('').join('-')}…`;
  const key = words.find((wd) => PLAN_WORDS[normalizeUtterance(wd)]) ?? words.slice(-2).join(' ');
  return `…${key.toUpperCase()}…`;
}

export function shortQuote(text: string, max = 48): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
