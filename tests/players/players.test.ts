// Track ⑤ Players unit tests: no Ctrl/Meta bindings anywhere in the client, edge-grid collision (no wall
// penetration, sliding, closed vs open doors), ray march, server noise bus.
//   node --test tests/players/players.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { generateFacility } from '../../packages/shared/src/procgen/index.ts';
import { buildEdgeGrid, initialDoorOpen, ALL_CLOSED, ALL_OPEN, EDGE } from '../../packages/shared/src/nav/index.ts';
import { PLAYER } from '../../packages/shared/src/constants.ts';
import { moveCircleGrid, rayGrid } from '../../apps/client/src/players/collide.ts';
import { emitNoise, onNoise } from '../../apps/server/src/players/noise.ts';
import type { Crew } from '../../apps/server/src/core/types.ts';

const ROOT = join(import.meta.dirname, '../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(n)) out.push(p);
  }
  return out;
}

test('no client handler reads ctrlKey/metaKey (Ctrl+W closes the tab)', () => {
  const hits: string[] = [];
  for (const f of walk(join(ROOT, 'apps/client/src'))) {
    readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
      if (/\b(ctrlKey|metaKey)\b/.test(line)) hits.push(`${f}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, []);
});

test('players input binds crouch to C and never to Control', () => {
  const src = readFileSync(join(ROOT, 'apps/client/src/players/input.ts'), 'utf8');
  assert.match(src, /'KeyC'/);
  assert.doesNotMatch(src, /'Control(Left|Right)'/);
  assert.doesNotMatch(src, /'Meta(Left|Right)'/);
});

const L = generateFacility({ seed: 'players-unit', players: 2, risk: 1 });
const g = buildEdgeGrid(L);

function findWallCell(): { cx: number; cz: number } {
  for (let cz = 1; cz < g.H - 1; cz++) {
    for (let cx = 1; cx < g.W - 1; cx++) {
      const own = g.owner[cz * g.W + cx];
      if (own < 0 || g.spaces[own]?.open || g.owner[cz * g.W + cx - 1] !== own) continue;
      if (g.v[cz * (g.W + 1) + cx + 1] === EDGE.wall && g.v[cz * (g.W + 1) + cx] === EDGE.free && g.solidStart[cz * g.W + cx] === g.solidStart[cz * g.W + cx + 1]) return { cx, cz };
    }
  }
  throw new Error('no wall cell');
}

test('walking into a wall never penetrates it (including big dt steps)', () => {
  const { cx, cz } = findWallCell();
  let x = cx + 0.5, z = cz + 0.5;
  for (let i = 0; i < 60; i++) [x, z] = moveCircleGrid(g, x, z, 0.4, 0, PLAYER.radius, ALL_OPEN);
  assert.ok(x <= cx + 1 - PLAYER.radius + 1e-6, `x=${x}`);
  assert.ok(x > cx + 1 - PLAYER.radius - 0.02, 'slid up to the wall');
});

test('diagonal motion slides along a wall', () => {
  const { cx, cz } = findWallCell();
  const [x, z] = moveCircleGrid(g, cx + 0.5, cz + 0.5, 1.0, 0.3, PLAYER.radius, ALL_OPEN);
  assert.ok(x <= cx + 1 - PLAYER.radius + 1e-6);
  assert.ok(Math.abs(z - (cz + 0.5)) > 0.05, 'kept the tangential component');
});

test('closed doors block, open doors pass', () => {
  const d = L.doors.find((dd) => dd.kind === 'door' && dd.dir === 'v' && dd.a >= 0 && dd.b >= 0);
  assert.ok(d, 'a vertical door');
  const zMid = d.y + 0.5;
  const start = d.x - 0.6;
  const [xc] = moveCircleGrid(g, start, zMid, 1.5, 0, PLAYER.radius, ALL_CLOSED);
  assert.ok(xc <= d.x - PLAYER.radius + 1e-6, `closed door blocks (x=${xc})`);
  const [xo] = moveCircleGrid(g, start, zMid, 1.5, 0, PLAYER.radius, ALL_OPEN);
  assert.ok(xo > d.x + 0.5, `open door passes (x=${xo})`);
  void initialDoorOpen;
});

test('ray march stops at walls and floors', () => {
  const { cx, cz } = findWallCell();
  const r = rayGrid(g, [cx + 0.5, 1.5, cz + 0.5], [1, 0, 0], 20, 3, ALL_OPEN);
  assert.equal(r.hit, 'wall');
  assert.ok(r.p[0] < cx + 1 && r.p[0] > cx + 0.7, `wall hit x=${r.p[0]}`);
  const f = rayGrid(g, [cx + 0.5, 1.5, cz + 0.5], [0, -1, 0], 20, 3, ALL_OPEN);
  assert.equal(f.hit, 'floor');
});

test('noise bus delivers footsteps to subscribers', () => {
  const crew = { code: 'TEST', slices: {} } as unknown as Crew;
  const got: string[] = [];
  const off = onNoise((_c, n) => got.push(`${n.kind}:${n.radiusM}`));
  emitNoise(crew, { x: 1, z: 2, radiusM: 5, kind: 'walkStep', source: 'p1' });
  emitNoise(crew, { x: 1, z: 2, radiusM: 0, kind: 'bogus', source: 'p1' }); // ignored (no radius)
  off();
  emitNoise(crew, { x: 1, z: 2, radiusM: 12, kind: 'sprintStep', source: 'p1' });
  assert.deepEqual(got, ['walkStep:5']);
});
