// Owner: workshop (v1.2). Test harness: the full server booted in-process on PORT (default 3805, the workshop test
// port) with a temp SAVES_DIR + SESSION_FILE under WORKSHOP_SCRATCH (or the OS temp dir), AI_MODE=mock, plus a ws bot
// that mirrors the interaction state and the meta slice. In-process, so tests can also call the crafting hooks on the
// live Crew objects (srv.ctx.crews.get(code)).
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, decodeMsg, encodeMsg } from '../../packages/shared/src/envelope.ts';
import type { ClientMsg, ServerMsg } from '../../packages/shared/src/envelope.ts';
import { randomProfile } from '../../packages/shared/src/profile.ts';
import { applyInteractionPatch, emptyInteractionState } from '../../packages/shared/src/interactables.ts';
import type { InteractionPatch, InteractionState } from '../../packages/shared/src/messages/interaction.ts';
import type { FullState, Snapshot } from '../../packages/shared/src/state.ts';
import type { MetaState } from '../../packages/shared/src/messages/meta.ts';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Booted {
  ctx: import('../../apps/server/src/core/types.ts').ServerContext;
  port: number;
  installErrors: string[];
  close(): Promise<void>;
}

const TRACKS = ['net', 'level', 'players', 'voice', 'objectives', 'interaction', 'monsters', 'paranormal', 'meta', 'safes', 'fieldguide', 'ai'];

/** fresh temp saves dir (SAVES_DIR + SESSION_FILE point into it) */
export function tempSaves(name: string): string {
  const root = process.env.WORKSHOP_SCRATCH ?? join(tmpdir(), 'deadair-workshop');
  mkdirSync(root, { recursive: true });
  return mkdtempSync(join(root, `${name}-`));
}

/** boot every server track in this process (dev mode: dbg.* on). Call once per process. */
export async function bootServer(saves: string): Promise<{ srv: Booted; url: string }> {
  process.env.SAVES_DIR = saves;
  process.env.SESSION_FILE = join(saves, 'session.json');
  process.env.NODE_ENV = 'development';
  process.env.AI_MODE = 'mock';
  const { boot } = await import('../../apps/server/src/core/boot.ts');
  const { setQuiet } = await import('../../apps/server/src/core/log.ts');
  const tracks: [string, (ctx: never) => unknown][] = [];
  for (const n of TRACKS) {
    try {
      const m = (await import(`../../apps/server/src/${n}/index.ts`)) as { install: (ctx: never) => unknown };
      tracks.push([n, m.install]);
    } catch (e) {
      console.warn(`track ${n} failed to import (mid-edit elsewhere?): ${e instanceof Error ? e.message.split('\n')[0] : e}`);
    }
  }
  if (!process.env.VERBOSE) setQuiet(true);
  const srv = (await boot({ mode: 'development', port: Number(process.env.PORT ?? 3805), tracks: tracks as never })) as Booted;
  for (const e of srv.installErrors) console.warn(e.split('\n')[0]);
  return { srv, url: `ws://127.0.0.1:${srv.port}/ws` };
}

export interface Ev { e: string; d: unknown; t: number }

export class Bot {
  ws!: WebSocket;
  me = '';
  name: string;
  key: string;
  ix: InteractionState = emptyInteractionState();
  full: FullState | null = null;
  events: Ev[] = [];
  lastSnap: Snapshot | null = null;
  private reqId = 1;
  private seq = 1;
  private pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  private waiters: { pred: (ev: Ev) => boolean; res: (ev: Ev) => void }[] = [];

  constructor(name: string, key = randomBytes(16).toString('hex')) {
    this.name = name;
    this.key = key;
  }

  get meta(): MetaState | null {
    return this.full?.meta ?? null;
  }
  get phase(): string {
    return this.full?.phase ?? '';
  }

  connect(url: string, crew: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      this.ws = ws;
      ws.binaryType = 'nodebuffer';
      const t = setTimeout(() => reject(new Error(`${this.name}: no welcome`)), 15_000);
      ws.on('open', () => {
        this.send({ op: 'hello', v: PROTOCOL_VERSION, build: 'test', crew, playerKey: this.key, name: this.name, profile: randomProfile(this.name) });
      });
      ws.on('message', (data: Buffer) => {
        const m = decodeMsg<ServerMsg>(data);
        if (m.op === 'welcome') {
          this.me = m.you;
          this.applyFull(m.state);
          clearTimeout(t);
          resolve();
        } else if (m.op === 'snap') this.lastSnap = m.s;
        else if (m.op === 'ev') {
          if (m.e === 'phase') this.applyFull((m.d as { state: FullState }).state);
          if (m.e === 'interaction.patch') applyInteractionPatch(this.ix, m.d as InteractionPatch);
          if (m.e === 'meta.update' && this.full) {
            const d = m.d as { meta: MetaState; workOrders: FullState['workOrders']; activeOrder: FullState['activeOrder'] };
            this.full.meta = d.meta;
            this.full.workOrders = d.workOrders;
            this.full.activeOrder = d.activeOrder;
          }
          const ev = { e: m.e, d: m.d, t: m.t };
          this.events.push(ev);
          if (this.events.length > 4000) this.events.splice(0, 1000);
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

  req<T = unknown>(r: string, a: unknown = {}, timeoutMs = 10_000): Promise<T> {
    const id = this.reqId++;
    return new Promise<T>((res, rej) => {
      this.pending.set(id, { res: res as (v: unknown) => void, rej });
      this.send({ op: 'req', id, r: r as never, a });
      setTimeout(() => {
        if (this.pending.delete(id)) rej(new Error(`${this.name}: ${r} timed out`));
      }, timeoutMs);
    });
  }

  /** request that resolves to the error message instead of rejecting (denial checks) */
  async reqErr(r: string, a: unknown = {}): Promise<string | null> {
    try {
      await this.req(r, a);
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  dbg<T = unknown>(r: string, a: unknown = {}): Promise<T> {
    return this.req<T>(r.startsWith('dbg.') ? r : `dbg.${r}`, a);
  }

  pose(x: number, z: number, yaw = 0): void {
    this.send({ op: 'pose', seq: this.seq++, p: [x, 0, z], yaw, pitch: 0, stance: 0, anim: 0, light: 0 });
  }

  /** place the server-side pose instantly (dbg.interaction.pose; no movement validation) */
  async place(x: number, z: number, yaw = 0): Promise<void> {
    await this.dbg('interaction.pose', { x, z, yaw });
  }

  waitEvent(e: string, pred: (d: never) => boolean = () => true, timeoutMs = 6000): Promise<Ev> {
    return new Promise((res, rej) => {
      const w = { pred: (ev: Ev) => ev.e === e && pred(ev.d as never), res };
      this.waiters.push(w);
      setTimeout(() => {
        const had = this.waiters.includes(w);
        this.waiters = this.waiters.filter((x) => x !== w);
        if (had) rej(new Error(`${this.name}: timeout waiting for ${e}`));
      }, timeoutMs);
    });
  }

  waitPhase(phase: string, timeoutMs = 20_000): Promise<Ev> {
    if (this.phase === phase) return Promise.resolve({ e: 'phase', d: { phase }, t: 0 });
    return this.waitEvent('phase', (d: { phase: string }) => d.phase === phase, timeoutMs);
  }

  /** my inventory slots (item ids or null) */
  inv(): (string | null)[] {
    return this.ix.inventories[this.me] ?? [];
  }

  close(): void {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

/** unique 4-letter crew code (consonants) */
export function crewCode(prefix: string): string {
  const A = 'BCDFGHJKLMNPQRSTVWXZ';
  const n = Date.now() + Math.floor(performance.now() * 1000);
  return (prefix + A[n % 20] + A[Math.floor(n / 20) % 20] + A[Math.floor(n / 400) % 20]).slice(0, 4).toUpperCase();
}

let fails = 0;
let passes = 0;
export function check(step: string, ok: boolean, info?: unknown): boolean {
  if (ok) passes++;
  else fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step}${info !== undefined ? ` :: ${JSON.stringify(info)}` : ''}`);
  return ok;
}
export function note(text: string): void {
  console.log(`NOTE ${text}`);
}
export function summary(): number {
  console.log(fails ? `${fails} check(s) failed, ${passes} passed` : `all ${passes} checks passed`);
  return fails ? 1 : 0;
}

/** hub -> drive -> contract through the real meta flow (leader picks order 0, everyone readies, dbg skips the drive) */
export async function toContract(bots: Bot[]): Promise<void> {
  const lead = bots[0];
  const order = lead.full?.workOrders?.find((o) => o.available) ?? lead.full?.workOrders?.[0];
  if (!order) throw new Error('no work order on the board');
  await lead.req('meta.pick', { orderId: order.id });
  const drive = lead.waitPhase('drive', 15_000);
  for (const b of bots) await b.req('meta.ready', { ready: true });
  await drive;
  await sleep(150);
  const contract = lead.waitPhase('contract', 60_000);
  await lead.dbg('meta.skipDrive');
  await contract;
  for (const b of bots.slice(1)) await b.waitPhase('contract', 20_000);
  await sleep(400);
}

/** a standing spot `dist` m in front of a station (towards its aim point) */
export function standAt(st: { x: number; z: number; p: [number, number, number] }, dist = 0.9): [number, number] {
  const dx = st.p[0] - st.x, dz = st.p[2] - st.z;
  const l = Math.hypot(dx, dz) || 1;
  return [st.x + (dx / l) * dist, st.z + (dz / l) * dist];
}
