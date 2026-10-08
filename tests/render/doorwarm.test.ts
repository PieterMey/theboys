// env-render + env-world (door-lag fix), the REAL level on three r186's renderer core in Node (no GPU, no GL): the
// client level (apps/client/src/level, real layout, real materials, the staged prop GLBs as geometry with one material
// per glTF material) drawn by three's Renderer over a counting no-op backend (GLSLNodeBuilder: every node build /
// program / pipeline / render object is counted), lit by a shadowed flashlight beam at the camera (+ fog, batched
// fixtures). render.warmSite's sitewarm.ts warms the whole site through real frames; then the door-hitch gate's
// sequence: 4+ doors whose far room was never drawn are opened (animated), closed and re-opened, and the camera walks
// through an opened door into rooms never drawn, and paranormal grabs movable props (their handle draws a plain clone).
// Every reveal / grab must compile NOTHING (0 node builds, 0 programs, 0 pipelines; main + shadow pass). Control: the
// same first reveals without the warm do compile.
//   node --test tests/render/doorwarm.test.ts      (~20-40 s; skips when no staged GLBs exist)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { color, exp, exponentialHeightFogFactor, fog, Fn, length, uniform, vec3 } from 'three/tsl';
import { DynamicLighting } from 'three/addons/lighting/DynamicLighting.js';
import { generateFacility } from '../../packages/shared/src/procgen/facility.ts';
import { PROP_DEFS } from '../../packages/shared/src/procgen/decor.ts';
import { clutterFor } from '../../packages/shared/src/procgen/clutter.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import { installDomShim, installLevel } from '../world/harness.ts';
import { glbPath, loadGlbModel } from '../world/glb.ts';
import { buildTemplate, primePropTemplate } from '../../apps/client/src/level/assets.ts';
import { createSiteWarm } from '../../apps/client/src/render/sitewarm.ts';
import { movableRefsOf } from '../../packages/shared/src/procgen/movables.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const g = globalThis as Any;
g.self ??= globalThis;
g.requestAnimationFrame ??= () => 0;
g.cancelAnimationFrame ??= () => {};
g.ImageBitmap ??= class ImageBitmap {};
installDomShim();

const C: Record<string, number> = {};
const KEYS = ['nb', 'prog', 'pipe', 'ro', 'draw'];
const zero = () => { for (const k of KEYS) C[k] = 0; };
zero();
/** what compiled (object name prefix / pass) */
let log: string[] = [];
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
    b.build = () => { C.nb++; log.push(String(object?.name || object?.type).split(':')[0]); return build(); };
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
  updateTexture() {}
  generateMipmaps() {}
  draw() { C.draw++; }
  hasFeature() { return false; }
}

/** the staged prop GLBs (geometry + one material per glTF material) as level templates; false when none are staged */
async function primeGlbs(L: LevelLayout): Promise<boolean> {
  const keys = new Set<string>();
  for (const it of L.items) { const k = String(it.data?.prop ?? ''); if (it.kind === 'prop' && PROP_DEFS[k] && !PROP_DEFS[k].proc) keys.add(k); }
  for (const c of clutterFor(L)) if (c.kind === 'glb' && c.key) keys.add(c.key);
  let n = 0;
  for (const key of keys) {
    const p = glbPath(key);
    if (!p) continue;
    primePropTemplate(key, buildTemplate(key, await loadGlbModel(p, { materials: true })));
    n++;
  }
  return n > 0;
}

interface Sim { L: LevelLayout; lv: Any; h: Any; frame(dt?: number, tick?: boolean): Record<string, number>; renderer: Any }
async function sim(seed: string): Promise<Sim | null> {
  const L = generateFacility({ seed, players: 1, risk: 1 });
  if (!(await primeGlbs(L))) return null;
  const h = await installLevel(L);
  await new Promise((r) => setTimeout(r, 50));
  const renderer = new T.Renderer(new CountingBackend(), {});
  renderer.library = new T.StandardNodeLibrary();
  renderer.lighting = new DynamicLighting({ maxPointLights: 8, maxSpotLights: 8, maxHemisphereLights: 2, maxDirectionalLights: 2 });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  await renderer.init();
  const cro = renderer._objects.createRenderObject.bind(renderer._objects);
  renderer._objects.createRenderObject = (...a: Any[]) => { C.ro++; return cro(...a); };
  renderer.setSize(640, 360, false);
  const scene = h.scene as THREE.Scene;
  (scene as Any).fogNode = fog(color(0x06080a), exponentialHeightFogFactor(uniform(0.08), uniform(3.4)));
  scene.add(new THREE.HemisphereLight(0x8b9096, 0x2b2925, 0.45));
  for (let i = 0; i < 6; i++) { const l = new THREE.PointLight(0xd9f2c4, 0, 9, 2); l.position.set(0, -400, 0); scene.add(l); }
  // the local flashlight: a shadowed projector at the camera (the game's beam), its shadow pass every frame
  const beam = new T.ProjectorLight(0xffe3bd, 260, 24, 0.42, 0.7, 1.6);
  beam.colorNode = Fn(([uv]: Any) => vec3(exp(length(uv.xy.sub(0.5)).mul(-4))));
  beam.castShadow = true;
  beam.shadow.mapSize.set(256, 256);
  scene.add(beam, beam.target);
  const camera = h.camera as THREE.PerspectiveCamera;
  scene.add(camera);
  const lv = h.services.use('level');
  const fwd = new THREE.Vector3();
  // tick = the level system first (door animation, culling, batch packing), as the client loop runs it before render
  const frame = (dt = 1 / 60, tick = true) => {
    zero();
    if (tick) h.tick(dt, 1);
    camera.updateMatrixWorld();
    camera.getWorldDirection(fwd);
    beam.position.copy(camera.position).y -= 0.1;
    beam.target.position.copy(camera.position).add(fwd);
    renderer._nodes.nodeFrame.update();
    scene.updateMatrixWorld();
    renderer.render(scene, camera);
    return { ...C };
  };
  return { L, lv, h, frame, renderer };
}

const centre = (d: { dir: string; x: number; y: number; len: number }) => ({ cx: d.dir === 'v' ? d.x : d.x + d.len / 2, cz: d.dir === 'v' ? d.y + d.len / 2 : d.y });
/** stand 0.8 m into the side of `d` owned by `sp`, facing the door */
function look(S: Sim, d: { dir: string; x: number; y: number; len: number }, sp: number): boolean {
  const { cx, cz } = centre(d);
  for (const s of [-1, 1]) {
    const x = d.dir === 'v' ? cx + s * 0.8 : cx, z = d.dir === 'h' ? cz + s * 0.8 : cz;
    if (S.L.owner[Math.floor(z) * S.L.W + Math.floor(x)] !== sp) continue;
    S.h.camera.position.set(x, 1.6, z);
    S.h.camera.lookAt(cx, 1.3, cz);
    return true;
  }
  return false;
}
const sum = (rs: Record<string, number>[]) => { const o: Record<string, number> = {}; for (const k of KEYS) o[k] = rs.reduce((a, r) => a + r[k], 0); return o; };
/** the door sequence: first opens of doors whose far room was never drawn, close, re-open; then a walk */
function doorRun(S: Sim, seen: Set<number>, nDoors: number) {
  const out: { door: number; far: number; open1: Record<string, number>; open2: Record<string, number>; what: string[] }[] = [];
  const vis = () => S.lv.visibleSpaces([S.h.camera.position.x, 1.6, S.h.camera.position.z]) as Set<number>;
  const mark = () => { for (const s of vis()) seen.add(s); };
  const run = (frames: number) => { const rs: Record<string, number>[] = []; for (let i = 0; i < frames; i++) { rs.push(S.frame()); mark(); } return sum(rs); };
  for (const d of S.L.doors) {
    if (out.length >= nDoors) break;
    if (!(d.kind === 'door' || d.kind === 'fire') || d.initiallyOpen || d.a < 0 || d.b < 0 || S.L.spaces[d.a]?.open || S.L.spaces[d.b]?.open) continue;
    if (seen.has(d.a) === seen.has(d.b)) continue; // one side drawn, the other never
    const near = seen.has(d.a) ? d.a : d.b, far = near === d.a ? d.b : d.a;
    if (!look(S, d, near)) continue;
    run(3);
    if (vis().has(far)) continue;
    log = [];
    S.lv.setDoorOpen(d.id, true);
    const open1 = run(60);
    const what = log.slice(0, 12);
    S.lv.setDoorOpen(d.id, false);
    run(60);
    S.lv.setDoorOpen(d.id, true);
    const open2 = run(30);
    S.lv.setDoorOpen(d.id, false);
    run(30);
    out.push({ door: d.id, far, open1, open2, what });
  }
  return out;
}

test('real level: after warmSite, 4+ first door reveals, re-opens and a walk compile nothing (main + shadow)', { timeout: 240_000 }, async (t) => {
  const S = await sim('dl-1');
  if (!S) { t.skip('no staged prop GLBs'); return; }
  const sp = S.L.items.find((i) => i.kind === 'spawn_player')!;
  S.h.camera.position.set(sp.x, 1.6, sp.z);
  S.h.camera.lookAt(sp.x + 1, 1.5, sp.z);
  for (let i = 0; i < 3; i++) S.frame();
  // the loading flow: warmSite through real frames
  const w = createSiteWarm({ root: () => S.lv.root, version: () => S.lv.version, skip: (m) => m.name === 'mirror-live', now: () => performance.now() });
  let settled = false;
  const p = w.run(600_000).then((r) => { settled = true; return r; });
  const t0 = performance.now();
  let frames = 0;
  const warm: Record<string, number>[] = [];
  while (!settled && frames < 2000) {
    // the client order: the level system (SYS.level), then render's frame(): begin -> render -> end
    S.h.tick(1 / 60, 1);
    const on = w.begin();
    const f0 = performance.now();
    if (on) { warm.push(S.frame(1 / 60, false)); w.end(performance.now() - f0); }
    frames++;
    await new Promise((r) => setTimeout(r, 0));
  }
  const res = await p;
  const wsum = sum(warm);
  t.diagnostic(`warmSite: ${JSON.stringify(res)} in ${Math.round(performance.now() - t0)} ms; created ${JSON.stringify(wsum)}; ${JSON.stringify(w.info())}`);
  assert.ok(res.done && res.meshes === res.total && res.total > 300, `warm done over the real level (${res.total} meshes)`);
  assert.ok(wsum.nb > 50 && wsum.pipe > 20, 'the warm compiled the site');
  const seen = new Set<number>(S.lv.visibleSpaces([sp.x, 1.6, sp.z]));
  const doors = doorRun(S, seen, 5);
  for (const d of doors) t.diagnostic(`door ${d.door} -> ${d.far}: open1 ${JSON.stringify(d.open1)} open2 ${JSON.stringify(d.open2)}`);
  assert.ok(doors.length >= 4, `${doors.length} first door reveals`);
  for (const d of doors) {
    assert.deepEqual([d.open1.nb, d.open1.prog, d.open1.pipe], [0, 0, 0], `door ${d.door}: first reveal of space ${d.far} compiled ${JSON.stringify(d.open1)} (${d.what.join(',')})`);
    assert.deepEqual([d.open2.nb, d.open2.prog, d.open2.pipe], [0, 0, 0], `door ${d.door}: re-open`);
  }
  // the walk: through an opened door into the far room, then on through its open doorways (rooms never drawn)
  const d0 = S.L.doors.find((d) => (d.kind === 'door' || d.kind === 'fire') && !d.initiallyOpen && d.a >= 0 && d.b >= 0 && seen.has(d.a) !== seen.has(d.b) && !S.L.spaces[d.a]?.open && !S.L.spaces[d.b]?.open);
  assert.ok(d0, 'a door left for the walk');
  const near = seen.has(d0!.a) ? d0!.a : d0!.b, far = near === d0!.a ? d0!.b : d0!.a;
  S.lv.setDoorOpen(d0!.id, true, true);
  const before = seen.size;
  const walk: Record<string, number>[] = [];
  const route = [far, ...S.L.doors.filter((x) => (x.a === far || x.b === far) && (x.kind === 'open' || x.initiallyOpen)).map((x) => (x.a === far ? x.b : x.a)).filter((s) => s >= 0 && !S.L.spaces[s]?.open).slice(0, 2)];
  for (const s of route) {
    const r = S.L.spaces[s].rect;
    S.h.camera.position.set(r.x + r.w / 2, 1.6, r.y + r.h / 2);
    for (let i = 0; i < 20; i++) { walk.push(S.frame()); for (const v of S.lv.visibleSpaces([S.h.camera.position.x, 1.6, S.h.camera.position.z])) seen.add(v); }
    S.h.camera.rotation.y += Math.PI / 2;
    for (let i = 0; i < 10; i++) walk.push(S.frame());
  }
  const ws = sum(walk);
  t.diagnostic(`walk ${near} -> ${route.join(' -> ')}: ${JSON.stringify(ws)}, spaces drawn ${before} -> ${seen.size}`);
  assert.ok(seen.size > before, 'the walk revealed rooms never drawn');
  assert.deepEqual([ws.nb, ws.prog, ws.pipe], [0, 0, 0], `walk compiled ${JSON.stringify(ws)}`);
  // movable props (poltergeist / falls): the first handle of each key draws its clone
  const grabbed = new Set<string>();
  for (const ref of movableRefsOf(S.L)) {
    if (grabbed.has(ref.key) || grabbed.size >= 6) continue;
    S.h.camera.position.set(ref.x + 1.2, 1.6, ref.z + 1.2);
    S.h.camera.lookAt(ref.x, 0.4, ref.z);
    for (let i = 0; i < 3; i++) S.frame();
    log = [];
    const ph = S.lv.propHandle(ref.ref, { key: ref.key, x: ref.x, z: ref.z });
    if (!ph) continue;
    grabbed.add(ref.key);
    const c = sum([S.frame(), S.frame()]);
    ph.restore();
    assert.deepEqual([c.nb, c.prog, c.pipe], [0, 0, 0], `movable ${ref.key}: its clone compiled ${JSON.stringify(c)} (${log.join(',')})`);
  }
  t.diagnostic(`movable clones drawn without a compile: ${[...grabbed].join(', ')}`);
  assert.ok(grabbed.size > 0, 'movable props grabbed');
  assert.deepEqual(S.h.errors, []);
});

test('real level control: without the warm, first door reveals compile', { timeout: 120_000 }, async (t) => {
  const S = await sim('dl-1');
  if (!S) { t.skip('no staged prop GLBs'); return; }
  const sp = S.L.items.find((i) => i.kind === 'spawn_player')!;
  S.h.camera.position.set(sp.x, 1.6, sp.z);
  S.h.camera.lookAt(sp.x + 1, 1.5, sp.z);
  for (let i = 0; i < 3; i++) S.frame();
  const seen = new Set<number>(S.lv.visibleSpaces([sp.x, 1.6, sp.z]));
  const doors = doorRun(S, seen, 3);
  const compiled = doors.filter((d) => d.open1.nb > 0);
  t.diagnostic(doors.map((d) => `door ${d.door} -> ${d.far}: open1 ${JSON.stringify(d.open1)} (${d.what.join(',')})`).join('\n'));
  assert.ok(compiled.length > 0, 'unwarmed first reveals compile (the hitch the warm removes)');
});
