// Owner: track (c) Monsters. ws bot + dev-server helpers for the monster e2e tests (envelope codec, no browser).
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, decodeMsg, encodeMsg } from '../../packages/shared/src/envelope.ts';
import type { ClientMsg, ServerMsg } from '../../packages/shared/src/envelope.ts';
import { randomProfile } from '../../packages/shared/src/profile.ts';
import type { Snapshot, SnapMonster } from '../../packages/shared/src/state.ts';

export const REPO = resolve(import.meta.dirname, '../..');

export interface Server { port: number; base: string; proc: ChildProcess; log: () => string; stop(): Promise<void> }

/** dev server (NODE_ENV=development => dbg.* requests) on `port` */
export async function startServer(port: number, extraEnv: Record<string, string> = {}): Promise<Server> {
  const proc = spawn(process.execPath, ['apps/server/src/index.ts', '--dev'], {
    cwd: REPO,
    env: { ...process.env, PORT: String(port), NODE_ENV: 'development', AI_MODE: 'mock', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout!.on('data', (d) => (out += d));
  proc.stderr!.on('data', (d) => (out += d));
  const base = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`server exited early:\n${out.slice(-3000)}`);
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch { /* not yet */ }
    if (Date.now() - t0 > 30_000) throw new Error(`server did not come up:\n${out.slice(-3000)}`);
    await sleep(150);
  }
  return {
    port, base, proc, log: () => out,
    async stop() {
      if (proc.exitCode !== null) return;
      proc.kill();
      await new Promise((r) => proc.once('exit', r));
    },
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface EventRec { e: string; d: unknown; t: number; at: number }

export class Bot {
  ws!: WebSocket;
  id = '';
  name: string;
  snap: Snapshot | null = null;
  events: EventRec[] = [];
  private pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  private nextId = 1;
  constructor(name: string) { this.name = name; }

  async connect(url: string, crew: string): Promise<void> {
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'nodebuffer';
    await new Promise<void>((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`${this.name}: no welcome`)), 8000);
      this.ws.on('open', () => this.send({ op: 'hello', v: PROTOCOL_VERSION, build: 'monsters-test', crew, playerKey: randomBytes(16).toString('hex'), name: this.name, profile: randomProfile(this.name) }));
      this.ws.on('message', (data: Buffer) => {
        const m = decodeMsg<ServerMsg>(data);
        if (m.op === 'welcome') { this.id = m.you; clearTimeout(timer); res(); }
        else if (m.op === 'snap') this.snap = m.s;
        else if (m.op === 'ev') this.events.push({ e: m.e, d: m.d, t: m.t, at: performance.now() });
        else if (m.op === 'rep') {
          const p = this.pending.get(m.id);
          if (p) { this.pending.delete(m.id); m.ok ? p.res(m.d) : p.rej(new Error(m.err ?? 'req failed')); }
        } else if (m.op === 'err') rej(new Error(`${this.name}: ${m.code} ${m.msg}`));
      });
      this.ws.on('error', rej);
    });
  }

  send(m: ClientMsg): void { this.ws.send(encodeMsg(m)); }

  req<T = unknown>(r: string, a: unknown = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((res, rej) => {
      this.pending.set(id, { res: res as (v: unknown) => void, rej });
      this.send({ op: 'req', id, r: r as never, a });
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error(`req ${r} timed out`)); }, 8000);
    });
  }

  dbg<T = unknown>(r: string, a: unknown = {}): Promise<T> { return this.req<T>(r.startsWith('dbg.') ? r : `dbg.${r}`, a); }

  loud(band: number, radio: 0 | 1 = 0): void { this.send({ op: 'loud', band, radio }); }

  monster(id: string): SnapMonster | undefined { return this.snap?.monsters.find((m) => m.id === id); }

  eventsOf(e: string, since = 0): EventRec[] { return this.events.filter((x) => x.e === e && x.at >= since); }

  close(): void { try { this.ws.close(); } catch { /* ignore */ } }
}

/** poll fn every 50 ms until it returns a truthy value or timeoutMs passes */
export async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs: number, label: string): Promise<NonNullable<T>> {
  const t0 = performance.now();
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (performance.now() - t0 > timeoutMs) throw new Error(`timeout (${timeoutMs} ms): ${label}`);
    await sleep(50);
  }
}
