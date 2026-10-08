// Built-in dev-only requests (registered only when NODE_ENV=development; registerDbg is a no-op otherwise).
// Tracks add their own with ctx.registerDbg('<track>.<name>', handler) -> client sends 'dbg.<track>.<name>'.
import { monitorEventLoopDelay } from 'node:perf_hooks';
import type { Phase } from '@dead-air/shared/state.ts';
import type { ServerContext } from './types.ts';
import type { Internals } from './context.ts';
import { runHooks } from './hooks.ts';

const PHASES: readonly Phase[] = ['hub', 'drive', 'contract', 'results'];

export function installCoreDbg(ctx: ServerContext, internals: Internals): void {
  ctx.registerDbg('ping', () => ({ pong: ctx.now() }));
  ctx.registerDbg('reloadConfig', () => {
    ctx.reloadConfig();
    return { flags: ctx.flags };
  });
  // kill-switch tests: { set: { mirrors: false, ... } } flips flags IN MEMORY (booleans only; config/flags.json is
  // untouched, dbg.reloadConfig restores it); config hooks run as on a reload. Clients pick the live flags up at their
  // next page load (/healthz `flags`, apps/client/src/core/flags.ts).
  ctx.registerDbg('setFlags', (_crew, _p, args) => {
    const set = (args as { set?: Record<string, unknown> } | null)?.set ?? {};
    const applied: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(set)) if (typeof v === 'boolean') ctx.flags[k] = applied[k] = v;
    runHooks(ctx, 'config', ctx.hooks.config);
    return { applied, flags: ctx.flags };
  });
  ctx.registerDbg('stats', () => {
    const s = internals.stats;
    const sec = (performance.now() - s.startedAt) / 1000;
    return { ticks: s.ticks, tickHz: s.ticks / sec, snaps: s.snaps, snapHz: s.snaps / sec, snapSkipped: s.snapSkipped, crews: ctx.crews.list().length };
  });
  ctx.registerDbg('state', (crew) => ({
    code: crew.code,
    phase: crew.phase,
    tick: crew.tick,
    layout: crew.layout ? { seed: crew.layout.seed, hash: crew.layout.hash } : null,
    slices: Object.keys(crew.slices),
    players: [...crew.players.values()].map((p) => ({
      id: p.id, name: p.name, connected: p.connected, ready: p.ready, alive: p.alive, isLeader: p.isLeader,
      band: p.band, radio: p.radio, pose: p.pose,
    })),
    systems: internals.systems.map((s) => `${s.order}:${s.name}`),
    reqs: [...internals.reqs.keys()],
  }));
  // dev-only cost probe (QA): ms of CPU per wall second per system / snapshot hook + event-loop delay, since the
  // previous call. The first call installs the timers (wrappers) and returns zeros.
  let perf: { since: number; cost: Map<string, number>; eld: ReturnType<typeof monitorEventLoopDelay> } | null = null;
  const timed = <F extends (...a: never[]) => unknown>(key: string, fn: F): F => (function (this: unknown, ...a: never[]) {
    const t0 = performance.now();
    try { return fn.apply(this, a); } finally { if (perf) perf.cost.set(key, (perf.cost.get(key) ?? 0) + performance.now() - t0); }
  }) as F;
  ctx.registerDbg('perf', () => {
    if (!perf) {
      perf = { since: performance.now(), cost: new Map(), eld: monitorEventLoopDelay({ resolution: 10 }) };
      perf.eld.enable();
      for (const s of internals.systems) s.tick = timed(`tick:${s.name}`, s.tick.bind(s));
      for (const k of ['crewSnapshot', 'snapshot', 'pose', 'loud'] as const) {
        const list = ctx.hooks[k] as unknown as ((...a: never[]) => unknown)[];
        for (let i = 0; i < list.length; i++) list[i] = timed(`${k}:${list[i].name || i}`, list[i]);
      }
      return { installed: true };
    }
    const sec = Math.max(0.001, (performance.now() - perf.since) / 1000);
    const out = Object.fromEntries([...perf.cost].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round((v / sec) * 10) / 10]));
    const ms = (v: number) => Math.round(v / 1e4) / 100;
    const eld = { p50: ms(perf.eld.percentile(50)), p99: ms(perf.eld.percentile(99)), max: ms(perf.eld.max), mean: ms(perf.eld.mean) };
    perf.cost.clear();
    perf.eld.reset();
    perf.since = performance.now();
    return { sec: Math.round(sec * 10) / 10, msPerSec: out, eventLoopDelayMs: eld };
  });
  ctx.registerDbg('setPhase', (crew, _p, args) => {
    const phase = (args as { phase?: Phase } | null)?.phase;
    if (!phase || !PHASES.includes(phase)) throw new Error(`phase must be one of ${PHASES.join(', ')}`);
    ctx.setPhase(crew, phase);
    return { phase };
  });
}
