// Owner: track ① Net. Server-side pose validation (hooks.pose). Clients own their movement; the server
// - clamps speed with a token bucket: refill MOVE.sprint * speedMult per second, cap = refill * moveSlackSec + moveSlackM
//   (tolerates TCP bunching of a few poses), so a jump of more than ~5 m is a rejected teleport;
// - rejects straight-line moves through walls / rubble / fences (②'s walkClear; closed doors only if
//   balance.net.validateClosedDoors) and moves out of the grid;
// - sends 'net.correct' (rate-limited) with the last accepted position to that player only;
// - never validates the dead (their pose is the spectator camera);
// - v1.2 (players-stealth, plan check #7): a LIVING player (interaction's isAlive) who claims the dead stance is
//   validated like stand and stored as stand: no free flight through walls, and the stored pose can never re-arm the
//   revive grace below;
// - safety valve: after rejectResyncCount consecutive rejections it accepts a walkable pose (resync), so a
//   client that ignores corrections or a validation bug can never freeze a player.
import { MOVE } from '@dead-air/shared/constants.ts';
import { STANCE } from '@dead-air/shared/state.ts';
import { walkClear } from '@dead-air/shared/nav/index.ts';
import type { EdgeGrid } from '@dead-air/shared/nav/index.ts';
import type { Crew, PlayerPose, ServerContext, ServerPlayer } from '../core/types.ts';
import { isAlive } from '../interaction/api.ts';
import { doorView, gridFor } from './grid.ts';
import { netBalance } from './balance.ts';

/** alive per the interaction track (roster flag and not on its dead list); the roster flag if that throws */
function livingPlayer(crew: Crew, player: ServerPlayer): boolean {
  if (!player.alive) return false;
  try {
    return isAlive(crew, player.id);
  } catch {
    return player.alive;
  }
}

interface MoveState {
  /** grace after join / phase change: until this time AND while gracePoses > 0, any walkable pose is accepted */
  graceUntil: number;
  gracePoses: number;
  budget: number;
  rejects: number;
  lastCorrect: number;
  accepted: number;
  rejected: number;
  lastReason: string;
}

export const moveStats = { accepted: 0, rejected: 0, resync: 0, byReason: {} as Record<string, number> };

/** crews with validation switched off (dbg.net.validate) */
const disabled = new WeakSet<Crew>();
export function setValidation(crew: Crew, on: boolean): void {
  if (on) disabled.delete(crew);
  else disabled.add(crew);
}

export function moveState(p: ServerPlayer): MoveState {
  const slot = (p.slices.net ??= {}) as { move?: MoveState };
  slot.move ??= { graceUntil: 0, gracePoses: 0, budget: Infinity, rejects: 0, lastCorrect: -Infinity, accepted: 0, rejected: 0, lastReason: '' };
  return slot.move;
}

/**
 * Join / phase change: clients may still send poses from the old layout or their own spawn guess for a moment,
 * and the local controller is re-placed when the phase event lands (which can stall behind a level build).
 * For ~2 s and at least 20 poses, any walkable pose is accepted; normal validation resumes after that.
 */
export function startGrace(p: ServerPlayer, ms = 2000, poses = 20): void {
  const st = moveState(p);
  st.graceUntil = performance.now() + ms;
  st.gracePoses = poses;
  st.budget = Infinity;
  st.rejects = 0;
}

/** Server-side teleport (dev/test, spawns): next poses validate from here. */
export function serverTeleport(p: ServerPlayer, x: number, z: number, y?: number, yaw?: number): void {
  p.pose = { ...p.pose, p: [x, y ?? p.pose.p[1], z], yaw: yaw ?? p.pose.yaw };
  p.poseAt = performance.now();
  const ms = moveState(p);
  ms.budget = Infinity;
  ms.rejects = 0;
}

const inGrid = (g: EdgeGrid, x: number, z: number) => x >= 0 && z >= 0 && x < g.W && z < g.H;
const isOrigin = (p: readonly number[]) => p[0] === 0 && p[1] === 0 && p[2] === 0;

export function makePoseHook(ctx: ServerContext) {
  return function netValidatePose(crew: Crew, player: ServerPlayer, pose: PlayerPose): boolean | void {
    // y is never trusted far from the floor
    pose.p[1] = Math.max(-1, Math.min(6, pose.p[1]));
    const living = livingPlayer(crew, player);
    // a living player's dead claim (stale client right after a revive, or a cheat) walks like everyone else; a hidden
    // claim is never taken on trust either (later pose hooks set hidden for real hiding spots: interaction's lockers and
    // ducts, the Snatcher's duct)
    if (living && (pose.stance === STANCE.dead || pose.stance === STANCE.hidden)) pose.stance = STANCE.stand;
    if (disabled.has(crew)) return;
    if (!living) return; // spectator camera: free
    const bal = netBalance(ctx);
    const ms = moveState(player);
    const prev = player.pose.p;
    const g = gridFor(crew.layout);
    // first pose after join with no spawn set by anyone: accept (nothing to validate against)
    if (player.poseAt === 0 && isOrigin(prev)) return accept(ms, bal);
    // revived: the last accepted pose was the spectator camera, so validate the next ones from scratch
    if (player.pose.stance === STANCE.dead) startGrace(player);

    const now = performance.now();
    if (ms.gracePoses > 0 || now < ms.graceUntil) {
      ms.gracePoses = Math.max(0, ms.gracePoses - 1);
      const walkable = !g || !inGrid(g, pose.p[0], pose.p[2]) || g.owner[Math.floor(pose.p[2]) * g.W + Math.floor(pose.p[0])] >= 0;
      if (walkable) return accept(ms, bal);
    }
    const vmax = MOVE.sprint * bal.speedMult;
    const cap = vmax * bal.moveSlackSec + bal.moveSlackM;
    const dt = player.poseAt ? Math.max(0, (now - player.poseAt) / 1000) : 1;
    ms.budget = Math.min(cap, (Number.isFinite(ms.budget) ? ms.budget : cap) + vmax * dt);
    const dx = pose.p[0] - prev[0], dz = pose.p[2] - prev[2];
    const dist = Math.sqrt(dx * dx + dz * dz);

    let reason: 'speed' | 'wall' | 'solid' | 'grid' | null = null;
    if (dist > ms.budget) reason = 'speed';
    else if (g && dist > 0) {
      const prevIn = inGrid(g, prev[0], prev[2]);
      const nextIn = inGrid(g, pose.p[0], pose.p[2]);
      if (prevIn && !nextIn) reason = 'grid';
      else if (prevIn && nextIn) {
        const open = bal.validateClosedDoors ? doorView(crew).open : () => true;
        if (!walkClear(g, prev[0], prev[2], pose.p[0], pose.p[2], open)) reason = 'wall';
      } else if (nextIn && g.owner[Math.floor(pose.p[2]) * g.W + Math.floor(pose.p[0])] < 0) reason = 'solid';
    }
    if (!reason) {
      ms.budget -= dist;
      return accept(ms, bal);
    }
    ms.rejects++;
    // safety valve: a client that keeps disagreeing gets resynced to a walkable spot it reports
    if (ms.rejects >= bal.rejectResyncCount) {
      const walkable = !g || !inGrid(g, pose.p[0], pose.p[2]) || g.owner[Math.floor(pose.p[2]) * g.W + Math.floor(pose.p[0])] >= 0;
      if (walkable) {
        moveStats.resync++;
        ms.budget = cap;
        ctx.log('net').warn(`pose resync for ${player.name} after ${ms.rejects} rejections (${reason})`);
        return accept(ms, bal);
      }
    }
    ms.rejected++;
    ms.lastReason = reason;
    moveStats.rejected++;
    moveStats.byReason[reason] = (moveStats.byReason[reason] ?? 0) + 1;
    if (now - ms.lastCorrect >= bal.correctMinMs) {
      ms.lastCorrect = now;
      ctx.emit(crew, 'net.correct', { p: [prev[0], prev[1], prev[2]], yaw: player.pose.yaw, reason, seq: pose.seq }, { to: [player.id] });
    }
    return false;
  };
}

function accept(ms: MoveState, _bal: unknown): void {
  ms.rejects = 0;
  ms.accepted++;
  moveStats.accepted++;
}
