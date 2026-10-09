// v1.3 env-render: what the post pipeline wires per preset, read back from its real pass nodes (three r186 node
// objects; no GPU). 4c: the scene pass (Low) and the GTAO pre-pass (Medium+) write a velocity MRT target only while
// TRAA reads it.
//   node --test tests/render/pipeline.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { createPipeline } from '../../apps/client/src/render/pipeline.ts';
import type { PipeCfg } from '../../apps/client/src/render/pipeline.ts';
import type { Preset } from '../../apps/client/src/render/presets.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const g = globalThis as Any;
g.self ??= globalThis;
g.requestAnimationFrame ??= () => 0;
g.cancelAnimationFrame ??= () => {};

const CFG: PipeCfg = {
  volume: { density: 1.6, noiseScale: 0.45, drift: 0.05, strength: 1.7, blur: 0.35, maxDist: 15 },
  bloom: { strength: 0.14, radius: 0.55, threshold: 1.6 },
  fx: { ca: 0.12, grain: 0.07, vignette: 0.3, desat: 0.32 },
  grade: { shadowTint: [0.82, 0.92, 1.12], midTint: [1.02, 1.04, 0.9], contrast: 1.06, lift: 0.018, liftTint: [1, 1, 1] },
};
const P = (name: string, o: Partial<Preset>): Preset => ({ name, shadowed: 2, unshadowed: 4, shadowMap: 512, volumetric: false, volScale: 0.25, volSteps: 8, gtao: false, aoScale: 0.5, res: 0.75, fixtures: 8, traa: false, ...o });

const T = THREE as Any;
/** a backend that does nothing (the pipeline only builds node graphs here; nothing renders) */
class NullBackend extends T.Backend {
  constructor() {
    super({ canvas: { width: 640, height: 360, style: {}, addEventListener() {}, removeEventListener() {}, setAttribute() {}, getContext() { return null; } } });
    this.extensions = { has: () => false, get: () => null };
    this.capabilities = { getUniformBufferLimit: () => 65536, getMaxAnisotropy: () => 16 };
  }
  get coordinateSystem() { return THREE.WebGLCoordinateSystem; }
}

function make() {
  const renderer = new T.Renderer(new NullBackend(), {});
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 120);
  return createPipeline(renderer, scene, camera, CFG, 10, {});
}

test('4c: Low (no TRAA) has no velocity target; Medium (GTAO + TRAA) keeps it in the pre-pass', () => {
  const pipe = make();
  pipe.build(P('low', {}));
  const low = pipe.state();
  assert.equal(low.preset, 'low');
  assert.equal(low.ao, false);
  assert.equal(low.traa, false);
  assert.equal(low.velocity, false, 'no velocity MRT without TRAA');
  pipe.build(P('medium', { gtao: true, traa: true, volumetric: true, shadowed: 4, unshadowed: 2, res: 1 }));
  const med = pipe.state();
  assert.equal(med.ao, true);
  assert.equal(med.traa, true);
  assert.equal(med.velocity, true, 'TRAA reads the pre-pass velocity');
  assert.equal(med.volumetric, true);
  // GTAO without TRAA (?rdebug=notraa): the pre-pass has normals only
  pipe.build(P('medium', { gtao: true, traa: true, volumetric: true }), new Set(['notraa']));
  const noT = pipe.state();
  assert.equal(noT.ao, true);
  assert.equal(noT.traa, false);
  assert.equal(noT.velocity, false);
  // TRAA without GTAO: the scene pass carries the velocity target
  pipe.build(P('custom', { traa: true }));
  const sceneVel = pipe.state();
  assert.equal(sceneVel.ao, false);
  assert.equal(sceneVel.traa, true);
  assert.equal(sceneVel.velocity, true);
});

test('4e Lite: scene pass + one output pass (no AO, GI, velocity, TRAA, bloom, march); SIGNAL on Low drops bloom', () => {
  const pipe = make();
  pipe.build(P('lite', { lite: true, shadowed: 1, unshadowed: 5, res: 1, fixtures: 4 }));
  const lite = pipe.state();
  assert.deepEqual({ ao: lite.ao, velocity: lite.velocity, traa: lite.traa, bloom: lite.bloom, volumetric: lite.volumetric, gi: lite.gi, lite: lite.lite }, { ao: false, velocity: false, traa: false, bloom: false, volumetric: false, gi: false, lite: true });
  assert.equal(pipe.reflectionContext(), null);
  // SIGNAL: the dither wraps the output; on Low it also drops bloom / CA / grain
  pipe.build(P('low', {}), new Set(), { signal: true });
  const sig = pipe.state();
  assert.equal(sig.signal, true);
  assert.equal(sig.bloom, false);
  pipe.build(P('low', {}));
  assert.equal(pipe.state().bloom, true, 'plain Low keeps its bloom');
  assert.equal(pipe.state().signal, false);
  pipe.build(P('lite', { lite: true }), new Set(), { signal: true });
  assert.deepEqual([pipe.state().lite, pipe.state().signal], [true, true]);
});
