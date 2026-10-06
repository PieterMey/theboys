// Owner: track ③ Render. RenderPipeline: (pre-pass MRT normal+velocity) -> GTAO (builtinAOContext) -> scene pass ->
// + volumetric flashlight beams (VolumeNodeMaterial on its own layer, low-res pass + gaussian blur) -> bloom ->
// TRAA -> tone map (AgX) -> horror grade -> chromatic aberration -> vignette -> film grain.
import * as THREE from 'three/webgpu';
import {
  Fn, builtinAOContext, float, mix, mrt, normalView, packNormalToRGB, pass, renderOutput, sample, screenCoordinate,
  screenUV, smoothstep, time, uniform, unpackRGBToNormal, vec3, vec4, velocity, mx_fractal_noise_float, luminance,
  output, vec2, rand, fract, uv, cameraPosition, cameraViewMatrix, cameraNear, cameraFar, perspectiveDepthToViewZ, positionWorld,
  property, Loop,
} from 'three/tsl';
import { ao } from 'three/addons/tsl/display/GTAONode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { gaussianBlur } from 'three/addons/tsl/display/GaussianBlurNode.js';
import { chromaticAberration } from 'three/addons/tsl/display/ChromaticAberrationNode.js';
import { vignette } from 'three/addons/tsl/display/CRT.js';
import { bayer16 } from 'three/addons/tsl/math/Bayer.js';
import type { Preset } from './presets.ts';

export interface PipeCfg {
  volume: { density: number; noiseScale: number; drift: number; strength: number; blur: number; maxDist?: number; haze?: number; nearFade?: number };
  bloom: { strength: number; radius: number; threshold: number };
  fx: { ca: number; grain: number; vignette: number; desat: number };
  grade: { shadowTint: number[]; midTint: number[]; contrast: number; lift: number };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

// ---- depth-clamped volumetric ray march ----
// three's VolumetricLightingModel marches camera <-> the volume box's back face and rejects samples behind the scene
// depth: in a 40 m box only 1-2 of 16 samples landed in front of a corridor wall (blobby, flat shafts). This model
// marches from the camera to min(back face, scene depth, maxDist), so every sample lights visible air. Same scattering
// / Beer's-law integration and light hook-up as the stock model (lights of the volume layer, shadows applied).
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
    // per-beam weight (flashlights.ts): own beam a subtle haze, teammates' beams readable shafts
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

export interface Pipeline {
  pipeline: THREE.RenderPipeline;
  volMesh: THREE.Mesh;
  fx: { ca: { value: number }; grain: { value: number }; vignette: { value: number }; desat: { value: number }; volStrength: { value: number } };
  /** live scattering density (render scales it down outdoors: open air is not a dusty corridor) */
  volDensity: { value: number };
  build(p: Preset, debug?: Set<string>): void;
  setVolumeBounds(box: THREE.Box3): void;
  render(): void;
}

export function createPipeline(renderer: THREE.WebGPURenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, cfg: PipeCfg, volLayer: number): Pipeline {
  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputColorTransform = false;

  const fx = {
    ca: uniform(cfg.fx.ca),
    grain: uniform(cfg.fx.grain),
    vignette: uniform(cfg.fx.vignette),
    desat: uniform(cfg.fx.desat),
    volStrength: uniform(cfg.volume.strength),
  };

  // --- volumetric dust volume (only rendered by the layer-filtered low-res pass) ---
  const vol = new ClampedVolumeMaterial();
  vol.steps = 12;
  vol.offsetNode = bayer16(screenCoordinate);
  vol.maxDistNode.value = cfg.volume.maxDist ?? 16;
  const density = uniform(cfg.volume.density);
  const nScale = cfg.volume.noiseScale;
  const drift = cfg.volume.drift;
  const haze = cfg.volume.haze ?? 0.22;
  const nearFade = cfg.volume.nearFade ?? 2.6;
  vol.scatteringNode = Fn(({ positionRay }: { positionRay: THREE.Node }) => {
    const p = (positionRay as unknown as ReturnType<typeof vec3>);
    // slow drifting dust: large soft wisps + a finer breakup, contrast-shaped so the shafts read as uneven air
    const q = p.mul(nScale).add(vec3(time.mul(drift), time.mul(drift * 0.35), time.mul(drift * -0.6)));
    const n = mx_fractal_noise_float(q, 3, 2.0, 0.5, 1.0).mul(0.5).add(0.5).clamp(0, 1);
    const fine = mx_fractal_noise_float(q.mul(3.7).add(vec3(0, time.mul(drift * 1.6), 0)), 2, 2.0, 0.5, 1.0).mul(0.5).add(0.5).clamp(0, 1);
    const wisps = smoothstep(0.38, 0.86, n).mul(fine.mul(0.7).add(0.3));
    // denser near the floor (settled dust), thin under the ceiling
    const heightK = smoothstep(3.4, 0.0, p.y).mul(0.45).add(0.55);
    // fade in over the first metres: the local beam starts at the lens and would veil the whole screen
    const near = smoothstep(0.35, nearFade, p.sub(cameraPosition).length());
    return density.mul(wisps.mul(1.6).add(haze)).mul(heightK).mul(near);
  }) as unknown as THREE.VolumeNodeMaterial['scatteringNode'];
  const volMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), vol);
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

  // --- horror grade (display-referred, after tone mapping) ---
  const sT = cfg.grade.shadowTint;
  const mT = cfg.grade.midTint;
  const grade = Fn(([c]: [THREE.Node]) => {
    const col = (c as unknown as ReturnType<typeof vec4>).rgb.toVar();
    const l = luminance(col).toVar();
    // desaturate (more in the shadows)
    const desatK = fx.desat.mul(float(1.15).sub(l.mul(0.5)));
    col.assign(mix(col, vec3(l), desatK.clamp(0, 1)));
    // cold shadows, sickly green-yellow mids, neutral-ish highlights
    const shadowW = smoothstep(0.35, 0.0, l);
    const midW = smoothstep(0.05, 0.35, l).mul(smoothstep(0.85, 0.4, l));
    col.assign(col.mul(mix(vec3(1), vec3(sT[0], sT[1], sT[2]), shadowW)));
    col.assign(col.mul(mix(vec3(1), vec3(mT[0], mT[1], mT[2]), midW)));
    // toe-preserving contrast (power curve keeps 0 -> 0 and never clips the darks) + black lift
    col.assign(col.clamp(0, 1).pow(vec3(cfg.grade.contrast)));
    col.assign(col.add(vec3(cfg.grade.lift * 0.8, cfg.grade.lift * 0.9, cfg.grade.lift * 1.25)).mul(1 - cfg.grade.lift));
    return col;
  });

  // film grain: additive, visible in the shadows too (sensor noise), stronger in the mids
  const grain = Fn(([c]: [THREE.Node]) => {
    const col = (c as unknown as ReturnType<typeof vec4>).rgb.toVar();
    const l = luminance(col);
    const n = rand(fract(uv().add(fract(time.mul(0.6173))))).sub(0.5);
    const w = float(0.35).add(l.sqrt().mul(0.65)).mul(smoothstep(1.0, 0.75, l).mul(0.8).add(0.2));
    return col.add(n.mul(fx.grain).mul(w)).max(0);
  });

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
      const preNormal = sample((uv: THREE.Node) => unpackRGBToNormal(pre.getTextureNode().sample(uv)));
      velTex = pre.getTextureNode('velocity') as unknown as N;
      const aoPass = ao(preDepth, preNormal, camera);
      aoPass.resolutionScale = p.aoScale;
      aoPass.distanceExponent.value = 1;
      aoPass.radius.value = 0.6;
      aoPass.scale.value = 1.15;
      aoPass.thickness.value = 1;
      scenePass.contextNode = builtinAOContext(aoPass.getTextureNode().sample(screenUV).r);
      depthTex = preDepth as unknown as N;
    } else {
      scenePass.setMRT(mrt({ output, velocity }));
      velTex = scenePass.getTextureNode('velocity') as unknown as N;
      depthTex = scenePass.getTextureNode('depth') as unknown as N;
    }
    let color = scenePass.getTextureNode('output') as unknown as N;
    if (p.volumetric && !dbg.has('novol')) {
      vol.steps = p.volSteps;
      vol.depthNode = (depthTex as unknown as { sample(uv: THREE.Node): THREE.Node }).sample(screenUV);
      const volPass = pass(scene, camera, { depthBuffer: false });
      volPass.setLayers(volLayers);
      volPass.setResolutionScale(p.volScale);
      const blurred = gaussianBlur(volPass, cfg.volume.blur);
      color = color.add((blurred as unknown as N).mul(fx.volStrength)) as unknown as N;
      if (dbg.has('volonly')) color = (blurred as unknown as N).mul(10) as unknown as N;
      if (dbg.has('volraw')) color = (volPass as unknown as N).mul(10) as unknown as N;
      volMesh.visible = true;
    } else volMesh.visible = false;
    if (!dbg.has('nobloom')) {
      const bloomPass = bloom(color, cfg.bloom.strength, cfg.bloom.radius, cfg.bloom.threshold);
      color = color.add(bloomPass) as unknown as N;
    }
    if (useTRAA && velTex) color = traa(color, depthTex, velTex, camera) as unknown as N;
    const toned = renderOutput(color);
    let out = (dbg.has('nograde') ? toned : grade(toned)) as unknown as N;
    if (!dbg.has('nofx')) {
      out = chromaticAberration(vec4(out, 1), fx.ca, vec2(0.5, 0.5), float(1.0)) as unknown as N;
      out = vignette(out, fx.vignette, float(0.55)) as unknown as N;
      out = grain(out) as unknown as N;
    }
    pipeline.outputNode = vec4((out as unknown as ReturnType<typeof vec4>).rgb, 1);
    pipeline.needsUpdate = true;
  }

  return {
    pipeline,
    volMesh,
    volDensity: density as unknown as { value: number },
    fx: fx as unknown as Pipeline['fx'],
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
