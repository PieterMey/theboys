// Owner: track ② Level (v1.2: env-world). Furniture models (prop.* GLBs from /assets/manifest.json: meshopt + embedded
// KTX2), loaded once per type, normalised (centred on x/z, standing on y = 0) and cloned per placement.
// v1.2: movable parts (container drawers / trays / lids / doors: GLB nodes named *_drawer_NN, *_tray_NN, *_lid, *_door,
// plus any node a container part names) stay SEPARATE template children, baked with the same recentring shift as the
// body, so a container's parts can be instanced and animated on their own. clone(true) of a template still shows the
// whole model (body + parts); templateInfo() gives the body / part / full-merge split the level instancer uses.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { assetUrl, getAssetManifest, loadAssetManifest } from '@dead-air/shared/assets.ts';
import * as ContainersMod from '@dead-air/shared/procgen/containers.ts';
import { sharedKTX2 } from './materials.ts';

let renderer: THREE.WebGPURenderer | null = null;
let resolveRenderer: ((r: THREE.WebGPURenderer) => void) | null = null;
const rendererReady = new Promise<THREE.WebGPURenderer>((res) => { resolveRenderer = res; });
let loader: GLTFLoader | null = null;
const cache = new Map<string, Promise<THREE.Object3D | null>>();
let pending = 0;
/** prop model loads still in flight */
export function propsPending(): number { return pending; }

export function setPropRenderer(r: THREE.WebGPURenderer): void { renderer = r; resolveRenderer?.(r); }

/** per-model yaw fix (radians) so the model's front faces local +Z (away from the wall) */
const YAW_FIX: Record<string, number> = {};

/** GLB node names that are movable parts (containers): *_drawer_NN, *_tray_NN, *_lid, *_door */
export const PART_NODE_RE = /(_drawer_\d\d|_tray_\d\d|_lid|_door)$/;
/** part group of a part node: numbered drawers / trays are their own part; every *_lid (lid + its hinge leaf) is one
 *  part, every *_door one part */
export function partGroupOf(name: string): string | null {
  const m = PART_NODE_RE.exec(name);
  if (!m) return null;
  return m[1] === '_lid' ? 'lid' : m[1] === '_door' ? 'door' : name;
}
/** extra node names (from container defs) that must also stay separate, by prop key */
const extraPartNodes = new Map<string, Set<string>>();
/** env-layout's container part nodes per GLB key (CONTAINER_NODES) + any registered ones */
export function partNodesFor(key: string): Set<string> {
  const table = (ContainersMod as unknown as { CONTAINER_NODES?: Readonly<Record<string, readonly string[]>> }).CONTAINER_NODES;
  return new Set([...(table?.[key] ?? []), ...(extraPartNodes.get(key) ?? [])]);
}
/** register container part node names for a key before it loads (no-op once loaded) */
export function registerPartNodes(key: string, nodes: Iterable<string>): void {
  let s = extraPartNodes.get(key);
  if (!s) { s = new Set(); extraPartNodes.set(key, s); }
  for (const n of nodes) s.add(n);
}

export interface TemplatePart {
  /** canonical node name (shortest member of the part group) */
  name: string;
  /** every GLB node name in the group (a container part may name any of them) */
  nodes: string[];
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  /** bounds centre / size in the recentred model frame (authored pose) */
  centre: THREE.Vector3;
  size: THREE.Vector3;
}
export interface PropTemplateInfo {
  key: string;
  /** body meshes merged per material, movable parts excluded (recentred frame) */
  body: THREE.Mesh[];
  parts: TemplatePart[];
  /** model height (m) after recentring */
  height: number;
  /** body + parts merged per material (lazy; for placements whose parts never move) */
  full(): THREE.Mesh[];
}
const infos = new WeakMap<THREE.Object3D, PropTemplateInfo>();
/** split of a loaded template (null for models without the v1.2 split, e.g. fallback roots) */
export function templateInfo(tpl: THREE.Object3D | null): PropTemplateInfo | null {
  return tpl ? infos.get(tpl) ?? null : null;
}
/** find a part by any of its node names (or its group: 'lid' / 'door') */
export function findPart(info: PropTemplateInfo, node: string): TemplatePart | null {
  return info.parts.find((p) => p.name === node || p.nodes.includes(node)) ?? info.parts.find((p) => partGroupOf(p.name) === partGroupOf(node) && partGroupOf(node) !== node) ?? null;
}

/** tests (Node, no assets): install a template for a key as if its GLB had loaded */
export function primePropTemplate(key: string, tpl: THREE.Object3D | null): void {
  cache.set(key, Promise.resolve(tpl));
}

export function loadPropModel(key: string): Promise<THREE.Object3D | null> {
  let p = cache.get(key);
  if (p) return p;
  pending++;
  p = (async () => {
    const r = renderer ?? (await rendererReady);
    if (!getAssetManifest()) await loadAssetManifest();
    const url = assetUrl(`prop.${key}`);
    if (!url) return null;
    if (!loader) {
      loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      loader.setKTX2Loader(sharedKTX2(r));
    }
    try {
      const gltf = await loader.loadAsync(url);
      return buildTemplate(key, gltf.scene);
    } catch (e) {
      console.warn(`[level] prop ${key} failed: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  })();
  void p.finally(() => { pending--; });
  cache.set(key, p);
  return p;
}

/** normalise a loaded model into a template: body merged per material + separate movable parts (same shift) */
export function buildTemplate(key: string, model: THREE.Object3D): THREE.Object3D {
  const root = new THREE.Group();
  root.name = `prop-model:${key}`;
  model.rotation.y = YAW_FIX[key] ?? 0;
  model.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(model);
  const c = bb.getCenter(new THREE.Vector3());
  const shift = new THREE.Matrix4().makeTranslation(-c.x, -bb.min.y, -c.z);
  const extra = partNodesFor(key);
  /** part group of a mesh: the nearest ancestor (or itself) named like a part node */
  const groupOf = (o: THREE.Object3D): { group: string; node: string } | null => {
    for (let a: THREE.Object3D | null = o; a && a !== model; a = a.parent) {
      if (!a.name) continue;
      if (extra.has(a.name)) return { group: partGroupOf(a.name) ?? a.name, node: a.name };
      const g = partGroupOf(a.name);
      if (g) return { group: g, node: a.name };
    }
    return null;
  };
  // bake every sub-mesh: body per material (1 draw call per material per placed prop), parts per group + material
  const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const partGeos = new Map<string, { nodes: Set<string>; byMat: Map<THREE.Material, THREE.BufferGeometry[]> }>();
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || Array.isArray(m.material)) return;
    const g = toFloat32(m.geometry);
    g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(shift, m.matrixWorld));
    const pg = groupOf(m);
    let target = byMat;
    if (pg) {
      let e = partGeos.get(pg.group);
      if (!e) { e = { nodes: new Set(), byMat: new Map() }; partGeos.set(pg.group, e); }
      e.nodes.add(pg.node);
      target = e.byMat;
    }
    const list = target.get(m.material) ?? [];
    list.push(g);
    target.set(m.material, list);
  });
  const body: THREE.Mesh[] = [];
  for (const [mat, geos] of byMat) {
    const merged = mergeSame(geos);
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    root.add(mesh);
    body.push(mesh);
  }
  const parts: TemplatePart[] = [];
  for (const [group, e] of partGeos) {
    // one material per part (container GLBs use one): extra materials of a part fold into its first one
    const mats = [...e.byMat.keys()];
    const merged = mergeSame(mats.flatMap((mm) => e.byMat.get(mm) ?? []));
    if (!merged) continue;
    merged.computeBoundingBox();
    const bbx = merged.boundingBox!;
    const nodes = [...e.nodes].sort((a, b) => a.length - b.length || a.localeCompare(b));
    const name = nodes[0] ?? group;
    const mesh = new THREE.Mesh(merged, mats[0]);
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.userData.part = true;
    root.add(mesh);
    parts.push({ name, nodes, geometry: merged, material: mats[0], centre: bbx.getCenter(new THREE.Vector3()), size: bbx.getSize(new THREE.Vector3()) });
  }
  if (!root.children.length) {
    model.position.set(-c.x, -bb.min.y, -c.z);
    root.add(model);
    return root;
  }
  let fullCache: THREE.Mesh[] | null = null;
  infos.set(root, {
    key, body, parts, height: bb.max.y - bb.min.y,
    full() {
      if (fullCache) return fullCache;
      if (!parts.length) { fullCache = body; return body; }
      const by = new Map<THREE.Material, THREE.BufferGeometry[]>();
      for (const b of body) by.set(b.material as THREE.Material, [b.geometry]);
      for (const p of parts) { const l = by.get(p.material) ?? []; l.push(p.geometry); by.set(p.material, l); }
      fullCache = [];
      for (const [mat, geos] of by) {
        const g = geos.length === 1 ? geos[0] : mergeSame(geos.map((x) => x.clone()));
        if (!g) continue;
        const mesh = new THREE.Mesh(g, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        fullCache.push(mesh);
      }
      return fullCache;
    },
  });
  return root;
}

/** merge geometries that share an attribute layout (others dropped); non-indexed result */
function mergeSame(geos: THREE.BufferGeometry[]): THREE.BufferGeometry | null {
  if (!geos.length) return null;
  const attrs = (g: THREE.BufferGeometry) => Object.keys(g.attributes).sort().join(',');
  const sig = attrs(geos[0]);
  const same = geos.filter((g) => attrs(g) === sig).map((g) => (g.index ? g.toNonIndexed() : g));
  return same.length > 1 ? mergeGeometries(same) : same[0];
}

/** copy of a geometry with plain Float32 attributes (meshopt / KHR_mesh_quantization data is normalized Int16/Int8,
 *  which would clamp when transforms are baked in) */
function toFloat32(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv', 'tangent', 'color']) {
    const a = src.getAttribute(name) as THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined;
    if (!a) continue;
    const n = a.count, k = a.itemSize;
    const out = new Float32Array(n * k);
    for (let i = 0; i < n; i++) {
      out[i * k] = a.getX(i);
      if (k > 1) out[i * k + 1] = a.getY(i);
      if (k > 2) out[i * k + 2] = a.getZ(i);
      if (k > 3) out[i * k + 3] = a.getW(i);
    }
    g.setAttribute(name, new THREE.BufferAttribute(out, k));
  }
  if (src.index) g.setIndex(Array.from(src.index.array as ArrayLike<number>));
  return g;
}

// ---------------------------------------------------------------- pure GLB inspection (tests, no THREE scene)

interface GltfNode { name?: string; mesh?: number; children?: number[]; translation?: number[]; scale?: number[]; rotation?: number[] }
interface GltfJson { nodes: GltfNode[]; meshes: { primitives: { attributes: Record<string, number> }[] }[]; accessors: { min?: number[]; max?: number[]; normalized?: boolean; componentType: number }[]; scenes: { nodes: number[] }[]; scene?: number }

/** JSON chunk of a .glb */
export function glbJson(buf: Uint8Array): GltfJson {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const len = dv.getUint32(12, true);
  return JSON.parse(new TextDecoder().decode(buf.subarray(20, 20 + len))) as GltfJson;
}

/**
 * Part bounds of a GLB in the loader's recentred frame, from the JSON alone (accessor min/max + node TRS; models
 * without node rotation, which the prop pipeline guarantees). Same rules as buildTemplate: part groups by node name.
 * Returns the model bounds and, per part group, its canonical name, member nodes, centre and size.
 */
export function glbPartBounds(json: GltfJson, extra: ReadonlySet<string> = new Set()): { min: number[]; max: number[]; parts: { name: string; nodes: string[]; centre: number[]; size: number[] }[]; nodes: Map<string, { centre: number[]; size: number[] }> } {
  const all = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
  const groups = new Map<string, { nodes: Set<string>; min: number[]; max: number[] }>();
  /** bounds per named node (its subtree) */
  const named = new Map<string, { min: number[]; max: number[] }>();
  const deq = (v: number, normalized: boolean | undefined, ct: number) => {
    if (!normalized) return v;
    if (ct === 5120) return Math.max(v / 127, -1);
    if (ct === 5121) return v / 255;
    if (ct === 5122) return Math.max(v / 32767, -1);
    if (ct === 5123) return v / 65535;
    return v;
  };
  const walk = (ni: number, t: number[], s: number[], part: { group: string; node: string } | null, owners: string[]) => {
    const n = json.nodes[ni];
    if (n.rotation && Math.abs(n.rotation[3] ?? 1) < 0.99999) throw new Error(`node ${n.name ?? ni} is rotated: not supported`);
    const ns = n.scale ?? [1, 1, 1], nt = n.translation ?? [0, 0, 0];
    const t2 = [t[0] + s[0] * nt[0], t[1] + s[1] * nt[1], t[2] + s[2] * nt[2]];
    const s2 = [s[0] * ns[0], s[1] * ns[1], s[2] * ns[2]];
    let p = part;
    if (!p && n.name) {
      if (extra.has(n.name)) p = { group: partGroupOf(n.name) ?? n.name, node: n.name };
      else { const g = partGroupOf(n.name); if (g) p = { group: g, node: n.name }; }
    }
    const own = n.name ? [...owners, n.name] : owners;
    if (n.mesh !== undefined) {
      for (const prim of json.meshes[n.mesh].primitives) {
        const a = json.accessors[prim.attributes.POSITION];
        if (!a.min || !a.max) continue;
        const lo = [0, 1, 2].map((k) => t2[k] + s2[k] * deq(s2[k] >= 0 ? a.min![k] : a.max![k], a.normalized, a.componentType));
        const hi = [0, 1, 2].map((k) => t2[k] + s2[k] * deq(s2[k] >= 0 ? a.max![k] : a.min![k], a.normalized, a.componentType));
        for (let k = 0; k < 3; k++) { all.min[k] = Math.min(all.min[k], lo[k]); all.max[k] = Math.max(all.max[k], hi[k]); }
        for (const name of own) {
          let e = named.get(name);
          if (!e) { e = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }; named.set(name, e); }
          for (let k = 0; k < 3; k++) { e.min[k] = Math.min(e.min[k], lo[k]); e.max[k] = Math.max(e.max[k], hi[k]); }
        }
        if (p) {
          let e = groups.get(p.group);
          if (!e) { e = { nodes: new Set(), min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }; groups.set(p.group, e); }
          e.nodes.add(p.node);
          for (let k = 0; k < 3; k++) { e.min[k] = Math.min(e.min[k], lo[k]); e.max[k] = Math.max(e.max[k], hi[k]); }
        }
      }
    }
    for (const c of n.children ?? []) walk(c, t2, s2, p, own);
  };
  for (const ni of json.scenes[json.scene ?? 0].nodes) walk(ni, [0, 0, 0], [1, 1, 1], null, []);
  const shift = [-(all.min[0] + all.max[0]) / 2, -all.min[1], -(all.min[2] + all.max[2]) / 2];
  const parts = [...groups.values()].map((e) => {
    const nodes = [...e.nodes].sort((a, b) => a.length - b.length || a.localeCompare(b));
    return {
      name: nodes[0], nodes,
      centre: [0, 1, 2].map((k) => (e.min[k] + e.max[k]) / 2 + shift[k]),
      size: [0, 1, 2].map((k) => e.max[k] - e.min[k]),
    };
  });
  const nodes = new Map<string, { centre: number[]; size: number[] }>();
  for (const [name, e] of named) nodes.set(name, { centre: [0, 1, 2].map((k) => (e.min[k] + e.max[k]) / 2 + shift[k]), size: [0, 1, 2].map((k) => e.max[k] - e.min[k]) });
  return { min: all.min.map((v, k) => v + shift[k]), max: all.max.map((v, k) => v + shift[k]), parts, nodes };
}
