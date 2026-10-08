// Owner: env-world (v1.2). Cheap static geometry for the level's merged furniture (build time). A GeoRef is a shared,
// never-mutated prototype geometry + a transform: boxes and cylinders scale one unit prototype, rounded boxes and other
// repeatable shapes are cached by their parameters, so a room full of kits allocates matrices instead of thousands of
// small BufferGeometries. mergeParts() bakes a (geometry, matrix) list into ONE non-indexed position / normal / uv
// geometry in a single pass (optionally with per-part colour + roughness / metalness attributes for the shared
// vertex-colour furniture material), without the toNonIndexed / applyMatrix4 / mergeGeometries round trips.
import * as THREE from 'three/webgpu';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

const _t = new THREE.Matrix4();

/** a shared prototype geometry placed by a matrix; the BufferGeometry transform API, applied to the matrix */
export class GeoRef {
  readonly geo: THREE.BufferGeometry;
  readonly m: THREE.Matrix4;
  constructor(geo: THREE.BufferGeometry, m: THREE.Matrix4 = new THREE.Matrix4()) { this.geo = geo; this.m = m; }
  applyMatrix4(m: THREE.Matrix4): this { this.m.premultiply(m); return this; }
  translate(x: number, y: number, z: number): this { this.m.premultiply(_t.makeTranslation(x, y, z)); return this; }
  rotateX(a: number): this { this.m.premultiply(_t.makeRotationX(a)); return this; }
  rotateY(a: number): this { this.m.premultiply(_t.makeRotationY(a)); return this; }
  rotateZ(a: number): this { this.m.premultiply(_t.makeRotationZ(a)); return this; }
  scale(x: number, y: number, z: number): this { this.m.premultiply(_t.makeScale(x, y, z)); return this; }
  /** a real, independent geometry (instanced parts, tests) */
  toGeometry(): THREE.BufferGeometry { return this.geo.clone().applyMatrix4(this.m); }
}
export type AnyGeo = THREE.BufferGeometry | GeoRef;

/** a static part: material key + geometry, optionally a shared prototype placed by m (never mutate geo when m is set) */
export interface Part { mat: string; geo: THREE.BufferGeometry; m?: THREE.Matrix4 }
export function part(mat: string, g: AnyGeo): Part {
  return g instanceof GeoRef ? { mat, geo: g.geo, m: g.m } : { mat, geo: g };
}
/** a part's own geometry with its transform baked in (tests, bounds) */
export function partGeometry(p: Part): THREE.BufferGeometry {
  return p.m ? p.geo.clone().applyMatrix4(p.m) : p.geo;
}
/** apply a transform to a part in place (prototype parts move their matrix, own geometries are transformed) */
export function transformPart(p: Part, m: THREE.Matrix4): void {
  if (p.m) p.m.premultiply(m);
  else p.geo.applyMatrix4(m);
}
/** a real geometry of either kind (prototypes are cloned) */
export function realGeometry(g: AnyGeo): THREE.BufferGeometry {
  return g instanceof GeoRef ? g.toGeometry() : g;
}

// ---------------------------------------------------------------- prototypes (kept for the session; never disposed)

const protos = new Map<string, THREE.BufferGeometry>();
/** a cached prototype by key (bounded: a pathological stream of unique shapes cannot grow it without limit) */
export function proto(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = protos.get(key);
  if (!g) {
    if (protos.size > 1500) protos.clear();
    g = make();
    protos.set(key, g);
  }
  return g;
}
const q4 = (v: number) => Math.round(v * 1e4);

/** box w x h x d centred at (x, y, z): the unit box scaled (same vertices, normals and uvs as a BoxGeometry) */
export function box(w: number, h: number, d: number, x = 0, y = 0, z = 0): GeoRef {
  const g = proto('box', () => new THREE.BoxGeometry(1, 1, 1));
  return new GeoRef(g, new THREE.Matrix4().makeScale(w, h, d).setPosition(x, y, z));
}
/** cylinder along y (radius top r, bottom r2, height h, seg segments) centred at (x, y, z): a unit prototype scaled */
export function cyl(r: number, h: number, x = 0, y = 0, z = 0, seg = 16, r2 = r): GeoRef {
  const rm = Math.max(r, r2, 1e-6);
  const g = proto(`cyl:${seg}:${q4(r / rm)}:${q4(r2 / rm)}`, () => new THREE.CylinderGeometry(r / rm, r2 / rm, 1, seg));
  return new GeoRef(g, new THREE.Matrix4().makeScale(rm, h, rm).setPosition(x, y, z));
}
/** rounded box (cached per size + bevel + segments) centred at (x, y, z) */
export function rbox(w: number, h: number, d: number, x: number, y: number, z: number, r: number, seg: number): GeoRef {
  const rr = Math.max(0.002, Math.min(r, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001));
  const g = proto(`rb:${q4(w)}:${q4(h)}:${q4(d)}:${q4(rr)}:${seg}`, () => new RoundedBoxGeometry(w, h, d, seg, rr));
  return new GeoRef(g, new THREE.Matrix4().makeTranslation(x, y, z));
}
/** any repeatable shape (torus, sphere, capsule...) by its parameter key, placed at the origin */
export function shape(key: string, make: () => THREE.BufferGeometry): GeoRef {
  return new GeoRef(proto(key, make));
}

// ---------------------------------------------------------------- one-pass merge

export interface MergeItem {
  geo: THREE.BufferGeometry;
  m: THREE.Matrix4 | null;
  /** vertex colour (linear) + roughness / metalness of the shared vertex-colour material */
  rgb?: readonly [number, number, number];
  rm?: readonly [number, number];
}

/** attribute data as a plain Float32Array with tight itemSize packing (copies only unusual layouts) */
function flat(a: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, size: number): Float32Array {
  if (!(a as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute && a.array instanceof Float32Array && a.itemSize === size && !a.normalized) return a.array;
  const out = new Float32Array(a.count * size);
  for (let i = 0; i < a.count; i++) {
    out[i * size] = a.getX(i);
    if (size > 1) out[i * size + 1] = a.getY(i);
    if (size > 2) out[i * size + 2] = a.getZ(i);
  }
  return out;
}

const _nm = new THREE.Matrix3();
const I16 = new THREE.Matrix4().elements, I9 = new THREE.Matrix3().elements;
/**
 * Bake a list of (geometry, matrix) items into one non-indexed geometry with position / normal / uv (missing uvs are
 * zero), plus 'color' + 'rm' when `vertexMaterial` is set. Sources are only read: prototypes can repeat freely.
 */
export function mergeParts(items: readonly MergeItem[], vertexMaterial = false): THREE.BufferGeometry {
  let n = 0;
  for (const it of items) n += it.geo.index ? it.geo.index.count : it.geo.getAttribute('position').count;
  const P = new Float32Array(n * 3), N = new Float32Array(n * 3), U = new Float32Array(n * 2);
  const C = vertexMaterial ? new Float32Array(n * 3) : null, R = vertexMaterial ? new Float32Array(n * 2) : null;
  let o = 0;
  for (const it of items) {
    const g = it.geo;
    const pa = g.getAttribute('position'), na = g.getAttribute('normal'), ua = g.getAttribute('uv');
    if (!pa) continue;
    const pos = flat(pa, 3), nor = na ? flat(na, 3) : null, uv = ua ? flat(ua, 2) : null;
    const idx = g.index ? g.index.array : null;
    const cnt = idx ? idx.length : pa.count;
    const o0 = o;
    // identity items copy; placed items transform (positions by m, normals by its normal matrix, renormalised)
    const e = it.m ? it.m.elements : I16;
    const ne = it.m ? _nm.getNormalMatrix(it.m).elements : I9;
    const e0 = e[0], e1 = e[1], e2 = e[2], e4 = e[4], e5 = e[5], e6 = e[6], e8 = e[8], e9 = e[9], e10 = e[10], e12 = e[12], e13 = e[13], e14 = e[14];
    const n0 = ne[0], n1 = ne[1], n2 = ne[2], n3 = ne[3], n4 = ne[4], n5 = ne[5], n6 = ne[6], n7 = ne[7], n8 = ne[8];
    for (let k = 0; k < cnt; k++, o++) {
      const v = idx ? idx[k] : k;
      const v3 = v * 3, o3 = o * 3;
      const x = pos[v3], y = pos[v3 + 1], z = pos[v3 + 2];
      P[o3] = e0 * x + e4 * y + e8 * z + e12;
      P[o3 + 1] = e1 * x + e5 * y + e9 * z + e13;
      P[o3 + 2] = e2 * x + e6 * y + e10 * z + e14;
      if (nor) {
        const a = nor[v3], b = nor[v3 + 1], c = nor[v3 + 2];
        const nx = n0 * a + n3 * b + n6 * c, ny = n1 * a + n4 * b + n7 * c, nz = n2 * a + n5 * b + n8 * c;
        const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        N[o3] = nx / l; N[o3 + 1] = ny / l; N[o3 + 2] = nz / l;
      } else N[o3 + 1] = 1;
      if (uv) { U[o * 2] = uv[v * 2]; U[o * 2 + 1] = uv[v * 2 + 1]; }
    }
    if (C && R) {
      const [cr, cg, cb] = it.rgb ?? [1, 1, 1], [rr, mm] = it.rm ?? [0.8, 0];
      for (let k = o0; k < o; k++) { C[k * 3] = cr; C[k * 3 + 1] = cg; C[k * 3 + 2] = cb; R[k * 2] = rr; R[k * 2 + 1] = mm; }
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(o === n ? P : P.subarray(0, o * 3), 3));
  out.setAttribute('normal', new THREE.BufferAttribute(o === n ? N : N.subarray(0, o * 3), 3));
  out.setAttribute('uv', new THREE.BufferAttribute(o === n ? U : U.subarray(0, o * 2), 2));
  if (C && R) {
    out.setAttribute('color', new THREE.BufferAttribute(C.subarray(0, o * 3), 3));
    out.setAttribute('rm', new THREE.BufferAttribute(R.subarray(0, o * 2), 2));
  }
  return out;
}
