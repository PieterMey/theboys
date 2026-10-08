// Owned by P2 track (b) Interaction; read by all. Interactable kinds a player can target with E / LMB,
// plus the item catalog (names, stacks, LMB use) shared by server and client.
import type { InteractionPatch, InteractionState } from './messages/interaction.ts';
import { MATERIAL_LABEL, MATERIAL_TYPES, PAGE_TYPE, POUCH_TYPE } from './catalog.ts';

export type InteractableKind =
  | 'door' | 'lever' | 'keypad' | 'loot' | 'core' | 'locker' | 'switch' | 'console' | 'board' | 'shop'
  | 'mirror' | 'leave_lever' | 'deposit' | 'body' | 'badge' | 'item' | 'note' | 'intercom' | 'kennel'
  /** v1.2: openable drawer / cabinet / tool chest (id 'cont:<host prop id>', ref = container id) */
  | 'container';

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
  /** v1.2: client sub-line with {item} = active slot's label, e.g. '{item} · no longer counts toward the quota' */
  heldNote?: string;
}

/** Default targeting sphere radius per kind (m). Doors use their own box. */
export const INTERACT_RADIUS: Record<string, number> = {
  lever: 0.3, keypad: 0.25, switch: 0.2, intercom: 0.25, note: 0.25, locker: 0.55, console: 0.7, board: 0.7,
  shop: 0.7, mirror: 0.5, leave_lever: 0.3, deposit: 0.8, body: 0.6, core: 0.45, kennel: 0.9, item: 0.3,
  loot: 0.32, badge: 0.25, container: 0.32,
};

/** Inventory slots per player */
export const INV_SLOTS = 4;

export type ItemUse = 'throw' | 'swing' | 'glow' | 'revive' | 'radio' | 'horn' | 'none'
  /** v1.1 gear: LMB throws a burning flare / places a motion sensor / injects adrenaline */
  | 'flare' | 'sensor' | 'inject'
  /** v1.2 gear: LMB swaps in a fresh battery / fires a flashbulb */
  | 'battery' | 'flash';

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
  /** short line under the pick-up prompt / passive effect while carried */
  note?: string;
  /** gear tier (1 = standard issue, 2 = pro / special) */
  tier?: 1 | 2;
  /** v1.2: stack count unit for the HUD label ('charge' -> "Master keycard (3 charges)") */
  unit?: string;
}

/** v1.2 world / HUD colour per crafting material */
export const MATERIAL_COLOR: Readonly<Record<string, string>> = {
  'mat.scrap': '#9a9fa3', 'mat.wiring': '#d0773a', 'mat.chem': '#d9d24c', 'mat.optics': '#8fd3ff', 'mat.cells': '#6fe06a', 'mat.relic': '#b48cff',
};

export const ITEM_DEFS: Record<string, ItemDef> = {
  bottle: { name: 'Bottle', short: 'BTL', use: 'throw', stack: 3, color: '#2f6b3a', prop: 'prop.bottles', hint: 'LMB throw (15 m smash: Hound bait)' },
  crowbar: { name: 'Crowbar', short: 'BAR', use: 'swing', color: '#a8322a', prop: 'prop.crowbar', hint: 'LMB swing (frees a grabbed teammate)' },
  glowstick: { name: 'Glowsticks', short: 'GLO', use: 'glow', stack: 5, color: '#39ff6a', hint: 'LMB drop a glowstick (keeps things lit)' },
  medkit: { name: 'Medkit', short: 'MED', use: 'revive', color: '#e9e4da', prop: 'prop.medical_box', hint: 'LMB / E at a body: revive (within 30 s)' },
  walkie: { name: 'Walkie', short: 'RAD', use: 'radio', color: '#3a3f44', prop: 'prop.radio', hint: 'Hold Q to talk on the radio' },
  airhorn: { name: 'Airhorn', short: 'HRN', use: 'horn', color: '#d63b2f', hint: 'LMB: HONK (30 m, wakes the Hound)' },
  keycard: { name: 'Keycard', short: 'KEY', use: 'none', color: '#f2c230', hint: 'Opens the locked wing door' },
  badge: { name: 'Badge', short: 'ID', use: 'none', color: '#5dade2', hint: 'Bring it to the van deposit to respawn them' },
  // v1.1 gear pack (shop) and special finds (rare, deep rooms). Passive items work from any slot.
  flashlight_pro: { name: 'Pro Flashlight', short: 'PRO', use: 'none', color: '#bfe3ff', tier: 2, hint: 'Passive (any slot): LED beam, brighter + wider, 2x battery', note: 'tier II LED beam: brighter, wider, twice the battery' },
  flare: { name: 'Flares', short: 'FLR', use: 'flare', stack: 3, color: '#ff3b2f', tier: 2, hint: 'LMB throw a flare (red light for 60 s, keeps things lit)', note: 'throw it: a red light for 60 s' },
  sensor: { name: 'Motion sensor', short: 'MOT', use: 'sensor', stack: 2, color: '#62e0c4', tier: 2, hint: 'LMB place: the van console shows movement within 6 m', note: 'the van console shows movement within 6 m' },
  syringe: { name: 'Adrenaline syringe', short: 'ADR', use: 'inject', color: '#ffd23f', tier: 2, hint: 'LMB inject: 15 s of sprint without stamina drain', note: '15 s of sprint without getting tired' },
  charm: { name: 'Lucky charm', short: 'LCK', use: 'none', color: '#6fdc6a', tier: 2, hint: 'Passive (any slot): loot you deposit counts +10%', note: 'carry it to the van: your deposits count +10%' },
  'loot.idol': { name: 'Cursed idol', short: 'IDL', use: 'none', color: '#a070ff', loot: true, tier: 2, hint: 'It whispers. Every monster hears where you are. Get it to the van', note: 'worth a fortune. It whispers: every monster will hear where you are' },
  'loot.small': { name: 'Salvage', short: '$', use: 'none', color: '#c9a227', loot: true, hint: 'Deposit in the van' },
  'loot.medium': { name: 'Salvage', short: '$$', use: 'none', color: '#d08c2a', loot: true, hint: 'Deposit in the van' },
  'loot.heavy': { name: 'Heavy salvage', short: '$$$', use: 'none', color: '#e0662b', loot: true, hint: 'Deposit in the van' },
  // v1.2 gear (findable in deep rooms / drawers / safes, craftable at the van workbench). Passive items work from any slot.
  battery: { name: 'Battery', short: 'BAT', use: 'battery', stack: 2, color: '#e9c64a', tier: 1, hint: 'LMB: swap in a fresh battery (flashlight back to 100%)', note: 'LMB swaps it in: your light back to 100%' },
  lockpick: { name: 'Lockpicks', short: 'PIK', use: 'none', stack: 3, color: '#b7b0a2', tier: 1, hint: 'Hold E on a locked door: pick the lock (5 s, loud)', note: 'hold E on a locked door: 5 s and 6 m of noise' },
  masterkey: { name: 'Master keycard', short: 'MKY', use: 'none', stack: 3, unit: 'charge', color: '#ff8f3a', tier: 2, hint: 'E: any locked door opens; a security door opens without the clank (1 charge)', note: 'any locked door, or a security door without the clank' },
  soles: { name: 'Soft overshoes', short: 'SOL', use: 'none', color: '#8aa1b4', tier: 1, hint: 'Passive (any slot): your footsteps carry less far · worn out after this contract', note: 'quieter footsteps (they wear out after this contract)' },
  nvg: { name: 'Night-vision module', short: 'NVG', use: 'none', color: '#5cff7a', tier: 2, hint: 'Passive (any slot): N toggles night vision (flashlight off, 2x battery)', note: 'N: see in the dark · no flashlight · twice the battery' },
  flashbulb: { name: 'Flashbulbs', short: 'FLB', use: 'flash', stack: 3, color: '#fff2c2', tier: 2, hint: 'LMB: a blinding flash (14 m cone, a 6 m pop)', note: 'LMB: a blinding flash that makes them flinch' },
  'loot.curio': { name: 'Curio', short: 'CUR', use: 'none', color: '#d6a63f', loot: true, tier: 2, hint: 'One of a kind. Deposit in the van', note: 'one of a kind: the Company pays well for these' },
  // crafting materials: picked up into the salvage pouch (no slot), deposited at the van into the crew stash
  ...Object.fromEntries(MATERIAL_TYPES.map((t) => [t, {
    name: MATERIAL_LABEL[t], short: t.slice(4, 7).toUpperCase(), use: 'none' as const, stack: 1, color: MATERIAL_COLOR[t],
    note: 'crafting material: goes in your salvage pouch',
  }])),
  [POUCH_TYPE]: { name: 'Salvage pouch', short: 'PCH', use: 'none', color: '#8a7350', note: 'crafting materials: they go in your pouch' },
  [PAGE_TYPE]: { name: 'Field-note page', short: 'PG', use: 'none', color: '#e8dfc6', note: 'it files itself in your Field Guide' },
};

export const LOOT_TIER_TYPES = ['loot.small', 'loot.medium', 'loot.heavy'] as const;

/**
 * Shop packs (config/balance/meta.json shop entries use these as their 'type'): meta hands out one unit per purchase via
 * giveItem(pack), and interaction converts it into the real item (stacks merge into one slot). A pack id is never held,
 * so meta's top-up hand-out can't confuse a new purchase with gear the player still carries.
 */
export const GEAR_PACKS: Record<string, { type: string; count?: number }> = {
  'pro-flashlight': { type: 'flashlight_pro' },
  flares: { type: 'flare', count: 3 },
  'motion-sensors': { type: 'sensor', count: 2 },
};

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
  if (d.unit && d.stack) return `${base} (${it.count ?? 1} ${d.unit}${(it.count ?? 1) === 1 ? '' : 's'})`;
  if (d.stack && (it.count ?? 1) > 1) return `${base} x${it.count}`;
  if (d.loot && (it.value ?? 0) > 0) return `${base} ($${it.value})`;
  return base;
}

// ---------------------------------------------------------------- patch application (client mirror + test bots)

export function emptyInteractionState(): InteractionState {
  return {
    doors: {}, items: {}, inventories: {}, lights: {}, dead: [], hidden: {}, active: {}, ints: {}, glows: {}, bodies: {}, respawns: {}, hp: {}, flares: {},
    containers: {}, nv: {}, pouches: {}, flashes: {},
  };
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
  st.ints ??= {}; st.glows ??= {}; st.bodies ??= {}; st.respawns ??= {}; st.hp ??= {}; st.dead ??= []; st.flares ??= {};
  st.containers ??= {}; st.nv ??= {}; st.pouches ??= {}; st.flashes ??= {};
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
  mergeMap(st.flares, p.flares);
  mergeMap(st.containers, p.containers);
  mergeMap(st.nv, p.nv);
  mergeMap(st.pouches, p.pouches);
  mergeMap(st.flashes, p.flashes);
  if (p.dead) st.dead = [...p.dead];
  return st;
}
