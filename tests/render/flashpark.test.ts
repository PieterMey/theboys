// v1.2 flashlight shadow scheduling (env-render). Every shadowed slot keeps shadow.autoUpdate = false; armShadows()
// sets needsUpdate once per drawn frame on assigned slots (+ one last render for a slot that was just parked), so
// several cameras in one frame (main + live mirror + warm reflector) give ONE shadow render per slot. three r186's own
// ShadowNode.updateBefore decides here (only updateShadow is stubbed to count renders).
// castShadow and the light count never change. Shadow camera masks are set once at creation and never change: slot 0
// is your beam's for the page lifetime and alone sees layer 0 + phantom (the presence figure) + detail; teammates'
// slots see layer 0 only, so a phantom caster costs ONE shadow draw per frame (gate P: it was one per shadowed beam).
// v1.2 gate P: High / Ultra shadow your own beam + the 3 best remote beams (nearest, most centred, with hysteresis);
// remote beams reach remoteDistance (their shadow far plane follows).
//   node --test tests/render/flashpark.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as THREE from 'three/webgpu';
import { SHADOW_EMPTY_LAYER, SHADOW_LAYER_MASK, SHADOW_LAYER_MASK_LOCAL, createFlashlightPool, interferenceDim } from '../../apps/client/src/render/flashlights.ts';
import type { FlashCfg } from '../../apps/client/src/render/flashlights.ts';
import { RENDER_LAYERS } from '../../apps/client/src/render/api.ts';
import type { FlashlightInfo } from '../../apps/client/src/render/types.ts';

const CFG: FlashCfg = { angle: 0.62, penumbra: 0.9, decay: 1.6, distance: 28, intensity1: 74, intensity2: 105, color1: '#ffe3bd', color2: '#e4eeff', bias: -0.0004, normalBias: 0.02, shadowRadius: 3, near: 0.12, cone: 0.035, halfRateFar: 8, remoteDistance: 20, shadowHold: 2 };
const beam = (id: string, local = false, pos: [number, number, number] = [0, 1.5, 0], dir: [number, number, number] = [0, 0, -1]): FlashlightInfo => ({ id, pos, dir, on: true, local, tier: 1 });

function setup(shadowed = 6, unshadowed = 0) {
  const scene = new THREE.Scene();
  const cam = new THREE.PerspectiveCamera(70, 1, 0.05, 120);
  const pool = createFlashlightPool(scene, CFG, shadowed, unshadowed, 1024, 10);
  const opts = { activeShadowed: shadowed, volumetric: true, reduceFlicker: false };
  // three's real ShadowNode per shadowed slot; only the actual map render is stubbed (counted)
  const renders = new Map<number, number>();
  const nodes = pool.slots.filter((s) => s.shadowed).map((s, i) => {
    const sn = new THREE.ShadowNode(s.light, s.light.shadow) as unknown as { shadowMap: unknown; updateShadow: (f: unknown) => void; updateBefore: (f: unknown) => void; _depthVersionCached: number };
    sn.shadowMap = { depthTexture: { version: 0 } };
    sn.updateShadow = () => { sn._depthVersionCached = 0; renders.set(i, (renders.get(i) ?? 0) + 1); };
    return sn;
  });
  let frameId = 0;
  /** one drawn frame: N cameras each run every slot's ShadowNode.updateBefore (as the passes / reflector would) */
  const drawFrame = (cams: THREE.Camera[]) => {
    frameId++;
    renders.clear();
    pool.armShadows();
    for (const c of cams) for (const sn of nodes) sn.updateBefore({ renderer: { _isPreCompiling: false }, camera: c, frameId });
    return nodes.map((_, i) => renders.get(i) ?? 0);
  };
  return { scene, cam, pool, opts, drawFrame };
}

const REPO = resolve(import.meta.dirname, '../..');
const masksOf = (pool: ReturnType<typeof setup>['pool']) => pool.slots.map((s) => s.light.shadow.camera.layers.mask);

test('every shadowed slot stays autoUpdate=false; masks set at creation: slot 0 (yours) 0 + phantom + detail, the rest 0', () => {
  const { cam, pool, opts } = setup();
  // before any beam: slot 0 is yours, every other shadowed slot a teammate's
  pool.slots.forEach((s, i) => {
    assert.equal(s.own, i === 0, `slot ${i}: own`);
    assert.equal(s.light.shadow.camera.layers.mask, i === 0 ? SHADOW_LAYER_MASK_LOCAL : SHADOW_LAYER_MASK, `slot ${i}: mask`);
  });
  const masks = masksOf(pool);
  pool.update([beam('p2', false, [0, 1.5, -2]), beam('me', true)], cam, 0, 1 / 60, opts);
  pool.armShadows();
  assert.equal(pool.slots[0].id, 'me', 'your beam sits in your slot (whatever its place in the list)');
  for (const s of pool.slots) {
    assert.equal(s.light.shadow.autoUpdate, false);
    assert.equal(s.light.castShadow, true);
    const L = s.light.shadow.camera.layers;
    assert.ok(L.isEnabled(0), `slot ${s.index}: layer 0`);
    assert.equal(L.isEnabled(RENDER_LAYERS.phantom), s.own, 'phantom (the presence figure): your own beam only');
    assert.equal(L.isEnabled(RENDER_LAYERS.detail), s.own, 'detail casters: your own beam only');
    assert.ok(!L.isEnabled(RENDER_LAYERS.firstPerson) && !L.isEnabled(RENDER_LAYERS.ghost) && !L.isEnabled(RENDER_LAYERS.self) && !L.isEnabled(RENDER_LAYERS.vol));
  }
  assert.deepEqual(masksOf(pool), masks, 'an update never touches a mask');
});

test("teammates' mask is never 'layer 0 alone': three r186's ShadowNode would swap in the rendering camera's mask", () => {
  // node_modules/three/src/nodes/lighting/ShadowNode.js updateShadow(): the rule SHADOW_EMPTY_LAYER sidesteps
  const src = readFileSync(join(REPO, 'node_modules/three/src/nodes/lighting/ShadowNode.js'), 'utf8');
  assert.match(src, /\(\s*shadow\.camera\.layers\.mask\s*&\s*0xFFFFFFFE\s*\)\s*===\s*0\s*\)\s*\{\s*shadow\.camera\.layers\.mask\s*=\s*camera\.layers\.mask/);
  const effective = (shadowMask: number, renderingMask: number) => ((shadowMask & 0xFFFFFFFE) === 0 ? renderingMask : shadowMask);
  const main = (1 << 0) | (1 << RENDER_LAYERS.firstPerson) | (1 << RENDER_LAYERS.detail);
  const mirror = (1 << 0) | (1 << RENDER_LAYERS.ghost) | (1 << RENDER_LAYERS.self) | (1 << RENDER_LAYERS.detail);
  for (const cam of [main, mirror]) {
    const L = new THREE.Layers();
    L.mask = effective(SHADOW_LAYER_MASK, cam);
    assert.equal(L.mask, SHADOW_LAYER_MASK, 'keeps its own mask under every rendering camera');
    for (const k of ['phantom', 'detail', 'firstPerson', 'ghost', 'self', 'vol'] as const) assert.ok(!L.isEnabled(RENDER_LAYERS[k]), k);
  }
  assert.ok(!(Object.values(RENDER_LAYERS) as number[]).includes(SHADOW_EMPTY_LAYER), 'the empty layer is no render layer');
  assert.ok(SHADOW_LAYER_MASK > 0 && SHADOW_LAYER_MASK_LOCAL > 0);
});

test('the presence figure (phantom) and detail casters draw in ONE shadow map per frame, yours; layer-0 casters in all', () => {
  const { cam, pool, opts, drawFrame } = setup(4, 2);
  cam.position.set(0, 1.6, 0);
  cam.updateMatrixWorld();
  const caster = (layer: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.7, 0.3), new THREE.MeshBasicNodeMaterial());
    m.layers.set(layer);
    m.castShadow = true;
    return m;
  };
  const figure = caster(RENDER_LAYERS.phantom), prop = caster(RENDER_LAYERS.detail), wall = caster(0);
  const masks = masksOf(pool);
  // you + 5 teammates, every beam on and within halfRateFar (all 4 shadowed maps render every frame)
  const six = [beam('me', true), ...[1, 2, 3, 4, 5].map((d) => beam(`p${d}`, false, [0.3 * d, 1.5, -d]))];
  const shadowSlots = pool.slots.filter((s) => s.shadowed);
  for (let f = 0; f < 5; f++) {
    pool.update(six, cam, f / 60, 1 / 60, { ...opts, frame: f });
    const r = drawFrame([cam]);
    if (f === 0) continue; // the first frame also flushes the creation-time needsUpdate
    assert.deepEqual(r, [1, 1, 1, 1], `frame ${f}: your map + 3 teammates' maps`);
    // a shadow pass draws an object when object.layers.test(shadow.camera.layers) (and castShadow)
    const drawnBy = (o: THREE.Object3D) => shadowSlots.filter((s, k) => r[k] > 0 && o.layers.test(s.light.shadow.camera.layers)).map((s) => s.id);
    assert.deepEqual(drawnBy(figure), ['me'], `frame ${f}: the figure costs 1 shadow draw (was 4)`);
    assert.deepEqual(drawnBy(prop), ['me'], `frame ${f}: detail casters in your beam only`);
    assert.equal(drawnBy(wall).length, 4, `frame ${f}: layer 0 casts in every beam`);
  }
  assert.deepEqual(masksOf(pool), masks);
});

test("your slot is never a teammate's: parked without your beam, yours again at once; nobody is evicted, masks stay", () => {
  const { cam, pool, opts, drawFrame } = setup(4, 2);
  cam.position.set(0, 1.6, 0);
  cam.updateMatrixWorld();
  const masks = masksOf(pool);
  const mates = [1, 2, 3, 4, 5].map((d) => beam(`p${d}`, false, [0.3 * d, 1.5, -d]));
  // teammates only (a reconnect, a test view): the 3 best take the teammates' shadowed slots, yours stays empty
  pool.update(mates, cam, 0, 1 / 60, opts);
  drawFrame([cam]);
  assert.equal(pool.slots[0].id, null, 'your slot stays parked');
  assert.deepEqual(pool.slots.slice(1, 4).map((s) => s.id).sort(), ['p1', 'p2', 'p3']);
  assert.deepEqual(pool.slots.slice(4).map((s) => s.id).sort(), ['p4', 'p5'], 'the 4th shadow-class beam falls back to a plain slot');
  assert.equal(pool.usedShadowed(), 3);
  pool.update(mates, cam, 0.016, 1 / 60, opts);
  assert.deepEqual(drawFrame([cam]), [0, 1, 1, 1], 'your parked slot sleeps');
  // your beam turns up (last in the list): straight into your slot, every teammate keeps theirs
  const held = pool.slots.map((s) => s.id);
  pool.update([...mates, beam('me', true)], cam, 0.032, 1 / 60, opts);
  assert.equal(pool.slots[0].id, 'me');
  assert.equal(pool.slots[0].local, true);
  for (let i = 1; i < pool.slots.length; i++) assert.equal(pool.slots[i].id, held[i], `slot ${i} keeps ${held[i]}`);
  assert.deepEqual(drawFrame([cam]), [1, 1, 1, 1], 'your map renders in the same frame');
  // a lower preset (2 shadowed): yours + the best teammate; your beam off: it keeps its slot
  pool.update([beam('me', true), ...mates], cam, 0.048, 1 / 60, { ...opts, activeShadowed: 2 });
  assert.equal(pool.slots[0].id, 'me');
  assert.equal(pool.usedShadowed(), 2);
  pool.update([{ ...beam('me', true), on: false }, ...mates], cam, 0.064, 1 / 60, opts);
  assert.equal(pool.slots[0].id, 'me');
  // you leave: one last render of your (now empty) slot; the teammates' slots never take it
  pool.update(mates, cam, 0.08, 1 / 60, opts);
  assert.equal(pool.slots[0].id, null);
  assert.equal(drawFrame([cam])[0], 1, 'one last render of the parked frustum');
  assert.ok(pool.slots.every((s) => !s.own || s.id === null));
  assert.deepEqual(masksOf(pool), masks, 'no mask ever changed');
});

test('Ultra 4 + 2: your beam + the 3 nearest remote beams are shadowed, the 2 farthest use unshadowed slots', () => {
  const { cam, pool, opts } = setup(4, 2);
  cam.position.set(0, 1.6, 0);
  cam.updateMatrixWorld();
  // five teammates ahead of the camera at 2..10 m, all aiming down the view axis
  const six = [beam('me', true, [0, 1.5, 0]), ...[2, 4, 6, 8, 10].map((d) => beam(`p${d}`, false, [0.5, 1.5, -d]))];
  pool.update(six, cam, 0, 1 / 60, opts);
  const shadowed = pool.slots.filter((s) => s.shadowed).map((s) => s.id).sort();
  const plain = pool.slots.filter((s) => !s.shadowed).map((s) => s.id).sort();
  assert.deepEqual(shadowed, ['me', 'p2', 'p4', 'p6']);
  assert.deepEqual(plain, ['p10', 'p8']);
  assert.equal(pool.usedShadowed(), 4);
  assert.equal(pool.slots.length, 6, 'fixed pool: 4 shadowed + 2 unshadowed lights for the page lifetime');
  assert.ok(pool.slots.every((s) => s.light.castShadow === s.shadowed), 'castShadow fixed per slot');
});

test('dark fill beams (automatic mirror warm) take only idle slots: real beams keep theirs, idle maps render once', () => {
  const { cam, pool, opts, drawFrame } = setup(4, 2);
  cam.position.set(0, 1.6, 0);
  cam.updateMatrixWorld();
  const real = [beam('me', true, [0, 1.5, 0]), beam('p2', false, [0.5, 1.5, -3])];
  pool.update(real, cam, 0, 1 / 60, opts);
  drawFrame([cam]);
  const before = pool.slots.map((s) => s.id);
  const fill = Array.from({ length: 4 }, (_, i) => ({ ...beam(`mwarm${i}`, false, [0, 1.5, 0]), on: false }));
  pool.update([...real, ...fill], cam, 0.016, 1 / 60, opts);
  pool.slots.forEach((s, i) => { if (before[i]) assert.equal(s.id, before[i], `slot ${i} keeps ${before[i]}`); });
  assert.deepEqual(drawFrame([cam]), [1, 1, 1, 1], 'every shadowed slot renders its map (the idle ones see the warm proxies)');
  for (const s of pool.slots) if (s.id?.startsWith('mwarm')) assert.equal(s.light.intensity, 0, 'a fill beam never lights anything');
  // the fill ends: the real beams stay, the fill slots render once more (parked) and sleep
  pool.update(real, cam, 0.032, 1 / 60, opts);
  assert.deepEqual(pool.slots.filter((s) => s.shadowed).map((s) => s.id).filter(Boolean).sort(), ['me', 'p2']);
});

test('a centred remote beam outranks an off-axis one at the same distance', () => {
  const { cam, pool, opts } = setup(2, 1);
  cam.position.set(0, 1.6, 0);
  cam.lookAt(0, 1.6, -1);
  cam.updateMatrixWorld();
  // both 3 m to the side: one lights the view centre, the other points away behind the camera
  const into = beam('into', false, [3, 1.5, -1], [-0.95, 0, -0.3]);
  const away = beam('away', false, [-3, 1.5, -1], [-0.3, 0, 0.95]);
  pool.update([beam('me', true), away, into], cam, 0, 1 / 60, opts);
  assert.deepEqual(pool.slots.filter((s) => s.shadowed).map((s) => s.id).sort(), ['into', 'me']);
});

test('hysteresis: two similar beams never swap the shadowed slot every frame', () => {
  const { cam, pool, opts } = setup(2, 1);
  cam.position.set(0, 1.6, 0);
  cam.lookAt(0, 1.6, -1);
  cam.updateMatrixWorld();
  let swaps = 0;
  let holder: string | null = null;
  for (let k = 0; k < 40; k++) {
    // A and B trade the nearer spot by 0.3 m every frame (inside the 2 m hold)
    const da = 4 + (k % 2 ? 0.3 : -0.3), db = 4 + (k % 2 ? -0.3 : 0.3);
    pool.update([beam('me', true), beam('A', false, [0.6, 1.5, -da]), beam('B', false, [-0.6, 1.5, -db])], cam, k / 60, 1 / 60, opts);
    const h = pool.slots.find((s) => s.shadowed && s.id !== 'me')?.id ?? null;
    if (holder !== null && h !== holder) swaps++;
    holder = h;
  }
  assert.equal(swaps, 0, 'no flip-flop');
  // a clearly better beam (much nearer) still takes the slot
  pool.update([beam('me', true), beam('A', false, [0.6, 1.5, -12]), beam('B', false, [-0.6, 1.5, -1.5])], cam, 1, 1 / 60, opts);
  pool.update([beam('me', true), beam('A', false, [0.6, 1.5, -12]), beam('B', false, [-0.6, 1.5, -1.5])], cam, 1.02, 1 / 60, opts);
  assert.equal(pool.slots.find((s) => s.shadowed && s.id !== 'me')?.id, 'B');
});

test('ranges by role: your beam reaches distance, teammates reach remoteDistance; the shadow far plane follows', () => {
  const { cam, pool, opts } = setup(4, 2);
  const six = Array.from({ length: 6 }, (_, i) => beam(`p${i}`, i === 0, [0, 1.5, -i]));
  pool.update(six, cam, 0, 1 / 60, opts);
  for (const s of pool.slots) {
    assert.equal(s.light.distance, s.local ? 28 : 20, `${s.id}`);
    if (!s.shadowed) continue;
    s.light.shadow.updateMatrices(s.light);
    assert.equal((s.light.shadow.camera as THREE.PerspectiveCamera).far, s.local ? 28 : 20, 'far = range');
  }
  const b = pool.beams();
  assert.equal(b.find((x) => x.local)!.range, 28);
  assert.ok(b.filter((x) => !x.local).every((x) => x.range === 20));
  assert.equal(pool.beams(), b, 'one beams() array per frame');
  pool.update(six, cam, 0.016, 1 / 60, opts);
  assert.notEqual(pool.beams(), b, 'rebuilt after the next update');
});

test('3 cameras in one frame (main + mirror + warm reflector) give 1 shadow render per assigned slot', () => {
  const { cam, pool, opts, drawFrame } = setup();
  const mirrorCam = cam.clone();
  const warmCam = cam.clone();
  const six = Array.from({ length: 6 }, (_, i) => beam(`p${i}`, i === 0));
  pool.update(six, cam, 0, 1 / 60, opts);
  assert.deepEqual(drawFrame([cam, mirrorCam, warmCam]), [1, 1, 1, 1, 1, 1]);
  pool.update(six, cam, 0.016, 1 / 60, opts);
  assert.deepEqual(drawFrame([cam, mirrorCam, warmCam]), [1, 1, 1, 1, 1, 1], 'again next frame');
  // a frame the draw gate skipped (no armShadows, no render): nothing renders, nothing is lost
  pool.update(six, cam, 0.032, 1 / 60, opts);
  pool.update(six, cam, 0.048, 1 / 60, opts);
  assert.deepEqual(drawFrame([cam, mirrorCam]), [1, 1, 1, 1, 1, 1]);
});

test('one beam (the menu backdrop): 5 parked slots render their empty frustum once, then sleep', () => {
  const { cam, pool, opts, drawFrame } = setup();
  const lightsBefore = pool.slots.map((s) => s.light);
  pool.update(Array.from({ length: 6 }, (_, i) => beam(`warm${i}`, i === 0)), cam, 0, 1 / 60, opts);
  drawFrame([cam]);
  pool.update([beam('me', true)], cam, 0.016, 1 / 60, opts);
  assert.deepEqual(drawFrame([cam]), [1, 1, 1, 1, 1, 1], 'the parked slots render once more (empty frustum)');
  pool.update([beam('me', true)], cam, 0.032, 1 / 60, opts);
  assert.deepEqual(drawFrame([cam]), [1, 0, 0, 0, 0, 0], 'then only the active slot renders');
  assert.ok(pool.slots.every((s) => s.light.castShadow === true), 'castShadow never toggles');
  assert.deepEqual(pool.slots.map((s) => s.light), lightsBefore, 'same lights');
});

test('a teammate turns up: the slot renders its map in the same frame; leaves: one last render', () => {
  const { cam, pool, opts, drawFrame } = setup();
  pool.update([beam('me', true)], cam, 0, 1 / 60, opts);
  drawFrame([cam]);
  pool.update([beam('me', true)], cam, 0.016, 1 / 60, opts);
  drawFrame([cam]);
  pool.update([beam('me', true), beam('p2')], cam, 0.032, 1 / 60, opts);
  assert.deepEqual(drawFrame([cam]), [1, 1, 0, 0, 0, 0]);
  pool.update([beam('me', true)], cam, 0.048, 1 / 60, opts);
  assert.deepEqual(drawFrame([cam]), [1, 1, 0, 0, 0, 0], 'parked: one last render');
  pool.update([beam('me', true)], cam, 0.064, 1 / 60, opts);
  assert.deepEqual(drawFrame([cam]), [1, 0, 0, 0, 0, 0]);
});

test('parkShadows:false (?rdebug=shadowall) renders every slot every frame; a lower preset parks the unused slots', () => {
  const { cam, pool, opts, drawFrame } = setup();
  pool.update([], cam, 0, 1 / 60, { ...opts, parkShadows: false });
  assert.deepEqual(drawFrame([cam, cam.clone()]), [1, 1, 1, 1, 1, 1]);
  const six = Array.from({ length: 6 }, (_, i) => beam(`p${i}`, i === 0));
  pool.update(six, cam, 0.016, 1 / 60, { ...opts, activeShadowed: 4 });
  drawFrame([cam]);
  pool.update(six, cam, 0.032, 1 / 60, { ...opts, activeShadowed: 4 });
  assert.deepEqual(drawFrame([cam]), [1, 1, 1, 1, 0, 0]);
});

test('half-rate remote shadows beyond halfRateFar: every other frame, position and target frozen with the map', () => {
  const { cam, pool, opts, drawFrame } = setup(2, 0);
  cam.position.set(0, 1.6, 0);
  const far = beam('p2', false, [20, 1.5, 0]);
  pool.update([beam('me', true), far], cam, 0, 1 / 60, { ...opts, frame: 0 });
  assert.deepEqual(drawFrame([cam]), [1, 1], 'first frame of an assignment always renders');
  const moved = { ...far, pos: [21, 1.5, 0] as [number, number, number] };
  pool.update([beam('me', true), moved], cam, 0.016, 1 / 60, { ...opts, frame: 1 });
  assert.deepEqual(drawFrame([cam]), [1, 0], 'odd frame: the far remote map is skipped');
  assert.equal(pool.slots[1].light.position.x, 20, 'frozen with its shadow');
  pool.update([beam('me', true), moved], cam, 0.032, 1 / 60, { ...opts, frame: 2 });
  assert.deepEqual(drawFrame([cam]), [1, 1]);
  assert.equal(pool.slots[1].light.position.x, 21);
  // near remote beams stay full rate
  const near = beam('p3', false, [3, 1.5, 0]);
  pool.update([beam('me', true), near], cam, 0.048, 1 / 60, { ...opts, frame: 3 });
  pool.update([beam('me', true), near], cam, 0.064, 1 / 60, { ...opts, frame: 5 });
  assert.deepEqual(drawFrame([cam]), [1, 1]);
});

test('beamInterference dims the cookie uniform (never reset mid-interference) and beams() lists lit beams', () => {
  const { cam, pool, opts } = setup(1, 1);
  const t0 = 1000;
  pool.update([beam('me', true), beam('p2')], cam, 0, 1, { ...opts, now: t0 });
  assert.equal(pool.slots[0].flick.value, 1);
  pool.interfere('local', 300, 0.6, t0);
  let minFlick = 1;
  for (let ms = 10; ms < 300; ms += 16) {
    pool.update([beam('me', true), beam('p2')], cam, ms / 1000, 1 / 60, { ...opts, now: t0 + ms });
    minFlick = Math.min(minFlick, pool.slots[0].flick.value);
    assert.ok(pool.slots[0].flick.value >= 0.39 && pool.slots[0].flick.value <= 1);
  }
  assert.ok(minFlick < 0.7, `the beam dims during the interference (min flick ${minFlick})`);
  pool.update([beam('me', true), beam('p2')], cam, 0.4, 1 / 60, { ...opts, now: t0 + 400 });
  assert.equal(pool.slots[0].flick.value, 1, 'restored after ms');
  const b = pool.beams();
  assert.deepEqual(b.map((x) => x.id).sort(), ['me', 'p2']);
  assert.equal(b.find((x) => x.id === 'me')!.local, true);
  assert.ok(Math.abs(b[0].dir[2] + 1) < 1e-6);
  // reduceFlicker: a smooth dip, no stutter
  const it = { who: 'local', t0: 0, ms: 300, depth: 0.6, seed: 3 };
  const smooth = [50, 100, 150, 200].map((ms) => interferenceDim(it, ms, true));
  assert.ok(smooth.every((v) => v >= 0 && v <= 0.6));
});
