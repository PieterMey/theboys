// Owner: track (d) Meta. v1.3 P2b: who the van waits for at the end of the drive, ws clients against an in-process dev
// server (no browser). Bots (hello.build 'bot' -> ServerPlayer.bot) are never waited for, asked or not; a human client
// that never asks for the site holds the van at most driveLoadWaitSec (30 s) past the drive timer and is named on the
// drive screen; a human that asks late holds it until it reports loaded. Port 3804; saves in the meta scratch folder.
// Run: node tests/meta/drivewait.e2e.ts   (about 45 s: one wait runs the full 30 s cap)
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bot } from './bot.ts';
import type { FullState } from '../../packages/shared/src/state.ts';

const SCRATCH = process.env.META_SCRATCH ?? join(tmpdir(), 'dead-air-meta');
mkdirSync(join(SCRATCH, 'saves'), { recursive: true });
const saves = mkdtempSync(join(SCRATCH, 'saves', 'drivewait-'));
process.env.SAVES_DIR = saves;
process.env.SESSION_FILE = join(saves, 'session.json');
process.env.NODE_ENV = 'development';
process.env.AI_MODE = 'mock';

const { boot } = await import('../../apps/server/src/core/boot.ts');
const { setQuiet } = await import('../../apps/server/src/core/log.ts');
const tracks = await Promise.all(
  ['net', 'level', 'players', 'voice', 'objectives', 'interaction', 'monsters', 'meta', 'ai'].map(async (n) => {
    const m = (await import(`../../apps/server/src/${n}/index.ts`)) as { install: (ctx: never) => unknown };
    return [n, m.install] as [string, (ctx: never) => unknown];
  }),
);
if (!process.env.VERBOSE) setQuiet(true);
const srv = await boot({ mode: 'development', port: Number(process.env.PORT ?? 3804), tracks: tracks as never });
const url = `ws://127.0.0.1:${srv.port}/ws`;
const t0 = performance.now();
const step = (s: string) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WAIT = Number((JSON.parse(readFileSync(join(import.meta.dirname, '../../config/balance/meta.json'), 'utf8')) as { driveLoadWaitSec?: number }).driveLoadWaitSec ?? 30);

/** pick + ready everyone -> drive; then the drive timer ends 1 s later; resolves with the seconds until 'contract' */
async function driveAndTime(lead: Bot, all: Bot[], during?: (hash: string) => Promise<void>, timeoutMs = 45_000): Promise<{ sec: number; waiting: string[] }> {
  const order = lead.state!.workOrders.find((o) => o.available)!;
  await lead.req('meta.pick', { orderId: order.id });
  const drive = lead.nextPhase('drive');
  for (const b of all) await b.req('meta.ready', { ready: true });
  const dv = await drive;
  const hash = (dv.d as { state: FullState }).state.meta.drive ? ((await lead.req<{ hash: string | null }>('net.preload')).hash ?? '') : '';
  let arrived = 0;
  const contract = lead.nextPhase('contract', timeoutMs).then(() => { arrived = performance.now(); });
  await lead.req('dbg.meta.driveFor', { sec: 1 });
  const ts = performance.now();
  let waiting: string[] = [];
  const watch = (async () => {
    for (let i = 0; i < 40 && !waiting.length && !arrived; i++) {
      await sleep(100);
      waiting = (lead.state as FullState).meta.drive?.waiting ?? [];
    }
  })();
  if (during) await during(hash);
  await contract;
  await watch;
  return { sec: (arrived - ts) / 1000, waiting };
}

let code = 0;
const bots: Bot[] = [];
try {
  // ---------- bots only (one even asks for the site and never reports it): no wait
  const b1 = new Bot('Bot1');
  const b2 = new Bot('Bot2');
  bots.push(b1, b2);
  await b1.join(url, 'DRW1');
  await b2.join(url, 'DRW1');
  await sleep(150);
  const r1 = await driveAndTime(b1, [b1, b2], async () => { await b2.req('net.preload'); });
  step(`bots only: contract ${r1.sec.toFixed(1)} s after a 1 s drive timer was set (waiting ${JSON.stringify(r1.waiting)})`);
  assert.ok(r1.sec < 3, 'bots are never waited for');
  assert.deepEqual(r1.waiting, []);

  // ---------- a human client that never asks: the van holds at most driveLoadWaitSec
  const lead = new Bot('Lead');
  const human = new Bot('Hana');
  human.build = 'e2e-human';
  bots.push(lead, human);
  await lead.join(url, 'DRW2');
  await human.join(url, 'DRW2');
  await sleep(150);
  const r2 = await driveAndTime(lead, [lead, human]);
  step(`human never asks: contract ${r2.sec.toFixed(1)} s after a 1 s drive timer was set (waiting ${JSON.stringify(r2.waiting)})`);
  assert.ok(r2.sec >= 1 + WAIT - 1.5 && r2.sec <= 1 + WAIT + 2.5, `held ~${WAIT} s past the timer (${r2.sec.toFixed(1)} s)`);
  assert.deepEqual(r2.waiting, ['Hana'], 'the drive screen names who the van holds for');

  // ---------- a human that asks late: the van waits until it reports loaded
  const lead3 = new Bot('Lead3');
  const late = new Bot('Lars');
  late.build = 'e2e-human';
  bots.push(lead3, late);
  await lead3.join(url, 'DRW3');
  await late.join(url, 'DRW3');
  await sleep(150);
  const r3 = await driveAndTime(lead3, [lead3, late], async (hash) => {
    await sleep(3000);
    const pre = await late.req<{ hash: string | null }>('net.preload');
    assert.equal(pre.hash, hash);
    await sleep(3000);
    await late.req('net.loaded', { hash, ok: true, ms: 6000 });
  });
  step(`human asks late: contract ${r3.sec.toFixed(1)} s after a 1 s drive timer was set`);
  assert.ok(r3.sec >= 5 && r3.sec < 9, `held until loaded (${r3.sec.toFixed(1)} s)`);

  console.log(`META DRIVEWAIT E2E PASS (${((performance.now() - t0) / 1000).toFixed(1)} s)`);
} catch (e) {
  code = 1;
  console.error('META DRIVEWAIT E2E FAIL:', e instanceof Error ? (e.stack ?? e.message) : e);
} finally {
  for (const bt of bots) bt.close();
  await srv.close().catch(() => {});
  process.exitCode = code;
  setTimeout(() => process.exit(code), 800).unref();
}
