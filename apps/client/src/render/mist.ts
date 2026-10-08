// Owner: env-render (v1.2). The beam march (Medium+): ONLY shadowed-light in-scatter through the shared medium of
// fog.ts (fogDensityAt), attenuated by its own transmittance, added to the scene the same way on every preset (no
// scene x T: fog.ts owns all extinction). Low-resolution pass on the volume layer:
//   - the ray runs camera -> min(volume box back face, scene depth, maxDist); IGN start offset (TRAA integrates it)
//   - a 1.5 m clear bubble (smooth) so your own beam never veils the screen
//   - fog = false (the old material was fogged by its own back face, so beams depended on the level bounds)
//   - output = vec4(in-scatter, transmittance); a 4-channel depth-aware separable blur at low resolution, then a
//     depth-aware (joint bilateral) upsample in the composite
import * as THREE from 'three/webgpu';
import {
  Fn, Loop, cameraPosition, cameraViewMatrix, cameraNear, cameraFar, float, floor, fract, interleavedGradientNoise, passTexture,
  perspectiveDepthToViewZ, positionWorld, property, renderGroup, screenCoordinate, screenUV, uniform, uv, vec2, vec3, vec4, exp,
  smoothstep, abs, texture,
} from 'three/tsl';
import { fogDensityAt } from './fog.ts';
import type { FogNodes } from './fog.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type N = any;

export interface MistCfg {
  /** scattering albedo x phase scale of the shared density (beam brightness) */
  scatter: number;
  /** march length cap (m) */
  maxDist: number;
  /** smooth clear bubble edge: density ramps in over [bubble, bubble + bubbleSoft] */
  bubble: number;
  bubbleSoft: number;
  /** depth-aware blur: taps each side, gaussian sigma (taps), depth sharpness */
  blurTaps: number;
  blurSigma: number;
  blurSharp: number;
}

export const MIST_DEFAULTS: MistCfg = { scatter: 0.11, maxDist: 15, bubble: 1.5, bubbleSoft: 1.6, blurTaps: 3, blurSigma: 1.8, blurSharp: 9 };

const volScatter = property('vec3');
const volOut = property('vec3');
const volT = property('float');

/** frame counter for the IGN offset (set per drawn frame) */
export const mistFrame = { value: 0 };

class MistModel extends (THREE.LightingModel as unknown as new () => N) {
  start(builder: N): void {
    const material = builder.material as MistMaterial;
    const F = material.fogNodes!;
    const toBack = positionWorld.sub(cameraPosition).toVar();
    const boxLen = toBack.length().toVar();
    const dir = toBack.div(boxLen.max(1e-4)).toVar();
    let len: N = boxLen.min(material.maxDistNode);
    if (material.depthNode) {
      const viewZ = perspectiveDepthToViewZ(material.depthNode, cameraNear, cameraFar);
      const dirViewZ = cameraViewMatrix.mul(vec4(dir, 0)).z.min(-1e-3);
      len = len.min(viewZ.div(dirViewZ));
    }
    len = len.max(0.05).toVar();
    const steps = uniform('int').onRenderUpdate(({ material: m }: N) => m.steps);
    const stepSize = len.div(float(steps)).toVar();
    const dist = float(0).toVar();
    // IGN start offset, animated per frame (TRAA integrates the march)
    const fr = uniform(0).setGroup(renderGroup).onRenderUpdate(() => mistFrame.value % 64);
    const ign = interleavedGradientNoise(screenCoordinate.add(vec2(fr.mul(5.588238), fr.mul(3.27))));
    dist.addAssign(ign.mul(stepSize));
    volOut.assign(vec3(0));
    volT.assign(1);
    const room = F.camRoom;
    Loop(steps, () => {
      const positionRay = cameraPosition.add(dir.mul(dist));
      const positionViewRay = cameraViewMatrix.mul(vec4(positionRay, 1)).xyz;
      builder.context.positionWorld = positionRay;
      builder.context.shadowPositionWorld = positionRay;
      builder.context.positionView = positionViewRay;
      volScatter.assign(0);
      super.start(builder);
      const bubble = smoothstep(material.bubble.x, material.bubble.x.add(material.bubble.y), dist);
      const rho = fogDensityAt(F, positionRay, room).toVar();
      // in-scatter of the shadowed beams through the same medium the fog integrates; Beer's law on its own T
      volOut.addAssign(volScatter.mul(rho.mul(material.scatterK).mul(bubble)).mul(volT).mul(stepSize));
      volT.mulAssign(exp(rho.mul(bubble).mul(stepSize).negate()));
      dist.addAssign(stepSize);
    });
  }

  direct({ lightNode, lightColor }: N): void {
    // only the shadowed flashlights scatter (batched lights call direct() with an empty light: skipped)
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

export class MistMaterial extends THREE.VolumeNodeMaterial {
  maxDistNode = uniform(16);
  scatterK = uniform(0.32);
  /** x = bubble start (m), y = soft width (m) */
  bubble = uniform(new THREE.Vector2(1.2, 1.6));
  fogNodes: FogNodes | null = null;
  constructor() {
    super();
    // v1.2 fix: NodeMaterial.fog defaults to true; the march box was fogged by its own back face
    this.fog = false;
    // one back face per pixel; write (in-scatter, T) as is (the composite adds rgb)
    this.blending = THREE.NoBlending;
    this.name = 'render-mist';
  }
  setupLightingModel(): N {
    return new MistModel();
  }
  setupOutput(builder: N, outputNode: N): N {
    // alpha = the march's transmittance (4-channel blur input; the composite only adds rgb)
    return super.setupOutput(builder, vec4((outputNode as N).rgb, volT));
  }
}

// ------------------------------------------------------------------------------------------------ depth-aware blur

const _quad = new THREE.QuadMesh(undefined as unknown as THREE.NodeMaterial);
let _state: N;

/**
 * 4-channel separable depth-aware blur at the input texture's resolution (the low-res march target). Weights =
 * gaussian x exp(-|z - z0| / z0 x sharp) on linear view depth sampled from the full-resolution depth texture.
 */
export class DepthAwareBlurNode extends THREE.TempNode {
  textureNode: N;
  depthNode: N;
  taps: number;
  sigma: number;
  sharp: N;
  near: N;
  far: N;
  /** 1 / low-res size */
  invSize: N;
  /** low-res size (for the upsample) */
  size: N;
  private _h = new THREE.RenderTarget(1, 1, { depthBuffer: false, type: THREE.HalfFloatType });
  private _v = new THREE.RenderTarget(1, 1, { depthBuffer: false, type: THREE.HalfFloatType });
  private _out: N;
  private _hm: THREE.NodeMaterial | null = null;
  private _vm: THREE.NodeMaterial | null = null;
  constructor(textureNode: N, depthNode: N, camera: THREE.PerspectiveCamera, taps = 3, sigma = 1.8, sharp = 9) {
    super('vec4');
    this.textureNode = textureNode;
    this.depthNode = depthNode;
    this.taps = taps;
    this.sigma = sigma;
    this.sharp = uniform(sharp);
    this.near = uniform(camera.near);
    this.far = uniform(camera.far);
    this.invSize = uniform(new THREE.Vector2(1, 1));
    this.size = uniform(new THREE.Vector2(1, 1));
    this._h.texture.name = 'mist-blur-h';
    this._v.texture.name = 'mist-blur-v';
    this._out = passTexture(this as N, this._v.texture);
    this.updateBeforeType = THREE.NodeUpdateType.FRAME;
  }
  getTextureNode(): N { return this._out; }
  updateBefore(frame: N): boolean | undefined {
    const { renderer } = frame;
    _state = THREE.RendererUtils.resetRendererState(renderer, _state);
    const map = this.textureNode.value as THREE.Texture;
    const w = Math.max(1, (map.image as { width: number }).width), h = Math.max(1, (map.image as { height: number }).height);
    this.invSize.value.set(1 / w, 1 / h);
    this.size.value.set(w, h);
    this._h.setSize(w, h);
    this._v.setSize(w, h);
    _quad.material = this._hm!;
    renderer.setRenderTarget(this._h);
    _quad.name = 'Mist blur [ H ]';
    _quad.render(renderer);
    _quad.material = this._vm!;
    renderer.setRenderTarget(this._v);
    _quad.name = 'Mist blur [ V ]';
    _quad.render(renderer);
    THREE.RendererUtils.restoreRendererState(renderer, _state);
    return undefined;
  }
  setup(builder: N): N {
    // the two blur materials are built ONCE. This setup runs for every builder that reaches this node (the composite,
    // TRAA's resolve); re-assigning the fragment graphs + needsUpdate here, with the vertical pass reading a
    // PassTextureNode of THIS node, re-entered setup every time that material rebuilt: both blur programs were
    // rebuilt and recompiled every frame (seen in gate P's pipeline log at the first mirror view)
    if (!this._hm || !this._vm) this.buildMaterials();
    const props = builder.getNodeProperties(this);
    props.textureNode = this.textureNode;
    props.depthNode = this.depthNode;
    return this._out;
  }
  private buildMaterials(): void {
    const linZ = (u: N) => perspectiveDepthToViewZ(this.depthNode.sample(u).r, this.near, this.far).negate();
    const weights: number[] = [];
    for (let i = 0; i <= this.taps; i++) weights.push(Math.exp(-0.5 * (i * i) / (this.sigma * this.sigma)));
    const blur = (src: N, dx: number, dy: number) => Fn(() => {
      const u0 = uv();
      const z0 = linZ(u0).max(0.05).toVar();
      const sum = src.sample(u0).mul(weights[0]).toVar();
      const ws = float(weights[0]).toVar();
      for (let i = 1; i <= this.taps; i++) {
        for (const s of [1, -1]) {
          const ui = u0.add(vec2(dx * i * s, dy * i * s).mul(this.invSize));
          const zi = linZ(ui);
          const w = float(weights[i]).mul(exp(abs(zi.sub(z0)).div(z0).mul(this.sharp).negate()));
          sum.addAssign(src.sample(ui).mul(w));
          ws.addAssign(w);
        }
      }
      return sum.div(ws.max(1e-4));
    })();
    const hm = new THREE.NodeMaterial();
    hm.fragmentNode = blur(this.textureNode, 1, 0);
    hm.name = 'mist-blur-h';
    // the horizontal result as a plain texture node (a PassTextureNode of this node would re-enter setup)
    const vm = new THREE.NodeMaterial();
    vm.fragmentNode = blur(texture(this._h.texture), 0, 1);
    vm.name = 'mist-blur-v';
    this._hm = hm;
    this._vm = vm;
  }
  dispose(): void {
    this._h.dispose();
    this._v.dispose();
    this._hm?.dispose();
    this._vm?.dispose();
    super.dispose();
  }
}

/**
 * Depth-aware upsample of the blurred low-res march into the full-res composite: the 4 low-res texels around the
 * pixel, bilinear weights x depth similarity (full-res depth vs depth at the low-res texel centres).
 */
export function mistUpsample(blur: DepthAwareBlurNode, depthNode: N): N {
  return Fn(() => {
    const linZ = (u: N) => perspectiveDepthToViewZ(depthNode.sample(u).r, blur.near, blur.far).negate();
    const tex = blur.getTextureNode();
    const f = screenUV.mul(blur.size).sub(0.5).toVar();
    const i0 = floor(f).toVar();
    const w = fract(f).toVar();
    const zf = linZ(screenUV).max(0.05).toVar();
    const sum = vec4(0).toVar();
    const ws = float(0).toVar();
    for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
      const ut = i0.add(vec2(ox, oy)).add(0.5).div(blur.size);
      const zt = linZ(ut);
      const bw = (ox ? w.x : w.x.oneMinus()).mul(oy ? w.y : w.y.oneMinus());
      const dw = float(1).div(float(0.02).add(abs(zt.sub(zf)).div(zf).mul(blur.sharp)));
      const ww = bw.mul(dw).add(1e-4);
      sum.addAssign(tex.sample(ut).mul(ww));
      ws.addAssign(ww);
    }
    return sum.div(ws);
  })();
}
