// Env-layout (v1.2): site themes and work-order modifiers.
//  - 14 themes x SEEDS seeds (1-6 players, risk 1-3): never GenFail, 0 validate errors, p95 generation <= 25 ms,
//    L.theme set, fixture kinds known, preferred landmarks present (>= 60%) for the 4 dressed MUST themes, the theme
//    props placed; unknown / absent theme = facility (and the same layout as no theme at all).
//  - every template site's (siteThemeOf, modifiers) x 1-6 players x TEMPLATE_SEEDS seeds: zero throws (plan check #3),
//    metrics['mod:<slug>'] = 1 for the applied modifiers.
//  - floorSurface: the facility mapping is exactly v1.1's, every theme yields a known surface, HARD FLOORS hardens.
// Run: node --test tests/level/themes.test.ts   (SEEDS=60 TEMPLATE_SEEDS=20 for a quick run)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LayoutSpace, LevelLayout } from '../../packages/shared/src/layout.ts';
import { generateFacility, validateLayout } from '../../packages/shared/src/procgen/index.ts';
import {
  FIXTURE_KINDS, GEN_MODIFIERS, MODIFIER_SLUG, SITE_THEMES, THEMES, floorSurface, modifierSlugs, siteThemeOf, themeChain, themeFor, themeOf,
} from '../../packages/shared/src/procgen/themes.ts';
import type { FloorSurface, SiteTheme } from '../../packages/shared/src/procgen/themes.ts';
import { PROP_DEFS, THEME_PROP_KEYS } from '../../packages/shared/src/procgen/decor.ts';
import { CALLSIGNS } from '../../packages/shared/src/callsign.ts';
import { SITES } from '../../apps/server/src/meta/templates.ts';
import { loadTuning } from '../../tools/gen-cli.ts';

const SEEDS = Number(process.env.SEEDS ?? 300);
const TEMPLATE_SEEDS = Number(process.env.TEMPLATE_SEEDS ?? 100);
const tuning = loadTuning();
const q = (a: number[], f: number) => [...a].sort((x, y) => x - y)[Math.floor(f * (a.length - 1))];
const SURFACES: readonly FloorSurface[] = ['concrete', 'tile', 'metal', 'grate', 'carpet', 'wood', 'rubber', 'lino', 'asphalt', 'dirt'];
const MUST: readonly SiteTheme[] = ['hospital', 'waterworks', 'records', 'cold_storage'];

test('theme table: 14 ids, existing callsigns only, chains end at facility, every site name maps', () => {
  assert.equal(SITE_THEMES.length, 14);
  const known = new Set<string>(CALLSIGNS);
  for (const id of SITE_THEMES) {
    const d = THEMES[id];
    assert.equal(d.id, id);
    for (const c of [...d.prefer.landmarks, ...d.prefer.rooms, ...(d.prefer.avoid ?? [])]) assert.ok(known.has(c), `${id}: ${c} is not an existing callsign`);
    assert.ok(themeChain(id).length <= 4 && !themeChain(id).includes('facility'));
    assert.ok(d.haunt >= -0.1 && d.haunt <= 0.15);
  }
  for (const s of SITES) assert.ok(siteThemeOf(s.name), `${s.name} has no theme`);
  assert.equal(themeFor('nope'), 'facility');
  assert.equal(themeFor(undefined), 'facility');
  assert.equal(themeOf({ theme: 'hub' }), 'facility');
  assert.deepEqual(modifierSlugs(['dark wards', 'MAZE', 'Maze', 'QUIET SITE']), ['dark', 'maze']);
  for (const sl of Object.values(MODIFIER_SLUG)) assert.ok(/^[a-z]+$/.test(sl));
});

test('unknown or absent theme generates the facility layout byte-identically', () => {
  for (const [seed, players] of [['th-u1', 2], ['th-u2', 5]] as const) {
    const plain = generateFacility({ seed, players, risk: 1 }, tuning);
    assert.equal(plain.theme, 'facility');
    for (const theme of ['facility', 'not-a-theme', '']) assert.equal(generateFacility({ seed, players, risk: 1, theme, modifiers: [] }, tuning).hash, plain.hash, `theme '${theme}'`);
    // look-only flavour chips never change the structure
    const flav = generateFacility({ seed, players, risk: 1, modifiers: ['QUIET SITE', 'RADIO HEAVY'] }, tuning);
    assert.equal(flav.hash, plain.hash, 'unknown chips are flavour only');
  }
});

test('theme props: honest procedural PROP_DEFS for every published key', () => {
  for (const [theme, keys] of Object.entries(THEME_PROP_KEYS)) for (const k of keys) {
    const d = PROP_DEFS[k];
    assert.ok(d && d.key === k && d.proc === true, `${theme}: ${k}`);
    assert.ok(d.h > 0 && d.w > 0 && d.d > 0 && d.w <= d.cells + 0.05, `${k} dims`);
    if (d.mount === 'floor' && d.solid) assert.ok(d.d <= 2.05, `${k} depth`);
  }
});

for (const theme of SITE_THEMES) {
  test(`theme ${theme}: ${SEEDS} seeds x 1-6 players`, () => {
    const fails: string[] = [];
    const times: number[] = [];
    const timed: Parameters<typeof generateFacility>[0][] = [];
    let lmAny = 0, lmFrac = 0, n = 0;
    const propSeen = new Set<string>();
    const pref = THEMES[theme].prefer.landmarks;
    for (let i = 0; i < 6; i++) generateFacility({ seed: `warm-${theme}-${i}`, players: 1 + i, risk: 1, theme }, tuning);
    for (let i = 0; i < SEEDS; i++) {
      const players = 1 + (i % 6), risk = 1 + (Math.floor(i / 6) % 3);
      const t0 = performance.now();
      let L: LevelLayout;
      try { L = generateFacility({ seed: `th-${theme}-${i}`, players, risk, theme }, tuning); } catch (e) { fails.push(`th-${theme}-${i} p${players}: THROW ${(e as Error).message.slice(0, 120)}`); continue; }
      times.push(performance.now() - t0);
      timed.push({ seed: `th-${theme}-${i}`, players, risk, theme });
      n++;
      if (L.theme !== theme) fails.push(`${L.seed}: theme ${L.theme}`);
      const v = validateLayout(L);
      if (v.errors.length) fails.push(`${L.seed} p${players}: ${v.errors.slice(0, 2).join('; ')}`);
      for (const it of L.items) {
        if (it.kind === 'light' && !(FIXTURE_KINDS as readonly string[]).includes(String(it.data?.kind))) fails.push(`${L.seed}: light kind ${it.data?.kind}`);
        if (it.kind === 'prop') propSeen.add(String(it.data?.prop));
      }
      if (pref.length) {
        const cs = new Set(L.spaces.map((s) => s.callsign));
        const k = pref.filter((c) => cs.has(c)).length;
        if (k) lmAny++;
        lmFrac += k / pref.length;
      }
      if (fails.length > 12) break;
    }
    let p95 = q(times, 0.95);
    // a busy machine (all test files in parallel, a game in the background) inflates single samples: re-time the
    // slowest tenth best-of-3 before judging, so only a generator that is slow every time fails
    if (p95 > 25) {
      const slow = times.map((_, k) => k).sort((a, b) => times[b] - times[a]).slice(0, Math.ceil(times.length / 10));
      for (const k of slow) for (let r = 0; r < 3; r++) {
        const t0 = performance.now();
        generateFacility(timed[k], tuning);
        times[k] = Math.min(times[k], performance.now() - t0);
      }
      p95 = q(times, 0.95);
    }
    console.log(JSON.stringify({ theme, n, p50: +q(times, 0.5).toFixed(2), p95: +p95.toFixed(2), landmarkAny: pref.length ? +(lmAny / n).toFixed(2) : null, landmarkFrac: pref.length ? +(lmFrac / n).toFixed(2) : null }));
    assert.deepEqual(fails.slice(0, 12), []);
    assert.ok(p95 <= 25, `p95 ${p95.toFixed(1)} ms > 25 ms`);
    if (MUST.includes(theme)) {
      assert.ok(lmAny / n >= 0.6 && lmFrac / n >= 0.6, `preferred landmarks only ${lmAny}/${n} (${(lmFrac / n).toFixed(2)})`);
      for (const k of THEME_PROP_KEYS[theme] ?? []) assert.ok(propSeen.has(k), `${theme}: ${k} never placed`);
    }
  });
}

test(`template sites (theme + modifiers) x 1-6 players x ${TEMPLATE_SEEDS} seeds: zero throws`, () => {
  const fails: string[] = [];
  const times: number[] = [];
  for (const site of SITES) {
    const theme = siteThemeOf(site.name)!;
    const slugs = modifierSlugs(site.modifiers);
    for (let i = 0; i < TEMPLATE_SEEDS; i++) for (let players = 1; players <= 6; players++) {
      const t0 = performance.now();
      let L: LevelLayout;
      try { L = generateFacility({ seed: `tpl-${i}`, players, risk: 1 + (i % 3), theme, modifiers: site.modifiers }, tuning); } catch (e) { fails.push(`${site.name} tpl-${i} p${players}: THROW ${(e as Error).message.slice(0, 100)}`); continue; }
      times.push(performance.now() - t0);
      if (L.theme !== theme) fails.push(`${site.name}: theme`);
      const relaxed = L.metrics.attempt >= tuning.maxAttempts - 3;
      for (const sl of slugs) {
        const want = relaxed && GEN_MODIFIERS.has(sl) ? undefined : 1;
        if (L.metrics[`mod:${sl}`] !== want) fails.push(`${site.name} tpl-${i}: mod:${sl} = ${L.metrics[`mod:${sl}`]}`);
      }
      if (i < 3 && validateLayout(L).errors.length) fails.push(`${site.name} tpl-${i} p${players}: invalid`);
      if (fails.length > 12) break;
    }
  }
  console.log(JSON.stringify({ layouts: times.length, p50: +q(times, 0.5).toFixed(2), p95: +q(times, 0.95).toFixed(2) }));
  assert.deepEqual(fails.slice(0, 12), []);
});

test('floorSurface: facility = the v1.1 mesher mapping; themes and HARD FLOORS give known surfaces', () => {
  const CLINICAL = new Set(['morgue', 'infirmary', 'showers', 'cold', 'cryo', 'kitchen', 'laundry', 'nursery']);
  const INDUSTRIAL = new Set(['boiler', 'furnace', 'foundry', 'pumps', 'tanks', 'garage', 'dock', 'pit', 'storage', 'greenhouse']);
  const HEAVY = new Set(['boiler', 'furnace', 'foundry', 'pumps', 'tanks']);
  const v11 = (s: LayoutSpace): FloorSurface => {
    if (s.type === 'van') return 'metal';
    if (s.kind === 'outside') return s.type === 'kennel' ? 'dirt' : 'asphalt';
    if (s.kind === 'corridor') return 'lino';
    if (s.kind === 'vault') return 'metal';
    if (s.type === 'lobby' || CLINICAL.has(s.type)) return 'tile';
    if (INDUSTRIAL.has(s.type)) return HEAVY.has(s.type) ? 'metal' : 'concrete';
    if (s.type === 'server' || s.type === 'radio') return 'rubber';
    return 'lino';
  };
  const base = generateFacility({ seed: 'floors', players: 6, risk: 1 }, tuning);
  for (const s of base.spaces) assert.equal(floorSurface(base, s.id), v11(s), `facility ${s.kind}/${s.type}`);
  assert.equal(floorSurface(base, 9999), 'concrete');
  const differs = new Set<string>();
  for (const theme of SITE_THEMES) {
    const L = generateFacility({ seed: 'floors', players: 6, risk: 1, theme }, tuning);
    const H = { ...L, metrics: { ...L.metrics, 'mod:hardfloors': 1 } };
    for (const s of L.spaces) {
      const f = floorSurface(L, s.id), h = floorSurface(H, s.id);
      assert.ok(SURFACES.includes(f) && SURFACES.includes(h), `${theme} ${s.type}: ${f}/${h}`);
      if (s.type === 'van' || s.kind === 'outside' || s.kind === 'vault') assert.equal(f, v11(s), `${theme}: ${s.type} floor is fixed`);
      if (!s.open) assert.ok(!['carpet', 'rubber', 'lino', 'dirt'].includes(h) || s.kind === 'outside', `${theme} ${s.type}: hard floors left ${h}`);
      if (f !== v11(s)) differs.add(theme);
    }
  }
  for (const t of MUST) assert.ok(differs.has(t), `${t} floors identical to facility`);
});
