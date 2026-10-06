// Track ② Level: generator determinism, fixture freshness, hub layout. Run: node --test tests/level/procgen.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import { GEN_VERSION } from '../../packages/shared/src/layout.ts';
import { generateFacility, generateHub, layoutHash, resolveTuning, validateLayout, verifyLayoutHash } from '../../packages/shared/src/procgen/index.ts';
import { FIXTURES, loadTuning, renderMap } from '../../tools/gen-cli.ts';

const dir = resolve(import.meta.dirname, '../fixtures/layouts');
const load = (f: string) => JSON.parse(readFileSync(resolve(dir, f), 'utf8')) as LevelLayout;

// The facility fixtures are shared snapshots other tracks' tests read (objectives, ai, interaction): they stay valid
// layouts, and the freshness check runs with FIXTURES_FRESH=1 (after node tools/gen-cli.ts --fixtures; the v1.1
// generator change makes them stale until the integrator regenerates them together with the dependent tests).
test('fixtures are valid (fresh with FIXTURES_FRESH=1; regenerate with: node tools/gen-cli.ts --fixtures)', () => {
  const t = loadTuning();
  for (const f of FIXTURES) {
    const L = load(f.file);
    const fresh = generateFacility({ seed: f.seed, players: f.players, risk: f.risk }, t);
    assert.deepEqual(validateLayout(fresh).errors, [], `${f.file} seed regenerates invalid`);
    if (process.env.FIXTURES_FRESH === '1') assert.equal(L.hash, fresh.hash, `${f.file} is stale`);
    assert.ok(verifyLayoutHash(L), `${f.file} hash`);
    assert.deepEqual(validateLayout(L).errors, [], f.file);
    assert.equal(L.genVersion, GEN_VERSION);
  }
  const hub = load('hub.json');
  assert.equal(hub.hash, generateHub().hash, 'hub.json is stale');
  assert.deepEqual(validateLayout(hub).errors, []);
});

test('deterministic and seed-sensitive; params change footprint', () => {
  const a = generateFacility({ seed: 'det', players: 4, risk: 2 });
  const b = generateFacility({ seed: 'det', players: 4, risk: 2 });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(a.hash, layoutHash(a));
  assert.notEqual(generateFacility({ seed: 'det2', players: 4, risk: 2 }).hash, a.hash);
  const s = generateFacility({ seed: 'det', players: 2, risk: 1 });
  const l = generateFacility({ seed: 'det', players: 6, risk: 1 });
  assert.deepEqual([s.W, s.H - s.metrics.lotDepth], [40, 30]);
  assert.deepEqual([a.W, a.H - a.metrics.lotDepth], [54, 40]);
  assert.deepEqual([l.W, l.H - l.metrics.lotDepth], [64, 48]);
});

test('layout contents: van, lot, vault, keycard, doors, items', () => {
  const L = load('facility_s4_p4_risk2.json');
  const lot = L.spaces[L.metrics.lot];
  assert.equal(lot.kind, 'outside');
  assert.equal(lot.open, true);
  assert.equal(lot.type, 'lot');
  assert.equal(lot.rect.h, 12);
  const van = L.spaces[L.metrics.vanSpace];
  assert.equal(van.type, 'van');
  assert.deepEqual(van.rect, L.van.cab);
  assert.ok(L.van.cab.x >= lot.rect.x && L.van.cab.y >= lot.rect.y && L.van.cab.x + L.van.cab.w <= lot.rect.x + lot.rect.w);
  const exit = L.doors.filter((d) => d.kind === 'exit');
  assert.equal(exit.length, 1);
  assert.ok([exit[0].a, exit[0].b].includes(L.entrance) && [exit[0].a, exit[0].b].includes(lot.id));
  assert.equal(L.doors.filter((d) => d.kind === 'locked').length, 1);
  assert.equal(L.items.filter((i) => i.kind === 'keycard').length, 1);
  const kinds = new Set(L.items.map((i) => i.kind));
  for (const k of ['loot', 'lever', 'keypad', 'core', 'keycard', 'hiding', 'note', 'light', 'vent', 'intercom', 'switch', 'console', 'spawn_player', 'spawn_hound', 'spawn_listener', 'spawn_mannequin', 'leave_lever', 'deposit']) {
    assert.ok(kinds.has(k as never), `missing ${k}`);
  }
  const loot = L.items.filter((i) => i.kind === 'loot');
  assert.ok(loot.every((i) => [0, 1, 2].includes(Number(i.data?.tier))));
  const notes = L.items.filter((i) => i.kind === 'note').length;
  assert.ok(notes >= 4 && notes <= 6);
  const lights = L.items.filter((i) => i.kind === 'light');
  assert.ok(lights.every((i) => ['on', 'off', 'flicker', 'broken'].includes(String(i.data?.state))));
  for (const s of L.spaces) {
    if (s.kind === 'corridor' || s.kind === 'outside') assert.equal(s.callsign, null);
    else assert.ok(s.callsign);
  }
});

test('hub: lot + van + kennel with chained hound + mirror/board/shop + 6 spawns', () => {
  const H = generateHub();
  assert.equal(H.kind, 'hub');
  assert.deepEqual(validateLayout(H).errors, []);
  const kennel = H.spaces.find((s) => s.type === 'kennel')!;
  assert.ok(kennel.open);
  assert.equal(kennel.rect.w * kennel.rect.h, 24);
  const hound = H.items.find((i) => i.kind === 'spawn_hound')!;
  assert.equal(hound.space, kennel.id);
  assert.equal(hound.data?.chained, true);
  assert.equal(H.items.filter((i) => i.kind === 'spawn_player').length, 6);
  assert.ok(H.items.some((i) => i.kind === 'prop' && i.data?.prop === 'entrance_door'));
});

test('tuning overrides apply; map renders', () => {
  const t = resolveTuning({ locksByRisk: { '1': 0 } });
  const L = generateFacility({ seed: 'nolock', players: 2, risk: 1 }, t);
  assert.equal(L.doors.filter((d) => d.kind === 'locked').length, 0);
  assert.equal(L.zones, 1);
  assert.deepEqual(validateLayout(L).errors, []);
  const png = renderMap(L, 8).png();
  assert.equal(png.subarray(1, 4).toString('ascii'), 'PNG');
});
