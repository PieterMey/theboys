// Owned by track ① Net. Crew/lobby/connection events.
import type { CrewPublic, Phase, FullState, Vec3 } from '../state.ts';
import type { Profile } from '../profile.ts';

export interface NetEvents {
  /** crew roster / readiness / leader changed */
  'crew': CrewPublic;
  /** phase transition; carries the full state for the new phase (layout, orders, slices) */
  'phase': { phase: Phase; state: FullState };
  /** a toast/system line for everyone, e.g. "Sam joined" */
  'notice': { text: string; kind?: 'info' | 'warn' | 'error' };
  /**
   * Sent ONLY to the player whose pose was rejected (too fast, through a wall, teleport):
   * the authoritative position to snap the local controller back to. Rate-limited (~3/s).
   */
  'net.correct': { p: Vec3; yaw: number; reason: 'speed' | 'wall' | 'solid' | 'grid'; seq: number };
}

export interface NetReqs {
  'crew.ready': { args: { ready: boolean }; result: { ok: true } };
  'crew.kick': { args: { id: string }; result: { ok: true } };
  'profile.set': { args: { profile: Profile }; result: { ok: true } };
  'consent.set': { args: { transcribe: boolean; mimic: boolean }; result: { ok: true } };
  'claim': { args: { name: string; pin: string }; result: { ok: boolean; level?: number } };
  'admin.createCrew': { args: { code?: string; password?: string }; result: { code: string } };
  /** invite link for this crew: https://<quick tunnel>/#CODE, or null when no tunnel is running */
  'net.invite': { args: Record<string, never>; result: { url: string | null; base: string | null } };
  /**
   * Dev/test only (NODE_ENV=development or test): move this player on the server so the next poses validate
   * from there. The client calls it automatically when the test API teleports.
   */
  'dbg.net.teleport': { args: { x: number; z: number; y?: number; yaw?: number }; result: { ok: true } };
}
