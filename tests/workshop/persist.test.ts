// Owner: workshop (v1.2). Persistence of the crew stash + van upgrades (CrewSave.stash / unlocks):
//   craftSave is null until loadCraft ran (meta then keeps the previous save's fields), the crew save carries them, a
//   restored crew gets them back, being fired wipes them (crafting.json firedWipes; the personnel file is untouched),
//   a promotion keeps them. Parts that need meta's (G4) wiring in flow.ts skip with a reason until it lands.
// Run: node --test tests/workshop/persist.test.ts   (boots the server in-process on PORT, default 3805, temp SAVES_DIR)
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Bot, bootServer, crewCode, sleep, tempSaves, toContract } from './lib.ts';
import type { Booted } from './lib.ts';
import type { Crew } from '../../apps/server/src/core/types.ts';
import type { CrewSave } from '../../packages/shared/src/saves.ts';

const REPO = join(import.meta.dirname, '../..');
const flowSrc = () => readFileSync(join(REPO, 'apps/server/src/meta/flow.ts'), 'utf8');
const wired = (hook: string) => flowSrc().includes(`${hook}(`);

const saves = tempSaves('persist');
let srv: Booted;
let url = '';
let a: Bot;
let crewId = '';
let W: typeof import('../../apps/server/src/meta/crafting.ts');
let flow: typeof import('../../apps/server/src/meta/flow.ts');
let metaApi: typeof import('../../apps/server/src/meta/api.ts');
const crew = (): Crew => srv.ctx.crews.get(crewId)!;
type St = { stash: Record<string, number> | null; unlocks: string[] | null };
const state = () => a.dbg<St>('workshop.state');
const savedCrew = (): CrewSave | null => {
  const p = join(saves, 'crews', `${crewId}.json`);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as CrewSave) : null;
};
const flush = async () => {
  await a.dbg('meta.flush');
  await sleep(50);
};

before(async () => {
  ({ srv, url } = await bootServer(saves));
  W = await import('../../apps/server/src/meta/crafting.ts');
  flow = await import('../../apps/server/src/meta/flow.ts');
  metaApi = await import('../../apps/server/src/meta/api.ts');
  crewId = crewCode('P');
  a = new Bot('Per');
  await a.connect(url, crewId);
  await sleep(400);
});

after(async () => {
  a?.close();
  await srv?.close().catch(() => {});
  setTimeout(() => process.exit(process.exitCode ?? 0), 1500).unref();
});

test('craftSave is null until loadCraft has run; loadCraft sanitises', () => {
  const fake = { code: 'QQQQ', phase: 'hub', players: new Map(), layout: null, slices: {}, createdAt: 0, tick: 0, emptySince: 0 } as unknown as Crew;
  assert.equal(W.craftSave(fake), null);
  assert.equal(W.craftView(fake), null);
  W.loadCraft(fake, { stash: { 'mat.scrap': 2, bogus: 5, 'mat.chem': -1, 'mat.relic': 1.6 } as Record<string, number>, unlocks: ['scanner', 'nope', 'scanner'] });
  assert.deepEqual(W.craftSave(fake), { stash: { 'mat.scrap': 2, 'mat.relic': 2 }, unlocks: ['scanner'] });
  W.loadCraft(fake, null);
  assert.deepEqual(W.craftSave(fake), { stash: {}, unlocks: [] });
});

test('the crew save carries stash + unlocks', async (t) => {
  if (!wired('craftSave')) return t.skip('meta saveCrew does not call craftSave yet (G4)');
  await a.dbg('workshop.give', { mats: { 'mat.wiring': 5, 'mat.optics': 2 } });
  await a.dbg('workshop.unlock', { id: 'scanner' });
  await flush();
  const sv = savedCrew();
  assert.ok(sv, 'crew save written');
  assert.equal(sv!.stash?.['mat.wiring'], 5);
  assert.equal(sv!.stash?.['mat.optics'], 2);
  assert.deepEqual(sv!.unlocks, ['scanner']);
});

test('craftSave null keeps the previous save (meta merges the old fields)', async (t) => {
  if (!wired('craftSave')) return t.skip('meta saveCrew does not call craftSave yet (G4)');
  const before = savedCrew();
  assert.ok(before?.stash && Object.keys(before.stash).length, 'a previous save with a stash');
  const c = crew();
  const mine = c.slices.workshop;
  delete c.slices.workshop; // inactive module: craftSave -> null
  try {
    assert.equal(W.craftSave(c), null);
    flow.saveCrew(c);
    await flush();
    const sv = savedCrew();
    assert.deepEqual(sv?.stash, before!.stash, 'stash kept');
    assert.deepEqual(sv?.unlocks, before!.unlocks, 'unlocks kept');
  } finally {
    c.slices.workshop = mine;
  }
});

test('a restored crew gets its stash + unlocks back (S() -> loadCraft)', async (t) => {
  if (!wired('loadCraft')) return t.skip('meta S() does not call loadCraft yet (G4)');
  await flush();
  const sv = savedCrew();
  const fresh = { code: crewId, phase: 'hub', players: new Map(), layout: null, slices: {}, createdAt: 0, tick: 0, emptySince: 0 } as unknown as Crew;
  flow.S(fresh);
  assert.deepEqual(W.craftView(fresh), { stash: sv?.stash ?? {}, unlocks: sv?.unlocks ?? [] });
});

/** play the shift's last contract to the HR memo, then continue as the leader */
async function endShift(hauled: number, quota: number): Promise<string | undefined> {
  await a.dbg('meta.shift', { contract: 2, hauled: 0, quota });
  await sleep(100);
  await toContract([a]);
  const res = a.waitPhase('results', 20_000);
  const end = await a.dbg<{ ok: boolean; results: { shiftEnd?: boolean } | null }>('meta.endContract', { outcome: 'extracted', hauled });
  await res;
  assert.ok(end.ok && end.results?.shiftEnd, 'the shift ended');
  await sleep(150);
  const verdict = a.meta?.review?.verdict;
  const hub = a.waitPhase('hub', 20_000);
  const r = await a.req<{ ok: boolean; reason?: string }>('meta.continue', {});
  assert.ok(r.ok, r.reason);
  await hub;
  await sleep(300);
  return verdict;
}

test('a promotion keeps the stash and the upgrades', async () => {
  await a.dbg('workshop.reset');
  await a.dbg('workshop.give', { mats: { 'mat.scrap': 7, 'mat.relic': 1 } });
  await a.dbg('workshop.unlock', { id: 'bench_tools' });
  const before = await state();
  const verdict = await endShift(80, 10);
  assert.equal(verdict, 'promoted');
  const now = await state();
  assert.deepEqual(now.stash, before.stash);
  assert.deepEqual(now.unlocks, before.unlocks);
});

test('being fired wipes the stash and the upgrades; the personnel file is untouched', async (t) => {
  await a.dbg('workshop.give', { mats: { 'mat.chem': 3 } });
  await a.dbg('workshop.unlock', { id: 'stretcher' });
  const sv0 = metaApi.playerSave(crew(), a.me);
  const file0 = sv0 ? JSON.stringify({ achievements: sv0.achievements, collection: sv0.collection ?? null, fieldGuide: sv0.fieldGuide ?? null, profile: sv0.profile }) : null;
  const xp0 = sv0?.xp ?? 0;
  const firedWired = wired('craftFired');
  const verdict = await endShift(0, 99999);
  assert.equal(verdict, 'fired');
  if (!firedWired) {
    t.diagnostic('meta continueFromResults does not call craftFired yet (G4): calling the hook directly');
    W.craftFired(crew());
  }
  const now = await state();
  assert.deepEqual(now.stash, {});
  assert.deepEqual(now.unlocks, []);
  const sv1 = metaApi.playerSave(crew(), a.me);
  assert.ok((sv1?.xp ?? 0) >= xp0, 'XP never taken away');
  if (file0 && sv1) {
    const f1 = JSON.parse(JSON.stringify({ achievements: sv1.achievements, collection: sv1.collection ?? null, fieldGuide: sv1.fieldGuide ?? null, profile: sv1.profile })) as Record<string, unknown>;
    const f0 = JSON.parse(file0) as Record<string, unknown>;
    // contract-end bookkeeping may add achievements/finds; the workshop never removes any
    for (const a0 of f0.achievements as string[]) assert.ok((f1.achievements as string[]).includes(a0), `achievement ${a0} kept`);
    assert.deepEqual(f1.profile, f0.profile, 'profile untouched');
  }
  if (wired('craftSave')) {
    await flush();
    const sv = savedCrew();
    assert.deepEqual(sv?.stash ?? {}, {}, 'the save is wiped too');
    assert.deepEqual(sv?.unlocks ?? [], []);
  }
});

test('firedWipes false keeps the stash (balance switch)', async () => {
  const bal = srv.ctx.balance.crafting as Record<string, unknown>;
  const prev = bal.firedWipes;
  try {
    await a.dbg('workshop.give', { mats: { 'mat.cells': 2 } });
    await a.dbg('workshop.unlock', { id: 'scanner' });
    bal.firedWipes = false;
    W.craftFired(crew());
    const now = await state();
    assert.equal(now.stash?.['mat.cells'], 2);
    assert.deepEqual(now.unlocks, ['scanner']);
  } finally {
    bal.firedWipes = prev;
  }
});
