// v1.3 (plan 4b, G3) the pooled flare + flashbulb SpotLights leave the batched light loop while they are dark, in Node
// (no GPU):
// - until the start-up warm-up is over every pooled light stays visible (the scene's lights node builds its SpotLight
//   data node with them); after it, a parked light is invisible, an assigned one visible, a fired flash visible for
//   its pop only;
// - hideParkedLights: false (no DynamicLighting) keeps the v1.2 behaviour: always visible, dark while parked;
// - three's DynamicLightsNode: batched lights change only the per-type count (a uniform), never the cache key that
//   picks a program, once the type has a data node or another light of the type stays visible (the fixtures'
//   sentinel). A plain LightsNode keys every light, so there the lights must stay visible.
// Run: node --test tests/gear/lights.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import DynamicLightsNode from 'three/addons/tsl/lighting/DynamicLightsNode.js';
import { emptyInteractionState } from '../../packages/shared/src/interactables.ts';
import type { InteractionState } from '../../packages/shared/src/messages/interaction.ts';
import type { VisualOpts } from '../../apps/client/src/interaction/visuals.ts';

// Node has no DOM: the halo and the print atlas draw on a do-nothing canvas (every property a no-op returning it)
const ctx2d: object = new Proxy(function stub() { /* no-op */ }, { get: () => () => ctx2d, set: () => true, apply: () => ctx2d });
(globalThis as unknown as { document: unknown }).document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }) };
const V = await import('../../apps/client/src/interaction/visuals.ts');

const spaceAt = (x: number) => (x < 0 ? -1 : Math.floor(x / 4));
function rig(cfg: { hideParkedLights?: boolean } = {}) {
  const scene = new THREE.Scene();
  const v = V.createVisuals(scene, { propModels: false, itemModels: true, ...cfg });
  const st: InteractionState = emptyInteractionState();
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 100);
  const o: VisualOpts = {
    camera, activeType: null, showViewModel: false, targetItem: null, targetPos: null, thrown: [], serverNow: 0, radioTx: false, dt: 0.016,
    version: 1, layoutRef: { id: 'L1' }, visibleSpaces: null, spaceAt,
  };
  const root = scene.getObjectByName('interaction')!;
  const lights = () => root.children.filter((c) => (c as THREE.Light).isLight) as THREE.SpotLight[];
  const flareLights = () => lights().filter((l) => l.name.startsWith('flare-light-'));
  const flash = () => lights().find((l) => l.name === 'flashbulb-light')!;
  return { scene, v, st, o, root, lights, flareLights, flash };
}
/** the warm set sees `n` main-camera frames, then 0.5 s passes */
async function endWarm(r: ReturnType<typeof rig>): Promise<void> {
  const hook = r.root.getObjectByName('ix-warm')?.getObjectsByProperty('name', 'ix-warm-proxy').find((m) => m.castShadow) as THREE.Mesh | undefined;
  const drawn = () => (hook?.onBeforeRender as unknown as ((a: unknown, s: unknown, c: THREE.Camera) => void) | undefined)?.(null, r.scene, r.o.camera);
  for (let i = 0; i < 4; i++) { drawn(); r.v.update(r.st, r.o); }
  await new Promise((res) => setTimeout(res, 520));
  drawn();
  r.v.update(r.st, r.o);
  assert.equal(r.v.drawStats().warm, false, 'the warm-up is over');
}
const vis = (ls: THREE.Light[]) => ls.map((l) => l.visible);

test('parked flare and flashbulb lights stay visible through the warm-up, then leave the loop', async () => {
  const r = rig();
  assert.equal(r.lights().length, 3, 'two flare lights and the flashbulb light, created once');
  assert.ok(r.lights().every((l) => !l.castShadow), 'all unshadowed (batched)');
  r.v.update(r.st, r.o);
  assert.deepEqual(vis(r.lights()), [true, true, true], 'visible (dark) during the warm-up');
  assert.ok(r.lights().every((l) => l.intensity === 0));
  await endWarm(r);
  assert.deepEqual(vis(r.lights()), [false, false, false], 'parked lights are out of the loop once the warm-up is over');
  const info = (r.root.userData as { ixDebug: { lights(): { settled: boolean; hide: boolean; list: { visible: boolean }[] } } }).ixDebug.lights();
  assert.equal(info.settled, true);
  assert.equal(info.hide, true);
  assert.equal(info.list.filter((l) => l.visible).length, 0);
});

test('a burning flare gets a visible light; it leaves the loop again when the flare is gone or out of view', async () => {
  const r = rig();
  r.v.update(r.st, r.o);
  await endWarm(r);
  r.st.flares = { f1: { p: [1.5, 0.04, 1], until: 60_000 } };
  r.o.version = 2;
  r.v.update(r.st, r.o);
  const fl = r.flareLights();
  assert.deepEqual(vis(fl).sort(), [false, true], 'one light for one flare, the other stays out');
  const on = fl.find((l) => l.visible)!;
  assert.ok(on.intensity > 0, 'lit');
  assert.ok(Math.abs(on.position.x - 1.5) < 1e-6 && Math.abs(on.position.z - 1) < 1e-6, 'over the flare');
  // a second flare: both lights in the loop
  r.st.flares.f2 = { p: [2.5, 0.04, 2], until: 60_000 };
  r.o.version = 3;
  r.v.update(r.st, r.o);
  assert.deepEqual(vis(fl), [true, true]);
  // the second flare's space leaves the view: its light parks (dark and out)
  r.st.flares.f2 = { p: [9.5, 0.04, 2], until: 60_000 };
  r.o.version = 4;
  r.o.visibleSpaces = new Set([0]);
  r.v.update(r.st, r.o);
  assert.deepEqual(vis(fl).sort(), [false, true], 'a flare behind a wall lights nothing here');
  assert.equal(fl.filter((l) => !l.visible).every((l) => l.intensity === 0), true);
  // both gone
  r.st.flares = {};
  r.o.version = 5;
  r.v.update(r.st, r.o);
  assert.deepEqual(vis(fl), [false, false]);
  assert.ok(fl.every((l) => l.intensity === 0));
  assert.equal(r.flash().visible, false, 'the flashbulb light never joined');
});

test('a flashbulb flash: visible for its pop only', async () => {
  const r = rig();
  r.v.update(r.st, r.o);
  await endWarm(r);
  r.v.flash([1, 1.5, 1], [0, 0, 1]);
  assert.equal(r.flash().visible, true);
  assert.equal(r.flash().intensity, 260);
  r.o.dt = 0.1;
  r.v.update(r.st, r.o);
  assert.equal(r.flash().visible, true, 'mid pop');
  for (let i = 0; i < 5; i++) r.v.update(r.st, r.o);
  assert.equal(r.flash().intensity, 0, 'faded out (~0.35 s)');
  assert.equal(r.flash().visible, false, 'and out of the loop');
  assert.ok(r.flareLights().every((l) => !l.visible));
});

test('hideParkedLights: false keeps every pooled light visible (and dark while parked)', async () => {
  const r = rig({ hideParkedLights: false });
  r.v.update(r.st, r.o);
  await endWarm(r);
  assert.deepEqual(vis(r.lights()), [true, true, true]);
  r.v.flash([1, 1.5, 1], [0, 0, 1]);
  r.o.dt = 0.2;
  for (let i = 0; i < 4; i++) r.v.update(r.st, r.o);
  assert.equal(r.flash().intensity, 0);
  assert.equal(r.flash().visible, true, 'stays in the light set');
});

test("three's DynamicLightsNode: batched spots leaving the list change no cache key (the program), only the count", () => {
  const spot = (name: string, shadow = false) => { const l = new THREE.SpotLight(0xffffff, 0, 10); l.name = name; l.castShadow = shadow; return l; };
  const fixtureSentinel = spot('fixture-sentinel');
  const pooled = [spot('flare-light-0'), spot('flare-light-1'), spot('flashbulb-light')];
  const beam = spot('beam-shadowed', true);
  const hemi = new THREE.HemisphereLight();
  const node = new DynamicLightsNode({ maxSpotLights: 16 });
  const key = (ls: THREE.Light[]) => { node.setLights(ls); return node.customCacheKey(); };
  const all = key([hemi, beam, fixtureSentinel, ...pooled]);
  assert.equal(key([hemi, beam, fixtureSentinel]), all, 'the pooled lights hidden: the same key (a sentinel spot keeps the type)');
  assert.equal(key([hemi, beam, fixtureSentinel, pooled[0]!]), all, 'one flare lit: the same key');
  // no other batched spot visible and no SpotLight data node yet: the type would leave the key (why the pooled lights
  // stay visible until the warm-up has built the scene's materials)
  assert.notEqual(key([hemi, beam]), all);
  // once a SpotLight data node exists (built with the lights visible) the type stays in the key for good
  (node as unknown as { _dataNodes: Map<string, unknown> })._dataNodes.set('SpotLight', { setLights() { return this; } });
  assert.equal(key([hemi, beam]), all, 'with the data node: the same key even with every spot hidden');
  // a shadowed light is keyed by itself: toggling one would recompile (the plan never toggles castShadow)
  assert.notEqual(key([hemi, fixtureSentinel, ...pooled]), all);
  // the plain LightsNode keys every light: hiding pooled lights there would change programs (hideParkedLights: false)
  const plain = new THREE.LightsNode();
  const pkey = (ls: THREE.Light[]) => { plain.setLights(ls); return plain.customCacheKey(); };
  assert.notEqual(pkey([fixtureSentinel, ...pooled]), pkey([fixtureSentinel]));
});
