// Client entity store, fed by core/net.ts. Remote entities keep a short snapshot history and are sampled
// `interpDelayMs` behind the estimated server clock (100 ms default; ① Net may adapt it to jitter).
import type { CrewPublic, FullState, Phase, Snapshot, SnapDyn, SnapMonster, SnapPlayer } from '@dead-air/shared/state.ts';
import type { LevelLayout } from '@dead-air/shared/layout.ts';

interface Timed<T> { t: number; s: T }

/** Snapshot history for one entity; sample(t) lerps p/yaw(/pitch), other fields from the older sample. */
export class InterpBuffer<T extends { p: [number, number, number]; yaw: number; pitch?: number }> {
  private buf: Timed<T>[] = [];
  push(t: number, s: T): void {
    const b = this.buf;
    if (b.length && t <= b[b.length - 1].t) return;
    b.push({ t, s });
    while (b.length > 2 && b[1].t < t - 1000) b.shift();
  }
  latest(): T | null {
    return this.buf.length ? this.buf[this.buf.length - 1].s : null;
  }
  sample(t: number): T | null {
    const b = this.buf;
    if (!b.length) return null;
    if (t <= b[0].t) return b[0].s;
    const last = b[b.length - 1];
    if (t >= last.t) return last.s; // no extrapolation
    let i = b.length - 2;
    while (i > 0 && b[i].t > t) i--;
    const a = b[i];
    const c = b[i + 1];
    const k = (t - a.t) / (c.t - a.t || 1);
    const out = { ...a.s };
    out.p = [a.s.p[0] + (c.s.p[0] - a.s.p[0]) * k, a.s.p[1] + (c.s.p[1] - a.s.p[1]) * k, a.s.p[2] + (c.s.p[2] - a.s.p[2]) * k];
    out.yaw = lerpAngle(a.s.yaw, c.s.yaw, k);
    if (a.s.pitch !== undefined && c.s.pitch !== undefined) out.pitch = a.s.pitch + (c.s.pitch - a.s.pitch) * k;
    return out;
  }
}

export function lerpAngle(a: number, b: number, k: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

export interface World {
  phase: Phase;
  crew: CrewPublic | null;
  /** local player id */
  me: string | null;
  layout: LevelLayout | null;
  /** last FullState (welcome / phase / resume); slices = objectives, interaction, meta, workOrders... */
  full: FullState | null;
  /** remote + local players' snapshot history (local entry = server's view of me) */
  players: Map<string, InterpBuffer<SnapPlayer>>;
  monsters: Map<string, InterpBuffer<SnapMonster>>;
  dyn: Map<string, InterpBuffer<SnapDyn>>;
  /** per-speaker path distance for this client (Snapshot.aud) */
  aud: Record<string, number>;
  lastSnap: Snapshot | null;
  /** per-track client-side scratch, keyed by track name */
  slices: Record<string, unknown>;
  interpDelayMs: number;
  /** estimated server clock (ms, same base as Snapshot.t) */
  serverNow(): number;
  /** server time to render remote entities at = serverNow() - interpDelayMs */
  renderTime(): number;
  samplePlayer(id: string, t?: number): SnapPlayer | null;
  sampleMonster(id: string, t?: number): SnapMonster | null;
  /** UI subscription for discrete changes (phase, crew, me, layout, full). Not called per snapshot. */
  subscribe(fn: () => void): () => void;
  notify(): void;
  /** bumps on every notify() */
  version: number;
  // --- fed by net (core) ---
  applyFull(state: FullState): void;
  applySnap(s: Snapshot): void;
  observeServerTime(serverMs: number): void;
  // --- additive (track ① Net) ---
  /** called after every applied snapshot with its local arrival time (performance.now()) */
  onSnap(fn: (s: Snapshot, arrivedAt: number) => void): () => void;
  /** current estimate of serverTime - performance.now() (ms) */
  clockOffset(): number;
}

export function createWorld(): World {
  const subs = new Set<() => void>();
  const snapSubs = new Set<(s: Snapshot, arrivedAt: number) => void>();
  let offset = 0; // serverTime - performance.now()
  let haveOffset = false;

  const syncMap = <T extends { id: string; p: [number, number, number]; yaw: number }>(map: Map<string, InterpBuffer<T>>, list: T[], t: number) => {
    const seen = new Set<string>();
    for (const e of list) {
      seen.add(e.id);
      let b = map.get(e.id);
      if (!b) map.set(e.id, (b = new InterpBuffer<T>()));
      b.push(t, e);
    }
    for (const id of map.keys()) if (!seen.has(id)) map.delete(id);
  };

  const w: World = {
    phase: 'hub',
    crew: null,
    me: null,
    layout: null,
    full: null,
    players: new Map(),
    monsters: new Map(),
    dyn: new Map(),
    aud: {},
    lastSnap: null,
    slices: {},
    interpDelayMs: 100,
    version: 0,
    serverNow: () => performance.now() + offset,
    renderTime: () => performance.now() + offset - w.interpDelayMs,
    samplePlayer: (id, t) => w.players.get(id)?.sample(t ?? w.renderTime()) ?? null,
    sampleMonster: (id, t) => w.monsters.get(id)?.sample(t ?? w.renderTime()) ?? null,
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    notify() {
      w.version++;
      for (const fn of subs) fn();
    },
    applyFull(state) {
      w.full = state;
      w.phase = state.phase;
      w.layout = state.layout;
      if (state.snap) w.applySnap(state.snap);
      w.notify();
    },
    applySnap(s) {
      w.observeServerTime(s.t);
      w.lastSnap = s;
      w.aud = s.aud;
      syncMap(w.players, s.players, s.t);
      syncMap(w.monsters, s.monsters, s.t);
      syncMap(w.dyn, s.dyn, s.t);
      if (snapSubs.size) {
        const at = performance.now();
        for (const fn of snapSubs) {
          try { fn(s, at); } catch { /* listener errors never break snapshot application */ }
        }
      }
    },
    onSnap(fn) {
      snapSubs.add(fn);
      return () => snapSubs.delete(fn);
    },
    clockOffset: () => offset,
    observeServerTime(serverMs) {
      const sample = serverMs - performance.now();
      if (!haveOffset || sample > offset) {
        offset = sample; // least-delayed packet wins immediately
        haveOffset = true;
      } else offset += (sample - offset) * 0.02; // drift down slowly
    },
  };
  return w;
}
