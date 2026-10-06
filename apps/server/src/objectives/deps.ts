// Owner: track (a) Objectives. Guarded adapters for the cross-track server APIs objectives consumes.
// Every dependency is loaded with a dynamic import (same file URL as the owner's own imports => same module
// instance) and every call degrades gracefully when the owner has not shipped yet (local fallbacks below).
//   (b) interaction/api.ts : doors, lights, alive/kill, onDeath, onInteract, registerInteractables
//   (c) monsters/api.ts    : listener.onDecision (LURE_IT_WITH_A_LIE), stopMonsters
//   (d) meta/api.ts        : crewSave (bot assertions only)
//   ②  level/index.ts      : generateFacility (fallback: shared procgen)
//   ⑤  players/noise.ts    : emitNoise
import type { Crew, ServerContext, ServerPlayer } from '../core/types.ts';
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import type { InteractableInfo } from '@dead-air/shared/interactables.ts';

type Fn = (...a: never[]) => unknown;
type Mod = Record<string, unknown>;

export interface KillCause { killer: string; reason: string; detail?: string }

export interface IxItem { id: string; type: string; value: number; where: 'world' | 'held' | 'van'; holder?: string; p?: [number, number, number]; name?: string; tier?: number; rot?: number }

interface InteractionApi {
  state?(crew: Crew): { items?: Record<string, IxItem> } | null;
  lootTotal?(crew: Crew): number;
  depositLoot?(crew: Crew, pid: string): IxItem[];
  onDeposit?(fn: (crew: Crew, pid: string, items: IxItem[]) => void): unknown;
  setPower?(crew: Crew, zone: number, on: boolean): unknown;
  setBlackout?(crew: Crew, on: boolean): unknown;
  updateInteractable?(crew: Crew, id: string, patch: Partial<InteractableInfo>): unknown;
  flushNow?(crew: Crew): unknown;
  isDoorOpen?(crew: Crew, id: number): boolean;
  setDoorOpen?(crew: Crew, id: number, open: boolean, by: string | null): unknown;
  lightsOn?(crew: Crew, space: number): boolean;
  setLights?(crew: Crew, space: number | 'all', on: boolean): unknown;
  isAlive?(crew: Crew, pid: string): boolean;
  kill?(crew: Crew, pid: string, cause: KillCause): unknown;
  onDeath?(fn: (crew: Crew, pid: string, cause?: unknown) => void): unknown;
  onInteract?(kind: string, fn: (crew: Crew, player: ServerPlayer, targetId: string) => boolean | string | { ok: boolean; msg?: string }): unknown;
  registerInteractables?(crew: Crew, list: InteractableInfo[]): unknown;
}

interface MonstersApi {
  stopMonsters?(crew: Crew): unknown;
  listener?: { onDecision?(fn: (...a: unknown[]) => void): unknown };
}

interface MetaApi {
  crewSave?(crew: Crew): unknown;
}

interface LevelApi {
  generateFacility?(p: { seed: string; players: number; risk: number }): LevelLayout;
}

interface NoiseApi {
  emitNoise?(crew: Crew, n: { x: number; z: number; radiusM: number; kind: string; source: string }): void;
}

const mods: { interaction: InteractionApi | null; monsters: MonstersApi | null; meta: MetaApi | null; level: LevelApi | null; noise: NoiseApi | null } = {
  interaction: null, monsters: null, meta: null, level: null, noise: null,
};
const tried = new Map<string, number>();
const PATHS = {
  interaction: '../interaction/api.ts',
  monsters: '../monsters/api.ts',
  meta: '../meta/api.ts',
  level: '../level/index.ts',
  noise: '../players/noise.ts',
} as const;
type DepName = keyof typeof PATHS;

let log: ReturnType<ServerContext['log']> | null = null;
const onLoad: ((name: DepName) => void)[] = [];

async function loadOne(name: DepName): Promise<void> {
  if (mods[name]) return;
  const last = tried.get(name) ?? -Infinity;
  if (performance.now() - last < 5000) return;
  tried.set(name, performance.now());
  try {
    const m = (await import(new URL(PATHS[name], import.meta.url).href)) as Mod;
    // a stub module without the functions we need counts as "not shipped yet"
    const has = (k: string) => typeof m[k] === 'function' || (typeof m[k] === 'object' && m[k] !== null);
    const need: Record<DepName, string[]> = {
      interaction: ['setDoorOpen', 'setLights', 'isAlive', 'kill', 'onInteract', 'state'],
      monsters: ['listener', 'stopMonsters', 'startMonsters'],
      meta: ['crewSave'],
      level: ['generateFacility'],
      noise: ['emitNoise'],
    };
    if (!need[name].some(has)) return;
    mods[name] = m as never;
    log?.info(`dependency ${name} loaded (${need[name].filter(has).join(', ')})`);
    for (const fn of onLoad) {
      try { fn(name); } catch (e) { log?.warn(`onLoad(${name}) threw`, e instanceof Error ? e.message : e); }
    }
  } catch (e) {
    // module missing or mid-edit: keep the fallback, retry later
    log?.debug(`dependency ${name} not available: ${e instanceof Error ? e.message.split('\n')[0] : e}`);
  }
}

/** (Re)try loading every missing dependency (cheap; rate-limited per dependency). */
export async function loadDeps(): Promise<void> {
  await Promise.all((Object.keys(PATHS) as DepName[]).map((n) => loadOne(n)));
}

export function initDeps(ctx: ServerContext): void {
  log = ctx.log('objectives');
}

/** Called once per dependency when it becomes available (register handlers / subscriptions here). */
export function whenLoaded(fn: (name: DepName) => void): void {
  onLoad.push(fn);
  for (const n of Object.keys(mods) as DepName[]) if (mods[n]) fn(n);
}

export function depStatus(): Record<DepName, boolean> {
  return { interaction: !!mods.interaction, monsters: !!mods.monsters, meta: !!mods.meta, level: !!mods.level, noise: !!mods.noise };
}

export const interaction = (): InteractionApi | null => mods.interaction;
export const monsters = (): MonstersApi | null => mods.monsters;
export const meta = (): MetaApi | null => mods.meta;

function call<T>(fn: Fn | undefined, self: unknown, args: unknown[], fallback: () => T): T {
  if (typeof fn !== 'function') return fallback();
  try {
    return (fn as (...a: unknown[]) => T).apply(self, args);
  } catch (e) {
    log?.warn('dependency call failed', e instanceof Error ? e.message : e);
    return fallback();
  }
}

// ---------------- local fallbacks (used until (b) ships) ----------------
interface LocalWorld { doors: Map<number, boolean>; lights: Map<number | 'all', boolean> }
const local = new WeakMap<Crew, LocalWorld>();
function lw(crew: Crew): LocalWorld {
  let w = local.get(crew);
  if (!w) local.set(crew, (w = { doors: new Map(), lights: new Map() }));
  return w;
}
export function resetLocal(crew: Crew): void {
  local.delete(crew);
}

export function isDoorOpen(crew: Crew, id: number): boolean {
  const b = mods.interaction;
  return call(b?.isDoorOpen as Fn | undefined, b, [crew, id], () => {
    const v = lw(crew).doors.get(id);
    if (v !== undefined) return v;
    const d = crew.layout?.doors[id];
    return !!d && (d.kind === 'open' || d.initiallyOpen);
  });
}

export function setDoorOpen(crew: Crew, id: number, open: boolean, by: string | null): void {
  lw(crew).doors.set(id, open);
  const b = mods.interaction;
  call(b?.setDoorOpen as Fn | undefined, b, [crew, id, open, by], () => undefined);
}

export function setLights(crew: Crew, space: number | 'all', on: boolean): void {
  lw(crew).lights.set(space, on);
  const b = mods.interaction;
  call(b?.setLights as Fn | undefined, b, [crew, space, on], () => undefined);
}

export function isAlive(crew: Crew, p: ServerPlayer): boolean {
  const b = mods.interaction;
  return call(b?.isAlive as Fn | undefined, b, [crew, p.id], () => p.alive) === true;
}

/** Kill via (b) (death card, spectate) or, without (b), mark the player dead locally. */
export function kill(crew: Crew, p: ServerPlayer, cause: KillCause): void {
  const b = mods.interaction;
  if (typeof b?.kill === 'function') {
    call(b.kill as Fn, b, [crew, p.id, cause], () => undefined);
  }
  p.alive = false;
}

/** power a zone: (b) setPower push (lights follow power there), else switch the zone's lights locally */
export function setZonePower(crew: Crew, zone: number, on: boolean, spaces: number[]): void {
  const b = mods.interaction;
  if (typeof b?.setPower === 'function') {
    call(b.setPower as Fn, b, [crew, zone, on], () => undefined);
    return;
  }
  for (const sp of spaces) setLights(crew, sp, on);
}

/** the 03:00 blackout: (b) setBlackout push, else every light off */
export function setBlackout(crew: Crew, on: boolean): void {
  const b = mods.interaction;
  if (typeof b?.setBlackout === 'function') {
    call(b.setBlackout as Fn, b, [crew, on], () => undefined);
    return;
  }
  setLights(crew, 'all', !on);
}

/** (b) owns world loot (spawned on layout load)? Returns its loot items, or null when objectives must spawn its own. */
export function ixLoot(crew: Crew): IxItem[] | null {
  const b = mods.interaction;
  if (typeof b?.state !== 'function') return null;
  const st = call(b.state as Fn, b, [crew], () => null) as { items?: Record<string, IxItem> } | null;
  if (!st?.items) return null;
  return Object.values(st.items).filter((it) => typeof it.type === 'string' && it.type.startsWith('loot.'));
}

export function ixDepositLoot(crew: Crew, pid: string): IxItem[] {
  const b = mods.interaction;
  return (call(b?.depositLoot as Fn | undefined, b, [crew, pid], () => []) as IxItem[]) ?? [];
}

export function ixFlush(crew: Crew): void {
  const b = mods.interaction;
  call(b?.flushNow as Fn | undefined, b, [crew], () => undefined);
}

export function registerInteractables(crew: Crew, list: InteractableInfo[]): boolean {
  const b = mods.interaction;
  if (typeof b?.registerInteractables !== 'function') return false;
  call(b.registerInteractables as Fn, b, [crew, list], () => undefined);
  return true;
}

export function emitNoise(crew: Crew, n: { x: number; z: number; radiusM: number; kind: string; source: string }, ctx?: ServerContext): void {
  const viaCtx = (ctx as (ServerContext & { noise?: NoiseApi }) | undefined)?.noise;
  const fn = viaCtx?.emitNoise ?? mods.noise?.emitNoise;
  if (typeof fn === 'function') {
    try { fn(crew, n); } catch (e) { log?.warn('emitNoise failed', e instanceof Error ? e.message : e); }
  }
}

export function stopMonsters(crew: Crew): void {
  const m = mods.monsters;
  call(m?.stopMonsters as Fn | undefined, m, [crew], () => undefined);
}

export function crewSave(crew: Crew): unknown {
  const m = mods.meta;
  return call(m?.crewSave as Fn | undefined, m, [crew], () => null);
}

/** ② generateFacility if shipped (it may add level tuning from balance), else the shared procgen directly. */
export async function generateFacility(p: { seed: string; players: number; risk: number }): Promise<LevelLayout> {
  await loadOne('level');
  const l = mods.level;
  if (typeof l?.generateFacility === 'function') {
    try { return l.generateFacility(p); } catch (e) { log?.warn('level.generateFacility failed, using shared procgen', e instanceof Error ? e.message : e); }
  }
  const shared = (await import(new URL('../../../../packages/shared/src/procgen/index.ts', import.meta.url).href)) as {
    generateFacility(p: { seed: string; players: number; risk: number }): LevelLayout;
  };
  return shared.generateFacility(p);
}
