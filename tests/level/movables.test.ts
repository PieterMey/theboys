// Env-layout (v1.2): movableRefsOf lists only non-solid floor GLB props and GLB clutter (never solids, procedural set
// pieces, wall pieces, the van or outdoors), deterministic and memoised; clutter refs index clutterFor(layout).
// Run: node --test tests/level/movables.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateFacility, generateHub } from '../../packages/shared/src/procgen/index.ts';
import { movableRefsOf, movableRefsOfFresh } from '../../packages/shared/src/procgen/movables.ts';
import { clutterFor } from '../../packages/shared/src/procgen/clutter.ts';
import { PROP_DEFS } from '../../packages/shared/src/procgen/decor.ts';

test('movables: non-solid GLB props + GLB clutter, deterministic, in their space', () => {
  const fails: string[] = [];
  let glbTotal = 0;
  for (let i = 0; i < 24; i++) {
    const L = generateFacility({ seed: `mov${i}`, players: 1 + (i % 6), risk: 1 + (i % 3) });
    const M = movableRefsOf(L);
    if (movableRefsOf(L) !== M) fails.push('not memoised');
    if (JSON.stringify(movableRefsOfFresh(JSON.parse(JSON.stringify(L)))) !== JSON.stringify(M)) fails.push(`${L.seed}: nondeterministic`);
    const clutter = clutterFor(L);
    let props = 0, glb = 0;
    for (const m of M) {
      if (!m.key.startsWith('prop.')) fails.push(`${m.ref}: key ${m.key}`);
      const s = L.spaces[m.space];
      if (!s || s.open || s.type === 'van') fails.push(`${m.ref}: in ${s?.type}`);
      if (L.owner[Math.floor(m.z) * L.W + Math.floor(m.x)] !== m.space) fails.push(`${m.ref}: outside its space`);
      if (m.kind === 'prop') {
        props++;
        const it = L.items.find((x) => x.id === m.ref)!;
        const def = PROP_DEFS[String(it?.data?.prop)];
        if (!it || it.data?.solid === true || !def || def.solid || def.proc || def.mount !== 'floor') fails.push(`${m.ref}: not a movable prop`);
        if (m.x !== it.x || m.z !== it.z) fails.push(`${m.ref}: position`);
      } else {
        glb++;
        const c = clutter[Number(m.ref.slice('clutter:'.length))];
        if (!c || c.kind !== 'glb' || `prop.${c.key}` !== m.key || c.x !== m.x || c.z !== m.z) fails.push(`${m.ref}: clutter index`);
      }
    }
    if (!props) fails.push(`${L.seed}: no movable props`);
    glbTotal += glb;
  }
  assert.deepEqual(fails.slice(0, 10), []);
  assert.ok(glbTotal > 24, `only ${glbTotal} GLB clutter movables over 24 sites`);
  assert.deepEqual(movableRefsOf(generateHub()), []);
});
