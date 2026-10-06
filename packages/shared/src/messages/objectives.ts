// Owned by P2 track (a) Objectives (levers, vault, Core, extraction, clock, Company Requests, notes).

export interface ObjectivesState {
  /** power zone id -> powered */
  power: Record<number, boolean>;
  vaultOpen: boolean;
  coreState: 'vault' | 'carried' | 'dropped' | 'van' | 'none';
  /** scrip value inside the van this contract */
  hauled: number;
  /** total spawned loot value */
  lootTotal: number;
  requests: { kind: string; done: boolean; failed: boolean }[];
  blackout: boolean;
  /** true once the van is leaving / contract ended */
  ended: boolean;
}

export interface ObjectivesEvents {}

export interface ObjectivesReqs {}
