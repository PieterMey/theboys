// Owner: track (c) Monsters. Monster models: mon.hound (restyled German Shepherd: blind milky eyes), the porcelain
// Mannequin (UAL mannequin, pale cracked glossy plaster) and the Listener (UAL mannequin with elongated bones: long neck
// and limbs, faceless cocked head, wet dark skin). GLTFLoader + meshopt; clips from anim.ual1/ual2 + the hound file,
// chosen via anim.clipmap. Missing assets -> null (index.ts keeps procedural placeholders).
import * as THREE from 'three/webgpu';
import {
  color, float, luminance, materialColor, mix, mx_fractal_noise_float, mx_noise_float, mx_worley_noise_vec2, positionGeometry, smoothstep, uniform, vec3,
} from 'three/tsl';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { assetUrl, getAssetManifest, loadAssetManifest } from '@dead-air/shared/assets.ts';
import type { ClipMap, ClipRef } from '@dead-air/shared/assets.ts';
import { ANIM } from '@dead-air/shared/anim.ts';
import type { MonsterKind } from '@dead-air/shared/state.ts';

export interface MonsterClip {
  clip: THREE.AnimationClip;
  loop: boolean;
  timeScale: number;
  /** m/s the clip looks right at (0 = fixed) */
  natural: number;
}

export interface MonsterTemplate {
  kind: MonsterKind;
  scene: THREE.Object3D;
  scale: number;
  clips: Map<number, MonsterClip>;
}

export interface MonsterLib {
  templates: Partial<Record<MonsterKind, MonsterTemplate>>;
}

const MONSTER_ANIMS: [string, number][] = [
  ['mIdle', ANIM.mIdle], ['mWalk', ANIM.mWalk], ['mRun', ANIM.mRun], ['mAttack', ANIM.mAttack],
  ['mAlert', ANIM.mAlert], ['mEat', ANIM.mEat], ['mFrozen', ANIM.mFrozen],
];

/** visually tuned natural speeds (m/s) */
const NATURAL: Record<string, Record<number, number>> = {
  hound: { [ANIM.mWalk]: 1.35, [ANIM.mRun]: 5.2 },
  mannequin: { [ANIM.mWalk]: 1.5, [ANIM.mRun]: 5.6 },
  listener: { [ANIM.mWalk]: 1.0, [ANIM.mRun]: 2.6 },
};

let libPromise: Promise<MonsterLib | null> | null = null;

export function loadMonsterLib(log: (m: string) => void): Promise<MonsterLib | null> {
  return (libPromise ??= doLoad(log).catch((e: unknown) => {
    log(`monster models failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }));
}

function cleanClip(c: THREE.AnimationClip): THREE.AnimationClip {
  const keep = c.tracks.filter((t) => {
    const [node, prop] = splitTrack(t.name);
    if (prop === 'scale') return false;
    if (prop === 'position') return /^(root|pelvis|Body)$/i.test(node);
    return true;
  });
  return new THREE.AnimationClip(c.name, c.duration, keep);
}

function splitTrack(name: string): [string, string] {
  const i = name.lastIndexOf('.');
  return [name.slice(0, i), name.slice(i + 1)];
}

async function doLoad(log: (m: string) => void): Promise<MonsterLib | null> {
  if (!getAssetManifest()) await loadAssetManifest();
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const load = (key: string) => {
    const u = assetUrl(key);
    return u ? loader.loadAsync(u).catch((e: unknown) => { log(`monsters: ${key}: ${e instanceof Error ? e.message : e}`); return null; }) : Promise.resolve(null);
  };
  const cmUrl = assetUrl('anim.clipmap');
  const [hound, man, ual1, ual2, clipmap] = await Promise.all([
    load('mon.hound'), load('char.mannequin_m'), load('anim.ual1'), load('anim.ual2'),
    cmUrl ? fetch(cmUrl).then((r) => (r.ok ? (r.json() as Promise<ClipMap>) : null)).catch(() => null) : Promise.resolve(null),
  ]);
  const files = new Map<string, Map<string, THREE.AnimationClip>>();
  for (const [k, g] of [['anim.ual1', ual1], ['anim.ual2', ual2], ['mon.hound', hound]] as const) {
    if (!g) continue;
    const m = new Map<string, THREE.AnimationClip>();
    for (const c of g.animations) m.set(c.name, k === 'mon.hound' ? c : cleanClip(c));
    files.set(k, m);
  }
  const clipsFor = (kind: 'hound' | 'mannequin' | 'listener', fallback: Record<number, [string, string, boolean, number?]>) => {
    const out = new Map<number, MonsterClip>();
    const sect = (clipmap?.[kind] ?? {}) as Record<string, unknown>;
    for (const [name, id] of MONSTER_ANIMS) {
      const ref = sect[name] as ClipRef | undefined;
      let clip: THREE.AnimationClip | null = null, loop = true, ts = 1;
      if (ref && typeof ref === 'object' && 'clip' in ref) {
        clip = files.get(ref.file)?.get(ref.clip) ?? null;
        loop = ref.loop !== false;
        ts = typeof ref.timeScale === 'number' ? ref.timeScale : 1;
      }
      if (!clip && fallback[id]) {
        const [f, c, l, t] = fallback[id];
        clip = files.get(f)?.get(c) ?? null;
        loop = l;
        ts = t ?? 1;
      }
      if (clip) out.set(id, { clip, loop, timeScale: ts, natural: NATURAL[kind]?.[id] ?? 0 });
    }
    return out;
  };
  const lib: MonsterLib = { templates: {} };
  if (hound) {
    const scene = hound.scene;
    prepHound(scene);
    stretchHound(scene);
    const scale = fitScale(scene, 'length', 1.75);
    lib.templates.hound = {
      kind: 'hound', scene, scale,
      clips: clipsFor('hound', {
        [ANIM.mIdle]: ['mon.hound', 'Idle_2_HeadLow', true], [ANIM.mWalk]: ['mon.hound', 'Walk', true], [ANIM.mRun]: ['mon.hound', 'Run', true],
        [ANIM.mAttack]: ['mon.hound', 'Attack', false], [ANIM.mAlert]: ['mon.hound', 'Idle_2', false], [ANIM.mEat]: ['mon.hound', 'Eating', true],
        [ANIM.mFrozen]: ['mon.hound', 'Idle', true, 0],
      }),
    };
  }
  if (man) {
    const porcelain = SkeletonUtils.clone(man.scene);
    prepMannequin(porcelain);
    lib.templates.mannequin = {
      kind: 'mannequin', scene: porcelain, scale: fitScale(porcelain, 'height', 1.86),
      clips: clipsFor('mannequin', {
        [ANIM.mIdle]: ['anim.ual1', 'Walk_Formal_Loop', true, 0], [ANIM.mWalk]: ['anim.ual1', 'Walk_Formal_Loop', true],
        [ANIM.mRun]: ['anim.ual1', 'Sprint_Loop', true], [ANIM.mAttack]: ['anim.ual1', 'Punch_Cross', false],
        [ANIM.mAlert]: ['anim.ual1', 'Idle_Loop', true], [ANIM.mFrozen]: ['anim.ual1', 'Walk_Formal_Loop', true, 0],
      }),
    };
    const wet = SkeletonUtils.clone(man.scene);
    const baseScale = fitScale(wet, 'height', 1.8);
    prepListener(wet);
    lib.templates.listener = {
      kind: 'listener', scene: wet, scale: baseScale,
      clips: clipsFor('listener', {
        [ANIM.mIdle]: ['anim.ual2', 'Zombie_Idle_Loop', true], [ANIM.mWalk]: ['anim.ual2', 'Zombie_Walk_Fwd_Loop', true],
        [ANIM.mRun]: ['anim.ual2', 'Zombie_Walk_Fwd_Loop', true, 2.2], [ANIM.mAttack]: ['anim.ual2', 'Zombie_Scratch', false],
        [ANIM.mAlert]: ['anim.ual2', 'Idle_No_Loop', false], [ANIM.mEat]: ['anim.ual1', 'Fixing_Kneeling', true],
        [ANIM.mFrozen]: ['anim.ual2', 'Zombie_Idle_Loop', true, 0],
      }),
    };
  }
  log(`monsters: models ${Object.keys(lib.templates).join(', ') || 'none'}`);
  return Object.keys(lib.templates).length ? lib : null;
}

function fitScale(scene: THREE.Object3D, axis: 'height' | 'length', target: number): number {
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene, false);
  const size = box.getSize(new THREE.Vector3());
  const v = axis === 'height' ? size.y : Math.max(size.x, size.z);
  return v > 1e-4 ? target / v : 1;
}

function eachMesh(root: THREE.Object3D, fn: (m: THREE.Mesh) => void): void {
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      const m = o as THREE.Mesh;
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      fn(m);
    }
  });
}

/** body size in raw geometry units (positions may be quantized) for noise frequencies */
function geoSize(m: THREE.Mesh): number {
  const g = m.geometry as THREE.BufferGeometry;
  g.computeBoundingBox();
  const s = g.boundingBox!.getSize(new THREE.Vector3());
  return Math.max(s.x, s.y, s.z) || 1;
}

function prepHound(scene: THREE.Object3D): void {
  eachMesh(scene, (m) => {
    const src = m.material as THREE.MeshStandardMaterial;
    // PBR again (look pass, track ③): re-verified with the full render pipeline that Standard/Physical shade this
    // skinned GLB correctly now (tests/render/houndlab.e2e.ts). Lambert read as a flat black cut-out; a damp, matted
    // hide with a fur sheen catches the flashlight on the ribs, shoulders and skull, so the shape reads in the dark.
    // The friendly tan coat must go: the atlas multiplied down to a near-black, slightly brown mangy hide.
    const mat = new THREE.MeshPhysicalNodeMaterial();
    if (src.map) mat.map = src.map;
    // desaturated + crushed: a grey-black hide where the tan was, the white patches stay a dirty grey
    const lum = luminance(materialColor.rgb);
    mat.colorNode = mix(vec3(0.006, 0.0055, 0.005), vec3(0.045, 0.04, 0.036), smoothstep(float(0.05), float(0.9), lum));
    const k = uniform(1 / geoSize(m));
    const wet = mx_fractal_noise_float(positionGeometry.mul(k).mul(9.0), 3, 2, 0.5).mul(0.5).add(0.5);
    // matted wet clumps (glossy) between dry, dusty fur
    mat.roughnessNode = mix(float(0.32), float(0.78), smoothstep(float(0.35), float(0.7), wet));
    mat.metalness = 0;
    mat.sheen = 0.6;
    mat.sheenRoughness = 0.55;
    mat.sheenColor = new THREE.Color(0x5a5550);
    m.material = mat;
  });
}

/** lankier, taller legs + longer neck: an emaciated, wrong-looking dog */
function stretchHound(scene: THREE.Object3D): void {
  const K: Record<string, number> = { 'FrontLowerLeg.L': 1.28, 'FrontLowerLeg.R': 1.28, 'BackLowerLeg.L': 1.25, 'BackLowerLeg.R': 1.25, Neck2: 1.2, Neck3: 1.2, Head: 1.15 };
  scene.traverse((o) => {
    const b = o as THREE.Bone;
    if (b.isBone && K[b.name]) b.position.multiplyScalar(K[b.name]);
  });
}

function prepMannequin(scene: THREE.Object3D): void {
  eachMesh(scene, (m) => {
    const mat = new THREE.MeshPhysicalNodeMaterial();
    const k = uniform(1 / geoSize(m));
    const p = positionGeometry.mul(k);
    // porcelain: pale, faintly warm, with hairline cracks in patches + grime in the creases
    const cells = mx_worley_noise_vec2(p.mul(14.0), 1);
    const edge = smoothstep(float(0.0), float(0.045), cells.y.sub(cells.x)).oneMinus();
    const patch = smoothstep(float(0.05), float(0.35), mx_noise_float(p.mul(3.2)));
    const crack = edge.mul(patch);
    const grime = mx_fractal_noise_float(p.mul(6.0), 3, 2, 0.5).mul(0.5).add(0.5);
    const base = mix(color(0x3a3733), color(0x26231f), grime.mul(0.6));
    mat.colorNode = mix(base, color(0x1d1815), crack.mul(0.95));
    mat.roughnessNode = mix(float(0.38), float(0.85), crack.max(grime.mul(0.3)));
    mat.metalness = 0;
    mat.clearcoat = 0.35;
    mat.clearcoatRoughness = 0.3;
    m.material = mat;
  });
}

/** bones to lengthen (child bone offsets scaled): long neck, long limbs, slightly longer torso */
const STRETCH: Record<string, number> = {
  Head: 2.7, neck_01: 1.25, spine_02: 1.12, spine_03: 1.12,
  lowerarm_l: 1.38, lowerarm_r: 1.38, hand_l: 1.42, hand_r: 1.42, upperarm_l: 1.1, upperarm_r: 1.1,
  calf_l: 1.22, calf_r: 1.22, foot_l: 1.24, foot_r: 1.24,
};

function prepListener(scene: THREE.Object3D): void {
  scene.traverse((o) => {
    const b = o as THREE.Bone;
    if (!b.isBone) return;
    const k = STRETCH[b.name];
    if (k) b.position.multiplyScalar(k);
    // uniform scales only (non-uniform parent scale shears children): small head, big hands
    if (b.name === 'Head') b.scale.setScalar(0.86);
    if (b.name === 'hand_l' || b.name === 'hand_r') b.scale.setScalar(1.32);
  });
  eachMesh(scene, (m) => {
    const mat = new THREE.MeshPhysicalNodeMaterial();
    const k = uniform(1 / geoSize(m));
    const p = positionGeometry.mul(k);
    const n = mx_fractal_noise_float(p.mul(11.0), 4, 2, 0.55).mul(0.5).add(0.5);
    // wet near-black skin, faint bruised undertone, glossy wet film with drier blotches
    mat.colorNode = mix(color(0x040405), color(0x16100f), n.pow(2.0));
    mat.roughnessNode = mix(float(0.06), float(0.4), n.mul(n));
    mat.metalness = 0.05;
    mat.clearcoat = 1;
    mat.clearcoatRoughness = 0.05;
    mat.specularIntensity = 1;
    m.material = mat;
  });
}

export interface MonsterModel {
  root: THREE.Group;
  mixer: THREE.AnimationMixer;
  actions: Map<number, THREE.AnimationAction>;
  clips: Map<number, MonsterClip>;
  head: THREE.Object3D | null;
  neck: THREE.Object3D | null;
}

export function instantiate(t: MonsterTemplate): MonsterModel {
  const inner = SkeletonUtils.clone(t.scene);
  inner.scale.multiplyScalar(t.scale);
  const root = new THREE.Group();
  root.add(inner);
  const mixer = new THREE.AnimationMixer(inner);
  const actions = new Map<number, THREE.AnimationAction>();
  for (const [id, c] of t.clips) {
    const a = mixer.clipAction(c.clip);
    a.setLoop(c.loop ? THREE.LoopRepeat : THREE.LoopOnce, c.loop ? Infinity : 1);
    a.clampWhenFinished = !c.loop;
    actions.set(id, a);
  }
  let head: THREE.Object3D | null = null, neck: THREE.Object3D | null = null, body: THREE.Object3D | null = null;
  inner.traverse((o) => {
    if (o.name === 'Head') head = o;
    if (o.name === 'neck_01' || o.name === 'Neck3') neck = o;
    if (o.name === 'Body' || o.name === 'Torso') body ??= o;
  });
  if (t.kind === 'hound' && head && body && EYES) addBlindEyes(root, head, body);
  return { root, mixer, actions, clips: t.clips, head, neck };
}

const EYES = new URLSearchParams(location.search).get('houndeyes') !== '0';
const EYE_MAT = (() => {
  const m = new THREE.MeshBasicNodeMaterial();
  m.colorNode = vec3(0.78, 0.84, 0.88).mul(1.6);
  return m;
})();
const EYE_GEO = new THREE.SphereGeometry(1, 10, 8);
const HALO_MAT = new THREE.MeshBasicNodeMaterial({ color: 0xffc98a, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false });

/** kennel (hub) hound: a soft additive glow around the blind eyes so it reads behind the fence in the dark (no extra lights) */
export function addKennelGlow(m: MonsterModel): void {
  const eyes: THREE.Mesh[] = [];
  m.root.traverse((o) => { const e = o as THREE.Mesh; if (e.isMesh && e.material === EYE_MAT) eyes.push(e); });
  for (const e of eyes) {
    const halo = new THREE.Mesh(EYE_GEO, HALO_MAT);
    halo.scale.setScalar(3.2);
    halo.castShadow = false;
    halo.frustumCulled = false;
    halo.renderOrder = 2;
    e.add(halo);
  }
}

/** milky, faintly glowing blind eyes parented to the head bone (they catch the dark first) */
function addBlindEyes(root: THREE.Object3D, head: THREE.Object3D, body: THREE.Object3D): void {
  root.updateMatrixWorld(true);
  const hp = head.getWorldPosition(new THREE.Vector3());
  const bp = body.getWorldPosition(new THREE.Vector3());
  const fwd = new THREE.Vector3(hp.x - bp.x, 0, hp.z - bp.z);
  if (fwd.lengthSq() < 1e-8) return;
  fwd.normalize();
  const side = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
  const ws = head.getWorldScale(new THREE.Vector3());
  for (const sgn of [1, -1]) {
    const w = hp.clone().addScaledVector(fwd, 0.085).add(new THREE.Vector3(0, 0.045, 0)).addScaledVector(side, 0.034 * sgn);
    const eye = new THREE.Mesh(EYE_GEO, EYE_MAT);
    eye.position.copy(head.worldToLocal(w));
    eye.scale.set(0.013 / ws.x, 0.011 / ws.y, 0.013 / ws.z);
    eye.castShadow = false;
    eye.frustumCulled = false;
    head.add(eye);
  }
}
