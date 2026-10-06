// Owner: track ⑤ Players. Remote avatars from world.samplePlayer(id): procedural placeholder until the UAL rig
// loads, then a SkeletonUtils clone per player with an AnimationMixer state machine (pose.anim + measured speed,
// crossfades), suit colour slots (M_Main / M_Joints), a procedural helmet on the Head bone with an emissive visor,
// badge decal, nameplate (close + lit + in line of sight), corpses that stay where people died, remote footsteps.
import * as THREE from 'three/webgpu';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';
import { STANCE } from '@dead-air/shared/state.ts';
import type { SnapPlayer } from '@dead-air/shared/state.ts';
import { ANIM } from '@dead-air/shared/anim.ts';
import { PLAYER } from '@dead-air/shared/constants.ts';
import type { Profile } from '@dead-air/shared/profile.ts';
import { randomProfile } from '@dead-air/shared/profile.ts';
import { los } from '@dead-air/shared/nav/index.ts';
import type { ClientContext } from '../core/context.ts';
import { badgeTexture, buildHelmet, buildPlaceholderBody, jointMaterial, nameplateTexture, suitMaterial } from './cosmetics.ts';
import type { HelmetParts } from './cosmetics.ts';
import type { RigLib, RigTemplate } from './rig.ts';
import type { LevelServiceShape, V3 } from './types.ts';
import { useLoose } from './types.ts';
import { levelNav } from './local.ts';

export interface Avatar {
  id: string;
  profileKey: string;
  root: THREE.Group;
  model: THREE.Object3D;
  rig: boolean;
  mixer: THREE.AnimationMixer | null;
  actions: Map<number, THREE.AnimationAction>;
  curAnim: number;
  curAction: THREE.AnimationAction | null;
  head: THREE.Object3D | null;
  neck: THREE.Object3D | null;
  helmet: HelmetParts;
  nameplate: THREE.Sprite;
  plateAlpha: number;
  lastPos: THREE.Vector3;
  /** last position while alive (corpse spot) */
  aliveAt: THREE.Vector3;
  speed: number;
  stride: number;
  deadAt: THREE.Vector3 | null;
  yaw: number;
  pitch: number;
  light: boolean;
  stance: number;
  lampWorld: THREE.Vector3;
  headWorld: THREE.Vector3;
  seen: boolean;
  phBody: THREE.Object3D | null;
  emote: { anim: number; until: number } | null;
}

const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();

export function profileKey(p: Profile): string {
  return `${p.body}|${p.suit[0]}|${p.suit[1]}|${p.helmet}|${p.visor.glyphs}|${p.visor.color}|${p.badge}|${p.name}`;
}

export function profileOf(ctx: ClientContext, id: string): Profile {
  const pp = ctx.world.crew?.players.find((p) => p.id === id);
  return pp?.profile ?? randomProfile(pp?.name ?? 'Contractor', () => 0.37);
}

/** model-space (bind pose) placement of a rigid attachment relative to a bone */
function attachRigid(bone: THREE.Object3D, obj: THREE.Object3D, modelRoot: THREE.Object3D, posModel: THREE.Vector3, quatModel = new THREE.Quaternion()): void {
  modelRoot.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(modelRoot.matrixWorld).invert();
  const boneInModel = new THREE.Matrix4().multiplyMatrices(inv, bone.matrixWorld);
  const desired = new THREE.Matrix4().compose(posModel, quatModel, new THREE.Vector3(1, 1, 1));
  const local = new THREE.Matrix4().copy(boneInModel).invert().multiply(desired);
  local.decompose(obj.position, obj.quaternion, obj.scale);
  bone.add(obj);
}

function buildRigModel(tpl: RigTemplate, profile: Profile): { model: THREE.Object3D; head: THREE.Object3D | null; neck: THREE.Object3D | null; helmet: HelmetParts } {
  const model = SkeletonUtils.clone(tpl.scene);
  model.scale.setScalar(tpl.scale);
  const primary = new THREE.Color(profile.suit[0]);
  const secondary = new THREE.Color(profile.suit[1]);
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    const remap = (m: THREE.Material): THREE.Material => {
      const src = m as THREE.MeshStandardMaterial;
      const isMain = src.name === 'M_Main' || !/joint/i.test(src.name);
      // look pass (③): woven work suit with hi-vis tape + dark rubber joints instead of flat plastic colour slots
      const nm = isMain ? suitMaterial(primary, mesh.geometry, src.normalMap) : jointMaterial(secondary);
      nm.name = src.name;
      return nm;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(remap) : remap(mesh.material);
  });
  const head = model.getObjectByName('Head') ?? null;
  const neck = model.getObjectByName('neck_01') ?? null;
  const helmet = buildHelmet(profile);
  if (head) {
    // helmet centre: head bone x/z, a little below the top of the body, slightly forward (model space, unscaled)
    model.updateMatrixWorld(true);
    const hp = new THREE.Vector3();
    head.getWorldPosition(hp);
    const sInv = 1 / tpl.scale;
    const top = tpl.height * sInv;
    const centre = new THREE.Vector3(hp.x * sInv, Math.max(hp.y * sInv + 0.07, top - 0.13), hp.z * sInv + 0.02);
    const hm = helmet.group;
    // attach in unscaled model space
    const saved = model.scale.x;
    model.scale.setScalar(1);
    attachRigid(head, hm, model, centre);
    // badge decal on the back (spine_03)
    const spine = model.getObjectByName('spine_03');
    if (spine) {
      const sp = new THREE.Vector3();
      model.updateMatrixWorld(true);
      spine.getWorldPosition(sp);
      const badge = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.08), new THREE.MeshStandardNodeMaterial({ map: badgeTexture(profile.badge, profile.suit[1]), roughness: 0.8 }));
      badge.castShadow = false;
      attachRigid(spine, badge, model, new THREE.Vector3(0, sp.y + 0.02, sp.z - 0.155), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
      const chest = new THREE.Mesh(new THREE.PlaneGeometry(0.09, 0.045), badge.material);
      chest.castShadow = false;
      attachRigid(spine, chest, model, new THREE.Vector3(-0.07, sp.y + 0.05, sp.z + 0.135));
    }
    model.scale.setScalar(saved);
  } else {
    helmet.group.position.set(0, 1.62, 0.02);
    model.add(helmet.group);
  }
  return { model, head, neck, helmet };
}

function buildPlaceholder(profile: Profile): { model: THREE.Object3D; head: THREE.Object3D; helmet: HelmetParts } {
  const { group, headY } = buildPlaceholderBody(profile);
  const helmet = buildHelmet(profile);
  const head = new THREE.Object3D();
  head.position.set(0, headY, 0.02);
  head.add(helmet.group);
  group.add(head);
  const badge = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.08), new THREE.MeshStandardNodeMaterial({ map: badgeTexture(profile.badge, profile.suit[1]), roughness: 0.8 }));
  badge.position.set(0, 1.3, -0.275);
  badge.rotation.y = Math.PI;
  group.add(badge);
  return { model: group, head, helmet };
}

export interface AvatarSystem {
  avatars: Map<string, Avatar>;
  update(dt: number, camPos: THREE.Vector3, localLight: { on: boolean; pos: THREE.Vector3; dir: THREE.Vector3 } | null): void;
  setRig(lib: RigLib | null): void;
  /** build one avatar per body x helmet variant in front of the camera for a few frames (pipeline warm-up) */
  warm(camera: THREE.Camera, frames?: number): void;
  playEmote(id: string, anim: number, ms: number): void;
  get(id: string): Avatar | undefined;
  /** local-only avatar (locker mirror preview, tests); pose fields as in SnapPlayer */
  setDummy(id: string, s: Omit<SnapPlayer, 'id'>, profile: Profile): void;
  /** hide this avatar's nameplate (the spectated teammate) */
  hideNameplate(id: string | null): void;
  removeDummy(id: string): void;
}

export function createAvatars(ctx: ClientContext, scene: THREE.Scene, opts: { stepSfx(pos: V3, kind: string, remote: boolean): void }): AvatarSystem {
  const avatars = new Map<string, Avatar>();
  let lib: RigLib | null = null;
  let warmGroup: THREE.Group | null = null;
  let warmLeft = 0;
  let warmAt = 0;
  let hideNameOf: string | null = null;
  /** extra local-only avatars (tests, locker-mirror previews): id -> pose + profile */
  const dummies = new Map<string, { s: SnapPlayer; profile: Profile }>();

  const createAvatar = (id: string, profile: Profile): Avatar => {
    const root = new THREE.Group();
    root.name = `avatar:${id}`;
    const tpl = lib?.bodies[profile.body] ?? lib?.bodies.m ?? lib?.bodies.f;
    let model: THREE.Object3D, head: THREE.Object3D | null, neck: THREE.Object3D | null = null, helmet: HelmetParts, rig = false;
    let phBody: THREE.Object3D | null = null;
    if (tpl) {
      const r = buildRigModel(tpl, profile);
      model = r.model; head = r.head; neck = r.neck; helmet = r.helmet; rig = true;
    } else {
      const r = buildPlaceholder(profile);
      model = r.model; head = r.head; helmet = r.helmet; phBody = r.model;
    }
    root.add(model);
    const plate = new THREE.Sprite(new THREE.SpriteNodeMaterial({ map: nameplateTexture(profile.name, profile.badge, profile.visor.color), transparent: true, depthWrite: false, depthTest: true }));
    plate.scale.set(0.9, 0.225, 1);
    plate.position.set(0, 2.12, 0);
    (plate.material as THREE.SpriteNodeMaterial).opacity = 0;
    plate.visible = false;
    plate.renderOrder = 10;
    root.add(plate);
    scene.add(root);
    const a: Avatar = {
      id, profileKey: profileKey(profile), root, model, rig, mixer: rig ? new THREE.AnimationMixer(model) : null, actions: new Map(),
      curAnim: -1, curAction: null, head, neck, helmet, nameplate: plate, plateAlpha: 0, lastPos: new THREE.Vector3(NaN, 0, 0), aliveAt: new THREE.Vector3(NaN, 0, 0),
      speed: 0, stride: 0, deadAt: null, yaw: 0, pitch: 0, light: false, stance: 0, lampWorld: new THREE.Vector3(),
      headWorld: new THREE.Vector3(), seen: true, phBody, emote: null,
    };
    return a;
  };

  const dispose = (a: Avatar) => {
    scene.remove(a.root);
    a.mixer?.stopAllAction();
    (a.nameplate.material as THREE.SpriteNodeMaterial).map?.dispose();
    a.nameplate.material.dispose();
  };

  const playAnim = (a: Avatar, id: number, speed: number) => {
    if (!a.mixer || !lib) return;
    let want = id;
    if (!lib.clips.has(want)) {
      want = want === ANIM.jog ? ANIM.walk : want === ANIM.carry || want === ANIM.carryWalk ? (speed > 0.3 ? ANIM.walk : ANIM.idle)
        : want === ANIM.crouchWalk ? ANIM.crouchIdle : want === ANIM.hidden ? ANIM.idle : speed > 0.3 ? ANIM.walk : ANIM.idle;
      if (!lib.clips.has(want)) want = ANIM.idle;
    }
    const rc = lib.clips.get(want);
    if (!rc) return;
    if (want !== a.curAnim) {
      let action = a.actions.get(want);
      if (!action) {
        action = a.mixer.clipAction(rc.clip);
        action.setLoop(rc.loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
        action.clampWhenFinished = rc.clamp;
        a.actions.set(want, action);
      }
      action.reset();
      action.enabled = true;
      action.setEffectiveWeight(1);
      action.setEffectiveTimeScale(1);
      action.play();
      const fade = want === ANIM.death ? 0.15 : a.curAnim === -1 ? 0 : 0.22;
      if (a.curAction && a.curAction !== action) a.curAction.crossFadeTo(action, fade, false);
      a.curAction = action;
      a.curAnim = want;
    }
    if (a.curAction && rc.naturalSpeed > 0) {
      const ts = Math.max(0.55, Math.min(1.9, speed / rc.naturalSpeed));
      a.curAction.setEffectiveTimeScale(want === ANIM.carryWalk && speed < 0.2 ? 0 : ts);
    } else if (a.curAction && want === ANIM.carry) {
      a.curAction.setEffectiveTimeScale(speed > 0.25 ? 1 : 0);
    }
  };

  /** extra head/neck pitch so remote players visibly look up/down */
  const applyPitch = (a: Avatar) => {
    if (!a.rig || (!a.head && !a.neck)) return;
    const right = tmpV.set(-Math.cos(a.yaw), 0, Math.sin(a.yaw));
    const p = Math.max(-1.1, Math.min(1.1, a.pitch));
    for (const [bone, k] of [[a.neck, 0.35], [a.head, 0.45]] as const) {
      if (!bone || !bone.parent) continue;
      bone.parent.getWorldQuaternion(tmpQ);
      const axis = tmpV2.copy(right).applyQuaternion(tmpQ.invert()).normalize();
      tmpQ2.setFromAxisAngle(axis, p * k);
      bone.quaternion.premultiply(tmpQ2);
    }
  };

  const isLit = (a: Avatar, camPos: THREE.Vector3, light: { on: boolean; pos: THREE.Vector3; dir: THREE.Vector3 } | null): boolean => {
    if (ctx.world.phase !== 'contract') return true;
    if (light?.on) {
      tmpV.copy(a.headWorld).sub(light.pos);
      const d = tmpV.length();
      if (d > 0.01 && tmpV.dot(light.dir) / d > Math.cos(0.5)) return true;
    }
    const lvl = useLoose<LevelServiceShape>(ctx.services, 'level');
    if (lvl?.roomAt && Array.isArray(lvl.fixtures)) {
      const sp = lvl.roomAt(a.root.position.x, a.root.position.z);
      if (sp >= 0 && lvl.fixtures.some((f) => f.space === sp && (f.state === 'on' || f.state === 'flicker'))) return true;
    } else if (ctx.world.layout) {
      const cx = Math.floor(a.root.position.x), cz = Math.floor(a.root.position.z);
      const L = ctx.world.layout;
      const sp = cx >= 0 && cz >= 0 && cx < L.W && cz < L.H ? L.owner[cz * L.W + cx] : -1;
      if (sp >= 0 && (L.spaces[sp]?.light === 'on')) return true;
    }
    void camPos;
    return false;
  };

  const sys: AvatarSystem = {
    avatars,
    get: (id) => avatars.get(id),
    setRig(l) {
      lib = l;
      // rebuild placeholders as rigs
      for (const [id, a] of avatars) {
        if (a.rig || !lib) continue;
        dispose(a);
        avatars.delete(id);
      }
    },
    setDummy(id, snap, profile) {
      dummies.set(id, { s: { id, ...snap }, profile });
    },
    hideNameplate(id) { hideNameOf = id; },
    removeDummy(id) {
      dummies.delete(id);
    },
    playEmote(id, anim, ms) {
      const a = avatars.get(id);
      if (a) a.emote = { anim, until: performance.now() + ms };
    },
    warm(camera, frames = 24) {
      if (warmGroup) return;
      warmGroup = new THREE.Group();
      const bodies = lib ? (Object.keys(lib.bodies) as ('m' | 'f')[]) : ['m' as const];
      let i = 0;
      for (const body of bodies.length ? bodies : ['m' as const]) {
        for (const helmet of ['dome', 'box', 'diver'] as const) {
          const prof: Profile = { name: 'warm', body, suit: ['#d4a017', '#2c3e50'], helmet, visor: { glyphs: 'W', color: '#7dfcff' }, badge: 100 + i };
          const a = createAvatar(`__warm${i}`, prof);
          scene.remove(a.root);
          a.root.position.set((i - 2.5) * 0.02, -0.03, -0.6);
          a.root.scale.setScalar(0.01);
          a.nameplate.visible = true;
          (a.nameplate.material as THREE.SpriteNodeMaterial).opacity = 0.01;
          if (a.mixer && lib) {
            const rc = lib.clips.get(ANIM.idle);
            if (rc) a.mixer.clipAction(rc.clip).play();
            a.mixer.update(0.01);
          }
          warmGroup.add(a.root);
          i++;
        }
      }
      camera.add(warmGroup);
      if (!camera.parent) scene.add(camera);
      warmLeft = frames;
      warmAt = performance.now();
    },
    update(dt, camPos, localLight) {
      const w = ctx.world;
      if (warmGroup && --warmLeft <= 0 && performance.now() - warmAt > 400) {
        warmGroup.parent?.remove(warmGroup);
        warmGroup = null;
      }
      const seen = new Set<string>();
      const nav = levelNav(ctx);
      const ids = [...w.players.keys(), ...dummies.keys()];
      for (const id of ids) {
        if (id === w.me) continue;
        const dummy = dummies.get(id);
        const s: SnapPlayer | null = dummy ? dummy.s : w.samplePlayer(id);
        if (!s) continue;
        seen.add(id);
        const profile = dummy ? dummy.profile : profileOf(ctx, id);
        let a = avatars.get(id);
        const key = profileKey(profile);
        if (a && (a.profileKey !== key || (!a.rig && lib && Object.keys(lib.bodies).length))) {
          dispose(a);
          avatars.delete(id);
          a = undefined;
        }
        if (!a) {
          a = createAvatar(id, profile);
          avatars.set(id, a);
        }
        const dead = s.stance === STANCE.dead;
        const hidden = s.stance === STANCE.hidden;
        a.stance = s.stance;
        a.root.visible = !hidden;
        // corpse stays where the player died; the dead pose afterwards is their spectator camera
        // the latest snapshot decides death: interpolation keeps the older (alive) stance while p already
        // lerps toward the dead player's spectator camera, so only trust positions while the newest sample is alive
        const latest = dummy ? s : w.players.get(id)?.latest() ?? s;
        const latestDead = latest.stance === STANCE.dead;
        if (dead || latestDead) {
          if (!a.deadAt) a.deadAt = Number.isFinite(a.aliveAt.x) ? a.aliveAt.clone() : new THREE.Vector3(s.p[0], 0, s.p[2]);
          a.deadAt.y = 0;
          a.root.position.copy(a.deadAt);
        } else {
          a.deadAt = null;
          a.root.position.set(s.p[0], s.p[1], s.p[2]);
          a.yaw = s.yaw;
          a.pitch = s.pitch;
          a.aliveAt.copy(a.root.position);
        }
        a.root.rotation.y = a.yaw;
        a.light = !dead && !hidden && s.light === 1;
        // measured speed (interpolated positions)
        if (Number.isFinite(a.lastPos.x) && dt > 0 && !dead) {
          const d = Math.hypot(a.root.position.x - a.lastPos.x, a.root.position.z - a.lastPos.z);
          const inst = d > 2 ? 0 : d / dt;
          a.speed += (inst - a.speed) * Math.min(1, dt * 8);
          if (a.speed > 0.4 && d < 2) {
            const crouch = s.stance === STANCE.crouch;
            const sprint = s.stance === STANCE.sprint || a.speed > 4.3;
            const strideLen = crouch ? 0.6 : sprint ? 1.15 : 0.78;
            a.stride += d;
            if (a.stride >= strideLen) {
              a.stride = 0;
              opts.stepSfx([a.root.position.x, 0, a.root.position.z], crouch ? 'crouchStep' : sprint ? 'sprintStep' : 'walkStep', true);
            }
          }
        } else if (dead) a.speed = 0;
        a.lastPos.copy(a.root.position);

        // animation
        let anim = dead ? ANIM.death : s.anim;
        if (a.emote && performance.now() < a.emote.until && !dead && a.speed < 1.2 && (anim === ANIM.idle || (anim >= ANIM.emoteWave && anim <= ANIM.emoteThumbs))) anim = a.emote.anim;
        else if (a.emote && performance.now() >= a.emote.until) a.emote = null;
        if (a.rig) {
          playAnim(a, anim, a.speed);
          a.mixer!.update(dt);
          applyPitch(a);
        } else if (a.phBody) {
          // placeholder: crouch squash + walk bob + death topple
          const crouchK = s.stance === STANCE.crouch ? 0.72 : 1;
          a.phBody.scale.y += (crouchK - a.phBody.scale.y) * Math.min(1, dt * 10);
          const bob = a.speed > 0.3 ? Math.abs(Math.sin(performance.now() / 1000 * a.speed * 4)) * 0.03 : 0;
          a.phBody.position.y = bob;
          const tilt = dead ? -Math.PI / 2 : 0;
          a.phBody.rotation.x += (tilt - a.phBody.rotation.x) * Math.min(1, dt * 6);
        }
        a.root.updateMatrixWorld(true);
        a.helmet.lamp.getWorldPosition(a.lampWorld);
        if (a.head) a.head.getWorldPosition(a.headWorld);
        else a.headWorld.set(a.root.position.x, a.root.position.y + PLAYER.eye, a.root.position.z);
        // visor dims when dead
        a.helmet.visorMat.emissiveIntensity = dead ? 0.15 : 2.6;

        // nameplate: close, lit and in line of sight
        const dist = camPos.distanceTo(a.headWorld);
        const range = Number((ctx.balance.players as Record<string, unknown> | undefined)?.nameplateRange ?? 6);
        let show = !dead && !hidden && dist < range && dist > 1.2 && id !== hideNameOf;
        if (show && nav) show = los(nav.grid, camPos.x, camPos.z, a.headWorld.x, a.headWorld.z, nav.doorOpen);
        if (show) show = isLit(a, camPos, localLight);
        a.plateAlpha += ((show ? 1 : 0) - a.plateAlpha) * Math.min(1, dt * 6);
        const pm = a.nameplate.material as THREE.SpriteNodeMaterial;
        pm.opacity = a.plateAlpha * Math.max(0, Math.min(1, (range - dist) / 1.5));
        a.nameplate.visible = pm.opacity > 0.02;
        if (a.head) {
          a.nameplate.position.set(0, a.headWorld.y - a.root.position.y + 0.42, 0);
        }
      }
      for (const [id, a] of avatars) {
        if (!seen.has(id)) {
          dispose(a);
          avatars.delete(id);
        }
      }
    },
  };
  return sys;
}
