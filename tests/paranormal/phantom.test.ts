// Owner: env-paranormal (v1.2), with env-render's flashlight pool. Which passes draw E4's figure meshes. The presence
// (phantom layer, castShadow) is drawn ONLY by your own beam's shadow camera (render's flashlight slot 0, whose mask is
// set once at creation): one shadow draw while it runs instead of one per shadowed beam (gate P: 4 at High / Ultra,
// against E4's +3 budget). Every client that gets the event spawns the figure (the server sends 'presence' to the whole
// crew), and each one shadows it in its own beam only. The silhouette and the mirror figure never cast; the warm
// templates stay hidden (render's warm proxies keep their masks, so the phantom one compiles in your beam's shadow).
//   node --test tests/paranormal/phantom.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { figureMesh, warmTemplates } from '../../apps/client/src/paranormal/figure.ts';
import { createFlashlightPool } from '../../apps/client/src/render/flashlights.ts';
import type { FlashCfg, FlashlightPool } from '../../apps/client/src/render/flashlights.ts';
import { RENDER_LAYERS } from '../../apps/client/src/render/api.ts';
import type { FlashlightInfo } from '../../apps/client/src/render/types.ts';

const CFG: FlashCfg = { angle: 0.62, penumbra: 0.9, decay: 1.6, distance: 24, intensity1: 74, intensity2: 105, color1: '#ffe3bd', color2: '#e4eeff', bias: -0.0004, normalBias: 0.02, shadowRadius: 3, near: 0.12, cone: 0.035, halfRateFar: 8, remoteDistance: 18, shadowHold: 2 };
const beam = (id: string, local: boolean, pos: [number, number, number]): FlashlightInfo => ({ id, pos, dir: [0, 0, -1], on: true, local, tier: 1 });
const logs: string[] = [];
const log = (m: string) => { logs.push(m); };

/** Ultra / High: 4 shadowed + 2 plain slots; you + 5 teammates around you, every beam on. Returns the shadow cameras
 *  that render a map this frame (armShadows) and the main camera with render/index.ts's layers. */
function ultraFrame(): { pool: FlashlightPool; armed: { id: string | null; layers: THREE.Layers }[]; main: THREE.PerspectiveCamera } {
  const scene = new THREE.Scene();
  const pool = createFlashlightPool(scene, CFG, 4, 2, 1024, RENDER_LAYERS.vol);
  const main = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 120);
  main.layers.enable(RENDER_LAYERS.firstPerson);
  main.layers.enable(RENDER_LAYERS.detail);
  main.position.set(0, 1.6, 0);
  main.updateMatrixWorld();
  // the creation-time needsUpdate has been consumed by the first rendered frame
  for (const s of pool.slots) if (s.shadowed) s.light.shadow.needsUpdate = false;
  const six = [beam('me', true, [0.2, 1.4, 0]), ...[1, 2, 3, 4, 5].map((d) => beam(`p${d}`, false, [0.4 * d - 1, 1.5, -d]))];
  pool.update(six, main, 0, 1 / 60, { activeShadowed: 4, volumetric: true, reduceFlicker: false, frame: 0 });
  pool.armShadows();
  const armed = pool.slots.filter((s) => s.shadowed && s.light.shadow.needsUpdate).map((s) => ({ id: s.id, layers: s.light.shadow.camera.layers }));
  return { pool, armed, main };
}

/** three r186: a shadow pass draws a visible object when its layers test the shadow camera's AND castShadow is on */
const shadowPasses = (armed: { id: string | null; layers: THREE.Layers }[], o: THREE.Mesh) =>
  o.visible && o.castShadow ? armed.filter((a) => o.layers.test(a.layers)).map((a) => a.id) : [];

test('the presence figure casts in your own beam only: 1 shadow draw per frame with 6 beams at Ultra (was 4)', () => {
  const { armed, main } = ultraFrame();
  assert.equal(armed.length, 4, 'your map + the 3 best teammates render this frame');
  const presence = figureMesh('phantom', 1, log);
  assert.equal(presence.castShadow, true);
  assert.deepEqual(shadowPasses(armed, presence), ['me'], 'drawn by your beam\'s shadow camera only');
  assert.equal(presence.layers.test(main.layers), false, 'never in the main view (a shadow-only presence)');
});

test('the silhouette and the mirror figure never cast; the silhouette shows in the main view, the mirror figure only in reflections', () => {
  const { armed, main } = ultraFrame();
  const silhouette = figureMesh('dark', 1, log);
  const wet = figureMesh('wet', 0, log);
  assert.deepEqual(shadowPasses(armed, silhouette), []);
  assert.deepEqual(shadowPasses(armed, wet), []);
  assert.equal(silhouette.layers.test(main.layers), true);
  assert.equal(wet.layers.test(main.layers), false);
  assert.equal(wet.layers.isEnabled(RENDER_LAYERS.ghost), true);
});

test('warm templates stay hidden; the phantom one (as a visible warm proxy) compiles in your beam\'s shadow only', () => {
  const { armed } = ultraFrame();
  const g = warmTemplates(log);
  const meshes: THREE.Mesh[] = [];
  g.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
  assert.equal(meshes.length, 3);
  for (const m of meshes) {
    assert.equal(m.visible, false, `${m.name} hidden`);
    assert.deepEqual(shadowPasses(armed, m), [], `${m.name}: no shadow draw at rest`);
    // render's warm proxy: same layer mask + castShadow, visible
    const proxy = new THREE.Mesh(m.geometry, m.material);
    proxy.layers.mask = m.layers.mask;
    proxy.castShadow = m.castShadow;
    const want = m.name === 'para-figure-phantom' ? ['me'] : [];
    assert.deepEqual(shadowPasses(armed, proxy), want, `${m.name} proxy`);
  }
});
