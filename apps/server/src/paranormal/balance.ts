// Owner: env-paranormal (v1.2). config/balance/paranormal.json -> ParaBalance with defaults (hot-reloaded: resolve() is
// called per tick from the live ctx.balance object, so edits apply without a restart).
import type { ParaBalance } from './types.ts';

export const DEFAULTS: ParaBalance = {
  enabled: true,
  tells: { stalk: true, intercept: true, ambushCold: false },
  leadMs: 350,
  gapSlowSec: 75,
  gapFastSec: 28,
  gapJitter: 0.35,
  relaxMult: 1.6,
  firstDelaySec: 40,
  retrySec: 6,
  haunt: { base: 0.15, clock: 0.45, tension: 0.25, blackout: 0.15, core: 0.1, emaSec: 30 },
  tierAt: [0, 0.25, 0.4],
  spacingSec: 10,
  perPlayerSec: 45,
  blockAfterWakeSec: 15,
  blockAfterDirectorSec: 8,
  quietSec: 8,
  noopChance: 0.12,
  budgets: {
    dark_walk: 3, mirror_writing: 2, mirror_figure: 2, presence: 4, knock: 6, poltergeist: 4, object_fall: 5, footprints: 3, cold_spot: 3,
    brownout_breath: 2,
  },
  weights: {
    knock: 1, handle_rattle: 0.7, poltergeist: 0.8, object_fall: 0.9, cold_spot: 0.7, brownout_breath: 0.5, footprints: 0.7, dark_walk: 0.9,
    mirror_writing: 0.8, presence: 0.9, silhouette: 0.6, mirror_figure: 0.7,
  },
  tierBoost: 1.5,
  kinds: { footprints: true, poltergeist: true, object_fall: true, cold_spot: true, brownout_breath: true, radio_on: false, phone_ring: false, dead_poke: false },
  guarantees: { t1ClockMin: 120, t2ClockMin: 240, mirrorM: 5, mirrorPendingSec: 60 },
  gates: { monsterM: 6, mannequinLightM: 25, grateM: 6, vanM: 6 },
  darkWalk: {
    minM: 15, maxM: 30, minFixtures: 4, stepMinMs: 380, stepMaxMs: 600, dieMs: 450, gapSec: 120, stalkSec: 60, stalkChance: 0.7, loneM: 10,
    reviveMinSec: 45, reviveMaxSec: 90, maxSpaces: 5,
  },
  writing: { nearM: 8, roomSec: 90, fog: 0.85, fogMs: 4000, revealMs: 2000, revealLeadMs: 300, maxArmSec: 240, lookM: 20, lookDeg: 55 },
  figure: { armSec: 120, nearM: 15, behindMin: 1.2, behindMax: 1.8, holdMs: 1200, lookM: 5 },
  presence: { aheadMin: 4, aheadMax: 9, msMin: 2500, msMax: 6000, litM: 14, litSec: 0.4, litDeg: 25, approachM: 7, darkFixtureM: 4, laneM: 2 },
  silhouette: { minM: 8, maxM: 22, coneDeg: 35, msMin: 2500, msMax: 6000, approachM: 7, brownMs: 1800, depth: 0.7, backM: 4 },
  knock: { minM: 2.5, maxM: 9, msMin: 1400, msMax: 2600, lockerChance: 0.3, beyondM: 0.3, hearM: 14 },
  props: { minM: 2.5, maxM: 10, slideMin: 0.25, slideMax: 0.7, msMin: 900, msMax: 1500, hearM: 12 },
  footprints: { fromMinM: 9, fromMaxM: 15, strideM: 0.62, stepMs: 560, fadeSec: 90, loreChance: 0.5, maxPrints: 28 },
  cold: { minM: 2, maxM: 5, rMin: 1.5, rMax: 2.3, msMin: 12000, msMax: 20000, density: 0.32 },
  breath: { msMin: 2500, msMax: 4000, depth: 0.55, puffs: 3 },
  seenPerSec: 10,
  witnessM: 25,
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

/** deep-merge: numbers/booleans/strings of `src` over `def` (same shape), unknown keys of records kept */
function merge<T>(def: T, src: unknown): T {
  if (!isObj(src)) return def;
  if (Array.isArray(def)) return def;
  const out: Obj = { ...(def as Obj) };
  for (const [k, dv] of Object.entries(def as Obj)) {
    const sv = src[k];
    if (sv === undefined) continue;
    if (Array.isArray(dv)) out[k] = Array.isArray(sv) && sv.every((x) => typeof x === 'number' && Number.isFinite(x)) && sv.length === dv.length ? sv : dv;
    else if (isObj(dv)) {
      const m = merge(dv, sv) as Obj;
      // open records (budgets, weights, kinds): keep extra numeric/boolean keys from the file
      if (isObj(sv)) for (const [kk, vv] of Object.entries(sv)) if (!(kk in m) && (typeof vv === 'number' || typeof vv === 'boolean')) m[kk] = vv;
      out[k] = m;
    } else if (typeof dv === 'number') out[k] = typeof sv === 'number' && Number.isFinite(sv) ? sv : dv;
    else if (typeof dv === 'boolean') out[k] = typeof sv === 'boolean' ? sv : dv;
    else out[k] = sv;
  }
  return out as T;
}

/** config/balance/paranormal.json (any shape) -> ParaBalance; index.ts caches it and re-resolves on hooks.config */
export function resolveBalance(src: unknown): ParaBalance {
  return merge(DEFAULTS, src);
}
