// Owner: track ① Net (apps/server/src/net/**). Server plugin entry; see apps/server/src/core/types.ts.
// - Snapshot.aud per receiver (aud.ts), pose validation + 'net.correct' (movement.ts)
// - saves/session.json persistence + restore (session.ts), /api/invite + 'net.invite' (invite.ts)
// - crew.ready / crew.kick / profile.set / consent.set / admin.createCrew (reqs.ts)
// - v1.1: 'net.telemetry' / 'net.perf' + socket close codes (telemetry.ts), 'net.preload' / 'net.loaded' (loading.ts)
// - dev: dbg.net.teleport, dbg.net.validate, dbg.net.stats, dbg.net.aud (also dbg.net.teleport in mode 'test')
import type { ServerContext } from '../core/types.ts';
import { audCrewSnapshot, audForReceiver, audStats, noteLoud } from './aud.ts';
import { makePoseHook, moveStats, serverTeleport, setValidation, startGrace } from './movement.ts';
import { createSession } from './session.ts';
import { installInvite } from './invite.ts';
import { installReqs } from './reqs.ts';
import { netBalance } from './balance.ts';
import { installTelemetry } from './telemetry.ts';
import { installLoading } from './loading.ts';
import type { ServerPlayer } from '../core/types.ts';

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export function install(ctx: ServerContext): void {
  const log = ctx.log('net');

  // ---- audibility ----
  ctx.hooks.crewSnapshot.push(function netAudCrew(crew, snap) { audCrewSnapshot(crew, snap, ctx); });
  ctx.hooks.snapshot.push(function netAudReceiver(crew, receiver, snap) { audForReceiver(crew, receiver, snap, ctx); });
  // last 'loud' message per player: the client resends at least every 500 ms while not silent, so a band that is
  // older than loudStaleMs (frozen tab, dead Wi-Fi, socket not yet closed) is reset to silent: no ghost voices
  const loudMsgAt = new WeakMap<ServerPlayer, number>();
  ctx.hooks.loud.push(function netLoud(_crew, player) { loudMsgAt.set(player, performance.now()); noteLoud(player); });
  ctx.registerSystem({
    name: 'net.loudStale',
    order: 2,
    tick(_dt, crew) {
      const now = performance.now();
      const staleMs = netBalance(ctx).loudStaleMs;
      for (const p of crew.players.values()) {
        if (p.band <= 0 && !(p.radio && !p.connected)) continue;
        if (!p.connected || now - (loudMsgAt.get(p) ?? 0) > staleMs) { p.band = 0; if (!p.connected) p.radio = 0; }
      }
    },
  });

  // ---- movement validation ----
  ctx.hooks.pose.push(makePoseHook(ctx));

  // ---- session persistence ----
  const session = createSession(ctx);
  ctx.hooks.join.push(function netSessionJoin(_crew, player) {
    const order = session.restoredOrder.get(player.id);
    if (order !== undefined) {
      // keep the pre-restart join order (leader = earliest)
      player.joinedAt = -1e9 + order;
      session.restoredOrder.delete(player.id);
    }
    startGrace(player);
    session.schedule();
    if (session.voidedPlayers.delete(player.id)) {
      // after a mid-contract server restart the crew lands back in the van: say why (no silent 'did we fail?')
      const crew = _crew;
      setTimeout(() => {
        if (player.connected) ctx.emit(crew, 'notice', { text: 'The host restarted the game. Contract voided, no penalty.', kind: 'warn' }, { to: [player.id] });
      }, 1500);
    }
  });
  ctx.hooks.leave.push(function netSessionLeave(_crew, _player, info) { if (info.final) session.schedule(); });
  ctx.hooks.phase.push(function netPhase(crew) {
    for (const p of crew.players.values()) startGrace(p);
    session.schedule();
  });

  // ---- invite + requests ----
  installInvite(ctx);
  installReqs(ctx);
  // ---- v1.1: client perf/error/drop telemetry + drive-time preload of the facility ----
  installTelemetry(ctx);
  installLoading(ctx);

  // ---- dev / test hooks ----
  const teleport = (_c: unknown, player: Parameters<typeof serverTeleport>[0], args: unknown) => {
    const a = (args ?? {}) as { x?: unknown; z?: unknown; y?: unknown; yaw?: unknown };
    const x = num(a.x, NaN), z = num(a.z, NaN);
    if (!Number.isFinite(x) || !Number.isFinite(z)) throw new Error('x and z required');
    serverTeleport(player, x, z, typeof a.y === 'number' ? a.y : undefined, typeof a.yaw === 'number' ? a.yaw : undefined);
    return { ok: true as const };
  };
  if (ctx.env.dev) ctx.registerDbg('net.teleport', teleport);
  else if (ctx.env.mode === 'test') ctx.registerReq('dbg.net.teleport', (c, p, a) => teleport(c, p, a));
  ctx.registerDbg('net.validate', (crew, _p, args) => {
    const on = (args as { on?: unknown } | null)?.on !== false;
    setValidation(crew, on);
    return { on };
  });
  ctx.registerDbg('net.stats', () => ({ aud: audStats, move: moveStats, session: { file: session.file, restored: session.restored } }));
  ctx.registerDbg('net.aud', (crew) => {
    const out: Record<string, Record<string, number>> = {};
    for (const p of crew.players.values()) {
      if (!p.connected) continue;
      const snap = { t: 0, tick: 0, players: [], monsters: [], dyn: [], aud: {} as Record<string, number> };
      audForReceiver(crew, p, snap, ctx);
      out[p.id] = snap.aud;
    }
    return out;
  });
  ctx.registerDbg('net.saveSession', () => { session.saveNow(); return { file: session.file }; });

  // ---- host crew (tools/host.mjs sets HOST_CREW): a crew code that always exists, so the invite link
  // printed at the start of the night stays valid through empty lobbies and server restarts ----
  const hostCrew = String(process.env.HOST_CREW ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  if (hostCrew) {
    ctx.registerSystem({
      name: 'net.hostCrew',
      order: 1,
      tick(_dt, crew) {
        if (crew.code === hostCrew) crew.emptySince = 0; // never swept
      },
    });
    const ensure = () => {
      try { if (!ctx.crews.get(hostCrew)) ctx.crews.create(hostCrew); } catch (e) { log.warn('host crew:', e instanceof Error ? e.message : e); }
      setTimeout(ensure, 2000).unref();
    };
    ensure();
  }

  log.info(`net: aud + pose validation + session (${session.file ?? 'off'}) + /api/invite${hostCrew ? ` + host crew ${hostCrew}` : ''}`);
}
