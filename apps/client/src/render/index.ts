// Owner: track ③ Render (apps/client/src/render/**). WebGPURenderer (WebGL2 with ?webgl=1), RenderPipeline post
// stack, flashlight + fixture light pools, presets, warm-up, stats. Provides services.three + services.render.
// Consumes services.players (flashlights) and services.level (fixtures, visibleSpaces), tolerating absence.
import * as THREE from 'three/webgpu';
import { color as tslColor, exponentialHeightFogFactor, fog, uniform } from 'three/tsl';
import { DynamicLighting } from 'three/addons/lighting/DynamicLighting.js';
import { h } from 'preact';
import type { ClientContext } from '../core/context.ts';
import { SYS } from '../core/loop.ts';
import { createFlashlightPool } from './flashlights.ts';
import type { FlashCfg } from './flashlights.ts';
import { createFixturePool } from './fixtures.ts';
import type { FixtureCfg } from './fixtures.ts';
import { createPipeline } from './pipeline.ts';
import type { PipeCfg } from './pipeline.ts';
import { PRESET_NAMES, gpuName, presetForGpu, presetTable } from './presets.ts';
import { auditSceneMaterials, makeEmissive, makeSurfaceMaterial } from './materials.ts';
import { buildTestScene, loadFixtureLayout } from './testscene.ts';
import { FrameTimes, coverMode, createAutoQuality, createPerfPanel, drawInterval, gateDraw, pixelRatioFor, readPerfCfg } from './perf.ts';
import type { AutoState, CoverMode, DrawGate, FrameStats } from './perf.ts';
import type { TestScene, TestView } from './testscene.ts';
import { useLoose } from './types.ts';
import type { FixtureInfo, FlashlightInfo, LevelView, PlayersView, RenderFx, RenderService, RenderStats, V3 } from './types.ts';

export type { RenderService, FlashlightInfo, FixtureInfo } from './types.ts';

const VOL_LAYER = 10;
const MAX_FLASHLIGHTS = 6;

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
}

declare global {
  interface Window {
    __render?: RenderTestApi;
  }
}

type Cfg = {
  exposure: number;
  ambient: { sky: string; ground: string; intensity: number };
  /** indoor fog + the outdoor (lot) variant the camera blends to when it stands in an open space */
  fog: { color: string; density: number; height: number; outdoorColor?: string; outdoorDensity?: number };
  /** cold moonlight, outdoors only: extra hemisphere sky intensity + colour while the camera stands in the lot */
  moon?: { color: string; intensity: number; dir?: number[] };
  /** cyan point light riding the Core canister (candela at full glow) */
  core?: { intensity: number; distance?: number };
  /** dark-adaptation fill light that follows the camera (candela, range m, decay) */
  adapt?: { color: string; intensity: number; distance: number; decay: number };
  flashlight: FlashCfg;
  fixture: FixtureCfg;
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

export async function install(ctx: ClientContext): Promise<void> {
  const done = ctx.readiness.require('render');
  const cfg = readCfg(ctx);
  const container = document.getElementById('game')!;
  const forceWebGL = ctx.params.get('webgl') === '1';
  const sceneMode = ctx.params.get('scene'); // 'test' = render test scene, camera owned by __render

  const gpu = await gpuName();
  const renderer = new THREE.WebGPURenderer({ antialias: false, forceWebGL, trackTimestamp: !forceWebGL });
  await renderer.init();
  const backend = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2';
  const device = (renderer.backend as unknown as { device?: EventTarget }).device;
  device?.addEventListener('uncapturederror', (e) => {
    ctx.reportError(`WebGPU: ${(e as unknown as { error?: { message?: string } }).error?.message ?? 'uncaptured error'}`);
  });

  const table = presetTable(ctx);
  const urlPreset = ctx.params.get('preset');
  const stored = lsGet('deadair.render.preset');
  const auto = presetForGpu(gpu, backend);
  let presetName = urlPreset && table[urlPreset] ? urlPreset : stored && table[stored] ? stored : auto;
  let preset = table[presetName];
  // pool sizes are fixed for the page's lifetime (changing them recompiles every lit material)
  const poolShadowed = preset.shadowed;
  const poolUnshadowed = Math.max(0, MAX_FLASHLIGHTS - poolShadowed);
  const poolFixtures = Math.max(...PRESET_NAMES.map((n) => table[n].fixtures).filter((f) => f <= Math.max(preset.fixtures, 8)));

  const dbg0 = new Set((ctx.params.get('rdebug') ?? '').split(',').filter(Boolean));
  if (!dbg0.has('nodyn')) renderer.lighting = new DynamicLighting({ maxPointLights: poolFixtures + 2, maxSpotLights: 8, maxHemisphereLights: 2, maxDirectionalLights: 2 });
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
  // 2026-10-07 host crashes: the title menu drew the full Ultra backdrop at the display's 240 Hz (about half a
  // RTX 5090, also behind other apps in the desktop shell). Covered states now draw capped (perf.menuFps /
  // menuBlurFps / coverFps) and the menu backdrop at a reduced internal resolution (perf.menuResCap).
  // ?menufps= / ?menublurfps= / ?coverfps= / ?maxfps= override (0 = every frame), ?menures=0 keeps full resolution.
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
  /** the menu backdrop currently renders under perf.menuResCap */
  let menuRes = false;
  const autoQ: AutoState = {
    enabled: ctx.params.get('autoq') !== '0' && lsGet('deadair.render.autoq') !== '0',
    presetFree: !urlPreset && ctx.params.get('autoq') !== 'scale',
    scale: 1,
    last: 'warming up',
    steps: 0,
  };
  let internal = { pr: 1, w: 0, h: 0, dpr: 1 };
  const applySize = () => {
    internal = pixelRatioFor(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1, preset, perfCfg, autoQ.scale, { ...resOpts, extraCap: menuRes ? perfCfg.menuResCap : null });
    renderer.setPixelRatio(internal.pr);
    renderer.setSize(window.innerWidth, window.innerHeight);
    ctx.diag.renderRes = `${renderer.domElement.width}x${renderer.domElement.height}`;
  };
  applySize();
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // every pass of the RenderPipeline (pre-pass, scene, volumetrics) and every shadow map re-renders the scene, and each
  // render traversed the whole graph to update world matrices (12 % of the main thread at 4K in the v1.1 profile):
  // update once per frame in frame() instead
  scene.matrixWorldAutoUpdate = false;
  const fogIn = new THREE.Color(cfg.fog.color);
  const fogOut = new THREE.Color(cfg.fog.outdoorColor ?? cfg.fog.color);
  const fogCol = fogIn.clone();
  scene.background = fogCol;
  const fogDensity = uniform(cfg.fog.density);
  const fogHeight = uniform(cfg.fog.height);
  const fogColor = uniform(fogCol);
  scene.fogNode = fog(fogColor, exponentialHeightFogFactor(fogDensity, fogHeight));
  const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 120);
  camera.position.set(0, 1.6, 3);
  scene.add(camera);

  // minimum ambient floor: never pure black on uncalibrated monitors
  const hemi = new THREE.HemisphereLight(cfg.ambient.sky, cfg.ambient.ground, cfg.ambient.intensity);
  scene.add(hemi);
  // moonlight for the lot: the hemisphere's sky term blends to a cold moon sky outdoors (a DirectionalLight would add
  // DynamicLighting's directional uniform arrays: 13 > 12 fragment uniform buffers on Medium/Low, both backends)
  const moonCfg = cfg.moon ?? DEFAULTS.moon!;
  const skyIn = new THREE.Color(cfg.ambient.sky);
  const skyMoon = new THREE.Color(moonCfg.color);
  let outdoorK = 0;

  const flash = createFlashlightPool(scene, cfg.flashlight, poolShadowed, poolUnshadowed, preset.shadowMap, VOL_LAYER);
  const fixtures = createFixturePool(scene, cfg.fixture, poolFixtures);
  // the Core lights its surroundings (the vault, then the carriers + corridor walls on the way out): one fixed
  // unshadowed point light that follows the objectives track's 'canister' object and pulses with its glow
  const coreLight = new THREE.PointLight(0x46ecff, 0, cfg.core?.distance ?? 7, 2);
  coreLight.castShadow = false;
  coreLight.name = 'core-glow';
  coreLight.position.set(0, -420, 0);
  scene.add(coreLight);
  let coreObj: THREE.Object3D | null = null;
  let coreSeek = 0;
  const coreTmp = new THREE.Vector3();
  // dark adaptation: a faint cold fill riding just above the camera (short, soft falloff). The first metres around
  // you stay readable in a blackout (silhouettes, door frames, a shape right next to you) while depth falls to black.
  // Visual only: the server's lit-checks never see it.
  const adaptCfg = cfg.adapt ?? DEFAULTS.adapt!;
  const adapt = new THREE.PointLight(adaptCfg.color, 0, adaptCfg.distance, adaptCfg.decay);
  adapt.castShadow = false;
  adapt.name = 'dark-adaptation';
  adapt.position.set(0, -430, 0);
  scene.add(adapt);
  const pipe = createPipeline(renderer, scene, camera, cfg, VOL_LAYER);
  const dbg = new Set((ctx.params.get('rdebug') ?? '').split(',').filter(Boolean));
  pipe.build(preset, dbg);
  if (dbg.has('nofog')) scene.fogNode = null;

  // keepNames proof (DynamicLighting batches by class name): must survive the production build
  ctx.diag.keepNames = fixtures.lights[0]?.constructor.name === 'PointLight';
  if (!ctx.diag.keepNames) ctx.reportError(`keepNames missing: PointLight minified to '${fixtures.lights[0]?.constructor.name}'`);
  ctx.diag.backend = backend;
  ctx.diag.renderPreset = presetName;
  ctx.diag.gpu = gpu;

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
  let t = 0;
  /** what covers the canvas this frame (perf.ts coverMode) + the frame-cap slot */
  let mode: CoverMode = 'game';
  const gate: DrawGate = { last: 0 };
  /** draws per second (the rAF rate stays at the display refresh: skipped frames do no GPU work) */
  let drawsInWindow = 0;
  let drawFps = 0;
  let drawWindowAt = 0;
  // desktop shell (apps/desktop preload): in a crew it never lets Chromium hide the page (voice + net keep running),
  // so a minimized window would keep drawing at full rate; deadAirDesktop.windowState() / onWindowState(cb) report
  // { minimized, visible, focused }: nothing is drawn while minimized / hidden (warm-up frames still are). Without the
  // shell (a browser tab) rAF simply stops in a hidden tab. Unfocused title menu: menuBlurFps via document.hasFocus().
  let winHidden = false;
  try {
    type WinState = { minimized?: boolean; visible?: boolean } | null | undefined;
    const desk = (window as unknown as { deadAirDesktop?: { windowState?: () => WinState; onWindowState?: (cb: (s: WinState) => void) => unknown } }).deadAirDesktop;
    const apply = (s: WinState) => { winHidden = !!s && (s.minimized === true || s.visible === false); };
    apply(desk?.windowState?.());
    desk?.onWindowState?.(apply);
  } catch { /* optional shell API */ }
  /** published on the canvas once a second for the desktop shell's heartbeat (its preload only sees the DOM) */
  let shownDraw = '';

  const applyPower = (v: TestView) => {
    fixtures.setPower('all', true);
    if (!v.power.all) fixtures.setPower('all', false);
    for (const s of v.power.off) fixtures.setPower(s, false);
  };

  const fxState = { ca: cfg.fx.ca, grain: cfg.fx.grain, vignette: cfg.fx.vignette, desat: cfg.fx.desat };
  const applyFx = () => {
    pipe.fx.ca.value = reduceFlicker ? 0 : fxState.ca;
    pipe.fx.grain.value = fxState.grain;
    pipe.fx.vignette.value = fxState.vignette;
    pipe.fx.desat.value = fxState.desat;
  };
  applyFx();

  // ---- v1.1: frame times, auto quality, F3 panel, full warm-up ----
  const times = new FrameTimes();
  /** draw-to-draw intervals (= the rAF intervals unless a frame cap skips frames): what auto quality judges */
  const drawTimes = new FrameTimes();
  /** live preset switch without persisting it (auto quality) */
  const applyPreset = (name: string) => {
    const p = table[name];
    if (!p) return;
    presetName = name;
    preset = p;
    ctx.diag.renderPreset = name;
    applySize();
    pipe.build(p, dbg);
    warmFrames = Math.max(warmFrames, 2);
  };
  /** in game, visible tab, no loading / full-screen menu over the canvas */
  const steady = () => !document.hidden && !backdropActive && warmAll <= 0 && ctx.ui.screen.value.name === 'none' && !document.querySelector('[data-loading-active]');
  const autoCtl = createAutoQuality(perfCfg, drawTimes, {
    preset: () => presetName,
    presets: PRESET_NAMES,
    setPreset: (n) => { applyPreset(n); autoCtl.busy(performance.now()); },
    setScale: () => { applySize(); autoCtl.busy(performance.now()); },
    gpuMs: () => gpuMs,
    steady,
  }, autoQ);
  const perfLines = (): string[] => {
    const now = performance.now();
    const s = times.stats(2000, now);
    const net = ctx.net;
    return [
      `DEAD AIR PERF  [F3]`,
      `fps ${s.fps.toFixed(0).padStart(4)}   frame p50 ${s.p50.toFixed(1)} p95 ${s.p95.toFixed(1)} max ${s.max.toFixed(0)} ms`,
      `gpu ${gpuMs !== undefined ? `${gpuMs.toFixed(2)} ms` : 'n/a'}   cpu ${ctx.loop.perf.frameMs.toFixed(2)} ms   draws ${lastDraws}`,
      `drawn ${drawFps.toFixed(0)}/s   view ${mode}${menuRes ? ' (menu res)' : ''}${gateCfg.maxFps > 0 ? `   cap ${gateCfg.maxFps} fps` : ''}`,
      `preset ${presetName}   ${backend}   internal ${renderer.domElement.width}x${renderer.domElement.height}`,
      `css ${window.innerWidth}x${window.innerHeight}  dpr ${(window.devicePixelRatio || 1).toFixed(2)} -> ${internal.pr.toFixed(3)}  scale ${autoQ.scale.toFixed(2)}`,
      `auto ${autoQ.enabled ? (autoQ.presetFree ? 'on' : 'scale only') : 'off'}: ${autoQ.last}`,
      `link ${net.status === 'joined' ? `${Math.round(net.rtt)} ms` : net.status}`,
    ];
  };
  const panel = createPerfPanel(perfLines);
  // scene changes restart the auto-quality warm-up (their compile hitches are not a resolution problem)
  ctx.bus.on('world:phase', () => autoCtl.busy(performance.now()));
  ctx.bus.on('net:welcome', () => autoCtl.busy(performance.now()));
  void ctx.services.wait('level').then((lv) => lv.onRebuild(() => autoCtl.busy(performance.now())));
  addEventListener('keydown', (e) => {
    if (e.code !== 'F3' || e.repeat) return;
    e.preventDefault();
    panel.toggle();
  });
  /** frames left of the full warm-up: one tiny proxy per unique (material, vertex layout, instancing, shadow flags)
   *  of the whole scene (hidden spaces included) rides in front of the camera, inside every warm flashlight cone, so
   *  each material's main / pre-pass / shadow pipelines compile now. (Forcing every object visible instead created a
   *  render object per object per pass: a 20 s frame for a facility.) */
  let warmAll = 0;
  /** warm-up frames left that render with the camera spun about the world up axis */
  let spin = 0;
  const spinQ = new THREE.Quaternion();
  const savedQ = new THREE.Quaternion();
  /** loading screen covers the canvas: skip drawing (except warm-up frames), at most one draw per second */
  let holdDraw = false;
  let warmAllWaiters: (() => void)[] = [];
  let proxies: THREE.Group | null = null;
  const buildProxies = (): THREE.Group => {
    const g = new THREE.Group();
    g.name = 'render-warm-proxies';
    const seen = new Set<string>();
    const ident = new THREE.Matrix4();
    let i = 0;
    scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || (m as unknown as { isSkinnedMesh?: boolean }).isSkinnedMesh || o === volMeshRef || !o.layers.isEnabled(0)) return;
      if (o.parent === g || o.name === 'render-warm-proxies') return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      if (!mats.length || mats.some((x) => !x)) return;
      const geo = m.geometry;
      const inst = (m as unknown as THREE.InstancedMesh).isInstancedMesh === true;
      const sig = `${Object.keys(geo.attributes).sort().join(',')}${geo.index ? ':i' : ''}:${Object.keys(geo.morphAttributes).length}`;
      const key = `${mats.map((x) => x.uuid).join('+')}|${sig}|${inst ? `I${(m as unknown as THREE.InstancedMesh).instanceColor ? 'c' : ''}` : ''}${m.castShadow ? 'C' : ''}${m.receiveShadow ? 'R' : ''}`;
      if (seen.has(key)) return;
      seen.add(key);
      let p: THREE.Mesh;
      if (inst) {
        const im = new THREE.InstancedMesh(geo, m.material, 1);
        im.setMatrixAt(0, ident);
        if ((m as unknown as THREE.InstancedMesh).instanceColor) im.setColorAt(0, new THREE.Color(1, 1, 1));
        p = im;
      } else p = new THREE.Mesh(geo, m.material);
      p.castShadow = m.castShadow;
      p.receiveShadow = m.receiveShadow;
      p.frustumCulled = false;
      p.renderOrder = m.renderOrder;
      p.position.set(((i % 9) - 4) * 0.03, -0.12 + Math.floor(i / 9) % 6 * 0.03, -1.4);
      p.scale.setScalar(1e-3);
      i++;
      g.add(p);
    });
    return g;
  };
  const volMeshRef = pipe.volMesh;

  const service: RenderService = {
    backend,
    get preset() { return presetName; },
    presets: PRESET_NAMES,
    setPreset(name) {
      if (!table[name]) return;
      lsSet('deadair.render.preset', name);
      applyPreset(name);
      // an explicit choice: auto quality restarts from it (it may still lower the resolution scale)
      autoQ.scale = 1;
      applySize();
      autoCtl.busy(performance.now());
    },
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
      // four frames, the camera turned 90 degrees further each time (restored after each): everything around the
      // spawn compiles behind the loading screen, not on the first look around
      warmFrames = Math.max(warmFrames, 4);
      spin = 4;
      return new Promise((res) => {
        const check = () => (warmFrames <= 0 ? res() : requestAnimationFrame(check));
        requestAnimationFrame(check);
      });
    },
    warmupAll(frames = 3) {
      if (!proxies) {
        proxies = buildProxies();
        camera.add(proxies);
        ctx.diag.warmProxies = proxies.children.length;
      }
      warmAll = Math.max(warmAll, frames);
      warmFrames = Math.max(warmFrames, frames + 1);
      autoCtl.busy(performance.now());
      return new Promise<void>((res) => { warmAllWaiters.push(res); });
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
    volumeLayer: VOL_LAYER,
    setFlashlightSource(fn) { flashOverride = fn; },
    setFixtureSource(src) { fixtureOverride = src; },
  };

  ctx.services.provide('three', { renderer, scene, camera, backend });
  ctx.services.provide('render', service);
  ctx.ui.registerHud('bottom-right', () => h('div', { class: 'hud-chip' }, `RENDER ${backend.toUpperCase()} · ${presetName.toUpperCase()}`), { id: 'render-backend', order: 100 });

  addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    applySize();
    autoCtl.busy(performance.now());
  });

  // ---- test scene / idle backdrop (replaced as soon as a real level or players exist) ----
  // a real level = a layout exists (world.layout from the server, or services.level.layout)
  const levelPresent = () => !!ctx.world.layout || !!useLoose<LevelView>(ctx, 'level')?.layout;
  try {
    const L = await loadFixtureLayout(ctx.params.get('layout') ?? 'facility_s2_p4');
    if (L && (sceneMode === 'test' || !levelPresent())) {
      test = buildTestScene(L);
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
      // idle backdrop: the local beam slowly searches the corridor
      const base = testView.lights[0];
      if (!base) return [];
      const sway = Math.sin(t * 0.37) * 0.22;
      const d = swayDir.set(base.dir[0], base.dir[1], base.dir[2]).applyAxisAngle(UP, sway);
      d.y += Math.sin(t * 0.23) * 0.05;
      return [{ ...base, dir: [d.x, d.y, d.z] }];
    }
    return [];
  }

  function fixtureSource() {
    if (fixtureOverride) return fixtureOverride;
    const level = useLoose<LevelView>(ctx, 'level');
    if (level && !backdropActive) {
      return { fixtures: level.fixtures ?? [], visibleSpaces: level.visibleSpaces ? (c: V3) => level.visibleSpaces(c) : undefined };
    }
    if (backdropActive && test) return { fixtures: test.fixtures };
    return null;
  }

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

  let auditT = 0;
  let volLayout: unknown = null;
  let maxFrameMs = 0;
  let lastNow = 0;
  let lastDrawNow = 0;
  const frame = (dt: number) => {
    t += dt;
    const nowMs = performance.now();
    if (lastNow) {
      maxFrameMs = Math.max(maxFrameMs, nowMs - lastNow);
      times.push(nowMs - lastNow, nowMs);
    }
    lastNow = nowMs;
    // a real level / players arrived: drop the backdrop (test mode keeps it)
    if (backdropActive && sceneMode !== 'test' && levelPresent() && test) {
      scene.remove(test.group);
      backdropActive = false;
      fixtures.setPower('all', true);
    }
    // what covers the canvas: the title menu draws its backdrop capped and at a reduced internal resolution, the
    // opaque loading screen capped at full resolution (or once a second while it holds); warm-up frames always draw
    const ld = useLoose<{ active?: boolean; covering?: boolean }>(ctx, 'loading');
    mode = coverMode({
      testScene: sceneMode === 'test',
      hidden: document.hidden || winHidden,
      hold: holdDraw,
      loadingVisible: !!ld?.active,
      loadingCovering: !!ld?.covering,
      backdrop: backdropActive,
      screen: ctx.ui.screen.value.name,
    });
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
    // volumetric box follows the active level (hub / facility)
    const L = backdropActive ? null : ctx.world.layout;
    if (L && L !== volLayout) {
      volLayout = L;
      // rays stop at the scene depth (ceilings indoors), so the box can rise high enough for beams swung up outdoors
      const outdoor = Array.isArray(L.spaces) && L.spaces.some((s) => s.open);
      const top = Math.max((L.wallH || 3) + 0.3, outdoor ? 7.5 : 0);
      pipe.setVolumeBounds(new THREE.Box3(new THREE.Vector3(-2, 0, -2), new THREE.Vector3(L.W + 2, top, L.H + 2)));
    }
    if (backdropActive && testView) {
      if (sceneMode === 'test') setCam(testView.cam, testView.look);
      else {
        // idle drift
        const c = testView.cam;
        setCam([c[0] + Math.sin(t * 0.11) * 0.25, c[1] + Math.sin(t * 0.7) * 0.015, c[2] + Math.cos(t * 0.09) * 0.2], testView.look);
      }
    }
    test?.update(t);
    const spun = spin > 0;
    if (spun) {
      savedQ.copy(camera.quaternion);
      camera.quaternion.premultiply(spinQ.setFromAxisAngle(new THREE.Vector3(0, 1, 0), spin * Math.PI / 2));
      spin--;
    }
    camera.updateMatrixWorld();
    // outdoors (lot / van) vs inside the building: moon on/off, thinner bluish fog outside (smooth ~0.6 s blend)
    {
      let out = 0;
      const lay = backdropActive ? null : ctx.world.layout;
      if (lay && Array.isArray(lay.owner)) {
        const cx = Math.floor(camera.position.x), cz = Math.floor(camera.position.z);
        const own = cx >= 0 && cz >= 0 && cx < lay.W && cz < lay.H ? lay.owner[cz * lay.W + cx] : -1;
        const sp = own >= 0 ? lay.spaces[own] : null;
        out = own < 0 ? (lay.kind === 'hub' ? 1 : 0) : sp && (sp.open || sp.type === 'van') ? 1 : 0;
      }
      outdoorK += (out - outdoorK) * Math.min(1, dt * 3.5);
      hemi.color.copy(skyIn).lerp(skyMoon, outdoorK);
      hemi.intensity = cfg.ambient.intensity + moonCfg.intensity * outdoorK;
      fogDensity.value = cfg.fog.density + ((cfg.fog.outdoorDensity ?? cfg.fog.density) - cfg.fog.density) * outdoorK;
      fogCol.copy(fogIn).lerp(fogOut, outdoorK);
      // open air: thinner dust than a sealed corridor (the own beam would otherwise glow like a fog bank)
      pipe.volDensity.value = cfg.volume.density * (1 - 0.6 * outdoorK);
    }
    let list = flashlightList();
    if (warmFrames > 0) {
      // warm-up: every slot sees real geometry so shadow/volume pipelines get created now, not mid-game
      const f = new THREE.Vector3();
      camera.getWorldDirection(f);
      const p = camera.position;
      list = Array.from({ length: MAX_FLASHLIGHTS }, (_, i) => ({ id: `warm${i}`, pos: [p.x, p.y - 0.1, p.z] as V3, dir: [f.x, f.y, f.z] as V3, on: true, local: i === 0, tier: 1 as const }));
    }
    flash.update(list, camera, t, dt, { activeShadowed: Math.min(preset.shadowed, poolShadowed), volumetric: preset.volumetric, reduceFlicker, parkShadows: !dbg.has('shadowall') });
    if (warmFrames > 0) for (const s of flash.slots) s.light.intensity = Math.max(s.light.intensity * 1e-4, 1e-4);
    fixtures.update(fixtureSource(), camera, t, { max: Math.min(preset.fixtures, poolFixtures), reduceFlicker, outdoor: outdoorK });
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

    // one world-matrix update per frame (scene.matrixWorldAutoUpdate is off: every pass used to redo it)
    scene.updateMatrixWorld();
    if (warmFrames > 0 || warmAll > 0) gate.last = nowMs;
    else if (!gateDraw(gate, nowMs, drawInterval(mode, gateCfg, mode !== 'menu' || document.hasFocus()))) {
      // skipped frame: no GPU work at all (the rAF loop and every other system keep running)
      if (spun) { camera.quaternion.copy(savedQ); camera.updateMatrixWorld(); }
      return;
    }
    drawsInWindow++;
    if (lastDrawNow > 0) drawTimes.push(nowMs - lastDrawNow, nowMs);
    lastDrawNow = nowMs;
    renderer.info.reset();
    pipe.render();
    if (spun) { camera.quaternion.copy(savedQ); camera.updateMatrixWorld(); }
    lastDraws = renderer.info.render.drawCalls;
    if (warmFrames > 0) warmFrames--;
    if (warmAll > 0 && --warmAll === 0) {
      proxies?.removeFromParent();
      proxies = null;
      const w = warmAllWaiters;
      warmAllWaiters = [];
      // resolve on the next frame: the forced frames' pipelines are in flight now
      requestAnimationFrame(() => { for (const fn of w) fn(); });
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
    auditT += dt;
    if (auditT > 5) {
      auditT = 0;
      auditSceneMaterials(scene);
    }
  };

  // warm-up: 3 real frames of the full pipeline with every light and material variant present
  warmFrames = 3;
  for (let i = 0; i < 3; i++) frame(1 / 60);
  await new Promise((r) => setTimeout(r, 0));
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
        return { ok: true, view: v };
      },
      info: () => ({
        backend, preset: presetName, gpu, poolShadowed, poolUnshadowed, poolFixtures,
        usedShadowed: flash.usedShadowed(), fixturesLit: fixtures.litCount(), exposure: renderer.toneMappingExposure,
        size: [renderer.domElement.width, renderer.domElement.height], backdrop: backdropActive, frames: ctx.loop.perf.frames,
        scale: autoQ.scale, pixelRatio: internal.pr, auto: autoQ.last, autoEnabled: autoQ.enabled, presetFree: autoQ.presetFree,
        mode, drawFps: +drawFps.toFixed(1), menuRes, maxFps: gateCfg.maxFps,
        parkedShadows: flash.slots.filter((s) => s.shadowed && !s.light.shadow.autoUpdate).length,
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
    };
  }
}
