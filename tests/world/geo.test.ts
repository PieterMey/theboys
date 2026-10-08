// env-world: the level's cheap static geometry (apps/client/src/level/geo.ts), Node only:
//   node --test tests/world/geo.test.ts
// - prototypes (unit box / cylinder scaled, cached rounded boxes and shapes) bake to the same vertices, normals and
//   uvs as the three.js geometries they replace, under any placement (rotation, translation, chained transforms);
// - mergeParts == toNonIndexed + applyMatrix4 + mergeGeometries, and never mutates its (shared) sources;
// - plain set materials fold into the vertex-colour buckets with their own colour / roughness / metalness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { box, cyl, mergeParts, partGeometry, rbox, shape } from '../../apps/client/src/level/geo.ts';
import type { GeoRef } from '../../apps/client/src/level/geo.ts';
import { plainParams, setMaterial } from '../../apps/client/src/level/setpieces.ts';
import { LevelMaterials } from '../../apps/client/src/level/materials.ts';
import { installDomShim } from './harness.ts';

installDomShim();
const flat = (g: THREE.BufferGeometry) => (g.index ? g.toNonIndexed() : g);
function same(a: THREE.BufferGeometry, b: THREE.BufferGeometry, label: string): void {
  const x = flat(a), y = flat(b);
  for (const name of ['position', 'normal', 'uv']) {
    const p = x.getAttribute(name) as THREE.BufferAttribute, q = y.getAttribute(name) as THREE.BufferAttribute;
    assert.equal(p.count, q.count, `${label} ${name} count`);
    let d = 0;
    for (let i = 0; i < p.array.length; i++) d = Math.max(d, Math.abs(p.array[i] - q.array[i]));
    assert.ok(d < (name === 'normal' ? 1e-4 : 1e-5), `${label} ${name} differs by ${d}`);
  }
}
/** the same chained placement on a prototype or a real geometry */
const place = <G extends THREE.BufferGeometry | GeoRef>(g: G): G => g.rotateY(0.7).rotateZ(-0.3).translate(1.5, 0.2, -2) as G;

test('prototypes bake exactly like the three.js geometries they replace', () => {
  same(partGeometry({ mat: 'x', ...refPart(place(box(0.4, 1.2, 0.07, 0.1, 0.6, -0.2))) }), place(new THREE.BoxGeometry(0.4, 1.2, 0.07).translate(0.1, 0.6, -0.2)), 'box');
  same(partGeometry({ mat: 'x', ...refPart(place(cyl(0.09, 0.16, 0.3, 0.92, 0.1, 10, 0.07))) }), place(new THREE.CylinderGeometry(0.09, 0.07, 0.16, 10).translate(0.3, 0.92, 0.1)), 'cone');
  same(partGeometry({ mat: 'x', ...refPart(place(cyl(0.02, 0.9, 0, 0.45, 0, 8))) }), place(new THREE.CylinderGeometry(0.02, 0.02, 0.9, 8).translate(0, 0.45, 0)), 'cylinder');
  same(partGeometry({ mat: 'x', ...refPart(place(rbox(0.6, 0.11, 0.34, 0.02, 0.66, -0.7, 0.05, 2))) }), place(new RoundedBoxGeometry(0.6, 0.11, 0.34, 2, 0.05).translate(0.02, 0.66, -0.7)), 'rounded box');
  same(partGeometry({ mat: 'x', ...refPart(place(shape('t:sph', () => new THREE.SphereGeometry(0.075, 12, 9)).scale(1, 0.85, 1.2).translate(0.3, 0.9, 0))) }), place(new THREE.SphereGeometry(0.075, 12, 9).scale(1, 0.85, 1.2).translate(0.3, 0.9, 0)), 'shape');
  // the same prototype is shared, never mutated by placement
  const a = box(1, 2, 3, 4, 5, 6), b = box(1, 1, 1);
  assert.equal(a.geo, b.geo, 'one unit box');
  const p0 = Array.from((b.geo.getAttribute('position') as THREE.BufferAttribute).array.slice(0, 6));
  place(a);
  assert.deepEqual(Array.from((b.geo.getAttribute('position') as THREE.BufferAttribute).array.slice(0, 6)), p0, 'prototype untouched');
});

test('mergeParts == toNonIndexed + applyMatrix4 + mergeGeometries (sources untouched)', () => {
  const g1 = new THREE.BoxGeometry(0.3, 0.2, 0.1), g2 = new THREE.CylinderGeometry(0.1, 0.1, 0.5, 9);
  const m1 = new THREE.Matrix4().makeRotationY(1.1).setPosition(2, 0, 1), m2 = new THREE.Matrix4().makeScale(1, 2, 1).premultiply(new THREE.Matrix4().makeTranslation(-1, 0.5, 0));
  const before = Array.from((g1.getAttribute('position') as THREE.BufferAttribute).array);
  const fast = mergeParts([{ geo: g1, m: m1 }, { geo: g2, m: m2 }, { geo: g1, m: null }]);
  const ref = mergeGeometries([g1.clone().toNonIndexed().applyMatrix4(m1), g2.clone().toNonIndexed().applyMatrix4(m2), g1.clone().toNonIndexed()])!;
  same(fast, ref, 'merge');
  assert.deepEqual(Array.from((g1.getAttribute('position') as THREE.BufferAttribute).array), before, 'source untouched');
  // the vertex-colour variant carries per-part colour + roughness / metalness
  const vc = mergeParts([{ geo: g1, m: null, rgb: [1, 0, 0], rm: [0.3, 0.9] }, { geo: g2, m: null, rgb: [0, 1, 0], rm: [0.8, 0] }], true);
  const col = vc.getAttribute('color') as THREE.BufferAttribute, rm = vc.getAttribute('rm') as THREE.BufferAttribute;
  const n1 = g1.index!.count;
  assert.deepEqual([col.getX(0), col.getY(0), col.getZ(0), rm.getX(0), rm.getY(0)].map((v) => +v.toFixed(3)), [1, 0, 0, 0.3, 0.9]);
  assert.deepEqual([col.getX(n1), col.getY(n1), rm.getX(n1)].map((v) => +v.toFixed(3)), [0, 1, 0.8]);
});

test('plain set materials fold into the vertex-colour buckets with their own colour and roughness', () => {
  const lm = new LevelMaterials();
  for (const key of ['steelDark', 'woodDark', 'brass', 'bookA', 'cardboard', 'enamel']) {
    const p = plainParams(lm, key);
    const m = setMaterial(lm, key) as THREE.MeshStandardNodeMaterial;
    assert.ok(p && p.bucket === 'vc', `${key} -> vc`);
    assert.deepEqual(p!.rgb.map((v) => +v.toFixed(4)), [m.color.r, m.color.g, m.color.b].map((v) => +v.toFixed(4)), `${key} colour`);
    assert.deepEqual(p!.rm, [m.roughness, m.metalness], `${key} roughness / metalness`);
  }
  assert.equal(plainParams(lm, 'glassGreen')?.bucket, 'vcGlass');
  for (const key of ['paper', 'poster', 'wood', 'metal_painted', 'ledG', 'decal', 'curtain', 'glassCase', 'puddle']) assert.equal(plainParams(lm, key), null, `${key} keeps its own material`);
  const vc = setMaterial(lm, 'vc') as THREE.MeshStandardNodeMaterial;
  assert.equal(vc.vertexColors, true);
  assert.ok(vc.roughnessNode && vc.metalnessNode, 'roughness / metalness from the rm attribute');
});

function refPart(g: THREE.BufferGeometry | GeoRef): { geo: THREE.BufferGeometry; m?: THREE.Matrix4 } {
  return 'm' in g && !(g instanceof THREE.BufferGeometry) ? { geo: g.geo, m: g.m } : { geo: g as THREE.BufferGeometry };
}
