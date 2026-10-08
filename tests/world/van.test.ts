// env-world: the v1.2 crew van (apps/client/src/level/van.ts), built in Node (no GPU).
//   node --test tests/world/van.test.ts
// Body <= 2.2 m wide (the hub board stands at x0 + 2.55), overhang <= 0.3 m, <= 25 meshes merged per material,
// named parts per station with their own materials, upgrades pre-merged + hidden + reusing van materials (no new
// pipelines), no shadows from emissive / glass / decal meshes, station furniture within 0.06 m of its collision box.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { generateHub } from '../../packages/shared/src/procgen/hub.ts';
import { generateFacility } from '../../packages/shared/src/procgen/facility.ts';
import { stationsOf, VAN_CAB_L } from '../../packages/shared/src/procgen/van.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import { VAN_UPGRADES } from '../../packages/shared/src/catalog.ts';
import { installDomShim } from './harness.ts';
import { LevelMaterials } from '../../apps/client/src/level/materials.ts';
import { buildVan } from '../../apps/client/src/level/van.ts';

installDomShim();
const lm = new LevelMaterials();
const layouts: LevelLayout[] = [generateHub()];
for (const [seed, players] of [['s1', 2], ['s2', 4], ['s3', 6], ['van-a', 1], ['van-b', 5]] as const) layouts.push(generateFacility({ seed, players, risk: 1 }));
const vanSpace = (L: LevelLayout) => L.spaces.find((s) => s.type === 'van')!.id;
const meshesOf = (o: THREE.Object3D) => { const out: THREE.Mesh[] = []; o.traverse((c) => { if ((c as THREE.Mesh).isMesh) out.push(c as THREE.Mesh); }); return out; };
const NAMED: Record<string, string> = { workbench: 'lamp', stash: 'door', booklet: 'books', charger: 'cradle', mirror: 'glass' };

test('body <= 2.2 m wide, overhang <= 0.3 m, group names', () => {
  for (const L of layouts) {
    const v = buildVan(L, lm, { vanSpace: vanSpace(L) });
    assert.equal(v.exterior.name, 'van');
    const c = L.van.cab;
    v.exterior.updateMatrixWorld(true);
    const box = new THREE.Box3();
    for (const m of meshesOf(v.exterior)) {
      if (!m.visible) continue;
      m.geometry.computeBoundingBox();
      const b = m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld);
      // side mirrors are accessories on arms (they clear the 0.38 m stand-off of the cab's wall line)
      if (m.name === 'van.paint') box.union(b);
      assert.ok(b.min.z >= c.y - 0.3 - 1e-6, `${L.seed} ${m.name} rear overhang ${(c.y - b.min.z).toFixed(3)}`);
      assert.ok(b.max.z <= c.y + c.h + VAN_CAB_L + 0.3 + 1e-6, `${L.seed} ${m.name} front overhang ${(b.max.z - c.y - c.h - VAN_CAB_L).toFixed(3)}`);
    }
    assert.ok(box.max.x - box.min.x <= 2.2 + 1e-6, `${L.seed}: painted body ${(box.max.x - box.min.x).toFixed(3)} m wide`);
    assert.ok(box.min.x >= c.x - 0.1 - 1e-6 && box.max.x <= c.x + c.w + 0.1 + 1e-6, `${L.seed}: body centred on the cab rect`);
    // everything stays clear of the hub's work-order board (x0 + 2.55)
    if (L.kind === 'hub') for (const m of meshesOf(v.exterior)) { m.geometry.computeBoundingBox(); assert.ok(m.geometry.boundingBox!.clone().applyMatrix4(m.matrixWorld).max.x < c.x + 2.45, `${m.name} reaches the board`); }
  }
});

test('<= 25 meshes merged per material; emissive / glass / decals never cast shadows', () => {
  for (const L of layouts) {
    const v = buildVan(L, lm, { vanSpace: vanSpace(L) });
    const all = [...meshesOf(v.exterior), ...meshesOf(v.interior)];
    const visible = all.filter((m) => m.visible && (m.parent?.visible ?? true));
    assert.ok(visible.length <= 25, `${L.seed}: ${visible.length} visible van meshes`);
    for (const m of all) {
      const mat = m.material as THREE.Material & { isMeshBasicMaterial?: boolean; emissiveIntensity?: number };
      if (mat.isMeshBasicMaterial || /glass|lens|led|decal|lamp|cradle/.test(m.name)) assert.equal(m.castShadow, false, `${m.name} casts`);
    }
    // the static parts merge per material: no two static van meshes share a material within one group
    for (const g of [v.exterior, v.interior]) {
      const seen = new Set<THREE.Material>();
      for (const m of g.children as THREE.Mesh[]) {
        if (!m.isMesh || !m.visible) continue;
        assert.ok(!seen.has(m.material as THREE.Material), `${g.name}: two meshes with ${(m.material as THREE.Material).name}`);
        seen.add(m.material as THREE.Material);
      }
    }
  }
});

test('every real station has its object and named part (own material); virtual stations are not drawn', () => {
  for (const L of layouts) {
    const v = buildVan(L, lm, { vanSpace: vanSpace(L) });
    const real = stationsOf(L).filter((s) => !s.virtual && s.kind in NAMED && L.items.some((it) => it.id === s.itemId && it.kind === 'prop'));
    for (const s of real) {
      const o = v.stations.get(s.kind);
      assert.ok(o, `${L.seed}: station ${s.kind} has no object`);
      const part = NAMED[s.kind];
      if (!part) continue;
      const p = o!.getObjectByName(part);
      assert.ok(p, `${L.seed}: ${s.kind} lacks '${part}'`);
      const mesh = (p as THREE.Mesh).isMesh ? (p as THREE.Mesh) : (meshesOf(p!)[0]);
      const mat = mesh.material as THREE.Material;
      const users = [...meshesOf(v.exterior), ...meshesOf(v.interior)].filter((m) => m.material === mat);
      assert.equal(users.length, 1, `${s.kind}.${part}: its material is shared`);
    }
    for (const s of stationsOf(L).filter((x) => x.virtual)) assert.ok(!v.stations.has(s.kind), `virtual ${s.kind} drawn`);
    // the facility van mirror registers as kind van with its item id
    for (const m of v.mirrors) assert.ok(L.items.some((it) => it.id === m.itemId), m.itemId);
  }
});

test('upgrades: pre-merged, hidden, toggled by visibility only, reusing the van materials', () => {
  for (const L of layouts) {
    const v = buildVan(L, lm, { vanSpace: vanSpace(L) });
    for (const id of VAN_UPGRADES) assert.ok(v.upgrades.has(id), `${L.seed}: upgrade ${id} missing`);
    const baseMats = new Set<THREE.Material>();
    for (const m of [...meshesOf(v.exterior), ...meshesOf(v.interior)]) if (!v.upgrades.has(String(m.name.split('.')[2])) && !m.name.startsWith('van.up.')) baseMats.add(m.material as THREE.Material);
    for (const [id, objs] of v.upgrades) for (const o of objs) {
      assert.equal(o.visible, false, `${id} visible by default`);
      for (const m of meshesOf(o)) assert.ok(baseMats.has(m.material as THREE.Material), `${id}: ${m.name} uses a material the van does not (${(m.material as THREE.Material).name})`);
    }
  }
});

test('solid station furniture stays within 0.06 m of its collision box; backs flush with the HALF_T wall face', () => {
  for (const L of layouts) {
    const v = buildVan(L, lm, { vanSpace: vanSpace(L) });
    for (const s of stationsOf(L)) {
      const b = v.stationBounds.get(s.kind);
      if (!b || s.virtual) continue;
      const solid = s.kind === 'workbench' || s.kind === 'stash';
      const tol = 0.06;
      const y0 = s.kind === 'workbench' || s.kind === 'stash' ? 0 : s.y - s.h / 2;
      if (solid) {
        assert.ok(b.min.x >= -s.w / 2 - tol && b.max.x <= s.w / 2 + tol, `${L.seed} ${s.kind} x ${b.min.x.toFixed(3)}..${b.max.x.toFixed(3)} vs w ${s.w}`);
        assert.ok(b.min.z >= -s.d / 2 - tol && b.max.z <= s.d / 2 + tol, `${L.seed} ${s.kind} z ${b.min.z.toFixed(3)}..${b.max.z.toFixed(3)} vs d ${s.d}`);
        assert.ok(b.max.y <= y0 + s.h + 0.75, `${L.seed} ${s.kind} too tall`);
      }
      // nothing sinks into the wall behind (the wall face is the station back, z = -d/2)
      assert.ok(b.min.z >= -s.d / 2 - 0.02, `${L.seed} ${s.kind} pokes into the wall (${(b.min.z + s.d / 2).toFixed(3)})`);
    }
  }
});

test('build is cheap and deterministic in mesh count', () => {
  const L = layouts[2];
  const t0 = performance.now();
  const a = buildVan(L, lm, { vanSpace: vanSpace(L) });
  const ms = performance.now() - t0;
  const b = buildVan(L, lm, { vanSpace: vanSpace(L) });
  assert.equal(meshesOf(a.exterior).length + meshesOf(a.interior).length, meshesOf(b.exterior).length + meshesOf(b.interior).length);
  assert.ok(ms < 250, `van build ${ms.toFixed(0)} ms`);
});
