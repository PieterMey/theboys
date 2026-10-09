// v1.3 (3b) env-render/env-world: a level surface material is built ONCE with its final textured node graph over 1x1
// placeholders; the KTX2 upgrade swaps the textures + params in and NOTHING recompiles (main + shadow pass). three
// r186's real Renderer + GLSL node builder over a counting no-op backend (no GPU). Control: the v1.2 in-place upgrade
// (new node graphs + needsUpdate) rebuilds.
//   node --test tests/render/livetex.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { DynamicLighting } from 'three/addons/lighting/DynamicLighting.js';
import { isSurfacePlaceholder, makeSurfaceMaterial, surfacePlaceholder } from '../../apps/client/src/render/materials.ts';
import type { SurfaceMaterial } from '../../apps/client/src/render/materials.ts';

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
  updateBindings() {}
  createAttribute() {}
  createIndexAttribute() {}
  createTexture() {}
  updateTexture() {}
  generateMipmaps() {}
  draw() {}
  hasFeature() { return false; }
}

async function setup(mat: THREE.Material) {
  const renderer = new T.Renderer(new CountingBackend(), {});
  renderer.library = new T.StandardNodeLibrary();
  renderer.lighting = new DynamicLighting({ maxPointLights: 4, maxSpotLights: 4, maxHemisphereLights: 1, maxDirectionalLights: 1 });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  await renderer.init();
  renderer.setSize(320, 180, false);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 120);
  camera.position.set(0, 1.6, 3);
  camera.lookAt(0, 1, 0);
  scene.add(camera, new THREE.HemisphereLight(0x8b9096, 0x2b2925, 0.45));
  const beam = new T.ProjectorLight(0xffffff, 200, 20, 0.6, 0.8, 1.6);
  beam.castShadow = true;
  beam.shadow.mapSize.set(128, 128);
  beam.position.set(0, 2, 3);
  beam.target.position.set(0, 0.5, 0);
  scene.add(beam, beam.target);
  const wall = new THREE.Mesh(new THREE.BoxGeometry(3, 2, 0.2), mat);
  wall.castShadow = wall.receiveShadow = true;
  scene.add(wall);
  const frame = () => { zero(); renderer._nodes.nodeFrame.update(); scene.updateMatrixWorld(); renderer.render(scene, camera); return [C.nb, C.prog, C.pipe]; };
  return { frame };
}

/** a KTX2-like set: a BC7 sRGB albedo (as KTX2Loader leaves it), linear normal + ORM */
function ktx2Like() {
  const mips = [{ data: new Uint8Array(16), width: 4, height: 4 }, { data: new Uint8Array(16), width: 2, height: 2 }, { data: new Uint8Array(16), width: 1, height: 1 }];
  const albedo = new THREE.CompressedTexture(mips, 4, 4, THREE.RGBA_BPTC_Format);
  albedo.colorSpace = THREE.SRGBColorSpace;
  albedo.minFilter = THREE.LinearMipmapLinearFilter;
  albedo.magFilter = THREE.LinearFilter;
  albedo.generateMipmaps = false;
  const lin = () => { const t = new THREE.DataTexture(new Uint8Array(64), 4, 4); t.colorSpace = THREE.NoColorSpace; t.needsUpdate = true; return t; };
  return { albedo, normal: lin(), orm: lin() };
}

/** every TextureNode value reachable from a node graph */
function texturesIn(node: Any, out = new Set<THREE.Texture>(), seen = new Set<unknown>()): Set<THREE.Texture> {
  if (!node || typeof node !== 'object' || seen.has(node)) return out;
  seen.add(node);
  if (node.isTextureNode && node.value?.isTexture) out.add(node.value);
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (v && typeof v === 'object' && (v.isNode || Array.isArray(v))) {
      if (Array.isArray(v)) for (const x of v) texturesIn(x, out, seen);
      else texturesIn(v, out, seen);
    }
  }
  return out;
}

test('3b: live textures: the KTX2 swap + textured params compile nothing (main + shadow pass)', async () => {
  const m = makeSurfaceMaterial({ color: 0x77746d, roughness: 0.92, metalness: 0, grime: 0.6, uvMode: 'uv', wet: 0.55, liveTextures: true }) as SurfaceMaterial;
  assert.ok(m.setTextures, 'live material');
  const ph = texturesIn(m.colorNode);
  assert.ok([...ph].some(isSurfacePlaceholder), 'the albedo starts as the shared placeholder');
  assert.equal(surfacePlaceholder('albedo').colorSpace, THREE.SRGBColorSpace);
  assert.equal(surfacePlaceholder('normal').colorSpace, THREE.NoColorSpace);
  const { frame } = await setup(m);
  const first = frame();
  assert.ok(first[0] > 0 && first[2] > 0, `the first frame compiles (${first})`);
  assert.deepEqual(frame(), [0, 0, 0], 'steady');
  const k = ktx2Like();
  m.setTextures!({ albedo: k.albedo, normal: k.normal, orm: k.orm });
  m.setSurface({ color: 0xd8d4cc, roughness: 0.97, grime: 0.42 });
  for (let i = 0; i < 3; i++) assert.deepEqual(frame(), [0, 0, 0], `after the swap, frame ${i}: no node build, program or pipeline`);
  const now = texturesIn(m.colorNode);
  assert.ok(now.has(k.albedo), 'the colour graph samples the KTX2 albedo now');
  assert.ok(texturesIn(m.roughnessNode).has(k.orm), 'roughness reads the KTX2 ORM');
  assert.ok(texturesIn(m.normalNode).has(k.normal), 'the normal node reads the KTX2 normal map');
  assert.ok(![...now].some(isSurfacePlaceholder), 'no placeholder left in the colour graph');
  assert.equal(m.version, 0, 'never needsUpdate');
});

test('control: the v1.2 in-place upgrade (new graphs + needsUpdate) rebuilds the material', async () => {
  const m = makeSurfaceMaterial({ color: 0x77746d, roughness: 0.92, metalness: 0, grime: 0.6, uvMode: 'uv', wet: 0.55 });
  const { frame } = await setup(m);
  frame();
  assert.deepEqual(frame(), [0, 0, 0]);
  const k = ktx2Like();
  const tm = makeSurfaceMaterial({ albedo: k.albedo, normal: k.normal, orm: k.orm, color: 0xd8d4cc, roughness: 0.97, metalness: 0, grime: 0.42, uvMode: 'uv', wet: 0.55 });
  m.colorNode = tm.colorNode;
  m.roughnessNode = tm.roughnessNode;
  m.metalnessNode = tm.metalnessNode;
  m.aoNode = tm.aoNode;
  m.normalMap = tm.normalMap;
  m.needsUpdate = true;
  const r = frame();
  assert.ok(r[0] > 0, `the old upgrade rebuilt (${r})`);
});

test('setSurface: live params with the creation clamps (corrugated / diamond: rough >= 0.7, metal <= 0.3)', () => {
  const m = makeSurfaceMaterial({ color: 0x55595b, roughness: 0.72, metalness: 0.3, uvMode: 'uv', pattern: 'diamond', liveTextures: true }) as SurfaceMaterial;
  m.setSurface({ roughness: 0.4, metalness: 0.9 });
  assert.equal(m.roughness, 0.7);
  assert.equal(m.metalness, 0.3);
  const plain = makeSurfaceMaterial({ color: 0x808080, roughness: 0.5, metalness: 0, uvMode: 'uv' }) as SurfaceMaterial;
  assert.equal(plain.setTextures, undefined, 'not live: no texture swap');
  plain.setSurface({ roughness: 0.3 });
  assert.equal(plain.roughness, 0.3);
});
