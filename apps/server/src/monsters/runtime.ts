// Owner: track (c) Monsters. Per-crew monster runtime: start/stop, noise -> perception dispatch (shared sound flood +
// perceived doorway), voice loudness as noise, kills, after-death retreats, snapshots.
import { ANIM } from '@dead-air/shared/anim.ts';
import { BAND, BAND_RADIUS_M, CLOCK } from '@dead-air/shared/constants.ts';
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import { buildEdgeGrid, fieldAt, soundFlood } from '@dead-air/shared/nav/index.ts';
import { makeRng } from '@dead-air/shared/rng.ts';
import type { MonsterKind, SnapMonster, Snapshot } from '@dead-air/shared/state.ts';
import type { MonsterCue } from '@dead-air/shared/messages/monsters.ts';
import type { Crew, ServerContext, ServerPlayer } from '../core/types.ts';
import { extDoorOpen, extKill, extSetDoor, hasDoorApi, isAlive, isHidden } from './ext.ts';
import { dist, inCab, perceive } from './geo.ts';
import type { Perceived } from './geo.ts';
import { bal, num } from './types.ts';
import type { Agent, Bal, CrewMonsters, HoundAgent, ListenerAgent, MannequinAgent, Noise } from './types.ts';
import { houndHear, houndTick, makeHound } from './hound.ts';
import { makeMannequin, mannequinTick, blinkTick } from './mannequin.ts';
import { listenerHearNoise, listenerTick, makeListener } from './listener.ts';

/** Runtime services handed to the per-monster modules. */
export interface Rt {
  ctx: ServerContext;
  crew: Crew;
  cm: CrewMonsters;
  hound: Bal;
  mannequin: Bal;
  listener: Bal;
  retreatBal: Bal;
  cue(a: Agent, cue: MonsterCue, radius: number): void;
  kill(a: Agent, p: ServerPlayer, reason: string, detail: string): void;
  openDoor(id: number): void;
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

export function makeAgentBase<K extends MonsterKind>(id: string, kind: K, x: number, z: number, yaw: number): Agent & { kind: K } {
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
    voiceAcc: 0, sightAcc: 0,
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
    retreatBal: bal(ctx, 'retreat'),
    cue(a, cue, radius) {
      ctx.emit(crew, 'monsters.cue', { id: a.id, kind: a.kind, cue, p: [round2(a.x), 0, round2(a.z)], radius });
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
      ctx.log('monsters').info(`crew ${crew.code}: ${a.kind.toUpperCase()} killed ${p.name}: ${reason} (${detail})`);
      onDeath(crew, p.id, a, x, z);
    },
    openDoor(id) {
      if (cm.doorOpen(id)) return;
      if (!extSetDoor(crew, id, true)) {
        const i = cm.doorIndex.get(id);
        if (i !== undefined) cm.doorState[i] = 1;
      }
      const d = cm.layout.doors.find((q) => q.id === id);
      if (d) {
        // monsters opening doors are audible (and visible: the interaction track animates the door)
        const cx = d.dir === 'v' ? d.x : d.x + d.len / 2, cz = d.dir === 'v' ? d.y + d.len / 2 : d.y;
        cm.noiseQ.push({ x: cx, z: cz, radiusM: 0, kind: 'monsterDoor', source: '' });
      }
    },
    alive() {
      const out: ServerPlayer[] = [];
      for (const p of crew.players.values()) if (isAlive(crew, p)) out.push(p);
      return out;
    },
    hidden: (p) => isHidden(crew, p),
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

export function bandRadius(ctx: ServerContext, band: number): number {
  const arr = (ctx.balance.voice as { bandRadiusM?: unknown } | undefined)?.bandRadiusM;
  const v = Array.isArray(arr) ? Number(arr[band]) : NaN;
  return Number.isFinite(v) ? v : (BAND_RADIUS_M[band] ?? 0);
}

/** voice loudness of living speakers as noise (van cab sealed), ~6.7 Hz */
function voiceNoise(rt: Rt, dt: number): void {
  const { cm, crew, ctx } = rt;
  cm.voiceAcc += dt;
  if (cm.voiceAcc < 0.15) return;
  cm.voiceAcc = 0;
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
    let field: Float32Array | null = null;
    for (const a of cm.agents) {
      if (!canHear(a) || inCab(cm.layout, a.x, a.z)) continue;
      if (Math.abs(a.x - n.x) > n.radiusM + 1 || Math.abs(a.z - n.z) > n.radiusM + 1) continue;
      if (!field) {
        field = soundFlood(cm.grid, n.x, n.z, n.radiusM, cm.doorOpen);
        stats.floods++;
      }
      const d = fieldAt(cm.grid, field, a.x, a.z);
      if (!(d <= n.radiusM)) continue;
      const per: Perceived = perceive(cm, field, a.x, a.z, n.x, n.z);
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
  voiceNoise(rt, dt);
  processNoise(rt);
  for (const a of cm.agents) {
    a.st += dt;
    if (a.kind === 'hound') houndTick(rt, a as HoundAgent, dt);
    else if (a.kind === 'mannequin') mannequinTick(rt, a as MannequinAgent, dt);
    else if (a.kind === 'listener') listenerTick(rt, a as ListenerAgent, dt);
  }
  blinkTick(rt);
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

export function agentOf<T extends Agent>(cm: CrewMonsters | null, kind: MonsterKind): T | null {
  return (cm?.agents.find((a) => a.kind === kind) as T | undefined) ?? null;
}

export function playerPos(p: ServerPlayer): [number, number] {
  return [p.pose.p[0], p.pose.p[2]];
}

export function addNoise(cm: CrewMonsters, n: Noise): void {
  cm.noiseQ.push(n);
}
