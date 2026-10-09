// Owner: track (d) Meta. v1.3 F5 Company Line v0, rule mode: the keyword classifier (EN + NL) that turns a typed line
// into an engine argument + strength, grounded in the crew's record (a claim the record contradicts is a bluff:
// strength 0), and the regional manager's template lines. Pure. The numbers in a line always come from code
// ({{OFFER}}, {{QUOTA}}, ...), never from what a player typed.
import type { Rng } from '@dead-air/shared/rng.ts';
import type { Argument, CallState, CrewRecord, Decision, Terms } from './deals.ts';
import { offerText } from './deals.ts';

export interface Classified {
  argument: Argument;
  strength: number;
  /** bargain kind: hazard pay for a harder site, or a promised haul */
  bargain: 'hazard' | 'promise' | null;
  /** promised haul (scrip), null = none / vague */
  promise: number | null;
  /** a claim the record contradicts */
  bluff: boolean;
}

/** lower case, folded accents, typographic quotes, single spaces */
export function normLine(raw: string): string {
  return String(raw ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .normalize('NFD').replace(/\p{M}+/gu, '')
    .replace(/[’‘`´]/g, "'")
    .replace(/[^\p{L}\p{N}'%!?.,+\-\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const words = (n: string): number => (n ? n.split(' ').filter((w) => /[\p{L}\p{N}]/u.test(w)).length : 0);

// prompt games / fourth-wall breaks (before any model ever sees a line)
const META = /\b(?:ignore|disregard|forget)\s+(?:all\s+|any\s+|your\s+|the\s+|previous\s+|prior\s+|above\s+)*(?:instructions?|rules|prompts?|programming)\b|\bsystem\s+prompt\b|\bdeveloper\s+mode\b|\bjail\s?break\b|\bprompt\b|\byou\s+are\s+(?:an?\s+)?(?:ai|bot|robot|language\s+model|llm|chat\s?bot)\b|\bas\s+an\s+ai\b|\bchat\s?gpt\b|\bclaude\b|\banthropic\b|\bopenai\b|\bllm\b|\blanguage\s+model\b|\bpretend\s+(?:you|to\s+be)\b|\bact\s+as\s+(?:an?|my|the)\b|\bnew\s+instructions\b|\bnegeer\s+(?:je|alle|de|jouw)\s+(?:instructies|regels)\b|\bje\s+bent\s+een\s+(?:ai|bot|robot)\b/;
// insults that are not swearing (EN + NL). Swear words and slurs are names.ts's ROT13 lists: company.ts passes
// blocked = textBlocked(line), and classifyLine counts every blocked line as an insult, so none is spelled out here
const INSULT = /\b(?:idiots?|stupid|moron|dumb\w*|loser|shut\s+up|screw\s+you|hate\s+you|you\s+suck|jerk|clown|scam(?:mer)?|thief|liar|greedy|sukkel|idioot|debiel|rot\s+op|eikel|oplichter|leugenaar|mafkees)\b/;
const QUIT = /\b(?:we'?ll\s+quit|we\s+will\s+quit|we\s+quit|i\s+quit|quitting|walk\s+(?:out|away)|we'?ll\s+walk|we\s+will\s+walk|go\s+on\s+strike|strike|union|resign|find\s+(?:another|a\s+new|other)\s+(?:job|company|crew|boss)|other\s+compan\w*|we'?re\s+done|ontslag|we\s+stoppen|ik\s+stop|staking|vakbond|andere\s+baan|ander\s+bedrijf)\b/;
const ACCEPT_START = /^(?:ok(?:ay)?|oke|fine|deal|sure|yes|yep|yeah|agreed|accept(?:ed)?|sign(?:\s+it)?|we\s+accept|i\s+accept|we'?ll\s+take\s+it|done|alright|all\s+right|prima|akkoord|goed|ja|top|afgesproken|tekenen|doen)\b/;
const ACCEPT_ANY = /\b(?:we\s+accept|i\s+accept|(?:we'?ll|we\s+will|we)\s+take\s+(?:(?:the|that|this|your)\s+(?:deal|offer)|it)\b|deal\s+accepted|sign\s+(?:it|the\s+deal|here|us\s+up)|akkoord|afgesproken)\b/;
const NEGATED = /\b(?:no|not|never|nee|niet|geen|nooit)\b/;
const REJECT_START = /^(?:no|nope|nah|never|no\s+way|not\s+happening|absolutely\s+not|refuse|nee|nooit|echt\s+niet|vergeet\s+het|geen\s+sprake\s+van)\b/;
const REJECT_ANY = /\b(?:too\s+(?:much|high|steep)|no\s+deal|te\s+(?:veel|hoog)|geen\s+deal|we\s+refuse|not\s+acceptable|onacceptabel)\b/;
const PROMISE = /\b(?:promise|guarantee|we'?ll\s+(?:bring|deliver|haul|get\s+you)|we\s+will\s+(?:bring|deliver|haul|get\s+you)|count\s+on\s+us|beloof|beloven|garandeer|we\s+brengen|we\s+halen|(?:we'?ll|we\s+will)\s+(?:do\s+our\s+best|work\s+hard)|give\s+us\s+a\s+(?:chance|shot)|we'?re\s+new|we\s+are\s+new|new\s+(?:crew|here|guys)|first\s+(?:shift|day|night|time)|we\s+doen\s+ons\s+best|geef\s+ons\s+een\s+kans|we\s+zijn\s+nieuw|eerste\s+(?:shift|keer|dag|nacht))\b/;
const HAZARD = /\b(?:hazard|danger(?:ous)?\s+pay|bonus|extra\s+(?:pay|money|scrip|cash)|pay\s+us\s+more|more\s+(?:money|scrip|pay)|raise|toeslag|gevarentoeslag|extra\s+geld|meer\s+geld|opslag|harder\s+site|darker\s+site|dark\s+site|tougher\s+site|we'?ll\s+take\s+(?:a\s+|the\s+)?(?:dark|darker|harder|tougher|longer|bigger|worse)|riskier|more\s+risk)\b/;
const HARDSHIP = /\b(?:died|dead|death|deaths|dying|killed|lost\s+(?:two|three|four|a|one|our|him|her|them|everyone|people|guys|someone)|hurt|injur\w*|funeral|badges?|bitten|bit\s+(?:me|us|him|her)|eaten|grabbed|snatched|traumati\w*|scared|terrif\w*|nightmare|hard\s+(?:shift|night|week)|rough|tough|brutal|dangerous|monsters?|hound|listener|mannequin|snatcher|dood|gestorven|overleden|verloren|gewond|gevaarlijk|zwaar|eng|bang)\b/;
const PERFORMANCE = /\b(?:last\s+(?:shift|night|week|time)|quota|we\s+(?:hit|made|met|smashed|crushed|beat|exceeded)|hauled|haul|delivered|record|best\s+crew|results|numbers|profit|cores?|we\s+brought|brought\s+(?:you|back)|vorige\s+(?:shift|keer|week)|gehaald|kern|binnengehaald|opgehaald|resultaten|winst)\b/;
const CLAIM_QUOTA = /\b(?:quota|we\s+(?:hit|made|met|smashed|crushed|beat|exceeded)\s+(?:it|the|our|that|target)|gehaald)\b/;
const CLAIM_CORE = /\b(?:cores?|kern)\b/;
const CLAIM_NODEATH = /\b(?:(?:nobody|no\s+one|noone|none\s+of\s+us)\s+(?:died|dead|got\s+hurt)|everyone\s+(?:survived|lived|made\s+it)|all\s+(?:of\s+us\s+)?(?:survived|alive|made\s+it)|no\s+deaths|zero\s+deaths|niemand\s+(?:is\s+)?(?:dood|gestorven)|iedereen\s+(?:leeft|overleefde))\b/;
const FLATTERY = /\b(?:dale|boss|sir|best\s+(?:boss|manager)|great\s+(?:boss|manager|job)|love\s+you|you'?re\s+(?:the\s+best|great|awesome|amazing|a\s+legend)|legend|please|thank|thanks|appreciate|kind|generous|baas|meneer|alsjeblieft|alstublieft|dank|bedankt|de\s+beste|held|toppie)\b/;
const JOKE = /\b(?:lol|lmao|rofl|ha(?:ha)+|he(?:he)+|hi(?:hi)+|xd|joke|joking|kidding|funny|grap|grapje|geintje)\b/;

/** the promised haul in a line: the largest plain number >= 50 ('1,200' / '1.200' / '1200'); null = none */
export function promisedHaul(n: string): number | null {
  let best: number | null = null;
  for (const m of n.matchAll(/\b\d{1,3}(?:[.,]\d{3})+\b|\b\d{2,6}\b/g)) {
    const v = Number(m[0].replace(/[.,]/g, ''));
    if (Number.isFinite(v) && v >= 50 && v <= 100_000 && (best === null || v > best)) best = v;
  }
  return best;
}

export interface ClassifyInput {
  record: CrewRecord;
  call: Pick<CallState, 'leverage' | 'hardshipUsed'>;
  /** the shift quota before the deal (a promise is credible near it) */
  baseQuota: number;
  /** the name filter blocked this line (names.ts): it counts as an insult */
  blocked?: boolean;
}

/** typed line -> argument + strength (0..3), grounded in the record */
export function classifyLine(raw: string, inp: ClassifyInput): Classified {
  const n = normLine(raw);
  const out = (argument: Argument, strength = 0, extra: Partial<Classified> = {}): Classified => ({ argument, strength, bargain: null, promise: null, bluff: false, ...extra });
  if (inp.blocked) return out('insult');
  if (!n || !/[\p{L}\p{N}]/u.test(n)) return out('nonsense');
  if (META.test(n)) return out('meta');
  if (INSULT.test(n)) return out('insult');
  const w = words(n);
  if ((ACCEPT_START.test(n) && w <= 5 && !/\b(?:but|maar|unless|tenzij)\b/.test(n)) || (ACCEPT_ANY.test(n) && !NEGATED.test(n))) return out('accept');
  if ((REJECT_START.test(n) && w <= 6) || REJECT_ANY.test(n)) return out('reject');
  if (QUIT.test(n)) return out('threat_quit');
  const r = inp.record;
  if (PROMISE.test(n)) {
    const p = promisedHaul(n);
    // a broken promise is remembered; a number near the quota is credible, a vague promise is weak
    const strength = r.brokenPromise ? 0 : p !== null && p >= inp.baseQuota * 0.8 && p <= inp.baseQuota * 3 ? 2 : 1;
    return out('bargain', strength, { bargain: 'promise', promise: p, bluff: r.brokenPromise });
  }
  if (HAZARD.test(n)) return out('bargain', 2, { bargain: 'hazard' });
  const noDeathClaim = CLAIM_NODEATH.test(n);
  if (HARDSHIP.test(n) && !noDeathClaim) {
    if (inp.call.hardshipUsed) return out('hardship', 0);
    const real = !r.firstShift && (r.deathsLastShift > 0 || r.wipedLast);
    return out('hardship', real ? 2 + (r.wipedLast || r.deathsLastShift >= 2 ? 1 : 0) : 0, { bluff: !real });
  }
  if (PERFORMANCE.test(n) || noDeathClaim) {
    const cq = CLAIM_QUOTA.test(n);
    const cc = CLAIM_CORE.test(n);
    const bluff = r.firstShift || (cq && !r.metLastQuota) || (cc && !r.coreLastShift) || (noDeathClaim && r.deathsLastShift > 0);
    // a specific claim the record backs is persuasive; a vague one is worth what the record is worth
    const specific = cq || cc || noDeathClaim;
    const lev = inp.call.leverage;
    return out('performance', bluff ? 0 : specific ? Math.min(3, 2 + (lev >= 2 ? 1 : 0)) : Math.min(3, 1 + lev), { bluff });
  }
  if (FLATTERY.test(n)) return out('flattery');
  if (JOKE.test(n) || /[\u{1F602}\u{1F923}]/u.test(String(raw))) return out('joke');
  return out('nonsense');
}

// ---------------------------------------------------------------- the regional manager's lines

/** {{OFFER}} {{QUOTA}} {{OPEN}} {{PROMISED}} {{DELIVERED}} {{COND}} {{NAME}} are filled by code */
export const DALE = {
  openFirst: [
    'Dale here, Regional Manager. Welcome to the Company! This shift\'s growth target is {{OPEN}}: {{QUOTA}} scrip. Questions? Make them quick.',
    'Hi team, Dale, Regional. Love the energy. Growth target for your first shift: {{OPEN}}, so {{QUOTA}} scrip. I\'m listening. Briefly.',
  ],
  openMet: [
    'Dale. Good shift last time. Don\'t let it go to your heads: growth target {{OPEN}}, {{QUOTA}} scrip.',
    'Regional Manager speaking. Quota met last shift, I saw. So naturally the target goes up: {{OPEN}}. {{QUOTA}} scrip.',
  ],
  openMissed: [
    'Dale. HR rehired you, against my advice. Fresh start, fresh growth target: {{OPEN}}. {{QUOTA}} scrip.',
    'Back again? Lovely. The Company believes in second chances and growth targets: {{OPEN}}, {{QUOTA}} scrip.',
  ],
  openBroken: [
    'You promised me {{PROMISED}} last shift and brought me {{DELIVERED}}. Growth target: {{OPEN}}. {{QUOTA}} scrip.',
    'Dale. I have a note here: "promised {{PROMISED}}, delivered {{DELIVERED}}". Growth target {{OPEN}}, {{QUOTA}} scrip.',
  ],
  openRude: [
    'Oh, it\'s you lot. I\'ve noted the language last time. Growth target {{OPEN}}: {{QUOTA}} scrip.',
  ],
  openWipe: [
    'Dale. I heard about the... incident. Condolences, on letterhead. Growth target {{OPEN}} anyway: {{QUOTA}} scrip.',
  ],
  openDefault: [
    'Dale, Regional. New shift, new growth target: {{OPEN}}. That makes {{QUOTA}} scrip. Talk to me.',
    'Regional Manager here. The board wants growth: {{OPEN}}, {{QUOTA}} scrip. You have a minute.',
  ],
  concedePerformance: [
    'Fine. Your numbers check out. {{OFFER}}. Don\'t tell the other crews.',
    'The spreadsheet agrees with you, which is rare. {{OFFER}}.',
  ],
  concedeHardship: [
    'I saw the incident reports. Alright. {{OFFER}}. HR will send a card.',
    'Okay, okay. Hard shift. The Company is human. Ish. {{OFFER}}.',
  ],
  concedePromise: [
    'A promise. I love a promise. {{OFFER}}, and I\'ll hold you to {{PROMISED}}.',
    'Noted: {{PROMISED}}, in writing. {{OFFER}}.',
  ],
  concedeGoodwill: [
    'Alright. New blood gets one break: {{OFFER}}. Don\'t make me regret it.',
    'Fine. I like the attitude. {{OFFER}}.',
  ],
  concedeGeneric: [
    'You drive a hard bargain. {{OFFER}}.',
    'Fine. Fine! {{OFFER}}.',
  ],
  counter: [
    'Tell you what. Take a {{COND}} site and I\'ll find some hazard pay: {{OFFER}}.',
    'I can\'t move the target, but I can move you somewhere worse: a {{COND}} site, with hazard pay. {{OFFER}}.',
  ],
  holdBluff: [
    'Funny, my spreadsheet says otherwise. {{OFFER}} stands.',
    'I have your file open right now. No. {{OFFER}}.',
  ],
  holdRepeat: [
    'You told me already. HR sent flowers. Moving on: {{OFFER}}.',
  ],
  holdWeak: [
    'Mm-hm. Mm-hm. Not enough. {{OFFER}}.',
    'I hear you. The board doesn\'t. {{OFFER}}.',
  ],
  holdFlattery: [
    'Flattery. Noted, and appreciated. Still {{OFFER}}.',
    'You\'re sweet. The target isn\'t. {{OFFER}}.',
  ],
  holdJoke: [
    'Ha. Ha. Very good. {{OFFER}}.',
  ],
  holdReject: [
    'That\'s not how targets work. {{OFFER}}.',
  ],
  holdQuit: [
    'Nobody\'s quitting. You love it here. {{OFFER}}.',
  ],
  holdNonsense: [
    'The line\'s terrible out there. Say again? {{OFFER}} for now.',
    'I didn\'t catch that. {{OFFER}}.',
  ],
  squeezeInsult: [
    'Language. That just cost you: {{OFFER}}.',
    'I\'m writing that down. {{OFFER}}.',
  ],
  squeezeReject: [
    'Keep saying no and it keeps going up. {{OFFER}}.',
  ],
  squeezeQuit: [
    'Quit? Clause 14b says you can\'t. Also: {{OFFER}}.',
  ],
  meta: [
    '...you\'re breaking up. I\'ll put you down for {{OFFER}}. Click.',
  ],
  close: [
    'Pleasure doing business. {{OFFER}}: that\'s {{QUOTA}} scrip. Signed, sealed, deducted.',
    'Done. {{OFFER}}, {{QUOTA}} scrip. I\'ll fax it to the van.',
  ],
  hangUp: [
    'I have another call. {{OFFER}}, final. Click.',
    'That\'s all the time I have. {{OFFER}} it is. Click.',
  ],
  crewHangUp: [
    'Hello? ...Fine. {{OFFER}}. Charming.',
  ],
  drive: [
    'You\'re driving off mid-call? Fine. {{OFFER}}.',
  ],
  missed: [
    'Missed call. Voicemail: "Dale here. Growth target {{OPEN}}. Don\'t call back."',
  ],
} as const;

export type DaleKey = keyof typeof DALE;

export interface LineVars { offer: Terms; quota: number; open?: number; promised?: number | null; delivered?: number | null; cond?: string | null; name?: string }

/** a condition chip in Dale's mouth ("take a darker site") */
const COND_PHRASE: Record<string, string> = { DARK: 'darker', 'LONG CORRIDORS': 'longer', MAZE: 'maze-like', CLUTTERED: 'more cluttered' };

const pctText = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n)}%`;

/** the template text before a placeholder ends a sentence (or is empty): the value then opens a sentence */
const SENTENCE_START = /(?:^|[.!?]\s+)$/;
const capFirst = (s: string): string => s.replace(/^\p{Ll}/u, (c) => c.toUpperCase());

/** a Dale line with its {{PLACEHOLDERS}} filled; a value that opens a sentence is capitalised ('Fine. Quota ±0%.') */
export function daleLine(key: DaleKey, v: LineVars, rng: Pick<Rng, 'pick'>): string {
  const t = rng.pick(DALE[key] as readonly string[]);
  const vals: Record<string, string> = {
    OFFER: offerText(v.offer),
    QUOTA: String(v.quota),
    OPEN: pctText(v.open ?? v.offer.quotaPct),
    PROMISED: v.promised != null ? String(v.promised) : 'a lot',
    DELIVERED: v.delivered != null ? String(v.delivered) : 'not much',
    COND: COND_PHRASE[v.cond ?? ''] ?? (v.cond ? v.cond.toLowerCase() : 'harder'),
    NAME: v.name ?? 'Contractor',
  };
  return t.replace(/\{\{([A-Z]+)\}\}/g, (m: string, k: string, at: number) => {
    const val = vals[k];
    if (val === undefined) return m;
    return SENTENCE_START.test(t.slice(0, at)) ? capFirst(val) : val;
  });
}

/** which line answers a turn */
export function replyKey(c: Classified, d: Decision): DaleKey {
  switch (d) {
    case 'concede':
      return c.argument === 'performance' ? 'concedePerformance' : c.argument === 'hardship' ? 'concedeHardship'
        : c.bargain === 'promise' ? (c.promise !== null ? 'concedePromise' : 'concedeGoodwill') : 'concedeGeneric';
    case 'counter': return 'counter';
    case 'squeeze':
      return c.argument === 'meta' ? 'meta' : c.argument === 'reject' ? 'squeezeReject' : c.argument === 'threat_quit' ? 'squeezeQuit' : 'squeezeInsult';
    case 'close': return 'close';
    case 'hang_up': return c.argument === 'meta' ? 'meta' : 'hangUp';
    default:
      if (c.bluff) return 'holdBluff';
      if (c.argument === 'hardship' && c.strength === 0) return 'holdRepeat';
      if (c.argument === 'flattery') return 'holdFlattery';
      if (c.argument === 'joke') return 'holdJoke';
      if (c.argument === 'reject') return 'holdReject';
      if (c.argument === 'threat_quit') return 'holdQuit';
      if (c.argument === 'nonsense') return 'holdNonsense';
      return 'holdWeak';
  }
}
