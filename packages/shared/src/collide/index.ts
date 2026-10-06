// Owned by track ② Level. Player collision: a circle (radius PLAYER.radius) against edge-grid walls with sliding.
// Blocking for walking: walls, fences, rubble ('blocked') and closed doors, plus static solid boxes (lockers,
// the van console...). Used by the client controller (⑤) and server pose validation (①).
import type { Vec2 } from '../state.ts';
import { EDGE } from '../nav/grid.ts';
import type { DoorOpenFn, EdgeGrid } from '../nav/grid.ts';
import { walkClear } from '../nav/los.ts';

/** max substep (m); must stay well below the radius so thin walls can't be tunnelled */
const MAX_STEP = 0.1;
const ITER = 4;
const EPS = 1e-6;
/** walls are 0.16 m thick visually: segments act as capsules of this radius (matches the mesher HALF_T) */
export const WALL_PAD = 0.08;

function edgeBlocks(code: number, door: number, doorOpen: DoorOpenFn): boolean {
  return code === EDGE.wall || code === EDGE.blocked || code === EDGE.fence || (code === EDGE.door && !doorOpen(door));
}

/** push the circle out of one segment (a -> b); returns the corrected position or null if not touching */
function pushSeg(x: number, z: number, r: number, ax: number, az: number, bx: number, bz: number, out: [number, number]): boolean {
  const vx = bx - ax, vz = bz - az;
  const len2 = vx * vx + vz * vz;
  let t = len2 > 0 ? ((x - ax) * vx + (z - az) * vz) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const px = ax + vx * t, pz = az + vz * t;
  let dx = x - px, dz = z - pz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= r * r) return false;
  let d = Math.sqrt(d2);
  if (d < EPS) {
    // centre exactly on the segment: push along the segment normal
    const l = Math.sqrt(len2) || 1;
    dx = -vz / l; dz = vx / l; d = 1;
    out[0] = px + dx * r; out[1] = pz + dz * r;
    return true;
  }
  const k = (r - d) / d;
  out[0] = x + dx * k; out[1] = z + dz * k;
  return true;
}

function pushBox(x: number, z: number, r: number, x0: number, z0: number, x1: number, z1: number, out: [number, number]): boolean {
  const cx = x < x0 ? x0 : x > x1 ? x1 : x;
  const cz = z < z0 ? z0 : z > z1 ? z1 : z;
  const dx = x - cx, dz = z - cz;
  const d2 = dx * dx + dz * dz;
  if (d2 >= r * r) return false;
  if (d2 > EPS * EPS) {
    const d = Math.sqrt(d2), k = (r - d) / d;
    out[0] = x + dx * k; out[1] = z + dz * k;
    return true;
  }
  // centre inside the box: leave by the nearest face
  const l = x - x0, rr = x1 - x, t = z - z0, b = z1 - z;
  const m = Math.min(l, rr, t, b);
  out[0] = x; out[1] = z;
  if (m === l) out[0] = x0 - r; else if (m === rr) out[0] = x1 + r; else if (m === t) out[1] = z0 - r; else out[1] = z1 + r;
  return true;
}

const tmp: [number, number] = [0, 0];

/** Resolve penetration of a circle at (x, z) against everything blocking nearby. Returns the corrected position. */
export function resolveCircle(g: EdgeGrid, x: number, z: number, r: number, doorOpen: DoorOpenFn): Vec2 {
  const W = g.W, H = g.H, W1 = W + 1, rw = r + WALL_PAD;
  for (let it = 0; it < ITER; it++) {
    let moved = false;
    const xl0 = Math.max(0, Math.floor(x - rw)), xl1 = Math.min(W, Math.floor(x + rw) + 1);
    const yr0 = Math.max(0, Math.floor(z - rw) - 1), yr1 = Math.min(H - 1, Math.floor(z + rw) + 1);
    // vertical edges: line xl, row yr
    for (let xl = xl0; xl <= xl1; xl++) for (let yr = yr0; yr <= yr1; yr++) {
      const e = yr * W1 + xl;
      if (!edgeBlocks(g.v[e], g.vDoor[e], doorOpen)) continue;
      if (pushSeg(x, z, rw, xl, yr, xl, yr + 1, tmp)) { x = tmp[0]; z = tmp[1]; moved = true; }
    }
    const yl0 = Math.max(0, Math.floor(z - rw)), yl1 = Math.min(H, Math.floor(z + rw) + 1);
    const xr0 = Math.max(0, Math.floor(x - rw) - 1), xr1 = Math.min(W - 1, Math.floor(x + rw) + 1);
    for (let yl = yl0; yl <= yl1; yl++) for (let xr = xr0; xr <= xr1; xr++) {
      const e = yl * W + xr;
      if (!edgeBlocks(g.h[e], g.hDoor[e], doorOpen)) continue;
      if (pushSeg(x, z, rw, xr, yl, xr + 1, yl, tmp)) { x = tmp[0]; z = tmp[1]; moved = true; }
    }
    if (g.solids.length) {
      const cx0 = Math.max(0, Math.floor(x - r)), cx1 = Math.min(W - 1, Math.floor(x + r));
      const cz0 = Math.max(0, Math.floor(z - r)), cz1 = Math.min(H - 1, Math.floor(z + r));
      for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
        const c = cz * W + cx;
        for (let k = g.solidStart[c]; k < g.solidStart[c + 1]; k++) {
          const b = g.solidIdx[k] * 4;
          if (pushBox(x, z, r, g.solids[b], g.solids[b + 1], g.solids[b + 2], g.solids[b + 3], tmp)) { x = tmp[0]; z = tmp[1]; moved = true; }
        }
      }
    }
    if (!moved) break;
  }
  return [x, z];
}

/**
 * Move a circle by delta with wall sliding. Substeps at <= 0.1 m so nothing is tunnelled.
 * doorOpen(id) = door currently open (closed / locked doors block).
 */
export function moveCircle(g: EdgeGrid, pos: Vec2, delta: Vec2, r: number, doorOpen: DoorOpenFn): Vec2 {
  let x = pos[0], z = pos[1];
  const dx = delta[0], dz = delta[1];
  const dist = Math.sqrt(dx * dx + dz * dz);
  const n = Math.max(1, Math.ceil(dist / MAX_STEP));
  const sx = dx / n, sz = dz / n;
  for (let i = 0; i < n; i++) {
    const p = resolveCircle(g, x + sx, z + sz, r, doorOpen);
    x = p[0]; z = p[1];
  }
  return [x, z];
}

/** true if a circle at (x, z) penetrates nothing (tolerance tol metres). */
export function circleFree(g: EdgeGrid, x: number, z: number, r: number, doorOpen: DoorOpenFn, tol = 0.01): boolean {
  const p = resolveCircle(g, x, z, r - tol, doorOpen);
  return Math.abs(p[0] - x) < 1e-4 && Math.abs(p[1] - z) < 1e-4;
}

/** true if the straight segment a -> b crosses a blocking edge (closed doors, walls, fences, rubble). */
export function crossesWall(g: EdgeGrid, ax: number, az: number, bx: number, bz: number, doorOpen: DoorOpenFn): boolean {
  return !walkClear(g, ax, az, bx, bz, doorOpen);
}

/**
 * Server-side pose check: accept the move from -> to if it doesn't cross a wall and doesn't end inside one
 * (with tolerance). Returns the position to keep (to, or a slid position, or from).
 */
export function validateMove(g: EdgeGrid, from: Vec2, to: Vec2, r: number, doorOpen: DoorOpenFn, tol = 0.08): { ok: boolean; p: Vec2 } {
  if (crossesWall(g, from[0], from[1], to[0], to[1], doorOpen)) {
    const slid = moveCircle(g, from, [to[0] - from[0], to[1] - from[1]], r, doorOpen);
    return { ok: false, p: slid };
  }
  if (!circleFree(g, to[0], to[1], r, doorOpen, tol)) return { ok: false, p: resolveCircle(g, to[0], to[1], r, doorOpen) };
  return { ok: true, p: to };
}
