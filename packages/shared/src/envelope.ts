// FROZEN CONTRACT (P0). Wire envelope shared by client and server.
// Changes: additive only, via the integrator. Track-specific events/requests live in ./messages/<track>.ts.
import { Packr } from 'msgpackr';
import type { Vec3, Snapshot, FullState, CrewPublic } from './state.ts';
import type { Profile } from './profile.ts';
import type { EventName, EventPayload, ReqName, ReqArgs, ReqResult } from './messages/index.ts';

export const PROTOCOL_VERSION = 1;

/** Every WebSocket frame is binary. Byte 0 selects the frame kind. */
export const FRAME = {
  /** 0x00 + msgpack-encoded Msg */
  msg: 0,
  /** 0x01 + VoiceChunk header + PCM16 mono 16 kHz (see voiceChunk helpers) */
  voiceChunk: 1,
} as const;

/** Client -> server messages */
export type ClientMsg =
  | { op: 'hello'; v: number; build: string; crew: string; playerKey: string; resume?: string; name: string; profile: Profile; admin?: string; password?: string }
  | { op: 'pose'; seq: number; p: Vec3; yaw: number; pitch: number; stance: number; anim: number; light: 0 | 1 }
  /** Loudness band + radio PTT, sent from the mic worklet port on change and at least every 500 ms while not silent. */
  | { op: 'loud'; band: number; radio: 0 | 1 }
  | { op: 'req'; id: number; r: ReqName; a: unknown }
  | { op: 'sig'; to: string; d: unknown }
  | { op: 'ping'; c: number };

/** Server -> client messages */
export type ServerMsg =
  | { op: 'welcome'; v: number; you: string; resume: string; crew: CrewPublic; state: FullState; iceServers: RTCIceServerLike[]; serverTime: number; build: string }
  | { op: 'snap'; s: Snapshot }
  | { op: 'ev'; e: EventName; d: unknown; t: number }
  | { op: 'rep'; id: number; ok: boolean; d?: unknown; err?: string }
  | { op: 'sig'; from: string; d: unknown }
  | { op: 'pong'; c: number; s: number }
  | { op: 'err'; code: ErrCode; msg: string };

export type ErrCode = 'bad_version' | 'stale_build' | 'unknown_crew' | 'crew_full' | 'bad_password' | 'kicked' | 'server';

export interface RTCIceServerLike { urls: string | string[]; username?: string; credential?: string }

// ---------- typed helpers (narrowing by name) ----------
export type TypedEvent<E extends EventName = EventName> = { e: E; d: EventPayload<E>; t: number };
export type TypedReq<R extends ReqName = ReqName> = { r: R; a: ReqArgs<R> };
export type { EventName, EventPayload, ReqName, ReqArgs, ReqResult };

// ---------- codec ----------
const packr = new Packr({ useRecords: false, mapsAsObjects: true });

export function encodeMsg(m: ClientMsg | ServerMsg): Uint8Array<ArrayBuffer> {
  const body = packr.pack(m);
  const out = new Uint8Array(body.length + 1);
  out[0] = FRAME.msg;
  out.set(body, 1);
  return out;
}

export function decodeMsg<T extends ClientMsg | ServerMsg>(buf: Uint8Array): T {
  if (buf[0] !== FRAME.msg) throw new Error('not a msg frame');
  return packr.unpack(buf.subarray(1)) as T;
}

export function frameKind(buf: Uint8Array): number {
  return buf[0];
}

/** Voice chunk frame: [0x01][segId u32 LE][seq u16 LE][flags u8: bit0=start, bit1=end][maxBand u8][pcm Int16LE...] */
export interface VoiceChunkHeader { segId: number; seq: number; start: boolean; end: boolean; maxBand: number }
export const VOICE_CHUNK_HEADER_BYTES = 9;

export function encodeVoiceChunk(h: VoiceChunkHeader, pcm: Int16Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(VOICE_CHUNK_HEADER_BYTES + pcm.byteLength);
  const dv = new DataView(out.buffer);
  out[0] = FRAME.voiceChunk;
  dv.setUint32(1, h.segId >>> 0, true);
  dv.setUint16(5, h.seq & 0xffff, true);
  out[7] = (h.start ? 1 : 0) | (h.end ? 2 : 0);
  out[8] = h.maxBand & 0xff;
  out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), VOICE_CHUNK_HEADER_BYTES);
  return out;
}

export function decodeVoiceChunk(buf: Uint8Array): { h: VoiceChunkHeader; pcm: Int16Array } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const h: VoiceChunkHeader = {
    segId: dv.getUint32(1, true),
    seq: dv.getUint16(5, true),
    start: (buf[7] & 1) !== 0,
    end: (buf[7] & 2) !== 0,
    maxBand: buf[8],
  };
  const bytes = buf.slice(VOICE_CHUNK_HEADER_BYTES); // copy => aligned
  return { h, pcm: new Int16Array(bytes.buffer, 0, bytes.byteLength >> 1) };
}
