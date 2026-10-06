// Owner: track ① Net. Connection quality + adaptive interpolation delay.
// lag_i = (arrival + clockOffset) - snap.t : how far behind the estimated server clock each snapshot lands.
// interpDelay = p95(lag) + one snapshot interval + margin, clamped to [interpMinMs, interpMaxMs] (80..250);
// it rises quickly on jitter spikes and relaxes slowly. jitterMs = p95(lag) - p5(lag).
import { SNAPSHOT_HZ } from '@dead-air/shared/constants.ts';
import type { ClientContext } from '../core/context.ts';
import type { NetStatus } from '../core/net.ts';

export interface NetStatService {
  /** smoothed RTT (ms) from the 2 s app-level ping */
  readonly rtt: number;
  readonly status: NetStatus;
  /** snapshot arrival jitter (ms, p95 - p5 over the last ~3 s) */
  readonly jitterMs: number;
  /** current interpolation delay (ms) applied to world.interpDelayMs */
  readonly interpDelayMs: number;
  /** serverTime - performance.now() estimate (ms) */
  readonly clockOffsetMs: number;
  /** measured snapshot rate (Hz) */
  readonly snapHz: number;
  /** ms since the last snapshot arrived (Infinity before the first) */
  readonly lastSnapAgeMs: number;
  /** server pose corrections received ('net.correct') */
  readonly corrections: number;
}

declare module '../core/services.ts' {
  interface ServiceMap {
    netstat: NetStatService;
  }
}

const WINDOW = 60; // ~3 s at 20 Hz

function pct(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)))];
}

export function createNetStats(ctx: ClientContext): NetStatService & { noteCorrection(): void } {
  const bal = (ctx.balance.net ?? {}) as { interpMinMs?: number; interpMaxMs?: number };
  const minMs = typeof bal.interpMinMs === 'number' ? bal.interpMinMs : 80;
  const maxMs = typeof bal.interpMaxMs === 'number' ? bal.interpMaxMs : 250;
  const lags: number[] = [];
  const arrivals: number[] = [];
  let jitter = 0;
  let lastAt = -Infinity;
  let corrections = 0;
  let forced: number | null = null;
  const fixed = Number(ctx.params.get('interp'));
  if (Number.isFinite(fixed) && fixed > 0) forced = fixed; // ?interp=150 pins the delay (debug)
  ctx.world.interpDelayMs = forced ?? 100;
  // main-thread stalls (shader compiles, loading) queue snapshots behind a long task; that is not network
  // jitter and does not starve interpolation (no frames render meanwhile), so those samples are skipped.
  let lastFrameAt = 0;
  ctx.registerSystem({ name: 'net.frameclock', order: 1, update() { lastFrameAt = performance.now(); } });

  ctx.world.onSnap((s, at) => {
    lastAt = at;
    arrivals.push(at);
    if (arrivals.length > WINDOW) arrivals.shift();
    if (lastFrameAt === 0 || at - lastFrameAt > 80) return;
    const lag = at + ctx.world.clockOffset() - s.t;
    lags.push(lag);
    if (lags.length > WINDOW) lags.shift();
    if (lags.length < 5) return;
    const sorted = lags.slice().sort((a, b) => a - b);
    const p95 = pct(sorted, 0.95), p5 = pct(sorted, 0.05);
    jitter = Math.max(0, p95 - p5);
    const target = Math.min(maxMs, Math.max(minMs, Math.max(0, p95) + 1000 / SNAPSHOT_HZ + 15));
    if (forced !== null) return;
    const cur = ctx.world.interpDelayMs;
    const k = target > cur ? 0.25 : 0.02; // fast attack, slow release
    ctx.world.interpDelayMs = Math.min(maxMs, Math.max(minMs, cur + (target - cur) * k));
  });

  return {
    get rtt() { return ctx.net.rtt; },
    get status() { return ctx.net.status; },
    get jitterMs() { return jitter; },
    get interpDelayMs() { return ctx.world.interpDelayMs; },
    get clockOffsetMs() { return ctx.world.clockOffset(); },
    get snapHz() {
      if (arrivals.length < 2) return 0;
      const span = arrivals[arrivals.length - 1] - arrivals[0];
      return span > 0 ? ((arrivals.length - 1) * 1000) / span : 0;
    },
    get lastSnapAgeMs() { return performance.now() - lastAt; },
    get corrections() { return corrections; },
    noteCorrection() { corrections++; },
  };
}
