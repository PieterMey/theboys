// v1.3 F3 (G3) client side in Node (no GPU, no audio device): the noise lure and field receiver models and the
// receiver's ears.
// - models: the lure (packed: LED dark and merged; armed: a separate blinking LED and a faint red floor halo; in flight
//   'thrown:lure:*' draws the lure) and the receiver: one opaque draw each on the shared item material, the same in
//   both itemModels modes, under 0.3 m (never a caster), a view-model pose of their own;
// - on the air: a cue counts within receiverRangeMult x its radius (straight) AND receiverPathM by sound path; the gain
//   falls with the path, the pan follows the bearing (three: right = (-fz, fx)); the room behind a door is the cell
//   across its edge; the path field goes around walls and through doors at their cost;
// - RadioOut without an AudioContext logs what it would have played (played: false) and never throws.
// Run: node --test tests/gear/f3.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three/webgpu';
import { emptyInteractionState } from '../../packages/shared/src/interactables.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import type { InteractionState, ItemState } from '../../packages/shared/src/messages/interaction.ts';
import type { VisualOpts } from '../../apps/client/src/interaction/visuals.ts';
import { AirField, CUE_SOUND, RadioOut, TELL_SOUND, airGain, airPan, dueTells, farPoint, onAir, spaceAcross } from '../../apps/client/src/interaction/receiver.ts';

const ctx2d: object = new Proxy(function stub() { /* no-op */ }, { get: () => () => ctx2d, set: () => true, apply: () => ctx2d });
(globalThis as unknown as { document: unknown }).document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d }) };
const V = await import('../../apps/client/src/interaction/visuals.ts');
const ROOT = join(import.meta.dirname, '../..');
const L = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/layouts/facility_s1_p2.json'), 'utf8')) as LevelLayout;

const meshesOf = (o: THREE.Object3D): THREE.Mesh[] => {
  const out: THREE.Mesh[] = [];
  o.traverse((c) => { if ((c as THREE.Mesh).isMesh) out.push(c as THREE.Mesh); });
  return out;
};
const additive = (m: THREE.Mesh) => (m.material as THREE.Material).blending === THREE.AdditiveBlending;

test('lure + receiver models: one opaque draw on the shared material, both modes, small, never casting', () => {
  const solid = V.itemMaterial(false);
  for (const legacy of [false, true]) {
    for (const t of ['lure', 'lure.armed', 'receiver']) {
      const grp = V.buildItemModel(t, { legacy, glb: false });
      const ms = meshesOf(grp);
      const body = ms.filter((m) => m.name === 'body');
      assert.equal(body.length, 1, `${t} (${legacy ? 'v1.2.0' : 'v1.2'}): one body`);
      assert.equal(body[0]!.material, solid, `${t}: the shared item material (no new pipeline)`);
      assert.ok(ms.every((m) => m.material === solid || additive(m)), `${t}: nothing else but a halo`);
      assert.equal(ms.filter((m) => m.castShadow).length, 0, `${t}: no caster`);
      const sz = grp.userData.size as THREE.Vector3;
      assert.ok(sz.y > 0.05 && sz.y < 0.3 && Math.max(sz.x, sz.z) < 0.12, `${t}: ${sz.toArray().map((v) => v.toFixed(3)).join(' x ')}`);
    }
    const packed = V.buildItemModel('lure', { legacy, glb: false });
    assert.equal(packed.getObjectByName('led'), undefined, 'a packed lure: its LED dark, merged into the body');
    assert.equal(packed.getObjectByName('halo'), undefined);
    const armed = V.buildItemModel('lure.armed', { legacy, glb: false });
    assert.ok(armed.getObjectByName('led'), 'an armed lure blinks its LED (a separate mesh)');
    assert.ok(armed.getObjectByName('halo'), 'and glows faintly red on the floor');
  }
  // its own model, not the bottle's or the sensor's
  const g = (t: string) => (V.buildItemModel(t, { glb: false }).getObjectByName('body') as THREE.Mesh).geometry;
  assert.notEqual(g('lure'), g('bottle'));
  assert.notEqual(g('receiver'), g('sensor'));
  assert.equal(V.castsFor('lure', false), false);
  assert.equal(V.castsFor('receiver', false), false);
  // held: their own view-model poses
  for (const t of ['lure', 'receiver']) {
    const pose = V.viewModelPose(t, t, false, new THREE.Vector3(0.08, 0.1, 0.06));
    assert.ok(pose.scale >= 1 && pose.pos[1] > -0.08, `${t}: held up close, above the inventory row (${pose.scale}, y ${pose.pos[1]})`);
  }
});

const item = (id: string, type: string, x: number, z: number, extra: Partial<ItemState> = {}): ItemState => ({ id, type, where: 'world', p: [x, 0, z], rot: 0, value: 0, ...extra } as ItemState);
function rig() {
  const scene = new THREE.Scene();
  const v = V.createVisuals(scene, { propModels: false, itemModels: true });
  const st: InteractionState = emptyInteractionState();
  const camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 100);
  const o: VisualOpts = {
    camera, activeType: null, showViewModel: false, targetItem: null, targetPos: null, thrown: [], serverNow: 0, radioTx: false, dt: 0.016,
    version: 1, layoutRef: { id: 'L1' }, visibleSpaces: null, spaceAt: () => -1,
  };
  return { scene, v, st, o, root: scene.getObjectByName('interaction')! };
}

test('world lures: armed = the blinking model, disarmed (picked up and dropped) = the packed one; a lure in flight', () => {
  const { v, st, o, root } = rig();
  st.items.a = item('a', 'lure', 1, 1, { armed: true, count: 1 });
  st.items.b = item('b', 'lure', 2, 1, { count: 1 });
  v.update(st, o);
  assert.equal(root.children.filter((c) => c.name === 'ix:lure.armed').length, 1);
  assert.equal(root.children.filter((c) => c.name === 'ix:lure').length, 1);
  // disarmed: the model swaps
  st.items.a = { ...st.items.a!, armed: undefined };
  o.version = 2;
  v.update(st, o);
  assert.equal(root.children.filter((c) => c.name === 'ix:lure.armed').length, 0);
  assert.equal(root.children.filter((c) => c.name === 'ix:lure').length, 2);
  // in flight
  o.thrown = [{ id: 'thrown:lure:7', p: [1, 1.2, 1], yaw: 0.4 }];
  v.update(st, o);
  assert.equal(v.drawStats().thrown, 1);
  assert.equal(root.children.filter((c) => c.name === 'ix:lure').length, 3, 'the thrown one is a lure, not a bottle');
  assert.equal(root.children.filter((c) => c.name === 'ix:bottle').length, 0);
});

test('on the air: 2.5x the cue radius and 30 m by sound path', () => {
  const cfg = { mult: 2.5, maxPath: 30 };
  assert.equal(onAir(9, 10, 9, cfg), true, 'inside its own radius');
  assert.equal(onAir(24, 10, 26, cfg), true, '2.4x its radius, 26 m by path');
  assert.equal(onAir(26, 10, 26, cfg), false, 'past 2.5x');
  assert.equal(onAir(20, 12, 31, cfg), false, 'past 30 m by path (walls in between)');
  assert.equal(onAir(5, 8, Infinity, cfg), false, 'unreachable (no sound path)');
  assert.equal(onAir(5, 0, 5, cfg), false, 'a cue nobody may hear');
  assert.ok(airGain(0, 25) === 1 && airGain(25, 25) > 0.19 && airGain(25, 25) < 0.21, 'from 1 up close to 0.2 at the reach');
  assert.ok(airGain(5, 25) > airGain(15, 25), 'louder the shorter the path');
  // camera looking -z (three's default): +x is right
  assert.ok(airPan(0, -1, 0, 0, 5, 0) > 0.8, 'right');
  assert.ok(airPan(0, -1, 0, 0, -5, 0) < -0.8, 'left');
  assert.ok(Math.abs(airPan(0, -1, 0, 0, 0, -5)) < 1e-9, 'ahead: centre');
  assert.ok(airPan(1, 0, 0, 0, 0, 5) > 0.8, 'facing +x: +z is right');
  // every cue the monsters send has a sound; tells never use breath or a whisper (the Listener's retreat cue)
  for (const c of ['growl', 'huff', 'bark', 'sniff', 'eat', 'lunge', 'creak', 'click', 'vent', 'scream', 'breath', 'rattle', 'tick', 'snatch', 'scratch', 'shriek', 'notice']) assert.ok(CUE_SOUND[c], c);
  for (const [k, t] of Object.entries(TELL_SOUND)) assert.ok(!/breath|whisper/.test(t[0]), `${k}: ${t[0]}`);
});

test('the room behind a door is the cell across its edge; the path field walks around walls', () => {
  const d = L.doors.find((x) => x.kind === 'door' && x.a !== x.b)!;
  const cx = d.dir === 'v' ? d.x : d.x + d.len / 2, cz = d.dir === 'v' ? d.y + d.len / 2 : d.y;
  const nx = d.dir === 'v' ? 1 : 0, nz = 1 - nx;
  const owner = (x: number, z: number) => L.owner[Math.floor(z) * L.W + Math.floor(x)]!;
  const sideA: [number, number] = [cx - nx * 0.6, cz - nz * 0.6], sideB: [number, number] = [cx + nx * 0.6, cz + nz * 0.6];
  assert.equal(spaceAcross(L, d.id, ...sideA), owner(...sideB), 'from one side: the other');
  assert.equal(spaceAcross(L, d.id, ...sideB), owner(...sideA), 'and back');
  assert.ok([d.a, d.b].includes(spaceAcross(L, d.id, ...sideA)));
  assert.equal(spaceAcross(L, 999999, 0, 0), -1, 'no such door');
  // the field: through the door at its cost, closed costs more than open, nothing past the budget
  const air = new AirField();
  air.update(L, sideA[0], sideA[1], 30, () => false);
  const closed = air.at(sideB[0], sideB[1]);
  air.update(L, sideA[0], sideA[1], 30, () => true);
  const open = air.at(sideB[0], sideB[1]);
  assert.ok(Number.isFinite(closed) && Number.isFinite(open), `through the door (${closed} / ${open} m)`);
  assert.ok(closed > open, 'a closed door costs more than an open one');
  assert.ok(open >= 1, 'a cell over');
  air.update(L, sideA[0], sideA[1], 4, () => true);
  let far = 0;
  for (let z = 0; z < L.H; z += 7) for (let x = 0; x < L.W; x += 7) if (Number.isFinite(air.at(x + 0.5, z + 0.5))) far = Math.max(far, air.at(x + 0.5, z + 0.5));
  assert.ok(far <= 4, `the budget caps the field (${far} m)`);
  air.update(null, 0, 0, 30, () => true);
  assert.equal(air.at(sideB[0], sideB[1]), Infinity, 'no layout: nothing on the air');
});

test('behind a door: the open floor past it (no other door crossed), the tells of what stands there, staggered', () => {
  const owner = (x: number, z: number) => { const cx = Math.floor(x), cz = Math.floor(z); return cx < 0 || cz < 0 || cx >= L.W || cz >= L.H ? -1 : L.owner[cz * L.W + cx]!; };
  const air = new AirField();
  let multi = 0, checked = 0;
  for (const d of L.doors) {
    if (d.a === d.b || d.kind === 'open' || d.kind === 'blocked') continue;
    const cx = d.dir === 'v' ? d.x : d.x + d.len / 2, cz = d.dir === 'v' ? d.y + d.len / 2 : d.y;
    const nx = d.dir === 'v' ? 1 : 0, nz = 1 - nx;
    const me: [number, number] = [cx - nx * 0.7, cz - nz * 0.7];
    if (owner(...me) < 0) continue;
    const fp = farPoint(L, d.id, ...me)!;
    assert.ok(Math.abs(fp[0] - (cx + nx * 0.5)) < 1e-9 && Math.abs(fp[1] - (cz + nz * 0.5)) < 1e-9, 'half a metre past the door, on the far side');
    assert.equal(owner(...fp), spaceAcross(L, d.id, ...me), 'the far point lies in the space behind the door');
    air.region(L, fp[0], fp[1], 30);
    assert.ok(air.behindAt(...fp) < 0.01, 'the far point itself');
    assert.equal(air.behindAt(...me), Infinity, 'never back through the door you listen at');
    const spaces = new Set<number>();
    for (let z = 0; z < L.H; z++) for (let x = 0; x < L.W; x++) if (Number.isFinite(air.behindAt(x + 0.5, z + 0.5))) spaces.add(owner(x + 0.5, z + 0.5));
    assert.ok(spaces.has(owner(...fp)), 'the space behind the door is part of it');
    if (spaces.size > 1) multi++;
    checked++;
    if (checked >= 24) break;
  }
  assert.ok(checked >= 6, `${checked} doors listened through`);
  assert.ok(multi >= 1, `${multi} of them open onto more than one space (a junction and the corridor running on)`);
  air.clearRegion();
  assert.equal(air.behindAt(1, 1), Infinity);
  // the tells: active monsters behind the door within the budget, each every 1.7-2.4 s, kinds without a tell skipped
  const behind = (x: number) => (x >= 0 ? x : Infinity);
  const next = new Map<string, number>();
  const mons = [
    { id: 'hound0', kind: 'hound', x: 3, z: 0, active: true }, { id: 'listener0', kind: 'listener', x: 31, z: 0, active: true },
    { id: 'mannequin0', kind: 'mannequin', x: 5, z: 0, active: false }, { id: 'snatcher0', kind: 'snatcher', x: -2, z: 0, active: true },
    { id: 'weird0', kind: 'weird', x: 1, z: 0, active: true },
  ];
  const t1 = dueTells(mons, behind, 30, 1000, next).map((t) => `${t.id}:${t.path}`);
  assert.deepEqual(t1, ['hound0:3'], 'only the active Hound within 30 m behind the door (the Snatcher is not behind it)');
  assert.deepEqual(dueTells(mons, behind, 30, 2000, next), [], 'not again before 1.7 s');
  const gap = next.get('hound0')! - 1000;
  assert.ok(gap >= 1700 && gap < 2400, `staggered ${gap} ms`);
  assert.deepEqual(dueTells(mons, behind, 30, 1000 + gap, next).map((t) => t.id), ['hound0'], 'and then again');
  mons[1]!.x = 12;
  assert.deepEqual(dueTells(mons, behind, 30, 1000 + gap + 2400, next).map((t) => t.id).sort(), ['hound0', 'listener0'], 'the Listener walked behind the door');
  assert.ok(next.has('weird0'), 'a kind without a tell is paced too (never logged)');
  assert.ok(Object.keys(TELL_SOUND).every((k) => ['hound', 'listener', 'mannequin', 'snatcher'].includes(k)));
});

test('RadioOut without audio: logs, never plays, never throws', () => {
  const r = new RadioOut(() => null, () => 1);
  r.open();
  r.play('sfx.hound_sniff', 0.6, -0.4, 0.92, 'tell:hound');
  r.close();
  assert.equal(r.log.length, 1);
  assert.deepEqual({ ...r.log[0], t: 0 }, { key: 'sfx.hound_sniff', why: 'tell:hound', gain: 0.6, pan: -0.4, played: false, t: 0 });
});
