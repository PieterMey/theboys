// Display-name and text safety (integrator, v1.3 P1a). Every player-chosen name passes safeDisplayName() where it
// enters the game: core/crews.ts (hello + resume), net/reqs.ts (profile.set), meta sanitizeProfile (G4, through
// apps/server/src/meta/safety.ts). textBlocked() / maskText() serve quotes, typed lines and mirror writing.
//  - Fold: NFKC (fullwidth, math and circled letters) -> invisible characters out (zero-width, bidi overrides, fillers)
//    -> lower case -> combining marks stripped -> confusables (Cyrillic, Greek, IPA, small caps, enclosed letters) ->
//    leet in three readings (none; 1 | ! = i; 1 | = l) -> words split on every non-letter and on camelCase, plus the
//    letters-only "squashed" form (w.o.r.d, w o r d, w_o_r_d). Term regexes accept repeated letters (wooorrd).
//  - Modes: 'sub' anywhere, 'prefix' at a word start, 'word' a whole word (+ s/z/es, xX..Xx wrappers, a few gamer-tag
//    decorations), so Scunthorpe, Dickson, Cockburn, Sussex and Assunta stay legal. A short allow list masks
//    benign words that do contain a term (Sexton, shiitake, therapist).
//  - Lists: EN + NL hate, sexual and harassment terms (the ai/lure.ts blocked() list, copied and extended), stored ROT13
//    so this public repo carries no readable slurs (rot13() is its own inverse). Edit them with scratch tooling only.
//  - Reserved: Listener, Company, HR, Admin(istrator), Moderator, Claude, System, as the whole name ("The Company",
//    "H.R.", "L1stener", "System-bot") or as one of at most two words ("Admin Bob"), so nobody speaks as the game.
//  - A blocked or reserved name becomes Contractor-NNNN (4 digits from a hash of the player id, so it is stable across
//    reconnects and restarts); the caller tells that player privately. Names are never logged by this module.
//  - Defaults: only the exact names the game hands out skip the filter (contractorName(id) for this player, and with
//    the player key the client's defaultName(key)); any other Contractor-NNNN goes through it like every name. Both
//    generators re-hash until their name passes the filter, so a default never comes back as "not allowed".
// Pure and deterministic (no I/O, no randomness, no clock): the server is authoritative; clients may use it to preview.
// Tests: node --test tests/core/names.test.ts (benign proxy words and ROT13 codes only; never type a slur in a test).
import { PROFILE_LIMITS } from './profile.ts';

/** ROT13 (its own inverse). The term lists below are stored encoded. */
export function rot13(s: string): string {
  return s.replace(/[a-z]/gi, (c) => {
    const base = c <= 'Z' ? 65 : 97;
    return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
  });
}

const decode = (enc: string): string[] => rot13(enc).split(' ').filter(Boolean);

// ---------------------------------------------------------------- term lists (ROT13, space separated)

/** anywhere in a word (and anywhere in a squashed name) */
const SUB_13 = 'shpx sipx cuhpx ovgpu onfgneq nffubyr nefrubyr nffung nffjvcr wnpxnff zbgurespx zbgureshx zbguresxre zguespxe zguesxe pbpxfhpxre qvpxurnq ohyyfuvg juber cbea betnfz fhvpvq xvyylbhefrys xvyyhefrys frysunez wvmm qvyqb oybjwbo unaqwbo uragnv vaprfg zbyrfg phzfubg intvan jnaxre crqbcuvy cnrqbcuvy crqbsvry uvgyre wvunq greebevf fvrturvy juvgrcbjre avtt snttbg genaal furznyr jrgonpx gbjryurnq enturnq wvtnobb cbepuzbaxrl tbyyvjbt xnaxre grevatyvwre glshf tbqire zbatbby avxxre xybbgmnx ubrerambba ubrerawbat trvgraarhxre mvtrhare fcyrrgbbt cbrcpuvarrf obfartre cyrhevf xyreryvwre';
/** at the start of a word */
const PREFIX_13 = 'phag fuvg ergneq frk xhg xbyrer grevat';
/** a whole word (+ a plural s, or es after s/x/z/ch/sh; xX..Xx wrappers; gamer-tag decorations) */
const WORD_13 = 'nff qvpx pbpx chffl chffvrf fyhg fyhggl anxrq encr encrq encvat encvfg anmv vfvf xxx xlf snt xvxr fcvp puvax qlxr pbba ornare tbbx cnxv jbt fcnm fcnfg phz obare gvgf gvggl gvggvrf obbo cravf pyvg zvys ubeal gjng cevpx fxnax jnax avt spx shx shd ubaxl crqb cnrqb ahqr arhx arhxra arhxg arhxgr arhxgra arhxre ubre ubrera syvxxre yhy cvx zbs zbssra artre fyrg xyrer';
/** benign words that contain a term: masked before matching */
const ALLOW_13 = 'fuvgnxr fuvvgnxr frkgba frkgnag frkgrg xhggre xhgyh xhgnl favttre favttref favttrerq favttrevat favttyr avttyr avttyrf avttyrq avttyvat avttyl ergneqnag gurencvfg gurencvfgf fuvvgr fuvvgrf xhgfpur xhgfpure artrre';
/** masked swearing ('*' = 1..3 mask symbols) */
const MASKED_13 = 's*px s*x fu*g o*gpu p*ag a*tt q*px c*ffl ju*er fy*g p*px s*t';

/** names nobody may take (the game's own voices) */
export const RESERVED_NAMES: readonly string[] = ['listener', 'company', 'hr', 'admin', 'administrator', 'moderator', 'claude', 'system'];

/** hate symbols: swastikas (CJK and Tibetan), SS runes / bolts */
const HATE_SYMBOLS = /[\u5350\u534d\u0fd5-\u0fd8]|\u03df{2}|\u16cb{2}/u;

/** the numeric hate code (14 + 88), built at run time like the lists are encoded: a name whose digits hold it is
 *  blocked; a name the game generates never carries its second half either (typed names may: birth years) */
const HATE_TAIL = String(88);
const HATE_CODE = String(14) + HATE_TAIL;

/** typed sentences: harassment phrases, matched on folded words joined by single spaces. The regex source is stored
 *  ROT13 like the word lists, so the public repo holds no readable hate slogans. String.raw keeps the backslashes, and
 *  ROT13 turns the \o back into \b. */
const PHRASES = new RegExp(rot13(String.raw`\oxvyy (?:lbhe ?frys|lbhe ?fryirf|he ?frys|he ?fryirf|h ?frys)\o|\ofrys ?unez|\ofvrt urvy\o|\ojuvgr cbjre\o`));

// ---------------------------------------------------------------- fold

/** control, format and filler characters (zero-width, bidi overrides, soft hyphen, Hangul fillers, braille blank) */
const INVISIBLE = /[\p{Cc}\p{Cf}\u034f\u115f\u1160\u17b4\u17b5\u2800\u3164\uffa0]/gu;

/** lookalikes that NFKC + mark stripping leave alone */
const CONFUSABLE: Record<string, string> = {
  // Cyrillic
  '\u0430': 'a', '\u0431': 'b', '\u0432': 'b', '\u0433': 'r', '\u0435': 'e', '\u0437': 'e', '\u043a': 'k', '\u043c': 'm', '\u043d': 'h', '\u043e': 'o', '\u043f': 'n', '\u0440': 'p', '\u0441': 'c',
  '\u0442': 't', '\u0443': 'y', '\u0445': 'x', '\u0448': 'w', '\u0449': 'w', '\u044c': 'b', '\u0455': 's', '\u0456': 'i', '\u0458': 'j', '\u0501': 'd', '\u051b': 'q', '\u051d': 'w', '\u04bb': 'h',
  '\u04cf': 'l', '\u04af': 'y', '\u04b3': 'x',
  // Greek
  '\u03b1': 'a', '\u03b2': 'b', '\u03b3': 'y', '\u03b5': 'e', '\u03b6': 'z', '\u03b7': 'n', '\u03b9': 'i', '\u03ba': 'k', '\u03bc': 'u', '\u03bd': 'v', '\u03bf': 'o', '\u03c1': 'p', '\u03c2': 's',
  '\u03c4': 't', '\u03c5': 'u', '\u03c7': 'x', '\u03c9': 'w',
  // Armenian
  '\u0585': 'o', '\u057d': 'u', '\u0581': 'g',
  // Latin letters without a decomposition
  '\u0131': 'i', '\u0237': 'j', '\u0142': 'l', '\u00f8': 'o', '\u0111': 'd', '\u0127': 'h', '\u0167': 't', '\u0180': 'b', '\u0268': 'i', '\u0289': 'u', '\u00df': 'ss', '\u00e6': 'ae',
  '\u0153': 'oe', '\u00fe': 'th', '\u00f0': 'd', '\u0138': 'k', '\u014b': 'n',
  // IPA and small capitals
  '\u0251': 'a', '\u0250': 'a', '\u0253': 'b', '\u0256': 'd', '\u0257': 'd', '\u0259': 'e', '\u025b': 'e', '\u0261': 'g', '\u0262': 'g', '\u0266': 'h', '\u026a': 'i', '\u0269': 'i', '\u029d': 'j',
  '\u029f': 'l', '\u0271': 'm', '\u0274': 'n', '\u0272': 'n', '\u0275': 'o', '\u0280': 'r', '\u0282': 's', '\u0288': 't', '\u028a': 'u', '\u028b': 'v', '\u028f': 'y', '\u0290': 'z', '\u0291': 'z',
  '\u1d00': 'a', '\u0299': 'b', '\u1d04': 'c', '\u1d05': 'd', '\u1d07': 'e', '\ua730': 'f', '\u029c': 'h', '\u1d0a': 'j', '\u1d0b': 'k', '\u1d0d': 'm', '\u1d0f': 'o', '\u1d18': 'p', '\ua7af': 'q',
  '\ua731': 's', '\u1d1b': 't', '\u1d1c': 'u', '\u1d20': 'v', '\u1d21': 'w', '\u1d22': 'z',
};

const LEET_BASE: Record<string, string> = {
  '4': 'a', '@': 'a', '8': 'b', '3': 'e', '\u20ac': 'e', '6': 'g', '9': 'g', '0': 'o', '5': 's', '$': 's', '\u00a7': 's', '7': 't', '+': 't',
  '2': 'z', '\u00d7': 'x', '!': 'i', '\u00a1': 'i',
};
const LEET_I: Record<string, string> = { ...LEET_BASE, '1': 'i', '|': 'i' };
const LEET_L: Record<string, string> = { ...LEET_BASE, '1': 'l', '|': 'l' };

function mapChar(ch: string): string {
  const m = CONFUSABLE[ch];
  if (m !== undefined) return m;
  const cp = ch.codePointAt(0) ?? 0;
  if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return String.fromCharCode(97 + cp - 0x1f1e6); // regional indicator letters
  if (cp >= 0x1f150 && cp <= 0x1f169) return String.fromCharCode(97 + cp - 0x1f150); // negative circled letters
  if (cp >= 0x1f170 && cp <= 0x1f189) return String.fromCharCode(97 + cp - 0x1f170); // negative squared letters
  return ch;
}

/** lower-case skeleton (spaces kept): NFKC, invisibles out, optional camelCase split, marks stripped, confusables */
function skeleton(raw: string, splitCase: boolean): string {
  let s = raw.normalize('NFKC').replace(/[\s\u0085]+/gu, ' ').replace(INVISIBLE, '');
  if (splitCase) s = s.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2');
  s = s.toLowerCase().normalize('NFD').replace(/\p{M}+/gu, '');
  let out = '';
  for (const ch of s) out += mapChar(ch);
  return out;
}

const leet = (s: string, map: Record<string, string>): string => {
  let out = '';
  for (const ch of s) out += map[ch] ?? ch;
  return out;
};

/** one reading of a string: its words (letters only) and all its letters run together */
interface Form { words: string[]; squashed: string }

function formsOf(raw: string): Form[] {
  const out: Form[] = [];
  const seen = new Set<string>();
  for (const split of [false, true]) {
    const sk = skeleton(raw, split);
    for (const v of [sk, leet(sk, LEET_I), leet(sk, LEET_L)]) {
      if (seen.has(v)) continue;
      seen.add(v);
      const words = v.split(/[^\p{L}]+/u).filter(Boolean);
      out.push({ words, squashed: words.join('') });
    }
  }
  return out;
}

/** The folded, letters-only readings of a name (tests / diagnostics; never log them for a real player). */
export function foldVariants(raw: string): string[] {
  return [...new Set(formsOf(String(raw ?? '')).map((f) => f.squashed))];
}

// ---------------------------------------------------------------- matcher

export interface TermLists {
  /** matched anywhere in a word (and anywhere in a squashed name) */
  sub: readonly string[];
  /** matched at the start of a word */
  prefix: readonly string[];
  /** matched as a whole word (+ a plural s, or es after s/x/z/ch/sh; xX..Xx wrappers; gamer-tag decorations) */
  word: readonly string[];
  /** benign words that contain a term (masked before matching) */
  allow?: readonly string[];
  /** masked swearing skeletons: '*' = 1..3 mask symbols (w*rd, w**rd, w#rd) */
  masked?: readonly string[];
}

export interface WordFilter {
  /** a display name: words, camelCase parts and all letters run together are checked */
  nameBlocked(raw: string): boolean;
  /** a sentence (quote, typed line): each word is checked, never two words run together, plus "w o r d" letter runs */
  textBlocked(text: string): boolean;
  /** the sentence with every blocked word replaced by '*' (one per character) */
  maskText(text: string): string;
}

const clean = (list: readonly string[] | undefined): string[] => [...new Set((list ?? []).map((t) => t.toLowerCase()).filter((t) => /^[a-z]+$/.test(t)))];
/** term -> repeat-tolerant regex source: 'abba' -> 'a+b{2,}a+' (extra repeats still match; a single letter never stands in for a double one) */
const body = (t: string): string => t.replace(/([a-z])\1*/g, (m: string, c: string) => (m.length > 1 ? `${c}{${m.length},}` : `${c}+`));
const alt = (list: readonly string[]): string => list.map(body).join('|');
/** whole-word term + its plural: 'es' only after s/x/z/ch/sh (buses), else 's' (so spices / pikes stay legal) */
const wordAlt = (list: readonly string[]): string => list.map((t) => `${body(t)}${/(?:s|x|z|ch|sh)$/.test(t) ? '(?:es)?' : 's?'}`).join('|');
const DECO_PRE = 'the|mr|mrs|ms|dr|lil|big|im|iam|its|real|official|ttv|yt';
const DECO_POST = 'tv|ttv|yt|lol|official';
const MASK_CHARS = '[*#%^~?]';

/** A filter over these term lists (the module's own lists back nameBlocked / textBlocked / maskText). */
export function makeWordFilter(lists: TermLists): WordFilter {
  const sub = clean(lists.sub);
  const prefix = clean(lists.prefix);
  const word = clean(lists.word);
  const allow = clean(lists.allow).sort((a, b) => b.length - a.length);
  const subRe = sub.length ? new RegExp(`(?:${alt(sub)})`) : null;
  const prefixRe = prefix.length ? new RegExp(`^x*(?:${alt(prefix)})`) : null;
  const wordRe = word.length ? new RegExp(`^(?:${DECO_PRE})?x*(?:${wordAlt(word)})x*(?:${DECO_POST})?$`) : null;
  const allowRe = allow.length ? new RegExp(allow.join('|'), 'g') : null;
  const masked = (lists.masked ?? []).map((m) => m.toLowerCase()).filter((m) => /^[a-z]+(?:\*[a-z]+)+$/.test(m));
  // (no lookbehind: older Safari cannot parse it, and this module may load in the browser)
  const maskedRe = masked.length ? new RegExp(`(?:^|[^a-z])(?:${masked.map((m) => m.split('*').join(`${MASK_CHARS}{1,3}`)).join('|')})`) : null;

  const hit = (w: string): boolean => !!w && ((subRe?.test(w) ?? false) || (prefixRe?.test(w) ?? false) || (wordRe?.test(w) ?? false));
  /** letters with the allow-listed words cut out (each remaining piece is matched on its own) */
  const segments = (sq: string): string[] => (allowRe ? sq.replace(allowRe, '#').split('#').filter(Boolean) : [sq]);
  const segHit = (sq: string): boolean => segments(sq).some(hit);
  const maskedHit = (raw: string): boolean => !!maskedRe && maskedRe.test(skeleton(raw, false));

  /** one token (a name, or one whitespace-separated word of a sentence) */
  const tokenHit = (tok: string): boolean => {
    if (!tok) return false;
    if (HATE_SYMBOLS.test(tok) || maskedHit(tok)) return true;
    for (const f of formsOf(tok)) {
      if (segHit(f.squashed)) return true;
      for (const w of f.words) if (segHit(w)) return true;
    }
    return false;
  };

  /** per whitespace token: its letters in the plain and the leet-i reading (for letter runs and phrases) */
  const tokenLetters = (tokens: string[]): string[][] => [false, true].map((useLeet) =>
    tokens.map((t) => {
      const sk = skeleton(t, false);
      return (useLeet ? leet(sk, LEET_I) : sk).replace(/[^\p{L}]+/gu, '');
    }));

  /** indices of tokens that form a blocked single-letter run ("w o r d") or a harassment phrase */
  const multiTokenHits = (tokens: string[]): Set<number> => {
    const out = new Set<number>();
    for (const letters of tokenLetters(tokens)) {
      let start = -1;
      for (let i = 0; i <= letters.length; i++) {
        if (i < letters.length && letters[i].length === 1) { if (start < 0) start = i; continue; }
        if (start >= 0 && i - start >= 3 && segHit(letters.slice(start, i).join(''))) for (let j = start; j < i; j++) out.add(j);
        start = -1;
      }
      for (let i = 0; i < letters.length; i++) {
        for (let n = 2; n <= 3 && i + n <= letters.length; n++) {
          if (PHRASES.test(letters.slice(i, i + n).filter(Boolean).join(' '))) for (let j = i; j < i + n; j++) out.add(j);
        }
      }
    }
    return out;
  };

  return {
    nameBlocked(raw) {
      const s = String(raw ?? '');
      if (!s.trim()) return false;
      if (s.normalize('NFKC').replace(/\D+/g, '').includes(HATE_CODE)) return true;
      return tokenHit(s);
    },
    textBlocked(text) {
      const tokens = String(text ?? '').split(/\s+/).filter(Boolean);
      if (!tokens.length) return false;
      return tokens.some(tokenHit) || multiTokenHits(tokens).size > 0;
    },
    maskText(text) {
      const parts = String(text ?? '').split(/(\s+)/);
      const idx: number[] = [];
      const tokens: string[] = [];
      parts.forEach((p, i) => { if (p && !/^\s+$/.test(p)) { idx.push(i); tokens.push(p); } });
      const bad = multiTokenHits(tokens);
      tokens.forEach((t, k) => { if (tokenHit(t)) bad.add(k); });
      if (!bad.size) return parts.join('');
      for (const k of bad) parts[idx[k]] = [...tokens[k]].map(() => '*').join('');
      return parts.join('');
    },
  };
}

const FILTER = makeWordFilter({ sub: decode(SUB_13), prefix: decode(PREFIX_13), word: decode(WORD_13), allow: decode(ALLOW_13), masked: decode(MASKED_13) });

/** true if a display name holds a hate, sexual or harassment term (any spelling the fold undoes) */
export function nameBlocked(raw: string): boolean {
  return FILTER.nameBlocked(raw);
}

/** true if a sentence (quote, typed line) holds a blocked word; words are never run together ("class hole" is fine) */
export function textBlocked(text: string): boolean {
  return FILTER.textBlocked(text);
}

/** the sentence with every blocked word masked ('*' per character) */
export function maskText(text: string): string {
  return FILTER.maskText(text);
}

/**
 * Sanity check of the built-in lists (tests): every term blocks itself as a name and inside a sentence, every masked
 * skeleton blocks, every allow-listed word passes. Reports counts and failing list positions only, never the words.
 */
export function listSelfCheck(): { terms: number; allow: number; masked: number; failing: string[] } {
  const failing: string[] = [];
  const lists: Record<string, string[]> = { sub: decode(SUB_13), prefix: decode(PREFIX_13), word: decode(WORD_13) };
  let terms = 0;
  for (const [k, list] of Object.entries(lists)) {
    list.forEach((t, i) => {
      terms++;
      if (!nameBlocked(t) || !textBlocked(`go ${t} now`)) failing.push(`${k}#${i}`);
    });
  }
  const allow = decode(ALLOW_13);
  allow.forEach((t, i) => { if (nameBlocked(t) || textBlocked(`the ${t} is here`)) failing.push(`allow#${i}`); });
  const masked = decode(MASKED_13);
  masked.forEach((m, i) => { if (!nameBlocked(m) || !textBlocked(`a ${m.replace('*', '**')} day`)) failing.push(`masked#${i}`); });
  return { terms, allow: allow.length, masked: masked.length, failing };
}

const RESERVED = new Set(RESERVED_NAMES);
const unwrap =(w: string): string => w.replace(/^x+|x+$/g, '');

/** true if a name passes for one of the game's own voices (RESERVED_NAMES) */
export function nameReserved(raw: string): boolean {
  const s = String(raw ?? '');
  if (!s.trim()) return false;
  for (const f of formsOf(s)) {
    const core = unwrap(f.squashed.replace(/^(?:the|official|real)/, '')).replace(/(?:official|team|dept|department|bot)$/, '');
    if (RESERVED.has(core)) return true;
    if (f.words.length <= 2 && f.words.some((w) => RESERVED.has(unwrap(w)))) return true;
  }
  return false;
}

// ---------------------------------------------------------------- display names

/**
 * The display text of a name: NFKC, every space and line break -> one space, controls / zero-width / bidi overrides
 * out, no angle brackets, at most two combining marks in a row (no zalgo towers), trimmed, at most `max` UTF-16 units
 * without splitting a surrogate pair. '' when nothing is left.
 */
export function cleanDisplayName(raw: unknown, max: number = PROFILE_LIMITS.nameMax): string {
  let s = String(raw ?? '').normalize('NFKC')
    .replace(/[\s\u0085]+/gu, ' ')
    .replace(INVISIBLE, '')
    .replace(/[<>]/g, '')
    .replace(/(\p{M}{2})\p{M}+/gu, '$1')
    .trim();
  s = s.slice(0, Math.max(0, max));
  if (/[\uD800-\uDBFF]$/.test(s)) s = s.slice(0, -1);
  return s.trim();
}

/** FNV-1a (32 bit, unsigned) */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** salted re-hashes a generator tries before its fixed fallback (about 3 in 100 numbers are skipped: never reached) */
const SALT_TRIES = 64;

/** a name the game hands out itself: never blocked or reserved, and never with the code's second half (88) */
const generatedOk = (n: string): boolean => !n.includes(HATE_TAIL) && !nameBlocked(n) && !nameReserved(n);

/**
 * Contractor-NNNN: the replacement for a blocked or reserved name, 4 digits from an FNV-1a hash of the player id (stable
 * across reconnects and restarts). A number the filter refuses (the hate code, digits that read as a listed word in
 * leet) or one with 88 is re-hashed with a salt ("<id>#1", "#2", ...) until the name passes; every other id keeps the
 * v1.3 number.
 */
export function contractorName(id: string): string {
  const s = String(id ?? '');
  for (let salt = 0; salt < SALT_TRIES; salt++) {
    const n = `Contractor-${String(fnv1a(salt ? `${s}#${salt}` : s) % 10000).padStart(4, '0')}`;
    if (generatedOk(n)) return n;
  }
  return 'Contractor-0000';
}

/**
 * The client's default name for a player key (apps/client/src/core/net.ts): Contractor-<the key's first 3 hex digits,
 * upper case>, as in v1.2. Hex + leet can spell a listed word, so a head the filter refuses (or one with 88, or a key
 * that does not start with 3 hex digits) gives 3 hex digits of a salted FNV-1a hash of the key instead ("<key>#1",
 * "#2", ...), the first that passes. Pure: the server derives the same name from the hello's player key.
 */
export function defaultName(key: string): string {
  const k = String(key ?? '');
  const head = k.slice(0, 3).toUpperCase();
  if (/^[0-9A-F]{3}$/.test(head) && generatedOk(`Contractor-${head}`)) return `Contractor-${head}`;
  for (let salt = 1; salt < SALT_TRIES; salt++) {
    const n = `Contractor-${(fnv1a(`${k}#${salt}`) % 4096).toString(16).toUpperCase().padStart(3, '0')}`;
    if (generatedOk(n)) return n;
  }
  return 'Contractor-000';
}

export type NameVerdict = 'ok' | 'empty' | 'blocked' | 'reserved';

export interface SafeDisplayName {
  /** the name to show (cleaned, or Contractor-NNNN when blocked or reserved, or 'Contractor' when empty) */
  name: string;
  /** true when the player's name was replaced (blocked or reserved): tell them privately */
  blocked: boolean;
  reason: NameVerdict;
}

/**
 * The name everyone else sees for this player. `id` = the player id (or a stable save id for stored names); `key` = the
 * player key, when the caller has it (core/crews.ts on hello and resume). Only the exact defaults skip the filter:
 * contractorName(id) and, given the key, defaultName(key). Every other name, any other Contractor-NNNN included, is
 * checked (both generators only hand out names that pass it, so callers without the key treat defaults the same).
 */
export function safeDisplayName(raw: unknown, id: string, key?: string): SafeDisplayName {
  const name = cleanDisplayName(raw);
  if (!name) return { name: 'Contractor', blocked: false, reason: 'empty' };
  if (name.startsWith('Contractor-') && (name === contractorName(id) || (key !== undefined && name === defaultName(key)))) {
    return { name, blocked: false, reason: 'ok' };
  }
  if (nameBlocked(name)) return { name: contractorName(id), blocked: true, reason: 'blocked' };
  if (nameReserved(name)) return { name: contractorName(id), blocked: true, reason: 'reserved' };
  return { name, blocked: false, reason: 'ok' };
}

/** The private notice for a player whose name was replaced (no name in it: the client shows it to that player only). */
export function renameNotice(r: SafeDisplayName): string {
  return r.reason === 'reserved'
    ? `That name is reserved for the game. You are ${r.name} on this crew; pick another name in the menu.`
    : `That name is not allowed here. You are ${r.name} on this crew; pick another name in the menu.`;
}
