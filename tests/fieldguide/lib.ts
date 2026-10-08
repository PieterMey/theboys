// Owner: fieldguide (v1.2). Test helpers: an own dev server (temp SAVES_DIR / SESSION_FILE, AI mock, port 3806 by default)
// and a small ws bot (hello -> welcome, req/dbg, event log, InteractionState mirror). Never touches :3000 or the real saves.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, decodeMsg, encodeMsg } from '../../packages/shared/src/envelope.ts';
import type { ClientMsg, ServerMsg } from '../../packages/shared/src/envelope.ts';
import { randomProfile } from '../../packages/shared/src/profile.ts';
import { applyInteractionPatch, emptyInteractionState } from '../../packages/shared/src/interactables.ts';
import type { InteractionPatch, InteractionState } from '../../packages/shared/src/messages/interaction.ts';
import type { FieldGuideView } from '../../packages/shared/src/messages/fieldguide.ts';
import type { FullState, Phase } from '../../packages/shared/src/state.ts';

export const REPO = resolve(import.meta.dirname, '../..');
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Server { port: number; base: string; ws: string; saves: string; session: string; proc: ChildProcess; log(): string; stop(): Promise<void> }

/** dev server (NODE_ENV=development, AI_MODE=mock) on `port`; reuse `dir` to restart on the same saves + session */
export async function startServer(o: { port?: number; dir?: string; env?: Record<string, string> } = {}): Promise<Server> {
  const port = o.port ?? Number(process.env.FG_PORT ?? 3806);
  const dir = o.dir ?? mkdtempSync(join(process.env.FG_SCRATCH ?? tmpdir(), 'fg-test-'));
  const saves = join(dir, 'saves');
  mkdirSync(saves, { recursive: true });
  const session = join(dir, 'session.json');
  const proc = spawn(process.execPath, ['apps/server/src/index.ts', '--dev'], {
    cwd: REPO,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'development', AI_MODE: 'mock', SAVES_DIR: saves, SESSION_FILE: session, ...(o.env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout?.on('data', (b: Buffer) => { log += b.toString(); });
  proc.stderr?.on('data', (b: Buffer) => { log += b.toString(); });
  const base = `http://127.0.0.1:${port}`;
  const stop = () => new Promise<void>((res) => {
    if (proc.exitCode !== null) return res();
    proc.once('exit', () => res());
    proc.kill('SIGTERM');
    setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } res(); }, 4000).unref();
  });
  for (let i = 0; i < 160; i++) {
    if (proc.exitCode !== null) throw new Error(`server exited (${proc.exitCode}):\n${log.slice(-3000)}`);
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return { port, base, ws: `ws://127.0.0.1:${port}/ws`, saves, session, proc, log: () => log, stop };
    } catch { /* booting */ }
    await sleep(250);
  }
  await stop();
  throw new Error(`server did not start:\n${log.slice(-3000)}`);
}

export interface Ev { e: string; d: unknown; t: number }

export class Bot {
  ws!: WebSocket;
  me = '';
  name: string;
  key: string;
  phase: Phase = 'hub';
  full: FullState | null = null;
  ix: InteractionState = emptyInteractionState();
  events: Ev[] = [];
  fg: FieldGuideView | null = null;
  private reqId = 1;
  private pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  private waiters: { pred: (ev: Ev) => boolean; res: (ev: Ev) => void }[] = [];

  constructor(name: string, key = randomBytes(16).toString('hex')) {
    this.name = name;
    this.key = key;
  }

  connect(url: string, crew: string): Promise<void> {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.binaryType = 'nodebuffer';
      const t = setTimeout(() => rej(new Error(`${this.name}: no welcome`)), 10000);
      ws.on('open', () => this.send({ op: 'hello', v: PROTOCOL_VERSION, build: 'test', crew, playerKey: this.key, name: this.name, profile: randomProfile(this.name) }));
      ws.on('message', (data: Buffer) => {
        const m = decodeMsg<ServerMsg>(data);
        if (m.op === 'welcome') {
          this.me = m.you;
          this.applyFull(m.state);
          clearTimeout(t);
          res();
        } else if (m.op === 'ev') {
          if (m.e === 'phase') this.applyFull((m.d as { state: FullState }).state);
          if (m.e === 'interaction.patch') applyInteractionPatch(this.ix, m.d as InteractionPatch);
          if (m.e === 'fieldguide.state') this.fg = m.d as FieldGuideView;
          const ev = { e: m.e, d: m.d, t: m.t };
          this.events.push(ev);
          this.waiters = this.waiters.filter((w) => {
            if (w.pred(ev)) { w.res(ev); return false; }
            return true;
          });
        } else if (m.op === 'rep') {
          const p = this.pending.get(m.id);
          if (!p) return;
          this.pending.delete(m.id);
          if (m.ok) p.res(m.d);
          else p.rej(new Error(`${this.name}: ${m.err ?? 'req failed'}`));
        } else if (m.op === 'err') rej(new Error(`${this.name}: ${m.code} ${m.msg}`));
      });
      ws.on('error', (e) => rej(e));
    });
  }

  private applyFull(s: FullState): void {
    this.full = s;
    this.phase = s.phase;
    applyInteractionPatch(this.ix, { reset: s.interaction ?? emptyInteractionState() });
  }

  send(m: ClientMsg): void {
    this.ws.send(encodeMsg(m));
  }

  req<T = unknown>(r: string, a: unknown = {}, timeoutMs = 10000): Promise<T> {
    const id = this.reqId++;
    return new Promise<T>((res, rej) => {
      this.pending.set(id, { res: res as (v: unknown) => void, rej });
      this.send({ op: 'req', id, r: r as never, a });
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error(`${this.name}: ${r} timed out`)); }, timeoutMs);
    });
  }

  dbg<T = unknown>(name: string, a: unknown = {}): Promise<T> {
    return this.req<T>(`dbg.${name}`, a);
  }

  /** next event matching pred (events after this call only) */
  next(pred: (ev: Ev) => boolean, timeoutMs = 8000, what = 'event'): Promise<Ev> {
    return new Promise((res, rej) => {
      const w = { pred, res };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) { this.waiters.splice(i, 1); rej(new Error(`${this.name}: timed out waiting for ${what}`)); }
      }, timeoutMs);
    });
  }

  of(e: string): Ev[] {
    return this.events.filter((x) => x.e === e);
  }

  /** place my server-side pose (no client controller) */
  pose(x: number, z: number, yaw = 0): Promise<unknown> {
    return this.dbg('interaction.pose', { x, z, yaw });
  }

  close(): void {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

export function crewCode(): string {
  const A = 'BCDFGHJKLMNPQRSTVWXZ';
  let s = '';
  const b = randomBytes(4);
  for (let i = 0; i < 4; i++) s += A[b[i]! % A.length];
  return s;
}

/** tiny assertion helpers that print what failed */
export function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAIL: ${msg}`);
  console.log(`  ok  ${msg}`);
}

export interface FgDbgState {
  enabled: boolean; key: string | null; visit: number; present: string[];
  shelf: { id: string; p: [number, number, number]; ref: string } | null;
  bulletins: { id: string; spot: string; space: number; monster: string; p: [number, number, number]; front: [number, number]; reads: Record<string, string> }[];
  stocked: { pageId: string; container: string; monster: string; spot: string | null; taken: boolean }[];
  targets: string[]; fake: boolean; persisted: boolean;
  save: { v: 1; monsters: Record<string, { first?: { at: string; site: string; how: string }; heard: number; seen: number; deaths: number; escapes: number }>; pages: string[]; anomalies: Record<string, number> };
}
