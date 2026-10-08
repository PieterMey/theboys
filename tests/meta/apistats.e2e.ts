// Owner: meta-records (v1.2). GET /api/stats (main-menu personnel file, before joining):
//   401 without the x-deadair-key header (a key in the URL is ignored), you:null for a key with no save, the caller's
//   own file for a known key, Cache-Control no-store, and the key never shows up in the server log.
// Run: node tests/meta/apistats.e2e.ts   (spawns a dev server on PORT, default 3804; temp SAVES_DIR + SESSION_FILE)
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Bot } from './bot.ts';
import { startServer } from './lib.ts';
import type { StatsReply } from '../../packages/shared/src/progress.ts';

const PORT = Number(process.env.PORT ?? 3804);
const srv = await startServer(PORT);
let code = 0;
const bot = new Bot('Ann', randomBytes(16).toString('hex'));
try {
  const H = 'x-deadair-key';
  // before any save exists for the key
  const r0 = await fetch(`${srv.base}/api/stats`, { headers: { [H]: bot.key } });
  assert.equal(r0.status, 200);
  const j0 = (await r0.json()) as StatsReply;
  assert.equal(j0.you, null, 'no save yet');
  assert.ok(j0.collectionSize > 40, `collection size ${j0.collectionSize}`);

  await bot.join(`ws://127.0.0.1:${PORT}/ws`, 'APIS');
  await new Promise((r) => setTimeout(r, 300));
  await bot.req('meta.buy', { item: 'bottles' }); // the crew save is written on its first change
  await bot.req('dbg.meta.flush');

  const none = await fetch(`${srv.base}/api/stats`);
  assert.equal(none.status, 401, 'no header -> 401');
  const inUrl = await fetch(`${srv.base}/api/stats?key=${bot.key}&x-deadair-key=${bot.key}`);
  assert.equal(inUrl.status, 401, 'a key in the URL is never used');
  const wrong = (await (await fetch(`${srv.base}/api/stats`, { headers: { [H]: 'not-a-real-key' } })).json()) as StatsReply;
  assert.equal(wrong.you, null, 'unknown key -> no file');

  const ok = await fetch(`${srv.base}/api/stats`, { headers: { [H]: bot.key } });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('cache-control') ?? '', /no-store/);
  const j = (await ok.json()) as StatsReply;
  assert.equal(j.you?.name, 'Ann');
  assert.equal(j.you?.saveId, bot.me, 'own save');
  assert.equal(j.you?.stats.v, 1);
  assert.ok(j.crews.some((c) => c.code === 'APIS'), 'crew listed');
  assert.ok(!JSON.stringify(j).includes(bot.key), 'the reply never echoes the key');

  // the request reply (in-game Record tab) is the same file
  const viaWs = await bot.req<StatsReply>('meta.stats');
  assert.equal(viaWs.you?.saveId, j.you?.saveId);

  bot.close();
  await new Promise((r) => setTimeout(r, 300));
  const log = srv.log();
  assert.ok(log.length > 100, 'captured the server log');
  assert.ok(!log.includes(bot.key), 'the key is never logged');
  console.log(`META API STATS E2E PASS (log ${log.length} chars checked)`);
} catch (e) {
  code = 1;
  console.error('META API STATS E2E FAIL:', e instanceof Error ? (e.stack ?? e.message) : e);
  console.error(srv.log().slice(-1500));
} finally {
  bot.close();
  srv.stop();
  process.exitCode = code;
  setTimeout(() => process.exit(code), 800).unref();
}
