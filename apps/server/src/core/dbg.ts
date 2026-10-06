// Built-in dev-only requests (registered only when NODE_ENV=development; registerDbg is a no-op otherwise).
// Tracks add their own with ctx.registerDbg('<track>.<name>', handler) -> client sends 'dbg.<track>.<name>'.
import type { Phase } from '@dead-air/shared/state.ts';
import type { ServerContext } from './types.ts';
import type { Internals } from './context.ts';

const PHASES: readonly Phase[] = ['hub', 'drive', 'contract', 'results'];

export function installCoreDbg(ctx: ServerContext, internals: Internals): void {
  ctx.registerDbg('ping', () => ({ pong: ctx.now() }));
  ctx.registerDbg('reloadConfig', () => {
    ctx.reloadConfig();
    return { flags: ctx.flags };
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
  ctx.registerDbg('setPhase', (crew, _p, args) => {
    const phase = (args as { phase?: Phase } | null)?.phase;
    if (!phase || !PHASES.includes(phase)) throw new Error(`phase must be one of ${PHASES.join(', ')}`);
    ctx.setPhase(crew, phase);
    return { phase };
  });
}
