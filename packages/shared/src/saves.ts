// FROZEN CONTRACT (P0): host-side save files (saves/ is gitignored; never commit).
import type { Profile } from './profile.ts';

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
}

export interface SessionSave {
  crews: { code: string; phase: string; players: { id: string; playerKey: string; resume: string }[] }[];
  savedAt: string;
}
