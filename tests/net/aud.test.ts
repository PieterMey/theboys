// Track ① Net: Snapshot.aud correctness + perf, and pose validation. Run: node --test tests/net/aud.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import type { Snapshot } from '../../packages/shared/src/state.ts';
import { generateFacility } from '../../packages/shared/src/procgen/index.ts';
import type { Crew, ServerContext, ServerPlayer, PlayerPose } from '../../apps/server/src/core/types.ts';
import { audCrewSnapshot, audForReceiver, audStats } from '../../apps/server/src/net/aud.ts';
import { makePoseHook } from '../../apps/server/src/net/movement.ts';

/** 12x6: room 0 = x 0..5, room 1 = x 6..11, wall on line x=6 with door 0 at row 2; van cab rect inside room 1 */
function twoRooms(): LevelLayout {
  const W = 12, H = 6;
  const owner: number[] = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) owner.push(x < 6 ? 0 : 1);
  const space = (id: number, x: number) => ({ id, kind: 'room' as const, rect: { x, y: 0, w: 6, h: 6 }, zone: 0, type: 'office', callsign: null, dist: 0, light: 'on' as const, open: false, powerZone: 0 });
  return {
    genVersion: 1, kind: 'facility', seed: 't', hash: 't', theme: 't', W, H, owner,
    spaces: [space(0, 0), space(1, 6)],
    doors: [{ id: 0, a: 0, b: 1, x: 6, y: 2, dir: 'v', len: 1, kind: 'door', lock: 0, initiallyOpen: false }],
    items: [], entrance: 0, van: { x: 10, z: 4, yaw: 0, cab: { x: 9, y: 3, w: 2, h: 2 } }, zones: 1, wallH: 3, metrics: {},
  };
}

const ctx = { balance: { core: {}, net: {} }, emit: () => {}, log: () => ({ debug() {}, info() {}, warn() {}, error() {} }) } as unknown as ServerContext;

function player(id: string, x: number, z: number, band = 2): ServerPlayer {
  return {
    id, key: id, name: id, profile: {} as ServerPlayer['profile'], connected: true, ready: false, alive: true,
    consent: { transcribe: false, mimic: false }, level: 1,
    pose: { seq: 0, p: [x, 0, z], yaw: 0, pitch: 0, stance: 0, anim: 0, light: 0 }, poseAt: performance.now(),
    band, radio: 0, socket: null, resume: id, joinedAt: 0, isLeader: false, disconnectedAt: 0, slices: {},
  };
}

function crewWith(layout: LevelLayout | null, ps: ServerPlayer[]): Crew {
  return { code: 'TEST', phase: 'contract', players: new Map(ps.map((p) => [p.id, p])), layout, slices: {}, createdAt: 0, tick: 0, emptySince: 0 };
}

const emptySnap = (): Snapshot => ({ t: 0, tick: 0, players: [], monsters: [], dyn: [], aud: {} });

function audOf(crew: Crew, receiver: ServerPlayer): Record<string, number> {
  const base = emptySnap();
  audCrewSnapshot(crew, base, ctx);
  const s = { ...base, aud: { ...base.aud } };
  audForReceiver(crew, receiver, s, ctx);
  return s.aud;
}

test('closed door costs +6 m, open door +1 m (octile path)', () => {
  const a = player('a', 4.5, 2.5), b = player('b', 7.5, 2.5);
  const crew = crewWith(twoRooms(), [a, b]);
  const closed = audOf(crew, b);
  assert.equal(closed.a, 9, `closed: 3 steps + 6 (got ${closed.a})`);
  crew.slices.interaction = { doors: { 0: { open: true, locked: false } } };
  const open = audOf(crew, b);
  assert.equal(open.a, 4, `open: 3 steps + 1 (got ${open.a})`);
  // symmetric
  assert.equal(audOf(crew, a).b, 4);
  // the receiver never gets itself
  assert.equal(open.b, undefined);
});

// playtest fix: the cab is NOT sealed for player-to-player voice (normal path distance through the open rear
// doorway); it stays a sanctuary for monster hearing only (apps/server/src/monsters/runtime.ts)
test('van cab is not sealed for player voice: inside <-> outside uses the path distance; both inside -> audible', () => {
  const inCab = player('c', 9.5, 3.5), outside = player('d', 8.5, 3.5), inCab2 = player('e', 10.5, 4.5);
  const crew = crewWith(twoRooms(), [inCab, outside, inCab2]);
  const io = audOf(crew, outside).c, oi = audOf(crew, inCab).d;
  assert.ok(io < 255 && oi < 255 && io <= 3 && oi <= 3, `inside <-> 1 m outside audible (got ${io}, ${oi})`);
  const both = audOf(crew, inCab).e;
  assert.ok(both <= 2, `both inside: near (got ${both})`);
});

test('wall without door: path goes around (or 255); no layout -> Euclidean', () => {
  // receiver in a solid-free room, speaker across the wall at a row far from the door
  const a = player('a', 5.5, 5.5), b = player('b', 6.5, 5.5);
  const crew = crewWith(twoRooms(), [a, b]);
  const d = audOf(crew, b).a;
  assert.ok(d > 6 && d < 255, `around through the closed door (got ${d})`);
  const c2 = crewWith(null, [player('x', 0, 0), player('y', 3, 4)]);
  assert.equal(audOf(c2, c2.players.get('y')!).x, 5);
});

test('perf: 6 talking players moving every snapshot on a 6-player facility < 2 ms / snapshot', () => {
  const L = generateFacility({ seed: 'net-perf', players: 6, risk: 1 });
  const walk = L.items.filter((i) => i.kind === 'spawn_player' || i.kind === 'loot' || i.kind === 'lever');
  const ps = Array.from({ length: 6 }, (_, i) => player(`p${i}`, walk[i % walk.length].x, walk[i % walk.length].z, 3));
  const crew = crewWith(L, ps);
  const N = 200;
  let worst = 0;
  const t0 = performance.now();
  for (let k = 0; k < N; k++) {
    // force every speaker into a new cell each snapshot (worst case: 6 floods)
    for (const [i, p] of ps.entries()) {
      const it = walk[(i * 7 + k) % walk.length];
      p.pose = { ...p.pose, p: [it.x, 0, it.z] };
    }
    const s0 = performance.now();
    const base = emptySnap();
    audCrewSnapshot(crew, base, ctx);
    for (const r of ps) audForReceiver(crew, r, { ...base, aud: {} }, ctx);
    worst = Math.max(worst, performance.now() - s0);
  }
  const avg = (performance.now() - t0) / N;
  console.log(`aud perf ${L.W}x${L.H}, 6 players: avg ${avg.toFixed(3)} ms, worst ${worst.toFixed(3)} ms, floods ${audStats.floods}`);
  assert.ok(avg < 2, `avg ${avg} ms`);
});

test('pose validation: walk ok, teleport and wall-crossing rejected with net.correct', () => {
  const sent: { e: string; d: unknown; to?: string[] }[] = [];
  const c = { ...ctx, emit: (_crew: unknown, e: string, d: unknown, o?: { to?: string[] }) => sent.push({ e, d, to: o?.to }) } as unknown as ServerContext;
  const hook = makePoseHook(c);
  const p = player('a', 2.5, 2.5);
  p.poseAt = performance.now() - 100;
  const crew = crewWith(twoRooms(), [p]);
  const pose = (x: number, z: number): PlayerPose => ({ seq: 1, p: [x, 0, z], yaw: 0, pitch: 0, stance: 0, anim: 0, light: 0 });
  assert.notEqual(hook(crew, p, pose(2.8, 2.5)), false, 'small step accepted');
  p.pose = pose(2.8, 2.5);
  p.poseAt = performance.now();
  assert.equal(hook(crew, p, pose(2.8, 2.5 + 20)), false, 'teleport rejected');
  assert.equal(sent.at(-1)?.e, 'net.correct');
  assert.deepEqual(sent.at(-1)?.to, ['a']);
  // through the wall at row 4 (no door there)
  p.pose = pose(5.7, 4.5);
  p.poseAt = performance.now() - 200;
  assert.equal(hook(crew, p, pose(6.3, 4.5)), false, 'wall crossing rejected');
  // through the doorway at row 2 (door closed but validateClosedDoors=false): accepted
  p.pose = pose(5.7, 2.5);
  p.poseAt = performance.now() - 200;
  assert.notEqual(hook(crew, p, pose(6.3, 2.5)), false, 'doorway accepted');
  // v1.2 (plan check #7): a LIVING player's dead claim is validated like stand and stored as stand
  p.pose = pose(2, 2);
  { const q = { ...pose(40, 40), stance: 4 }; assert.equal(hook(crew, p, q), false, 'living dead-claim validated'); assert.equal(q.stance, 0, 'rewritten to stand'); }
  // truly dead players (spectator camera) are never validated
  p.alive = false;
  assert.notEqual(hook(crew, p, { ...pose(40, 40), stance: 4 }), false, 'truly dead: free');
});
