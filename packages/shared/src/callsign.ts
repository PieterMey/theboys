// Owned by track ② Level. Callsign vocabulary + normalizer shared by the Listener validator, rule brain,
// STT hotwords and review quotes. Callsigns differ by a whole word (never only a digit).
// Players speak an English/Dutch mix: spoken forms include Dutch names, number words are EN + NL.
import type { LevelLayout } from './layout.ts';

export const CALLSIGNS = [
  'BOILER', 'COLDROOM', 'CHAPEL', 'MORGUE', 'DOCK', 'ARCHIVE', 'PUMPS', 'LAUNDRY', 'KITCHEN', 'WARDEN',
  'LOCKERS', 'SERVER', 'GARAGE', 'CANTEEN', 'FOUNDRY', 'GREENHOUSE', 'TANKS', 'VAULT', 'INFIRMARY', 'RADIO',
  'MAILROOM', 'GALLERY', 'FURNACE', 'STORES', 'PIT', 'OFFICE', 'LIBRARY', 'NURSERY', 'CRYO', 'SHOWERS',
  // special (never drawn from the random pool): the entrance room and the van
  'LOBBY', 'VAN',
] as const;
export type Callsign = (typeof CALLSIGNS)[number];

export interface CallsignInfo {
  /** room type used for decoration ('boiler', 'cold', ...) */
  type: string;
  /** preferred room size: S = small room, L = hall-sized, any */
  size: 'S' | 'L' | 'any';
  /** spoken forms (lower case, words separated by single spaces). forms[0] is the primary English form. */
  forms: readonly string[];
}

export const CALLSIGN_INFO: Readonly<Record<string, CallsignInfo>> = {
  BOILER: { type: 'boiler', size: 'any', forms: ['boiler', 'boilers', 'boiler room', 'boilerroom', 'ketel', 'ketelruimte', 'ketelhuis', 'stookruimte'] },
  COLDROOM: { type: 'cold', size: 'S', forms: ['cold room', 'coldroom', 'cold store', 'cold storage', 'freezer', 'koelcel', 'koude kamer', 'koelruimte', 'koelkamer', 'vriezer'] },
  CHAPEL: { type: 'chapel', size: 'any', forms: ['chapel', 'chapels', 'kapel'] },
  MORGUE: { type: 'morgue', size: 'S', forms: ['morgue', 'mortuary', 'mortuarium', 'lijkenhuis', 'lijkenkamer'] },
  DOCK: { type: 'dock', size: 'L', forms: ['dock', 'docks', 'doc', 'loading dock', 'loading bay', 'dok', 'laadperron', 'laadkade'] },
  ARCHIVE: { type: 'archive', size: 'S', forms: ['archive', 'archives', 'record room', 'records room', 'archief', 'archieven'] },
  PUMPS: { type: 'pumps', size: 'any', forms: ['pumps', 'pump room', 'pumproom', 'pump', 'pompen', 'pomp', 'pompkamer', 'pompruimte'] },
  LAUNDRY: { type: 'laundry', size: 'any', forms: ['laundry', 'laundry room', 'laundromat', 'wasserij', 'wasruimte', 'washok'] },
  KITCHEN: { type: 'kitchen', size: 'any', forms: ['kitchen', 'kitchens', 'keuken'] },
  WARDEN: { type: 'office', size: 'S', forms: ['warden', 'wardens', 'wardens office', 'directeur', 'bewaker'] },
  LOCKERS: { type: 'lockers', size: 'S', forms: ['lockers', 'locker room', 'kleedkamer', 'kluisjes'] },
  SERVER: { type: 'server', size: 'S', forms: ['server', 'servers', 'server room', 'serverroom', 'serverruimte'] },
  GARAGE: { type: 'garage', size: 'L', forms: ['garage', 'garages'] },
  CANTEEN: { type: 'canteen', size: 'L', forms: ['canteen', 'cafeteria', 'mess hall', 'kantine'] },
  FOUNDRY: { type: 'foundry', size: 'L', forms: ['foundry', 'smelter', 'gieterij'] },
  GREENHOUSE: { type: 'greenhouse', size: 'L', forms: ['greenhouse', 'green house', 'glasshouse', 'broeikas', 'kas', 'kassen'] },
  TANKS: { type: 'tanks', size: 'L', forms: ['tanks', 'tank', 'tank room', 'opslagtanks'] },
  VAULT: { type: 'vault', size: 'S', forms: ['vault', 'the vault', 'kluis', 'de kluis'] },
  INFIRMARY: { type: 'infirmary', size: 'S', forms: ['infirmary', 'sick bay', 'sickbay', 'med bay', 'medbay', 'ziekenboeg', 'ziekenzaal'] },
  RADIO: { type: 'radio', size: 'S', forms: ['radio room', 'radio', 'radiokamer'] },
  MAILROOM: { type: 'mailroom', size: 'S', forms: ['mail room', 'mailroom', 'post room', 'postroom', 'postkamer'] },
  GALLERY: { type: 'gallery', size: 'L', forms: ['gallery', 'galleries', 'galerij', 'galerie'] },
  FURNACE: { type: 'furnace', size: 'any', forms: ['furnace', 'furnaces', 'furnace room', 'smeltoven', 'oven'] },
  STORES: { type: 'storage', size: 'any', forms: ['stores', 'store room', 'storeroom', 'storage', 'stockroom', 'stock room', 'magazijn', 'opslag'] },
  PIT: { type: 'pit', size: 'L', forms: ['pit', 'the pit', 'pits', 'kuil'] },
  OFFICE: { type: 'office', size: 'S', forms: ['office', 'offices', 'kantoor'] },
  LIBRARY: { type: 'library', size: 'L', forms: ['library', 'libraries', 'bibliotheek', 'bieb'] },
  NURSERY: { type: 'nursery', size: 'S', forms: ['nursery', 'nurseries', 'kwekerij', 'kinderkamer'] },
  CRYO: { type: 'cryo', size: 'S', forms: ['cryo', 'cryo room', 'cryo lab', 'cryogenics', 'kryo', 'krio'] },
  SHOWERS: { type: 'showers', size: 'S', forms: ['showers', 'shower', 'shower room', 'douches', 'douche', 'doucheruimte'] },
  LOBBY: { type: 'lobby', size: 'any', forms: ['lobby', 'entrance', 'foyer', 'reception', 'ingang', 'entree', 'receptie'] },
  // 'van' alone is the Dutch "of/from": only English "the van" and Dutch words for the van count
  VAN: { type: 'van', size: 'any', forms: ['the van', 'busje', 'bestelbus', 'het busje', 'truck'] },
};

// ---------------- normalization ----------------

const UNITS: Record<string, number> = {
  zero: 0, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  nul: 0, twee: 2, drie: 3, vier: 4, vijf: 5, zes: 6, zeven: 7, acht: 8, negen: 9,
};
const TEENS: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  tien: 10, elf: 11, twaalf: 12, dertien: 13, veertien: 14, vijftien: 15, zestien: 16, zeventien: 17, achttien: 18, negentien: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  twintig: 20, dertig: 30, veertig: 40, vijftig: 50, zestig: 60, zeventig: 70, tachtig: 80, negentig: 90,
};
/** ambiguous words that are numbers only next to other numbers ("een" = "a", "one" = pronoun, "oh") */
const AMBIG: Record<string, number> = { een: 1, one: 1, oh: 0, o: 0 };
const NL_UNIT_RE = /^(een|twee|drie|vier|vijf|zes|zeven|acht|negen)en(twintig|dertig|veertig|vijftig|zestig|zeventig|tachtig|negentig)$/;
const NL_UNIT: Record<string, number> = { een: 1, twee: 2, drie: 3, vier: 4, vijf: 5, zes: 6, zeven: 7, acht: 8, negen: 9 };

const isNum = (t: string | undefined) => t !== undefined && /^\d+$/.test(t);

/**
 * Lower-case, fold diacritics, drop apostrophes, punctuation -> spaces, collapse whitespace,
 * and turn EN/NL number words into digits ("vier zeven" -> "4 7", "forty seven" -> "47", "zevenenveertig" -> "47").
 */
export function normalizeUtterance(text: string): string {
  const base = text
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’‘`]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!base) return '';
  const toks = base.split(' ');
  // pass 1: unambiguous number words (+ Dutch compounds)
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t in UNITS) toks[i] = String(UNITS[t]);
    else if (t in TEENS) toks[i] = String(TEENS[t]);
    else if (t in TENS) toks[i] = String(TENS[t]);
    else {
      const m = NL_UNIT_RE.exec(t);
      if (m) toks[i] = String(NL_UNIT[m[1]] + TENS[m[2]]);
    }
  }
  // pass 2: ambiguous words become digits only when adjacent to a number (iterate for chains)
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t in AMBIG && (isNum(toks[i - 1]) || isNum(toks[i + 1]))) { toks[i] = String(AMBIG[t]); changed = true; }
    }
    if (!changed) break;
  }
  // pass 3: "forty seven" -> "47" (tens word followed by a unit), "twenty one" handled after pass 2
  const out: string[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i], n = toks[i + 1];
    const tv = Number(t);
    if (isNum(t) && tv >= 20 && tv <= 90 && tv % 10 === 0 && isNum(n) && Number(n) >= 1 && Number(n) <= 9 && n.length === 1) {
      out.push(String(tv + Number(n)));
      i++;
    } else out.push(t);
  }
  return out.join(' ');
}

/** Runs of consecutive numbers in an utterance, concatenated: "code is four seven two one" -> ["4721"]. */
export function extractDigitRuns(text: string): string[] {
  const toks = normalizeUtterance(text).split(' ');
  const runs: string[] = [];
  let cur = '';
  for (const t of toks) {
    if (isNum(t)) cur += t;
    else if (cur) { runs.push(cur); cur = ''; }
  }
  if (cur) runs.push(cur);
  return runs;
}

// ---------------- fuzzy matching ----------------

/** Common words that must never fuzzy-match a callsign (they may still match exactly if they ARE a form). */
const NO_FUZZY = new Set([
  'thanks', 'thank', 'fault', 'faults', 'deck', 'duck', 'lock', 'locks', 'look', 'rock', 'sock', 'back', 'pack', 'dark', 'park',
  'boiled', 'boil', 'served', 'serve', 'never', 'officer', 'officers', 'store', 'story', 'stories', 'shows', 'show', 'power',
  'tower', 'towers', 'flower', 'flowers', 'shower', 'pump', 'bump', 'jump', 'jumps', 'dumps', 'lumps', 'pits', 'pity', 'spit',
  'pat', 'pet', 'pot', 'put', 'but', 'bit', 'kit', 'sit', 'hit', 'fit', 'lit', 'vault', 'salt', 'malt', 'halt', 'cult', 'volt',
  'cabin', 'ladder', 'later', 'water', 'radar', 'ready', 'radios', 'dog', 'doc', 'kas', 'kast', 'kat', 'was', 'pas', 'tas',
  'kapot', 'kamer', 'kamers', 'koud', 'koude', 'oven', 'over', 'even', 'open', 'often', 'chapter', 'cheaper', 'happen', 'kitten',
  'chicken', 'kitchen', 'archer', 'garbage', 'carriage', 'marriage', 'gallery', 'salary', 'celery', 'nursery', 'nurse',
  'warden', 'warning', 'garden', 'harden', 'tanks', 'tank', 'thank', 'think', 'drank', 'crank', 'frank', 'stank', 'blank',
  'mail', 'male', 'pile', 'cold', 'gold', 'hold', 'told', 'bold', 'fold', 'mold', 'sold', 'old', 'room', 'rooms', 'boom',
  'cryo', 'crew', 'crow', 'cry', 'dry', 'pumps', 'lobby', 'hobby', 'bobby', 'lobbying', 'trick', 'track', 'truck', 'trucks',
  'busy', 'bushes', 'kluis', 'kruis', 'thuis', 'huis', 'muis', 'luis', 'store', 'snore', 'shore', 'score', 'stairs', 'stars',
  'dock', 'docks', 'dick', 'ducks', 'kabel', 'kluit', 'pit', 'van', 'kan', 'man', 'fan', 'can', 'ban', 'pan', 'tan', 'plan', 'want', 'went', 'what',
]);

/** true if edit distance(a, b) <= 1 (an adjacent transposition also counts as one edit) */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  if (la === lb) {
    let first = -1, diff = 0;
    for (let i = 0; i < la; i++) {
      if (a.charCodeAt(i) === b.charCodeAt(i)) continue;
      if (++diff === 1) first = i;
      else if (diff > 2) return false;
    }
    if (diff <= 1) return true;
    // one adjacent transposition counts as a single edit ('bolier' ~ 'boiler')
    return a.charCodeAt(first) === b.charCodeAt(first + 1) && a.charCodeAt(first + 1) === b.charCodeAt(first) && a.slice(first + 2) === b.slice(first + 2);
  }
  const [s, l] = la < lb ? [a, b] : [b, a];
  let i = 0, j = 0, skipped = false;
  while (i < s.length && j < l.length) {
    if (s.charCodeAt(i) === l.charCodeAt(j)) { i++; j++; continue; }
    if (skipped) return false;
    skipped = true; j++;
  }
  return true;
}

/** Levenshtein distance (small strings). */
export function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array<number>(n + 1);
  let cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const c = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + c);
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}

/** same first sound: identical first letter, or c/k ("kold room" ~ "cold room") */
function sameOnset(a: string, b: string): boolean {
  const x = a[0], y = b[0];
  return x === y || ((x === 'c' || x === 'k') && (y === 'c' || y === 'k'));
}

/** token ~ form-word? exact, or one edit when the word is long enough (>= 6; or 4-5 with the same first sound). */
function wordMatch(tok: string, word: string): 0 | 1 | 2 {
  if (tok === word) return 2;
  if (word.length < 4 || tok.length < 4 || NO_FUZZY.has(tok) || isNum(tok)) return 0;
  if (word.length < 6 && !sameOnset(tok, word)) return 0;
  return withinOneEdit(tok, word) ? 1 : 0;
}

/** joined tokens ~ joined form: exact, or one edit for long joins (>= 8 letters) with the same first sound */
function joinedMatch(joined: string, form: string): 0 | 1 | 2 {
  if (joined === form) return 2;
  if (form.length < 8 || NO_FUZZY.has(joined) || /\d/.test(joined) || !sameOnset(joined, form)) return 0;
  return withinOneEdit(joined, form) ? 1 : 0;
}

interface Form { cs: string; words: string[]; joined: string }
const formCache = new Map<string, Form[]>();

function formsOf(cs: string): Form[] {
  let f = formCache.get(cs);
  if (f) return f;
  const info = CALLSIGN_INFO[cs.toUpperCase()];
  const raw = info ? info.forms : [cs.toLowerCase()];
  f = raw.map((s) => { const words = normalizeUtterance(s).split(' '); return { cs, words, joined: words.join('') }; });
  formCache.set(cs, f);
  return f;
}

export interface CallsignHit {
  callsign: string;
  /** token index range [start, end) in the normalized utterance */
  start: number;
  end: number;
  exact: boolean;
}

/** All callsign mentions in a transcript, left to right (greedy; exact beats fuzzy, longer beats shorter). */
export function matchCallsigns(text: string, candidates: readonly string[]): CallsignHit[] {
  const norm = normalizeUtterance(text);
  if (!norm) return [];
  const toks = norm.split(' ');
  const forms: Form[] = [];
  for (const c of candidates) forms.push(...formsOf(c));
  const hits: CallsignHit[] = [];
  for (let i = 0; i < toks.length; ) {
    let best: { cs: string; len: number; score: number } | null = null;
    for (const f of forms) {
      // (a) word-by-word
      const k = f.words.length;
      if (i + k <= toks.length) {
        let score = 0, ok = true;
        for (let w = 0; w < k; w++) { const m = wordMatch(toks[i + w], f.words[w]); if (!m) { ok = false; break; } score += m; }
        if (ok) {
          const s = (score === 2 * k ? 100 : 50) + k;
          if (!best || s > best.score || (s === best.score && k > best.len)) best = { cs: f.cs, len: k, score: s };
        }
      }
      // (b) joined tokens vs joined form ("cold room" ~ "coldroom" and vice versa)
      for (let m = 1; m <= 3 && i + m <= toks.length; m++) {
        let joined = '';
        for (let w = 0; w < m; w++) joined += toks[i + w];
        if (joined.length > f.joined.length + 1) break;
        const wm = m === 1 && f.words.length === 1 ? wordMatch(joined, f.joined) : joinedMatch(joined, f.joined);
        if (!wm) continue;
        const s = (wm === 2 ? 100 : 50) + m;
        if (!best || s > best.score || (s === best.score && m > best.len)) best = { cs: f.cs, len: m, score: s };
      }
    }
    if (best) { hits.push({ callsign: best.cs, start: i, end: i + best.len, exact: best.score >= 100 }); i += best.len; }
    else i++;
  }
  return hits;
}

/** Returns the callsigns mentioned in a transcript (fuzzy, EN/NL forms), in order of first mention, deduplicated. */
export function findCallsigns(text: string, candidates: readonly string[]): string[] {
  const out: string[] = [];
  for (const h of matchCallsigns(text, candidates)) if (!out.includes(h.callsign)) out.push(h.callsign);
  return out;
}

/** Callsign pairs whose primary spoken words are within 2 edits (LAUNDRY/FOUNDRY): never placed in one layout. */
export function confusable(a: string, b: string): boolean {
  if (a === b) return false;
  const fa = (CALLSIGN_INFO[a]?.forms[0] ?? a.toLowerCase()).replace(/ /g, '');
  const fb = (CALLSIGN_INFO[b]?.forms[0] ?? b.toLowerCase()).replace(/ /g, '');
  return editDistance(fa, fb) <= 2;
}

/** Callsigns present in a layout (rooms, halls, vault, lobby, van). */
export function layoutCallsigns(layout: Pick<LevelLayout, 'spaces'>): string[] {
  const out: string[] = [];
  for (const s of layout.spaces) if (s.callsign && !out.includes(s.callsign)) out.push(s.callsign);
  return out;
}

/** Spoken forms to bias speech-to-text (primary English form + the first Dutch/alternate form). */
export function hotwordsFor(layout: Pick<LevelLayout, 'spaces'>): string[] {
  const out: string[] = [];
  for (const cs of layoutCallsigns(layout)) {
    const info = CALLSIGN_INFO[cs];
    const forms = info ? info.forms : [cs.toLowerCase()];
    for (const f of forms.slice(0, 2)) if (!out.includes(f)) out.push(f);
  }
  return out;
}
