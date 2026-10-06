// FROZEN CONTRACT (P0). Serializable level layout produced by the server-side generator (Level track)
// and consumed by every track. Fields may be ADDED by the Level track; never renamed/removed.
// Grid: 1 m cells, thin walls on cell edges (see edge grid in ./nav/). Grid (x, y) maps to world (x, 0, y).

export const GEN_VERSION = 1;

export interface Rect { x: number; y: number; w: number; h: number }

export type SpaceKind = 'corridor' | 'room' | 'hall' | 'vault' | 'outside';
export type LightState = 'on' | 'off' | 'flicker' | 'broken';

export interface LayoutSpace {
  id: number;
  kind: SpaceKind;
  rect: Rect;
  /** keycard zone index: 0 = reachable from the entrance without keys */
  zone: number;
  /** room type for decoration/props: 'office' | 'storage' | 'lab' | 'boiler' | 'cold' | 'morgue' | 'archive' | 'lot' ... */
  type: string;
  /** speakable callsign stencilled on walls, e.g. 'BOILER'. null for corridors/outside. Unique per layout. */
  callsign: string | null;
  /** graph distance (m) from the entrance */
  dist: number;
  /** fixture light state at generation (the 'power' system can override at runtime) */
  light: LightState;
  /** true = no ceiling (outside lot) */
  open: boolean;
  /** power zone id for twin levers (spaces in the vault wing share a power zone) */
  powerZone: number;
}

export type DoorKind = 'open' | 'door' | 'fire' | 'security' | 'locked' | 'blocked' | 'exit' | 'vault';

export interface LayoutDoor {
  id: number;
  /** space ids on both sides (-1 = outside the grid) */
  a: number;
  b: number;
  /** v: edge on vertical grid line x spanning cells y..y+len-1; h: edge on horizontal line y spanning x..x+len-1 */
  x: number;
  y: number;
  dir: 'v' | 'h';
  len: number;
  kind: DoorKind;
  /** keycard colour index for kind 'locked' (1..n), else 0 */
  lock: number;
  /** initial open state (doors of kind 'open' are always open) */
  initiallyOpen: boolean;
}

export type SlotKind =
  | 'loot' | 'lever' | 'keypad' | 'core' | 'keycard' | 'hiding' | 'note' | 'light' | 'vent'
  | 'intercom' | 'switch' | 'console' | 'spawn_player' | 'spawn_hound' | 'spawn_listener' | 'spawn_mannequin'
  | 'kennel' | 'mirror' | 'board' | 'shop' | 'leave_lever' | 'deposit' | 'prop';

export interface LayoutItem {
  /** stable id within the layout, e.g. 'loot:12' */
  id: string;
  kind: SlotKind;
  space: number;
  /** world position (m), y = 0 is the floor */
  x: number;
  z: number;
  y?: number;
  /** yaw radians */
  rot?: number;
  data?: Record<string, number | string | boolean>;
}

export interface VanInfo {
  /** van centre in world metres and facing */
  x: number;
  z: number;
  yaw: number;
  /** sealed cab interior (voices inside are only heard inside) */
  cab: Rect;
}

export interface LevelLayout {
  genVersion: number;
  kind: 'hub' | 'facility';
  seed: string;
  /** stable hash of the generated content (for repro + client sanity) */
  hash: string;
  theme: string;
  W: number;
  H: number;
  /** W*H, space id per cell, -1 = solid */
  owner: number[];
  spaces: LayoutSpace[];
  doors: LayoutDoor[];
  items: LayoutItem[];
  /** space id of the entrance room */
  entrance: number;
  van: VanInfo;
  zones: number;
  /** wall height in metres */
  wallH: number;
  metrics: Record<string, number>;
}
