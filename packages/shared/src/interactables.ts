// Owned by P2 track (b) Interaction; read by all. Interactable kinds a player can target with E / LMB,
// plus the item catalog (names, stacks, LMB use) shared by server and client.
import type { InteractionPatch, InteractionState } from './messages/interaction.ts';

export type InteractableKind =
  | 'door' | 'lever' | 'keypad' | 'loot' | 'core' | 'locker' | 'switch' | 'console' | 'board' | 'shop'
  | 'mirror' | 'leave_lever' | 'deposit' | 'body' | 'badge' | 'item' | 'note' | 'intercom' | 'kennel';

export interface InteractableInfo {
  id: string;
  /** one of InteractableKind; other tracks may register their own kinds (string) via onInteract */
  kind: InteractableKind | (string & {});
  /** world position (m) of the interaction point */
  p: [number, number, number];
  /** prompt shown in the HUD, e.g. "Pull lever (needs a partner)" */
  prompt: string;
  /** false = shown but disabled (e.g. no power) */
  enabled: boolean;
  /** hold E this long (ms) before it triggers (client shows a ring, then sends interaction.use {hold:true}) */
  holdMs?: number;
  /** targeting sphere radius (m); default per kind (INTERACT_RADIUS) */
  r?: number;
  /** source reference: layout item id, door id, item id, player id (bodies) */
  ref?: string | number;
}

/** Default targeting sphere radius per kind (m). Doors use their own box. */
export const INTERACT_RADIUS: Record<string, number> = {
  lever: 0.3, keypad: 0.25, switch: 0.2, intercom: 0.25, note: 0.25, locker: 0.55, console: 0.7, board: 0.7,
  shop: 0.7, mirror: 0.5, leave_lever: 0.3, deposit: 0.8, body: 0.6, core: 0.45, kennel: 0.9, item: 0.3,
  loot: 0.32, badge: 0.25,
};

/** Inventory slots per player */
export const INV_SLOTS = 4;

export type ItemUse = 'throw' | 'swing' | 'glow' | 'revive' | 'radio' | 'horn' | 'none';

export interface ItemDef {
  name: string;
  /** 3-letter HUD tag */
  short: string;
  use: ItemUse;
  /** stack size when bought / spawned (count field) */
  stack?: number;
  /** placeholder colour (#rrggbb) */
  color: string;
  /** asset key of a prop model, if any */
  prop?: string;
  loot?: boolean;
  /** HUD hint for the active slot */
  hint?: string;
}

export const ITEM_DEFS: Record<string, ItemDef> = {
  bottle: { name: 'Bottle', short: 'BTL', use: 'throw', stack: 3, color: '#2f6b3a', prop: 'prop.bottles', hint: 'LMB throw (15 m smash: Hound bait)' },
  crowbar: { name: 'Crowbar', short: 'BAR', use: 'swing', color: '#a8322a', prop: 'prop.crowbar', hint: 'LMB swing (frees a grabbed teammate)' },
  glowstick: { name: 'Glowsticks', short: 'GLO', use: 'glow', stack: 5, color: '#39ff6a', hint: 'LMB drop a glowstick (keeps things lit)' },
  medkit: { name: 'Medkit', short: 'MED', use: 'revive', color: '#e9e4da', prop: 'prop.medical_box', hint: 'LMB / E at a body: revive (within 30 s)' },
  walkie: { name: 'Walkie', short: 'RAD', use: 'radio', color: '#3a3f44', prop: 'prop.radio', hint: 'Hold Q to talk on the radio' },
  airhorn: { name: 'Airhorn', short: 'HRN', use: 'horn', color: '#d63b2f', loot: true, hint: 'LMB: HONK (30 m, wakes the Hound)' },
  keycard: { name: 'Keycard', short: 'KEY', use: 'none', color: '#f2c230', hint: 'Opens the locked wing door' },
  badge: { name: 'Badge', short: 'ID', use: 'none', color: '#5dade2', hint: 'Bring it to the van deposit to respawn them' },
  'loot.small': { name: 'Salvage', short: '$', use: 'none', color: '#c9a227', loot: true, hint: 'Deposit in the van' },
  'loot.medium': { name: 'Salvage', short: '$$', use: 'none', color: '#d08c2a', loot: true, hint: 'Deposit in the van' },
  'loot.heavy': { name: 'Heavy salvage', short: '$$$', use: 'none', color: '#e0662b', loot: true, hint: 'Deposit in the van' },
};

export const LOOT_TIER_TYPES = ['loot.small', 'loot.medium', 'loot.heavy'] as const;

/** Flavour names per loot tier (picked deterministically per item). */
export const LOOT_NAMES: readonly (readonly string[])[] = [
  ['Pocket watch', 'Brass key ring', 'Old camera', 'Gas mask', 'Circuit board', 'Hip flask', 'Cassette tape', 'Dog tags', 'Reading glasses', 'Tin of buttons'],
  ['Tool chest', 'Jerrycan', 'Radio set', 'Typewriter', 'Medical case', 'Fuse box', 'Brass lamp', 'Film projector'],
  ['Server blade rack', 'Generator coil', 'Safe deposit box', 'Bronze bust', 'Cryo canister'],
];

export function itemDef(type: string): ItemDef {
  return ITEM_DEFS[type] ?? { name: type, short: '?', use: 'none', color: '#888888' };
}

/** HUD label: "Bottle x3", "Pocket watch ($24)", "Sam's badge" */
export function itemLabel(it: { type: string; name?: string; count?: number; value?: number }): string {
  const d = itemDef(it.type);
  const base = it.name ?? d.name;
  if (d.stack && (it.count ?? 1) > 1) return `${base} x${it.count}`;
  if (d.loot && (it.value ?? 0) > 0) return `${base} ($${it.value})`;
  return base;
}

// ---------------------------------------------------------------- patch application (client mirror + test bots)

export function emptyInteractionState(): InteractionState {
  return { doors: {}, items: {}, inventories: {}, lights: {}, dead: [], hidden: {}, active: {}, ints: {}, glows: {}, bodies: {}, respawns: {}, hp: {} };
}

function mergeMap<V>(target: Record<string | number, V>, src: Record<string | number, V | null> | undefined): void {
  if (!src) return;
  for (const [k, v] of Object.entries(src)) {
    if (v === null || v === undefined) delete target[k];
    else target[k] = v as V;
  }
}

/** Apply an 'interaction.patch' in place. Returns the (same or reset) state object. */
export function applyInteractionPatch(st: InteractionState, p: InteractionPatch): InteractionState {
  if (p.reset) {
    const r = p.reset;
    for (const k of Object.keys(st) as (keyof InteractionState)[]) delete (st as unknown as Record<string, unknown>)[k];
    Object.assign(st, emptyInteractionState(), r, { dead: [...(r.dead ?? [])] });
  }
  st.doors ??= {}; st.items ??= {}; st.inventories ??= {}; st.lights ??= {}; st.hidden ??= {}; st.active ??= {};
  st.ints ??= {}; st.glows ??= {}; st.bodies ??= {}; st.respawns ??= {}; st.hp ??= {}; st.dead ??= [];
  mergeMap(st.doors, p.doors);
  mergeMap(st.items, p.items);
  mergeMap(st.inventories, p.inventories);
  mergeMap(st.active, p.active);
  mergeMap(st.lights, p.lights);
  mergeMap(st.hidden, p.hidden);
  mergeMap(st.ints, p.ints);
  mergeMap(st.glows, p.glows);
  mergeMap(st.bodies, p.bodies);
  mergeMap(st.respawns, p.respawns);
  mergeMap(st.hp, p.hp);
  if (p.dead) st.dead = [...p.dead];
  return st;
}
