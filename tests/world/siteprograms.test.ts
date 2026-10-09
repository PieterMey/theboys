// v1.3 env-world/env-render: shader programs + render pipelines of a WHOLE site without a browser. The real client
// level (gp-6, 3 players, risk 1: the gfx-pipeline lane site; the staged prop GLBs, one material per glTF material)
// drawn once with every mesh forced visible (like render.warmSite), three r186's renderer core + GLSL node builder over
// a counting backend (WebGL2 code paths), Low's light setup: the real flashlight pool (2 shadowed projector beams with
// their cookies + 4 batched spots), a fixture-like sentinel spot + omni, the hemisphere.
// 3a: site batches hold >= 1025 instances, so three feeds their matrices as an instanced ATTRIBUTE: batches of one
// material + vertex layout share programs and pipelines. OLD = the same site with a huge uniform-buffer limit (every
// InstancedMesh back on the per-batch uniform-array path, `buffer<nodeId>[count]` in its shader).
//   node --test tests/world/siteprograms.test.ts      (~15 s; skips when no staged GLBs exist)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { DynamicLighting } from 'three/addons/lighting/DynamicLighting.js';
import { generateFacility } from '../../packages/shared/src/procgen/facility.ts';
import { PROP_DEFS } from '../../packages/shared/src/procgen/decor.ts';
import { clutterFor } from '../../packages/shared/src/procgen/clutter.ts';
import { installDomShim, installLevel } from './harness.ts';
import { glbPath, loadGlbModel } from './glb.ts';
import { buildTemplate, primePropTemplate } from '../../apps/client/src/level/assets.ts';
import { createFlashlightPool } from '../../apps/client/src/render/flashlights.ts';
import type { FlashCfg } from '../../apps/client/src/render/flashlights.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const g = globalThis as Any;
g.self ??= globalThis;
g.requestAnimationFrame ??= () => 0;
g.cancelAnimationFrame ??= () => {};
g.ImageBitmap ??= class ImageBitmap {};
installDomShim();

interface Count { vs: Set<string>; fs: Set<string>; pipes: number; instVs: Set<string>; builds: number }
const fresh = (): Count => ({ vs: new Set(), fs: new Set(), pipes: 0, instVs: new Set(), builds: 0 });
let C = fresh();
const T = THREE as Any;
class CountingBackend extends T.Backend {
  limit: number;
  constructor(limit: number) {
    super({ canvas: { width: 480, height: 270, style: {}, addEventListener() {}, removeEventListener() {}, setAttribute() {}, getContext() { return null; } } });
    this.limit = limit;
    this.extensions = { has: () => false, get: () => null };
    this.capabilities = { getUniformBufferLimit: () => this.limit, getMaxAnisotropy: () => 16 };
  }
  get coordinateSystem() { return THREE.WebGLCoordinateSystem; }
  createNodeBuilder(object: Any, renderer: Any) {
    const b = new T.GLSLNodeBuilder(object, renderer);
    const build = b.build.bind(b);
    b.build = () => { C.builds++; return build(); };
    return b;
  }
  createProgram(p: Any) { (p.stage === 'vertex' ? C.vs : C.fs).add(p.code); }
  createRenderPipeline(ro: Any) {
    C.pipes++;
    if (ro.object.isInstancedMesh) C.instVs.add(ro.pipeline.vertexProgram.code);
    (this as Any).get(ro.pipeline).pipeline = true;
  }
  needsRenderUpdate() { return false; }
  getRenderCacheKey() { return ''; }
  createBindings() {}
  createAttribute() {}
  createIndexAttribute() {}
  createTexture() {}
  updateTexture() {}
  generateMipmaps() {}
  draw() {}
  hasFeature() { return false; }
}

const FLASH: FlashCfg = { angle: 0.62, penumbra: 0.9, decay: 1.6, distance: 24, intensity1: 74, intensity2: 105, color1: '#ffe3bd', color2: '#e4eeff', bias: -0.0004, normalBias: 0.02, shadowRadius: 3, near: 0.12, cone: 0.035, remoteDistance: 18 };

async function siteCounts(limit: number) {
  const L = generateFacility({ seed: 'gp-6', players: 3, risk: 1 });
  const keys = new Set<string>();
  for (const it of L.items) { const k = String(it.data?.prop ?? ''); if (it.kind === 'prop' && PROP_DEFS[k] && !PROP_DEFS[k].proc) keys.add(k); }
  for (const c of clutterFor(L)) if (c.kind === 'glb' && c.key) keys.add(c.key);
  let primed = 0;
  for (const key of keys) { const p = glbPath(key); if (p) { primePropTemplate(key, buildTemplate(key, await loadGlbModel(p, { materials: true }))); primed++; } }
  if (!primed) return null;
  const h = await installLevel(L);
  await new Promise((r) => setTimeout(r, 100));
  const lv = h.services.use('level') as Any;
  const renderer = new T.Renderer(new CountingBackend(limit), {});
  renderer.library = new T.StandardNodeLibrary();
  renderer.lighting = new DynamicLighting({ maxPointLights: 9, maxSpotLights: 17, maxHemisphereLights: 2, maxDirectionalLights: 2 });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  await renderer.init();
  renderer.setSize(480, 270, false);
  const scene = h.scene as THREE.Scene;
  scene.add(new THREE.HemisphereLight(0x8b9096, 0x2b2925, 0.45));
  const sentSpot = new THREE.SpotLight(0xcfeedd, 1, 9, 0.9, 1, 2);
  const sentOmni = new THREE.PointLight(0xcfeedd, 1, 9, 2);
  scene.add(sentSpot, sentSpot.target, sentOmni);
  const camera = h.camera as THREE.PerspectiveCamera;
  camera.aspect = 480 / 270; camera.updateProjectionMatrix();
  scene.add(camera);
  const pool = createFlashlightPool(scene, FLASH, 2, 4, 256, 10);
  const sp = L.items.find((i) => i.kind === 'spawn_player')!;
  camera.position.set(sp.x, 1.6, sp.z);
  camera.lookAt(sp.x + 1, 1.5, sp.z + 1);
  camera.updateMatrixWorld();
  const beams = Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, pos: [sp.x, 1.5, sp.z] as [number, number, number], dir: [0.7, -0.1, 0.7] as [number, number, number], on: true, local: i === 0, tier: 1 as const }));
  // every level mesh drawn once (render.warmSite forces the same: visible, unculled, every batch packed)
  h.tick(1 / 60, 1);
  const root = lv.root as THREE.Object3D;
  root.traverse((o) => { o.visible = true; o.frustumCulled = false; });
  for (const o of root.children) if ((o as THREE.InstancedMesh).isInstancedMesh) { const im = o as THREE.InstancedMesh; im.count = Math.max(im.count, 1); }
  C = fresh();
  for (let f = 0; f < 2; f++) {
    pool.update(beams, camera, f / 60, 1 / 60, { activeShadowed: 2, volumetric: false, reduceFlicker: false, armDark: true });
    pool.armShadows();
    renderer._nodes.nodeFrame.update();
    scene.updateMatrixWorld();
    renderer.render(scene, camera);
  }
  let batches = 0;
  for (const o of root.children) if ((o as THREE.InstancedMesh).isInstancedMesh) batches++;
  return { vs: C.vs.size, fs: C.fs.size, pipelines: C.pipes, instancedVs: C.instVs.size, builds: C.builds, batches, errors: h.errors };
}

test('3a: site batches on the instanced-attribute path share programs + pipelines (OLD: one set per batch)', { timeout: 240_000 }, async (t) => {
  const NEW = await siteCounts(65536);
  if (!NEW) { t.skip('no staged prop GLBs'); return; }
  const OLD = await siteCounts(1 << 30);
  assert.ok(OLD);
  t.diagnostic(`NEW (attribute path): ${NEW.pipelines} pipelines, ${NEW.vs} vertex / ${NEW.fs} fragment programs, ${NEW.instancedVs} instanced vertex programs, ${NEW.builds} node builds, ${NEW.batches} batches`);
  t.diagnostic(`OLD (uniform arrays): ${OLD.pipelines} pipelines, ${OLD.vs} vertex / ${OLD.fs} fragment programs, ${OLD.instancedVs} instanced vertex programs, ${OLD.builds} node builds`);
  assert.deepEqual(NEW.errors, []);
  assert.ok(NEW.batches >= 10, `${NEW.batches} site batches`);
  assert.ok(NEW.pipelines < OLD.pipelines, `pipelines ${NEW.pipelines} < ${OLD.pipelines}`);
  assert.ok(NEW.instancedVs * 2 <= OLD.instancedVs, `instanced vertex programs ${NEW.instancedVs} vs ${OLD.instancedVs}`);
  assert.ok(NEW.vs < OLD.vs && NEW.fs <= OLD.fs, 'fewer programs');
});
