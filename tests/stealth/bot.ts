// players-stealth (v1.2) ws bot + dev-server helpers for the stealth e2e tests (envelope codec, no browser).
// Pattern copied from tests/monsters/bot.ts (not imported: another package owns it).
//   const srv = await ensureServer(); const b = new Bot('Creep'); await b.connect(srv.ws, 'STLA');
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, decodeMsg, encodeMsg } from '../../packages/shared/src/envelope.ts';
import type { ClientMsg, ServerMsg } from '../../packages/shared/src/envelope.ts';
import { randomProfile } from '../../packages/shared/src/profile.ts';
import { STANCE } from '../../packages/shared/src/state.ts';

export const REPO = resolve(import.meta.dirname, '../..');
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Server { base: string; ws: string; proc: ChildProcess | null; log: () => string; stop(): Promise<void> }

/**
 * The dev server at BASE_URL / PORT (default 3801, players-stealth's port) if it answers, else a fresh one on that port
 * (NODE_ENV=development for dbg.*, AI_MODE=mock, its own SAVES_DIR / SESSION_FILE under the temp dir).
 */
export async function ensureServer(): Promise<Server> {
  const port = Number(process.env.PORT ?? 3801);
  const base = (process.env.BASE_URL ?? `http://127.0.0.1:${port}`).replace(/\/$/, '');
  const ws = `${base.replace(/^http/, 'ws')}/ws`;
  const up = async () => {
    try { return (await fetch(`${base}/healthz`)).ok; } catch { return false; }
  };
  // never the live server (:3000, STT :3100, play.dead-air.io): checked BEFORE reusing whatever answers there
  if (port === 3000 || port === 3100 || /:(3000|3100)(\/|$)|dead-air\.io/.test(base)) throw new Error(`refusing the live server (${base})`);
  if (await up()) return { base, ws, proc: null, log: () => '', stop: async () => {} };
  const scratch = process.env.STEALTH_SCRATCH ?? join(tmpdir(), `dead-air-stealth-${process.pid}`);
  mkdirSync(join(scratch, 'saves'), { recursive: true });
  const proc = spawn(process.execPath, ['apps/server/src/index.ts'], {
    cwd: REPO,
    env: {
      ...process.env, PORT: String(port), NODE_ENV: 'development', AI_MODE: 'mock',
      SAVES_DIR: join(scratch, 'saves'), SESSION_FILE: join(scratch, 'session.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  proc.stdout!.on('data', (d) => (out += d));
  proc.stderr!.on('data', (d) => (out += d));
  const t0 = Date.now();
  while (!(await up())) {
    if (proc.exitCode !== null) throw new Error(`server exited early:\n${out.slice(-3000)}`);
    if (Date.now() - t0 > 45_000) throw new Error(`server did not come up:\n${out.slice(-3000)}`);
    await sleep(200);
  }
  return {
    base, ws, proc, log: () => out,
    async stop() {
      if (proc.exitCode !== null) return;
      proc.kill();
      await new Promise((r) => proc.once('exit', r));
    },
  };
}

export interface EventRec { e: string; d: unknown; t: number; at: number }
export interface NoiseRec { x: number; z: number; radiusM: number; kind: string; source: string; t: number }

export class Bot {
  ws!: WebSocket;
  id = '';
  name: string;
  events: EventRec[] = [];
  seq = 0;
  private pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  private nextId = 1;
  constructor(name: string) { this.name = name; }

  async connect(url: string, crew: string): Promise<void> {
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'nodebuffer';
    await new Promise<void>((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`${this.name}: no welcome`)), 8000);
      this.ws.on('open', () => this.send({ op: 'hello', v: PROTOCOL_VERSION, build: 'stealth-test', crew, playerKey: randomBytes(16).toString('hex'), name: this.name, profile: randomProfile(this.name) }));
      this.ws.on('message', (data: Buffer) => {
        const m = decodeMsg<ServerMsg>(data);
        if (m.op === 'welcome') { this.id = m.you; clearTimeout(timer); res(); }
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
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error(`req ${r} timed out`)); }, 10_000);
    });
  }

  dbg<T = unknown>(r: string, a: unknown = {}): Promise<T> { return this.req<T>(r.startsWith('dbg.') ? r : `dbg.${r}`, a); }

  pose(x: number, z: number, stance: number = STANCE.stand, yaw = 0): void {
    this.send({ op: 'pose', seq: ++this.seq, p: [x, 0, z], yaw, pitch: 0, stance, anim: 0, light: 0 });
  }

  /** the server's stored pose */
  async serverPos(): Promise<[number, number, number]> {
    const r = await this.dbg<{ pose: { p: [number, number, number] } } | null>('players.pose');
    return r ? r.pose.p : [Number.NaN, 0, Number.NaN];
  }

  close(): void { try { this.ws.close(); } catch { /* ignore */ } }
}

export interface WalkOpts {
  /** m/s along the path */
  speed: number;
  seconds: number;
  stance: number;
  /** poses held back and sent together (tunnel bunching); 1 = steady 20 Hz */
  bunch?: number;
  /** circle radius around (x0, z0): 0.38 stays inside one free 1 m cell (no walls to cross), chords lose < 2 % */
  radius?: number;
  /** ms per pose (50 = the client's 20 Hz) */
  stepMs?: number;
}

/** walk in a small circle around a free cell centre, one pose per stepMs (bunched if asked); returns the last point */
export async function walk(b: Bot, x0: number, z0: number, o: WalkOpts): Promise<[number, number]> {
  const stepMs = o.stepMs ?? 50;
  const r = o.radius ?? 0.38;
  const n = Math.round((o.seconds * 1000) / stepMs);
  const bunch = Math.max(1, o.bunch ?? 1);
  let ang = 0;
  const t0 = performance.now();
  const queue: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    ang += (o.speed * (stepMs / 1000)) / r;
    // the circle starts at (x0 + r, z0): idle there first (circleStart) so the walk begins without a hop
    queue.push([x0 + r * Math.cos(ang), z0 + r * Math.sin(ang)]);
    if (queue.length >= bunch) {
      for (const [x, z] of queue) b.pose(x, z, o.stance);
      queue.length = 0;
    }
    // keep real time: pose i is due at t0 + (i + 1) * stepMs
    const due = t0 + (i + 1) * stepMs;
    const wait = due - performance.now();
    if (wait > 0) await sleep(wait);
  }
  for (const [x, z] of queue) b.pose(x, z, o.stance);
  return [x0 + r * Math.cos(ang), z0 + r * Math.sin(ang)];
}

/** where walk() starts its circle */
export function circleStart(x0: number, z0: number, radius = 0.38): [number, number] {
  return [x0 + radius, z0];
}

/** idle poses at one spot (keeps the seq stream and the track alive) */
export async function idle(b: Bot, x: number, z: number, ms: number, stance: number = STANCE.stand): Promise<void> {
  const t0 = performance.now();
  let i = 0;
  while (performance.now() - t0 < ms) {
    b.pose(x, z, stance);
    i++;
    const wait = t0 + i * 50 - performance.now();
    if (wait > 0) await sleep(wait);
  }
}

export async function noises(b: Bot): Promise<NoiseRec[]> {
  return b.dbg<NoiseRec[]>('players.noise');
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

/** a crew code the server accepts (consonants only) */
export function crewCode(prefix: string): string {
  const tail = Date.now().toString(36).slice(-3).toUpperCase().replace(/[^BCDFGHJKLMNPQRSTVWXZ]/g, 'K');
  return `${prefix}${tail}`.slice(0, 6);
}
