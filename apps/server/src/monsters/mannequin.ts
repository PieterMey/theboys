// Owner: track (c) Monsters. THE MANNEQUIN (risk >= 2 or the crew's 3rd contract; flag 'mannequin').
// Frozen while any living player sees it AND it is lit. Sightings are computed client-side ('monsters.see': in frustum,
// LOS clear, <= 30 m, not during that player's visor blink) and combined here with the server's own LOS + light check.
// Unobserved it moves at 7 m/s toward the nearest living player and kills on touch. Each player's visor blinks for
// 0.35 s every 18-30 s on its own timer (server schedules it and tells that client). Spawns at 23:30 game time or when
// the Core is lifted, >= 25 m from everyone (2 players) and out of sight.
import { ANIM } from '@dead-air/shared/anim.ts';
import { CLOCK } from '@dead-air/shared/constants.ts';
import { cellOf, los } from '@dead-air/shared/nav/index.ts';
import type { ServerPlayer } from '../core/types.ts';
import type { Rt } from './runtime.ts';
import { makeAgentBase } from './runtime.ts';
import { dist, follow, inCab, monsterCanOpen, planTo, randomReachable, sees, walkField } from './geo.ts';
import { extBlackout, extClockMin, extCoreLifted, extLightsOn, extLitAt } from './ext.ts';
import { num } from './types.ts';
import type { MannequinAgent } from './types.ts';

export function makeMannequin(id: string, x: number, z: number, yaw: number): MannequinAgent {
  const a = makeAgentBase(id, 'mannequin', x, z, yaw);
  return { ...a, state: 'dormant', anim: ANIM.mFrozen, active: false, spawned: false, movedAt: -100, observed: false };
}

/** in-game minutes since 22:00 (objectives clock, else derived from the contract time) */
export function clockMin(rt: Rt): number {
  const ext = extClockMin(rt.crew);
  if (ext !== undefined && ext >= 0) return ext;
  const realSec = Number(rt.ctx.balance.core.contractRealSec ?? CLOCK.realSec) || CLOCK.realSec;
  return (rt.cm.time / realSec) * CLOCK.totalGameMin;
}

/** is (x, z) lit: interaction's litAt, else room light (minus blackout) or any flashlight cone */
export function litAt(rt: Rt, x: number, z: number): boolean {
  const ext = extLitAt(rt.crew, x, z);
  if (ext === true) return true;
  const L = rt.cm.layout;
  const s = L.owner[cellOf(rt.cm.grid, x, z)] ?? -1;
  if (ext === undefined && s >= 0) {
    const on = extLightsOn(rt.crew, s);
    const roomLit = on !== undefined ? on : (L.spaces[s]?.light === 'on' || L.spaces[s]?.light === 'flicker') && !extBlackout(rt.crew);
    if (roomLit) return true;
  }
  const range = num(rt.mannequin, 'flashlightRangeM', 14), half = num(rt.mannequin, 'flashlightHalfAngleDeg', 28);
  for (const p of rt.alive()) {
    if (!p.pose.light) continue;
    if (sees(rt.cm.grid, rt.cm.doorOpen, p.pose.p[0], p.pose.p[2], p.pose.yaw, x, z, range, half * 2)) return true;
  }
  return false;
}

export function isBlinking(rt: Rt, pid: string): boolean {
  const b = rt.cm.blinks.get(pid);
  return !!b && rt.cm.time >= b.next - 1e-6 && rt.cm.time < b.end;
}

function observedBy(rt: Rt, m: MannequinAgent): ServerPlayer | null {
  const sight = rt.cm.sight.get(m.id);
  if (!sight) return null;
  const now = performance.now();
  const range = num(rt.mannequin, 'seeRangeM', 30);
  for (const p of rt.alive()) {
    const s = sight.get(p.id);
    // a client that stalls (shader compile, tab hitch) stops sending poses AND reports: keep its last sighting
    const ps = p.slices.monsters as { poses?: number; lastPose?: number } | undefined;
    const gap = now - (ps?.lastPose ?? 0);
    const stalled = (ps?.poses ?? 0) > 10 && gap > 250 && gap < 4000;
    if (!s || (s.until < now && !(stalled && s.until >= (ps?.lastPose ?? 0) - 100))) continue;
    if (isBlinking(rt, p.id)) continue;
    const [px, , pz] = p.pose.p;
    if (dist(px, pz, m.x, m.z) > range) continue;
    if (!los(rt.cm.grid, px, pz, m.x, m.z, rt.cm.doorOpen)) continue;
    return p;
  }
  return null;
}

function spawnCondition(rt: Rt): boolean {
  if (rt.ctx.flags.mannequin === false) return false;
  return clockMin(rt) >= num(rt.mannequin, 'spawnGameMin', 90) || extCoreLifted(rt.crew);
}

/** out of sight of every living player and far enough from all of them */
function placeOutOfView(rt: Rt, m: MannequinAgent, minD: number): boolean {
  const cm = rt.cm;
  const players = rt.alive().filter((p) => !inCab(cm.layout, p.pose.p[0], p.pose.p[2]));
  const ok = (x: number, z: number) => players.every((p) => {
    const [px, , pz] = p.pose.p;
    return dist(px, pz, x, z) >= minD * 0.6 && !los(cm.grid, px, pz, x, z, cm.doorOpen);
  });
  // path distance from the nearest player
  const near = players[0];
  const field = near ? walkField(cm, near.pose.p[0], near.pose.p[2], 200, monsterCanOpen(cm.layout)) : null;
  const pathOk = (x: number, z: number) => !field || (field[cellOf(cm.grid, x, z)] ?? Infinity) >= minD;
  const spots = cm.layout.items.filter((i) => i.kind === 'spawn_mannequin');
  const cands: [number, number][] = spots.map((s) => [s.x, s.z]);
  for (let i = 0; i < 24; i++) {
    const c = randomReachable(cm, m.x, m.z, 0, 120, -1, monsterCanOpen(cm.layout));
    if (c) cands.push(c);
  }
  let best: [number, number] | null = null, bestScore = Infinity;
  for (const [x, z] of cands) {
    if (!ok(x, z) || !pathOk(x, z)) continue;
    const d = field ? (field[cellOf(cm.grid, x, z)] ?? Infinity) : 0;
    const score = Math.abs(d - minD); // close to the minimum: relevant, but not unfair
    if (score < bestScore) { bestScore = score; best = [x, z]; }
  }
  if (!best) return false;
  m.x = best[0];
  m.z = best[1];
  return true;
}

export function relocateMannequin(rt: Rt, m: MannequinAgent): boolean {
  if (!m.spawned || m.observed) return false;
  return placeOutOfView(rt, m, 12);
}

function spawn(rt: Rt, m: MannequinAgent): void {
  const minD = rt.cm.players <= 2 ? num(rt.mannequin, 'spawnMinDistM', 25) : num(rt.mannequin, 'spawnMinDistBigCrewM', 15);
  if (!placeOutOfView(rt, m, minD) && !placeOutOfView(rt, m, minD * 0.6)) return; // try again next tick
  m.spawned = true;
  m.active = true;
  m.state = 'frozen';
  m.st = 0;
  m.anim = ANIM.mFrozen;
  for (const p of rt.alive()) scheduleBlink(rt, p.id, 4 + rt.cm.rng.next() * 8);
  rt.ctx.log('monsters').info(`crew ${rt.crew.code}: mannequin spawned at ${m.x.toFixed(1)},${m.z.toFixed(1)}`);
}

function nearestTarget(rt: Rt, m: MannequinAgent): ServerPlayer | null {
  const field = walkField(rt.cm, m.x, m.z, 160, monsterCanOpen(rt.cm.layout));
  let best: ServerPlayer | null = null, bd = Infinity;
  for (const p of rt.alive()) {
    if (rt.hidden(p) || inCab(rt.cm.layout, p.pose.p[0], p.pose.p[2])) continue;
    const d = field[cellOf(rt.cm.grid, p.pose.p[0], p.pose.p[2])] ?? Infinity;
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}

export function mannequinTick(rt: Rt, m: MannequinAgent, dt: number): void {
  const cm = rt.cm;
  if (!m.spawned) {
    if (spawnCondition(rt)) spawn(rt, m);
    return;
  }
  if (m.state === 'out') {
    m.active = false;
    if (cm.time >= m.outUntil && placeOutOfView(rt, m, 15)) {
      m.active = true;
      m.state = 'frozen';
      m.st = 0;
    }
    return;
  }
  if (m.state === 'frozen' && m.st < 2 && cm.time - m.movedAt > 2) { m.anim = ANIM.mFrozen; return; } // spawn/return grace
  const watcher = observedBy(rt, m);
  const lit = watcher ? litAt(rt, m.x, m.z) : false;
  m.observed = !!watcher && lit;
  if (m.observed) {
    if (m.state !== 'frozen') { m.state = 'frozen'; m.st = 0; }
    m.anim = ANIM.mFrozen;
    return;
  }
  // unobserved: hunt the nearest living player
  const target = nearestTarget(rt, m);
  if (!target) {
    m.state = 'frozen';
    m.anim = ANIM.mFrozen;
    return;
  }
  const [tx, , tz] = target.pose.p;
  if (!m.path || cm.time - m.planAt > 0.4) planTo(cm, m, tx, tz, monsterCanOpen(cm.layout));
  const r = follow(cm, m, dt, num(rt.mannequin, 'speed', 7), monsterCanOpen(cm.layout), num(rt.mannequin, 'doorPauseSec', 1.5), rt.openDoor);
  m.state = r === 'door' ? 'door' : 'move';
  m.anim = r === 'door' ? ANIM.mFrozen : ANIM.mRun;
  m.movedAt = cm.time;
  if (r === 'arrived' || r === 'blocked') m.path = null;
  for (const p of rt.alive()) {
    if (rt.hidden(p)) continue;
    const [px, , pz] = p.pose.p;
    if (dist(px, pz, m.x, m.z) <= num(rt.mannequin, 'killRadiusM', 0.8)) {
      let mate = Infinity;
      for (const q of rt.alive()) if (q !== p) mate = Math.min(mate, dist(q.pose.p[0], q.pose.p[2], px, pz));
      const detail = Number.isFinite(mate) ? `${Math.round(mate)} m from the nearest teammate` : 'alone';
      m.anim = ANIM.mAttack;
      rt.kill(m, p, 'nobody was watching it', detail);
      return;
    }
  }
}

export function scheduleBlink(rt: Rt, pid: string, inSec?: number): void {
  const lo = num(rt.mannequin, 'blinkMinSec', 18), hi = num(rt.mannequin, 'blinkMaxSec', 30);
  const next = rt.cm.time + (inSec ?? lo + rt.cm.rng.next() * (hi - lo));
  rt.cm.blinks.set(pid, { next, end: next + num(rt.mannequin, 'blinkMs', 350) / 1000, sent: false });
}

/** per-player visor blink schedule (only while a mannequin is in play) */
export function blinkTick(rt: Rt): void {
  const cm = rt.cm;
  const m = cm.agents.find((a) => a.kind === 'mannequin') as MannequinAgent | undefined;
  if (!m || !m.spawned) return;
  const lead = num(rt.mannequin, 'blinkLeadMs', 200) / 1000;
  for (const p of rt.alive()) {
    let b = cm.blinks.get(p.id);
    if (!b) {
      scheduleBlink(rt, p.id);
      b = cm.blinks.get(p.id)!;
    }
    if (!b.sent && cm.time >= b.next - lead) {
      b.sent = true;
      rt.ctx.emit(rt.crew, 'monsters.blink', { at: rt.serverMs(b.next), ms: Math.round((b.end - b.next) * 1000) }, { to: [p.id] });
    }
    if (cm.time >= b.end) scheduleBlink(rt, p.id);
  }
}
