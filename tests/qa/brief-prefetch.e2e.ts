// P3 QA: (d) meta asks (e) briefFor() for the NEXT board's orders as soon as a contract starts, so the AI text is
// ready by results time. Uses AI_MODE=replay (tests/ai/fixtures, never the network) so the real call path runs:
//   contract 1 start -> 3 brief.opus calls for board 2 (same ids/seeds as the board enterHub builds later)
//   results -> hub   -> board 2 arrives with source 'ai' at once, no extra brief.opus calls (cache hits)
//   shift end        -> briefs for the next shift's first board start during the HR memo
// Run: node tests/qa/brief-prefetch.e2e.ts   (in-process server on a random port, temp SAVES_DIR)
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bot } from '../meta/bot.ts';
import type { FullState } from '../../packages/shared/src/state.ts';

process.env.SAVES_DIR = mkdtempSync(join(tmpdir(), 'deadair-qa-brief-'));
process.env.NODE_ENV = 'development';
process.env.AI_MODE = 'replay';
process.env.NET_SESSION = '0';
process.env.STT_URL = 'http://127.0.0.1:9'; // no STT in this test

const { boot } = await import('../../apps/server/src/core/boot.ts');
const { setQuiet } = await import('../../apps/server/src/core/log.ts');
const tracks = await Promise.all(
  ['net', 'level', 'players', 'voice', 'objectives', 'interaction', 'monsters', 'meta', 'ai'].map(async (n) => {
    const m = (await import(`../../apps/server/src/${n}/index.ts`)) as { install: (ctx: never) => unknown };
    return [n, m.install] as [string, (ctx: never) => unknown];
  }),
);
if (!process.env.VERBOSE) setQuiet(true);
const srv = await boot({ mode: 'development', port: 0, tracks: tracks as never });
const url = `ws://127.0.0.1:${srv.port}/ws`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const calls = async (b: Bot): Promise<number> => {
  const s = await b.req<{ mode: string; routes: Record<string, { calls: number }> }>('dbg.ai.status');
  assert.equal(s.mode, 'replay');
  return s.routes['brief.opus']?.calls ?? 0;
};

let code = 0;
const bots: Bot[] = [];
try {
  const a = new Bot('Ann');
  const b = new Bot('Bob');
  bots.push(a, b);
  await a.join(url, 'QBRF');
  await b.join(url, 'QBRF');
  await sleep(300);
  const c0 = await calls(a);
  assert.equal(c0, 0, 'first board of the night: templates only (PLAN 4.8)');

  const run = async (k: number): Promise<FullState> => {
    const o = a.state!.workOrders.find((x) => x.available)!;
    await a.req('meta.pick', { orderId: o.id });
    const drive = a.nextPhase('drive');
    await a.req('meta.ready', { ready: true });
    await b.req('meta.ready', { ready: true });
    await drive;
    const contract = a.nextPhase('contract', 10_000);
    await a.req('dbg.meta.skipDrive');
    await contract;
    await sleep(400);
    const atStart = await calls(a);
    console.log(`contract ${k}: brief.opus calls at contract start = ${atStart}`);
    const results = a.nextPhase('results');
    await a.req('dbg.meta.endContract', { hauled: 300 });
    const rv = (await results).d as { state: FullState };
    await sleep(300);
    const atResults = await calls(a);
    const hub = a.nextPhase('hub');
    await a.req('meta.continue');
    const hv = (await hub).d as { state: FullState };
    await sleep(500);
    const atHub = await calls(a);
    console.log(`contract ${k}: results ${rv.state.meta.results?.shiftEnd ? '(shift end) ' : ''}calls ${atResults}, hub calls ${atHub}; board sources at hub entry: ${hv.state.workOrders.map((x) => x.source).join(',')}; now: ${a.state!.workOrders.map((x) => x.source).join(',')}`);
    return hv.state;
  };

  // contract 1 -> the prefetch for board 2 starts with the contract
  const h1 = await run(1);
  const c1 = await calls(a);
  assert.equal(c1, 3, 'exactly the 3 orders of board 2 were briefed (at contract 1 start), no more at hub entry');
  assert.ok(a.state!.workOrders.every((o) => o.source === 'ai'), 'board 2 shows AI text right after hub entry');
  assert.ok(h1.workOrders.every((o) => o.id === a.state!.workOrders.find((x) => x.id === o.id)?.id), 'same order ids');

  // contract 2 (not the last): prefetch board 3
  await run(2);
  const c2 = await calls(a);
  assert.equal(c2, 6, 'board 3 briefed once (prefetched at contract 2 start)');
  assert.ok(a.state!.workOrders.every((o) => o.source === 'ai'), 'board 3 AI text ready at hub entry');

  // contract 3 = shift end: briefs for the next shift's first board start at results (verdict known)
  await run(3);
  const c3 = await calls(a);
  assert.equal(c3, 9, 'next-shift board briefed once, during the HR memo');
  assert.ok(a.state!.workOrders.every((o) => o.source === 'ai'), 'next shift board AI text ready');
  console.log('QA BRIEF PREFETCH PASS');
} catch (e) {
  code = 1;
  console.error('QA BRIEF PREFETCH FAIL:', e instanceof Error ? (e.stack ?? e.message) : e);
} finally {
  for (const bt of bots) bt.close();
  await srv.close().catch(() => {});
  process.exitCode = code;
  setTimeout(() => process.exit(code), 800).unref();
}
