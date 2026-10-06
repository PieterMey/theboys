// Owned by track ② Level. The crew van, grid-aligned so the edge grid gives it real walls:
//   cargo area (the sealed "cab" where the crew sits): VAN_CARGO_W x VAN_CARGO_L cells, its own space (type 'van'),
//   rear opening (an 'open' doorway) on the -Z side, driver cab VAN_CAB_L cells of solid (-1) on the +Z side.
// van.yaw = 0 means the van's nose points +Z (away from the facility); players board from the rear (-Z).
import type { Rect, VanInfo } from '../layout.ts';
import type { AddItem } from './common.ts';
import { HALF_T } from './place.ts';

export const VAN_CARGO_W = 2;
export const VAN_CARGO_L = 3;
export const VAN_CAB_L = 2;
export const VAN_LEN = VAN_CARGO_L + VAN_CAB_L;

/** Stamp the van into the owner grid. (x0, y0) = first cargo cell; the rear opening is the edge on line y0. */
export function stampVan(owner: Int32Array | number[], W: number, x0: number, y0: number, vanSpace: number): VanInfo {
  for (let y = y0; y < y0 + VAN_CARGO_L; y++) for (let x = x0; x < x0 + VAN_CARGO_W; x++) owner[y * W + x] = vanSpace;
  for (let y = y0 + VAN_CARGO_L; y < y0 + VAN_LEN; y++) for (let x = x0; x < x0 + VAN_CARGO_W; x++) owner[y * W + x] = -1;
  const cab: Rect = { x: x0, y: y0, w: VAN_CARGO_W, h: VAN_CARGO_L };
  return { x: x0 + VAN_CARGO_W / 2, z: y0 + VAN_LEN / 2, yaw: 0, cab };
}

/** Console (front wall of the cargo area, facing the rear), leave lever (left wall), deposit (just inside the rear). */
export function addVanItems(van: VanInfo, vanSpace: number, add: AddItem): void {
  const c = van.cab;
  add('console', vanSpace, c.x + c.w / 2, c.y + c.h - HALF_T - 0.275, { rot: Math.PI, y: 0, data: { w: 1.7, d: 0.55 } });
  add('leave_lever', vanSpace, c.x + HALF_T + 0.1, c.y + 1.75, { rot: Math.PI / 2, y: 1.15 });
  add('deposit', vanSpace, c.x + c.w / 2, c.y + 0.75, { y: 0, data: { r: 0.9 } });
}

/** 6 player spawns in two rows of three behind the rear doors, facing `yaw` (default: toward the facility, -Z). */
export function addVanSpawns(van: VanInfo, lotSpace: number, add: AddItem, yaw = Math.PI): void {
  const c = van.cab;
  for (let r = 0; r < 2; r++) for (let i = 0; i < 3; i++) {
    add('spawn_player', lotSpace, c.x + c.w / 2 + (i - 1) * 1.2, c.y - 1.4 - r * 1.1, { rot: yaw, data: { idx: r * 3 + i } });
  }
}
