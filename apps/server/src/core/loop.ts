// Fixed-step simulation: 30 Hz accumulator on performance.now(), woken by setTimeout(…, 1) (setInterval runs at
// ~21 Hz on Windows). Snapshots at 20 Hz; sockets with too much buffered data skip a snapshot.
import { encodeMsg } from '@dead-air/shared/envelope.ts';
import type { Snapshot } from '@dead-air/shared/state.ts';
import { NET, SNAPSHOT_HZ, TICK_HZ } from '@dead-air/shared/constants.ts';
import type { ServerContext } from './types.ts';
import type { Internals } from './context.ts';
import type { CrewCore } from './crews.ts';
import { rateLimited } from './log.ts';
import { buildCrewSnapshot, snapshotFor } from './snapshot.ts';

const STEP_MS = 1000 / TICK_HZ;
const SNAP_MS = 1000 / SNAPSHOT_HZ;

export function startLoop(ctx: ServerContext, internals: Internals, crews: CrewCore): { stop(): void } {
  const warn = rateLimited(ctx.log('loop'));
  const stats = internals.stats;
  stats.startedAt = performance.now();
  let last = performance.now();
  let acc = 0;
  let snapAcc = 0;
  let sweepAcc = 0;
  let timer: NodeJS.Timeout | null = null;
  let running = true;

  const tickAll = (dt: number) => {
    stats.ticks++;
    for (const crew of crews.list()) {
      crew.tick++;
      for (const sys of internals.systems) {
        try {
          sys.tick(dt, crew, ctx);
        } catch (e) {
          warn(`system ${sys.name} threw`, e instanceof Error ? (e.stack ?? e.message) : e);
        }
      }
    }
  };

  const sendSnapshots = () => {
    stats.snaps++;
    for (const crew of crews.list()) {
      let base: Snapshot | null = null;
      for (const p of crew.players.values()) {
        const s = p.socket;
        if (!p.connected || !s || s.readyState !== 1) continue;
        if (s.bufferedAmount > NET.maxBufferedBytes) { stats.snapSkipped++; continue; }
        base ??= buildCrewSnapshot(ctx, crew);
        s.send(encodeMsg({ op: 'snap', s: snapshotFor(ctx, crew, base, p) }));
      }
    }
  };

  const frame = () => {
    if (!running) return;
    const now = performance.now();
    let el = now - last;
    last = now;
    if (el > 250) el = 250; // after a stall: drop time instead of spiralling
    acc += el;
    snapAcc += el;
    sweepAcc += el;
    while (acc >= STEP_MS) {
      acc -= STEP_MS;
      tickAll(STEP_MS / 1000);
    }
    if (snapAcc >= SNAP_MS) {
      // keep at most one interval of debt: a late frame sends now and the next one right after, so loop jitter
      // (15.6 ms Windows timers, GC, a busy host) no longer silently drops snapshots (measured 16 Hz under load);
      // a long stall still yields at most one extra snapshot, never a burst
      snapAcc = Math.min(snapAcc - SNAP_MS, SNAP_MS);
      try { sendSnapshots(); } catch (e) { warn('snapshot failed', e instanceof Error ? (e.stack ?? e.message) : e); }
    }
    if (sweepAcc >= 1000) {
      sweepAcc = 0;
      crews.sweep(now);
    }
    timer = setTimeout(frame, 1);
  };
  timer = setTimeout(frame, 1);

  return {
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
    },
  };
}
