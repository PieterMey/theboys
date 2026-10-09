// Owner: track ③ Render / env-render (v1.2) (apps/client/src/render/**). WebGPURenderer (WebGL2 with ?webgl=1),
// RenderPipeline post stack, flashlight + fixture light pools, the light grid, the shared fog/mist medium, mirrors,
// presets, warm-up, stats. Provides services.three + services.render (RenderService & RenderServiceV12).
// Consumes services.players (flashlights, setMirrorSelf) and services.level (fixtures, visibleSpaces, doorAnim,
// spaceGroup), tolerating absence.
import * as THREE from 'three/webgpu';
import { Fn, exponentialHeightFogFactor, fog, normalWorld, positionWorld, renderGroup, smoothstep, uniform, float } from 'three/tsl';
import { DynamicLighting } from 'three/addons/lighting/DynamicLighting.js';
import { h } from 'preact';
import { signal } from '@preact/signals';
import type { ClientContext } from '../core/context.ts';
import { SYS } from '../core/loop.ts';
import { createFlashlightPool } from './flashlights.ts';
import type { FlashCfg } from './flashlights.ts';
import { createFixturePool } from './fixtures.ts';
import type { FixtureCfg, FixtureCurveName, FixtureUpdateOpts } from './fixtures.ts';
import { createPipeline } from './pipeline.ts';
import type { PipeCfg } from './pipeline.ts';
import { AUTO_PRESET, LITE_PRESET, MENU_PRESETS, PRESET_NAMES, gpuName, presetChoice, presetForGpu, presetTable } from './presets.ts';
import type { Preset } from './presets.ts';
import { auditSceneMaterials, makeEmissive, makeSurfaceMaterial, setSurfaceNoise } from './materials.ts';
import { buildTestScene, loadFixtureLayout } from './testscene.ts';
import { createMenuStill } from './still.ts';
import type { MenuStill } from './still.ts';
import { FrameTimes, coverMode, createAutoQuality, createPerfPanel, drawInterval, gateDraw, pixelRatioFor, readPerfCfg, signalPixelRatio } from './perf.ts';
import { createOsd, osdVisible } from './osd.ts';
import type { Osd } from './osd.ts';
import type { AutoState, CoverInputs, CoverMode, DrawGate } from './perf.ts';
import type { TestScene, TestView } from './testscene.ts';
import { useLoose } from './types.ts';
import type { FixtureInfo, FlashlightInfo, LevelView, PlayersView, RenderFx, RenderService, RenderStats, SiteWarmResult, V3 } from './types.ts';
import { RENDER_LAYERS } from './api.ts';
import type { FogVolume, RenderCoverMode, RenderServiceV12 } from './api.ts';
import { GRID_DEFAULTS, createLightGrid, gridNodes } from './lightgrid.ts';
import type { LightGridCfg } from './lightgrid.ts';
import { noiseTexture3D } from './noise3d.ts';
import { FOG_DEFAULTS, buildFogNode, cpuDensity, createFogUniforms, fogNodes } from './fog.ts';
import type { FogCfg } from './fog.ts';
import { MIST_DEFAULTS, mistFrame } from './mist.ts';
import type { MistCfg } from './mist.ts';
import { MIRROR_BUDGETS, createMirrorSystem } from './mirrors.ts';
import type { MirrorBudget } from './mirrors.ts';
import { createPuffs } from './motes.ts';
import { WARM_LIMITS, createSiteWarm } from './sitewarm.ts';
import type { WarmLimits } from './sitewarm.ts';
import type { PuffKind } from './motes.ts';
import { moodFor, roomParams } from './moods.ts';
import type { LevelLayout } from '@dead-air/shared/layout.ts';

export type { RenderService, FlashlightInfo, FixtureInfo } from './types.ts';
export type { RenderServiceV12 } from './api.ts';

const VOL_LAYER = RENDER_LAYERS.vol;
const MAX_FLASHLIGHTS = 6;
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const isLocalBeam = (b: { local: boolean }) => b.local;

export interface RenderTestApi {
  views(): string[];
  view(name: string): Promise<{ ok: boolean; view?: TestView }>;
  info(): Record<string, unknown>;
  stats(): RenderStats;
  setPreset(name: string): void;
  setExposure(v: number): void;
  setFx(p: RenderFx): void;
  setPower(space: number | 'all', on: boolean): void;
  flickerSpace(space: number, ms: number): void;
  /** longest frame interval (ms) since the last call */
  hitch(): number;
  /** override the active view's camera */
  camera(pos: V3, look: V3): void;
  /** test-only: the live scene + renderer (look-dev experiments from Playwright) */
  three(): { scene: THREE.Scene; renderer: THREE.WebGPURenderer; camera: THREE.PerspectiveCamera; THREE: typeof THREE };
  /** v1.2: compiled render pipelines / shader modules so far */
  pipelines(): { pipelines: number; vs: number; fs: number };
  /** v1.2: night vision on/off (render.setNightVision) */
  nightVision(on: boolean): void;
  /** v1.2: the RenderServiceV12 surface (fog volumes, curves, mirrors, ...) */
  v12(): RenderService & RenderServiceV12;
  /** v1.2 test: override the march volume box (null = back to the scene's bounds) */
  volBounds(min: number[] | null, max: number[] | null): void;
  /** v1.2 diagnostics: mirror path toggles (ctx swap, rim light, reflection renders, explicit top-level render) */
  mirrorDebug(p: Partial<{ ctx: boolean; rim: boolean; render: boolean; explicit: boolean }>): Record<string, boolean>;
  /** v1.2 test: parked batched fixture lights visible=false (the pipeline count must stay flat) */
  hideParked(on: boolean): void;
  /** v1.2 gate P look-dev: beam ranges (m) of your own beam / teammates' beams (= their shadow far planes) */
  flashRanges(local: number, remote: number): { local: number; remote: number };
  /** v1.2 door-lag fix: render.warmSite() progress (meshes / signatures warmed, frames, adaptive batch, timings) */
  siteWarm(): Record<string, unknown>;
}

declare global {
  interface Window {
    __render?: RenderTestApi;
  }
}

type V12Cfg = { fog: boolean; mist: boolean; gi: boolean; hideParked: boolean; giK: number; hemi: number; hemiSky: string; hemiGround: string; lumClamp: number; ambientK: number };

type Cfg = {
  exposure: number;
  ambient: { sky: string; ground: string; intensity: number };
  /** indoor fog + the outdoor (lot) variant the camera blends to when it stands in an open space (v1.1 fog) */
  fog: { color: string; density: number; height: number; outdoorColor?: string; outdoorDensity?: number };
  /** cold moonlight, outdoors only: extra hemisphere sky intensity + colour while the camera stands in the lot */
  moon?: { color: string; intensity: number; dir?: number[] };
  /** cyan point light riding the Core canister (candela at full glow) */
  core?: { intensity: number; distance?: number };
  /** dark-adaptation fill light that follows the camera (candela, range m, decay) */
  adapt?: { color: string; intensity: number; distance: number; decay: number };
  flashlight: FlashCfg;
  fixture: FixtureCfg;
  /** v1.2 switches + GI */
  v12: V12Cfg;
  /** v1.2 shared medium */
  fog12: FogCfg;
  mist12: MistCfg;
  grid: LightGridCfg;
  mirrors: Record<string, Partial<MirrorBudget>>;
  /** v1.3 (3c): render.warmSite per-frame caps per backend */
  warm: { webgl2?: Partial<WarmLimits>; webgpu?: Partial<WarmLimits> };
} & PipeCfg;

const DEFAULTS: Cfg = {
  exposure: 1,
  ambient: { sky: '#7a8aa0', ground: '#14120e', intensity: 0.3 },
  fog: { color: '#06080a', density: 0.085, height: 3.4 },
  moon: { color: '#8ea4c8', intensity: 0.55 },
  core: { intensity: 3.2, distance: 7 },
  adapt: { color: '#a9b8cc', intensity: 0.4, distance: 9, decay: 1.3 },
  flashlight: { angle: 0.42, penumbra: 0.7, decay: 1.6, distance: 28, intensity1: 260, intensity2: 380, color1: '#ffe3bd', color2: '#e4eeff', bias: -0.0004, normalBias: 0.02, shadowRadius: 3, near: 0.12, cone: 0.07 },
  fixture: { color: '#d9f2c4', intensity: 12, distance: 9, decay: 2, halo: 0.55, tube: 3.2 },
  volume: { density: 1.4, noiseScale: 0.55, drift: 0.06, strength: 1, blur: 0.3 },
  bloom: { strength: 0.38, radius: 0.5, threshold: 0.9 },
  fx: { ca: 0.22, grain: 0.07, vignette: 0.42, desat: 0.32 },
  grade: { shadowTint: [0.82, 0.92, 1.12], midTint: [1.02, 1.04, 0.9], contrast: 1.06, lift: 0.012 },
  v12: { fog: true, mist: true, gi: true, hideParked: true, giK: 0.05, hemi: 0.45, hemiSky: '#8b9096', hemiGround: '#2b2925', lumClamp: 12, ambientK: 0.09 },
  fog12: FOG_DEFAULTS,
  mist12: MIST_DEFAULTS,
  grid: GRID_DEFAULTS,
  mirrors: {},
  warm: {},
};

function readCfg(ctx: ClientContext): Cfg {
  const r = (ctx.balance.render ?? {}) as Partial<Cfg>;
  const out = { ...DEFAULTS } as Cfg;
  for (const k of Object.keys(DEFAULTS) as (keyof Cfg)[]) {
    const v = r[k];
    if (v === undefined) continue;
    (out as unknown as Record<string, unknown>)[k] = typeof v === 'object' && !Array.isArray(v) ? { ...(DEFAULTS[k] as object), ...(v as object) } : v;
  }
  return out;
}

function lsGet(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}
function lsSet(k: string, v: string): void {
  try { localStorage.setItem(k, v); } catch { /* ignore */ }
}
function lsDel(k: string): void {
  try { localStorage.removeItem(k); } catch { /* ignore */ }
}

/** ?r12=fog:0,mist:1,gi:0 overrides the render.json v12 switches (look-dev / A-B) */
function v12Switches(ctx: ClientContext, base: V12Cfg): V12Cfg {
  const out = { ...base };
  const q = ctx.params.get('r12');
  if (q === '0') { out.fog = false; out.mist = false; out.gi = false; return out; }
  for (const kv of (q ?? '').split(',').filter(Boolean)) {
    const [k, v] = kv.split(':');
    if (k === 'fog' || k === 'mist' || k === 'gi' || k === 'hideParked') (out as Record<string, unknown>)[k] = v !== '0';
  }
  return out;
}

export async function install(ctx: ClientContext): Promise<void> {
  const done = ctx.readiness.require('render');
  const cfg = readCfg(ctx);
  const v12 = v12Switches(ctx, cfg.v12);
  const container = document.getElementById('game')!;
  const forceWebGL = ctx.params.get('webgl') === '1';
  const sceneMode = ctx.params.get('scene'); // 'test' = render test scene, camera owned by __render

  const gpu = await gpuName();
  const renderer = new THREE.WebGPURenderer({ antialias: false, forceWebGL, trackTimestamp: !forceWebGL });
  await renderer.init();
  const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2';
  const device = (renderer.backend as unknown as { device?: EventTarget & { pushErrorScope?(f: string): void; popErrorScope?(): Promise<{ message?: string } | null> } }).device;
  device?.addEventListener('uncapturederror', (e) => {
    ctx.reportError(`WebGPU: ${(e as unknown as { error?: { message?: string } }).error?.message ?? 'uncaptured error'}`);
  });

  const table = presetTable(ctx);
  const urlPreset = ctx.params.get('preset');
  const stored = lsGet('deadair.render.preset');
  const auto = presetForGpu(gpu, backend);
  let presetName = urlPreset && table[urlPreset] ? urlPreset : stored && table[stored] ? stored : auto;
  /** v1.3 (P6): where the preset came from: ?preset= / a stored settings choice / GPU detection (AUTO) */
  let presetSource: 'url' | 'stored' | 'auto' = urlPreset && table[urlPreset] ? 'url' : stored && table[stored] ? 'stored' : 'auto';
  let preset = table[presetName];
  /** the active preset for the HUD's RENDER chip: a signal applyPreset() updates, so a live switch (settings, auto
   *  quality) redraws the chip (it read the plain presetName and kept the old preset until something else redrew it) */
  const presetShown = signal(presetName);
  // v1.3 (4e): a page loaded on Lite also gets Lite's load-time parts: noise-volume surfaces (every surface material
  // made from now on) and low-poly fixture halos (a later switch to / from Lite keeps them until the next load)
  const liteLoad = preset.lite === true;
  if (liteLoad) setSurfaceNoise('volume');
  // pool sizes are fixed for the page's lifetime (changing them recompiles every lit material)
  const poolShadowed = preset.shadowed;
  const poolUnshadowed = Math.max(0, MAX_FLASHLIGHTS - poolShadowed);
  const poolFixtures = Math.max(...PRESET_NAMES.map((n) => table[n].fixtures).filter((f) => f <= Math.max(preset.fixtures, 8)));
  const poolOmni = cfg.fixture.omni ?? 4;

  const dbg0 = new Set((ctx.params.get('rdebug') ?? '').split(',').filter(Boolean));
  // v1.2 caps, sized once at load: spots = fixture spots + unshadowed flashlights + the mirror bounce + 4 reserved for
  // gameplay (2 flares + the flashbulb); points = the omni sub-pool + core glow + dark adaptation + the mirror ghost
  // rim + 2 reserved. No new light TYPES (the lit shaders sit at 12/12 uniform buffers).
  const capSpots = poolFixtures + poolUnshadowed + 1 + 4;
  const capPoints = poolOmni + 2 + 1 + 2;
  if (!dbg0.has('nodyn')) renderer.lighting = new DynamicLighting({ maxPointLights: capPoints, maxSpotLights: capSpots, maxHemisphereLights: 2, maxDirectionalLights: 2 });
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = Number(lsGet('deadair.render.exposure')) || cfg.exposure;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.info.autoReset = false;
  // v1.1 internal resolution: DPR clamped to 1 on wide (>= 2560 CSS px) canvases, a per-preset cap (Ultra <= 2560x1440
  // physical pixels; the browser upscales the canvas), the preset's res factor and the auto-quality scale.
  // ?dprclamp=0 / ?rescap=0 restore the old full-DPR behaviour (measurements).
  const perfCfg = readPerfCfg((ctx.balance.render as Record<string, unknown> | undefined)?.perf);
  const resOpts = { clamp: ctx.params.get('dprclamp') !== '0', cap: ctx.params.get('rescap') !== '0' };
  // 2026-10-07 host crashes: covered states draw capped (perf.menuFps / menuBlurFps / coverFps) and the menu
  // backdrop at a reduced internal resolution (perf.menuResCap). ?menufps= / ?menublurfps= / ?coverfps= / ?maxfps=
  // override (0 = every frame), ?menures=0 keeps full resolution.
  const fpsParam = (k: string, d: number): number => {
    const v = ctx.params.get(k);
    if (v === null || v === '') return d;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : d;
  };
  const gateCfg = {
    menuFps: fpsParam('menufps', perfCfg.menuFps),
    menuBlurFps: fpsParam('menublurfps', perfCfg.menuBlurFps),
    coverFps: fpsParam('coverfps', perfCfg.coverFps),
    maxFps: fpsParam('maxfps', Number(lsGet('deadair.render.maxFps')) > 0 ? Number(lsGet('deadair.render.maxFps')) : perfCfg.maxFps),
  };
  const menuResOn = ctx.params.get('menures') !== '0';
  let menuRes = false;
  const autoQ: AutoState = {
    enabled: ctx.params.get('autoq') !== '0' && lsGet('deadair.render.autoq') !== '0',
    presetFree: !urlPreset && ctx.params.get('autoq') !== 'scale',
    scale: 1,
    last: 'warming up',
    steps: 0,
  };
  let internal = { pr: 1, w: 0, h: 0, dpr: 1 };
  // v1.3 SIGNAL look (opt-in; applies on Lite and Low only): whole-number pixel scale + image-rendering: pixelated,
  // Bayer posterize instead of bloom / CA / grain, the full-resolution bodycam OSD. ?signal=1 / ?signal=0 override the
  // stored toggle (deadair.render.signal) for this page
  const signalParam = ctx.params.get('signal');
  let signalOn = signalParam === '1' ? true : signalParam === '0' ? false : lsGet('deadair.render.signal') === '1';
  const signalActive = () => signalOn && (presetName === LITE_PRESET || presetName === 'low');
  let signalK = 0;
  const applySize = () => {
    const sig = signalActive() && !menuRes;
    if (sig) {
      const r = signalPixelRatio(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1, perfCfg, autoQ.scale);
      internal = { pr: r.pr, w: r.w, h: r.h, dpr: r.dpr };
      signalK = r.k;
    } else {
      internal = pixelRatioFor(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1, preset, perfCfg, autoQ.scale, { ...resOpts, extraCap: menuRes ? perfCfg.menuResCap : null });
      signalK = 0;
    }
    renderer.setPixelRatio(internal.pr);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.domElement.style.imageRendering = sig ? 'pixelated' : '';
    ctx.diag.renderRes = `${renderer.domElement.width}x${renderer.domElement.height}`;
  };
  applySize();
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // every pass of the RenderPipeline and every shadow map re-renders the scene: world matrices update once per frame
  scene.matrixWorldAutoUpdate = false;
  const fogIn = new THREE.Color(cfg.fog.color);
  const fogOut = new THREE.Color(cfg.fog.outdoorColor ?? cfg.fog.color);
  const fogCol = fogIn.clone();
  scene.background = fogCol;
  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 120);
  camera.position.set(0, 1.6, 3);
  // v1.2 layers: the main camera sees layer 0 + first person (view model) + detail (small props / items); mirrors
  // see 0 + ghost + self + detail; shadow cameras 0 + phantom (+ detail in your own beam); the march pass only vol
  camera.layers.enable(RENDER_LAYERS.firstPerson);
  camera.layers.enable(RENDER_LAYERS.detail);
  scene.add(camera);

  // ---- the light grid + the shared medium (fog.ts owns all extinction on every preset)
  const grid = createLightGrid(cfg.grid);
  const gridN = gridNodes(grid);
  const noise = noiseTexture3D();
  const fogU = createFogUniforms(cfg.fog12);
  const F = fogNodes(fogU, gridN, noise);
  // v1.1 fog (?r12=fog:0): per-material exponential height fog towards a near-black colour
  const fogDensity = uniform(cfg.fog.density);
  const fogHeight = uniform(cfg.fog.height);
  const fogColorU = uniform(fogCol);
  // v1.3 (4e): both media are built once; Lite (and ?r12=fog:0) uses the v1.1 closed-form exponential fog (no noise
  // taps, no grid loads, no volume loop); a preset switch between them recompiles (like any preset switch)
  const fog11 = fog(fogColorU, exponentialHeightFogFactor(fogDensity, fogHeight));
  const fog12n = v12.fog ? buildFogNode(F) : null;
  const fogFor = (p: Preset) => (p.lite || !fog12n ? fog11 : fog12n);
  scene.fogNode = fogFor(preset);
  const fogBase = new THREE.Color(cfg.fog12.color);
  const fogBaseOut = new THREE.Color(cfg.fog12.outdoorColor);
  const moonFog = new THREE.Color(cfg.fog12.moon);

  // ---- GI from the light grid (tag-aware so light never crosses a wall), AO multiplies it (pipeline.ts context)
  const giU = { k: uniform(cfg.v12.giK).setGroup(renderGroup), wallH: uniform(3).setGroup(renderGroup) };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const giNode: any = v12.gi ? Fn(() => {
    const p = positionWorld;
    const n = normalWorld;
    const qx = p.x.add(n.x.mul(0.3)), qz = p.z.add(n.z.mul(0.3));
    const tag = gridN.tagAt(qx, qz);
    const e = gridN.bilinear(qx, qz, tag);
    // a little less bounce up under the ceiling (the fixtures throw their light down)
    const hk = smoothstep(giU.wallH.add(0.4), float(0.3), p.y).mul(0.3).add(0.7);
    return e.mul(giU.k).mul(hk);
  })() : null;

  // minimum ambient floor: never pure black on uncalibrated monitors (v1.2 with GI: a dimmer neutral floor, the grid
  // brings the room colour)
  // (v1.3 Lite has no GI: the v1.1 ambient floor)
  const giFor = (p: Preset) => v12.gi && !p.lite;
  const hemi = giFor(preset)
    ? new THREE.HemisphereLight(cfg.v12.hemiSky, cfg.v12.hemiGround, cfg.v12.hemi)
    : new THREE.HemisphereLight(cfg.ambient.sky, cfg.ambient.ground, cfg.ambient.intensity);
  scene.add(hemi);
  let hemiBase = hemi.intensity;
  const moonCfg = cfg.moon ?? DEFAULTS.moon!;
  const skyIn = hemi.color.clone();
  let ambientGi = giFor(preset);
  const applyAmbient = (p: Preset) => {
    const gi = giFor(p);
    ambientGi = gi;
    hemi.color.set(gi ? cfg.v12.hemiSky : cfg.ambient.sky);
    hemi.groundColor.set(gi ? cfg.v12.hemiGround : cfg.ambient.ground);
    hemiBase = gi ? cfg.v12.hemi : cfg.ambient.intensity;
    hemi.intensity = hemiBase;
    skyIn.copy(hemi.color);
  };
  const skyMoon = new THREE.Color(moonCfg.color);
  let outdoorK = 0;

  const flash = createFlashlightPool(scene, cfg.flashlight, poolShadowed, poolUnshadowed, preset.shadowMap, VOL_LAYER);
  const fixtures = createFixturePool(scene, { ...cfg.fixture, hideParked: v12.hideParked, ...(liteLoad ? { haloSegments: [10, 6] as [number, number] } : {}) }, poolFixtures, poolOmni);
  // the Core lights its surroundings: one fixed unshadowed point light following the objectives track's 'canister'
  const coreLight = new THREE.PointLight(0x46ecff, 0, cfg.core?.distance ?? 7, 2);
  coreLight.castShadow = false;
  coreLight.name = 'core-glow';
  coreLight.position.set(0, -420, 0);
  scene.add(coreLight);
  let coreObj: THREE.Object3D | null = null;
  let coreSeek = 0;
  const coreTmp = new THREE.Vector3();
  // dark adaptation: a faint cold fill at chest height (never above the head: a hot ceiling patch). Visual only.
  const adaptCfg = cfg.adapt ?? DEFAULTS.adapt!;
  const adapt = new THREE.PointLight(adaptCfg.color, 0, adaptCfg.distance, adaptCfg.decay);
  adapt.castShadow = false;
  adapt.name = 'dark-adaptation';
  adapt.position.set(0, -430, 0);
  scene.add(adapt);
  const pipe = createPipeline(renderer, scene, camera, cfg, VOL_LAYER, { fogNodes: v12.mist ? F : null, mist: cfg.mist12, giNode, lumClamp: cfg.v12.lumClamp });
  const dbg = new Set((ctx.params.get('rdebug') ?? '').split(',').filter(Boolean));
  pipe.build(preset, dbg, { signal: signalActive() });
  /** full post-pipeline builds (the first + every preset switch): each one rebuilds every render object's nodes */
  let pipeBuilds = 1;
  if (dbg.has('nofog')) { scene.fogNode = null; fogU.k.value = 0; }

  // keepNames proof (DynamicLighting batches by class name): must survive the production build
  ctx.diag.keepNames = fixtures.spots[0]?.constructor.name === 'SpotLight' && (fixtures.omnis[0]?.constructor.name ?? 'PointLight') === 'PointLight';
  if (!ctx.diag.keepNames) ctx.reportError(`keepNames missing: SpotLight minified to '${fixtures.spots[0]?.constructor.name}'`);
  ctx.diag.backend = backend;
  ctx.diag.renderPreset = presetName;
  ctx.diag.renderPresetSource = presetSource;
  ctx.diag.renderPresetDetected = auto;
  ctx.diag.gpu = gpu;
  ctx.diag.renderV12 = { fog: v12.fog, mist: v12.mist, gi: v12.gi, hideParked: v12.hideParked, capSpots, capPoints };

  // ---- state ----
  let reduceFlicker = lsGet('deadair.render.reduceFlicker') === '1';
  let flashOverride: (() => FlashlightInfo[]) | null = null;
  let fixtureOverride: { fixtures: FixtureInfo[]; visibleSpaces?: (cam: V3) => Set<number> } | null = null;
  let gpuMs: number | undefined;
  let resolving = false;
  let warmFrames = 0;
  let lastDraws = 0;
  let test: TestScene | null = null;
  let testView: TestView | null = null;
  let backdropActive = false;
  /** v1.3 (3e): the static title-menu still (Low / Lite / WebGL2), until a level exists */
  let still: MenuStill | null = null;
  /** v1.3 SIGNAL: the bodycam OSD layer (created on first use) + its per-frame data (no per-frame objects) */
  let osd: Osd | null = null;
  const osdData = { batt: null as number | null, rtt: null as number | null, loc: null as string | null, k: 0 };
  let t = 0;
  let mode: CoverMode = 'game';
  const gate: DrawGate = { last: 0 };
  let drawsInWindow = 0;
  let drawFps = 0;
  let drawWindowAt = 0;
  let drawnFrames = 0;
  let shadowsArmed = 0;
  // desktop shell: nothing is drawn while its window is minimized / hidden (warm-up frames still are)
  let winHidden = false;
  try {
    type WinState = { minimized?: boolean; visible?: boolean } | null | undefined;
    const desk = (window as unknown as { deadAirDesktop?: { windowState?: () => WinState; onWindowState?: (cb: (s: WinState) => void) => unknown } }).deadAirDesktop;
    const apply = (s: WinState) => { winHidden = !!s && (s.minimized === true || s.visible === false); };
    apply(desk?.windowState?.());
    desk?.onWindowState?.(apply);
  } catch { /* optional shell API */ }
  let shownDraw = '';

  const applyPower = (v: TestView) => {
    fixtures.setPower('all', true);
    if (!v.power.all) fixtures.setPower('all', false);
    for (const s of v.power.off) fixtures.setPower(s, false);
  };

  // night vision (G3's nvg): grade uniforms, eased
  const nvState = { on: false, k: 0, gain: 6 };
  const fxState = { ca: cfg.fx.ca, grain: cfg.fx.grain, vignette: cfg.fx.vignette, desat: cfg.fx.desat };
  let moodDesat = 0;
  const applyFx = () => {
    pipe.fx.ca.value = reduceFlicker ? 0 : fxState.ca;
    pipe.fx.grain.value = fxState.grain;
    pipe.fx.vignette.value = fxState.vignette;
    pipe.fx.desat.value = Math.max(0, fxState.desat + moodDesat);
  };
  applyFx();

  // ---- v1.1: frame times, auto quality (v1.2 feature ladder), F3 panel, warm-up ----
  const times = new FrameTimes();
  const drawTimes = new FrameTimes();
  const applyPreset = (name: string) => {
    const p = table[name];
    if (!p) return;
    presetName = name;
    preset = p;
    presetShown.value = name;
    ctx.diag.renderPreset = name;
    applySize();
    // v1.3 (4e): Lite's medium + ambient (scene-level: every lit material recompiles with the preset anyway)
    if (!dbg.has('nofog') && scene.fogNode !== fogFor(p)) scene.fogNode = fogFor(p);
    if (giFor(p) !== ambientGi) applyAmbient(p);
    pipe.build(p, dbg, { signal: signalActive() });
    pipeBuilds++;
    pipe.setMistSteps(featureLevel >= 2 ? Math.max(4, Math.ceil(p.volSteps / 2)) : null);
    warmFrames = Math.max(warmFrames, 2);
  };
  const steady = () => !document.hidden && !backdropActive && warmAll <= 0 && mirrorWarmFrames <= 0 && !siteWarm.active() && ctx.ui.screen.value.name === 'none' && !document.querySelector('[data-loading-active]');
  /** auto quality features: 1 = no live mirror, 2 = half the march steps */
  const FEATURE_NAMES = ['', 'live mirror', 'mist steps'];
  let featureLevel = 0;
  const setFeatureLevel = (n: number) => {
    featureLevel = Math.max(0, Math.min(FEATURE_NAMES.length - 1, n));
    mirrorSys.setSuspended(featureLevel >= 1);
    pipe.setMistSteps(featureLevel >= 2 ? Math.max(4, Math.ceil(preset.volSteps / 2)) : null);
    ctx.diag.renderFeatures = featureLevel;
  };
  const autoCtl = createAutoQuality(perfCfg, drawTimes, {
    preset: () => presetName,
    presets: PRESET_NAMES,
    setPreset: (n) => { applyPreset(n); autoCtl.busy(performance.now()); },
    setScale: () => { applySize(); autoCtl.busy(performance.now()); },
    gpuMs: () => gpuMs,
    steady,
    features: { level: () => featureLevel, max: () => FEATURE_NAMES.length - 1, set: (n) => { setFeatureLevel(n); autoCtl.busy(performance.now()); }, name: (n) => FEATURE_NAMES[n] ?? '' },
    // v1.3 (P6): the ladder climbs back up to the stored choice; with AUTO (nothing stored) to the detected preset
    ceiling: () => (presetSource === 'auto' ? auto : lsGet('deadair.render.preset') ?? presetName),
    // v1.3 (4e): Lite has one more resolution rung (0.5); it never changes preset by itself
    scales: () => (preset.lite ? perfCfg.liteScales : perfCfg.scales),
  }, autoQ);

  // ---- mirrors (flag 'mirrors': off = fallback glass only)
  const levelSvc = () => useLoose<LevelView & { doorAnim?(id: number): number; spaceGroup?(s: number): THREE.Group | null; layout?: LevelLayout | null; root?: THREE.Object3D; version?: number }>(ctx, 'level');
  const camSpace = (): number => {
    const L = currentLayout();
    if (!L) return -1;
    const cx = Math.floor(camera.position.x), cz = Math.floor(camera.position.z);
    return cx >= 0 && cz >= 0 && cx < L.W && cz < L.H ? L.owner[cz * L.W + cx] : -1;
  };
  const mirrorSys = createMirrorSystem({
    renderer, scene, camera,
    enabled: ctx.flags.mirrors !== false && !dbg0.has('nomirrors'),
    budget: () => ({ ...MIRROR_BUDGETS[presetName] ?? MIRROR_BUDGETS.medium, ...(cfg.mirrors[presetName] ?? {}) }),
    coverMode: () => mode as RenderCoverMode,
    visibleSpaces: (c) => { const src = fixtureSource(); return src?.visibleSpaces ? src.visibleSpaces(c) : null; },
    inVan: () => { const L = currentLayout(); const s = camSpace(); return !!L && s >= 0 && L.spaces[s]?.type === 'van'; },
    localBeam: () => flash.beams().find(isLocalBeam) ?? null,
    players: () => useLoose<{ setMirrorSelf?(on: boolean): THREE.Object3D | null }>(ctx, 'players'),
    reflectionContext: () => pipe.reflectionContext(),
    reflecting: (on) => pipe.reflecting(on),
    nested: dbg0.has('mirrornested'),
    hideIdle: () => v12.hideParked,
  });
  const puffs = createPuffs(scene);

  const perfLines = (): string[] => {
    const now = performance.now();
    const s = times.stats(2000, now);
    const net = ctx.net;
    const mi = mirrorSys.info();
    const gs = grid.stats();
    return [
      `DEAD AIR PERF  [F3]`,
      `fps ${s.fps.toFixed(0).padStart(4)}   frame p50 ${s.p50.toFixed(1)} p95 ${s.p95.toFixed(1)} max ${s.max.toFixed(0)} ms`,
      `gpu ${gpuMs !== undefined ? `${gpuMs.toFixed(2)} ms` : 'n/a'}   cpu ${ctx.loop.perf.frameMs.toFixed(2)} ms   draws ${lastDraws}`,
      `drawn ${drawFps.toFixed(0)}/s   view ${mode}${menuRes ? ' (menu res)' : ''}${gateCfg.maxFps > 0 ? `   cap ${gateCfg.maxFps} fps` : ''}`,
      `preset ${presetName} (${presetSource}${presetSource === 'auto' ? '' : `, detected ${auto}`})   ${backend}   internal ${renderer.domElement.width}x${renderer.domElement.height}`,
      `css ${window.innerWidth}x${window.innerHeight}  dpr ${(window.devicePixelRatio || 1).toFixed(2)} -> ${internal.pr.toFixed(3)}  scale ${autoQ.scale.toFixed(2)}`,
      `auto ${autoQ.enabled ? (autoQ.presetFree ? 'on' : 'scale only') : 'off'}: ${autoQ.last}`,
      `v12 fog ${v12.fog ? 'on' : 'off'} mist ${pipe.mistActive() ? 'on' : 'off'} gi ${v12.gi ? 'on' : 'off'}  features -${featureLevel}`,
      `mirrors ${mi.live}/${mi.registered} live  rt ${mi.rt ? `${mi.rt[0]}x${mi.rt[1]}` : '-'}  renders ${mi.renders}${mi.suspended ? ' (suspended)' : ''}`,
      `lights fix ${fixtures.litCount()} shadows ${shadowsArmed}/${flash.usedShadowed()}  grid ${gs.uploads} uploads`,
      `link ${net.status === 'joined' ? `${Math.round(net.rtt)} ms` : net.status}`,
    ];
  };
  const panel = createPerfPanel(perfLines);
  ctx.bus.on('world:phase', () => autoCtl.busy(performance.now()));
  ctx.bus.on('net:welcome', () => autoCtl.busy(performance.now()));
  void ctx.services.wait('level').then((lv) => lv.onRebuild(() => autoCtl.busy(performance.now())));
  addEventListener('keydown', (e) => {
    if (e.code !== 'F3' || e.repeat) return;
    e.preventDefault();
    panel.toggle();
  });

  /** frames left of the full warm-up */
  let warmAll = 0;
  /** warm-up frames left that render with the camera spun about the world up axis */
  let spin = 0;
  const spinQ = new THREE.Quaternion();
  const savedQ = new THREE.Quaternion();
  let holdDraw = false;
  let warmAllWaiters: (() => void)[] = [];
  let warmWaiters: (() => void)[] = [];
  let proxies: THREE.Group | null = null;
  let warmSet: THREE.Group | null = null;
  /** real site-wide batches the warm set's forced reflection draws (visible + unculled during its frames) */
  let warmSetIms: THREE.Object3D[] = [];
  const warmImSaved: { o: THREE.Object3D; visible: boolean; frustumCulled: boolean }[] = [];
  // ---- v1.2 door-lag fix: render.warmSite() (sitewarm.ts) over the level root
  const warmLayers = (1 << 0) | (1 << RENDER_LAYERS.firstPerson) | (1 << RENDER_LAYERS.detail) | (1 << RENDER_LAYERS.phantom);
  // v1.3 (3c): per-frame caps (WebGL2 links every program synchronously: ~6 units; WebGPU: ~4 signature groups)
  const warmLimits: WarmLimits = { ...WARM_LIMITS[backend], ...(cfg.warm?.[backend] ?? {}) };
  const siteWarm = createSiteWarm({
    root: () => (backdropActive ? null : levelSvc()?.root ?? null),
    version: () => levelSvc()?.version,
    skip: (m) => (m as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh === true || m.name === 'mirror-live' || m.name.startsWith('mirror-warm')
      || (Array.isArray(m.material) ? m.material : [m.material]).some((x) => x?.name === 'mirror-live') || (m.layers.mask & warmLayers) === 0,
    now: () => performance.now(),
    limits: () => warmLimits,
  });
  const volMeshRef = pipe.volMesh;
  /** v1.2: one tiny proxy per unique (material, vertex layout, shadow flags, layer mask); filter limits the meshes
   *  (warm set: mirror rooms + the ghost / self / phantom layers). Proxies keep each mesh's layer mask so ghost / self
   *  meshes compile through the forced reflection and phantom meshes through the warm beams' shadows.
   *  Never an InstancedMesh proxy (door-lag finding): three r186 builds each InstancedMesh's shaders for that object
   *  alone (its uuid is in the node cache key, its instance buffer's name in the shader), so a proxy only warmed
   *  itself. The level's site-wide batches are warmed for real: warmSite(), and the warm set forces the mirror rooms'
   *  batches into its reflection (warmSetIms). */
  const buildProxies = (filter?: (o: THREE.Mesh) => boolean): THREE.Group => {
    const g = new THREE.Group();
    g.name = 'render-warm-proxies';
    const seen = new Set<string>();
    let i = 0;
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || (m as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh || o === volMeshRef) return;
      if (o.name === 'render-warm-proxies' || o.parent?.name === 'render-warm-proxies' || o.name === 'mirror-warm' || o.name === 'mirror-warm-fallback') return;
      if (o.layers.mask === 1 << VOL_LAYER) return;
      if (filter && !filter(m)) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      if (!mats.length || mats.some((x) => !x)) return;
      if ((m as unknown as THREE.InstancedMesh).isInstancedMesh === true) return;
      const geo = m.geometry;
      const sig = `${Object.keys(geo.attributes).sort().join(',')}${geo.index ? ':i' : ''}:${Object.keys(geo.morphAttributes).length}`;
      const key = `${mats.map((x) => x.uuid).join('+')}|${sig}|${m.castShadow ? 'C' : ''}${m.receiveShadow ? 'R' : ''}|L${o.layers.mask}`;
      if (seen.has(key)) return;
      seen.add(key);
      const p = new THREE.Mesh(geo, m.material);
      p.castShadow = m.castShadow;
      p.receiveShadow = m.receiveShadow;
      p.layers.mask = o.layers.mask;
      p.frustumCulled = false;
      p.renderOrder = m.renderOrder;
      p.position.set(((i % 9) - 4) * 0.03, -0.12 + Math.floor(i / 9) % 6 * 0.03, -1.4);
      p.scale.setScalar(1e-3);
      i++;
      g.add(p);
    });
    return g;
  };
  /** this preset can show a live mirror (flag on, budget > 0) */
  const liveMirrorBudget = () => ctx.flags.mirrors !== false && !dbg0.has('nomirrors') && ({ ...MIRROR_BUDGETS[presetName] ?? MIRROR_BUDGETS.medium, ...(cfg.mirrors[presetName] ?? {}) }).live > 0;
  /** the v1.2 warm set: everything a mirror can show, seen through a forced reflection (and inside the warm beams
   *  when the loading flow's warmup() runs it): every material of the mirror rooms (+ the rooms visible from them),
   *  everything outside the level's space groups (doors, players, monsters, items, fixtures, particles), the ghost /
   *  self / phantom layer meshes and the glass. Other rooms' materials never show in a mirror and stay out (compile
   *  time). Gate P: the doors, avatars, items and monsters a mirror shows were missing (+64 pipelines at the first
   *  live mirror). */
  const buildWarmSet = (): THREE.Group => {
    const lv = levelSvc();
    const mirrorSpaces = new Set<number>();
    const L = currentLayout();
    // no live mirror on this preset (Low) or flag off: nothing to compile through a reflection
    const reg = liveMirrorBudget() ? mirrorSys.spaces() : [];
    for (const s of reg) {
      mirrorSpaces.add(s);
      if (L && lv?.visibleSpaces) {
        const sp = L.spaces[s];
        if (sp) for (const n of lv.visibleSpaces([sp.rect.x + sp.rect.w / 2, 1.5, sp.rect.y + sp.rect.h / 2])) mirrorSpaces.add(n);
      }
    }
    // every space group (to leave out the rooms no mirror sees) and the mirror rooms' groups
    const groups = new Set<THREE.Object3D>();
    const allGroups = new Set<THREE.Object3D>();
    if (lv?.spaceGroup && L) {
      for (let s = 0; s < L.spaces.length; s++) {
        const g = lv.spaceGroup(s);
        if (!g) continue;
        allGroups.add(g);
        if (mirrorSpaces.has(s)) groups.add(g);
      }
    }
    const special = (1 << RENDER_LAYERS.ghost) | (1 << RENDER_LAYERS.self) | (1 << RENDER_LAYERS.phantom);
    /** in a mirror room, or outside every space group (doors, avatars, monsters, items, fixtures ...) */
    const inMirrorView = (o: THREE.Object3D) => {
      for (let p: THREE.Object3D | null = o; p; p = p.parent) {
        if (groups.has(p)) return true;
        if (allGroups.has(p)) return false;
      }
      return true;
    };
    // mirrors without level space groups (the test scene, a hub prop): every material may show in the glass
    const everything = reg.length > 0 && allGroups.size === 0;
    const fpOnly = 1 << RENDER_LAYERS.firstPerson;
    // never a live-glass proxy: it samples the reflection target the forced reflection draws into (the warm glass
    // itself compiles the live-glass program); never the first-person view model (no mirror camera sees it)
    const liveGlass = (m: THREE.Mesh) => m.name === 'mirror-live' || (Array.isArray(m.material) ? m.material : [m.material]).some((x) => x?.name === 'mirror-live');
    // the level's site-wide prop batches with instances in a mirror room: drawn for real through the forced reflection
    // (an InstancedMesh cannot be proxied)
    warmSetIms = [];
    if (reg.length > 0) lv?.root?.traverse((o) => {
      const sp = (o as THREE.InstancedMesh).isInstancedMesh ? (o.userData?.siteSpaces as Set<number> | undefined) : undefined;
      if (!sp) return;
      for (const s of sp) if (everything || mirrorSpaces.has(s)) { warmSetIms.push(o); return; }
    });
    return buildProxies((m) => !liveGlass(m) && m.layers.mask !== fpOnly && (everything || (m.layers.mask & special) !== 0 || m.name === 'render-puffs' || (m.material as THREE.Material)?.name === 'mirror-fallback' || (reg.length > 0 && inMirrorView(m))));
  };
  const endWarmSet = () => {
    warmSetIms = [];
    if (warmSet) { warmSet.removeFromParent(); warmSet = null; }
    // also releases the forced mirror self (the mirror system keeps it only while a mirror is within 8 m)
    mirrorSys.warm(null);
  };

  // ---- v1.2 automatic mirror warm (gate P: the warm set ran only from the loading flow, so ?test=1 pages and any
  // level shown without the loading screen compiled +64 pipelines at the first live mirror). Whenever the registered
  // mirror set changes (a level rebuild, a late registration, the test scene), what a mirror can show compiles
  // through ONE forced reflection (2 frames, behind the drive / loading screen in play), as soon as the level's
  // content is in or after MIRROR_WARM_CAP_MS, and once more if the content lands after such a capped warm. The real
  // beams stay on (no warm-beam frames).
  const MIRROR_WARM_CAP_MS = 12_000;
  const mirrorWarm = { version: -1, since: 0, state: 'idle' as 'idle' | 'pending' | 'early' | 'done', runs: 0 };
  let mirrorWarmFrames = 0;
  const contentReady = (): boolean => {
    if (backdropActive) return true;
    const lv = levelSvc() as { contentReady?(): boolean; texturesReady?(): boolean } | undefined;
    if (!lv) return true;
    try {
      if (typeof lv.contentReady === 'function') return lv.contentReady();
      return typeof lv.texturesReady === 'function' ? lv.texturesReady() : true;
    } catch { return true; }
  };
  const mirrorAutoWarm = (now: number) => {
    const v = mirrorSys.version();
    if (v !== mirrorWarm.version) { mirrorWarm.version = v; mirrorWarm.since = now; mirrorWarm.state = 'pending'; }
    if (mirrorWarm.state === 'early' && contentReady()) mirrorWarm.state = 'pending';
    if (mirrorWarm.state !== 'pending') return;
    // nothing a reflection could compile: Low, the flag off, no mirror registered
    if (!liveMirrorBudget() || mirrorSys.list().length === 0) { mirrorWarm.state = 'done'; return; }
    // a warm-up is running (boot frames, the loading flow's warmup / warmupAll): decide when it is over
    if (warmSet || warmFrames > 0 || warmAll > 0 || mirrorWarmFrames > 0 || siteWarm.active()) return;
    const ready = contentReady();
    if (!ready && now - mirrorWarm.since < MIRROR_WARM_CAP_MS) return;
    try {
      warmSet = buildWarmSet();
      camera.add(warmSet);
      mirrorSys.warm(warmSet);
      // 3 frames: the forced mirror self (players.setMirrorSelf) shows from the second one
      mirrorWarmFrames = 3;
      mirrorWarm.runs++;
      mirrorWarm.state = ready ? 'done' : 'early';
      ctx.diag.mirrorWarm = { proxies: warmSet.children.length, ims: warmSetIms.length, ready, runs: mirrorWarm.runs, atMs: Math.round(now) };
    } catch (e) {
      console.warn('[render] mirror warm', e);
      warmSet = null;
      mirrorWarm.state = 'done';
    }
  };
  // belt and braces: every level rebuild re-arms it (E3 re-registers its glass in the rebuild)
  void ctx.services.wait('level').then((lv) => lv.onRebuild(() => { mirrorWarm.version = -1; }));

  // ---- v1.2 service surface ----
  const curveName = (c: string): FixtureCurveName | null => (c === 'die' || c === 'surge_die' || c === 'brown' || c === 'pulse' || c === 'revive' ? c : null);
  const ambientAt = (x: number, _y: number, z: number): V3 => {
    const g = grid.sample(x, z);
    const k = cfg.v12.ambientK;
    const amb = hemi.intensity * 0.04;
    return [g[0] * k + amb, g[1] * k + amb, g[2] * k + amb];
  };
  const v12Service: RenderServiceV12 = {
    layers: RENDER_LAYERS,
    brownout: (space, ms, depth) => fixtures.brownout(space, ms, depth),
    failSpace: (space) => fixtures.failSpace(space),
    fixtureCurve: (indices, curve, startMs, stepMs) => { const c = curveName(curve); if (c) fixtures.fixtureCurve(indices, c, startMs, stepMs); },
    fixtureLevels: () => fixtures.levels(),
    mirrors: mirrorSys,
    setFogVolumes(list: readonly FogVolume[]) {
      grid.setVolumes(list);
      refreshHaloMist();
    },
    puff(pos, kind, strength = 1) {
      const k: PuffKind = kind === 'steam' || kind === 'dust' || kind === 'frost' ? kind : 'breath';
      // brightness: the fixture light here + the local beam if it reaches the spot (breath only shows when lit)
      const a = ambientAt(pos[0], pos[1], pos[2]);
      let lit = (a[0] + a[1] + a[2]) / 3;
      const b = flash.beams().find((x) => x.local);
      if (b) {
        const dx = pos[0] - b.pos[0], dy = pos[1] - b.pos[1], dz = pos[2] - b.pos[2];
        const d = Math.hypot(dx, dy, dz) || 1e-3;
        const cos = (dx * b.dir[0] + dy * b.dir[1] + dz * b.dir[2]) / d;
        if (cos > Math.cos(b.angle)) lit += Math.min(3, (b.intensity / (d * d + 1)) * 0.02) * Math.min(1, (cos - Math.cos(b.angle)) * 6);
      }
      puffs.puff(pos, k, strength, Math.min(2.5, lit * 1.4 + 0.02), performance.now(), b?.dir);
    },
    beams: () => flash.beams(),
    beamInterference: (who, ms, depth) => flash.interfere(who, ms, depth),
    ambientAt,
    coverMode: () => mode as RenderCoverMode,
    setNightVision(on, opts) { nvState.on = on; if (opts?.gain !== undefined) nvState.gain = Math.max(1, opts.gain); },
  };

  const service: RenderService & RenderServiceV12 = {
    backend,
    get preset() { return presetName; },
    get detectedPreset() { return auto; },
    get presetSource() { return presetSource; },
    // v1.3 (4e): the settings list Lite first (opt-in; the auto-quality ladder stays Low..Ultra)
    presets: MENU_PRESETS,
    setPreset(name) {
      // v1.3 (3d): the same choice again does nothing. The settings re-apply the stored preset ~600 ms after every
      // welcome (meta applySettings): that rebuilt the whole post pipeline (a new scene-pass context = new node builds
      // for every render object) and reset the auto-quality scale on every join, and it overrode a ?preset= page
      const c = presetChoice(name, lsGet('deadair.render.preset'), presetName, Object.keys(table), auto);
      if (c.store !== null) lsSet('deadair.render.preset', c.store);
      else lsDel('deadair.render.preset');
      // v1.3 (P6): 'auto' = nothing stored: the detected preset, and auto quality may climb back up to it (a ?preset=
      // page keeps its source until a choice really switches the preset)
      if ((name === AUTO_PRESET || table[name]) && (presetSource !== 'url' || c.apply)) presetSource = name === AUTO_PRESET ? 'auto' : 'stored';
      ctx.diag.renderPresetSource = presetSource;
      if (!c.apply) return;
      applyPreset(c.apply);
      autoQ.scale = 1;
      applySize();
      autoCtl.busy(performance.now());
    },
    /** v1.3 (P6): = setPreset('auto') */
    clearPreset() { service.setPreset(AUTO_PRESET); },
    setExposure(v) {
      renderer.toneMappingExposure = Math.max(0.2, Math.min(4, v));
      lsSet('deadair.render.exposure', String(renderer.toneMappingExposure));
    },
    exposure: () => renderer.toneMappingExposure,
    setFx(p) {
      Object.assign(fxState, Object.fromEntries(Object.entries(p).filter(([, v]) => typeof v === 'number')));
      applyFx();
    },
    setReduceFlicker(on) {
      reduceFlicker = on;
      lsSet('deadair.render.reduceFlicker', on ? '1' : '0');
      applyFx();
    },
    setPower: (space, on) => fixtures.setPower(space, on),
    flickerSpace: (space, ms) => fixtures.flickerSpace(space, ms),
    stats: () => ({ fps: ctx.loop.perf.fps, frameMs: ctx.loop.perf.frameMs, gpuMs, drawCalls: lastDraws }),
    warmup() {
      // v1.2 warm set (always): the mirror rooms' materials through a forced reflection, ghost / self / phantom
      // layers, particles + glass; then four frames, the camera turned 90 degrees further each time. The forced
      // reflection only where a live mirror can ever show (not Low / mirrors off): door-lag run, Low preset, it
      // compiled reflection programs for the whole spawn view (one 5.4 s software frame) that no mirror would use
      if (!warmSet) {
        try {
          warmSet = buildWarmSet();
          camera.add(warmSet);
          if (liveMirrorBudget()) mirrorSys.warm(warmSet);
          ctx.diag.warmSet = warmSet.children.length;
          // the same scope as the automatic mirror warm: a pending one is covered (again later if content is missing)
          if (mirrorWarm.state === 'pending' && mirrorWarm.version === mirrorSys.version()) mirrorWarm.state = contentReady() ? 'done' : 'early';
        } catch (e) { console.warn('[render] warm set', e); warmSet = null; }
      }
      warmFrames = Math.max(warmFrames, 4);
      spin = 4;
      return new Promise((res) => { warmWaiters.push(res); });
    },
    warmupAll(frames = 3) {
      if (!proxies) {
        proxies = buildProxies();
        camera.add(proxies);
        mirrorSys.warm(proxies);
        ctx.diag.warmProxies = proxies.children.length;
      }
      warmAll = Math.max(warmAll, frames);
      warmFrames = Math.max(warmFrames, frames + 1);
      autoCtl.busy(performance.now());
      return new Promise<void>((res) => { warmAllWaiters.push(res); });
    },
    warmSite(maxMs = 20_000, onProgress?: (k: number) => void): Promise<SiteWarmResult> {
      autoCtl.busy(performance.now());
      const p = siteWarm.run(maxMs, onProgress);
      void p.then((r) => { ctx.diag.siteWarm = r; autoCtl.busy(performance.now()); });
      return p;
    },
    frameStats: (spanMs: number) => times.stats(spanMs, performance.now()),
    perf() {
      const s = times.stats(perfCfg.telemetrySec * 1000, performance.now());
      return {
        fps: +s.fps.toFixed(1), p50: +s.p50.toFixed(1), p95: +s.p95.toFixed(1), long: s.long, gpuMs: gpuMs !== undefined ? +gpuMs.toFixed(2) : null,
        preset: presetName, res: [renderer.domElement.width, renderer.domElement.height] as [number, number], dpr: +(window.devicePixelRatio || 1).toFixed(3),
        scale: +internal.pr.toFixed(3), autoScale: autoQ.scale, backend, auto: autoQ.last,
      };
    },
    setAutoQuality(on) {
      autoQ.enabled = on;
      lsSet('deadair.render.autoq', on ? '1' : '0');
      if (!on && autoQ.scale !== 1) { autoQ.scale = 1; applySize(); }
      if (!on && featureLevel) setFeatureLevel(0);
    },
    busy: () => autoCtl.busy(performance.now()),
    hold(on) {
      holdDraw = on;
      if (!on) autoCtl.busy(performance.now());
    },
    setMaxFps(fps) {
      const n = Number.isFinite(fps) && fps > 0 ? Math.max(20, Math.round(fps)) : 0;
      gateCfg.maxFps = n;
      lsSet('deadair.render.maxFps', String(n));
      autoCtl.busy(performance.now());
    },
    maxFps: () => gateCfg.maxFps,
    // v1.3 SIGNAL: the settings checkbox's API (setSignalLook / signalLook / signalActive; usage in types.ts
    // RenderService). Live, persisted; a rebuild only when what the screen shows changes (SIGNAL off on Medium = none)
    setSignalLook(on: boolean) {
      lsSet('deadair.render.signal', on ? '1' : '0');
      if (on === signalOn) return;
      const was = signalActive();
      signalOn = on;
      if (signalActive() === was) return;
      applySize();
      pipe.build(preset, dbg, { signal: signalActive() });
      pipeBuilds++;
      warmFrames = Math.max(warmFrames, 2);
      autoCtl.busy(performance.now());
    },
    signalLook: () => signalOn,
    signalActive: () => signalActive(),
    volumeLayer: VOL_LAYER,
    setFlashlightSource(fn) { flashOverride = fn; },
    setFixtureSource(src) { fixtureOverride = src; },
    ...v12Service,
  };

  ctx.services.provide('three', { renderer, scene, camera, backend });
  ctx.services.provide('render', service);
  // reads the presetShown signal: the chip redraws on every preset switch (settings or auto quality)
  ctx.ui.registerHud('bottom-right', () => h('div', { class: 'hud-chip', 'data-testid': 'render-chip' }, `RENDER ${backend.toUpperCase()} · ${presetShown.value.toUpperCase()}`), { id: 'render-backend', order: 100 });

  addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    applySize();
    autoCtl.busy(performance.now());
  });

  // ---- test scene / idle backdrop (replaced as soon as a real level or players exist) ----
  const levelPresent = () => !!ctx.world.layout || !!useLoose<LevelView>(ctx, 'level')?.layout;
  // v1.3 (3e): no live 3D backdrop on Low / Lite or WebGL2: a static still behind the title menu (the backdrop's
  // 67-91 programs compiled at boot; seconds of freezes on the friends' WebGL2 machines). ?menu3d=1 forces the live
  // backdrop, ?menu3d=0 the still on every preset
  const menu3d = ctx.params.get('menu3d');
  const staticMenu = sceneMode !== 'test' && menu3d !== '1' && (menu3d === '0' || backend === 'webgl2' || presetName === 'low' || presetName === 'lite');
  if (staticMenu && !levelPresent()) still = createMenuStill(container);
  ctx.diag.menuBackdrop = staticMenu ? 'still' : '3d';
  try {
    const L = staticMenu && sceneMode !== 'test' ? null : await loadFixtureLayout(ctx.params.get('layout') ?? 'facility_s2_p4');
    if (L && (sceneMode === 'test' || !levelPresent())) {
      test = buildTestScene(L, sceneMode === 'test' ? { mirrors: mirrorSys } : undefined);
      scene.add(test.group);
      pipe.setVolumeBounds(test.bounds);
      backdropActive = true;
      testView = test.views[sceneMode === 'test' ? 'six' : 'corridor'] ?? Object.values(test.views)[0] ?? null;
      if (testView) applyPower(testView);
    }
  } catch (e) {
    console.warn('[render] test scene unavailable', e);
  }

  const look = new THREE.Vector3();
  const swayDir = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);
  const setCam = (p: V3, l: V3) => {
    camera.position.set(p[0], p[1], p[2]);
    look.set(l[0], l[1], l[2]);
    camera.lookAt(look);
  };

  function flashlightList(): FlashlightInfo[] {
    if (flashOverride) return flashOverride();
    const players = useLoose<PlayersView>(ctx, 'players');
    if (players && !backdropActive) {
      try { return players.flashlights(); } catch { return []; }
    }
    if (backdropActive && testView) {
      if (sceneMode === 'test') return testView.lights;
      const base = testView.lights[0];
      if (!base) return [];
      const sway = Math.sin(t * 0.37) * 0.22;
      const d = swayDir.set(base.dir[0], base.dir[1], base.dir[2]).applyAxisAngle(UP, sway);
      d.y += Math.sin(t * 0.23) * 0.05;
      return [{ ...base, dir: [d.x, d.y, d.z] }];
    }
    return [];
  }

  // the fixture source: one persistent object per kind (frame() and the mirror system call this every frame)
  const NO_FIXTURES: FixtureInfo[] = [];
  let srcLevel: LevelView | null = null;
  const levelVis = (c: V3) => (srcLevel ? srcLevel.visibleSpaces(c) : new Set<number>());
  const levelSrc: { fixtures: FixtureInfo[]; visibleSpaces?: (cam: V3) => Set<number> } = { fixtures: NO_FIXTURES };
  const testSrc: { fixtures: FixtureInfo[]; visibleSpaces?: (cam: V3) => Set<number> } = { fixtures: NO_FIXTURES };
  function fixtureSource() {
    if (fixtureOverride) return fixtureOverride;
    const level = useLoose<LevelView>(ctx, 'level');
    if (level && !backdropActive) {
      srcLevel = level;
      // a missing list is ONE constant empty array (a fresh [] per frame rebuilt the fixture pool every frame)
      levelSrc.fixtures = level.fixtures ?? NO_FIXTURES;
      // (a level mid-edit may lack it)
      levelSrc.visibleSpaces = typeof level.visibleSpaces === 'function' ? levelVis : undefined;
      return levelSrc;
    }
    if (backdropActive && test) { testSrc.fixtures = test.fixtures; return testSrc; }
    return null;
  }

  function currentLayout(): LevelLayout | null {
    if (backdropActive && test) return test.layout;
    return (ctx.world.layout as LevelLayout | null) ?? (levelSvc()?.layout as LevelLayout | null | undefined) ?? null;
  }

  // ---- the medium per layout: grid + per-room params + theme mood
  let gridLayout: LevelLayout | null = null;
  let mood = moodFor(null);
  const fixtureTint = new THREE.Color(1, 1, 1);
  const refreshHaloMist = () => {
    const f12 = cfg.fog12;
    const ref = Math.max(1e-3, f12.haze * Math.exp(-2.4 / f12.hazeHeight));
    const L = gridLayout;
    const vols = grid.volumes();
    fixtures.setMistFn(v12.fog ? (x, y, z) => {
      let room = { mist: 1, haze: 1 };
      if (L) { const c = grid.cell(Math.floor(x), Math.floor(z)); if (c && c.tag >= 0) room = grid.spaceParams(c.tag); }
      return 0.6 + 0.4 * cpuDensity({ haze: f12.haze * mood.haze, hazeHeight: f12.hazeHeight, mist: f12.mist * mood.mist, mistTop: f12.mistTop, mistSoft: f12.mistSoft }, x, y, z, vols, room) / ref;
    } : null);
  };
  /** the mood's dark-floor colour of the medium (set with the layout; frame() must not build a Color) */
  const moodFloor = new THREE.Color().setRGB(...mood.floor);
  const setGridLayout = (L: LevelLayout | null) => {
    gridLayout = L;
    grid.setLayout(L);
    mood = moodFor(L?.theme);
    moodDesat = mood.desat;
    applyFx();
    fixtureTint.setRGB(...mood.fixtureTint);
    moodFloor.setRGB(...mood.floor);
    if (L) for (let s = 0; s < L.spaces.length; s++) grid.setSpaceParams(s, roomParams(L, s));
    giU.wallH.value = L?.wallH || 3;
    refreshHaloMist();
  };

  // warm-up material variants other tracks will use (compiled behind the loading screen)
  const warmGroup = new THREE.Group();
  {
    const g = new THREE.BoxGeometry(0.2, 0.2, 0.2);
    const a = new THREE.Mesh(g, makeSurfaceMaterial({ color: 0x777777, roughness: 0.8, metalness: 0 }));
    const b = new THREE.Mesh(g, makeEmissive(0xffffff, 2));
    a.castShadow = a.receiveShadow = true;
    a.position.set(0, -0.3, -1);
    b.position.set(0.25, -0.3, -1);
    warmGroup.add(a, b);
    camera.add(warmGroup);
  }

  // ---- boot compile check (lit material + the volume material, this page's preset + backend) -> diag
  const bootCheck = async () => {
    const t0 = performance.now();
    const errors: string[] = [];
    const origErr = console.error;
    console.error = (...a: unknown[]) => { const s = a.map(String).join(' '); if (/shader|wgsl|glsl|program|pipeline/i.test(s)) errors.push(s.slice(0, 300)); origErr.apply(console, a as []); };
    const g = new THREE.Group();
    g.name = 'render-boot-check';
    const lit = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), makeSurfaceMaterial({ color: 0x808080, roughness: 0.7, metalness: 0, pattern: 'paint', macro: 0.5 }));
    lit.castShadow = lit.receiveShadow = true;
    lit.position.set(0, -60, 0);
    g.add(lit);
    let scoped = false; // a pushed error scope must be popped on every path, or later validation errors stay captured
    try {
      if (device?.pushErrorScope) { device.pushErrorScope('validation'); scoped = true; }
      const r = renderer as unknown as { compileAsync?: (o: THREE.Object3D, c: THREE.Camera, s?: THREE.Scene) => Promise<unknown> };
      if (r.compileAsync) {
        scene.add(g);
        g.updateMatrixWorld(true);
        await r.compileAsync(g, camera, scene);
        // the march material through a volume-layer camera
        const vc = new THREE.PerspectiveCamera(camera.fov, camera.aspect, camera.near, camera.far);
        vc.position.copy(camera.position);
        vc.quaternion.copy(camera.quaternion);
        vc.updateMatrixWorld();
        vc.layers.set(VOL_LAYER);
        await r.compileAsync(pipe.volMesh, vc, scene);
      }
      if (scoped) {
        scoped = false;
        const e = await device?.popErrorScope?.();
        if (e) errors.push(`validation: ${e.message ?? e}`);
      }
    } catch (e) {
      errors.push(`compile: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (scoped) void device?.popErrorScope?.()?.catch(() => null);
      console.error = origErr;
      g.removeFromParent();
    }
    ctx.diag.renderCompile = { preset: presetName, backend, ok: errors.length === 0, ms: Math.round(performance.now() - t0), errors: errors.slice(0, 4) };
    if (errors.length) ctx.reportError(`render boot compile (${presetName} ${backend}): ${errors[0]}`);
  };

  let auditT = 0;
  const auditOn = ctx.testMode || ctx.build === 'dev' || ctx.params.get('audit') === '1';
  let volLayout: unknown = null;
  let maxFrameMs = 0;
  let lastNow = 0;
  let lastDrawNow = 0;
  // ---- per-frame scratch: frame() builds no objects, arrays or closures in steady play (gate P)
  const coverIn: CoverInputs = { testScene: false, hidden: false, hold: false, loadingVisible: false, loadingCovering: false, backdrop: false, screen: 'none', drive: false };
  const warmDir = new THREE.Vector3();
  const warmBeams: FlashlightInfo[] = Array.from({ length: MAX_FLASHLIGHTS }, (_, i) => ({ id: `warm${i}`, pos: [0, 0, 0] as V3, dir: [0, 0, -1] as V3, on: true, local: i === 0, tier: 1 as const }));
  /** dark fill beams of the automatic mirror warm (off: they never light anything, they only take idle slots) */
  const mirrorWarmBeams: FlashlightInfo[] = Array.from({ length: MAX_FLASHLIGHTS }, (_, i) => ({ id: `mwarm${i}`, pos: [0, 0, 0] as V3, dir: [0, 0, -1] as V3, on: false, local: false, tier: 1 as const }));
  const warmFill: FlashlightInfo[] = [];
  const flashOpts = { activeShadowed: 0, volumetric: false, reduceFlicker: false, parkShadows: !dbg.has('shadowall'), frame: 0, now: 0, armDark: false, hideIdle: v12.hideParked };
  let fixLayout: LevelLayout | null = null;
  const outdoorSpaceOf = (sp: number) => fixLayout?.spaces[sp]?.open === true;
  const fixOpts: FixtureUpdateOpts = { max: 0, reduceFlicker: false, outdoor: 0, now: 0, outdoorSpace: undefined };
  const gridInfo = { r: 0, g: 0, b: 0, cd: 0, range: 0 };
  let gridLevel: (LevelView & { doorAnim?(id: number): number }) | null = null;
  const doorOpenness = (id: number) => (gridLevel?.doorAnim ? gridLevel.doorAnim(id) : 0);
  const camSample: V3 = [0, 0, 0];
  const frame = (dt: number) => {
    t += dt;
    const nowMs = performance.now();
    if (lastNow) {
      maxFrameMs = Math.max(maxFrameMs, nowMs - lastNow);
      times.push(nowMs - lastNow, nowMs);
    }
    lastNow = nowMs;
    // a real level / players arrived: drop the backdrop (test mode keeps it) or the static menu still
    if (still && levelPresent()) { still.remove(); still = null; }
    if (backdropActive && sceneMode !== 'test' && levelPresent() && test) {
      scene.remove(test.group);
      test.dispose?.();
      backdropActive = false;
      fixtures.setPower('all', true);
    }
    const ld = useLoose<{ active?: boolean; covering?: boolean }>(ctx, 'loading');
    coverIn.testScene = sceneMode === 'test';
    coverIn.hidden = document.hidden || winHidden;
    coverIn.hold = holdDraw;
    coverIn.loadingVisible = !!ld?.active;
    coverIn.loadingCovering = !!ld?.covering;
    coverIn.backdrop = backdropActive;
    coverIn.screen = ctx.ui.screen.value.name;
    // v1.3 (2c): meta's drive screen is opaque: the facility the preload just built must not draw (and compile) at
    // full rate under it; only the paced warm frames draw
    coverIn.drive = ctx.world.phase === 'drive' && coverIn.screen === 'drive';
    mode = coverMode(coverIn);
    if (mode !== 'hidden') {
      const wantMenuRes = mode === 'menu' && menuResOn;
      if (wantMenuRes !== menuRes) {
        menuRes = wantMenuRes;
        applySize();
        autoCtl.busy(nowMs);
      }
    }
    if (nowMs - drawWindowAt >= 1000) {
      drawFps = drawWindowAt > 0 ? (drawsInWindow * 1000) / (nowMs - drawWindowAt) : 0;
      drawsInWindow = 0;
      drawWindowAt = nowMs;
      const shown = `${Math.round(drawFps)} ${mode}`;
      if (shown !== shownDraw) {
        shownDraw = shown;
        renderer.domElement.dataset.drawFps = String(Math.round(drawFps));
        renderer.domElement.dataset.view = mode;
      }
    }
    // volumetric box follows the active level (hub / facility); the grid + medium follow the layout
    const L = currentLayout();
    const Lw = backdropActive ? null : ctx.world.layout;
    if (Lw && Lw !== volLayout) {
      volLayout = Lw;
      const outdoor = Array.isArray(Lw.spaces) && Lw.spaces.some((s) => s.open);
      const top = Math.max((Lw.wallH || 3) + 0.3, outdoor ? 7.5 : 0);
      pipe.setVolumeBounds(new THREE.Box3(new THREE.Vector3(-2, 0, -2), new THREE.Vector3(Lw.W + 2, top, Lw.H + 2)));
    }
    if (L !== gridLayout) setGridLayout(L);
    if (backdropActive && testView) {
      if (sceneMode === 'test') setCam(testView.cam, testView.look);
      else {
        const c = testView.cam;
        setCam([c[0] + Math.sin(t * 0.11) * 0.25, c[1] + Math.sin(t * 0.7) * 0.015, c[2] + Math.cos(t * 0.09) * 0.2], testView.look);
      }
    }
    test?.update(t);
    const spun = spin > 0;
    if (spun) {
      savedQ.copy(camera.quaternion);
      camera.quaternion.premultiply(spinQ.setFromAxisAngle(Y_AXIS, spin * Math.PI / 2));
      spin--;
    }
    camera.updateMatrixWorld();
    // outdoors (lot) vs inside: moon, thinner fog; the furnished van cargo counts as 0.25 outdoor (checker #23)
    let camRoom = -1;
    {
      let out = 0;
      const lay = backdropActive ? null : ctx.world.layout;
      if (lay && Array.isArray(lay.owner)) {
        const cx = Math.floor(camera.position.x), cz = Math.floor(camera.position.z);
        const own = cx >= 0 && cz >= 0 && cx < lay.W && cz < lay.H ? lay.owner[cz * lay.W + cx] : -1;
        const sp = own >= 0 ? lay.spaces[own] : null;
        camRoom = own;
        out = own < 0 ? (lay.kind === 'hub' ? 1 : 0) : sp?.open ? 1 : sp?.type === 'van' ? 0.25 : 0;
      } else if (L) {
        const cx = Math.floor(camera.position.x), cz = Math.floor(camera.position.z);
        camRoom = cx >= 0 && cz >= 0 && cx < L.W && cz < L.H ? L.owner[cz * L.W + cx] : -1;
      }
      outdoorK += (out - outdoorK) * Math.min(1, dt * 3.5);
      hemi.color.copy(skyIn).lerp(skyMoon, outdoorK);
      hemi.intensity = hemiBase + moonCfg.intensity * outdoorK;
      // v1.1 fog uniforms (kept for ?r12=fog:0)
      fogDensity.value = cfg.fog.density + ((cfg.fog.outdoorDensity ?? cfg.fog.density) - cfg.fog.density) * outdoorK;
      fogCol.copy(fogIn).lerp(fogOut, outdoorK);
      // v1.2 medium: indoor <-> outdoor, the theme mood, the main camera's room + grid sample
      const f12 = cfg.fog12;
      fogU.a.value.set((f12.haze + (f12.outdoorHaze - f12.haze) * outdoorK) * mood.haze, f12.hazeHeight, f12.mist * mood.mist * (1 + (f12.outdoorMist - 1) * outdoorK), f12.mistTop);
      fogU.c.value.w = f12.litK * mood.litK;
      fogU.wind.value.w = outdoorK;
      fogU.color.value.copy(fogBase).lerp(fogBaseOut, outdoorK).multiply(moodFloor);
      fogU.moon.value.copy(moonFog).multiplyScalar(outdoorK);
      const g = grid.sample(camera.position.x, camera.position.z, camSample);
      fogU.camGrid.value.setRGB(g[0], g[1], g[2]);
      // unknown room (-1): the grid's shared default params
      const rp = grid.spaceParams(camRoom);
      fogU.camRoom.value.set(rp.mist, rp.haze, rp.frost, rp.steam);
      giU.k.value = cfg.v12.giK * mood.gi;
      // open air: thinner dust than a sealed corridor
      pipe.volDensity.value = cfg.volume.density * (1 - 0.6 * outdoorK);
      pipe.mistScatter.value = cfg.mist12.scatter * (1 - 0.35 * outdoorK);
    }
    // v1.2 site warm (render.warmSite): this frame's batch of level meshes is drawn once (forced visible, unculled)
    const siteFrame = siteWarm.begin();
    let list = flashlightList();
    // v1.3 SIGNAL: the bodycam OSD (full resolution, DOM): on the job only (phase 'contract', the game view, no screen
    // over it). Hidden in the van, where the HUD's CREW panel takes the same top-left corner, the menus and the drive
    const osdOn = osdVisible(signalActive(), mode, ctx.world.phase, coverIn.screen, backdropActive || still !== null);
    if (osdOn && !osd) osd = createOsd(container);
    if (osd) {
      osd.show(osdOn);
      if (osdOn) {
        let batt: number | null = null;
        for (let i = 0; i < list.length; i++) if (list[i].local) { batt = list[i].battery ?? 1; break; }
        const Lc = currentLayout();
        osdData.batt = batt;
        osdData.rtt = ctx.net.status === 'joined' ? ctx.net.rtt : null;
        osdData.loc = Lc && camRoom >= 0 ? (Lc.spaces[camRoom] as { callsign?: string } | undefined)?.callsign ?? null : null;
        osdData.k = signalK;
        osd.update(osdData, nowMs);
      }
    }
    if (warmFrames > 0 || siteFrame) {
      // warm-up: every slot sees real geometry so shadow/volume pipelines get created now, not mid-game
      camera.getWorldDirection(warmDir);
      const p = camera.position;
      for (const w of warmBeams) {
        w.pos[0] = p.x; w.pos[1] = p.y - 0.1; w.pos[2] = p.z;
        w.dir[0] = warmDir.x; w.dir[1] = warmDir.y; w.dir[2] = warmDir.z;
      }
      list = warmBeams;
    } else if (mirrorWarmFrames > 0) {
      // the automatic mirror warm keeps the real beams; idle slots get a dark warm beam at the camera (ranked after
      // every lit beam) so the proxies' shadow-pass programs compile as well (gate P: first-sight ShadowMaterial
      // programs of the mirror room's casters)
      camera.getWorldDirection(warmDir);
      const p = camera.position;
      warmFill.length = 0;
      for (let i = 0; i < list.length; i++) warmFill.push(list[i]);
      for (let i = 0; i < poolShadowed; i++) {
        const w = mirrorWarmBeams[i];
        w.pos[0] = p.x; w.pos[1] = p.y - 0.1; w.pos[2] = p.z;
        w.dir[0] = warmDir.x; w.dir[1] = warmDir.y; w.dir[2] = warmDir.z;
        warmFill.push(w);
      }
      list = warmFill;
    }
    flashOpts.activeShadowed = Math.min(preset.shadowed, poolShadowed);
    flashOpts.volumetric = preset.volumetric;
    flashOpts.reduceFlicker = reduceFlicker;
    flashOpts.frame = drawnFrames;
    flashOpts.now = nowMs;
    // v1.3 (4a): a dark beam's shadow map sleeps; warm-up frames still render every assigned slot (the mirror warm's
    // dark fill beams exist so the proxies' shadow-pass programs compile)
    flashOpts.armDark = warmFrames > 0 || siteFrame || mirrorWarmFrames > 0;
    flash.update(list, camera, t, dt, flashOpts);
    if (warmFrames > 0 || siteFrame) for (const s of flash.slots) s.light.intensity = Math.max(s.light.intensity * 1e-4, 1e-4);
    const fsrc = fixtureSource();
    fixLayout = L;
    fixOpts.max = Math.min(preset.fixtures, poolFixtures);
    fixOpts.reduceFlicker = reduceFlicker;
    fixOpts.outdoor = outdoorK;
    fixOpts.now = nowMs;
    fixOpts.outdoorSpace = L ? outdoorSpaceOf : undefined;
    fixtures.update(fsrc, camera, t, fixOpts);
    {
      // Core glow light: find the canister (re-scan twice a second while missing or detached)
      if ((!coreObj || !coreObj.parent) && (coreSeek -= dt) <= 0) { coreSeek = 0.5; coreObj = backdropActive ? null : scene.getObjectByName('canister') ?? null; }
      let k = 0;
      if (coreObj && coreObj.parent) {
        let vis = true;
        for (let o: THREE.Object3D | null = coreObj; o; o = o.parent) if (!o.visible) { vis = false; break; }
        const glow = coreObj.getObjectByName('glow') as THREE.Mesh | undefined;
        const ei = (glow?.material as { emissiveIntensity?: number } | undefined)?.emissiveIntensity;
        k = vis ? (typeof ei === 'number' ? Math.min(1.6, ei / 3.2) : 1) : 0;
        (glow ?? coreObj).getWorldPosition(coreTmp);
        coreLight.position.copy(coreTmp);
      }
      coreLight.intensity = (cfg.core?.intensity ?? 2.2) * k;
      // chest height: far enough from the 3 m ceiling that it never paints a hot patch overhead
      adapt.position.set(camera.position.x, camera.position.y - 0.2, camera.position.z);
      adapt.intensity = backdropActive ? 0 : adaptCfg.intensity * (1 - 0.5 * outdoorK);
      if (k === 0) coreLight.position.set(0, -420, 0);
    }
    warmGroup.visible = warmFrames > 0;
    // mirrors: candidates, live set, mirror self, bounce light; then the automatic mirror warm (after the update:
    // detached glass is disposed first, so one rebuild arms ONE warm)
    mirrorSys.update(nowMs, dt);
    mirrorAutoWarm(nowMs);
    // night vision: eased grade uniforms (G3's nvg)
    nvState.k += ((nvState.on ? 1 : 0) - nvState.k) * Math.min(1, dt * 9);
    if (Math.abs(nvState.k - (nvState.on ? 1 : 0)) < 0.002) nvState.k = nvState.on ? 1 : 0;
    pipe.nv.k.value = nvState.k;
    pipe.nv.gain.value = nvState.gain;
    puffs.update(nowMs);

    // one world-matrix update per frame (scene.matrixWorldAutoUpdate is off: every pass used to redo it)
    scene.updateMatrixWorld();
    if (warmFrames > 0 || warmAll > 0 || mirrorWarmFrames > 0 || siteFrame) gate.last = nowMs;
    // (the static menu still covers an empty scene: nothing to draw until a level exists)
    else if (!gateDraw(gate, nowMs, still ? Infinity : drawInterval(mode, gateCfg, mode !== 'menu' || document.hasFocus()))) {
      // skipped frame: no GPU work at all (the rAF loop and every other system keep running)
      if (spun) { camera.quaternion.copy(savedQ); camera.updateMatrixWorld(); }
      return;
    }
    // light grid: re-splat only the spaces whose fixture levels changed (+ door spill), every drawn frame. The lights
    // go into the grid's persistent table in place (gate P: no per-frame objects; ~0 B of garbage per frame)
    if (gridLayout && fsrc) {
      const lv = fixtures.levels();
      const fl = fixtures.list();
      const T = grid.lightTable(fl.length);
      for (let i = 0; i < fl.length; i++) {
        const lvl = lv[i];
        if (!(lvl > 0.001) || !fixtures.infoInto(i, gridInfo)) { T.space[i] = -1; T.level[i] = 0; continue; }
        const p = fl[i].pos;
        T.space[i] = fl[i].space; T.x[i] = p[0]; T.y[i] = p[1]; T.z[i] = p[2];
        T.r[i] = gridInfo.r * fixtureTint.r; T.g[i] = gridInfo.g * fixtureTint.g; T.b[i] = gridInfo.b * fixtureTint.b;
        T.cd[i] = gridInfo.cd; T.range[i] = gridInfo.range; T.level[i] = lvl;
      }
      gridLevel = levelSvc() ?? null;
      grid.updateTable(doorOpenness);
    }
    drawsInWindow++;
    drawnFrames++;
    mistFrame.value = drawnFrames;
    if (lastDrawNow > 0) drawTimes.push(nowMs - lastDrawNow, nowMs);
    lastDrawNow = nowMs;
    renderer.info.reset();
    // v1.2: shadow maps render once per drawn frame (needsUpdate), never once per camera
    shadowsArmed = flash.armShadows();
    // the warm set's forced reflection also draws the mirror rooms' real prop batches (never proxied)
    const forceIms = warmSet !== null && warmSetIms.length > 0;
    if (forceIms) for (const o of warmSetIms) { warmImSaved.push({ o, visible: o.visible, frustumCulled: o.frustumCulled }); o.visible = true; o.frustumCulled = false; }
    const tRender = performance.now();
    // the live mirror's reflection: one top-level render before the pipeline (it renders the armed shadow maps
    // first; the pipeline's passes then reuse them)
    mirrorSys.renderLive();
    pipe.render();
    const renderMs = performance.now() - tRender;
    // restores in reverse order of the forcing (the warm set's batches first, then the site warm's batch)
    if (forceIms) {
      for (let i = warmImSaved.length - 1; i >= 0; i--) { const w = warmImSaved[i]; w.o.visible = w.visible; w.o.frustumCulled = w.frustumCulled; }
      warmImSaved.length = 0;
    }
    if (siteFrame) siteWarm.end(renderMs);
    if (spun) { camera.quaternion.copy(savedQ); camera.updateMatrixWorld(); }
    lastDraws = renderer.info.render.drawCalls;
    if (warmFrames > 0 && --warmFrames === 0) {
      // the warm set's last frame is in flight: release it on the next frame (unless a mirror warm still uses it)
      const w = warmWaiters;
      warmWaiters = [];
      requestAnimationFrame(() => { if (mirrorWarmFrames === 0 && warmFrames === 0) endWarmSet(); for (const fn of w) fn(); });
    }
    if (mirrorWarmFrames > 0 && --mirrorWarmFrames === 0) requestAnimationFrame(() => { if (mirrorWarmFrames === 0 && warmFrames === 0) endWarmSet(); });
    if (warmAll > 0 && --warmAll === 0) {
      proxies?.removeFromParent();
      proxies = null;
      const w = warmAllWaiters;
      warmAllWaiters = [];
      requestAnimationFrame(() => { if (!warmSet) mirrorSys.warm(null); for (const fn of w) fn(); });
    }
    autoCtl.tick(nowMs);
    panel.tick(nowMs);
    ctx.diag.autoQuality = autoQ.last;
    const r = renderer as unknown as { backend: { trackTimestamp?: boolean }; resolveTimestampsAsync?: (type?: string) => Promise<number | undefined> };
    if (!resolving && r.backend.trackTimestamp && r.resolveTimestampsAsync) {
      resolving = true;
      r.resolveTimestampsAsync('render').then((ms) => {
        if (typeof ms === 'number' && ms > 0) gpuMs = gpuMs === undefined ? ms : gpuMs * 0.9 + ms * 0.1;
      }, () => {}).finally(() => { resolving = false; });
    }
    // v1.3 (4d): the sampler-budget audit walks the whole scene (~2 ms per call on a laptop): test pages and the
    // dev server only
    if (auditOn) {
      auditT += dt;
      if (auditT > 5) {
        auditT = 0;
        auditSceneMaterials(scene);
      }
    }
  };

  // warm-up: 3 real frames of the full pipeline with every light and material variant present
  warmFrames = 3;
  for (let i = 0; i < 3; i++) frame(1 / 60);
  await new Promise((r) => setTimeout(r, 0));
  // the boot compile check is a diagnostic (gate R reads diag.renderCompile): test pages and ?compilecheck=1 only
  if (ctx.testMode || sceneMode === 'test' || ctx.params.get('compilecheck') === '1') void bootCheck();
  done();

  ctx.registerSystem({ name: 'render', order: SYS.render, update: (dt) => frame(dt) });

  if (ctx.testMode || sceneMode === 'test') {
    window.__render = {
      views: () => (test ? Object.keys(test.views) : []),
      async view(name) {
        const v = test?.views[name];
        if (!v) return { ok: false };
        testView = v;
        applyPower(v);
        test?.onView?.(name, service);
        return { ok: true, view: v };
      },
      info: () => ({
        backend, preset: presetName, presetSource, detectedPreset: auto, gpu, poolShadowed, poolUnshadowed, poolFixtures, poolOmni, capSpots, capPoints,
        usedShadowed: flash.usedShadowed(), fixturesLit: fixtures.litCount(), exposure: renderer.toneMappingExposure,
        size: [renderer.domElement.width, renderer.domElement.height], backdrop: backdropActive, frames: ctx.loop.perf.frames,
        scale: autoQ.scale, pixelRatio: internal.pr, auto: autoQ.last, autoEnabled: autoQ.enabled, presetFree: autoQ.presetFree,
        mode, drawFps: +drawFps.toFixed(1), menuRes, maxFps: gateCfg.maxFps,
        parkedShadows: flash.slots.filter((s) => s.shadowed && !s.id).length, shadowRenders: shadowsArmed,
        mirrorsLive: mirrorSys.liveCount(), mirrors: mirrorSys.info(), v12, features: featureLevel, mist: pipe.mistActive(),
        nv: nvState.k, grid: grid.stats(), compile: ctx.diag.renderCompile ?? null, warmSet: ctx.diag.warmSet ?? null,
        mirrorWarm: { state: mirrorWarm.state, runs: mirrorWarm.runs, frames: mirrorWarmFrames, last: ctx.diag.mirrorWarm ?? null },
        beamRanges: flash.ranges(),
        pipe: pipe.state(), pipeBuilds, signal: signalActive(), signalK, osd: osd?.shown ?? false,
        pipelines: (() => { const pp = (renderer as unknown as { _pipelines?: { caches?: Map<unknown, unknown> } })._pipelines; return pp?.caches?.size ?? null; })(),
      }),
      hitch() { const m = maxFrameMs; maxFrameMs = 0; return m; },
      stats: () => service.stats(),
      setPreset: (n) => service.setPreset(n),
      setExposure: (v) => service.setExposure(v),
      setFx: (p) => service.setFx(p),
      setPower: (s, on) => service.setPower(s, on),
      flickerSpace: (s, ms) => service.flickerSpace(s, ms),
      camera(pos, l) {
        if (testView) testView = { ...testView, cam: pos, look: l };
      },
      three: () => ({ scene, renderer, camera, THREE }),
      pipelines() {
        const pp = (renderer as unknown as { _pipelines?: { caches?: Map<unknown, unknown>; programs?: { vertex: Map<unknown, unknown>; fragment: Map<unknown, unknown> } } })._pipelines;
        return { pipelines: pp?.caches?.size ?? -1, vs: pp?.programs?.vertex.size ?? -1, fs: pp?.programs?.fragment.size ?? -1 };
      },
      nightVision: (on) => service.setNightVision(on),
      v12: () => service,
      mirrorDebug: (p) => mirrorSys.debug(p),
      // v1.3 (4b): one switch for every idle batched light (fixtures, flashlight slots, mirror bounce / rim)
      hideParked: (on) => { v12.hideParked = on; flashOpts.hideIdle = on; fixtures.setHideParked(on); },
      flashRanges: (local, remote) => { flash.setRanges(local, remote); return flash.ranges(); },
      siteWarm: () => ({ ...siteWarm.info(), last: ctx.diag.siteWarm ?? null }),
      volBounds(min, max) {
        if (min && max) pipe.setVolumeBounds(new THREE.Box3(new THREE.Vector3(min[0], min[1], min[2]), new THREE.Vector3(max[0], max[1], max[2])));
        else if (test) pipe.setVolumeBounds(test.bounds);
      },
    };
  }
}
