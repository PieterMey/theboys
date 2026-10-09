// v1.3 (4b) env-render: idle batched lights leave the per-pixel light loop (visible=false) WITHOUT a recompile.
// three r186's real Renderer + node builders + DynamicLighting over a counting no-op backend (no GPU): the flashlight
// pool (2 shadowed ProjectorLights + 4 batched SpotLight slots), a fixture-like sentinel SpotLight + PointLight, the
// hemisphere. Hiding parked / dark batched slots must build 0 nodes, 0 programs and 0 pipelines; a hidden SHADOWED
// light would recompile (the control: why shadowed slots never hide).
//   node --test tests/render/hideidle.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { DynamicLighting } from 'three/addons/lighting/DynamicLighting.js';
import { createFlashlightPool } from '../../apps/client/src/render/flashlights.ts';
import type { FlashCfg } from '../../apps/client/src/render/flashlights.ts';
import type { FlashlightInfo } from '../../apps/client/src/render/types.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const g = globalThis as Any;
g.self ??= globalThis;
g.requestAnimationFrame ??= () => 0;
g.cancelAnimationFrame ??= () => {};
g.ImageBitmap ??= class ImageBitmap {};

const C: Record<string, number> = { nb: 0, prog: 0, pipe: 0 };
const zero = () => { C.nb = 0; C.prog = 0; C.pipe = 0; };
const T = THREE as Any;
class CountingBackend extends T.Backend {
  constructor() {
    super({ canvas: { width: 320, height: 180, style: {}, addEventListener() {}, removeEventListener() {}, setAttribute() {}, getContext() { return null; } } });
    this.extensions = { has: () => false, get: () => null };
    this.capabilities = { getUniformBufferLimit: () => 65536, getMaxAnisotropy: () => 16 };
  }
  get coordinateSystem() { return THREE.WebGLCoordinateSystem; }
  createNodeBuilder(object: Any, renderer: Any) {
    const b = new T.GLSLNodeBuilder(object, renderer);
    const build = b.build.bind(b);
    b.build = () => { C.nb++; return build(); };
    return b;
  }
  createProgram() { C.prog++; }
  createRenderPipeline(ro: Any) { C.pipe++; (this as Any).get(ro.pipeline).pipeline = true; }
  needsRenderUpdate() { return false; }
  getRenderCacheKey() { return ''; }
  createBindings() {}
  createAttribute() {}
  createIndexAttribute() {}
  createTexture() {}
  draw() {}
  hasFeature() { return false; }
}

const CFG: FlashCfg = { angle: 0.62, penumbra: 0.9, decay: 1.6, distance: 24, intensity1: 74, intensity2: 105, color1: '#ffe3bd', color2: '#e4eeff', bias: -0.0004, normalBias: 0.02, shadowRadius: 3, near: 0.12, cone: 0.035, remoteDistance: 18 };
const beam = (id: string, local: boolean, on = true, x = 0): FlashlightInfo => ({ id, pos: [x, 1.5, 0], dir: [0, 0, -1], on, local, tier: 1 });

async function setup() {
  const renderer = new T.Renderer(new CountingBackend(), {});
  renderer.library = new T.StandardNodeLibrary();
  renderer.lighting = new DynamicLighting({ maxPointLights: 6, maxSpotLights: 10, maxHemisphereLights: 2, maxDirectionalLights: 2 });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  await renderer.init();
  renderer.setSize(320, 180, false);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 120);
  camera.position.set(0, 1.6, 2);
  camera.lookAt(0, 1.2, -4);
  scene.add(camera);
  scene.add(new THREE.HemisphereLight(0x8b9096, 0x2b2925, 0.45));
  // the fixture pool's sentinels (render/fixtures.ts keeps one visible light per batched type)
  const sentSpot = new THREE.SpotLight(0xcfeedd, 0, 9, 0.9, 1, 2);
  sentSpot.position.set(0, -400, 0);
  const sentOmni = new THREE.PointLight(0xcfeedd, 0, 9, 2);
  sentOmni.position.set(0, -400, 0);
  scene.add(sentSpot, sentSpot.target, sentOmni);
  const pool = createFlashlightPool(scene, CFG, 2, 4, 256, 10);
  const wall = new THREE.Mesh(new THREE.BoxGeometry(6, 3, 0.2), new THREE.MeshStandardNodeMaterial({ roughness: 0.8 }));
  wall.position.set(0, 1.5, -4);
  wall.castShadow = wall.receiveShadow = true;
  scene.add(wall);
  const opts = { activeShadowed: 2, volumetric: false, reduceFlicker: false, hideIdle: true };
  let t = 0;
  const frame = (list: FlashlightInfo[]) => {
    t += 1 / 60;
    pool.update(list, camera, t, 1 / 60, opts);
    pool.armShadows();
    zero();
    renderer._nodes.nodeFrame.update();
    scene.updateMatrixWorld();
    renderer.render(scene, camera);
    return [C.nb, C.prog, C.pipe];
  };
  return { renderer, scene, pool, frame, opts };
}

test('4b: parked / dark batched slots hide; lit ones show; shadowed slots never hide', async () => {
  const { pool, frame } = await setup();
  frame([beam('me', true), beam('p2', false, true, 1), beam('p3', false, true, 2), beam('p4', false, true, 3)]);
  const plain = pool.slots.filter((s) => !s.shadowed);
  // me -> own shadowed slot, p2 -> the other shadowed slot, p3 + p4 -> 2 of the 4 batched slots
  assert.equal(plain.filter((s) => s.light.visible).length, 2, 'two lit batched slots visible, the 2 parked ones hidden');
  for (let i = 0; i < 12; i++) frame([beam('me', true), beam('p2', false, true, 1), beam('p3', false, false, 2), beam('p4', false, true, 3)]);
  const p3 = pool.slots.find((s) => s.id === 'p3')!;
  assert.equal(p3.shadowed, false);
  assert.equal(p3.light.visible, false, 'a dark beam in a batched slot hides once its fade ends');
  frame([]);
  assert.ok(plain.every((s) => !s.light.visible), 'all parked: every batched slot hidden');
  assert.ok(pool.slots.filter((s) => s.shadowed).every((s) => s.light.visible), 'shadowed slots stay in the light list');
});

test('4b: hiding / showing idle batched lights compiles nothing (0 node builds, programs, pipelines)', async () => {
  const { frame } = await setup();
  const all = [beam('me', true), beam('p2', false, true, 1), beam('p3', false, true, 2), beam('p4', false, true, 3), beam('p5', false, true, 0.5), beam('p6', false, true, 1.5)];
  const first = frame(all);
  assert.ok(first[2] > 0, `the first frame compiles (${first})`);
  assert.deepEqual(frame(all), [0, 0, 0], 'steady');
  // beams go dark / leave one by one: batched slots hide, the light count shrinks
  const seq: FlashlightInfo[][] = [all.slice(0, 4), all.slice(0, 2), [all[0]], [], all.slice(0, 3), all];
  for (const list of seq) for (let i = 0; i < 12; i++) {
    const r = frame(list);
    assert.deepEqual(r, [0, 0, 0], `beams ${list.map((b) => b.id).join(',') || 'none'}: ${r}`);
  }
});

test('control: hiding a SHADOWED light recompiles (why shadowed slots never hide)', async () => {
  const { pool, frame } = await setup();
  const two = [beam('me', true), beam('p2', false, true, 1)];
  frame(two);
  assert.deepEqual(frame(two), [0, 0, 0]);
  const sh = pool.slots.find((s) => s.shadowed && !s.own)!;
  sh.light.visible = false;
  const r = frame([beam('me', true)]);
  sh.light.visible = true;
  assert.ok(r[0] > 0, `a shadowed light leaving the list rebuilds the lit materials (${r})`);
});
