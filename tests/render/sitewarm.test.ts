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
import { WARM_LIMITS, createSiteWarm } from '../../apps/client/src/render/sitewarm.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const g = globalThis as Any;
g.self ??= globalThis;
g.requestAnimationFrame ??= () => 0;
g.cancelAnimationFrame ??= () => {};
g.ImageBitmap ??= class ImageBitmap {};

const C: Record<string, number> = {};
/** objects drawn since the last zero() (any pass) */
const drawn = new Set<THREE.Object3D>();
const zero = () => { for (const k of ['nb', 'prog', 'pipe', 'ro', 'draw']) C[k] = 0; drawn.clear(); };
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
  draw(ro: Any) { C.draw++; drawn.add(ro.object); }
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

test('v1.3 (2c): a warm frame draws ONLY its batch (the view around the camera stays out until its own turn)', async () => {
  const S = await site();
  S.show([0, 1]);
  let now = 0;
  const w = createSiteWarm({ root: () => S.root, version: () => 1, skip: () => false, now: () => now });
  const p = w.run(1e9);
  const under = (o: THREE.Object3D) => { for (let q: THREE.Object3D | null = o; q; q = q.parent) if (q === S.root) return true; return false; };
  const before = flags(S.root);
  let frames = 0;
  let maxLevel = 0;
  let firstBatch = true;
  let calib = 0;
  let settled = false;
  void p.then(() => { settled = true; });
  for (; frames < 400 && !settled; frames++) {
    now += 16;
    if (!w.begin()) { await new Promise((r) => setTimeout(r, 0)); continue; }
    // only meshes under the root with a non-zero mask may draw: the batch
    const live = new Set<THREE.Object3D>();
    S.root.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.layers.mask !== 0) live.add(o); });
    S.frame();
    const lvl = [...drawn].filter(under);
    for (const o of lvl) assert.ok(live.has(o), `${o.name || o.type} drew outside the batch`);
    maxLevel = Math.max(maxLevel, new Set(lvl).size);
    // v1.3 (3c) calibration frames force nothing: no level object draws at all
    if (!lvl.length) calib++;
    else if (firstBatch) {
      firstBatch = false;
      // the first batch takes one signature group (budget 1): an instanced batch, never the rooms in view
      assert.equal(new Set(lvl).size, 1, `first warm batch: one level object (${lvl.map((o) => o.name).join(', ')})`);
      assert.ok((lvl[0] as THREE.InstancedMesh).isInstancedMesh, 'instanced batches first');
    }
    now += 4;
    w.end(4);
    await new Promise((r) => setTimeout(r, 0));
  }
  assert.ok((await p).done);
  assert.equal(flags(S.root), before, 'every mask restored');
  assert.equal(calib, 2, 'one calibration frame at the start + one where the queue moves to the plain meshes');
  assert.equal(w.info().calibrations, 2);
  // a normal frame afterwards draws the view again (rooms 0 + 1)
  S.frame();
  assert.ok(S.groups[0].children.some((o) => drawn.has(o)) && S.groups[1].children.some((o) => drawn.has(o)), 'the view draws again');
  assert.ok(maxLevel >= 1);
});

/** v1.3 (3c) pacing on a synthetic site: n plain meshes, one new material each (1 cost unit per group, no shadow).
 *  A warm frame's wall time = baseMs + costMs per unit, all of it AFTER the render (the GPU process / driver), the
 *  JS render itself ~1 ms: the WebGPU case v1.2 booked as idle time. */
function pace(limits: Any, baseMs: number, costMs: number, n = 120) {
  const root = new THREE.Group();
  root.name = 'level';
  const geo = new THREE.BoxGeometry(1, 1, 1);
  for (let i = 0; i < n; i++) root.add(new THREE.Mesh(geo, new THREE.MeshBasicNodeMaterial()));
  let now = 1000;
  const w = createSiteWarm({ root: () => root, version: () => 1, skip: () => false, now: () => now, limits: limits ? () => limits : undefined });
  void w.run(1e12);
  const units: number[] = [], groups: number[] = [], walls: number[] = [];
  let u0 = 0, g0 = 0;
  for (let f = 0; f < 2000 && w.active(); f++) {
    if (!w.begin()) { now += 16; continue; }
    w.end(1);
    const inf = w.info();
    const du = inf.units - u0, dg = inf.signatures - g0;
    u0 = inf.units; g0 = inf.signatures;
    const wall = baseMs + costMs * du;
    now += wall;
    if (!dg) continue; // a calibration frame (forces nothing)
    units.push(du); groups.push(dg);
    walls.push(wall);
  }
  return { units, groups, walls, info: w.info() };
}

test('v1.3 (3c): compile stalls AFTER the render are charged to the warm frame: the batch shrinks to 1 group', () => {
  // a slow driver: 400 ms per new material, all of it in the GPU process (the JS render takes 1 ms)
  const r = pace(null, 20, 400);
  assert.ok(r.info.done, JSON.stringify(r.info));
  assert.equal(r.info.signatures, 120);
  const late = r.units.slice(10);
  assert.ok(Math.max(...late) <= 1.01, `steady batch: 1 group per frame (units ${JSON.stringify(late.slice(0, 12))})`);
  // never the v1.2 runaway (budget 40 units = a 16 s frame here)
  assert.ok(Math.max(...r.units) <= 6, `max ${Math.max(...r.units)} units in one frame`);
  assert.ok(Math.max(...r.walls) <= 20 + 400 * 6, `longest warm frame ${Math.max(...r.walls)} ms`);
});

test('v1.3 (3c): a fast machine packs more per frame, up to the WebGL2 cap of 6 units', () => {
  const r = pace(WARM_LIMITS.webgl2, 8, 3);
  assert.ok(r.info.done);
  assert.equal(Math.max(...r.units), 6, `reaches the cap (${JSON.stringify(r.units.slice(0, 12))})`);
  assert.ok(r.units.every((u) => u <= 6));
  assert.ok(r.units.length <= 40, `${r.units.length} frames for 120 materials`);
  assert.equal(r.info.maxUnits, 6);
});

test('v1.3 (3c): WebGPU limits: at most 4 signature groups per frame', () => {
  const r = pace(WARM_LIMITS.webgpu, 8, 3);
  assert.ok(r.info.done);
  assert.equal(Math.max(...r.groups), 4, `${JSON.stringify(r.groups.slice(0, 12))}`);
  assert.equal(r.info.maxGroups, 4);
  assert.equal(r.info.signatures, 120);
});
