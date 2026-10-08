// Owner: env-audio (v1.2). Heartbeat drive with several writers (plan check #13): sfx.fear(source, v, ms?) keeps one
// value per source ('spotted' from monsters.spotted, 'paranormal' from phenomena the player perceives, 'default' =
// setFear(v)); the heartbeat follows the MAXIMUM over live sources. v <= 0 clears the source; ms clears it after ms.
// Writers feed only what the player perceives (never raw tension). Pure; unit-tested in tests/audio/fear.test.ts.

export class FearMix {
  private src = new Map<string, { v: number; until: number }>();

  /** nowMs on any monotonic clock (performance.now()) */
  set(source: string, v: number, ms: number | undefined, nowMs: number): void {
    const key = typeof source === 'string' && source ? source : 'default';
    const val = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
    if (val <= 0) {
      this.src.delete(key);
      return;
    }
    const until = ms !== undefined && Number.isFinite(ms) && ms > 0 ? nowMs + ms : Infinity;
    this.src.set(key, { v: val, until });
  }

  /** maximum over live sources (expired ones are dropped) */
  value(nowMs: number): number {
    let m = 0;
    for (const [k, s] of this.src) {
      if (s.until <= nowMs) {
        this.src.delete(k);
        continue;
      }
      if (s.v > m) m = s.v;
    }
    return m;
  }

  /** live sources (debug) */
  sources(nowMs: number): Record<string, number> {
    this.value(nowMs);
    const out: Record<string, number> = {};
    for (const [k, s] of this.src) out[k] = s.v;
    return out;
  }

  clear(): void { this.src.clear(); }
}

/** one smoothing step of the heartbeat drive: quick to rise (attackSec), slow to calm (releaseSec) */
export function smoothFear(cur: number, target: number, dt: number, attackSec: number, releaseSec: number): number {
  const c = Number.isFinite(cur) ? cur : 0;
  const t = Number.isFinite(target) ? Math.max(0, Math.min(1, target)) : 0;
  if (!(dt > 0) || !Number.isFinite(dt)) return c;
  const tc = Math.max(0.01, t > c ? attackSec : releaseSec);
  const next = c + (t - c) * (1 - Math.exp(-dt / tc));
  return Math.abs(next - t) < 1e-4 ? t : next;
}
