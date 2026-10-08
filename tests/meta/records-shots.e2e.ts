// Owner: meta-records (v1.2). Reviewed screenshots of the personnel file and the v1.2 results (real Chrome):
//   main-menu 'Personnel file' (GET /api/stats), results (lines, superlatives, NEW FINDS, STASH +N), the pause 'Record'
//   tab, the records-board 'stats' screen, the board's theme chips, the hub HUD (stash chips, hints) and the drive
//   screen with the Snatcher card. ws bots play the contract; the browser joins as Ann during the results.
// 1) seed (no browser):  node tests/meta/records-shots.e2e.ts --seed <dir>
// 2) server (outside the GPU guard): PORT=3804 SAVES_DIR=<dir> SESSION_FILE=<dir>/session.json NODE_ENV=development
//      AI_MODE=mock node apps/server/src/index.ts --dev
// 3) shots: SEED_DIR=<dir> node tools/gpu-guard.mjs --max-sec 120 -- node tests/meta/records-shots.e2e.ts [--gpu]
//    (default lane: SwiftShader WebGL2, preset low; --gpu = the real WebGPU renderer). Screenshots: tests/artifacts/meta
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchPlayer } from '../lib/launch.ts';
import type { Player } from '../lib/launch.ts';
import { Bot } from './bot.ts';
import { OUT, freezeVite, shot, sleep } from './lib.ts';
import { emptyStats } from '../../packages/shared/src/progress.ts';
import type { PlayerStatsV1 } from '../../packages/shared/src/progress.ts';
import type { CrewSave, PlayerSave } from '../../packages/shared/src/saves.ts';
import type { Profile } from '../../packages/shared/src/profile.ts';
import { collectionCatalog } from '../../packages/shared/src/messages/meta.ts';
import { playerIdFromKey } from '../../apps/server/src/core/crews.ts';
import { hashPin } from '../../apps/server/src/meta/saves.ts';

const CREW = 'SHOT';
interface Keys { ann: string; bob: string; cat: string; annProfile: Profile; bobProfile: Profile; catProfile: Profile }

// ---------------------------------------------------------------- 1) seed
const seedAt = process.argv.indexOf('--seed');
if (seedAt >= 0) {
  const dir = process.argv[seedAt + 1];
  if (!dir) throw new Error('--seed <dir>');
  mkdirSync(join(dir, 'players'), { recursive: true });
  mkdirSync(join(dir, 'crews'), { recursive: true });
  const keys: Keys = {
    ann: 'shot-ann-0000000000000000000000001', bob: 'shot-bob-0000000000000000000000002', cat: 'shot-cat-0000000000000000000000003',
    annProfile: { name: 'Ann', body: 'f', suit: ['#d4a017', '#2c3e50'], helmet: 'box', visor: { glyphs: 'ANN', color: '#7dfcff' }, badge: 417 },
    bobProfile: { name: 'Bob', body: 'm', suit: ['#c0392b', '#7f8c8d'], helmet: 'dome', visor: { glyphs: 'B', color: '#ff4d4d' }, badge: 233 },
    catProfile: { name: 'Cat', body: 'f', suit: ['#27ae60', '#ecf0f1'], helmet: 'dome', visor: { glyphs: 'CAT', color: '#9dff6b' }, badge: 871 },
  };
  const t = (d: number) => new Date(Date.now() - d * 86400_000).toISOString();
  const stats = (o: Partial<PlayerStatsV1>): PlayerStatsV1 => ({ ...emptyStats(t(9)), ...o, lastAt: t(0) });
  const cat = collectionCatalog();
  const col: PlayerSave['collection'] = {};
  const sites = ['Halvorsen Cold Storage', 'St. Brannock Infirmary, East Wing', 'Lowmoor Pumping Station No. 4', 'Mercer & Pell Records Depository'];
  cat.forEach((d, i) => { if (i % 3 !== 2 && d.group !== 'idol') col[d.key] = { at: t(9 - (i % 9)), site: sites[i % sites.length], crew: i % 2 ? CREW : 'NITE' }; });
  const save = (key: string, p: Profile, xp: number, level: number, achievements: string[], st: PlayerStatsV1, collection: PlayerSave['collection']): PlayerSave => ({
    id: playerIdFromKey(key), keys: [key], name: p.name, pinHash: hashPin(playerIdFromKey(key), '1234'), profile: p, xp, level, achievements,
    createdAt: t(9), updatedAt: t(0), stats: st, collection, loadout: ['medkit', 'crowbar'],
  });
  const ann = save(keys.ann, keys.annProfile, 1310, 5, ['Core Business', 'Field Medic', 'Ghost', 'Night Shift'], stats({
    contracts: 27, extracted: 21, wipes: 2, survived: 22, deaths: 5, leftBehind: 1, shifts: 8, quotasMet: 7, fired: 1, timeOnSiteSec: 21_640,
    distanceM: 14_230, sprintM: 2_180, crouchM: 1_342, crouchSec: 3_120, hiddenSec: 410, flashlightSec: 9_800, nvSec: 220, stepsCrept: 2_450,
    stepsWalked: 9_120, stepsSprinted: 1_610, ductsCrawled: 4, lootItems: 96, lootValue: 8_740, bestHaul: 1_240, heavyItems: 7, idols: 1, curios: 4,
    coresExtracted: 3, safesCracked: 2, materials: 31, scrapped: 6, crafted: 9, scripSpent: 640, drawersSearched: 58, doorsEased: 41, pagesFiled: 6,
    phenomenaSeen: 9, revivesGiven: 11, revivedTimes: 3, badgesFiled: 2, rescues: 3, killedBy: { HOUND: 2, LISTENER: 2, 'LEFT BEHIND': 1 },
    houndAlerts: 14, grabbed: 3, knockdowns: 2, snatched: 1, escapes: 3, listenerUsedYourWords: 4, itemsUsed: { bottle: 18, glowstick: 22, medkit: 6, flare: 5 },
    crowbarSwings: 12, crowbarHits: 5, doorsOpened: 233, radioSec: 1_420, screams: 3, chatLines: 512, cleanStreak: 4, bestCleanStreak: 9,
  }), col);
  const bob = save(keys.bob, keys.bobProfile, 640, 3, ['Core Business'], stats({ contracts: 12, survived: 7, deaths: 5, lootValue: 3_120, bestHaul: 700, killedBy: { HOUND: 3, MANNEQUIN: 2 } }), {});
  const cat2 = save(keys.cat, keys.catProfile, 420, 3, [], stats({ contracts: 9, survived: 8, deaths: 1, lootValue: 2_010, revivesGiven: 4, killedBy: { SNATCHER: 1 } }), {});
  for (const s of [ann, bob, cat2]) writeFileSync(join(dir, 'players', `${s.id}.json`), JSON.stringify(s, null, 2));
  const crew: CrewSave = {
    code: CREW, members: [bob.id, cat2.id, ann.id],
    shift: { index: 1, contract: 1, quota: 655, hauled: 410, balance: 520, gear: {}, quotasMet: 1 },
    history: [], updatedAt: t(0),
    shiftStats: { [ann.id]: { contracts: 1, survived: 1, deaths: 0, hauled: 300, revives: 1, crafted: 2, scrapped: 1 }, [bob.id]: { contracts: 1, survived: 0, deaths: 1, hauled: 110, revives: 0, crafted: 0, scrapped: 0 } },
    records: { bestHaul: 1_240, bestHaulSite: 'Halvorsen Cold Storage', bestHaulAt: t(3), quotaStreak: 1, bestQuotaStreak: 2, cores: 3, contracts: 11, wipes: 1 },
    stash: { 'mat.scrap': 6, 'mat.wiring': 3, 'mat.optics': 1, 'mat.cells': 2 }, unlocks: ['bench_tools'],
  };
  const nite: CrewSave = {
    code: 'NITE', members: [ann.id], shift: { index: 0, contract: 0, quota: 300, hauled: 0, balance: 150, gear: {}, quotasMet: 0 }, history: [], updatedAt: t(5),
    records: { bestHaul: 860, bestHaulSite: 'Varga Brothers Foundry', bestHaulAt: t(6), quotaStreak: 0, bestQuotaStreak: 1, cores: 1, contracts: 6, wipes: 1 },
  };
  writeFileSync(join(dir, 'crews', `${CREW}.json`), JSON.stringify(crew, null, 2));
  writeFileSync(join(dir, 'crews', 'NITE.json'), JSON.stringify(nite, null, 2));
  writeFileSync(join(dir, 'shot-keys.json'), JSON.stringify(keys, null, 2));
  console.log(`seeded ${dir}: ann ${ann.id}, bob ${bob.id}, cat ${cat2.id}`);
  process.exit(0);
}

// ---------------------------------------------------------------- 3) shots
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3804';
const WS = BASE.replace(/^http/, 'ws') + '/ws';
const keys = JSON.parse(readFileSync(join(process.env.SEED_DIR ?? '', 'shot-keys.json'), 'utf8')) as Keys;
const GPU = process.argv.includes('--gpu');
const lane = GPU ? 'gpu' : 'sw';
mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const step = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
type W = { __meta?: { open(n: string, p?: unknown): void; close(): void; screen(): string }; __game?: { state(): { phase: string; net: string } } };

let player: Player | null = null;
const failed: string[] = [];
/** one screenshot group: a failure is logged (plus a shot of the page) and the run goes on */
async function attempt(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    step(`${name} ok`);
  } catch (e) {
    failed.push(name);
    console.error(`${name} FAILED: ${e instanceof Error ? e.message.split(/\r?\n/)[0] : e}`);
    if (player) await shot(player.page, `shots-fail-${name}-${lane}`).catch(() => {});
  }
}
const bots: Bot[] = [];
let code = 0;
try {
  player = await launchPlayer({
    name: 'Ann', baseUrl: BASE, crew: CREW, webgl: !GPU, viewport: { width: 1440, height: 900 },
    query: { preset: 'low', nobright: '1' },
    extraArgs: GPU ? [] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-gl=angle'],
  });
  const page = player.page;
  await page.addInitScript((k: { key: string; profile: unknown }) => {
    try {
      localStorage.setItem('deadair.key', k.key);
      localStorage.setItem('deadair.profile', JSON.stringify(k.profile));
      localStorage.setItem('deadair.meta.settings', JSON.stringify({ brightnessDone: true, hints: true }));
    } catch { /* ignore */ }
  }, { key: keys.ann, profile: keys.annProfile });
  await freezeVite(page);
  // ---- main menu: Personnel file (before joining)
  await attempt('menu', async () => {
  await page.waitForSelector('[data-testid="menu-file"]', { timeout: 45_000 });
  await page.click('[data-testid="menu-file"]');
  await page.waitForSelector('[data-testid="personnel-file"][data-save]', { timeout: 15_000 });
  await sleep(700);
  await shot(page, `pf-menu-${lane}`);
  await page.evaluate(() => { const b = document.querySelector('.mm-panel-body'); if (b) b.scrollTop = 1100; });
  await sleep(300);
  await shot(page, `pf-menu-collection-${lane}`);
  });

  // ---- ws bots play one contract (Bob leads); the browser joins as Ann during the results
  const bob = new Bot('Bob', keys.bob, keys.bobProfile);
  const cat = new Bot('Cat', keys.cat, keys.catProfile);
  const annBot = new Bot('Ann', keys.ann, keys.annProfile);
  bots.push(bob, cat, annBot);
  await bob.join(WS, CREW);
  await cat.join(WS, CREW);
  await annBot.join(WS, CREW);
  await sleep(300);
  const o = bob.state!.workOrders.find((w) => w.available)!;
  await bob.req('meta.pick', { orderId: o.id });
  const dr = bob.nextPhase('drive');
  for (const b of bots) await b.req('meta.ready', { ready: true });
  await dr;
  const ct = bob.nextPhase('contract', 15_000);
  await bob.req('dbg.meta.skipDrive');
  await ct;
  await sleep(300);
  await annBot.req('dbg.meta.stats', { record: { lootValue: 520, lootItems: 5, crouchM: 12, drawersSearched: 3 } });
  await bob.req('dbg.meta.stats', { record: { crouchM: 86, lootValue: 120, lootItems: 1 } });
  await cat.req('dbg.meta.stats', { record: { revivesGiven: 2, scrapped: 1, lootValue: 60, lootItems: 1 } });
  await annBot.req('dbg.meta.itemEvent', { kind: 'pickup', type: 'loot.heavy', name: 'Cryo canister', fresh: true });
  await cat.req('dbg.meta.itemEvent', { kind: 'pickup', type: 'loot.small', name: 'Gas mask', fresh: true });
  await cat.req('dbg.meta.itemEvent', { kind: 'pickup', type: 'loot.curio', name: 'Porcelain doll', fresh: true });
  await bob.req('dbg.interaction.kill', { pid: bob.me, killer: 'LISTENER', reason: 'grabbed you alone in COLDROOM' });
  await cat.req('dbg.interaction.give', { type: 'mat.wiring', count: 2 });
  await cat.req('dbg.interaction.give', { type: 'mat.chem', count: 1 });
  const L = bob.state!.layout!;
  await cat.req('dbg.interaction.pose', { x: L.van.cab.x + L.van.cab.w / 2, z: L.van.cab.y + L.van.cab.h / 2 });
  const rs = bob.nextPhase('results');
  await bob.req('dbg.meta.endContract', { hauled: 700, lootTotal: 1650, coreExtracted: true });
  await rs;
  step('bots played contract 2 -> results');

  // ---- browser joins as Ann (replaces the bot's socket)
  await page.goto(`${BASE}/?test=1&autojoin=1&nobright=1&preset=low${GPU ? '' : '&webgl=1'}#${CREW}`, { waitUntil: 'domcontentloaded' });
  await attempt('results', async () => {
  await page.waitForFunction(() => (window as unknown as W).__meta?.screen() === 'results', undefined, { timeout: 40_000, polling: 250 });
  await page.waitForSelector('[data-testid="results-crew"]', { timeout: 25_000, state: 'attached' });
  await sleep(2500);
  await shot(page, `results-v12-${lane}`);
  await page.evaluate(() => { const s = document.querySelector('.m-screen'); if (s) s.scrollTop = 99999; });
  await sleep(400);
  await shot(page, `results-v12-report-${lane}`);
  });

  // ---- back to the van: Record tab, stats screen, board, HUD
  const hub = bob.nextPhase('hub');
  await bob.req('meta.continue');
  await hub;
  await attempt('record', async () => {
  await page.waitForFunction(() => (window as unknown as W).__game?.state().phase === 'hub', undefined, { timeout: 25_000, polling: 250 });
  await sleep(1500);
  await page.evaluate(() => (window as unknown as W).__meta!.open('menu', { tab: 'record' }));
  await page.waitForSelector('.m-pf-tab [data-testid="personnel-file"][data-save]', { timeout: 20_000, state: 'attached' });
  await sleep(600);
  await shot(page, `pf-record-${lane}`);
  });
  await attempt('stats', async () => {
  await page.evaluate(() => (window as unknown as W).__meta!.open('stats'));
  await page.waitForSelector('.m-pf-screen [data-testid="personnel-file"][data-save]', { timeout: 20_000, state: 'attached' });
  await sleep(600);
  await shot(page, `pf-stats-${lane}`);
  await page.evaluate(() => { const s = document.querySelector('.m-pf-screen'); if (s) s.scrollTop = 1500; });
  await sleep(300);
  await shot(page, `pf-stats-collection-${lane}`);
  });
  await attempt('board', async () => {
  await page.evaluate(() => (window as unknown as W).__meta!.open('board'));
  await sleep(800);
  await shot(page, `board-themes-${lane}`);
  await page.evaluate(() => (window as unknown as W).__meta!.close());
  await sleep(1200);
  await shot(page, `hub-hud-${lane}`);
  });

  // ---- drive: 4 rule cards (contract 2+ of the shift: the Snatcher can appear)
  const o2 = bob.state!.workOrders.find((w) => w.available)!;
  const dr2 = bob.nextPhase('drive');
  await bob.req('meta.drive', { orderId: o2.id });
  await dr2;
  await bob.req('dbg.meta.driveFor', { sec: 90 });
  await attempt('drive', async () => {
  await page.waitForFunction(() => (window as unknown as W).__meta?.screen() === 'drive', undefined, { timeout: 20_000, polling: 250 });
  await sleep(2600);
  await shot(page, `drive-rules-${lane}`);
  });
  if (failed.length) code = 1;
  const errs = player.errors.filter((e) => !/favicon|ERR_ABORTED|WebSocket/i.test(e));
  step(`page errors: ${errs.length ? errs.slice(0, 6).join(' | ') : 'none'}`);
  console.log(`META RECORDS SHOTS DONE${failed.length ? ` (failed: ${failed.join(', ')})` : ''}`);
} catch (e) {
  code = 1;
  console.error('META RECORDS SHOTS FAIL:', e instanceof Error ? (e.stack ?? e.message) : e);
  if (player) await shot(player.page, `shots-fail-${lane}`).catch(() => {});
} finally {
  for (const b of bots) b.close();
  await player?.close().catch(() => {});
  process.exitCode = code;
  setTimeout(() => process.exit(code), 500).unref();
}
