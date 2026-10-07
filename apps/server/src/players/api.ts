// Owner: players-stealth (v1.2). Cross-package server API of the players module (PLAN.md §13). Safe to import from
// anywhere: no runtime state until players/index.ts binds the real reading at install.
import type { Crew } from '../core/types.ts';
import { STANCE } from '@dead-air/shared/state.ts';

type StanceFn = (crew: Crew, pid: string) => number;
let impl: StanceFn | null = null;

/** players install (G1): bind the server's stealth stance reading */
export function bindStealthStance(fn: StanceFn | null): void {
  impl = fn;
}

/**
 * v1.2 (plan check #6): pid's stance as the server judges it for stealth, a STANCE value, never the raw claim. A crouch
 * claim above crouchMaxSpeed for crouchOverSpeedSec (seq-window speed) reads as STANCE.stand (walking), any speed above
 * noiseSprintSpeed as STANCE.sprint, and hidden only while interaction's isHidden is true. Monsters' crouch sight and
 * low cover (G2) use this. Contract stub until G1 binds it: the claimed pose.stance.
 */
export function stealthStance(crew: Crew, pid: string): number {
  if (impl) return impl(crew, pid);
  return crew.players.get(pid)?.pose.stance ?? STANCE.stand;
}
