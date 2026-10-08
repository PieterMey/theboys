// Owner: track (c) Monsters (v1.2 G2). Unit (no server): the monster tests never start or reuse the live server (game
// :3000, STT :3100, play.dead-air.io). bot.ts refuseLive throws for those ports and bases; startServer calls it before it
// spawns anything, and the browser tests before they reuse a BASE_URL.
//   node --test tests/monsters/live-guard.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { refuseLive } from './bot.ts';

test('refuseLive: the live ports and hosts throw, the test ports pass', () => {
  for (const port of [3000, 3100]) assert.throws(() => refuseLive(port), /refusing the live server/, `port ${port}`);
  for (const base of ['http://127.0.0.1:3000', 'http://localhost:3100/', 'ws://127.0.0.1:3000/ws', 'https://play.dead-air.io', 'https://PLAY.DEAD-AIR.IO/x']) {
    assert.throws(() => refuseLive(3802, base), /refusing the live server/, base);
  }
  for (const port of [3802, 3013, 3030, 30000]) assert.doesNotThrow(() => refuseLive(port), `port ${port}`);
  for (const base of ['http://127.0.0.1:3802', 'http://127.0.0.1:30001/', 'http://localhost:3013']) assert.doesNotThrow(() => refuseLive(3802, base), base);
});
