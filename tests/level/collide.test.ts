// Track ② Level: circle-vs-edge-grid collision. Run: node --test tests/level/collide.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LayoutDoor, LayoutSpace, LevelLayout } from '../../packages/shared/src/layout.ts';
import { PLAYER } from '../../packages/shared/src/constants.ts';
import { ALL_CLOSED, ALL_OPEN, buildEdgeGrid, initialDoorOpen } from '../../packages/shared/src/nav/index.ts';
import { WALL_PAD, circleFree, crossesWall, moveCircle, validateMove } from '../../packages/shared/src/collide/index.ts';

const R = PLAYER.radius;
const space = (id: number, x: number, y: number, w: number, h: number, open = false): LayoutSpace =>
  ({ id, kind: open ? 'outside' : 'room', rect: { x, y, w, h }, zone: 0, type: 'room', callsign: null, dist: 0, light: 'on', open, powerZone: 0 });
function layout(W: number, H: number, spaces: LayoutSpace[], doors: LayoutDoor[]) {
  const owner = new Array<number>(W * H).fill(-1);
  for (const s of spaces) for (let y = s.rect.y; y < s.rect.y + s.rect.h; y++) for (let x = s.rect.x; x < s.rect.x + s.rect.w; x++) owner[y * W + x] = s.id;
  return { W, H, owner, spaces, doors };
}
// two 4x4 rooms, wall on x=4 with a door at y=1..2 (len 1 at y=1)
const g = buildEdgeGrid(layout(8, 4, [space(0, 0, 0, 4, 4), space(1, 4, 0, 4, 4)],
  [{ id: 0, a: 0, b: 1, x: 4, y: 1, dir: 'v', len: 1, kind: 'door', lock: 0, initiallyOpen: false }]));
const stop = R + WALL_PAD;

test('wall stops the circle at radius + half wall thickness and slides along it', () => {
  const p = moveCircle(g, [2, 3], [3, 0], R, ALL_OPEN);
  assert.ok(Math.abs(p[0] - (4 - stop)) < 1e-3, `x ${p[0]}`);
  assert.ok(Math.abs(p[1] - 3) < 1e-6, 'no drift when pushing straight');
  const s = moveCircle(g, [3.5, 3.0], [1.0, -0.6], R, ALL_CLOSED);
  assert.ok(s[0] <= 4 - stop + 1e-3 && s[1] < 2.6, `slides along the wall: ${s}`);
});

test('closed doors block, open doors pass; doorway jambs are round', () => {
  const blocked = moveCircle(g, [2, 1.5], [4, 0], R, ALL_CLOSED);
  assert.ok(blocked[0] < 4, `closed door blocks: ${blocked}`);
  const through = moveCircle(g, [2, 1.5], [4, 0], R, ALL_OPEN);
  assert.ok(through[0] > 5.9, `open door passes: ${through}`);
  // entering slightly off-centre gets nudged into the opening, not stuck
  const nudged = moveCircle(g, [2, 1.3], [4, 0], R, ALL_OPEN);
  assert.ok(nudged[0] > 5.5, `off-centre entry slides through: ${nudged}`);
  assert.equal(crossesWall(g, 2, 1.5, 6, 1.5, ALL_CLOSED), true);
  assert.equal(crossesWall(g, 2, 1.5, 6, 1.5, ALL_OPEN), false);
  assert.equal(crossesWall(g, 2, 0.5, 6, 0.5, ALL_OPEN), true);
});

test('fast moves never tunnel; validateMove rejects wall crossings', () => {
  const p = moveCircle(g, [3.4, 3.5], [10, 0], R, ALL_OPEN);
  assert.ok(p[0] < 4, `no tunnelling: ${p}`);
  const bad = validateMove(g, [3.4, 3.5], [4.6, 3.5], R, ALL_OPEN);
  assert.equal(bad.ok, false);
  assert.ok(bad.p[0] < 4);
  const good = validateMove(g, [1.5, 1.5], [2.0, 1.6], R, ALL_OPEN);
  assert.equal(good.ok, true);
  assert.equal(circleFree(g, 2, 2, R, ALL_OPEN), true);
  assert.equal(circleFree(g, 3.8, 2, R, ALL_OPEN), false);
});

test('fixture: van walls, solids (lockers/console), fence and rubble all block; spawns are free', () => {
  const L = JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/layouts/facility_s1_p2.json'), 'utf8')) as LevelLayout;
  const fg = buildEdgeGrid(L);
  const open = initialDoorOpen(L);
  for (const sp of L.items.filter((i) => i.kind === 'spawn_player')) assert.ok(circleFree(fg, sp.x, sp.z, R, open), `spawn ${sp.id} free`);
  const cab = L.van.cab;
  // walk from outside into the van's side wall: blocked
  const side = moveCircle(fg, [cab.x - 1.2, cab.y + 1.5], [2, 0], R, open);
  assert.ok(side[0] < cab.x, `van side wall blocks: ${side}`);
  // walk in through the rear opening: allowed, but the console stops you at the front
  const rear = moveCircle(fg, [cab.x + 1, cab.y - 1], [0, 5], R, open);
  assert.ok(rear[1] > cab.y + 1 && rear[1] < cab.y + cab.h - 0.5, `enter van, stop at console: ${rear}`);
  // lockers are solid
  const locker = L.items.find((i) => i.kind === 'hiding')!;
  assert.equal(circleFree(fg, locker.x, locker.z, R, open), false);
  // lot fence at the grid edge
  const fence = moveCircle(fg, [L.W - 2, L.H - 2], [5, 5], R, open);
  assert.ok(fence[0] < L.W && fence[1] < L.H, `fence blocks: ${fence}`);
  // rubble
  const rub = L.doors.find((d) => d.kind === 'blocked');
  if (rub) {
    const mx = rub.dir === 'v' ? rub.x : rub.x + rub.len / 2, mz = rub.dir === 'v' ? rub.y + rub.len / 2 : rub.y;
    const from: [number, number] = rub.dir === 'v' ? [mx - 1, mz] : [mx, mz - 1];
    const p = moveCircle(fg, from, rub.dir === 'v' ? [2, 0] : [0, 2], R, ALL_OPEN);
    assert.ok(rub.dir === 'v' ? p[0] < mx : p[1] < mz, `rubble blocks: ${p}`);
  }
});

test('perf: 10k moveCircle substeps budget', () => {
  const L = JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/layouts/facility_s3_p6.json'), 'utf8')) as LevelLayout;
  const fg = buildEdgeGrid(L);
  const sp = L.items.find((i) => i.kind === 'spawn_player')!;
  let p: [number, number] = [sp.x, sp.z];
  const t0 = performance.now();
  for (let i = 0; i < 10000; i++) p = moveCircle(fg, p, [((i * 37) % 11 - 5) * 0.02, ((i * 53) % 13 - 6) * 0.02], R, ALL_OPEN);
  const ms = performance.now() - t0;
  console.log(JSON.stringify({ moves: 10000, ms: +ms.toFixed(1) }));
  assert.ok(ms < 200, `${ms} ms`);
});
