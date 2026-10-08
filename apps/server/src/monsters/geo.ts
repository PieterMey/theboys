// Owner: track (c) Monsters. Grid helpers on ②'s shared edge grid: perceived doorway of a sound (Thief/Hitman style),
// agent path planning + following (doors opened by monsters), random wander targets, sight checks.
import { EDGE, astar, cellOf, edgeCode, edgeDoor, floodCells, los, pathPoints, smoothPath, walkClear } from '@dead-air/shared/nav/index.ts';
import type { DoorOpenFn, EdgeGrid } from '@dead-air/shared/nav/index.ts';
import type { LayoutDoor, LevelLayout, Rect } from '@dead-air/shared/layout.ts';
import type { Agent, CrewMonsters } from './types.ts';

export const DIRS: readonly [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export function inRect(r: Rect, x: number, z: number): boolean {
  return x >= r.x && x < r.x + r.w && z >= r.y && z < r.y + r.h;
}

export function inCab(L: LevelLayout, x: number, z: number): boolean {
  return !!L.van?.cab && inRect(L.van.cab, x, z);
}

export function doorCenter(d: LayoutDoor): [number, number] {
  return d.dir === 'v' ? [d.x, d.y + d.len / 2] : [d.x + d.len / 2, d.y];
}

const ROOMISH = new Set(['room', 'hall', 'vault']);

/** a doorway that reads as "an opening the sound came through" (real doors, or doorless room entrances) */
export function significantDoor(L: LevelLayout, id: number): boolean {
  const d = L.doors[id];
  if (!d || d.id !== id) {
    const dd = L.doors.find((q) => q.id === id);
    if (!dd) return false;
    return dd.kind !== 'open' || ROOMISH.has(L.spaces[dd.a]?.kind ?? '') || ROOMISH.has(L.spaces[dd.b]?.kind ?? '');
  }
  return d.kind !== 'open' || ROOMISH.has(L.spaces[d.a]?.kind ?? '') || ROOMISH.has(L.spaces[d.b]?.kind ?? '');
}

export function doorById(L: LevelLayout, id: number): LayoutDoor | null {
  const d = L.doors[id];
  if (d && d.id === id) return d;
  return L.doors.find((q) => q.id === id) ?? null;
}

export interface Perceived {
  x: number;
  z: number;
  /** door id the sound came through (-1 = heard directly) */
  door: number;
}

/**
 * Where a monster at (mx, mz) perceives a sound: descend the sound field (distance from the source) from the monster's
 * cell; the first significant doorway crossed is "where it came from". No doorway -> the source position itself.
 */
export function perceive(cm: CrewMonsters, field: Float32Array, mx: number, mz: number, sx: number, sz: number): Perceived {
  const g = cm.grid, W = g.W, H = g.H;
  let c = cellOf(g, mx, mz);
  if (!Number.isFinite(field[c])) return { x: sx, z: sz, door: -1 };
  for (let steps = 0; steps < 400 && field[c] > 0.01; steps++) {
    const x = c % W, y = (c - x) / W;
    let best = -1, bestD = field[c], bestDoor = -1;
    for (let dir = 0; dir < 4; dir++) {
      const nx = x + DIRS[dir][0], ny = y + DIRS[dir][1];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const code = edgeCode(g, x, y, dir);
      if (code === EDGE.wall) continue;
      const n = ny * W + nx;
      if (field[n] < bestD - 1e-4) { best = n; bestD = field[n]; bestDoor = edgeDoor(g, x, y, dir); }
    }
    // diagonals (only through free 2x2 blocks; never cross a door)
    for (const [dx, dy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]] as const) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const n = ny * W + nx;
      if (!(field[n] < bestD - 1e-4)) continue;
      const ex = dx > 0 ? 0 : 1, ey = dy > 0 ? 2 : 3;
      if (edgeCode(g, x, y, ex) !== EDGE.free || edgeCode(g, x, y, ey) !== EDGE.free) continue;
      if (edgeCode(g, x + dx, y, ey) !== EDGE.free || edgeCode(g, x, y + dy, ex) !== EDGE.free) continue;
      best = n; bestD = field[n]; bestDoor = -1;
    }
    if (best < 0) break;
    if (bestDoor >= 0 && significantDoor(cm.layout, bestDoor)) {
      const d = doorById(cm.layout, bestDoor);
      if (d) {
        const [cx, cz] = doorCenter(d);
        return { x: cx, z: cz, door: bestDoor };
      }
    }
    c = best;
  }
  return { x: sx, z: sz, door: -1 };
}

/** point 0.6 m beyond a door centre on the side away from (fromX, fromZ) (or toward it with sign -1) */
export function throughDoor(d: LayoutDoor, fromX: number, fromZ: number, dist = 0.6): [number, number] {
  const [cx, cz] = doorCenter(d);
  if (d.dir === 'v') return [cx + (fromX < cx ? dist : -dist), cz];
  return [cx, cz + (fromZ < cz ? dist : -dist)];
}

// ---------------- movement ----------------

export type CanOpen = (id: number) => boolean;

/** door kinds a monster can push open (security/locked/vault/exit doors stop it) */
export function monsterCanOpen(L: LevelLayout): CanOpen {
  return (id) => {
    const d = doorById(L, id);
    return !!d && (d.kind === 'door' || d.kind === 'fire');
  };
}

export function planTo(cm: CrewMonsters, a: Agent, tx: number, tz: number, canOpen?: CanOpen, maxCost = 400): boolean {
  const g = cm.grid;
  // the van is a sanctuary: monsters never path into the cab
  if (inCab(cm.layout, tx, tz)) {
    a.path = null;
    a.planAt = cm.time;
    return false;
  }
  const r = astar(g, a.x, a.z, tx, tz, { mode: 'walk', doorOpen: cm.doorOpen, canOpen, maxCost });
  a.planAt = cm.time;
  a.goalX = tx;
  a.goalZ = tz;
  if (!r) {
    a.path = null;
    return false;
  }
  const pts = pathPoints(g, r.cells);
  pts[0] = [a.x, a.z];
  if (pts.length > 1 && cellOf(g, tx, tz) === r.cells[r.cells.length - 1]) pts[pts.length - 1] = [tx, tz];
  a.path = pts.length > 2 ? smoothPath(g, pts, cm.doorOpen, 0.32) : pts;
  a.pathI = 1;
  a.stuck = 0;
  return true;
}

/** the closed door between two orthogonally adjacent cells, or -1 */
function closedDoorBetween(cm: CrewMonsters, ax: number, az: number, bx: number, bz: number): number {
  const g = cm.grid;
  const x0 = Math.floor(ax), y0 = Math.floor(az), x1 = Math.floor(bx), y1 = Math.floor(bz);
  const dx = x1 - x0, dy = y1 - y0;
  if (Math.abs(dx) + Math.abs(dy) !== 1) return -2;
  const dir = dx === 1 ? 0 : dx === -1 ? 1 : dy === 1 ? 2 : 3;
  if (edgeCode(g, x0, y0, dir) !== EDGE.door) return -1;
  const id = edgeDoor(g, x0, y0, dir);
  return id >= 0 && !cm.doorOpen(id) ? id : -1;
}

export function turnToward(a: Agent, yaw: number, dt: number, rate = 9): void {
  let d = (yaw - a.yaw) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  const step = Math.min(Math.abs(d), rate * dt);
  a.yaw += Math.sign(d) * step;
}

export function yawTo(ax: number, az: number, bx: number, bz: number): number {
  return Math.atan2(bx - ax, bz - az);
}

export type FollowResult = 'moving' | 'arrived' | 'blocked' | 'door';

/**
 * Follow the planned path at `speed`. Closed doors the agent may open: wait `doorPause` s, then `openDoor(id)`.
 * Returns 'arrived' at the end of the path.
 */
export function follow(cm: CrewMonsters, a: Agent, dt: number, speed: number, canOpen: CanOpen | undefined, doorPause: number, openDoor: (id: number, by: Agent) => void): FollowResult {
  if (!a.path) return 'arrived';
  if (a.doorWait > 0) {
    a.doorWait -= dt;
    if (a.doorWait <= 0) {
      if (a.pendingDoor >= 0) openDoor(a.pendingDoor, a);
      a.pendingDoor = -1;
    }
    return 'door';
  }
  let budget = speed * dt;
  a.speed = speed;
  let replanned = false;
  while (budget > 1e-6 && a.pathI < a.path.length) {
    const [tx, tz] = a.path[a.pathI];
    if (!walkClear(cm.grid, a.x, a.z, tx, tz, cm.doorOpen)) {
      const door = closedDoorBetween(cm, a.x, a.z, tx, tz);
      if (door >= 0) {
        if (canOpen && canOpen(door)) {
          a.doorWait = doorPause;
          a.pendingDoor = door;
          a.yaw = yawTo(a.x, a.z, tx, tz);
          return 'door';
        }
        a.path = null;
        return 'blocked';
      }
      if (door === -2) {
        // long segment blocked by a door that closed since planning: replan, at most once per call. A goal ON a closed
        // door's edge (a perceived doorway) replans to the same blocked segment forever, which froze the server tick.
        if (replanned || !planTo(cm, a, a.goalX, a.goalZ, canOpen)) { a.path = null; return 'blocked'; }
        replanned = true;
        continue;
      }
    }
    const dx = tx - a.x, dz = tz - a.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > 1e-4) turnToward(a, Math.atan2(dx, dz), dt, 10);
    if (d <= budget) {
      a.x = tx;
      a.z = tz;
      a.pathI++;
      budget -= d;
    } else {
      a.x += (dx / d) * budget;
      a.z += (dz / d) * budget;
      budget = 0;
    }
  }
  // stuck detection
  const moved = Math.hypot(a.x - a.lastX, a.z - a.lastZ);
  a.lastX = a.x;
  a.lastZ = a.z;
  a.stuck = moved < speed * dt * 0.2 ? a.stuck + dt : 0;
  if (a.stuck > 2.5) {
    a.path = null;
    return 'blocked';
  }
  return a.pathI >= a.path.length ? 'arrived' : 'moving';
}

/** walk-mode distance field from an agent (bounded) */
export function walkField(cm: CrewMonsters, x: number, z: number, budget: number, canOpen?: CanOpen): Float32Array {
  return floodCells(cm.grid, [cellOf(cm.grid, x, z)], { mode: 'walk', doorOpen: cm.doorOpen, canOpen, budget });
}

/** random reachable cell centre within [minD, maxD] walk distance; restrict to a space if given */
export function randomReachable(cm: CrewMonsters, x: number, z: number, minD: number, maxD: number, space = -1, canOpen?: CanOpen): [number, number] | null {
  const f = walkField(cm, x, z, maxD, canOpen);
  const g = cm.grid;
  const cand: number[] = [];
  for (let c = 0; c < f.length; c++) {
    const d = f[c];
    if (!(d >= minD && d <= maxD)) continue;
    if (g.owner[c] < 0) continue;
    if (space >= 0 && g.owner[c] !== space) continue;
    if (inCab(cm.layout, (c % g.W) + 0.5, Math.floor(c / g.W) + 0.5)) continue;
    cand.push(c);
  }
  if (!cand.length) return null;
  const c = cand[Math.floor(cm.rng.next() * cand.length)];
  return [(c % g.W) + 0.5, Math.floor(c / g.W) + 0.5];
}

/** true if a viewer at (vx,vz) facing `yaw` sees (tx,tz) within `range` m and a `fovDeg` cone, LOS clear */
export function sees(g: EdgeGrid, doorOpen: DoorOpenFn, vx: number, vz: number, yaw: number, tx: number, tz: number, range: number, fovDeg: number): boolean {
  const dx = tx - vx, dz = tz - vz;
  const d2 = dx * dx + dz * dz;
  if (d2 > range * range) return false;
  if (d2 > 0.25) {
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const cos = (fx * dx + fz * dz) / Math.sqrt(d2);
    if (cos < Math.cos(((fovDeg / 2) * Math.PI) / 180)) return false;
  }
  return los(g, vx, vz, tx, tz, doorOpen);
}

export function dist(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}
