// Owner: track (c) Monsters. Per-crew monster runtime: start/stop, noise -> perception dispatch (shared sound flood +
// perceived doorway), voice loudness as noise, kills, after-death retreats, snapshots.
import { ANIM } from '@dead-air/shared/anim.ts';
import { BAND, BAND_RADIUS_M, CLOCK } from '@dead-air/shared/constants.ts';
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import { buildEdgeGrid, fieldAt, los, soundFlood } from '@dead-air/shared/nav/index.ts';
import { makeRng } from '@dead-air/shared/rng.ts';
import { STANCE } from '@dead-air/shared/state.ts';
import type { MonsterKind, SnapMonster, Snapshot } from '@dead-air/shared/state.ts';
import type { MonsterCue, MonsterEvent, MonsterKindX } from '@dead-air/shared/messages/monsters.ts';
import type { Crew, ServerContext, ServerPlayer } from '../core/types.ts';
import { emitMonsterEvent } from './api.ts';
import { extDoorOpen, extHiddenIn, extKill, extSetDoor, extUnhide, hasDoorApi, isAlive, isHidden } from './ext.ts';
import { dist, inCab, perceive } from './geo.ts';
import type { Perceived } from './geo.ts';
import { bal, num } from './types.ts';
import type { Agent, Bal, CrewMonsters, HoundAgent, ListenerAgent, MannequinAgent, Noise, SnatcherAgent } from './types.ts';
import { houndHear, houndTick, makeHound } from './hound.ts';
import { litAt, makeMannequin, mannequinTick, blinkTick } from './mannequin.ts';
import { listenerHearNoise, listenerTick, makeListener } from './listener.ts';
import { makeSnatcher, snatcherTick, snatchVictim } from './snatcher.ts';

/** Runtime services handed to the per-monster modules. */
export interface Rt {
  ctx: ServerContext;
  crew: Crew;
  cm: CrewMonsters;
  hound: Bal;
  mannequin: Bal;
  listener: Bal;
  snatcher: Bal;
  retreatBal: Bal;
  cue(a: Agent, cue: MonsterCue, radius: number): void;
  kill(a: Agent, p: ServerPlayer, reason: string, detail: string): void;
  /** a monster pushes a door open (its own door noise is not heard by itself) */
  openDoor(id: number, by?: Agent): void;
  /** connected, alive players (any position) */
  alive(): ServerPlayer[];
  hidden(p: ServerPlayer): boolean;
  /** send an agent out of play for `sec` seconds */
  retreat(a: Agent, sec: number): void;
  /** server ms for a crew time (s) */
  serverMs(t: number): number;
}

export interface StartOpts {
  risk: number;
  contractIndex: number;
}

const stats = { noises: 0, floods: 0, kills: 0 };
export function runtimeStats(): typeof stats {
  return stats;
}

export function makeAgentBase<K extends MonsterKindX>(id: string, kind: K, x: number, z: number, yaw: number): Agent & { kind: K } {
  return {
    id, kind, x, z, yaw, state: 'idle', anim: ANIM.mIdle, active: true, st: 0,
    path: null, pathI: 0, goalX: x, goalZ: z, doorWait: 0, pendingDoor: -1, speed: 0, stuck: 0, lastX: x, lastZ: z,
    outUntil: 0, planAt: -10,
  };
}

function baseState(ctx: ServerContext, crew: Crew, layout: LevelLayout, mode: 'hub' | 'contract', o: StartOpts): CrewMonsters {
  const grid = buildEdgeGrid(layout);
  const doorState = new Uint8Array(layout.doors.length);
  const doorIndex = new Map<number, number>();
  layout.doors.forEach((d, i) => {
    doorIndex.set(d.id, i);
    doorState[i] = d.kind === 'open' || d.initiallyOpen ? 1 : 0;
  });
  const spaceCallsign = new Map<number, string>();
  const callsignSpace = new Map<string, number>();
  for (const s of layout.spaces) if (s.callsign) { spaceCallsign.set(s.id, s.callsign); callsignSpace.set(s.callsign, s.id); }
  const cm: CrewMonsters = {
    mode, layout, grid,
    doorOpen: () => true,
    doorState, doorIndex,
    time: 0,
    startedAtMs: ctx.now(),
    risk: Math.max(1, Math.min(3, Math.round(o.risk || 1))),
    contractIndex: Math.max(0, Math.round(o.contractIndex || 0)),
    players: Math.max(1, ctx.crews.connected(crew).length),
    rng: makeRng(`${layout.seed}|${crew.code}|${o.contractIndex}`, 'monsters'),
    agents: [], noiseQ: [], frozen: false, log: [], sight: new Map(), blinks: new Map(), deaths: new Map(),
    voiceAcc: 0, sightAcc: 0, selfNoise: [],
    callsigns: [...callsignSpace.keys()], spaceCallsign, callsignSpace,
    lastAutoStart: 0,
  };
  cm.doorOpen = (id: number) => {
    const ext = extDoorOpen(crew, id);
    if (ext !== undefined) return ext;
    const i = cm.doorIndex.get(id);
    return i !== undefined && cm.doorState[i] === 1;
  };
  return cm;
}

function spawnItems(L: LevelLayout, kind: string) {
  return L.items.filter((i) => i.kind === kind).sort((a, b) => Number(a.data?.order ?? 0) - Number(b.data?.order ?? 0));
}

export function startContract(ctx: ServerContext, crew: Crew, o: StartOpts): CrewMonsters | null {
  const L = crew.layout;
  if (!L || L.kind !== 'facility') return null;
  const cm = baseState(ctx, crew, L, 'contract', o);
  const hb = bal(ctx, 'hound');
  // hounds: one per contract, +1 at 5-6 players on risk >= 2
  const hs = spawnItems(L, 'spawn_hound');
  const nh = 1 + (cm.players >= num(hb, 'extraAtPlayers', 5) && cm.risk >= num(hb, 'extraMinRisk', 2) ? 1 : 0);
  for (let i = 0; i < nh; i++) {
    const s = hs[i] ?? hs[0];
    if (!s) break;
    cm.agents.push(makeHound(`hound${i}`, s.x, s.z, s.rot ?? 0, false, -1));
  }
  // listener: dormant at its spawn
  const ls = spawnItems(L, 'spawn_listener')[0];
  if (ls) {
    const lb = bal(ctx, 'listener');
    const realSec = Number(ctx.balance.core.contractRealSec ?? CLOCK.realSec) || CLOCK.realSec;
    const wake = cm.risk <= 1 ? num(lb, 'dormantRealSecRisk1', 180) : (num(lb, 'dormantGameMin', 3) / CLOCK.totalGameMin) * realSec;
    cm.agents.push(makeListener('listener0', ls.x, ls.z, ls.rot ?? 0, wake));
  }
  // mannequin: risk >= 2 or the crew's 3rd contract (flag 'mannequin'); spawns later (23:30 or Core lifted)
  const mb = bal(ctx, 'mannequin');
  if (ctx.flags.mannequin !== false && (cm.risk >= num(mb, 'minRisk', 2) || cm.contractIndex >= num(mb, 'minContractIndex', 2))) {
    const ms = spawnItems(L, 'spawn_mannequin')[0];
    cm.agents.push(makeMannequin('mannequin0', ms?.x ?? L.van.x, ms?.z ?? L.van.z, ms?.rot ?? 0));
  }
  // snatcher (v1.1): risk >= 2 or the crew's 2nd contract onward (flag 'snatcher'); max 1; hunts after minStartSec
  const sb = bal(ctx, 'snatcher');
  if (ctx.flags.snatcher !== false && (cm.risk >= num(sb, 'minRisk', 2) || cm.contractIndex >= num(sb, 'minContractIndex', 1))) {
    const sn = makeSnatcher('snatcher0', L, num(sb, 'minStartSec', 120));
    if (sn) cm.agents.push(sn);
  }
  crew.slices.monsters = cm;
  return cm;
}

export function startHubRuntime(ctx: ServerContext, crew: Crew): CrewMonsters | null {
  const L = crew.layout;
  if (!L || L.kind !== 'hub') return null;
  const cm = baseState(ctx, crew, L, 'hub', { risk: 1, contractIndex: 0 });
  const s = spawnItems(L, 'spawn_hound').find((i) => i.data?.chained === true) ?? spawnItems(L, 'spawn_hound')[0];
  if (s) {
    const pen = L.owner[Math.floor(s.z) * L.W + Math.floor(s.x)] ?? -1;
    cm.agents.push(makeHound('kennel', s.x, s.z, s.rot ?? 0, true, pen));
  }
  crew.slices.monsters = cm;
  return cm;
}

export function stopRuntime(crew: Crew): void {
  const cm = crew.slices.monsters as CrewMonsters | undefined;
  if (cm) cm.mode = 'off';
  delete crew.slices.monsters;
}

export function makeRt(ctx: ServerContext, crew: Crew, cm: CrewMonsters, onDeath: (crew: Crew, pid: string, killer: Agent | null, x: number, z: number) => void): Rt {
  const rt: Rt = {
    ctx, crew, cm,
    hound: bal(ctx, 'hound'),
    mannequin: bal(ctx, 'mannequin'),
    listener: bal(ctx, 'listener'),
    snatcher: bal(ctx, 'snatcher'),
    retreatBal: bal(ctx, 'retreat'),
    cue(a, cue, radius) {
      ctx.emit(crew, 'monsters.cue', { id: a.id, kind: a.kind, cue, p: [round2(a.x), 0, round2(a.z)], radius });
      logCue(cm, a.id, a.kind, a.x, a.z, radius);
    },
    kill(a, p, reason, detail) {
      if (!isAlive(crew, p)) return;
      stats.kills++;
      const [x, , z] = p.pose.p;
      const cause = { killer: a.kind, reason, detail };
      if (!extKill(crew, p.id, cause)) {
        p.alive = false;
        ctx.crews.broadcastRoster(crew);
      }
      ctx.emit(crew, 'monsters.kill', { victim: p.id, killer: a.kind, reason, detail, p: [round2(x), 0, round2(z)] });
      monsterEvent(rt, a, 'kill', p.id, null, x, z);
      ctx.log('monsters').info(`crew ${crew.code}: ${a.kind.toUpperCase()} killed ${p.name}: ${reason} (${detail})`);
      onDeath(crew, p.id, a, x, z);
    },
    openDoor(id, by) {
      if (cm.doorOpen(id)) return;
      const dd = cm.layout.doors.find((q) => q.id === id);
      if (dd && by) {
        const cx = dd.dir === 'v' ? dd.x : dd.x + dd.len / 2, cz = dd.dir === 'v' ? dd.y + dd.len / 2 : dd.y;
        cm.selfNoise.push({ x: cx, z: cz, until: cm.time + 0.6, agent: by.id });
      }
      if (!extSetDoor(crew, id, true)) {
        const i = cm.doorIndex.get(id);
        if (i !== undefined) cm.doorState[i] = 1;
      }
    },
    alive() {
      const out: ServerPlayer[] = [];
      for (const p of crew.players.values()) if (isAlive(crew, p)) out.push(p);
      return out;
    },
    // hidden in a locker, inside the sealed van cab (sanctuary), or being dragged by the Snatcher: untouchable
    hidden: (p) => isHidden(crew, p) || inCab(cm.layout, p.pose.p[0], p.pose.p[2]) || snatchVictim(cm) === p.id,
    retreat(a, sec) {
      a.active = false;
      a.state = 'out';
      a.path = null;
      a.outUntil = cm.time + sec;
      a.st = 0;
    },
    serverMs: (t) => cm.startedAtMs + t * 1000,
  };
  return rt;
}

const round2 = (v: number) => Math.round(v * 100) / 100;

// ---------------- v1.2 monster event bus (api.onMonsterEvent) ----------------

/** publish one MonsterEvent (victim = perceiver for seen/heard, target otherwise; by = freer / rescuer / cause) */
export function monsterEvent(rt: Rt, a: Agent, event: MonsterEvent['event'], victim?: string | null, by?: string | null, x = a.x, z = a.z): void {
  const e: MonsterEvent = { monster: a.kind, id: a.id, event, p: [round2(x), 0, round2(z)], at: rt.ctx.now() };
  if (victim) e.victim = victim;
  if (by) e.by = by;
  emitMonsterEvent(rt.crew, e);
}

/** a cue went out at (x, z): players inside its radius 'heard' that monster (processed in the 2 Hz pass) */
export function logCue(cm: CrewMonsters, id: string, kind: MonsterKindX, x: number, z: number, r: number): void {
  const log = (cm.cueLog ??= []);
  if (log.length < 64) log.push({ id, kind, x, z, r });
}

/** 2 Hz: 'seen' (in the player's view cone, LOS, lit or close; the Mannequin by the client sighting reports) and
 *  'heard' (inside a cue's radius), deduped per event + monster + player for dedupeSec */
function encounterPass(rt: Rt, dt: number): void {
  const cm = rt.cm;
  const eb = bal(rt.ctx, 'events');
  cm.evAcc = (cm.evAcc ?? 0) + dt;
  if (cm.evAcc < num(eb, 'intervalSec', 0.5)) return;
  cm.evAcc = 0;
  const t = cm.time;
  const dedupe = num(eb, 'dedupeSec', 30);
  const last = (cm.evLast ??= new Map());
  const fresh = (key: string): boolean => {
    const at = last.get(key);
    if (at !== undefined && t - at < dedupe) return false;
    last.set(key, t);
    return true;
  };
  if (last.size > 256) for (const [k, v] of last) if (t - v >= dedupe) last.delete(k);
  const players = rt.alive().filter((p) => !String(extHiddenIn(rt.crew, p.id) ?? '').startsWith('duct:'));
  // heard: every cue since the last pass, straight-line radius (the client plays it within the same radius)
  const cues = cm.cueLog ?? [];
  cm.cueLog = [];
  for (const c of cues) {
    const a = cm.agents.find((q) => q.id === c.id);
    if (!a) continue;
    for (const p of players) {
      if (dist(p.pose.p[0], p.pose.p[2], c.x, c.z) > c.r) continue;
      if (fresh(`heard|${a.id}|${p.id}`)) monsterEvent(rt, a, 'heard', p.id, null, c.x, c.z);
    }
  }
  // seen
  const range = num(eb, 'seenRangeM', 15), close = num(eb, 'seenCloseM', 3);
  const cosHalf = Math.cos(((num(eb, 'seenConeDeg', 110) / 2) * Math.PI) / 180);
  const now = performance.now();
  for (const a of cm.agents) {
    if (!a.active || a.state === 'out' || a.state === 'vent' || a.state === 'dormant') continue;
    if (a.kind === 'listener' && (a as ListenerAgent).dormant) continue;
    if (a.kind === 'mannequin' && !(a as MannequinAgent).spawned) continue;
    if (a.kind === 'snatcher' && (a.state === 'lurk' || a.state === 'duct' || a.state === 'stalk')) continue;
    let litHere: boolean | null = null;
    for (const p of players) {
      const key = `seen|${a.id}|${p.id}`;
      const at = last.get(key);
      if (at !== undefined && t - at < dedupe) continue;
      let vis = false;
      if (a.kind === 'mannequin') {
        const s = cm.sight.get(a.id)?.get(p.id);
        vis = !!s && s.until >= now;
      } else {
        const [px, , pz] = p.pose.p;
        const d = dist(px, pz, a.x, a.z);
        if (d > range) continue;
        if (d > 0.5) {
          const fx = Math.sin(p.pose.yaw), fz = Math.cos(p.pose.yaw);
          if ((fx * (a.x - px) + fz * (a.z - pz)) / d < cosHalf) continue;
        }
        if (!los(cm.grid, px, pz, a.x, a.z, cm.doorOpen)) continue;
        if (d > close) {
          litHere ??= litAt(rt, a.x, a.z);
          if (!litHere) continue;
        }
        vis = true;
      }
      if (vis && fresh(key)) monsterEvent(rt, a, 'seen', p.id);
    }
  }
}

export function bandRadius(ctx: ServerContext, band: number): number {
  const arr = (ctx.balance.voice as { bandRadiusM?: unknown } | undefined)?.bandRadiusM;
  const v = Array.isArray(arr) ? Number(arr[band]) : NaN;
  return Number.isFinite(v) ? v : (BAND_RADIUS_M[band] ?? 0);
}

/** voice loudness of living speakers as noise (van cab sealed), ~6.7 Hz; also samples who is moving / loud */
function voiceNoise(rt: Rt, dt: number): void {
  const { cm, crew, ctx } = rt;
  cm.voiceAcc += dt;
  if (cm.voiceAcc < 0.15) return;
  const el = Math.max(0.05, cm.voiceAcc);
  cm.voiceAcc = 0;
  const act = (cm.activity ??= new Map());
  for (const p of crew.players.values()) {
    if (!isAlive(crew, p)) continue;
    const [px, , pz] = p.pose.p;
    let ac = act.get(p.id);
    if (!ac) {
      ac = { x: px, z: pz, movedAt: -100, loudAt: -100 };
      act.set(p.id, ac);
    }
    const sp = dist(ac.x, ac.z, px, pz) / el;
    // walking / sprinting (creeping in a crouch does not count, even with pose bunching: crouch speed is 1.5 m/s and
    // two bunched 20 Hz poses read ~2.5 m/s); a teleport-sized jump is ignored
    if (sp < 30 && (p.pose.stance === STANCE.crouch ? sp > 2.8 : sp > 0.5)) ac.movedAt = cm.time;
    if (p.band > BAND.whisper) ac.loudAt = cm.time;
    ac.x = px;
    ac.z = pz;
  }
  for (const p of crew.players.values()) {
    if (p.band <= BAND.silent || !isAlive(crew, p)) continue;
    const [x, , z] = p.pose.p;
    if (inCab(cm.layout, x, z)) continue;
    const r = bandRadius(ctx, p.band);
    if (r > 0) cm.noiseQ.push({ x, z, radiusM: r, kind: 'voice', source: p.id, band: p.band });
  }
}

/** can this agent hear right now (the dormant Listener listens) */
function canHear(a: Agent): boolean {
  if (a.kind === 'listener') return (a as ListenerAgent).dormant || a.active || a.state === 'vent';
  return a.active;
}

/** continuous sound classes: one utterance / one burst of steps from one source is ONE sound */
const STREAM_CLASS: Record<string, string> = { voice: 'v', radio: 'r', walkStep: 'w', sprintStep: 's', crouchStep: 'c' };

/** crew time the stream this noise belongs to started; a new stream needs a gap of >= distinctGapSec of silence */
function streamStart(rt: Rt, n: Noise): number {
  const cm = rt.cm;
  const cls = n.source ? STREAM_CLASS[n.kind] : undefined;
  if (!cls) return cm.time;
  const gap = num(rt.hound, 'distinctGapSec', 0.8);
  const streams = (cm.streams ??= new Map());
  const key = `${cls}|${n.source}`;
  const st = streams.get(key);
  if (st && cm.time - st.last < gap) {
    st.last = cm.time;
    return st.start;
  }
  streams.set(key, { start: cm.time, last: cm.time });
  if (streams.size > 64) for (const [k, v] of streams) if (cm.time - v.last > 30) streams.delete(k);
  return cm.time;
}

/** true if this living player walked/sprinted or spoke above a whisper within the last `sec` seconds */
export function activeRecently(rt: Rt, pid: string, sec: number): boolean {
  const ac = rt.cm.activity?.get(pid);
  if (!ac) return true;
  return rt.cm.time - ac.movedAt <= sec || rt.cm.time - ac.loudAt <= sec;
}

function processNoise(rt: Rt): void {
  const { cm, crew } = rt;
  const q = cm.noiseQ;
  if (!q.length) return;
  cm.noiseQ = [];
  for (const n of q) {
    stats.noises++;
    if (!(n.radiusM > 0)) continue;
    if (inCab(cm.layout, n.x, n.z)) continue; // sealed van cab
    if (n.source) {
      const sp = crew.players.get(n.source);
      if (sp && !isAlive(crew, sp)) continue; // the dead make no noise for monsters
    }
    if (n.start === undefined) n.start = streamStart(rt, n);
    let field: Float32Array | null = null;
    const doorish = n.kind === 'door' || n.kind === 'securityDoor';
    for (const a of cm.agents) {
      if (!canHear(a) || inCab(cm.layout, a.x, a.z)) continue;
      if (doorish && !n.source && cm.selfNoise.some((s) => s.agent === a.id && s.until >= cm.time && Math.abs(s.x - n.x) < 1.5 && Math.abs(s.z - n.z) < 1.5)) continue;
      if (Math.abs(a.x - n.x) > n.radiusM + 1 || Math.abs(a.z - n.z) > n.radiusM + 1) continue;
      if (!field) {
        field = soundFlood(cm.grid, n.x, n.z, n.radiusM, cm.doorOpen);
        stats.floods++;
      }
      const d = fieldAt(cm.grid, field, a.x, a.z);
      if (!(d <= n.radiusM)) continue;
      const per: Perceived = perceive(cm, field, a.x, a.z, n.x, n.z);
      // any voice above a whisper from a hiding spot right next to a monster gives you away (a locker; never a duct
      // crawl 'duct:<vent>': nothing pulls a crawler out of the vent)
      if (n.kind === 'voice' && (n.band ?? 0) >= 2 && d <= 2.5 && n.source && (a.kind === 'hound' || a.kind === 'listener')) {
        const hp = crew.players.get(n.source);
        if (hp && isHidden(crew, hp) && !String(extHiddenIn(crew, hp.id) ?? '').startsWith('duct:')) extUnhide(crew, hp.id);
      }
      if (a.kind === 'hound') houndHear(rt, a as HoundAgent, n, d, per);
      else if (a.kind === 'listener') listenerHearNoise(rt, a as ListenerAgent, n, d, per);
    }
  }
}

export function tickRuntime(rt: Rt, dt: number): void {
  const { cm } = rt;
  if (cm.mode === 'off') return;
  if (cm.frozen) {
    cm.noiseQ = [];
    return;
  }
  cm.time += dt;
  if (cm.selfNoise.length) cm.selfNoise = cm.selfNoise.filter((s) => s.until >= cm.time);
  voiceNoise(rt, dt);
  processNoise(rt);
  for (const a of cm.agents) {
    a.st += dt;
    if (a.kind === 'hound') houndTick(rt, a as HoundAgent, dt);
    else if (a.kind === 'mannequin') mannequinTick(rt, a as MannequinAgent, dt);
    else if (a.kind === 'listener') listenerTick(rt, a as ListenerAgent, dt);
    else if (a.kind === 'snatcher') snatcherTick(rt, a as SnatcherAgent, dt);
  }
  blinkTick(rt);
  encounterPass(rt, dt);
}

/** After every death: the killer and monsters within 25 m retreat ~20 s (the hound eats first). */
export function afterDeath(rt: Rt, killer: Agent | null, x: number, z: number): void {
  const { cm } = rt;
  const sec = num(rt.retreatBal, 'afterDeathSec', 20);
  const radius = num(rt.retreatBal, 'radiusM', 25);
  for (const a of cm.agents) {
    if (a.state === 'out' || (a.kind === 'listener' && (a as ListenerAgent).dormant)) continue;
    const near = dist(a.x, a.z, x, z) <= radius;
    if (a !== killer && !near) continue;
    if (a.kind === 'hound' && a === killer) {
      const h = a as HoundAgent;
      h.state = 'eat';
      h.st = 0;
      h.path = null;
      h.eatX = x;
      h.eatZ = z;
      h.timer = num(rt.hound, 'eatSec', 4.5);
      h.outUntil = cm.time + h.timer + sec;
      rt.cue(h, 'eat', 14);
    } else if (a.kind === 'mannequin' && !(a as MannequinAgent).spawned) {
      continue;
    } else if (a.kind === 'snatcher' && (a.state === 'dormant' || (a as SnatcherAgent).victim)) {
      continue; // not out yet / busy with its own victim (its own kill already sent it away)
    } else rt.retreat(a, sec);
  }
}

export function fillSnapshot(cm: CrewMonsters, snap: Snapshot): void {
  for (const a of cm.agents) {
    if (a.kind === 'mannequin' && !(a as MannequinAgent).spawned) continue;
    const m: SnapMonster = {
      id: a.id,
      kind: a.kind,
      p: [round2(a.x), 0, round2(a.z)],
      yaw: Math.round(a.yaw * 1000) / 1000,
      state: a.state,
      anim: a.anim,
      active: a.active,
    };
    snap.monsters.push(m);
  }
}

export function setFallbackDoor(cm: CrewMonsters, id: number, open: boolean): void {
  if (hasDoorApi()) return;
  const i = cm.doorIndex.get(id);
  if (i !== undefined) cm.doorState[i] = open ? 1 : 0;
}

export function agentOf<T extends Agent>(cm: CrewMonsters | null, kind: MonsterKindX): T | null {
  return (cm?.agents.find((a) => a.kind === kind) as T | undefined) ?? null;
}

export function playerPos(p: ServerPlayer): [number, number] {
  return [p.pose.p[0], p.pose.p[2]];
}

export function addNoise(cm: CrewMonsters, n: Noise): void {
  cm.noiseQ.push(n);
}
