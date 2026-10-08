// players-stealth (v1.2) unit tests: the shared footstep radius helper and the server's seq-window speed tracker
// (bunched frames over the tunnel, slow clients, seq inflation, teleports), plus the stealth stance judgement.
//   node --test tests/stealth/footsteps.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stepNoiseRadius } from '../../packages/shared/src/messages/players.ts';
import { NOISE_M } from '../../packages/shared/src/constants.ts';
import { STANCE } from '../../packages/shared/src/state.ts';
import { DEFAULT_TRACK_OPTS, feedPose, judgeStance, newTrack, speedAt, stepKindOf } from '../../apps/server/src/players/stealth.ts';
import type { StealthTrack, TrackOpts } from '../../apps/server/src/players/stealth.ts';

const ROOT = join(import.meta.dirname, '../..');
const BAL = JSON.parse(readFileSync(join(ROOT, 'config/balance/players.json'), 'utf8')) as Record<string, unknown>;
const OPTS: TrackOpts = { ...DEFAULT_TRACK_OPTS, crouchMaxSpeed: Number(BAL.crouchMaxSpeed), windowSec: Number(BAL.stealthWindowSec ?? 0.5) };
const JUDGE = { crouchOverSpeedSec: Number(BAL.crouchOverSpeedSec), sprintSpeed: Number(BAL.noiseSprintSpeed) };

test('players.json carries the v1.2 stealth numbers', () => {
  assert.deepEqual(BAL.surfaceNoiseMult, { lino: 1, concrete: 1, wood: 1, rubber: 1, asphalt: 1, dirt: 1, tile: 1.1, carpet: 0.85, metal: 1.3, grate: 1.4 });
  assert.equal(BAL.solesNoiseMult, 0.8);
  assert.equal(BAL.crouchMaxSpeed, 3.0);
  assert.equal(BAL.crouchOverSpeedSec, 0.5);
});

test('stepNoiseRadius: the documented radii per surface', () => {
  const r = (k: 'crouchStep' | 'walkStep' | 'sprintStep', s: string, soles = false) => stepNoiseRadius(k, s, soles, BAL);
  assert.equal(r('walkStep', 'metal'), 6.5);
  assert.equal(r('walkStep', 'grate'), 7);
  assert.equal(r('walkStep', 'tile'), 5.5);
  assert.equal(r('walkStep', 'carpet'), 4.25);
  for (const s of ['lino', 'concrete', 'wood', 'rubber', 'asphalt', 'dirt']) assert.equal(r('walkStep', s), NOISE_M.walkStep, s);
  // rubber stays 1.0: v1.1 server and radio rooms keep their balance
  assert.equal(r('walkStep', 'rubber'), 5);
  // crouching is <= 2.1 m everywhere
  for (const s of Object.keys(BAL.surfaceNoiseMult as object)) assert.ok(r('crouchStep', s) <= 2.1 + 1e-9, `crouch on ${s}: ${r('crouchStep', s)}`);
  assert.equal(r('crouchStep', 'grate'), 2.1);
  // overshoes cut walking to 4 m on a neutral floor
  assert.equal(r('walkStep', 'concrete', true), 4);
  assert.equal(r('walkStep', 'metal', true), 5.2);
  assert.equal(r('sprintStep', 'metal'), 15.6);
});

test('stepNoiseRadius: defaults and bad balance values', () => {
  assert.equal(stepNoiseRadius('walkStep', 'metal', false, {}), 5); // no table: x1
  assert.equal(stepNoiseRadius('walkStep', 'metal', true, {}), 4); // soles default 0.8
  assert.equal(stepNoiseRadius('walkStep', 'water', false, BAL), 5); // unknown surface: x1
  assert.equal(stepNoiseRadius('walkStep', null, false, BAL), 5);
  assert.equal(stepNoiseRadius('walkStep', 'metal', false, null), 5);
  assert.equal(stepNoiseRadius('walkStep', 'metal', false, { surfaceNoiseMult: { metal: Number.NaN } }), 5);
  assert.equal(stepNoiseRadius('walkStep', 'metal', true, { solesNoiseMult: -1 }), 4);
  assert.equal(stepNoiseRadius('bogus', 'concrete', false, BAL), 5); // unknown kind: walk radius
});

/** a client walking straight along +x at `speed`, one pose per `stepMs` (seq +1 each), delivered per `deliver` */
function simulate(o: { speed: number; seconds: number; stepMs?: number; bunch?: number; bunchGapMs?: number; seqPerPose?: number; t?: StealthTrack }): StealthTrack {
  const t = o.t ?? newTrack();
  const stepMs = o.stepMs ?? 50;
  const n = Math.round((o.seconds * 1000) / stepMs);
  const bunch = o.bunch ?? 1;
  let seq = (t.samples.at(-1)?.seq ?? 0) + 1;
  const t0 = t.samples.at(-1)?.at ?? 1000;
  const x0 = t.samples.at(-1)?.x ?? 0;
  for (let i = 0; i < n; i++) {
    const sendAt = t0 + (i + 1) * stepMs;
    // bunching: poses are held back and released together every `bunch` poses (all arrive at the last one's time)
    const arrive = bunch > 1 ? t0 + (Math.floor(i / bunch) + 1) * bunch * stepMs + (o.bunchGapMs ?? 0) : sendAt;
    feedPose(t, seq, arrive, x0 + (o.speed * (i + 1) * stepMs) / 1000, 0, OPTS);
    seq += o.seqPerPose ?? 1;
  }
  return t;
}

test('seq window: steady 20 Hz walker and creeper', () => {
  const walk = simulate({ speed: 3.5, seconds: 2 });
  assert.ok(Math.abs(walk.speed - 3.5) < 0.05, `walk ${walk.speed}`);
  assert.ok(walk.overSec >= 0.5, 'over the crouch limit long enough to walk');
  const creep = simulate({ speed: 1.5, seconds: 2 });
  assert.ok(Math.abs(creep.speed - 1.5) < 0.05, `creep ${creep.speed}`);
  assert.equal(creep.overSec, 0);
});

test('seq window: bunched frames never make a creeper look fast (critic)', () => {
  // 3 poses arrive at once every 150 ms; the per-arrival speed would read 1.5 * 0.05 / 0.002 = 37 m/s
  for (const bunch of [2, 3, 4, 6]) {
    const t = newTrack();
    let maxSpeed = 0;
    let seq = 1;
    for (let i = 0; i < 80; i++) {
      const arrive = 1000 + Math.floor(i / bunch) * bunch * 50 + (i % bunch) * 1; // 1 ms apart inside a bunch
      feedPose(t, seq++, arrive, (1.5 * (i + 1) * 50) / 1000, 0, OPTS);
      if (i > 12) maxSpeed = Math.max(maxSpeed, t.speed);
    }
    assert.ok(maxSpeed <= 1.5 * 1.05, `bunch ${bunch}: creeper max ${maxSpeed}`);
    assert.equal(t.overSec, 0, `bunch ${bunch}: never over the crouch limit`);
  }
});

test('seq window: a slow client (8 fps: one pose per 125 ms) creeping stays a creeper (check #24p)', () => {
  // seq time alone would read 1.5 x 125 / 50 = 3.75 m/s (a walker); the arrival span (minus the 0.1 s jitter
  // allowance) puts it back near 1.5
  const t = simulate({ speed: 1.5, seconds: 3, stepMs: 125 });
  assert.ok(t.speed >= 1.45 && t.speed < 1.5 * 1.15, `slow creep ${t.speed}`);
  assert.equal(t.overSec, 0);
  // and a slow client walking at 3.5 still reads as walking
  const w = simulate({ speed: 3.5, seconds: 3, stepMs: 125 });
  assert.ok(w.speed > 3.4 && w.speed < 3.5 * 1.15, `slow walk ${w.speed}`);
  // ~10 fps (95 ms per pose) with delivery jitter: the jitter allowance only ever overestimates a little
  const t2 = newTrack();
  let seq = 1;
  let max = 0;
  for (let i = 0; i < 60; i++) {
    feedPose(t2, seq++, 1000 + (i + 1) * 95 + [0, 70, 20, 90, 0][i % 5], (1.5 * (i + 1) * 95) / 1000, 0, OPTS);
    if (i > 8) max = Math.max(max, t2.speed);
  }
  assert.ok(max < 2.0, `10 fps creeper max ${max}`);
  assert.equal(t2.overSec, 0);
});

test('seq window: jitter only ever reads slow, and a 3.5 m/s walker stays above the crouch limit', () => {
  const t = newTrack();
  let seq = 1;
  let minAfter = Infinity;
  for (let i = 0; i < 100; i++) {
    const jitter = [0, 40, 10, 90, 20, 0, 60][i % 7]; // ms of extra delay, deterministic
    feedPose(t, seq++, 1000 + (i + 1) * 50 + jitter, (3.5 * (i + 1) * 50) / 1000, 0, OPTS);
    if (i > 20) minAfter = Math.min(minAfter, t.speed);
    assert.ok(t.speed <= 3.5 * 1.02 || i < 3, `never faster than true (${t.speed})`);
  }
  assert.ok(minAfter > OPTS.crouchMaxSpeed, `min ${minAfter}`);
});

test('seq window: inflated sequence numbers (modified client) switch to arrival timing', () => {
  // a client that walks 3.5 m/s but numbers its poses x10 would read 0.35 m/s by seq time alone
  const t = simulate({ speed: 3.5, seconds: 6, seqPerPose: 10 });
  assert.equal(t.arrivalOnly, true);
  assert.ok(Math.abs(t.speed - 3.5) < 0.2, `inflated ${t.speed}`);
  // an honest client never trips it, also after a 2 s stall that delivers 40 poses at once
  const h = simulate({ speed: 1.5, seconds: 4 });
  const last = h.samples.at(-1)!;
  let seq = last.seq + 1;
  for (let i = 0; i < 40; i++) feedPose(h, seq++, last.at + 2000 + i * 0.5, last.x + (1.5 * (i + 1) * 50) / 1000, 0, OPTS);
  for (let i = 0; i < 80; i++) {
    feedPose(h, seq++, last.at + 2000 + (i + 1) * 50, last.x + (1.5 * (41 + i) * 50) / 1000, 0, OPTS);
    assert.equal(h.overSec, 0, `after the stall: speed ${h.speed}`);
  }
  assert.equal(h.arrivalOnly, false);
});

test('sprint window: a crouch-claimed sprint from standstill reads as a sprint within ~0.25 s', () => {
  const t = newTrack();
  let seq = 1;
  for (let i = 0; i < 20; i++) feedPose(t, seq++, 1000 + i * 50, 0, 0, OPTS); // 1 s idle
  let x = 0;
  let firstSprintMs = -1;
  for (let i = 1; i <= 20; i++) {
    x += 5.5 * 0.05;
    feedPose(t, seq++, 1950 + i * 50, x, 0, OPTS);
    const st = judgeStance(STANCE.crouch, t.speed, t.overSec, true, false, JUDGE, Math.max(t.speed, t.fastSpeed));
    if (st === STANCE.sprint && firstSprintMs < 0) firstSprintMs = i * 50;
  }
  assert.ok(firstSprintMs > 0 && firstSprintMs <= 250, `sprint after ${firstSprintMs} ms`);
  // and a 3.0 m/s walker never trips the short window, bunched or not
  const w = newTrack();
  seq = 1;
  for (let i = 0; i < 80; i++) {
    feedPose(w, seq++, 1000 + Math.floor(i / 3) * 150 + (i % 3), (3.0 * (i + 1) * 50) / 1000, 0, OPTS);
    assert.ok(Math.max(w.speed, w.fastSpeed) <= 3.0 * 1.05, `walker short window ${w.fastSpeed}`);
  }
});

test('seq window: teleports, new connections and stale tracks', () => {
  const t = simulate({ speed: 1.5, seconds: 1 });
  const last = t.samples.at(-1)!;
  assert.equal(feedPose(t, last.seq + 1, last.at + 50, last.x + 10, 0, OPTS), null, 'a 10 m jump restarts the track');
  assert.equal(t.samples.length, 1);
  assert.equal(t.speed, 0);
  simulate({ speed: 1.5, seconds: 1, t });
  const l2 = t.samples.at(-1)!;
  assert.equal(feedPose(t, 3, l2.at + 50, l2.x, 0, OPTS), null, 'a lower seq (new connection) restarts the track');
  assert.equal(speedAt(t, l2.at + 5000), 0, 'an idle / stalled track reads 0');
});

test('stealth stance judgement (plan check #6)', () => {
  const j = (claim: number, speed: number, over = 0, alive = true, hidden = false) => judgeStance(claim, speed, over, alive, hidden, JUDGE);
  assert.equal(j(STANCE.crouch, 1.5), STANCE.crouch);
  assert.equal(j(STANCE.crouch, 3.5, 0.2), STANCE.crouch, 'not yet over the limit long enough');
  assert.equal(j(STANCE.crouch, 3.5, 0.5), STANCE.stand, 'a fast crouch claim walks');
  assert.equal(j(STANCE.crouch, 5.5, 0), STANCE.sprint, 'above noiseSprintSpeed it is always a sprint');
  assert.equal(j(STANCE.stand, 5.5), STANCE.sprint);
  assert.equal(j(STANCE.sprint, 3.0), STANCE.sprint);
  assert.equal(j(STANCE.hidden, 3.0), STANCE.stand, 'a claimed hidden stance outside a hiding spot walks');
  assert.equal(j(STANCE.hidden, 0, 0, true, true), STANCE.hidden);
  assert.equal(j(STANCE.stand, 3.0, 0, true, true), STANCE.hidden, 'a real hiding spot wins over the claim');
  assert.equal(j(STANCE.dead, 3.0), STANCE.stand, 'a living dead-claim walks');
  assert.equal(j(STANCE.stand, 3.0, 0, false), STANCE.dead);
  assert.equal(stepKindOf(STANCE.crouch), 'crouchStep');
  assert.equal(stepKindOf(STANCE.stand), 'walkStep');
  assert.equal(stepKindOf(STANCE.sprint), 'sprintStep');
  assert.equal(stepKindOf(STANCE.hidden), null);
  assert.equal(stepKindOf(STANCE.dead), null);
});
