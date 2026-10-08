// v1.2 (G3) gate-P fix, in Node (no GPU): the item visuals' draw budget.
// - every item model is one opaque draw (+ one clear draw for glass), on the two shared item materials, and keeps the
//   exact shape of the v1.2 multi-mesh original (bounding boxes recorded before the merge);
// - only items of 0.3 m or more cast shadows;
// - world items in spaces the camera cannot see are hidden (and so cast nothing); the material instances compact to
//   the visible spaces; a new visible set with the same members, or a state version without a change, uploads nothing;
// - the pre-warm is a handful of microscopic meshes with one shadow caster and ends after 3 drawn frames AND 0.5 s;
// - targeting rebuilds its candidate list only when the state version changes.
// Run: node --test tests/gear/visuals.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { emptyInteractionState } from '../../packages/shared/src/interactables.ts';
import type { InteractionState, ItemState } from '../../packages/shared/src/messages/interaction.ts';
import type { VisualOpts } from '../../apps/client/src/interaction/visuals.ts';

// Node has no DOM: the halo texture draws on a stub canvas
(globalThis as unknown as { document: unknown }).document ??= {
  createElement: () => ({ width: 0, height: 0, getContext: () => ({ createRadialGradient: () => ({ addColorStop() {} }), fillRect() {}, fillStyle: '' }) }),
};
const V = await import('../../apps/client/src/interaction/visuals.ts');
const { pick } = await import('../../apps/client/src/interaction/targeting.ts');

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

const meshesOf = (o: THREE.Object3D): THREE.Mesh[] => {
  const out: THREE.Mesh[] = [];
  o.traverse((c) => { if ((c as THREE.Mesh).isMesh) out.push(c as THREE.Mesh); });
  return out;
};
const additive = (m: THREE.Mesh) => (m.material as THREE.Material).blending === THREE.AdditiveBlending;

test('every model is one opaque draw (+ one clear) on the shared item materials, the same shape as before the merge', () => {
  const solid = V.itemMaterial(false), clear = V.itemMaterial(true);
  for (const [key, bb] of Object.entries(BEFORE)) {
    const [type, lit] = key.split(':');
    const grp = V.buildItemModel(type!, { lit: lit === 'lit' });
    grp.updateMatrixWorld(true);
    const ms = meshesOf(grp);
    const body = ms.filter((m) => m.material === solid && m.name !== 'led');
    const glass = ms.filter((m) => m.material === clear);
    const halos = ms.filter(additive);
    assert.equal(body.length, 1, `${key}: one opaque body`);
    assert.ok(glass.length <= 1, `${key}: at most one clear mesh`);
    assert.ok(halos.length <= 1, `${key}: at most one halo draw`);
    for (const m of ms) assert.ok(m.material === solid || m.material === clear || additive(m), `${key}: ${m.name} on a shared material`);
    const box = new THREE.Box3();
    for (const m of ms) if (!additive(m)) box.union(new THREE.Box3().setFromObject(m, true));
    const got = [...box.min.toArray(), ...box.max.toArray()];
    got.forEach((v, i) => assert.ok(Math.abs(v - bb[i]!) <= 0.0015, `${key}: bbox[${i}] ${v.toFixed(4)} vs ${bb[i]} before the merge`));
    // the geometry carries the surface (colour + roughness / metalness + emissive) per vertex
    for (const m of [...body, ...glass]) for (const a of ['position', 'normal', 'color', 'ixs', 'ixe']) assert.ok(m.geometry.getAttribute(a), `${key}: ${a}`);
  }
  // a world walkie has its LED merged; the view model keeps a separate one that blinks
  assert.equal(V.buildItemModel('walkie').getObjectByName('led'), undefined);
  assert.ok(V.buildItemModel('walkie', { vm: true }).getObjectByName('led'));
  assert.ok(V.buildItemModel('sensor.armed').getObjectByName('led'), 'an armed sensor blinks');
});

test('only items of 0.3 m or more cast shadows', () => {
  assert.deepEqual([...V.ITEM_CASTS].sort(), ['crowbar', 'loot.heavy', 'loot.idol', 'medkit']);
  for (const key of Object.keys(BEFORE)) {
    const [type, lit] = key.split(':');
    const casters = meshesOf(V.buildItemModel(type!, { lit: lit === 'lit' })).filter((m) => m.castShadow).length;
    assert.equal(casters, V.ITEM_CASTS.has(type!) ? 1 : 0, `${key}: ${casters} casters`);
    if (V.ITEM_CASTS.has(type!)) {
      const b = BEFORE[key]!;
      assert.ok(Math.max(b[3]! - b[0]!, b[4]! - b[1]!, b[5]! - b[2]!) >= 0.3, `${key} is 0.3 m or more`);
    }
  }
});

// ---------------------------------------------------------------- the per-frame visuals
const item = (id: string, type: string, x: number, z: number, extra: Partial<ItemState> = {}): ItemState => ({ id, type, where: 'world', p: [x, 0, z], rot: 0, ...extra } as ItemState);
/** spaces: x < 0 none (-1), then one space per 4 m strip */
const spaceAt = (x: number, _z: number) => (x < 0 ? -1 : Math.floor(x / 4));
function rig(): { scene: THREE.Scene; v: ReturnType<typeof V.createVisuals>; st: InteractionState; o: VisualOpts; root: THREE.Object3D } {
  const scene = new THREE.Scene();
  const v = V.createVisuals(scene, { propModels: false });
  const st = emptyInteractionState();
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 100);
  const o: VisualOpts = {
    camera, activeType: null, showViewModel: false, targetItem: null, targetPos: null, thrown: [], serverNow: 0, radioTx: false, dt: 0.016,
    version: 1, layoutRef: { id: 'L1' }, visibleSpaces: null, spaceAt,
  };
  return { scene, v, st, o, root: scene.getObjectByName('interaction')! };
}
const groupFor = (root: THREE.Object3D, type: string) => root.children.filter((c) => c.name === `ix:${type}`);

test('world items in unseen spaces are hidden; materials compact to the visible spaces; unchanged inputs upload nothing', () => {
  const { v, st, o, root } = rig();
  st.items.b = item('b', 'bottle', 1.5, 1); // space 0
  st.items.c = item('c', 'crowbar', 5.5, 1); // space 1
  st.items.k = item('k', 'keycard', -3, 1); // no space: always drawn
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
  assert.equal(ds.items, 3);
  assert.equal(ds.shown, 2);
  assert.equal(ds.maxMeshesPerItem, 1, 'a merged item is one mesh');
  // the crowbar's space comes into view
  o.visibleSpaces = new Set([0, 1]);
  v.update(st, o);
  assert.equal(c!.visible, true);
  assert.deepEqual(v.matStats(), { draws: 2, instances: 3 });
  ds = v.drawStats();
  assert.equal(ds.casters, 1, 'only the crowbar casts');
  // the same members in a new set (the camera crossed a cell), and a state version without a visual change: no upload
  const scrap = root.getObjectByName('ix:inst:mat.scrap') as THREE.InstancedMesh;
  const ver0 = scrap.instanceMatrix.version;
  o.visibleSpaces = new Set([1, 0]);
  v.update(st, o);
  o.version = 2;
  v.update(st, o);
  assert.equal(scrap.instanceMatrix.version, ver0, 'no re-upload for an unchanged compaction');
  // a move and a pickup re-sync on the next version
  st.items.b = { ...st.items.b!, p: [2.5, 0, 3] };
  delete st.items.k;
  o.version = 3;
  v.update(st, o);
  assert.equal(b!.position.x, 2.5);
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

test('a facility-like scatter: draws follow the visible items, one mesh each', () => {
  const { v, st, o } = rig();
  const types = ['bottle', 'bottle', 'medkit', 'crowbar', 'walkie', 'glowstick', 'flare', 'keycard', 'battery', 'lockpick', 'masterkey', 'soles',
    'nvg', 'flashbulb', 'loot.curio', 'page', 'syringe', 'charm', 'airhorn', 'sensor', 'loot.idol', 'battery', 'bottle', 'flare', 'lockpick',
    'glowstick', 'medkit', 'page', 'page', 'flashlight_pro', 'badge'];
  types.forEach((t, i) => { st.items[`i${i}`] = item(`i${i}`, t, (i % 10) * 4 + 1, 1 + Math.floor(i / 10)); });
  o.visibleSpaces = new Set([0, 1]);
  v.update(st, o);
  const ds = v.drawStats();
  const inView = types.filter((_, i) => i % 10 <= 1);
  assert.equal(ds.items, types.length);
  assert.equal(ds.shown, inView.length);
  assert.ok(ds.maxMeshesPerItem <= 2, 'one mesh per item (two with glass)');
  // draws: the shown items' meshes + their halos (the idol) + the warm set excluded + flare lights are not draws
  const expectMax = inView.length * 2 + 2;
  assert.ok(ds.draws <= expectMax, `${ds.draws} draws for ${inView.length} items in view`);
  assert.ok(ds.casters <= inView.filter((t) => V.ITEM_CASTS.has(t)).length);
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
