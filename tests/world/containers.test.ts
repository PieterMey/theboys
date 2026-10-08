// env-world: openable containers + procedural kits on the client (apps/client/src/level/{assets,containers,setpieces,
// kits}.ts). Node only (no GPU):
//   node --test tests/world/containers.test.ts
// - every container def node exists in its GLB and its measured centre (closed pose) matches the def within 1 cm;
// - the loader keeps those nodes as separate template parts with the same recentring shift;
// - drawers slide, hinged parts turn about their pivot, the authored-open tool-chest lid closes;
// - ContainerSystem: state kept until instances exist, a tap <= 0.4 s, quiet-open overrides, partMatrix, flag off;
// - opening adds no meshes (0 new draw calls); every procedural PROP_DEFS key yields parts (kit or fallback).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three/webgpu';
import * as Containers from '../../packages/shared/src/procgen/containers.ts';
import type { ContainerPart } from '../../packages/shared/src/procgen/containers.ts';
import { PROP_DEFS } from '../../packages/shared/src/procgen/decor.ts';
import { generateFacility } from '../../packages/shared/src/procgen/facility.ts';
import { makeRng } from '../../packages/shared/src/rng.ts';
import type { LayoutItem } from '../../packages/shared/src/layout.ts';
import { REPO, installLevel } from './harness.ts';
import { buildTemplate, findPart, glbJson, glbPartBounds, partNodesFor, templateInfo } from '../../apps/client/src/level/assets.ts';
import { ContainerSystem, TAP_SECONDS, partPose, restOf } from '../../apps/client/src/level/containers.ts';
import { procPartGeometry, procParts } from '../../apps/client/src/level/setpieces.ts';
import { KIT_KEYS, fallbackParts } from '../../apps/client/src/level/kits.ts';
import { partGeometry } from '../../apps/client/src/level/geo.ts';

type PartDef = Omit<ContainerPart, 'slot'>;
const defFor = (key: string): { parts: PartDef[] } | null =>
  (Containers as unknown as { containerDefFor?: (it: Pick<LayoutItem, 'data'>) => { parts: PartDef[] } | null }).containerDefFor?.({ data: { prop: key } }) ?? null;
const NODES = (Containers as unknown as { CONTAINER_NODES?: Record<string, readonly string[]> }).CONTAINER_NODES ?? { cabinet: [], desk: [], tool_chest: [] };

/** the GLB of a prop key: env-layout's build cache, else the staged dist */
function glbPath(key: string): string | null {
  const build = join(REPO, '.assets/build/props', `${key}.glb`);
  if (existsSync(build)) return build;
  const stage = process.env.ASSETS_DIR ?? 'C:/Users/Pieter/AppData/Local/Temp/dead-air-assets-stage';
  const man = join(stage, 'dist', 'manifest.json');
  if (!existsSync(man)) return null;
  const e = (JSON.parse(readFileSync(man, 'utf8')) as { files: Record<string, { url: string }> }).files[`prop.${key}`];
  return e ? join(stage, 'dist', e.url) : null;
}

const v3 = (a: readonly number[]) => new THREE.Vector3(a[0], a[1], a[2]);

test('every container def node exists in its GLB; measured centre (closed pose) matches within 1 cm', (t) => {
  let checked = 0;
  for (const key of Object.keys(NODES)) {
    const path = glbPath(key);
    if (!path) { t.diagnostic(`no GLB for ${key}: skipped`); continue; }
    const B = glbPartBounds(glbJson(new Uint8Array(readFileSync(path))), partNodesFor(key));
    const def = defFor(key);
    assert.ok(def, `no container def for ${key}`);
    for (const p of def!.parts) {
      if (!p.node) continue;
      const nb = B.nodes.get(p.node);
      assert.ok(nb, `${key}: node ${p.node} missing in ${path}`);
      // closed-pose centre: authored-open parts are turned back by -sign * travel about their hinge
      const c = v3(nb!.centre).applyMatrix4(restOf(p, new THREE.Matrix4()));
      const d = c.distanceTo(v3(p.local));
      assert.ok(d <= 0.01, `${key}.${p.node}: measured (${c.toArray().map((v) => v.toFixed(3))}) vs def (${p.local}) = ${(d * 100).toFixed(1)} cm`);
      // the loader keeps the node in a separate part group
      assert.ok(B.parts.some((g) => g.nodes.includes(p.node!)), `${key}: ${p.node} not kept as a part`);
      checked++;
    }
    for (const n of NODES[key]) assert.ok(B.nodes.has(n), `${key}: CONTAINER_NODES ${n} missing`);
  }
  t.diagnostic(`${checked} part nodes checked`);
});

test('template split: parts stay separate with the body shift; a clone still shows the whole model', () => {
  // a GLB-like hierarchy: body + two drawers (named groups with an unnamed mesh child) + an unrelated knob
  const model = new THREE.Group();
  const mk = (name: string, w: number, h: number, d: number, x: number, y: number, z: number) => {
    const g = new THREE.Group();
    g.name = name;
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d).translate(x, y, z), new THREE.MeshStandardNodeMaterial());
    g.add(m);
    model.add(g);
    return m;
  };
  const mat = new THREE.MeshStandardNodeMaterial();
  for (const m of [mk('thing', 1, 1, 0.5, 2, 0.5, 3), mk('thing_drawer_01', 0.9, 0.2, 0.45, 2, 0.7, 3.05), mk('thing_drawer_02', 0.9, 0.2, 0.45, 2, 0.3, 3.05)]) m.material = mat;
  const tpl = buildTemplate('unit-test-thing', model);
  const info = templateInfo(tpl);
  assert.ok(info);
  assert.equal(info!.parts.length, 2);
  assert.equal(info!.body.length, 1);
  const d1 = findPart(info!, 'thing_drawer_01')!;
  // recentred: model x/z centre at 0, y = 0 at the bottom
  // model z spans 2.75..3.275 (body + proud drawers): centre 3.0125, so the drawer centre sits at 3.05 - 3.0125
  assert.ok(Math.abs(d1.centre.x) < 1e-6 && Math.abs(d1.centre.y - 0.7) < 1e-6 && Math.abs(d1.centre.z - 0.0375) < 1e-6, d1.centre.toArray().join(','));
  let meshes = 0;
  tpl.clone(true).traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes++; });
  assert.equal(meshes, 3, 'clone = body + both drawers');
  assert.equal(info!.full().length, 1, 'full(): one merged mesh per material');
});

test('poses: drawers slide <= 0.45 m along +Z; hinges turn about the pivot; the tool-chest lid closes', () => {
  const m = new THREE.Matrix4();
  const drawer = { kind: 'drawer' as const, travel: 0.6 };
  partPose(drawer, 1, m);
  assert.ok(Math.abs(m.elements[14] - 0.45) < 1e-9, 'travel capped at 0.45');
  partPose(drawer, 0, m);
  assert.ok(m.equals(new THREE.Matrix4()), 'closed = identity');
  const lid = defFor('tool_chest')?.parts[0];
  assert.ok(lid?.hinge && lid.authoredOpen, 'tool chest lid is a hinged authored-open part');
  // rest . open(1) = identity: the authored (open) geometry, closed, then opened fully, is where it was authored
  const rest = restOf(lid!, new THREE.Matrix4());
  const open = partPose(lid!, 1, new THREE.Matrix4());
  const round = new THREE.Matrix4().multiplyMatrices(open, rest);
  assert.ok(round.equals(new THREE.Matrix4()) || round.elements.every((v, i) => Math.abs(v - new THREE.Matrix4().elements[i]) < 1e-6));
  // a counter door's free edge swings out toward +Z
  const door: Pick<ContainerPart, 'kind' | 'travel' | 'hinge'> = { kind: 'door', travel: 1.75, hinge: { axis: 'y', pivot: [-0.3, 0.5, 0.3], sign: -1 } };
  const edge = new THREE.Vector3(0.3, 0.5, 0.3).applyMatrix4(partPose(door, 1, new THREE.Matrix4()));
  assert.ok(edge.z > 0.6, `door edge z ${edge.z.toFixed(3)}`);
});

test('ContainerSystem: state before instances, tap time, overrides, partMatrix, flag off; no new draws', () => {
  const info = {
    id: 'prop:1', prop: 'filing', kind: 'filing' as const, space: 0, roomType: 'office', x: 2, z: 3, rot: 0, p: [2, 0.8, 3.3] as [number, number, number], front: [2, 4] as [number, number],
    parts: [0, 1].map((k) => ({ idx: k, kind: 'drawer' as const, local: [0, 0.17 + k * 0.32, 0.03] as [number, number, number], size: [0.46, 0.29, 0.56] as [number, number, number], travel: 0.4, slot: [2, 0.2, 3.5] as [number, number, number] })),
    main: 1, tier: 0,
  };
  const cs = new ContainerSystem();
  cs.reset([info], () => new THREE.Matrix4().setPosition(2, 0, 3));
  cs.setOpen('prop:1', 0b10);
  assert.equal(cs.open('prop:1'), 2, 'mask kept before any instance exists');
  const scene = new THREE.Scene();
  const im = new THREE.InstancedMesh(new THREE.BoxGeometry(0.46, 0.29, 0.56), new THREE.MeshStandardNodeMaterial(), 2);
  scene.add(im);
  const childrenBefore = scene.children.length;
  cs.addSlot('prop:1', 0, im, 0, new THREE.Matrix4());
  cs.addSlot('prop:1', 1, im, 1, new THREE.Matrix4());
  let frames = 0;
  while (cs.anim('prop:1', 1) < 1 && frames < 600) { cs.update(1 / 60); frames++; }
  assert.ok(frames / 60 <= 0.4 + 1e-9, `tap took ${(frames / 60).toFixed(2)} s`);
  assert.equal(cs.anim('prop:1', 0), 0, 'other drawer stays shut');
  const mm = new THREE.Matrix4();
  im.getMatrixAt(1, mm);
  assert.ok(Math.abs(mm.elements[14] - (3 + 0.4)) < 1e-6, `drawer instance slid out: z ${mm.elements[14]}`);
  // quiet open of drawer 0 holds its visual t, null hands back (eases shut again)
  cs.setProgress('prop:1', 0, 0.5);
  assert.equal(cs.anim('prop:1', 0), 0.5);
  cs.setProgress('prop:1', 0, null);
  for (let i = 0; i < 60; i++) cs.update(1 / 60);
  assert.equal(cs.anim('prop:1', 0), 0);
  assert.ok(cs.partMatrix('prop:1', 1, mm) && Math.abs(mm.elements[14] - 3.4) < 1e-6, 'partMatrix = host . pose');
  assert.equal(scene.children.length, childrenBefore, 'opening adds no objects');
  assert.ok(TAP_SECONDS <= 0.4);
  const off = new ContainerSystem();
  off.enabled = false;
  off.reset([info], () => null);
  off.setOpen('prop:1', 3, true);
  assert.equal(off.anim('prop:1', 1), 0, 'flag containers off keeps drawers shut');
});

test('procedural hosts: skip removes the movable parts from the static merge; same-size parts share one shape', () => {
  const it: LayoutItem = { id: 'prop:9', kind: 'prop', space: 0, x: 0, z: 0, data: { prop: 'filing', w: 0.5, d: 0.62 } };
  const all = procParts(it, makeRng('t', 'decor:set'))!;
  const host = procParts(it, makeRng('t', 'decor:set'), { host: true, skip: new Set([0, 1, 2, 3]) })!;
  assert.ok(host.length < all.length, 'drawer fronts left out');
  const def = defFor('filing');
  assert.ok(def && def.parts.length === 4);
  const keys = new Set(def!.parts.map((p) => procPartGeometry('filing', p).shapeKey));
  assert.equal(keys.size, 1, 'the four filing drawers share one instanced shape');
  for (const key of ['morgue_drawers', 'counter']) {
    const d2 = defFor(key);
    if (!d2) continue;
    assert.equal(new Set(d2.parts.map((p) => procPartGeometry(key, p).shapeKey)).size, 1, `${key}: one shape`);
  }
});

test('every procedural PROP_DEFS key yields parts (kit or bevelled fallback) inside its footprint', () => {
  for (const [key, def] of Object.entries(PROP_DEFS)) {
    if (!def.proc) continue;
    const it: LayoutItem = { id: `prop:${key}`, kind: 'prop', space: 0, x: 0, z: 0, y: def.mount === 'wall' ? def.y : 0, data: { prop: key, w: def.w, d: def.d, h: def.h } };
    const parts = procParts(it, makeRng(key, 'decor:set'));
    assert.ok(parts && parts.length > 0, `${key}: no parts`);
    if (!KIT_KEYS.includes(key)) continue;
    const box = new THREE.Box3();
    for (const p of parts!) { const g = partGeometry(p); g.computeBoundingBox(); box.union(g.boundingBox!); }
    if (def.solid) {
      assert.ok(box.min.x >= -def.w / 2 - 0.06 && box.max.x <= def.w / 2 + 0.06, `${key}: x ${box.min.x.toFixed(2)}..${box.max.x.toFixed(2)} vs w ${def.w}`);
      assert.ok(box.min.z >= -def.d / 2 - 0.06 && box.max.z <= def.d / 2 + 0.06, `${key}: z ${box.min.z.toFixed(2)}..${box.max.z.toFixed(2)} vs d ${def.d}`);
    }
  }
  // the 10 MUST theme keys have kits, whether or not env-layout's PROP_DEFS has them yet
  for (const key of ['ward_bed', 'curtain_rail', 'iv_stand', 'sink_row', 'pump_flywheel', 'pipe_bank', 'card_catalogue', 'display_case', 'meat_rail', 'strip_curtain']) assert.ok(KIT_KEYS.includes(key), key);
  assert.ok(fallbackParts({ w: 1, d: 0.5, h: 1 }, 'floor').length > 0);
});

test('a facility on the client: containers match containersOf; proc drawers animate in place with no new meshes', async () => {
  const L = generateFacility({ seed: 's3', players: 6, risk: 1 });
  const h = await installLevel(L);
  const lv = h.services.use('level') as { containers(): readonly { id: string; prop: string; main: number }[]; setContainerOpen(id: string, m: number, i?: boolean): void; containerAnim(id: string, i: number): number; containerOpen(id: string): number; containerPartMatrix(id: string, i: number, out: THREE.Matrix4): boolean; root: THREE.Group };
  assert.deepEqual(lv.containers().map((c) => c.id), Containers.containersOf(L).map((c) => c.id));
  const proc = lv.containers().find((c) => c.prop === 'filing' || c.prop === 'morgue_drawers' || c.prop === 'counter');
  assert.ok(proc, 'a procedural container on s3');
  let count = 0;
  lv.root.traverse(() => { count++; });
  lv.setContainerOpen(proc!.id, 1 << proc!.main);
  h.tick(1 / 60, 30);
  assert.equal(lv.containerAnim(proc!.id, proc!.main), 1);
  let after = 0;
  lv.root.traverse(() => { after++; });
  assert.equal(after, count, 'no objects added by opening');
  const m = new THREE.Matrix4();
  assert.ok(lv.containerPartMatrix(proc!.id, proc!.main, m));
  // GLB hosts (no assets in Node): state is kept for when their instances arrive
  const glb = lv.containers().find((c) => c.prop === 'cabinet' || c.prop === 'desk' || c.prop === 'tool_chest');
  if (glb) { lv.setContainerOpen(glb.id, 1); assert.equal(lv.containerOpen(glb.id), 1); }
  assert.deepEqual(h.errors, []);
});
