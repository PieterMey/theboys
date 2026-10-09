// Tiny ws game client for the core tests (tests/core/*.test.ts): hello -> welcome, events, req/rep, pings.
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, decodeMsg, encodeMsg } from '../../packages/shared/src/envelope.ts';
import type { ClientMsg, ServerMsg } from '../../packages/shared/src/envelope.ts';
import { randomProfile } from '../../packages/shared/src/profile.ts';
import type { Profile } from '../../packages/shared/src/profile.ts';

export type Welcome = Extract<ServerMsg, { op: 'welcome' }>;
export interface Ev { e: string; d: unknown; t: number }

export class TestClient {
  ws: WebSocket | null = null;
  welcome: Welcome | null = null;
  events: Ev[] = [];
  pongs: { c: number; s: number }[] = [];
  /** called synchronously in the socket's message handler for every event, before waiters (like a page's handlers) */
  onEv: ((ev: Ev) => void) | null = null;
  key = randomBytes(16).toString('hex');
  private reqId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private evWaiters: { match: (ev: Ev) => boolean; resolve: (ev: Ev) => void }[] = [];
  private name: string;
  private build: string;
  private profile: Profile;

  constructor(name: string, opts: { build?: string; profile?: Profile; key?: string } = {}) {
    this.name = name;
    this.build = opts.build ?? 'core-test';
    this.profile = opts.profile ?? randomProfile(name);
    if (opts.key) this.key = opts.key;
  }

  connect(port: number, crew: string, timeoutMs = 5000): Promise<Welcome> {
    try { refuseLive(port); } catch (e) { return Promise.reject(e); }
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.binaryType = 'nodebuffer';
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error(`${this.name}: no welcome in ${timeoutMs} ms`)), timeoutMs);
      ws.on('open', () => this.send({ op: 'hello', v: PROTOCOL_VERSION, build: this.build, crew, playerKey: this.key, name: this.name, profile: this.profile }));
      ws.on('message', (data: Buffer) => {
        const m = decodeMsg<ServerMsg>(data);
        if (m.op === 'welcome') { this.welcome = m; clearTimeout(timer); resolve(m); }
        else if (m.op === 'ev') {
          const ev = { e: m.e, d: m.d, t: m.t };
          this.events.push(ev);
          this.onEv?.(ev);
          for (const w of [...this.evWaiters]) if (w.match(ev)) { this.evWaiters.splice(this.evWaiters.indexOf(w), 1); w.resolve(ev); }
        } else if (m.op === 'rep') {
          const p = this.pending.get(m.id);
          if (p) { this.pending.delete(m.id); if (m.ok) p.resolve(m.d); else p.reject(new Error(m.err ?? 'request failed')); }
        } else if (m.op === 'pong') this.pongs.push({ c: m.c, s: m.s });
        else if (m.op === 'err') reject(new Error(`${this.name}: server err ${m.code}: ${m.msg}`));
      });
      ws.on('error', (e) => reject(e));
    });
  }

  send(m: ClientMsg): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeMsg(m));
  }

  req<T = unknown>(r: string, a: unknown = {}, timeoutMs = 5000): Promise<T> {
    return new Promise((resolve, reject) => {
      const id = this.reqId++;
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`${r} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v as T); }, reject: (e) => { clearTimeout(t); reject(e); } });
      this.send({ op: 'req', id, r: r as never, a: a as never });
    });
  }

  /** resolves with the first (past or future) event that matches */
  waitEvent(match: (ev: Ev) => boolean, timeoutMs = 3000): Promise<Ev> {
    const seen = this.events.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const w = { match, resolve };
      this.evWaiters.push(w);
      setTimeout(() => { const i = this.evWaiters.indexOf(w); if (i >= 0) { this.evWaiters.splice(i, 1); reject(new Error('event timeout')); } }, timeoutMs);
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      const ws = this.ws;
      if (!ws || ws.readyState === WebSocket.CLOSED) return resolve();
      ws.once('close', () => resolve());
      ws.close();
      setTimeout(resolve, 1000);
    });
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Never the live server (game :3000, STT :3100, play.dead-air.io): throws for that port or base. Called before a test
 * reuses a server (BASE, a ws port) or spawns one (mirrors tests/monsters/bot.ts refuseLive).
 */
export function refuseLive(port: number, base?: string): void {
  const b = (base ?? `http://127.0.0.1:${port}`).replace(/\/$/, '');
  if (port === 3000 || port === 3100 || /:(3000|3100)(\/|$)|dead-air\.io/i.test(b)) throw new Error(`refusing the live server (${b}, port ${port})`);
}

/** true if something already accepts TCP connections on 127.0.0.1:port */
async function portBusy(port: number): Promise<boolean> {
  const { connect } = await import('node:net');
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port });
    const done = (busy: boolean) => { s.destroy(); resolve(busy); };
    s.setTimeout(1000, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/**
 * A dev game server in its own process (so a test can freeze its own event loop): NODE_ENV=development, AI_MODE=mock,
 * saves + session under `scratch` (never the live saves/), STT pointed at a dead port. Kills only its own PID.
 * Refuses the live server's ports and bases (refuseLive) and a port something else already holds, and only takes a
 * /healthz answer from its own child: while that child still runs, in dev mode, with the child's pid.
 */
export async function startServer(port: number, scratch: string, extraEnv: Record<string, string> = {}): Promise<{ log: string[]; stop(): Promise<void> }> {
  refuseLive(port);
  if (extraEnv.PORT !== undefined) refuseLive(Number(extraEnv.PORT));
  for (const b of [process.env.BASE_URL, extraEnv.BASE_URL]) if (b) refuseLive(port, b);
  if (await portBusy(port)) throw new Error(`port ${port} is already in use: not starting a test server on it (and not reusing that one)`);
  const { spawn } = await import('node:child_process');
  const { join } = await import('node:path');
  const root = join(import.meta.dirname, '../..');
  const env = {
    ...process.env, NODE_ENV: 'development', AI_MODE: 'mock', PORT: String(port), STT_URL: 'http://127.0.0.1:9',
    SAVES_DIR: join(scratch, 'saves'), SESSION_FILE: join(scratch, 'session.json'), ...extraEnv,
  };
  const child = spawn(process.execPath, [join(root, 'apps/server/src/index.ts'), '--dev'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log: string[] = [];
  const keep = (b: Buffer) => { for (const l of b.toString().split(/\r?\n/)) if (l) log.push(l); if (log.length > 4000) log.splice(0, log.length - 4000); };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  const stop = async () => {
    if (child.exitCode !== null) return;
    const done = new Promise<void>((r) => child.once('exit', () => r()));
    child.kill();
    await Promise.race([done, sleep(5000)]);
  };
  const t0 = performance.now();
  for (;;) {
    if (child.exitCode !== null) throw new Error(`server exited (${child.exitCode}): ${log.slice(-10).join(' | ')}`);
    let h: { mode?: string; pid?: number } | null = null;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/healthz`);
      if (r.ok) h = (await r.json()) as { mode?: string; pid?: number };
    } catch { /* not up yet */ }
    // only our own child counts: still running, in dev mode, and with its pid (core/http.ts reports it in dev)
    if (h && child.exitCode === null) {
      if (h.mode !== 'development' || (h.pid !== undefined && h.pid !== child.pid)) {
        await stop();
        throw new Error(`port ${port} answered for another server (mode ${h.mode}, pid ${h.pid}; ours ${child.pid}): refusing it`);
      }
      break;
    }
    if (performance.now() - t0 > 60_000) { await stop(); throw new Error('server did not come up in 60 s'); }
    await sleep(250);
  }
  return { log, stop };
}
