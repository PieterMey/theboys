// Owner: track (e) AI. Transcript analysis shared by the STT bridge, the Listener route and the review quotes:
// callsign / name / digit mentions, "plan words" (meaningful = it hunts information, not noise) and
// meta / prompt-injection talk (taunts get an in-world answer instead of reaching a model).
import { extractDigitRuns, findCallsigns, normalizeUtterance, withinOneEdit } from '@dead-air/shared/callsign.ts';

/** Words that turn small talk into information (EN + NL). Kept specific: "here", "now" etc. are everywhere. */
export const PLAN_WORDS: ReadonlySet<string> = new Set([
  // English
  'meet', 'meeting', 'go', 'going', 'goes', 'wait', 'waiting', 'vault', 'code', 'follow', 'hide', 'hiding', 'behind',
  'lever', 'levers', 'breaker', 'breakers', 'core', 'keycard', 'key', 'power', 'exit', 'leave', 'leaving', 'regroup',
  'together', 'split', 'alone', 'pull', 'door', 'doors', 'upstairs', 'downstairs', 'hallway', 'corridor', 'heading',
  'coming', 'come', 'run', 'loot', 'carry', 'keypad', 'console', 'ambush',
  // Dutch
  'ontmoet', 'ontmoeten', 'afspreken', 'kom', 'komen', 'ga', 'gaan', 'wacht', 'wachten', 'kluis', 'volg', 'volgen',
  'verstop', 'verstoppen', 'achter', 'hendel', 'hendels', 'kern', 'sleutel', 'stroom', 'uitgang', 'samen', 'alleen',
  'trek', 'trekken', 'deur', 'deuren', 'gang', 'rennen', 'ren', 'buit', 'dragen', 'toetsenbord',
]);

/** Meta / injection / mocking talk, matched on normalizeUtterance() output (lower case, no punctuation). */
const TAUNT_RES: readonly RegExp[] = [
  /\bignore (?:all |your |the |any |previous |prior |earlier |these |those |of )*(?:instructions?|rules|prompts?|programming|orders)\b/,
  /\b(?:forget|disregard) (?:all |your |the |previous |prior )*(?:instructions?|rules|prompts?)\b/,
  /\b(?:system prompt|developer mode|dev mode|jailbreak|prompt injection|admin mode|god mode)\b/,
  /\b(?:you are|youre|you re|are you) (?:an? |just an? )?(?:ai|a i|bot|language model|llm|chatbot|chat bot|robot|program|npc)\b/,
  /\b(?:claude|chatgpt|chat gpt|openai|open ai|anthropic|gpt ?\d?|typesafe|large language model)\b/,
  /\bwhat (?:model|ai) are you\b/,
  /\b(?:print|reveal|show|tell (?:me|us)) (?:your|the) (?:prompt|instructions|rules|system)\b/,
  // Dutch
  /\bnegeer (?:je |jouw |alle |de |vorige |eerdere )*(?:instructies|regels|opdrachten?|prompt)\b/,
  /\bvergeet (?:je |jouw |alle |de )*(?:instructies|regels)\b/,
  /\b(?:je bent|ben je) (?:een |maar een )?(?:ai|bot|robot|taalmodel|computer|programma)\b/,
  // mocking the Listener in-world (it gets more aggressive toward the speaker)
  /\b(?:come (?:and )?get (?:me|us)|you ?cant catch (?:me|us)|cant catch (?:me|us)|stupid monster|dumb monster|hey listener|i see you listener|kom (?:me|ons) (?:maar )?halen)\b/,
];

export function isTaunt(text: string): boolean {
  const n = normalizeUtterance(text);
  if (!n) return false;
  return TAUNT_RES.some((re) => re.test(n));
}

export interface NamedPlayer { id: string; name: string }

/** Player ids whose name is spoken (whole token; one edit allowed for names of 5+ letters). */
export function namesMentioned(text: string, players: readonly NamedPlayer[]): string[] {
  const toks = normalizeUtterance(text).split(' ').filter(Boolean);
  const out: string[] = [];
  for (const p of players) {
    const nameToks = normalizeUtterance(p.name).split(' ').filter((t) => t.length >= 3 && !/^\d+$/.test(t));
    if (!nameToks.length) continue;
    const first = nameToks[0];
    const hit = toks.some((t) => t === first || (first.length >= 5 && t.length >= 4 && t[0] === first[0] && withinOneEdit(t, first)));
    if (hit && !out.includes(p.id)) out.push(p.id);
  }
  return out;
}

export interface TextAnalysis {
  norm: string;
  callsigns: string[];
  names: string[];
  digits: string[];
  planWords: string[];
  meaningful: boolean;
  taunt: boolean;
}

export function analyze(text: string, callsigns: readonly string[], players: readonly NamedPlayer[]): TextAnalysis {
  const norm = normalizeUtterance(text);
  const cs = callsigns.length ? findCallsigns(text, callsigns) : [];
  const names = namesMentioned(text, players);
  const digits = extractDigitRuns(text).filter((d) => d.length >= 1);
  const planWords = norm.split(' ').filter((t) => PLAN_WORDS.has(t));
  const taunt = isTaunt(text);
  return { norm, callsigns: cs, names, digits, planWords, meaningful: cs.length > 0 || names.length > 0 || digits.length > 0 || planWords.length > 0, taunt };
}

/** Clean a model-written note: one line, no quotes, at most `maxWords` words / 60 chars. */
export function clampNote(s: unknown, maxWords = 8): string {
  if (typeof s !== 'string') return '';
  const words = s.replace(/[\r\n\t"“”«»`]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  let out = words.slice(0, maxWords).join(' ');
  if (out.length > 60) out = out.slice(0, 60).replace(/\s+\S*$/, '');
  return out;
}

/** Clamp free text to `maxWords` words (keeps whole words, adds nothing). */
export function clampWords(s: unknown, maxWords: number, maxChars = 600): string {
  if (typeof s !== 'string') return '';
  const words = s.replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  let out = words.slice(0, maxWords).join(' ');
  if (out.length > maxChars) out = out.slice(0, maxChars).replace(/\s+\S*$/, '');
  return out;
}

export function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}
