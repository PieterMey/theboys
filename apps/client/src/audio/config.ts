// Owner: env-audio (v1.2). config/balance/audio.json (ctx.balance.audio) with defaults: every key is optional and a
// bad value falls back to its default, so a half-edited balance file never breaks the audio graph. The audio code
// reads occlusion and reverb settings from here only (never voice.json).

export interface ReverbCfg {
  /** send of a reference room (sizeRefM3, lino, facility) */
  base: number;
  min: number;
  max: number;
  sizeRefM3: number;
  /** send ~ (volume / sizeRefM3)^sizeExp, clamped to [sizeMin, sizeMax] */
  sizeExp: number;
  sizeMin: number;
  sizeMax: number;
  /** multipliers: corridors flutter, the lot has no ceiling, mod:echoes */
  corridor: number;
  outdoor: number;
  echoes: number;
  /** the reverb of a source fades gently with distance (1 / (1 + (d - distRefM) / distRolloffM)) ... */
  distRefM: number;
  distRolloffM: number;
  /** ... while its wet share grows (x (1 + distBoost * min(1, d / distBoostM))): far sources sound far */
  distBoost: number;
  distBoostM: number;
  /** a sound through walls keeps occlusionGain^throughWall of its send (the room tail is less damped than the direct path) */
  throughWall: number;
  /** floor surface multiplier (level.surfaceAt / floorSurface) */
  surface: Record<string, number>;
  /** site theme multiplier (layout.theme) */
  theme: Record<string, number>;
  /** listener-room IR blend: 0 (small dry room) at irSmallM3, 1 (hall) at irHallM3, log in between */
  irSmallM3: number;
  irHallM3: number;
  irOutdoor: number;
  /** corridors use at least this much hall */
  irCorridor: number;
  /** reverb return level (1 = the v1.1 wet level); outdoors and mod:echoes scale it */
  wet: number;
  wetOutdoor: number;
  wetEchoes: number;
}

export interface HumCfg {
  /** fixtures within this distance (m) of the listener get a hum voice */
  radiusM: number;
  /** at most this many hum voices */
  max: number;
  attackSec: number;
  /** time constant of the fade when a fixture loses power; the gain is forced to exactly 0 after cutSec */
  releaseSec: number;
  cutSec: number;
  /** hum bus level (into the ambience bus) */
  bus: number;
  /** gain per hum voice kind (tube, highbay, buzz, tick) */
  kinds: Record<string, number>;
  /** volume of the ballast tink when a lit room switches off / a tube starts */
  switchTink: number;
  tinkRadiusM: number;
  /** hums are ambience: they get the occlusion gain of the walls between fixture and listener */
  occlude: boolean;
}

export interface BedsCfg {
  /** master level of the theme beds (0 = off) */
  level: number;
  fadeSec: number;
  /** bed one-shots (drips, creaks...) happen within this distance of the listener */
  eventRadiusM: number;
}

export interface FearCfg {
  /** heartbeat drive smoothing: quick to rise, slow to calm */
  attackSec: number;
  releaseSec: number;
}

export interface AudioCfg {
  /** occluded sounds (opts.occlude): gain per wall (dB) and lowpass cutoff per wall count */
  occlusionPerWallDb: number;
  occlusionLowpassHz: number[];
  /** a closed door counts as this fraction of a wall (an unknown door state as half of it) */
  closedDoorWallFrac: number;
  /** false: monster / item / UI sounds keep the v1.1 behaviour (lowpass only, no occlusion gain, no reverb send) */
  occludeMonsters: boolean;
  /** the v1.1 lowpass table every other positional sound keeps (monsters, items) */
  legacyLowpassHz: number[];
  reverb: ReverbCfg;
  hum: HumCfg;
  beds: BedsCfg;
  fear: FearCfg;
}

export const AUDIO_DEFAULTS: AudioCfg = {
  occlusionPerWallDb: -6,
  occlusionLowpassHz: [20000, 2400, 1200, 700, 450],
  closedDoorWallFrac: 0.6,
  occludeMonsters: false,
  legacyLowpassHz: [20000, 2400, 1200, 700, 450],
  reverb: {
    base: 0.16, min: 0.02, max: 0.55,
    sizeRefM3: 180, sizeExp: 0.22, sizeMin: 0.55, sizeMax: 1.7,
    corridor: 1.15, outdoor: 0.3, echoes: 1.6,
    distRefM: 1.5, distRolloffM: 14, distBoost: 0.6, distBoostM: 10,
    throughWall: 0.5,
    surface: { tile: 1.25, metal: 1.3, grate: 1.15, concrete: 1.15, lino: 1, rubber: 0.8, wood: 0.8, carpet: 0.55, asphalt: 0.6, dirt: 0.45, water: 1.35 },
    theme: {
      facility: 1, hospital: 1.1, waterworks: 1.2, industry: 1.15, records: 0.75, hospitality: 0.8, cold_storage: 1.15, comms: 0.85,
      transport: 1.1, retail: 0.85, parish: 1.3, baths: 1.35, greenhouse: 0.9, laundry: 1.1,
    },
    irSmallM3: 70, irHallM3: 600, irOutdoor: 0.35, irCorridor: 0.6,
    wet: 1, wetOutdoor: 0.45, wetEchoes: 1.35,
  },
  hum: {
    radiusM: 13, max: 8, attackSec: 0.02, releaseSec: 0.025, cutSec: 0.2, bus: 0.5,
    kinds: { tube: 1, highbay: 1.6, buzz: 0.45, tick: 0.12 },
    switchTink: 0.22, tinkRadiusM: 12, occlude: true,
  },
  beds: { level: 1, fadeSec: 2.5, eventRadiusM: 12 },
  fear: { attackSec: 0.3, releaseSec: 2.2 },
};

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const bool = (v: unknown, d: boolean): boolean => (typeof v === 'boolean' ? v : d);
/** a table of >= 2 finite positive numbers (Hz), else the default */
const table = (v: unknown, d: number[]): number[] =>
  Array.isArray(v) && v.length >= 2 && v.every((x) => typeof x === 'number' && Number.isFinite(x) && x > 0) ? (v as number[]).slice() : d.slice();
const record = (v: unknown, d: Record<string, number>): Record<string, number> => {
  const out: Record<string, number> = { ...d };
  if (isObj(v)) for (const [k, x] of Object.entries(v)) if (typeof x === 'number' && Number.isFinite(x) && x >= 0) out[k] = x;
  return out;
};
function section<T extends object>(raw: unknown, d: T): T {
  const src = isObj(raw) ? raw : {};
  const out: Record<string, unknown> = {};
  for (const [k, dv] of Object.entries(d)) {
    const v = src[k];
    if (typeof dv === 'number') out[k] = num(v, dv);
    else if (typeof dv === 'boolean') out[k] = bool(v, dv);
    else if (Array.isArray(dv)) out[k] = table(v, dv as number[]);
    else if (isObj(dv)) out[k] = record(v, dv as Record<string, number>);
    else out[k] = dv;
  }
  return out as T;
}

/** ctx.balance.audio -> a complete, validated AudioCfg */
export function readAudioCfg(raw: unknown): AudioCfg {
  const src = isObj(raw) ? raw : {};
  const D = AUDIO_DEFAULTS;
  return {
    occlusionPerWallDb: Math.min(0, num(src.occlusionPerWallDb, D.occlusionPerWallDb)),
    occlusionLowpassHz: table(src.occlusionLowpassHz, D.occlusionLowpassHz),
    closedDoorWallFrac: Math.max(0, Math.min(1, num(src.closedDoorWallFrac, D.closedDoorWallFrac))),
    occludeMonsters: bool(src.occludeMonsters, D.occludeMonsters),
    legacyLowpassHz: table(src.legacyLowpassHz, D.legacyLowpassHz),
    reverb: section(src.reverb, D.reverb),
    hum: section(src.hum, D.hum),
    beds: section(src.beds, D.beds),
    fear: section(src.fear, D.fear),
  };
}
