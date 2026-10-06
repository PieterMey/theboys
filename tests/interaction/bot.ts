// ws bot for interaction tests: hello -> welcome, typed req/dbg, pose, event log, InteractionState mirror (patches).
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, decodeMsg, encodeMsg } from '../../packages/shared/src/envelope.ts';
import type { ClientMsg, ServerMsg } from '../../packages/shared/src/envelope.ts';
import { randomProfile } from '../../packages/shared/src/profile.ts';
import { applyInteractionPatch, emptyInteractionState } from '../../packages/shared/src/interactables.ts';
import type { InteractionPatch, InteractionState } from '../../packages/shared/src/messages/interaction.ts';
import type { CrewPublic, FullState, Snapshot } from '../../packages/shared/src/state.ts';

export interface Ev { e: string; d: unknown; t: number }

export class Bot {
  ws!: WebSocket;
  me = '';
  name: string;
  crew: CrewPublic | null = null;
  ix: InteractionState = emptyInteractionState();
  full: FullState | null = null;
  events: Ev[] = [];
  lastSnap: Snapshot | null = null;
  private reqId = 1;
  private seq = 1;
  private pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  private waiters: { pred: (ev: Ev) => boolean; res: (ev: Ev) => void }[] = [];

  constructor(name: string) {
    this.name = name;
  }

  connect(url: string, crew: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.binaryType = 'nodebuffer';
      const t = setTimeout(() => reject(new Error(`${this.name}: no welcome`)), 8000);
      ws.on('open', () => {
        this.send({ op: 'hello', v: PROTOCOL_VERSION, build: 'test', crew, playerKey: randomBytes(16).toString('hex'), name: this.name, profile: randomProfile(this.name) });
      });
      ws.on('message', (data: Buffer) => {
        const m = decodeMsg<ServerMsg>(data);
        if (m.op === 'welcome') {
          this.me = m.you;
          this.crew = m.crew;
          this.applyFull(m.state);
          clearTimeout(t);
          resolve();
        } else if (m.op === 'snap') this.lastSnap = m.s;
        else if (m.op === 'ev') {
          if (m.e === 'crew') this.crew = m.d as CrewPublic;
          if (m.e === 'phase') this.applyFull((m.d as { state: FullState }).state);
          if (m.e === 'interaction.patch') applyInteractionPatch(this.ix, m.d as InteractionPatch);
          const ev = { e: m.e, d: m.d, t: m.t };
          this.events.push(ev);
          this.waiters = this.waiters.filter((w) => {
            if (w.pred(ev)) { w.res(ev); return false; }
            return true;
          });
        } else if (m.op === 'rep') {
          const p = this.pending.get(m.id);
          if (p) {
            this.pending.delete(m.id);
            if (m.ok) p.res(m.d);
            else p.rej(new Error(m.err ?? 'req failed'));
          }
        } else if (m.op === 'err') reject(new Error(`${this.name}: ${m.code} ${m.msg}`));
      });
      ws.on('error', reject);
    });
  }

  private applyFull(st: FullState): void {
    this.full = st;
    this.ix = st.interaction ? applyInteractionPatch(emptyInteractionState(), { reset: st.interaction }) : emptyInteractionState();
  }

  send(m: ClientMsg): void {
    this.ws.send(encodeMsg(m));
  }

  req<T = unknown>(r: string, a: unknown = {}): Promise<T> {
    const id = this.reqId++;
    return new Promise<T>((res, rej) => {
      this.pending.set(id, { res: res as (v: unknown) => void, rej });
      this.send({ op: 'req', id, r: r as never, a });
    });
  }

  dbg<T = unknown>(r: string, a: unknown = {}): Promise<T> {
    return this.req<T>(r.startsWith('dbg.') ? r : `dbg.${r}`, a);
  }

  pose(x: number, z: number, yaw = 0, light: 0 | 1 = 0, stance = 0): void {
    this.send({ op: 'pose', seq: this.seq++, p: [x, 0, z], yaw, pitch: 0, stance, anim: 0, light });
  }

  waitEvent(e: string, pred: (d: never) => boolean = () => true, timeoutMs = 4000): Promise<Ev> {
    const hit = this.events.find((ev) => ev.e === e && pred(ev.d as never));
    if (hit) return Promise.resolve(hit);
    return new Promise((res, rej) => {
      const w = { pred: (ev: Ev) => ev.e === e && pred(ev.d as never), res };
      this.waiters.push(w);
      setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        rej(new Error(`${this.name}: timeout waiting for ${e}`));
      }, timeoutMs);
    });
  }

  clearEvents(): void {
    this.events = [];
  }

  /** wait for the next tick flush */
  settle(ms = 80): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  close(): void {
    this.ws.close();
  }
}
