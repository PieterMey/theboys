// Integrator-owned (v1.2), additive only. Career stats + collection log (meta), monster booklet (fieldguide).
// Counters and ids only: never transcripts or chat text.
import type { MonsterKind } from './state.ts';

export interface PlayerStatsV1 {
  v: 1;
  contracts: number; extracted: number; wipes: number; survived: number; deaths: number; leftBehind: number;
  shifts: number; quotasMet: number; fired: number;
  timeOnSiteSec: number; distanceM: number; sprintM: number; crouchM: number; crouchSec: number; hiddenSec: number;
  flashlightSec: number; nvSec: number; stepsCrept: number; stepsWalked: number; stepsSprinted: number; ductsCrawled: number;
  lootItems: number; lootValue: number; bestHaul: number; heavyItems: number; idols: number; curios: number;
  coresExtracted: number; safesCracked: number; materials: number; scrapped: number; crafted: number; scripSpent: number;
  drawersSearched: number; doorsEased: number; pagesFiled: number; phenomenaSeen: number;
  revivesGiven: number; revivedTimes: number; badgesFiled: number; rescues: number;
  /** 'HOUND' | 'LISTENER' | 'MANNEQUIN' | 'SNATCHER' | 'LEFT BEHIND' ... -> deaths */
  killedBy: Record<string, number>;
  houndAlerts: number; grabbed: number; knockdowns: number; snatched: number; escapes: number; listenerUsedYourWords: number;
  /** item type -> uses */
  itemsUsed: Record<string, number>;
  crowbarSwings: number; crowbarHits: number; doorsOpened: number;
  radioSec: number; screams: number; chatLines: number;
  /** contracts survived in a row (Clean Record) */
  cleanStreak: number; bestCleanStreak: number;
  firstAt: string; lastAt: string;
}

/** first find of a collection-log entry. Keys: type ('nvg', 'mat.wiring'), 'loot:<flavour>', 'curio:<name>', 'loot.idol' */
export interface CollectionEntry { at: string; site: string; crew: string }

/** CrewSave.shiftStats line, keyed by save id */
export interface ShiftStatLine { contracts: number; survived: number; deaths: number; hauled: number; revives: number; crafted: number; scrapped: number }

export interface CrewRecords {
  bestHaul: number; bestHaulSite: string; bestHaulAt: string;
  quotaStreak: number; bestQuotaStreak: number; cores: number; contracts: number; wipes: number;
}

export interface StatsHeadline {
  saveId: string; name: string; badge: number; level: number; contracts: number; lootValue: number; deaths: number; revivesGiven: number; collection: number;
}

/** GET /api/stats (header x-deadair-key) and 'meta.stats' reply */
export interface StatsReply {
  you: {
    saveId: string; name: string; badge: number; level: number; xp: number; achievements: string[];
    stats: PlayerStatsV1; collection: Record<string, CollectionEntry>;
  } | null;
  crews: { code: string; members: StatsHeadline[]; records: CrewRecords | null }[];
  collectionSize: number;
}

export function emptyStats(now: string): PlayerStatsV1 {
  return {
    v: 1, contracts: 0, extracted: 0, wipes: 0, survived: 0, deaths: 0, leftBehind: 0, shifts: 0, quotasMet: 0, fired: 0,
    timeOnSiteSec: 0, distanceM: 0, sprintM: 0, crouchM: 0, crouchSec: 0, hiddenSec: 0, flashlightSec: 0, nvSec: 0,
    stepsCrept: 0, stepsWalked: 0, stepsSprinted: 0, ductsCrawled: 0, lootItems: 0, lootValue: 0, bestHaul: 0, heavyItems: 0,
    idols: 0, curios: 0, coresExtracted: 0, safesCracked: 0, materials: 0, scrapped: 0, crafted: 0, scripSpent: 0,
    drawersSearched: 0, doorsEased: 0, pagesFiled: 0, phenomenaSeen: 0, revivesGiven: 0, revivedTimes: 0, badgesFiled: 0, rescues: 0,
    killedBy: {}, houndAlerts: 0, grabbed: 0, knockdowns: 0, snatched: 0, escapes: 0, listenerUsedYourWords: 0, itemsUsed: {},
    crowbarSwings: 0, crowbarHits: 0, doorsOpened: 0, radioSec: 0, screams: 0, chatLines: 0, cleanStreak: 0, bestCleanStreak: 0,
    firstAt: now, lastAt: now,
  };
}

/** Field Guide progress per monster kind */
export interface FieldGuideMonster {
  first?: { at: string; site: string; how: 'heard' | 'seen' | 'grabbed' | 'killed' };
  heard: number; seen: number; deaths: number; escapes: number;
}
export interface FieldGuideSave {
  v: 1;
  monsters: Partial<Record<MonsterKind, FieldGuideMonster>>;
  /** filed page ids ('hound.2') */
  pages: string[];
  /** paranormal kind -> times witnessed */
  anomalies: Record<string, number>;
}
export function emptyFieldGuide(): FieldGuideSave {
  return { v: 1, monsters: {}, pages: [], anomalies: {} };
}
