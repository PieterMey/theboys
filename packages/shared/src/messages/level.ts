// Owned by track ② Level (layout generation, hub layout, level events).
// Add entries here only (additive). Events: name -> payload. Reqs: name -> { args; result }.
// The layout itself travels in FullState.layout (welcome / 'phase' event / resume); nothing else is needed per frame.
// Dev-only requests (NODE_ENV=development, via __game.dbg):
//   'dbg.level.generate' { seed?: string; players?: number; risk?: number }  -> switches the crew to 'contract' with a fresh facility
//   'dbg.level.hub'      {}                                                    -> back to 'hub' with the hub layout
//   'dbg.level.info'     {}                                                    -> { kind, seed, hash, W, H, metrics }
import type { LevelLayout } from '../layout.ts';

export interface LevelSummary {
  kind: LevelLayout['kind'];
  seed: string;
  hash: string;
  W: number;
  H: number;
  metrics: Record<string, number>;
}

export interface LevelEvents {}

export interface LevelReqs {
  /** re-fetch the current layout (normally it arrives with FullState) */
  'level.get': { args: Record<string, never>; result: { layout: LevelLayout | null } };
}
