// v1.2 fixture pool (env-render): downward spots per kind, the omni sub-pool, power / curves / brownout / failSpace
// semantics (the dark walk), battery accents in a blackout, hidden parked lights with one sentinel per type.
//   node --test tests/render/fixtures.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { createFixturePool } from '../../apps/client/src/render/fixtures.ts';
import type { FixtureCfg } from '../../apps/client/src/render/fixtures.ts';
import type { FixtureInfo } from '../../apps/client/src/render/types.ts';

const CFG: FixtureCfg = { color: '#cfeedd', intensity: 12, distance: 9, decay: 2, halo: 0.5, tube: 3.4, omni: 4, hideParked: true };
type F = FixtureInfo & { kind?: string; rot?: number; battery?: boolean };
const fx = (space: number, x: number, z: number, kind = 'tube', extra: Partial<F> = {}): F => ({ space, pos: [x, 2.93, z], state: 'on', kind, ...extra });

function setup(list: F[], spots = 8) {
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(70, 1, 0.05, 120);
  cam.position.set(0, 1.6, 0);
  cam.updateMatrixWorld();
  const pool = createFixturePool(scene, CFG, spots, 4);
  const src = { fixtures: list };
  let now = 1000;
  // every test space is indoors (outdoorSpace: never gated by the camera's outdoor factor)
  const step = (ms = 16) => { now += ms; pool.update(src, cam, now / 1000, { max: spots, reduceFlicker: false, outdoor: 0, now, outdoorSpace: () => false }); return pool.levels(); };
  return { scene, cam, pool, step, at: () => now };
}

test('spots point down for tubes, along rot for wall packs; candles go to the omni sub-pool; targets are in the scene', () => {
  const list = [fx(0, 1, 1), fx(0, 3, 1, 'wall', { rot: Math.PI / 2 }), fx(0, 2, 2, 'candle')];
  const { scene, pool, step } = setup(list);
  step();
  const lit = pool.spots.filter((l) => l.intensity > 0);
  assert.equal(lit.length, 2, 'tube + wall pack (the candle is omni only)');
  const tube = lit.find((l) => Math.abs(l.position.x - 1) < 1e-6)!;
  const dir = tube.target.position.clone().sub(tube.position).normalize();
  assert.ok(dir.y < -0.999, 'tube aims straight down');
  assert.ok(Math.abs(tube.angle - 1.2) < 1e-6 && Math.abs(tube.penumbra - 0.85) < 1e-6 && tube.decay === 2);
  const wall = lit.find((l) => Math.abs(l.position.x - 3) < 1e-6)!;
  const wd = wall.target.position.clone().sub(wall.position).normalize();
  assert.ok(wd.x > 0.5 && wd.y < -0.3, 'wall pack aims out along normalOfYaw(rot), tilted down');
  assert.equal(pool.omnis.filter((l) => l.intensity > 0).length, 1, 'the candle lights an omni');
  for (const l of pool.spots) assert.ok(l.target.parent === scene, 'target lives in the scene (batched spot data reads target.matrixWorld)');
  for (const l of pool.lights) assert.equal(l.castShadow, false);
});

test('parked lights hide (one sentinel per type stays visible); lit ones are visible', () => {
  const { pool, step } = setup([fx(0, 1, 1), fx(0, 3, 1)], 6);
  step();
  assert.equal(pool.spots.filter((l) => l.visible).length, 2, 'the two lit spots (the first doubles as the sentinel)');
  assert.ok(pool.spots[0].visible, 'sentinel spot');
  assert.ok(pool.spots.slice(2).every((l) => !l.visible), 'parked spots hidden');
  assert.ok(pool.omnis[0].visible && !pool.omnis[1].visible, 'sentinel omni only');
  pool.setPower('all', false);
  step();
  assert.equal(pool.spots.filter((l) => l.visible).length, 1, 'all dark: only the sentinel stays in the light list');
  pool.setHideParked(false);
  step();
  assert.ok(pool.lights.every((l) => l.visible));
});

test('blackout: mains fixtures go dark, battery fixtures stay on as dim red accents', () => {
  const list = [fx(0, 1, 1), fx(0, 3, 1, 'emergency'), fx(1, 6, 1, 'tube', { battery: true })];
  const { pool, step } = setup(list);
  let lv = step();
  assert.ok(lv[0] > 0.9 && lv[1] > 0.9, 'all on with mains power');
  pool.setPower('all', false);
  lv = step();
  assert.equal(lv[0], 0);
  assert.ok(lv[1] > 0.2 && lv[1] < 0.45, `emergency dim accent ${lv[1]}`);
  assert.ok(lv[2] > 0.2 && lv[2] < 0.45, 'battery flag on a tube');
  const red = pool.spots.find((l) => l.intensity > 0)!;
  assert.ok(red.color.r > red.color.g * 3, 'red accent');
});

test('dark walk: die curves step through the fixtures, stay dead under the 2 s re-sync, revive on a real power return', () => {
  const list = [fx(3, 1, 1), fx(3, 1, 3), fx(3, 1, 5), fx(4, 9, 9)];
  const { pool, step, at } = setup(list);
  step();
  pool.fixtureCurve([0, 1, 2], 'die', at(), 400);
  let lv = step(300);
  assert.ok(lv[0] < 1 && lv[1] > 0.9, 'the first one dies first');
  for (let i = 0; i < 20; i++) lv = step(100);
  assert.deepEqual([lv[0], lv[1], lv[2]], [0, 0, 0], 'all three dead');
  assert.ok(lv[3] > 0.9, 'the other space is untouched');
  // interaction re-sends every space's power every 2 s: a repeated 'on' must not revive them
  pool.setPower(3, true);
  lv = step();
  assert.equal(lv[0], 0, 'still dead after a re-sent on');
  // the server turns the space off at its last fixture, a switch turns it back on: revived
  pool.setPower(3, false);
  step();
  pool.setPower(3, true);
  lv = step();
  assert.ok(lv[0] > 0.9 && lv[2] > 0.9, 'revived by the off -> on transition');
  // a revive curve also brings a dead fixture back (switchless corridors)
  pool.fixtureCurve([0], 'die', at(), 0);
  for (let i = 0; i < 10; i++) step(100);
  pool.fixtureCurve([0], 'revive', at(), 0);
  for (let i = 0; i < 10; i++) lv = step(100);
  assert.ok(lv[0] > 0.9);
});

test('brownout sags smoothly and recovers; failSpace kills a whole space (surge first)', () => {
  const list = [fx(5, 1, 1), fx(5, 3, 1), fx(6, 9, 9)];
  const { pool, step, at } = setup(list);
  step();
  pool.brownout(5, 1000, 0.6, at());
  const sag: number[] = [];
  for (let i = 0; i < 70; i++) sag.push(step(16)[0]);
  assert.ok(Math.min(...sag) < 0.55, 'sags');
  let maxStep = 0;
  for (let i = 1; i < sag.length; i++) maxStep = Math.max(maxStep, Math.abs(sag[i] - sag[i - 1]));
  assert.ok(maxStep < 0.2, `smooth (largest step ${maxStep.toFixed(3)}), never a strobe`);
  let lv = step(400);
  assert.ok(lv[0] > 0.9, 'recovered');
  pool.failSpace(5, at());
  const surge = step(60)[0];
  assert.ok(surge > 1.0, `surges first (${surge})`);
  for (let i = 0; i < 20; i++) lv = step(50);
  assert.deepEqual([lv[0], lv[1]], [0, 0]);
  assert.ok(lv[2] > 0.9);
  assert.equal(pool.levels(), pool.levels(), 'fixtureLevels() returns the same array');
});
