// Parked flashlight slots stop re-rendering their shadow maps (three r186 redraws every shadow map each frame while
// shadow.autoUpdate is on: 5 of 6 2048^2 passes in the title menu). castShadow and the light count never change.
//   node --test tests/render/flashpark.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { createFlashlightPool } from '../../apps/client/src/render/flashlights.ts';
import type { FlashCfg } from '../../apps/client/src/render/flashlights.ts';
import type { FlashlightInfo } from '../../apps/client/src/render/types.ts';

const CFG: FlashCfg = { angle: 0.62, penumbra: 0.9, decay: 1.6, distance: 28, intensity1: 74, intensity2: 105, color1: '#ffe3bd', color2: '#e4eeff', bias: -0.0004, normalBias: 0.02, shadowRadius: 3, near: 0.12, cone: 0.035 };
const beam = (id: string, local = false): FlashlightInfo => ({ id, pos: [0, 1.5, 0], dir: [0, 0, -1], on: true, local, tier: 1 });

function setup() {
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(70, 1, 0.05, 120);
  const pool = createFlashlightPool(scene, CFG, 6, 0, 1024, 10);
  const opts = { activeShadowed: 6, volumetric: true, reduceFlicker: false };
  const auto = () => pool.slots.map((s) => s.light.shadow.autoUpdate);
  return { scene, cam, pool, opts, auto };
}

test('one beam (the menu backdrop): 5 shadowed slots park their maps after one last render', () => {
  const { cam, pool, opts, auto } = setup();
  const lightsBefore = pool.slots.map((s) => s.light);
  pool.update([beam('me', true)], cam, 0, 1 / 60, opts);
  assert.deepEqual(auto(), [true, false, false, false, false, false]);
  // the parked ones get exactly one more render (needsUpdate), the active one renders every frame (autoUpdate)
  assert.deepEqual(pool.slots.map((s) => s.light.shadow.needsUpdate), [false, true, true, true, true, true]);
  for (const s of pool.slots) s.light.shadow.needsUpdate = false; // what three's ShadowNode does after the render
  pool.update([beam('me', true)], cam, 0.016, 1 / 60, opts);
  assert.deepEqual(pool.slots.map((s) => s.light.shadow.needsUpdate), [false, false, false, false, false, false]);
  assert.ok(pool.slots.every((s) => s.light.castShadow === true), 'castShadow never toggles');
  assert.deepEqual(pool.slots.map((s) => s.light), lightsBefore, 'same lights');
});

test('a teammate turns up: the slot wakes and renders its map in the same frame', () => {
  const { cam, pool, opts, auto } = setup();
  pool.update([beam('me', true)], cam, 0, 1 / 60, opts);
  for (const s of pool.slots) s.light.shadow.needsUpdate = false;
  pool.update([beam('me', true), beam('p2')], cam, 0.016, 1 / 60, opts);
  assert.deepEqual(auto(), [true, true, false, false, false, false]);
  assert.equal(pool.slots[1].light.shadow.needsUpdate, true);
  // the teammate leaves: parked again
  pool.update([beam('me', true)], cam, 0.032, 1 / 60, opts);
  assert.deepEqual(auto(), [true, false, false, false, false, false]);
});

test('warm-up (all six beams) keeps every map live; parkShadows:false restores the old behaviour', () => {
  const { cam, pool, opts, auto } = setup();
  pool.update([beam('me', true)], cam, 0, 1 / 60, opts);
  pool.update(Array.from({ length: 6 }, (_, i) => beam(`warm${i}`, i === 0)), cam, 0.016, 1 / 60, opts);
  assert.deepEqual(auto(), [true, true, true, true, true, true]);
  pool.update([], cam, 0.032, 1 / 60, { ...opts, parkShadows: false });
  assert.deepEqual(auto(), [true, true, true, true, true, true]);
});

test('a lower preset (4 active shadowed slots of a pool of 6): the 2 unused slots stay parked', () => {
  const { cam, pool, opts, auto } = setup();
  const four = Array.from({ length: 6 }, (_, i) => beam(`p${i}`, i === 0));
  pool.update(four, cam, 0, 1 / 60, { ...opts, activeShadowed: 4 });
  assert.deepEqual(auto(), [true, true, true, true, false, false]);
});
