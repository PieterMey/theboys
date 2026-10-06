// Owner: track ① Net (apps/client/src/net/**). Client plugin entry; see apps/client/src/core/context.ts.
// Provides services.netstat { rtt, status, jitterMs, interpDelayMs, clockOffsetMs, snapHz, lastSnapAgeMs, corrections }.
// - adaptive interpolation delay (80-250 ms) from snapshot lag jitter (stats.ts)
// - 'net.correct' from the server -> snap the local controller back (services.input.teleport)
// - dev/test: the test API's teleport also moves the player on the server (dbg.net.teleport) so poses validate
// - HUD widget (top-right), error screens: stale build -> reload, kicked, unknown crew
import type { ClientContext } from '../core/context.ts';
import { SYS } from '../core/loop.ts';
import { createNetStats } from './stats.ts';
import { NetErrorScreen, NetHud } from './NetHud.tsx';

declare module '../core/bus.ts' {
  interface BusEvents {
    /** the server rejected our pose and moved us back (already applied via services.input.teleport) */
    'net:correct': { p: [number, number, number]; reason: string };
  }
}

export function install(ctx: ClientContext): void {
  const stats = createNetStats(ctx);
  ctx.services.provide('netstat', stats);

  // ---- server corrections ----
  let rawTeleport: ((x: number, z: number, yaw?: number) => void) | null = null;
  ctx.net.on('net.correct', (d) => {
    stats.noteCorrection();
    const input = ctx.services.use('input');
    const tp = rawTeleport ?? input?.teleport.bind(input);
    tp?.(d.p[0], d.p[2]);
    ctx.bus.emit('net:correct', { p: d.p, reason: d.reason });
  });

  // ---- dev/test: test-API teleports also move us on the server, so the next poses validate ----
  if (ctx.build === 'dev' || ctx.testMode) {
    void ctx.services.wait('input').then((input) => {
      const orig = input.teleport.bind(input);
      rawTeleport = orig;
      input.teleport = (x, z, yaw) => {
        if (ctx.net.status === 'joined') void ctx.net.dbg('net.teleport', { x, z, yaw }).catch(() => { /* prod server: no dbg */ });
        orig(x, z, yaw);
      };
    });
  }

  // ---- error screens ----
  ctx.ui.registerScreen('net-error', NetErrorScreen);
  let everJoined = false;
  ctx.bus.on('net:welcome', () => {
    everJoined = true;
    if (ctx.ui.screen.value.name === 'net-error') ctx.ui.setScreen('none');
  });
  ctx.net.onServerError((code, msg) => {
    // at the first join the Join screen shows bad codes inline; stale builds and kicks always get a screen
    if (code === 'stale_build' || code === 'bad_version' || code === 'kicked' || everJoined) {
      ctx.ui.setScreen('net-error', { code, msg });
    }
  });

  // ---- HUD ----
  ctx.ui.registerHud('top-right', NetHud, { order: 5, id: 'net' });

  // ---- test-only debug handle for gates (tests/gates/g1.mjs): aud, layout, services present ----
  if (ctx.testMode) {
    const SERVICES = ['three', 'render', 'sfx', 'input', 'voice', 'level', 'players', 'netstat'] as const;
    (window as unknown as { __netDebug: unknown }).__netDebug = {
      aud: () => ({ ...ctx.world.aud }),
      layout: () => ctx.world.layout,
      services: () => Object.fromEntries(SERVICES.map((n) => [n, ctx.services.use(n as never) !== undefined])),
      stat: () => ({ rtt: stats.rtt, jitterMs: stats.jitterMs, interpDelayMs: stats.interpDelayMs, snapHz: stats.snapHz, corrections: stats.corrections, status: stats.status }),
      self: () => (ctx.net.me ? ctx.world.players.get(ctx.net.me)?.latest() ?? null : null),
    };
  }

  // ---- diagnostics for __game.state().diag.net (twice a second) ----
  let lastDiag = -Infinity;
  ctx.registerSystem({
    name: 'net.stats',
    order: SYS.net + 1,
    update() {
      const now = performance.now();
      if (now - lastDiag < 500) return; // wall clock: dt is clamped to 0.1 s per frame
      lastDiag = now;
      ctx.diag.net = {
        status: ctx.net.status,
        rtt: Math.round(ctx.net.rtt),
        jitterMs: Math.round(stats.jitterMs),
        interpDelayMs: Math.round(stats.interpDelayMs),
        snapHz: Math.round(stats.snapHz * 10) / 10,
        corrections: stats.corrections,
      };
    },
  });
}
