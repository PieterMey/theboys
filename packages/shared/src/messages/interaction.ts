// Owned by P2 track (b) Interaction (doors, items, inventory, hiding, switches, walkies, death/revive).
import type { InteractableInfo } from '../interactables.ts';

type V3 = [number, number, number];

export interface DoorState {
  open: boolean;
  locked: boolean;
  /** LayoutDoor kind ('door' | 'fire' | 'security' | 'locked' | 'vault' | 'exit') */
  kind?: string;
  /** server time (ms) until the console may toggle it again (security doors) */
  cooldownUntil?: number;
  /** v1.2 quiet hold-E in progress (server-timed) */
  ease?: EaseState;
}

export interface ItemState {
  id: string;
  /** item type, e.g. 'loot.small' | 'bottle' | 'crowbar' | 'walkie' | 'glowstick' | 'medkit' | 'keycard' | 'core' | 'airhorn' | 'badge' */
  type: string;
  value: number;
  /** 'world' (lying at pos) | 'held' (in someone's inventory) | 'van' (deposited) */
  where: 'world' | 'held' | 'van';
  holder?: string;
  p?: [number, number, number];
  /** display name (loot flavour name, "Sam's badge") */
  name?: string;
  /** stack count (bottles, glowsticks) */
  count?: number;
  /** keycard colour index (matches LayoutDoor.lock) */
  lock?: number;
  /** badge: player id it belongs to */
  owner?: string;
  /** loot tier 0..2 */
  tier?: number;
  /** yaw on the floor */
  rot?: number;
  /** motion sensor lying in the world: armed (the van console shows movement within its range) */
  armed?: boolean;
  /** lucky charm bonus (scrip) already added to value at deposit */
  bonus?: number;
  /** v1.2: pouch item contents (MaterialType -> units) */
  mats?: Record<string, number>;
}

/** a thrown flare burning on the floor (red area light; counts as lit for litAt) */
export interface FlareState {
  p: V3;
  /** server time (ms) when it burns out */
  until: number;
  by?: string;
}

export interface DeathCause {
  /** e.g. 'HOUND' | 'MANNEQUIN' | 'LISTENER' | 'THE VAN' */
  killer: string;
  /** e.g. 'heard your SPRINT (9 m)' */
  reason: string;
  detail?: string;
}

export interface BodyState {
  pid: string;
  name: string;
  p: V3;
  yaw: number;
  /** server time (ms) of death */
  at: number;
  /** server time (ms) until a medkit can revive */
  reviveBy: number;
  cause: DeathCause;
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
  /** player id -> active slot 0..3 */
  active: Record<string, number>;
  /** non-item interactables (doors, lockers, switches, levers, console, bodies, ...); world items are in `items` */
  ints: Record<string, InteractableInfo>;
  /** dropped (lit) glowsticks: id -> floor position */
  glows: Record<string, V3>;
  /** dead players' bodies */
  bodies: Record<string, BodyState>;
  /** player id -> server time (ms) of the badge respawn at the van */
  respawns: Record<string, number>;
  /** player id -> hp (100; 50 after a revive) */
  hp: Record<string, number>;
  /** burning flares (v1.1 gear; optional so older mirrors stay valid) */
  flares?: Record<string, FlareState>;
  /** v1.2: container id (host prop id) -> state; absent = closed */
  containers?: Record<string, ContainerState>;
  /** v1.2: player id -> night vision on */
  nv?: Record<string, boolean>;
  /** v1.2: player id -> salvage pouch (MaterialType -> units), no slot */
  pouches?: Record<string, Record<string, number>>;
  /** v1.2 flashbulb: a fired flash (counts as lit inside its cone while it lasts) */
  flashes?: Record<string, FlashState>;
}

/** Incremental update; null deletes a key. `reset` replaces the whole state (layout rebuild). */
export interface InteractionPatch {
  reset?: InteractionState;
  doors?: Record<number, DoorState>;
  items?: Record<string, ItemState | null>;
  inventories?: Record<string, (string | null)[] | null>;
  active?: Record<string, number | null>;
  lights?: Record<number, boolean>;
  /** full dead list when it changed */
  dead?: string[];
  hidden?: Record<string, string | null>;
  ints?: Record<string, InteractableInfo | null>;
  glows?: Record<string, V3 | null>;
  bodies?: Record<string, BodyState | null>;
  respawns?: Record<string, number | null>;
  hp?: Record<string, number | null>;
  flares?: Record<string, FlareState | null>;
  containers?: Record<string, ContainerState | null>;
  nv?: Record<string, boolean | null>;
  pouches?: Record<string, Record<string, number> | null>;
  flashes?: Record<string, FlashState | null>;
}

/** v1.2 flashbulb flash: lit inside flashRangeM / flashConeDeg (LOS) from p along dir until `until` (server ms) */
export interface FlashState { p: V3; dir: V3; until: number; by: string }

export type IxFxKind =
  | 'smash' | 'throw' | 'swing' | 'hit' | 'horn' | 'door' | 'security' | 'pickup' | 'drop' | 'switch' | 'deny'
  | 'glow' | 'locker' | 'unlock' | 'deposit' | 'revive' | 'medkit' | 'slot'
  /** v1.1 gear: flare ignites, motion sensor armed, adrenaline injected, cursed idol whisper (open=true: a wail), lucky deposit */
  | 'flare' | 'sensor' | 'inject' | 'whisper' | 'lucky'
  /** v1.2: drawer/cabinet opened (soft = eased), materials into the van stash, battery swapped, night vision toggled
   *  (open = on), lock picked, master keycard used, flashbulb fired */
  | 'container' | 'stash' | 'battery' | 'nv' | 'pick' | 'masterkey' | 'flash';

export interface IxResult {
  ok: boolean;
  /** HUD message (denials: "Locked: needs a keycard") */
  msg?: string;
}

export interface InteractionEvents {
  'interaction.patch': InteractionPatch;
  /** a player died: victim client shows the 4 s death card, everyone else a toast */
  'interaction.death': { pid: string; name: string; cause: DeathCause; p: V3 };
  'interaction.revive': { pid: string; by: string | null; how: 'medkit' | 'badge' | 'api'; p: V3; yaw: number; hp: number };
  /** one-shot effects (sfx / animations): door clanks, smashes, swings, pickups */
  'interaction.fx': {
    kind: IxFxKind; p?: V3; pid?: string; id?: string; door?: number; open?: boolean; item?: string;
    /** v1.2: a quiet (eased) door / drawer */
    soft?: boolean;
    /** v1.2: units (stash, battery) */
    count?: number;
    /** v1.2 flashbulb: direction */
    dir?: V3;
  };
}

export interface InteractionReqs {
  /** E on an interactable (door, item, locker, switch, lever, body, ...). hold = the client held E for holdMs */
  'interaction.use': { args: { id: string; hold?: boolean }; result: IxResult };
  /** LMB with the active item: throw / swing / glowstick / medkit / airhorn. dir = camera forward, eye = camera position */
  'interaction.act': { args: { dir: V3; eye?: V3 }; result: IxResult };
  /** G: drop the active slot (or `slot`) */
  'interaction.drop': { args: { slot?: number }; result: IxResult };
  /** 1-4: select the active slot (0..3) */
  'interaction.slot': { args: { slot: number }; result: IxResult };
  /** console operator toggles a security door (5 s cooldown, 12 m clank). open omitted = toggle */
  'interaction.consoleDoor': { args: { id: number; open?: boolean }; result: IxResult & { open?: boolean; cooldownMs?: number } };
  /** v1.2 quiet hold-E on a door/container: on=true after E was held 220 ms, on=false on release; the server times it */
  'interaction.ease': { args: { id: string; on: boolean }; result: IxResult & { t0?: number; ms?: number; off?: boolean; done?: boolean } };
  /** v1.2 night vision (needs 'nvg' in any slot) */
  'interaction.nv': { args: { on: boolean }; result: IxResult & { on?: boolean } };
}

/** server-timed quiet action: commits at t0 + ms (ctx.now clock) unless cancelled */
export interface EaseState {
  by: string; to: boolean; t0: number; ms: number;
  /** v1.2: 'soft' = quiet ease (the door / drawer moves), 'pick' = lockpick (loud, the door stays put),
   *  'force' = security-door hold (loud) */
  kind?: 'soft' | 'pick' | 'force';
}
/** container state; interactable 'cont:<container id>' */
export interface ContainerState {
  /** bitmask of open parts (ContainerPart.idx); 0 = closed */
  open: number;
  by?: string;
  ease?: EaseState;
}
/** v1.2 item event bus (server only, never sent): api.onItemEvent */
export interface ItemEvent {
  kind: 'pickup' | 'acquire' | 'use' | 'consume' | 'deposit' | 'stash' | 'drop';
  pid: string;
  type: string;
  id: string;
  name?: string;
  value?: number;
  count?: number;
  /** pickup of a world-spawned item nobody held before this contract */
  fresh?: boolean;
  /** acquire: how the player got it */
  via?: 'handout' | 'buy' | 'craft' | 'safe' | 'container' | 'api';
  space?: number;
  p?: V3;
  dir?: V3;
}
