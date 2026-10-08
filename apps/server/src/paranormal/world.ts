// Owner: env-paranormal (v1.2). The live ParaWorld for one crew: reads the §13 providers (interaction, monsters,
// objectives, level, procgen) and degrades to safe defaults while a provider is still a stub.
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import { STANCE } from '@dead-air/shared/state.ts';
import { mirrorsOf } from '@dead-air/shared/procgen/mirrors.ts';
import type { MirrorSpot } from '@dead-air/shared/procgen/mirrors.ts';
import { movableRefsOf } from '@dead-air/shared/procgen/movables.ts';
import type { MovableRef } from '@dead-air/shared/procgen/movables.ts';
import { loreSpotsOf } from '@dead-air/shared/procgen/lore.ts';
import type { LoreSpot } from '@dead-air/shared/procgen/lore.ts';
import { THEMES, themeOf } from '@dead-air/shared/procgen/themes.ts';
import { buildEdgeGrid } from '@dead-air/shared/nav/index.ts';
import type { EdgeGrid } from '@dead-air/shared/nav/index.ts';
import type { Crew, ServerContext } from '../core/types.ts';
import * as IX from '../interaction/api.ts';
import * as MON from '../monsters/api.ts';
import * as OBJ from '../objectives/api.ts';
import { levelOf } from '../level/index.ts';
import { nearVan } from './gates.ts';
import type { DirectorView, ParaMonster, ParaPlayer, ParaWorld } from './types.ts';

export interface LiveWorld extends ParaWorld {
  /** clear the per-tick caches */
  refresh(): void;
}

const mirrorCache = new WeakMap<LevelLayout, MirrorSpot[]>();
const movCache = new WeakMap<LevelLayout, readonly MovableRef[]>();
const loreCache = new WeakMap<LevelLayout, readonly LoreSpot[]>();
const safe = <T>(fn: () => T, d: T): T => {
  try { return fn(); } catch { return d; }
};

export function makeLiveWorld(ctx: ServerContext, crew: Crew, L: LevelLayout): LiveWorld {
  const lv = levelOf(crew);
  const grid: EdgeGrid = lv && lv.layout === L ? lv.grid : buildEdgeGrid(L);
  const doorOpen = IX.doorOpenFn(crew);
  let players: ParaPlayer[] | null = null;
  let mons: ParaMonster[] | null = null;
  const obj = () => safe(() => OBJ.state(crew), null);
  const w: LiveWorld = {
    layout: L,
    grid,
    doorOpen,
    now: () => ctx.now(),
    refresh() { players = null; mons = null; },
    players() {
      if (players) return players;
      const st = obj();
      const carriers = st?.core?.carriers ?? [];
      const out: ParaPlayer[] = [];
      for (const p of crew.players.values()) {
        const [x, , z] = p.pose.p;
        const alive = p.connected && p.alive && p.pose.stance !== STANCE.dead && safe(() => IX.isAlive(crew, p.id), p.alive);
        const hidden = safe(() => IX.hiddenIn(crew, p.id), null);
        out.push({
          id: p.id, name: p.name, x, z, yaw: p.pose.yaw, light: p.pose.light === 1, alive,
          inVan: nearVan(L, x, z, 0) || safe(() => OBJ.inVan(crew, x, z), false),
          hidden, core: carriers.includes(p.id), grabbed: safe(() => MON.isGrabbed(crew, p.id), null) !== null,
        });
      }
      players = out;
      return out;
    },
    monsters() {
      mons ??= safe(() => MON.monsterPositions(crew), []);
      return mons;
    },
    director(): DirectorView | null {
      const d = crew.slices.director as Partial<DirectorView> | undefined;
      if (!d || typeof d.phase !== 'string') return null;
      return { phase: d.phase, tension: d.tension ?? {}, events: Array.isArray(d.events) ? d.events : [] };
    },
    clockMin: () => safe(() => OBJ.clockMin(crew), -1),
    contractRealSec: () => {
      const st = obj();
      const r = st?.realSec ?? Number(ctx.balance.core?.contractRealSec ?? 900);
      return r > 0 ? r : 900;
    },
    blackout: () => !!obj()?.blackout,
    coreLifted: () => {
      const c = obj()?.core;
      return !!c && c.state === 'carried' && c.carriers.length >= 2;
    },
    lightsOn: (space) => safe(() => IX.lightsOn(crew, space), false),
    setLights: (space, on) => { safe(() => IX.setLights(crew, space, on), undefined); },
    mirrors() {
      // flag mirrors=false only swaps the client to fallback glass: writing and the Low handprint still work there
      let m = mirrorCache.get(L);
      if (!m) { m = safe(() => mirrorsOf(L), []); mirrorCache.set(L, m); }
      return m;
    },
    movables() {
      let m = movCache.get(L);
      if (!m) { m = safe(() => movableRefsOf(L), []); movCache.set(L, m); }
      return m;
    },
    loreSpots() {
      let m = loreCache.get(L);
      if (!m) { m = safe(() => loreSpotsOf(L), []); loreCache.set(L, m); }
      return m;
    },
    themeHaunt: () => {
      if (ctx.flags.siteThemes === false) return 0;
      const t = safe(() => THEMES[themeOf(L)], undefined);
      return t?.haunt ?? 0;
    },
    snatcherLurking: () => w.monsters().some((m) => m.kind === 'snatcher' && m.state === 'lurk'),
  };
  return w;
}
