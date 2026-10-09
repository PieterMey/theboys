// Owner: env-paranormal (v1.3 F4 dead pokes, flag deadPokes). A dead player watching through the spectator camera can
// KNOCK 1-3 times on the closed door (or the wall) nearest the camera, or FLICKER the lights of the room they watch:
// "knock once if the Hound is in DOCK". Pure over ParaWorld (tests run it on simulated crews); index.ts sends the event
// (paranormal.event kind 'dead_poke', never naming the poker: the living cannot tell a friend from the building) and
// makes the knock's noise ('deadStatic', 4 m: the Hound hears it as STATIC). Per dead player: knock 8 s / flicker 20 s
// cooldowns and per-contract caps; a crew-wide gap between any two pokes. A poke never changes server light or door
// state, and only happens near a living teammate (the dead see what their follow camera shows, nothing else).
import { EDGE } from '@dead-air/shared/nav/index.ts';
import { makeRng } from '@dead-air/shared/rng.ts';
import type { Rng } from '@dead-air/shared/rng.ts';
import type { PokeKind, PokeRefusal } from '@dead-air/shared/messages/paranormal.ts';
import { dist2, doorCenter, doorNormal, fixturesBySpace, glowing, indoor, nearVan, spaceAtXZ } from './gates.ts';
import type { Built, ParaBalance, ParaPlayer, ParaWorld } from './types.ts';

export interface PokeSlot { knockAt: number; flickerAt: number; knocks: number; flickers: number }

export interface PokeState {
  /** the haunt key (layout hash + contract index) this state belongs to: a new contract starts fresh */
  key: string;
  rng: Rng;
  players: Map<string, PokeSlot>;
  /** server ms of the crew's last accepted poke (crew-wide gap) */
  lastAt: number;
  stats: { ok: number; knocks: number; flickers: number; refused: Partial<Record<PokeRefusal, number>> };
}

export function newPokeState(key: string): PokeState {
  return { key, rng: makeRng(key, 'dead-poke'), players: new Map(), lastAt: -Infinity, stats: { ok: 0, knocks: 0, flickers: 0, refused: {} } };
}

function slotOf(ps: PokeState, pid: string): PokeSlot {
  let s = ps.players.get(pid);
  if (!s) ps.players.set(pid, (s = { knockAt: -Infinity, flickerAt: -Infinity, knocks: 0, flickers: 0 }));
  return s;
}

/** ms until each kind is ready again for pid (0 = ready now) */
export function pokeCooldowns(ps: PokeState, b: ParaBalance, pid: string, now: number): { knockMs: number; flickerMs: number } {
  const s = ps.players.get(pid);
  if (!s) return { knockMs: 0, flickerMs: 0 };
  return {
    knockMs: Math.max(0, Math.ceil(s.knockAt + b.poke.knockCooldownSec * 1000 - now)),
    flickerMs: Math.max(0, Math.ceil(s.flickerAt + b.poke.flickerCooldownSec * 1000 - now)),
  };
}

export interface PokeOutcome {
  ok: boolean;
  reason?: PokeRefusal;
  /** accepted: the full cooldown of this kind; refused: ms until it would be accepted, when that is known */
  cooldownMs?: number;
  built?: Built;
  /** event seed (the poke rng, never the haunt's: a poke must not shift the haunt's seeded schedule) */
  seed?: number;
  /** the knock's noise for monsters (index.ts emits it as 'deadStatic' with no player source) */
  noise?: { x: number; z: number; radiusM: number };
}

const KNOCK_DOORS = new Set(['door', 'fire', 'security', 'locked']);
const r2 = (v: number): number => Math.round(v * 100) / 100;

export interface KnockSpot { x: number; z: number; space: number; door: number; pattern: 'wood' | 'metal' }

/**
 * Where a dead player's knock lands: the closed door of the camera's space within knockM (0.3 m beyond the leaf, on the
 * far side, like the haunt's knocks), else the camera space's wall within wallM (0.12 m in front of it), whichever is
 * nearer (doors win ties within 1.5 m). Never within hiddenM of a hidden player, never at the van. null = nothing near.
 */
export function knockSpot(w: ParaWorld, b: ParaBalance, cam: { x: number; z: number }, players: readonly ParaPlayer[]): KnockSpot | null {
  const L = w.layout;
  const g = w.grid;
  const pb = b.poke;
  const camSpace = spaceAtXZ(L, cam.x, cam.z);
  const own = camSpace >= 0 && indoor(L, camSpace) ? camSpace : -1;
  const blockedAt = (x: number, z: number): boolean => nearVan(L, x, z, 1) || players.some((p) => !!p.hidden && dist2(p.x, p.z, x, z) < pb.hiddenM);
  let door: KnockSpot | null = null, doorD = Infinity;
  for (const d of L.doors) {
    if (!KNOCK_DOORS.has(d.kind) || d.a < 0 || d.b < 0) continue;
    if (own >= 0 && d.a !== own && d.b !== own) continue;
    if (w.doorOpen(d.id) || !indoor(L, d.a) || !indoor(L, d.b)) continue;
    const [cx, cz] = doorCenter(d);
    const dd = dist2(cx, cz, cam.x, cam.z);
    if (dd > pb.knockM || dd >= doorD) continue;
    const [nx, nz] = doorNormal(d);
    const side = (cam.x - cx) * nx + (cam.z - cz) * nz >= 0 ? 1 : -1;
    const x = cx - nx * side * 0.3, z = cz - nz * side * 0.3;
    const far = spaceAtXZ(L, cx - nx * side * 0.6, cz - nz * side * 0.6);
    if (far < 0 || !indoor(L, far) || blockedAt(x, z)) continue;
    door = { x, z, space: far, door: d.id, pattern: d.kind === 'door' ? 'wood' : 'metal' };
    doorD = dd;
  }
  let wall: KnockSpot | null = null, wallD = Infinity;
  const R = Math.ceil(pb.wallM) + 1;
  const cx0 = Math.floor(cam.x), cz0 = Math.floor(cam.z);
  for (let cz = cz0 - R; cz <= cz0 + R; cz++) {
    for (let cx = cx0 - R; cx <= cx0 + R; cx++) {
      if (cx < 0 || cz < 0 || cx >= g.W || cz >= g.H) continue;
      const s = g.owner[cz * g.W + cx];
      if (s < 0 || (own >= 0 ? s !== own : !indoor(L, s))) continue;
      // the cell's four edges: code, edge midpoint, inward normal
      const edges: [number, number, number, number, number][] = [
        [g.v[cz * (g.W + 1) + cx], cx, cz + 0.5, 1, 0],
        [g.v[cz * (g.W + 1) + cx + 1], cx + 1, cz + 0.5, -1, 0],
        [g.h[cz * g.W + cx], cx + 0.5, cz, 0, 1],
        [g.h[(cz + 1) * g.W + cx], cx + 0.5, cz + 1, 0, -1],
      ];
      for (const [code, ex, ez, ix, iz] of edges) {
        if (code !== EDGE.wall) continue;
        const x = ex + ix * 0.12, z = ez + iz * 0.12;
        const dd = dist2(x, z, cam.x, cam.z);
        if (dd > pb.wallM || dd >= wallD || blockedAt(x, z)) continue;
        wall = { x, z, space: s, door: -1, pattern: 'wood' };
        wallD = dd;
      }
    }
  }
  if (door && (!wall || doorD <= wallD + 1.5)) return door;
  return wall ?? door;
}

export interface FlickerRoom { space: number; lights: string[]; x: number; z: number }

/** the lit room the camera is in (else the nearest living teammate's within nearLivingM) with at least one working light */
export function flickerRoom(w: ParaWorld, b: ParaBalance, cam: { x: number; z: number }, players: readonly ParaPlayer[], self: string): FlickerRoom | null {
  const L = w.layout;
  const cand: number[] = [];
  const s0 = spaceAtXZ(L, cam.x, cam.z);
  if (s0 >= 0) cand.push(s0);
  const near = players.filter((p) => p.alive && p.id !== self && dist2(p.x, p.z, cam.x, cam.z) <= b.poke.nearLivingM)
    .sort((p, q) => dist2(p.x, p.z, cam.x, cam.z) - dist2(q.x, q.z, cam.x, cam.z) || (p.id < q.id ? -1 : 1));
  for (const p of near) {
    const s = spaceAtXZ(L, p.x, p.z);
    if (s >= 0 && !cand.includes(s)) cand.push(s);
  }
  for (const s of cand) {
    if (!indoor(L, s) || !w.lightsOn(s)) continue;
    const fx = (fixturesBySpace(L).get(s) ?? []).filter(glowing);
    if (!fx.length) continue;
    let x = 0, z = 0;
    for (const f of fx) { x += f.x; z += f.z; }
    return { space: s, lights: fx.map((f) => f.id), x: x / fx.length, z: z / fx.length };
  }
  return null;
}

function refuse(ps: PokeState, reason: PokeRefusal, cooldownMs?: number): PokeOutcome {
  ps.stats.refused[reason] = (ps.stats.refused[reason] ?? 0) + 1;
  return cooldownMs !== undefined ? { ok: false, reason, cooldownMs } : { ok: false, reason };
}

/**
 * One poke request from pid at server time `now`. Order of the checks: only the dead, the kind's cooldown, its
 * per-contract cap, the crew-wide gap, a living teammate within nearLivingM of the camera, then the placement. An
 * accepted poke starts its cooldown; a refused one changes nothing.
 */
export function pokeOnce(ps: PokeState, w: ParaWorld, b: ParaBalance, pid: string, kind: PokeKind, count: number, now: number): PokeOutcome {
  const pb = b.poke;
  const players = w.players();
  const me = players.find((p) => p.id === pid);
  if (!me) return refuse(ps, 'phase');
  if (me.alive) return refuse(ps, 'alive');
  const cd = pokeCooldowns(ps, b, pid, now);
  const left = kind === 'knock' ? cd.knockMs : cd.flickerMs;
  if (left > 0) return refuse(ps, 'cooldown', left);
  const slot = slotOf(ps, pid);
  if (kind === 'knock' ? slot.knocks >= pb.knockMax : slot.flickers >= pb.flickerMax) return refuse(ps, 'budget');
  const gap = ps.lastAt + pb.crewGapMs - now;
  if (gap > 0) return refuse(ps, 'busy', Math.ceil(gap));
  // a dead player's pose is their spectator camera, which follows a living teammate
  const cam = { x: me.x, z: me.z };
  if (!players.some((p) => p.alive && p.id !== pid && dist2(p.x, p.z, cam.x, cam.z) <= pb.nearLivingM)) return refuse(ps, 'far');
  if (kind === 'knock') {
    const spot = knockSpot(w, b, cam, players);
    if (!spot) return refuse(ps, 'nothing');
    const n = Math.max(1, Math.min(Math.max(1, Math.round(pb.maxCount)), Math.round(Number.isFinite(count) ? count : 1) || 1));
    slot.knockAt = now;
    slot.knocks++;
    ps.lastAt = now;
    ps.stats.ok++;
    ps.stats.knocks++;
    return {
      ok: true, cooldownMs: Math.round(pb.knockCooldownSec * 1000), seed: ps.rng.int(1, 0x7fffffff),
      built: {
        kind: 'dead_poke', tier: 0, target: null,
        ev: {
          ms: 260 * n + 900, space: spot.space, p: [r2(spot.x), 1.15, r2(spot.z)], yaw: 0, ...(spot.door >= 0 ? { ref: `door:${spot.door}` } : {}),
          data: { poke: 'knock', door: spot.door, pattern: spot.pattern, count: n, amp: pb.amp },
        },
      },
      noise: { x: spot.x, z: spot.z, radiusM: pb.noiseM },
    };
  }
  const room = flickerRoom(w, b, cam, players, pid);
  if (!room) return refuse(ps, 'dark');
  slot.flickerAt = now;
  slot.flickers++;
  ps.lastAt = now;
  ps.stats.ok++;
  ps.stats.flickers++;
  return {
    ok: true, cooldownMs: Math.round(pb.flickerCooldownSec * 1000), seed: ps.rng.int(1, 0x7fffffff),
    built: {
      kind: 'dead_poke', tier: 0, target: null,
      ev: { ms: Math.round(pb.flickerMs), space: room.space, p: [r2(room.x), 2.6, r2(room.z)], data: { poke: 'flicker', lights: room.lights, curve: 'pulse' } },
    },
  };
}
