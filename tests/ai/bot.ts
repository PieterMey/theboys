// Track (e) e2e helpers: a ws bot speaking the envelope codec, WAV -> 16 kHz PCM, dev-server spawner.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, decodeMsg, encodeMsg, encodeVoiceChunk } from '../../packages/shared/src/envelope.ts';
import type { ClientMsg, ServerMsg } from '../../packages/shared/src/envelope.ts';
import { randomProfile } from '../../packages/shared/src/profile.ts';
import { REPO } from './helpers.ts';

export async function waitHttp(url: string, ms: number, check: (r: Response) => Promise<boolean> = async (r) => r.ok): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (await check(r)) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/** Spawn the real dev server (all tracks) on `port`, AI_MODE=mock. Saves and the session file default to a temp
 *  folder: the repo's saves/ belongs to the live server. */
export function startDevServer(port: number, sttUrl: string): ChildProcess {
  const scratch = process.env.SAVES_DIR && process.env.SESSION_FILE ? '' : mkdtempSync(join(tmpdir(), 'deadair-ai-'));
  const server = spawn(process.execPath, ['--env-file-if-exists=C:/Users/Pieter/repos/theboys/.env', join(REPO, 'apps/server/src/index.ts'), '--dev'], {
    env: {
      ...process.env, PORT: String(port), AI_MODE: 'mock', STT_URL: sttUrl, NODE_ENV: 'development',
      SAVES_DIR: process.env.SAVES_DIR ?? join(scratch, 'saves'), SESSION_FILE: process.env.SESSION_FILE ?? join(scratch, `session-${port}.json`),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (d: Buffer) => { if (process.env.E2E_VERBOSE) process.stdout.write(`[srv] ${d}`); });
  server.stderr?.on('data', (d: Buffer) => { if (!/CF_TURN/.test(String(d))) process.stderr.write(`[srv] ${d}`); });
  return server;
}

/** Mono PCM16 WAV at any rate -> 16 kHz Int16 (box-filter decimation). */
export function wav16k(path: string): Int16Array {
  const b = readFileSync(path);
  const rate = b.readUInt32LE(24);
  let off = 12;
  let data: Buffer | null = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const len = b.readUInt32LE(off + 4);
    if (id === 'data') { data = b.subarray(off + 8, off + 8 + len); break; }
    off += 8 + len + (len & 1);
  }
  if (!data) throw new Error('no data chunk');
  const src = new Int16Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  if (rate === 16000) return src;
  const ratio = rate / 16000;
  const n = Math.floor(src.length / ratio);
  const out = new Int16Array(n);
  const w = Math.max(1, Math.round(ratio));
  for (let i = 0; i < n; i++) {
    const k = Math.floor(i * ratio);
    let acc = 0, cnt = 0;
    for (let j = k; j < Math.min(src.length, k + w); j++) { acc += src[j]; cnt++; }
    out[i] = Math.max(-32768, Math.min(32767, Math.round(acc / Math.max(1, cnt))));
  }
  return out;
}

export class Bot {
  ws: WebSocket;
  id = '';
  private reqId = 1;
  private pending = new Map<number, (m: Extract<ServerMsg, { op: 'rep' }>) => void>();
  private welcomed: Promise<void>;
  constructor(url: string, crew: string, name: string) {
    this.ws = new WebSocket(url);
    this.ws.binaryType = 'nodebuffer';
    this.welcomed = new Promise((resolve, reject) => {
      this.ws.on('open', () => this.send({ op: 'hello', v: PROTOCOL_VERSION, build: 'e2e', crew, playerKey: randomBytes(16).toString('hex'), name, profile: randomProfile(name) }));
      this.ws.on('message', (data: Buffer) => {
        const m = decodeMsg<ServerMsg>(data);
        if (m.op === 'welcome') { this.id = m.you; resolve(); }
        else if (m.op === 'rep') this.pending.get(m.id)?.(m);
        else if (m.op === 'err') reject(new Error(`${m.code}: ${m.msg}`));
      });
      this.ws.on('error', reject);
    });
  }
  ready(): Promise<void> { return this.welcomed; }
  send(m: ClientMsg): void { this.ws.send(encodeMsg(m)); }
  req<T = unknown>(r: string, a: unknown = {}): Promise<T> {
    const id = this.reqId++;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${r}: timeout`)), 8000);
      this.pending.set(id, (m) => { clearTimeout(t); this.pending.delete(id); if (m.ok) resolve(m.d as T); else reject(new Error(`${r}: ${m.err}`)); });
      this.send({ op: 'req', id, r: r as never, a });
    });
  }
  /** stream PCM as 100 ms voice chunks in real time; resolves at speech end (performance.now()) */
  async speak(pcm: Int16Array, segId: number, band: number): Promise<number> {
    const n = 1600;
    const chunks = Math.ceil(pcm.length / n);
    let t = performance.now();
    for (let i = 0; i < chunks; i++) {
      const part = pcm.subarray(i * n, Math.min(pcm.length, (i + 1) * n));
      this.ws.send(encodeVoiceChunk({ segId, seq: i, start: i === 0, end: i === chunks - 1, maxBand: band }, part.slice()));
      t += 100;
      const wait = t - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    }
    return performance.now();
  }
}
