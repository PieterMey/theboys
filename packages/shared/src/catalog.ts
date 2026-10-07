// Integrator-owned (v1.2), additive only. Ids several v1.2 packages agree on; balance lives in config/balance/*.json.

/** Crafting materials: picked up into the salvage pouch (no slot), deposited at the van, committed to CrewSave.stash at
 *  contract end. Never 'loot.*', so the haul and lootTotal ignore them. */
export const MATERIAL_TYPES = ['mat.scrap', 'mat.wiring', 'mat.chem', 'mat.optics', 'mat.cells', 'mat.relic'] as const;
export type MaterialType = (typeof MATERIAL_TYPES)[number];
export const MATERIAL_LABEL: Readonly<Record<MaterialType, string>> = {
  'mat.scrap': 'Scrap metal', 'mat.wiring': 'Wiring', 'mat.chem': 'Chemicals', 'mat.optics': 'Optics', 'mat.cells': 'Battery cells', 'mat.relic': 'Relic',
};
export function isMaterial(type: string): type is MaterialType {
  return (MATERIAL_TYPES as readonly string[]).includes(type);
}
/** world item a dead or leaving player's pouch drops as (ItemState.mats = contents); never a collection-log entry */
export const POUCH_TYPE = 'mat.pouch';

/** v1.2 gear. Interaction adds ITEM_DEFS only for the ones it implements; a type without ITEM_DEFS is hidden from crafting,
 *  finds, safes and the collection log. */
export const GEAR_V12 = ['battery', 'lockpick', 'masterkey', 'soles', 'nvg', 'flashbulb', 'lure', 'receiver'] as const;
export type GearV12 = (typeof GEAR_V12)[number];

/** one-of-a-kind salvage: type CURIO_TYPE, ItemState.name from CURIOS; at most one per site */
export const CURIO_TYPE = 'loot.curio';
export const CURIOS: readonly string[] = [
  `Founder's fountain pen`, 'Employee of the Month plaque', 'Snow globe (VAN 7)', 'Porcelain doll', 'Music box', 'Dashcam tape: VAN 3',
  'Gold tooth', 'Ouija planchette', 'Signed safety manual', 'Taxidermy owl', 'Wax cylinder recording', 'Brass diving helmet',
];

/** field-note page in a drawer (ItemState.name = page id); picking it up files it in the picker's Field Guide */
export const PAGE_TYPE = 'page';

/** gear that stays in the crew pool after a contract. meta GEAR_TYPES and interaction CARRY_OVER_TYPES = this list.
 *  'soles' is missing on purpose (overshoes wear out at contract end): see HANDOUT_ONLY. */
export const POOL_TYPES: readonly string[] = [
  'walkie', 'crowbar', 'bottle', 'glowstick', 'medkit', 'flashlight_pro', 'flare', 'sensor', 'syringe', 'charm',
  'battery', 'lockpick', 'masterkey', 'nvg', 'flashbulb', 'lure', 'receiver',
];
/** gear that can enter the pool and be handed out (crafted overshoes) but never carries over: meta poolAdd, the hand-out
 *  and meta.loadout accept POOL_TYPES + HANDOUT_ONLY; carry-over (CARRY_OVER_TYPES, collectGear) stays POOL_TYPES */
export const HANDOUT_ONLY: readonly string[] = ['soles'];
/** units per inventory slot for stackable gear (ITEM_DEFS stack; meta hand-out / pool maths). masterkey units = charges */
export const POOL_STACK: Readonly<Record<string, number>> = {
  bottle: 3, glowstick: 5, flare: 3, sensor: 2, battery: 2, lockpick: 3, masterkey: 3, flashbulb: 3, lure: 2, receiver: 5,
};

/** van upgrades: bought at the workbench, persisted in CrewSave.unlocks, shown via level.setVanUpgrades */
export const VAN_UPGRADES = ['bench_tools', 'charging_rack', 'scanner', 'stretcher'] as const;
export type VanUpgrade = (typeof VAN_UPGRADES)[number];

/** Interactable kinds of v1.2 modules (never reuse built-in kinds like 'locker' or 'mirror') -> id prefix.
 *  Interactable id = `${prefix}:${layout item id}` so two modules never collide on one layout item. */
export const V12_KINDS = {
  container: 'cont', // interaction: drawers/cabinets ('cont:prop:41', ref = container id)
  workbench: 'wb', // workshop: van workbench (hub craft, contract scrap)
  stash: 'stash', // workshop: crew stash locker (hub)
  records: 'rec', // meta: personnel-file board on the hub facade
  fieldguide: 'fg', // fieldguide: booklet shelf in the van
  bulletin: 'lore', // fieldguide: hazard bulletin on a lore spot (ref = spot id)
  vent: 'crawl', // players: crawl vent (stretch)
} as const;
export type V12Kind = keyof typeof V12_KINDS;
export function v12Id(kind: V12Kind, itemId: string): string {
  return `${V12_KINDS[kind]}:${itemId}`;
}

/** desktop shell -> page hotkey (window.deadAirDesktop.onHotkey); the web client never reads Ctrl */
export interface DesktopHotkey { action: 'crouch'; down: boolean }

// Frozen for v1.2: interactables.ts LOOT_NAMES strings key crafting.json 'salvage'. Never rename/remove; add only.
