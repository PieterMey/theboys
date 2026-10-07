// Owner: env-world (v1.2). Consumers: `ctx.services.use('level') as (LevelService & Partial<LevelServiceV12>) | undefined`.
import type * as THREE from 'three/webgpu';
import type { Station, StationKind } from '@dead-air/shared/procgen/van.ts';
import type { ContainerInfo } from '@dead-air/shared/procgen/containers.ts';
import type { LoreSpot } from '@dead-air/shared/procgen/lore.ts';
import type { FloorSurface } from '@dead-air/shared/procgen/themes.ts';
import type { MirrorHandle } from '../render/api.ts';

export type SurfaceKind = FloorSurface | 'water';
export interface LorePageVisual { visible: boolean; title?: string; text?: string; glow?: number; dim?: boolean }
export interface PropHandle { readonly object: THREE.Object3D; commit(world: THREE.Matrix4): void; restore(): void }
export interface LevelServiceV12 {
  stations(): readonly Station[];
  /** named parts: 'door' (stash), 'books', 'lamp', 'glass', 'cradle', 'screen0'..'screen3' */
  stationObject(kind: StationKind): THREE.Object3D | null;
  setVanUpgrades(ids: readonly string[]): void;
  containers(): readonly ContainerInfo[];
  setContainerOpen(id: string, mask: number, instant?: boolean): void;
  containerOpen(id: string): number;
  containerAnim(id: string, idx: number): number;
  /** visual 0..1 during a quiet open; null hands back */
  setContainerProgress(id: string, idx: number, t: number | null): void;
  containerPartMatrix(id: string, idx: number, out: THREE.Matrix4): boolean;
  loreSpots(): readonly LoreSpot[];
  setLorePage(id: string, page: LorePageVisual | null): void;
  /** visual 0..1 while easing a door; null hands back */
  setDoorProgress(id: number, t: number | null): void;
  rattleDoor(id: number, ms: number, amp?: number): void;
  surfaceAt(x: number, z: number): SurfaceKind;
  propHandle(ref: string, at?: { key: string; x: number; z: number }): PropHandle | null;
  mirrorOf(itemId: string): MirrorHandle | null;
}
// FixtureInfo (level/index.ts) gains rot?: number and battery?: boolean.
