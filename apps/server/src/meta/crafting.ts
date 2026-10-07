// Owner: workshop (v1.2). Stash, upgrades, scrap, stash locker. Keep every export/signature.
import type { Crew, ServerContext } from '../core/types.ts';
import type { InteractableInfo } from '@dead-air/shared/interactables.ts';

export interface CraftSave { stash: Record<string, number>; unlocks: string[] }
/** meta install: meta.workbench/craft/upgrade, IX.onInteract('workbench' | 'stash'), dbg.workshop.* */
export function installCrafting(_ctx: ServerContext): void {}
/** S(crew) restore (null = new crew) */
export function loadCraft(_crew: Crew, _saved: CraftSave | null): void {}
/** saveCrew: fields to write; null = inactive -> meta keeps the previous save's stash/unlocks */
export function craftSave(_crew: Crew): CraftSave | null { return null; }
/** view(): MetaState.stash/unlocks (null = omit) */
export function craftView(_crew: Crew): CraftSave | null { return null; }
/** hubInteractables (hub + contract) */
export function workbenchInteractables(_crew: Crew): InteractableInfo[] { return []; }
export function craftContractStart(_crew: Crew): void {}
/** finishContract, before results: commit van materials + scrap unless wiped/voided */
export function craftContractEnd(_crew: Crew, _outcome: string, _participated: readonly string[]): { materials: Record<string, number>; scrapped: number } {
  return { materials: {}, scrapped: 0 };
}
/** continueFromResults when fired (crafting.json firedWipes true) */
export function craftFired(_crew: Crew): void {}
