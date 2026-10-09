// Owner: track (d) Meta. v1.3 P2b: who the van waits for at the end of the drive (pure, no server).
//   node --test tests/meta/drive-wait.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crewLoaded, loadWaiting, playerLoaded } from '../../apps/server/src/meta/flow.ts';
import type { Crew, ServerPlayer } from '../../apps/server/src/core/types.ts';

const HASH = 'h-site';

function player(name: string, o: { bot?: boolean | null; observer?: boolean; connected?: boolean; want?: string | null; loaded?: string | null } = {}): ServerPlayer {
  const slices: Record<string, unknown> = {};
  if (o.observer) slices.observer = true;
  if (o.want !== undefined || o.loaded !== undefined) slices.loading = { want: o.want ?? null, loaded: o.loaded ?? null, at: 0 };
  const p = { id: `p-${name}`, name, connected: o.connected ?? true, slices } as unknown as ServerPlayer;
  if (o.bot !== undefined && o.bot !== null) (p as unknown as { bot: boolean }).bot = o.bot;
  return p;
}
const crewOf = (...ps: ServerPlayer[]): Crew => ({ players: new Map(ps.map((p) => [p.id, p])) } as unknown as Crew);
const pending = { pendingLayout: { hash: HASH } as never };

test('a human that never asked for the site is waited for (bot flag known)', () => {
  const h = player('Ann', { bot: false });
  assert.equal(playerLoaded(h, HASH), false);
  const c = crewOf(h);
  assert.equal(crewLoaded(c, pending), false);
  assert.deepEqual(loadWaiting(c, pending), ['Ann']);
});

test('a human that asked late is waited for until it reports loaded', () => {
  const h = player('Ann', { bot: false, want: HASH, loaded: null });
  assert.equal(playerLoaded(h, HASH), false);
  (h.slices.loading as { loaded: string }).loaded = HASH;
  assert.equal(playerLoaded(h, HASH), true);
  assert.equal(crewLoaded(crewOf(h), pending), true);
});

test('bots are never waited for, asked or not', () => {
  assert.equal(playerLoaded(player('B1', { bot: true }), HASH), true);
  assert.equal(playerLoaded(player('B2', { bot: true, want: HASH, loaded: null }), HASH), true);
  const c = crewOf(player('B1', { bot: true }), player('B2', { bot: true, want: HASH }));
  assert.equal(crewLoaded(c, pending), true);
  assert.deepEqual(loadWaiting(c, pending), []);
});

test('observers and disconnected players are never waited for', () => {
  assert.equal(playerLoaded(player('Obs', { bot: false, observer: true }), HASH), true);
  assert.equal(playerLoaded(player('Gone', { bot: false, connected: false }), HASH), true);
});

test('a stale mark for another layout does not count as loaded', () => {
  assert.equal(playerLoaded(player('Ann', { bot: false, want: 'old', loaded: 'old' }), HASH), false);
});

test('no pending layout: nothing to wait for', () => {
  const c = crewOf(player('Ann', { bot: false }));
  assert.equal(crewLoaded(c, { pendingLayout: null }), true);
  assert.deepEqual(loadWaiting(c, { pendingLayout: null }), []);
});

test('a core without the bot flag keeps the v1.1 rule (only askers are waited for)', () => {
  assert.equal(playerLoaded(player('Old'), HASH), true, 'never asked: not waited for');
  assert.equal(playerLoaded(player('Old', { want: HASH }), HASH), false, 'asked: waited for');
  assert.equal(playerLoaded(player('Old', { want: HASH, loaded: HASH }), HASH), true);
});

test('mixed crew: only the unloaded human holds the van', () => {
  const c = crewOf(player('Ann', { bot: false, want: HASH, loaded: HASH }), player('Bob', { bot: false }), player('Bot', { bot: true }));
  assert.equal(crewLoaded(c, pending), false);
  assert.deepEqual(loadWaiting(c, pending), ['Bob']);
});
