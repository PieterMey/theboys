// Owner: track ⑤ Players. Cross-track service shapes this track provides/consumes, as module augmentations.
// Consumers: const pl = ctx.services.use('players'); pl?.flashlights() ...; ctx.bus.on('action:interact', ({down}) => ...)
import type * as THREE from 'three/webgpu';
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import type { EdgeGrid } from '@dead-air/shared/nav/index.ts';
import type { EmoteKind } from '@dead-air/shared/messages/players.ts';
import type { Profile } from '@dead-air/shared/profile.ts';

export type V3 = [number, number, number];

export interface FlashlightInfo {
  id: string;
  pos: V3;
  /** unit direction */
  dir: V3;
  on: boolean;
  local: boolean;
  tier: 1 | 2;
  /** optional 0..1 flashlight battery (interaction track); render flickers the beam below 0.15 */
  battery?: number;
}

/** services.players (provided by ⑤ Players) */
export interface PlayersService {
  localId(): string | null;
  /** every flashlight this frame (local first). Positions are world metres; on=false entries keep their slot. */
  flashlights(): FlashlightInfo[];
  /** eye/head position of a player (local: camera), or null if unknown */
  headPos(id: string): V3 | null;
  cameraPos(): V3;
  /** true while the local player is dead/static and the camera follows teammates */
  spectating(): boolean;
  /** interaction track: force spectating on/off (death, revive). Dead pose = camera position. */
  setSpectate(on: boolean): void;
  /**
   * interaction track (battery): false forces the light off and ignores F until re-enabled.
   * v1.2 (PLAN.md §13): ref-counted per `reason` like freeze(): the light is usable only while no reason holds it off
   * ('battery' | 'nv' | 'knockdown' ...); an omitted reason is 'battery' (the v1.1 single writer). Until players-stealth
   * implements the ref-count, the last call wins.
   */
  setFlashlightEnabled(enabled: boolean, reason?: string): void;
  flashlightOn(): boolean;
  setFlashlight(on: boolean): void;
  /** interaction track: movement multiplier (e.g. carrying the Core = MOVE.carryCoreMult); 1 = normal */
  setSpeedMult(mult: number): void;
  /** interaction track: carried dyn id (avatar uses carry clips), null = hands free */
  setCarry(id: string | null): void;
  /** interaction track: hidden in a locker (stance hidden, no movement); camera at `at` while hidden */
  setHidden(hidden: boolean, at?: V3, yaw?: number): void;
  /** play a one-shot/held anim id (ANIM.interact, pickup, throw, swing, grabbed...) for ms on the local pose */
  playAnim(anim: number, ms: number): void;
  /** freeze movement + look (menus, death card, cutscenes); reasons are ref-counted by name */
  freeze(reason: string, on: boolean): void;
  /** local player's feet position + yaw */
  localPose(): { p: V3; yaw: number; pitch: number; stance: number; anim: number } | null;
  /** remote avatar root (for attaching props / hit tests); undefined for the local player */
  avatarObject(id: string): THREE.Object3D | undefined;
  emote(kind: EmoteKind): void;
  /** settings (persisted in localStorage) */
  settings(): PlayerSettings;
  setSettings(p: Partial<PlayerSettings>): void;
  /**
   * local-only avatar (e.g. the locker-mirror preview in the van): full rig + helmet/visor for `profile` at `pose`.
   * Call again to update; pose null removes it. anim = ANIM id, stance = STANCE value.
   */
  setPreviewAvatar(id: string, pose: { p: V3; yaw: number; anim?: number; stance?: number; light?: 0 | 1 } | null, profile?: Profile): void;
  /** current stamina 0..1 */
  stamina(): number;
  /** interaction track (adrenaline syringe): sprint without stamina drain for ms (stamina refilled) */
  setStaminaFree?(ms: number): void;
  /** pointer lock active */
  locked(): boolean;
  /** v1.2: local full-body avatar on RENDER_LAYERS.self only, castShadow false, no nameplate/step sfx */
  setMirrorSelf?(on: boolean): THREE.Object3D | null;
}

export interface PlayerSettings {
  /** radians per mouse pixel */
  sensitivity: number;
  crouchToggle: boolean;
  invertY: boolean;
  headBob: boolean;
  /** v1.2 desktop: Left Ctrl also crouches */
  ctrlCrouch?: boolean;
}

/** services.level (provided by ② Level) — consumed here; every field optional at runtime. */
export interface LevelServiceShape {
  layout?: LevelLayout | null;
  grid?: EdgeGrid | null;
  roomAt?(x: number, z: number): number;
  visibleSpaces?(camPos: V3): Set<number>;
  fixtures?: { space: number; pos: V3; state: 'on' | 'off' | 'flicker' | 'broken' }[];
  setDoorOpen?(id: number, open: boolean): void;
  doorOpen?(id: number): boolean;
  itemObject?(id: string): THREE.Object3D | undefined;
  /** optional precise ray hit against level geometry */
  raycast?(origin: V3, dir: V3, maxDist: number): { p: V3; n?: V3 } | null;
}

/** services.render (provided by ③ Render) — consumed for warm-up / presets only */
export interface RenderServiceShape {
  backend?: 'webgpu' | 'webgl2';
  preset?: string;
  stats?(): { fps: number; frameMs: number; gpuMs?: number; drawCalls?: number };
}

export interface SfxHandle { stop(): void }

declare module '../core/bus.ts' {
  interface BusEvents {
    /** E (interact / carry / hide) */
    'action:interact': { down: boolean };
    /** LMB (use / throw / swing) while pointer-locked */
    'action:use': { down: boolean };
    /** G */
    'action:drop': { down: boolean };
    /** F (the players track toggles the light itself; listen to react, e.g. click SFX) */
    'action:flashlight': { down: boolean; on: boolean };
    /** Q walkie (hold) */
    'action:radio': { down: boolean };
    /** V push-to-talk (hold) */
    'action:ptt': { down: boolean };
    /** T emote wheel (hold) */
    'action:emote': { down: boolean };
    /** MMB silent ping */
    'action:ping': { down: boolean };
    /** 1-4 inventory slots (0-based slot index); not sent while the emote wheel is open */
    'action:slot': { slot: number };
    /** 1-4 while the emote wheel (T) is open: pick that emote (0-based wheel index) instead of changing slots */
    'action:wheelKey': { slot: number };
    /** Esc / pointer lock released by the browser: open the pause menu */
    'action:menu': { down: boolean };
    /** Enter: proximity text line opened/closed */
    'action:chat': { open: boolean };
    'input:pointerlock': { locked: boolean };
    /** local player stance/alive changes */
    'players:spectate': { on: boolean };
    /** local footstep (for HUD/noise feedback); kind = crouchStep | walkStep | sprintStep */
    'players:step': { kind: string; pos: V3 };
    /** a ping marker appeared */
    'players:ping': { id: string; p: V3 };
    /** chat line submitted from the HUD (players track sends it) */
    'players:chatSend': { text: string };
    /** v1.3 dead pokes: a spectator's poke (keys 1-3 knock that many times, 4 flickers; or the poke bar's buttons) */
    'players:poke': { kind: 'knock' | 'flicker'; count?: number };
  }
}

declare module '../core/services.ts' {
  interface ServiceMap {
    players: PlayersService;
  }
}

/**
 * Untyped lookup for services other tracks declare themselves (level, render): avoids duplicate ServiceMap
 * declarations while their files are in flux. Always tolerate undefined.
 */
export function useLoose<T>(services: { use(name: never): unknown }, name: string): T | undefined {
  return (services.use as unknown as (n: string) => unknown)(name) as T | undefined;
}
