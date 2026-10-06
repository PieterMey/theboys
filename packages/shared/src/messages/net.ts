// Owned by track ① Net. Crew/lobby/connection events.
import type { CrewPublic, Phase, FullState } from '../state.ts';
import type { Profile } from '../profile.ts';

export interface NetEvents {
  /** crew roster / readiness / leader changed */
  'crew': CrewPublic;
  /** phase transition; carries the full state for the new phase (layout, orders, slices) */
  'phase': { phase: Phase; state: FullState };
  /** a toast/system line for everyone, e.g. "Sam joined" */
  'notice': { text: string; kind?: 'info' | 'warn' | 'error' };
}

export interface NetReqs {
  'crew.ready': { args: { ready: boolean }; result: { ok: true } };
  'crew.kick': { args: { id: string }; result: { ok: true } };
  'profile.set': { args: { profile: Profile }; result: { ok: true } };
  'consent.set': { args: { transcribe: boolean; mimic: boolean }; result: { ok: true } };
  'claim': { args: { name: string; pin: string }; result: { ok: boolean; level?: number } };
  'admin.createCrew': { args: { code?: string; password?: string }; result: { code: string } };
}
