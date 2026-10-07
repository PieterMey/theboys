// Owner: track (b) Interaction. Cross-track server API (import from '../interaction/api.ts').
// Names in the first block are the agreed contract; the rest are extras other tracks may use.
// Every mutating call batches its changes into the crew's 'interaction.patch' (sent at the end of the next tick, <=33 ms).
import type { Crew, ServerPlayer } from '../core/types.ts';
import type { InteractableInfo } from '@dead-air/shared/interactables.ts';
import type { BodyState, DeathCause, InteractionState, ItemEvent, ItemState } from '@dead-air/shared/messages/interaction.ts';
import type { Vec3 } from '@dead-air/shared/state.ts';
import * as E from './engine.ts';
import type { DeathRecord, DepositFn, DoorFn, InteractFn, MeleeFn, ReviveFn } from './engine.ts';

export type { DeathCause, DeathRecord, InteractFn, MeleeFn, ItemState, InteractableInfo, BodyState };

// ---------------------------------------------------------------- agreed contract

/** door currently open? (unknown id = false) */
export function isDoorOpen(crew: Crew, id: number): boolean {
  return !!E.slice(crew).doors[id]?.open;
}

/** open/close a door (bypasses locks: use for the vault keypad, director slams). by = player id or null. false = no such door */
export function setDoorOpen(crew: Crew, id: number, open: boolean, byPlayerId: string | null): boolean {
  return E.setDoor(crew, id, open, byPlayerId, { force: true });
}

/** room lights on = power && switch && !blackout (&& fixture not broken). Lot and van cab are always lit. */
export function lightsOn(crew: Crew, space: number): boolean {
  return !!E.slice(crew).lights[space];
}

/** force the light switch of a space (or every space) on/off; power and blackout still apply */
export function setLights(crew: Crew, space: number | 'all', on: boolean): void {
  E.setSwitch(crew, space, on);
}

export function isAlive(crew: Crew, pid: string): boolean {
  const pl = crew.players.get(pid);
  return !!pl && pl.alive && !E.slice(crew).dead.includes(pid);
}

/**
 * Kill a player: alive=false (roster), inventory dropped at the body, badge spawned, 'interaction.death' {pid, cause}
 * -> the victim sees the death card "HOUND / heard your SPRINT (9 m)". false if already dead / unknown.
 */
export function kill(crew: Crew, pid: string, cause: { killer: string; reason: string; detail?: string }): boolean {
  return E.killPid(crew, pid, cause);
}

/** revive a dead player at `at` (default: their body), 50% hp */
export function revive(crew: Crew, pid: string, at?: Vec3 | [number, number, number]): boolean {
  return E.reviveSelf(crew, pid, at ?? null, { how: 'api' });
}

/** true if the player carries an item of this type in any inventory slot ('loot' matches any loot tier) */
export function holding(crew: Crew, pid: string, type: string): boolean {
  return E.hasType(E.slice(crew), pid, type);
}

export function hasWalkie(crew: Crew, pid: string): boolean {
  return E.hasType(E.slice(crew), pid, 'walkie');
}

/** give an item (into a free slot; dropped at the player's feet if the inventory is full). Returns the item or null. */
export function giveItem(crew: Crew, pid: string, type: string, opts: Partial<Pick<ItemState, 'count' | 'value' | 'name' | 'lock'>> = {}): ItemState | null {
  return E.giveItemTo(crew, pid, type, opts);
}

/** items in a player's inventory (slot order, empty slots skipped) */
export function itemsOf(crew: Crew, pid: string): ItemState[] {
  return E.itemsOfPid(E.slice(crew), pid);
}

/** called after every death (director peak / retreat, meta death cards) */
export function onDeath(fn: (crew: Crew, pid: string, cause: DeathCause, p: Vec3) => void): void {
  E.addDeathFn(fn);
}

/**
 * Handle E on interactables of a kind owned by your track (lever, keypad, core, console, board, shop, mirror, kennel,
 * leave_lever, note, intercom, or your own kinds). Return true = handled; a string = denial message for the HUD;
 * false = "nothing happens". 'deposit': badges are handled here first, then your handler; if no handler returns
 * true, loot in the inventory is deposited (where='van') and onDeposit listeners run.
 * Register at install time (interactables of a kind with no handler are shown disabled).
 */
export function onInteract(kind: string, fn: (crew: Crew, player: ServerPlayer, targetId: string) => boolean | string | void | { ok: boolean; msg?: string }): void {
  E.onInteractKind(kind, fn as InteractFn);
}

/**
 * Add or update interactables (upsert by id). Layout items of your kinds are already registered with their layout
 * id (e.g. 'lever:0', 'keypad:0', 'console:0') and a default prompt; call this to change prompt/enabled/holdMs or add new ones.
 */
export function registerInteractables(crew: Crew, list: InteractableInfo[]): void {
  E.upsertInteractables(crew, list);
}

// ---------------------------------------------------------------- extras for monsters (c)

/** player is inside a hiding locker */
export function isHidden(crew: Crew, pid: string): boolean {
  return !!E.slice(crew).hidden[pid];
}

/** locker id the player hides in (null if not hidden) */
export function hiddenIn(crew: Crew, pid: string): string | null {
  return E.slice(crew).hidden[pid] ?? null;
}

/** pull a player out of their locker (a monster found them) */
export function unhide(crew: Crew, pid: string): boolean {
  return E.unhidePid(crew, pid);
}

/**
 * Crowbar swings: fn(crew, pid, eyePos, dir) for every LMB swing (2 m reach, ~100 deg arc is yours to test).
 * Return true if it hit something (e.g. frees a Listener grab): the client plays a hit and an 8 m noise is emitted.
 */
export function onMelee(fn: (crew: Crew, pid: string, pos: Vec3, dir: Vec3) => boolean | void): void {
  E.addMeleeFn(fn as MeleeFn);
}

/** Mannequin rule: (x, z) lit by a room light that is on, a flashlight cone (12 m, 25 deg, LOS) or a glowstick within 2 m */
export function litAt(crew: Crew, x: number, z: number): boolean {
  return E.litAtXZ(crew, x, z);
}

/** dropped glowsticks (floor positions) */
export function glowsticks(crew: Crew): Vec3[] {
  return Object.values(E.slice(crew).glows);
}

// ---------------------------------------------------------------- extras for objectives (a) / meta (d)

/** full public state (read-only view) */
export function state(crew: Crew): InteractionState {
  return E.publicState(E.slice(crew));
}

/** deaths this contract (death cards in results): { pid, name, cause, at (server ms), p, revived? } */
export function deaths(crew: Crew): DeathRecord[] {
  return E.slice(crew).deaths.slice();
}

/** badges of dead players nobody brought back (for the 10% badge fine) */
export function unrecoveredBadges(crew: Crew): string[] {
  return E.slice(crew).dead.slice();
}

/** deposit every loot item pid carries into the van (where='van'); returns them (sum .value for the haul) */
export function depositLoot(crew: Crew, pid: string): ItemState[] {
  return E.depositLootOf(crew, pid);
}

/** after loot is deposited (by the built-in deposit or depositLoot) */
export function onDeposit(fn: (crew: Crew, pid: string, items: ItemState[]) => void): void {
  E.addDepositFn(fn as DepositFn);
}

/** total value of loot spawned for this contract (world + held + van) */
export function lootTotal(crew: Crew): number {
  return Object.values(E.slice(crew).items).filter((it) => it.type.startsWith('loot.')).reduce((a, it) => a + (it.value ?? 0), 0);
}

/** loot value currently in the van */
export function vanValue(crew: Crew): number {
  return Object.values(E.slice(crew).items).filter((it) => it.where === 'van' && it.type.startsWith('loot.')).reduce((a, it) => a + (it.value ?? 0), 0);
}

/** spawn an item lying in the world */
export function spawnItem(crew: Crew, type: string, p: Vec3, opts: Partial<Pick<ItemState, 'count' | 'value' | 'name' | 'lock' | 'rot'>> = {}): ItemState {
  return E.spawnWorldItem(crew, type, p, opts);
}

/** delete an item wherever it is (inventory, world, van) */
export function removeItem(crew: Crew, itemId: string): void {
  E.deleteItem(E.slice(crew), itemId);
}

/** remove interactables you registered */
export function removeInteractable(crew: Crew, id: string): void {
  E.dropInteractable(crew, id);
}

/** patch one interactable (prompt / enabled / holdMs) */
export function updateInteractable(crew: Crew, id: string, patch: Partial<InteractableInfo>): boolean {
  return E.patchInteractable(crew, id, patch);
}

/** objectives push power state (alternative to us polling objectives' state(crew).power) */
export function setPower(crew: Crew, powerZone: number, on: boolean): void {
  E.setPowerPush(crew, powerZone, on);
}

/** objectives push the 03:00 blackout */
export function setBlackout(crew: Crew, on: boolean): void {
  E.setBlackoutPush(crew, on);
}

export function onRevive(fn: (crew: Crew, pid: string, how: 'medkit' | 'badge' | 'api', by: string | null) => void): void {
  E.addReviveFn(fn as ReviveFn);
}

/** door opened/closed by anyone (hand, console, API) */
export function onDoor(fn: (crew: Crew, id: number, open: boolean, by: string | null) => void): void {
  E.addDoorFn(fn as DoorFn);
}

/** player hp (100; 50 after a revive; 0 dead) */
export function hp(crew: Crew, pid: string): number {
  return E.slice(crew).hp[pid] ?? 100;
}

/** door id -> open (for nav/audibility doorOpen callbacks): (id) => boolean */
export function doorOpenFn(crew: Crew): (id: number) => boolean {
  const s = E.slice(crew);
  return (id: number) => !!s.doors[id]?.open;
}

/** send pending interaction changes now (normally automatic at the end of the tick) */
export function flushNow(crew: Crew): void {
  E.flush(crew);
}

// ---------------------------------------------------------------- v1.2 contract (PLAN.md §13; stubs until G3 fills them)

const itemEventSubs = new Set<(crew: Crew, e: ItemEvent) => void>();
/** v1.2 item events (server only) */
export function onItemEvent(fn: (crew: Crew, e: ItemEvent) => void): () => void {
  itemEventSubs.add(fn);
  return () => itemEventSubs.delete(fn);
}
/** (b) internal: publish */
export function emitItemEvent(crew: Crew, e: ItemEvent): void {
  for (const f of itemEventSubs) {
    try { f(crew, e); } catch { /* subscriber bug */ }
  }
}
/** deposited materials + mat.* / pouch items in the van cargo rect +-0.6 m; returns and clears */
export function takeVanMaterials(_crew: Crew): Record<string, number> { return {}; }
export function vanMaterials(_crew: Crew): Record<string, number> { return {}; }
export function pouchOf(_crew: Crew, _pid: string): Record<string, number> { return {}; }
/** private item into a closed container (fieldguide pages); false if unknown/open */
export function stockContainer(_crew: Crew, _containerId: string, _spec: { type: string; name?: string; value?: number }): boolean { return false; }
/** programmatic hide (crawl: 'duct:<vent id>'): stance hidden, use/act blocked, monsters + litAt ignore; unhide() ends */
export function hideIn(_crew: Crew, _pid: string, _spotId: string): boolean { return false; }
/** an onInteract handler exists for kind (gate checks) */
export function hasInteractHandler(_kind: string): boolean { return false; }
