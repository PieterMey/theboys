// Owned by track ② Level. Generator tuning. Defaults live here (pure, deterministic); the server overlays
// config/balance/level.json (same shape, any subset) via resolveTuning().

export interface LevelTuning {
  /** facility footprint [W, H] in metres per crew size (the parking lot is added on the entrance side) */
  footprint: Record<string, [number, number]>;
  /** parking lot depth (m) */
  lotDepth: number;
  corridorWidth: number;
  /** perimeter room strip depth range (m) */
  marginMin: number;
  marginMax: number;
  /** target block size between corridor lines (m) and minimum block size */
  blockTarget: number;
  blockMin: number;
  /** inner vertical corridor line probabilities (rest = full) */
  innerAbsent: number;
  innerPartial: number;
  bspMinSide: number;
  bspMaxSide: number;
  /** BSP max room area = base + perPlayer * players */
  bspMaxAreaBase: number;
  bspMaxAreaPerPlayer: number;
  bspStopChance: number;
  /** chance to keep a whole inner block (area within range) as one hall */
  hallChance: number;
  hallMinArea: number;
  hallMaxArea: number;
  /** rooms with area >= this are kind 'hall' */
  hallKindArea: number;
  roomsMin: number;
  roomsMax: number;
  /** non-vault dead-end rooms to aim for [min, max] */
  deadEnds: [number, number];
  roomRoomDoorChance: number;
  /** keycard locks per risk (max 1 is enforced) */
  locksByRisk: Record<string, number>;
  rubbleBase: number;
  rubblePerRisk: number;
  rubbleMax: number;
  fireDoorChance: number;
  /** security doors per crew size */
  securityDoors: Record<string, number>;
  leverMinPathM: number;
  leverIdealPathM: number;
  /** every walkable cell within this path distance of a hiding locker */
  hidingCoverageM: number;
  hidingRoomChance: number;
  notesMin: number;
  notesMax: number;
  /** vent pairs per crew size */
  ventPairs: Record<string, number>;
  intercomsMin: number;
  intercomsMax: number;
  /** loot per room = floor(area / lootAreaPerItem * (0.6 + depth) + rand) */
  lootAreaPerItem: number;
  lootMaxPerRoom: number;
  lightOffBase: number;
  lightOffPerRisk: number;
  lightOffDepth: number;
  lightBrokenBase: number;
  lightBrokenDepth: number;
  lightBrokenPerRisk: number;
  lightFlickerBase: number;
  lightFlickerPerRisk: number;
  /** chance a single fixture deviates from its space state */
  fixtureDeviate: number;
  /** fraction of facility spaces in the vault-wing power zone */
  vaultWingFrac: number;
  maxAttempts: number;
  /** callsigns never used for rooms (common words in play: radio = walkie, lockers = hiding) */
  avoidCallsigns: string[];
}

export const DEFAULT_LEVEL_TUNING: LevelTuning = {
  footprint: { '1': [30, 22], '2': [32, 24], '3': [36, 27], '4': [40, 30], '5': [45, 33], '6': [50, 36] },
  lotDepth: 12,
  corridorWidth: 2,
  marginMin: 5,
  marginMax: 8,
  blockTarget: 14,
  blockMin: 6,
  innerAbsent: 0.15,
  innerPartial: 0.3,
  bspMinSide: 5,
  bspMaxSide: 18,
  bspMaxAreaBase: 30,
  bspMaxAreaPerPlayer: 18,
  bspStopChance: 0.8,
  hallChance: 0.6,
  hallMinArea: 40,
  hallMaxArea: 260,
  hallKindArea: 56,
  roomsMin: 12,
  roomsMax: 24,
  deadEnds: [2, 3],
  roomRoomDoorChance: 0.08,
  locksByRisk: { '1': 1, '2': 1, '3': 1 },
  rubbleBase: 0.12,
  rubblePerRisk: 0.05,
  rubbleMax: 3,
  fireDoorChance: 0.25,
  securityDoors: { '1': 2, '2': 2, '3': 3, '4': 3, '5': 4, '6': 4 },
  leverMinPathM: 18,
  leverIdealPathM: 26,
  hidingCoverageM: 16,
  hidingRoomChance: 0.5,
  notesMin: 4,
  notesMax: 6,
  ventPairs: { '1': 2, '2': 2, '3': 2, '4': 3, '5': 3, '6': 3 },
  intercomsMin: 2,
  intercomsMax: 3,
  lootAreaPerItem: 12,
  lootMaxPerRoom: 6,
  lightOffBase: 0.04,
  lightOffPerRisk: 0.05,
  lightOffDepth: 0.12,
  lightBrokenBase: 0.03,
  lightBrokenDepth: 0.14,
  lightBrokenPerRisk: 0.04,
  lightFlickerBase: 0.12,
  lightFlickerPerRisk: 0.05,
  fixtureDeviate: 0.15,
  vaultWingFrac: 0.5,
  maxAttempts: 16,
  avoidCallsigns: ['RADIO', 'LOCKERS', 'VAULT'],
};

type DeepPartial<T> = { [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K] };
export type LevelTuningOverrides = DeepPartial<LevelTuning>;

/** Overlay a (partial) balance config onto the defaults. Unknown keys are ignored. */
export function resolveTuning(over?: LevelTuningOverrides | Record<string, unknown> | null): LevelTuning {
  const out: LevelTuning = structuredClone(DEFAULT_LEVEL_TUNING);
  if (!over) return out;
  const o = over as Record<string, unknown>;
  const dst = out as unknown as Record<string, unknown>;
  for (const k of Object.keys(out)) {
    const val = o[k];
    if (val === undefined || val === null) continue;
    const cur = dst[k];
    if (Array.isArray(cur)) { if (Array.isArray(val)) dst[k] = val.slice(); }
    else if (typeof cur === 'object' && cur !== null) { if (typeof val === 'object') dst[k] = { ...(cur as object), ...(val as object) }; }
    else if (typeof cur === typeof val) dst[k] = val;
  }
  return out;
}

/** Facility footprint for a crew size (1..6). */
export function footprintFor(players: number, t: LevelTuning = DEFAULT_LEVEL_TUNING): [number, number] {
  const p = Math.max(1, Math.min(6, Math.round(players)));
  const fp = t.footprint[String(p)];
  if (fp) return [fp[0], fp[1]];
  return [30 + 4 * p, 22 + 3 * p];
}
