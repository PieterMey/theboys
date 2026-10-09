// Owner: track (d) Meta. Minimal ws bot client for meta flow tests (envelope codec, hello, req/rep, event log).
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, decodeMsg, encodeMsg } from '../../packages/shared/src/envelope.ts';
import type { ClientMsg, ServerMsg } from '../../packages/shared/src/envelope.ts';
import { randomProfile } from '../../packages/shared/src/profile.ts';
import type { FullState } from '../../packages/shared/src/state.ts';

export type Welcome = Extract<ServerMsg, { op: 'welcome' }>;
export interface Ev { e: string; d: unknown; t: number }

export class Bot {
  name: string;
  key: string;
  ws!: WebSocket;
  welcome: Welcome | null = null;
  events: Ev[] = [];
  state: FullState | null = null;
  private id = 1;
  private pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  private waiters: { pred: (e: Ev) => boolean; res: (e: Ev) => void }[] = [];

  profile: ReturnType<typeof randomProfile> | null = null;
  /** hello.build: 'bot' (default) marks a test bot (ServerPlayer.bot); anything else plays a human client */
  build = 'bot';

  constructor(name: string, key = randomBytes(16).toString('hex'), profile: ReturnType<typeof randomProfile> | null = null) {
    this.name = name;
    this.key = key;
    this.profile = profile;
  }

  get me(): string {
    return this.welcome?.you ?? '';
  }

  join(url: string, crew: string): Promise<Welcome> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.binaryType = 'nodebuffer';
      const t = setTimeout(() => reject(new Error(`${this.name}: no welcome`)), 8000);
      ws.on('open', () => this.send({ op: 'hello', v: PROTOCOL_VERSION, build: this.build, crew, playerKey: this.key, name: this.name, profile: this.profile ?? randomProfile(this.name) }));
      ws.on('message', (data: Buffer) => {
        const m = decodeMsg<ServerMsg>(data);
        if (m.op === 'welcome') {
          clearTimeout(t);
          this.welcome = m;
          this.state = m.state;
          resolve(m);
        } else if (m.op === 'ev') {
          const ev = { e: m.e, d: m.d, t: m.t };
          this.events.push(ev);
          if (m.e === 'phase') this.state = (m.d as { state: FullState }).state;
          if (m.e === 'meta.update' && this.state) {
            const d = m.d as { meta: FullState['meta']; workOrders: FullState['workOrders']; activeOrder: FullState['activeOrder'] };
            this.state.meta = d.meta;
            this.state.workOrders = d.workOrders;
            this.state.activeOrder = d.activeOrder;
          }
          for (const w of this.waiters.slice()) {
            if (w.pred(ev)) {
              this.waiters.splice(this.waiters.indexOf(w), 1);
              w.res(ev);
            }
          }
        } else if (m.op === 'rep') {
          const p = this.pending.get(m.id);
          if (p) {
            this.pending.delete(m.id);
            if (m.ok) p.res(m.d);
            else p.rej(new Error(m.err ?? 'req failed'));
          }
        } else if (m.op === 'err') reject(new Error(`${this.name}: ${m.code} ${m.msg}`));
      });
      ws.on('error', (e) => reject(e));
    });
  }

  send(m: ClientMsg): void {
    this.ws.send(encodeMsg(m));
  }

  req<T = unknown>(r: string, a: unknown = {}): Promise<T> {
    const id = this.id++;
    return new Promise<T>((res, rej) => {
      this.pending.set(id, { res: res as (v: unknown) => void, rej });
      this.send({ op: 'req', id, r: r as never, a });
      setTimeout(() => {
        if (this.pending.delete(id)) rej(new Error(`${this.name}: ${r} timed out`));
      }, 8000);
    });
  }

  /** resolve on the next event matching pred (only events after this call) */
  next(pred: (e: Ev) => boolean, timeoutMs = 8000, what = 'event'): Promise<Ev> {
    return new Promise((res, rej) => {
      const w = { pred, res };
      this.waiters.push(w);
      setTimeout(() => {
        const i = this.waiters.indexOf(w);
        if (i >= 0) {
          this.waiters.splice(i, 1);
          rej(new Error(`${this.name}: timed out waiting for ${what}`));
        }
      }, timeoutMs);
    });
  }

  nextPhase(phase: string, timeoutMs = 8000): Promise<Ev> {
    return this.next((e) => e.e === 'phase' && (e.d as { phase: string }).phase === phase, timeoutMs, `phase ${phase}`);
  }

  close(): void {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}
