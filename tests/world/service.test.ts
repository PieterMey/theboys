// env-world: the client 'level' service (apps/client/src/level/index.ts) built in Node on a fake context (no GPU):
//   node --test tests/world/service.test.ts
// Every LevelServiceV12 member is present and works: stations + named parts + upgrades, containers, lore pages,
// quiet door easing (culling bump + slow return) and rattles, surfaceAt, mirrors registered with render.mirrors
// (itemId -> mirrorOf), propHandle (zero-scale + movable clone + commit), fixtures rot/battery, clutter shadows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { generateHub } from '../../packages/shared/src/procgen/hub.ts';
import { generateFacility } from '../../packages/shared/src/procgen/facility.ts';
import { movableRefsOf } from '../../packages/shared/src/procgen/movables.ts';
import { floorSurface } from '../../packages/shared/src/procgen/themes.ts';
import { spaceLinks } from '../../packages/shared/src/nav/index.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import { installDomShim, installLevel } from './harness.ts';
import { buildTemplate, primePropTemplate } from '../../apps/client/src/level/assets.ts';
import type { LevelServiceV12 } from '../../apps/client/src/level/api.ts';

installDomShim();
type Lv = LevelServiceV12 & { layout: LevelLayout; root: THREE.Group; fixtures: { kind: string; rot?: number; battery?: boolean }[]; visibleSpaces(p: [number, number, number]): Set<number>; isDoorOpen(id: number): boolean; doorAnim(id: number): number; spaceGroup(s: number): THREE.Group | null };
const MEMBERS = ['stations', 'stationObject', 'setVanUpgrades', 'containers', 'setContainerOpen', 'containerOpen', 'containerAnim', 'setContainerProgress', 'containerPartMatrix', 'loreSpots', 'setLorePage', 'setDoorProgress', 'rattleDoor', 'surfaceAt', 'propHandle', 'mirrorOf'];

/** a stand-in render service whose mirror registry records registrations */
function fakeRender() {
  const regs: { glass: THREE.Mesh; opts: { itemId?: string; kind: string } }[] = [];
  return {
    regs,
    svc: {
      mirrors: {
        register(glass: THREE.Mesh, opts: { itemId?: string; kind: string }) {
          regs.push({ glass, opts });
          return { id: regs.length, itemId: opts.itemId ?? null, live: () => false, setFog() {}, setWriting() {}, setCrack() {}, ghost: new THREE.Group(), dispose() {} };
        },
        list: () => [], liveCount: () => 0,
      },
    },
  };
}

test('every LevelServiceV12 member is present; hub stations have objects and named parts; upgrades toggle', async () => {
  const L = generateHub();
  const h = await installLevel(L);
  const lv = h.services.use('level') as unknown as Lv;
  for (const m of MEMBERS) assert.equal(typeof (lv as unknown as Record<string, unknown>)[m], 'function', m);
  const kinds = lv.stations().map((s) => s.kind);
  for (const k of ['console', 'leave_lever', 'deposit', 'mirror', 'workbench', 'stash', 'booklet', 'charger', 'records']) assert.ok(kinds.includes(k as never), `hub station ${k}`);
  // the frozen objectives client animates the lever's 'handle' through itemObject: item objects stay
  const lever = lv.stationObject('leave_lever');
  assert.ok(lever?.getObjectByName('handle'), 'leave lever handle');
  const con = lv.stationObject('console')!;
  for (const n of ['screen0', 'screen1', 'screen2', 'screen3']) assert.ok(con.getObjectByName(n), n);
  assert.ok(lv.stationObject('mirror')?.getObjectByName('glass'), 'hub mirror glass');
  for (const [k, part] of [['workbench', 'lamp'], ['stash', 'door'], ['booklet', 'books'], ['charger', 'cradle']] as const) assert.ok(lv.stationObject(k)?.getObjectByName(part), `${k}.${part}`);
  const scanner = con.getObjectByName('scanner')!;
  assert.equal(scanner.visible, false);
  lv.setVanUpgrades(['scanner', 'bench_tools']);
  assert.equal(scanner.visible, true, 'scanner upgrade shows screen3');
  let shown = 0;
  lv.stationObject('workbench')!.parent!.traverse((o) => { if (o.name.startsWith('van.up.bench_tools') && o.visible) shown++; });
  assert.ok(shown > 0, 'bench tools visible');
  lv.setVanUpgrades([]);
  assert.equal(scanner.visible, false);
  assert.deepEqual(h.errors, []);
});

test('quiet door easing: the room behind is drawn from the first frame; a cancel returns slowly; rattles keep state', async () => {
  const L = generateFacility({ seed: 's2', players: 4, risk: 1 });
  const h = await installLevel(L);
  const lv = h.services.use('level') as unknown as Lv;
  void spaceLinks;
  // a closed wooden door whose far room is NOT drawn from the near room's centre while the door is shut
  const camOf = (sid: number): [number, number, number] => { const r = L.spaces[sid].rect; return [r.x + r.w / 2, 1.6, r.y + r.h / 2]; };
  const id = L.doors.findIndex((dd) => dd.kind === 'door' && !dd.initiallyOpen && dd.a >= 0 && dd.b >= 0 && !lv.visibleSpaces(camOf(dd.a)).has(dd.b));
  assert.ok(id >= 0, 'a culled room behind a closed door');
  const d = L.doors[id];
  const cam = camOf(d.a);
  assert.equal(lv.visibleSpaces(cam).has(d.b), false);
  lv.setDoorProgress(id, 0);
  assert.equal(lv.visibleSpaces(cam).has(d.b), true, 'the room behind an easing door is drawn from its first frame');
  lv.setDoorProgress(id, 0.6);
  h.tick(1 / 60, 2);
  assert.ok(Math.abs(lv.doorAnim(id) - 0.6) < 1e-6, 'visual t follows the ease');
  assert.equal(lv.isDoorOpen(id), false, 'logical state untouched');
  lv.setDoorProgress(id, null);
  h.tick(0.1, 1);
  const t1 = lv.doorAnim(id);
  assert.ok(t1 < 0.6 && t1 >= 0.6 - 0.1 * 1.2 - 1e-6, `returns at ~1.2/s (${t1.toFixed(3)})`);
  h.tick(0.1, 10);
  assert.equal(lv.doorAnim(id), 0);
  lv.rattleDoor(id, 300, 1);
  h.tick(1 / 60, 5);
  assert.equal(lv.isDoorOpen(id), false);
  h.tick(0.1, 5);
  assert.equal(lv.doorAnim(id), 0, 'a rattle never opens the door');
  assert.deepEqual(h.errors, []);
});

test('surfaceAt, fixtures rot/battery, lore pages, mirrors -> mirrorOf', async () => {
  const L = generateFacility({ seed: 's3', players: 6, risk: 1, theme: 'records' });
  const fr = fakeRender();
  const h = await installLevel(L);
  h.services.provide('render', fr.svc);
  const lv = h.services.use('level') as unknown as Lv;
  // surfaces
  const room = L.spaces.find((s) => s.kind === 'room' && s.type === 'office') ?? L.spaces.find((s) => s.kind === 'room')!;
  const got = lv.surfaceAt(room.rect.x + 0.5, room.rect.y + 0.5);
  assert.ok(got === floorSurface(L, room.id) || got === 'water', `${got} vs ${floorSurface(L, room.id)}`);
  // fixtures carry rot + battery
  assert.ok(lv.fixtures.every((f) => typeof f.rot === 'number' && typeof f.battery === 'boolean'));
  // lore: pages hidden until set, null clears
  const spots = lv.loreSpots();
  assert.ok(spots.length >= 3, `${spots.length} lore spots`);
  const sp = spots[0];
  const holder = lv.root.getObjectByName(`lore:${sp.id}`)!;
  const page = holder.getObjectByName('page')!;
  assert.equal(page.visible, false);
  lv.setLorePage(sp.id, { visible: true, title: 'HAZARD BULLETIN', text: 'THE LISTENER — FORM FG-1. '.repeat(40), glow: 0.5 });
  assert.equal(page.visible, true);
  lv.setLorePage(sp.id, { visible: true, title: 'HAZARD BULLETIN', text: 'filed', dim: true });
  lv.setLorePage(sp.id, null);
  assert.equal(page.visible, false);
  // mirrors registered (pending until the render service appeared, flushed by the level system)
  h.tick(0.6, 2);
  const ids = fr.regs.map((r) => r.opts.itemId);
  assert.ok(fr.regs.length >= 3, `${fr.regs.length} mirrors registered`);
  assert.ok(fr.regs.some((r) => r.opts.kind === 'van'), 'the van mirror');
  for (const id of ids) assert.ok(lv.mirrorOf(id!), `mirrorOf(${id})`);
  assert.deepEqual(h.errors, []);
});

test('propHandle: zero-scales the instance, hands out a movable clone, commit bakes it back', async () => {
  const L = generateFacility({ seed: 's2', players: 4, risk: 1 });
  const refs = movableRefsOf(L).filter((r) => r.kind === 'prop');
  assert.ok(refs.length > 0, 'movable props');
  const key = refs[0].key.replace(/^prop\./, '');
  // a template for that key (Node has no GLBs): one box
  const model = new THREE.Group();
  const g = new THREE.Group(); g.name = key;
  g.add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.9, 0.5).translate(0, 0.45, 0), new THREE.MeshStandardNodeMaterial()));
  model.add(g);
  primePropTemplate(key, buildTemplate(key, model));
  const h = await installLevel(L);
  await new Promise((r) => setTimeout(r, 10));
  const lv = h.services.use('level') as unknown as Lv;
  const ref = refs.find((r) => r.key === `prop.${key}`)!;
  const ph = lv.propHandle(ref.ref, { key: ref.key, x: ref.x, z: ref.z });
  assert.ok(ph, 'handle');
  const im = lv.spaceGroup(ref.space)!.children.find((o) => o.name === `glb:${ref.space}:${key}`) as THREE.InstancedMesh;
  assert.ok(im, 'instanced mesh');
  // the hidden instance is the one nearest the ref
  let hidden = -1;
  const m = new THREE.Matrix4();
  for (let i = 0; i < im.count; i++) { im.getMatrixAt(i, m); if (m.elements[0] === 0 && m.elements[5] === 0) hidden = i; }
  assert.ok(hidden >= 0, 'zero-scaled instance');
  assert.ok(ph!.object.parent, 'clone in the scene');
  const moved = new THREE.Matrix4().makeTranslation(ref.x + 0.4, 0, ref.z);
  ph!.commit(moved);
  im.getMatrixAt(hidden, m);
  assert.ok(Math.abs(m.elements[12] - (ref.x + 0.4)) < 1e-6, 'committed position baked into the instance');
  assert.equal(ph!.object.parent, null, 'clone removed');
  assert.equal(lv.propHandle('prop:999999'), null);
  assert.deepEqual(h.errors, []);
});

test('rebuild hub -> facility -> hub: no errors, groups replaced, stations follow the layout', async () => {
  const hub = generateHub();
  const h = await installLevel(hub);
  const lv = h.services.use('level') as unknown as Lv;
  const fac = generateFacility({ seed: 'rb', players: 3, risk: 1, theme: 'cold_storage' });
  h.world.layout = fac;
  h.world.notify();
  assert.equal(lv.layout?.seed, 'rb');
  assert.ok(lv.stationObject('mirror'), 'facility van mirror');
  h.world.layout = hub;
  h.world.notify();
  assert.equal(lv.layout?.kind, 'hub');
  h.tick(1 / 60, 5);
  assert.deepEqual(h.errors, []);
});
