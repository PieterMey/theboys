// v1.2 light grid (env-render): no light through closed walls or doors, 25 % spill through open doors, re-splats only
// changed spaces, deterministic texels, tag-aware sampling, table rows (fog volumes, room params).
//   node --test tests/render/lightgrid.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { createLightGrid, splatWeight } from '../../apps/client/src/render/lightgrid.ts';
import type { GridLight } from '../../apps/client/src/render/lightgrid.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';

/** two 6x4 rooms side by side (A: x 0..5, B: x 6..11), one wall at x = 6 with a 1 m door at z = 1; a third room C
 *  behind A (z 4..7) with NO door to anything */
function layout(): LevelLayout {
  const W = 12, H = 8;
  const owner = new Array(W * H).fill(-1);
  for (let z = 0; z < 4; z++) for (let x = 0; x < 12; x++) owner[z * W + x] = x < 6 ? 0 : 1;
  for (let z = 4; z < 8; z++) for (let x = 0; x < 6; x++) owner[z * W + x] = 2;
  const sp = (id: number, x: number, y: number, w: number, h: number) => ({ id, kind: 'room' as const, rect: { x, y, w, h }, zone: 0, type: 'office', callsign: null, dist: 0, light: 'on' as const, open: false, powerZone: 0 });
  return {
    genVersion: 1, kind: 'facility', seed: 't', hash: 'h', theme: 'facility', W, H, owner,
    spaces: [sp(0, 0, 0, 6, 4), sp(1, 6, 0, 6, 4), sp(2, 0, 4, 6, 4)],
    doors: [{ id: 0, a: 0, b: 1, x: 6, y: 1, dir: 'v', len: 1, kind: 'door', lock: 0, initiallyOpen: false }],
    items: [], entrance: 0, van: { x: 0, z: 0, yaw: 0, cab: { x: 0, y: 0, w: 0, h: 0 } }, zones: 1, wallH: 3, metrics: {},
  };
}

const tube = (space: number, x: number, z: number, level = 1): GridLight => ({ space, x, y: 2.9, z, r: 0.8, g: 1, b: 0.9, cd: 12, range: 9, level });
const cellsOf = (g: ReturnType<typeof createLightGrid>, space: number) => {
  const out: number[] = [];
  for (let z = 0; z < g.H; z++) for (let x = 0; x < g.W; x++) { const c = g.cell(x, z)!; if (c.tag === space) out.push(c.rgb[0] + c.rgb[1] + c.rgb[2]); }
  return out;
};

test('a lit fixture in A lights only A while the door is closed (never C, which shares a wall)', () => {
  const g = createLightGrid();
  g.setLayout(layout());
  g.update([tube(0, 3, 2)], () => 0);
  assert.ok(Math.max(...cellsOf(g, 0)) > 1, 'A is lit');
  assert.equal(Math.max(...cellsOf(g, 1)), 0, 'B dark behind the closed door');
  assert.equal(Math.max(...cellsOf(g, 2)), 0, 'C dark behind the wall');
  // tag-aware CPU sample right at the wall: B / C points never pick up A's cells
  assert.equal(g.sample(6.05, 1.5)[1], 0);
  assert.equal(g.sample(2.5, 4.05)[1], 0);
  assert.ok(g.sample(5.95, 1.5)[1] > 0);
});

test('an open door spills 25 % of the door-side light into B, fading over the reach', () => {
  const g = createLightGrid({ spill: 0.25, spillReach: 4 });
  g.setLayout(layout());
  g.update([tube(0, 4.5, 1.5)], () => 1);
  const a = g.cell(5, 1)!.rgb[1];
  const b = g.cell(6, 1)!.rgb[1];
  assert.ok(b > 0 && b < a * 0.3, `spill ${b} vs door-side ${a}`);
  assert.equal(g.cell(11, 3)!.rgb[1], 0, 'beyond the reach: dark');
  assert.equal(Math.max(...cellsOf(g, 2)), 0, 'C still dark');
  // closing (openness <= 2 %) removes the spill again
  g.update([tube(0, 4.5, 1.5)], () => 0.01);
  assert.equal(g.cell(6, 1)!.rgb[1], 0);
});

test('re-splats only changed spaces; identical frames upload nothing; deterministic texels', () => {
  const L = layout();
  const g1 = createLightGrid();
  g1.setLayout(L);
  assert.equal(g1.update([tube(0, 3, 2), tube(1, 9, 2)], () => 0), 3, 'first frame: every space');
  assert.equal(g1.update([tube(0, 3, 2), tube(1, 9, 2)], () => 0), 0, 'nothing changed: no upload');
  assert.equal(g1.update([tube(0, 3, 2, 0.5), tube(1, 9, 2)], () => 0), 1, 'only A changed');
  assert.equal(g1.update([tube(0, 3, 2, 0.5), tube(1, 9, 2)], () => 1), 2, 'the door opened: A and B');
  const g2 = createLightGrid();
  g2.setLayout(L);
  g2.update([tube(0, 3, 2), tube(1, 9, 2)], () => 0);
  g2.update([tube(0, 3, 2, 0.5), tube(1, 9, 2)], () => 0);
  g2.update([tube(0, 3, 2, 0.5), tube(1, 9, 2)], () => 1);
  const d1 = (g1.texture.image as { data: Uint16Array }).data, d2 = (g2.texture.image as { data: Uint16Array }).data;
  assert.deepEqual(Array.from(d1), Array.from(d2), 'same inputs -> same texels');
});

test('texture layout: RGBA16F, nearest (no sampler), room tags in alpha, table rows under the grid', () => {
  const g = createLightGrid();
  g.setLayout(layout());
  const t = g.texture;
  assert.equal(t.type, THREE.HalfFloatType);
  assert.equal(t.minFilter, THREE.NearestFilter);
  assert.equal(t.magFilter, THREE.NearestFilter);
  const img = t.image as { data: Uint16Array; width: number; height: number };
  assert.ok(img.width >= 24 && img.height >= 8 + 2);
  const tagAt = (x: number, z: number) => THREE.DataUtils.fromHalfFloat(img.data[(z * img.width + x) * 4 + 3]);
  assert.equal(tagAt(0, 0), 0);
  assert.equal(tagAt(7, 0), 1);
  assert.equal(tagAt(1, 5), 2);
  assert.equal(tagAt(8, 6), -1, 'solid');
  g.setVolumes([{ p: [3, 0.6, 2], r: 2.5, density: 0.3, frost: 0.5, ground: true }]);
  assert.equal(g.rows.value.y, 1, 'one volume');
  const row = g.dims.value.w;
  assert.equal(THREE.DataUtils.fromHalfFloat(img.data[(row * img.width) * 4]), 3);
  assert.ok(Math.abs(THREE.DataUtils.fromHalfFloat(img.data[(row * img.width + 1) * 4]) - 0.3) < 1e-3);
  g.setSpaceParams(2, { mist: 3, frost: 0.5 });
  assert.equal(g.spaceParams(2).mist, 3);
  const pr = g.rows.value.x;
  assert.equal(THREE.DataUtils.fromHalfFloat(img.data[(pr * img.width + 2) * 4]), 3);
});

test('splat weight: smooth, windowed at the range, monotonic', () => {
  assert.equal(splatWeight(100, 0, 9), 0);
  assert.ok(splatWeight(0, 1.9, 9) > splatWeight(4, 1.9, 9));
  assert.ok(splatWeight(4, 1.9, 9) > splatWeight(16, 1.9, 9));
});
