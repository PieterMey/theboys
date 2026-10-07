// Owner: env-render (v1.2). Consumers: `ctx.services.use('render') as (RenderService & Partial<RenderServiceV12>) | undefined`.
import type * as THREE from 'three/webgpu';
import type { MirrorKind } from '@dead-air/shared/procgen/mirrors.ts';
export type { MirrorKind };

export type V3 = [number, number, number];
/** main camera = 0 + firstPerson; mirror cameras = 0 + ghost + self; shadow cameras = 0 + phantom; vol pass = vol */
export const RENDER_LAYERS = { vol: 10, ghost: 11, phantom: 12, self: 13, firstPerson: 14 } as const;
export type RenderLayers = typeof RENDER_LAYERS;
export type FixtureCurve = 'die' | 'surge_die' | 'brown' | 'pulse' | 'revive';
export interface FogVolume { p: V3; r: number; density: number; color?: string; frost?: number; ground?: boolean }
export interface BeamInfo { id: string; pos: V3; dir: V3; angle: number; range: number; intensity: number; local: boolean }
export interface MirrorOpts { space: number; w: number; h: number; kind: MirrorKind; itemId?: string; priority?: number; tarnish?: number }
export interface MirrorHandle {
  readonly id: number;
  readonly itemId: string | null;
  live(): boolean;
  setFog(k: number): void;
  setWriting(mask: THREE.Texture | null, reveal?: number): void;
  setCrack(k: number, seed?: number): void;
  /** renders only in reflections; local frame = glass, +Z out */
  readonly ghost: THREE.Group;
  dispose(): void;
}
export interface MirrorService { register(glass: THREE.Mesh, opts: MirrorOpts): MirrorHandle; list(): readonly MirrorHandle[]; liveCount(): number }
export type RenderCoverMode = 'game' | 'menu' | 'cover' | 'hold' | 'hidden';
export interface RenderServiceV12 {
  readonly layers: RenderLayers;
  /** smooth sag + recovery, never a strobe */
  brownout(space: number, ms: number, depth?: number): void;
  failSpace(space: number): void;
  /** indices into level.fixtures; startMs on performance.now() */
  fixtureCurve(indices: readonly number[], curve: FixtureCurve, startMs: number, stepMs?: number): void;
  fixtureLevels(): Float32Array;
  readonly mirrors: MirrorService;
  setFogVolumes(list: readonly FogVolume[]): void;
  puff(pos: V3, kind: 'breath' | 'steam' | 'dust' | 'frost', strength?: number): void;
  beams(): readonly BeamInfo[];
  /** dim/stutter a beam ('local' = own) */
  beamInterference(who: string, ms: number, depth?: number): void;
  ambientAt(x: number, y: number, z: number): V3;
  coverMode(): RenderCoverMode;
  setNightVision(on: boolean, opts?: { gain?: number }): void;
}
// DynamicLighting reserves 4 spot + 2 point batched slots for gameplay lights (2 flares + 1 flashbulb). Ask before adding.
