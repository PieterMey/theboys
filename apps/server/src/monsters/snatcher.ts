// Owner: track (c) Monsters. THE SNATCHER (v1.1; risk >= 2 or (v1.3) the crew's 3rd contract onward; max 1 per contract;
// never in the first 2 minutes; never in the van). It lurks in the vent network (layout 'vent' grates) and teaches the
// buddy system: a player who has had no living teammate within 10 m for >= 8 s and is within 16 m (walking) of a grate
// gets stalked. Tells: the grate rattles, dust trickles from it and from the ceiling above the player, then a soft
// clicking ~1.4 s before it DROPS onto them. It drags them along the floor to that grate and into the duct (the
// victim's camera follows the drag; dark + muffled inside). The victim mashes E to slow it. A teammate who follows the
// scratching / the drag trail and holds E for 2 s at the victim (floor) or at the grate (in the duct) pulls them out.
// At the end of the drag (20 s at base pace) the victim dies: 'SNATCHER took you while you were alone'. It retreats into
// the ducts after a rescue (60 s) or a kill (90 s). Solo crews (1 living player) are never snatched (nobody could help).
import { ANIM } from '@dead-air/shared/anim.ts';
import { cellOf } from '@dead-air/shared/nav/index.ts';
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import type { MonsterCue, SnatchEvent } from '@dead-air/shared/messages/monsters.ts';
import { STANCE } from '@dead-air/shared/state.ts';
import type { PlayerPose, ServerPlayer } from '../core/types.ts';
import type { Rt } from './runtime.ts';
import { logCue, makeAgentBase, monsterEvent } from './runtime.ts';
import { dist, inCab, planTo, walkField, yawTo } from './geo.ts';
import { isAlive } from './ext.ts';
import { num } from './types.ts';
import type { CrewMonsters, Grate, SnatcherAgent } from './types.ts';

const r2 = (v: number) => Math.round(v * 100) / 100;
const DRAGGING = new Set(['drop', 'drag', 'duct']);

/** every vent grate of the layout with its inward normal and the walkable rescue spot in front of it */
export function gratesOf(L: LevelLayout): Grate[] {
  const own = (x: number, z: number) => (x >= 0 && z >= 0 && x < L.W && z < L.H ? L.owner[Math.floor(z) * L.W + Math.floor(x)] ?? -1 : -1);
  const out: Grate[] = [];
  for (const it of L.items) {
    if (it.kind !== 'vent') continue;
    const rot = it.rot ?? 0;
    let nx = Math.sin(rot), nz = Math.cos(rot);
    // the mount yaw faces into the room; verify (and flip) against the grate's own space
    if (own(it.x + nx * 0.6, it.z + nz * 0.6) !== it.space && own(it.x - nx * 0.6, it.z - nz * 0.6) === it.space) { nx = -nx; nz = -nz; }
    let fx = it.x + nx * 0.6, fz = it.z + nz * 0.6;
    if (own(fx, fz) < 0) { fx = it.x + nx * 0.35; fz = it.z + nz * 0.35; }
    out.push({ id: it.id, to: String(it.data?.to ?? ''), space: it.space, x: it.x, z: it.z, nx, nz, fx, fz });
  }
  return out;
}

export function makeSnatcher(id: string, L: LevelLayout, readyAt: number): SnatcherAgent | null {
  const grates = gratesOf(L);
  if (!grates.length) return null;
  const g = grates[0];
  const a = makeAgentBase(id, 'snatcher', g.x - g.nx * 0.3, g.z - g.nz * 0.3, Math.atan2(g.nx, g.nz));
  return {
    ...a, state: 'dormant', active: false, readyAt, grates, grate: g,
    aloneSince: new Map(), victim: null, aloneFor: 0, dragPath: [], dragCum: [0], sHead: 0, sVictim: 0, progress: 0,
    struggle: 0, lastStruggleAt: -100, pulls: new Map(), pull: 0, stalkUntil: 0, clicked: false,
    nextTellAt: readyAt + 4, nextMoveAt: readyAt, nextScanAt: 0, nextTickEvAt: 0, nextScratchAt: 0, lastEndAt: -100,
    snatches: 0, rescues: 0,
  };
}

export function snatcherOf(cm: CrewMonsters | null): SnatcherAgent | null {
  return (cm?.agents.find((a) => a.kind === 'snatcher') as SnatcherAgent | undefined) ?? null;
}

/** player id currently being dragged (other monsters leave them alone), or null */
export function snatchVictim(cm: CrewMonsters | null): string | null {
  const s = snatcherOf(cm);
  return s && s.victim && DRAGGING.has(s.state) ? s.victim : null;
}

function cueAt(rt: Rt, s: SnatcherAgent, cue: MonsterCue, x: number, y: number, z: number, radius: number): void {
  rt.ctx.emit(rt.crew, 'monsters.cue', { id: s.id, kind: s.kind, cue, p: [r2(x), r2(y), r2(z)], radius });
  logCue(rt.cm, s.id, s.kind, x, z, radius);
}

function inVan(rt: Rt, p: ServerPlayer): boolean {
  const L = rt.cm.layout;
  const [x, , z] = p.pose.p;
  if (inCab(L, x, z)) return true;
  const sp = L.spaces[L.owner[cellOf(rt.cm.grid, x, z)] ?? -1];
  return !!sp && (sp.type === 'van' || sp.callsign === 'VAN');
}

function rand(rt: Rt, lo: number, hi: number): number {
  return lo + rt.cm.rng.next() * (hi - lo);
}

/** per player: since when nobody living has been within aloneM (deleted when a buddy is near, in the van or dead) */
function trackAlone(rt: Rt, s: SnatcherAgent): void {
  const t = rt.cm.time;
  const aloneM = num(rt.snatcher, 'aloneM', 10);
  const alive = rt.alive();
  const seen = new Set<string>();
  for (const p of alive) {
    seen.add(p.id);
    const [px, , pz] = p.pose.p;
    const buddy = alive.some((q) => q !== p && dist(q.pose.p[0], q.pose.p[2], px, pz) <= aloneM);
    if (buddy || inVan(rt, p) || (rt.hidden(p) && p.id !== s.victim)) s.aloneSince.delete(p.id);
    else if (!s.aloneSince.has(p.id)) s.aloneSince.set(p.id, t);
  }
  for (const id of s.aloneSince.keys()) if (!seen.has(id)) s.aloneSince.delete(id);
}

function placeBehind(s: SnatcherAgent, g: Grate): void {
  s.grate = g;
  s.x = s.lastX = g.x - g.nx * 0.3;
  s.z = s.lastZ = g.z - g.nz * 0.3;
  s.yaw = Math.atan2(g.nx, g.nz);
}

function toLurk(rt: Rt, s: SnatcherAgent, g: Grate | null): void {
  s.state = 'lurk';
  s.st = 0;
  s.active = false;
  s.anim = ANIM.mIdle;
  s.victim = null;
  s.pulls.clear();
  s.pull = 0;
  s.progress = 0;
  s.struggle = 0;
  s.path = null;
  if (g) placeBehind(s, g);
  s.nextMoveAt = rt.cm.time + rand(rt, num(rt.snatcher, 'moveMinSec', 8), num(rt.snatcher, 'moveMaxSec', 15));
}

/** grate farthest (straight line) from every living player: where it comes back after a retreat */
function farGrate(rt: Rt, s: SnatcherAgent): Grate | null {
  const ps = rt.alive();
  let best: Grate | null = null, bd = -1;
  for (const g of s.grates) {
    const d = ps.length ? Math.min(...ps.map((p) => dist(p.pose.p[0], p.pose.p[2], g.x, g.z))) : 0;
    if (d > bd) { bd = d; best = g; }
  }
  return best;
}

/** the lone player it can reach: alone >= aloneSec and a grate within snatchRangeM walking (closed doors block) */
function pickVictim(rt: Rt, s: SnatcherAgent): { p: ServerPlayer; g: Grate; aloneFor: number } | null {
  const t = rt.cm.time;
  const need = num(rt.snatcher, 'aloneSec', 8), range = num(rt.snatcher, 'snatchRangeM', 16);
  let best: { p: ServerPlayer; g: Grate; aloneFor: number } | null = null;
  for (const p of rt.alive()) {
    const since = s.aloneSince.get(p.id);
    if (since === undefined || t - since < need) continue;
    if (rt.hidden(p) || inVan(rt, p)) continue;
    const [px, , pz] = p.pose.p;
    const near = s.grates.filter((g) => dist(g.fx, g.fz, px, pz) <= range);
    if (!near.length) continue;
    const f = walkField(rt.cm, px, pz, range + 1);
    let g: Grate | null = null, gd = Infinity;
    for (const q of near) {
      const d = f[cellOf(rt.cm.grid, q.fx, q.fz)] ?? Infinity;
      if (d <= range && d < gd) { gd = d; g = q; }
    }
    if (!g) continue;
    if (!best || t - since > best.aloneFor) best = { p, g, aloneFor: t - since };
  }
  return best;
}

function lurk(rt: Rt, s: SnatcherAgent): void {
  const t = rt.cm.time;
  s.active = false;
  s.anim = ANIM.mIdle;
  const b = rt.snatcher;
  // ambient tell: the grate it lurks behind rattles (+ dust) when someone is near it
  if (t >= s.nextTellAt) {
    s.nextTellAt = t + rand(rt, num(b, 'tellMinSec', 9), num(b, 'tellMaxSec', 16));
    const g = s.grate;
    if (g && rt.alive().some((p) => dist(p.pose.p[0], p.pose.p[2], g.x, g.z) <= num(b, 'tellRadiusM', 15))) rattle(rt, s, g, false);
  }
  // crawl through the ducts toward whoever has been alone the longest (else a random grate)
  if (t >= s.nextMoveAt) {
    s.nextMoveAt = t + rand(rt, num(b, 'moveMinSec', 8), num(b, 'moveMaxSec', 15));
    let lone: ServerPlayer | null = null, since = Infinity;
    for (const p of rt.alive()) {
      const a = s.aloneSince.get(p.id);
      if (a !== undefined && a < since) { since = a; lone = p; }
    }
    let g: Grate | null = null;
    if (lone) {
      const [px, , pz] = lone.pose.p;
      g = s.grates.reduce<Grate | null>((m, q) => (!m || dist(q.x, q.z, px, pz) < dist(m.x, m.z, px, pz) ? q : m), null);
    } else g = s.grates[Math.floor(rt.cm.rng.next() * s.grates.length)] ?? null;
    if (g && g !== s.grate) placeBehind(s, g);
  }
  if (t < s.nextScanAt) return;
  s.nextScanAt = t + 0.25;
  if (t - s.lastEndAt < num(b, 'abortCooldownSec', 6)) return;
  if (rt.alive().length < 2) return; // solo: nobody could pull you out
  const v = pickVictim(rt, s);
  if (v) startStalk(rt, s, v.p, v.g, v.aloneFor);
}

/** grate rattle + dust (tells); also used by the director's 'vent_rattle' event */
export function rattle(rt: Rt, s: SnatcherAgent, g: Grate, loud: boolean): void {
  cueAt(rt, s, 'rattle', g.x, 0.35, g.z, loud ? 18 : 13);
  cueAt(rt, s, 'dust', g.x + g.nx * 0.05, 0.6, g.z + g.nz * 0.05, 12);
}

function startStalk(rt: Rt, s: SnatcherAgent, p: ServerPlayer, g: Grate, aloneFor: number): void {
  const t = rt.cm.time;
  placeBehind(s, g);
  s.state = 'stalk';
  s.st = 0;
  s.victim = p.id;
  s.aloneFor = aloneFor;
  s.stalkUntil = t + num(rt.snatcher, 'stalkSec', 2.6);
  s.clicked = false;
  rattle(rt, s, g, true);
  // dust trickling from the ceiling duct right above them
  cueAt(rt, s, 'dust', p.pose.p[0], 2.6, p.pose.p[2], 10);
  rt.ctx.log('monsters').info(`crew ${rt.crew.code}: SNATCHER stalks ${p.name} (alone ${Math.round(aloneFor)} s, grate ${g.id})`);
}

function stalk(rt: Rt, s: SnatcherAgent): void {
  const t = rt.cm.time;
  s.active = false;
  const v = s.victim ? rt.crew.players.get(s.victim) : undefined;
  const since = v ? s.aloneSince.get(v.id) : undefined;
  // a teammate came within 10 m / they hid / reached the van / died: it pulls back (the buddy system works)
  if (!v || !isAlive(rt.crew, v) || since === undefined || rt.hidden(v) || inVan(rt, v)) {
    s.lastEndAt = t;
    toLurk(rt, s, s.grate);
    return;
  }
  if (!s.clicked && t >= s.stalkUntil - num(rt.snatcher, 'tickLeadSec', 1.4)) {
    s.clicked = true;
    cueAt(rt, s, 'tick', v.pose.p[0], 2.4, v.pose.p[2], 7);
  }
  if (t >= s.stalkUntil) startDrop(rt, s, v);
}

function pointAt(s: SnatcherAgent, at: number): [number, number] {
  const P = s.dragPath, C = s.dragCum;
  if (P.length === 1) return [P[0][0], P[0][1]];
  const a = Math.max(0, Math.min(C[C.length - 1], at));
  let i = 1;
  while (i < C.length - 1 && C[i] < a) i++;
  const seg = C[i] - C[i - 1];
  const k = seg > 1e-6 ? (a - C[i - 1]) / seg : 1;
  return [P[i - 1][0] + (P[i][0] - P[i - 1][0]) * k, P[i - 1][1] + (P[i][1] - P[i - 1][1]) * k];
}

function startDrop(rt: Rt, s: SnatcherAgent, v: ServerPlayer): void {
  const cm = rt.cm, g = s.grate!;
  const [vx, , vz] = v.pose.p;
  // the drag route: walking path from the victim to the grate front (closed doors block it, as when it was chosen)
  s.x = vx;
  s.z = vz;
  const ok = planTo(cm, s, g.fx, g.fz);
  const route: [number, number][] = ok && s.path && s.path.length >= 2 ? s.path.map((q) => [q[0], q[1]] as [number, number]) : [[vx, vz], [g.fx, g.fz]];
  route[0] = [vx, vz];
  s.path = null;
  s.dragPath = route;
  s.dragCum = [0];
  for (let i = 1; i < route.length; i++) s.dragCum.push(s.dragCum[i - 1] + dist(route[i - 1][0], route[i - 1][1], route[i][0], route[i][1]));
  const total = s.dragCum[s.dragCum.length - 1];
  s.sVictim = 0;
  s.sHead = Math.min(total, num(rt.snatcher, 'headLeadM', 1.05));
  const [hx, hz] = total > 0.05 ? pointAt(s, s.sHead) : [g.fx, g.fz];
  s.x = s.lastX = hx;
  s.z = s.lastZ = hz;
  s.yaw = yawTo(hx, hz, vx, vz);
  s.state = 'drop';
  s.st = 0;
  s.active = true;
  s.anim = ANIM.mAttack;
  s.progress = 0;
  s.struggle = 0;
  s.pulls.clear();
  s.pull = 0;
  s.snatches++;
  s.nextTickEvAt = 0;
  s.nextScratchAt = cm.time + 0.9;
  holdVictim(rt, s, v);
  cueAt(rt, s, 'snatch', vx, 1.2, vz, 26);
  rt.ctx.emit(rt.crew, 'monsters.snatch', snatchEv(rt, s, v, 'start'));
  monsterEvent(rt, s, 'snatch', v.id, null, vx, vz);
  rt.ctx.log('monsters').info(`crew ${rt.crew.code}: SNATCHER dropped onto ${v.name} (route ${total.toFixed(1)} m to ${g.id})`);
}

/** where the victim is right now (floor; in the duct = the grate's front spot, hidden) */
export function victimSpot(s: SnatcherAgent): [number, number] {
  if (s.state === 'duct' && s.grate) return [s.grate.fx, s.grate.fz];
  return pointAt(s, s.sVictim);
}

/** the rescue spot: next to the victim on the floor, the grate front once they are in the duct */
function rescueSpot(s: SnatcherAgent): [number, number] {
  return victimSpot(s);
}

/** pins the victim's server pose to the drag (also applied to every incoming pose by the monsters pose hook) */
export function applyVictimPose(s: SnatcherAgent, pose: PlayerPose): void {
  const [x, z] = victimSpot(s);
  pose.p = [x, 0, z];
  pose.yaw = yawTo(x, z, s.x, s.z);
  // in the duct the avatar is gone (hidden); on the floor: knocked down, sliding (crouch = no loud footsteps)
  pose.stance = s.state === 'duct' ? STANCE.hidden : STANCE.crouch;
  pose.anim = ANIM.grabbed;
}

function holdVictim(rt: Rt, s: SnatcherAgent, v: ServerPlayer): void {
  const pose: PlayerPose = { ...v.pose, p: [v.pose.p[0], v.pose.p[1], v.pose.p[2]] };
  applyVictimPose(s, pose);
  v.pose = pose;
}

function snatchEv(rt: Rt, s: SnatcherAgent, v: ServerPlayer, state: SnatchEvent['state'], by?: string): SnatchEvent {
  const [x, z] = victimSpot(s);
  const g = s.grate!;
  const ev: SnatchEvent = { id: s.id, victim: v.id, state, p: [r2(x), 0, r2(z)] };
  if (DRAGGING.has(s.state)) ev.phase = s.state as 'drop' | 'drag' | 'duct';
  if (state === 'start') {
    ev.grate = { id: g.id, p: [r2(g.x), 0.35, r2(g.z)], n: [r2(g.nx), r2(g.nz)], front: [r2(g.fx), 0, r2(g.fz)] };
    ev.route = s.dragPath.map((q) => [r2(q[0]), r2(q[1])] as [number, number]);
  }
  if (state === 'start' || state === 'tick') {
    ev.progress = Math.round(s.progress * 1000) / 1000;
    ev.pull = Math.round(s.pull * 100) / 100;
    ev.struggle = Math.round(s.struggle * 100) / 100;
    const rate = (1 - num(rt.snatcher, 'struggleMaxSlow', 0.45) * s.struggle) / num(rt.snatcher, 'dragSec', 20);
    ev.eta = Math.round(rt.serverMs(rt.cm.time + (1 - s.progress) / Math.max(1e-3, rate)));
  }
  if (by) ev.by = by;
  return ev;
}

/** victim mashing E: each press (>= struggleMinGapMs apart) adds to the struggle meter that slows the drag */
export function struggle(rt: Rt, s: SnatcherAgent, p: ServerPlayer): number {
  if (s.victim !== p.id || !DRAGGING.has(s.state)) return 0;
  const t = rt.cm.time;
  if ((t - s.lastStruggleAt) * 1000 >= num(rt.snatcher, 'struggleMinGapMs', 60)) {
    s.lastStruggleAt = t;
    s.struggle = Math.min(1, s.struggle + num(rt.snatcher, 'struggleStep', 0.12));
  }
  return s.struggle;
}

/** teammate E hold heartbeat at the rescue spot */
export function pull(rt: Rt, s: SnatcherAgent, p: ServerPlayer, on: boolean): { pull: number; inRange: boolean } {
  if (!s.victim || s.victim === p.id || !DRAGGING.has(s.state) || !isAlive(rt.crew, p)) return { pull: 0, inRange: false };
  const [rx, rz] = rescueSpot(s);
  const inRange = dist(p.pose.p[0], p.pose.p[2], rx, rz) <= num(rt.snatcher, 'pullRangeM', 2.2);
  if (!on) s.pulls.delete(p.id);
  else {
    const cur = s.pulls.get(p.id);
    if (cur) cur.lastAt = rt.cm.time;
    else s.pulls.set(p.id, { held: 0, lastAt: rt.cm.time });
  }
  return { pull: s.pull, inRange };
}

function dragTick(rt: Rt, s: SnatcherAgent, dt: number): void {
  const cm = rt.cm, b = rt.snatcher, t = cm.time;
  const v = s.victim ? rt.crew.players.get(s.victim) : undefined;
  if (!v || !isAlive(rt.crew, v)) {
    // victim gone (disconnected / killed by something else): back into the ducts
    if (v) releaseVictim(rt, s, v);
    s.lastEndAt = t;
    rt.retreat(s, num(b, 'rescueRetreatSec', 60) / 2);
    s.victim = null;
    return;
  }
  s.struggle = Math.max(0, s.struggle - s.struggle * num(b, 'struggleDecay', 1.1) * dt);
  const slow = 1 - num(b, 'struggleMaxSlow', 0.45) * s.struggle;
  s.progress = Math.min(s.state === 'duct' ? 1 : 0.95, s.progress + (dt / num(b, 'dragSec', 20)) * slow);
  const total = s.dragCum[s.dragCum.length - 1];
  const g = s.grate!;
  if (s.state === 'drop') {
    s.anim = ANIM.mAttack;
    if (s.st >= num(b, 'dropSec', 0.8)) { s.state = 'drag'; s.st = 0; }
  } else if (s.state === 'drag') {
    const step = num(b, 'dragSpeed', 1.25) * slow * dt;
    const lead = num(b, 'headLeadM', 1.05);
    if (s.sHead < total - 1e-3) {
      s.sHead = Math.min(total, s.sHead + step);
      s.sVictim = Math.max(s.sVictim, s.sHead - lead);
      const [hx, hz] = pointAt(s, s.sHead);
      const [vx, vz] = pointAt(s, s.sVictim);
      s.x = hx;
      s.z = hz;
      s.yaw = yawTo(hx, hz, vx, vz); // it crawls backward, facing its victim
      s.anim = ANIM.mWalk;
      s.active = true;
    } else {
      // it is in the duct already, reeling the victim in
      s.active = false;
      s.x = g.x - g.nx * 0.3;
      s.z = g.z - g.nz * 0.3;
      s.sVictim = Math.min(total, s.sVictim + step);
    }
    if (s.sVictim >= total - 0.05) {
      s.state = 'duct';
      s.st = 0;
      s.active = false;
      s.x = g.x - g.nx * 0.3;
      s.z = g.z - g.nz * 0.3;
      cueAt(rt, s, 'scratch', g.x, 0.35, g.z, num(b, 'scratchRadiusM', 22));
      s.nextTickEvAt = 0;
    }
  } else s.active = false;
  holdVictim(rt, s, v);
  // scratching: follow it (at the victim on the floor, at the grate once inside)
  if (t >= s.nextScratchAt) {
    s.nextScratchAt = t + num(b, 'scratchEverySec', 1.3);
    const [sx, sz] = s.state === 'duct' ? [g.x, g.z] : victimSpot(s);
    cueAt(rt, s, 'scratch', sx, s.state === 'duct' ? 0.35 : 0.1, sz, num(b, 'scratchRadiusM', 22));
  }
  // rescue: a teammate holding E for pullSec at the rescue spot
  const [rx, rz] = rescueSpot(s);
  const need = num(b, 'pullSec', 2), range = num(b, 'pullRangeM', 2.2), stale = num(b, 'pullStaleSec', 0.45);
  let best = 0, by: ServerPlayer | null = null;
  for (const [pid, h] of s.pulls) {
    const q = rt.crew.players.get(pid);
    if (!q || !isAlive(rt.crew, q) || t - h.lastAt > stale) { s.pulls.delete(pid); continue; }
    if (dist(q.pose.p[0], q.pose.p[2], rx, rz) > range) { h.held = 0; continue; }
    h.held += dt;
    if (h.held > best) { best = h.held; by = q; }
  }
  s.pull = Math.min(1, best / need);
  if (by && best >= need) return rescue(rt, s, v, by);
  if (t >= s.nextTickEvAt) {
    s.nextTickEvAt = t + 0.2;
    rt.ctx.emit(rt.crew, 'monsters.snatch', snatchEv(rt, s, v, 'tick'));
  }
  if (s.progress >= 1 && s.state === 'duct') kill(rt, s, v);
}

function releaseVictim(rt: Rt, s: SnatcherAgent, v: ServerPlayer): [number, number] {
  const [x, z] = victimSpot(s);
  v.pose = { ...v.pose, p: [x, 0, z], stance: STANCE.stand, anim: ANIM.idle };
  v.poseAt = performance.now();
  return [x, z];
}

function rescue(rt: Rt, s: SnatcherAgent, v: ServerPlayer, by: ServerPlayer): void {
  const g = s.grate!;
  const [x, z] = releaseVictim(rt, s, v);
  const ev = snatchEv(rt, s, v, 'freed', by.id);
  ev.p = [r2(x), 0, r2(z)];
  rt.ctx.emit(rt.crew, 'monsters.snatch', ev);
  monsterEvent(rt, s, 'rescued', v.id, by.id, x, z);
  cueAt(rt, s, 'shriek', g.x, 0.4, g.z, 28);
  s.rescues++;
  s.lastEndAt = rt.cm.time;
  rt.ctx.log('monsters').info(`crew ${rt.crew.code}: ${by.name} pulled ${v.name} away from the SNATCHER (${s.state}, ${Math.round(s.progress * 100)}%)`);
  s.victim = null;
  rt.retreat(s, num(rt.snatcher, 'rescueRetreatSec', 60));
}

function kill(rt: Rt, s: SnatcherAgent, v: ServerPlayer): void {
  const g = s.grate!;
  const room = rt.cm.spaceCallsign.get(g.space) ?? null;
  const detail = `alone ${Math.max(1, Math.round(s.aloneFor))} s${room ? `, ${room} vent` : ''}`;
  rt.ctx.emit(rt.crew, 'monsters.snatch', snatchEv(rt, s, v, 'killed'));
  s.lastEndAt = rt.cm.time;
  s.victim = null;
  // retreat first, so the generic after-death retreat leaves it alone
  rt.retreat(s, num(rt.snatcher, 'killRetreatSec', 90));
  rt.kill(s, v, 'took you while you were alone', detail);
}

export function snatcherTick(rt: Rt, s: SnatcherAgent, dt: number): void {
  const t = rt.cm.time;
  trackAlone(rt, s);
  switch (s.state) {
    case 'dormant':
      s.active = false;
      if (t >= s.readyAt) toLurk(rt, s, farGrate(rt, s));
      return;
    case 'out':
      s.active = false;
      if (s.victim) {
        const v = rt.crew.players.get(s.victim);
        if (v && isAlive(rt.crew, v)) releaseVictim(rt, s, v);
        s.victim = null;
      }
      if (t >= s.outUntil) toLurk(rt, s, farGrate(rt, s));
      return;
    case 'lurk':
      return lurk(rt, s);
    case 'stalk':
      return stalk(rt, s);
    case 'drop':
    case 'drag':
    case 'duct':
      return dragTick(rt, s, dt);
    default:
      toLurk(rt, s, s.grate);
  }
}

/** dev/test: skip the first-2-minutes rule (and any cooldown) */
export function readyNow(rt: Rt, s: SnatcherAgent): void {
  s.readyAt = Math.min(s.readyAt, rt.cm.time);
  s.lastEndAt = -100;
  if (s.state === 'dormant' || s.state === 'out') toLurk(rt, s, s.grate ?? farGrate(rt, s));
}

export function describeSnatcher(s: SnatcherAgent, t: number): Record<string, unknown> {
  return {
    readyAt: r2(s.readyAt), grate: s.grate?.id ?? null, victim: s.victim, progress: r2(s.progress), pull: r2(s.pull), struggle: r2(s.struggle),
    sHead: r2(s.sHead), sVictim: r2(s.sVictim), route: s.dragPath.length, snatches: s.snatches, rescues: s.rescues,
    alone: Object.fromEntries([...s.aloneSince].map(([k, v]) => [k, r2(t - v)])),
    grates: s.grates.map((g) => ({ id: g.id, x: r2(g.x), z: r2(g.z), n: [r2(g.nx), r2(g.nz)], front: [r2(g.fx), r2(g.fz)], space: g.space })),
  };
}
