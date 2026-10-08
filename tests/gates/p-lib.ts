// Gate P helpers (integrator): minimal ws bots that hold a pose with the flashlight on (beams for the draw-call
// probe and the server CPU probe), plus layout helpers that pick fixed camera views. No browser here.
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, decodeMsg, encodeMsg } from '../../packages/shared/src/envelope.ts';
import type { ClientMsg, ServerMsg } from '../../packages/shared/src/envelope.ts';
import { randomProfile } from '../../packages/shared/src/profile.ts';

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export type V3 = [number, number, number];

export class Bot {
  ws!: WebSocket;
  id = '';
  name: string;
  seq = 0;
  /** the pose this bot streams at 20 Hz (null = silent) */
  target: { x: number; z: number; yaw: number; pitch: number; light: 0 | 1; anim: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending = new Map<number, { res: (v: unknown) => void; rej: (e: Error) => void }>();
  private nextId = 1;
  constructor(name: string) { this.name = name; }

  async connect(url: string, crew: string): Promise<void> {
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'nodebuffer';
    await new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${this.name}: no welcome`)), 10_000);
      this.ws.on('open', () => this.send({ op: 'hello', v: PROTOCOL_VERSION, build: 'gate-p', crew, playerKey: randomBytes(16).toString('hex'), name: this.name, profile: randomProfile(this.name) }));
      this.ws.on('message', (data: Buffer) => {
        const m = decodeMsg<ServerMsg>(data);
        if (m.op === 'welcome') { this.id = m.you; clearTimeout(t); res(); }
        else if (m.op === 'rep') {
          const p = this.pending.get(m.id);
          if (p) { this.pending.delete(m.id); if (m.ok) p.res(m.d); else p.rej(new Error(m.err ?? 'req failed')); }
        } else if (m.op === 'err') rej(new Error(`${this.name}: ${m.code} ${m.msg}`));
      });
      this.ws.on('error', rej);
    });
    const tick = () => {
      if (this.target && this.ws.readyState === WebSocket.OPEN) {
        const t = this.target;
        this.send({ op: 'pose', seq: ++this.seq, p: [t.x, 0, t.z], yaw: t.yaw, pitch: t.pitch, stance: 0, anim: t.anim, light: t.light });
      }
      this.timer = setTimeout(tick, 50);
    };
    tick();
  }

  send(m: ClientMsg): void { this.ws.send(encodeMsg(m)); }

  req<T = unknown>(r: string, a: unknown = {}, timeoutMs = 15_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((res, rej) => {
      this.pending.set(id, { res: res as (v: unknown) => void, rej });
      this.send({ op: 'req', id, r: r as never, a });
      setTimeout(() => { if (this.pending.delete(id)) rej(new Error(`req ${r} timed out`)); }, timeoutMs);
    });
  }

  dbg<T = unknown>(r: string, a: unknown = {}): Promise<T> { return this.req<T>(r.startsWith('dbg.') ? r : `dbg.${r}`, a); }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------- layout views
interface Rect { x: number; y: number; w: number; h: number }
interface Space { id: number; kind: string; type: string; rect: Rect; open?: boolean }
interface Item { id: string; kind: string; x: number; z: number; y?: number; rot?: number; space?: number; data?: Record<string, unknown> }
export interface LayoutLite { kind: string; seed: string; hash: string; W: number; H: number; owner: number[]; spaces: Space[]; items: Item[]; van: { x: number; z: number; yaw: number; cab: Rect }; entrance?: unknown }

export interface View { name: string; x: number; z: number; yaw: number; pitch: number; bots: { x: number; z: number; yaw: number }[] }

/** yaw so that forward = (sin yaw, cos yaw) points from (x,z) to (tx,tz) */
export const yawTo = (x: number, z: number, tx: number, tz: number) => Math.atan2(tx - x, tz - z);

/** 5 bot spots spread ahead of the camera inside rect r (feet positions), beams pointing the same way */
export function botsAhead(r: Rect, x: number, z: number, yaw: number): { x: number; z: number; yaw: number }[] {
  const fx = Math.sin(yaw), fz = Math.cos(yaw), rx = -Math.cos(yaw), rz = Math.sin(yaw);
  const spots: [number, number][] = [[1.6, -0.7], [1.9, 0.8], [3.0, -0.2], [3.6, 1.0], [4.2, -1.0]];
  const clampX = (v: number) => Math.min(r.x + r.w - 0.45, Math.max(r.x + 0.45, v));
  const clampZ = (v: number) => Math.min(r.y + r.h - 0.45, Math.max(r.y + 0.45, v));
  return spots.map(([f, s]) => ({ x: clampX(x + fx * f + rx * s), z: clampZ(z + fz * f + rz * s), yaw }));
}

/** fixed facility views: the arrival (spawn -> entrance), the biggest rooms corner-to-corner, the longest corridors end-to-end */
export function facilityViews(L: LayoutLite, nRooms = 6, nCorr = 3): View[] {
  const out: View[] = [];
  const sp = L.items.filter((i) => i.kind === 'spawn_player');
  const s0 = sp[0];
  const ent = L.items.find((i) => i.kind === 'console') ?? s0;
  if (s0) {
    // arrival: from the first player spawn towards the facility (away from the van)
    const vx = L.van.cab.x + L.van.cab.w / 2, vz = L.van.cab.y + L.van.cab.h / 2;
    const yaw = typeof s0.rot === 'number' ? s0.rot : (yawTo(vx, vz, s0.x, s0.z) || 0);
    const own = L.owner[Math.floor(s0.z) * L.W + Math.floor(s0.x)];
    const r = own >= 0 ? L.spaces[own].rect : { x: s0.x - 3, y: s0.z - 3, w: 6, h: 6 };
    out.push({ name: 'arrive', x: s0.x, z: s0.z, yaw, pitch: -0.05, bots: botsAhead(r, s0.x, s0.z, yaw) });
  }
  void ent;
  const rooms = L.spaces.filter((s) => s.kind === 'room' && s.type !== 'van').sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h).slice(0, nRooms);
  for (const s of rooms) {
    const r = s.rect;
    const x = r.x + 0.6, z = r.y + 0.6;
    const yaw = yawTo(x, z, r.x + r.w, r.y + r.h);
    out.push({ name: `room${s.id}_${s.type}`, x, z, yaw, pitch: -0.08, bots: botsAhead(r, x, z, yaw) });
  }
  const corr = L.spaces.filter((s) => s.kind === 'corridor').sort((a, b) => Math.max(b.rect.w, b.rect.h) - Math.max(a.rect.w, a.rect.h)).slice(0, nCorr);
  for (const s of corr) {
    const r = s.rect;
    const along = r.w >= r.h;
    const x = along ? r.x + 0.5 : r.x + r.w / 2, z = along ? r.y + r.h / 2 : r.y + 0.5;
    const yaw = along ? yawTo(x, z, r.x + r.w, z) : yawTo(x, z, x, r.y + r.h);
    out.push({ name: `corr${s.id}`, x, z, yaw, pitch: -0.03, bots: botsAhead(r, x, z, yaw) });
  }
  return out;
}

/** a view 2 m in front of a layout mirror, facing it (null if none) */
export function mirrorView(L: LayoutLite): View | null {
  const m = L.items.find((i) => i.kind === 'prop' && i.data && (i.data.mirror !== undefined) && L.spaces[i.space ?? -1]?.type !== 'van');
  if (!m) return null;
  const rot = m.rot ?? 0;
  // the glass faces local +Z rotated by rot
  const nx = Math.sin(rot), nz = Math.cos(rot);
  const x = m.x + nx * 2, z = m.z + nz * 2;
  const own = L.owner[Math.floor(z) * L.W + Math.floor(x)];
  const r = own >= 0 ? L.spaces[own].rect : { x: x - 2, y: z - 2, w: 4, h: 4 };
  const yaw = yawTo(x, z, m.x, m.z);
  return { name: `mirror_${m.id}`, x, z, yaw, pitch: -0.02, bots: botsAhead(r, x, z, yaw + Math.PI).map((b) => ({ ...b, yaw })) };
}
