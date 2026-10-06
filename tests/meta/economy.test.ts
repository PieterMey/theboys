// Owner: track (d) Meta. Unit tests: quota formula, overtime, badge fines, levels, board, review templates.
// Run: node --test tests/meta/economy.test.ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { badgeFines, economyFrom, firstQuota, levelFor, nextLevelXp, nextQuota, overtime } from '../../apps/server/src/meta/economy.ts';
import { makeBoard } from '../../apps/server/src/meta/orders.ts';
import { SITES, FLAVOUR_NOTES, CODE_A_NOTES, CODE_B_NOTES, LEVER_NOTES } from '../../apps/server/src/meta/templates.ts';
import { pickQuote, templateReview, mergeAiReview } from '../../apps/server/src/meta/review.ts';
import { hashPin } from '../../apps/server/src/meta/saves.ts';

const root = join(import.meta.dirname, '../..');
const core = JSON.parse(readFileSync(join(root, 'config/balance/core.json'), 'utf8')) as Record<string, unknown>;
const meta = JSON.parse(readFileSync(join(root, 'config/balance/meta.json'), 'utf8')) as Record<string, unknown>;
const e = economyFrom(core, meta);

test('first quota = 500 x player multiplier (PLAN 3.6)', () => {
  assert.equal(firstQuota(e, 2), 375);
  assert.equal(firstQuota(e, 3), 440);
  assert.equal(firstQuota(e, 4), 500);
  assert.equal(firstQuota(e, 5), 560);
  assert.equal(firstQuota(e, 6), 625);
});

test('later quota = prev + 275 x (1 + n^2/10) x U(0.85..1.15), deterministic', () => {
  for (let n = 1; n <= 4; n++) {
    const q = nextQuota(e, 500, n, 'CREW');
    const base = 275 * (1 + (n * n) / 10);
    assert.ok(q >= 500 + base * 0.85 - 1 && q <= 500 + base * 1.15 + 1, `n=${n} q=${q}`);
    assert.equal(q, nextQuota(e, 500, n, 'CREW'), 'same seed -> same quota');
  }
});

test('overtime 20% above quota; fines 10% per badge from balance', () => {
  assert.equal(overtime(e, 600, 500), 20);
  assert.equal(overtime(e, 400, 500), 0);
  assert.deepEqual(badgeFines(e, 300, 2), [30, 30]);
  assert.deepEqual(badgeFines(e, 0, 1), [0]);
});

test('levels 0/150/400/750/1200/1800/2600', () => {
  assert.equal(levelFor(e, 0), 1);
  assert.equal(levelFor(e, 149), 1);
  assert.equal(levelFor(e, 150), 2);
  assert.equal(levelFor(e, 2600), 7);
  assert.equal(nextLevelXp(e, 1), 150);
  assert.equal(nextLevelXp(e, 7), null);
});

test('template pack: 20+ sites, notes carry the (e) placeholders', () => {
  assert.ok(SITES.length >= 20, `${SITES.length} sites`);
  assert.equal(new Set(SITES.map((s) => s.name)).size, SITES.length, 'unique site names');
  for (const n of CODE_A_NOTES) assert.ok(n.body.includes('{{CODE_A}}') && !n.body.includes('{{CODE_B}}'));
  for (const n of CODE_B_NOTES) assert.ok(n.body.includes('{{CODE_B}}') && !n.body.includes('{{CODE_A}}'));
  for (const n of LEVER_NOTES) assert.ok(n.body.includes('{{ROOM_2}}') && n.body.includes('{{ROOM_3}}'));
  for (const n of [...FLAVOUR_NOTES]) assert.ok(!/\{\{(CODE_[AB]|ROOM_[23])\}\}/.test(n.body), 'flavour notes never hold secrets');
});

test('board: 3 orders, risk 2 gated, placeholders once each', () => {
  const b = makeBoard({
    crewCode: 'ABCD', shiftIndex: 0, contract: 0, boardSeq: 1, players: 4, avgLevel: 1, achievements: [],
    payoutMult: { 1: 1, 2: 1.4 }, riskLootMult: { 1: 1, 2: 1.4 }, playerMult: 1, lootBudgetBase: 650,
    risk2MinAvgLevel: 2, risk2Achievement: 'Core Business', recentSites: [],
  });
  assert.equal(b.length, 3);
  assert.equal(b[0].risk, 1);
  assert.equal(b[2].risk, 2);
  assert.equal(b[2].available, false);
  for (const o of b) {
    const all = o.notes.map((n) => n.body).join('\n');
    for (const ph of ['CODE_A', 'CODE_B', 'ROOM_2', 'ROOM_3']) assert.equal(all.split(`{{${ph}}}`).length - 1, 1, `${ph} once in ${o.id}`);
    assert.ok((all.split('{{ROOM_1}}').length - 1) <= 1, 'ROOM_1 at most once');
    assert.ok(o.requests.length === 2 && o.requests.every((r) => r.reward >= 50 && r.reward <= 150));
  }
  const b2 = makeBoard({
    crewCode: 'ABCD', shiftIndex: 0, contract: 0, boardSeq: 1, players: 4, avgLevel: 2, achievements: [],
    payoutMult: { 1: 1, 2: 1.4 }, riskLootMult: { 1: 1, 2: 1.4 }, playerMult: 1, lootBudgetBase: 650,
    risk2MinAvgLevel: 2, risk2Achievement: 'Core Business', recentSites: [],
  });
  assert.equal(b2[2].available, true, 'avg level 2 unlocks risk 2');
  assert.deepEqual(b2.map((o) => o.seed), b.map((o) => o.seed), 'deterministic seeds');
});

test('review: template memo + termination letter; AI ShiftReview merges', () => {
  const r = templateReview({
    crew: 'ABCD', shiftIndex: 0, quota: 500, hauled: 320, overtime: 0, met: false, nextQuota: null,
    players: [
      { id: 'p1', name: 'Ann', level: 2, deaths: 0, survived: 3, contracts: 3, quotes: ['ok meet me in the BOILER in 2 minutes', 'lol'] },
      { id: 'p2', name: 'Bob', level: 1, deaths: 3, survived: 0, contracts: 3, quotes: [] },
    ],
  });
  assert.equal(r.verdict, 'fired');
  assert.ok(r.letter && r.letter.includes('Ann') && r.letter.includes('Bob'));
  assert.equal(r.memos[1].rating, 'DECEASED · STILL ON PAYROLL');
  assert.ok(r.memos[0].body.includes('BOILER'), 'quote used');
  assert.equal(pickQuote(['hi', 'ok meet me in the BOILER in 2 minutes']), 'ok meet me in the BOILER in 2 minutes');
  const changed = mergeAiReview(r, { crew: 'ABCD', memos: { p1: { title: 'Synergy Champion', lines: ['Line one.', 'Line two.'], quote: 'meet in boiler' } }, comments: ['c1', 'c2'], letter: 'You are fired, warmly.', source: 'ai' });
  assert.equal(changed, true);
  assert.equal(r.memos[0].title, 'Synergy Champion');
  assert.ok(r.memos[0].body.startsWith('Line one. Line two.'));
  assert.deepEqual(r.employeeComments, ['c1', 'c2']);
  assert.equal(r.letter, 'You are fired, warmly.');
  assert.equal(r.source, 'ai');
  assert.equal(mergeAiReview(r, { source: 'template', comments: ['x'] }), false, 'template results never overwrite');
});

test('PIN hash is salted sha256 hex', () => {
  const h = hashPin('p123', '0420');
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.notEqual(h, hashPin('p124', '0420'));
});
