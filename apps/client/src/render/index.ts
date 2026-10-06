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
  const dpr = () => Math.min(window.devicePixelRatio || 1, 2) * preset.res;
  renderer.setPixelRatio(dpr());
  renderer.setSize(window.innerWidth, window.innerHeight);
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
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

  const service: RenderService = {
    backend,
    get preset() { return presetName; },
    presets: PRESET_NAMES,
    setPreset(name) {
      const p = table[name];
      if (!p) return;
      presetName = name;
      preset = p;
      lsSet('deadair.render.preset', name);
      ctx.diag.renderPreset = name;
      renderer.setPixelRatio(dpr());
      renderer.setSize(window.innerWidth, window.innerHeight);
      pipe.build(p, dbg);
      warmFrames = 2;
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
      warmFrames = Math.max(warmFrames, 2);
      return new Promise((res) => {
        const check = () => (warmFrames <= 0 ? res() : requestAnimationFrame(check));
        requestAnimationFrame(check);
      });
    },
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
    renderer.setPixelRatio(dpr());
    renderer.setSize(window.innerWidth, window.innerHeight);
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
      const d = new THREE.Vector3(...base.dir).applyAxisAngle(new THREE.Vector3(0, 1, 0), sway);
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
  const frame = (dt: number) => {
    t += dt;
    const nowMs = performance.now();
    if (lastNow) maxFrameMs = Math.max(maxFrameMs, nowMs - lastNow);
    lastNow = nowMs;
    // a real level / players arrived: drop the backdrop (test mode keeps it)
    if (backdropActive && sceneMode !== 'test' && levelPresent() && test) {
      scene.remove(test.group);
      backdropActive = false;
      fixtures.setPower('all', true);
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
    flash.update(list, camera, t, dt, { activeShadowed: Math.min(preset.shadowed, poolShadowed), volumetric: preset.volumetric, reduceFlicker });
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

    renderer.info.reset();
    pipe.render();
    lastDraws = renderer.info.render.drawCalls;
    if (warmFrames > 0) warmFrames--;
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
