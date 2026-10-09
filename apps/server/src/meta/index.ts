// Owner: track (d) Meta (apps/server/src/meta/**). Server plugin entry: hub/board/ready/drive/contract/results flow,
// shop, quota, XP, saves, claim codes. Cross-track APIs are reached through ./adapters.ts (guarded; fallbacks).
import type { ServerContext, ServerPlayer, Crew } from '../core/types.ts';
import { SYSTEM_ORDER } from '../core/types.ts';
import { isObserver } from '../core/crews.ts';
import { registerHttpRoute } from '../core/ws.ts';
import type { ReqArgs, ReqName } from '@dead-air/shared/messages/index.ts';
import type { ReqHandler } from '../core/types.ts';
import type { ItemEvent } from '@dead-air/shared/messages/interaction.ts';
import type { MonsterEvent } from '@dead-air/shared/messages/monsters.ts';
import * as A from './adapters.ts';
import {
  P, S, allReady, attachPlayer, buy, claim, continueFromResults, continueVote, finishContract, loadoutMax, markDirty, newBoard,
  onForeignPhase, pick, poolConsumed, recordDeath, recordUtterance, refreshBoard, regenPin, saveOf, setProfile, setRuntime, startDrive,
  tickCrew, view,
} from './flow.ts';
import type { RawResult } from './flow.ts';
import { SaveStore, savesDir } from './saves.ts';
import { economyFrom, levelFor } from './economy.ts';
import { installCrafting } from './crafting.ts';
import { validateLoadout } from './pool.ts';
import {
  contractBuf, recordStat, statDecision, statDeath, statDeposit, statDoor, statItemEvent, statLoud, statMelee, statMonsterEvent,
  statPhenomenon, statRevive, statUtterance,
} from './stats.ts';
import { canRead, statsReply, statsRoute } from './records.ts';
import { dbgRing, dbgState, phoneReq } from './company.ts';

/** hub interactable kind -> client screen ('workbench' and 'stash' belong to the workshop: never add them here) */
const SCREEN_FOR: Record<string, string> = { board: 'board', shop: 'shop', mirror: 'mirror', kennel: 'kennel', console: 'console', records: 'stats' };

export async function install(ctx: ServerContext): Promise<void> {
  const log = ctx.log('meta');
  const mb = () => (ctx.balance.meta ?? {}) as Record<string, unknown>;
  const store = new SaveStore(savesDir(ctx.env.ROOT), Number(mb().saveDebounceMs ?? 400), (m) => log.warn(m));
  setRuntime({ ctx, store, shiftEndFns: [] });

  // ---- cross-track wiring (runs when each module first loads; retried every 5 s while missing)
  const wire = (name: keyof A.Adapters): void => {
    if (name === 'objectives') {
      const on = A.fn<(f: (crew: Crew, result: RawResult) => void) => void>('objectives', 'onContractEnd');
      on?.((crew, result) => {
        try {
          finishContract(crew, result ?? {}, typeof result?.outcome === 'string' ? result.outcome : undefined);
        } catch (e) {
          log.error('finishContract failed:', e instanceof Error ? (e.stack ?? e.message) : e);
        }
      });
    } else if (name === 'interaction') {
      const onInteract = A.fn<(kind: string, f: (crew: Crew, player: ServerPlayer, targetId: string) => boolean) => void>('interaction', 'onInteract');
      for (const kind of Object.keys(SCREEN_FOR)) {
        onInteract?.(kind, (crew, player) => {
          if (kind !== 'console' && crew.phase !== 'hub') return false;
          ctx.emit(crew, 'meta.open', { screen: SCREEN_FOR[kind] }, { to: [player.id] });
          return true;
        });
      }
      const onDeath = A.fn<(f: (crew: Crew, who: unknown, cause: unknown) => void) => void>('interaction', 'onDeath');
      onDeath?.((crew, who, cause) => {
        const pid = typeof who === 'string' ? who : String((who as { id?: unknown } | null)?.id ?? '');
        if (!pid) return;
        recordDeath(crew, pid, cause as A.DeathCause | undefined);
        const c = cause as { killer?: unknown } | string | undefined;
        statDeath(crew, pid, typeof c === 'string' ? c : String(c?.killer ?? 'UNKNOWN'));
      });
      // v1.2 stats (counters only)
      A.fn<(f: (crew: Crew, pid: string, items: { type: string; value?: number }[]) => void) => void>('interaction', 'onDeposit')?.((crew, pid, items) => statDeposit(crew, pid, items));
      A.fn<(f: (crew: Crew, pid: string, how: string, by: string | null) => void) => void>('interaction', 'onRevive')?.((crew, pid, how, by) => statRevive(crew, pid, how, by));
      A.fn<(f: (crew: Crew, id: number, open: boolean, by: string | null) => void) => void>('interaction', 'onDoor')?.((crew, id, open, by) => statDoor(crew, id, open, by));
      // returns nothing: a stats subscriber never claims a melee hit
      A.fn<(f: (crew: Crew, pid: string) => void) => void>('interaction', 'onMelee')?.((crew, pid) => { statMelee(crew, pid); });
      A.fn<(f: (crew: Crew, e: ItemEvent) => void) => unknown>('interaction', 'onItemEvent')?.((crew, e) => {
        statItemEvent(crew, e);
        if (e?.kind === 'consume') poolConsumed(crew, e.pid, e.type, Number(e.count ?? 1));
      });
    } else if (name === 'monsters') {
      A.fn<(f: (crew: Crew, e: MonsterEvent) => void) => unknown>('monsters', 'onMonsterEvent')?.((crew, e) => statMonsterEvent(crew, e));
      A.fn<(f: (crew: Crew, d: { valid?: boolean; action?: string; speakerId?: string | null }) => void) => unknown>('monsters', 'listener.onDecision')?.((crew, d) => statDecision(crew, d));
    } else if (name === 'ai') {
      const onUtt = A.fn<(f: (crew: Crew, u: { speaker: string; text: string; hearers?: { listener?: boolean } }) => void) => void>('ai', 'onUtterance');
      onUtt?.((crew, u) => {
        if (u?.hearers?.listener && typeof u.speaker === 'string') recordUtterance(crew, u.speaker, u.text);
        // the personnel file counts lines, never their text
        if (typeof u?.speaker === 'string') statUtterance(crew, u.speaker);
      });
    } else if (name === 'paranormal') {
      A.fn<(f: (crew: Crew, rec: { witnesses?: string[] }) => void) => unknown>('paranormal', 'onPhenomenon')?.((crew, rec) => statPhenomenon(crew, rec));
    }
  };
  A.setAdapterLog(log, (name) => wire(name));
  await A.loadAll();
  installCrafting(ctx);

  // ---- hooks
  const ensureHubLayout = (crew: Crew) => {
    if (crew.phase === 'hub' && (!crew.layout || crew.layout.kind !== 'hub')) crew.layout = A.generateHubLayout();
  };
  // run FIRST so ② / ⑤ join hooks already see the hub layout (spawns)
  ctx.hooks.join.unshift(function metaEarlyJoin(crew) {
    const fresh = !crew.slices.meta;
    S(crew);
    if (fresh && crew.phase !== 'hub' && !crew.layout) crew.phase = 'hub'; // restored crew after a restart: back to the van
    ensureHubLayout(crew);
  });
  ctx.hooks.join.push(function metaJoin(crew, player) {
    attachPlayer(crew, player);
    const s = S(crew);
    if (crew.phase === 'hub' && !s.orders.length) newBoard(crew);
    refreshBoard(crew);
    markDirty(crew);
  });
  ctx.hooks.leave.push(function metaLeave(crew, _player, info) {
    if (crew.slices.meta) {
      refreshBoard(crew);
      markDirty(crew);
    }
    if (info.final) store.flush();
  });
  ctx.hooks.phase.unshift(function metaEarlyPhase(crew, _from, to) {
    if (to === 'hub' && (!crew.layout || crew.layout.kind !== 'hub')) crew.layout = A.generateHubLayout();
  });
  ctx.hooks.phase.push(function metaPhase(crew, from, to) {
    onForeignPhase(crew, from, to);
  });
  // v1.2 stats: screams (rising edges into band 4); radio seconds come from the tick sampler
  ctx.hooks.loud.push(function metaLoud(crew, player, prevBand) {
    statLoud(crew, player, prevBand);
  });
  ctx.hooks.fullState.push(function metaFull(crew, player, state) {
    const s = S(crew);
    state.meta = view(crew, player);
    state.workOrders = s.orders;
    state.activeOrder = s.active;
  });

  // ---- system
  let n = 0;
  ctx.registerSystem({
    name: 'meta',
    order: SYSTEM_ORDER.meta,
    tick(_dt, crew) {
      if (++n % 300 === 0) A.retryMissing();
      tickCrew(crew);
    },
  });

  // ---- requests (guarded: a name another track already registered is skipped, not fatal)
  const req = <R extends ReqName>(name: R, h: ReqHandler<R>) => {
    try {
      ctx.registerReq(name, h);
    } catch (e) {
      log.warn(`request ${name} not registered: ${e instanceof Error ? e.message : e}`);
    }
  };
  const leaderOrSolo = (crew: Crew, player: ServerPlayer) => player.isLeader || [...crew.players.values()].filter((p) => p.connected).length <= 1;

  req('meta.ready', (crew, player, args: ReqArgs<'meta.ready'>) => {
    player.ready = !!args?.ready;
    ctx.crews.broadcastRoster(crew);
    markDirty(crew);
    return { ok: true as const };
  });
  req('meta.pick', (crew, player, args) => pick(crew, player, String(args?.orderId ?? '')));
  req('meta.drive', (crew, player, args) => {
    if (crew.phase !== 'hub') return { ok: false, reason: 'not in the van' };
    if (!leaderOrSolo(crew, player)) return { ok: false, reason: 'only the crew leader can drive' };
    const s = S(crew);
    const id = args?.orderId ?? s.picked;
    const o = (id ? s.orders.find((x) => x.id === id) : null) ?? s.orders.find((x) => x.available);
    if (!o) return { ok: false, reason: 'no work order' };
    if (!o.available) return { ok: false, reason: 'requirements not met' };
    startDrive(crew, o);
    return { ok: (crew.phase as string) === 'drive' };
  });
  req('meta.hold', (crew, player, args) => {
    if (crew.phase !== 'hub' || !leaderOrSolo(crew, player)) return { ok: false };
    const s = S(crew);
    s.holdUntil = args?.holding ? ctx.now() + Number(mb().holdDriveSec ?? 3) * 1000 : 0;
    s.holdBy = args?.holding ? player.id : null;
    markDirty(crew);
    return { ok: true };
  });
  req('meta.buy', (crew, player, args) => buy(crew, player, String(args?.item ?? '')));
  req('meta.profile', (crew, player, args) => {
    const r = setProfile(crew, player, args.profile);
    markDirty(crew);
    return r;
  });
  req('meta.newPin', (crew, player) => {
    const claimCode = regenPin(player);
    markDirty(crew);
    return { claim: claimCode };
  });
  req('meta.continue', (crew, player, args) => {
    if (crew.phase !== 'results') return { ok: false, reason: 'no results to close' };
    if ((args as { vote?: unknown } | undefined)?.vote === true) return continueVote(crew, player);
    if (!leaderOrSolo(crew, player)) return { ok: false, reason: 'the crew leader continues' };
    continueFromResults(crew);
    return { ok: true };
  });
  req('meta.state', (crew, player) => ({ meta: view(crew, player), workOrders: S(crew).orders, activeOrder: S(crew).active }));
  // v1.3 F5 Company Line (flag companyLine): answer / say / accept / hang up the van phone
  req('meta.phone', (crew, player, args) => phoneReq(crew, player, args));
  req('claim', (crew, player, args) => {
    const r = claim(crew, player, String(args?.name ?? ''), String(args?.pin ?? ''));
    if (!r.ok) throw new Error(r.reason ?? 'claim failed');
    return { ok: true, level: r.level };
  });

  // ---- v1.2 (meta-records): hand-out priority + personnel file
  req('meta.loadout', (crew, player, args) => {
    const sv = saveOf(player);
    const cur = [...(sv?.loadout ?? [])];
    if (!sv) return { ok: false, reason: 'no save', loadout: cur };
    const v = validateLoadout((args as { order?: unknown } | undefined)?.order, loadoutMax());
    if (!v.ok) return { ok: false, reason: v.reason, loadout: cur };
    sv.loadout = v.loadout;
    store.putPlayer(sv);
    markDirty(crew);
    return { ok: true, loadout: [...v.loadout] };
  });
  req('meta.stats', (crew, player, args) => {
    const me = P(player).saveId;
    const want = typeof (args as { saveId?: unknown } | undefined)?.saveId === 'string' ? String(args!.saveId) : me;
    const live = [...crew.players.values()].filter((p) => !isObserver(p)).map((p) => P(p).saveId);
    if (!canRead(store, me, want, live)) throw new Error('not in a crew with you');
    return statsReply(store, store.playerById(want), me);
  });
  // main menu (before joining): the browser key goes in a header, never the URL; never logged
  registerHttpRoute('/api/stats', statsRoute(store));

  // ---- dev-only test controls
  ctx.registerDbg('meta.endContract', (crew, _p, args) => {
    const a = (args ?? {}) as RawResult & { real?: boolean };
    if (crew.phase !== 'contract') throw new Error(`not in a contract (phase ${crew.phase})`);
    // real: let (a) objectives compute the result (fires onContractEnd -> finishContract)
    if (a.real && A.has('objectives', 'endContract')) {
      A.call('objectives', 'endContract', crew, 'leave');
      return { ok: (crew.phase as string) === 'results', phase: crew.phase, results: S(crew).results };
    }
    const ok = finishContract(crew, a, a.outcome);
    return { ok, phase: crew.phase, results: S(crew).results };
  });
  ctx.registerDbg('meta.contractSec', (_crew, _p, args) => {
    const sec = Number((args as { sec?: unknown } | null)?.sec);
    if (!Number.isFinite(sec) || sec < 5) throw new Error('sec >= 5');
    ctx.balance.core.contractRealSec = sec;
    return { contractRealSec: sec };
  });
  ctx.registerDbg('meta.driveFor', (crew, _p, args) => {
    const sec = Number((args as { sec?: unknown } | null)?.sec ?? 60);
    S(crew).driveEndsAt = ctx.now() + Math.max(1, sec) * 1000;
    markDirty(crew);
    return { ok: crew.phase === 'drive' };
  });
  ctx.registerDbg('meta.skipDrive', (crew) => {
    S(crew).driveEndsAt = 0;
    return { ok: (crew.phase as string) === 'drive' };
  });
  ctx.registerDbg('meta.resultsNow', (crew) => {
    S(crew).resultsEndsAt = 1;
    return { ok: crew.phase === 'results' };
  });
  ctx.registerDbg('meta.setXp', (crew, player, args) => {
    const a = (args ?? {}) as { xp?: number; id?: string };
    const target = a.id ? crew.players.get(a.id) : player;
    const sv = target ? saveOf(target) : null;
    if (!target || !sv) throw new Error('no such player');
    sv.xp = Math.max(0, Number(a.xp ?? 0));
    sv.level = levelFor(economyFrom(ctx.balance.core, mb()), sv.xp);
    target.level = sv.level;
    store.putPlayer(sv);
    refreshBoard(crew);
    ctx.crews.broadcastRoster(crew);
    return { xp: sv.xp, level: sv.level };
  });
  ctx.registerDbg('meta.shift', (crew, _p, args) => {
    const s = S(crew);
    const a = (args ?? {}) as Partial<Record<'contract' | 'hauled' | 'quota' | 'balance' | 'index', number>>;
    for (const k of ['contract', 'hauled', 'quota', 'balance', 'index'] as const) if (typeof a[k] === 'number') s.shift[k] = a[k];
    if (typeof a.quota === 'number') s.shift.quotaLocked = true;
    markDirty(crew);
    return { shift: s.shift };
  });
  ctx.registerDbg('meta.state', (crew, player) => {
    const s = S(crew);
    return {
      phase: crew.phase, picked: s.picked, active: s.active?.id ?? null, orders: s.orders.map((o) => ({ id: o.id, risk: o.risk, available: o.available, siteName: o.siteName })),
      shift: s.shift, gear: s.gear, allReady: allReady(crew), contractId: s.contractId, ended: s.ended, results: s.results, review: s.review,
      you: view(crew, player).you, saveId: P(player).saveId, savesDir: store.dir, writes: store.writes,
      adapters: Object.fromEntries(Object.entries(A.mods).map(([k, v]) => [k, !!v])),
    };
  });
  ctx.registerDbg('meta.flush', () => {
    store.flush();
    return { writes: store.writes, dir: store.dir };
  });
  // v1.2 (meta-records) test controls
  ctx.registerDbg('meta.stats', (crew, player, args) => {
    const a = (args ?? {}) as { id?: string; record?: Record<string, number> };
    const target = a.id ? crew.players.get(a.id) : player;
    if (!target) throw new Error('no such player');
    for (const [k, v] of Object.entries(a.record ?? {})) recordStat(crew, target.id, k, Number(v));
    const sv = saveOf(target);
    return {
      saveId: P(target).saveId, phase: crew.phase, buffer: contractBuf(crew, P(target).saveId), stats: sv?.stats ?? null,
      collection: sv?.collection ?? {}, achievements: sv?.achievements ?? [], loadout: sv?.loadout ?? [],
      shiftStats: S(crew).shiftStats, records: S(crew).records, gear: S(crew).gear,
    };
  });
  ctx.registerDbg('meta.itemEvent', (crew, player, args) => {
    const e = { pid: player.id, id: `dbg${Date.now()}`, ...((args ?? {}) as Partial<ItemEvent>) } as ItemEvent;
    if (!e.kind || !e.type) throw new Error('kind and type');
    const target = crew.players.get(e.pid);
    const before = Object.keys((target && saveOf(target)?.collection) ?? {}).length;
    statItemEvent(crew, e);
    if (e.kind === 'consume') poolConsumed(crew, e.pid, e.type, Number(e.count ?? 1));
    return { ok: true, before, collection: Object.keys((target && saveOf(target)?.collection) ?? {}).length };
  });
  // v1.3 F5 test controls: ring the van phone now ({ force } clears this shift's terms first), dump the call + file
  ctx.registerDbg('meta.phoneRing', (crew, _p, args) => dbgRing(crew, (args as { force?: unknown } | null)?.force === true));
  ctx.registerDbg('meta.phoneState', (crew) => dbgState(crew));
  ctx.registerDbg('meta.collectionReset', (crew, player, args) => {
    const a = (args ?? {}) as { id?: string };
    const target = a.id ? crew.players.get(a.id) : player;
    const sv = target ? saveOf(target) : null;
    if (!sv) throw new Error('no such player');
    sv.collection = {};
    store.putPlayer(sv);
    return { ok: true };
  });

  process.on('exit', () => {
    try { store.flush(); } catch { /* ignore */ }
  });
  log.info(`meta installed (saves: ${store.dir}; adapters: ${Object.entries(A.mods).map(([k, v]) => `${k}=${v ? 'yes' : 'no'}`).join(' ')})`);
}
