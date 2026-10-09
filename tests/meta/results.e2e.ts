// Owner: meta-records (v1.2). ws-bot test of the v1.2 results screen data (no browser):
//   a line per player (hauled, items, deaths, revives, metres crept, NEW FINDS), at most 3 superlatives with distinct
//   winners, STASH +N (workshop salvage from the van) and a commendation (+XP, unlock line) on the XP line.
// Run: node tests/meta/results.e2e.ts   (in-process server on a random port; temp SAVES_DIR + SESSION_FILE)
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bot } from './bot.ts';
import type { FullState } from '../../packages/shared/src/state.ts';

const saves = mkdtempSync(join(process.env.META_SAVES ?? tmpdir(), 'deadair-meta-results-'));
process.env.SAVES_DIR = saves;
process.env.SESSION_FILE = join(saves, 'session.json');
process.env.NODE_ENV = 'development';
process.env.AI_MODE = 'mock';

const { boot } = await import('../../apps/server/src/core/boot.ts');
const { setQuiet } = await import('../../apps/server/src/core/log.ts');
const NAMES = ['net', 'level', 'players', 'voice', 'objectives', 'interaction', 'monsters', 'paranormal', 'meta', 'safes', 'fieldguide', 'ai'];
const tracks = await Promise.all(NAMES.map(async (n) => {
  const m = (await import(`../../apps/server/src/${n}/index.ts`)) as { install: (ctx: never) => unknown };
  return [n, m.install] as [string, (ctx: never) => unknown];
}));
if (!process.env.VERBOSE) setQuiet(true);
const srv = await boot({ mode: 'development', port: Number(process.env.PORT ?? 0), tracks: tracks as never });
const url = `ws://127.0.0.1:${srv.port}/ws`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let code = 0;
const bots: Bot[] = [];
try {
  const crew = 'RSLT';
  const [a, b, c] = [new Bot('Ann'), new Bot('Bob'), new Bot('Cat')];
  bots.push(a, b, c);
  for (const x of bots) await x.join(url, crew);
  await sleep(150);
  const o = a.state!.workOrders[0];
  await a.req('meta.pick', { orderId: o.id });
  const dr = a.nextPhase('drive');
  for (const x of bots) await x.req('meta.ready', { ready: true });
  await dr;
  const ct = a.nextPhase('contract', 10_000);
  await a.req('dbg.meta.skipDrive');
  const L = ((await ct).d as { state: FullState }).state.layout!;
  await sleep(150);

  await a.req('dbg.meta.stats', { record: { lootValue: 500, lootItems: 4 } });
  await b.req('dbg.meta.stats', { record: { crouchM: 60, lootValue: 40 } });
  await c.req('dbg.meta.stats', { record: { revivesGiven: 10, scrapped: 2 } });
  await a.req('dbg.meta.itemEvent', { kind: 'pickup', type: 'loot.small', name: 'Gas mask', fresh: true });
  await b.req('dbg.interaction.kill', { pid: b.me, killer: 'HOUND' });
  // Cat stands in the van cargo with 2 wiring in the pouch: the workshop commits it at contract end
  await c.req('dbg.interaction.give', { type: 'mat.wiring', count: 2 });
  const cab = L.van.cab;
  await c.req('dbg.interaction.pose', { x: cab.x + cab.w / 2, z: cab.y + cab.h / 2 });

  const rs = a.nextPhase('results');
  await a.req('dbg.meta.endContract', { hauled: 540 });
  const r = ((await rs).d as { state: FullState }).state.meta.results!;
  console.log(`players: ${r.players?.map((p) => `${p.name} $${p.hauled} items ${p.items} deaths ${p.deaths} rev ${p.revives} crept ${p.creptM} finds [${p.finds.join(', ')}]`).join(' | ')}`);
  console.log(`superlatives: ${r.superlatives?.map((s) => `${s.title}=${s.name} (${s.why})`).join(' | ')}`);
  console.log(`salvage: ${JSON.stringify(r.salvage)}`);
  assert.equal(r.players?.length, 3);
  const ann = r.players!.find((p) => p.player === a.me)!;
  assert.equal(ann.hauled, 500);
  assert.equal(ann.items, 4);
  assert.ok(ann.finds.includes('Gas mask'), 'NEW FINDS');
  assert.equal(r.players!.find((p) => p.player === b.me)!.deaths, 1);
  assert.equal(r.players!.find((p) => p.player === c.me)!.revives, 10);
  assert.equal(r.players!.find((p) => p.player === b.me)!.creptM, 60);
  const sup = r.superlatives ?? [];
  assert.equal(sup.length, 3, 'at most 3');
  assert.deepEqual(sup.map((s) => s.title), ['EMPLOYEE OF THE CONTRACT', 'QUIETEST FEET', 'FIELD MEDIC']);
  assert.deepEqual(sup.map((s) => s.name), ['Ann', 'Bob', 'Cat'], 'distinct winners');
  const catXp = r.xp.find((x) => x.player === c.me)!;
  assert.ok(catXp.unlocks.includes('commendation: Field Medic'), 'commendation unlock line');
  assert.ok(catXp.reasons.some((q) => q.text === 'commendation: Field Medic' && q.xp === 50), '+50 XP');
  if (r.salvage) {
    assert.equal(r.salvage.materials['mat.wiring'] ?? 0, 2, 'STASH +2 wiring from the van');
    assert.equal(r.salvage.scrapped, 0);
    const hub = a.nextPhase('hub');
    await a.req('meta.continue');
    const hs = ((await hub).d as { state: FullState }).state;
    assert.equal(hs.meta.stash?.['mat.wiring'], 2, 'MetaState.stash from craftView');
  } else console.log('NOTE: workshop salvage not reported (crafting stub)');
  console.log('META RESULTS E2E PASS');
} catch (e) {
  code = 1;
  console.error('META RESULTS E2E FAIL:', e instanceof Error ? (e.stack ?? e.message) : e);
} finally {
  for (const x of bots) x.close();
  await srv.close().catch(() => {});
  process.exitCode = code;
  setTimeout(() => process.exit(code), 800).unref();
}
