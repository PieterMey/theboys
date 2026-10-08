// env-audio (v1.2): theme beds (beds.ts) on the fake Web Audio graph over a real fixture layout.
//   node --test tests/audio/beds.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FakeContext, FakeGain, installFakeAudio } from './fakeaudio.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import { SITE_THEMES } from '../../packages/shared/src/procgen/themes.ts';
import { makeRng } from '../../packages/shared/src/rng.ts';
import { BEDS, Beds, activeBeds, bedThemeOf, eventPos, nextGap } from '../../apps/client/src/audio/beds.ts';
import type { BedKind } from '../../apps/client/src/audio/synth.ts';
import { BED_KINDS } from '../../apps/client/src/audio/synth.ts';
import { AUDIO_DEFAULTS } from '../../apps/client/src/audio/config.ts';
import type { V3 } from '../../apps/client/src/audio/graph.ts';

installFakeAudio();
const ROOT = join(import.meta.dirname, '../..');
const BASE = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/layouts/facility_s1_p2.json'), 'utf8')) as LevelLayout;
const themed = (theme: string, mods: string[] = []): LevelLayout => ({
  ...BASE, theme, metrics: { ...BASE.metrics, ...Object.fromEntries(mods.map((m) => [`mod:${m}`, 1])) },
});
const room = BASE.spaces.find((s) => s.kind === 'room' && s.rect.w >= 4 && s.rect.h >= 4)!;
const INSIDE: V3 = [room.rect.x + room.rect.w / 2, 1.6, room.rect.y + room.rect.h / 2];
const lot = BASE.spaces.find((s) => s.open || s.kind === 'outside')!;
const OUTSIDE: V3 = [lot.rect.x + lot.rect.w / 2, 1.6, lot.rect.y + lot.rect.h / 2];

interface Played { kind: BedKind; pos: V3 | null; level: number; seed: number }
function rig() {
  const ac = new FakeContext();
  const amb = new FakeGain(ac);
  amb.connect(ac.destination);
  const played: Played[] = [];
  const beds = new Beds({ ac: ac as unknown as AudioContext, ambBus: amb as unknown as GainNode }, AUDIO_DEFAULTS.beds, {
    play: (kind, pos, level, seed) => { played.push({ kind, pos, level, seed }); },
  });
  return { ac, beds, played, base: ac.connectedCount() };
}
function run(r: ReturnType<typeof rig>, L: LevelLayout | null, sec: number, listener: V3 = INSIDE, phase = 'contract', siteThemes = true): void {
  for (let i = 0; i < sec * 10; i++) {
    r.ac.advance(0.1);
    r.beds.update({ layout: L, phase, listener, siteThemes, now: r.ac.currentTime });
  }
}

test('every theme resolves to a bed (undressed ones through ThemeDef.base); facility has none', () => {
  const want: Record<string, string | null> = {
    facility: null, hospital: 'hospital', waterworks: 'waterworks', industry: 'industry', records: 'records',
    hospitality: 'hospitality', cold_storage: 'cold_storage', comms: 'comms', transport: 'industry', retail: 'hospitality',
    parish: 'records', baths: 'hospital', greenhouse: 'waterworks', laundry: 'hospital',
  };
  for (const t of SITE_THEMES) assert.equal(bedThemeOf(t), want[t], t);
  assert.equal(bedThemeOf('mars_base'), null);
  assert.equal(bedThemeOf(undefined), null);
  assert.equal(bedThemeOf('lot'), null, 'special beds are not themes');
  for (const def of Object.values(BEDS)) for (const e of def.events) assert.ok(BED_KINDS.includes(e.kind), e.kind);
});

test('activeBeds: contract facility only; mods add machine / damp; the lot wind outside; siteThemes off = facility', () => {
  assert.deepEqual(activeBeds(themed('waterworks'), 'contract', false), ['waterworks']);
  assert.deepEqual(activeBeds(themed('waterworks', ['machine', 'damp']), 'contract', false), ['waterworks', 'machine', 'damp']);
  assert.deepEqual(activeBeds(themed('facility', ['machine']), 'contract', false), ['machine']);
  assert.deepEqual(activeBeds(themed('records'), 'results', false), []);
  assert.deepEqual(activeBeds(themed('records'), 'contract', true), ['records', 'lot']);
  assert.deepEqual(activeBeds(themed('records'), 'drive', true), []);
  assert.deepEqual(activeBeds({ ...themed('records'), kind: 'hub' }, 'hub', true), ['lot']);
  assert.deepEqual(activeBeds(themed('waterworks'), 'contract', false, false), [], 'flag siteThemes off');
  assert.deepEqual(activeBeds(null, 'contract', true), []);
});

test('nextGap: periodic +-4 %, random gaps bounded to [0.3, 3] x mean', () => {
  const rng = makeRng('x', 'gaps');
  for (let i = 0; i < 500; i++) {
    const p = nextGap(rng, 2, true), g = nextGap(rng, 5);
    assert.ok(p >= 1.92 && p <= 2.08 + 1e-9);
    assert.ok(g >= 1.5 && g <= 15 && Number.isFinite(g));
  }
  assert.ok(Number.isFinite(nextGap(rng, Number.NaN)));
});

test('waterworks bed: water + air layers, drips and the pump thump, inside the layout; finite params', () => {
  const r = rig();
  run(r, themed('waterworks'), 30);
  const info = r.beds.info();
  assert.deepEqual(info.active, ['waterworks']);
  assert.deepEqual(info.layers.sort(), ['waterworks:air', 'waterworks:water']);
  assert.ok(r.beds.nodes() > 0);
  const drips = r.played.filter((p) => p.kind === 'drip'), thumps = r.played.filter((p) => p.kind === 'thump');
  assert.ok(drips.length >= 5 && drips.length <= 25, `drips in 30 s: ${drips.length}`);
  assert.ok(thumps.length >= 12 && thumps.length <= 18, `pump thumps every ~1.8 s: ${thumps.length}`);
  for (const p of r.played) {
    assert.ok(p.pos && p.pos.every(Number.isFinite), 'positional');
    assert.ok(p.pos![0] >= 0 && p.pos![0] <= BASE.W && p.pos![2] >= 0 && p.pos![2] <= BASE.H, 'inside the layout');
    assert.ok(p.level > 0 && p.level <= 1);
  }
  for (const d of drips) assert.ok(d.pos![1] > 1.7, 'drips fall from the ceiling');
  for (const p of r.ac.allParams()) for (const v of p.history) assert.ok(Number.isFinite(v), `${p.name} ${v}`);
});

test('seeded client-only one-shots: the same layout gives the same sequence', () => {
  const a = rig(), b = rig();
  run(a, themed('hospitality'), 40);
  run(b, themed('hospitality'), 40);
  assert.ok(a.played.length >= 3);
  assert.deepEqual(a.played, b.played);
  const c = rig();
  run(c, { ...themed('hospitality'), seed: 'other', hash: 'other' }, 40);
  assert.notDeepEqual(a.played, c.played);
});

test('mod:machine adds the machine bed + its rhythmic clank; cold storage cycles its compressor', () => {
  const r = rig();
  run(r, themed('facility', ['machine']), 12);
  assert.ok(r.beds.info().layers.includes('machine:machine'));
  const clanks = r.played.filter((p) => p.kind === 'clank').length;
  assert.ok(clanks >= 8 && clanks <= 12, `machine clank ~1.15 s: ${clanks}`);
  const c = rig();
  run(c, themed('cold_storage'), 130);
  const cyc = c.played.filter((p) => p.kind === 'compressor_on' || p.kind === 'compressor_off').map((p) => p.kind);
  assert.ok(cyc.length >= 3, `compressor cycles: ${cyc.join(',')}`);
  for (let i = 1; i < cyc.length; i++) assert.notEqual(cyc[i], cyc[i - 1], 'on / off alternate');
  assert.equal(cyc[0], 'compressor_on');
});

test('the lot wind outside; leaving the contract fades every layer out and frees its nodes', () => {
  const r = rig();
  run(r, themed('records'), 3, OUTSIDE);
  assert.ok(r.beds.info().layers.includes('lot:wind'));
  run(r, themed('records'), 3, INSIDE);
  assert.ok(!r.beds.info().active.includes('lot'));
  run(r, themed('records'), 8, INSIDE, 'results');
  assert.deepEqual(r.beds.info().layers, []);
  assert.equal(r.beds.nodes(), 0);
  assert.equal(r.ac.connectedCount(), r.base, 'every bed node disconnected');
  // test override: force a theme anywhere
  r.beds.forceTheme('comms');
  run(r, themed('facility'), 6);
  assert.ok(r.beds.info().layers.includes('comms:equipment'));
  assert.ok(r.played.some((p) => p.kind === 'selector'));
  r.beds.forceTheme(undefined);
  run(r, themed('facility'), 8);
  assert.equal(r.beds.nodes(), 0);
  r.beds.dispose();
  assert.equal(r.ac.connectedCount(), r.base - 1);
});

test('eventPos: in the listener room or a neighbour, far events 10-18 m away, null outside any room', () => {
  const rng = makeRng('pos', 'test');
  for (let i = 0; i < 200; i++) {
    const p = eventPos(BASE, INSIDE, room.id, 'ceiling', 12, rng)!;
    assert.ok(p && p[1] > 1.7);
    const f = eventPos(BASE, INSIDE, room.id, 'far', 12, rng)!;
    const d = Math.hypot(f[0] - INSIDE[0], f[2] - INSIDE[2]);
    assert.ok(f[0] >= 0.5 && f[0] <= BASE.W - 0.5 && f[2] >= 0.5 && f[2] <= BASE.H - 0.5);
    assert.ok(d <= 18.01);
  }
  assert.equal(eventPos(BASE, [500, 1, 500], -1, 'near', 12, rng), null);
});
