// Env-layout (v1.2): the 4 m van with its stations, on the hub and on 300 seeds x 1-6 players.
// Stations inside the cargo bay and reachable; the console's walkable neighbour (c.x+1, c.y+2) clear; cargo rows 0-2
// walkable; a >= 0.85 m aisle between the wall solids; 6 outdoor spawns; moveCircle keeps players 0.38 m off walls and
// 0.30 m off boxes; the van rect (inVan) covers the full 2 x 4 cargo bay. Run: node --test tests/level/van.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import { PLAYER } from '../../packages/shared/src/constants.ts';
import { ALL_OPEN, buildEdgeGrid, initialDoorOpen, solidBoxesOf } from '../../packages/shared/src/nav/grid.ts';
import { WALL_PAD, moveCircle } from '../../packages/shared/src/collide/index.ts';
import { generateFacility, generateHub, validateLayout } from '../../packages/shared/src/procgen/index.ts';
import { HUB } from '../../packages/shared/src/procgen/hub.ts';
import { HALF_T, reachAroundSolids } from '../../packages/shared/src/procgen/place.ts';
import { VAN_CARGO_L, VAN_CARGO_W, VAN_LEN, plannedRecordsBoard, plannedVanStations, stationOf, stationsOf } from '../../packages/shared/src/procgen/van.ts';
import type { StationKind } from '../../packages/shared/src/procgen/van.ts';
import { mirrorsOf } from '../../packages/shared/src/procgen/mirrors.ts';

const SEEDS = Number(process.env.SEEDS ?? 300);
const R = PLAYER.radius;

function vanErrors(L: LevelLayout): string[] {
  const errs: string[] = [];
  const e = (m: string) => { if (errs.length < 12) errs.push(`${L.seed}: ${m}`); };
  const c = L.van.cab, W = L.W;
  if (c.w !== VAN_CARGO_W || c.h !== VAN_CARGO_L || VAN_CARGO_L !== 4 || VAN_LEN !== 6) e(`cargo ${c.w}x${c.h}`);
  const vanSpace = L.owner[c.y * W + c.x];
  if (L.spaces[vanSpace]?.type !== 'van') e('no van space');
  for (let y = c.y; y < c.y + VAN_LEN; y++) for (let x = c.x; x < c.x + c.w; x++) {
    const want = y < c.y + VAN_CARGO_L ? vanSpace : -1;
    if (L.owner[y * W + x] !== want) e(`cell ${x},${y} owner ${L.owner[y * W + x]}`);
  }
  // inVan: the cab rect covers the whole cargo bay
  if (!(c.x === L.spaces[vanSpace].rect.x && c.y === L.spaces[vanSpace].rect.y && L.spaces[vanSpace].rect.w === 2 && L.spaces[vanSpace].rect.h === 4)) e('van rect');
  // stations: all present (real, not virtual) at the planned spots, inside the cargo bay
  const kinds: StationKind[] = ['console', 'leave_lever', 'deposit', 'workbench', 'stash', 'booklet', 'charger', 'mirror'];
  for (const k of kinds) {
    const st = stationOf(L, k);
    if (!st || st.virtual) { e(`station ${k} missing`); continue; }
    if (st.space !== vanSpace) e(`station ${k} not in the van space`);
    if (st.x < c.x || st.x > c.x + c.w || st.z < c.y || st.z > c.y + c.h) e(`station ${k} outside the cargo bay`);
  }
  for (const sp of plannedVanStations(c)) {
    const st = stationOf(L, sp.kind)!;
    if (st && (st.x !== sp.x || st.z !== sp.z || st.y !== sp.y || st.rot !== sp.rot)) e(`station ${sp.kind} off its planned spot`);
  }
  if (stationsOf(L).filter((s) => s.space === vanSpace).length !== kinds.length) e('extra van stations');
  // wall solids <= 0.30 m deep; their +0.1 m validator margin never covers the cell centres c.x+0.5 / c.x+1.5
  const boxes = solidBoxesOf(L.items.filter((it) => it.space === vanSpace && it.kind === 'prop'));
  for (let b = 0; b < boxes.length / 4; b++) {
    const [x0, z0, x1, z1] = boxes.slice(b * 4, b * 4 + 4);
    if (x1 - x0 > 0.3 + 1e-9) e(`van wall solid ${x1 - x0} m deep`);
    for (const cx of [c.x + 0.5, c.x + 1.5]) if (cx > x0 - 0.1 && cx < x1 + 0.1) e(`solid margin covers x=${cx}`);
    if (z0 < c.y || z1 > c.y + c.h) e('van solid outside the bay');
  }
  // cargo rows 0-2 walkable, the console's neighbour (c.x+1, c.y+2) included, reachable from the crew spawn
  const g = buildEdgeGrid(L);
  const sp0 = L.items.find((it) => it.kind === 'spawn_player')!;
  const seen = reachAroundSolids(g, Math.floor(sp0.z) * W + Math.floor(sp0.x));
  for (let y = c.y; y < c.y + 3; y++) for (let x = c.x; x < c.x + 2; x++) if (!seen[y * W + x]) e(`cargo cell ${x - c.x},${y - c.y} not walkable`);
  // aisle: free width between the left and right wall solids at every z slice in front of the console
  const con = L.items.find((it) => it.kind === 'console')!;
  const cz0 = con.z - Number(con.data?.d ?? 0.55) / 2;
  for (let z = c.y + 0.05; z < cz0; z += 0.05) {
    let lo = c.x + HALF_T, hi = c.x + c.w - HALF_T;
    for (let b = 0; b < boxes.length / 4; b++) {
      const [x0, z0, x1, z1] = boxes.slice(b * 4, b * 4 + 4);
      if (z < z0 || z > z1) continue;
      if (x0 - c.x < c.w / 2) lo = Math.max(lo, x1); else hi = Math.min(hi, x0);
    }
    if (hi - lo < 0.85) { e(`aisle ${(hi - lo).toFixed(2)} m at z=${(z - c.y).toFixed(2)}`); break; }
  }
  // spawns: 6, outdoors, free
  const spawns = L.items.filter((it) => it.kind === 'spawn_player');
  if (spawns.length !== 6) e(`spawns x${spawns.length}`);
  for (const s of spawns) if (!L.spaces[s.space]?.open) e(`spawn ${s.id} indoors`);
  // van mirror: one, kind van
  if (mirrorsOf(L).filter((m) => m.kind === 'van').length !== 1) e('van mirrors');
  return errs;
}

test('hub: the van, its stations, the mirror inside, the board clear of the body, the records board', () => {
  const H = generateHub();
  assert.deepEqual(validateLayout(H).errors, []);
  assert.deepEqual(vanErrors(H), []);
  const mirror = H.items.filter((it) => it.kind === 'mirror');
  assert.equal(mirror.length, 1, 'exactly one kind mirror item (Change your look)');
  assert.equal(mirror[0].space, H.metrics.vanSpace);
  assert.equal(stationOf(H, 'mirror')!.itemId, mirror[0].id);
  const board = H.items.find((it) => it.kind === 'board')!;
  assert.equal(board.x, HUB.van.x0 + 2.55);
  // board box (SOLID_ITEMS board 1.6 x 0.3, rotated) clears a 2.2 m van body
  assert.ok(board.x - 0.15 >= HUB.van.x0 + 1 + 1.1 + 0.25, 'board clear of the van body');
  const rec = stationOf(H, 'records')!;
  assert.ok(rec && !rec.virtual, 'records board is a real station');
  const door = H.items.find((it) => it.kind === 'prop' && it.data?.prop === 'entrance_door')!;
  const plan = plannedRecordsBoard(door);
  assert.deepEqual([rec.x, rec.y, rec.z, rec.rot], [plan.x, plan.y, plan.z, plan.rot]);
  assert.equal(H.items.find((it) => it.id === rec.itemId)?.data?.prop, 'noticeboard');
  // no virtual stations left anywhere
  assert.ok(stationsOf(H).every((s) => !s.virtual));
});

test('moveCircle: 0.38 m off the van walls, 0.30 m off the station boxes, the console stops you', () => {
  const L = generateFacility({ seed: 'van-collide', players: 2, risk: 1 });
  const g = buildEdgeGrid(L);
  const open = initialDoorOpen(L);
  const c = L.van.cab;
  const wb = stationOf(L, 'workbench')!, st = stationOf(L, 'stash')!;
  // row 0 (no furniture): the right wall stops you at R + WALL_PAD
  const toWall = moveCircle(g, [c.x + 1, c.y + 0.5], [3, 0], R, open);
  assert.ok(Math.abs(toWall[0] - (c.x + 2 - R - WALL_PAD)) < 1e-3, `right wall: ${toWall}`);
  assert.ok(Math.abs(R + WALL_PAD - 0.38) < 1e-9);
  // the workbench (right wall, z c.y+1.55..2.85) stops you R from its face
  const toBench = moveCircle(g, [c.x + 1, wb.z], [3, 0], R, open);
  assert.ok(Math.abs(toBench[0] - (wb.x - wb.d / 2 - R)) < 1e-3, `workbench: ${toBench}`);
  // the stash (left wall) likewise
  const toStash = moveCircle(g, [c.x + 1, st.z], [-3, 0], R, open);
  assert.ok(Math.abs(toStash[0] - (st.x + st.d / 2 + R)) < 1e-3, `stash: ${toStash}`);
  // walking in through the rear opening ends at the console
  const con = L.items.find((it) => it.kind === 'console')!;
  const walk = moveCircle(g, [c.x + 1, c.y - 1], [0, 6], R, ALL_OPEN);
  assert.ok(Math.abs(walk[1] - (con.z - 0.275 - R)) < 1e-3 && walk[0] > c.x + 0.6 && walk[0] < c.x + 1.4, `console: ${walk}`);
});

test(`facility vans: ${SEEDS} seeds x 1-6 players`, () => {
  const failures: string[] = [];
  for (let i = 0; i < SEEDS; i++) {
    const players = 1 + (i % 6);
    const L = generateFacility({ seed: `van${i}`, players, risk: 1 + (i % 3) });
    failures.push(...vanErrors(L));
    if (failures.length > 20) break;
  }
  assert.deepEqual(failures.slice(0, 20), []);
});
