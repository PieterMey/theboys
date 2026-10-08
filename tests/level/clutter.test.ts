// Track ② Level: cosmetic clutter is deterministic, stays inside its space and never lands on door-front cells,
// solid furniture or cells players must reach. Run: node --test tests/level/clutter.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateFacility, generateHub } from '../../packages/shared/src/procgen/index.ts';
import { DECAL_CELLS, clutterFor } from '../../packages/shared/src/procgen/clutter.ts';

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
      if (c.kind === 'poster' || (c.kind === 'decal' && !c.tip)) continue; // on the wall above
      assert.equal(front[cell], 0, `${c.kind} on a door-front cell (${L.seed})`);
      assert.ok(!reach.has(cell), `${c.kind} on an interactable's cell (${L.seed})`);
    }
  }
  assert.deepEqual(clutterFor(generateHub()), []);
});

test('v1.2 clutter: themes change mess / wet, mod:damp doubles puddles, decals are appended and well placed', () => {
  const count = (theme: string | undefined, modifiers: string[] | undefined, kind: string) => {
    let n = 0;
    for (let i = 0; i < 16; i++) {
      const L = generateFacility({ seed: `clutterv12-${i}`, players: 1 + (i % 6), risk: 1, theme, modifiers });
      n += clutterFor(L).filter((c) => c.kind === kind).length;
    }
    return n;
  };
  const dry = count('waterworks', undefined, 'puddle'), damp = count('waterworks', ['DAMP'], 'puddle');
  assert.ok(damp > dry * 1.5, `DAMP puddles ${damp} vs ${dry}`);
  assert.ok(count('records', undefined, 'paper') > count('hospitality', undefined, 'paper'), 'records sites are paper-heavy');
  assert.ok(count('baths', undefined, 'puddle') > count('facility', undefined, 'puddle'), 'baths are wet');
  for (const theme of ['facility', 'hospital', 'cold_storage']) {
    const L = generateFacility({ seed: `decal-${theme}`, players: 4, risk: 2, theme, modifiers: ['CLUTTERED'] });
    const all = clutterFor(L);
    const first = all.findIndex((c) => c.kind === 'decal');
    assert.ok(first > 0 && all.slice(first).every((c) => c.kind === 'decal'), 'decals come after every other clutter item');
    const decals = all.slice(first);
    assert.ok(decals.length >= 20 && decals.length <= 140, `${decals.length} decals`);
    for (const d of decals) {
      assert.ok(Number.isInteger(d.a) && d.a >= 0 && d.a < DECAL_CELLS.length && d.b >= DECAL_CELLS[d.a].w * 0.85 - 1e-9 && d.b <= DECAL_CELLS[d.a].w * 1.15 + 1e-9, `decal cell/size ${d.a}/${d.b}`);
      assert.equal(L.owner[Math.floor(d.z) * L.W + Math.floor(d.x)], d.space, 'decal in its space');
      assert.ok(d.tip ? DECAL_CELLS[d.a].surface !== 'wall' : DECAL_CELLS[d.a].surface !== 'floor', 'decal on its surface');
      if (d.tip) assert.ok(d.y < 0.01, 'floor decal on the floor');
      else assert.ok(d.y > 0.2 && d.y < L.wallH, 'wall decal on the wall');
    }
  }
});
