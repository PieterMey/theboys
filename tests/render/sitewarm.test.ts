// env-render (door-lag fix): render.warmSite()'s mechanism on the REAL three r186 renderer core (Renderer, node
// builders, render objects, program / pipeline caches) over a counting no-op backend (GLSLNodeBuilder; no GPU, no GL),
// with the level's site-wide batches (apps/client/src/level/sitebatch.ts) packed by visible space:
//   node --test tests/render/sitewarm.test.ts
// - control: without the warm, revealing a room compiles (its own materials, a batch whose instances only live there);
// - with createSiteWarm (sitewarm.ts) drawn through real frames: every later reveal, a re-pack (count changes), a page
//   made visible and a re-open compile NOTHING (0 node builds / programs / pipelines, main + shadow pass), and every
//   forced flag (visible, frustumCulled, layers) is restored exactly;
// - pausing at the time limit resolves done:false and a second run resumes; a level rebuild starts over.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { color, exp, exponentialHeightFogFactor, fog, Fn, length, uniform, vec3 } from 'three/tsl';
import { DynamicLighting } from 'three/addons/lighting/DynamicLighting.js';
import { SiteBatch } from '../../apps/client/src/level/sitebatch.ts';
import { createSiteWarm } from '../../apps/client/src/render/sitewarm.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const g = globalThis as Any;
g.self ??= globalThis;
g.requestAnimationFrame ??= () => 0;
g.cancelAnimationFrame ??= () => {};
g.ImageBitmap ??= class ImageBitmap {};

const C: Record<string, number> = {};
const zero = () => { for (const k of ['nb', 'prog', 'pipe', 'ro', 'draw']) C[k] = 0; };
zero();

const T = THREE as Any;
class CountingBackend extends T.Backend {
  constructor() {
    super({ canvas: { width: 640, height: 360, style: {}, addEventListener() {}, removeEventListener() {}, setAttribute() {}, getContext() { return null; } } });
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
  draw() { C.draw++; }
  hasFeature() { return false; }
}

interface Site {
  renderer: Any; scene: THREE.Scene; camera: THREE.PerspectiveCamera; root: THREE.Group; groups: THREE.Group[]; batches: SiteBatch[];
  page: THREE.Mesh; show(ids: number[]): void; frame(): Record<string, number>;
}

/** 6 spaces in a row: a room mesh each (shared material; space 4 its own), a hidden 'page' in space 3, and 4 prop
 *  kinds as site-wide batches (kind 3 only in space 5; kinds 0-1 cast shadows); a shadowed projector beam + fog */
async function site(): Promise<Site> {
  const renderer = new T.Renderer(new CountingBackend(), {});
  renderer.library = new T.StandardNodeLibrary();
  renderer.lighting = new DynamicLighting({ maxPointLights: 8, maxSpotLights: 4, maxHemisphereLights: 1, maxDirectionalLights: 1 });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  await renderer.init();
  const cro = renderer._objects.createRenderObject.bind(renderer._objects);
  renderer._objects.createRenderObject = (...a: Any[]) => { C.ro++; return cro(...a); };
  renderer.setSize(640, 360, false);
  const scene = new THREE.Scene();
  (scene as Any).fogNode = fog(color(0x06080a), exponentialHeightFogFactor(uniform(0.08), uniform(3.4)));
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 120);
  camera.position.set(2, 1.6, 2);
  camera.lookAt(10, 1.2, 2);
  scene.add(camera);
  scene.add(new THREE.HemisphereLight(0x7a8aa0, 0x14120e, 0.3));
  for (let i = 0; i < 4; i++) { const l = new THREE.PointLight(0xcfeedd, 0, 9, 2); l.position.set(i * 6, 2.9, 2); scene.add(l); }
  const beam = new T.ProjectorLight(0xffffff, 200, 28, 0.42, 0.7, 1.6);
  beam.colorNode = Fn(([uv]: Any) => vec3(exp(length(uv.xy.sub(0.5)).mul(-4))));
  beam.castShadow = true;
  beam.shadow.mapSize.set(256, 256);
  beam.position.copy(camera.position);
  beam.target.position.set(10, 1, 2);
  scene.add(beam, beam.target);
  const root = new THREE.Group();
  root.name = 'level';
  scene.add(root);
  const roomMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.8 });
  const tex = new THREE.DataTexture(new Uint8Array(16), 2, 2);
  tex.needsUpdate = true;
  const oddMat = new THREE.MeshStandardNodeMaterial({ roughness: 0.3, metalness: 0.5, map: tex });
  const roomGeo = new THREE.BoxGeometry(6, 3, 6);
  const groups: THREE.Group[] = [];
  let page: THREE.Mesh | null = null;
  for (let s = 0; s < 6; s++) {
    const grp = new THREE.Group();
    grp.name = `space:${s}`;
    const room = new THREE.Mesh(roomGeo, s === 4 ? oddMat : roomMat);
    room.position.set(s * 6 + 3, 1.5, 2);
    room.castShadow = true; room.receiveShadow = true;
    grp.add(room);
    if (s === 3) {
      page = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.3), new THREE.MeshStandardNodeMaterial({ color: 0xeeeeee, side: THREE.DoubleSide }));
      page.position.set(s * 6 + 2, 1, 1);
      page.visible = false;
      grp.add(page);
    }
    root.add(grp);
    groups.push(grp);
  }
  const kinds = [0, 1, 2, 3].map((k) => ({ geo: new THREE.BoxGeometry(0.4 + k * 0.1, 0.8, 0.5), mat: new THREE.MeshStandardNodeMaterial({ metalness: 0.1 * k }) }));
  const batches: SiteBatch[] = [];
  for (let k = 0; k < 4; k++) {
    const spaces = k === 3 ? [5] : [0, 1, 2, 3, 4, 5];
    const b = new SiteBatch(kinds[k].geo, kinds[k].mat, spaces.length * 2, `glb:site:k${k}`);
    for (const s of spaces) for (let i = 0; i < 2; i++) b.add(s, new THREE.Matrix4().makeTranslation(s * 6 + 1 + i * 1.5, 0.4, 0.5 + k * 1.2));
    b.im.castShadow = k < 2;
    b.im.receiveShadow = true;
    root.add(b.im);
    batches.push(b);
  }
  const show = (ids: number[]) => {
    groups.forEach((grp, i) => { grp.visible = ids.includes(i); });
    const m = new Uint8Array(6);
    for (const i of ids) m[i] = 1;
    for (const b of batches) b.pack(m);
  };
  const frame = () => { zero(); renderer._nodes.nodeFrame.update(); scene.updateMatrixWorld(); renderer.render(scene, camera); return { ...C }; };
  return { renderer, scene, camera, root, groups, batches, page: page!, show, frame };
}

/** every flag the warm may touch, for an exact-restore check */
const flags = (root: THREE.Object3D) => { const out: string[] = []; root.traverse((o) => out.push(`${o.uuid}:${o.visible}:${o.frustumCulled}:${o.layers.mask}`)); return out.join('|'); };

/** drive a warm run through real frames (begin -> render -> end) until it settles */
async function warmFrames(S: Site, w: ReturnType<typeof createSiteWarm>, p: Promise<unknown>): Promise<number> {
  let settled = false;
  void p.then(() => { settled = true; });
  let n = 0;
  for (; n < 400 && !settled; n++) {
    const on = w.begin();
    const t0 = performance.now();
    if (on) { S.frame(); w.end(performance.now() - t0); }
    await new Promise((r) => setTimeout(r, 0));
  }
  return n;
}

test('control: without the warm a room reveal compiles (its own material, a batch living only there)', async () => {
  const S = await site();
  S.show([0, 1]);
  S.frame();
  assert.equal(S.frame().nb, 0, 'steady');
  S.show([0, 1, 2, 3, 4]);
  const r4 = S.frame();
  assert.ok(r4.nb > 0 && r4.pipe > 0, `space 4's own material compiles on reveal: ${JSON.stringify(r4)}`);
  S.show([0, 1, 2, 3, 4, 5]);
  const r5 = S.frame();
  assert.ok(r5.nb > 0, `the batch living only in space 5 compiles on reveal: ${JSON.stringify(r5)}`);
});

test('warmSite: after the warm, reveals / re-packs / a shown page / re-opens compile nothing; flags restored', async () => {
  const S = await site();
  S.show([0, 1]);
  S.frame();
  const before = flags(S.root);
  let ver = 1;
  const w = createSiteWarm({ root: () => S.root, version: () => ver, skip: () => false, now: () => performance.now() });
  const p = w.run(60_000);
  const n = await warmFrames(S, w, p);
  const res = await p as { done: boolean; meshes: number; total: number; signatures: number; frames: number };
  assert.ok(res.done, `warm done in ${n} frames (${JSON.stringify(res)})`);
  assert.equal(res.meshes, res.total);
  assert.equal(flags(S.root), before, 'every forced flag restored');
  assert.equal(w.active(), false);
  // reveal room by room (+ the batches re-pack each time)
  for (const ids of [[0, 1, 2], [0, 1, 2, 3], [0, 1, 2, 3, 4], [0, 1, 2, 3, 4, 5], [3, 4, 5], [0, 1, 2, 3, 4, 5]]) {
    S.show(ids);
    const r = S.frame();
    assert.deepEqual([r.nb, r.prog, r.pipe], [0, 0, 0], `reveal ${ids}: ${JSON.stringify(r)}`);
  }
  // a hidden page shown later (fieldguide lore page): warmed too
  S.page.visible = true;
  const rp = S.frame();
  assert.deepEqual([rp.nb, rp.prog, rp.pipe], [0, 0, 0], `page: ${JSON.stringify(rp)}`);
  // a drawer slide / prop shove: a matrix update of a drawn instance
  S.batches[0].setMatrixAt(3, new THREE.Matrix4().makeTranslation(8, 0.4, 1.4));
  const rm = S.frame();
  assert.deepEqual([rm.nb, rm.prog, rm.pipe], [0, 0, 0]);
  // the level is already warm: a second run resolves at once
  const again = await w.run(1000);
  assert.ok(again.done);
  // a rebuild (new version) starts over
  ver = 2;
  const p2 = w.run(60_000);
  await warmFrames(S, w, p2);
  assert.ok((await p2).done);
});

test('warmSite: a run that hits its time limit pauses (done:false), the next run resumes', async () => {
  const S = await site();
  S.show([0]);
  S.frame();
  let now = 0;
  const w = createSiteWarm({ root: () => S.root, version: () => 1, skip: (m) => m.name === 'skip-me', now: () => now });
  const p = w.run(10);
  // one frame, then time is up
  assert.ok(w.begin());
  S.frame();
  w.end(5);
  now = 20;
  assert.equal(w.begin(), false, 'no warm frame past the time limit');
  const r1 = await p;
  assert.equal(r1.done, false);
  assert.ok(r1.left > 0, 'work left');
  const p2 = w.run(1e9);
  const n = await warmFrames(S, w, p2);
  const r2 = await p2;
  assert.ok(r2.done && r2.meshes === r2.total, `resumed and done in ${n} frames`);
});
