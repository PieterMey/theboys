// Owner: track (d) Meta. Pure economy + career math (PLAN §3.6). No I/O, no ctx: unit-tested in tests/meta.
import { makeRng } from '@dead-air/shared/rng.ts';

export interface Economy {
  startScrip: number;
  playerMult: Record<string, number>;
  firstQuotaBase: number;
  quotaStep: number;
  quotaJitter: [number, number];
  contractsPerShift: number;
  overtimeBonus: number;
  badgeFine: number;
  xpLevels: number[];
}

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function economyFrom(core: Record<string, unknown>, meta: Record<string, unknown> = {}): Economy {
  const pm = (core.playerMult && typeof core.playerMult === 'object' ? core.playerMult : {}) as Record<string, number>;
  const jit = Array.isArray(meta.quotaJitter) && meta.quotaJitter.length === 2 ? (meta.quotaJitter as number[]) : [0.85, 1.15];
  const levels = Array.isArray(core.xpLevels) ? (core.xpLevels as number[]).filter((x) => typeof x === 'number') : [];
  return {
    startScrip: num(core.startScrip, 150),
    playerMult: { 1: 0.6, 2: 0.75, 3: 0.88, 4: 1.0, 5: 1.12, 6: 1.25, ...pm },
    firstQuotaBase: num(core.firstQuotaBase, 500),
    quotaStep: num(core.quotaStep, 275),
    quotaJitter: [num(jit[0], 0.85), num(jit[1], 1.15)],
    contractsPerShift: Math.max(1, Math.round(num(core.contractsPerShift, 3))),
    overtimeBonus: num(core.overtimeBonus, 0.2),
    badgeFine: num(core.badgeFine, 0.1),
    xpLevels: levels.length ? levels : [0, 150, 400, 750, 1200, 1800, 2600],
  };
}

export function playerMult(e: Economy, players: number): number {
  const n = Math.max(1, Math.min(6, Math.round(players) || 1));
  return num(e.playerMult[String(n)], 1);
}

/** first quota of a run: 500 x player multiplier */
export function firstQuota(e: Economy, players: number): number {
  return Math.round(e.firstQuotaBase * playerMult(e, players));
}

/**
 * quota for shift n (n >= 1 = the 2nd, 3rd ... quota): prev + 275 x (1 + n^2/10) x U(0.85..1.15).
 * Deterministic per crew + shift (makeRng), so a restart doesn't re-roll it.
 */
export function nextQuota(e: Economy, prev: number, n: number, seed: string): number {
  const u = makeRng(seed, `quota|${n}`).next();
  const [lo, hi] = e.quotaJitter;
  return Math.round(prev + e.quotaStep * (1 + (n * n) / 10) * (lo + (hi - lo) * u));
}

/** overtime bonus: 20% of the haul above the quota (0 when missed) */
export function overtime(e: Economy, hauled: number, quota: number): number {
  return hauled > quota ? Math.round((hauled - quota) * e.overtimeBonus) : 0;
}

/** fine per unrecovered badge: 10% of the spendable balance each (capped at the balance) */
export function badgeFines(e: Economy, balance: number, count: number): number[] {
  const out: number[] = [];
  let left = Math.max(0, balance);
  for (let i = 0; i < count; i++) {
    const f = Math.min(left, Math.round(Math.max(0, balance) * e.badgeFine));
    out.push(f);
    left -= f;
  }
  return out;
}

/** career level (1-based) for an XP total: thresholds 0 / 150 / 400 / ... */
export function levelFor(e: Economy, xp: number): number {
  let lvl = 1;
  for (let i = 0; i < e.xpLevels.length; i++) if (xp >= e.xpLevels[i]) lvl = i + 1;
  return lvl;
}

/** XP total needed for the next level, or null at max level */
export function nextLevelXp(e: Economy, level: number): number | null {
  return level < e.xpLevels.length ? e.xpLevels[level] : null;
}

/** quota met? */
export function quotaMet(hauled: number, quota: number): boolean {
  return hauled >= quota;
}
