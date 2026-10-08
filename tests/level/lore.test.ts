// Env-layout (v1.2): lore spots. 3-6 wall holders per facility (one per room, never the lobby / vault / van or a room
// with a clue note, at 1.45-1.6 m on a free, reachable wall cell) + 1-2 drawer spots on containers; none in the hub.
// Deterministic and stable: loreSpotsOf derives from the layout only. Run: node --test tests/level/lore.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateFacility, generateHub } from '../../packages/shared/src/procgen/index.ts';
import { LORE_DIMS, loreSpotsOf } from '../../packages/shared/src/procgen/lore.ts';
import { containersOf } from '../../packages/shared/src/procgen/containers.ts';
import { normalOfYaw } from '../../packages/shared/src/procgen/common.ts';

const SEEDS = Number(process.env.SEEDS ?? 60);

test('hub has no lore spots; loreSpotsOf is deterministic and memoised', () => {
  assert.deepEqual(loreSpotsOf(generateHub()), []);
  const L = generateFacility({ seed: 'lore-det', players: 3, risk: 1 });
  const a = loreSpotsOf(L);
  assert.equal(loreSpotsOf(L), a);
  assert.equal(JSON.stringify(loreSpotsOf(JSON.parse(JSON.stringify(L)))), JSON.stringify(a));
});

test(`lore spots: ${SEEDS} seeds x 1-6 players`, () => {
  const fails: string[] = [];
  const styles: Record<string, number> = {};
  for (let i = 0; i < SEEDS; i++) {
    const players = 1 + (i % 6);
    const L = generateFacility({ seed: `lore${i}`, players, risk: 1 + (i % 3) });
    const spots = loreSpotsOf(L);
    const wall = spots.filter((s) => s.style !== 'drawer'), drawers = spots.filter((s) => s.style === 'drawer');
    if (wall.length < 3 || wall.length > 6) fails.push(`${L.seed}: ${wall.length} wall spots`);
    if (drawers.length < 1 || drawers.length > 2) fails.push(`${L.seed}: ${drawers.length} drawer spots`);
    if (L.metrics.lore !== wall.length) fails.push(`${L.seed}: metrics.lore`);
    const idx = spots.map((s) => s.idx);
    if (new Set(idx).size !== idx.length || idx.some((v, k) => v !== k)) fails.push(`${L.seed}: idx ${idx}`);
    const noteRooms = new Set(L.items.filter((it) => it.kind === 'note').map((it) => it.space));
    const rooms = new Set<number>();
    for (const s of wall) {
      const sp = L.spaces[s.space];
      styles[s.style] = (styles[s.style] ?? 0) + 1;
      if (sp.kind !== 'room' && sp.kind !== 'hall') fails.push(`${L.seed} ${s.id}: in a ${sp.kind}`);
      if (['lobby', 'vault', 'van'].includes(sp.type) || sp.id === L.entrance) fails.push(`${L.seed} ${s.id}: in the ${sp.type}`);
      if (noteRooms.has(s.space)) fails.push(`${L.seed} ${s.id}: room has a clue note`);
      if (rooms.has(s.space)) fails.push(`${L.seed} ${s.id}: second spot in the room`);
      rooms.add(s.space);
      if (!(s.y >= 1.45 && s.y <= 1.6)) fails.push(`${L.seed} ${s.id}: y ${s.y}`);
      const it = L.items.find((x) => x.id === s.id)!;
      if (it.data?.prop !== `lore_${s.style}` || it.data?.solid !== false) fails.push(`${L.seed} ${s.id}: item data`);
      const dim = LORE_DIMS[s.style as keyof typeof LORE_DIMS];
      if (!dim || it.data?.w !== dim.w || dim.w > 0.9) fails.push(`${L.seed} ${s.id}: dims`);
      // the aim point is in front of the holder, inside the room
      const [nx, nz] = normalOfYaw(s.rot);
      if (Math.abs(s.p[0] - s.x - nx * (dim.d / 2 + 0.02)) > 1e-3 || Math.abs(s.p[2] - s.z - nz * (dim.d / 2 + 0.02)) > 1e-3) fails.push(`${s.id}: aim point`);
      if (L.owner[Math.floor(s.p[2]) * L.W + Math.floor(s.p[0])] !== s.space) fails.push(`${s.id}: aim point outside the room`);
    }
    const cont = new Map(containersOf(L).map((c) => [c.id, c]));
    for (const d of drawers) {
      const c = cont.get(d.container ?? '');
      if (!c || d.id !== c.id || d.part !== c.main) fails.push(`${L.seed} ${d.id}: drawer spot not on a container main part`);
      if (noteRooms.has(d.space) || L.spaces[d.space].type === 'lobby') fails.push(`${L.seed} ${d.id}: drawer room`);
    }
    if (fails.length > 12) break;
  }
  console.log(JSON.stringify(styles));
  assert.deepEqual(fails.slice(0, 12), []);
});
