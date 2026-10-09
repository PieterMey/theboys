// Owner: track (c) Monsters. Monster models: mon.hound (restyled German Shepherd: blind milky eyes), the porcelain
// Mannequin (UAL mannequin, pale cracked glossy plaster) and the Listener (UAL mannequin with elongated bones: long neck
// and limbs, faceless cocked head, wet dark skin). GLTFLoader + meshopt; clips from anim.ual1/ual2 + the hound file,
// chosen via anim.clipmap. Missing assets -> null (index.ts keeps procedural placeholders).
// v1.1 THE SNATCHER: the same UAL mannequin rig, extreme thin/long-armed bone variant (arms ~2x, long fingers, small
// head, flattened body) in a dark, wet, mottled skin, posed procedurally into a hunched crawl (no crawl clips in the
// clipmap: crouch-walk legs + a world-space spine/neck bend, see poseSnatcher).
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
import type { MonsterKindX as MonsterKind } from '@dead-air/shared/messages/monsters.ts';

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
  snatcher: { [ANIM.mWalk]: 0.9, [ANIM.mRun]: 2.4 },
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
  const clipsFor = (kind: 'hound' | 'mannequin' | 'listener' | 'snatcher', fallback: Record<number, [string, string, boolean, number?]>) => {
    const out = new Map<number, MonsterClip>();
    const sect = ((clipmap as Record<string, unknown> | null)?.[kind] ?? {}) as Record<string, unknown>;
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
    const thin = SkeletonUtils.clone(man.scene);
    const sScale = fitScale(thin, 'height', 2.05);
    prepSnatcher(thin);
    lib.templates.snatcher = {
      kind: 'snatcher', scene: thin, scale: sScale,
      clips: clipsFor('snatcher', {
        [ANIM.mIdle]: ['anim.ual1', 'Crouch_Idle_Loop', true], [ANIM.mWalk]: ['anim.ual1', 'Crouch_Fwd_Loop', true],
        [ANIM.mRun]: ['anim.ual1', 'Crouch_Fwd_Loop', true, 1.8], [ANIM.mAttack]: ['anim.ual2', 'Zombie_Scratch', false],
        [ANIM.mAlert]: ['anim.ual1', 'Crouch_Idle_Loop', true], [ANIM.mEat]: ['anim.ual1', 'Fixing_Kneeling', true],
        [ANIM.mFrozen]: ['anim.ual1', 'Crouch_Idle_Loop', true, 0],
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

/** thin, long-armed: arm chain ~2x, long fingers, long neck + shins, small head (child offsets scaled = bone lengths) */
const SNATCH_STRETCH: Record<string, number> = {
  upperarm_l: 1.3, upperarm_r: 1.3, lowerarm_l: 2.0, lowerarm_r: 2.0, hand_l: 1.75, hand_r: 1.75,
  neck_01: 1.3, Head: 1.6, spine_02: 1.08, spine_03: 1.08, calf_l: 1.25, calf_r: 1.25, foot_l: 1.2, foot_r: 1.2,
};

function prepSnatcher(scene: THREE.Object3D): void {
  scene.traverse((o) => {
    const b = o as THREE.Bone;
    if (!b.isBone) return;
    const k = SNATCH_STRETCH[b.name] ?? (/^(index|middle|ring|pinky)_0[1-3]_[lr]$/.test(b.name) ? 1.8 : /^thumb_0[1-3]_[lr]$/.test(b.name) ? 1.4 : 0);
    if (k) b.position.multiplyScalar(k);
    if (b.name === 'Head') b.scale.setScalar(0.78);
    if (b.name === 'hand_l' || b.name === 'hand_r') b.scale.setScalar(1.25);
  });
  eachMesh(scene, (m) => {
    const mat = new THREE.MeshPhysicalNodeMaterial();
    const k = uniform(1 / geoSize(m));
    const p = positionGeometry.mul(k);
    // dark, wet, mottled skin: grey-olive bruising over near-black, dark vein cells, a glossy film with drier patches
    const n = mx_fractal_noise_float(p.mul(7.0), 4, 2, 0.55).mul(0.5).add(0.5);
    const cells = mx_worley_noise_vec2(p.mul(18.0), 1);
    const vein = smoothstep(float(0.0), float(0.06), cells.y.sub(cells.x)).oneMinus();
    const base = mix(color(0x050505), color(0x1c1d16), n.pow(1.6));
    mat.colorNode = mix(base, color(0x0a0303), vein.mul(0.8));
    mat.roughnessNode = mix(float(0.05), float(0.5), n.mul(n).add(vein.mul(0.3)));
    mat.metalness = 0.04;
    mat.clearcoat = 1;
    mat.clearcoatRoughness = 0.08;
    mat.specularIntensity = 1;
    m.material = mat;
  });
}

const _q = new THREE.Quaternion(), _pw = new THREE.Quaternion(), _pwi = new THREE.Quaternion(), _ax = new THREE.Vector3();

/** rotate `bone` by `angle` about a WORLD axis (keeps the clip's motion, adds a bend independent of bone axes) */
function bendWorld(bone: THREE.Object3D, axis: THREE.Vector3, angle: number): void {
  if (!bone.parent || angle === 0) return;
  bone.parent.updateWorldMatrix(true, false);
  bone.parent.getWorldQuaternion(_pw);
  _pwi.copy(_pw).invert();
  _q.setFromAxisAngle(axis, angle);
  // local' = parent^-1 * q * parent * local
  bone.quaternion.premultiply(_pwi.multiply(_q).multiply(_pw));
}

/** tunable crawl pose (radians) for the Snatcher; `?snpose=spine,neck,arms` overrides for look-dev */
export const SNATCH_POSE = (() => {
  const q = new URLSearchParams(location.search).get('snpose');
  const v = q ? q.split(',').map(Number) : [];
  return { spine: Number.isFinite(v[0]) ? v[0] : 1.05, neck: Number.isFinite(v[1]) ? v[1] : -0.95, arms: Number.isFinite(v[2]) ? v[2] : 0.55, drop: 0 };
})();

/** hunched, on-all-fours crawl on top of the crouch clip: torso pitched forward, head up, long arms reaching down/ahead */
export function poseSnatcher(m: MonsterModel, state: string, time: number): void {
  const b = (m.bones ??= collectBones(m.root));
  const root = m.root;
  root.updateWorldMatrix(true, false);
  // the character's right axis in world space (model faces +Z locally)
  _ax.set(1, 0, 0).applyQuaternion(root.getWorldQuaternion(new THREE.Quaternion())).normalize();
  const dragging = state === 'drag';
  const twitch = Math.sin(time * 23.0) * 0.04 + Math.sin(time * 7.3) * 0.03;
  if (b.spine_01) bendWorld(b.spine_01, _ax, SNATCH_POSE.spine * 0.55);
  if (b.spine_02) bendWorld(b.spine_02, _ax, SNATCH_POSE.spine * 0.3);
  if (b.spine_03) bendWorld(b.spine_03, _ax, SNATCH_POSE.spine * 0.15 + (dragging ? 0.1 : 0));
  if (b.neck_01) bendWorld(b.neck_01, _ax, SNATCH_POSE.neck * 0.6 + twitch);
  if (b.Head) bendWorld(b.Head, _ax, SNATCH_POSE.neck * 0.4 - twitch);
  for (const side of ['l', 'r'] as const) {
    const ua = b[`upperarm_${side}`];
    const swing = Math.sin(time * (dragging ? 5.5 : 4.2) + (side === 'l' ? 0 : Math.PI)) * 0.35;
    if (ua) bendWorld(ua, _ax, -SNATCH_POSE.arms + swing * (dragging ? 0.6 : 1));
  }
}

function collectBones(root: THREE.Object3D): Record<string, THREE.Object3D> {
  const out: Record<string, THREE.Object3D> = {};
  root.traverse((o) => { if ((o as THREE.Bone).isBone) out[o.name] = o; });
  return out;
}

/** v1.3 (Earwigs): the Listener's wet-skin material (its first body mesh), shared by every clone and the ears */
export function listenerSkin(lib: MonsterLib | null): THREE.Material | null {
  let out: THREE.Material | null = null;
  lib?.templates.listener?.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!out && m.isMesh && !Array.isArray(m.material)) out = m.material as THREE.Material;
  });
  return out;
}

export interface MonsterModel {
  bones?: Record<string, THREE.Object3D>;
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
  // the Snatcher is flattened (thin enough for a duct): narrower and shallower than it is long
  if (t.kind === 'snatcher') inner.scale.multiply(new THREE.Vector3(0.7, 1, 0.62));
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
