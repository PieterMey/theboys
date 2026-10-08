// Owner: env-paranormal (v1.2). Haunt level, tiers and cadence (pure). H is never sent to clients.
import type { ParaBalance, Tier, DirectorPhase } from './types.ts';

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;

export interface HauntIn {
  clockMin: number;
  /** EMA (30 s) of the director's max per-player tension */
  tensionEma: number;
  blackout: boolean;
  coreLifted: boolean;
  themeHaunt: number;
}

/** H = clamp(0.15 + 0.45·clockMin/360 + 0.25·tensionEMA30s + 0.15·blackout + 0.10·Core lifted + THEMES haunt) */
export function hauntLevel(b: ParaBalance, i: HauntIn): number {
  const h = b.haunt;
  return clamp01(h.base + h.clock * clamp01(i.clockMin / 360) + h.tension * clamp01(i.tensionEma) + (i.blackout ? h.blackout : 0)
    + (i.coreLifted ? h.core : 0) + (Number.isFinite(i.themeHaunt) ? i.themeHaunt : 0));
}

/** T0 always; T1 at H >= tierAt[1]; T2 at H >= tierAt[2] during the director's build phase only */
export function tierCap(b: ParaBalance, H: number, phase: DirectorPhase): Tier {
  if (H >= b.tierAt[2] && phase === 'build') return 2;
  if (H >= b.tierAt[1]) return 1;
  return 0;
}

/** mean gap (s) lerp(75, 28, H) */
export function meanGapSec(b: ParaBalance, H: number): number {
  return lerp(b.gapSlowSec, b.gapFastSec, clamp01(H));
}

/** one drawn gap (s): mean ±35% (u in [0,1) from the crew rng), x1.6 in relax */
export function drawGapSec(b: ParaBalance, H: number, phase: DirectorPhase, u: number): number {
  const g = meanGapSec(b, H) * (1 + b.gapJitter * (2 * u - 1));
  return phase === 'relax' ? g * b.relaxMult : g;
}

/**
 * first-order EMA without Math.exp (determinism rule): k = dt / (tau + dt).
 * Returns the new average.
 */
export function emaStep(prev: number, sample: number, dtSec: number, tauSec: number): number {
  if (!(dtSec > 0)) return prev;
  const k = dtSec / (Math.max(0.001, tauSec) + dtSec);
  return prev + (sample - prev) * k;
}

/** in-game minutes from the module's own contract clock (when objectives has none) */
export function fallbackClockMin(startedAt: number, now: number, realSec: number): number {
  const sec = Math.max(0, (now - startedAt) / 1000);
  return Math.min(360, (sec / Math.max(1, realSec)) * 360);
}
