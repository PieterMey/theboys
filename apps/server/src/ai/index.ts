// Owner: track (e) AI + speech (apps/server/src/ai/**, apps/server/src/stt/**). Server plugin entry.
//  - configures the AI gateway (AI_MODE mock|record|replay|live, budget balance.core.aiBudgetUsdPerSession)
//  - installs the STT bridge (apps/server/src/stt) -> onUtterance
//  - registers the Listener brain + director picker with (c) monsters (guarded import, retried on phase changes)
//  - 'ai.status' request (host-only HUD line) + dev-only dbg.ai.* helpers
//  - live mode: free JEV health check + one Haiku warm-up call (compiles the schema grammar) at boot
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
    });
  }
}
