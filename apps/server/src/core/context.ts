// Builds the ServerContext (plugin API) plus the internal registries the ws/loop modules read.
import { encodeMsg } from '@dead-air/shared/envelope.ts';
import type { ServerMsg } from '@dead-air/shared/envelope.ts';
import type { FullState } from '@dead-air/shared/state.ts';
import type { MetaState } from '@dead-air/shared/messages/meta.ts';
import type { AppConfig } from './config.ts';
import { reloadInto } from './config.ts';
import type { Crew, CrewRegistry, DbgHandler, ServerContext, ServerHooks, ServerPlayer, ServerSystem, VoiceChunkHandler } from './types.ts';
import { makeLogger } from './log.ts';
import { runHooks } from './hooks.ts';
import { buildCrewSnapshot, snapshotFor } from './snapshot.ts';

export type AnyReqHandler = (crew: Crew, player: ServerPlayer, args: unknown) => unknown;

export interface Internals {
  systems: ServerSystem[];
  reqs: Map<string, AnyReqHandler>;
  voice: VoiceChunkHandler[];
  stats: { ticks: number; snaps: number; snapSkipped: number; startedAt: number };
}

export function defaultMeta(ctx: ServerContext): MetaState {
  const start = Number(ctx.balance.core.startScrip ?? 150);
  return { shift: { index: 0, contract: 0, quota: 0, hauled: 0, balance: start, quotasMet: 0 }, careers: {}, shop: [] };
}

export function createContext(cfg: AppConfig): { ctx: ServerContext; internals: Internals; setCrews(c: CrewRegistry): void } {
  const log = makeLogger('core');
  const internals: Internals = { systems: [], reqs: new Map(), voice: [], stats: { ticks: 0, snaps: 0, snapSkipped: 0, startedAt: performance.now() } };
  const hooks: ServerHooks = { join: [], leave: [], phase: [], pose: [], loud: [], crewSnapshot: [], snapshot: [], fullState: [], welcome: [], config: [] };
  let crews: CrewRegistry | null = null;

  const send = (player: ServerPlayer, msg: ServerMsg): void => {
    const s = player.socket;
    if (s && s.readyState === 1) s.send(encodeMsg(msg));
  };

  const ctx: ServerContext = {
    cfg,
    flags: cfg.flags,
    balance: cfg.balance,
    env: cfg.env,
    log: makeLogger,
    get crews(): CrewRegistry {
      if (!crews) throw new Error('crew registry not ready');
      return crews;
    },
    registerSystem(sys) {
      if (internals.systems.some((s) => s.name === sys.name)) throw new Error(`system ${sys.name} already registered`);
      internals.systems.push(sys);
      internals.systems.sort((a, b) => a.order - b.order);
    },
    registerReq(name, handler) {
      if (internals.reqs.has(name)) throw new Error(`request ${name} already registered`);
      internals.reqs.set(name, handler as AnyReqHandler);
    },
    registerDbg(name: string, handler: DbgHandler) {
      if (!cfg.env.dev) return;
      const full = name.startsWith('dbg.') ? name : `dbg.${name}`;
      internals.reqs.set(full, handler);
    },
    onVoiceChunk(fn) {
      internals.voice.push(fn);
    },
    emit(crew, e, d, opts) {
      let buf: Uint8Array | null = null;
      for (const p of crew.players.values()) {
        if (!p.connected || !p.socket || p.socket.readyState !== 1) continue;
        if (opts?.to && !opts.to.includes(p.id)) continue;
        if (opts?.except && opts.except.includes(p.id)) continue;
        buf ??= encodeMsg({ op: 'ev', e, d, t: ctx.now() });
        p.socket.send(buf);
      }
    },
    send,
    sendSig(crew, from, to, d) {
      const target = crew.players.get(to);
      if (target) send(target, { op: 'sig', from, d });
    },
    notice(crew, text, kind = 'info') {
      ctx.emit(crew, 'notice', { text, kind });
    },
    hooks,
    setPhase(crew, phase, layout) {
      const from = crew.phase;
      crew.phase = phase;
      if (layout !== undefined) crew.layout = layout;
      runHooks(ctx, 'phase', hooks.phase, crew, from, phase);
      for (const p of crew.players.values()) {
        if (p.connected) send(p, { op: 'ev', e: 'phase', d: { phase, state: ctx.buildFullState(crew, p) }, t: ctx.now() });
      }
      ctx.crews.broadcastRoster(crew);
      log.info(`crew ${crew.code}: phase ${from} -> ${phase}`);
    },
    buildFullState(crew, player) {
      const state: FullState = {
        phase: crew.phase,
        layout: crew.layout,
        workOrders: [],
        activeOrder: null,
        clockMin: -1,
        objectives: null,
        interaction: null,
        meta: defaultMeta(ctx),
        snap: snapshotFor(ctx, crew, buildCrewSnapshot(ctx, crew), player),
      };
      runHooks(ctx, 'fullState', hooks.fullState, crew, player, state);
      return state;
    },
    now: () => performance.timeOrigin + performance.now(),
    reloadConfig() {
      try {
        reloadInto(cfg);
        log.info('config reloaded');
        runHooks(ctx, 'config', hooks.config);
      } catch (e) {
        log.error('config reload failed (old values kept):', e instanceof Error ? e.message : e);
      }
    },
  };
  return { ctx, internals, setCrews: (c) => { crews = c; } };
}
