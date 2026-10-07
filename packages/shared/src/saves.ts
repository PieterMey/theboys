// FROZEN CONTRACT (P0): host-side save files (saves/ is gitignored; never commit).
import type { Profile } from './profile.ts';
import type { CollectionEntry, CrewRecords, FieldGuideSave, PlayerStatsV1, ShiftStatLine } from './progress.ts';

export interface PlayerSave {
  /** stable player id */
  id: string;
  /** browser playerKeys bound to this profile (new tunnel origin => new key; re-bound via claim code) */
  keys: string[];
  name: string;
  /** 4-digit PIN for the claim code (badge + PIN). Stored as sha256 hex. */
  pinHash: string;
  profile: Profile;
  xp: number;
  level: number;
  achievements: string[];
  createdAt: string;
  updatedAt: string;
  /** v1.2 (meta): career counters; default lazily with emptyStats */
  stats?: PlayerStatsV1;
  /** v1.2 (meta): collection log, key -> first find */
  collection?: Record<string, CollectionEntry>;
  /** v1.2 (meta): hand-out priority (item types first handed out first) */
  loadout?: string[];
  /** v1.2 (fieldguide): booklet progress; default lazily with emptyFieldGuide */
  fieldGuide?: FieldGuideSave;
}

export interface ContractResult {
  orderId: string;
  risk: number;
  hauled: number;
  survivors: string[];
  deaths: { player: string; cause: string }[];
  coreExtracted: boolean;
  requestsMet: string[];
  at: string;
}

export interface CrewSave {
  code: string;
  members: string[];
  shift: {
    index: number;
    /** contracts completed in this shift (0..2) */
    contract: number;
    quota: number;
    /** scrip hauled this shift (counts toward quota) */
    hauled: number;
    /** spendable balance (purchases and fines come out of this only) */
    balance: number;
    gear: Record<string, number>;
    quotasMet: number;
  };
  history: ContractResult[];
  updatedAt: string;
  /** v1.2 (workshop): MaterialType -> units */
  stash?: Record<string, number>;
  /** v1.2 (workshop): VanUpgrade ids owned */
  unlocks?: string[];
  /** v1.2 (meta): running shift per save id (HR memo survives a restart) */
  shiftStats?: Record<string, ShiftStatLine>;
  /** v1.2 (meta) */
  records?: CrewRecords;
}

export interface SessionSave {
  crews: { code: string; phase: string; players: { id: string; playerKey: string; resume: string }[] }[];
  savedAt: string;
}
