// Owner: track ⑤ Players. Local player: first-person camera (eye/crouch transitions, head bob, sprint sway),
// movement with stamina, collision against the edge grid (doors), stance + anim id, flashlight state, pose source.
import * as THREE from 'three/webgpu';
import { MOVE, PLAYER } from '@dead-air/shared/constants.ts';
import { STANCE } from '@dead-air/shared/state.ts';
import { ANIM } from '@dead-air/shared/anim.ts';
import { buildEdgeGrid, initialDoorOpen } from '@dead-air/shared/nav/index.ts';
import type { DoorOpenFn, EdgeGrid } from '@dead-air/shared/nav/index.ts';
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import type { ClientContext } from '../core/context.ts';
import type { InputCore } from './input.ts';
import { moveCircle } from '@dead-air/shared/collide/index.ts';
import type { LevelServiceShape, V3 } from './types.ts';
import { useLoose } from './types.ts';

export interface LocalPlayer {
  pos: THREE.Vector3;
  yaw: number;
  pitch: number;
  vel: THREE.Vector3;
  stance: number;
  anim: number;
  stamina: number;
  light: boolean;
  lightEnabled: boolean;
  speedMult: number;
  carry: string | null;
  hidden: boolean;
  hiddenAt: V3 | null;
  dead: boolean;
  frozen: Set<string>;
  animOverride: { anim: number; until: number } | null;
  /** smoothed eye height above the floor */
  eye: number;
  bobPhase: number;
  bobAmp: number;
  roll: number;
  stride: number;
  speed: number;
  sprintLock: boolean;
  /** camera world position (incl. bob) */
  cam: THREE.Vector3;
  camQuat: THREE.Quaternion;
}

export function createLocal(): LocalPlayer {
  return {
    pos: new THREE.Vector3(0, 0, 0), yaw: 0, pitch: 0, vel: new THREE.Vector3(), stance: STANCE.stand, anim: ANIM.idle,
    stamina: 1, light: true, lightEnabled: true, speedMult: 1, carry: null, hidden: false, hiddenAt: null, dead: false,
    frozen: new Set(), animOverride: null, eye: PLAYER.eye, bobPhase: 0, bobAmp: 0, roll: 0, stride: 0, speed: 0, sprintLock: false,
    cam: new THREE.Vector3(0, PLAYER.eye, 0), camQuat: new THREE.Quaternion(),
  };
}

const gridCache = new WeakMap<LevelLayout, { grid: EdgeGrid; doors: DoorOpenFn }>();

/** the edge grid + door state to collide against: services.level when present, else built from world.layout */
export function levelNav(ctx: ClientContext): { grid: EdgeGrid; doorOpen: DoorOpenFn; wallH: number } | null {
  const lvl = useLoose<LevelServiceShape>(ctx.services, 'level');
  const layout = lvl?.layout ?? ctx.world.layout;
  if (lvl?.grid) {
    const doorOpen: DoorOpenFn = typeof lvl.doorOpen === 'function' ? (id) => lvl.doorOpen!(id) : layout ? cached(layout).doors : () => true;
    return { grid: lvl.grid, doorOpen, wallH: layout?.wallH ?? 3 };
  }
  if (!layout) return null;
  const c = cached(layout);
  return { grid: c.grid, doorOpen: c.doors, wallH: layout.wallH ?? 3 };
}

function cached(layout: LevelLayout): { grid: EdgeGrid; doors: DoorOpenFn } {
  let c = gridCache.get(layout);
  if (!c) {
    c = { grid: buildEdgeGrid(layout), doors: initialDoorOpen(layout) };
    gridCache.set(layout, c);
  }
  return c;
}

const tmpEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const PITCH_MAX = 1.48;

export interface StepInfo { kind: 'crouchStep' | 'walkStep' | 'sprintStep'; pos: V3 }

/** advance the local player one frame; returns a footstep if one happened */
export function stepLocal(ctx: ClientContext, me: LocalPlayer, input: InputCore, dt: number): StepInfo | null {
  const bal = (ctx.balance.players ?? {}) as Record<string, number>;
  const frozen = me.frozen.size > 0 || me.dead || me.hidden;
  const look = input.takeLook();
  if (!frozen || me.hidden) {
    me.yaw += look.dYaw;
    me.pitch = Math.max(-PITCH_MAX, Math.min(PITCH_MAX, me.pitch + look.dPitch));
  }
  me.yaw = Math.atan2(Math.sin(me.yaw), Math.cos(me.yaw));

  const st = input.typing() || frozen ? { forward: 0, right: 0, sprint: false, crouch: false } : input.state();
  const crouch = !!st.crouch;
  let wantSprint = !!st.sprint && !crouch && st.forward > 0.1;
  // stamina: drains over MOVE.staminaSec while sprinting, regenerates over MOVE.staminaRegenSec
  if (me.stamina <= 0.001) me.sprintLock = true;
  if (me.sprintLock && me.stamina >= (bal.staminaResumeFrac ?? 0.25)) me.sprintLock = false;
  if (me.sprintLock) wantSprint = false;

  // wish direction (yaw 0 = facing +Z; right = (-cos, 0, sin))
  const fx = Math.sin(me.yaw), fz = Math.cos(me.yaw);
  const rx = -Math.cos(me.yaw), rz = Math.sin(me.yaw);
  let wx = fx * st.forward + rx * st.right;
  let wz = fz * st.forward + rz * st.right;
  const wl = Math.hypot(wx, wz);
  if (wl > 1) { wx /= wl; wz /= wl; }
  const base = crouch ? MOVE.crouch : wantSprint ? MOVE.sprint : MOVE.walk;
  const speed = base * me.speedMult * (st.forward < -0.1 && !crouch ? 0.85 : 1);
  const accel = bal.accel ?? 12;
  const k = 1 - Math.exp(-accel * dt);
  me.vel.x += (wx * speed - me.vel.x) * k;
  me.vel.z += (wz * speed - me.vel.z) * k;
  if (wl < 0.01 && Math.hypot(me.vel.x, me.vel.z) < 0.02) me.vel.set(0, 0, 0);

  const moving = Math.hypot(me.vel.x, me.vel.z);
  const sprinting = wantSprint && moving > MOVE.walk * 0.9;
  if (sprinting) me.stamina = Math.max(0, me.stamina - dt / MOVE.staminaSec);
  else me.stamina = Math.min(1, me.stamina + dt / MOVE.staminaRegenSec * (moving < 0.1 ? 1.25 : 1));

  // collide
  const ox = me.pos.x, oz = me.pos.z;
  const nav = levelNav(ctx);
  if (nav) {
    const [nx, nz] = moveCircle(nav.grid, [me.pos.x, me.pos.z], [me.vel.x * dt, me.vel.z * dt], PLAYER.radius, nav.doorOpen);
    me.pos.x = nx;
    me.pos.z = nz;
  } else {
    me.pos.x += me.vel.x * dt;
    me.pos.z += me.vel.z * dt;
  }
  const moved = Math.hypot(me.pos.x - ox, me.pos.z - oz);
  const actual = dt > 0 ? moved / dt : 0;
  me.speed = me.speed + (actual - me.speed) * Math.min(1, dt * 10);
  // walls eat velocity (no sliding build-up)
  if (dt > 0 && moving > 0.05) {
    const ratio = Math.min(1, actual / moving);
    if (ratio < 0.98) { me.vel.x = (me.pos.x - ox) / dt; me.vel.z = (me.pos.z - oz) / dt; }
  }

  // stance + anim
  me.stance = me.dead ? STANCE.dead : me.hidden ? STANCE.hidden : crouch ? STANCE.crouch : sprinting ? STANCE.sprint : STANCE.stand;
  const now = performance.now();
  if (me.animOverride && now > me.animOverride.until) me.animOverride = null;
  if (me.animOverride && me.speed > 1.2 && me.animOverride.anim >= ANIM.emoteWave && me.animOverride.anim <= ANIM.emoteThumbs) me.animOverride = null;
  me.anim = me.dead ? ANIM.death
    : me.hidden ? ANIM.hidden
    : me.animOverride ? me.animOverride.anim
    : me.carry ? (me.speed > 0.3 ? ANIM.carryWalk : ANIM.carry)
    : crouch ? (me.speed > 0.2 ? ANIM.crouchWalk : ANIM.crouchIdle)
    : sprinting && me.speed > 4 ? ANIM.sprint
    : me.speed > 3.6 ? ANIM.jog
    : me.speed > 0.25 ? ANIM.walk
    : ANIM.idle;

  // eye height, bob, sway
  const eyeTarget = me.hidden ? PLAYER.eye : crouch ? PLAYER.crouchEye : PLAYER.eye;
  me.eye += (eyeTarget - me.eye) * (1 - Math.exp(-(bal.eyeLerp ?? 10) * dt));
  const settings = input.settings;
  const bobTarget = !settings.headBob || me.speed < 0.3 ? 0 : crouch ? (bal.bobCrouch ?? 0.018) : sprinting ? (bal.bobSprint ?? 0.055) : (bal.bobWalk ?? 0.032);
  me.bobAmp += (bobTarget - me.bobAmp) * Math.min(1, dt * 8);
  const strideLen = crouch ? (bal.strideCrouch ?? 0.6) : sprinting ? (bal.strideSprint ?? 1.15) : (bal.strideWalk ?? 0.78);
  me.bobPhase += (moved / strideLen) * Math.PI; // one half-cycle per stride
  const rollTarget = sprinting && settings.headBob ? Math.sin(me.bobPhase) * THREE.MathUtils.degToRad(bal.sprintRollDeg ?? 0.7) : 0;
  me.roll += (rollTarget - me.roll) * Math.min(1, dt * 10);

  const bobY = Math.abs(Math.sin(me.bobPhase)) * me.bobAmp - me.bobAmp * 0.5;
  const bobX = Math.cos(me.bobPhase) * me.bobAmp * 0.35;
  if (me.hidden && me.hiddenAt) {
    me.cam.set(me.hiddenAt[0], me.hiddenAt[1], me.hiddenAt[2]);
  } else {
    me.cam.set(me.pos.x + rx * bobX, me.pos.y + me.eye + bobY, me.pos.z + rz * bobX);
  }
  tmpEuler.set(me.pitch, me.yaw + Math.PI, me.roll, 'YXZ');
  me.camQuat.setFromEuler(tmpEuler);

  // footsteps
  let step: StepInfo | null = null;
  if (me.speed > 0.4 && !me.dead && !me.hidden) {
    me.stride += moved;
    if (me.stride >= strideLen) {
      me.stride -= strideLen;
      if (me.stride > strideLen) me.stride = 0;
      step = { kind: crouch ? 'crouchStep' : sprinting ? 'sprintStep' : 'walkStep', pos: [me.pos.x, 0, me.pos.z] };
    }
  } else me.stride = Math.min(me.stride, strideLen * 0.5);
  return step;
}

export function applyCamera(cam: THREE.PerspectiveCamera, me: LocalPlayer): void {
  cam.position.copy(me.cam);
  cam.quaternion.copy(me.camQuat);
  cam.updateMatrixWorld();
}
