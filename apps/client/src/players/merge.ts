// Owner: players (v1.2 fix round, draw budget). Static avatar / view-model parts are baked into one geometry per
// material: every Object3D-placed part (position, XYZ Euler rotation, scale) is applied to a clone of its geometry,
// so a helmet of 7-14 little meshes draws as 2 meshes, the glove of 7 as 2. Pure geometry work, no GPU calls.
import * as THREE from 'three/webgpu';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export type Triple = readonly [number, number, number];

/** a geometry placed the way Object3D places a mesh (matrix = T * R(XYZ) * S), or by an explicit matrix */
export interface PlacedPart {
  geo: THREE.BufferGeometry;
  p?: Triple;
  r?: Triple;
  s?: Triple | number;
  m?: THREE.Matrix4;
}

const tmpM = new THREE.Matrix4();
const tmpQ = new THREE.Quaternion();
const tmpE = new THREE.Euler();
const tmpP = new THREE.Vector3();
const tmpS = new THREE.Vector3();

/** a clone of part.geo with its placement baked in (normals through the normal matrix) */
export function placeGeometry(part: PlacedPart): THREE.BufferGeometry {
  const g = part.geo.clone();
  if (part.m) return g.applyMatrix4(part.m);
  const s = part.s === undefined ? 1 : part.s;
  tmpP.set(...(part.p ?? [0, 0, 0]));
  tmpQ.setFromEuler(tmpE.set(...(part.r ?? [0, 0, 0])));
  if (typeof s === 'number') tmpS.setScalar(s);
  else tmpS.set(...s);
  return g.applyMatrix4(tmpM.compose(tmpP, tmpQ, tmpS));
}

/**
 * Merge placed parts into one geometry. `decorate(g, i)` may add per-part vertex attributes first (every part must
 * end up with the same attribute set). Returns null when the parts cannot merge (callers keep separate meshes).
 */
export function mergeParts(parts: PlacedPart[], decorate?: (g: THREE.BufferGeometry, i: number) => void): THREE.BufferGeometry | null {
  if (!parts.length) return null;
  const geos = parts.map((part, i) => {
    const g = placeGeometry(part);
    decorate?.(g, i);
    return g;
  });
  const list = geos.every((g) => g.index !== null) ? geos : geos.map((g) => (g.index ? g.toNonIndexed() : g));
  const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
  if (!merged) return null;
  merged.computeBoundingSphere();
  merged.computeBoundingBox();
  return merged;
}

/** a float vertex attribute holding the same value(s) on every vertex of g */
export function constantAttribute(g: THREE.BufferGeometry, name: string, values: readonly number[]): void {
  const n = g.getAttribute('position').count;
  const k = values.length;
  const a = new Float32Array(n * k);
  for (let i = 0; i < n; i++) for (let j = 0; j < k; j++) a[i * k + j] = values[j];
  g.setAttribute(name, new THREE.BufferAttribute(a, k));
}

/**
 * Replace the direct child meshes of `parent` (plain Mesh, one material, no children) by one mesh per material, the
 * geometry baked in the parent's space; the merged meshes are appended to `parent`. castShadow / receiveShadow: true
 * when any merged part had it. Other children (groups, sprites, anchors) stay. Returns the meshes now drawn.
 */
export function bakeChildMeshes(parent: THREE.Object3D): THREE.Mesh[] {
  const byMat = new Map<THREE.Material, THREE.Mesh[]>();
  for (const c of parent.children) {
    const m = c as THREE.Mesh;
    if (!m.isMesh || Array.isArray(m.material) || m.children.length || (m as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh) continue;
    let list = byMat.get(m.material);
    if (!list) byMat.set(m.material, (list = []));
    list.push(m);
  }
  const out: THREE.Mesh[] = [];
  for (const [mat, meshes] of byMat) {
    if (meshes.length < 2) { out.push(meshes[0]); continue; }
    const g = mergeParts(meshes.map((m) => { m.updateMatrix(); return { geo: m.geometry, m: m.matrix.clone() }; }));
    if (!g) { out.push(...meshes); continue; }
    const merged = new THREE.Mesh(g, mat);
    merged.name = meshes[0].name;
    merged.castShadow = meshes.some((m) => m.castShadow);
    merged.receiveShadow = meshes.some((m) => m.receiveShadow);
    merged.renderOrder = meshes[0].renderOrder;
    for (const m of meshes) parent.remove(m);
    parent.add(merged);
    out.push(merged);
  }
  return out;
}
