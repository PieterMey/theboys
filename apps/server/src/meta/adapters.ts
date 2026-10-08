// Owner: track (d) Meta. Thin, guarded adapters to other tracks' server APIs (module exports named in the P2 brief).
// Each module is dynamically imported; a missing/broken module or function degrades to a local fallback (null).
// Retried at most every 5 s until found (a track may land while we run in dev).
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import type { WorkOrder } from '@dead-air/shared/workorder.ts';
import type { Crew, Logger } from '../core/types.ts';
import { generateFacility as sharedFacility, generateHub as sharedHub } from '@dead-air/shared/procgen/index.ts';

type Fn = (...a: never[]) => unknown;
type Mod = Record<string, unknown>;

export interface DeathCause { killer: string; reason: string; detail?: string }

export interface Adapters {
  level: Mod | null;
  objectives: Mod | null;
  interaction: Mod | null;
  monsters: Mod | null;
  ai: Mod | null;
  /** v1.2: stealthStance (G1) */
  players: Mod | null;
  /** v1.2: onPhenomenon (E4), guarded */
  paranormal: Mod | null;
}

const SPECS: Record<keyof Adapters, string> = {
  level: '../level/index.ts',
  objectives: '../objectives/api.ts',
  interaction: '../interaction/api.ts',
  monsters: '../monsters/api.ts',
  ai: '../ai/api.ts',
  players: '../players/api.ts',
  paranormal: '../paranormal/api.ts',
};

export const mods: Adapters = { level: null, objectives: null, interaction: null, monsters: null, ai: null, players: null, paranormal: null };
const lastTry: Record<string, number> = {};
const failedOnce = new Set<string>();
const wired = new Set<string>();
let log: Logger | null = null;
/** called once per module when it first loads (register callbacks there) */
let onLoaded: ((name: keyof Adapters, m: Mod) => void) | null = null;

export function setAdapterLog(l: Logger, loaded: (name: keyof Adapters, m: Mod) => void): void {
  log = l;
  onLoaded = loaded;
}

async function load(name: keyof Adapters): Promise<void> {
  if (mods[name]) return;
  const now = performance.now();
  if (lastTry[name] && now - lastTry[name] < 5000) return;
  lastTry[name] = now;
  try {
    const m = (await import(new URL(SPECS[name], import.meta.url).href)) as Mod;
    mods[name] = m;
    log?.info(`adapter ${name}: loaded (${Object.keys(m).filter((k) => typeof m[k] === 'function').join(', ') || 'no functions'})`);
    if (!wired.has(name)) {
      wired.add(name);
      try { onLoaded?.(name, m); } catch (e) { log?.warn(`adapter ${name} wiring failed:`, e instanceof Error ? e.message : e); }
    }
  } catch (e) {
    if (!failedOnce.has(name)) {
      failedOnce.add(name);
      const msg = e instanceof Error ? e.message.split('\n')[0] : String(e);
      log?.info(`adapter ${name}: not available yet (${msg}); using fallback`);
    }
  }
}

export async function loadAll(): Promise<void> {
  await Promise.all((Object.keys(SPECS) as (keyof Adapters)[]).map((k) => load(k)));
}

/** cheap periodic retry for modules still missing */
export function retryMissing(): void {
  for (const k of Object.keys(SPECS) as (keyof Adapters)[]) if (!mods[k]) void load(k);
}

/** function `fn` of module `name`, or null */
export function fn<T extends Fn>(name: keyof Adapters, f: string): T | null {
  const m = mods[name];
  if (!m) return null;
  const v = m[f];
  if (typeof v === 'function') return v as T;
  // allow nested namespaces, e.g. listener.setBrain / director.setPicker
  const [ns, sub] = f.split('.');
  if (sub && m[ns] && typeof (m[ns] as Mod)[sub] === 'function') return ((m[ns] as Mod)[sub] as Fn).bind(m[ns]) as T;
  return null;
}

/** call a function if present; swallow + log errors; returns undefined when absent/failed */
export function call<R = unknown>(name: keyof Adapters, f: string, ...args: unknown[]): R | undefined {
  const g = fn<(...a: unknown[]) => R>(name, f);
  if (!g) return undefined;
  try {
    return g(...args);
  } catch (e) {
    log?.warn(`${name}.${f} threw:`, e instanceof Error ? (e.stack ?? e.message) : e);
    return undefined;
  }
}

export function has(name: keyof Adapters, f: string): boolean {
  return fn(name, f) !== null;
}

// ---------------- typed wrappers with fallbacks ----------------

export function generateHubLayout(): LevelLayout {
  for (const name of ['generateHub', 'hubLayout']) {
    const g = fn<() => LevelLayout>('level', name);
    if (!g) continue;
    try {
      const l = g();
      if (l && l.kind === 'hub') return l;
    } catch (e) {
      log?.warn(`level.${name} threw, using shared procgen:`, e instanceof Error ? e.message : e);
    }
  }
  return sharedHub();
}

export interface FacilityParams { seed: string; players: number; risk: number; theme?: string; modifiers?: readonly string[] }

/**
 * Facility for a work order. Prefers ② generateFacility(params), then ② generateFacilityForCrew(crew, params) (which also
 * stores it as crew.layout + builds ②'s nav state, using balance/level.json tuning), else the shared procgen defaults.
 * v1.2: {theme, modifiers} are forwarded. A themed/modified site that fails to generate falls back to the same site
 * without modifiers, then to the plain shared facility {seed, players, risk} (plan check #3), each inside a try.
 */
export function generateFacilityLayout(crew: Crew, p: FacilityParams): LevelLayout {
  const g = fn<(p: FacilityParams) => LevelLayout>('level', 'generateFacility');
  const gc = fn<(crew: Crew, p: FacilityParams) => LevelLayout>('level', 'generateFacilityForCrew');
  const plain = { seed: p.seed, players: p.players, risk: p.risk };
  const tries: FacilityParams[] = [p];
  if (p.modifiers?.length) tries.push({ ...plain, theme: p.theme });
  if (p.theme || p.modifiers?.length) tries.push(plain);
  let last: unknown = null;
  for (const q of tries) {
    try {
      const l = g ? g(q) : gc ? gc(crew, q) : null;
      if (l && l.kind === 'facility') return l;
    } catch (e) {
      last = e;
      log?.warn(`level facility generation threw (${q.theme ?? 'facility'}${q.modifiers?.length ? ` +${q.modifiers.length} modifiers` : ''}), falling back:`, e instanceof Error ? e.message : e);
    }
  }
  try {
    return sharedFacility(plain);
  } catch (e) {
    log?.error('shared facility generation threw too:', e instanceof Error ? e.message : e);
    throw last ?? e;
  }
}

/** the server's stealth stance (G1 players/api.ts), else the claimed pose stance */
export function stealthStance(crew: Crew, pid: string): number {
  const r = call<number>('players', 'stealthStance', crew, pid);
  return typeof r === 'number' ? r : (crew.players.get(pid)?.pose.stance ?? 0);
}

export function isAlive(crew: Crew, pid: string): boolean | null {
  const r = call<boolean>('interaction', 'isAlive', crew, pid);
  return typeof r === 'boolean' ? r : null;
}

export function giveItem(crew: Crew, pid: string, type: string): boolean {
  if (!has('interaction', 'giveItem')) return false;
  call('interaction', 'giveItem', crew, pid, type);
  return true;
}

/** item types held by a player (normalised to strings), or null when unknown */
export function itemTypesOf(crew: Crew, pid: string): string[] | null {
  if (!has('interaction', 'itemsOf')) return null;
  const r = call<unknown>('interaction', 'itemsOf', crew, pid);
  if (!Array.isArray(r)) return null;
  return r
    .map((it) => (typeof it === 'string' ? it : it && typeof it === 'object' ? String((it as { type?: unknown }).type ?? '') : ''))
    .filter(Boolean);
}

export async function briefFor(order: WorkOrder, timeoutMs: number): Promise<Partial<WorkOrder> | null> {
  const g = fn<(o: WorkOrder) => unknown>('ai', 'briefFor');
  if (!g) return null;
  try {
    const r = await withTimeout(Promise.resolve(g(order)), timeoutMs);
    return r && typeof r === 'object' ? (r as Partial<WorkOrder>) : null;
  } catch {
    return null;
  }
}

export async function reviewFor(shift: unknown, timeoutMs: number): Promise<Record<string, unknown> | null> {
  const g = fn<(s: unknown) => unknown>('ai', 'reviewFor');
  if (!g) return null;
  try {
    const r = await withTimeout(Promise.resolve(g(shift)), timeoutMs);
    return r && typeof r === 'object' ? (r as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms);
    t.unref?.();
    p.then((v) => { clearTimeout(t); resolve(v); }, () => { clearTimeout(t); resolve(null); });
  });
}
