// Owner: track ⑤ Players (apps/server/src/players/**). Server plugin entry; see apps/server/src/core/types.ts.
// - spawn poses (hooks.join / layout change) + a short spawn lock that rejects stale client poses
// - footstep noise from pose deltas -> noise bus (./noise.ts, also ctx.noise) for monsters/director
// - requests: players.emote, players.ping (LOS-filtered), players.chat (proximity text, talk-band path distance)
// - dev: dbg.players.testLevel, dbg.players.kill, dbg.players.noise, dbg.players.pose
import type { Crew, ServerContext, ServerPlayer } from '../core/types.ts';
import { SYSTEM_ORDER } from '../core/types.ts';
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import type { Vec3 } from '@dead-air/shared/state.ts';
import { STANCE } from '@dead-air/shared/state.ts';
import { ANIM } from '@dead-air/shared/anim.ts';
import { BAND, BAND_RADIUS_M, NOISE_M } from '@dead-air/shared/constants.ts';
import type { EmoteKind } from '@dead-air/shared/messages/players.ts';
import { EMOTE_KINDS } from '@dead-air/shared/messages/players.ts';
import { buildEdgeGrid, initialDoorOpen, soundFlood, fieldAt, los } from '@dead-air/shared/nav/index.ts';
import type { DoorOpenFn, EdgeGrid } from '@dead-air/shared/nav/index.ts';
import { emitNoise, emitProxText, noiseBus, recentNoises, setNoiseClock } from './noise.ts';

export { onNoise, emitNoise, onProxText } from './noise.ts';
export type { NoiseEvent, NoiseKind, NoiseListener, NoiseBus, ProxTextEvent } from './noise.ts';

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
}

interface CrewSlice {
  layoutHash: string | null;
}

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
      s = { last: null, lastSeq: -1, lastAt: 0, speed: 0, stride: 0, spawn: null, spawnLockUntil: 0, lastEmoteAt: 0, lastPingAt: 0, lastChatAt: 0 };
      p.slices.players = s;
    }
    return s;
  };
  const crewSlice = (c: Crew): CrewSlice => {
    let s = c.slices.players as CrewSlice | undefined;
    if (!s) c.slices.players = s = { layoutHash: null };
    return s;
  };

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
  ctx.registerSystem({
    name: 'players.noise',
    order: SYSTEM_ORDER.players,
    tick(_dt, crew) {
      const b = bal();
      const minSpeed = num(b.noiseMinSpeed, 0.6);
      const sprintSpeed = num(b.noiseSprintSpeed, 4.3);
      for (const pl of crew.players.values()) {
        if (!pl.connected) continue;
        const s = slice(pl);
        const pose = pl.pose;
        if (pose.seq === s.lastSeq) continue;
        const prev = s.last;
        const prevAt = s.lastAt;
        s.lastSeq = pose.seq;
        s.last = [pose.p[0], pose.p[1], pose.p[2]];
        s.lastAt = pl.poseAt;
        if (!prev || !pl.alive || pose.stance === STANCE.dead || pose.stance === STANCE.hidden) {
          s.speed = 0;
          continue;
        }
        const dx = pose.p[0] - prev[0], dz = pose.p[2] - prev[2];
        const d = Math.hypot(dx, dz);
        const dtS = Math.max(0.02, (pl.poseAt - prevAt) / 1000);
        if (d > 3) continue; // teleport / respawn
        const inst = d / dtS;
        s.speed = s.speed * 0.5 + inst * 0.5;
        if (s.speed < minSpeed) {
          s.stride = Math.min(s.stride, 0.3);
          continue;
        }
        const crouch = pose.stance === STANCE.crouch;
        const sprint = !crouch && (pose.stance === STANCE.sprint || s.speed > sprintSpeed);
        const strideLen = crouch ? num(b.strideCrouch, 0.6) : sprint ? num(b.strideSprint, 1.15) : num(b.strideWalk, 0.78);
        s.stride += d;
        if (s.stride >= strideLen) {
          s.stride -= strideLen;
          if (s.stride > strideLen) s.stride = 0;
          const kind = crouch ? 'crouchStep' : sprint ? 'sprintStep' : 'walkStep';
          emitNoise(crew, { x: pose.p[0], z: pose.p[2], radiusM: NOISE_M[kind], kind, source: pl.id });
        }
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

  log.info('installed (noise bus, spawns, emotes, pings, proximity text)');
}
