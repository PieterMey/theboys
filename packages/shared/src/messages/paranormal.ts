// Owner: env-paranormal (v1.2). Every effect carries a server 'at' time and a seed; residue re-sent on reconnect.
import type { Vec3 } from '../state.ts';

export type ParanormalKind =
  | 'dark_walk' | 'revive' | 'mirror_writing' | 'mirror_figure' | 'presence' | 'silhouette' | 'cold_spot' | 'knock'
  | 'handle_rattle' | 'poltergeist' | 'object_fall' | 'footprints' | 'brownout_breath' | 'radio_on' | 'phone_ring' | 'dead_poke';
export type ParanormalData = Record<string, number | string | boolean | number[] | string[] | number[][]>;
export interface ParanormalEvent {
  id: number;
  kind: ParanormalKind;
  tier: 0 | 1 | 2;
  /** server ms (ctx.now) the effect starts, >= emit + 250; clients use world.serverNow() */
  at: number;
  ms: number;
  seed: number;
  /** -1 = several / none */
  space: number;
  p?: Vec3;
  yaw?: number;
  /** 'light:12' | 'door:7' | 'prop:31' | 'clutter:88' | lore spot id */
  ref?: string;
  /** only these players render it */
  to?: string[];
  data?: ParanormalData;
  persist?: boolean;
}
export interface ParanormalEvents {
  'paranormal.event': ParanormalEvent;
  'paranormal.end': { id: number; reason: 'seen' | 'lit' | 'interrupted' | 'timeout' };
  /** mirror writing: reveal strokes from server time `at` (first witness) */
  'paranormal.reveal': { id: number; at: number };
}
export interface ParanormalReqs {
  'paranormal.sync': { args: Record<string, never> | undefined; result: { residue: ParanormalEvent[]; active: ParanormalEvent[]; now: number } };
  'paranormal.seen': { args: { id: number; end?: boolean }; result: { ok: boolean } };
  /** stretch, off */
  'paranormal.poke': { args: { kind: 'knock' | 'brownout' | 'write'; callsign?: string }; result: { ok: boolean; cooldownMs?: number } };
}

// ---------------------------------------------------------------- v1.2 additions (env-paranormal, additive)

/** fixed mirror phrases: mirror writing is only ever a callsign, a roster name or one of these (never transcripts) */
export const PARANORMAL_PHRASES = ['IT HEARS', 'NOT ALONE', 'COUNT AGAIN'] as const;

/** roster name as it may appear in mirror writing: A-Z 0-9 space ' -, collapsed, <= 12 chars ('' = unusable) */
export function mirrorName(name: string): string {
  const s = String(name ?? '').toUpperCase().replace(/[^A-Z0-9 '-]/g, '').replace(/\s+/g, ' ').trim();
  return s.slice(0, 12).trim();
}

/**
 * ParanormalEvent.data keys per kind (all optional for forward compatibility; clients ignore unknown keys):
 * - dark_walk: lights string[] (fixture item ids in death order), stepMs, dieMs, spaces number[] (kill order),
 *   killAt number[] (ms after `at` when each space's last fixture dies), dead number[] (residue: spaces still dark)
 * - revive: lights string[] (fixture ids of `space`), walk (dark_walk id)
 * - mirror_writing: mirror (item id), text, fog, fogMs, revealMs, revealAt (server ms, once revealed)
 * - mirror_figure: mirrors string[], behind (m), side (m), holdMs, nearM (sent only to the armed player)
 * - presence: interf (T2 beam interference), litM, litMs, approachM, variant
 * - silhouette: room (lit space id behind the figure), end (space id beyond the corridor end, -1 = outside the map),
 *   brownMs, depth, approachM
 * - knock / handle_rattle: door (door id, -1 = locker), pattern ('wood' | 'metal' | 'locker'), count, amp, rattle
 * - poltergeist: key, from number[] [x, y, z, rot], to number[] [x, y, z, rot]
 * - object_fall: key, from number[] [x, y, z, rot], to number[] [x, z, yaw], tilt [ax, az] (unit axis), angle
 * - footprints: pts number[][] ([x, z, yaw] per print), stepMs, fadeMs, toLore (bool)
 * - cold_spot: r, density, frost
 * - brownout_breath: depth, puffs
 */
