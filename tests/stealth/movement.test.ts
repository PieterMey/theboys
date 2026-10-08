// players-stealth (v1.2) unit tests for apps/server/src/net/movement.ts, plan checks #3 / #7 (no server, no ws):
//   - a LIVING player (interaction's isAlive) who claims the dead or hidden stance is validated like stand and the
//     pose is rewritten to stand before it is stored (no free flight through walls, no re-armed revive grace)
//   - the truly dead (roster flag, or interaction's dead list) keep the free spectator camera
//   - the revive grace still accepts the first poses after a real death
// tests/net/aud.test.ts (net-owned, frozen this round) still pins the v1.1 rule on its last line; the integrator has
// the one-line patch (G1 fix-round report).
//   node --test tests/stealth/movement.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import { STANCE } from '../../packages/shared/src/state.ts';
import type { Crew, PlayerPose, ServerContext, ServerPlayer } from '../../apps/server/src/core/types.ts';
import { makePoseHook, setValidation, startGrace } from '../../apps/server/src/net/movement.ts';
import { slice } from '../../apps/server/src/interaction/engine.ts';

/** 12x6: room 0 = x 0..5, room 1 = x 6..11, wall on x=6 with door 0 at row 2 (the net test's layout) */
function twoRooms(): LevelLayout {
  const W = 12, H = 6;
  const owner: number[] = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) owner.push(x < 6 ? 0 : 1);
  const space = (id: number, x: number) => ({ id, kind: 'room' as const, rect: { x, y: 0, w: 6, h: 6 }, zone: 0, type: 'office', callsign: null, dist: 0, light: 'on' as const, open: false, powerZone: 0 });
  return {
    genVersion: 1, kind: 'facility', seed: 'mv', hash: 'mv', theme: 't', W, H, owner,
    spaces: [space(0, 0), space(1, 6)],
    doors: [{ id: 0, a: 0, b: 1, x: 6, y: 2, dir: 'v', len: 1, kind: 'door', lock: 0, initiallyOpen: false }],
    items: [], entrance: 0, van: { x: 10, z: 4, yaw: 0, cab: { x: 9, y: 3, w: 2, h: 2 } }, zones: 1, wallH: 3, metrics: {},
  } as unknown as LevelLayout;
}

const sent: { e: string; to?: string[] }[] = [];
const ctx = {
  balance: { core: {}, net: {} },
  emit: (_c: unknown, e: string, _d: unknown, o?: { to?: string[] }) => { sent.push({ e, to: o?.to }); },
  log: () => ({ debug() {}, info() {}, warn() {}, error() {} }),
} as unknown as ServerContext;

function setup(): { hook: ReturnType<typeof makePoseHook>; crew: Crew; p: ServerPlayer } {
  const p = {
    id: 'a', key: 'a', name: 'a', profile: {} as ServerPlayer['profile'], connected: true, ready: false, alive: true,
    consent: { transcribe: false, mimic: false }, level: 1,
    pose: { seq: 0, p: [2.5, 0, 2.5], yaw: 0, pitch: 0, stance: 0, anim: 0, light: 0 }, poseAt: performance.now() - 100,
    band: 2, radio: 0, socket: null, resume: 'a', joinedAt: 0, isLeader: false, disconnectedAt: 0, slices: {},
  } as unknown as ServerPlayer;
  const crew = { code: 'MOVE', phase: 'contract', players: new Map([[p.id, p]]), layout: twoRooms(), slices: {}, createdAt: 0, tick: 0, emptySince: 0 } as unknown as Crew;
  return { hook: makePoseHook(ctx), crew, p };
}
const pose = (x: number, z: number, stance: number = STANCE.stand): PlayerPose => ({ seq: 1, p: [x, 0, z], yaw: 0, pitch: 0, stance, anim: 0, light: 0 });

test('a living player claiming the dead stance is validated like stand and stored as stand (#7)', () => {
  const { hook, crew, p } = setup();
  const far = pose(40, 40, STANCE.dead);
  assert.equal(hook(crew, p, far), false, 'a 40 m dead-claim jump is rejected');
  assert.equal(far.stance, STANCE.stand, 'rewritten to stand before storing');
  assert.equal(sent.at(-1)?.e, 'net.correct');
  // through the wall at row 4 (no door there): a dead claim is no ghost pass
  p.pose = pose(5.7, 4.5);
  p.poseAt = performance.now() - 200;
  assert.equal(hook(crew, p, pose(6.3, 4.5, STANCE.dead)), false, 'no wall clip with a dead claim');
  // an ordinary step with a stale dead stance (the client right after a revive) is fine, as stand
  p.pose = pose(2.5, 2.5);
  p.poseAt = performance.now() - 100;
  const step = pose(2.8, 2.5, STANCE.dead);
  assert.notEqual(hook(crew, p, step), false, 'a small step is accepted');
  assert.equal(step.stance, STANCE.stand);
});

test('a hidden claim is never taken on trust: rewritten to stand and validated', () => {
  const { hook, crew, p } = setup();
  const step = pose(2.8, 2.5, STANCE.hidden);
  assert.notEqual(hook(crew, p, step), false);
  assert.equal(step.stance, STANCE.stand, 'the interaction / Snatcher hooks set hidden for real hiding spots');
  p.poseAt = performance.now();
  assert.equal(hook(crew, p, pose(2.8, 22.5, STANCE.hidden)), false, 'a hidden-claim teleport is rejected');
});

test('the rewrite holds while validation is switched off for the crew (dbg.net.validate)', () => {
  const { hook, crew, p } = setup();
  setValidation(crew, false);
  const far = pose(40, 40, STANCE.dead);
  assert.notEqual(hook(crew, p, far), false, 'validation off: accepted');
  assert.equal(far.stance, STANCE.stand, 'but still stored as stand');
  setValidation(crew, true);
});

test('the truly dead keep the free spectator camera (roster flag or interaction dead list)', () => {
  const { hook, crew, p } = setup();
  p.alive = false;
  const cam = pose(40, 40, STANCE.dead);
  assert.notEqual(hook(crew, p, cam), false, 'roster dead: free');
  assert.equal(cam.stance, STANCE.dead, 'the spectator pose keeps its dead stance');
  p.alive = true;
  slice(crew).dead.push(p.id);
  const cam2 = pose(-30, 9, STANCE.dead);
  assert.notEqual(hook(crew, p, cam2), false, 'interaction says dead: free');
  assert.equal(cam2.stance, STANCE.dead);
});

test('the revive grace still accepts the first poses after a real death', () => {
  const { hook, crew, p } = setup();
  // the last stored pose is the spectator camera from while the player was dead
  p.pose = pose(40, 40, STANCE.dead);
  p.poseAt = performance.now() - 50;
  p.alive = true; // revived
  const back = pose(9.5, 4.5);
  assert.notEqual(hook(crew, p, back), false, 'the first pose after the revive is accepted (grace)');
  // and the grace is the normal one: startGrace stays the only way to re-arm it
  startGrace(p, 0, 0);
  p.pose = pose(9.5, 4.5);
  p.poseAt = performance.now();
  assert.equal(hook(crew, p, pose(2.5, 2.5, STANCE.dead)), false, 'after the grace a living dead-claim jump is rejected again');
});
