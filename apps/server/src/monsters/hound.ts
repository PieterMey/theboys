// Owner: track (c) Monsters. THE HOUND (blind; every risk). Ignores anything below talk-level loudness (whispers,
// crouch steps). First heard sound -> ALERT (1.5 s head tilt + growl audible 10 m) -> INVESTIGATE the doorway the sound
// came through at 4 m/s -> CHARGE (7.5 m/s after a 300-600 ms wind-up, kills on contact) only if a second noise comes
// within 6 s and within 12 m. Loses interest after 10 s of quiet. Bottles override everything.
// Chained kennel variant (hub): whisper ignored, talk -> turns + growls, shout -> lunges at the fence. Never kills.
import { ANIM } from '@dead-air/shared/anim.ts';
import { BAND } from '@dead-air/shared/constants.ts';
import type { ServerPlayer } from '../core/types.ts';
import type { Rt } from './runtime.ts';
import { activeRecently, makeAgentBase } from './runtime.ts';
import { doorById, dist, follow, monsterCanOpen, planTo, randomReachable, throughDoor, turnToward, yawTo } from './geo.ts';
import type { Perceived } from './geo.ts';
import { num } from './types.ts';
import type { HoundAgent, Noise } from './types.ts';

export function makeHound(id: string, x: number, z: number, yaw: number, chained: boolean, pen: number): HoundAgent {
  return {
    ...makeAgentBase(id, 'hound', x, z, yaw),
    chained, pen,
    lastNoiseAt: -100, lastNoiseKind: '', lastNoiseDist: 0, lastGrowlAt: -100,
    tx: x, tz: z, tdoor: -1, windup: 0, timer: 1, eatX: x, eatZ: z, causeKind: '', causeDist: 0,
  };
}

/** label for death cards: "heard your SPRINT" */
export function noiseLabel(n: Pick<Noise, 'kind' | 'band'>): string {
  switch (n.kind) {
    case 'voice': return n.band !== undefined && n.band >= BAND.scream ? 'SCREAM' : n.band !== undefined && n.band >= BAND.shout ? 'SHOUT' : 'VOICE';
    case 'radio': return 'WALKIE';
    case 'walkStep': return 'FOOTSTEPS';
    case 'sprintStep': return 'SPRINT';
    case 'crouchStep': return 'CREEPING';
    case 'door': return 'DOOR';
    case 'securityDoor': return 'SECURITY DOOR';
    case 'coreDrop': return 'CORE DROP';
    case 'leverAlarm': return 'LEVER ALARM';
    case 'airhorn': return 'AIRHORN';
    case 'crowbar': return 'CROWBAR';
    case 'deadStatic': return 'STATIC';
    default: return n.kind.replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase();
  }
}

function setState(h: HoundAgent, s: string, timer = 0): void {
  h.state = s;
  h.st = 0;
  h.timer = timer;
}

function canOpenFor(rt: Rt) {
  return monsterCanOpen(rt.cm.layout);
}

function growl(rt: Rt, h: HoundAgent): void {
  if (rt.cm.time - h.lastGrowlAt < 2.2) return;
  h.lastGrowlAt = rt.cm.time;
  rt.cue(h, 'growl', num(rt.hound, 'growlRadiusM', 10));
}

function startWindup(rt: Rt, h: HoundAgent, x: number, z: number, n: Noise, d: number): void {
  const lo = num(rt.hound, 'windupMinMs', 300), hi = num(rt.hound, 'windupMaxMs', 600);
  h.tx = x;
  h.tz = z;
  h.tdoor = -1;
  h.causeKind = n.source ? `${n.source}|${noiseLabel(n)}` : `|${noiseLabel(n)}`;
  h.causeDist = d;
  // the growl -> charge gap is always readable (>= minChargeAfterGrowlSec), the bark comes first
  const minGap = num(rt.hound, 'minChargeAfterGrowlSec', 1.6);
  const w = Math.max((lo + rt.cm.rng.next() * (hi - lo)) / 1000, h.lastGrowlAt + minGap - rt.cm.time);
  setState(h, 'windup', Math.min(2.5, w));
  h.path = null;
  h.anim = ANIM.mAttack;
  h.yaw = yawTo(h.x, h.z, x, z);
  rt.cue(h, 'bark', 20);
}

function investigateTarget(rt: Rt, h: HoundAgent, per: Perceived): [number, number] {
  if (per.door >= 0) {
    const d = doorById(rt.cm.layout, per.door);
    if (d) {
      const open = rt.cm.doorOpen(d.id) || d.kind === 'door' || d.kind === 'fire';
      // step through the doorway if it can (it is "where the sound came from"), else wait on this side
      return throughDoor(d, h.x, h.z, open ? 0.7 : -0.6);
    }
  }
  return [per.x, per.z];
}

export function houndHear(rt: Rt, h: HoundAgent, n: Noise, d: number, per: Perceived): void {
  if (!h.active || h.state === 'eat' || h.state === 'out') return;
  if (h.chained) return kennelHear(rt, h, n);
  const now = rt.cm.time;
  if (n.kind === 'bottle') {
    // bottles override everything: go to the impact point and sniff
    h.tx = n.x;
    h.tz = n.z;
    setState(h, 'bottle');
    planTo(rt.cm, h, n.x, n.z, canOpenFor(rt));
    rt.cue(h, 'huff', 8);
    return;
  }
  if (h.state === 'bottle' || h.state === 'sniff') return;
  if (n.radiusM < num(rt.hound, 'hearMinRadiusM', 4)) return; // whispers, crouch steps
  if (n.kind === 'monsterDoor') return;
  // the second noise must be a DISTINCT sound: a new utterance / step burst (>= distinctGapSec of silence before it) or a
  // separate non-voice noise. Ongoing speech that began before / at the alert never counts.
  const heardAt = h.heardAt ?? -100;
  const distinct = (n.start ?? now) > heardAt + 0.05;
  h.lastNoiseAt = now;
  h.lastNoiseKind = n.kind;
  h.lastNoiseDist = d;
  const window = num(rt.hound, 'chargeWindowSec', 6), range = num(rt.hound, 'chargeRangeM', 12);
  const grace = num(rt.hound, 'alertGraceSec', 1.0);
  const second = distinct && now - heardAt <= window && d <= range;
  if (distinct) h.heardAt = now;
  switch (h.state) {
    case 'idle': {
      h.heardAt = now;
      const [tx, tz] = investigateTarget(rt, h, per);
      h.tx = tx;
      h.tz = tz;
      h.tdoor = per.door;
      setState(h, 'alert', num(rt.hound, 'alertSec', 1.5));
      h.path = null;
      growl(rt, h);
      return;
    }
    case 'alert': {
      if (second && h.st >= grace) return startWindup(rt, h, n.x, n.z, n, d);
      const [tx, tz] = investigateTarget(rt, h, per);
      h.tx = tx;
      h.tz = tz;
      h.tdoor = per.door;
      return;
    }
    case 'investigate':
    case 'search': {
      if (second) return startWindup(rt, h, n.x, n.z, n, d);
      const [tx, tz] = investigateTarget(rt, h, per);
      if (dist(tx, tz, h.tx, h.tz) > 1.5) {
        h.tx = tx;
        h.tz = tz;
        h.tdoor = per.door;
        setState(h, 'investigate');
        planTo(rt.cm, h, tx, tz, canOpenFor(rt));
        if (now - h.lastGrowlAt > 4) growl(rt, h);
      }
      return;
    }
    case 'windup':
    case 'charge': {
      if (d <= range) {
        h.tx = n.x;
        h.tz = n.z;
        h.causeKind = n.source ? `${n.source}|${noiseLabel(n)}` : `|${noiseLabel(n)}`;
        h.causeDist = d;
      }
      return;
    }
  }
}

function kennelHear(rt: Rt, h: HoundAgent, n: Noise): void {
  if (n.kind !== 'voice' && n.kind !== 'airhorn' && n.kind !== 'bottle' && n.kind !== 'radio') return;
  if (n.radiusM < num(rt.hound, 'hearMinRadiusM', 4)) return; // whisper: ignored
  const L = rt.cm.layout;
  const pen = L.spaces[h.pen]?.rect;
  const shout = n.kind !== 'voice' || (n.band ?? 0) >= BAND.shout || n.radiusM >= 25;
  h.lastNoiseAt = rt.cm.time;
  if (shout) {
    if (h.state === 'lunge') return;
    // lunge at the fence point nearest the speaker (clamped inside the pen)
    let tx = n.x, tz = n.z;
    if (pen) {
      tx = Math.min(pen.x + pen.w - 0.45, Math.max(pen.x + 0.45, n.x));
      tz = Math.min(pen.y + pen.h - 0.45, Math.max(pen.y + 0.45, n.z));
    }
    h.tx = tx;
    h.tz = tz;
    setState(h, 'lunge', num(rt.hound, 'kennelLungeSec', 1.4));
    planTo(rt.cm, h, tx, tz);
    h.anim = ANIM.mAttack;
    rt.cue(h, 'lunge', 30);
    return;
  }
  if (h.state === 'lunge') return;
  const fresh = h.state !== 'alert';
  h.tx = n.x;
  h.tz = n.z;
  if (fresh) {
    // talk: it turns, pads up to the fence toward the speaker and growls (visible from outside the pen)
    setState(h, 'alert', num(rt.hound, 'kennelAlertSec', 2.2));
    h.path = null;
    if (pen) {
      const fx = Math.min(pen.x + pen.w - 0.6, Math.max(pen.x + 0.6, n.x));
      const fz = Math.min(pen.y + pen.h - 0.6, Math.max(pen.y + 0.6, n.z));
      const k = Math.min(1, num(rt.hound, 'kennelApproachFrac', 0.6));
      const ax = h.x + (fx - h.x) * k, az = h.z + (fz - h.z) * k;
      if (dist(ax, az, h.x, h.z) > 0.6) planTo(rt.cm, h, ax, az);
    }
  } else h.timer = Math.max(h.timer, h.st + 1.2); // keeps watching while the talk goes on
  growl(rt, h);
}

function contactKill(rt: Rt, h: HoundAgent, radius: number): ServerPlayer | null {
  for (const p of rt.alive()) {
    if (rt.hidden(p)) continue;
    if (dist(p.pose.p[0], p.pose.p[2], h.x, h.z) <= radius) return p;
  }
  return null;
}

/** bumped while investigating / sniffing: only a player who is walking or louder than a whisper gives itself away */
function activeContact(rt: Rt, h: HoundAgent, radius: number): ServerPlayer | null {
  for (const p of rt.alive()) {
    if (rt.hidden(p)) continue;
    if (dist(p.pose.p[0], p.pose.p[2], h.x, h.z) > radius) continue;
    if (activeRecently(rt, p.id, 0.6)) return p;
  }
  return null;
}

function presenceWindup(rt: Rt, h: HoundAgent, p: ServerPlayer): void {
  const loud = rt.cm.activity ? rt.cm.time - (rt.cm.activity.get(p.id)?.loudAt ?? -100) <= 0.6 : false;
  startWindup(rt, h, p.pose.p[0], p.pose.p[2], { x: p.pose.p[0], z: p.pose.p[2], radiusM: 1, kind: 'bump', source: p.id }, 1);
  h.causeKind = `${p.id}|${loud ? 'VOICE' : 'MOVEMENT'}`;
}

/** a living, visible player standing right next to the hound (frozen players are sniffed at, then ignored) */
function playerNear(rt: Rt, h: HoundAgent, radius: number): boolean {
  return rt.alive().some((p) => !rt.hidden(p) && dist(p.pose.p[0], p.pose.p[2], h.x, h.z) <= radius);
}

function killCause(rt: Rt, h: HoundAgent, victim: ServerPlayer): [string, string] {
  const [src, label] = h.causeKind.split('|');
  const who = src && src !== victim.id ? rt.crew.players.get(src)?.name : null;
  const reason = who ? `heard ${who}'s ${label || 'NOISE'}` : `heard your ${label || 'NOISE'}`;
  return [reason, `${Math.max(1, Math.round(h.causeDist))} m`];
}

function wander(rt: Rt, h: HoundAgent, dt: number): void {
  const speed = num(rt.hound, 'wanderSpeed', 1.5);
  if (!h.path) {
    h.anim = ANIM.mIdle;
    h.timer -= dt;
    if (h.timer > 0) return;
    const range = num(rt.hound, 'wanderRangeM', 14);
    const t = h.chained ? randomReachable(rt.cm, h.x, h.z, 1, 6, h.pen) : randomReachable(rt.cm, h.x, h.z, 4, range, -1, canOpenFor(rt));
    if (!t || !planTo(rt.cm, h, t[0], t[1], h.chained ? undefined : canOpenFor(rt))) {
      h.timer = 2;
      return;
    }
  }
  const r = follow(rt.cm, h, dt, speed, canOpenFor(rt), 0.6, rt.openDoor);
  h.anim = r === 'door' ? ANIM.mIdle : ANIM.mWalk;
  if (r === 'arrived' || r === 'blocked') {
    h.path = null;
    const lo = num(rt.hound, 'wanderPauseMinSec', 2), hi = num(rt.hound, 'wanderPauseMaxSec', 6);
    h.timer = lo + rt.cm.rng.next() * (hi - lo);
  }
}

export function houndTick(rt: Rt, h: HoundAgent, dt: number): void {
  const cm = rt.cm;
  if (h.state === 'out') {
    h.active = false;
    if (cm.time >= h.outUntil) respawnFar(rt, h);
    return;
  }
  if (h.chained) return kennelTick(rt, h, dt);
  const lose = num(rt.hound, 'loseInterestSec', 10);
  switch (h.state) {
    case 'idle':
      wander(rt, h, dt);
      break;
    case 'alert':
      h.anim = ANIM.mAlert;
      turnToward(h, yawTo(h.x, h.z, h.tx, h.tz), dt, 4);
      if (h.st >= h.timer) {
        setState(h, 'investigate');
        if (!planTo(cm, h, h.tx, h.tz, canOpenFor(rt))) setState(h, 'search', 3);
      }
      break;
    case 'investigate': {
      if (!h.path && !planTo(cm, h, h.tx, h.tz, canOpenFor(rt))) {
        setState(h, 'search', 3);
        break;
      }
      const r = follow(cm, h, dt, num(rt.hound, 'investigateSpeed', 4), canOpenFor(rt), 0.5, rt.openDoor);
      h.anim = r === 'door' ? ANIM.mIdle : ANIM.mRun;
      const bump = activeContact(rt, h, num(rt.hound, 'bumpRadiusM', 1.8));
      if (bump) {
        // blind, but it bumped into someone walking / talking: wind up and lunge (a frozen, silent player is safe)
        presenceWindup(rt, h, bump);
        break;
      }
      // a sound heard directly (same room): it goes to where the sound arrived, stopping short of the exact spot
      const short = h.tdoor < 0 && dist(h.x, h.z, h.tx, h.tz) <= num(rt.hound, 'investigateStandoffM', 1.6);
      if (r === 'arrived' || r === 'blocked' || short) {
        setState(h, 'search', num(rt.hound, 'sniffMinSec', 2) + cm.rng.next() * (num(rt.hound, 'sniffMaxSec', 3) - num(rt.hound, 'sniffMinSec', 2)));
        h.path = null;
        rt.cue(h, 'sniff', 6);
      }
      if (cm.time - h.lastNoiseAt > lose) setState(h, 'idle', 1);
      break;
    }
    case 'search': {
      h.anim = ANIM.mIdle;
      const bump = activeContact(rt, h, num(rt.hound, 'bumpRadiusM', 1.8));
      if (bump) {
        presenceWindup(rt, h, bump);
        break;
      }
      if (h.st >= h.timer && playerNear(rt, h, 2.4)) {
        // sniffed a frozen, silent player for a few seconds: loses interest
        h.path = null;
        h.lastNoiseAt = -100;
        h.heardAt = -100;
        setState(h, 'idle', 2 + cm.rng.next() * 2);
        break;
      }
      if (h.st >= h.timer && !h.path) {
        const t = randomReachable(cm, h.x, h.z, 2, 6, -1, canOpenFor(rt));
        if (t) planTo(cm, h, t[0], t[1], canOpenFor(rt));
        h.timer = h.st + 3 + cm.rng.next() * 2;
      }
      if (h.path) {
        const r = follow(cm, h, dt, 1.8, canOpenFor(rt), 0.6, rt.openDoor);
        h.anim = ANIM.mWalk;
        if (r !== 'moving' && r !== 'door') h.path = null;
      }
      if (cm.time - h.lastNoiseAt > lose) setState(h, 'idle', 1);
      break;
    }
    case 'windup':
      h.anim = ANIM.mAttack;
      turnToward(h, yawTo(h.x, h.z, h.tx, h.tz), dt, 12);
      if (h.st >= h.timer) {
        setState(h, 'charge');
        planTo(cm, h, h.tx, h.tz, canOpenFor(rt));
      }
      break;
    case 'charge': {
      if (cm.time - h.planAt > 0.35 && dist(h.goalX, h.goalZ, h.tx, h.tz) > 0.8) planTo(cm, h, h.tx, h.tz, canOpenFor(rt));
      const r = follow(cm, h, dt, num(rt.hound, 'chargeSpeed', 7.5), canOpenFor(rt), 0.25, rt.openDoor);
      h.anim = ANIM.mRun;
      const victim = contactKill(rt, h, num(rt.hound, 'killRadiusM', 0.95));
      if (victim) {
        const [reason, detail] = killCause(rt, h, victim);
        h.anim = ANIM.mAttack;
        rt.kill(h, victim, reason, detail);
        break;
      }
      if (r === 'arrived' || r === 'blocked') {
        setState(h, 'search', 2 + cm.rng.next() * 2);
        h.path = null;
        rt.cue(h, 'sniff', 6);
      }
      break;
    }
    case 'bottle': {
      if (!h.path && !planTo(cm, h, h.tx, h.tz, canOpenFor(rt))) {
        setState(h, 'sniff', num(rt.hound, 'bottleSniffSec', 6));
        break;
      }
      const r = follow(cm, h, dt, num(rt.hound, 'investigateSpeed', 4) + 0.6, canOpenFor(rt), 0.4, rt.openDoor);
      h.anim = r === 'door' ? ANIM.mIdle : ANIM.mRun;
      if (r === 'arrived' || r === 'blocked') {
        setState(h, 'sniff', num(rt.hound, 'bottleSniffSec', 6));
        h.path = null;
        rt.cue(h, 'sniff', 8);
      }
      break;
    }
    case 'sniff':
      h.anim = ANIM.mIdle;
      if (Math.floor(h.st / 2) !== Math.floor((h.st - dt) / 2)) rt.cue(h, 'sniff', 6);
      if (h.st >= h.timer) {
        h.lastNoiseAt = -100;
        setState(h, 'idle', 1.5);
      }
      break;
    case 'eat':
      h.anim = ANIM.mEat;
      h.path = null;
      turnToward(h, yawTo(h.x, h.z, h.eatX, h.eatZ), dt, 6);
      if (h.st >= h.timer) {
        h.active = false;
        h.state = 'out';
        h.st = 0;
      }
      break;
    default:
      setState(h, 'idle', 1);
  }
}

function kennelTick(rt: Rt, h: HoundAgent, dt: number): void {
  switch (h.state) {
    case 'alert': {
      let moving = false;
      if (h.path) {
        const r = follow(rt.cm, h, dt, num(rt.hound, 'kennelApproachSpeed', 1.8), undefined, 0, rt.openDoor);
        moving = r === 'moving';
        if (!moving) h.path = null;
      }
      h.anim = moving ? ANIM.mWalk : ANIM.mAlert;
      if (!moving) turnToward(h, yawTo(h.x, h.z, h.tx, h.tz), dt, 6);
      if (h.st >= h.timer) {
        h.path = null;
        setState(h, 'idle', 2 + rt.cm.rng.next() * 3);
      }
      break;
    }
    case 'lunge': {
      const r = follow(rt.cm, h, dt, 6.5, undefined, 0, rt.openDoor);
      turnToward(h, yawTo(h.x, h.z, h.tx, h.tz), dt, 12);
      h.anim = r === 'moving' ? ANIM.mRun : ANIM.mAttack;
      if (h.st >= h.timer + 0.6) {
        h.path = null;
        setState(h, 'idle', 1.5);
      }
      break;
    }
    default:
      wander(rt, h, dt);
  }
}

/** back in play after a retreat: a spawn point (or random cell) far from every living player */
function respawnFar(rt: Rt, h: HoundAgent): void {
  const cm = rt.cm;
  const players = rt.alive();
  const far = (x: number, z: number) => players.every((p) => dist(p.pose.p[0], p.pose.p[2], x, z) >= 18);
  const spots = cm.layout.items.filter((i) => i.kind === 'spawn_hound' && far(i.x, i.z));
  let pt: [number, number] | null = spots.length ? [spots[0].x, spots[0].z] : null;
  if (!pt) {
    for (let i = 0; i < 8 && !pt; i++) {
      const c = randomReachable(cm, h.x, h.z, 10, 60, -1, monsterCanOpen(cm.layout));
      if (c && far(c[0], c[1])) pt = c;
    }
  }
  if (pt) {
    h.x = pt[0];
    h.z = pt[1];
  }
  h.active = true;
  h.lastNoiseAt = -100;
  h.path = null;
  setState(h, 'idle', 2);
}
