// env-render + env-world (door-lag fix): gate P draw calls of the level WITHOUT a browser. The real client level (the
// gate P site gp-6: 6 players, risk 2; the staged prop GLBs with one material per glTF material) drawn by three r186's
// renderer core over a counting backend at gate P's views (facilityViews: 'arrive' + the largest room, the v1.2 final
// worst view 'room37_server', 445 draws in the browser), the camera + 5 bots' beams (4 shadowed, Ultra).
// NEW = the site-wide prop batches packed by visible space (this fix); OLD = the same instances split back into one
// InstancedMesh per space (the v1.2 structure). Level draws per pass must not grow at the worst view; triangles are
// reported (a packed batch draws every instance of the visible spaces, also those outside a pass's frustum).
//   node --test tests/render/batchdraws.test.ts      (~10 s; skips when no staged GLBs exist)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { DynamicLighting } from 'three/addons/lighting/DynamicLighting.js';
import { generateFacility } from '../../packages/shared/src/procgen/facility.ts';
import { PROP_DEFS } from '../../packages/shared/src/procgen/decor.ts';
import { clutterFor } from '../../packages/shared/src/procgen/clutter.ts';
import { installDomShim, installLevel } from '../world/harness.ts';
import { glbPath, loadGlbModel } from '../world/glb.ts';
import { buildTemplate, primePropTemplate } from '../../apps/client/src/level/assets.ts';
import { siteBatchOf } from '../../apps/client/src/level/sitebatch.ts';
import { facilityViews } from '../gates/p-lib.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const g = globalThis as Any;
g.self ??= globalThis;
g.requestAnimationFrame ??= () => 0;
g.cancelAnimationFrame ??= () => {};
g.ImageBitmap ??= class ImageBitmap {};
installDomShim();

const C: Record<string, number> = {};
const zero = () => { for (const k of ['main', 'shadow', 'mainTris', 'shadowTris', 'mainIM', 'shadowIM']) C[k] = 0; };
let mainCam: THREE.Camera | null = null;
let levelRoot: THREE.Object3D | null = null;
const inLevel = (o: THREE.Object3D) => { for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p === levelRoot) return true; return false; };
const T = THREE as Any;
class CountingBackend extends T.Backend {
  constructor() {
    super({ canvas: { width: 480, height: 270, style: {}, addEventListener() {}, removeEventListener() {}, setAttribute() {}, getContext() { return null; } } });
    this.extensions = { has: () => false, get: () => null };
    this.capabilities = { getUniformBufferLimit: () => 65536, getMaxAnisotropy: () => 16 };
  }
  get coordinateSystem() { return THREE.WebGLCoordinateSystem; }
  createNodeBuilder(object: Any, renderer: Any) { return new T.GLSLNodeBuilder(object, renderer); }
  createProgram() {}
  createRenderPipeline(ro: Any) { (this as Any).get(ro.pipeline).pipeline = true; }
  needsRenderUpdate() { return false; }
  getRenderCacheKey() { return ''; }
  createBindings() {}
  createAttribute() {}
  createIndexAttribute() {}
  createTexture() {}
  updateTexture() {}
  generateMipmaps() {}
  draw(ro: Any) {
    const p = ro.getDrawParameters();
    if (!p || !inLevel(ro.object)) return;
    const pass = ro.camera === mainCam ? 'main' : 'shadow';
    C[pass]++;
    C[pass + 'Tris'] += (p.vertexCount * p.instanceCount) / 3;
    if (ro.object.isInstancedMesh) C[pass + 'IM']++;
  }
  hasFeature() { return false; }
}

test('gate P views: site-wide batches draw no more level calls than per-room InstancedMeshes', { timeout: 180_000 }, async (t) => {
  const L = generateFacility({ seed: 'gp-6', players: 6, risk: 2 });
  const keys = new Set<string>();
  for (const it of L.items) { const k = String(it.data?.prop ?? ''); if (it.kind === 'prop' && PROP_DEFS[k] && !PROP_DEFS[k].proc) keys.add(k); }
  for (const c of clutterFor(L)) if (c.kind === 'glb' && c.key) keys.add(c.key);
  let primed = 0;
  for (const key of keys) { const p = glbPath(key); if (p) { primePropTemplate(key, buildTemplate(key, await loadGlbModel(p, { materials: true }))); primed++; } }
  if (!primed) { t.skip('no staged prop GLBs'); return; }
  const h = await installLevel(L);
  await new Promise((r) => setTimeout(r, 100));
  const lv = h.services.use('level') as Any;
  levelRoot = lv.root;
  const renderer = new T.Renderer(new CountingBackend(), {});
  renderer.library = new T.StandardNodeLibrary();
  renderer.lighting = new DynamicLighting({ maxPointLights: 8, maxSpotLights: 8, maxHemisphereLights: 2, maxDirectionalLights: 2 });
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  await renderer.init();
  renderer.setSize(480, 270, false);
  const scene = h.scene as THREE.Scene;
  scene.add(new THREE.HemisphereLight(0x8b9096, 0x2b2925, 0.45));
  const camera = h.camera as THREE.PerspectiveCamera;
  camera.aspect = 480 / 270; camera.fov = 70; camera.near = 0.05; camera.far = 120; camera.updateProjectionMatrix();
  mainCam = camera;
  scene.add(camera);
  // 6 beams like gate P: yours (24 m) + 5 bots (18 m); the 4 best shadowed (Ultra), 2 unshadowed
  const beams: THREE.SpotLight[] = [];
  for (let i = 0; i < 6; i++) {
    const b = new THREE.SpotLight(0xffe3bd, 260, i === 0 ? 24 : 18, 0.42, 0.7, 1.6);
    b.castShadow = i < 4;
    if (b.castShadow) b.shadow.mapSize.set(256, 256);
    scene.add(b, b.target);
    beams.push(b);
  }
  const dir = (yaw: number, pitch: number) => new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
  const views = facilityViews(L as never, 1, 0);
  const place = (v: (typeof views)[number]) => {
    camera.position.set(v.x, 1.6, v.z);
    camera.lookAt(camera.position.clone().add(dir(v.yaw, v.pitch)));
    const pts = [{ x: v.x, z: v.z, yaw: v.yaw }, ...v.bots];
    beams.forEach((b, i) => { const p = pts[i] ?? pts[0]; b.position.set(p.x, 1.5, p.z); b.target.position.copy(b.position).add(dir(p.yaw, -0.08)); });
  };
  const batches = (lv.root.children as THREE.Object3D[]).filter((o) => (o as THREE.InstancedMesh).isInstancedMesh) as THREE.InstancedMesh[];
  // OLD: one InstancedMesh per (batch, space), in the space group, culled by its own bounds
  const old: THREE.InstancedMesh[] = [];
  const m4 = new THREE.Matrix4();
  for (const im of batches) {
    const sb = siteBatchOf(im)!;
    const by = new Map<number, number[]>();
    for (let id = 0; id < sb.size; id++) { const s = sb.spaceOfId(id); if (!by.has(s)) by.set(s, []); by.get(s)!.push(id); }
    for (const [s, ids] of by) {
      const o = new THREE.InstancedMesh(im.geometry, im.material, ids.length);
      ids.forEach((id, j) => o.setMatrixAt(j, sb.getMatrixAt(id, m4)));
      o.computeBoundingSphere();
      o.castShadow = im.castShadow;
      o.receiveShadow = im.receiveShadow;
      o.visible = false;
      lv.spaceGroup(s)?.add(o);
      old.push(o);
    }
  }
  const frame = (useOld: boolean) => {
    zero();
    h.tick(1 / 60, 1);
    for (const im of batches) if (useOld) im.visible = false;
    for (const o of old) o.visible = useOld;
    camera.updateMatrixWorld();
    renderer._nodes.nodeFrame.update();
    scene.updateMatrixWorld();
    renderer.render(scene, camera);
    return { ...C };
  };
  const rows: Record<string, Record<string, number>> = {};
  for (const v of views) {
    place(v);
    for (const variant of ['NEW', 'OLD'] as const) {
      for (let i = 0; i < 2; i++) frame(variant === 'OLD');
      rows[`${variant} ${v.name}`] = frame(variant === 'OLD');
    }
  }
  t.diagnostic(`${batches.length} site batches vs ${old.length} per-room InstancedMeshes`);
  for (const [k, r] of Object.entries(rows)) t.diagnostic(`${k.padEnd(24)} level draws main ${r.main} shadow ${r.shadow} (instanced ${r.mainIM} / ${r.shadowIM}); triangles main ${Math.round(r.mainTris)} shadow ${Math.round(r.shadowTris)}`);
  const worst = views.find((v) => v.name.startsWith('room'))!.name;
  const N = rows[`NEW ${worst}`], O = rows[`OLD ${worst}`];
  assert.ok(N.main + N.shadow <= O.main + O.shadow, `${worst}: level draws ${N.main + N.shadow} (new) vs ${O.main + O.shadow} (old)`);
  assert.ok(batches.length < old.length / 3, 'far fewer InstancedMeshes (each one its own shaders)');
  assert.deepEqual(h.errors, []);
});
