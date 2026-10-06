// Owner: track ③ Render. Service shapes provided (render) and consumed (players, level) by the render track.
// `level` / `players` are NOT added to ServiceMap here (their owners declare them); we read them through
// `useLoose()` with these structural views so a type mismatch in another track can never break this file.
import type * as THREE from 'three/webgpu';
import type { ClientContext } from '../core/context.ts';

export type V3 = [number, number, number];

export interface FlashlightInfo {
  id: string;
  pos: V3;
  dir: V3;
  on: boolean;
  local: boolean;
  /** 1 = cheap incandescent (warm), 2 = LED (cold, brighter) */
  tier: 1 | 2;
  /** optional 0..1 battery; < 0.15 makes the beam flicker */
  battery?: number;
}

export interface PlayersView {
  localId(): string | null;
  flashlights(): FlashlightInfo[];
  headPos(id: string): V3 | null;
  cameraPos(): V3;
  spectating(): boolean;
}

export type FixtureState = 'on' | 'off' | 'flicker' | 'broken';
export interface FixtureInfo {
  space: number;
  pos: V3;
  state: FixtureState;
}

export interface LevelView {
  layout: unknown;
  roomAt(x: number, z: number): number;
  visibleSpaces(camPos: V3): Set<number>;
  fixtures: FixtureInfo[];
}

export interface RenderFx {
  ca?: number;
  grain?: number;
  vignette?: number;
  desat?: number;
}

export interface RenderStats {
  fps: number;
  frameMs: number;
  gpuMs?: number;
  drawCalls?: number;
}

export interface RenderPerf {
  fps: number;
  p50: number;
  p95: number;
  long: number;
  gpuMs: number | null;
  preset: string;
  res: [number, number];
  dpr: number;
  /** renderer pixel ratio actually used (DPR x cap x preset res x auto scale) */
  scale: number;
  autoScale: number;
  backend: 'webgpu' | 'webgl2';
  auto: string;
}

export interface RenderService {
  backend: 'webgpu' | 'webgl2';
  /** active preset name ('low' | 'medium' | 'high' | 'ultra') */
  readonly preset: string;
  presets: readonly string[];
  /** live: resolution, AO, volumetrics, fixture count, active shadow slots. Pool size / shadow map size: next load. */
  setPreset(name: string): void;
  /** tone-mapping exposure (default from render.json) */
  setExposure(v: number): void;
  exposure(): number;
  setFx(p: RenderFx): void;
  /** accessibility: no CA, no strobing fixture flicker (flicker becomes a slow dim) */
  setReduceFlicker(on: boolean): void;
  /** power override: blackout = setPower('all', false); setPower('all', true) clears every override */
  setPower(space: number | 'all', on: boolean): void;
  /** monster telegraph: fixtures in `space` strobe for `ms` */
  flickerSpace(space: number, ms: number): void;
  stats(): RenderStats;
  /** render 2 real frames now (call after adding many new meshes/materials, behind a loading screen) */
  warmup(): Promise<void>;
  /** v1.1 loading screen: render `frames` frames with EVERY level space visible and no frustum culling (all six
   *  flashlight slots on), so every material / shadow / volume pipeline compiles now; resolves after them */
  warmupAll(frames?: number): Promise<void>;
  /** frame-interval statistics over the last `spanMs` */
  frameStats(spanMs: number): { n: number; fps: number; p50: number; p95: number; max: number; long: number };
  /** telemetry snapshot (last telemetrySec seconds) */
  perf(): RenderPerf;
  /** auto quality on/off (persisted per browser) */
  setAutoQuality(on: boolean): void;
  /** the scene just changed (level rebuild, loading): auto quality restarts its warm-up */
  busy(): void;
  /** pause drawing (an opaque loading screen covers the canvas): GPU free for uploads; warm-up frames still draw */
  hold(on: boolean): void;
  /** layer used by the volumetric pass (lights that should make beams enable it) */
  volumeLayer: number;
  /** test/scene override for flashlights when no players service exists */
  setFlashlightSource(fn: (() => FlashlightInfo[]) | null): void;
  /** test/scene override for fixtures when no level service exists */
  setFixtureSource(src: { fixtures: FixtureInfo[]; visibleSpaces?: (cam: V3) => Set<number> } | null): void;
}

declare module '../core/services.ts' {
  interface ServiceMap {
    render: RenderService;
  }
}

/** services.use() for services this track does not declare (level, players): structural, never throws. */
export function useLoose<T>(ctx: ClientContext, name: string): T | undefined {
  return (ctx.services.use as unknown as (n: string) => T | undefined)(name);
}

export interface RenderCore {
  renderer: THREE.WebGPURenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  backend: 'webgpu' | 'webgl2';
}
