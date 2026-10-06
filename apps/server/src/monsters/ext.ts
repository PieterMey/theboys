// Owner: track (c) Monsters. Guarded bindings to other tracks' server APIs. Those modules may not exist yet (P2 tracks
// are built in parallel), so they are imported dynamically and every call has a local fallback that keeps the
// monsters playable: door state from the layout / interaction slice, lights from the layout, kill = alive=false.
// TODO(interaction): isDoorOpen/setDoorOpen/lightsOn/setLights/litAt/isAlive/isHidden/kill/hasWalkie/onDeath/onMelee
// TODO(objectives): clockMin/state  TODO(ai): onUtterance  (all optional; re-bound on every monster start)
import { STANCE } from '@dead-air/shared/state.ts';
import type { Crew, ServerContext, ServerPlayer } from '../core/types.ts';

type Mod = Record<string, unknown>;
// eslint-style any: other tracks' signatures are not known at compile time
type Fn = (...a: unknown[]) => unknown;

const SOURCES = {
  interaction: '../interaction/api.ts',
  objectives: '../objectives/api.ts',
  meta: '../meta/api.ts',
  ai: '../ai/api.ts',
} as const;
type Src = keyof typeof SOURCES;

const mods: Record<Src, Mod | null> = { interaction: null, objectives: null, meta: null, ai: null };
const subscribed = new Set<string>();
let warnFn: ((m: string) => void) | null = null;

async function load(name: Src): Promise<void> {
  if (mods[name]) return;
  try {
    mods[name] = (await import(new URL(SOURCES[name], import.meta.url).href)) as Mod;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!/Cannot find module|ERR_MODULE_NOT_FOUND|not found/i.test(msg)) warnFn?.(`could not load ${SOURCES[name]}: ${msg.split('\n')[0]}`);
    mods[name] = null;
  }
}

function fn(src: Src, name: string): Fn | null {
  const f = mods[src]?.[name];
  return typeof f === 'function' ? (f as Fn) : null;
}

/** (Re)binds every optional API; subscriptions are made once per module. */
export async function bindExternal(ctx: ServerContext, hooks: {
  onDeath: (crew: Crew, pid: string, cause: unknown) => void;
  onMelee: (crew: Crew, attacker: string, args: unknown[]) => boolean | void;
  onUtterance: (crew: Crew, u: unknown) => void;
}): Promise<string[]> {
  const log = ctx.log('monsters');
  warnFn = (m) => log.warn(m);
  await Promise.all((Object.keys(SOURCES) as Src[]).map(load));
  const bound: string[] = [];
  for (const k of Object.keys(SOURCES) as Src[]) if (mods[k]) bound.push(k);
  const sub = (src: Src, name: string, cb: (...a: unknown[]) => unknown) => {
    const key = `${src}.${name}`;
    const f = fn(src, name);
    if (!f || subscribed.has(key)) return;
    try {
      f(cb);
      subscribed.add(key);
    } catch (e) {
      log.warn(`${key} subscribe failed: ${e instanceof Error ? e.message : e}`);
    }
  };
  sub('interaction', 'onDeath', (crew, who, cause) => hooks.onDeath(crew as Crew, pidOf(who), cause));
  sub('interaction', 'onMelee', (crew, who, ...rest) => hooks.onMelee(crew as Crew, pidOf(who), rest) === true);
  sub('ai', 'onUtterance', (crew, u) => hooks.onUtterance(crew as Crew, u));
  return bound;
}

export function boundApis(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const k of Object.keys(SOURCES) as Src[]) {
    const m = mods[k];
    out[k] = m ? Object.keys(m).filter((n) => typeof m[n] === 'function') : [];
  }
  out.subscribed = [...subscribed];
  return out;
}

function pidOf(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && 'id' in v) return String((v as { id: unknown }).id);
  return '';
}

function safe<T>(f: Fn | null, args: unknown[], dflt: T, coerce: (v: unknown) => T | undefined): T {
  if (!f) return dflt;
  try {
    const v = coerce(f(...args));
    return v === undefined ? dflt : v;
  } catch {
    return dflt;
  }
}
const asBool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
const asNum = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

// ---------------- doors ----------------

function sliceDoorOpen(crew: Crew, id: number): boolean | undefined {
  const raw = (crew.slices.interaction as { doors?: unknown } | undefined)?.doors;
  let v: unknown;
  if (raw instanceof Map) v = raw.get(id);
  else if (Array.isArray(raw) || ArrayBuffer.isView(raw)) v = (raw as ArrayLike<unknown>)[id];
  else if (raw && typeof raw === 'object') v = (raw as Record<string, unknown>)[id];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (v && typeof v === 'object' && 'open' in v) return Boolean((v as { open: unknown }).open);
  return undefined;
}

/** null when interaction's isDoorOpen is missing (caller uses its own state) */
export function extDoorOpen(crew: Crew, id: number): boolean | undefined {
  const f = fn('interaction', 'isDoorOpen');
  if (f) {
    try {
      const v = f(crew, id);
      if (typeof v === 'boolean') return v;
    } catch { /* fall through */ }
  }
  for (const k of ['interaction', 'level']) {
    const live = (crew.slices[k] as { doorOpen?: unknown } | undefined)?.doorOpen;
    if (typeof live === 'function') {
      try {
        const v = (live as (id: number) => unknown)(id);
        if (typeof v === 'boolean') return v;
      } catch { /* ignore */ }
    }
  }
  return sliceDoorOpen(crew, id);
}

export function hasDoorApi(): boolean {
  return !!fn('interaction', 'setDoorOpen');
}

/** open/close a door as a monster (byPlayerId null); false when the interaction API is missing */
export function extSetDoor(crew: Crew, id: number, open: boolean): boolean {
  const f = fn('interaction', 'setDoorOpen');
  if (!f) return false;
  try {
    f(crew, id, open, null);
    return true;
  } catch {
    return false;
  }
}

// ---------------- lights ----------------

export function extLightsOn(crew: Crew, space: number): boolean | undefined {
  const f = fn('interaction', 'lightsOn');
  if (f) {
    try {
      const v = f(crew, space);
      if (typeof v === 'boolean') return v;
    } catch { /* fall through */ }
  }
  const lights = (crew.slices.interaction as { lights?: Record<number, boolean> } | undefined)?.lights;
  if (lights && typeof lights === 'object' && space in lights) return Boolean(lights[space]);
  return undefined;
}

export function extLitAt(crew: Crew, x: number, z: number): boolean | undefined {
  const f = fn('interaction', 'litAt');
  if (!f) return undefined;
  try {
    const v = f(crew, x, z);
    return typeof v === 'boolean' ? v : typeof v === 'number' ? v > 0 : undefined;
  } catch {
    return undefined;
  }
}

export function extSetLights(crew: Crew, space: number | 'all', on: boolean): boolean {
  const f = fn('interaction', 'setLights');
  if (!f) return false;
  try {
    f(crew, space, on);
    return true;
  } catch {
    return false;
  }
}

// ---------------- players ----------------

export function isAlive(crew: Crew, p: ServerPlayer): boolean {
  if (!p.connected) return false;
  return safe(fn('interaction', 'isAlive'), [crew, p.id], p.alive, asBool) && p.alive !== false;
}

export function isHidden(crew: Crew, p: ServerPlayer): boolean {
  const hid = (crew.slices.interaction as { hidden?: Record<string, string> } | undefined)?.hidden;
  const fallback = p.pose.stance === STANCE.hidden || !!(hid && typeof hid === 'object' && hid[p.id]);
  return safe(fn('interaction', 'isHidden'), [crew, p.id], fallback, asBool);
}

export function hasWalkie(crew: Crew, p: ServerPlayer): boolean {
  const f = fn('interaction', 'hasWalkie');
  if (f) return safe(f, [crew, p.id], true, asBool);
  const h = fn('interaction', 'holding');
  if (h) return safe(h, [crew, p.id, 'walkie'], true, asBool);
  return true; // no inventory system yet: assume everyone carries the 2 free company walkies
}

export function holdingCrowbar(crew: Crew, p: ServerPlayer): boolean {
  const h = fn('interaction', 'holding');
  return h ? safe(h, [crew, p.id, 'crowbar'], false, asBool) : true;
}

/** kill through interaction (death card, spectate). Returns true if the interaction API handled it. */
export function extKill(crew: Crew, pid: string, cause: { killer: string; reason: string; detail?: string }): boolean {
  const f = fn('interaction', 'kill');
  if (!f) return false;
  try {
    f(crew, pid, cause);
    return true;
  } catch {
    return false;
  }
}

// ---------------- objectives / meta ----------------

export function extClockMin(crew: Crew): number | undefined {
  return safe(fn('objectives', 'clockMin'), [crew], undefined as number | undefined, asNum);
}

export function extCoreLifted(crew: Crew): boolean {
  const f = fn('objectives', 'state');
  let st: unknown = null;
  if (f) {
    try { st = f(crew); } catch { st = null; }
  }
  st ??= crew.slices.objectives ?? null;
  const cs = st && typeof st === 'object' ? (st as { coreState?: unknown }).coreState : undefined;
  return cs === 'carried' || cs === 'dropped';
}

export function extBlackout(crew: Crew): boolean {
  const f = fn('objectives', 'state');
  let st: unknown = null;
  if (f) {
    try { st = f(crew); } catch { st = null; }
  }
  st ??= crew.slices.objectives ?? null;
  return !!(st && typeof st === 'object' && (st as { blackout?: unknown }).blackout === true);
}
