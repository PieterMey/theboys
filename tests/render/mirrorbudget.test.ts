// v1.2 mirror budget (env-render): never more live mirrors than the preset allows, none in menus, no flip-flop
// between two similar mirrors (1.3x hysteresis), the van mirror wins inside the van, fixed reflection sizes.
//   node --test tests/render/mirrorbudget.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIRROR_BUDGETS, MIRROR_MAX_PIXELS, chooseLive, fixedReflectorSize, mirrorScore } from '../../apps/client/src/render/mirrors.ts';

test('budget table: Ultra 1 @ 0.5, High 1 @ 0.3 (half rate only while still), Medium 1 @ 0.25 within 5 m, Low none', () => {
  assert.deepEqual([MIRROR_BUDGETS.ultra.live, MIRROR_BUDGETS.ultra.scale, MIRROR_BUDGETS.ultra.halfRateStill], [1, 0.5, false]);
  assert.deepEqual([MIRROR_BUDGETS.high.live, MIRROR_BUDGETS.high.scale, MIRROR_BUDGETS.high.halfRateStill], [1, 0.3, true]);
  assert.deepEqual([MIRROR_BUDGETS.medium.live, MIRROR_BUDGETS.medium.scale, MIRROR_BUDGETS.medium.maxDist], [1, 0.25, 5]);
  assert.equal(MIRROR_BUDGETS.low.live, 0);
});

test('never more live mirrors than the budget; none in menus or at budget 0', () => {
  const c = [{ id: 1, score: 3, van: false }, { id: 2, score: 2, van: false }, { id: 3, score: 1, van: false }];
  assert.deepEqual(chooseLive(c, [], 1, { menu: false, inVan: false }), [1]);
  assert.deepEqual(chooseLive(c, [], 2, { menu: false, inVan: false }), [1, 2]);
  assert.deepEqual(chooseLive(c, [1], 1, { menu: true, inVan: false }), []);
  assert.deepEqual(chooseLive(c, [1], 0, { menu: false, inVan: false }), []);
  assert.deepEqual(chooseLive([{ id: 1, score: 0, van: false }], [1], 1, { menu: false, inVan: false }), [], 'not a candidate any more');
});

test('no flip-flop: a rival needs > 1.3x the live mirror\'s score', () => {
  let live: number[] = [];
  const flips: number[] = [];
  for (let f = 0; f < 200; f++) {
    // two mirrors whose scores wobble around each other (walking past them)
    const a = 1 + 0.12 * Math.sin(f * 0.3), b = 1 + 0.12 * Math.cos(f * 0.3);
    const next = chooseLive([{ id: 1, score: a, van: false }, { id: 2, score: b, van: false }], live, 1, { menu: false, inVan: false });
    if (live.length && next[0] !== live[0]) flips.push(f);
    live = next;
  }
  assert.equal(flips.length, 0, `flips at ${flips.join(',')}`);
  // a clearly better rival does take over
  assert.deepEqual(chooseLive([{ id: 1, score: 1, van: false }, { id: 2, score: 1.5, van: false }], [1], 1, { menu: false, inVan: false }), [2]);
});

test('the van mirror wins inside the van', () => {
  const c = [{ id: 1, score: 5, van: false }, { id: 2, score: 0.4, van: true }];
  assert.deepEqual(chooseLive(c, [], 1, { menu: false, inVan: true }), [2]);
  assert.deepEqual(chooseLive(c, [2], 1, { menu: false, inVan: false }), [1]);
});

test('fixed reflection sizes: multiples of 8, capped at MIRROR_MAX_PIXELS (<= 10 MB with mips + depth)', () => {
  const u = fixedReflectorSize(2560, 1440, 0.5);
  assert.deepEqual(u, [1024, 576]);
  assert.ok(u[0] * u[1] <= MIRROR_MAX_PIXELS);
  const h = fixedReflectorSize(2560, 1440, 0.3);
  assert.equal(h[0] % 8, 0);
  assert.equal(h[1] % 8, 0);
  assert.deepEqual(h, [768, 432]);
  assert.deepEqual(fixedReflectorSize(1920, 1080, 0.25), [480, 272]);
  // RGBA16F + 1/3 mips + 32-bit depth
  const bytes = u[0] * u[1] * (8 * 4 / 3 + 4);
  assert.ok(bytes <= 10 * 1024 * 1024, `${(bytes / 1048576).toFixed(1)} MB`);
});

test('score: facing, within maxDist, larger when closer / more frontal', () => {
  const n: [number, number, number] = [0, 0, 1];
  assert.equal(mirrorScore([0, 1.6, -2], [0, 1.5, 0], n, 1, 1.2, 8), 0, 'behind the glass');
  assert.equal(mirrorScore([0, 1.6, 9], [0, 1.5, 0], n, 1, 1.2, 8), 0, 'too far');
  assert.ok(mirrorScore([0, 1.6, 2], [0, 1.5, 0], n, 1, 1.2, 8) > mirrorScore([0, 1.6, 4], [0, 1.5, 0], n, 1, 1.2, 8));
  assert.ok(mirrorScore([0, 1.6, 3], [0, 1.5, 0], n, 1, 1.2, 8) > mirrorScore([2.5, 1.6, 1.5], [0, 1.5, 0], n, 1, 1.2, 8));
});
