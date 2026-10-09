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
  /** v1.3 (meta, Company Line v0): what the Company remembers about this crew. Structured facts only, never transcripts */
  companyFile?: CompanyFileV1;
}

/** v1.3 (meta): one shift's Company Line term sheet (code-owned numbers) */
export interface CompanyTermsV1 {
  /** CrewSave.shift.index the terms belong to (cleared when that shift ends) */
  shift: number;
  quotaPct: number;
  payoutPct: number;
  /** hazard pay per contract, paid through an EXTRACT_ABOVE Company Request */
  bonus: number;
  /** harder-site modifier chips added to the shift's work orders */
  conditions: string[];
  /** the quota before the deal */
  baseQuota: number;
  outcome: 'deal' | 'missed' | 'hung_up';
  at: string;
}

/** v1.3 (meta): CrewSave.companyFile. Counts and numbers only: nothing anyone said is ever stored */
export interface CompanyFileV1 {
  v: 1;
  /** calls answered / missed */
  calls: number;
  missed: number;
  /** lines the classifier counted as insults or prompt games, over all calls */
  insults: number;
  /** the regional manager's opinion of the crew, -2..2 */
  mood: number;
  /** haul promised on the last call (null = no promise) and what that shift hauled (null = not over yet) */
  promised: number | null;
  delivered: number | null;
  brokenPromises: number;
  /** the term sheet of the shift in progress (null = no call yet this shift) */
  terms: CompanyTermsV1 | null;
  /** the previous shift's term sheet */
  last: CompanyTermsV1 | null;
}

export interface SessionSave {
  crews: { code: string; phase: string; players: { id: string; playerKey: string; resume: string }[] }[];
  savedAt: string;
}
