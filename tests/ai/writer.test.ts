// Track (e): briefs (placeholder validation) and the shift review, AI_MODE=mock (no network).
//   node --test tests/ai/writer.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { configureGateway, resetGateway } from '../../apps/server/src/ai/gateway.ts';
import { fillPlaceholders, mergeBrief, placeholdersIn, resetBriefs } from '../../apps/server/src/ai/brief.ts';
import { resetReviews, templateReview } from '../../apps/server/src/ai/review.ts';
import { addQuote } from '../../apps/server/src/ai/hub.ts';
import { briefFor, reviewFor } from '../../apps/server/src/ai/api.ts';
import { quietLog, templateOrder } from './helpers.ts';

beforeEach(() => {
  resetGateway();
  resetBriefs();
  resetReviews();
  configureGateway({ mode: 'mock', flags: {}, bal: () => ({}), budgetUsd: () => 3, log: quietLog });
});

test('briefFor (mock Opus) rewrites flavour and keeps placeholders exactly once in the same notes', async () => {
  const o = templateOrder();
  const ai = await briefFor(o);
  assert.equal(ai.source, 'ai');
  assert.equal(ai.id, o.id);
  assert.equal(ai.seed, o.seed);
  assert.notEqual(ai.siteName, o.siteName);
  assert.deepEqual(placeholdersIn(ai.notes[0].body), ['CODE_A']);
  assert.deepEqual(placeholdersIn(ai.notes[1].body).sort(), ['CODE_B', 'ROOM_1']);
  assert.equal(ai.notes[0].slot, 'note:0');
  assert.ok(ai.requests[1].text.includes('400'), 'the request number survives');
  assert.equal(await briefFor(o), ai, 'cached per order');
  assert.equal(fillPlaceholders(ai.notes[0].body, { CODE_A: '47' })?.includes('47'), true);
  assert.equal(fillPlaceholders('x {{CODE_Z}}', { CODE_A: '1' }), null);
});

test('mergeBrief rejects notes with moved/duplicated/missing placeholders or invented codes', () => {
  const o = templateOrder();
  const base = { site_name: 'Nightjar Waterworks', history: 'It hummed.', memo: 'Be quiet.', requests: ['Everyone comes back, ideally.', 'Bring back over 400 scrip.'] };
  const moved = mergeBrief(o, { ...base, notes: [{ title: 'A', body: 'Second {{CODE_B}}' }, { title: 'B', body: '{{CODE_A}} and {{ROOM_1}}' }] });
  assert.ok(moved);
  assert.deepEqual(moved.notes, o.notes, 'notes kept from the template');
  assert.equal(moved.siteName, 'Nightjar Waterworks', 'other fields still applied');
  const dup = mergeBrief(o, { ...base, notes: [{ title: 'A', body: '{{CODE_A}} {{CODE_A}}' }, { title: 'B', body: '{{CODE_B}} {{ROOM_1}}' }] });
  assert.deepEqual(dup?.notes, o.notes);
  const fake = mergeBrief(o, { ...base, notes: [{ title: 'A', body: 'The code is 4719. {{CODE_A}}' }, { title: 'B', body: '{{CODE_B}} {{ROOM_1}}' }] });
  assert.deepEqual(fake?.notes, o.notes);
  const ok = mergeBrief(o, { ...base, notes: [{ title: 'A', body: 'Scratched: {{CODE_A}}' }, { title: 'B', body: 'Then {{CODE_B}} near {{ROOM_1}}' }] });
  assert.equal(ok?.notes[1].body, 'Then {{CODE_B}} near {{ROOM_1}}');
  assert.equal(mergeBrief(o, { site_name: '', history: '', memo: '', requests: [], notes: [] }), null, 'nothing usable -> null');
});

test('briefFor never rejects and returns the template when AI is off', async () => {
  configureGateway({ mode: 'mock', flags: { ai: false }, bal: () => ({}), budgetUsd: () => 3, log: quietLog });
  const o = templateOrder('o2');
  const r = await briefFor(o);
  assert.equal(r, o);
});

test('reviewFor (mock Opus): per-player memo with a verbatim overheard quote chosen by index, 8 comments, letter when fired', async () => {
  addQuote('RVW1', 'p1', { text: 'I am definitely not lost, meet me at the boiler', at: 1, heardByListener: true, meaningful: true, band: 2 }, 40);
  addQuote('RVW1', 'p1', { text: 'ok', at: 2, heardByListener: false, meaningful: false, band: 2 }, 40);
  const shift = { crew: 'RVW1', quota: 500, hauled: 320, fired: true, players: [{ id: 'p1', name: 'Sam', deaths: 1, hauled: 120 }, { id: 'p2', name: 'Noor', deaths: 0, hauled: 200 }] };
  const tpl = templateReview(shift);
  assert.equal(tpl.memos.p1.quote, 'I am definitely not lost, meet me at the boiler');
  assert.ok(tpl.letter);
  const r = await reviewFor(shift);
  assert.equal(r.source, 'ai');
  assert.equal(r.memos.p1.quote, 'I am definitely not lost, meet me at the boiler');
  assert.equal(r.memos.p2.quote, null, 'no consented quotes -> no quote');
  assert.equal(r.memos.p1.lines.length, 2);
  assert.equal(r.comments.length, 8);
  assert.ok(r.letter && r.letter.length > 10);
  const kept = await reviewFor({ ...shift, crew: 'RVW2', fired: false });
  assert.equal(kept.letter, null);
});
