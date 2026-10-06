// Owned by P2 track (d) Meta (hub, board, shop, results, quota, XP, saves, claim codes, console).

export interface MetaState {
  shift: { index: number; contract: number; quota: number; hauled: number; balance: number; quotasMet: number };
  /** player id -> { xp, level } */
  careers: Record<string, { xp: number; level: number }>;
  shop: { id: string; name: string; price: number; desc: string }[];
}

export interface MetaEvents {}

export interface MetaReqs {}
