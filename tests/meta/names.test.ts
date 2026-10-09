// Owner: track (d) Meta. v1.3 P1c: meta's name safety on top of packages/shared/src/names.ts: sanitizeProfile (mirror
// renames + visor glyphs), saved names, HR-memo quotes (template pickQuote and the AI merge). Blocked words appear only
// as ROT13 codes (rot13() from names.ts), never in plain text: this repo is public.
//   node --test tests/meta/names.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rot13 } from '../../packages/shared/src/names.ts';
import { glyphsBlocked, maskLine, safeName, textBlocked } from '../../apps/server/src/meta/safety.ts';
import { sanitizeProfile, setRuntime } from '../../apps/server/src/meta/flow.ts';
import type { ProfileRefusal } from '../../apps/server/src/meta/flow.ts';
import { mergeAiReview, pickQuote, templateReview } from '../../apps/server/src/meta/review.ts';
import type { Profile } from '../../packages/shared/src/profile.ts';

setRuntime({ ctx: { balance: { meta: {}, core: {} }, flags: {}, log: () => ({ info() {}, warn() {}, error() {} }) } as never, store: null as never, shiftEndFns: [] });

/** a blocked proxy word (ROT13 of a mild insult on the names.ts list) */
const BAD = rot13('onfgneq');
const prof = (name: string, glyphs = 'A'): Profile => ({ name, body: 'm', suit: ['#d4a017', '#c0392b'], helmet: 'dome', visor: { glyphs, color: '#7dfcff' }, badge: 321 });

test('names.ts is wired: ordinary names pass, a blocked one becomes a stable Contractor-NNNN', () => {
  for (const n of ['Pieter', 'Sanne', 'xXSniperXx', 'Contractor-E37', 'Dickson', 'Scunthorpe']) assert.deepEqual(safeName(n, 'p1').blocked, false, n);
  const a = safeName(`${BAD}2000`, 'p1');
  assert.equal(a.blocked, true);
  assert.match(a.name, /^Contractor-\d{4}$/);
  assert.equal(safeName(`${BAD}2000`, 'p1').name, a.name, 'stable for the same id');
  const r = safeName('The Company', 'p1');
  assert.equal(r.blocked, true);
  assert.equal(r.reason, 'reserved');
});

test('a blocked mirror rename keeps the old name and is reported; reserved names are reported as reserved', () => {
  const refused: ProfileRefusal = {};
  const p = sanitizeProfile(prof([...BAD].join('.')), 1, prof('Ann'), 'p1', refused);
  assert.equal(p.name, 'Ann');
  assert.equal(refused.name, true);
  assert.equal(refused.reserved, false);
  const r2: ProfileRefusal = {};
  assert.equal(sanitizeProfile(prof('Listener'), 1, prof('Ann'), 'p1', r2).name, 'Ann');
  assert.equal(r2.reserved, true);
  const ok: ProfileRefusal = {};
  assert.equal(sanitizeProfile(prof('Bob'), 1, prof('Ann'), 'p1', ok).name, 'Bob');
  assert.equal(ok.name, undefined);
});

test('a blocked name with a blocked previous name becomes the replacement', () => {
  const p = sanitizeProfile(prof(BAD), 1, prof(`${BAD}X`), 'p1', {});
  assert.match(p.name, /^Contractor-\d{4}$/);
});

test('visor glyphs: hate symbols and blocked text fall back to the previous glyphs, else none', () => {
  // this repo is public: the symbols are written as escapes and the letter acronym is built at runtime
  const K3 = 'K'.repeat(3);
  const symbols = [K3, [...K3.toLowerCase()].join(' '), '\u5350', '\u534d', '\u0fd6', '\u03df\u03df', '88',
    // hidden behind invisible separators (zero-width space, right-to-left mark, word joiner, byte order mark)
    [...K3].join('\u200b'), [...K3].join('\u200f'), '\u16cb\u2060\u16cb', '\u03df\ufeff\u03df'];
  symbols.forEach((g, i) => assert.equal(glyphsBlocked(g), true, `blocked glyphs #${i}`));
  for (const g of ['A', 'JD', '7', 'K9', 'XO', 'ANN']) assert.equal(glyphsBlocked(g), false, `glyphs ${g}`);
  const refused: ProfileRefusal = {};
  assert.equal(sanitizeProfile(prof('Ann', K3), 1, prof('Ann', 'AN'), 'p1', refused).visor.glyphs, 'AN');
  assert.equal(refused.glyphs, true);
  assert.equal(sanitizeProfile(prof('Ann', K3), 1, prof('Ann', K3), 'p1', {}).visor.glyphs, '');
});

test('HR memo: a blocked overheard line is never the quote', () => {
  const quotes = [`meet at the vault you ${BAD}, code 4417 now!`, 'go left at the boiler'];
  assert.equal(textBlocked(quotes[0]), true);
  assert.equal(pickQuote(quotes), 'go left at the boiler');
  assert.equal(pickQuote([`${BAD} where is the code?`]), null);
  assert.equal(pickQuote(['wait here please', 'run to the vault now 12'], (t) => t.includes('vault')), 'wait here please', 'injectable predicate');
  const r = templateReview({ crew: 'T', shiftIndex: 0, quota: 100, hauled: 200, overtime: 0, met: true, nextQuota: 300, players: [
    { id: 'a', name: 'Ann', level: 1, deaths: 0, survived: 3, contracts: 3, quotes: [`${BAD} the vault code is 12`] },
  ] });
  assert.equal(r.memos[0].quote, undefined, 'no quote printed');
  assert.ok(!r.memos[0].body.toLowerCase().includes(BAD));
});

test('HR memo: a blocked AI quote is dropped from the merged memo', () => {
  const base = templateReview({ crew: 'T', shiftIndex: 0, quota: 100, hauled: 200, overtime: 0, met: true, nextQuota: 300, players: [
    { id: 'a', name: 'Ann', level: 1, deaths: 0, survived: 3, contracts: 3, quotes: [] },
  ] });
  mergeAiReview(base, { memos: { a: { title: 'T', lines: ['Fine work.', 'Truly.'], quote: `${BAD} at the vault` } }, source: 'ai' });
  assert.equal(base.memos[0].quote, undefined);
  assert.ok(!base.memos[0].body.toLowerCase().includes(BAD));
  assert.ok(base.memos[0].body.includes('Fine work.'));
});

test('the speakerphone masks a blocked word', () => {
  const m = maskLine(`shut up you ${BAD}`);
  assert.ok(!m.toLowerCase().includes(BAD));
  assert.ok(m.startsWith('shut up you'));
});
