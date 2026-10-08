// env-world: decals from env-layout's atlas (apps/client/src/level/decals.ts):
//   node --test tests/world/decals.test.ts
// Every decal quad stays on its own straight wall run (never over a doorway, never through a corner) or on its own
// floor cells, inside the wall height, with UVs inside its atlas cell; the client merges them into ONE mesh per
// space (no shadows, blended, polygon offset), and the procedural stand-in atlas uses the staged cell layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { generateFacility } from '../../packages/shared/src/procgen/facility.ts';
import { clutterFor, DECAL_CELLS } from '../../packages/shared/src/procgen/clutter.ts';
import { EDGE, buildEdgeGrid, edgeCode } from '../../packages/shared/src/nav/index.ts';
import type { EdgeGrid } from '../../packages/shared/src/nav/index.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import { installDomShim, installLevel } from './harness.ts';

installDomShim();
const { DEFAULT_DECAL_CELLS, decalMaterial, decalParts, decalStats, floorPointOk } = await import('../../apps/client/src/level/decals.ts');

const SITES: LevelLayout[] = [
  generateFacility({ seed: 's2', players: 4, risk: 1 }),
  generateFacility({ seed: 'dw', players: 6, risk: 2, theme: 'waterworks' }),
  generateFacility({ seed: 'dc', players: 6, risk: 1, theme: 'cold_storage' }),
  generateFacility({ seed: 'dh', players: 5, risk: 2, theme: 'hospital' }),
];

/** wall behind (x, z) for an inward normal (nx, nz) is a real wall of `space` at that point along the run */
function onWall(g: EdgeGrid, space: number, x: number, z: number, nx: number, nz: number): boolean {
  const dir = nx > 0.5 ? 1 : nx < -0.5 ? 0 : nz > 0.5 ? 3 : 2;
  const cx = Math.floor(x), cz = Math.floor(z);
  if (cx < 0 || cz < 0 || cx >= g.W || cz >= g.H) return false;
  return g.owner[cz * g.W + cx] === space && edgeCode(g, cx, cz, dir) === EDGE.wall;
}

test('the staged cell table matches env-layout DECAL_CELLS (16 cells, portrait strips stay portrait)', () => {
  assert.equal(DEFAULT_DECAL_CELLS.length, DECAL_CELLS.length);
  for (const [i, c] of DEFAULT_DECAL_CELLS.entries()) {
    const [u0, v0, u1, v1] = c.uv;
    assert.ok(u0 < u1 && v0 < v1 && u0 >= 0 && v1 <= 1, `cell ${i} uv`);
    // the uv rect (2048 px atlas) has the declared aspect within 5 %
    assert.ok(Math.abs((u1 - u0) / (v1 - v0) / c.aspect - 1) < 0.05, `cell ${i} aspect`);
  }
});

test('every decal quad sits on its own wall run / floor cells, inside the wall height, uv inside its cell', () => {
  let walls = 0, floors = 0, dropped = 0, total = 0;
  for (const L of SITES) {
    const g = buildEdgeGrid(L);
    const decals = clutterFor(L).filter((c) => c.kind === 'decal');
    assert.ok(decals.length > 0, `${L.theme} has decals`);
    for (const ci of decals) {
      total++;
      const parts = decalParts(ci, { grid: g, wallH: L.wallH });
      if (!parts.length) { dropped++; continue; }
      assert.equal(parts.length, 1);
      assert.equal(parts[0].mat, 'decal');
      const geo = parts[0].geo;
      const pos = geo.getAttribute('position'), nor = geo.getAttribute('normal'), uv = geo.getAttribute('uv');
      assert.equal(pos.count, 6);
      const [u0, v0, u1, v1] = DEFAULT_DECAL_CELLS[Math.round(ci.a)].uv;
      for (let i = 0; i < uv.count; i++) {
        assert.ok(uv.getX(i) >= u0 - 1e-6 && uv.getX(i) <= u1 + 1e-6 && uv.getY(i) >= v0 - 1e-6 && uv.getY(i) <= v1 + 1e-6, `uv in cell ${ci.a}`);
      }
      const n = new THREE.Vector3(nor.getX(0), nor.getY(0), nor.getZ(0));
      if (ci.tip === 1) {
        floors++;
        assert.ok(n.y > 0.99, 'floor decals face up');
        for (let i = 0; i < pos.count; i++) {
          assert.ok(Math.abs(pos.getY(i) - Math.max(0.002, ci.y)) < 1e-6, 'flat on the floor');
          assert.ok(floorPointOk(g, ci.space, pos.getX(i), pos.getZ(i)), `floor corner inside space ${ci.space} cells, clear of walls / doors`);
        }
      } else {
        walls++;
        const nx = Math.round(n.x), nz = Math.round(n.z);
        assert.equal(Math.abs(nx) + Math.abs(nz), 1, 'wall decals face along an axis');
        let cx = 0, cz = 0;
        for (let i = 0; i < pos.count; i++) { cx += pos.getX(i) / pos.count; cz += pos.getZ(i) / pos.count; }
        // orientation: the image top is up (v counts from the atlas's top row), image right = the viewer's right
        const tv = new THREE.Vector3(Math.cos(ci.rot), 0, -Math.sin(ci.rot));
        assert.ok(new THREE.Vector3().crossVectors(tv, new THREE.Vector3(0, 1, 0)).dot(n) > 0.99, 'right x up = the wall normal (not mirrored)');
        let hi = 0, lo = 0, rt = 0, lf = 0;
        for (let i = 1; i < pos.count; i++) {
          if (pos.getY(i) > pos.getY(hi)) hi = i;
          if (pos.getY(i) < pos.getY(lo)) lo = i;
          const s = (k: number) => pos.getX(k) * tv.x + pos.getZ(k) * tv.z;
          if (s(i) > s(rt)) rt = i;
          if (s(i) < s(lf)) lf = i;
        }
        assert.ok(uv.getY(hi) < uv.getY(lo), 'top edge samples the upper rows');
        assert.ok(uv.getX(rt) > uv.getX(lf), 'right edge samples the right columns');
        for (let i = 0; i < pos.count; i++) {
          const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
          assert.ok(y >= 0.1 - 1e-6 && y <= L.wallH - 0.04 + 1e-6, `inside the wall height (${y.toFixed(2)})`);
          // pull the corner 0.02 m back toward the quad centre along the wall: it must still be on a real wall
          const px = nx !== 0 ? x : x + Math.sign(cx - x) * 0.02, pz = nz !== 0 ? z : z + Math.sign(cz - z) * 0.02;
          assert.ok(onWall(g, ci.space, px, pz, nx, nz), `wall corner (${x.toFixed(2)}, ${z.toFixed(2)}) is on a wall of space ${ci.space}`);
          // 4 mm in front of the wall face (HALF_T 0.08 + 0.004)
          const face = nx > 0 ? Math.floor(px) + 0.08 : nx < 0 ? Math.floor(px) + 0.92 : nz > 0 ? Math.floor(pz) + 0.08 : Math.floor(pz) + 0.92;
          const d = nx !== 0 ? (x - face) * nx : (z - face) * nz;
          assert.ok(d > 0 && d < 0.01, `just in front of the wall face (${d.toFixed(4)})`);
        }
      }
      geo.dispose();
    }
  }
  assert.ok(walls > 20 && floors > 5, `walls ${walls}, floors ${floors}`);
  // doorway prints slide onto the wall beside the frame instead of being dropped
  assert.ok(decalStats.moved > 10, `moved ${decalStats.moved}`);
  assert.ok(dropped / total < 0.12, `dropped ${dropped} of ${total}`);
});

test('the client merges decals into one blended, shadowless mesh per space (procedural atlas until the staged one)', async () => {
  const L = SITES[1];
  const h = await installLevel(L);
  const lv = h.services.use('level') as unknown as { root: THREE.Group };
  const perSpace = new Map<string, number>();
  let meshes = 0;
  lv.root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.name.endsWith(':decal')) return;
    meshes++;
    const sid = m.name.split(':')[1];
    perSpace.set(sid, (perSpace.get(sid) ?? 0) + 1);
    assert.equal(m.castShadow, false, 'decals cast no shadow');
    const mat = m.material as THREE.Material;
    assert.equal(mat.name, 'level.decal');
    assert.ok(mat.transparent && !mat.depthWrite && mat.polygonOffset, 'blended, no depth write, polygon offset');
    const n = m.geometry.getAttribute('position').count / 6;
    assert.ok(Number.isInteger(n) && n >= 1);
  });
  assert.ok(meshes > 0, 'decal meshes built');
  for (const [sid, n] of perSpace) assert.equal(n, 1, `space ${sid}: one decal mesh`);
  assert.deepEqual(h.errors, []);
  // the shared material: one instance across layouts; the stand-in atlas is unflipped (top row first) like the staged one
  const m1 = decalMaterial(), m2 = decalMaterial();
  assert.equal(m1, m2);
});
