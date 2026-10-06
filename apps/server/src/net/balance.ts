// Owner: track ① Net. Typed view of config/balance/net.json (live: re-read on config reload).
import type { ServerContext } from '../core/types.ts';

export interface NetBalance {
  speedMult: number;
  moveSlackSec: number;
  moveSlackM: number;
  validateClosedDoors: boolean;
  rejectResyncCount: number;
  correctMinMs: number;
  audRangeM: number;
  audSilentRefreshMs: number;
  sessionSaveDebounceMs: number;
  invitePollMs: number;
}

const DEFAULTS: NetBalance = {
  speedMult: 1.35,
  moveSlackSec: 0.6,
  moveSlackM: 0.5,
  validateClosedDoors: false,
  rejectResyncCount: 30,
  correctMinMs: 300,
  audRangeM: 40,
  audSilentRefreshMs: 500,
  sessionSaveDebounceMs: 150,
  invitePollMs: 3000,
};

export function netBalance(ctx: ServerContext): NetBalance {
  const b = (ctx.balance.net ?? {}) as Partial<Record<keyof NetBalance, unknown>>;
  const out = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS) as (keyof NetBalance)[]) {
    const v = b[k];
    if (typeof v === typeof DEFAULTS[k]) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
