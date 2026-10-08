// Owner: env-render (v1.2). Consumers: `ctx.services.use('render') as (RenderService & Partial<RenderServiceV12>) | undefined`.
import type * as THREE from 'three/webgpu';
import type { MirrorKind } from '@dead-air/shared/procgen/mirrors.ts';
export type { MirrorKind };

export type V3 = [number, number, number];
/** main camera = 0 + firstPerson + detail; mirror cameras = 0 + ghost + self + detail; shadow cameras = 0 + phantom
 *  (+ detail for YOUR OWN beam only); vol pass = vol.
 *  detail (v1.2 gate P draw budget): put small props and item models on this layer INSTEAD of layer 0
 *  (`obj.layers.set(RENDER_LAYERS.detail)` on each mesh): every view still draws them and your own beam shadows them,
 *  but teammates' beams skip them (each shadowed beam redraws every caster in its frustum). */
export const RENDER_LAYERS = { vol: 10, ghost: 11, phantom: 12, self: 13, firstPerson: 14, detail: 15 } as const;
export type RenderLayers = typeof RENDER_LAYERS;
export type FixtureCurve = 'die' | 'surge_die' | 'brown' | 'pulse' | 'revive';
/** p = centre (m), r = radius (m), density = extinction 1/m at the centre (0.1-0.4 reads as a thick bank); frost 0..1
 *  tints it cold; ground = hugs the floor (fades out above ~1.4 m). At most 8 at once (render.setFogVolumes). */
export interface FogVolume { p: V3; r: number; density: number; color?: string; frost?: number; ground?: boolean }
export interface BeamInfo { id: string; pos: V3; dir: V3; angle: number; range: number; intensity: number; local: boolean }
export interface MirrorOpts { space: number; w: number; h: number; kind: MirrorKind; itemId?: string; priority?: number; tarnish?: number }
export interface MirrorHandle {
  readonly id: number;
  readonly itemId: string | null;
  /** the reflection is live this frame (else the fallback glass shows) */
  live(): boolean;
  /** condensation 0..1 (works on the fallback glass too) */
  setFog(k: number): void;
  /** mask: white strokes (red channel) on black / transparent, mapped on the glass UVs; reveal 0..1 wipes the
   *  condensation along the strokes (live glass) or leaves greasy marks (fallback / no fog); null clears */
  setWriting(mask: THREE.Texture | null, reveal?: number): void;
  /** cracks 0..1 from a seeded impact point (seed: any number) */
  setCrack(k: number, seed?: number): void;
  /** renders only in reflections; local frame = glass, +Z out. Children are kept on the ghost layer with
   *  castShadow false (a faint cold rim light follows them while the local beam hits the glass) */
  readonly ghost: THREE.Group;
  dispose(): void;
}
/** register(glass): the glass is a plane facing its local +Z (PlaneGeometry), already in the scene graph (a space
 *  group). Its material is replaced by the per-mirror fallback glass; the live reflection mesh is added beside it
 *  (same parent, same transform). A glass removed from the scene graph disposes its mirror on the next frame. */
export interface MirrorService { register(glass: THREE.Mesh, opts: MirrorOpts): MirrorHandle; list(): readonly MirrorHandle[]; liveCount(): number }
export type RenderCoverMode = 'game' | 'menu' | 'cover' | 'hold' | 'hidden';
export interface RenderServiceV12 {
  readonly layers: RenderLayers;
  /** smooth sag + recovery, never a strobe */
  brownout(space: number, ms: number, depth?: number): void;
  /** every fixture of the space surges and dies in a quick cascade; dark until its power returns (off -> on) or a revive */
  failSpace(space: number): void;
  /** indices into level.fixtures; startMs on performance.now(); stepMs = delay between consecutive indices. 'die' /
   *  'surge_die' leave the fixture dead until its space's power returns (an off -> on transition, not a re-sent on)
   *  or a 'revive' curve; 'brown' / 'pulse' recover by themselves */
  fixtureCurve(indices: readonly number[], curve: FixtureCurve, startMs: number, stepMs?: number): void;
  /** current level per fixture (index = level.fixtures index; 0 = dark, ~1 = lit, > 1 during a surge); the same
   *  array every call, updated every frame */
  fixtureLevels(): Float32Array;
  readonly mirrors: MirrorService;
  setFogVolumes(list: readonly FogVolume[]): void;
  puff(pos: V3, kind: 'breath' | 'steam' | 'dust' | 'frost', strength?: number): void;
  /** every lit flashlight beam this frame */
  beams(): readonly BeamInfo[];
  /** dim/stutter a beam ('local' = own) */
  beamInterference(who: string, ms: number, depth?: number): void;
  /** fixture light at a point (linear rgb, flashlights excluded): ~1 under a lit tube, ~0.02 in an unlit room */
  ambientAt(x: number, y: number, z: number): V3;
  coverMode(): RenderCoverMode;
  /** gain 6 default; phosphor green, +grain, +vignette, highlight clamp; off = the normal output */
  setNightVision(on: boolean, opts?: { gain?: number }): void;
}
// DynamicLighting reserves 4 spot + 2 point batched slots for gameplay lights (2 flares + 1 flashbulb). Ask before adding.
