// Owner: track ③ Render / env-render (v1.2). RenderPipeline: (pre-pass MRT normal+velocity) -> GTAO -> scene pass
// (contextNode: AO x GI from the light grid) -> + beam march (mist.ts: MistMaterial on the volume layer, low-res pass,
// 4-channel depth-aware blur + depth-aware upsample) -> luminance clamp -> bloom -> TRAA -> tone map (AgX) -> horror
// grade (+ night vision) -> chromatic aberration -> vignette -> film grain.
// The v1.1 march (ClampedVolumeModel + gaussian blur) stays available behind ?rdebug=legacyvol (and when the v1.2
// mist is switched off in render.json v12.mist).
import * as THREE from 'three/webgpu';
import {
  Fn, builtinAOContext, context, float, mix, mrt, normalView, packNormalToRGB, pass, renderOutput, sample, screenCoordinate,
  screenUV, smoothstep, time, uniform, unpackRGBToNormal, vec3, vec4, velocity, mx_fractal_noise_float, luminance,
  output, vec2, rand, fract, uv, cameraPosition, cameraViewMatrix, cameraNear, cameraFar, perspectiveDepthToViewZ, positionWorld,
  property, Loop, min, max, length, renderGroup,
} from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js';
import { chromaticAberration } from 'three/addons/tsl/display/ChromaticAberrationNode.js';
import { vignette } from 'three/addons/tsl/display/CRT.js';
import { bayer16 } from 'three/addons/tsl/math/Bayer.js';
import type { Preset } from './presets.ts';
import { DepthAwareBlurNode, MistMaterial, mistUpsample } from './mist.ts';
import type { MistCfg } from './mist.ts';
import type { FogNodes } from './fog.ts';

export interface PipeCfg {
  volume: { density: number; noiseScale: number; drift: number; strength: number; blur: number; maxDist?: number; haze?: number; nearFade?: number };
  bloom: { strength: number; radius: number; threshold: number };
  fx: { ca: number; grain: number; vignette: number; desat: number };
  grade: { shadowTint: number[]; midTint: number[]; contrast: number; lift: number; liftTint?: number[] };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

// ---- v1.1 depth-clamped volumetric ray march (legacy path: ?rdebug=legacyvol) ----
const volScatter = property('vec3');
const volOut = property('vec3');

class ClampedVolumeModel extends (THREE.LightingModel as unknown as new () => N) {
  start(builder: N): void {
    const material = builder.material as N;
    const toBack = positionWorld.sub(cameraPosition).toVar();
    const boxLen = toBack.length().toVar();
    const dir = toBack.div(boxLen.max(1e-4)).toVar();
    let len: N = boxLen.min(material.maxDistNode ?? float(16));
    if (material.depthNode) {
      const viewZ = perspectiveDepthToViewZ(material.depthNode, cameraNear, cameraFar);
      const dirViewZ = cameraViewMatrix.mul(vec4(dir, 0)).z.min(-1e-3);
      len = len.min(viewZ.div(dirViewZ));
    }
    len = len.max(0.05).toVar();
    const steps = uniform('int').onRenderUpdate(({ material: m }: N) => m.steps);
    const stepSize = len.div(float(steps)).toVar();
    const dist = float(0).toVar();
    if (material.offsetNode) dist.addAssign(material.offsetNode.mul(stepSize));
    const transmittance = vec3(1).toVar();
    Loop(steps, () => {
      const positionRay = cameraPosition.add(dir.mul(dist));
      const positionViewRay = cameraViewMatrix.mul(vec4(positionRay, 1)).xyz;
      builder.context.positionWorld = positionRay;
      builder.context.shadowPositionWorld = positionRay;
      builder.context.positionView = positionViewRay;
      volScatter.assign(0);
      const sc = material.scatteringNode ? material.scatteringNode({ positionRay }) : null;
      super.start(builder);
      if (sc) volScatter.mulAssign(sc);
      const stepLight = volScatter.mul(0.01).toVar();
      const falloff = volScatter.mul(-0.01).mul(stepSize).exp();
      volOut.addAssign(stepLight.mul(transmittance).mul(stepSize));
      transmittance.mulAssign(falloff);
      dist.addAssign(stepSize);
    });
  }

  direct({ lightNode, lightColor }: N): void {
    if (lightNode.isAnalyticLightNode !== true || lightNode.light.distance === undefined) return;
    const dl = lightColor.xyz.toVar();
    if (lightNode.shadowNode !== null) dl.mulAssign(lightNode.shadowNode);
    const w = lightNode.light.userData?.volWeight;
    if (w) dl.mulAssign(w);
    volScatter.addAssign(dl);
  }

  finish(builder: N): void {
    builder.context.outgoingLight.assign(volOut);
  }
}

class ClampedVolumeMaterial extends THREE.VolumeNodeMaterial {
  maxDistNode = uniform(16);
  setupLightingModel(): N {
    return new ClampedVolumeModel();
  }
}

export interface PipelineOpts {
  /** the shared fog medium (fog.ts): the v1.2 march uses its density; null = legacy march only */
  fogNodes?: FogNodes | null;
  mist?: MistCfg;
  /** light-grid GI irradiance node for the scene pass (null = no GI) */
  giNode?: N | null;
  /** clamp HDR luminance before bloom (0 = off) */
  lumClamp?: number;
}

export interface Pipeline {
  pipeline: THREE.RenderPipeline;
  volMesh: THREE.Mesh;
  fx: { ca: { value: number }; grain: { value: number }; vignette: { value: number }; desat: { value: number }; volStrength: { value: number } };
  /** night vision: k 0..1 (0 = off: output identical to no NV), gain */
  nv: { k: { value: number }; gain: { value: number } };
  /** live scattering density (legacy march) */
  volDensity: { value: number };
  /** v1.2 march: scattering scale (render scales it down outdoors) */
  mistScatter: { value: number };
  /** march steps of the active preset after auto-quality drops (setMistSteps) */
  setMistSteps(n: number | null): void;
  /** context of a reflection render: the scene pass's own context (the same shader code: a reflection reuses the
   *  main view's programs and pipelines); call reflecting(true) around the reflection render so its AO term is off */
  reflectionContext(): N | null;
  /** true while a reflection renders: the scene-pass context's AO factor is 1 (never the main view's screen-space AO
   *  in a mirror), through a render-group uniform (no new program) */
  reflecting(on: boolean): void;
  build(p: Preset, debug?: Set<string>): void;
  setVolumeBounds(box: THREE.Box3): void;
  render(): void;
  /** the v1.2 march is the active volume model */
  mistActive(): boolean;
}

export function createPipeline(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, cfg: PipeCfg, volLayer: number, opts: PipelineOpts = {}): Pipeline {
  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputColorTransform = false;

  const fx = {
    ca: uniform(cfg.fx.ca),
    grain: uniform(cfg.fx.grain),
    vignette: uniform(cfg.fx.vignette),
    desat: uniform(cfg.fx.desat),
    volStrength: uniform(cfg.volume.strength),
  };
  const nv = { k: uniform(0), gain: uniform(6) };

  // --- legacy dust volume (v1.1) ---
  const legacy = new ClampedVolumeMaterial();
  legacy.steps = 12;
  legacy.offsetNode = bayer16(screenCoordinate);
  legacy.maxDistNode.value = cfg.volume.maxDist ?? 16;
  legacy.fog = false;
  const density = uniform(cfg.volume.density);
  const nScale = cfg.volume.noiseScale;
  const drift = cfg.volume.drift;
  const haze = cfg.volume.haze ?? 0.22;
  const nearFade = cfg.volume.nearFade ?? 2.6;
  legacy.scatteringNode = Fn(({ positionRay }: { positionRay: THREE.Node }) => {
    const p = (positionRay as unknown as ReturnType<typeof vec3>);
    const q = p.mul(nScale).add(vec3(time.mul(drift), time.mul(drift * 0.35), time.mul(drift * -0.6)));
    const n = mx_fractal_noise_float(q, 3, 2.0, 0.5, 1.0).mul(0.5).add(0.5).clamp(0, 1);
    const fine = mx_fractal_noise_float(q.mul(3.7).add(vec3(0, time.mul(drift * 1.6), 0)), 2, 2.0, 0.5, 1.0).mul(0.5).add(0.5).clamp(0, 1);
    const wisps = smoothstep(0.38, 0.86, n).mul(fine.mul(0.7).add(0.3));
    const heightK = smoothstep(3.4, 0.0, p.y).mul(0.45).add(0.55);
    const near = smoothstep(0.35, nearFade, p.sub(cameraPosition).length());
    return density.mul(wisps.mul(1.6).add(haze)).mul(heightK).mul(near);
  }) as unknown as THREE.VolumeNodeMaterial['scatteringNode'];

  // --- v1.2 march through the shared medium ---
  const mistCfg = opts.mist;
  const mist = new MistMaterial();
  mist.fogNodes = opts.fogNodes ?? null;
  if (mistCfg) {
    mist.scatterK.value = mistCfg.scatter;
    mist.maxDistNode.value = mistCfg.maxDist;
    mist.bubble.value.set(mistCfg.bubble, mistCfg.bubbleSoft);
  }
  let mistSteps: number | null = null;

  const volMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), legacy);
  volMesh.name = 'render-volume';
  volMesh.receiveShadow = true;
  volMesh.frustumCulled = false;
  volMesh.layers.disableAll();
  volMesh.layers.enable(volLayer);
  volMesh.scale.set(80, 4, 80);
  volMesh.position.set(0, 2, 0);
  scene.add(volMesh);

  const volLayers = new THREE.Layers();
  volLayers.disableAll();
  volLayers.enable(volLayer);

  // --- horror grade (display-referred, after tone mapping) + night vision ---
  const sT = cfg.grade.shadowTint;
  const mT = cfg.grade.midTint;
  const grade = Fn(([c]: [THREE.Node]) => {
    const col = (c as unknown as ReturnType<typeof vec4>).rgb.toVar();
    const l = luminance(col).toVar();
    const desatK = fx.desat.mul(float(1.15).sub(l.mul(0.5)));
    col.assign(mix(col, vec3(l), desatK.clamp(0, 1)));
    const shadowW = smoothstep(0.35, 0.0, l);
    const midW = smoothstep(0.05, 0.35, l).mul(smoothstep(0.85, 0.4, l));
    col.assign(col.mul(mix(vec3(1), vec3(sT[0], sT[1], sT[2]), shadowW)));
    col.assign(col.mul(mix(vec3(1), vec3(mT[0], mT[1], mT[2]), midW)));
    col.assign(col.clamp(0, 1).pow(vec3(cfg.grade.contrast)));
    // black lift: v1.1 tinted it blue (0.8, 0.9, 1.25); v1.2 a neutral black point by default (grade.liftTint)
    const lt = cfg.grade.liftTint ?? [0.8, 0.9, 1.25];
    col.assign(col.add(vec3(cfg.grade.lift * lt[0], cfg.grade.lift * lt[1], cfg.grade.lift * lt[2])).mul(1 - cfg.grade.lift));
    // night vision: phosphor green from the (already gain-amplified) luminance, highlights clamped (tube saturation)
    const nl = luminance(col).toVar();
    const tube = nl.div(nl.add(0.18)).mul(1.18).min(0.92);
    const phosphor = vec3(0.32, 1.0, 0.42).mul(tube.pow(0.85)).add(vec3(0.004, 0.018, 0.006));
    col.assign(mix(col, phosphor, nv.k));
    return col;
  });

  // film grain: additive, visible in the shadows too (sensor noise), stronger in the mids (+0.3 under night vision)
  const grain = Fn(([c]: [THREE.Node]) => {
    const col = (c as unknown as ReturnType<typeof vec4>).rgb.toVar();
    const l = luminance(col);
    const n = rand(fract(uv().add(fract(time.mul(0.6173))))).sub(0.5);
    const w = float(0.35).add(l.sqrt().mul(0.65)).mul(smoothstep(1.0, 0.75, l).mul(0.8).add(0.2));
    return col.add(n.mul(fx.grain.add(nv.k.mul(0.3))).mul(w)).max(0);
  });

  /** the scene pass context: AO multiplies the indirect light INCLUDING the grid GI (three's builtinGIContext divides
   *  the GI by the AO, so it would flood under tables); GI-only without AO.
   *  v1.2 gate P: mirror reflections render with this SAME context (identical shader code, so the first live mirror
   *  compiles no new programs or pipelines for materials the main view already drew: it compiled a whole GI-only
   *  program set before, +64 pipelines at the first mirror). The AO factor is mix(1, ao, aoOn): aoOn is a
   *  render-group uniform (shared buffer, uploaded once per render call), 1 in the scene pass and 0 while a reflection
   *  renders (the main view's screen-space AO never lands in a mirror). */
  const aoOn = uniform(1).setGroup(renderGroup);
  const mainContext = (aoNode: N | null): N => {
    const gi = opts.giNode ?? null;
    const ao: N = aoNode ? mix(float(1), aoNode, aoOn) : null;
    if (!gi) return ao ? builtinAOContext(ao) : null;
    const data: Record<string, unknown> = { getGI: (input: N, { material }: N) => (material.transparent === true ? input : input !== null ? input.add(gi) : gi) };
    if (ao) data.getAO = (input: N, { material }: N) => (material.transparent === true ? input : input !== null ? input.mul(ao) : ao);
    return context(data);
  };
  /** the reflection context: the scene pass's context merged over the renderer's own, exactly like PassNode does for
   *  its render (same data -> same generated code); null = the scene pass has no context either */
  let reflCtx: N | null = null;
  const reflectionCtxOf = (ctx: N | null): N | null => {
    if (!ctx) return null;
    const base = (renderer as unknown as { contextNode: N }).contextNode;
    return context({ ...(base?.getFlowContextData?.() ?? {}), ...ctx.getFlowContextData() });
  };

  let useMist = false;

  function build(p: Preset, dbg: Set<string> = new Set()): void {
    const useAO = p.gtao && !dbg.has('noao');
    const useTRAA = p.traa && !dbg.has('notraa');
    let depthTex: N;
    let velTex: N | null = null;
    const scenePass = pass(scene, camera);
    if (useAO) {
      const pre = pass(scene, camera);
      pre.transparent = false;
      pre.setMRT(mrt({ output: packNormalToRGB(normalView), velocity }));
      pre.getTexture('output').type = THREE.UnsignedByteType;
      const preDepth = pre.getTextureNode('depth');
      const preNormal = sample((uvn: THREE.Node) => unpackRGBToNormal(pre.getTextureNode().sample(uvn)));
      velTex = pre.getTextureNode('velocity') as unknown as N;
      const aoPass = ao(preDepth, preNormal, camera);
      aoPass.resolutionScale = p.aoScale;
      aoPass.distanceExponent.value = 1;
      aoPass.radius.value = 0.6;
      aoPass.scale.value = 1.15;
      aoPass.thickness.value = 1;
      const ctx = mainContext(aoPass.getTextureNode().sample(screenUV).r);
      if (ctx) scenePass.contextNode = ctx;
      reflCtx = reflectionCtxOf(ctx);
      depthTex = preDepth as unknown as N;
    } else {
      scenePass.setMRT(mrt({ output, velocity }));
      velTex = scenePass.getTextureNode('velocity') as unknown as N;
      depthTex = scenePass.getTextureNode('depth') as unknown as N;
      const ctx = mainContext(null);
      if (ctx) scenePass.contextNode = ctx;
      reflCtx = reflectionCtxOf(ctx);
    }
    let color = scenePass.getTextureNode('output') as unknown as N;
    useMist = false;
    if (p.volumetric && !dbg.has('novol')) {
      const v12 = !!mist.fogNodes && !!mistCfg && !dbg.has('legacyvol');
      const volPass = pass(scene, camera, { depthBuffer: false });
      volPass.setLayers(volLayers);
      volPass.setResolutionScale(p.volScale);
      if (v12) {
        useMist = true;
        mist.steps = mistSteps ?? p.volSteps;
        mist.depthNode = (depthTex as unknown as { sample(uv: THREE.Node): THREE.Node }).sample(screenUV);
        volMesh.material = mist;
        const blur = new DepthAwareBlurNode(volPass.getTextureNode(), depthTex, camera, mistCfg!.blurTaps, mistCfg!.blurSigma, mistCfg!.blurSharp);
        const up = mistUpsample(blur, depthTex);
        color = color.add(vec4(up.rgb.mul(fx.volStrength), 0)) as unknown as N;
        if (dbg.has('volonly')) color = vec4(up.rgb.mul(10), 1) as unknown as N;
        if (dbg.has('volraw')) color = vec4((volPass as unknown as N).rgb.mul(10), 1) as unknown as N;
      } else {
        legacy.steps = p.volSteps;
        legacy.depthNode = (depthTex as unknown as { sample(uv: THREE.Node): THREE.Node }).sample(screenUV);
        volMesh.material = legacy;
        const blurred = gaussianBlur(volPass, cfg.volume.blur);
        color = color.add((blurred as unknown as N).mul(fx.volStrength)) as unknown as N;
        if (dbg.has('volonly')) color = (blurred as unknown as N).mul(10) as unknown as N;
        if (dbg.has('volraw')) color = (volPass as unknown as N).mul(10) as unknown as N;
      }
      volMesh.visible = true;
    } else volMesh.visible = false;
    // night vision gain (pre tone map: the tone mapper compresses it like an intensifier tube)
    color = vec4((color as N).rgb.mul(mix(float(1), nv.gain, nv.k)), (color as N).a) as unknown as N;
    // luminance clamp before bloom: no single texel (a flashlight lens up close, a tube edge) explodes the bloom
    const lc = opts.lumClamp ?? 0;
    if (lc > 0) {
      const c0 = color as N;
      const lum = luminance(c0.rgb);
      color = vec4(c0.rgb.mul(min(float(1), float(lc).div(max(lum, 1e-4)))), c0.a) as unknown as N;
    }
    if (!dbg.has('nobloom')) {
      const bloomPass = bloom(color, cfg.bloom.strength, cfg.bloom.radius, cfg.bloom.threshold);
      color = color.add(bloomPass) as unknown as N;
    }
    if (useTRAA && velTex) color = traa(color, depthTex, velTex, camera) as unknown as N;
    const toned = renderOutput(color);
    let out = (dbg.has('nograde') ? toned : grade(toned)) as unknown as N;
    if (!dbg.has('nofx')) {
      out = chromaticAberration(vec4(out, 1), fx.ca, vec2(0.5, 0.5), float(1.0)) as unknown as N;
      out = vignette(out, fx.vignette.add(nv.k.mul(0.4)), float(0.55)) as unknown as N;
      out = grain(out) as unknown as N;
    }
    pipeline.outputNode = vec4((out as unknown as ReturnType<typeof vec4>).rgb, 1);
    pipeline.needsUpdate = true;
  }

  return {
    pipeline,
    volMesh,
    volDensity: density as unknown as { value: number },
    mistScatter: mist.scatterK as unknown as { value: number },
    fx: fx as unknown as Pipeline['fx'],
    nv: nv as unknown as Pipeline['nv'],
    reflectionContext: () => reflCtx,
    reflecting(on) { aoOn.value = on ? 0 : 1; },
    mistActive: () => useMist,
    setMistSteps(n) {
      mistSteps = n;
      if (useMist) mist.steps = n ?? mist.steps;
    },
    build,
    setVolumeBounds(box) {
      const s = new THREE.Vector3();
      const c = new THREE.Vector3();
      box.getSize(s);
      box.getCenter(c);
      volMesh.scale.set(Math.max(1, s.x), Math.max(1, s.y), Math.max(1, s.z));
      volMesh.position.copy(c);
    },
    render() {
      pipeline.render();
    },
  };
}
void length;
