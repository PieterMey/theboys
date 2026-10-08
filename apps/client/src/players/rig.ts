// Owner: track ⑤ Players. UAL mannequin rig loading: char.mannequin_m/_f + anim.ual1/ual2 clips via anim.clipmap.
// Clip hygiene at load (even though the build already did it): drop .scale tracks and .position tracks except
// root/pelvis. Missing assets -> null (callers keep the procedural placeholder).
// v1.2 draw budget: the mannequin's two skinned primitives (M_Main suit + M_Joints) are merged into ONE skinned mesh
// (vertex attribute 'jmask': 0 suit, 1 joint; cosmetics.ts bodyMaterial shades both), and the body is frustum culled
// against a fixed, pose-proof sphere instead of being drawn into every flashlight's shadow map.
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { deinterleaveGeometry, mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { assetUrl, getAssetManifest, loadAssetManifest } from '@dead-air/shared/assets.ts';
import type { ClipMap, ClipRef } from '@dead-air/shared/assets.ts';
import { ANIM } from '@dead-air/shared/anim.ts';
import type { BodyKind } from '@dead-air/shared/profile.ts';

export interface RigClip {
  clip: THREE.AnimationClip;
  loop: boolean;
  clamp: boolean;
  /** m/s the clip looks right at (timeScale = speed / naturalSpeed), 0 = fixed timeScale 1 */
  naturalSpeed: number;
  timeScale: number;
}

export interface RigTemplate {
  body: BodyKind;
  scene: THREE.Object3D;
  /** model-space scale applied to the clone so the body is PLAYER.height tall */
  scale: number;
  height: number;
}

export interface RigLib {
  bodies: Partial<Record<BodyKind, RigTemplate>>;
  /** ANIM id -> clip */
  clips: Map<number, RigClip>;
  clipmap: ClipMap | null;
}

/** visually tuned natural speeds (the clipmap's root-motion numbers look off, see its note) */
const NATURAL: Record<string, number> = { walk: 1.55, jog: 3.3, sprint: 5.4, crouchWalk: 1.15, carryWalk: 1.35, carry: 0 };

let libPromise: Promise<RigLib | null> | null = null;

export function loadRigLib(onLog: (m: string) => void): Promise<RigLib | null> {
  return (libPromise ??= doLoad(onLog).catch((e: unknown) => {
    onLog(`rig load failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }));
}

async function doLoad(onLog: (m: string) => void): Promise<RigLib | null> {
  if (!getAssetManifest()) await loadAssetManifest();
  const mUrl = assetUrl('char.mannequin_m'), fUrl = assetUrl('char.mannequin_f');
  const a1 = assetUrl('anim.ual1'), a2 = assetUrl('anim.ual2'), cm = assetUrl('anim.clipmap');
  if (!mUrl && !fUrl) return null;
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const load = (u: string | null) => (u ? loader.loadAsync(u).catch((e: unknown) => { onLog(`rig: ${u}: ${e instanceof Error ? e.message : e}`); return null; }) : Promise.resolve(null));
  const [gm, gf, g1, g2, clipmap] = await Promise.all([
    load(mUrl), load(fUrl), load(a1), load(a2),
    cm ? fetch(cm).then((r) => (r.ok ? (r.json() as Promise<ClipMap>) : null)).catch(() => null) : Promise.resolve(null),
  ]);
  const lib: RigLib = { bodies: {}, clips: new Map(), clipmap };
  for (const [body, g] of [['m', gm], ['f', gf]] as const) {
    if (g) lib.bodies[body] = prepareBody(body, g.scene, onLog);
  }
  // clips by file key, with hygiene
  const byFile = new Map<string, Map<string, THREE.AnimationClip>>();
  for (const [key, g] of [['anim.ual1', g1], ['anim.ual2', g2]] as const) {
    if (!g) continue;
    const m = new Map<string, THREE.AnimationClip>();
    for (const c of g.animations) m.set(c.name, cleanClip(c));
    byFile.set(key, m);
  }
  const pick = (ref: ClipRef | null | undefined): THREE.AnimationClip | null => {
    if (!ref || typeof ref !== 'object' || !('clip' in ref)) return null;
    return byFile.get(ref.file)?.get(ref.clip) ?? null;
  };
  const players = (clipmap?.players ?? {}) as Record<string, unknown>;
  const fallbackNames: Record<string, [string, string, boolean]> = {
    idle: ['anim.ual1', 'Idle_Loop', true], walk: ['anim.ual1', 'Walk_Loop', true], jog: ['anim.ual1', 'Jog_Fwd_Loop', true],
    sprint: ['anim.ual1', 'Sprint_Loop', true], crouchIdle: ['anim.ual1', 'Crouch_Idle_Loop', true], crouchWalk: ['anim.ual1', 'Crouch_Fwd_Loop', true],
    interact: ['anim.ual1', 'Interact', false], pickup: ['anim.ual1', 'PickUp_Table', false], carry: ['anim.ual2', 'Walk_Carry_Loop', true],
    carryWalk: ['anim.ual2', 'Walk_Carry_Loop', true], throw: ['anim.ual2', 'OverhandThrow', false], swing: ['anim.ual2', 'Sword_Regular_A', false],
    death: ['anim.ual1', 'Death01', false], emoteWave: ['anim.ual1', 'Spell_Simple_Idle_Loop', true], emotePoint: ['anim.ual1', 'Spell_Simple_Shoot', false],
    emoteBeckon: ['anim.ual1', 'Idle_Talking_Loop', true], emoteThumbs: ['anim.ual2', 'Yes', false], grabbed: ['anim.ual2', 'Hit_Knockback', false],
  };
  for (const [name, id] of Object.entries(ANIM)) {
    if (id >= 40) continue;
    const ref = players[name] as ClipRef | null | undefined;
    let clip = pick(ref ?? null);
    let loop = ref && typeof ref === 'object' && 'loop' in ref ? !!ref.loop : true;
    let clamp = !!(ref && typeof ref === 'object' && 'clampWhenFinished' in ref && ref.clampWhenFinished);
    if (!clip && fallbackNames[name]) {
      const [f, c, l] = fallbackNames[name];
      clip = byFile.get(f)?.get(c) ?? null;
      loop = l;
    }
    if (!clip) continue;
    if (name === 'death') clamp = true;
    lib.clips.set(id, { clip, loop, clamp: clamp || !loop, naturalSpeed: NATURAL[name] ?? 0, timeScale: 1 });
  }
  onLog(`rig: bodies ${Object.keys(lib.bodies).join('+') || 'none'}, ${lib.clips.size} clips`);
  return lib.clips.size || Object.keys(lib.bodies).length ? lib : null;
}

/**
 * A loaded mannequin scene -> its avatar template: the skinned parts merged (mergeBodyParts), measured (scale to
 * PLAYER height), shadow flags, and the skinned body culled against a pose-proof sphere (setCullSphere; clones copy
 * it). Exported for the unit tests (tests/players/avatar-merge.test.ts).
 */
export function prepareBody(body: BodyKind, scene: THREE.Object3D, onLog?: (m: string) => void): RigTemplate {
  const merged = mergeBodyParts(scene);
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene, false);
  const height = Math.max(0.5, box.max.y - box.min.y);
  const scale = height > 1.5 && height < 2.1 ? 1 : 1.75 / height;
  scene.traverse((o) => {
    const sm = o as THREE.SkinnedMesh;
    if (sm.isSkinnedMesh || (o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = sm.isSkinnedMesh ? setCullSphere(sm, box) : false;
    }
  });
  if (!merged) onLog?.(`rig: ${body} body parts kept separate (not mergeable)`);
  return { body, scene, scale, height: height * scale };
}

const materialName = (m: THREE.Material | THREE.Material[]): string => (Array.isArray(m) ? m[0]?.name : m?.name) ?? '';
const hasMaps = (m: THREE.Material | THREE.Material[]): boolean => (Array.isArray(m) ? m : [m]).some((x) => {
  const s = x as THREE.MeshStandardMaterial;
  return !!(s.map || s.normalMap || s.roughnessMap || s.metalnessMap || s.emissiveMap || s.aoMap || s.alphaMap);
});

/**
 * v1.2 draw budget: the UAL mannequin's two skinned primitives (M_Main suit, M_Joints) -> ONE skinned mesh bound to
 * the same skeleton, with a 0/1 'jmask' vertex attribute (cosmetics.ts bodyMaterial). geometry.userData.suitBox keeps
 * the suit part's own bind-pose box (the suit pattern space). Returns false and leaves the scene untouched unless
 * exactly two skinned parts share parent, placement, skeleton and attribute layout and carry no textures.
 */
export function mergeBodyParts(scene: THREE.Object3D): boolean {
  const parts: THREE.SkinnedMesh[] = [];
  scene.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) parts.push(o as THREE.SkinnedMesh); });
  if (parts.length !== 2) return false;
  const joint = parts.find((p) => /joint/i.test(materialName(p.material)));
  const main = parts.find((p) => p !== joint);
  const parent = main?.parent;
  if (!joint || !main || !parent || joint.parent !== parent) return false;
  const bonesA = main.skeleton?.bones ?? [], bonesB = joint.skeleton?.bones ?? [];
  if (!bonesA.length || bonesA.length !== bonesB.length || bonesA.some((b, i) => b !== bonesB[i])) return false;
  if (!main.bindMatrix.equals(joint.bindMatrix) || !main.position.equals(joint.position) || !main.quaternion.equals(joint.quaternion) || !main.scale.equals(joint.scale)) return false;
  if (hasMaps(main.material) || hasMaps(joint.material)) return false;
  const ga = main.geometry, gb = joint.geometry;
  const keys = (g: THREE.BufferGeometry) => Object.keys(g.attributes).sort().join(',');
  if (keys(ga) !== keys(gb) || !ga.index || !gb.index || Object.keys(ga.morphAttributes).length || Object.keys(gb.morphAttributes).length) return false;
  const tagged = [ga, gb].map((src, i) => {
    const g = src.clone();
    deinterleaveGeometry(g);
    g.setAttribute('jmask', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(i), 1));
    return g;
  });
  let geo: THREE.BufferGeometry | null = null;
  try { geo = mergeGeometries(tagged, false); } catch { geo = null; }
  if (!geo) return false;
  ga.computeBoundingBox();
  geo.userData.suitBox = (ga.boundingBox ?? new THREE.Box3()).clone();
  const body = new THREE.SkinnedMesh(geo, main.material);
  body.name = main.name || 'body';
  body.position.copy(main.position);
  body.quaternion.copy(main.quaternion);
  body.scale.copy(main.scale);
  body.bindMode = main.bindMode;
  body.bind(main.skeleton, main.bindMatrix);
  parent.add(body);
  parent.remove(main);
  parent.remove(joint);
  return true;
}

/**
 * A fixed bounding sphere in the skinned mesh's local space that every clip fits in: centre at half the body height,
 * radius 1.3 body heights (lying dead in any direction, a knock-back with pelvis motion). The default (the rest pose,
 * computed once) would clip animated limbs; no culling at all drew every body into every flashlight's shadow map.
 * `modelBox` is the template scene's box (the scene root at the identity). Returns true (cull against it).
 */
function setCullSphere(sm: THREE.SkinnedMesh, modelBox: THREE.Box3): boolean {
  const h = Math.max(0.5, modelBox.max.y - modelBox.min.y);
  const c = modelBox.getCenter(new THREE.Vector3());
  c.y = modelBox.min.y + h * 0.5;
  sm.updateWorldMatrix(true, false);
  const k = Math.max(1e-12, sm.matrixWorld.getMaxScaleOnAxis());
  sm.boundingSphere = new THREE.Sphere(c.applyMatrix4(sm.matrixWorld.clone().invert()), (h * 1.3) / k);
  return true;
}

/** UAL clip hygiene: keep rotations everywhere, translations only on root/pelvis, never scale */
export function cleanClip(c: THREE.AnimationClip): THREE.AnimationClip {
  const tracks = c.tracks.filter((t) => {
    const dot = t.name.lastIndexOf('.');
    const node = t.name.slice(0, dot);
    const prop = t.name.slice(dot + 1);
    if (prop === 'scale') return false;
    if (prop === 'position') return node === 'root' || node === 'pelvis';
    return true;
  });
  return new THREE.AnimationClip(c.name, c.duration, tracks);
}
