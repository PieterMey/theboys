// Track ① Net: headless bot client (Node ws + the shared envelope codec). Joins a crew, walks, reconnects with
// its resume token, records snapshots/events. Used by tests/net/*.e2e.ts and handy for other tracks' tests:
//   const b = new Bot({ url: 'ws://127.0.0.1:3001/ws', name: 'bot1', crew: 'ABCD' }); await b.connect();
//   await b.walk([10, 0, 10], 3); b.close();
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, decodeMsg, encodeMsg } from '../../packages/shared/src/envelope.ts';
import type { ClientMsg, ServerMsg } from '../../packages/shared/src/envelope.ts';
import { randomProfile } from '../../packages/shared/src/profile.ts';
import type { Snapshot, Vec3 } from '../../packages/shared/src/state.ts';

export type Welcome = Extract<ServerMsg, { op: 'welcome' }>;

export interface BotOpts {
  url: string;
  name: string;
  crew: string;
  /** stable player key (same key => same player id); random by default */
  key?: string;
  admin?: string;
  password?: string;
  /** client build id; default: apps/client/dist/build.json (prod servers reject other builds) */
  build?: string;
}

export function distBuild(): string {
  const p = join(resolve(import.meta.dirname, '../..'), 'apps/client/dist/build.json');
  try {
    return existsSync(p) ? String((JSON.parse(readFileSync(p, 'utf8')) as { build?: string }).build ?? 'dev') : 'dev';
  } catch {
    return 'dev';
  }
}

export class Bot {
  readonly opts: BotOpts;
  readonly key: string;
  ws: WebSocket | null = null;
  welcome: Welcome | null = null;
  me: string | null = null;
  resume: string | undefined;
  crew: string;
  pos: Vec3 = [0, 0, 0];
  yaw = 0;
  seq = 0;
  lastSnap: Snapshot | null = null;
  snaps = 0;
  events: { e: string; d: unknown; t: number }[] = [];
  errors: { code: string; msg: string }[] = [];
  sigs: { from: string; d: unknown }[] = [];
  private reqId = 1;
  private pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  private evWaiters: { e: string; pred: (d: unknown) => boolean; res: (d: unknown) => void }[] = [];

  constructor(opts: BotOpts) {
    this.opts = opts;
    this.key = opts.key ?? randomBytes(16).toString('hex');
    this.crew = opts.crew;
  }

  send(m: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(encodeMsg(m));
  }

  /** connect (or reconnect with the resume token); resolves on welcome, rejects on err/close */
  connect(timeoutMs = 8000): Promise<Welcome> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.opts.url);
      ws.binaryType = 'nodebuffer';
      this.ws = ws;
      const timer = setTimeout(() => { ws.terminate(); reject(new Error(`${this.opts.name}: welcome timeout`)); }, timeoutMs);
      ws.on('open', () => {
        this.send({
          op: 'hello', v: PROTOCOL_VERSION, build: this.opts.build ?? distBuild(), crew: this.crew, playerKey: this.key,
          resume: this.resume, name: this.opts.name, profile: randomProfile(this.opts.name), admin: this.opts.admin, password: this.opts.password,
        });
      });
      ws.on('message', (data: Buffer) => {
        let m: ServerMsg;
        try { m = decodeMsg<ServerMsg>(data); } catch { return; }
        switch (m.op) {
          case 'welcome': {
            clearTimeout(timer);
            this.welcome = m;
            this.me = m.you;
            this.resume = m.resume;
            this.crew = m.crew.code;
            const mine = m.state.snap?.players.find((p) => p.id === m.you);
            if (mine) this.pos = [mine.p[0], mine.p[1], mine.p[2]];
            resolve(m);
            break;
          }
          case 'snap':
            this.lastSnap = m.s;
            this.snaps++;
            break;
          case 'ev': {
            this.events.push({ e: m.e, d: m.d, t: m.t });
            if (m.e === 'net.correct') {
              const d = m.d as { p: Vec3 };
              this.pos = [d.p[0], d.p[1], d.p[2]];
            }
            this.evWaiters = this.evWaiters.filter((w) => {
              if (w.e === m.e && w.pred(m.d)) { w.res(m.d); return false; }
              return true;
            });
            break;
          }
          case 'rep': {
            const p = this.pending.get(m.id);
            if (!p) break;
            this.pending.delete(m.id);
            if (m.ok) p.res(m.d);
            else p.rej(new Error(m.err ?? 'request failed'));
            break;
          }
          case 'sig':
            this.sigs.push({ from: m.from, d: m.d });
            break;
          case 'err':
            this.errors.push({ code: m.code, msg: m.msg });
            clearTimeout(timer);
            reject(Object.assign(new Error(`${this.opts.name}: ${m.code}: ${m.msg}`), { code: m.code }));
            break;
          default:
            break;
        }
      });
      ws.on('close', () => {
        clearTimeout(timer);
        for (const [, p] of this.pending) p.rej(new Error('closed'));
        this.pending.clear();
        if (!this.welcome || this.ws !== ws) reject(new Error(`${this.opts.name}: closed before welcome`));
      });
      ws.on('error', () => { /* close follows */ });
    });
  }

  req<T = unknown>(r: string, a: unknown = {}, timeoutMs = 5000): Promise<T> {
    return new Promise((res, rej) => {
      const id = this.reqId++;
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`${r} timeout`)); }, timeoutMs);
      this.pending.set(id, { res: (v) => { clearTimeout(t); res(v as T); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.send({ op: 'req', id, r: r as never, a });
    });
  }

  waitEvent<T = unknown>(e: string, pred: (d: T) => boolean = () => true, timeoutMs = 3000): Promise<T> {
    return new Promise((res, rej) => {
      const w = { e, pred: pred as (d: unknown) => boolean, res: res as (d: unknown) => void };
      this.evWaiters.push(w);
      setTimeout(() => { this.evWaiters = this.evWaiters.filter((x) => x !== w); rej(new Error(`event ${e} timeout`)); }, timeoutMs);
    });
  }

  pose(p: Vec3 = this.pos, yaw = this.yaw, stance = 0): void {
    this.pos = [p[0], p[1], p[2]];
    this.yaw = yaw;
    this.send({ op: 'pose', seq: ++this.seq, p: this.pos, yaw, pitch: 0, stance, anim: 0, light: 1 });
  }

  loud(band: number): void {
    this.send({ op: 'loud', band, radio: 0 });
  }

  /** walk in a straight line toward `to` at `speed` m/s, posing at 20 Hz */
  async walk(to: Vec3, speed = 3): Promise<void> {
    const step = speed / 20;
    for (;;) {
      const dx = to[0] - this.pos[0], dz = to[2] - this.pos[2];
      const d = Math.hypot(dx, dz);
      if (d < 1e-3) break;
      const k = Math.min(1, step / d);
      this.pose([this.pos[0] + dx * k, this.pos[1], this.pos[2] + dz * k], Math.atan2(dx, dz));
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** the server's view of a player in the latest snapshot */
  seen(id: string | null = this.me): Vec3 | null {
    const p = this.lastSnap?.players.find((q) => q.id === id);
    return p ? [p.p[0], p.p[1], p.p[2]] : null;
  }

  drop(): void {
    this.ws?.terminate();
    this.ws = null;
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }
}
