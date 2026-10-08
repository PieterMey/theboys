// env-world test helper: a prop GLB (meshopt + KHR_mesh_quantization) decoded in Node into a THREE hierarchy of plain
// meshes (positions + indices only, no textures), so the client loader's buildTemplate() and the container slot probes
// run on the real model geometry without a GPU. Also a ray / triangle soup helper for line-of-sight checks.
import * as THREE from 'three/webgpu';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { REPO } from './harness.ts';

/** the GLB of a prop key: env-layout's build cache, else the staged dist (null when neither exists) */
export function glbPath(key: string): string | null {
  const build = join(REPO, '.assets/build/props', `${key}.glb`);
  if (existsSync(build)) return build;
  const stage = process.env.ASSETS_DIR ?? 'C:/Users/Pieter/AppData/Local/Temp/dead-air-assets-stage';
  const dist = stage.endsWith('dist') ? stage : join(stage, 'dist');
  const man = join(dist, 'manifest.json');
  if (!existsSync(man)) return null;
  const e = (JSON.parse(readFileSync(man, 'utf8')) as { files: Record<string, { url: string }> }).files[`prop.${key}`];
  return e ? join(dist, e.url) : null;
}

interface Node { name?: string; mesh?: number; children?: number[]; translation?: number[]; rotation?: number[]; scale?: number[]; matrix?: number[] }
interface Json {
  nodes: Node[]; scenes: { nodes: number[] }[]; scene?: number;
  meshes: { primitives: { attributes: Record<string, number>; indices?: number }[] }[];
  accessors: { bufferView: number; byteOffset?: number; componentType: number; count: number; type: string; normalized?: boolean }[];
  bufferViews: { byteOffset?: number; byteLength: number; byteStride?: number; extensions?: { EXT_meshopt_compression?: { byteOffset?: number; byteLength: number; byteStride: number; count: number; mode: string; filter?: string } } }[];
}
const SIZE: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

/** decode a .glb into a THREE.Group (node names kept, TRS kept, one plain mesh per primitive) */
export async function loadGlbModel(path: string): Promise<THREE.Group> {
  await MeshoptDecoder.ready;
  const buf = readFileSync(path);
  const jl = buf.readUInt32LE(12);
  const json = JSON.parse(buf.subarray(20, 20 + jl).toString('utf8')) as Json;
  const binLen = buf.readUInt32LE(20 + jl);
  const bin = new Uint8Array(buf.buffer, buf.byteOffset + 20 + jl + 8, binLen);
  const views = json.bufferViews.map((bv) => {
    const ext = bv.extensions?.EXT_meshopt_compression;
    if (!ext) return { data: bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength), stride: bv.byteStride };
    const out = new Uint8Array(ext.count * ext.byteStride);
    MeshoptDecoder.decodeGltfBuffer(out, ext.count, ext.byteStride, bin.subarray(ext.byteOffset ?? 0, (ext.byteOffset ?? 0) + ext.byteLength), ext.mode, ext.filter ?? 'NONE');
    return { data: out, stride: ext.byteStride as number | undefined };
  });
  const read = (ai: number): Float32Array | Uint32Array => {
    const a = json.accessors[ai];
    const v = views[a.bufferView];
    const nc = SIZE[a.type] ?? 1;
    const es = ({ 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 } as Record<number, number>)[a.componentType];
    const stride = v.stride ?? nc * es;
    const dv = new DataView(v.data.buffer, v.data.byteOffset, v.data.byteLength);
    const isIndex = a.type === 'SCALAR';
    const out = isIndex ? new Uint32Array(a.count) : new Float32Array(a.count * nc);
    for (let i = 0; i < a.count; i++) for (let c = 0; c < nc; c++) {
      const p = (a.byteOffset ?? 0) + i * stride + c * es;
      let x: number;
      switch (a.componentType) {
        case 5120: x = dv.getInt8(p); if (a.normalized) x = Math.max(-1, x / 127); break;
        case 5121: x = dv.getUint8(p); if (a.normalized) x /= 255; break;
        case 5122: x = dv.getInt16(p, true); if (a.normalized) x = Math.max(-1, x / 32767); break;
        case 5123: x = dv.getUint16(p, true); if (a.normalized) x /= 65535; break;
        case 5125: x = dv.getUint32(p, true); break;
        default: x = dv.getFloat32(p, true);
      }
      out[i * nc + c] = x;
    }
    return out;
  };
  const mat = new THREE.MeshStandardNodeMaterial();
  const build = (ni: number): THREE.Object3D => {
    const n = json.nodes[ni];
    const o = new THREE.Group();
    o.name = n.name ?? '';
    if (n.matrix) new THREE.Matrix4().fromArray(n.matrix).decompose(o.position, o.quaternion, o.scale);
    else {
      if (n.translation) o.position.fromArray(n.translation);
      if (n.rotation) o.quaternion.fromArray(n.rotation);
      if (n.scale) o.scale.fromArray(n.scale);
    }
    if (n.mesh !== undefined) for (const pr of json.meshes[n.mesh].primitives) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(read(pr.attributes.POSITION) as Float32Array, 3));
      if (pr.indices !== undefined) g.setIndex(new THREE.BufferAttribute(read(pr.indices) as Uint32Array, 1));
      o.add(new THREE.Mesh(g, mat));
    }
    for (const c of n.children ?? []) o.add(build(c));
    return o;
  };
  const root = new THREE.Group();
  for (const ni of json.scenes[json.scene ?? 0].nodes) root.add(build(ni));
  return root;
}

/** distances along a ray (o + t d, |d| = 1) at which it crosses any triangle of the geometries (world positions) */
export function rayHits(geos: readonly THREE.BufferGeometry[], o: THREE.Vector3, d: THREE.Vector3, maxT: number): number[] {
  const out: number[] = [];
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), hit = new THREE.Vector3();
  const ray = new THREE.Ray(o, d);
  for (const g of geos) {
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const idx = g.index;
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i + 2 < n; i += 3) {
      a.fromBufferAttribute(pos, idx ? idx.getX(i) : i);
      b.fromBufferAttribute(pos, idx ? idx.getX(i + 1) : i + 1);
      c.fromBufferAttribute(pos, idx ? idx.getX(i + 2) : i + 2);
      if (ray.intersectTriangle(a, b, c, false, hit)) { const t = hit.distanceTo(o); if (t > 1e-5 && t < maxT) out.push(t); }
    }
  }
  return out.sort((x, y) => x - y);
}
