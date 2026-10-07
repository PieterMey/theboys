// Owner: track ④ Voice (audio). Radio-static crackle timing (pure, unit-tested in tests/voice/crackle.test.ts).
// Irregular pops whose density follows the static level: the menu's faint bed (~0.35) pops every few seconds,
// full static (next to the Listener, dead air) crackles several times a second. Replaces a fixed sine gate that
// ticked ~1.7 times per second in a mechanical rhythm.

export interface CrackleStep {
  /** seconds from this pop to the next one */
  wait: number;
  /** pop length in seconds */
  dur: number;
  /** 0..1 loudness multiplier for this pop */
  amp: number;
}

/** mean seconds between pops for a static level 0..1 (0.35 -> ~3 s, 0.6 -> ~1.2 s, 1 -> 0.3 s) */
export function crackleMeanGap(level: number): number {
  const l = Math.max(0, Math.min(1, level));
  return 0.3 * Math.pow(10, (1 - l) * 1.53);
}

/** next pop: exponential (Poisson-like) gaps around the mean, never closer than the level's minimum gap */
export function crackleStep(level: number, rnd: () => number): CrackleStep {
  const l = Math.max(0, Math.min(1, level));
  const mean = crackleMeanGap(l);
  const minGap = 0.12 + (1 - l) * 1.0;
  const u = Math.min(0.999, Math.max(0, rnd()));
  const wait = Math.min(mean * 3, Math.max(minGap, -mean * Math.log(1 - u)));
  return { wait, dur: 0.008 + rnd() * 0.03, amp: 0.35 + rnd() * 0.65 };
}

/** small seeded LCG (cosmetic audio only; no Math.random) */
export function crackleRng(seed = 0x5eed1234): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
