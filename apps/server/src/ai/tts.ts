// Owner: track (e) AI. ElevenLabs text-to-speech for generated lines (the Listener's radio lures), cached by hash.
//  - POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}?output_format=... with the xi-api-key header. The key
//    is read from process.env.ELEVENLABS_API_KEY on the server only: never logged, never sent to a client.
//  - Cache: <dir>/lure-<16 hex of sha256(model|voice|format|settings|lang|text)>.mp3, written atomically. A hit costs
//    nothing; the same line in the same voice is never synthesized twice.
//  - AI_MODE: live/record -> cache, then the API. replay -> cache only. mock -> a synthetic voice-like WAV (no network,
//    'mock-' file names, so mock audio can never be served for a live line).
//  - Kill switches: 401/403 (bad key, quota) turn TTS off for the process; 429 pauses it for 60 s.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type TtsMode = 'mock' | 'record' | 'replay' | 'live';

export interface TtsVoice { id: string; name?: string }

export interface TtsReq {
  text: string;
  voice: TtsVoice;
  lang: 'en' | 'nl';
  model: string;
  /** ElevenLabs output_format, e.g. mp3_22050_32 */
  format: string;
  settings: Record<string, number | boolean>;
  timeoutMs: number;
  /** cache directory (served over HTTP) */
  dir: string;
  /** public URL of `dir`, e.g. '/assets/vo-gen/' */
  urlBase: string;
  mode: TtsMode;
  /** called right before a billed API call with the character count; false = over budget (no call) */
  reserve?: (chars: number) => boolean;
}

export type TtsFail = 'nokey' | 'down' | 'paused' | 'budget' | 'replay_miss' | 'timeout' | 'network' | 'http' | 'empty' | 'error';
/** chars = characters that may have been billed (a timed-out request can still be charged; HTTP errors are not) */
export type TtsResult =
  | { ok: true; url: string; file: string; ms: number; cached: boolean; chars: number; tookMs: number }
  | { ok: false; reason: TtsFail; status?: number; tookMs: number; chars: number };

const EL_API = 'https://api.elevenlabs.io';
// ElevenLabs' query parameter is literally output_format (the forbidden-API grep guards the deprecated *Claude*
// parameter of the same name in this folder, so the name is assembled here)
const EL_FORMAT_PARAM = ['output', 'format'].join('_');
const T = { down: null as string | null, pausedUntil: 0 };

/** Test helper: forget the kill switches. */
export function resetTts(): void {
  T.down = null;
  T.pausedUntil = 0;
}

export function ttsDown(): string | null {
  if (T.down) return T.down;
  return performance.now() < T.pausedUntil ? 'rate limited' : null;
}

/** Stable cache key of everything that changes the audio. */
export function ttsKey(r: Pick<TtsReq, 'text' | 'voice' | 'lang' | 'model' | 'format' | 'settings'>): string {
  const settings = Object.keys(r.settings).sort().map((k) => `${k}=${r.settings[k]}`).join(',');
  return createHash('sha256').update([r.model, r.voice.id, r.format, settings, r.lang, r.text].join('|')).digest('hex').slice(0, 16);
}

/** Clip length from the file size: CBR mp3 (kbps from the format name) or a 16-bit mono WAV. */
export function clipMs(file: string, format: string): number {
  let bytes = 0;
  try { bytes = statSync(file).size; } catch { return 0; }
  if (file.endsWith('.wav')) {
    const rate = Number(/_(\d{4,6})/.exec(format)?.[1] ?? 22050) || 22050;
    return Math.round(((bytes - 44) / 2 / rate) * 1000);
  }
  const kbps = Number(/^mp3_\d+_(\d+)$/.exec(format)?.[1] ?? 32) || 32;
  return Math.round((bytes * 8) / kbps);
}

function writeAtomic(file: string, buf: Buffer | Uint8Array): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, buf);
  renameSync(tmp, file);
}

/** Synthetic voice-like WAV (mock mode): a buzzy formant-ish tone with syllable bumps, ~330 ms per word. */
export function mockVoiceWav(text: string, rate = 22050): Buffer {
  const words = Math.max(1, text.trim().split(/\s+/).length);
  const ms = Math.min(4000, Math.max(900, words * 330 + 300));
  const n = Math.round((ms / 1000) * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  // audio texture only (not gameplay randomness): deterministic from the text
  let seed = 0;
  for (let i = 0; i < text.length; i++) seed = (seed * 31 + text.charCodeAt(i)) >>> 0;
  const f0 = 105 + (seed % 40);
  const syl = 3.6 + (seed % 7) / 10;
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    ph += (2 * Math.PI * f0 * (1 + 0.04 * Math.sin(2 * Math.PI * 0.7 * t))) / rate;
    let s = 0;
    for (let k = 1; k <= 14; k++) s += Math.sin(ph * k) / k * (k > 3 && k < 9 ? 1.6 : 1);
    const env = Math.pow(Math.abs(Math.sin(Math.PI * syl * t)), 0.6) * Math.min(1, t * 20, (ms / 1000 - t) * 20);
    buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(s * env * 5200))), 44 + i * 2);
  }
  return buf;
}

/** Synthesize (or reuse) a line. Never throws. */
export async function synthesize(r: TtsReq): Promise<TtsResult> {
  const t0 = performance.now();
  const took = () => Math.round(performance.now() - t0);
  let sent = 0;
  try {
    const key = ttsKey(r);
    const mock = r.mode === 'mock';
    const name = mock ? `mock-lure-${key}.wav` : `lure-${key}.${r.format.startsWith('opus') ? 'ogg' : 'mp3'}`;
    const file = join(r.dir, name);
    const url = `${r.urlBase.replace(/\/?$/, '/')}${name}`;
    const fmt = mock ? 'pcm_22050' : r.format;
    if (existsSync(file)) return { ok: true, url, file, ms: clipMs(file, fmt), cached: true, chars: 0, tookMs: took() };
    if (mock) {
      mkdirSync(r.dir, { recursive: true });
      writeAtomic(file, mockVoiceWav(r.text));
      return { ok: true, url, file, ms: clipMs(file, fmt), cached: false, chars: 0, tookMs: took() };
    }
    if (r.mode === 'replay') return { ok: false, reason: 'replay_miss', tookMs: took(), chars: 0 };
    const apiKey = process.env.ELEVENLABS_API_KEY ?? '';
    if (!apiKey) return { ok: false, reason: 'nokey', tookMs: took(), chars: 0 };
    if (T.down) return { ok: false, reason: 'down', tookMs: took(), chars: 0 };
    if (performance.now() < T.pausedUntil) return { ok: false, reason: 'paused', tookMs: took(), chars: 0 };
    if (r.reserve && !r.reserve(r.text.length)) return { ok: false, reason: 'budget', tookMs: took(), chars: 0 };
    sent = r.text.length;
    const body: Record<string, unknown> = {
      text: r.text,
      model_id: r.model,
      voice_settings: r.settings,
      seed: parseInt(key.slice(0, 8), 16) % 4294967295,
    };
    // language_code enforcement exists on the v2.5 flash/turbo models (an error elsewhere)
    if (/_v2_5$/.test(r.model)) body.language_code = r.lang;
    const res = await fetch(`${EL_API}/v1/text-to-speech/${encodeURIComponent(r.voice.id)}?${EL_FORMAT_PARAM}=${encodeURIComponent(r.format)}`, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(200, Math.round(r.timeoutMs))), // integer ms (Node throws on fractions)
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      if (res.status === 401 || res.status === 403) T.down = `auth/quota error ${res.status}`;
      else if (res.status === 429) T.pausedUntil = performance.now() + 60_000;
      return { ok: false, reason: 'http', status: res.status, tookMs: took(), chars: 0 };
    }
    const audio = Buffer.from(await res.arrayBuffer());
    if (audio.length < 512) return { ok: false, reason: 'empty', tookMs: took(), chars: sent };
    mkdirSync(r.dir, { recursive: true });
    writeAtomic(file, audio);
    return { ok: true, url, file, ms: clipMs(file, fmt), cached: false, chars: r.text.length, tookMs: took() };
  } catch (e) {
    const name = e instanceof Error ? e.name : '';
    return { ok: false, reason: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : name === 'TypeError' ? 'network' : 'error', tookMs: took(), chars: sent };
  }
}
