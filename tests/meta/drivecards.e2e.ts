// Owner: track (d) Meta. v1.3: the drive screen's monster cards match what spawns, one ws bot against an in-process dev
// server (no browser). On Risk 1 the 2nd contract of a shift (contract index 1) shows no Snatcher card and spawns no
// Snatcher; the 3rd (index 2) shows the card and spawns it (the Mannequin likewise). The card follows
// balance.monsters live: snatcher.minContractIndex 1 brings it to the 2nd contract. Port 3804 (PORT overrides); saves
// under META_SCRATCH (default: the OS temp folder).
// Run: node tests/meta/drivecards.e2e.ts
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bot } from './bot.ts';
import type { MetaState } from '../../packages/shared/src/messages/meta.ts';
import type { FullState } from '../../packages/shared/src/state.ts';

const SCRATCH = process.env.META_SCRATCH ?? join(tmpdir(), 'dead-air-meta');
mkdirSync(join(SCRATCH, 'saves'), { recursive: true });
const saves = mkdtempSync(join(SCRATCH, 'saves', 'drivecards-'));
process.env.SAVES_DIR = saves;
process.env.SESSION_FILE = join(saves, 'session.json');
process.env.NODE_ENV = 'development';
process.env.AI_MODE = 'mock';

const { boot } = await import('../../apps/server/src/core/boot.ts');
const { setQuiet } = await import('../../apps/server/src/core/log.ts');
const { S } = await import('../../apps/server/src/meta/flow.ts');
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
const CREW = 'SNC1';
const meta = (b: Bot): MetaState => (b.state as FullState).meta;
const cards = (b: Bot): string[] => (meta(b).drive?.rules ?? []).map((r) => r.monster);
const mannequinTitle = (b: Bot): string => meta(b).drive?.rules.find((r) => r.monster === 'mannequin')?.title ?? '';
async function until(what: string, pred: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(50);
  }
}

/** pick a Risk 1 order, ready up and hold the drive screen; true if the server's pending site has vents */
async function drive(b: Bot): Promise<boolean> {
  const o = b.state!.workOrders.find((w) => w.available && w.risk === 1);
  assert.ok(o, 'a Risk 1 order on the board');
  await b.req('meta.pick', { orderId: o!.id });
  const p = b.nextPhase('drive', 15_000);
  await b.req('meta.ready', { ready: true });
  await p;
  await b.req('dbg.meta.driveFor', { sec: 120 });
  await until('the drive cards', () => cards(b).length > 0);
  const crew = srv.ctx.crews.get(CREW);
  assert.ok(crew, 'the crew');
  return !!S(crew!).pendingLayout?.items.some((i) => i.kind === 'vent');
}

/** leave the drive screen for the contract: the kinds of monster that spawned */
async function contractMonsters(b: Bot): Promise<string[]> {
  const p = b.nextPhase('contract', 20_000);
  await b.req('dbg.meta.skipDrive');
  await p;
  const st = await b.req<{ agents?: { kind?: unknown }[] }>('dbg.monsters.state');
  return (st.agents ?? []).map((a) => String(a.kind));
}

/** end the contract and come back to the van */
async function backToVan(b: Bot): Promise<void> {
  const r = b.nextPhase('results', 10_000);
  await b.req('dbg.meta.endContract', { hauled: 120 });
  await r;
  const h = b.nextPhase('hub', 15_000);
  await b.req('dbg.meta.resultsNow');
  await h;
  await sleep(300);
}

let code = 0;
const a = new Bot('Ann');
try {
  await a.join(url, CREW);
  await sleep(200);
  // the crew's 2nd contract of the shift
  await a.req('dbg.meta.shift', { contract: 1 });
  await until('contract index 1', () => meta(a).shift.contract === 1);

  const vents2 = await drive(a);
  assert.equal(vents2, true, 'every facility site has vents (procgen validate)');
  assert.ok(!cards(a).includes('snatcher'), `2nd contract: no Snatcher card (cards ${cards(a).join(', ')})`);
  assert.equal(mannequinTitle(a), 'MANNEQUIN: NOT REPORTED');
  step(`2nd contract (index 1), Risk 1: cards ${cards(a).join(', ')}`);

  // the card reads balance.monsters live: an earlier Snatcher shows on this drive screen at once
  const sb = srv.ctx.balance.monsters.snatcher as Record<string, unknown>;
  const was = sb.minContractIndex;
  sb.minContractIndex = 1;
  await a.req('dbg.meta.driveFor', { sec: 120 });
  await until('the Snatcher card with minContractIndex 1', () => cards(a).includes('snatcher'));
  sb.minContractIndex = was;
  await a.req('dbg.meta.driveFor', { sec: 120 });
  await until('no Snatcher card again', () => !cards(a).includes('snatcher'));
  step('balance snatcher.minContractIndex 1 -> the card shows on the 2nd contract; back to 2 -> gone');

  const spawned2 = await contractMonsters(a);
  assert.ok(!spawned2.includes('snatcher'), `2nd contract: no Snatcher spawned (${spawned2.join(', ')})`);
  assert.ok(!spawned2.includes('mannequin'), `2nd contract: no Mannequin spawned (${spawned2.join(', ')})`);
  step(`2nd contract spawned: ${spawned2.join(', ')}`);
  await backToVan(a);

  // the 3rd contract of the shift
  assert.equal(meta(a).shift.contract, 2, 'contract index 2 after the results');
  await drive(a);
  assert.ok(cards(a).includes('snatcher'), `3rd contract: the Snatcher card (cards ${cards(a).join(', ')})`);
  assert.equal(mannequinTitle(a), 'THE MANNEQUIN MOVES UNSEEN');
  step(`3rd contract (index 2), Risk 1: cards ${cards(a).join(', ')}`);
  const spawned3 = await contractMonsters(a);
  assert.ok(spawned3.includes('snatcher'), `3rd contract: the Snatcher spawned (${spawned3.join(', ')})`);
  assert.ok(spawned3.includes('mannequin'), `3rd contract: the Mannequin spawned (${spawned3.join(', ')})`);
  step(`3rd contract spawned: ${spawned3.join(', ')}`);
  console.log('DRIVE CARDS E2E PASS');
} catch (e) {
  code = 1;
  console.error('DRIVE CARDS E2E FAIL:', e instanceof Error ? (e.stack ?? e.message) : e);
} finally {
  a.close();
  await srv.close().catch(() => {});
  process.exitCode = code;
  setTimeout(() => process.exit(code), 300).unref();
}
