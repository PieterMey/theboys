// Env-layout (v1.2): mirrors. Every facility has the van mirror plus 2-4 decorative mirrors (guaranteed >= 2), at most
// one per room, never in the vault or van, the floor cell in front free and reachable, kind by room type with the
// lobby / office / showers fallbacks; the hub has exactly its van mirror (the 'Change your look' item).
// Run: node --test tests/level/mirrors.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateFacility, generateHub } from '../../packages/shared/src/procgen/index.ts';
import { MIRROR_DIMS, MIRROR_ROOMS, mirrorsOf } from '../../packages/shared/src/procgen/mirrors.ts';
import { buildEdgeGrid } from '../../packages/shared/src/nav/grid.ts';
import { reachAroundSolids } from '../../packages/shared/src/procgen/place.ts';
import { normalOfYaw } from '../../packages/shared/src/procgen/common.ts';

const SEEDS = Number(process.env.SEEDS ?? 300);

test('hub: one mirror, the van mirror (kind mirror item inside the van)', () => {
  const H = generateHub();
  const m = mirrorsOf(H);
  assert.equal(m.length, 1);
  assert.equal(m[0].kind, 'van');
  assert.equal(H.items.find((it) => it.id === m[0].id)?.kind, 'mirror');
  assert.equal(m[0].space, H.metrics.vanSpace);
});

test(`facility mirrors: ${SEEDS} seeds x 1-6 players (>= 2 decorative)`, () => {
  const fails: string[] = [];
  const kinds: Record<string, number> = {};
  let min = Infinity;
  for (let i = 0; i < SEEDS; i++) {
    const players = 1 + (i % 6);
    const L = generateFacility({ seed: `mir${i}`, players, risk: 1 + (i % 3) });
    const all = mirrorsOf(L);
    const van = all.filter((m) => m.kind === 'van'), deco = all.filter((m) => m.kind !== 'van');
    if (van.length !== 1 || van[0].space !== L.metrics.vanSpace) fails.push(`${L.seed}: van mirror`);
    if (deco.length < 2 || deco.length > 4) fails.push(`${L.seed}: ${deco.length} decorative mirrors`);
    if (L.metrics.mirrors !== deco.length) fails.push(`${L.seed}: metrics.mirrors`);
    min = Math.min(min, deco.length);
    const g = buildEdgeGrid(L);
    const sp = L.items.find((it) => it.kind === 'spawn_player')!;
    const seen = reachAroundSolids(g, Math.floor(sp.z) * L.W + Math.floor(sp.x));
    const rooms = new Set<number>();
    for (const m of deco) {
      kinds[m.kind] = (kinds[m.kind] ?? 0) + 1;
      const s = L.spaces[m.space];
      if (s.kind === 'vault' || s.type === 'van' || s.open || s.kind === 'corridor') fails.push(`${L.seed} ${m.id}: in ${s.kind}/${s.type}`);
      if (rooms.has(m.space)) fails.push(`${L.seed} ${m.id}: second mirror in the room`);
      rooms.add(m.space);
      const want = MIRROR_ROOMS[s.type];
      if (want && m.kind !== want && !(m.kind === 'hand')) fails.push(`${L.seed} ${m.id}: ${m.kind} in a ${s.type}`);
      const dim = MIRROR_DIMS[m.kind];
      if (m.y !== dim.y || m.w !== dim.w || m.h !== dim.h) fails.push(`${L.seed} ${m.id}: dims`);
      const [nx, nz] = normalOfYaw(m.rot);
      const fc = Math.floor(m.z + nz * 0.45) * L.W + Math.floor(m.x + nx * 0.45);
      if (L.owner[fc] !== m.space || !seen[fc]) fails.push(`${L.seed} ${m.id}: front cell not walkable`);
      const it = L.items.find((x) => x.id === m.id)!;
      if (it.kind !== 'prop' || it.data?.solid !== false || it.data?.prop !== `mirror_${m.kind}`) fails.push(`${L.seed} ${m.id}: item`);
    }
    if (fails.length > 12) break;
  }
  console.log(JSON.stringify({ min, kinds }));
  assert.deepEqual(fails.slice(0, 12), []);
});
