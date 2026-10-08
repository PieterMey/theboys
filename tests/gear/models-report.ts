// v1.2 item models (G3): a table of every visual key's procedural model (size, triangles, meshes, casts), in Node.
// Run: node tests/gear/models-report.ts
import * as THREE from 'three/webgpu';
// a do-nothing 2D context: every property is a function returning the context again
const ctx2d: object = new Proxy(function stub() { /* no-op */ }, { get: () => () => ctx2d, set: () => true, apply: () => ctx2d });
(globalThis as unknown as { document: unknown }).document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }) };
const V = await import('../../apps/client/src/interaction/visuals.ts');
const rows: string[] = [];
let bad = 0;
for (const s of V.itemSamples()) {
  const grp = V.buildItemModel(s.type, { name: s.name, glb: false });
  grp.updateMatrixWorld(true);
  let tris = 0, meshes = 0, casters = 0, nan = false;
  grp.traverse((c) => {
    const m = c as THREE.Mesh;
    if (!m.isMesh) return;
    meshes++;
    if (m.castShadow) casters++;
    const p = m.geometry.attributes.position!;
    tris += (m.geometry.index ? m.geometry.index.count : p.count) / 3;
    for (let i = 0; i < p.count; i++) if (!Number.isFinite(p.getX(i) + p.getY(i) + p.getZ(i))) nan = true;
  });
  const b = new THREE.Box3().setFromObject(grp, true);
  const sz = b.getSize(new THREE.Vector3());
  const key = String(grp.userData.key);
  if (nan || !meshes || key !== s.key) bad++;
  rows.push(`${key.padEnd(16)} ${String(s.name ?? '').padEnd(30)} size ${[sz.x, sz.y, sz.z].map((v) => v.toFixed(3)).join(' x ')}  min.y ${b.min.y.toFixed(3)}  tris ${String(Math.round(tris)).padStart(5)}  meshes ${meshes}  casts ${casters}${nan ? '  NaN!' : ''}${key !== s.key ? `  KEY ${key} != ${s.key}` : ''}`);
}
console.log(rows.join('\n'));
console.log(bad ? `BAD ${bad}` : `ok ${rows.length} models`);
