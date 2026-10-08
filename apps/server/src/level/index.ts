// Owner: track ② Level (apps/server/src/level/**). Layout lifecycle on the server:
//  - hub phase: the fixed hub layout (generateHub)
//  - contract phase: a facility generated for the work order (generateFacilityForCrew), stored in crew.layout,
//    shipped to clients in FullState.layout by the core
//  - per-crew nav cache (edge grid + audibility) for other server tracks: levelOf(crew)
// Other tracks import the exported functions directly: import { levelOf, generateFacilityForCrew } from '../level/index.ts'.
import type { Crew, ServerContext } from '../core/types.ts';
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import type { LevelSummary } from '@dead-air/shared/messages/level.ts';
import { generateFacility, generateHub, resolveTuning, validateLayout } from '@dead-air/shared/procgen/index.ts';
import type { LevelTuning } from '@dead-air/shared/procgen/index.ts';
import { Audibility, buildEdgeGrid, initialDoorOpen } from '@dead-air/shared/nav/index.ts';
import type { DoorOpenFn, EdgeGrid } from '@dead-air/shared/nav/index.ts';

export interface CrewLevel {
  layout: LevelLayout;
  /** edge grid of the layout (walls, doors, fences, solids); door state comes from the caller's doorOpen fn */
  grid: EdgeGrid;
  /** cached sound-metric distances (sealed van cab); call audibility.doorsChanged() when doors change */
  audibility: Audibility;
  /** doors as generated (use the interaction track's live state when available) */
  initialDoorOpen: DoorOpenFn;
}

export interface FacilityRequest {
  seed: string;
  /** crew size for the footprint; default = connected players (1..6) */
  players?: number;
  risk?: number;
  /** v1.2: SiteTheme id (WorkOrder.siteTheme); absent = 'facility' */
  theme?: string;
  /** v1.2: WorkOrder.modifiers */
  modifiers?: readonly string[];
}

let ctxRef: ServerContext | null = null;
let hub: LevelLayout | null = null;
let fallbackCounter = 0;

/** The (cached) hub layout. */
export function hubLayout(): LevelLayout {
  hub ??= generateHub();
  return hub;
}

/** Generator tuning = defaults overlaid with config/balance/level.json (hot-reloaded with the config). */
export function levelTuning(): LevelTuning {
  return resolveTuning((ctxRef?.balance.level as Record<string, unknown> | undefined) ?? null);
}

export function summarize(L: LevelLayout): LevelSummary {
  return { kind: L.kind, seed: L.seed, hash: L.hash, W: L.W, H: L.H, metrics: L.metrics, theme: L.theme };
}

/**
 * Generate a facility for a work order and store it as crew.layout (does NOT change the phase: call
 * ctx.setPhase(crew, 'contract', layout) when the drive ends; setPhase without a layout keeps this one).
 */
export function generateFacilityForCrew(crew: Crew, req: FacilityRequest): LevelLayout {
  const connected = [...crew.players.values()].filter((p) => p.connected).length;
  const players = Math.max(1, Math.min(6, Math.round(req.players ?? (connected || 1))));
  const p = { seed: String(req.seed), players, risk: req.risk ?? 1 };
  let L: LevelLayout;
  try {
    L = generateFacility({ ...p, theme: req.theme, modifiers: req.modifiers }, levelTuning());
  } catch (e) {
    // never fail a drive over a theme / modifier combination: the plain site of the same seed always generates
    ctxRef?.log('level').warn(`themed generation failed (${req.theme ?? '-'} ${(req.modifiers ?? []).join('+')}): ${e instanceof Error ? e.message : e}; plain site instead`);
    L = generateFacility(p, levelTuning());
  }
  crew.layout = L;
  levelOf(crew);
  return L;
}

/** Nav data for the crew's current layout (built once per layout; null without a layout). */
export function levelOf(crew: Crew): CrewLevel | null {
  const L = crew.layout;
  if (!L) return null;
  const cur = crew.slices.level as CrewLevel | undefined;
  if (cur && cur.layout === L) return cur;
  const grid = buildEdgeGrid(L);
  const lv: CrewLevel = { layout: L, grid, audibility: new Audibility(grid, { sealed: [L.van.cab] }), initialDoorOpen: initialDoorOpen(L) };
  crew.slices.level = lv;
  return lv;
}

export function install(ctx: ServerContext): void {
  ctxRef = ctx;
  const log = ctx.log('level');
  hubLayout();

  // every crew starts in the hub: give it the hub layout before the Welcome is built
  ctx.hooks.join.push((crew) => {
    if (!crew.layout) crew.layout = crew.phase === 'contract' ? generateFacilityForCrew(crew, { seed: `${crew.code}-${++fallbackCounter}` }) : hubLayout();
    levelOf(crew);
  });

  // phase changes without an explicit layout: hub -> hub layout; contract -> keep a prepared facility or make one
  ctx.hooks.phase.push((crew, _from, to) => {
    // 'drive' and 'results' keep whatever layout is current (hub while driving, the facility on the results screen)
    if (to === 'hub' && crew.layout?.kind !== 'hub') crew.layout = hubLayout();
    if (to === 'contract' && crew.layout?.kind !== 'facility') {
      const L = generateFacilityForCrew(crew, { seed: `${crew.code}-${++fallbackCounter}` });
      log.info(`crew ${crew.code}: contract without a prepared layout -> generated ${L.seed} (${L.hash})`);
    }
    levelOf(crew);
  });

  ctx.hooks.fullState.push((crew, _player, state) => {
    if (!state.layout) state.layout = crew.layout ?? hubLayout();
  });

  ctx.registerReq('level.get', (crew) => ({ layout: crew.layout }));

  // dev: switch the crew into a contract with a fresh facility (lets other tracks test before the meta track exists)
  ctx.registerDbg('level.generate', (crew, _player, args) => {
    const a = (args ?? {}) as { seed?: string | number; players?: number; risk?: number; theme?: string; modifiers?: unknown };
    const modifiers = Array.isArray(a.modifiers) ? a.modifiers.map(String) : typeof a.modifiers === 'string' ? a.modifiers.split(',').map((m) => m.trim()).filter(Boolean) : undefined;
    const t0 = performance.now();
    const L = generateFacilityForCrew(crew, { seed: String(a.seed ?? `dbg-${Date.now() % 100000}`), players: a.players, risk: a.risk, theme: typeof a.theme === 'string' ? a.theme : undefined, modifiers });
    const ms = performance.now() - t0;
    const v = validateLayout(L);
    if (v.errors.length) log.warn(`generated layout ${L.seed} has invariant errors: ${v.errors.join('; ')}`);
    ctx.setPhase(crew, 'contract', L);
    return { ...summarize(L), genMs: +ms.toFixed(2), errors: v.errors };
  });
  ctx.registerDbg('level.hub', (crew) => {
    ctx.setPhase(crew, 'hub', hubLayout());
    return summarize(hubLayout());
  });
  ctx.registerDbg('level.info', (crew) => (crew.layout ? summarize(crew.layout) : null));

  ctx.hooks.config.push(() => { log.debug('level tuning reloaded'); });
}
