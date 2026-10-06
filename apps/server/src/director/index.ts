// Owner: track (c) Monsters + director (apps/server/src/director/**). Deterministic pacing director (Left 4 Dead style):
// per-player tension from monster proximity, chases, grabs, nearby deaths, sprinting and darkness; cycle
// build-up -> peak (3-5 s) -> fade -> relax (30-45 s). Every 20-30 s it lists the allowed ambient events and picks one
// via director.setPicker (AI track, JEV) or a weighted random pick; clients render/play 'monsters.director' events.
// Installed by apps/server/src/monsters/index.ts (the director has no entry of its own in the server track list).
import { STANCE } from '@dead-air/shared/state.ts';
import type { DirectorEventKind } from '@dead-air/shared/messages/monsters.ts';
import { cellOf, los } from '@dead-air/shared/nav/index.ts';
import type { Crew, ServerContext, ServerPlayer } from '../core/types.ts';
import { SYSTEM_ORDER } from '../core/types.ts';
import type { Rt } from '../monsters/runtime.ts';
import { registry } from '../monsters/registry.ts';
import type { DirectorPickState } from '../monsters/registry.ts';
import { bal, num } from '../monsters/types.ts';
import type { HoundAgent, ListenerAgent, MannequinAgent } from '../monsters/types.ts';
import { dist, doorCenter, inCab, monsterCanOpen, randomReachable } from '../monsters/geo.ts';
import { extLightsOn, extSetDoor, extSetLights, hasWalkie, isAlive } from '../monsters/ext.ts';
import { clockMin, relocateMannequin } from '../monsters/mannequin.ts';

type Phase = DirectorPickState['phase'];

export interface DirectorSlice {
  phase: Phase;
  phaseT: number;
  phaseDur: number;
  tension: Record<string, number>;
  nextEventAt: number;
  picking: boolean;
  lastEvent: string;
  events: { t: number; kind: string; source: string }[];
  /** agent id -> last seen chase state (chase-start detection) */
  chase: Record<string, string>;
  grabbed: Record<string, boolean>;
  t: number;
}

const CHASE = new Set(['charge', 'windup', 'hunt', 'grab', 'move']);

function slice(crew: Crew): DirectorSlice {
  let d = crew.slices.director as DirectorSlice | undefined;
  if (!d) {
    d = { phase: 'build', phaseT: 0, phaseDur: 0, tension: {}, nextEventAt: 25, picking: false, lastEvent: '', events: [], chase: {}, grabbed: {}, t: 0 };
    crew.slices.director = d;
  }
  return d;
}

export function resetDirector(crew: Crew): void {
  delete crew.slices.director;
}

/** a death is always a peak: monsters back off and the crew gets a breather afterwards */
export function directorDeath(crew: Crew, x: number, z: number): void {
  const d = slice(crew);
  for (const p of crew.players.values()) {
    if (!p.connected) continue;
    const near = dist(p.pose.p[0], p.pose.p[2], x, z) <= 15;
    d.tension[p.id] = Math.min(1, (d.tension[p.id] ?? 0) + (near ? 0.3 : 0.1));
  }
  setPhase(d, 'peak', 4);
}

function setPhase(d: DirectorSlice, phase: Phase, dur: number): void {
  d.phase = phase;
  d.phaseT = 0;
  d.phaseDur = dur;
}

function spaceLit(rt: Rt, x: number, z: number): boolean {
  const s = rt.cm.layout.owner[cellOf(rt.cm.grid, x, z)] ?? -1;
  if (s < 0) return false;
  const on = extLightsOn(rt.crew, s);
  return on !== undefined ? on : rt.cm.layout.spaces[s]?.light === 'on' || rt.cm.layout.spaces[s]?.light === 'flicker';
}

function updateTension(rt: Rt, d: DirectorSlice, dt: number): void {
  const b = bal(rt.ctx, 'director');
  const decay = num(b, 'decayPerSec', 0.04);
  const players = rt.alive();
  const cm = rt.cm;
  // chase starts (+0.25 to players within 12 m)
  for (const a of cm.agents) {
    const prev = d.chase[a.id] ?? '';
    const now = a.active ? a.state : 'out';
    if (now !== prev) {
      d.chase[a.id] = now;
      if (CHASE.has(now) && !CHASE.has(prev)) {
        for (const p of players) if (dist(p.pose.p[0], p.pose.p[2], a.x, a.z) <= 12) d.tension[p.id] = Math.min(1, (d.tension[p.id] ?? 0) + 0.25);
      }
    }
    if (a.kind === 'listener') {
      const v = (a as ListenerAgent).grabVictim;
      if (v && !d.grabbed[v]) { d.grabbed[v] = true; d.tension[v] = Math.min(1, (d.tension[v] ?? 0) + 0.5); }
      if (!v) d.grabbed = {};
    }
  }
  for (const p of players) {
    let t = d.tension[p.id] ?? 0;
    const [px, , pz] = p.pose.p;
    let engaged = false;
    for (const a of cm.agents) {
      if (!a.active) continue;
      const dd = dist(px, pz, a.x, a.z);
      if (dd <= 8) { t += 0.05 * dt * (1 + (8 - dd) / 4); engaged = true; }
    }
    if (p.pose.stance === STANCE.sprint) t += 0.02 * dt;
    if (!p.pose.light && !spaceLit(rt, px, pz)) t += 0.01 * dt;
    if (!engaged) t -= decay * dt;
    d.tension[p.id] = Math.max(0, Math.min(1, t));
  }
}

function maxTension(d: DirectorSlice): number {
  let m = 0;
  for (const v of Object.values(d.tension)) m = Math.max(m, v);
  return m;
}

function chaseActive(rt: Rt): boolean {
  return rt.cm.agents.some((a) => a.active && CHASE.has(a.state) && a.state !== 'move');
}

function allowedEvents(rt: Rt, d: DirectorSlice): DirectorEventKind[] {
  if (d.phase === 'peak' || d.phase === 'fade') return [];
  const out: DirectorEventKind[] = ['flicker', 'radio_static', 'door_slam', 'quiet'];
  if (d.phase === 'relax') return out;
  const players = rt.alive();
  const hound = rt.cm.agents.find((a) => a.kind === 'hound' && a.active && a.state === 'idle') as HoundAgent | undefined;
  if (hound && players.every((p) => dist(p.pose.p[0], p.pose.p[2], hound.x, hound.z) > 25)) out.push('hound_relocate');
  const man = rt.cm.agents.find((a) => a.kind === 'mannequin') as MannequinAgent | undefined;
  if (man && man.spawned && man.active && !man.observed) out.push('mannequin_relocate');
  out.push('fixture_failure');
  return out;
}

function weightedPick(rt: Rt, allowed: DirectorEventKind[]): DirectorEventKind {
  const w = (bal(rt.ctx, 'director').weights ?? {}) as unknown as Record<string, number>;
  let sum = 0;
  for (const k of allowed) sum += Math.max(0, Number(w[k] ?? 1));
  let r = rt.cm.rng.next() * sum;
  for (const k of allowed) {
    r -= Math.max(0, Number(w[k] ?? 1));
    if (r <= 0) return k;
  }
  return allowed[allowed.length - 1];
}

function centroid(players: ServerPlayer[]): [number, number] {
  let x = 0, z = 0;
  for (const p of players) { x += p.pose.p[0]; z += p.pose.p[2]; }
  return players.length ? [x / players.length, z / players.length] : [0, 0];
}

/** runs one director event (also used by dbg.monsters.director) */
export function runDirectorEvent(rt: Rt, kind: DirectorEventKind, source = 'director'): boolean {
  const { ctx, crew, cm } = rt;
  const d = slice(crew);
  const players = rt.alive().filter((p) => !inCab(cm.layout, p.pose.p[0], p.pose.p[2]));
  const L = cm.layout;
  const pick = <T>(arr: T[]): T | undefined => arr[Math.floor(cm.rng.next() * arr.length)];
  let ok = false;
  switch (kind) {
    case 'flicker': {
      const p = pick(players);
      if (!p) break;
      const s = L.owner[cellOf(cm.grid, p.pose.p[0], p.pose.p[2])] ?? -1;
      if (s < 0) break;
      ctx.emit(crew, 'monsters.director', { kind, space: s, ms: 700 + Math.round(cm.rng.next() * 500) });
      ok = true;
      break;
    }
    case 'door_slam': {
      const [cx, cz] = centroid(players);
      const doors = L.doors.filter((q) => (q.kind === 'door' || q.kind === 'fire') && q.a >= 0 && q.b >= 0).filter((q) => {
        const [x, z] = doorCenter(q);
        const dd = dist(x, z, cx, cz);
        return dd >= 12 && dd <= 30 && players.every((p) => dist(p.pose.p[0], p.pose.p[2], x, z) > 6);
      });
      const door = pick(doors);
      if (!door) break;
      const [x, z] = doorCenter(door);
      if (cm.doorOpen(door.id)) extSetDoor(crew, door.id, false);
      ctx.emit(crew, 'monsters.director', { kind, p: [x, 1.2, z] });
      ok = true;
      break;
    }
    case 'radio_static': {
      const holders = players.filter((p) => hasWalkie(crew, p));
      const p = pick(holders);
      if (!p) break;
      ctx.emit(crew, 'monsters.director', { kind, to: [p.id], ms: 900 });
      ok = true;
      break;
    }
    case 'hound_relocate': {
      const h = cm.agents.find((a) => a.kind === 'hound' && a.active && a.state === 'idle') as HoundAgent | undefined;
      const near = players[0];
      if (!h || !near) break;
      for (let i = 0; i < 10; i++) {
        const c = randomReachable(cm, near.pose.p[0], near.pose.p[2], 15, 26, -1, monsterCanOpen(L));
        if (!c) continue;
        if (players.some((p) => dist(p.pose.p[0], p.pose.p[2], c[0], c[1]) < 12 || los(cm.grid, p.pose.p[0], p.pose.p[2], c[0], c[1], cm.doorOpen))) continue;
        h.x = c[0];
        h.z = c[1];
        h.path = null;
        ok = true;
        break;
      }
      if (ok) ctx.emit(crew, 'monsters.director', { kind });
      break;
    }
    case 'mannequin_relocate': {
      const m = cm.agents.find((a) => a.kind === 'mannequin') as MannequinAgent | undefined;
      if (m && relocateMannequin(rt, m)) {
        ctx.emit(crew, 'monsters.director', { kind });
        ok = true;
      }
      break;
    }
    case 'fixture_failure': {
      const p = pick(players);
      if (!p) break;
      const s = L.owner[cellOf(cm.grid, p.pose.p[0], p.pose.p[2])] ?? -1;
      const sp = L.spaces[s];
      if (!sp || sp.kind === 'outside' || sp.callsign === 'VAN') break;
      if (!spaceLit(rt, p.pose.p[0], p.pose.p[2])) break;
      const light = L.items.find((i) => i.kind === 'light' && i.space === s);
      extSetLights(crew, s, false);
      ctx.emit(crew, 'monsters.director', { kind, space: s, p: light ? [light.x, light.y ?? 2.9, light.z] : [p.pose.p[0], 2.9, p.pose.p[2]], ms: 900 });
      ok = true;
      break;
    }
    case 'quiet':
      ok = true;
      break;
  }
  if (ok) {
    d.lastEvent = kind;
    d.events.push({ t: Math.round(cm.time), kind, source });
    if (d.events.length > 50) d.events.shift();
  }
  return ok;
}

export function installDirector(ctx: ServerContext, rtFor: (crew: Crew) => Rt | null): void {
  const log = ctx.log('director');
  ctx.registerSystem({
    name: 'director',
    order: SYSTEM_ORDER.director,
    tick(dt, crew) {
      const rt = rtFor(crew);
      if (!rt || rt.cm.mode !== 'contract' || rt.cm.frozen) return;
      if (ctx.flags.director === false) return;
      const d = slice(crew);
      const b = bal(ctx, 'director');
      d.t += dt;
      d.phaseT += dt;
      updateTension(rt, d, dt);
      const mx = maxTension(d);
      const R = (lo: string, hi: string, dl: number, dh: number) => num(b, lo, dl) + rt.cm.rng.next() * (num(b, hi, dh) - num(b, lo, dl));
      switch (d.phase) {
        case 'build':
          if (mx >= num(b, 'peakAt', 0.8)) setPhase(d, 'peak', R('peakMinSec', 'peakMaxSec', 3, 5));
          break;
        case 'peak':
          if (d.phaseT >= d.phaseDur) setPhase(d, 'fade', 0);
          break;
        case 'fade':
          if (mx < num(b, 'fadeBelow', 0.45) && !chaseActive(rt)) setPhase(d, 'relax', R('relaxMinSec', 'relaxMaxSec', 30, 45));
          break;
        case 'relax':
          if (d.phaseT >= d.phaseDur) setPhase(d, 'build', 0);
          break;
      }
      if (d.t >= d.nextEventAt && !d.picking) {
        d.nextEventAt = d.t + R('eventMinSec', 'eventMaxSec', 20, 30);
        const allowed = allowedEvents(rt, d);
        if (!allowed.length) return;
        const picker = registry.picker;
        if (picker && ctx.flags.jev !== false) {
          d.picking = true;
          const state: DirectorPickState = { crew: crew.code, phase: d.phase, tension: mx, perPlayer: { ...d.tension }, t: Math.round(rt.cm.time), clockMin: Math.round(clockMin(rt)) };
          let done = false;
          const finish = (k: string | null, src: string) => {
            if (done) return;
            done = true;
            d.picking = false;
            const live = rtFor(crew);
            if (!live || live.cm !== rt.cm) return;
            const kind = (k && (allowed as string[]).includes(k) ? k : weightedPick(rt, allowed)) as DirectorEventKind;
            runDirectorEvent(live, kind, k ? src : 'weighted');
          };
          const timer = setTimeout(() => finish(null, 'timeout'), num(b, 'pickerTimeoutMs', 1000));
          Promise.resolve().then(() => picker(state, allowed)).then((k) => { clearTimeout(timer); finish(k, 'picker'); }, () => { clearTimeout(timer); finish(null, 'error'); });
        } else runDirectorEvent(rt, weightedPick(rt, allowed), 'weighted');
      }
    },
  });
  log.info('installed (tension model, build/peak/fade/relax, ambient events)');
}

export function directorState(crew: Crew): DirectorSlice | null {
  return (crew.slices.director as DirectorSlice | undefined) ?? null;
}

export function playersAlive(crew: Crew): ServerPlayer[] {
  return [...crew.players.values()].filter((p) => isAlive(crew, p));
}
