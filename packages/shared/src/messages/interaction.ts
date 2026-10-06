// Owned by P2 track (b) Interaction (doors, items, inventory, hiding, switches, walkies, death/revive).

export interface DoorState { open: boolean; locked: boolean }
export interface ItemState {
  id: string;
  /** item type, e.g. 'loot.small' | 'bottle' | 'crowbar' | 'walkie' | 'glowstick' | 'medkit' | 'keycard' | 'core' | 'airhorn' */
  type: string;
  value: number;
  /** 'world' (lying at pos) | 'held' (in someone's inventory) | 'van' (deposited) */
  where: 'world' | 'held' | 'van';
  holder?: string;
  p?: [number, number, number];
}

export interface InteractionState {
  doors: Record<number, DoorState>;
  items: Record<string, ItemState>;
  /** player id -> 4 inventory slots (item ids or null) */
  inventories: Record<string, (string | null)[]>;
  /** space id -> light on? (switches / power / blackout) */
  lights: Record<number, boolean>;
  dead: string[];
  /** player id -> hiding spot item id */
  hidden: Record<string, string>;
}

export interface InteractionEvents {}

export interface InteractionReqs {}
