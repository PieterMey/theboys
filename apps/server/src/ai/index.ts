// Owner: track (e) AI + speech (apps/server/src/ai/**, apps/server/src/stt/**). Server plugin entry.
//  - configures the AI gateway (AI_MODE mock|record|replay|live, budget balance.core.aiBudgetUsdPerSession)
//  - installs the STT bridge (apps/server/src/stt) -> onUtterance
//  - registers the Listener brain + director picker with (c) monsters (guarded import, retried on phase changes)
//  - 'ai.status' request (host-only HUD line) + dev-only dbg.ai.* helpers
//  - live mode: free JEV health check + Haiku warm-up calls (compile the Listener + lure schema grammars) at boot
//  - the Listener speaks: speakLure (lure.ts) is called by (c) monsters on radio_lure; dbg.ai.lure triggers it
import { timingSafeEqual } from 'node:crypto';
import type { ListenerInput, ShiftSummary } from '@dead-air/shared/messages/ai.ts';
import type { WorkOrder } from '@dead-air/shared/workorder.ts';
import type { ServerContext } from '../core/types.ts';
import { configureGateway, jevHealthCheck } from './gateway.ts';
import { setCtx } from './hub.ts';
import { aiStatus, briefFor, directorPick, listenerIntent, reviewFor } from './api.ts';
import { depsLoaded, loadDeps, monstersApi, onDepLoaded } from './adapters.ts';
import { runHaiku, prepare } from './listener.ts';
import { install as installStt } from '../stt/index.ts';
import { lureStatus, recentLures, resetLureCooldown, speakLure, warmLure } from './lure.ts';
import type { LureHeard } from './lure.ts';
import type { Vec3 } from '@dead-air/shared/state.ts';
import { CALLSIGN_INFO } from '@dead-air/shared/callsign.ts';

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export async function install(ctx: ServerContext): Promise<void> {
  const log = ctx.log('ai');
  setCtx(ctx);
  configureGateway({
    mode: ctx.env.AI_MODE,
    flags: ctx.flags,
    bal: () => (ctx.balance.ai ?? {}) as Record<string, unknown>,
    budgetUsd: () => Number(ctx.balance.core.aiBudgetUsdPerSession ?? 3),
    log,
  });
  installStt(ctx);

  // ---- (c) monsters: Listener brain + director picker ----
  let brainWired = false;
  let pickerWired = false;
  const wireMonsters = () => {
    const m = monstersApi();
    if (!m) return;
    try {
      if (!brainWired && typeof m.listener?.setBrain === 'function') {
        m.listener.setBrain(listenerIntent as never);
        brainWired = true;
        log.info('Listener brain registered with monsters (JEV -> Haiku -> rules)');
      }
      if (!pickerWired && typeof m.director?.setPicker === 'function') {
        m.director.setPicker(directorPick as never);
        pickerWired = true;
        log.info('director picker registered with monsters (JEV -> weighted random)');
      }
    } catch (e) {
      log.warn(`monsters wiring failed: ${e instanceof Error ? e.message : e}`);
    }
  };
  onDepLoaded((name) => { if (name === 'monsters') wireMonsters(); });
  await loadDeps();
  wireMonsters();
  ctx.hooks.phase.push(() => {
    if (!brainWired || !pickerWired) void loadDeps().then(wireMonsters);
  });

  ctx.registerReq('ai.status', (_crew, _player, args) => {
    const admin = typeof args?.admin === 'string' ? args.admin : '';
    if (!ctx.env.dev && !(admin && safeEq(admin, ctx.env.ADMIN_TOKEN))) throw new Error('admin only');
    return aiStatus();
  });

  // ---- dev-only helpers ----
  ctx.registerDbg('ai.status', () => ({ ...aiStatus(), deps: depsLoaded(), brainWired, pickerWired }));
  ctx.registerDbg('ai.listener', (_crew, _p, args) => listenerIntent((args as { input: ListenerInput }).input));
  ctx.registerDbg('ai.director', (_crew, _p, args) => {
    const a = (args ?? {}) as { state?: unknown; allowed?: string[] };
    return directorPick(a.state ?? {}, a.allowed ?? []);
  });
  ctx.registerDbg('ai.brief', (_crew, _p, args) => briefFor((args as { order: WorkOrder }).order));
  ctx.registerDbg('ai.review', (_crew, _p, args) => reviewFor((args as { shift: ShiftSummary }).shift));
  // voice a radio lure now (no monsters needed): { victim?, heard?: [{text, speaker?, room?, agoSec?}], room?, intercom?: [x,y,z], force? }
  ctx.registerDbg('ai.lure', (crew, player, args) => {
    const a = (args ?? {}) as { victim?: string; heard?: LureHeard[]; room?: string; intercom?: Vec3; force?: boolean };
    if (a.force !== false) resetLureCooldown(crew.code);
    const victim = a.intercom ? null : (a.victim ?? player.id);
    const known = (crew.layout?.spaces ?? []).map((sp) => sp.callsign).filter((c): c is string => !!c && c !== 'VAN' && c !== 'LOBBY');
    // room '*' = this layout's first callsign; '{ROOM}' in heard lines = its spoken form
    const room = a.room === '*' ? (known[0] ?? null) : (a.room ?? null);
    const spoken = room ? (CALLSIGN_INFO[room]?.forms[0] ?? room.toLowerCase()) : 'boiler room';
    const heard = (Array.isArray(a.heard) ? a.heard : []).map((h) => ({ ...h, text: String(h.text ?? '').replace(/\{ROOM\}/g, spoken) }));
    let garbled = false;
    const started = speakLure({
      crew, victim, viaWalkie: !a.intercom, intercom: a.intercom ? { id: 'dbg', p: a.intercom } : null, room,
      knownRooms: known, heard,
    }, () => {
      garbled = true;
      ctx.emit(crew, 'monsters.lure', a.intercom ? { to: [], clip: 'sfx.listener_radio_whisper.1', ms: 2600, p: a.intercom, intercom: 'dbg' } : { to: [victim ?? player.id], clip: 'sfx.listener_radio_whisper.1', ms: 2600 });
    });
    return { started, garbled, room, rooms: known, recent: recentLures().slice(-1) };
  });
  ctx.registerDbg('ai.lures', (crew, _p, args) => {
    if ((args as { reset?: boolean } | null)?.reset) resetLureCooldown(crew.code);
    return { recent: recentLures(), status: lureStatus() };
  });

  const mode = ctx.env.AI_MODE;
  log.info(`AI gateway mode=${mode} budget=$${Number(ctx.balance.core.aiBudgetUsdPerSession ?? 3)} deps=${JSON.stringify(depsLoaded())}`);
  if ((mode === 'live' || mode === 'record') && ctx.flags.ai !== false && ctx.env.mode !== 'test') {
    void jevHealthCheck().then(async () => {
      const b = (ctx.balance.ai ?? {}) as Record<string, unknown>;
      if (b.warmupHaiku === false || ctx.flags.listenerAi === false) return;
      // one tiny real call so the Listener schema grammar is compiled before the first real decision
      const input: ListenerInput = {
        crew: '_warmup', listenerRoom: 'BOILER', knownRooms: ['BOILER', 'CHAPEL'],
        heard: [{ speaker: 'w1', text: 'meet me in the chapel', room: 'BOILER', agoSec: 1 }],
        players: [{ id: 'w1', name: 'Warmup' }],
      };
      const p = prepare(input);
      if (!p) return;
      const t0 = performance.now();
      const r = await runHaiku(input, p, ctx.env.MODEL_FAST, 15_000);
      log.info(`Haiku warm-up ${r ? 'ok' : 'failed'} in ${Math.round(performance.now() - t0)} ms`);
      if (b.warmupLure === false || ctx.flags.listenerVoice === false) return;
      const t1 = performance.now();
      const w = await warmLure(ctx.env.MODEL_FAST);
      log.info(`lure warm-up ${w ? 'ok' : 'failed'} in ${Math.round(performance.now() - t1)} ms`);
    });
  }
}
