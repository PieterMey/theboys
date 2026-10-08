// Owner: env-paranormal (v1.2) client. The figure: the CC0 UAL mannequin (char.mannequin_m) posed with a hunched clip
// frame and baked into static geometry (no skinning pipelines, no per-frame bones): a hunched worker in wet coveralls
// for the mirror (ghost layer), a pitch-dark silhouette, and a shadow-only presence (phantom layer). Never porcelain,
// never elongated (those are the Mannequin and the Listener). Procedural capsule figure until / unless the model loads.
// Warm templates (one mesh per material + layer, invisible) live in the scene so render's warm set compiles them before
// the first presence / reflection.
import * as THREE from 'three/webgpu';
import { float, mix, mx_noise_float, positionLocal, smoothstep, vec3 } from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { assetUrl, getAssetManifest, loadAssetManifest } from '@dead-air/shared/assets.ts';
import { RENDER_LAYERS } from '../render/api.ts';

/** standing height of the hunched pose (m) */
const POSE_H = 1.66;
/** clip frames (s) of the hunched idle: 3 variants */
const POSE_T = [0.35, 1.15, 1.85];

export interface FigureLib {
  /** pose variants: position + normal (+ groups 0 = suit, 1 = joints/boots) */
  geos: THREE.BufferGeometry[];
  /** true once the mannequin replaced the capsule fallback */
  model: boolean;
  wet: THREE.Material[];
  dark: THREE.Material;
  phantom: THREE.Material;
}

let lib: FigureLib | null = null;
let loading: Promise<void> | null = null;

function materials(): Pick<FigureLib, 'wet' | 'dark' | 'phantom'> {
  // wet coveralls: dark olive drab, soaked toward the hem and in patches (glossy where wet)
  const n = mx_noise_float(positionLocal.mul(5.5)).mul(0.5).add(0.5);
  const soak = smoothstep(0.75, 0.15, positionLocal.y).max(smoothstep(0.55, 0.8, n)).clamp(0, 1);
  const suit = new THREE.MeshStandardNodeMaterial({ roughness: 0.6, metalness: 0 });
  suit.colorNode = mix(vec3(0.085, 0.1, 0.08), vec3(0.035, 0.045, 0.038), soak);
  suit.roughnessNode = mix(float(0.66), float(0.16), soak);
  suit.name = 'para-figure-suit';
  const boots = new THREE.MeshStandardNodeMaterial({ color: 0x0a0b0b, roughness: 0.32, metalness: 0 });
  boots.name = 'para-figure-boots';
  // silhouette: pitch dark, even in a beam (it is not lit like a person)
  const dark = new THREE.MeshBasicNodeMaterial({ color: 0x020202 });
  dark.name = 'para-silhouette';
  // presence: only ever drawn by shadow cameras (phantom layer)
  const phantom = new THREE.MeshBasicNodeMaterial({ color: 0x000000 });
  phantom.name = 'para-phantom';
  return { wet: [suit, boots], dark, phantom };
}

/** capsule figure (position + normal only, same layout as the baked model), hunched forward */
function capsuleFigure(variant: number): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const add = (g: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0, rz = 0) => {
    g.rotateX(rx);
    g.rotateZ(rz);
    g.translate(x, y, z);
    g.deleteAttribute('uv');
    parts.push(g.index ? g.toNonIndexed() : g);
  };
  const lean = 0.28 + variant * 0.05;
  add(new THREE.CapsuleGeometry(0.075, 0.72, 4, 8), -0.11, 0.42, 0.02);
  add(new THREE.CapsuleGeometry(0.075, 0.72, 4, 8), 0.11, 0.42, -0.02);
  add(new THREE.CapsuleGeometry(0.17, 0.42, 4, 10), 0, 1.08, 0.1, lean);
  add(new THREE.SphereGeometry(0.11, 12, 10), 0, 1.44, 0.26);
  add(new THREE.CapsuleGeometry(0.055, 0.58, 4, 8), -0.24, 1.0, 0.16, 0.35, 0.12);
  add(new THREE.CapsuleGeometry(0.055, 0.58, 4, 8), 0.24, 0.98, 0.18, 0.4, -0.12);
  const g = mergeGeometries(parts, false)!;
  g.clearGroups();
  g.addGroup(0, g.attributes.position.count, 0);
  g.computeVertexNormals();
  return g;
}

/** bake one pose of every skinned mesh of `scene` into a static, normalized geometry */
function bake(scene: THREE.Object3D, clip: THREE.AnimationClip | null, t: number): THREE.BufferGeometry | null {
  const root = SkeletonUtils.clone(scene);
  if (clip) {
    const mixer = new THREE.AnimationMixer(root);
    mixer.clipAction(clip).play();
    mixer.setTime(t);
  }
  root.updateMatrixWorld(true);
  const parts: THREE.BufferGeometry[] = [];
  const mats: string[] = [];
  const v = new THREE.Vector3();
  root.traverse((o) => {
    const sm = o as THREE.SkinnedMesh;
    if (!sm.isSkinnedMesh) return;
    const src = sm.geometry;
    const pos = src.attributes.position;
    const out = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      sm.applyBoneTransform(i, v);
      v.applyMatrix4(sm.matrixWorld);
      out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(out, 3));
    if (src.index) g.setIndex(src.index.clone());
    parts.push(g);
    mats.push((Array.isArray(sm.material) ? sm.material[0] : sm.material)?.name ?? '');
  });
  if (!parts.length) return null;
  // suit first, joints second (material order of the merged groups)
  const order = parts.map((_, i) => i).sort((a, b) => (mats[a] === 'M_Joints' ? 1 : 0) - (mats[b] === 'M_Joints' ? 1 : 0));
  const merged = mergeGeometries(order.map((i) => parts[i]), true);
  if (!merged) return null;
  merged.computeBoundingBox();
  const bb = merged.boundingBox!;
  const h = bb.max.y - bb.min.y;
  if (!(h > 0.1)) return null;
  const k = POSE_H / h;
  merged.translate(-(bb.min.x + bb.max.x) / 2, -bb.min.y, -(bb.min.z + bb.max.z) / 2);
  merged.scale(k, k, k);
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  return merged;
}

async function loadModel(log: (m: string) => void): Promise<THREE.BufferGeometry[] | null> {
  if (!getAssetManifest()) await loadAssetManifest();
  const charUrl = assetUrl('char.mannequin_m');
  if (!charUrl) return null;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const [ch, a2, a1] = await Promise.all([
    loader.loadAsync(charUrl),
    assetUrl('anim.ual2') ? loader.loadAsync(assetUrl('anim.ual2')!).catch(() => null) : Promise.resolve(null),
    assetUrl('anim.ual1') ? loader.loadAsync(assetUrl('anim.ual1')!).catch(() => null) : Promise.resolve(null),
  ]);
  const clip = a2?.animations.find((c) => c.name === 'Zombie_Idle_Loop') ?? a1?.animations.find((c) => c.name === 'Idle_Loop') ?? null;
  if (!clip) log('paranormal: no hunched clip, using the bind pose');
  const out: THREE.BufferGeometry[] = [];
  for (const t of POSE_T) {
    const g = bake(ch.scene, clip, t);
    if (g) out.push(g);
  }
  return out.length ? out : null;
}

/** the figure library (capsule geometry at once, the baked mannequin when it loads) */
export function figures(log: (m: string) => void): FigureLib {
  if (!lib) {
    lib = { geos: [0, 1, 2].map(capsuleFigure), model: false, ...materials() };
    loading ??= loadModel(log).then((geos) => {
      if (!geos || !lib) return;
      for (let i = 0; i < lib.geos.length; i++) {
        const old = lib.geos[i];
        lib.geos[i] = geos[i % geos.length];
        old.dispose();
      }
      lib.model = true;
      for (const fn of swapSubs) fn();
    }, (e: unknown) => log(`paranormal: figure model failed: ${e instanceof Error ? e.message : e}`));
  }
  return lib;
}

const swapSubs = new Set<() => void>();
/** called when the baked model replaces the capsules (live meshes swap their geometry) */
export function onFigureSwap(fn: () => void): () => void {
  swapSubs.add(fn);
  return () => swapSubs.delete(fn);
}

export type FigureLook = 'wet' | 'dark' | 'phantom';

/** a figure mesh for one effect (the caller parents and disposes it; materials + geometry stay shared) */
export function figureMesh(look: FigureLook, variant: number, log: (m: string) => void): THREE.Mesh {
  const L = figures(log);
  const geo = L.geos[Math.abs(variant) % L.geos.length];
  const mat: THREE.Material | THREE.Material[] = look === 'wet' ? L.wet : look === 'dark' ? L.dark : L.phantom;
  const m = new THREE.Mesh(geo, mat);
  m.name = `para-figure-${look}`;
  m.frustumCulled = false;
  if (look === 'phantom') {
    m.layers.set(RENDER_LAYERS.phantom);
    m.castShadow = true;
  } else if (look === 'wet') {
    m.layers.set(RENDER_LAYERS.ghost);
    m.castShadow = false;
  } else {
    m.castShadow = false;
  }
  m.receiveShadow = false;
  const off = onFigureSwap(() => { m.geometry = figures(log).geos[Math.abs(variant) % figures(log).geos.length]; });
  m.userData.paraDispose = off;
  return m;
}

export function disposeFigureMesh(m: THREE.Mesh): void {
  m.removeFromParent();
  const off = m.userData.paraDispose as (() => void) | undefined;
  off?.();
}

/**
 * invisible warm templates: render's warm set builds proxies of every ghost / phantom layer mesh in the scene (and of
 * meshes it is told about), so the first reflection / shadow of a figure compiles nothing new. The dark silhouette
 * also carries the phantom bit so its main-pass program warms through the same set (proxies keep the layer mask).
 */
export function warmTemplates(log: (m: string) => void): THREE.Group {
  const g = new THREE.Group();
  g.name = 'para-warm';
  const wet = figureMesh('wet', 0, log);
  const ph = figureMesh('phantom', 0, log);
  const dk = figureMesh('dark', 0, log);
  dk.layers.mask = (1 << 0) | (1 << RENDER_LAYERS.phantom);
  for (const m of [wet, ph, dk]) {
    m.visible = false;
    m.position.set(0, -50, 0);
    g.add(m);
  }
  return g;
}
