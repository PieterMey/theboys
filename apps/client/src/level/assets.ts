// Owner: track ② Level. Furniture models (prop.* GLBs from /assets/manifest.json: meshopt + embedded KTX2),
// loaded once per type, normalised (centred on x/z, standing on y = 0) and cloned per placement.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
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
      model.position.set(-c.x, -bb.min.y, -c.z);
      root.add(model);
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) { m.castShadow = true; m.receiveShadow = true; }
      });
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
