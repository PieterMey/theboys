// Owner: meta-records (v1.2). ws-bot test of the personnel-file recorder (no browser):
//   counters (recordStat, item events, deaths, the tick sampler) commit once per contract into PlayerSave.stats; first
//   finds go into PlayerSave.collection with a private 'meta.collection'; CrewSave.shiftStats + records persist; a
//   server restart keeps all of it and the HR memo still names every player of the shift; no transcript text in saves.
// Run: node tests/meta/stats.e2e.ts   (in-process server on a random port; temp SAVES_DIR + SESSION_FILE)
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bot } from './bot.ts';
import type { FullState } from '../../packages/shared/src/state.ts';
import type { MetaContractResults, MetaShiftReview } from '../../packages/shared/src/messages/meta.ts';
import type { CrewSave, PlayerSave } from '../../packages/shared/src/saves.ts';
import type { StatsReply } from '../../packages/shared/src/progress.ts';
import { stationOf } from '../../packages/shared/src/procgen/van.ts';
import { v12Id } from '../../packages/shared/src/catalog.ts';

const saves = mkdtempSync(join(tmpdir(), 'deadair-meta-stats-'));
process.env.SAVES_DIR = saves;
process.env.SESSION_FILE = join(saves, 'session.json');
process.env.NODE_ENV = 'development';
process.env.AI_MODE = 'mock';

const { boot } = await import('../../apps/server/src/core/boot.ts');
const { setQuiet } = await import('../../apps/server/src/core/log.ts');
const { emitUtterance } = await import('../../apps/server/src/ai/hub.ts');
const NAMES = ['net', 'level', 'players', 'voice', 'objectives', 'interaction', 'monsters', 'paranormal', 'meta', 'safes', 'fieldguide', 'ai'];
const tracks = await Promise.all(NAMES.map(async (n) => {
  const m = (await import(`../../apps/server/src/${n}/index.ts`)) as { install: (ctx: never) => unknown };
  return [n, m.install] as [string, (ctx: never) => unknown];
}));
if (!process.env.VERBOSE) setQuiet(true);
const start = () => boot({ mode: 'development', port: 0, tracks: tracks as never });

const t0 = performance.now();
const step = (s: string) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SECRET = 'xyzzy-plugh';

async function runContract(a: Bot, others: Bot[], during: () => Promise<void>, end: Record<string, unknown>): Promise<{ results: MetaContractResults; review: MetaShiftReview | null }> {
  const o = a.state!.workOrders.find((w) => w.available)!;
  await a.req('meta.pick', { orderId: o.id });
  const dr = a.nextPhase('drive');
  for (const b of [a, ...others]) await b.req('meta.ready', { ready: true });
  await dr;
  const ct = a.nextPhase('contract', 10_000);
  await a.req('dbg.meta.skipDrive');
  await ct;
  await sleep(150);
  await during();
  const rs = a.nextPhase('results');
  await a.req('dbg.meta.endContract', end);
  const st = ((await rs).d as { state: FullState }).state;
  return { results: st.meta.results!, review: st.meta.review ?? null };
}

async function continueToHub(a: Bot): Promise<void> {
  const hb = a.nextPhase('hub');
  await a.req('meta.continue');
  await hb;
}

let code = 0;
const bots: Bot[] = [];
let srv = await start();
try {
  const crew = 'STAT';
  const a = new Bot('Ann');
  const b = new Bot('Bob');
  bots.push(a, b);
  await a.join(`ws://127.0.0.1:${srv.port}/ws`, crew);
  await b.join(`ws://127.0.0.1:${srv.port}/ws`, crew);
  await sleep(150);
  const annSave = (await a.req<{ saveId: string }>('dbg.meta.stats')).saveId;
  const bobSave = (await b.req<{ saveId: string }>('dbg.meta.stats')).saveId;

  // ---------- the records board on the hub facade opens the personnel file (virtual station until env-layout's prop)
  {
    const L = a.state!.layout!;
    const st = stationOf(L, 'records');
    assert.ok(st, 'records station in the hub');
    let opened = false;
    for (const dz of [0.8, -0.8]) {
      await a.req('dbg.interaction.pose', { x: st!.p[0], z: st!.p[2] + dz });
      const open = a.next((e) => e.e === 'meta.open', 1500, 'meta.open stats').catch(() => null);
      await a.req('interaction.use', { id: v12Id('records', st!.itemId) }).catch(() => null);
      const ev = await open;
      if (ev && (ev.d as { screen: string }).screen === 'stats') { opened = true; break; }
    }
    assert.ok(opened, `E at ${v12Id('records', st!.itemId)} opens 'stats'`);
    step(`records board ok (${st!.itemId})`);
  }

  // ---------- contract 1: counters, finds, a death, a transcript that must never reach a save
  const { results: r1 } = await runContract(a, [b], async () => {
    await a.req('dbg.meta.stats', { record: { stepsCrept: 40, lootValue: 320, lootItems: 3, drawersSearched: 2, 'itemsUsed.bottle': 2, contracts: 99, bogus: 5 } });
    const col = a.next((e) => e.e === 'meta.collection', 3000, 'meta.collection');
    await a.req('dbg.meta.itemEvent', { kind: 'pickup', type: 'loot.small', name: 'Pocket watch', fresh: true });
    const ev = (await col).d as { key: string; label: string; total: number; of: number };
    assert.equal(ev.key, 'loot:Pocket watch');
    assert.equal(ev.label, 'Pocket watch');
    assert.ok(ev.total >= 1 && ev.of > 40, `collection ${ev.total}/${ev.of}`);
    await a.req('dbg.meta.itemEvent', { kind: 'pickup', type: 'loot.small', name: 'Pocket watch', fresh: true }); // second: no event
    await a.req('dbg.meta.itemEvent', { kind: 'pickup', type: 'badge', fresh: true }); // excluded
    await a.req('dbg.meta.itemEvent', { kind: 'pickup', type: 'loot.small', name: 'Tin of buttons', fresh: false }); // not fresh
    await b.req('dbg.meta.itemEvent', { kind: 'acquire', type: 'crowbar', via: 'handout' });
    const st = await a.req<{ phase: string }>('dbg.meta.stats');
    assert.equal(st.phase, 'contract');
    const crewObj = srv.ctx.crews.get(crew)!;
    emitUtterance(crewObj, {
      segId: 1, crew, speaker: a.me, speakerName: 'Ann', text: `meet me in the boiler room ${SECRET}`, norm: `meet me in the boiler room ${SECRET}`,
      lang: 'en', band: 2, room: null, roomId: -1, pos: [0, 0], startedAt: srv.ctx.now(), endedAt: srv.ctx.now(), radio: false, hearers: { players: [], listener: true, walkies: [] },
    } as never);
    await b.req('dbg.interaction.kill', { pid: b.me, killer: 'LISTENER', reason: 'grabbed you alone' });
    await sleep(100);
  }, { hauled: 320, coreExtracted: true });
  assert.equal(r1.players?.length, 2, 'a result line per player');
  const annLine = r1.players!.find((p) => p.player === a.me)!;
  assert.equal(annLine.hauled, 320);
  assert.ok(annLine.finds.includes('Pocket watch') && !annLine.finds.includes('Tin of buttons'), `finds ${annLine.finds.join(', ')}`);
  assert.equal(r1.players!.find((p) => p.player === b.me)!.deaths, 1);
  const sup = r1.superlatives ?? [];
  assert.ok(sup.length >= 1 && sup.length <= 3, `${sup.length} superlatives`);
  assert.equal(sup[0].title, 'EMPLOYEE OF THE CONTRACT');
  assert.equal(sup[0].player, a.me);
  assert.ok(sup.some((x) => x.title === 'FIRST TO VOLUNTEER' && x.player === b.me), 'first to die');
  step(`contract 1 ok: ${sup.map((x) => `${x.title}=${x.name} (${x.why})`).join(' · ')}`);
  await continueToHub(a);

  // ---------- contract 2: plain
  await runContract(a, [b], async () => {
    await b.req('dbg.meta.stats', { record: { lootValue: 140, lootItems: 1, revivesGiven: 1 } });
  }, { hauled: 140 });
  await continueToHub(a);
  await a.req('dbg.meta.flush');
  const annFile = JSON.parse(readFileSync(join(saves, 'players', `${annSave}.json`), 'utf8')) as PlayerSave;
  assert.equal(annFile.stats?.contracts, 2, 'contracts counted by meta (a recordStat of contracts is ignored)');
  assert.equal(annFile.stats?.stepsCrept, 40);
  assert.equal(annFile.stats?.drawersSearched, 2);
  assert.equal(annFile.stats?.lootValue, 320);
  assert.equal(annFile.stats?.bestHaul, 320);
  assert.equal(annFile.stats?.itemsUsed.bottle, 2);
  assert.equal(annFile.stats?.coresExtracted, 1);
  assert.equal(annFile.stats?.cleanStreak, 2);
  assert.equal(annFile.stats?.chatLines, 1, 'the line is counted');
  assert.ok(annFile.collection?.['loot:Pocket watch'], 'collection entry');
  assert.equal(annFile.collection?.['loot:Tin of buttons'], undefined, 'a non-fresh pickup is not a find');
  assert.equal((annFile as unknown as Record<string, unknown>).bogus, undefined);
  const bobFile = JSON.parse(readFileSync(join(saves, 'players', `${bobSave}.json`), 'utf8')) as PlayerSave;
  assert.equal(bobFile.stats?.deaths, 1);
  assert.equal(bobFile.stats?.killedBy.LISTENER, 1);
  assert.equal(bobFile.stats?.cleanStreak, 1, 'died in contract 1, survived contract 2');
  assert.ok(bobFile.collection?.crowbar, 'acquire counts as a find');
  const crewFile = JSON.parse(readFileSync(join(saves, 'crews', `${crew}.json`), 'utf8')) as CrewSave;
  assert.deepEqual(crewFile.shiftStats?.[annSave], { contracts: 2, survived: 2, deaths: 0, hauled: 320, revives: 0, crafted: 0, scrapped: 0 });
  assert.equal(crewFile.shiftStats?.[bobSave]?.deaths, 1);
  assert.equal(crewFile.shiftStats?.[bobSave]?.revives, 1);
  assert.equal(crewFile.records?.contracts, 2);
  assert.equal(crewFile.records?.cores, 1);
  assert.equal(crewFile.records?.bestHaul, 320);
  step('saves ok after 2 contracts');

  // ---------- restart: only Ann comes back; contract 3 ends the shift
  for (const x of bots) x.close();
  await sleep(200);
  await srv.close();
  srv = await start();
  const a2 = new Bot('Ann', a.key);
  bots.push(a2);
  await a2.join(`ws://127.0.0.1:${srv.port}/ws`, crew);
  await sleep(200);
  assert.equal(a2.state!.meta.shift.contract, 2, 'shift position restored');
  const mine = await a2.req<StatsReply>('meta.stats');
  assert.equal(mine.you?.saveId, annSave);
  assert.equal(mine.you?.stats.contracts, 2, 'stats survive the restart');
  assert.ok(mine.you?.collection['loot:Pocket watch'], 'collection survives the restart');
  assert.ok(mine.crews.some((c) => c.code === crew && c.members.length === 2 && c.records?.contracts === 2), 'crew records in the file');
  const bobsFile = await a2.req<StatsReply>('meta.stats', { saveId: bobSave });
  assert.equal(bobsFile.you?.name, 'Bob', "a crewmate's file");
  assert.ok(Object.values(bobsFile.you?.collection ?? {}).every((e) => e.crew === ''), 'crew codes stripped from a crewmate file');
  await assert.rejects(a2.req('meta.stats', { saveId: 'pNOBODY0000' }), /not in a crew/);
  const { review } = await runContract(a2, [], async () => {}, { hauled: 30 });
  assert.ok(review, 'shift review');
  const names = review!.memos.map((m) => m.name).sort();
  assert.deepEqual(names, ['Ann', 'Bob'], 'the memo names every player of the shift, present or not');
  step(`memo ok after restart: ${names.join(', ')} (${review!.verdict})`);
  await a2.req('dbg.meta.flush');
  const annAfter = JSON.parse(readFileSync(join(saves, 'players', `${annSave}.json`), 'utf8')) as PlayerSave;
  const bobAfter = JSON.parse(readFileSync(join(saves, 'players', `${bobSave}.json`), 'utf8')) as PlayerSave;
  assert.equal(annAfter.stats?.shifts, 1);
  assert.equal(bobAfter.stats?.shifts, 1, 'shift counted for the absent player too');
  assert.equal(annAfter.stats?.[review!.met ? 'quotasMet' : 'fired'], 1);

  // ---------- no transcript text anywhere in the saves
  const files: string[] = [];
  const walk = (d: string) => { for (const f of readdirSync(d, { withFileTypes: true })) f.isDirectory() ? walk(join(d, f.name)) : files.push(join(d, f.name)); };
  walk(saves);
  const leaks = files.filter((f) => readFileSync(f, 'utf8').includes(SECRET));
  assert.deepEqual(leaks, [], 'transcripts never reach a save');
  step(`no transcript text in ${files.length} save files`);
  console.log(`META STATS E2E PASS (${((performance.now() - t0) / 1000).toFixed(1)} s) saves=${saves}`);
} catch (e) {
  code = 1;
  console.error('META STATS E2E FAIL:', e instanceof Error ? (e.stack ?? e.message) : e);
} finally {
  for (const x of bots) x.close();
  await srv.close().catch(() => {});
  process.exitCode = code;
  setTimeout(() => process.exit(code), 800).unref();
}
