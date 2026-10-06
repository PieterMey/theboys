// Owner: track ② Level. Furniture models (prop.* GLBs from /assets/manifest.json: meshopt + embedded KTX2),
// loaded once per type, normalised (centred on x/z, standing on y = 0) and cloned per placement.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { assetUrl, getAssetManifest, loadAssetManifest } from '@dead-air/shared/assets.ts';
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
      const root = new THREE.Group();
      root.name = `prop-model:${key}`;
      const model = gltf.scene;
      model.rotation.y = YAW_FIX[key] ?? 0;
      model.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(model);
      const c = bb.getCenter(new THREE.Vector3());
      const shift = new THREE.Matrix4().makeTranslation(-c.x, -bb.min.y, -c.z);
      // bake every sub-mesh into one geometry per material: 1 draw call per material per placed prop
      const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
      model.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || Array.isArray(m.material)) return;
        const g = toFloat32(m.geometry);
        g.applyMatrix4(new THREE.Matrix4().multiplyMatrices(shift, m.matrixWorld));
        const list = byMat.get(m.material) ?? [];
        list.push(g);
        byMat.set(m.material, list);
      });
      for (const [mat, geos] of byMat) {
        const attrs = (g: THREE.BufferGeometry) => Object.keys(g.attributes).sort().join(',');
        const sig = attrs(geos[0]);
        const same = geos.filter((g) => attrs(g) === sig).map((g) => (g.index ? g : g.toNonIndexed()));
        const merged = same.length > 1 ? mergeGeometries(same.map((g) => (g.index ? g.toNonIndexed() : g))) : same[0];
        if (!merged) continue;
        const mesh = new THREE.Mesh(merged, mat);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        root.add(mesh);
      }
      if (!root.children.length) {
        model.position.set(-c.x, -bb.min.y, -c.z);
        root.add(model);
      }
      return root;
    } catch (e) {
      console.warn(`[level] prop ${key} failed: ${e instanceof Error ? e.message : e}`);
      return null;
    }
  })();
  void p.finally(() => { pending--; });
  cache.set(key, p);
  return p;
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
