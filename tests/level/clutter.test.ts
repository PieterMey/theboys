// Track ② Level: cosmetic clutter is deterministic, stays inside its space and never lands on door-front cells,
// solid furniture or cells players must reach. Run: node --test tests/level/clutter.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateFacility, generateHub } from '../../packages/shared/src/procgen/index.ts';
import { clutterFor } from '../../packages/shared/src/procgen/clutter.ts';

test('clutter: deterministic, in its space, clear of doors and interactables', () => {
  for (const players of [2, 4, 6]) for (let i = 0; i < 12; i++) {
    const L = generateFacility({ seed: `clutter${players}-${i}`, players, risk: 1 + (i % 3) });
    const a = clutterFor(L), b = clutterFor(L);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
    assert.ok(a.length > L.metrics.rooms * 4, `only ${a.length} clutter items`);
    const W = L.W;
    const front = new Uint8Array(W * L.H);
    for (const d of L.doors) for (let k = 0; k < d.len; k++) {
      const cells = d.dir === 'v' ? [[d.x - 1, d.y + k], [d.x, d.y + k]] : [[d.x + k, d.y - 1], [d.x + k, d.y]];
      for (const [x, y] of cells) if (x >= 0 && y >= 0 && x < W && y < L.H) front[y * W + x] = 1;
    }
    const reach = new Set(L.items.filter((it) => ['lever', 'keypad', 'switch', 'note', 'intercom', 'keycard', 'core', 'loot', 'vent', 'hiding'].includes(it.kind)).map((it) => Math.floor(it.z) * W + Math.floor(it.x)));
    for (const c of a) {
      if (c.kind === 'tile' || c.kind === 'cable' || c.kind === 'pipe') continue; // under the ceiling
      const cell = Math.floor(c.z) * W + Math.floor(c.x);
      assert.equal(L.owner[cell], c.space, `${c.kind} at ${c.x},${c.z} outside space ${c.space}`);
      if (c.kind === 'poster') continue; // on the wall above
      assert.equal(front[cell], 0, `${c.kind} on a door-front cell (${L.seed})`);
      assert.ok(!reach.has(cell), `${c.kind} on an interactable's cell (${L.seed})`);
    }
  }
  assert.deepEqual(clutterFor(generateHub()), []);
});
