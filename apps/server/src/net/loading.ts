// Owner: track ① Net (v1.1 loading). Lets clients build the facility DURING the drive instead of after it:
//   'net.preload' (client, on entering the drive): the facility layout meta prepared for this drive
//     (crew.slices.meta.pendingLayout, read-only) -> { layout, hash }. Marks the player as preloading that hash.
//   'net.loaded' { hash, ok, ms } (client, once it has built the facility and rendered warm-up frames):
//     marks the player loaded; the crew gets a 'net.loading' event { waiting: names } for the drive screen.
// meta/flow.ts ends the drive only when every connected player that asked for a preload has reported it loaded
// (or at most driveLoadWaitSec after the drive timer): see crewLoaded() there. Players that never asked (bots, old
// clients) are not waited for. Request/event names are typed in messages/net.ts; registered through a loose cast.
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import type { Crew, ServerContext, ServerPlayer } from '../core/types.ts';

/** per-player slice (player.slices.loading), read by meta/flow.ts */
export interface PlayerLoading { want: string | null; loaded: string | null; at: number }

type LooseReq = (name: string, h: (crew: Crew, player: ServerPlayer, args: unknown) => unknown) => void;
type LooseEmit = (crew: Crew, e: string, d: unknown) => void;

export function loadingOf(p: ServerPlayer): PlayerLoading {
  return ((p.slices.loading as PlayerLoading | undefined) ??= { want: null, loaded: null, at: 0 });
}

function pendingLayout(crew: Crew): LevelLayout | null {
  const m = crew.slices.meta as { pendingLayout?: LevelLayout | null } | undefined;
  return crew.phase === 'drive' ? (m?.pendingLayout ?? null) : null;
}

/** names of connected players still building the layout `hash` */
export function waitingFor(crew: Crew, hash: string): string[] {
  const out: string[] = [];
  for (const p of crew.players.values()) {
    if (!p.connected) continue;
    const l = p.slices.loading as PlayerLoading | undefined;
    if (l && l.want === hash && l.loaded !== hash) out.push(p.name);
  }
  return out;
}

export function installLoading(ctx: ServerContext): void {
  const log = ctx.log('loading');
  const reg = ctx.registerReq as unknown as LooseReq;
  const emit = ctx.emit as unknown as LooseEmit;
  const broadcast = (crew: Crew, hash: string) => emit(crew, 'net.loading', { hash, waiting: waitingFor(crew, hash) });

  reg('net.preload', (crew, player) => {
    const L = pendingLayout(crew);
    if (!L) return { layout: null, hash: null };
    const l = loadingOf(player);
    l.want = L.hash;
    if (l.loaded !== L.hash) l.loaded = null;
    l.at = performance.now();
    broadcast(crew, L.hash);
    return { layout: L, hash: L.hash };
  });

  reg('net.loaded', (crew, player, args) => {
    const a = (args && typeof args === 'object' ? args : {}) as { hash?: unknown; ok?: unknown; ms?: unknown };
    const hash = typeof a.hash === 'string' ? a.hash.slice(0, 80) : '';
    if (!hash) return { ok: false };
    const l = loadingOf(player);
    l.want = l.want ?? hash;
    l.loaded = hash;
    const ms = typeof a.ms === 'number' && Number.isFinite(a.ms) ? Math.round(a.ms) : -1;
    log.info(`${player.name} preloaded the site in ${ms >= 0 ? `${(ms / 1000).toFixed(1)} s` : '?'}${a.ok === false ? ' (with errors)' : ''} (crew ${crew.code}, phase ${crew.phase})`);
    broadcast(crew, hash);
    return { ok: true, waiting: waitingFor(crew, hash) };
  });

  // a player that drops mid-drive must not hold the van (connected-only check), but tell the others
  ctx.hooks.leave.push(function loadingLeave(crew) {
    const L = pendingLayout(crew);
    if (L) broadcast(crew, L.hash);
  });
  // a new drive / any phase change resets the per-player marks of the old layout
  ctx.hooks.phase.push(function loadingPhase(crew, _from, to) {
    if (to === 'drive' || to === 'hub') for (const p of crew.players.values()) { const l = loadingOf(p); l.want = null; l.loaded = null; }
  });
}
