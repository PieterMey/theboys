// Owner: env-layout (v1.2). Openable containers derived from existing furniture: a PURE filter over the layout (no
// generation change), memoised per hash. Contract skeleton: keep exports; env-layout fills defs and containersOf.
import type { LevelLayout } from '../layout.ts';

export type ContainerKind = 'cabinet' | 'desk' | 'filing' | 'tool_chest' | 'morgue_drawers' | 'counter' | 'drawer_chest' | 'nightstand';
export type ContainerPartKind = 'drawer' | 'tray' | 'door' | 'lid';
export interface ContainerPart {
  /** bit index in the open mask (0..15) */
  idx: number;
  kind: ContainerPartKind;
  /** GLB node name for model-backed hosts; absent for procedural parts */
  node?: string;
  /** centre in the host's local frame = the client loader's recentred model frame (+X width, +Z room-facing front, y up) */
  local: [number, number, number];
  size: [number, number, number];
  /** drawer/tray: slide along local +Z (m, <= 0.45); door/lid: max hinge angle (rad) */
  travel: number;
  hinge?: { axis: 'x' | 'y'; pivot: [number, number, number]; sign: 1 | -1 };
  /** world point inside the part where items lie when open */
  slot: [number, number, number];
}
export interface ContainerInfo {
  /** host prop id ('prop:41'); interactable id = v12Id('container', id) */
  id: string;
  prop: string;
  kind: ContainerKind;
  space: number;
  roomType: string;
  x: number; z: number; rot: number;
  /** aim point on the front face */
  p: [number, number, number];
  /** walkable cell in front (cx, cz) */
  front: [number, number];
  parts: ContainerPart[];
  /** part a search opens; its slot holds the contents */
  main: number;
  /** loot tier hint 0..2 */
  tier: number;
}
/** <= 3 per room, <= 32 per site; deterministic */
export function containersOf(_L: LevelLayout): readonly ContainerInfo[] {
  return [];
}
export function containerById(L: LevelLayout, id: string): ContainerInfo | null {
  return containersOf(L).find((c) => c.id === id) ?? null;
}
