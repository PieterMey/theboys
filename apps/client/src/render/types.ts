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

/** render.warmSite() outcome (done = every mesh of the level drawn once; false = paused at the time limit) */
export interface SiteWarmResult {
  done: boolean;
  /** wall time since the warm of this level started (ms) */
  ms: number;
  frames: number;
  meshes: number;
  signatures: number;
  /** signature groups still queued */
  left: number;
  total: number;
}

export interface RenderService {
  backend: 'webgpu' | 'webgl2';
  /** active preset name ('low' | 'medium' | 'high' | 'ultra'; v1.3 also 'lite', opt-in) */
  readonly preset: string;
  presets: readonly string[];
  /** live: resolution, AO, volumetrics, fixture count, active shadow slots. Pool size / shadow map size: next load.
   *  The same choice again does nothing (v1.3). v1.3 (P6): 'auto' clears the stored choice: the detected preset
   *  applies and auto quality may climb back up to it (the settings' "AUTO (detected: X)" entry) */
  setPreset(name: string): void;
  /** v1.3 (P6): the preset GPU detection picks on this machine (what AUTO means here) */
  readonly detectedPreset?: string;
  /** v1.3 (P6): where the active choice comes from: ?preset= / a stored settings choice / AUTO (nothing stored) */
  readonly presetSource?: 'url' | 'stored' | 'auto';
  /** v1.3 (P6): = setPreset('auto') */
  clearPreset?(): void;
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
  /** v1.2 door-lag fix: draw EVERY mesh of the current level once (all spaces, doors, the site-wide prop batches,
   *  hidden pages / upgrades; pre-pass, scene pass and every shadow slot), a few new shader signatures per frame,
   *  so a door or a first walk into a room compiles nothing later. Call it only while a loading / drive screen covers
   *  the view (the warm frames use the warm beams). Resolves when done, or with done:false after maxMs (paused: the
   *  next call resumes; a level rebuild starts over; an already warm level resolves at once). */
  warmSite?(maxMs?: number, onProgress?: (k: number) => void): Promise<SiteWarmResult>;
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
  /** in-game frame cap in fps (0 = uncapped, the default; persisted per browser, ?maxfps= overrides at load).
   *  Covered views are capped regardless: title menu perf.menuFps (menuBlurFps unfocused), loading perf.coverFps. */
  setMaxFps(fps: number): void;
  maxFps(): number;
  /** layer used by the volumetric pass (lights that should make beams enable it) */
  volumeLayer: number;
  /** v1.3 SIGNAL look: the API for the settings' SIGNAL checkbox (meta SettingsTab, menu LocalSettings), all three
   *  optional (`r.setSignalLook?.(on)`; no render service = no checkbox):
   *    checked  = signalLook()           the toggle as this page has it
   *    onChange = setSignalLook(checked) applies live (no reload) and persists ('deadair.render.signal')
   *    hint     = signalActive()         false while the preset is not Lite / Low: show "Lite and Low only"
   *  The look applies on Lite and Low only: whole-number pixel scale with crisp pixels, Bayer posterize instead of
   *  bloom / CA / grain, and the bodycam OSD in the top-left corner during a contract (never in the van, whose CREW
   *  panel sits there, nor over a menu or the drive). Re-read signalActive() after a setPreset(). ?signal=1 / ?signal=0
   *  override the stored toggle for one page load. */
  setSignalLook?(on: boolean): void;
  /** the SIGNAL toggle as this page has it: the stored choice, or this page's ?signal=1 / ?signal=0 override (true =
   *  the checkbox is checked, whatever the preset) */
  signalLook?(): boolean;
  /** SIGNAL is on AND the preset is Lite / Low (what the screen shows now) */
  signalActive?(): boolean;
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
