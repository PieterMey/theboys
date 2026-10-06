// Owner: track (d) Meta. Cross-track server API (module exports; import from '../meta/api.ts').
//   crewSave(crew), awardXp(crew, pid, xp, reason), onShiftEnd(fn), currentOrder(crew)
// plus helpers: fillPlaceholders(text, values) for clue notes, metaState(crew, player?), shift(crew).
import type { Crew } from '../core/types.ts';
import type { CrewSave } from '@dead-air/shared/saves.ts';
import type { WorkOrder } from '@dead-air/shared/workorder.ts';
import type { MetaShiftReview, MetaState, MetaXpLine } from '@dead-air/shared/messages/meta.ts';
import { S, awardXp as award, runtime, saveCrew, view } from './flow.ts';

export { fillPlaceholders } from './orders.ts';

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
