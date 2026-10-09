// v1.3 P1a: display-name safety (packages/shared/src/names.ts). No slur is ever written here: the mechanics run on
// benign proxy words through makeWordFilter(), and checks of the real list use ROT13 codes decoded at run time.
//   node --test tests/core/names.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RESERVED_NAMES, cleanDisplayName, contractorName, defaultName, foldVariants, listSelfCheck, makeWordFilter, maskText, nameBlocked,
  nameReserved, renameNotice, rot13, safeDisplayName, textBlocked,
} from '../../packages/shared/src/names.ts';

/** decode a space-separated ROT13 list */
const codes = (s: string): string[] => rot13(s).split(' ');
/** the numeric hate code, built at run time (never written out in this public repo) */
const HATE_CODE = String(14) + String(88);

// ---------------------------------------------------------------- the ai-design evasion probe (16 transforms x 6 words)

const CYR: Record<string, string> = { a: '\u0430', e: '\u0435', o: '\u043e', i: '\u0456', c: '\u0441', p: '\u0440', x: '\u0445', y: '\u0443' };
const LEET_DIGITS: Record<string, string> = { a: '4', e: '3', i: '1', o: '0', s: '5', t: '7' };
const LEET_SYMBOLS: Record<string, string> = { a: '@', i: '!', s: '$' };
const TRANSFORMS: Record<string, (w: string) => string> = {
  plain: (w) => w,
  titleCase: (w) => w[0].toUpperCase() + w.slice(1),
  allCaps: (w) => w.toUpperCase(),
  inName: (w) => `xX${w}Xx`,
  withDigits: (w) => `${w}2000`,
  hyphenSuffix: (w) => `${w}-Destroyer`,
  leetDigits: (w) => [...w].map((c) => LEET_DIGITS[c] ?? c).join(''),
  leetSymbols: (w) => [...w].map((c) => LEET_SYMBOLS[c] ?? c).join(''),
  spaced: (w) => [...w].join(' '),
  dotted: (w) => [...w].join('.'),
  underscored: (w) => [...w].join('_'),
  doubledLetters: (w) => [...w].map((c, i) => (i % 2 ? c + c : c)).join(''),
  cyrillicHomoglyphs: (w) => [...w].map((c) => CYR[c] ?? c).join(''),
  zeroWidth: (w) => w.slice(0, 2) + '\u200b' + w.slice(2),
  fullwidth: (w) => [...w].map((c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0)).join(''),
  combiningMarks: (w) => [...w].map((c) => c + '\u0301').join(''),
};

function probe(words: readonly string[], blocked: (s: string) => boolean): { caught: number; total: number; partial: string[] } {
  let caught = 0;
  let total = 0;
  const partial: string[] = [];
  for (const [name, fn] of Object.entries(TRANSFORMS)) {
    let c = 0;
    for (const w of words) if (blocked(fn(w))) c++;
    caught += c;
    total += words.length;
    if (c < words.length) partial.push(`${name} ${c}/${words.length}`);
  }
  return { caught, total, partial };
}

/** benign proxies, one per mode the real list uses (sub / prefix / word) */
const PROXY = makeWordFilter({
  sub: ['zorblax', 'gribnok', 'snorkwump'],
  prefix: ['quib', 'blent'],
  word: ['flarp', 'mungo'],
  allow: ['quibble', 'blentworth'],
  masked: ['z*rb', 'fl*rp'],
});

test('fold mechanics (benign proxies): all 16 evasion transforms of every mode are caught', () => {
  const r = probe(['zorblax', 'gribnok', 'snorkwump', 'quibster', 'blenter', 'flarp', 'mungo'], PROXY.nameBlocked);
  assert.equal(r.caught, r.total, `missed: ${r.partial.join(', ')}`);
});

test('modes (benign proxies): sub anywhere, prefix at a word start, word whole (+plural, xX..Xx, decorations)', () => {
  const yes = ['MegaZorblax', 'megazorblax', 'z o r b l a x', 'zzoorrbbllaaxx', 'Quibs', 'quib-master', 'Big Quibster', 'flarp', 'Flarps',
    'xXflarpXx', 'TheFlarp', 'flarp_tv', 'f l a r p', 'f.l.a.r.p', 'mungo2000', 'Mr Mungo', 'z*rb', 'Z##RB', 'fl#rp', 'fl^^rp'];
  for (const n of yes) assert.equal(PROXY.nameBlocked(n), true, `blocks ${n}`);
  const no = ['aquib', 'Squib', 'quibble', 'Quibbles', 'blentworth', 'flarpy', 'unflarp', 'flarpington', 'Mungolia', 'humungo', 'zorb', 'flap',
    'Pieter', 'Sanne', 'xXSniperXx'];
  for (const n of no) assert.equal(PROXY.nameBlocked(n), false, `keeps ${n}`);
  // sentences: words are never run together, but single-letter runs are joined
  assert.equal(PROXY.textBlocked('meet the zorblax at the vault'), true);
  assert.equal(PROXY.textBlocked('z o r b l a x behind you'), true);
  assert.equal(PROXY.textBlocked('zor blax'), false, 'two real words are not run together in a sentence');
  assert.equal(PROXY.nameBlocked('zor blax'), true, 'but a name is read run together');
  assert.equal(PROXY.textBlocked('a flarpy quibble'), false);
  assert.equal(PROXY.maskText('the flarp is at the  boiler, quibble!'), 'the ***** is at the  boiler, quibble!');
  assert.equal(PROXY.maskText('go f l a r p now'), 'go * * * * * now');
  assert.equal(PROXY.maskText('nothing here'), 'nothing here');
});

test('the real list: the ai-design probe words (ROT13 codes) are caught in >= 94 of 96 evasions (v1.2 blocked(): 42)', () => {
  const words = codes('onfgneq uvgyre cbea xnaxre nffubyr anmv');
  const r = probe(words, nameBlocked);
  console.log(`  names.ts blocked ${r.caught}/${r.total}${r.partial.length ? `; partial: ${r.partial.join(', ')}` : ''}`);
  assert.ok(r.caught >= 94, `${r.caught}/${r.total}: ${r.partial.join(', ')}`);
  // the same words in sentences, masked swearing, numeric and symbol codes
  for (const w of words) assert.equal(textBlocked(`meet the ${w} at the vault`), true, 'a probe word in a sentence');
  assert.equal(nameBlocked(rot13('s**x')), true, 'masked swearing');
  assert.equal(nameBlocked(`Bob ${HATE_CODE.slice(0, 2)} ${HATE_CODE.slice(2)}`), true, 'numeric hate code');
  assert.equal(nameBlocked('Bob \u5350'), true, 'hate symbol');
  assert.equal(textBlocked(rot13('xvyy lbhefrys')), true, 'harassment phrase');
  assert.equal(textBlocked(rot13('s h p x vg')), true, 'letter run in a sentence');
});

// ordinary names and handles (EN + NL + gamer tags) and, ROT13-coded, real words that contain a listed term
const ORDINARY = ['Pieter', 'Jan', 'Sanne', 'Daan', 'Lotte', 'Bram', 'Sem', 'Noah', 'Emma', 'Julia', 'Lucas', 'Finn', 'Tess', 'Milan',
  'Fleur', 'Ruben', 'Anouk', 'Thijs', 'Sophie', 'Jesse', 'Sven', 'Koen', 'Niels', 'Joost', 'Wouter', 'Maarten', 'Hendrik', 'Kees',
  'Sjoerd', 'Richard', 'Contractor-E37', 'Contractor-766', 'xXSniperXx', 'GhostRider', 'NightOwl', 'Voicetest', 'L33tHax0r',
  'Bob_the_Builder', 'Mr.Spooky', 'Kluis'];
const SCUNTHORPE = codes('Pnffnaqen Qvpxfba Fphagubecr Fhffrk Zngfhfuvgn Unapbpx Nffhagn Onffnz Tynftbj Chfflpng Fuvgnxr Pbpxohea Xhag Gvghf Naany Fcvpre Encre Nanyvfr Tencr Gurencvfg Frkgba Zvqqyrfrk Rffrk Xavtug Avtry Favttre Fcvpl Zbssng Ubrexrf Cvxnpuh Yhyh Xhggre');

test('false positives: about 3 of the 72 ordinary EN/NL names and handles at most (ai-design probe list)', () => {
  const all = [...ORDINARY, ...SCUNTHORPE];
  assert.equal(all.length, 72);
  const fp = all.map((n, i) => (nameBlocked(n) || nameReserved(n) ? i : -1)).filter((i) => i >= 0);
  console.log(`  false positives: ${fp.length}/72${fp.length ? ` (list indices ${fp.join(', ')})` : ''}`);
  assert.ok(fp.length <= 3, `${fp.length} false positives (indices ${fp.join(', ')})`);
  for (const n of ORDINARY) assert.deepEqual(safeDisplayName(n, 'p1'), { name: n, blocked: false, reason: 'ok' }, n);
});

test('sentences: ordinary game talk (EN + NL) is never blocked; words are not run together', () => {
  const talk = ['meet me at the boiler in ten', 'the code is 4417', 'kill the lights', 'go left at the boiler', 'wacht bij de kluis',
    'ik heb de sleutel', 'trek de hendel', 'pak de kleren', 'assassin behind you', 'pass the spices', 'for the lulz', 'mother figure',
    'hij zat bellend in de auto', 'class hole', 'mass effect', 'the cocktail bar', 'analysis says go left', 'the canal room',
    'peninsula map', 'pedometer says 4000', 'the assembly hall', 'kanaal twee', 'de flikkerende lamp', 'i a m h e r e', 'b o i l e r',
    'run to the vault now', 'waar is de kern', 'the snatcher got me', 'do not look at it', 'neukirchen station', ''];
  for (const s of talk) assert.equal(textBlocked(s), false, JSON.stringify(s));
  for (const s of talk) assert.equal(maskText(s), s, JSON.stringify(s));
});

test('every listed term blocks itself (as a name and in a sentence); allow-listed words pass', () => {
  const r = listSelfCheck(); // counts and list positions only: the decoded words are never printed
  console.log(`  ${r.terms} terms, ${r.masked} masked skeletons, ${r.allow} allow-listed words`);
  assert.ok(r.terms >= 120, `${r.terms} terms`);
  assert.deepEqual(r.failing, []);
  assert.deepEqual(foldVariants('x'), ['x']);
  for (const w of codes('onfgneq uvgyre cbea xnaxre nffubyr anmv')) {
    assert.equal(nameBlocked(w.toUpperCase()), true);
    assert.equal(textBlocked(`${w}!`), true);
  }
});

test('reserved names: the game\'s own voices, as the whole name or one of at most two words', () => {
  assert.deepEqual([...RESERVED_NAMES].sort(), ['admin', 'administrator', 'claude', 'company', 'hr', 'listener', 'moderator', 'system']);
  const yes = ['Listener', 'The Listener', 'L1stener', 'LISTENER', 'Company', 'The Company', 'H.R.', 'hr', 'Admin', 'Admin Bob', 'xXAdminXx',
    'Claude', 'ClaudeAI', 'System', 'System-bot', 'SYSTEM32', 'Moderator', 'Administrator', 'Sys tem', '\u0421laude'];
  for (const n of yes) assert.equal(nameReserved(n), true, `reserved ${n}`);
  const no = ['Claudette', 'Hrothgar', 'Systematic', 'Company of Wolves', 'Listener fan club', 'Admiral', 'Pieter', 'Voicetest'];
  for (const n of no) assert.equal(nameReserved(n), false, `not reserved ${n}`);
  const r = safeDisplayName('The Listener', 'pABC');
  assert.equal(r.blocked, true);
  assert.equal(r.reason, 'reserved');
  assert.equal(r.name, contractorName('pABC'));
});

test('cleanDisplayName: controls, bidi overrides, zero-width, angle brackets out; NFKC; zalgo capped; 16 units, pairs intact', () => {
  assert.equal(cleanDisplayName('  Bob\u0000\u0007\u001f  '), 'Bob');
  assert.equal(cleanDisplayName('Bob\u202eevil'), 'Bobevil', 'RTL override removed');
  assert.equal(cleanDisplayName('Pie\u200bter\u2060'), 'Pieter', 'zero-width removed');
  assert.equal(cleanDisplayName('<b>Bob</b>'), 'bBob/b');
  assert.equal(cleanDisplayName('\uff30\uff49\uff45\uff54\uff45\uff52'), 'Pieter', 'fullwidth -> ASCII');
  assert.equal(cleanDisplayName('Ann\n\tBob'), 'Ann Bob', 'line breaks -> one space');
  assert.equal(cleanDisplayName('Zoë'), 'Zoë', 'accents kept');
  assert.equal(cleanDisplayName(`Z${'\u0336'.repeat(30)}ed`).length, 5, 'at most two combining marks in a row');
  assert.equal(cleanDisplayName('abcdefghijklmnopqrstuvwxyz'), 'abcdefghijklmnop');
  const emoji = `${'a'.repeat(15)}\u{1F600}`; // the emoji's surrogate pair would straddle unit 16
  assert.equal(cleanDisplayName(emoji), 'a'.repeat(15));
  assert.equal(cleanDisplayName(null), '');
  assert.equal(cleanDisplayName(42), '42');
});

test('safeDisplayName: Contractor-NNNN from the id (stable), private notice text without the old name', () => {
  const bad = rot13('onfgneq') + '99';
  const a = safeDisplayName(bad, 'pXyZ123');
  assert.equal(a.blocked, true);
  assert.equal(a.reason, 'blocked');
  assert.match(a.name, /^Contractor-\d{4}$/);
  assert.deepEqual(safeDisplayName(bad, 'pXyZ123'), a, 'deterministic');
  assert.equal(a.name, contractorName('pXyZ123'));
  assert.notEqual(contractorName('pXyZ123'), contractorName('pXyZ124'));
  const n = renameNotice(a);
  assert.ok(n.includes(a.name) && !n.toLowerCase().includes(rot13('onfgneq')), 'notice names the replacement only');
  assert.deepEqual(safeDisplayName('', 'p1'), { name: 'Contractor', blocked: false, reason: 'empty' });
  assert.deepEqual(safeDisplayName('   ', 'p1'), { name: 'Contractor', blocked: false, reason: 'empty' });
  // ordinary-looking defaults pass the filter; one whose hex reads as a listed word in leet (ROT13 codes) is no longer
  // waved through for a player it does not belong to (tests below: the exact defaults)
  for (const d of ['Contractor-0E3', 'Contractor-1234']) assert.equal(safeDisplayName(d, 'p1').blocked, false, d);
  for (const d of codes('Pbagenpgbe-N55 Pbagenpgbe-SN6')) assert.deepEqual(safeDisplayName(d, 'p1'), { name: contractorName('p1'), blocked: true, reason: 'blocked' }, 'leet hex default of another key');
  // G4 meta/safety.ts reads { name, blocked } and textBlocked()
  assert.equal(typeof textBlocked, 'function');
  const g4 = safeDisplayName('Ann', 'save-1');
  assert.equal(g4.name, 'Ann');
  assert.equal(g4.blocked, false);
});

test('defaults: only the exact defaults skip the filter; neither generator hands out a refused name', () => {
  const fnv = (s: string): number => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; };
  const four = (n: number): string => `Contractor-${String(n).padStart(4, '0')}`;
  /** what a generated name must never be: refused by the filter, or carrying 88 */
  const refused = (n: string): boolean => nameBlocked(n) || nameReserved(n) || n.includes(HATE_CODE.slice(2));

  // 1. a typed Contractor-<the hate code> is blocked for everyone (v1.3 let any Contractor-NNNN through unchecked)
  const typed = `Contractor-${HATE_CODE}`;
  assert.equal(nameBlocked(typed), true);
  for (const id of ['p1', 'pXyZ123', 'save-1']) assert.deepEqual(safeDisplayName(typed, id), { name: contractorName(id), blocked: true, reason: 'blocked' }, id);
  assert.equal(safeDisplayName(typed, 'p1', 'abcdef0123456789abcdef0123456789').blocked, true, 'with a player key too');

  // 2. the 4-digit space: the filter refuses a handful of numbers (the code, digits that read as listed words), and
  //    generated names skip every number with 88 as well
  const space = Array.from({ length: 10000 }, (_, n) => four(n));
  const skipped = new Set(space.filter(refused));
  const filterOnly = space.filter((n) => nameBlocked(n) || nameReserved(n)).length;
  assert.ok(skipped.has(typed) && skipped.size > 250 && skipped.size < 400, `${skipped.size} skipped numbers`);
  assert.ok(filterOnly >= 5 && filterOnly <= 20, `${filterOnly} numbers the filter refuses`);

  // 3. contractorName: never a skipped number, and every id whose v1.3 number was fine keeps it (stable replacements)
  let moved = 0;
  for (let i = 0; i < 10000; i++) {
    const id = `p${i}`;
    const c = contractorName(id);
    const v13 = four(fnv(id) % 10000);
    assert.match(c, /^Contractor-\d{4}$/);
    assert.ok(!skipped.has(c), `id ${i} got a skipped number`);
    if (skipped.has(v13)) { moved++; assert.notEqual(c, v13); } else assert.equal(c, v13, `id ${i} keeps its number`);
    assert.deepEqual(safeDisplayName(c, id), { name: c, blocked: false, reason: 'ok' }, 'its own replacement passes');
  }
  assert.ok(moved > 100 && moved < 500, `${moved} of 10000 ids re-hashed`);
  assert.deepEqual(safeDisplayName(contractorName('p2'), 'p1'), { name: contractorName('p2'), blocked: false, reason: 'ok' }, "another player's replacement is checked, and passes");
  let hit = '';
  for (let i = 0; i < 400_000 && !hit; i++) if (four(fnv(`q${i}`) % 10000) === typed) hit = `q${i}`;
  assert.ok(hit, 'an id the v1.3 hash sent to the code');
  assert.notEqual(contractorName(hit), typed);
  assert.equal(refused(contractorName(hit)), false);
  assert.equal(contractorName(hit), contractorName(hit), 'deterministic');

  // 4. defaultName, every 3-hex head: the v1.2 default (the key's first 3 hex digits) stays unless it is refused
  let changed = 0;
  for (let h = 0; h < 4096; h++) {
    const head = h.toString(16).padStart(3, '0');
    const key = `${head}${'5e'.repeat(14)}a`; // 32 hex digits, like the client's keys
    const d = defaultName(key);
    const v12 = `Contractor-${head.toUpperCase()}`;
    assert.match(d, /^Contractor-[0-9A-F]{3}$/);
    assert.equal(refused(d), false, `head ${h}`);
    if (refused(v12)) { changed++; assert.notEqual(d, v12); } else assert.equal(d, v12, `head ${h} keeps the v1.2 default`);
    assert.deepEqual(safeDisplayName(d, `p${h}`, key), { name: d, blocked: false, reason: 'ok' }, 'the exact default passes with its key');
  }
  assert.ok(changed > 0 && changed < 64, `${changed} of 4096 heads re-derived`);
  // the leet hex heads (ROT13 codes) get another default, and the old one is refused even with its own key
  for (const old of codes('Pbagenpgbe-N55 Pbagenpgbe-SN6')) {
    const key = `${old.slice(-3).toLowerCase()}${'5e'.repeat(14)}a`;
    assert.notEqual(defaultName(key), old);
    assert.equal(defaultName(key), defaultName(key), 'deterministic');
    assert.equal(safeDisplayName(old, 'p1', key).blocked, true);
  }
  // odd keys (empty, short, not hex) still get a hex default that passes
  for (const k of ['', 'zz', 'not-hex-at-all', 'XYZ123']) {
    assert.match(defaultName(k), /^Contractor-[0-9A-F]{3}$/);
    assert.equal(refused(defaultName(k)), false);
  }
});

test('the fold is deterministic and cheap (no randomness, no clock): 2000 names well under a second', () => {
  const names = Array.from({ length: 2000 }, (_, i) => `Player_${i.toString(36)}${i % 7 ? '' : 'X'}`);
  const t0 = performance.now();
  const r1 = names.map((n) => safeDisplayName(n, n).name);
  const ms = performance.now() - t0;
  const r2 = names.map((n) => safeDisplayName(n, n).name);
  assert.deepEqual(r1, r2);
  console.log(`  2000 names in ${ms.toFixed(0)} ms`);
  assert.ok(ms < 2000, `${ms} ms`);
});
