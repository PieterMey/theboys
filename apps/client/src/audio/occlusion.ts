// Owner: track ④ Voice/audio. Cheap wall-crossing count between two points over the level edge grid
// (Amanatides-Woo DDA like packages/shared/src/nav/los.ts, but counting instead of stopping).
// Walls / rubble = 1, closed (or unknown) doors = closedDoorFrac, open doors / fences / free = 0.
// Grid source: services.level.grid (② Level), else built locally from world.layout with buildEdgeGrid.
import { EDGE, buildEdgeGrid } from '@dead-air/shared/nav/index.ts';
import type { EdgeGrid } from '@dead-air/shared/nav/index.ts';
import type { ClientContext } from '../core/context.ts';
import { useLoose } from './graph.ts';

interface LevelLike {
  grid?: EdgeGrid;
  doorOpen?(id: number): boolean;
}

let localGrid: { key: unknown; grid: EdgeGrid | null } = { key: null, grid: null };

export function levelGrid(ctx: ClientContext): { grid: EdgeGrid | null; doorOpen: ((id: number) => boolean) | null } {
  const lvl = useLoose<LevelLike>(ctx, 'level');
  if (lvl?.grid) return { grid: lvl.grid, doorOpen: lvl.doorOpen ? (id) => lvl.doorOpen!(id) : null };
  const L = ctx.world.layout;
  if (!L) return { grid: null, doorOpen: null };
  if (localGrid.key !== L) {
    let grid: EdgeGrid | null = null;
    try { grid = buildEdgeGrid(L); } catch { grid = null; }
    localGrid = { key: L, grid };
  }
  return { grid: localGrid.grid, doorOpen: null };
}

/** weighted wall count along the segment a -> b (x/z in metres = grid cells) */
export function wallCrossings(
  g: EdgeGrid, ax: number, az: number, bx: number, bz: number, doorOpen: ((id: number) => boolean) | null, closedDoorFrac = 0.6, cap = 4,
): number {
  const W = g.W, H = g.H, W1 = W + 1;
  let x = Math.floor(ax), y = Math.floor(az);
  const tx = Math.floor(bx), ty = Math.floor(bz);
  if (x < 0 || y < 0 || x >= W || y >= H || tx < 0 || ty < 0 || tx >= W || ty >= H) return 0;
  if (x === tx && y === ty) return 0;
  const cost = (c: number, door: number): number => {
    if (c === EDGE.free || c === EDGE.fence) return 0;
    if (c === EDGE.door) {
      const open = doorOpen ? doorOpen(door) : null;
      return open === true ? 0 : open === false ? closedDoorFrac : closedDoorFrac * 0.5;
    }
    return 1;
  };
  const dx = bx - ax, dy = bz - az;
  const stepX = dx > 0 ? 1 : -1, stepY = dy > 0 ? 1 : -1;
  const tDx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDy = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  let tMx = dx !== 0 ? (stepX > 0 ? x + 1 - ax : ax - x) * tDx : Infinity;
  let tMy = dy !== 0 ? (stepY > 0 ? y + 1 - az : az - y) * tDy : Infinity;
  const maxSteps = Math.abs(tx - x) + Math.abs(ty - y) + 2;
  let walls = 0;
  for (let i = 0; i < maxSteps && (x !== tx || y !== ty) && walls < cap; i++) {
    if (tMx <= tMy) {
      const nx = x + stepX;
      if (nx < 0 || nx >= W) break;
      const e = y * W1 + (stepX > 0 ? x + 1 : x);
      walls += cost(g.v[e], g.vDoor[e]);
      x = nx; tMx += tDx;
    } else {
      const ny = y + stepY;
      if (ny < 0 || ny >= H) break;
      const e = (stepY > 0 ? y + 1 : y) * W + x;
      walls += cost(g.h[e], g.hDoor[e]);
      y = ny; tMy += tDy;
    }
  }
  return Math.min(cap, walls);
}

/** lowpass cutoff + gain for a weighted wall count (balance voice.occlusionLowpassHz / occlusionPerWallDb) */
export function occlusionParams(walls: number, lowpassHz: readonly number[], perWallDb: number): { freq: number; gain: number } {
  if (walls <= 0.01) return { freq: lowpassHz[0] ?? 20000, gain: 1 };
  const i = Math.min(lowpassHz.length - 1, Math.floor(walls));
  const j = Math.min(lowpassHz.length - 1, i + 1);
  const k = walls - Math.floor(walls);
  // interpolate in log-frequency
  const f = Math.exp(Math.log(lowpassHz[i]) * (1 - k) + Math.log(lowpassHz[j]) * k);
  return { freq: f, gain: Math.pow(10, (perWallDb * walls) / 20) };
}
