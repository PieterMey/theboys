// Owned by track ② Level. Line of sight / straight-line passability over the edge grid
// (Amanatides-Woo traversal, checking every crossed edge; exact corner crossings require both L-routes clear).
import { EDGE } from './grid.ts';
import type { DoorOpenFn, EdgeGrid } from './grid.ts';

/**
 * true if nothing blocks the straight segment a -> b.
 * Sight semantics (default): walls, rubble and closed doors block; fences and open doors don't.
 * With fenceBlocks = true (walking semantics) fences block too.
 */
export function los(g: EdgeGrid, ax: number, az: number, bx: number, bz: number, doorOpen: DoorOpenFn, fenceBlocks = false): boolean {
  const W = g.W, H = g.H, W1 = W + 1;
  let x = Math.floor(ax), y = Math.floor(az);
  const tx = Math.floor(bx), ty = Math.floor(bz);
  if (x < 0 || y < 0 || x >= W || y >= H || tx < 0 || ty < 0 || tx >= W || ty >= H) return false;
  if (x === tx && y === ty) return true;
  const v = g.v, h = g.h, vD = g.vDoor, hD = g.hDoor;
  const passCode = (c: number, door: number): boolean =>
    c === EDGE.free || (c === EDGE.door ? doorOpen(door) : c === EDGE.fence ? !fenceBlocks : false);
  // step from (cx, cy) along x (sx = +-1) / along y (sy = +-1)
  const passX = (cx: number, cy: number, sx: number): boolean => {
    const nx = cx + sx;
    if (nx < 0 || nx >= W) return false;
    const e = cy * W1 + (sx > 0 ? cx + 1 : cx);
    return passCode(v[e], vD[e]);
  };
  const passY = (cx: number, cy: number, sy: number): boolean => {
    const ny = cy + sy;
    if (ny < 0 || ny >= H) return false;
    const e = (sy > 0 ? cy + 1 : cy) * W + cx;
    return passCode(h[e], hD[e]);
  };
  const dx = bx - ax, dy = bz - az;
  const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1;
  const tDx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  let tMx = dx !== 0 ? (stepX > 0 ? x + 1 - ax : ax - x) * tDx : Infinity;
  let tMy = dy !== 0 ? (stepY > 0 ? y + 1 - az : az - y) * tDy : Infinity;
  const maxSteps = Math.abs(tx - x) + Math.abs(ty - y) + 2;
  for (let i = 0; i < maxSteps && (x !== tx || y !== ty); i++) {
    if (tMx < tMy) {
      if (!passX(x, y, stepX)) return false;
      x += stepX; tMx += tDx;
    } else if (tMy < tMx) {
      if (!passY(x, y, stepY)) return false;
      y += stepY; tMy += tDy;
    } else {
      // exact vertex crossing: conservative, both L-shaped routes must be clear
      if (!(passX(x, y, stepX) && passY(x + stepX, y, stepY))) return false;
      if (!(passY(x, y, stepY) && passX(x, y + stepY, stepX))) return false;
      x += stepX; y += stepY; tMx += tDx; tMy += tDy;
    }
  }
  return true;
}

/** Straight-line walkability (fences block). Used for server pose validation and path smoothing. */
export function walkClear(g: EdgeGrid, ax: number, az: number, bx: number, bz: number, doorOpen: DoorOpenFn): boolean {
  return los(g, ax, az, bx, bz, doorOpen, true);
}

/**
 * String-pull a waypoint list for an agent of radius r: keeps a waypoint only when the corridor
 * (two parallel rays offset by +-r) to the next kept point is blocked.
 */
export function smoothPath(g: EdgeGrid, pts: readonly [number, number][], doorOpen: DoorOpenFn, r = 0.3): [number, number][] {
  if (pts.length <= 2) return pts.slice();
  const out: [number, number][] = [pts[0]];
  let i = 0;
  while (i < pts.length - 1) {
    let best = i + 1;
    for (let j = pts.length - 1; j > i + 1; j--) {
      const [ax, az] = pts[i], [bx, bz] = pts[j];
      const dx = bx - ax, dz = bz - az;
      const len = Math.sqrt(dx * dx + dz * dz) || 1;
      const ox = (-dz / len) * r, oz = (dx / len) * r;
      if (walkClear(g, ax, az, bx, bz, doorOpen) && walkClear(g, ax + ox, az + oz, bx + ox, bz + oz, doorOpen) && walkClear(g, ax - ox, az - oz, bx - ox, bz - oz, doorOpen)) { best = j; break; }
    }
    out.push(pts[best]);
    i = best;
  }
  return out;
}
