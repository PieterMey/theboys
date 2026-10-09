// Owner: track (c) Monsters (v1.3). Unit-test helpers: a stub ServerContext + crew + players that drive the monster
// runtime (startContract / makeRt / tickRuntime) in-process, without a server, sockets or other tracks (their
// optional APIs stay unbound, so ext.ts falls back to the layout / player fields). Balance + flags are the real
// config files, so the tests exercise the shipped numbers; `flags` / `tune` override them per test.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { STANCE } from '../../packages/shared/src/state.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import type { Crew, ServerContext, ServerPlayer } from '../../apps/server/src/core/types.ts';

export const REPO = resolve(import.meta.dirname, '../..');

const readJson = (p: string): Record<string, unknown> => JSON.parse(readFileSync(join(REPO, p), 'utf8')) as Record<string, unknown>;

export interface StubCtx {
  ctx: ServerContext;
  /** every ctx.emit: event name, payload, options */
  events: { e: string; d: unknown; to?: string[] }[];
  /** every log line, as 'scope: text' */
  logs: string[];
  /** advance the server clock (ms) */
  clock: { ms: number };
}

/** stub context: real config/flags.json + config/balance/{monsters,core,voice}.json (deep-copied), optional overrides */
export function stubCtx(o: { flags?: Record<string, boolean>; tune?: Record<string, Record<string, unknown>> } = {}): StubCtx {
  const flags = { ...readJson('config/flags.json'), ...(o.flags ?? {}) } as Record<string, boolean>;
  const monsters = readJson('config/balance/monsters.json') as Record<string, Record<string, unknown>>;
  for (const [sec, set] of Object.entries(o.tune ?? {})) monsters[sec] = { ...(monsters[sec] ?? {}), ...set };
  const balance = { monsters, core: readJson('config/balance/core.json'), voice: readJson('config/balance/voice.json') };
  const events: StubCtx['events'] = [];
  const logs: string[] = [];
  const clock = { ms: 1_000_000 };
  const logger = (scope: string) => {
    const put = (...a: unknown[]) => { logs.push(`${scope}: ${a.map(String).join(' ')}`); };
    return { debug: () => {}, info: put, warn: put, error: put };
  };
  const ctx = {
    flags, balance, env: { dev: true },
    log: logger,
    crews: {
      connected: (crew: Crew) => [...crew.players.values()].filter((p) => p.connected),
      broadcastRoster: () => {},
    },
    emit: (_crew: Crew, e: string, d: unknown, opts?: { to?: string[] }) => { events.push({ e, d, to: opts?.to }); },
    now: () => clock.ms,
  } as unknown as ServerContext;
  return { ctx, events, logs, clock };
}

export function stubPlayer(id: string, x: number, z: number, o: Partial<ServerPlayer> = {}): ServerPlayer {
  return {
    id, key: `k-${id}`, name: `Player ${id}`, profile: {} as ServerPlayer['profile'], connected: true, ready: true, alive: true,
    consent: { transcribe: true, mimic: false }, level: 1,
    pose: { seq: 0, p: [x, 0, z], yaw: 0, pitch: 0, stance: STANCE.stand, anim: 0, light: 0 } as unknown as ServerPlayer['pose'],
    poseAt: 0, band: 0, radio: 0, socket: null, resume: '', joinedAt: 0, isLeader: false, disconnectedAt: 0, slices: {},
    ...o,
  };
}

export function stubCrew(layout: LevelLayout, players: ServerPlayer[], code = 'UNIT'): Crew {
  return { code, phase: 'contract', players: new Map(players.map((p) => [p.id, p])), layout, slices: {}, createdAt: 0, tick: 0, emptySince: 0 };
}

/** walkable indoor cell centres of a space (never the van cab) */
export function cellsOf(L: LevelLayout, space: number): [number, number][] {
  const out: [number, number][] = [];
  for (let c = 0; c < L.owner.length; c++) if (L.owner[c] === space) out.push([(c % L.W) + 0.5, Math.floor(c / L.W) + 0.5]);
  return out;
}
