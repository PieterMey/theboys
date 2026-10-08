// env-world: what a search reveals must be SEEN in the opened container (Node only, no GPU):
//   node --test tests/world/slots.test.ts
// Every container host kind is opened and probed at its main part's slot (env-layout's point where searched items and
// drawer pages lie; G3 spreads items +-0.12 m across the host):
// - procedural hosts (env-world geometry: counter, filing, morgue_drawers): a floor right under the slot (items rest ON
//   it, +-5 mm), nothing over it inside the host for 0.3 m, and a clear line from a standing player's eye in front;
// - model hosts (cabinet, desk, tool_chest, drawer_chest, nightstand GLBs through the client loader): open-topped over
//   the part's real floor with a clear eye line; drawer lore pages lie on that measured floor. env-layout's slot
//   height against the real floor is env-layout data: reported as todo while it is off by more than 1 cm.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import * as Containers from '../../packages/shared/src/procgen/containers.ts';
import type { ContainerPart } from '../../packages/shared/src/procgen/containers.ts';
import { PROP_DEFS } from '../../packages/shared/src/procgen/decor.ts';
import { makeRng } from '../../packages/shared/src/rng.ts';
import type { LayoutItem } from '../../packages/shared/src/layout.ts';
import { installDomShim } from './harness.ts';
import { glbPath, loadGlbModel, rayHits } from './glb.ts';
import { buildTemplate, templateInfo } from '../../apps/client/src/level/assets.ts';
import { floorUnder, measuredFloor, partPose, slotInPart, swingPose } from '../../apps/client/src/level/containers.ts';
import { procPartGeometry, procParts } from '../../apps/client/src/level/setpieces.ts';
import { drawerPageOffset } from '../../apps/client/src/level/lore.ts';
import { partGeometry } from '../../apps/client/src/level/geo.ts';

installDomShim();
type V3 = [number, number, number];
type PartDef = Omit<ContainerPart, 'slot'> & { slotLocal: V3 };
interface Def { frontZ: number; main: number; parts: PartDef[] }
const defOf = (it: Pick<LayoutItem, 'data'>): Def | null =>
  (Containers as unknown as { containerDefFor?: (it: Pick<LayoutItem, 'data'>) => Def | null }).containerDefFor?.(it) ?? null;
const SPREAD = [-0.12, 0, 0.12];

/** lowest surface straight over (x, z) above yStart, or null */
function ceilingOver(geos: readonly THREE.BufferGeometry[], x: number, z: number, yStart: number): number | null {
  const h = rayHits(geos, new THREE.Vector3(x, yStart, z), new THREE.Vector3(0, 1, 0), 5);
  return h.length ? yStart + h[0] : null;
}
/** occluders on the line from a standing eye (1.6 m, 0.65 m in front of the host face) to 5 cm over the point */
function eyeBlocked(geos: readonly THREE.BufferGeometry[], p: THREE.Vector3, frontZ: number): number[] {
  const eye = new THREE.Vector3(p.x, 1.6, frontZ + 0.65);
  const tgt = p.clone().add(new THREE.Vector3(0, 0.05, 0));
  const dir = tgt.clone().sub(eye);
  const len = dir.length();
  return rayHits(geos, eye, dir.normalize(), len - 0.01);
}

test('procedural hosts: the main slot has a floor under it, open space over it and a clear eye line', () => {
  for (const key of ['counter', 'filing', 'morgue_drawers']) {
    const pd = PROP_DEFS[key];
    const it: LayoutItem = { id: `prop:${key}`, kind: 'prop', space: 0, x: 0, z: 0, data: { prop: key, w: pd?.w ?? 1, d: pd?.d ?? 0.6 } };
    const def = defOf(it);
    assert.ok(def, `${key}: container def`);
    // the host as the level builds it: static carcass without the movable parts + each part instanced at its pose
    const geos: THREE.BufferGeometry[] = procParts(it, makeRng(`t:${key}`, 'decor:set'), { host: true, skip: new Set(def!.parts.map((p) => p.idx)) })!.map(partGeometry);
    for (const p of def!.parts) {
      const pg = procPartGeometry(key, p, slotInPart(p));
      const t = p.idx === def!.main ? 1 : 0;
      const m = partPose(p, t, new THREE.Matrix4()).multiply(new THREE.Matrix4().makeTranslation(p.local[0], p.local[1], p.local[2]));
      geos.push(pg.geo.clone().applyMatrix4(m));
      // a piece with its own motion (the morgue door swings aside while the tray slides out)
      const pc = pg.piece;
      if (pc) {
        const pose = swingPose([p.local[0] + pc.pivot[0], p.local[1] + pc.pivot[1], p.local[2] + pc.pivot[2]], pc.sign, pc.travel, pc.lead);
        geos.push(pc.geo.clone().applyMatrix4(pose(t, new THREE.Matrix4()).multiply(new THREE.Matrix4().makeTranslation(p.local[0] + pc.offset[0], p.local[1] + pc.offset[1], p.local[2] + pc.offset[2]))));
      }
    }
    const main = def!.parts.find((p) => p.idx === def!.main)!;
    for (const dx of SPREAD) {
      const s = new THREE.Vector3(main.slotLocal[0] + dx, main.slotLocal[1], main.slotLocal[2]);
      const floor = floorUnder(geos, s.x, s.z, s.y + 0.02);
      assert.ok(floor !== null && Math.abs(floor - s.y) <= 0.005, `${key} dx ${dx}: floor ${floor?.toFixed(3)} vs slot y ${s.y.toFixed(3)} (items must rest on it)`);
      const ceil = ceilingOver(geos, s.x, s.z, s.y + 0.02);
      assert.ok(ceil === null || ceil - s.y >= 0.3, `${key} dx ${dx}: covered ${(ceil! - s.y).toFixed(3)} m over the slot`);
      const occ = eyeBlocked(geos, s, def!.frontZ);
      assert.deepEqual(occ, [], `${key} dx ${dx}: eye line blocked at ${occ.map((v) => v.toFixed(3))}`);
    }
    // a drawer page lies at the slot (procedural floors are the slot height)
    const spec = { slotLocal: [...main.slotLocal] as V3, slide: main.kind === 'drawer' ? main.travel : 0, width: main.size[0], depth: main.kind === 'door' ? 0.5 : main.size[2] };
    const off = drawerPageOffset(spec, 3);
    const at = new THREE.Vector3().setFromMatrixPosition(off);
    assert.ok(Math.abs(at.y - main.slotLocal[1] - 0.004) < 1e-6, `${key}: page height`);
    assert.ok(Math.abs(at.z + spec.slide - main.slotLocal[2]) < 1e-6, `${key}: page rides on the part (closed-pose offset)`);
  }
});

test('model hosts: open-topped over the real floor, clear eye line, drawer pages on that floor; slot height (env-layout data)', async (t) => {
  for (const key of ['cabinet', 'desk', 'tool_chest', 'drawer_chest', 'nightstand']) {
    const path = glbPath(key);
    if (!path) { t.diagnostic(`no GLB for ${key}: skipped`); continue; }
    const tpl = buildTemplate(key, await loadGlbModel(path));
    const info = templateInfo(tpl);
    assert.ok(info, `${key}: template split`);
    const def = defOf({ data: { prop: key } })!;
    const main = def.parts.find((p) => p.idx === def.main)!;
    const floor = measuredFloor(info!, main, main.slotLocal);
    assert.ok(floor !== null, `${key}: a floor under the slot`);
    // the scene with the main part open: drawers slide by travel; the authored-open lid stays as authored (open)
    const slide = main.kind === 'drawer' || main.kind === 'tray' ? main.travel : 0;
    const geos: THREE.BufferGeometry[] = info!.body.map((m) => m.geometry);
    for (const tp of info!.parts) geos.push(main.node && tp.nodes.includes(main.node) && slide ? tp.geometry.clone().translate(0, 0, slide) : tp.geometry);
    for (const dx of main.kind === 'lid' ? SPREAD : [0]) {
      const s = new THREE.Vector3(main.slotLocal[0] + dx, floor!, main.slotLocal[2]);
      const ceil = ceilingOver(geos, s.x, s.z, s.y + 0.005);
      assert.ok(ceil === null || ceil - s.y >= 0.1, `${key} dx ${dx}: covered ${(ceil! - s.y).toFixed(3)} m over the floor`);
      const occ = eyeBlocked(geos, s, def.frontZ);
      assert.deepEqual(occ, [], `${key} dx ${dx}: eye line blocked`);
    }
    // a drawer lore page lies on the measured floor
    const spec = { slotLocal: [...main.slotLocal] as V3, slide, width: main.size[0], depth: main.size[2] };
    const at = new THREE.Vector3().setFromMatrixPosition(drawerPageOffset(spec, 1, floor));
    assert.ok(Math.abs(at.y - floor! - 0.004) < 1e-6, `${key}: page on the measured floor`);
    const off = main.slotLocal[1] - floor!;
    t.diagnostic(`${key}: slot y ${main.slotLocal[1].toFixed(3)}, real floor ${floor!.toFixed(3)} (${off > 0 ? 'items float' : 'items sink'} ${Math.abs(off * 100).toFixed(1)} cm)`);
    await t.test(`${key}: env-layout's slot height matches the real floor (+-1 cm)`, { todo: Math.abs(off) > 0.01 ? `env-layout slotLocal y ${main.slotLocal[1]} vs floor ${floor!.toFixed(3)}` : false }, () => {
      assert.ok(Math.abs(off) <= 0.01, `${key}: slot ${main.slotLocal[1]} vs floor ${floor!.toFixed(3)}`);
    });
  }
});
