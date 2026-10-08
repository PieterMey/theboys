// env-world (door-lag fix): site-wide instanced batches (apps/client/src/level/sitebatch.ts) and the level's packing
// by visible space, in Node (no GPU):
//   node --test tests/world/sitebatch.test.ts
// - SiteBatch: stable logical ids, packing to a visible-space mask (front of the buffer, count), stable slots for
//   instances that stay visible, holes filled first, compaction, updates to hidden instances landing at the next pack,
//   bounds over the drawn instances;
// - the level: every prop / container-part InstancedMesh is a child of the level root (one per key + mesh / part shape
//   for the whole site, none in a space group); a room reveal (door opened) only re-packs: no object is added, the
//   instances that were drawn keep their slots, the new room's instances are drawn; a drawer opened while its room is
//   culled shows open when the room is revealed; propHandle + commit still land.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { generateFacility } from '../../packages/shared/src/procgen/facility.ts';
import { PROP_DEFS } from '../../packages/shared/src/procgen/decor.ts';
import { clutterFor } from '../../packages/shared/src/procgen/clutter.ts';
import { movableRefsOf } from '../../packages/shared/src/procgen/movables.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import { installDomShim, installLevel } from './harness.ts';
import { SiteBatch } from '../../apps/client/src/level/sitebatch.ts';
import { buildTemplate, primePropTemplate } from '../../apps/client/src/level/assets.ts';
import { glbPath, loadGlbModel } from './glb.ts';

installDomShim();
const at = (x: number, z: number) => new THREE.Matrix4().makeTranslation(x, 0, z);
const mask = (n: number, on: number[]) => { const m = new Uint8Array(n); for (const s of on) m[s] = 1; return m; };
const posOf = (im: THREE.InstancedMesh, slot: number) => { const m = new THREE.Matrix4(); im.getMatrixAt(slot, m); return [m.elements[12], m.elements[14]]; };

test('SiteBatch: packing by space, stable slots, holes, hidden updates, compaction, bounds', () => {
  const b = new SiteBatch(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshStandardNodeMaterial(), 6, 'glb:site:test');
  // spaces 0,0,1,1,2,2 at x = id
  for (let i = 0; i < 6; i++) assert.equal(b.add(i >> 1, at(i, 0)), i);
  assert.equal(b.add(0, at(9, 9)), -1, 'full');
  assert.equal(b.im.count, 0);
  assert.equal(b.im.visible, false, 'nothing drawn before the first pack');
  b.pack(mask(3, [0]));
  assert.equal(b.im.count, 2);
  assert.deepEqual([b.slotOfId(0), b.slotOfId(1), b.slotOfId(2)], [0, 1, -1]);
  // a door opens: space 1 joins; ids 0/1 keep their slots (TRAA velocity), 2/3 append
  b.pack(mask(3, [0, 1]));
  assert.equal(b.im.count, 4);
  assert.deepEqual([0, 1, 2, 3].map((i) => b.slotOfId(i)), [0, 1, 2, 3]);
  assert.deepEqual(posOf(b.im, 3), [3, 0]);
  // walking on: space 0 drops out (holes stay: no compaction for 2 holes), space 2 fills the holes
  b.pack(mask(3, [1]));
  assert.equal(b.im.count, 4, 'holes kept in front');
  assert.deepEqual(posOf(b.im, 0), [0, 0]);
  const zero = new THREE.Matrix4();
  b.im.getMatrixAt(0, zero);
  assert.equal(zero.elements[0], 0, 'a hole is zero-scaled');
  // an update while hidden is stored and lands with the next pack
  b.setMatrixAt(4, at(40, 4));
  b.pack(mask(3, [1, 2]));
  assert.deepEqual([b.slotOfId(2), b.slotOfId(3)], [2, 3], 'visible instances never move');
  assert.deepEqual([b.slotOfId(4), b.slotOfId(5)], [0, 1], 'new instances fill the holes');
  assert.deepEqual(posOf(b.im, 0), [40, 4], 'hidden update applied');
  b.getMatrixAt(4, zero);
  assert.equal(zero.elements[12], 40);
  // an update of a drawn instance lands at once and keeps it inside the bounds
  b.setMatrixAt(5, at(80, 0));
  assert.deepEqual(posOf(b.im, 1), [80, 0]);
  assert.ok(b.im.boundingSphere!.containsPoint(new THREE.Vector3(80, 0, 0)), 'bounds grow over a moved instance');
  // bounds: the drawn instances + margin, never the origin of a hole
  b.pack(mask(3, [2]));
  const bs = b.im.boundingSphere!;
  assert.ok(bs.containsPoint(new THREE.Vector3(40, 0, 4)) && bs.containsPoint(new THREE.Vector3(80, 0, 0)));
  // nothing visible: not drawn at all
  b.pack(mask(3, []));
  assert.equal(b.im.count, 0);
  assert.equal(b.im.visible, false);
  b.pack(null);
  assert.equal(b.im.count, 6, 'null mask = every space');
  // compaction once holes dominate
  const c = new SiteBatch(new THREE.BoxGeometry(), new THREE.MeshStandardNodeMaterial(), 40, 'c');
  for (let i = 0; i < 40; i++) c.add(i < 30 ? 0 : 1, at(i, 1));
  c.pack(null);
  c.pack(mask(2, [1]));
  assert.equal(c.im.count, 10, 'compacted: 10 drawn');
  for (let i = 30; i < 40; i++) assert.deepEqual(posOf(c.im, c.slotOfId(i)), [i, 1]);
});

/** box templates for every GLB key a layout uses (Node has no GLBs) */
function primeAll(L: LevelLayout): void {
  const keys = new Set<string>();
  for (const it of L.items) { const k = String(it.data?.prop ?? ''); if (it.kind === 'prop' && PROP_DEFS[k] && !PROP_DEFS[k].proc) keys.add(k); }
  for (const c of clutterFor(L)) if (c.kind === 'glb' && c.key) keys.add(c.key);
  const mat = new THREE.MeshStandardNodeMaterial();
  for (const key of keys) {
    const model = new THREE.Group();
    const g = new THREE.Group(); g.name = key;
    g.add(new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.6, 0.4).translate(0, 0.3, 0), mat));
    model.add(g);
    primePropTemplate(key, buildTemplate(key, model));
  }
}

type Lv = {
  root: THREE.Group; layout: LevelLayout; spaceGroup(s: number): THREE.Group | null; visibleSpaces(p: [number, number, number]): Set<number>;
  setDoorOpen(id: number, open: boolean, instant?: boolean): void; containers(): readonly { id: string; prop: string; space: number; main: number; p: [number, number, number] }[];
  setContainerOpen(id: string, mask: number, instant?: boolean): void; containerPartMatrix(id: string, idx: number, out: THREE.Matrix4): boolean;
  propHandle(ref: string, at?: { key: string; x: number; z: number }): { object: THREE.Object3D; commit(m: THREE.Matrix4): void } | null;
};

test('level: site-wide batches at the root; a door reveal only re-packs (no new objects, stable slots, drawers keep their pose)', async () => {
  const L = generateFacility({ seed: 's3', players: 6, risk: 1 });
  primeAll(L);
  const h = await installLevel(L);
  await new Promise((r) => setTimeout(r, 20));
  const lv = h.services.use('level') as unknown as Lv;
  const ims: THREE.InstancedMesh[] = [];
  lv.root.traverse((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh) ims.push(o as THREE.InstancedMesh); });
  assert.ok(ims.length > 5, `${ims.length} batches`);
  for (const im of ims) assert.equal(im.parent, lv.root, `${im.name} is a child of the level root`);
  assert.equal(new Set(ims.map((m) => m.uuid)).size, ims.length);
  // camera in a room next to a closed door whose far room is culled
  const camOf = (sid: number): [number, number, number] => { const r = L.spaces[sid].rect; return [r.x + r.w / 2, 1.6, r.y + r.h / 2]; };
  const hasInst = (s: number) => ims.some((im) => (im.userData.siteSpaces as Set<number>).has(s));
  // procedural hosts (filing, counter, morgue drawers): their parts are instanced without GLBs
  const PROC = new Set(['filing', 'counter', 'morgue_drawers']);
  const closedTo = (d: (typeof L.doors)[number]) => d.kind === 'door' && !d.initiallyOpen && d.a >= 0 && d.b >= 0 && hasInst(d.b) && !lv.visibleSpaces(camOf(d.a)).has(d.b);
  let id = L.doors.findIndex((d) => closedTo(d) && lv.containers().some((c) => c.space === d.b && PROC.has(c.prop)));
  if (id < 0) id = L.doors.findIndex(closedTo);
  assert.ok(id >= 0, 'a closed door to a culled room with props');
  const d = L.doors[id];
  h.camera.position.set(...camOf(d.a));
  // a procedural container in the far room, opened while the room is culled
  const cont = lv.containers().find((c) => c.space === d.b && PROC.has(c.prop));
  assert.ok(cont, 's3: a procedural container behind a closed door');
  if (cont) lv.setContainerOpen(cont.id, 1 << cont.main, true);
  h.tick(1 / 60, 2);
  const vis0 = lv.visibleSpaces(camOf(d.a));
  const children0 = lv.root.children.length;
  let objects0 = 0;
  lv.root.traverse(() => { objects0++; });
  const drawn = (im: THREE.InstancedMesh) => { const out: string[] = []; const m = new THREE.Matrix4(); for (let i = 0; i < im.count; i++) { im.getMatrixAt(i, m); if (m.elements[0] !== 0 || m.elements[1] !== 0 || m.elements[2] !== 0) out.push(`${i}:${m.elements[12].toFixed(3)},${m.elements[14].toFixed(3)}`); } return out; };
  const before = new Map(ims.map((im) => [im, drawn(im)]));
  // packed counts follow the visible spaces
  for (const im of ims) {
    const visible = [...(im.userData.siteSpaces as Set<number>)].some((s) => vis0.has(s));
    assert.equal(im.visible, visible && im.count > 0, `${im.name}: drawn only with instances in view`);
  }
  // open the door: the far room appears
  lv.setDoorOpen(id, true, true);
  h.tick(1 / 60, 2);
  assert.ok(lv.visibleSpaces(camOf(d.a)).has(d.b), 'far room visible');
  let objects1 = 0;
  lv.root.traverse(() => { objects1++; });
  assert.equal(lv.root.children.length, children0, 'no new root children');
  assert.equal(objects1, objects0, 'no object added by a reveal');
  let grew = 0;
  for (const im of ims) {
    const was = before.get(im)!;
    const now = new Set(drawn(im));
    for (const s of was) assert.ok(now.has(s), `${im.name}: drawn instance ${s} kept its slot`);
    if (now.size > was.length) grew++;
  }
  assert.ok(grew > 0, 'the far room\'s instances are drawn');
  // the drawer opened while culled shows open
  if (cont) {
    const pm = new THREE.Matrix4();
    assert.ok(lv.containerPartMatrix(cont.id, cont.main, pm));
    const want = new THREE.Vector3().setFromMatrixPosition(pm);
    let found = false;
    const m = new THREE.Matrix4();
    for (const im of ims) {
      if (!(im.userData.siteSpaces as Set<number>).has(d.b) || !im.name.startsWith('parts:')) continue;
      for (let i = 0; i < im.count && !found; i++) {
        im.getMatrixAt(i, m);
        const p = new THREE.Vector3().setFromMatrixPosition(m);
        if (p.distanceTo(want) < 0.6 && Math.abs(new THREE.Vector3().setFromMatrixColumn(m, 0).length() - 1) < 1e-3) found = true;
      }
    }
    assert.ok(found, `${cont.prop} part drawn near its open pose`);
  }
  // close again + walk away: the far room's instances leave the drawn range
  lv.setDoorOpen(id, false, true);
  h.tick(1 / 60, 2);
  assert.equal(lv.visibleSpaces(camOf(d.a)).has(d.b), false);
  assert.deepEqual(h.errors, []);
});

test('level: propHandle on a culled prop lands when its room is drawn again', async () => {
  const L = generateFacility({ seed: 's2', players: 4, risk: 1 });
  primeAll(L);
  const h = await installLevel(L);
  await new Promise((r) => setTimeout(r, 20));
  const lv = h.services.use('level') as unknown as Lv;
  const ref = movableRefsOf(L).find((r) => r.kind === 'prop');
  assert.ok(ref, 'a movable prop');
  // camera far away in another space: the ref's room is culled
  const other = L.spaces.find((s) => s.kind === 'room' && s.id !== ref!.space && !lv.visibleSpaces([s.rect.x + s.rect.w / 2, 1.6, s.rect.y + s.rect.h / 2]).has(ref!.space))!;
  h.camera.position.set(other.rect.x + other.rect.w / 2, 1.6, other.rect.y + other.rect.h / 2);
  h.tick(1 / 60, 2);
  const ph = lv.propHandle(ref!.ref, { key: ref!.key, x: ref!.x, z: ref!.z });
  assert.ok(ph, 'handle');
  assert.equal(ph!.object.parent, lv.spaceGroup(ref!.space), 'the clone joins its space group');
  ph!.commit(new THREE.Matrix4().makeTranslation(ref!.x + 0.3, 0, ref!.z));
  // back in the ref's room: the committed instance is drawn where it was moved to
  const r = L.spaces[ref!.space].rect;
  h.camera.position.set(r.x + r.w / 2, 1.6, r.y + r.h / 2);
  h.tick(1 / 60, 2);
  const key = ref!.key.replace(/^prop\./, '');
  let found = false;
  const m = new THREE.Matrix4();
  for (const o of lv.root.children) {
    const im = o as THREE.InstancedMesh;
    if (!im.isInstancedMesh || im.name !== `glb:site:${key}`) continue;
    for (let i = 0; i < im.count; i++) { im.getMatrixAt(i, m); if (Math.abs(m.elements[12] - (ref!.x + 0.3)) < 1e-6 && Math.abs(m.elements[14] - ref!.z) < 1e-6) found = true; }
  }
  assert.ok(found, 'committed position drawn after the room is packed again');
  assert.deepEqual(h.errors, []);
});

test('level: a GLB container (real model parts) opened while culled draws its part open once its room is drawn', async (t) => {
  const L = generateFacility({ seed: 's3', players: 6, risk: 1 });
  primeAll(L);
  // the real models of the GLB hosts (their drawer / lid / door nodes stay separate parts)
  let real = 0;
  for (const key of ['cabinet', 'desk', 'tool_chest', 'drawer_chest', 'nightstand']) { const p = glbPath(key); if (p) { primePropTemplate(key, buildTemplate(key, await loadGlbModel(p))); real++; } }
  if (!real) { t.skip('no staged GLBs'); return; }
  const h = await installLevel(L);
  await new Promise((r) => setTimeout(r, 30));
  const lv = h.services.use('level') as unknown as Lv;
  const cont = lv.containers().find((c) => ['cabinet', 'desk', 'drawer_chest', 'nightstand'].includes(c.prop) && glbPath(c.prop));
  assert.ok(cont, 'a GLB drawer container on s3');
  const r = L.spaces[cont!.space].rect;
  const other = L.spaces.find((s) => s.kind === 'room' && s.id !== cont!.space && !lv.visibleSpaces([s.rect.x + s.rect.w / 2, 1.6, s.rect.y + s.rect.h / 2]).has(cont!.space))!;
  const parts = lv.root.children.filter((o) => o.name === `parts:site:${cont!.prop}`) as THREE.InstancedMesh[];
  assert.ok(parts.length > 0, `${cont!.prop}: site-wide part batches`);
  const host = new THREE.Vector3(cont!.p[0], 0, cont!.p[2]);
  const near = () => { const out: THREE.Vector3[] = []; const m = new THREE.Matrix4(); for (const im of parts) for (let i = 0; i < im.count; i++) { im.getMatrixAt(i, m); if (m.elements[0] === 0 && m.elements[5] === 0) continue; const at = new THREE.Vector3().setFromMatrixPosition(m); if (Math.hypot(at.x - host.x, at.z - host.z) < 1.2) out.push(at); } return out; };
  // 1. in its room, closed
  h.camera.position.set(r.x + r.w / 2, 1.6, r.y + r.h / 2);
  h.tick(1 / 60, 2);
  const p0 = near();
  assert.ok(p0.length > 0, 'its part instances are drawn in its room');
  const pm = new THREE.Matrix4();
  lv.containerPartMatrix(cont!.id, cont!.main, pm);
  const closed = new THREE.Vector3().setFromMatrixPosition(pm);
  // 2. walk away (culled), open it there, let the slide finish
  h.camera.position.set(other.rect.x + other.rect.w / 2, 1.6, other.rect.y + other.rect.h / 2);
  h.tick(1 / 60, 2);
  assert.equal(near().length, 0, 'culled: its part instances are not drawn');
  lv.setContainerOpen(cont!.id, 1 << cont!.main);
  h.tick(1 / 60, 40);
  lv.containerPartMatrix(cont!.id, cont!.main, pm);
  const slide = new THREE.Vector3().setFromMatrixPosition(pm).distanceTo(closed);
  assert.ok(slide > 0.1, `${cont!.prop}: the main drawer slid ${slide.toFixed(3)} m`);
  // 3. back in its room: exactly the opened drawer is drawn moved by the slide, the rest where they were
  h.camera.position.set(r.x + r.w / 2, 1.6, r.y + r.h / 2);
  h.tick(1 / 60, 2);
  const p1 = near();
  assert.equal(p1.length, p0.length, 'the same part instances drawn');
  const moved = p1.filter((a) => !p0.some((b) => b.distanceTo(a) < 1e-4));
  assert.ok(moved.length >= 1, `${cont!.prop}: the opened drawer instance moved`);
  for (const a of moved) {
    const d = Math.min(...p0.map((b) => b.distanceTo(a)));
    assert.ok(Math.abs(d - slide) < 0.01, `${cont!.prop}: drawn ${d.toFixed(3)} m out vs the part pose ${slide.toFixed(3)} m`);
  }
  assert.deepEqual(h.errors, []);
});
