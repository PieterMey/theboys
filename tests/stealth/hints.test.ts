// players-stealth (v1.2) unit tests for the one-time stealth hints (apps/client/src/players/stealth.ts, no browser):
//   - spottedHints: the Listener's 'monsters.spotted' shows 'spotted' the first time; 'flashlight' the first time it
//     spots you with your own flashlight on in an unlit room, queued after 'spotted' when both are new (never over it)
//   - the hint store: once ever per browser (localStorage 'deadair.hints.v12'), nothing while meta's hints setting is off
//   - roomLitAt: the room-light reading under the player (unknown = no flashlight hint)
//   - the flashlight hint's 6 M / 3 M are the Listener's sight ranges (config/balance/monsters.json)
//   node --test tests/stealth/hints.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HINTS_KEY, HINT_TEXT, createHintStore, roomLitAt, spottedHints } from '../../apps/client/src/players/stealth.ts';
import type { HintId } from '../../apps/client/src/players/stealth.ts';

const ROOT = join(import.meta.dirname, '../..');

function memStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, m };
}

/** players/index.ts's 'monsters.spotted' handler over a store + queue: what shows now, what is queued */
function spottedEvent(store: ReturnType<typeof createHintStore>, queue: HintId[], flashlightOn: boolean, roomLit: boolean | null): { shown: HintId[]; queued: HintId[] } {
  const plan = spottedHints((id) => store.seen(id) || queue.includes(id), flashlightOn, roomLit);
  const shown: HintId[] = [];
  if (plan.now && store.once(plan.now)) shown.push(plan.now);
  if (plan.later && !store.seen(plan.later) && !queue.includes(plan.later)) queue.push(plan.later);
  return { shown, queued: [...queue] };
}

test('spottedHints: spotted first; flashlight only with your own light on in an unlit room', () => {
  const none = () => false;
  assert.deepEqual(spottedHints(none, true, false), { now: 'spotted', later: 'flashlight' });
  assert.deepEqual(spottedHints(none, false, false), { now: 'spotted', later: null });
  assert.deepEqual(spottedHints(none, true, true), { now: 'spotted', later: null });
  assert.deepEqual(spottedHints(none, true, null), { now: 'spotted', later: null }, 'unknown room light: no flashlight hint');
  const spotted = (id: HintId) => id === 'spotted';
  assert.deepEqual(spottedHints(spotted, true, false), { now: 'flashlight', later: null });
  assert.deepEqual(spottedHints(spotted, false, false), { now: null, later: null });
  assert.deepEqual(spottedHints(spotted, true, true), { now: null, later: null });
  const both = (id: HintId) => id === 'spotted' || id === 'flashlight';
  assert.deepEqual(spottedHints(both, true, false), { now: null, later: null });
});

test('the spotted / flashlight pair: one each, ever, in order, and never over each other', () => {
  const st = memStorage();
  let store = createHintStore(st);
  const queue: HintId[] = [];
  // first notice, flashlight on in a dark room: 'spotted' now, 'flashlight' queued behind it
  assert.deepEqual(spottedEvent(store, queue, true, false), { shown: ['spotted'], queued: ['flashlight'] });
  // a second notice while 'flashlight' is still queued: nothing new, nothing doubled
  assert.deepEqual(spottedEvent(store, queue, true, false), { shown: [], queued: ['flashlight'] });
  // the queue's turn (frame(): hintOnce)
  assert.equal(store.once(queue.shift()!), true);
  assert.deepEqual(spottedEvent(store, queue, true, false), { shown: [], queued: [] });
  // remembered across reloads (same browser storage)
  store = createHintStore(st);
  assert.equal(store.seen('spotted') && store.seen('flashlight'), true);
  assert.deepEqual(JSON.parse(st.m.get(HINTS_KEY)!).sort(), ['flashlight', 'spotted']);

  // a player who first got spotted in a lit room (or with the light off) gets the flashlight hint later, right away
  const st2 = memStorage();
  const s2 = createHintStore(st2);
  const q2: HintId[] = [];
  assert.deepEqual(spottedEvent(s2, q2, true, true), { shown: ['spotted'], queued: [] });
  assert.deepEqual(spottedEvent(s2, q2, false, false), { shown: [], queued: [] });
  assert.deepEqual(spottedEvent(s2, q2, true, false), { shown: ['flashlight'], queued: [] });
  assert.deepEqual(spottedEvent(s2, q2, true, false), { shown: [], queued: [] });
});

test('hints off (meta settings): nothing shows and nothing is remembered', () => {
  const st = memStorage({ 'deadair.meta.settings': JSON.stringify({ hints: false }) });
  const store = createHintStore(st);
  const queue: HintId[] = [];
  const r = spottedEvent(store, queue, true, false);
  assert.deepEqual(r.shown, []);
  assert.equal(store.once(queue.shift() ?? 'flashlight'), false);
  assert.equal(st.m.has(HINTS_KEY), false);
  assert.equal(store.seen('spotted') || store.seen('flashlight'), false);
});

test('roomLitAt: the room-light state of the space under the player; unknown = null', () => {
  // 3 x 2: spaces 0 (unlit), 1 (lit); one solid cell
  const L = { W: 3, H: 2, owner: [0, 0, 1, -1, 1, 1] };
  const lightOn = (s: number) => s === 1;
  assert.equal(roomLitAt(L, lightOn, 0.5, 0.5), false);
  assert.equal(roomLitAt(L, lightOn, 1.9, 0.2), false);
  assert.equal(roomLitAt(L, lightOn, 2.5, 0.5), true);
  assert.equal(roomLitAt(L, lightOn, 1.5, 1.5), true);
  assert.equal(roomLitAt(L, lightOn, 0.5, 1.5), null, 'a solid cell');
  assert.equal(roomLitAt(L, lightOn, -0.5, 0.5), null, 'outside the grid');
  assert.equal(roomLitAt(L, lightOn, 3.2, 0.5), null, 'outside the grid');
  assert.equal(roomLitAt(L, lightOn, Number.NaN, 0.5), null);
  assert.equal(roomLitAt(null, lightOn, 0.5, 0.5), null, 'no layout');
  assert.equal(roomLitAt(L, undefined, 0.5, 0.5), null, 'no room-light query (interaction missing)');
  assert.equal(roomLitAt(L, () => { throw new Error('mid-init'); }, 0.5, 0.5), null);
});

test('the flashlight hint quotes the Listener\'s sight ranges', () => {
  const lb = (JSON.parse(readFileSync(join(ROOT, 'config/balance/monsters.json'), 'utf8')) as { listener: { sightLitM: number; sightDarkM: number } }).listener;
  assert.match(HINT_TEXT.flashlight, new RegExp(`IT SEES YOU AT ${lb.sightLitM} M\\b`));
  assert.match(HINT_TEXT.flashlight, new RegExp(`DARK: ${lb.sightDarkM} M\\b`));
  assert.match(HINT_TEXT.spotted, /SPRINT, BREAK LINE OF SIGHT, THEN CREEP \(C\)/);
});
