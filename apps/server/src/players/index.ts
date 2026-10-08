// Owner: track ⑤ Players (apps/server/src/players/**); v1.2 footsteps + stealth stance: players-stealth.
// Server plugin entry; see apps/server/src/core/types.ts.
// - spawn poses (hooks.join / layout change) + a short spawn lock that rejects stale client poses
// - footstep noise from pose deltas -> noise bus (./noise.ts, also ctx.noise) for monsters/director. v1.2 (flag
//   stealthV12): speed from a >= 0.5 s seq window (./stealth.ts), a crouch claim needs a creep speed, sprint speed is
//   always a sprint step, hidden only in a real hiding spot, no steps while grabbed, radius = stepNoiseRadius(kind,
//   floorSurface, overshoes); recordStat stepsCrept/Walked/Sprinted per step; stealthStance(crew, pid) for monsters
// - requests: players.emote, players.ping (LOS-filtered), players.chat (proximity text, talk-band path distance)
// - crawl vents (flag crawlVents): ./vents.ts
// - dev: dbg.players.testLevel, dbg.players.kill, dbg.players.noise, dbg.players.pose, dbg.players.stealth,
//   dbg.players.surfaces
import type { Crew, ServerContext, ServerPlayer } from '../core/types.ts';
import { SYSTEM_ORDER } from '../core/types.ts';
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import type { Vec3 } from '@dead-air/shared/state.ts';
import { STANCE } from '@dead-air/shared/state.ts';
import { ANIM } from '@dead-air/shared/anim.ts';
import { BAND, BAND_RADIUS_M, NOISE_M } from '@dead-air/shared/constants.ts';
import type { EmoteKind, StepKind } from '@dead-air/shared/messages/players.ts';
import { EMOTE_KINDS, stepNoiseRadius } from '@dead-air/shared/messages/players.ts';
import { floorSurface } from '@dead-air/shared/procgen/themes.ts';
import { buildEdgeGrid, initialDoorOpen, soundFlood, fieldAt, los } from '@dead-air/shared/nav/index.ts';
import type { DoorOpenFn, EdgeGrid } from '@dead-air/shared/nav/index.ts';
import * as IX from '../interaction/api.ts';
import { isGrabbed } from '../monsters/api.ts';
import { recordStat } from '../meta/api.ts';
import { bindStealthStance } from './api.ts';
import { emitNoise, emitProxText, noiseBus, recentNoises, setNoiseClock } from './noise.ts';
import { DEFAULT_TRACK_OPTS, feedPose, judgeStance, newTrack, resetTrack, speedAt, sprintProbeAt, stepKindOf } from './stealth.ts';
import type { StealthTrack, TrackOpts } from './stealth.ts';
import { installVents } from './vents.ts';

export { onNoise, emitNoise, onProxText } from './noise.ts';
export type { NoiseEvent, NoiseKind, NoiseListener, NoiseBus, ProxTextEvent } from './noise.ts';
export { stealthStance } from './api.ts';

interface PlayerSlice {
  /** last position used for footstep accumulation */
  last: Vec3 | null;
  lastSeq: number;
  lastAt: number;
  speed: number;
  stride: number;
  spawn: Vec3 | null;
  spawnLockUntil: number;
  lastEmoteAt: number;
  lastPingAt: number;
  lastChatAt: number;
  /** v1.2: seq-window speed tracker */
  track: StealthTrack;
  /** dev/test: floor surface override (a stub until env-layout's themed floors exist) */
  surfaceOverride: string | null;
}

interface CrewSlice {
  layoutHash: string | null;
  /** dev/test: per-crew flag overrides (dbg.players.stealth) */
  v12: boolean | null;
  vents: boolean | null;
}

const STEP_STAT: Record<StepKind, string> = { crouchStep: 'stepsCrept', walkStep: 'stepsWalked', sprintStep: 'stepsSprinted' };

const EMOTE_ANIM: Record<EmoteKind, number> = {
  wave: ANIM.emoteWave,
  point: ANIM.emotePoint,
  beckon: ANIM.emoteBeckon,
  thumbs: ANIM.emoteThumbs,
};

const grids = new WeakMap<LevelLayout, EdgeGrid>();
const initialDoors = new WeakMap<LevelLayout, DoorOpenFn>();

export function gridFor(layout: LevelLayout | null): EdgeGrid | null {
  if (!layout) return null;
  let g = grids.get(layout);
  if (!g) {
    try {
      g = buildEdgeGrid(layout);
      grids.set(layout, g);
    } catch {
      return null;
    }
  }
  return g;
}

/** Door state for a crew: prefers a live callback published by the level/interaction tracks, else generation state. */
export function doorOpenFor(crew: Crew): DoorOpenFn {
  for (const k of ['level', 'interaction']) {
    const s = crew.slices[k] as { doorOpen?: unknown } | undefined;
    if (s && typeof s.doorOpen === 'function') return s.doorOpen as DoorOpenFn;
  }
  const L = crew.layout;
  if (!L) return () => true;
  let f = initialDoors.get(L);
  if (!f) initialDoors.set(L, (f = initialDoorOpen(L)));
  return f;
}

function num(v: unknown, d: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

export function install(ctx: ServerContext): void {
  const log = ctx.log('players');
  ctx.noise = noiseBus;
  setNoiseClock(() => ctx.now());
  const bal = (): Record<string, unknown> => (ctx.balance.players as Record<string, unknown> | undefined) ?? {};

  const slice = (p: ServerPlayer): PlayerSlice => {
    let s = p.slices.players as PlayerSlice | undefined;
    if (!s) {
      s = {
        last: null, lastSeq: -1, lastAt: 0, speed: 0, stride: 0, spawn: null, spawnLockUntil: 0, lastEmoteAt: 0, lastPingAt: 0, lastChatAt: 0,
        track: newTrack(), surfaceOverride: null,
      };
      p.slices.players = s;
    }
    return s;
  };
  const crewSlice = (c: Crew): CrewSlice => {
    let s = c.slices.players as CrewSlice | undefined;
    if (!s) c.slices.players = s = { layoutHash: null, v12: null, vents: null };
    return s;
  };
  /** flag stealthV12 (a dev override per crew wins) */
  const v12 = (c: Crew): boolean => crewSlice(c).v12 ?? ctx.flags.stealthV12 !== false;
  const trackOpts = (): TrackOpts => {
    const b = bal();
    return {
      ...DEFAULT_TRACK_OPTS,
      windowSec: Math.max(0.5, num(b.stealthWindowSec, 0.5)),
      sprintWindowSec: Math.max(0.1, Math.min(0.5, num(b.stealthSprintWindowSec, 0.2))),
      rateWindowSec: Math.max(1, num(b.stealthRateWindowSec, 3)),
      jitterSec: Math.max(0, Math.min(0.3, num(b.stealthJitterSec, 0.1))),
      crouchMaxSpeed: num(b.crouchMaxSpeed, 3),
    };
  };
  /** floor under a position: floorSurface of the owning space (dev override first) */
  const surfaceAt = (crew: Crew, s: PlayerSlice, x: number, z: number): string => {
    if (s.surfaceOverride) return s.surfaceOverride;
    const L = crew.layout;
    if (!L) return 'concrete';
    const cx = Math.floor(x), cz = Math.floor(z);
    const sp = cx >= 0 && cz >= 0 && cx < L.W && cz < L.H ? L.owner[cz * L.W + cx] : -1;
    if (sp < 0) return 'concrete';
    try { return floorSurface(L, sp); } catch { return 'concrete'; }
  };
  const safeBool = (f: () => boolean, d: boolean): boolean => {
    try { return f(); } catch { return d; }
  };
  const holdsSoles = (crew: Crew, pid: string) => safeBool(() => IX.holding(crew, pid, 'soles'), false);
  /** dev/test only (dbg.players.stealth fakeGrab): stands in for a monster grab until the monsters package binds isGrabbed */
  const fakeGrabbed = new Set<string>();
  const grabbedNow = (crew: Crew, pid: string) => fakeGrabbed.has(pid) || safeBool(() => isGrabbed(crew, pid) !== null, false);

  /** v1.2 stance for stealth (bound into players/api.ts stealthStance for the monsters package) */
  const stealthStanceOf = (crew: Crew, pid: string): number => {
    const pl = crew.players.get(pid);
    if (!pl) return STANCE.stand;
    if (!v12(crew)) return pl.pose.stance;
    const s = slice(pl);
    const b = bal();
    const alive = safeBool(() => IX.isAlive(crew, pid), pl.alive);
    const hidden = safeBool(() => IX.isHidden(crew, pid), false);
    const now = performance.now();
    return judgeStance(pl.pose.stance, speedAt(s.track, now), s.track.overSec, alive, hidden, {
      crouchOverSpeedSec: num(b.crouchOverSpeedSec, 0.5), sprintSpeed: num(b.noiseSprintSpeed, 4.3),
    }, sprintProbeAt(s.track, now));
  };
  bindStealthStance(stealthStanceOf);

  /** spawn point for the n-th player (join order) in the crew's layout */
  const spawnPoint = (crew: Crew, player: ServerPlayer): { p: Vec3; yaw: number } => {
    const order = [...crew.players.values()].sort((a, b) => a.joinedAt - b.joinedAt);
    const idx = Math.max(0, order.indexOf(player));
    const L = crew.layout;
    const spawns = (L?.items ?? []).filter((i) => i.kind === 'spawn_player')
      .sort((a, b) => num(a.data?.idx, 0) - num(b.data?.idx, 0));
    if (spawns.length) {
      const s = spawns[idx % spawns.length];
      return { p: [s.x, 0, s.z], yaw: s.rot ?? 0 };
    }
    // no layout yet: a little line around the origin (client falls back to flat ground)
    return { p: [(idx % 3) * 1.2 - 1.2, 0, Math.floor(idx / 3) * 1.2], yaw: 0 };
  };

  const placeAtSpawn = (crew: Crew, player: ServerPlayer) => {
    const sp = spawnPoint(crew, player);
    const s = slice(player);
    player.pose = { ...player.pose, p: sp.p, yaw: sp.yaw, pitch: 0, stance: STANCE.stand, anim: ANIM.idle };
    s.spawn = sp.p;
    s.spawnLockUntil = performance.now() + num(bal().spawnLockMs, 2500);
    s.last = null;
    s.stride = 0;
    resetTrack(s.track);
  };

  ctx.hooks.join.push((crew, player, info) => {
    const s = slice(player);
    const atOrigin = player.poseAt === 0 && player.pose.p[0] === 0 && player.pose.p[2] === 0;
    if (!info.resumed || atOrigin) placeAtSpawn(crew, player);
    else s.spawnLockUntil = 0;
    crewSlice(crew).layoutHash = crew.layout?.hash ?? null;
  });

  ctx.hooks.phase.push((crew) => {
    const cs = crewSlice(crew);
    const hash = crew.layout?.hash ?? null;
    if (hash === cs.layoutHash) return;
    cs.layoutHash = hash;
    for (const p of crew.players.values()) placeAtSpawn(crew, p);
  });

  ctx.hooks.pose.push((_crew, player, pose) => {
    const s = slice(player);
    if (s.spawnLockUntil && s.spawn) {
      if (performance.now() < s.spawnLockUntil) {
        const dx = pose.p[0] - s.spawn[0], dz = pose.p[2] - s.spawn[2];
        if (dx * dx + dz * dz > 9) return false; // stale pose from before the respawn
      }
      s.spawnLockUntil = 0;
    }
    pose.p[1] = Math.max(-2, Math.min(12, pose.p[1]));
    if (pose.pitch > 1.6) pose.pitch = 1.6;
    if (pose.pitch < -1.6) pose.pitch = -1.6;
    return true;
  });

  // ---- footstep noise from pose deltas ----
  const strideOf = (b: Record<string, unknown>, kind: StepKind): number =>
    kind === 'crouchStep' ? num(b.strideCrouch, 0.6) : kind === 'sprintStep' ? num(b.strideSprint, 1.15) : num(b.strideWalk, 0.78);
  const stat = (crew: Crew, pid: string, kind: StepKind) => {
    try { recordStat(crew, pid, STEP_STAT[kind], 1); } catch { /* meta not ready */ }
  };

  /** v1.1 footsteps (flag stealthV12 off): arrival-time EMA speed, the claimed stance, flat NOISE_M radii */
  const tickV11 = (crew: Crew, pl: ServerPlayer, s: PlayerSlice, b: Record<string, unknown>) => {
    const minSpeed = num(b.noiseMinSpeed, 0.6);
    const sprintSpeed = num(b.noiseSprintSpeed, 4.3);
    const pose = pl.pose;
    const prev = s.last;
    const prevAt = s.lastAt;
    s.last = [pose.p[0], pose.p[1], pose.p[2]];
    s.lastAt = pl.poseAt;
    if (!prev || !pl.alive || pose.stance === STANCE.dead || pose.stance === STANCE.hidden) {
      s.speed = 0;
      return;
    }
    const dx = pose.p[0] - prev[0], dz = pose.p[2] - prev[2];
    const d = Math.hypot(dx, dz);
    const dtS = Math.max(0.02, (pl.poseAt - prevAt) / 1000);
    if (d > 3) return; // teleport / respawn
    const inst = d / dtS;
    s.speed = s.speed * 0.5 + inst * 0.5;
    if (s.speed < minSpeed) {
      s.stride = Math.min(s.stride, 0.3);
      return;
    }
    const crouch = pose.stance === STANCE.crouch;
    const sprint = !crouch && (pose.stance === STANCE.sprint || s.speed > sprintSpeed);
    const kind: StepKind = crouch ? 'crouchStep' : sprint ? 'sprintStep' : 'walkStep';
    const strideLen = strideOf(b, kind);
    s.stride += d;
    if (s.stride >= strideLen) {
      s.stride -= strideLen;
      if (s.stride > strideLen) s.stride = 0;
      emitNoise(crew, { x: pose.p[0], z: pose.p[2], radiusM: NOISE_M[kind], kind, source: pl.id });
      stat(crew, pl.id, kind);
    }
  };

  /**
   * v1.2 honest footsteps (flag stealthV12). The track (./stealth.ts) measures speed over a >= 0.5 s seq window;
   * the kind comes from the judged stance (a crouch claim above crouchMaxSpeed for crouchOverSpeedSec walks, above
   * noiseSprintSpeed always sprints, a claimed hidden stance only counts inside a real hiding spot), no steps while dead,
   * hidden or grabbed, and the radius follows the floor and overshoes.
   */
  const tickV12 = (crew: Crew, pl: ServerPlayer, s: PlayerSlice, b: Record<string, unknown>) => {
    const pose = pl.pose;
    s.last = [pose.p[0], pose.p[1], pose.p[2]];
    s.lastAt = pl.poseAt;
    const mv = feedPose(s.track, pose.seq, pl.poseAt, pose.p[0], pose.p[2], trackOpts());
    if (!mv) {
      s.stride = 0;
      return;
    }
    const alive = safeBool(() => IX.isAlive(crew, pl.id), pl.alive);
    const hidden = safeBool(() => IX.isHidden(crew, pl.id), false);
    if (!alive || hidden || grabbedNow(crew, pl.id)) {
      s.stride = 0;
      return;
    }
    const speed = s.track.speed;
    if (speed < num(b.noiseMinSpeed, 0.6)) {
      s.stride = Math.min(s.stride, 0.3);
      return;
    }
    const stance = judgeStance(pose.stance, speed, s.track.overSec, alive, hidden, {
      crouchOverSpeedSec: num(b.crouchOverSpeedSec, 0.5), sprintSpeed: num(b.noiseSprintSpeed, 4.3),
    }, Math.max(speed, s.track.fastSpeed));
    const kind = stepKindOf(stance);
    if (!kind || mv.d < 1e-3) return; // standing still never completes a stride (a shorter stride kind would)
    const strideLen = strideOf(b, kind);
    s.stride += mv.d;
    if (s.stride < strideLen) return;
    s.stride -= strideLen;
    if (s.stride > strideLen) s.stride = 0;
    const surface = surfaceAt(crew, s, pose.p[0], pose.p[2]);
    const radiusM = stepNoiseRadius(kind, surface, holdsSoles(crew, pl.id), b);
    emitNoise(crew, { x: pose.p[0], z: pose.p[2], radiusM, kind, source: pl.id });
    stat(crew, pl.id, kind);
  };

  ctx.registerSystem({
    name: 'players.noise',
    order: SYSTEM_ORDER.players,
    tick(_dt, crew) {
      const b = bal();
      const on = v12(crew);
      for (const pl of crew.players.values()) {
        if (!pl.connected) continue;
        const s = slice(pl);
        if (pl.pose.seq === s.lastSeq) continue;
        s.lastSeq = pl.pose.seq;
        if (on) tickV12(crew, pl, s, b);
        else tickV11(crew, pl, s, b);
      }
    },
  });

  // ---- emotes ----
  ctx.registerReq('players.emote', (crew, player, args) => {
    if (ctx.flags.emotes === false) return { ok: false };
    const kind = (args as { kind?: unknown } | null)?.kind;
    if (typeof kind !== 'string' || !(EMOTE_KINDS as readonly string[]).includes(kind)) return { ok: false };
    const s = slice(player);
    const now = performance.now();
    if (now - s.lastEmoteAt < 400) return { ok: false };
    s.lastEmoteAt = now;
    ctx.emit(crew, 'players.emote', { id: player.id, kind: kind as EmoteKind, anim: EMOTE_ANIM[kind as EmoteKind] });
    return { ok: true };
  });

  // ---- silent ping: LOS-filtered ----
  ctx.registerReq('players.ping', (crew, player, args) => {
    const p = (args as { p?: unknown } | null)?.p;
    if (!Array.isArray(p) || p.length < 3 || !p.every((v) => typeof v === 'number' && Number.isFinite(v))) return { ok: false, seenBy: 0 };
    const s = slice(player);
    const now = performance.now();
    if (now - s.lastPingAt < 350) return { ok: false, seenBy: 0 };
    s.lastPingAt = now;
    const pt: Vec3 = [p[0] as number, p[1] as number, p[2] as number];
    const range = num(bal().pingRange, 40);
    const g = gridFor(crew.layout);
    const doorOpen = doorOpenFor(crew);
    const to: string[] = [player.id];
    for (const other of crew.players.values()) {
      if (other === player || !other.connected || !other.alive) continue;
      const op = other.pose.p;
      const dist = Math.hypot(op[0] - pt[0], op[2] - pt[2]);
      if (dist > range) continue;
      if (g && !los(g, op[0], op[2], pt[0], pt[2], doorOpen)) continue;
      to.push(other.id);
    }
    ctx.emit(crew, 'players.ping', { id: player.id, name: player.name, p: pt }, { to });
    return { ok: true, seenBy: to.length - 1 };
  });

  // ---- proximity text ----
  ctx.registerReq('players.chat', (crew, player, args) => {
    if (ctx.flags.proxText === false) return { ok: false, heardBy: 0 };
    const raw = (args as { text?: unknown } | null)?.text;
    if (typeof raw !== 'string') return { ok: false, heardBy: 0 };
    const maxLen = num(bal().chatMaxLen, 140);
    const text = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLen);
    if (!text) return { ok: false, heardBy: 0 };
    const s = slice(player);
    const now = performance.now();
    if (now - s.lastChatAt < 250) return { ok: false, heardBy: 0 };
    s.lastChatAt = now;
    const voiceBal = (ctx.balance.voice as Record<string, unknown> | undefined) ?? {};
    const radii = Array.isArray(voiceBal.bandRadiusM) ? (voiceBal.bandRadiusM as number[]) : null;
    const radius = num(radii?.[BAND.talk], BAND_RADIUS_M[BAND.talk]);
    const [sx, , sz] = player.pose.p;
    const g = gridFor(crew.layout);
    const field = g ? soundFlood(g, sx, sz, radius + 2, doorOpenFor(crew)) : null;
    const heardBy: string[] = [];
    for (const other of crew.players.values()) {
      if (!other.connected) continue;
      let dist = 0;
      if (other !== player) {
        const [ox, , oz] = other.pose.p;
        dist = g && field ? fieldAt(g, field, ox, oz) : Math.hypot(ox - sx, oz - sz);
        if (!(dist <= radius)) continue;
        heardBy.push(other.id);
      }
      ctx.emit(crew, 'players.chat', { id: player.id, name: player.name, text, dist: Math.round(dist * 10) / 10 }, { to: [other.id] });
    }
    emitProxText(crew, { player, text, x: sx, z: sz, radiusM: radius, heardBy, t: ctx.now() });
    return { ok: true, heardBy: heardBy.length };
  });

  // ---- dev helpers (NODE_ENV=development only) ----
  ctx.registerDbg('players.testLevel', async (crew, _player, args) => {
    const a = (args ?? {}) as { seed?: string; players?: number; risk?: number; hub?: boolean; phase?: 'hub' | 'contract' };
    const gen = await import('@dead-air/shared/procgen/index.ts');
    const layout = a.hub ? gen.generateHub() : gen.generateFacility({ seed: a.seed ?? 'players-test', players: a.players ?? 2, risk: a.risk ?? 1 });
    ctx.setPhase(crew, a.phase ?? (a.hub ? 'hub' : 'contract'), layout);
    return { seed: layout.seed, hash: layout.hash, W: layout.W, H: layout.H };
  });
  ctx.registerDbg('players.kill', (crew, player, args) => {
    const a = (args ?? {}) as { id?: string; alive?: boolean };
    const target = a.id ? crew.players.get(a.id) : player;
    if (!target) return { ok: false };
    target.alive = a.alive ?? false;
    ctx.crews.broadcastRoster(crew);
    return { ok: true, id: target.id, alive: target.alive };
  });
  ctx.registerDbg('players.noise', (crew) => recentNoises(crew).slice(-32));
  ctx.registerDbg('players.pose', (crew, player, args) => {
    const id = (args as { id?: string } | null)?.id;
    const p = id ? crew.players.get(id) : player;
    return p ? { id: p.id, pose: p.pose, alive: p.alive } : null;
  });
  /**
   * v1.2 stealth probe + test switches: { id?, v12?: boolean | null (per-crew stealthV12 override, null = the flag),
   * vents?: boolean | null (crawlVents override), surface?: string | null (floor override for this player) }
   */
  ctx.registerDbg('players.stealth', (crew, player, args) => {
    const a = (args ?? {}) as { id?: string; v12?: boolean | null; vents?: boolean | null; surface?: string | null; fakeGrab?: boolean };
    const cs = crewSlice(crew);
    if (a.v12 !== undefined) cs.v12 = typeof a.v12 === 'boolean' ? a.v12 : null;
    if (a.vents !== undefined) cs.vents = typeof a.vents === 'boolean' ? a.vents : null;
    const target = a.id ? crew.players.get(a.id) : player;
    if (!target) return null;
    const s = slice(target);
    if (a.surface !== undefined) s.surfaceOverride = typeof a.surface === 'string' && a.surface ? a.surface : null;
    if (a.fakeGrab !== undefined) {
      if (a.fakeGrab) fakeGrabbed.add(target.id);
      else fakeGrabbed.delete(target.id);
    }
    return {
      id: target.id, v12: v12(crew), vents: cs.vents ?? ctx.flags.crawlVents !== false,
      claim: target.pose.stance, stance: stealthStanceOf(crew, target.id),
      speed: Math.round(s.track.speed * 1000) / 1000, fastSpeed: Math.round(s.track.fastSpeed * 1000) / 1000, overSec: Math.round(s.track.overSec * 1000) / 1000,
      windowDt: Math.round(s.track.windowDt * 1000) / 1000, arrivalOnly: s.track.arrivalOnly, samples: s.track.samples.length,
      surface: surfaceAt(crew, s, target.pose.p[0], target.pose.p[2]), soles: holdsSoles(crew, target.id),
      hidden: safeBool(() => IX.isHidden(crew, target.id), false), alive: safeBool(() => IX.isAlive(crew, target.id), target.alive),
      grabbed: grabbedNow(crew, target.id),
    };
  });
  /** floor surfaces of the current layout: one walkable cell centre per space (tests stand on each floor) */
  ctx.registerDbg('players.surfaces', (crew) => {
    const L = crew.layout;
    if (!L) return [];
    const g = gridFor(L);
    const out: { space: number; kind: string; type: string; surface: string; x: number; z: number }[] = [];
    for (const sp of L.spaces) {
      const r = sp.rect;
      let best: { x: number; z: number; d: number } | null = null;
      const cx0 = r.x + r.w / 2, cz0 = r.y + r.h / 2;
      for (let z = r.y; z < r.y + r.h; z++) {
        for (let x = r.x; x < r.x + r.w; x++) {
          if (x < 0 || z < 0 || x >= L.W || z >= L.H || L.owner[z * L.W + x] !== sp.id) continue;
          if (g && g.solidStart[z * g.W + x] !== g.solidStart[z * g.W + x + 1]) continue; // a prop stands here
          const d = Math.hypot(x + 0.5 - cx0, z + 0.5 - cz0);
          if (!best || d < best.d) best = { x: x + 0.5, z: z + 0.5, d };
        }
      }
      if (!best) continue;
      let surface = 'concrete';
      try { surface = floorSurface(L, sp.id); } catch { /* env-layout mid-edit */ }
      out.push({ space: sp.id, kind: sp.kind, type: sp.type, surface, x: best.x, z: best.z });
    }
    return out;
  });

  /** two free, walkable cell centres 1 m apart with a solid wall between them (wall-clip tests) */
  ctx.registerDbg('players.wallProbe', (crew) => {
    const L = crew.layout;
    const g = gridFor(L);
    if (!L || !g) return null;
    const free = (c: number) => g.owner[c] >= 0 && g.solidStart[c] === g.solidStart[c + 1] && !g.spaces[g.owner[c]]?.open;
    for (let cz = 1; cz < g.H - 1; cz++) {
      for (let cx = 1; cx < g.W - 2; cx++) {
        const a = cz * g.W + cx;
        if (!free(a) || !free(a + 1)) continue;
        if (g.v[cz * (g.W + 1) + cx + 1] !== 1) continue; // EDGE.wall between (cx, cz) and (cx + 1, cz)
        return { a: [cx + 0.5, cz + 0.5], b: [cx + 1.5, cz + 0.5], spaces: [g.owner[a], g.owner[a + 1]] };
      }
    }
    return null;
  });

  // ---- v1.2 crawl vents (flag crawlVents; stretch) ----
  installVents(ctx, { ventsOn: (c) => crewSlice(c).vents ?? ctx.flags.crawlVents !== false, bal });

  log.info('installed (noise bus, spawns, emotes, pings, proximity text, v1.2 stealth footsteps)');
}
