// window.__game (GameTestApi, packages/shared/src/test-api.ts), installed only with ?test=1.
import type { GameTestApi } from '@dead-air/shared/test-api.ts';
import type { ClientContext } from './context.ts';

export function installTestApi(ctx: ClientContext): void {
  const api: GameTestApi = {
    ready: () => ctx.readiness.isReady() && ctx.loop.perf.frames > 2,
    backend: () => ctx.services.use('three')?.backend ?? 'none',
    async join(crew, name) {
      ctx.audio.unlock();
      await ctx.net.join(crew, name);
      ctx.ui.setScreen('none');
    },
    me: () => ctx.net.me,
    state: () => {
      const w = ctx.world;
      return JSON.parse(JSON.stringify({
        phase: w.phase,
        me: w.me,
        net: ctx.net.status,
        crew: w.crew,
        players: [...w.players.entries()].map(([id, b]) => ({ id, ...b.latest() })),
        monsters: [...w.monsters.entries()].map(([id, b]) => ({ id, ...b.latest() })),
        objectives: w.full?.objectives ?? null,
        interaction: w.full?.interaction ?? null,
        layout: w.layout ? { seed: w.layout.seed, hash: w.layout.hash, W: w.layout.W, H: w.layout.H } : null,
        screen: ctx.ui.screen.value.name,
        pending: ctx.readiness.pending(),
        diag: ctx.diag,
      }));
    },
    perf: () => {
      const r = ctx.services.use('three')?.renderer;
      return { fps: ctx.loop.perf.fps, frameMs: ctx.loop.perf.frameMs, drawCalls: r?.info.render.drawCalls };
    },
    teleport: (x, z, yaw) => ctx.services.use('input')?.teleport(x, z, yaw),
    look: (yaw, pitch) => ctx.services.use('input')?.look(yaw, pitch),
    setInput: (input) => ctx.services.use('input')?.setInput(input),
    errors: () => ctx.errors(),
    /** test-only: any game request (e.g. meta.pick / meta.ready / meta.drive) */
    req: (r: string, a?: unknown) => (ctx.net as any).req(r, a ?? {}),
    dbg: (r, a) => ctx.net.dbg(r, a),
  };
  window.__game = api;
}
