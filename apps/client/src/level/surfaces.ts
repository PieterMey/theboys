// Owner: env-world (v1.2). Floor surface under a point (footstep sound, step noise on the client): floorSurface of the
// cell's space (the same table the server uses for noise and the palette draws), with clutter puddles and flooded
// halls as 'water'. Pure (no THREE / DOM): a per-layout cell grid, O(1) per query.
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import { clutterFor } from '@dead-air/shared/procgen/clutter.ts';
import { floorSurface } from '@dead-air/shared/procgen/themes.ts';
import type { FloorSurface } from '@dead-air/shared/procgen/themes.ts';
import type { SurfaceKind } from './api.ts';

export const SURFACE_KINDS: readonly SurfaceKind[] = ['concrete', 'tile', 'metal', 'grate', 'carpet', 'wood', 'rubber', 'lino', 'asphalt', 'dirt', 'water'];
const WATER = SURFACE_KINDS.indexOf('water');

export interface SurfaceGrid {
  W: number; H: number;
  /** SURFACE_KINDS index per cell; 255 = no space (solid / van cab) */
  cells: Uint8Array;
  /** surface of the outdoor lot (positions outside the grid) */
  outside: SurfaceKind;
  /** per space id */
  spaces: FloorSurface[];
}

/** flooded halls get the client's water sheet (setpieces waterSheet): boiler halls of 40 m2 and more */
export function floodedSpace(s: { type: string; rect: { w: number; h: number } }): boolean {
  return s.type === 'boiler' && s.rect.w * s.rect.h >= 40;
}

export function buildSurfaceGrid(L: Pick<LevelLayout, 'W' | 'H' | 'owner' | 'spaces' | 'theme' | 'metrics' | 'kind'> & LevelLayout): SurfaceGrid {
  const { W, H } = L;
  const spaces = L.spaces.map((s) => { try { return floorSurface(L, s.id); } catch { return 'concrete' as FloorSurface; } });
  const cells = new Uint8Array(W * H).fill(255);
  for (let i = 0; i < W * H; i++) {
    const o = L.owner[i];
    if (o < 0) continue;
    cells[i] = L.spaces[o] && floodedSpace(L.spaces[o]) ? WATER : SURFACE_KINDS.indexOf(spaces[o]);
  }
  // puddles: every cell whose centre lies in a puddle ellipse, plus the cell under the puddle's centre
  for (const ci of clutterFor(L)) {
    if (ci.kind !== 'puddle') continue;
    const rx = 0.5 * ci.a, rz = 0.5 * (ci.b + 0.4);
    const c = Math.cos(ci.rot), s = Math.sin(ci.rot);
    const ext = Math.max(rx, rz);
    const mark = (x: number, z: number) => { if (x >= 0 && z >= 0 && x < W && z < H && L.owner[z * W + x] === ci.space) cells[z * W + x] = WATER; };
    mark(Math.floor(ci.x), Math.floor(ci.z));
    for (let z = Math.floor(ci.z - ext); z <= Math.floor(ci.z + ext); z++) for (let x = Math.floor(ci.x - ext); x <= Math.floor(ci.x + ext); x++) {
      const dx = x + 0.5 - ci.x, dz = z + 0.5 - ci.z;
      // into the puddle's frame (rotation about y by ci.rot)
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      if ((lx * lx) / (rx * rx) + (lz * lz) / (rz * rz) <= 1) mark(x, z);
    }
  }
  const lot = L.spaces.find((s) => s.open && s.type === 'lot') ?? L.spaces.find((s) => s.open);
  return { W, H, cells, outside: lot ? spaces[lot.id] : 'concrete', spaces };
}

export function surfaceFromGrid(g: SurfaceGrid, x: number, z: number): SurfaceKind {
  const cx = Math.floor(x), cz = Math.floor(z);
  if (cx < 0 || cz < 0 || cx >= g.W || cz >= g.H) return g.outside;
  const v = g.cells[cz * g.W + cx];
  if (v !== 255) return SURFACE_KINDS[v];
  // a solid cell (wall line, van cab): the nearest space cell around it
  for (let r = 1; r <= 1; r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
    const nx = cx + dx, nz = cz + dz;
    if (nx < 0 || nz < 0 || nx >= g.W || nz >= g.H) continue;
    const w = g.cells[nz * g.W + nx];
    if (w !== 255) return SURFACE_KINDS[w];
  }
  return g.outside;
}
