// Owner: track ⑤ Players. UAL mannequin rig loading: char.mannequin_m/_f + anim.ual1/ual2 clips via anim.clipmap.
// Clip hygiene at load (even though the build already did it): drop .scale tracks and .position tracks except
// root/pelvis. Missing assets -> null (callers keep the procedural placeholder).
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
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
    if (!g) continue;
    const scene = g.scene;
    scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(scene, false);
    const height = Math.max(0.5, box.max.y - box.min.y);
    const scale = height > 1.5 && height < 2.1 ? 1 : 1.75 / height;
    scene.traverse((o) => {
      const sm = o as THREE.SkinnedMesh;
      if (sm.isSkinnedMesh || (o as THREE.Mesh).isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        o.frustumCulled = false;
      }
    });
    lib.bodies[body] = { body, scene, scale, height: height * scale };
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
