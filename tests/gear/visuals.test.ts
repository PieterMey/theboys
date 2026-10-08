// v1.2 (G3) item visuals in Node (no GPU): the gate-P draw budget and the v1.2 item models.
// - itemModels off (v1.2.0): every model is one opaque draw (+ one clear draw for glass) on the two shared item
//   materials and keeps the exact shape of the v1.2 multi-mesh original (bounding boxes recorded before the merge);
// - itemModels on: every visual key (salvage and curios by name, the rest by type) is its own modelled object, never a
//   box, one opaque draw (+ one clear), non-indexed on one attribute layout, standing on y = 0;
// - only models of 0.3 m or more in height cast (v1.2.0: ITEM_CASTS by longest side); the view model never casts;
// - real models are plain meshes sharing the template's geometry and material, rest-posed before grounding, clipped
//   (the gas mask hose), fitted (an unscaled build), bronzed; placed items rebuild when their model loads, and the warm
//   set re-arms once per new material layout;
// - drawer contents shrink to the open part and sit side by side; tiny salvage grows to 0.10 m; bottles lie centred;
// - world items in spaces the camera cannot see are hidden; materials compact to the visible spaces; a new visible set
//   with the same members, or a state version without a change, uploads nothing;
// - the pre-warm is a handful of microscopic meshes with one shadow caster and ends after 3 drawn frames AND 0.5 s;
// - targeting rebuilds its candidate list only when the state version changes and aims tall models at their middle.
// Run: node --test tests/gear/visuals.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { emptyInteractionState, LOOT_NAMES, LOOT_TIER_TYPES } from '../../packages/shared/src/interactables.ts';
import { CURIOS, MATERIAL_TYPES } from '../../packages/shared/src/catalog.ts';
import { generateFacility } from '../../packages/shared/src/procgen/index.ts';
import { containersOf } from '../../packages/shared/src/procgen/containers.ts';
import type { ContainerInfo } from '../../packages/shared/src/procgen/containers.ts';
import type { InteractionState, ItemState } from '../../packages/shared/src/messages/interaction.ts';
import type { VisualOpts } from '../../apps/client/src/interaction/visuals.ts';

// Node has no DOM: the halo and the print atlas draw on a do-nothing canvas (every property a no-op returning it)
const ctx2d: object = new Proxy(function stub() { /* no-op */ }, { get: () => () => ctx2d, set: () => true, apply: () => ctx2d });
(globalThis as unknown as { document: unknown }).document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }) };
const V = await import('../../apps/client/src/interaction/visuals.ts');
const { pick, candidates } = await import('../../apps/client/src/interaction/targeting.ts');

/** solid (non-additive) bounding boxes of the v1.2 models before the merge: [min xyz, max xyz] (m) */
const BEFORE: Record<string, number[]> = {
  "bottle": [-0.041, 0, -0.042, 0.041, 0.31, 0.042], "crowbar": [-0.015, 0, -0.355, 0.015, 0.102, 0.361],
  "glowstick": [-0.041, 0.001, -0.086, 0.041, 0.023, 0.086], "glowstick:lit": [-0.011, 0.001, -0.086, 0.011, 0.023, 0.086],
  "medkit": [-0.15, 0, -0.1, 0.15, 0.152, 0.1], "walkie": [-0.031, 0, -0.017, 0.031, 0.24, 0.02],
  "airhorn": [-0.044, 0, -0.045, 0.044, 0.23, 0.045], "keycard": [-0.043, 0, -0.027, 0.043, 0.004, 0.027],
  "badge": [-0.035, 0.001, -0.05, 0.035, 0.006, 0.05], "flashlight_pro": [-0.03, -0.01, -0.105, 0.03, 0.05, 0.121],
  "flare": [-0.052, 0, -0.13, 0.052, 0.03, 0.105], "flare.lit": [-0.022, -0.002, -0.13, 0.022, 0.042, 0.131],
  "sensor": [-0.079, 0, -0.08, 0.079, 0.15, 0.08], "sensor.armed": [-0.079, 0, -0.08, 0.079, 0.15, 0.08],
  "syringe": [-0.015, -0.003, -0.068, 0.015, 0.027, 0.1], "charm": [-0.022, 0.001, -0.047, 0.022, 0.046, 0.081],
  "loot.idol": [-0.09, 0, -0.09, 0.09, 0.386, 0.09], "battery": [-0.036, 0, -0.018, 0.036, 0.066, 0.018],
  "lockpick": [-0.108, 0, -0.023, 0.05, 0.026, 0.023], "masterkey": [-0.043, 0, -0.027, 0.043, 0.005, 0.027],
  "soles": [-0.083, -0.001, -0.08, 0.083, 0.045, 0.08], "nvg": [-0.055, 0, -0.085, 0.055, 0.052, 0.046],
  "flashbulb": [-0.044, 0, -0.012, 0.044, 0.105, 0.039], "loot.curio": [-0.066, 0, -0.066, 0.066, 0.112, 0.066],
  "page": [-0.074, 0.004, -0.105, 0.074, 0.01, 0.105], "mat.scrap": [-0.096, -0.005, -0.073, 0.101, 0.054, 0.095],
  "mat.wiring": [-0.059, 0.002, -0.058, 0.088, 0.034, 0.058], "mat.chem": [-0.034, 0, -0.034, 0.093, 0.13, 0.048],
  "mat.optics": [-0.033, 0, -0.046, 0.086, 0.068, 0.045], "mat.cells": [-0.043, -0.001, -0.025, 0.043, 0.027, 0.025],
  "mat.relic": [-0.036, 0, -0.036, 0.036, 0.116, 0.036], "mat.pouch": [-0.085, -0.013, -0.078, 0.085, 0.127, 0.078],
  "loot.small": [-0.07, 0, -0.056, 0.07, 0.098, 0.056], "loot.medium": [-0.13, 0, -0.104, 0.13, 0.182, 0.104],
  "loot.heavy": [-0.23, 0, -0.184, 0.23, 0.322, 0.184],
};
const LAYOUT = ['color', 'ixe', 'ixs', 'normal', 'position', 'uv'];

const meshesOf = (o: THREE.Object3D): THREE.Mesh[] => {
  const out: THREE.Mesh[] = [];
  o.traverse((c) => { if ((c as THREE.Mesh).isMesh) out.push(c as THREE.Mesh); });
  return out;
};
const additive = (m: THREE.Mesh) => (m.material as THREE.Material).blending === THREE.AdditiveBlending;
const trisOf = (m: THREE.Mesh) => (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position!.count) / 3;
const solidBox = (o: THREE.Object3D): THREE.Box3 => {
  o.updateMatrixWorld(true);
  const b = new THREE.Box3();
  for (const m of meshesOf(o)) if (!additive(m)) b.union(new THREE.Box3().setFromObject(m, true));
  return b;
};

test('v1.2.0 models (itemModels off): one opaque draw (+ one clear) on the shared item materials, the same shape as before the merge', () => {
  const solid = V.itemMaterial(false), clear = V.itemMaterial(true);
  for (const [key, bb] of Object.entries(BEFORE)) {
    const [type, lit] = key.split(':');
    const grp = V.buildItemModel(type!, { lit: lit === 'lit', legacy: true });
    grp.updateMatrixWorld(true);
    const ms = meshesOf(grp);
    const body = ms.filter((m) => m.material === solid && m.name !== 'led');
    const glass = ms.filter((m) => m.material === clear);
    const halos = ms.filter(additive);
    assert.equal(body.length, 1, `${key}: one opaque body`);
    assert.ok(glass.length <= 1, `${key}: at most one clear mesh`);
    assert.ok(halos.length <= 1, `${key}: at most one halo draw`);
    for (const m of ms) assert.ok(m.material === solid || m.material === clear || additive(m), `${key}: ${m.name} on a shared material`);
    const box = solidBox(grp);
    const got = [...box.min.toArray(), ...box.max.toArray()];
    got.forEach((v, i) => assert.ok(Math.abs(v - bb[i]!) <= 0.0015, `${key}: bbox[${i}] ${v.toFixed(4)} vs ${bb[i]} before the merge`));
    // the geometry carries the surface (colour + roughness / metalness + emissive, the atlas uv) per vertex
    for (const m of [...body, ...glass]) for (const a of LAYOUT) assert.ok(m.geometry.getAttribute(a), `${key}: ${a}`);
  }
  // a world walkie has its LED merged; the view model keeps a separate one that blinks
  assert.equal(V.buildItemModel('walkie', { legacy: true }).getObjectByName('led'), undefined);
  assert.ok(V.buildItemModel('walkie', { vm: true, legacy: true }).getObjectByName('led'));
  assert.ok(V.buildItemModel('sensor.armed', { legacy: true }).getObjectByName('led'), 'an armed sensor blinks');
  // v1.2.0 salvage is a box (12 triangles): the look the flag restores
  assert.equal(trisOf(meshesOf(V.buildItemModel('loot.small', { name: 'Pocket watch', legacy: true }))[0]!), 12);
});

test('v1.2 item models: every visual key is its own modelled object (never a box), one opaque draw + at most one clear, on y = 0', () => {
  const solid = V.itemMaterial(false), clear = V.itemMaterial(true);
  const bodies = new Map<THREE.BufferGeometry, string>();
  const samples = V.itemSamples();
  assert.ok(samples.length >= 65, `${samples.length} visual keys`);
  for (const s of samples) {
    const grp = V.buildItemModel(s.type, { name: s.name, glb: false });
    assert.equal(grp.userData.key, s.key, `${s.type} '${s.name}' -> ${s.key}`);
    const ms = meshesOf(grp);
    const body = ms.filter((m) => m.material === solid && m.name !== 'led');
    const glass = ms.filter((m) => m.material === clear);
    assert.equal(body.length, 1, `${s.key}: one opaque body`);
    assert.ok(glass.length <= 1, `${s.key}: at most one clear mesh`);
    assert.ok(ms.filter(additive).length <= 1, `${s.key}: at most one halo`);
    for (const m of [...body, ...glass]) {
      assert.deepEqual(Object.keys(m.geometry.attributes).sort(), LAYOUT, `${s.key}: one attribute layout`);
      assert.equal(m.geometry.index, null, `${s.key}: non-indexed (one node build for every procedural model)`);
    }
    const tris = body.reduce((a, m) => a + trisOf(m), 0);
    if (/^(s\.|c\.|loot\.)/.test(s.key)) assert.ok(tris > 60, `${s.key}: a modelled object, not a box (${tris} triangles)`);
    const prev = bodies.get(body[0]!.geometry);
    assert.ok(!prev, `${s.key}: its own model (shares one with ${prev})`);
    bodies.set(body[0]!.geometry, s.key);
    const b = solidBox(grp), sz = b.getSize(new THREE.Vector3());
    assert.ok(b.min.y > -0.0125, `${s.key}: stands on the floor (min y ${b.min.y.toFixed(4)})`);
    const L = Math.max(sz.x, sz.y, sz.z);
    assert.ok(L > 0.04 && L < 0.75, `${s.key}: plausible size ${sz.toArray().map((v) => v.toFixed(3)).join(' x ')}`);
    const us = grp.userData.size as THREE.Vector3;
    assert.ok(us && us.y > 0, `${s.key}: model size recorded`);
  }
});

test('visual keys: salvage by name (with the safe bonds), curios by name, unknown names fall back to the tier shape', () => {
  const keys: string[] = [];
  LOOT_NAMES.forEach((names, tier) => {
    for (const n of names) {
      const k = V.visualKey({ type: LOOT_TIER_TYPES[tier]!, name: n });
      assert.ok(k.startsWith('s.'), `${n} -> ${k}`);
      keys.push(k);
    }
  });
  assert.equal(V.visualKey({ type: 'loot.medium', name: 'Company bearer bonds' }), 's.bonds');
  keys.push('s.bonds');
  for (const n of CURIOS) {
    const k = V.visualKey({ type: 'loot.curio', name: n });
    assert.ok(k.startsWith('c.'), `${n} -> ${k}`);
    keys.push(k);
  }
  assert.equal(new Set(keys).size, keys.length, 'one model per name');
  assert.equal(V.visualKey({ type: 'loot.small', name: 'A strange trinket' }), 'loot.small');
  assert.equal(V.visualKey({ type: 'loot.curio', name: 'Something odd' }), 'loot.curio');
  assert.equal(V.visualKey({ type: 'loot.small', name: 'Pocket watch' }, true), 'loot.small', 'v1.2.0: by type');
  assert.equal(V.visualKey({ type: 'crowbar' }), 'crowbar');
});

test('casting by height: 0.30 m or taller casts (a bottle lies down: never), the view model never; v1.2.0 keeps ITEM_CASTS', () => {
  assert.deepEqual([...V.ITEM_CASTS].sort(), ['crowbar', 'loot.heavy', 'loot.idol', 'medkit']);
  let tall = 0;
  for (const s of V.itemSamples()) {
    const grp = V.buildItemModel(s.type, { name: s.name, glb: false });
    const h = (grp.userData.size as THREE.Vector3).y;
    const casters = meshesOf(grp).filter((m) => m.castShadow).length;
    const want = h >= 0.3 && s.key !== 'bottle';
    assert.equal(casters, want ? 1 : 0, `${s.key}: ${h.toFixed(3)} m tall, ${casters} casters`);
    assert.equal(V.castsFor(s.key, false), want, `${s.key}: castsFor`);
    if (want) tall++;
    assert.equal(meshesOf(V.buildItemModel(s.type, { name: s.name, vm: true, glb: false })).filter((m) => m.castShadow).length, 0, `${s.key}: the view model never casts`);
  }
  assert.ok(tall >= 6 && tall <= 16, `${tall} tall models cast`);
  for (const key of Object.keys(BEFORE)) {
    const [type, lit] = key.split(':');
    const casters = meshesOf(V.buildItemModel(type!, { lit: lit === 'lit', legacy: true })).filter((m) => m.castShadow).length;
    assert.equal(casters, V.ITEM_CASTS.has(type!) ? 1 : 0, `v1.2.0 ${key}: ${casters} casters`);
  }
});

// ---------------------------------------------------------------- real models
const phMaterial = (metal = 1) => {
  const m = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, metalness: metal, roughness: 1 });
  m.map = new THREE.Texture(); m.normalMap = new THREE.Texture(); m.roughnessMap = m.metalnessMap = m.aoMap = new THREE.Texture();
  return m;
};
/** a template geometry as the level's buildTemplate leaves it: non-indexed Float32, bottom centre at the origin */
const tplBox = (w: number, h: number, d: number, y0 = 0) => { const gm = new THREE.BoxGeometry(w, h, d).toNonIndexed(); gm.translate(0, y0 + h / 2, 0); return gm; };
const sizeOf = (t: { size: THREE.Vector3 }) => t.size.toArray().map((v) => Math.round(v * 1000) / 1000);

test('real models: plain meshes sharing the template geometry and material, rest pose before grounding, clip, fit, bronze', () => {
  // the shipped crowbar stands upright (0.04 x 0.555 x 0.128): its rest pose lays it on its side, hook flat
  const gm = tplBox(0.04, 0.555, 0.128), mat = phMaterial();
  const t = V.makeItemTemplate('crowbar', 'crowbar', [{ geometry: gm, material: mat }])!;
  assert.deepEqual(sizeOf(t), [0.128, 0.04, 0.555], 'lying on its side, along z');
  V.registerItemTemplate(t);
  try {
    const grp = V.buildItemModel('crowbar');
    const ms = meshesOf(grp);
    assert.equal(ms.length, 1, 'one draw');
    assert.equal(ms[0]!.geometry, gm, 'the template geometry itself (no copy)');
    assert.equal(ms[0]!.material, mat, 'the template material itself');
    assert.equal(ms[0]!.castShadow, false, 'a crowbar lying flat (4 cm) casts nothing');
    assert.equal(grp.userData.glb, 'crowbar');
    const b = solidBox(grp);
    assert.ok(Math.abs(b.min.y) < 1e-6 && Math.abs(b.max.y - 0.04) < 1e-6, `grounded after the rest pose (${b.min.y}..${b.max.y})`);
    assert.ok(Math.abs(b.min.x + b.max.x) < 1e-6 && Math.abs(b.min.z + b.max.z) < 1e-6, 'centred on its spot');
    assert.notEqual(meshesOf(V.buildItemModel('crowbar', { legacy: true }))[0]!.geometry, gm, 'v1.2.0 keeps the procedural crowbar');
    assert.notEqual(meshesOf(V.buildItemModel('crowbar', { glb: false }))[0]!.geometry, gm, 'glb: false = the fallback');
  } finally { V.registerItemTemplate(null, 'crowbar'); }
  // 'flat': an upright pocket watch lies face up; already flat builds stay as they are
  assert.deepEqual(sizeOf(V.makeItemTemplate('s.watch', 'item_pocket_watch', [{ geometry: tplBox(0.058, 0.076, 0.013), material: mat }])!), [0.058, 0.013, 0.076]);
  assert.deepEqual(sizeOf(V.makeItemTemplate('s.watch', 'item_pocket_watch', [{ geometry: tplBox(0.058, 0.013, 0.076), material: mat }])!), [0.058, 0.013, 0.076]);
  // maxLen: an unscaled 0.40 m circuit board fits 0.24 m
  const cb = V.makeItemTemplate('s.circuit', 'item_circuit_board', [{ geometry: tplBox(0.4, 0.078, 0.39), material: mat }])!;
  assert.ok(Math.abs(Math.max(...cb.size.toArray()) - 0.24) < 1e-6, `fitted ${sizeOf(cb)}`);
  // clipTop: the gas mask keeps its face piece, not the 0.8 m hose under it; then it lies face up
  const hose = tplBox(0.04, 0.8, 0.04), face = tplBox(0.21, 0.32, 0.24, 0.8);
  const gmk = V.makeItemTemplate('s.gasmask', 'gas_mask', [{ geometry: mergeTwo(hose, face), material: mat }])!;
  assert.ok(gmk.size.z < 0.36 && gmk.size.y < 0.26, `the hose is gone, lying face up: ${sizeOf(gmk)}`);
  // bronze: a marble (metalness 0) bust gets a bronze copy of its material (same maps: the same layout)
  const marble = phMaterial(0);
  const bu = V.makeItemTemplate('s.bust', 'item_bronze_bust', [{ geometry: tplBox(0.27, 0.515, 0.3), material: marble }])!;
  const bm = bu.meshes[0]!.material as THREE.MeshStandardMaterial;
  assert.notEqual(bm, marble);
  assert.equal(bm.metalness, 1);
  assert.equal(bm.map, marble.map);
  assert.equal(V.materialSignature(bm), V.materialSignature(phMaterial(1)), 'bronze shares the metal layout');
  const baked = phMaterial(1);
  assert.equal(V.makeItemTemplate('s.bust', 'item_bronze_bust', [{ geometry: tplBox(0.27, 0.515, 0.3), material: baked }])!.meshes[0]!.material, baked, 'a baked build stays');
  // material signatures: metal on / off and the side are different layouts, textures by sampler only
  assert.notEqual(V.materialSignature(phMaterial(0)), V.materialSignature(phMaterial(1)));
  const fs = phMaterial(1); fs.side = THREE.FrontSide;
  assert.notEqual(V.materialSignature(fs), V.materialSignature(phMaterial(1)));
  const other = phMaterial(1); other.map = new THREE.Texture();
  assert.equal(V.materialSignature(other), V.materialSignature(phMaterial(1)), 'another texture, the same layout');
});
function mergeTwo(a: THREE.BufferGeometry, b: THREE.BufferGeometry): THREE.BufferGeometry {
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const x = a.getAttribute(name) as THREE.BufferAttribute, y = b.getAttribute(name) as THREE.BufferAttribute;
    const arr = new Float32Array(x.array.length + y.array.length);
    arr.set(x.array as Float32Array, 0); arr.set(y.array as Float32Array, x.array.length);
    out.setAttribute(name, new THREE.BufferAttribute(arr, x.itemSize));
  }
  return out;
}

// ---------------------------------------------------------------- the per-frame visuals
const item = (id: string, type: string, x: number, z: number, extra: Partial<ItemState> = {}): ItemState => ({ id, type, where: 'world', p: [x, 0, z], rot: 0, ...extra } as ItemState);
/** spaces: x < 0 none (-1), then one space per 4 m strip */
const spaceAt = (x: number, _z: number) => (x < 0 ? -1 : Math.floor(x / 4));
function rig(cfg: { itemModels?: boolean; propModels?: boolean } = {}): { scene: THREE.Scene; v: ReturnType<typeof V.createVisuals>; st: InteractionState; o: VisualOpts; root: THREE.Object3D } {
  const scene = new THREE.Scene();
  const v = V.createVisuals(scene, { propModels: false, itemModels: true, ...cfg });
  const st = emptyInteractionState();
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 100);
  const o: VisualOpts = {
    camera, activeType: null, showViewModel: false, targetItem: null, targetPos: null, thrown: [], serverNow: 0, radioTx: false, dt: 0.016,
    version: 1, layoutRef: { id: 'L1' }, visibleSpaces: null, spaceAt,
  };
  return { scene, v, st, o, root: scene.getObjectByName('interaction')! };
}
const groupFor = (root: THREE.Object3D, type: string) => root.children.filter((c) => c.name === `ix:${type}`);
/** let the warm set see `n` main-camera frames, then wait it out */
async function endWarm(scene: THREE.Scene, v: ReturnType<typeof V.createVisuals>, st: InteractionState, o: VisualOpts): Promise<void> {
  const root = scene.getObjectByName('interaction')!;
  const hook = root.getObjectByName('ix-warm')?.getObjectsByProperty('name', 'ix-warm-proxy').find((m) => m.castShadow) as THREE.Mesh | undefined;
  const drawn = () => (hook?.onBeforeRender as unknown as ((r: unknown, s: unknown, c: THREE.Camera) => void) | undefined)?.(null, scene, o.camera);
  for (let i = 0; i < 4; i++) { drawn(); v.update(st, o); }
  await new Promise((r) => setTimeout(r, 520));
  drawn();
  v.update(st, o);
}

test('world items in unseen spaces are hidden; materials compact to the visible spaces; unchanged inputs upload nothing', () => {
  const { v, st, o, root } = rig();
  st.items.b = item('b', 'bottle', 1.5, 1); // space 0
  st.items.c = item('c', 'crowbar', 5.5, 1); // space 1
  st.items.k = item('k', 'keycard', -3, 1); // no space: always drawn
  st.items.j = item('j', 'loot.heavy', 6.5, 2, { name: 'Cryo canister' }); // space 1, 0.64 m tall: casts
  st.items.m1 = item('m1', 'mat.scrap', 1.2, 2);
  st.items.m2 = item('m2', 'mat.scrap', 5.2, 2);
  st.items.m3 = item('m3', 'mat.relic', 6.2, 2);
  o.visibleSpaces = new Set([0]);
  v.update(st, o);
  const [b] = groupFor(root, 'bottle'), [c] = groupFor(root, 'crowbar'), [k] = groupFor(root, 'keycard');
  assert.ok(b && c && k, 'one group per world item');
  assert.equal(b!.visible, true);
  assert.equal(c!.visible, false, 'the crowbar in an unseen space is hidden (no main or shadow draw)');
  assert.equal(k!.visible, true, 'an item outside every space stays drawn');
  assert.deepEqual(v.matStats(), { draws: 1, instances: 1 });
  let ds = v.drawStats();
  assert.equal(ds.items, 4);
  assert.equal(ds.shown, 2);
  assert.equal(ds.maxMeshesPerItem, 1, 'a merged item is one mesh');
  assert.equal(ds.casters, 0, 'nothing tall in view');
  // the crowbar's space comes into view
  o.visibleSpaces = new Set([0, 1]);
  v.update(st, o);
  assert.equal(c!.visible, true);
  assert.deepEqual(v.matStats(), { draws: 2, instances: 3 });
  ds = v.drawStats();
  assert.equal(ds.casters, 1, 'only the cryo canister (0.64 m) casts');
  // the same members in a new set (the camera crossed a cell), and a state version without a visual change: no upload
  const scrap = root.getObjectByName('ix:inst:mat.scrap') as THREE.InstancedMesh;
  const ver0 = scrap.instanceMatrix.version;
  o.visibleSpaces = new Set([1, 0]);
  v.update(st, o);
  o.version = 2;
  v.update(st, o);
  assert.equal(scrap.instanceMatrix.version, ver0, 'no re-upload for an unchanged compaction');
  // a move and a pickup re-sync on the next version (a floor bottle lies on its side, centred on its spot)
  st.items.b = { ...st.items.b!, p: [2.5, 0, 3] };
  delete st.items.k;
  o.version = 3;
  v.update(st, o);
  const bb = solidBox(b!), ctr = bb.getCenter(new THREE.Vector3());
  assert.ok(Math.abs(ctr.x - 2.5) < 0.01 && Math.abs(ctr.z - 3) < 0.01, `the bottle lies centred on its spot (${ctr.x.toFixed(3)}, ${ctr.z.toFixed(3)})`);
  assert.ok(bb.min.y > -0.004 && bb.max.y < 0.1, `and lies down (${bb.min.y.toFixed(3)}..${bb.max.y.toFixed(3)})`);
  assert.equal(groupFor(root, 'keycard').length, 0, 'a picked-up item leaves the scene');
  delete st.items.m2;
  o.version = 4;
  v.update(st, o);
  assert.ok(scrap.instanceMatrix.version > ver0, 'a picked-up material re-uploads its type');
  assert.deepEqual(v.matStats(), { draws: 2, instances: 2 });
  // no visible-space set (no level service): everything is drawn
  o.visibleSpaces = null;
  v.update(st, o);
  assert.equal(c!.visible, true);
});

test('lit glowsticks and burning flares in unseen spaces are hidden; the flare lights only go to visible flares', () => {
  const { v, st, o, root } = rig();
  st.glows.g1 = [1, 0, 1];
  st.glows.g2 = [9, 0, 1];
  st.flares = { f1: { p: [9.5, 0, 1], until: 60_000 } as never };
  o.visibleSpaces = new Set([0]);
  v.update(st, o);
  const glows = groupFor(root, 'glowstick');
  assert.equal(glows.length, 2);
  assert.deepEqual(glows.map((g) => g.visible).sort(), [false, true]);
  assert.equal(groupFor(root, 'flare.lit')[0]!.visible, false);
  const lights = root.children.filter((c) => c.name.startsWith('flare-light-')) as THREE.SpotLight[];
  assert.ok(lights.every((l) => l.intensity === 0), 'a flare behind a wall lights nothing here');
  o.visibleSpaces = new Set([0, 2]);
  v.update(st, o);
  assert.ok(lights.some((l) => l.intensity > 0), 'the flare in view gets a pooled light');
});

test('the pre-warm: a handful of meshes, one shadow caster, gone after 3 drawn frames and 0.5 s', async () => {
  const { scene, v, st, o, root } = rig();
  const warm = root.getObjectByName('ix-warm')!;
  assert.ok(warm, 'warm set present at start-up');
  const draws: THREE.Object3D[] = [];
  warm.traverse((c) => { if ((c as THREE.Mesh).isMesh || (c as THREE.Sprite).isSprite) draws.push(c); });
  assert.ok(draws.length <= 6, `${draws.length} warm draws`);
  assert.ok(!draws.some((c) => (c as THREE.InstancedMesh).isInstancedMesh), 'no instanced proxy (an InstancedMesh warms only its own program)');
  const casters = draws.filter((c) => c.castShadow);
  assert.equal(casters.length, 1, 'one shadow caster (the item depth pipeline)');
  const hook = casters[0] as THREE.Mesh;
  const drawn = (camera: THREE.Camera) => (hook.onBeforeRender as unknown as (r: unknown, s: unknown, c: THREE.Camera) => void)(null, scene, camera);
  v.update(st, o); // not drawn yet
  // a shadow camera's draw is not a drawn frame
  drawn(new THREE.PerspectiveCamera());
  v.update(st, o);
  assert.equal(v.drawStats().warmFrames, 0);
  for (let i = 0; i < 4; i++) { drawn(o.camera); v.update(st, o); }
  assert.equal(v.drawStats().warmFrames, 4);
  assert.ok(root.getObjectByName('ix-warm'), 'still warming: 4 frames but under 0.5 s');
  await new Promise((r) => setTimeout(r, 520));
  drawn(o.camera);
  v.update(st, o);
  assert.equal(root.getObjectByName('ix-warm'), undefined, 'warm set removed');
  assert.equal(v.drawStats().warm, false);
});

test('real models in the world: items rebuild when their model loads, one mesh each; the warm set re-arms once per new layout', async () => {
  const { scene, v, st, o, root } = rig({ propModels: true });
  st.items.a = item('a', 'loot.medium', 1.5, 1, { name: 'Jerrycan' });
  st.items.b = item('b', 'loot.small', 1.8, 1, { name: 'Pocket watch' });
  v.update(st, o);
  await endWarm(scene, v, st, o);
  assert.equal(v.drawStats().warm, false, 'the start-up warm is over');
  const proxies0 = v.drawStats().warmProxies!;
  assert.equal(meshesOf(groupFor(root, 'loot.medium')[0]!)[0]!.material, V.itemMaterial(false), 'procedural until the model loads');
  const can = tplBox(0.36, 0.5, 0.171), mat = phMaterial(1);
  try {
    V.registerItemTemplate(V.makeItemTemplate('s.jerrycan', 'item_jerrycan', [{ geometry: can, material: mat }]));
    v.update(st, o);
    const [a] = groupFor(root, 'loot.medium');
    const ms = meshesOf(a!);
    assert.equal(ms.length, 1);
    assert.equal(ms[0]!.geometry, can, 'rebuilt on the real model');
    assert.equal(ms[0]!.castShadow, true, 'a 0.5 m jerrycan casts');
    let ds = v.drawStats();
    assert.equal(ds.glbShown, 1);
    assert.equal(ds.warm, true, 'a new material layout re-arms the warm set');
    assert.equal(ds.warmProxies, proxies0 + 1, 'one proxy for it');
    assert.equal(ds.maxMeshesPerItem, 1);
    // another model of the same layout (its own material object, other textures): no new proxy
    V.registerItemTemplate(V.makeItemTemplate('s.watch', 'item_pocket_watch', [{ geometry: tplBox(0.058, 0.013, 0.076), material: phMaterial(1) }]));
    v.update(st, o);
    ds = v.drawStats();
    assert.equal(ds.warmProxies, proxies0 + 1, 'the same layout: the proxy already compiled it');
    assert.equal(ds.glbShown, 2);
    // tiny salvage grows to a 0.10 m longest side
    const w = solidBox(groupFor(root, 'loot.small')[0]!).getSize(new THREE.Vector3());
    assert.ok(Math.abs(Math.max(w.x, w.y, w.z) - V.MIN_SALVAGE) < 1e-6, `pocket watch ${w.toArray().map((x) => x.toFixed(3))}`);
    // metal off is another layout: one more proxy
    V.registerItemTemplate(V.makeItemTemplate('mat.relic', 'item_mat_relic', [{ geometry: tplBox(0.109, 0.096, 0.058), material: phMaterial(0) }]));
    v.update(st, o);
    assert.equal(v.drawStats().warmProxies, proxies0 + 2);
    // the relic's instances switch to the real model (a self-lit copy of its material)
    const relic = root.getObjectByName('ix:inst:mat.relic') as THREE.InstancedMesh;
    assert.notEqual(relic.material, V.itemMaterial(false));
    assert.equal((relic.material as THREE.MeshStandardMaterial).map, (V.itemTemplates().get('mat.relic')!.meshes[0]!.material as THREE.MeshStandardMaterial).map);
  } finally {
    for (const k of ['s.jerrycan', 's.watch', 'mat.relic']) V.registerItemTemplate(null, k);
  }
  v.update(st, o);
  assert.equal(meshesOf(groupFor(root, 'loot.medium')[0]!)[0]!.material, V.itemMaterial(false), 'back to the procedural model');
  v.dispose();
});

test('drawer fit: contents shrink to the open part and sit side by side across its width; a bottle lies down', () => {
  let checked = 0;
  for (let seed = 0; seed < 6 && checked < 4; seed++) {
    const L = generateFacility({ seed: `g3-drawers-${seed}`, players: 2, risk: 2 });
    const pickC = (kind: string) => containersOf(L).find((c) => c.kind === kind);
    for (const c of [pickC('desk'), pickC('cabinet'), pickC('tool_chest'), pickC('counter')].filter((x): x is ContainerInfo => !!x)) {
      if (checked >= 4) break;
      const { v, st, o, root } = rig();
      o.layoutRef = L;
      o.spaceAt = () => -1;
      const part = c.parts.find((q) => q.idx === c.main)!;
      const ax = Math.cos(c.rot), az = -Math.sin(c.rot);
      const at = (off: number): [number, number, number] => [part.slot[0] + ax * off, part.slot[1], part.slot[2] + az * off];
      // two contents 0.12 m apart across the width, at the container's yaw, as the server spawns them
      st.items.x = { ...item('x', 'loot.medium', 0, 0, { name: 'Typewriter' }), p: at(-0.06), rot: c.rot };
      st.items.y = { ...item('y', 'bottle', 0, 0), p: at(0.06), rot: c.rot };
      v.update(st, o);
      const w = part.size[0] - 0.04;
      const spans: [number, number][] = [];
      for (const type of ['loot.medium', 'bottle']) {
        const b = solidBox(groupFor(root, type)[0]!);
        const ctr = b.getCenter(new THREE.Vector3()), sz = b.getSize(new THREE.Vector3());
        // the drawer's width / travel axes are world x or z (quarter-turn yaws)
        const alongX = Math.abs(ax) > 0.5;
        const ew = alongX ? sz.x : sz.z, ed = alongX ? sz.z : sz.x;
        const cw = (ctr.x - part.slot[0]) * ax + (ctr.z - part.slot[2]) * az;
        spans.push([cw - ew / 2, cw + ew / 2]);
        assert.ok(Math.abs(cw) + ew / 2 <= w / 2 + 0.006, `${c.kind}: ${type} inside the width (${(Math.abs(cw) + ew / 2).toFixed(3)} <= ${(w / 2).toFixed(3)})`);
        if (part.kind === 'drawer') assert.ok(ed <= part.travel - 0.02 + 0.006, `${c.kind}: ${type} within the travel (${ed.toFixed(3)})`);
        assert.ok(b.min.y >= part.slot[1] - 0.004, `${c.kind}: ${type} on the drawer floor`);
        const hMax = part.kind === 'lid' ? 0.16 : part.kind === 'door' ? 0.45 : Math.max(0.06, part.size[1]) + 0.05;
        assert.ok(sz.y <= hMax + 0.006, `${c.kind}: ${type} not towering over the open part (${sz.y.toFixed(3)} <= ${hMax.toFixed(3)})`);
      }
      spans.sort((a, b) => a[0] - b[0]);
      assert.ok(spans[0]![1] <= spans[1]![0] + 0.006, `${c.kind}: side by side, not through each other (${JSON.stringify(spans.map((s) => s.map((x) => +x.toFixed(3))))})`);
      const bottle = solidBox(groupFor(root, 'bottle')[0]!).getSize(new THREE.Vector3());
      assert.ok(bottle.y < 0.1, `${c.kind}: the bottle lies down (${bottle.y.toFixed(3)} tall)`);
      if (part.kind === 'drawer') assert.ok((Math.abs(ax) > 0.5 ? bottle.z : bottle.x) > (Math.abs(ax) > 0.5 ? bottle.x : bottle.z), `${c.kind}: the bottle lies front to back`);
      // targeting aims at the drawn model's middle (a lying bottle: its diameter)
      const cand = candidates(st, null).find((q) => q.item === 'y')!;
      assert.ok(cand.p[1] - part.slot[1] <= 0.12, 'a low target point in the drawer');
      checked++;
    }
  }
  assert.ok(checked >= 3, `${checked} containers checked`);
});

test('drawer packing: each at its own size while they fit, one shrink factor when they do not; travel and height cap', () => {
  const d = V.DESK_DRAWER;
  const sz = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const radio = { size: sz(0.315, 0.136, 0.261), lying: false, base: 1, rel: 0 };
  const watch = { size: sz(0.058, 0.013, 0.076), lying: false, base: V.MIN_SALVAGE / 0.076, rel: 0 };
  const bottleAlong = { size: sz(0.082, 0.322, 0.084), lying: true, base: 1, rel: Math.PI / 2 };
  const bottleAcross = { ...bottleAlong, rel: 0 };
  assert.equal(V.drawerPack([radio], d.w, d.depth, d.hMax)[0]!.scale, 1, 'a radio set fits a desk drawer as it is');
  const pair = V.drawerPack([radio, watch], d.w, d.depth, d.hMax);
  assert.ok(pair[0]!.scale > 0.85 && pair[0]!.scale < 1, `radio + watch: the radio shrinks a little (${pair[0]!.scale.toFixed(2)})`);
  assert.ok(pair[1]!.off > pair[0]!.off, 'left to right in order');
  const span = (p: { scale: number; off: number }, w: number) => [p.off - (w * p.scale) / 2, p.off + (w * p.scale) / 2];
  const [r0, r1] = span(pair[0]!, 0.315), [w0, w1] = span(pair[1]!, 0.058);
  assert.ok(r0! >= -d.w / 2 - 1e-6 && w1! <= d.w / 2 + 1e-6 && r1! <= w0! + 1e-6, 'inside the width, not overlapping');
  const along = V.drawerPack([radio, bottleAlong], d.w, d.depth, d.hMax), across = V.drawerPack([radio, bottleAcross], d.w, d.depth, d.hMax);
  assert.ok(along[0]!.scale > across[0]!.scale + 0.2, `a bottle lying front to back leaves the width (${along[0]!.scale.toFixed(2)} vs ${across[0]!.scale.toFixed(2)})`);
  // the travel and the height cap a lone item: a 0.6 m projector, a 0.5 m jerrycan
  assert.ok(Math.abs(V.drawerFitScale(sz(0.253, 0.345, 0.603), false, 1, 0, d.w, d.depth, d.hMax) - d.hMax / 0.345) < 1e-9);
  assert.ok(Math.abs(V.drawerFitScale(sz(0.36, 0.5, 0.171), false, 1, 0, d.w, d.depth, d.hMax) - d.hMax / 0.5) < 1e-9);
});

test('targeting and the glint: tall models are aimed at their middle, the ring lies at the foot and opens around them', () => {
  const { v, st, o, root } = rig();
  st.items.t = item('t', 'loot.heavy', 1.5, 1, { name: 'Cryo canister' });
  st.items.s = item('s', 'battery', 2.5, 1);
  v.update(st, o);
  const tall = candidates(st, null).find((c) => c.item === 't')!, small = candidates(st, null).find((c) => c.item === 's')!;
  assert.ok(tall.p[1] > 0.3 && tall.p[1] < 0.34, `the canister's sphere at half its 0.64 m (${tall.p[1].toFixed(3)})`);
  assert.equal(small.p[1], 0.12, 'small things keep the v1.2.0 point');
  o.targetItem = 't';
  o.targetPos = tall.p;
  v.update(st, o);
  const glint = root.children.find((c) => (c as THREE.Mesh).isMesh && (c as THREE.Mesh).geometry?.boundingSphere && c.rotation.x === -Math.PI / 2 && c.visible && !c.name) as THREE.Mesh;
  assert.ok(glint, 'glint shown');
  assert.ok(glint.position.y < 0.05, `at the foot (${glint.position.y.toFixed(3)})`);
  assert.ok(glint.scale.x > 1, 'opened around a 0.25 m canister');
  // v1.2.0 (flag off): the old point and ring
  const r2 = rig({ itemModels: false });
  r2.st.items.t = st.items.t;
  r2.v.update(r2.st, r2.o);
  assert.equal(candidates(r2.st, null).find((c) => c.item === 't')!.p[1], 0.12);
});

test('itemModels off restores the v1.2.0 models: salvage boxes, the old material instances', () => {
  const { v, st, o, root } = rig({ itemModels: false });
  st.items.w = item('w', 'loot.small', 1.5, 1, { name: 'Pocket watch' });
  st.items.m = item('m', 'mat.pouch', 1.2, 2);
  v.update(st, o);
  const [w] = groupFor(root, 'loot.small');
  assert.equal(trisOf(meshesOf(w!)[0]!), 12, 'the v1.2.0 box');
  assert.equal(w!.userData.key, 'loot.small');
  assert.equal(v.drawStats().itemModels, false);
  const pouch = root.getObjectByName('ix:inst:mat.pouch') as THREE.InstancedMesh;
  assert.equal(pouch.geometry, (V.buildItemModel('mat.pouch', { legacy: true }).getObjectByName('body') as THREE.Mesh).geometry);
});

test('a facility-like scatter: draws follow the visible items, one mesh each (two with glass)', () => {
  const { v, st, o } = rig();
  const types = ['bottle', 'bottle', 'medkit', 'crowbar', 'walkie', 'glowstick', 'flare', 'keycard', 'battery', 'lockpick', 'masterkey', 'soles',
    'nvg', 'flashbulb', 'loot.curio', 'page', 'syringe', 'charm', 'airhorn', 'sensor', 'loot.idol', 'battery', 'bottle', 'flare', 'lockpick',
    'glowstick', 'medkit', 'page', 'page', 'flashlight_pro', 'badge', 'loot.small', 'loot.medium', 'loot.heavy', 'loot.medium', 'loot.small'];
  const names: Record<number, string> = { 14: 'Taxidermy owl', 31: 'Hip flask', 32: 'Typewriter', 33: 'Generator coil', 34: 'Company bearer bonds', 35: 'Dog tags' };
  types.forEach((t, i) => { st.items[`i${i}`] = item(`i${i}`, t, (i % 10) * 4 + 1, 1 + Math.floor(i / 10), names[i] ? { name: names[i] } : {}); });
  o.visibleSpaces = new Set([0, 1]);
  v.update(st, o);
  const ds = v.drawStats();
  const inView = types.map((t, i) => ({ t, i })).filter(({ i }) => i % 10 <= 1);
  assert.equal(ds.items, types.length);
  assert.equal(ds.shown, inView.length);
  assert.ok(ds.maxMeshesPerItem <= 2, 'one mesh per item (two with glass)');
  // draws: the shown items' meshes + their halos (the idol) + the warm set excluded + flare lights are not draws
  const expectMax = inView.length * 2 + 2;
  assert.ok(ds.draws <= expectMax, `${ds.draws} draws for ${inView.length} items in view`);
  assert.ok(ds.casters <= inView.filter(({ t, i }) => V.castsFor(V.visualKey({ type: t, name: names[i] }), false)).length, `${ds.casters} casters`);
});

test('thrown projectiles and remote held items: pooled lists in, one merged model each, removed when gone', () => {
  const { v, st, o, root } = rig();
  const list: { id: string; p: [number, number, number]; yaw: number }[] = [{ id: 'thrown:1', p: [1, 1.4, 1], yaw: 0.3 }, { id: 'thrown:flare:2', p: [2, 1.2, 1], yaw: 0 }];
  o.thrown = list;
  v.update(st, o);
  assert.equal(v.drawStats().thrown, 2);
  const bottle = groupFor(root, 'bottle')[0]!;
  assert.ok(Math.abs(bottle.position.y - 1.26) < 1e-6, 'drawn 14 cm under the sampled point');
  const flare = groupFor(root, 'flare.lit')[0]!;
  assert.equal(flare.getObjectByName('halo')!.visible, false, 'a flare in flight has no floor halo');
  // the same pooled view, moved
  list[0]!.p[0] = 1.5;
  v.update(st, o);
  assert.equal(bottle.position.x, 1.5);
  assert.equal(groupFor(root, 'bottle').length, 1, 'no second model for the same id');
  list.length = 1; // the flare landed
  v.update(st, o);
  assert.equal(v.drawStats().thrown, 1);
  assert.equal(groupFor(root, 'flare.lit').length, 0);
  list.length = 0;
  v.update(st, o);
  assert.equal(v.drawStats().thrown, 0);
  // remote players' held items
  const held = [{ pid: 'p2', type: 'crowbar', p: [3, 1, 3] as [number, number, number], yaw: 1 }];
  v.held(held);
  assert.equal(v.drawStats().held, 1);
  held[0]!.type = 'medkit';
  v.held(held);
  assert.equal(v.drawStats().held, 1);
  assert.equal(groupFor(root, 'crowbar').length, 0, 'a switched item is rebuilt');
  assert.equal(groupFor(root, 'medkit').length, 1);
  v.held([]);
  assert.equal(v.drawStats().held, 0);
  assert.equal(groupFor(root, 'medkit').length, 0);
});

test('the view model: salvage and curios in hand by name (activeName, else the one held item of the type), posed, no shadow', () => {
  const { v, st, o, root } = rig();
  st.items.h = { id: 'h', type: 'loot.heavy', where: 'held', holder: 'p1', value: 200, name: 'Generator coil' } as ItemState;
  st.inventories.p1 = ['h', null, null, null];
  st.active.p1 = 0;
  o.activeType = 'loot.heavy';
  o.showViewModel = true;
  v.update(st, o);
  const vm = root.getObjectsByProperty('name', 'ix:loot.heavy')[0]!;
  assert.equal(vm.userData.key, 's.coil', 'looked up in the state');
  assert.ok(vm.scale.x > 0.3 && vm.scale.x < 0.8, `scaled to read in hand (${vm.scale.x.toFixed(2)})`);
  assert.equal(meshesOf(vm).filter((m) => m.castShadow).length, 0);
  o.activeName = 'Safe deposit box';
  v.update(st, o);
  assert.equal(root.getObjectsByProperty('name', 'ix:loot.heavy')[0]!.userData.key, 's.depositbox', 'activeName wins');
  // two players holding the same type, no activeName: the generic tier model (never a wrong name)
  st.items.h2 = { id: 'h2', type: 'loot.heavy', where: 'held', holder: 'p2', value: 200, name: 'Bronze bust' } as ItemState;
  st.inventories.p2 = ['h2', null, null, null];
  st.active.p2 = 0;
  delete o.activeName;
  o.version++;
  v.update(st, o);
  assert.equal(root.getObjectsByProperty('name', 'ix:loot.heavy')[0]!.userData.key, 'loot.heavy');
  // the VM gallery hook (e2e shots): view models side by side
  const dbg = (root.userData as { ixDebug: { gallery(list: { type: string; name?: string }[] | null): number } }).ixDebug;
  assert.equal(dbg.gallery([{ type: 'loot.small', name: 'Hip flask' }, { type: 'crowbar' }, { type: 'mat.wiring' }]), 3);
  assert.equal(dbg.gallery(null), 0);
});

test("item meshes move to render's detail layer (lights and the view model do not), new ones are born there", () => {
  const { v, st, o, root } = rig();
  st.items.b = item('b', 'bottle', 1.5, 1);
  st.items.m = item('m', 'mat.scrap', 1.2, 2);
  o.activeType = 'walkie';
  o.showViewModel = true;
  v.setFirstPersonLayer(14);
  v.update(st, o);
  v.setDetailLayer(15);
  const masks = (pred: (c: THREE.Object3D) => boolean) => {
    const out = new Set<number>();
    root.traverse((c) => { if (pred(c)) out.add(c.layers.mask); });
    return [...out];
  };
  const isDraw = (c: THREE.Object3D) => (c as THREE.Mesh).isMesh || (c as THREE.Sprite).isSprite;
  const inVm = (c: THREE.Object3D) => { for (let p: THREE.Object3D | null = c; p; p = p.parent) if (p.children.some((k) => k.name === 'ix:walkie') && p !== root) return true; return false; };
  assert.deepEqual(masks((c) => isDraw(c) && !inVm(c)), [1 << 15], 'every world mesh on the detail layer');
  assert.deepEqual(masks((c) => (c as THREE.Light).isLight === true), [1], 'lights stay on layer 0');
  assert.deepEqual(masks((c) => isDraw(c) && inVm(c)), [1 << 14], 'the view model stays on the first-person layer');
  st.items.c = item('c', 'crowbar', 2.5, 1);
  st.glows.g = [1, 0, 2];
  o.version = 2;
  v.update(st, o);
  assert.deepEqual(masks((c) => isDraw(c) && !inVm(c)), [1 << 15], 'new items / glows are born on the detail layer');
  v.setDetailLayer(null);
  assert.deepEqual(masks((c) => isDraw(c) && !inVm(c)), [1], 'back to layer 0 without render');
});

test('targeting rebuilds its candidates only when the state version changes', () => {
  const st = emptyInteractionState();
  st.items.a = item('a', 'bottle', 1, 0);
  const base = { st, layout: null, me: 'p1', origin: [0, 1.5, 0] as [number, number, number], dir: [0.55, -0.83, 0] as [number, number, number], reach: 3 };
  const d = Math.hypot(base.dir[0], base.dir[1]);
  base.dir = [base.dir[0] / d, base.dir[1] / d, 0];
  const h1 = pick({ ...base, version: 7 });
  const h2 = pick({ ...base, version: 7 });
  assert.ok(h1 && h2, 'the bottle is targeted');
  assert.equal(h1!.c, h2!.c, 'the same candidate object while the version holds');
  st.items.a = { ...st.items.a!, p: [1.1, 0, 0] };
  const h3 = pick({ ...base, version: 8 });
  assert.notEqual(h3?.c, h1!.c, 'a new version rebuilds');
  assert.equal(h3!.c.p[0], 1.1);
});

test('every material type has a v1.2 instance model on the shared layout', () => {
  for (const t of [...MATERIAL_TYPES, 'mat.pouch']) {
    const body = V.buildItemModel(t, { glb: false }).getObjectByName('body') as THREE.Mesh;
    assert.deepEqual(Object.keys(body.geometry.attributes).sort(), LAYOUT, t);
  }
});
