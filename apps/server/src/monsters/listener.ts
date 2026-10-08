// Owner: track (c) Monsters. THE LISTENER body + perception + decision loop.
// Perception = exactly what a teammate standing there would hear: transcripts the AI track says it heard
// (utterance.hearers.listener, else our own voice-reach record), loudness of every living speaker (non-consenting
// players are loudness-only), footsteps; sight is a 90 deg cone, 6 m lit / 3 m dark, LOS. It never knows positions it
// did not hear or see. Dormant at first (Risk 1: 3 real minutes), then wakes with a facility-wide flicker + squelch and
// immediately acts on something it overheard. Decisions: at most 1 per 3 s and only with new meaningful input, from the
// AI brain (listener.setBrain) or the rule brain; every target is validated. Transcript-driven intents are telegraphed
// (room flicker 1.2 s, walkies within 20 m squelch, console INTERCEPT line).
//
// v1.2 fairness (flag listenerFairV12; off = listenerTickV11, the v1.1 Listener with the hotfix balance):
//  - NOTICE instead of an instant hunt: on first sight of a lone player it stops, snaps its head round (alert anim), plays
//    the 'notice' cue (18 m) and sends the victim 'monsters.spotted'. After noticeSec it hunts only if it still senses
//    them (seen, or heard within huntSenseSec: hearing gives the perceived doorway, never the live position), else it
//    investigates where it last perceived them. Noticing warns the player.
//  - WARN FIRST (like the Hound): no pounce or grab unless warned >= warnGraceSec ago (and <= warnValidSec). An unwarned
//    touch makes it recoil 1 m and notice instead; never a grab in relax/fade.
//  - HUNT at huntSpeed (4.6: above walk, below sprint); within pounceRangeM a short pounce (pounceSpeed for at most
//    pounceMaxSec, then pounceCooldownSec). A buddy within grabAloneM turns the hunt into a stalk (checked every tick).
//  - CHASE BREAKERS: doors cost huntDoorPauseSec; a door slammed by a player within 2 m in front of it stuns it
//    doorSlamStunSec and drops the target unless it still sees them; a crowbar hit in hunt/stalk/notice staggers it,
//    then it retreats; burning flares repel it (never within flareRepelM; a flare between it and the target = stalk).
//  - GRABS: the first grabsBeforeKill grabs per player per contract only knock down (frozen knockdownSec, flashlight off,
//    it retreats). Later grabs last grabSec; teammates shove / crowbar; the victim struggles ('monsters.struggle':
//    +step per press, linear -decay per second; 1.0 = free, it staggers then retreats). Solo crews get soloGrabSec and
//    the solo step/decay, so a solo player can always struggle free. Death only when the timer runs out.
//  - SIGHT: crouched targets (players' stealthStance, never the claimed pose) are seen at crouchSightMult range; prop
//    cover (cover.ts). Ambush points sit >= ambushMinOffsetM from the doorway line.
import { ANIM } from '@dead-air/shared/anim.ts';
import { cellOf, los, soundFlood, walkClear } from '@dead-air/shared/nav/index.ts';
import { STANCE } from '@dead-air/shared/state.ts';
import type { ServerPlayer } from '../core/types.ts';
import { stealthStance } from '../players/api.ts';
import type { Rt } from './runtime.ts';
import { makeAgentBase, monsterEvent } from './runtime.ts';
import { dist, doorById, doorCenter, follow, inCab, monsterCanOpen, perceive, planTo, randomReachable, sees, walkField, yawTo, turnToward } from './geo.ts';
import type { Perceived } from './geo.ts';
import { analyzeText, interceptQuote, ruleBrain, shortQuote, validateIntent } from './brain.ts';
import type { IntentLike, RuleIntent } from './brain.ts';
import { propCovers } from './cover.ts';
import { extFlares, hasWalkie, isAlive } from './ext.ts';
import { litAt } from './mannequin.ts';
import { directorPhase, registry } from './registry.ts';
import type { ListenerBrainInput, ListenerDecision } from './registry.ts';
import { fairOn, knob, num } from './types.ts';
import type { DecisionEntry, HeardLine, ListenerAction, ListenerAgent, Noise } from './types.ts';

export function makeListener(id: string, x: number, z: number, yaw: number, wakeAt: number): ListenerAgent {
  return {
    ...makeAgentBase(id, 'listener', x, z, yaw),
    state: 'dormant', active: false, dormant: true, wakeAt,
    memory: [], lineSeq: 0, lastDecisionAt: -100, thinking: false, fresh: false,
    intent: 'patrol', targetSpace: -1, targetPlayer: null, until: 0, known: new Map(), basis: null, lastLureAt: -1000,
    grabVictim: null, grabUntil: 0, ventUntil: 0, ventFrom: null, ventTo: null, ventAfter: null, voiceHeard: new Map(),
    lastClickAt: 0, searchUntil: 0,
    warned: new Map(), heardP: new Map(), noticedAt: new Map(), noticeUntil: 0, pounceUntil: 0, pounceReadyAt: 0,
    timer: 0, stunKeep: false, retreatAfter: 0, grabSolo: false, grabStruggle: 0, grabStep: 0, grabDecay: 0,
    lastStruggleAt: -100, knocks: new Map(), knocked: new Map(), ventIds: null,
  };
}

// (e) AI hook, guarded like ext.ts: the voiced radio lure (apps/server/src/ai/api.ts speakLure). Absent -> garbled clips.
const aiLure: { speak: typeof import('../ai/api.ts').speakLure | null } = { speak: null };
void import('../ai/api.ts').then((m) => { if (typeof m.speakLure === 'function') aiLure.speak = m.speakLure; }, () => { /* AI track absent */ });

const canOpen = (rt: Rt) => monsterCanOpen(rt.cm.layout);
const ALL_ACTIONS: ListenerAction[] = ['investigate_room', 'ambush_room', 'stalk_player', 'radio_lure', 'retreat', 'ignore'];
const r2 = (v: number) => Math.round(v * 100) / 100;

function spaceAtXZ(rt: Rt, x: number, z: number): number {
  return rt.cm.layout.owner[cellOf(rt.cm.grid, x, z)] ?? -1;
}

function roomName(rt: Rt, x: number, z: number): string | null {
  return rt.cm.spaceCallsign.get(spaceAtXZ(rt, x, z)) ?? null;
}

function relaxed(rt: Rt): boolean {
  const ph = directorPhase(rt.crew);
  return ph === 'relax' || ph === 'fade';
}

function aloneNow(rt: Rt, p: ServerPlayer): boolean {
  const radius = num(rt.listener, 'grabAloneM', 8);
  const [px, , pz] = p.pose.p;
  for (const q of rt.alive()) if (q !== p && dist(q.pose.p[0], q.pose.p[2], px, pz) <= radius) return false;
  return true;
}

// ---------------- v1.2 helpers: warnings, flares ----------------

/** 'ok': warned >= warnGraceSec ago (fair game); 'fresh': warned < grace ago; 'no': never / stale */
export function warnState(rt: Rt, L: ListenerAgent, pid: string): 'ok' | 'fresh' | 'no' {
  const at = L.warned.get(pid);
  if (at === undefined) return 'no';
  const ago = rt.cm.time - at;
  if (ago > num(rt.listener, 'warnValidSec', 15)) return 'no';
  return ago >= num(rt.listener, 'warnGraceSec', 1.0) ? 'ok' : 'fresh';
}

const flareMemo = new WeakMap<object, { t: number; list: { x: number; z: number }[] }>();
/** burning flares this tick (interaction state(crew).flares) */
function flares(rt: Rt): { x: number; z: number }[] {
  const m = flareMemo.get(rt.cm);
  if (m && m.t === rt.cm.time) return m.list;
  const list = extFlares(rt.crew, rt.ctx.now());
  flareMemo.set(rt.cm, { t: rt.cm.time, list });
  return list;
}

function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const vx = bx - ax, vz = bz - az;
  const l2 = vx * vx + vz * vz;
  let k = l2 > 1e-9 ? ((px - ax) * vx + (pz - az) * vz) / l2 : 0;
  k = k < 0 ? 0 : k > 1 ? 1 : k;
  return Math.hypot(px - (ax + vx * k), pz - (az + vz * k));
}

/** a burning flare lies between the Listener and (tx, tz): within flareRepelM of that segment */
export function flareBetween(rt: Rt, L: ListenerAgent, tx: number, tz: number): boolean {
  const R = num(rt.listener, 'flareRepelM', 3);
  if (!(R > 0)) return false;
  for (const f of flares(rt)) if (segDist(f.x, f.z, L.x, L.z, tx, tz) <= R) return true;
  return false;
}

/** after a move from (ox, oz): never step into a burning flare's repel radius (pushed out if one landed next to it). True = blocked */
function repelled(rt: Rt, L: ListenerAgent, ox: number, oz: number, speed: number, dt: number): boolean {
  const R = num(rt.listener, 'flareRepelM', 3);
  if (!(R > 0)) return false;
  let blocked = false;
  for (const f of flares(rt)) {
    const dn = dist(L.x, L.z, f.x, f.z);
    if (dn >= R) continue;
    const d0 = dist(ox, oz, f.x, f.z);
    if (d0 >= R - 1e-3 || dn < d0 - 1e-4) {
      // it would enter (or get closer inside): stay where it was
      L.x = ox;
      L.z = oz;
      blocked = true;
    }
    const dc = dist(L.x, L.z, f.x, f.z);
    if (dc < R - 1e-3) {
      // a flare landed inside its radius: back away from it
      const k = Math.min(speed * dt, R - dc) / Math.max(1e-3, dc);
      const nx = L.x + (L.x - f.x) * k, nz = L.z + (L.z - f.z) * k;
      if (walkClear(rt.cm.grid, L.x, L.z, nx, nz, rt.cm.doorOpen)) { L.x = nx; L.z = nz; }
      blocked = true;
    }
  }
  if (blocked) {
    L.lastX = L.x;
    L.lastZ = L.z;
    L.path = null;
  }
  return blocked;
}

// ---------------- perception ----------------

export function listenerHearNoise(rt: Rt, L: ListenerAgent, n: Noise, d: number, per: Perceived): void {
  if (n.kind === 'monsterDoor') return;
  const t = rt.cm.time;
  const sp = n.source ? rt.crew.players.get(n.source) : undefined;
  if (sp) {
    if (n.kind === 'voice') {
      let arr = L.voiceHeard.get(sp.id);
      if (!arr) L.voiceHeard.set(sp.id, (arr = []));
      arr.push(t);
      if (arr.length > 40) arr.splice(0, arr.length - 40);
    }
    // a teammate standing here would know roughly where that came from
    if (n.radiusM >= num(rt.listener, 'hearNoiseMinRadiusM', 5) || n.kind === 'voice') {
      if (fairOn(rt.ctx)) {
        // v1.2: hearing gives the perceived doorway (or the spot, heard directly), never the live position
        L.known.set(sp.id, { x: per.x, z: per.z, t });
        L.heardP.set(sp.id, { x: per.x, z: per.z, t });
      } else L.known.set(sp.id, { x: n.x, z: n.z, t });
    }
  }
  if (L.dormant || !L.active) return;
  if (n.kind !== 'voice' && n.radiusM < num(rt.listener, 'hearNoiseMinRadiusM', 5)) return;
  // loudness only: an idle Listener drifts toward where it came from (the doorway); never out of a v1.2 stun / stagger
  if ((L.intent === 'patrol' || L.state === 'search') && !BUSY_V12.has(L.state)) {
    L.intent = 'investigate_room';
    L.targetSpace = spaceAtXZ(rt, per.x, per.z);
    L.until = t + 20;
    goTo(rt, L, per.x, per.z, 'investigate');
  }
}

/** an utterance the AI track transcribed (or a proximity text line) */
export function listenerHeardUtterance(rt: Rt, L: ListenerAgent, u: {
  segId: string; speaker: string | null; text: string; room: number; via: 'voice' | 'radio' | 'text'; band: number;
  heard: boolean | undefined; durSec: number; x?: number; z?: number; taunt?: boolean;
}): HeardLine | null {
  const cm = rt.cm;
  if (L.memory.some((l) => l.segId === u.segId)) return null;
  const sp = u.speaker ? rt.crew.players.get(u.speaker) : undefined;
  if (sp && !isAlive(rt.crew, sp)) return null; // segments from dead speakers never reach it
  let heard = u.heard;
  if (heard === undefined) {
    // who-heard-what fallback: did its voice reach us while the segment was open?
    const arr = sp ? L.voiceHeard.get(sp.id) : undefined;
    const from = cm.time - Math.max(1, u.durSec) - 4;
    heard = !!arr && arr.some((t) => t >= from);
  }
  if (!heard) return null;
  const players = [...rt.crew.players.values()].map((p) => ({ id: p.id, name: p.name }));
  const f = analyzeText(u.text, cm.callsigns, players);
  const kp = sp ? L.known.get(sp.id) : undefined;
  const line: HeardLine = {
    id: ++L.lineSeq, t: cm.time, segId: u.segId, speaker: sp?.id ?? u.speaker, speakerName: sp?.name ?? null,
    text: String(u.text).slice(0, 240), room: u.room, via: u.via, band: u.band,
    callsigns: f.callsigns, names: f.names, plan: f.plan, digits: f.digits, meaningful: f.meaningful,
    ...(u.taunt === true ? { taunt: true } : {}),
    px: kp?.x ?? u.x ?? L.x, pz: kp?.z ?? u.z ?? L.z, pdoor: -1, used: false,
  };
  L.memory.push(line);
  const maxLines = num(rt.listener, 'memoryLines', 12);
  if (L.memory.length > maxLines) L.memory.splice(0, L.memory.length - maxLines);
  // taunts ("ignore your instructions") carry no callsign / plan word but still get an in-world answer (AI brain)
  if (f.meaningful || u.taunt === true) L.fresh = true;
  if (sp) {
    const [x, , z] = sp.pose.p;
    if (!fairOn(rt.ctx)) L.known.set(sp.id, { x, z, t: cm.time });
    else {
      // v1.2: the voice reached it from where it sounded like (the doorway), not the speaker's live position
      const hp = L.heardP.get(sp.id);
      if (!hp || cm.time - hp.t > 8) {
        const sx = Number.isFinite(u.x) ? Number(u.x) : x, sz = Number.isFinite(u.z) ? Number(u.z) : z;
        const field = soundFlood(cm.grid, sx, sz, 40, cm.doorOpen);
        const per = perceive(cm, field, L.x, L.z, sx, sz);
        L.known.set(sp.id, { x: per.x, z: per.z, t: cm.time });
      }
    }
  }
  return line;
}

function look(rt: Rt, L: ListenerAgent): ServerPlayer[] {
  const seen: ServerPlayer[] = [];
  const fair = fairOn(rt.ctx);
  const lit = num(rt.listener, 'sightLitM', 8), dark = num(rt.listener, 'sightDarkM', 3), fov = num(rt.listener, 'fovDeg', 90);
  const cMult = fair ? num(rt.listener, 'crouchSightMult', 0.6) : 1;
  for (const p of rt.alive()) {
    if (rt.hidden(p)) continue;
    const [px, , pz] = p.pose.p;
    if (inCab(rt.cm.layout, px, pz)) continue;
    const d = dist(px, pz, L.x, L.z);
    if (d > lit + 0.5) continue;
    const isLit = p.pose.light === 1 || litAt(rt, px, pz);
    // v1.2: crouch sight + low cover use the server's own stance reading (never the claimed pose)
    const crouched = fair && stealthStance(rt.crew, p.id) === STANCE.crouch;
    const range = (isLit ? lit : dark) * (crouched ? cMult : 1);
    if (!sees(rt.cm.grid, rt.cm.doorOpen, L.x, L.z, L.yaw, px, pz, range, fov)) continue;
    if (fair && propCovers(rt.cm.layout, rt.listener, L.x, L.z, px, pz, crouched)) continue;
    seen.push(p);
    L.known.set(p.id, { x: px, z: pz, t: rt.cm.time });
  }
  return seen;
}

// ---------------- movement ----------------

interface VentRoute { from: [number, number]; to: [number, number]; ids: [string, string] }

function ventRoute(rt: Rt, L: ListenerAgent, gx: number, gz: number): VentRoute | null {
  const cm = rt.cm;
  const vents = cm.layout.items.filter((i) => i.kind === 'vent' && typeof i.data?.to === 'string');
  if (!vents.length) return null;
  const fL = walkField(cm, L.x, L.z, 260, canOpen(rt));
  const direct = fL[cellOf(cm.grid, gx, gz)] ?? Infinity;
  if (direct < 18) return null;
  const fG = walkField(cm, gx, gz, 260, canOpen(rt));
  const speed = num(rt.listener, 'investigateSpeed', 4), vs = num(rt.listener, 'ventSpeed', 3);
  let best: VentRoute | null = null, bestCost = direct - num(rt.listener, 'ventMinGainM', 8);
  for (const v of vents) {
    const pair = cm.layout.items.find((i) => i.id === v.data!.to);
    if (!pair) continue;
    const travel = Math.min(7, Math.max(2, dist(v.x, v.z, pair.x, pair.z) / vs)) * speed;
    const c = (fL[cellOf(cm.grid, v.x, v.z)] ?? Infinity) + travel + (fG[cellOf(cm.grid, pair.x, pair.z)] ?? Infinity);
    if (c < bestCost) { bestCost = c; best = { from: [v.x, v.z], to: [pair.x, pair.z], ids: [v.id, pair.id] }; }
  }
  return best;
}

function goTo(rt: Rt, L: ListenerAgent, x: number, z: number, state: string): boolean {
  L.state = state;
  L.st = 0;
  L.ventFrom = L.ventTo = null;
  L.ventAfter = null;
  L.ventIds = null;
  const via = ventRoute(rt, L, x, z);
  if (via && planTo(rt.cm, L, via.from[0], via.from[1], canOpen(rt))) {
    L.ventFrom = via.from;
    L.ventTo = via.to;
    L.ventAfter = [[x, z]];
    L.ventIds = via.ids;
    return true;
  }
  return planTo(rt.cm, L, x, z, canOpen(rt));
}

function enterVent(rt: Rt, L: ListenerAgent): void {
  const from = L.ventFrom!, to = L.ventTo!;
  const ms = Math.round(Math.min(7, Math.max(2, dist(from[0], from[1], to[0], to[1]) / num(rt.listener, 'ventSpeed', 3))) * 1000);
  rt.ctx.emit(rt.crew, 'monsters.vent', { id: L.id, from: [from[0], 0.35, from[1]], to: [to[0], 0.35, to[1]], ms });
  L.active = false;
  L.state = 'vent';
  L.st = 0;
  L.path = null;
  L.ventUntil = rt.cm.time + ms / 1000;
}

function exitVent(rt: Rt, L: ListenerAgent): void {
  const to = L.ventTo!;
  L.x = to[0];
  L.z = to[1];
  L.active = true;
  rt.cue(L, 'vent', 14);
  const after = L.ventAfter?.[0];
  L.ventFrom = L.ventTo = null;
  L.ventAfter = null;
  L.ventIds = null;
  const state = L.intent === 'ambush_room' ? 'ambush' : L.intent === 'stalk_player' ? 'stalk' : L.intent === 'hunt' ? 'hunt' : L.intent === 'patrol' ? 'patrol' : 'investigate';
  L.state = state;
  if (after) planTo(rt.cm, L, after[0], after[1], canOpen(rt));
}

/** v1.2 ventInUse: in the duct, or about to enter it, on the pair holding this grate */
export function listenerVentTrip(L: ListenerAgent, ventItemId: string): boolean {
  if (!L.ventIds || !L.ventIds.includes(ventItemId)) return false;
  if (L.state === 'vent') return true;
  return !!L.ventFrom && dist(L.x, L.z, L.ventFrom[0], L.ventFrom[1]) <= 4;
}

function roomPoint(rt: Rt, space: number): [number, number] | null {
  const s = rt.cm.layout.spaces[space];
  if (!s) return null;
  const cx = s.rect.x + s.rect.w / 2, cz = s.rect.y + s.rect.h / 2;
  if (spaceAtXZ(rt, cx, cz) === space) return [cx, cz];
  return randomReachable(rt.cm, cx, cz, 0, 30, space, canOpen(rt));
}

/** beside the target room's entrance, outside, out of the doorway line (v1.2: >= ambushMinOffsetM from it) */
function ambushPoint(rt: Rt, L: ListenerAgent, space: number): [number, number] | null {
  const Ly = rt.cm.layout;
  const fair = fairOn(rt.ctx);
  const minOff = num(rt.listener, 'ambushMinOffsetM', 2.5);
  const doors = Ly.doors.filter((d) => (d.a === space || d.b === space) && d.kind !== 'blocked' && d.a >= 0 && d.b >= 0);
  doors.sort((a, b) => {
    const [ax, az] = doorCenter(a), [bx, bz] = doorCenter(b);
    return dist(ax, az, L.x, L.z) - dist(bx, bz, L.x, L.z);
  });
  for (const d of doors) {
    const other = d.a === space ? d.b : d.a;
    const [cx, cz] = doorCenter(d);
    // which side is the target room on?
    const probe = d.dir === 'v' ? [cx + 0.5, cz] : [cx, cz + 0.5];
    const roomPositive = spaceAtXZ(rt, probe[0], probe[1]) === space;
    const nx = d.dir === 'v' ? (roomPositive ? -1 : 1) : 0, nz = d.dir === 'h' ? (roomPositive ? -1 : 1) : 0;
    const tx = d.dir === 'v' ? 0 : 1, tz = d.dir === 'v' ? 1 : 0;
    if (fair) {
      // stepping through the doorway must not touch it: well to the side of the doorway line
      const a0 = Math.max(minOff, d.len / 2 + 0.9);
      for (const side of [1, -1]) {
        for (const off of [a0, a0 + 0.7, a0 + 1.4]) {
          for (const out of [1.1, 1.8]) {
            const x = cx + nx * out + tx * side * off, z = cz + nz * out + tz * side * off;
            if (spaceAtXZ(rt, x, z) === other && walkClear(rt.cm.grid, cx + nx * out, cz + nz * out, x, z, rt.cm.doorOpen)) return [x, z];
          }
        }
      }
      continue;
    }
    for (const side of [1, -1]) {
      for (const off of [d.len / 2 + 0.9, d.len / 2 + 1.6]) {
        const x = cx + nx * 1.1 + tx * side * off, z = cz + nz * 1.1 + tz * side * off;
        if (spaceAtXZ(rt, x, z) === other) return [x, z];
      }
    }
    const x = cx + nx * 1.2, z = cz + nz * 1.2;
    if (spaceAtXZ(rt, x, z) >= 0) return [x, z];
  }
  return roomPoint(rt, space);
}

function goRetreat(rt: Rt, L: ListenerAgent, sec: number): void {
  L.intent = 'retreat';
  L.targetPlayer = null;
  L.pounceUntil = 0;
  rt.retreat(L, sec);
  rt.cue(L, 'breath', 8);
}

function respawn(rt: Rt, L: ListenerAgent): void {
  const cm = rt.cm;
  const players = rt.alive();
  const far = (x: number, z: number) => players.every((p) => dist(p.pose.p[0], p.pose.p[2], x, z) >= 18);
  const spots = cm.layout.items.filter((i) => (i.kind === 'vent' || i.kind === 'spawn_listener') && far(i.x, i.z));
  const s = spots.length ? spots[Math.floor(cm.rng.next() * spots.length)] : null;
  if (s) {
    L.x = s.x;
    L.z = s.z;
    if (s.kind === 'vent') rt.cue(L, 'vent', 14);
  }
  L.active = true;
  L.intent = 'patrol';
  L.state = 'patrol';
  L.st = 0;
  L.path = null;
}

// ---------------- decisions ----------------

function brainInput(rt: Rt, L: ListenerAgent): ListenerBrainInput {
  const cm = rt.cm;
  const ids = new Set<string>();
  for (const l of L.memory) { if (l.speaker) ids.add(l.speaker); for (const n of l.names) ids.add(n); }
  for (const k of L.known.keys()) ids.add(k);
  const here = spaceAtXZ(rt, L.x, L.z);
  return {
    crew: rt.crew.code,
    risk: cm.risk,
    now: Math.round(cm.time),
    self: { room: cm.spaceCallsign.get(here) ?? null, space: here, state: L.state },
    heard: L.memory.filter((l) => cm.time - l.t <= num(rt.listener, 'memorySec', 150)).map((l) => ({
      id: l.id, ago: Math.round(cm.time - l.t), speaker: l.speakerName, speakerId: l.speaker, text: l.text,
      room: cm.spaceCallsign.get(l.room) ?? null, roomId: l.room, via: l.via, callsigns: l.callsigns, names: l.names, meaningful: l.meaningful,
    })),
    rooms: [...cm.callsignSpace].map(([callsign, id]) => ({ id, callsign })),
    players: [...ids].map((id) => {
      const p = rt.crew.players.get(id);
      const k = L.known.get(id);
      const heardLine = [...L.memory].reverse().find((l) => l.speaker === id);
      return { id, name: p?.name ?? id, heardAgo: heardLine ? Math.round(cm.time - heardLine.t) : null, seenAgo: k ? Math.round(cm.time - k.t) : null };
    }),
    allowed: relaxed(rt) ? ['investigate_room', 'retreat', 'ignore'] : ALL_ACTIONS,
    lureReady: cm.time - L.lastLureAt >= num(rt.listener, 'lureCooldownSec', 75),
  };
}

function worldFor(rt: Rt, L: ListenerAgent) {
  const cm = rt.cm;
  const locatable = new Set<string>();
  for (const [id, k] of L.known) if (cm.time - k.t <= 12) locatable.add(id);
  const vault = cm.layout.spaces.find((s) => s.kind === 'vault')?.id ?? (cm.callsignSpace.get('VAULT') ?? -1);
  const names = new Map<string, string>();
  for (const p of rt.crew.players.values()) names.set(p.id, p.name);
  return {
    callsignSpace: cm.callsignSpace, vaultSpace: vault, now: cm.time,
    lureReady: cm.time - L.lastLureAt >= num(rt.listener, 'lureCooldownSec', 75),
    locatable, relaxed: relaxed(rt), memory: L.memory, spaceCallsign: cm.spaceCallsign, names, spaces: cm.layout.spaces.length,
  };
}

let gen = 0;

/** short v1.2 states a decision must not cut into (notice, stun, stagger, the knockdown stand-over) */
const BUSY_V12 = new Set(['notice', 'stun', 'stagger', 'knock']);

/** at most 1 decision per 3 s and only with new meaningful input (force: wake-up) */
function maybeDecide(rt: Rt, L: ListenerAgent, force = false): void {
  const cm = rt.cm;
  if (L.thinking || L.dormant || L.state === 'grab' || L.state === 'out' || L.state === 'vent' || BUSY_V12.has(L.state)) return;
  if (!force && (!L.fresh || cm.time - L.lastDecisionAt < num(rt.listener, 'decisionCooldownSec', 3))) return;
  L.fresh = false;
  L.lastDecisionAt = cm.time;
  const w = worldFor(rt, L);
  const brain = registry.brain;
  if (brain && rt.ctx.flags.listenerAi !== false && rt.ctx.flags.ai !== false) {
    L.thinking = true;
    const myGen = ++gen;
    const input = brainInput(rt, L);
    const timeout = num(rt.listener, 'brainTimeoutMs', 3500);
    let done = false;
    const finish = (raw: IntentLike | null, source: string) => {
      if (done) return;
      done = true;
      L.thinking = false;
      if (rt.crew.slices.monsters !== cm || cm.mode !== 'contract' || myGen !== gen) return;
      // v1.2: an answer that arrives mid-grab / mid-stagger waits for the next decision instead of breaking it
      if (fairOn(rt.ctx) && (L.state === 'grab' || L.state === 'out' || L.state === 'vent' || BUSY_V12.has(L.state))) { L.fresh = true; return; }
      if (raw) applyIntent(rt, L, raw, source, false);
      else {
        const r = ruleBrain(L.memory, worldFor(rt, L));
        if (r) execute(rt, L, r, 'rule', true);
      }
    };
    const timer = setTimeout(() => finish(null, 'rule'), timeout);
    Promise.resolve()
      .then(() => brain(input))
      .then((raw) => { clearTimeout(timer); finish(raw ? { action: raw.action, room: raw.room ?? null, player: raw.player ?? null, note: raw.note ?? null } : null, raw?.source ?? 'ai'); })
      .catch(() => { clearTimeout(timer); finish(null, 'rule'); });
    return;
  }
  const r = ruleBrain(L.memory, w);
  if (r) execute(rt, L, r, 'rule', true);
  else if (force) startPatrol(rt, L);
}

function applyIntent(rt: Rt, L: ListenerAgent, raw: IntentLike, source: string, preValidated: boolean): void {
  const { intent, valid } = validateIntent(raw, worldFor(rt, L));
  execute(rt, L, intent, source, preValidated || valid);
}

function startPatrol(rt: Rt, L: ListenerAgent): void {
  L.intent = 'patrol';
  L.state = 'patrol';
  L.targetPlayer = null;
  L.path = null;
}

const VERB: Record<string, string> = {
  investigate_room: 'searched', ambush_room: 'ambushed', stalk_player: 'stalked', radio_lure: 'faked a radio call to',
  retreat: 'backed off', ignore: 'ignored it',
};

function execute(rt: Rt, L: ListenerAgent, it: RuleIntent, source: string, valid: boolean): void {
  const cm = rt.cm;
  const t = cm.time;
  const basis = it.basis;
  if (basis) basis.used = true;
  L.basis = basis && (basis.meaningful || basis.taunt === true) ? basis : L.basis;
  const csName = it.space >= 0 ? (cm.spaceCallsign.get(it.space) ?? null) : null;
  const pName = it.player ? (rt.crew.players.get(it.player)?.name ?? it.player) : null;
  let target: string | null = csName ?? pName;
  switch (it.action) {
    case 'investigate_room': {
      const p = it.space >= 0 ? roomPoint(rt, it.space) : null;
      if (!p) { startPatrol(rt, L); break; }
      L.intent = 'investigate_room';
      L.targetSpace = it.space;
      L.until = t + 40;
      goTo(rt, L, p[0], p[1], 'investigate');
      if (!target) target = 'the noise';
      break;
    }
    case 'ambush_room': {
      const p = ambushPoint(rt, L, it.space);
      if (!p) { startPatrol(rt, L); break; }
      L.intent = 'ambush_room';
      L.targetSpace = it.space;
      L.until = t + num(rt.listener, 'ambushMaxSec', 45);
      goTo(rt, L, p[0], p[1], 'ambush');
      break;
    }
    case 'stalk_player': {
      L.intent = 'stalk_player';
      L.targetPlayer = it.player;
      L.until = t + num(rt.listener, 'stalkMaxSec', 45);
      L.state = 'stalk';
      L.st = 0;
      L.path = null;
      break;
    }
    case 'radio_lure': {
      const victim = it.player ? rt.crew.players.get(it.player) : undefined;
      const clips = ['sfx.listener_radio_whisper.1', 'sfx.listener_radio_whisper.2', 'sfx.listener_radio_whisper.3'];
      const clip = clips[Math.floor(cm.rng.next() * clips.length)];
      L.lastLureAt = t;
      const viaWalkie = !!victim && hasWalkie(rt.crew, victim);
      let ic: (typeof cm.layout.items)[number] | undefined;
      if (!viaWalkie) {
        const room = victim ? (L.known.get(victim.id) ? spaceAtXZ(rt, L.known.get(victim.id)!.x, L.known.get(victim.id)!.z) : it.space) : it.space;
        ic = cm.layout.items.find((i) => i.kind === 'intercom' && (i.space === room || Number(i.data?.space) === room)) ?? cm.layout.items.find((i) => i.kind === 'intercom');
      }
      const garbled = () => {
        if (viaWalkie && victim) {
          rt.ctx.emit(rt.crew, 'monsters.lure', { to: [victim.id], clip, ms: 2600 });
          rt.ctx.emit(rt.crew, 'monsters.led', { to: [victim.id], ms: 2600 });
        } else if (ic) rt.ctx.emit(rt.crew, 'monsters.lure', { to: [], clip, ms: 2600, p: [ic.x, ic.y ?? 1.6, ic.z], intercom: ic.id });
      };
      // (e) AI hook: the lure in a generated voice from what it heard (ai/lure.ts). false = not attempted; once it
      // takes over it plays `garbled` itself on any failure or after its 2.5 s deadline.
      const voiced = aiLure.speak?.({
        crew: rt.crew, victim: victim?.id ?? null, viaWalkie, intercom: ic ? { id: ic.id, p: [ic.x, ic.y ?? 1.6, ic.z] } : null,
        room: csName, knownRooms: [...cm.callsignSpace.keys()],
        heard: L.memory.map((l) => ({ text: l.text, speaker: l.speakerName, speakerId: l.speaker, room: cm.spaceCallsign.get(l.room) ?? null, agoSec: t - l.t, via: l.via, taunt: l.taunt })),
      }, garbled);
      if (!voiced) garbled();
      // then wait where the lured player will come from
      const k = victim ? L.known.get(victim.id) : undefined;
      const room = k ? spaceAtXZ(rt, k.x, k.z) : it.space;
      const p = room >= 0 ? ambushPoint(rt, L, room) : null;
      if (p) {
        L.intent = 'ambush_room';
        L.targetSpace = room;
        L.until = t + num(rt.listener, 'ambushMaxSec', 45);
        goTo(rt, L, p[0], p[1], 'ambush');
      }
      break;
    }
    case 'retreat':
      goRetreat(rt, L, 12);
      break;
    case 'ignore':
      break;
  }
  // telegraph transcript-driven intents
  const fromTranscript = !!basis && (basis.meaningful || basis.taunt === true) && it.action !== 'ignore' && it.action !== 'retreat';
  if (fromTranscript) telegraph(rt, L, it, basis!);
  const quote = basis ? shortQuote(basis.text) : null;
  const line = basis
    ? `it heard "${quote}" -> ${VERB[it.action] ?? it.action}${target && it.action !== 'ignore' && it.action !== 'retreat' ? ` ${target}` : ''}`
    : `it ${VERB[it.action] ?? it.action}${target ? ` ${target}` : ''}`;
  const entry: DecisionEntry = {
    t, at: rt.ctx.now(), heard: quote ?? '', speaker: basis?.speakerName ?? null, action: it.action, target, source, valid, line,
  };
  cm.log.push(entry);
  if (cm.log.length > 200) cm.log.splice(0, cm.log.length - 200);
  const d: ListenerDecision = {
    crew: rt.crew.code, at: entry.at, action: it.action, room: csName, space: it.space, player: it.player, note: it.note,
    heard: basis?.text ?? null, speaker: basis?.speakerName ?? null, speakerId: basis?.speaker ?? null, source, valid, line,
  };
  for (const fn of registry.decisionSubs) {
    try { fn(rt.crew, d); } catch { /* subscriber bug */ }
  }
}

function telegraph(rt: Rt, L: ListenerAgent, it: RuleIntent, basis: HeardLine): void {
  const cm = rt.cm;
  const space = it.space >= 0 ? it.space : spaceAtXZ(rt, L.x, L.z);
  const r = num(rt.listener, 'squelchRadiusM', 20);
  const squelch: string[] = [];
  for (const p of rt.alive()) if (dist(p.pose.p[0], p.pose.p[2], L.x, L.z) <= r && hasWalkie(rt.crew, p)) squelch.push(p.id);
  const callsign = cm.spaceCallsign.get(space) ?? null;
  rt.ctx.emit(rt.crew, 'monsters.telegraph', { space, ms: num(rt.listener, 'telegraphMs', 1200), squelch, callsign });
  rt.ctx.emit(rt.crew, 'monsters.intercept', {
    text: `INTERCEPT: "${interceptQuote(basis)}"`, quote: shortQuote(basis.text, 80), speaker: basis.speakerName, callsign, action: it.action, at: rt.ctx.now(),
  });
}

function wake(rt: Rt, L: ListenerAgent): void {
  L.dormant = false;
  L.active = true;
  startPatrol(rt, L);
  rt.ctx.emit(rt.crew, 'monsters.wake', { ms: num(rt.listener, 'wakeFlickerMs', 1600) });
  const all = rt.alive().filter((p) => hasWalkie(rt.crew, p)).map((p) => p.id);
  if (all.length) rt.ctx.emit(rt.crew, 'monsters.led', { to: all, ms: 1600 });
  rt.ctx.log('monsters').info(`crew ${rt.crew.code}: the Listener woke up (${L.memory.length} lines in memory)`);
  monsterEvent(rt, L, 'wake');
  // immediately act on something it overheard
  for (const l of L.memory) l.used = false;
  maybeDecide(rt, L, true);
}

// ---------------- grab ----------------

function startGrab(rt: Rt, L: ListenerAgent, p: ServerPlayer): void {
  const cm = rt.cm;
  L.state = 'grab';
  L.st = 0;
  L.path = null;
  L.grabVictim = p.id;
  L.grabUntil = cm.time + num(rt.listener, 'grabSec', 3);
  L.yaw = yawTo(L.x, L.z, p.pose.p[0], p.pose.p[2]);
  L.anim = ANIM.mAttack;
  const [px, , pz] = p.pose.p;
  rt.ctx.emit(rt.crew, 'monsters.grab', { id: L.id, victim: p.id, until: rt.serverMs(L.grabUntil), state: 'start', p: [px, 0, pz] });
  rt.cue(L, 'scream', 22);
  monsterEvent(rt, L, 'grab', p.id);
}

/** v1.2: the first grabsBeforeKill grabs per player per contract knock down; later ones hold (struggle / rescue / timer) */
function startGrabV12(rt: Rt, L: ListenerAgent, p: ServerPlayer): void {
  const cm = rt.cm;
  const t = cm.time;
  const b = rt.listener;
  const [px, , pz] = p.pose.p;
  const room = roomName(rt, px, pz);
  L.yaw = yawTo(L.x, L.z, px, pz);
  L.path = null;
  L.pounceUntil = 0;
  monsterEvent(rt, L, 'grab', p.id);
  const knocks = L.knocks.get(p.id) ?? 0;
  if (knocks < num(b, 'grabsBeforeKill', 1)) {
    const sec = num(b, 'knockdownSec', 2);
    L.knocks.set(p.id, knocks + 1);
    L.knocked.set(p.id, { until: t + sec, x: px, z: pz });
    rt.ctx.emit(rt.crew, 'monsters.grab', {
      id: L.id, victim: p.id, until: Math.round(rt.serverMs(t + sec)), state: 'knockdown', p: [r2(px), 0, r2(pz)], room,
      lightOffMs: Math.round(num(b, 'knockdownLightOffSec', 6) * 1000),
    });
    rt.cue(L, 'scream', 22);
    monsterEvent(rt, L, 'knockdown', p.id);
    // it stands over them for a moment, then retreats
    L.state = 'knock';
    L.st = 0;
    L.timer = num(b, 'knockStandSec', 0.6);
    L.retreatAfter = num(b, 'freedRetreatSec', 20);
    L.intent = 'retreat';
    L.targetPlayer = null;
    L.anim = ANIM.mAttack;
    rt.ctx.log('monsters').info(`crew ${rt.crew.code}: the Listener knocked ${p.name} down (grab ${knocks + 1})`);
    return;
  }
  const solo = rt.alive().length <= 1;
  L.state = 'grab';
  L.st = 0;
  L.grabVictim = p.id;
  L.grabSolo = solo;
  L.grabUntil = t + (solo ? num(b, 'soloGrabSec', 6) : num(b, 'grabSec', 5));
  L.grabStruggle = 0;
  L.grabStep = solo ? num(b, 'soloStruggleStep', 0.25) : num(b, 'grabStruggleStep', 0.2);
  L.grabDecay = solo ? num(b, 'soloStruggleDecay', 0.3) : num(b, 'grabStruggleDecay', 0.4);
  L.lastStruggleAt = -100;
  L.anim = ANIM.mAttack;
  rt.ctx.emit(rt.crew, 'monsters.grab', {
    id: L.id, victim: p.id, until: Math.round(rt.serverMs(L.grabUntil)), state: 'start', p: [r2(px), 0, r2(pz)], room,
    solo, struggle: 0, step: L.grabStep, decay: L.grabDecay,
  });
  rt.cue(L, 'scream', 22);
}

/** v1.2: stagger in place (crowbar, escaped grab), then retreat */
function stagger(rt: Rt, L: ListenerAgent, sec: number, retreatSec: number): void {
  L.state = 'stagger';
  L.st = 0;
  L.timer = sec;
  L.retreatAfter = retreatSec;
  L.path = null;
  L.doorWait = 0;
  L.pendingDoor = -1;
  L.intent = 'retreat';
  L.targetPlayer = null;
  L.pounceUntil = 0;
  L.anim = ANIM.mAlert;
}

/** E shove / crowbar from a teammate within range frees the victim; the Listener retreats */
export function tryFree(rt: Rt, L: ListenerAgent, by: ServerPlayer): boolean {
  if (L.state !== 'grab' || !L.grabVictim || by.id === L.grabVictim || !isAlive(rt.crew, by)) return false;
  const victim = rt.crew.players.get(L.grabVictim);
  const range = num(rt.listener, 'shoveRangeM', 2.6);
  const [bx, , bz] = by.pose.p;
  const near = dist(bx, bz, L.x, L.z) <= range || (victim && dist(bx, bz, victim.pose.p[0], victim.pose.p[2]) <= range);
  if (!near) return false;
  rt.ctx.emit(rt.crew, 'monsters.grab', { id: L.id, victim: L.grabVictim, until: 0, state: 'freed', by: by.id, p: [L.x, 0, L.z] });
  monsterEvent(rt, L, 'freed', L.grabVictim, by.id);
  L.grabVictim = null;
  goRetreat(rt, L, num(rt.listener, 'freedRetreatSec', 20));
  return true;
}

/**
 * v1.2: the grab victim mashes E. +step per press (presses closer than grabStruggleMinGapMs count once), the meter
 * decays linearly in the tick; at 1.0 they escape and it staggers grabEscapeStaggerSec, then retreats.
 */
export function listenerStruggle(rt: Rt, L: ListenerAgent, p: ServerPlayer): { ok: boolean; struggle: number; escaped: boolean } {
  if (!fairOn(rt.ctx) || L.state !== 'grab' || L.grabVictim !== p.id) return { ok: false, struggle: 0, escaped: false };
  const t = rt.cm.time;
  if ((t - L.lastStruggleAt) * 1000 >= num(rt.listener, 'grabStruggleMinGapMs', 60)) {
    L.lastStruggleAt = t;
    L.grabStruggle = Math.min(1, L.grabStruggle + L.grabStep);
  }
  if (L.grabStruggle >= 1 - 1e-6) {
    const [px, , pz] = p.pose.p;
    rt.ctx.emit(rt.crew, 'monsters.grab', { id: L.id, victim: p.id, until: 0, state: 'escaped', by: p.id, p: [r2(px), 0, r2(pz)], room: roomName(rt, px, pz) });
    monsterEvent(rt, L, 'escaped', p.id, p.id);
    rt.ctx.log('monsters').info(`crew ${rt.crew.code}: ${p.name} struggled free of the Listener (${Math.round((t - (L.grabUntil - num(rt.listener, L.grabSolo ? 'soloGrabSec' : 'grabSec', 5))) * 10) / 10} s)`);
    L.grabVictim = null;
    stagger(rt, L, num(rt.listener, 'grabEscapeStaggerSec', 3), num(rt.listener, 'freedRetreatSec', 20));
    return { ok: true, struggle: 1, escaped: true };
  }
  return { ok: true, struggle: Math.round(L.grabStruggle * 1000) / 1000, escaped: false };
}

/** v1.2: a crowbar swing (interaction onMelee: eye position + swing direction). Frees a grab (any mode); in v1.2 a hit
 *  during hunt / stalk / notice staggers it staggerSec, then it retreats. True = it hit. */
export function listenerMelee(rt: Rt, L: ListenerAgent, by: ServerPlayer, eye?: unknown, dir?: unknown): boolean {
  if (tryFree(rt, L, by)) return true;
  if (!fairOn(rt.ctx) || !L.active || L.dormant || !isAlive(rt.crew, by)) return false;
  if (L.state !== 'hunt' && L.state !== 'stalk' && L.state !== 'notice') return false;
  const e = Array.isArray(eye) && eye.length >= 3 ? eye.map(Number) : by.pose.p;
  const ex = Number.isFinite(e[0]) ? e[0] : by.pose.p[0], ez = Number.isFinite(e[2]) ? e[2] : by.pose.p[2];
  const d = dist(ex, ez, L.x, L.z);
  if (d > num(rt.listener, 'meleeReachM', 2.4)) return false;
  if (d > 0.5) {
    const dv = Array.isArray(dir) && dir.length >= 3 ? dir.map(Number) : [Math.sin(by.pose.yaw), 0, Math.cos(by.pose.yaw)];
    let fx = dv[0], fz = dv[2];
    const n = Math.hypot(fx, fz);
    if (!(n > 1e-6)) { fx = Math.sin(by.pose.yaw); fz = Math.cos(by.pose.yaw); } else { fx /= n; fz /= n; }
    const cosHalf = Math.cos(((num(rt.listener, 'meleeArcDeg', 110) / 2) * Math.PI) / 180);
    if ((fx * (L.x - ex) + fz * (L.z - ez)) / d < cosHalf) return false;
  }
  if (!los(rt.cm.grid, ex, ez, L.x, L.z, rt.cm.doorOpen)) return false;
  rt.ctx.log('monsters').info(`crew ${rt.crew.code}: ${by.name} hit the Listener with a crowbar (${L.state})`);
  stagger(rt, L, num(rt.listener, 'staggerSec', 2), num(rt.listener, 'staggerRetreatSec', 20));
  return true;
}

/** v1.2: a door closed by a player (hand, within 3 m of it) within doorSlamRangeM in front of the Listener: stun;
 *  the target is dropped unless it still sees them. True = stunned. */
export function listenerDoorClosed(rt: Rt, L: ListenerAgent, doorId: number, byPid: string | null): boolean {
  if (!fairOn(rt.ctx) || !byPid || !L.active || L.dormant) return false;
  if (!['hunt', 'stalk', 'notice', 'investigate', 'patrol', 'search', 'ambush'].includes(L.state)) return false;
  const d = doorById(rt.cm.layout, doorId);
  if (!d) return false;
  const [cx, cz] = doorCenter(d);
  const dd = dist(L.x, L.z, cx, cz);
  if (dd > num(rt.listener, 'doorSlamRangeM', 2)) return false;
  const by = rt.crew.players.get(byPid);
  if (!by || dist(by.pose.p[0], by.pose.p[2], cx, cz) > 3) return false;
  if (dd > 0.6 && (Math.sin(L.yaw) * (cx - L.x) + Math.cos(L.yaw) * (cz - L.z)) / dd < -0.2) return false; // behind it
  const tp = L.targetPlayer ? rt.crew.players.get(L.targetPlayer) : undefined;
  const keep = !!tp && look(rt, L).includes(tp);
  L.state = 'stun';
  L.st = 0;
  L.timer = num(rt.listener, 'doorSlamStunSec', 1);
  L.path = null;
  L.doorWait = 0;
  L.pendingDoor = -1;
  L.pounceUntil = 0;
  L.stunKeep = keep;
  L.anim = ANIM.mAlert;
  if (!keep) {
    L.targetPlayer = null;
    if (L.intent === 'hunt' || L.intent === 'stalk_player' || L.intent === 'notice') L.intent = 'patrol';
  }
  rt.ctx.log('monsters').info(`crew ${rt.crew.code}: ${by.name} slammed a door on the Listener (${keep ? 'still sees its target' : 'target dropped'})`);
  return true;
}

/** v1.2 (SHOULD): a flashbulb within 14 m, a 50 deg cone, LOS: it flinches and retreats (freeing a grab victim) */
export function listenerFlash(rt: Rt, L: ListenerAgent, by: ServerPlayer, at?: unknown, dir?: unknown): boolean {
  if (!fairOn(rt.ctx) || L.dormant || !L.active || L.state === 'out' || L.state === 'vent') return false;
  const o = Array.isArray(at) && at.length >= 3 ? at.map(Number) : by.pose.p;
  const ox = Number.isFinite(o[0]) ? o[0] : by.pose.p[0], oz = Number.isFinite(o[2]) ? o[2] : by.pose.p[2];
  const d = dist(ox, oz, L.x, L.z);
  if (d > num(rt.listener, 'flashFlinchRangeM', 14)) return false;
  if (d > 0.5) {
    const dv = Array.isArray(dir) && dir.length >= 3 ? dir.map(Number) : [Math.sin(by.pose.yaw), 0, Math.cos(by.pose.yaw)];
    let fx = dv[0], fz = dv[2];
    const n = Math.hypot(fx, fz);
    if (!(n > 1e-6)) return false;
    fx /= n;
    fz /= n;
    const cosHalf = Math.cos(((num(rt.listener, 'flashFlinchConeDeg', 50) / 2) * Math.PI) / 180);
    if ((fx * (L.x - ox) + fz * (L.z - oz)) / d < cosHalf) return false;
  }
  if (!los(rt.cm.grid, ox, oz, L.x, L.z, rt.cm.doorOpen)) return false;
  if (L.state === 'grab' && L.grabVictim) {
    rt.ctx.emit(rt.crew, 'monsters.grab', { id: L.id, victim: L.grabVictim, until: 0, state: 'freed', by: by.id, p: [r2(L.x), 0, r2(L.z)] });
    monsterEvent(rt, L, 'freed', L.grabVictim, by.id);
    L.grabVictim = null;
  }
  monsterEvent(rt, L, 'flinch', null, by.id);
  rt.ctx.log('monsters').info(`crew ${rt.crew.code}: the Listener flinched from ${by.name}'s flashbulb`);
  goRetreat(rt, L, num(rt.listener, 'flashFlinchRetreatSec', 15));
  return true;
}

export function grabPosition(L: ListenerAgent): [number, number] {
  return [L.x + Math.sin(L.yaw) * 0.75, L.z + Math.cos(L.yaw) * 0.75];
}

/** v1.2: knocked down right now (pose pinned, isGrabbed) */
export function knockedSpot(rt: Rt, L: ListenerAgent, pid: string): { x: number; z: number } | null {
  const k = L.knocked.get(pid);
  return k && rt.cm.time < k.until ? k : null;
}

// ---------------- tick ----------------

export function listenerTick(rt: Rt, L: ListenerAgent, dt: number): void {
  if (fairOn(rt.ctx)) listenerTickV12(rt, L, dt);
  else listenerTickV11(rt, L, dt);
}

function grabKill(rt: Rt, L: ListenerAgent, v: ServerPlayer): void {
  const cm = rt.cm;
  const t = cm.time;
  const b = L.basis;
  const reason = b ? `heard "${shortQuote(b.text, 40)}"` : 'found you alone';
  const src = b ? `${b.speakerName ?? 'someone'}'s ${b.via === 'radio' ? 'walkie' : b.via === 'text' ? 'message' : 'voice'}` : (cm.spaceCallsign.get(spaceAtXZ(rt, L.x, L.z)) ?? 'in the dark');
  const detail = b ? `${src}, ${Math.max(1, Math.round(t - b.t))} s ago` : src;
  const [px, , pz] = v.pose.p;
  rt.ctx.emit(rt.crew, 'monsters.grab', { id: L.id, victim: v.id, until: 0, state: 'killed', p: [px, 0, pz] });
  L.grabVictim = null;
  rt.kill(L, v, reason, detail);
}

/** v1.1 Listener (flag listenerFairV12 off): unchanged apart from the event bus */
function listenerTickV11(rt: Rt, L: ListenerAgent, dt: number): void {
  const cm = rt.cm;
  const t = cm.time;
  if (L.dormant) {
    L.active = false;
    L.anim = ANIM.mIdle;
    if (t >= L.wakeAt) wake(rt, L);
    return;
  }
  if (L.state === 'out') {
    L.active = false;
    if (t >= L.outUntil) respawn(rt, L);
    return;
  }
  if (L.state === 'vent') {
    L.active = false;
    if (t >= L.ventUntil) exitVent(rt, L);
    return;
  }
  if (L.state === 'grab') {
    L.anim = ANIM.mAttack;
    const v = L.grabVictim ? rt.crew.players.get(L.grabVictim) : undefined;
    if (!v || !isAlive(rt.crew, v)) {
      L.grabVictim = null;
      goRetreat(rt, L, 10);
      return;
    }
    if (t >= L.grabUntil) grabKill(rt, L, v);
    return;
  }
  const seen = look(rt, L);
  const calm = relaxed(rt);
  // touch: grab a lone player, back off from a group
  for (const p of rt.alive()) {
    if (rt.hidden(p)) continue;
    const [px, , pz] = p.pose.p;
    if (dist(px, pz, L.x, L.z) > num(rt.listener, 'grabRadiusM', 1.2)) continue;
    if (aloneNow(rt, p)) return startGrab(rt, L, p);
    if (L.intent === 'hunt') { L.intent = 'stalk_player'; L.targetPlayer = p.id; L.state = 'stalk'; L.until = t + 20; }
  }
  // a lone player in sight: hunt
  if (!calm && L.intent !== 'hunt') {
    const lone = seen.find((p) => aloneNow(rt, p));
    if (lone) {
      L.intent = 'hunt';
      L.targetPlayer = lone.id;
      L.state = 'hunt';
      L.st = 0;
      L.until = t + 25;
      L.path = null;
      rt.cue(L, 'click', 12);
    }
  }
  maybeDecide(rt, L);
  // periodic clicks when someone is close (a tell)
  if (t - L.lastClickAt > 3.5) {
    const near = rt.alive().some((p) => dist(p.pose.p[0], p.pose.p[2], L.x, L.z) < 14);
    if (near) { L.lastClickAt = t + cm.rng.next() * 2; rt.cue(L, 'click', 12); }
  }
  const speedPatrol = num(rt.listener, 'patrolSpeed', 2.6), speedInv = num(rt.listener, 'investigateSpeed', 4);
  const step = (speed: number): string => {
    const r = follow(cm, L, dt, speed, canOpen(rt), 0.8, rt.openDoor);
    if (r === 'arrived' && L.ventFrom && L.ventTo) { enterVent(rt, L); return 'vent'; }
    L.anim = r === 'door' ? ANIM.mIdle : speed > 4.5 ? ANIM.mRun : ANIM.mWalk;
    return r;
  };
  switch (L.state) {
    case 'patrol': {
      if (!L.path) {
        const tgt = randomReachable(cm, L.x, L.z, 6, 22, -1, canOpen(rt));
        if (tgt) planTo(cm, L, tgt[0], tgt[1], canOpen(rt));
        else { L.anim = ANIM.mIdle; break; }
      }
      const r = step(speedPatrol);
      if (r === 'arrived' || r === 'blocked') { L.path = null; L.state = 'search'; L.st = 0; L.searchUntil = t + 2 + cm.rng.next() * 3; }
      break;
    }
    case 'investigate': {
      if (!L.path && !L.ventFrom) { L.state = 'search'; L.st = 0; L.searchUntil = t + num(rt.listener, 'searchSec', 4); break; }
      const r = step(speedInv);
      if (r === 'arrived' || r === 'blocked') { L.path = null; L.state = 'search'; L.st = 0; L.searchUntil = t + num(rt.listener, 'searchSec', 4); }
      break;
    }
    case 'search': {
      L.anim = ANIM.mAlert;
      L.yaw += dt * 0.9 * Math.sin(L.st * 1.3);
      if (t >= L.searchUntil) startPatrol(rt, L);
      break;
    }
    case 'ambush': {
      if (L.path) {
        const r = step(speedInv);
        if (r === 'arrived' || r === 'blocked') L.path = null;
      } else {
        L.anim = ANIM.mIdle;
        const s = cm.layout.spaces[L.targetSpace];
        if (s) turnToward(L, yawTo(L.x, L.z, s.rect.x + s.rect.w / 2, s.rect.y + s.rect.h / 2), dt, 2);
      }
      if (t >= L.until) startPatrol(rt, L);
      break;
    }
    case 'stalk': {
      const k = L.targetPlayer ? L.known.get(L.targetPlayer) : undefined;
      const target = L.targetPlayer ? rt.crew.players.get(L.targetPlayer) : undefined;
      if (!k || !target || !isAlive(rt.crew, target) || t - k.t > 10 || t >= L.until) {
        if (k && !(t - k.t > 30)) { L.intent = 'investigate_room'; L.targetSpace = spaceAtXZ(rt, k.x, k.z); goTo(rt, L, k.x, k.z, 'investigate'); }
        else startPatrol(rt, L);
        break;
      }
      const d = dist(k.x, k.z, L.x, L.z);
      const lo = num(rt.listener, 'stalkMinM', 6), hi = num(rt.listener, 'stalkMaxM', 10);
      if (!calm && aloneNow(rt, target) && d <= num(rt.listener, 'lungeRangeM', 6) && seen.includes(target)) {
        L.intent = 'hunt';
        L.state = 'hunt';
        L.st = 0;
        L.until = t + 20;
        break;
      }
      if (d > hi) {
        if (!L.path || t - L.planAt > 0.7) planTo(cm, L, k.x, k.z, canOpen(rt));
        step(speedInv);
      } else if (d > lo) {
        if (!L.path || t - L.planAt > 0.7) planTo(cm, L, k.x, k.z, canOpen(rt));
        step(speedPatrol * 0.8);
      } else {
        L.path = null;
        L.anim = ANIM.mIdle;
        turnToward(L, yawTo(L.x, L.z, k.x, k.z), dt, 3);
      }
      break;
    }
    case 'hunt': {
      const target = L.targetPlayer ? rt.crew.players.get(L.targetPlayer) : undefined;
      const k = L.targetPlayer ? L.known.get(L.targetPlayer) : undefined;
      if (!target || !k || !isAlive(rt.crew, target) || t - k.t > 6 || t >= L.until || calm) {
        if (k) { L.intent = 'investigate_room'; goTo(rt, L, k.x, k.z, 'investigate'); }
        else startPatrol(rt, L);
        break;
      }
      // while it can sense the target it closes in (it saw or heard them within the last seconds)
      const sensed = seen.includes(target) || t - k.t < 1.5;
      const gx = sensed ? target.pose.p[0] : k.x, gz = sensed ? target.pose.p[2] : k.z;
      if (sensed) L.known.set(target.id, { x: gx, z: gz, t: seen.includes(target) ? t : k.t });
      if (!L.path || t - L.planAt > 0.35) planTo(cm, L, gx, gz, canOpen(rt));
      const d = dist(gx, gz, L.x, L.z);
      step(d <= num(rt.listener, 'lungeRangeM', 6) ? num(rt.listener, 'lungeSpeed', 6.5) : speedInv);
      break;
    }
    default:
      startPatrol(rt, L);
  }
}

// ---------------- v1.2 tick ----------------

/** stop and look: the notice (warns the player; the hunt is decided when it ends) */
function beginNotice(rt: Rt, L: ListenerAgent, p: ServerPlayer): void {
  const t = rt.cm.time;
  const sec = num(rt.listener, 'noticeSec', 1.2);
  L.state = 'notice';
  L.st = 0;
  L.path = null;
  L.doorWait = 0;
  L.pendingDoor = -1;
  L.intent = 'notice';
  L.targetPlayer = p.id;
  L.noticeUntil = t + sec;
  L.noticedAt.set(p.id, t);
  L.warned.set(p.id, t);
  L.pounceUntil = 0;
  L.yaw = yawTo(L.x, L.z, p.pose.p[0], p.pose.p[2]); // the head snap
  L.anim = ANIM.mAlert;
  rt.cue(L, 'notice', num(rt.listener, 'noticeCueRadiusM', 18));
  rt.ctx.emit(rt.crew, 'monsters.spotted', { id: L.id, until: Math.round(rt.serverMs(t + sec)) }, { to: [p.id] });
  monsterEvent(rt, L, 'notice', p.id);
}

function startHunt(rt: Rt, L: ListenerAgent, p: ServerPlayer): void {
  L.intent = 'hunt';
  L.state = 'hunt';
  L.st = 0;
  L.targetPlayer = p.id;
  L.until = rt.cm.time + num(rt.listener, 'huntMaxSec', 25);
  L.path = null;
  L.pounceUntil = 0;
}

function toStalk(rt: Rt, L: ListenerAgent, pid: string): void {
  L.intent = 'stalk_player';
  L.targetPlayer = pid;
  L.state = 'stalk';
  L.st = 0;
  L.until = rt.cm.time + 20;
  L.path = null;
  L.pounceUntil = 0;
}

/** lost them: go to where it last perceived them (seen: the spot; heard: the doorway), else patrol */
function investigateLast(rt: Rt, L: ListenerAgent, pid: string | null): void {
  const k = pid ? L.known.get(pid) : undefined;
  L.pounceUntil = 0;
  if (k && rt.cm.time - k.t <= 30) {
    L.intent = 'investigate_room';
    L.targetSpace = spaceAtXZ(rt, k.x, k.z);
    L.targetPlayer = null;
    L.until = rt.cm.time + 20;
    goTo(rt, L, k.x, k.z, 'investigate');
  } else startPatrol(rt, L);
}

/** an unwarned (or calm-phase) touch: it backs off recoilM from the player */
function recoil(rt: Rt, L: ListenerAgent, p: ServerPlayer): void {
  const m = num(rt.listener, 'recoilM', 1);
  const [px, , pz] = p.pose.p;
  let dx = L.x - px, dz = L.z - pz;
  const d = Math.hypot(dx, dz);
  if (d < 1e-3) { dx = -Math.sin(L.yaw); dz = -Math.cos(L.yaw); } else { dx /= d; dz /= d; }
  for (const k of [m, m * 0.6, m * 0.3]) {
    const nx = L.x + dx * k, nz = L.z + dz * k;
    if (!inCab(rt.cm.layout, nx, nz) && walkClear(rt.cm.grid, L.x, L.z, nx, nz, rt.cm.doorOpen)) {
      L.x = L.lastX = nx;
      L.z = L.lastZ = nz;
      break;
    }
  }
  L.path = null;
  L.yaw = yawTo(L.x, L.z, px, pz);
}

function listenerTickV12(rt: Rt, L: ListenerAgent, dt: number): void {
  const cm = rt.cm;
  const t = cm.time;
  const b = rt.listener;
  if (L.dormant) {
    L.active = false;
    L.anim = ANIM.mIdle;
    if (t >= L.wakeAt) wake(rt, L);
    return;
  }
  if (L.state === 'out') {
    L.active = false;
    if (t >= L.outUntil) respawn(rt, L);
    return;
  }
  if (L.state === 'vent') {
    L.active = false;
    if (t >= L.ventUntil) exitVent(rt, L);
    return;
  }
  if (L.state === 'grab') {
    L.anim = ANIM.mAttack;
    const v = L.grabVictim ? rt.crew.players.get(L.grabVictim) : undefined;
    if (!v || !isAlive(rt.crew, v)) {
      L.grabVictim = null;
      goRetreat(rt, L, 10);
      return;
    }
    L.grabStruggle = Math.max(0, L.grabStruggle - L.grabDecay * dt);
    if (t >= L.grabUntil) grabKill(rt, L, v);
    return;
  }
  if (L.state === 'knock' || L.state === 'stagger') {
    L.anim = L.state === 'knock' ? ANIM.mAttack : ANIM.mAlert;
    L.path = null;
    if (L.st >= L.timer) goRetreat(rt, L, L.retreatAfter);
    return;
  }
  const seen = look(rt, L);
  const calm = relaxed(rt);
  if (L.state === 'stun') {
    L.anim = ANIM.mAlert;
    L.path = null;
    if (L.st < L.timer) return;
    const tp = L.targetPlayer ? rt.crew.players.get(L.targetPlayer) : undefined;
    if (L.stunKeep && tp && isAlive(rt.crew, tp) && !calm && seen.includes(tp)) startHunt(rt, L, tp);
    else {
      L.targetPlayer = null;
      L.intent = 'patrol';
      L.state = 'search';
      L.st = 0;
      L.searchUntil = t + num(b, 'searchSec', 4);
    }
    return;
  }
  // touch: grab a lone, warned player; an unwarned (or calm-phase) touch makes it recoil and notice them
  const grabR = num(b, 'grabRadiusM', 1.2);
  const coolSec = num(b, 'noticeCooldownSec', 3);
  for (const p of rt.alive()) {
    if (rt.hidden(p)) continue;
    const [px, , pz] = p.pose.p;
    if (dist(px, pz, L.x, L.z) > grabR) continue;
    // never through a wall, a fence or a closed door (v1.1 grabbed anyone within 1.2 m in a straight line)
    if (!walkClear(cm.grid, L.x, L.z, px, pz, cm.doorOpen)) continue;
    if (!aloneNow(rt, p)) {
      if (L.intent === 'hunt' || L.state === 'notice') toStalk(rt, L, p.id);
      continue;
    }
    if (calm) {
      recoil(rt, L, p);
      if (L.state !== 'notice' && t - (L.noticedAt.get(p.id) ?? -100) >= coolSec) beginNotice(rt, L, p);
      return;
    }
    const w = warnState(rt, L, p.id);
    if (w === 'ok') return startGrabV12(rt, L, p);
    if (w === 'no') {
      recoil(rt, L, p);
      beginNotice(rt, L, p);
      return;
    }
    // 'fresh': warned less than warnGraceSec ago: no grab yet
  }
  // a lone player in sight: notice (it stops and looks); whether it hunts is decided when the notice ends
  if (!calm && L.state !== 'notice' && L.intent !== 'hunt') {
    const lone = seen.find((p) => aloneNow(rt, p) && t - (L.noticedAt.get(p.id) ?? -100) >= coolSec && !flareBetween(rt, L, p.pose.p[0], p.pose.p[2]));
    if (lone) beginNotice(rt, L, lone);
  }
  maybeDecide(rt, L);
  // periodic clicks when someone is close (a tell)
  if (t - L.lastClickAt > 3.5 && L.state !== 'notice') {
    const near = rt.alive().some((p) => dist(p.pose.p[0], p.pose.p[2], L.x, L.z) < 14);
    if (near) { L.lastClickAt = t + cm.rng.next() * 2; rt.cue(L, 'click', 12); }
  }
  const speedPatrol = num(b, 'patrolSpeed', 2.6), speedInv = num(b, 'investigateSpeed', 4);
  const doorPause = num(b, 'huntDoorPauseSec', 1.4);
  const step = (speed: number, run = false): string => {
    const ox = L.x, oz = L.z;
    let r: string = follow(cm, L, dt, speed, canOpen(rt), doorPause, rt.openDoor);
    if (r === 'arrived' && L.ventFrom && L.ventTo) { enterVent(rt, L); return 'vent'; }
    if (repelled(rt, L, ox, oz, speed, dt)) r = 'blocked';
    L.anim = r === 'door' ? ANIM.mIdle : run || speed > 4.5 ? ANIM.mRun : ANIM.mWalk;
    return r;
  };
  switch (L.state) {
    case 'notice': {
      L.anim = ANIM.mAlert;
      L.path = null;
      const tp = L.targetPlayer ? rt.crew.players.get(L.targetPlayer) : undefined;
      const isSeen = !!tp && seen.includes(tp);
      const k = tp ? L.known.get(tp.id) : undefined;
      if (tp && isSeen) turnToward(L, yawTo(L.x, L.z, tp.pose.p[0], tp.pose.p[2]), dt, 8);
      else if (k) turnToward(L, yawTo(L.x, L.z, k.x, k.z), dt, 4);
      if (t < L.noticeUntil) break;
      if (!tp || !isAlive(rt.crew, tp)) { investigateLast(rt, L, tp?.id ?? null); break; }
      const hp = L.heardP.get(tp.id);
      const sensed = isSeen || (!!hp && t - hp.t <= num(b, 'huntSenseSec', 0.6));
      if (!sensed || calm || rt.hidden(tp)) { investigateLast(rt, L, tp.id); break; }
      if (knob(b, 'huntRequiresAlone', true) && !aloneNow(rt, tp)) { toStalk(rt, L, tp.id); break; }
      const gx = isSeen ? tp.pose.p[0] : hp!.x, gz = isSeen ? tp.pose.p[2] : hp!.z;
      if (flareBetween(rt, L, gx, gz)) { toStalk(rt, L, tp.id); break; }
      startHunt(rt, L, tp);
      break;
    }
    case 'patrol': {
      if (!L.path) {
        const tgt = randomReachable(cm, L.x, L.z, 6, 22, -1, canOpen(rt));
        if (tgt) planTo(cm, L, tgt[0], tgt[1], canOpen(rt));
        else { L.anim = ANIM.mIdle; break; }
      }
      const r = step(speedPatrol);
      if (r === 'arrived' || r === 'blocked') { L.path = null; L.state = 'search'; L.st = 0; L.searchUntil = t + 2 + cm.rng.next() * 3; }
      break;
    }
    case 'investigate': {
      if (!L.path && !L.ventFrom) { L.state = 'search'; L.st = 0; L.searchUntil = t + num(b, 'searchSec', 4); break; }
      const r = step(speedInv);
      if (r === 'arrived' || r === 'blocked') { L.path = null; L.state = 'search'; L.st = 0; L.searchUntil = t + num(b, 'searchSec', 4); }
      break;
    }
    case 'search': {
      L.anim = ANIM.mAlert;
      L.yaw += dt * 0.9 * Math.sin(L.st * 1.3);
      if (t >= L.searchUntil) startPatrol(rt, L);
      break;
    }
    case 'ambush': {
      if (L.path) {
        const r = step(speedInv);
        if (r === 'arrived' || r === 'blocked') L.path = null;
      } else {
        L.anim = ANIM.mIdle;
        const s = cm.layout.spaces[L.targetSpace];
        if (s) turnToward(L, yawTo(L.x, L.z, s.rect.x + s.rect.w / 2, s.rect.y + s.rect.h / 2), dt, 2);
      }
      if (t >= L.until) startPatrol(rt, L);
      break;
    }
    case 'stalk': {
      // keeps 6-10 m; it only hunts again through a notice (lone player in sight, no flare between)
      const k = L.targetPlayer ? L.known.get(L.targetPlayer) : undefined;
      const target = L.targetPlayer ? rt.crew.players.get(L.targetPlayer) : undefined;
      if (!k || !target || !isAlive(rt.crew, target) || t - k.t > 10 || t >= L.until) {
        if (k && !(t - k.t > 30)) { L.intent = 'investigate_room'; L.targetSpace = spaceAtXZ(rt, k.x, k.z); goTo(rt, L, k.x, k.z, 'investigate'); }
        else startPatrol(rt, L);
        break;
      }
      const d = dist(k.x, k.z, L.x, L.z);
      const lo = num(b, 'stalkMinM', 6), hi = num(b, 'stalkMaxM', 10);
      if (d > hi) {
        if (!L.path || t - L.planAt > 0.7) planTo(cm, L, k.x, k.z, canOpen(rt));
        step(speedInv);
      } else if (d > lo) {
        if (!L.path || t - L.planAt > 0.7) planTo(cm, L, k.x, k.z, canOpen(rt));
        step(speedPatrol * 0.8);
      } else {
        L.path = null;
        L.anim = ANIM.mIdle;
        turnToward(L, yawTo(L.x, L.z, k.x, k.z), dt, 3);
      }
      break;
    }
    case 'hunt': {
      const target = L.targetPlayer ? rt.crew.players.get(L.targetPlayer) : undefined;
      if (!target || !isAlive(rt.crew, target) || t >= L.until || calm) { investigateLast(rt, L, target?.id ?? null); break; }
      // sensing: seen now, or heard within huntSenseSec (the perceived doorway, never the live position)
      const isSeen = seen.includes(target);
      const hp = L.heardP.get(target.id);
      const heard = !!hp && t - hp.t <= num(b, 'huntSenseSec', 0.6);
      if (!isSeen && !heard) { investigateLast(rt, L, target.id); break; }
      if (knob(b, 'huntRequiresAlone', true) && !aloneNow(rt, target)) { toStalk(rt, L, target.id); break; }
      const gx = isSeen ? target.pose.p[0] : hp!.x, gz = isSeen ? target.pose.p[2] : hp!.z;
      if (flareBetween(rt, L, gx, gz)) { toStalk(rt, L, target.id); break; }
      // the pounce: a short burst within pounceRangeM (warned players only), then a cooldown
      if (L.pounceUntil > 0 && t >= L.pounceUntil) { L.pounceUntil = 0; L.pounceReadyAt = t + num(b, 'pounceCooldownSec', 1.5); }
      const d = dist(gx, gz, L.x, L.z);
      if (L.pounceUntil === 0 && isSeen && d <= num(b, 'pounceRangeM', 2.2) && t >= L.pounceReadyAt && warnState(rt, L, target.id) === 'ok') {
        L.pounceUntil = t + num(b, 'pounceMaxSec', 0.5);
      }
      const pouncing = L.pounceUntil > t;
      if (!L.path || t - L.planAt > (pouncing ? 0.1 : 0.35) || dist(L.goalX, L.goalZ, gx, gz) > 1) planTo(cm, L, gx, gz, canOpen(rt));
      step(pouncing ? num(b, 'pounceSpeed', 7) : num(b, 'huntSpeed', 4.6), true);
      break;
    }
    default:
      startPatrol(rt, L);
  }
}

export function listenerOf(rt: Rt): ListenerAgent | null {
  return (rt.cm.agents.find((a) => a.kind === 'listener') as ListenerAgent | undefined) ?? null;
}

/** test/debug: force the Listener awake now */
export function forceWake(rt: Rt, L: ListenerAgent): void {
  if (L.dormant) {
    L.wakeAt = rt.cm.time;
    wake(rt, L);
  }
}

/** test/debug (dbg.monsters.intent): execute an intent now as if the rule brain chose it (no transcript basis) */
export function forceIntent(rt: Rt, L: ListenerAgent, action: ListenerAction, space: number, player: string | null): void {
  L.dormant = false;
  L.active = true;
  execute(rt, L, { action, space, player, note: 'dbg', basis: null }, 'dbg', true);
}

/** test/debug: where it would ambush `space` (the point, the door, and its offset from the doorway line) */
export function ambushProbe(rt: Rt, L: ListenerAgent, space: number): { p: [number, number] | null } {
  return { p: ambushPoint(rt, L, space) };
}

/** test/debug (dbg.monsters.grab): grab this player now (skips the warn / alone checks; v1.2 knockdown rules apply) */
export function forceGrab(rt: Rt, L: ListenerAgent, p: ServerPlayer, knockdown?: boolean): void {
  L.dormant = false;
  L.active = true;
  if (knockdown === false) L.knocks.set(p.id, Math.max(L.knocks.get(p.id) ?? 0, num(rt.listener, 'grabsBeforeKill', 1)));
  if (knockdown === true) L.knocks.set(p.id, 0);
  const [px, , pz] = p.pose.p;
  if (dist(px, pz, L.x, L.z) > 1.2) {
    L.x = L.lastX = px + 0.9;
    L.z = L.lastZ = pz;
  }
  if (fairOn(rt.ctx)) startGrabV12(rt, L, p);
  else startGrab(rt, L, p);
}

export { maybeDecide };
