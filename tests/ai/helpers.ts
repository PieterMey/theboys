// Test helpers for track (e): an in-process ServerContext (no HTTP/ws), fake players, fixture layouts.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import type { WorkOrder } from '../../packages/shared/src/workorder.ts';
import { randomProfile } from '../../packages/shared/src/profile.ts';
import { loadConfig } from '../../apps/server/src/core/config.ts';
import { createContext } from '../../apps/server/src/core/context.ts';
import type { Internals } from '../../apps/server/src/core/context.ts';
import { createCrews } from '../../apps/server/src/core/crews.ts';
import { setQuiet } from '../../apps/server/src/core/log.ts';
import type { Crew, ServerContext, ServerPlayer } from '../../apps/server/src/core/types.ts';

export const REPO = resolve(import.meta.dirname, '../..');

export function loadLayout(name: string): LevelLayout {
  return JSON.parse(readFileSync(join(REPO, 'tests/fixtures/layouts', `${name}.json`), 'utf8')) as LevelLayout;
}

export function makeCtx(opts: { sttUrl?: string; dev?: boolean } = {}): { ctx: ServerContext; internals: Internals } {
  setQuiet(true);
  const cfg = loadConfig(opts.dev === false ? 'test' : 'development', 0);
  cfg.env.AI_MODE = 'mock';
  if (opts.sttUrl) cfg.env.STT_URL = opts.sttUrl;
  const { ctx, internals, setCrews } = createContext(cfg);
  setCrews(createCrews(ctx));
  return { ctx, internals };
}

export function addPlayer(crew: Crew, id: string, name: string, x: number, z: number, opts: { consent?: boolean; alive?: boolean } = {}): ServerPlayer {
  const p: ServerPlayer = {
    id, key: `key-${id}-0123456789`, name, profile: randomProfile(name, () => 0.5), connected: true, ready: false, alive: opts.alive ?? true,
    consent: { transcribe: opts.consent ?? true, mimic: false }, level: 1,
    pose: { seq: 0, p: [x, 0, z], yaw: 0, pitch: 0, stance: 0, anim: 0, light: 0 }, poseAt: performance.now(),
    band: 0, radio: 0, socket: null, resume: `r-${id}`, joinedAt: performance.now(), isLeader: false, disconnectedAt: 0, slices: {},
  };
  crew.players.set(id, p);
  return p;
}

/** 16 kHz PCM16 test tone/noise of `ms` milliseconds (content is irrelevant: the fake STT server answers text). */
export function pcmOf(ms: number): Int16Array {
  const n = Math.round((ms / 1000) * 16000);
  const a = new Int16Array(n);
  for (let i = 0; i < n; i++) a[i] = ((i * 7919) % 2000) - 1000;
  return a;
}

export const quietLog = { debug() {}, info() {}, warn() {}, error() {} };

/** A template work order with 2 requests and 2 clue notes ({{CODE_A}} | {{CODE_B}} {{ROOM_1}}). */
export function templateOrder(id = 'o1'): WorkOrder {
  return {
    id, seed: `seed-${id}`, risk: 1, siteName: 'Template Site', theme: 'facility', size: 'M', payoutMult: 1, modifiers: [], requirements: {},
    available: true, history: 'Template history.', memo: 'Template memo.', source: 'template',
    requests: [{ kind: 'ALL_SURVIVE', reward: 100, text: 'Everyone comes back.' }, { kind: 'EXTRACT_ABOVE', param: 400, reward: 80, text: 'Extract more than 400.' }],
    notes: [
      { slot: 'note:0', title: 'Scrawl', body: 'The first half is {{CODE_A}}.' },
      { slot: 'note:1', title: 'Receipt', body: 'Second half {{CODE_B}}, ask {{ROOM_1}}.' },
    ],
  };
}
