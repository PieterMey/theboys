// Owner: track (e) AI. Guarded adapters for the cross-track server APIs this track consumes. Each owner module is
// loaded with a dynamic import of its file URL (same URL as the owner's own imports => same module instance);
// a missing module, a stub without the needed functions, or one that throws while loading counts as "not
// shipped yet" and every call below degrades to a local fallback. Retried at most every 5 s.
//   (b) interaction/api.ts : isDoorOpen, isAlive, hasWalkie
//   (c) monsters/api.ts    : listener.setBrain, director.setPicker
//   ⑤  players/noise.ts    : onProxText (typed proximity text reaches the Listener like speech)
import { initialDoorOpen } from '@dead-air/shared/nav/index.ts';
import type { DoorOpenFn } from '@dead-air/shared/nav/index.ts';
import type { Crew, ServerPlayer } from '../core/types.ts';

type Mod = Record<string, unknown>;

export interface InteractionApi {
  isDoorOpen?(crew: Crew, id: number): boolean;
  isAlive?(crew: Crew, pid: string): boolean;
  hasWalkie?(crew: Crew, pid: string): boolean;
}

export interface MonstersApi {
  listener?: { setBrain?(fn: (input: never) => Promise<unknown>): unknown; heard?(crew: Crew, u: unknown): unknown };
  director?: { setPicker?(fn: (state: never, allowed: never) => Promise<string | null>): unknown };
  monsterPositions?(crew: Crew): { id: string; kind: string; x: number; z: number; active: boolean; state: string }[];
}

export interface ProxTextEventLike { player: ServerPlayer; text: string; x: number; z: number; radiusM: number; heardBy: string[]; t: number }
export interface NoiseApi {
  onProxText?(fn: (crew: Crew, e: ProxTextEventLike) => void): unknown;
}

const PATHS = {
  interaction: '../interaction/api.ts',
  monsters: '../monsters/api.ts',
  noise: '../players/noise.ts',
} as const;
type DepName = keyof typeof PATHS;

const NEED: Record<DepName, string[]> = {
  interaction: ['isDoorOpen', 'isAlive', 'hasWalkie'],
  monsters: ['listener', 'director'],
  noise: ['onProxText'],
};

const mods: { interaction: InteractionApi | null; monsters: MonstersApi | null; noise: NoiseApi | null } = { interaction: null, monsters: null, noise: null };
const tried = new Map<DepName, number>();
const loadedHooks: ((name: DepName) => void)[] = [];

export function onDepLoaded(fn: (name: DepName) => void): void {
  loadedHooks.push(fn);
}

async function loadOne(name: DepName): Promise<boolean> {
  if (mods[name]) return true;
  const last = tried.get(name) ?? -Infinity;
  if (performance.now() - last < 5000) return false;
  tried.set(name, performance.now());
  try {
    const m = (await import(new URL(PATHS[name], import.meta.url).href)) as Mod;
    const has = (k: string) => typeof m[k] === 'function' || (typeof m[k] === 'object' && m[k] !== null);
    if (!NEED[name].some(has)) return false;
    mods[name] = m as never;
    for (const fn of loadedHooks) {
      try { fn(name); } catch { /* ignore */ }
    }
    return true;
  } catch {
    return false;
  }
}

/** Try to load every dependency that isn't loaded yet (throttled). */
export async function loadDeps(): Promise<void> {
  await Promise.all((Object.keys(PATHS) as DepName[]).map((n) => loadOne(n)));
}

export function depsLoaded(): Record<DepName, boolean> {
  return { interaction: !!mods.interaction, monsters: !!mods.monsters, noise: !!mods.noise };
}

export function monstersApi(): MonstersApi | null {
  return mods.monsters;
}

export function noiseApi(): NoiseApi | null {
  return mods.noise;
}

// ---------------------------------------------------------------- interaction fallbacks

const initialCache = new WeakMap<object, DoorOpenFn>();

/** Door state for path distance: (b) isDoorOpen, else the layout's initial door states. */
export function doorOpenFor(crew: Crew): DoorOpenFn {
  const api = mods.interaction;
  const layout = crew.layout;
  if (api?.isDoorOpen) {
    const f = api.isDoorOpen.bind(api);
    let fallback: DoorOpenFn | null = null;
    return (id) => {
      try {
        return !!f(crew, id);
      } catch {
        if (!layout) return true;
        fallback ??= initialDoorOpen(layout);
        return fallback(id);
      }
    };
  }
  if (!layout) return () => true;
  let fn = initialCache.get(layout);
  if (!fn) initialCache.set(layout, (fn = initialDoorOpen(layout)));
  return fn;
}

export function isAlive(crew: Crew, p: ServerPlayer): boolean {
  const api = mods.interaction;
  if (api?.isAlive) {
    try {
      return !!api.isAlive(crew, p.id);
    } catch { /* fall through */ }
  }
  return p.alive;
}

/** Holds a walkie? Without (b), everyone counts as having one (the radio path stays testable). */
export function hasWalkie(crew: Crew, p: ServerPlayer): boolean {
  const api = mods.interaction;
  if (api?.hasWalkie) {
    try {
      return !!api.hasWalkie(crew, p.id);
    } catch { /* fall through */ }
  }
  return true;
}
