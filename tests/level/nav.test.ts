// Track ② Level: edge-grid navigation unit tests + flood perf check. Run: node --test tests/level/nav.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LayoutDoor, LayoutSpace, LevelLayout } from '../../packages/shared/src/layout.ts';
import { PATH } from '../../packages/shared/src/constants.ts';
import {
  ALL_CLOSED, ALL_OPEN, Audibility, EDGE, astar, buildEdgeGrid, canWalk, floodCells, initialDoorOpen, los,
  pathDistance, pathDistanceField, soundFlood, spaceAt, spaceLinks, walkClear,
} from '../../packages/shared/src/nav/index.ts';

const space = (id: number, x: number, y: number, w: number, h: number, open = false, type = 'room'): LayoutSpace =>
  ({ id, kind: open ? 'outside' : 'room', rect: { x, y, w, h }, zone: 0, type, callsign: null, dist: 0, light: 'on', open, powerZone: 0 });
const door = (id: number, a: number, b: number, x: number, y: number, dir: 'v' | 'h', len: number, kind: LayoutDoor['kind'] = 'door', initiallyOpen = false): LayoutDoor =>
  ({ id, a, b, x, y, dir, len, kind, lock: 0, initiallyOpen });
function grid(W: number, H: number, spaces: LayoutSpace[], doors: LayoutDoor[]) {
  const owner = new Array<number>(W * H).fill(-1);
  for (const s of spaces) for (let y = s.rect.y; y < s.rect.y + s.rect.h; y++) for (let x = s.rect.x; x < s.rect.x + s.rect.w; x++) owner[y * W + x] = s.id;
  return { W, H, owner, spaces, doors };
}
const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) < eps;

// two 4x3 rooms side by side, wall on x=4 with a 1-wide door at y=1
const twoRooms = () => grid(8, 3, [space(0, 0, 0, 4, 3), space(1, 4, 0, 4, 3)], [door(0, 0, 1, 4, 1, 'v', 1)]);

test('edge codes: walls between spaces, door edges, boundary', () => {
  const g = buildEdgeGrid(twoRooms());
  const W1 = 9;
  assert.equal(g.v[0 * W1 + 4], EDGE.wall);
  assert.equal(g.v[1 * W1 + 4], EDGE.door);
  assert.equal(g.vDoor[1 * W1 + 4], 0);
  assert.equal(g.v[2 * W1 + 4], EDGE.wall);
  assert.equal(g.v[1 * W1 + 2], EDGE.free);
  assert.equal(g.v[1 * W1 + 0], EDGE.wall, 'indoor grid boundary is a wall');
  assert.equal(g.h[0 * 8 + 1], EDGE.wall);
  assert.equal(spaceAt(g, 5.5, 1.2), 1);
  assert.equal(canWalk(g, 3, 1, 0, ALL_CLOSED), false);
  assert.equal(canWalk(g, 3, 1, 0, ALL_OPEN), true);
  assert.equal(canWalk(g, 3, 0, 0, ALL_OPEN), false);
});

test('fences: between outdoor spaces and around outdoor grid edges; sight + sound pass, walking blocked', () => {
  const L = grid(6, 2, [space(0, 0, 0, 3, 2, true), space(1, 3, 0, 3, 2, true)], []);
  const g = buildEdgeGrid(L);
  assert.equal(g.v[0 * 7 + 3], EDGE.fence);
  assert.equal(g.v[0 * 7 + 0], EDGE.fence, 'outdoor grid boundary is a fence');
  assert.equal(walkClear(g, 1.5, 0.5, 4.5, 0.5, ALL_OPEN), false);
  assert.equal(los(g, 1.5, 0.5, 4.5, 0.5, ALL_OPEN), true);
  const f = soundFlood(g, 1.5, 0.5, 10, ALL_OPEN);
  assert.ok(near(f[0 * 6 + 4], 3), `sound through fence ${f[4]}`);
  const w = floodCells(g, [1], { mode: 'walk', doorOpen: ALL_OPEN });
  assert.equal(w[4], Infinity);
  const links = spaceLinks(L);
  assert.deepEqual(links[0].map((l) => [l.other, l.kind]), [[1, 'fence']]);
});

test('octile metric: diagonal sqrt2 in open space, orthogonal only around corners and through doors', () => {
  const open = buildEdgeGrid(grid(5, 5, [space(0, 0, 0, 5, 5)], []));
  const f = pathDistanceField(open, 0.5, 0.5, { doorOpen: ALL_OPEN });
  assert.ok(near(f[4 * 5 + 4], 4 * PATH.diag), `got ${f[24]}`);
  assert.ok(near(f[4 * 5 + 2], 2 * PATH.diag + 2), `got ${f[22]}`);
  // door crossing is orthogonal (+1 open / +6 closed), never diagonal
  const g = buildEdgeGrid(twoRooms());
  const dOpen = floodCells(g, [1 * 8 + 3], { mode: 'sound', doorOpen: ALL_OPEN });
  assert.ok(near(dOpen[1 * 8 + 4], 1 + PATH.doorOpenCost));
  assert.ok(near(dOpen[0 * 8 + 4], 1 + PATH.doorOpenCost + 1), 'no diagonal through the door jamb');
  const dClosed = floodCells(g, [1 * 8 + 3], { mode: 'sound', doorOpen: ALL_CLOSED });
  assert.ok(near(dClosed[1 * 8 + 4], 1 + PATH.doorClosedCost));
  const walkClosed = floodCells(g, [1 * 8 + 3], { mode: 'walk', doorOpen: ALL_CLOSED });
  assert.equal(walkClosed[1 * 8 + 4], Infinity, 'walk: closed door blocks');
  const walkOpenable = floodCells(g, [1 * 8 + 3], { mode: 'walk', doorOpen: ALL_CLOSED, canOpen: ALL_OPEN });
  assert.ok(near(walkOpenable[1 * 8 + 4], 1 + PATH.doorClosedCost), 'walk: openable closed door costs +6');
  // budget
  const b = soundFlood(g, 0.5, 0.5, 3, ALL_OPEN);
  assert.equal(b[1 * 8 + 4], Infinity);
  assert.ok(Number.isFinite(b[1 * 8 + 2]));
});

test('A* matches the flood and returns a connected path', () => {
  const L = JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/layouts/facility_s2_p4.json'), 'utf8')) as LevelLayout;
  const g = buildEdgeGrid(L);
  const open = initialDoorOpen(L);
  const sp = L.items.find((i) => i.kind === 'spawn_player')!;
  const core = L.items.find((i) => i.kind === 'core')!;
  const field = pathDistanceField(g, sp.x, sp.z, { mode: 'walk', doorOpen: ALL_OPEN });
  const r = astar(g, sp.x, sp.z, core.x, core.z, { doorOpen: ALL_OPEN });
  assert.ok(r, 'core reachable with all doors open');
  const target = Math.floor(core.z) * L.W + Math.floor(core.x);
  assert.ok(near(r!.cost, field[target], 1e-3), `astar ${r!.cost} vs flood ${field[target]}`);
  for (let i = 1; i < r!.cells.length; i++) {
    const a = r!.cells[i - 1], b = r!.cells[i];
    const dx = Math.abs((a % L.W) - (b % L.W)), dy = Math.abs(Math.floor(a / L.W) - Math.floor(b / L.W));
    assert.ok(dx <= 1 && dy <= 1 && dx + dy > 0, 'steps are 8-neighbour');
  }
  // vault door initially closed -> walking agents can't reach the core without opening it
  assert.equal(astar(g, sp.x, sp.z, core.x, core.z, { doorOpen: open }), null);
  assert.ok(astar(g, sp.x, sp.z, core.x, core.z, { doorOpen: open, canOpen: ALL_OPEN }));
  const sd = pathDistance(g, sp.x, sp.z, core.x, core.z, { doorOpen: open });
  assert.ok(Number.isFinite(sd), 'sound passes closed doors (with extra cost)');
  const sOpen = pathDistance(g, sp.x, sp.z, core.x, core.z, { doorOpen: ALL_OPEN });
  assert.ok(sOpen <= field[target] + 1e-3, 'sound metric never longer than walking (it also passes rubble/fences)');
});

test('LOS: walls and closed doors block, open doors pass, corners are conservative', () => {
  const g = buildEdgeGrid(twoRooms());
  assert.equal(los(g, 2.5, 1.5, 6.5, 1.5, ALL_OPEN), true);
  assert.equal(los(g, 2.5, 1.5, 6.5, 1.5, ALL_CLOSED), false);
  assert.equal(los(g, 2.5, 0.5, 6.5, 0.5, ALL_OPEN), false);
  assert.equal(los(g, 0.5, 0.5, 3.5, 2.5, ALL_OPEN), true);
  assert.equal(los(g, 3.5, 0.5, 4.5, 1.5, ALL_OPEN), false, 'exact vertex crossing past a wall corner is blocked');
});

test('audibility: symmetric path distance, sealed van cab, caching', () => {
  // lot (outdoor) with a van cab space connected by an open rear doorway
  const L = grid(8, 6, [space(0, 0, 0, 8, 6, true, 'lot'), space(1, 3, 2, 2, 3, false, 'van')], [door(0, 0, 1, 3, 2, 'h', 2, 'open', true)]);
  L.owner = L.owner.map((o, c) => ((c % 8 >= 3 && c % 8 < 5 && Math.floor(c / 8) >= 2 && Math.floor(c / 8) < 5) ? 1 : o === 1 ? 0 : o));
  const g = buildEdgeGrid(L);
  const cab = { x: 3, y: 2, w: 2, h: 3 };
  const aud = new Audibility(g, { sealed: [cab] });
  const pts = [{ id: 'in1', x: 3.5, z: 3.5 }, { id: 'in2', x: 4.5, z: 4.5 }, { id: 'out', x: 3.5, z: 0.5 }, { id: 'far', x: 7.5, z: 5.5 }];
  const m = aud.matrix(pts, pts, ALL_OPEN);
  assert.equal(m.in1.out, 255, 'cab -> outside sealed');
  assert.equal(m.out.in1, 255, 'outside -> cab sealed');
  assert.ok(m.in1.in2 <= 2, 'inside the cab: audible');
  assert.equal(m.out.far, m.far.out, 'symmetric');
  assert.ok(m.out.far >= 5 && m.out.far < 255);
  const n = aud.floods;
  aud.matrix(pts, pts, ALL_OPEN);
  assert.equal(aud.floods, n, 'cached while nobody changed cell');
  aud.doorsChanged();
  aud.matrix(pts, pts, ALL_OPEN);
  assert.ok(aud.floods > n, 'door change invalidates');
});

test('perf: one sound flood on the 6-player fixture < 1 ms; audibility 6x6 < 2 ms', () => {
  const L = JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/layouts/facility_s3_p6.json'), 'utf8')) as LevelLayout;
  const g = buildEdgeGrid(L);
  const open = initialDoorOpen(L);
  const cells: number[] = [];
  for (let c = 0; c < L.W * L.H; c++) if (L.owner[c] >= 0) cells.push(c);
  const out = new Float32Array(L.W * L.H);
  for (let i = 0; i < 50; i++) floodCells(g, [cells[(i * 97) % cells.length]], { doorOpen: open }, out);
  const N = 400;
  let t0 = performance.now();
  for (let i = 0; i < N; i++) floodCells(g, [cells[(i * 7919) % cells.length]], { mode: 'sound', doorOpen: open }, out);
  const fullMs = (performance.now() - t0) / N;
  t0 = performance.now();
  for (let i = 0; i < N; i++) soundFlood(g, (cells[(i * 7919) % cells.length] % L.W) + 0.5, Math.floor(cells[(i * 7919) % cells.length] / L.W) + 0.5, 35, open, out);
  const budgetMs = (performance.now() - t0) / N;
  const aud = new Audibility(g, { sealed: [L.van.cab] });
  const pts = L.items.filter((i) => i.kind === 'loot').slice(0, 6).map((it, k) => ({ id: `p${k}`, x: it.x, z: it.z }));
  t0 = performance.now();
  for (let i = 0; i < 50; i++) { aud.doorsChanged(); aud.matrix(pts, pts, open); }
  const audMs = (performance.now() - t0) / 50;
  console.log(JSON.stringify({ W: L.W, H: L.H, fullFloodMs: +fullMs.toFixed(3), flood35Ms: +budgetMs.toFixed(3), aud6x6Ms: +audMs.toFixed(3) }));
  assert.ok(fullMs < 1, `full flood ${fullMs} ms`);
  assert.ok(budgetMs < 1, `35 m flood ${budgetMs} ms`);
  assert.ok(audMs < 2, `audibility ${audMs} ms`);
});
