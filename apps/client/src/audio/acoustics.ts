// Owner: env-audio (v1.2). Room acoustics, pure (unit-tested in tests/audio/acoustics.test.ts):
// - the per-sound reverb send of OCCLUDED sounds (ambience, paranormal, synth) from the sound's room size, floor
//   surface (level.surfaceAt, else floorSurface), site theme and mod:echoes, its distance and the walls in between;
// - the listener-room IR blend (0 = small dry room, 1 = hall) and the reverb return level.
// Settings come from config/balance/audio.json (config.ts), never voice.json.
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import { floorSurface, themeOf } from '@dead-air/shared/procgen/themes.ts';
import type { AudioCfg, ReverbCfg } from './config.ts';
import { occlusionParams } from './occlusion.ts';

export interface RoomInfo {
  space: number;
  /** m^3 (rect area x wall height; the open lot counts 12 m high) */
  volume: number;
  /** no ceiling (the outside lot) */
  open: boolean;
  corridor: boolean;
  surface: string;
  theme: string;
  /** mod:echoes on this layout */
  echoes: boolean;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const fin = (v: number, d: number): number => (Number.isFinite(v) ? v : d);

/** space id at world (x, z) or -1 (owner grid; 1 m cells) */
export function spaceAt(L: Pick<LevelLayout, 'W' | 'H' | 'owner'>, x: number, z: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return -1;
  const cx = Math.floor(x), cz = Math.floor(z);
  if (cx < 0 || cz < 0 || cx >= L.W || cz >= L.H) return -1;
  const s = L.owner[cz * L.W + cx];
  return typeof s === 'number' ? s : -1;
}

/** acoustic description of a space; surface = level.surfaceAt(x, z) when known, else the space's floorSurface */
export function roomInfo(L: LevelLayout, space: number, surface?: string | null): RoomInfo | null {
  const s = L.spaces?.[space];
  if (!s) return null;
  const open = !!s.open || s.kind === 'outside';
  const h = open ? 12 : Math.max(2, fin(L.wallH, 3));
  const volume = Math.max(1, fin(s.rect.w * s.rect.h, 1) * h);
  let surf = surface ?? null;
  if (!surf) {
    try { surf = floorSurface(L, space); } catch { surf = 'concrete'; }
  }
  return {
    space, volume, open, corridor: s.kind === 'corridor', surface: surf,
    theme: themeOf(L), echoes: (L.metrics?.['mod:echoes'] ?? 0) > 0,
  };
}

/** the room around (x, z): its space, or the sealed van cab (solid cells: no space) as a tiny dry metal room */
export function roomAtXZ(L: LevelLayout, x: number, z: number, surface?: string | null): RoomInfo | null {
  const sp = spaceAt(L, x, z);
  if (sp >= 0) return roomInfo(L, sp, surface);
  const cab = L.van?.cab;
  if (cab && x >= cab.x && x <= cab.x + cab.w && z >= cab.y && z <= cab.y + cab.h) {
    return { space: -1, volume: Math.max(1, cab.w * cab.h * 1.6), open: false, corridor: false, surface: 'metal', theme: themeOf(L), echoes: false };
  }
  return null;
}

/** room size factor: (volume / sizeRefM3)^sizeExp, clamped */
export function sizeK(volume: number, c: ReverbCfg): number {
  const v = Number.isFinite(volume) && volume > 0 ? volume : c.sizeRefM3;
  return clamp(Math.pow(v / Math.max(1, c.sizeRefM3), c.sizeExp), c.sizeMin, c.sizeMax);
}

/** base reverb send of a room (before distance and walls), in [min, max] */
export function roomReverb(room: RoomInfo | null, c: ReverbCfg): number {
  if (!room) return clamp(c.base, c.min, c.max);
  let k = c.base * sizeK(room.volume, c) * (c.surface[room.surface] ?? 1) * (c.theme[room.theme] ?? 1);
  if (room.corridor) k *= c.corridor;
  if (room.open) k *= c.outdoor;
  if (room.echoes) k *= c.echoes;
  return clamp(fin(k, c.base), c.min, c.max);
}

/**
 * reverb send of one occluded sound: its room's reverb, wetter with distance (the reverberant field outlasts the
 * direct path), fading gently far away, and damped through walls by occlusionGain^throughWall. In [0, max].
 */
export function reverbSend(room: RoomInfo | null, distM: number, occlusionGain: number, c: ReverbCfg): number {
  const d = Math.max(0, fin(distM, 0));
  const og = clamp(fin(occlusionGain, 1), 0, 1);
  const wetter = 1 + c.distBoost * Math.min(1, d / Math.max(0.1, c.distBoostM));
  const fade = 1 / (1 + Math.max(0, d - c.distRefM) / Math.max(0.1, c.distRolloffM));
  const through = og >= 1 ? 1 : Math.pow(og, Math.max(0, c.throughWall));
  return clamp(fin(roomReverb(room, c) * wetter * fade * through, 0), 0, c.max);
}

/** listener-room IR blend: 0 = small dry room IR, 1 = hall IR (v1.1 = 1, also when the room is unknown) */
export function irBlend(room: RoomInfo | null, c: ReverbCfg): number {
  if (!room) return 1;
  if (room.open) return clamp(c.irOutdoor, 0, 1);
  const lo = Math.max(1, c.irSmallM3), hi = Math.max(lo + 1, c.irHallM3);
  let m = clamp(Math.log(Math.max(1, room.volume) / lo) / Math.log(hi / lo), 0, 1);
  if (room.corridor) m = Math.max(m, clamp(c.irCorridor, 0, 1));
  const hard = c.surface[room.surface] ?? 1;
  if (hard > 1.1) m = Math.min(1, m + 0.1);
  if (room.echoes) m = Math.min(1, m + 0.3);
  return clamp(fin(m, 1), 0, 1);
}

/** reverb return level for the listener's room (1 = v1.1) */
export function wetLevel(room: RoomInfo | null, c: ReverbCfg): number {
  let w = c.wet;
  if (room?.open) w *= c.wetOutdoor;
  if (room?.echoes) w *= c.wetEchoes;
  return clamp(fin(w, 1), 0, 2);
}

/** occlusion of an occluded sound: lowpass cutoff + gain from audio.json (occlusionLowpassHz, occlusionPerWallDb) */
export function occlusionOf(walls: number, cfg: Pick<AudioCfg, 'occlusionLowpassHz' | 'occlusionPerWallDb'>): { freq: number; gain: number } {
  const w = clamp(fin(walls, 0), 0, 8);
  const o = occlusionParams(w, cfg.occlusionLowpassHz, cfg.occlusionPerWallDb);
  return { freq: clamp(fin(o.freq, 20000), 20, 22000), gain: clamp(fin(o.gain, 1), 0, 1) };
}

/** the v1.1 lowpass every other positional sound keeps (gain untouched): audio.json legacyLowpassHz */
export function legacyLowpass(walls: number, cfg: Pick<AudioCfg, 'legacyLowpassHz'>): number {
  const w = clamp(fin(walls, 0), 0, 8);
  return clamp(fin(occlusionParams(w, cfg.legacyLowpassHz, 0).freq, 20000), 20, 22000);
}
