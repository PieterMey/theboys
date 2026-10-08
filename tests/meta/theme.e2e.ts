// Owner: meta-records (v1.2). Site themes through meta (no browser):
//   makeBoard stamps order.siteTheme from the template site; the drive's facility is generated with {theme, modifiers}
//   (layout.theme reaches the generator); flags.siteThemes=false makes every site 'facility'; a themed site whose
//   modifiers make generation throw falls back to the same theme without modifiers, then to the plain facility.
// Run: node tests/meta/theme.e2e.ts   (in-process server on a random port; temp SAVES_DIR + SESSION_FILE)
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bot } from './bot.ts';
import type { FullState } from '../../packages/shared/src/state.ts';
import type { WorkOrder } from '../../packages/shared/src/workorder.ts';
import { siteThemeOf } from '../../packages/shared/src/procgen/themes.ts';
import { SITES } from '../../apps/server/src/meta/templates.ts';
import { makeBoard } from '../../apps/server/src/meta/orders.ts';

const saves = mkdtempSync(join(tmpdir(), 'deadair-meta-theme-'));
process.env.SAVES_DIR = saves;
process.env.SESSION_FILE = join(saves, 'session.json');
process.env.NODE_ENV = 'development';
process.env.AI_MODE = 'mock';

// every template site has a theme (the board would stamp 'facility' otherwise)
for (const s of SITES) assert.ok(siteThemeOf(s.name), `theme for ${s.name}`);
const board = makeBoard({
  crewCode: 'THME', shiftIndex: 0, contract: 0, boardSeq: 1, players: 2, avgLevel: 1, achievements: [], payoutMult: { 1: 1, 2: 1.4 },
  riskLootMult: { 1: 1, 2: 1.4 }, playerMult: 0.75, lootBudgetBase: 950, risk2MinAvgLevel: 2, risk2Achievement: 'Core Business', recentSites: [],
});
for (const o of board) assert.equal(o.siteTheme, siteThemeOf(o.siteName), `stamped ${o.siteName}`);

const { boot } = await import('../../apps/server/src/core/boot.ts');
const { setQuiet } = await import('../../apps/server/src/core/log.ts');
const A = await import('../../apps/server/src/meta/adapters.ts');
const NAMES = ['net', 'level', 'players', 'voice', 'objectives', 'interaction', 'monsters', 'paranormal', 'meta', 'safes', 'fieldguide', 'ai'];
const tracks = await Promise.all(NAMES.map(async (n) => {
  const m = (await import(`../../apps/server/src/${n}/index.ts`)) as { install: (ctx: never) => unknown };
  return [n, m.install] as [string, (ctx: never) => unknown];
}));
if (!process.env.VERBOSE) setQuiet(true);
const srv = await boot({ mode: 'development', port: 0, tracks: tracks as never });
const url = `ws://127.0.0.1:${srv.port}/ws`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function play(a: Bot, pick: (o: WorkOrder[]) => WorkOrder): Promise<{ order: WorkOrder; theme: string; metrics: Record<string, number> }> {
  const o = pick(a.state!.workOrders);
  await a.req('meta.pick', { orderId: o.id });
  const dr = a.nextPhase('drive');
  await a.req('meta.ready', { ready: true });
  await dr;
  const ct = a.nextPhase('contract', 15_000);
  await a.req('dbg.meta.skipDrive');
  const L = ((await ct).d as { state: FullState }).state.layout!;
  const rs = a.nextPhase('results');
  await a.req('dbg.meta.endContract', { hauled: 0 });
  await rs;
  const hb = a.nextPhase('hub');
  await a.req('meta.continue');
  await hb;
  return { order: o, theme: L.theme, metrics: (L.metrics ?? {}) as Record<string, number> };
}

let code = 0;
const bots: Bot[] = [];
try {
  const a = new Bot('Ann');
  bots.push(a);
  await a.join(url, 'THME');
  await sleep(150);
  for (const o of a.state!.workOrders) assert.equal(o.siteTheme, siteThemeOf(o.siteName) ?? 'facility', `board order ${o.siteName}`);

  // 1. the theme reaches the generator
  const r1 = await play(a, (os) => os.find((o) => o.available && o.siteTheme !== 'facility') ?? os[0]);
  console.log(`themed: ${r1.order.siteName} -> order ${r1.order.siteTheme} -> layout ${r1.theme} (mods ${r1.order.modifiers.join(', ')}; metrics ${Object.keys(r1.metrics).filter((k) => k.startsWith('mod:')).join(', ') || 'none'})`);
  assert.equal(r1.theme, r1.order.siteTheme, 'layout.theme = order.siteTheme');

  // 2. flags.siteThemes off: every site is a facility
  srv.ctx.flags.siteThemes = false;
  const r2 = await play(a, (os) => os.find((o) => o.available)!);
  assert.equal(r2.theme, 'facility', 'flag off -> facility');
  srv.ctx.flags.siteThemes = true;
  console.log(`flag off: ${r2.order.siteName} -> ${r2.theme}`);

  // 3. a generator that fails on modifiers: same theme without modifiers, then the plain facility
  const real = A.mods.level!;
  const seen: string[] = [];
  A.mods.level = {
    ...real,
    generateFacilityForCrew: (crew: unknown, p: { theme?: string; modifiers?: readonly string[] }) => {
      seen.push(`${p.theme ?? '-'}/${p.modifiers?.length ?? 0}`);
      if (p.modifiers?.length) throw new Error('GenFail rooms:12 (test)');
      return (real.generateFacilityForCrew as (c: unknown, q: unknown) => unknown)(crew, p);
    },
  };
  const crewObj = srv.ctx.crews.get('THME')!;
  const L3 = A.generateFacilityLayout(crewObj as never, { seed: 'THME-fallback-1', players: 4, risk: 1, theme: 'cold_storage', modifiers: ['COLD', 'LONG CORRIDORS'] });
  assert.equal(L3.kind, 'facility');
  assert.equal(L3.theme, 'cold_storage', 'fallback keeps the theme');
  assert.deepEqual(seen, ['cold_storage/2', 'cold_storage/0']);
  A.mods.level = { ...real, generateFacilityForCrew: () => { throw new Error('GenFail (test)'); } };
  const L4 = A.generateFacilityLayout(crewObj as never, { seed: 'THME-fallback-2', players: 4, risk: 1, theme: 'cold_storage', modifiers: ['LONG CORRIDORS'] });
  assert.equal(L4.kind, 'facility', 'plain shared facility as the last resort');
  A.mods.level = real;
  console.log(`fallback ok: ${seen.join(' -> ')} -> shared ${L4.theme}`);
  console.log('META THEME E2E PASS');
} catch (e) {
  code = 1;
  console.error('META THEME E2E FAIL:', e instanceof Error ? (e.stack ?? e.message) : e);
} finally {
  for (const x of bots) x.close();
  await srv.close().catch(() => {});
  process.exitCode = code;
  setTimeout(() => process.exit(code), 800).unref();
}
