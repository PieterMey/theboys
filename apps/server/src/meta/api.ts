// Owner: track (d) Meta. Cross-track server API (module exports; import from '../meta/api.ts').
//   crewSave(crew), awardXp(crew, pid, xp, reason), onShiftEnd(fn), currentOrder(crew)
// plus helpers: fillPlaceholders(text, values) for clue notes, metaState(crew, player?), shift(crew).
import type { Crew } from '../core/types.ts';
import type { CrewSave, PlayerSave } from '@dead-air/shared/saves.ts';
import type { WorkOrder } from '@dead-air/shared/workorder.ts';
import type { MetaShiftReview, MetaState, MetaXpLine } from '@dead-air/shared/messages/meta.ts';
import { S, awardXp as award, runtime, saveCrew, saveOf, view } from './flow.ts';
import { craftView } from './crafting.ts';

export { fillPlaceholders } from './orders.ts';
export { recordStat } from './stats.ts';

/** persist + return the crew save (CrewSave contract) */
export function crewSave(crew: Crew): CrewSave | null {
  const rt = runtime();
  if (!rt) return null;
  saveCrew(crew);
  return rt.store.crew(crew.code);
}

/** add XP to a player's career (persisted); returns the resulting line (level-ups, unlocks) */
export function awardXp(crew: Crew, pid: string, xp: number, reason: string): MetaXpLine | null {
  return award(crew, pid, xp, reason);
}

/** called once per shift end (after the 3rd contract), with the (template) review */
export function onShiftEnd(fn: (crew: Crew, review: MetaShiftReview) => void): void {
  runtime()?.shiftEndFns.push(fn);
}

/** the work order being driven to / played (null in the hub) */
export function currentOrder(crew: Crew): WorkOrder | null {
  return crew.slices.meta ? S(crew).active : null;
}

/** read-only meta view (same as FullState.meta) */
export function metaState(crew: Crew): MetaState {
  return view(crew, null);
}

/** shift numbers: { index, contract (0-based, contracts finished), quota, hauled, balance, quotasMet } */
export function shift(crew: Crew): MetaState['shift'] {
  return view(crew, null).shift;
}

// ---------------------------------------------------------------- v1.2 contract (PLAN.md §13; G4 fills poolAdd/poolView)

/** VanUpgrade ids the crew owns (workshop) */
export function unlocks(crew: Crew): string[] {
  return craftView(crew)?.unlocks.slice() ?? [];
}
export function playerSave(crew: Crew, pid: string): PlayerSave | null {
  const p = crew.players.get(pid);
  return p ? saveOf(p) : null;
}
/** mutate a save and schedule the debounced write */
export function updatePlayerSave(crew: Crew, pid: string, fn: (sv: PlayerSave) => void): boolean {
  const rt = runtime();
  const sv = playerSave(crew, pid);
  if (!rt || !sv) return false;
  fn(sv);
  sv.updatedAt = new Date().toISOString();
  rt.store.putPlayer(sv);
  return true;
}
// Gear pool keyed by save id (G4). Migrating an old live-id owner key: the live id of a save is
// playerIdFromKey(key) for each sv.keys entry (apps/server/src/core/crews.ts: 'p' + base64url(sha256(key)).slice(0, 10)),
// never 'p' + a sha256 hex digest (plan check #24g).
/** G4 fills: add crafted units to pid's pool (cap, stacks); accepts POOL_TYPES + HANDOUT_ONLY */
export function poolAdd(_crew: Crew, _pid: string, _type: string, _units: number): { ok: boolean; reason?: string } {
  return { ok: false, reason: 'Gear pool not ready' };
}
export function poolView(_crew: Crew, _pid: string): { units: Record<string, number>; slots: number; maxSlots: number } {
  return { units: {}, slots: 0, maxSlots: 8 };
}
