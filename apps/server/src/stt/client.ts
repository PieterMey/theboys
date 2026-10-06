// Owner: track (e) speech. HTTP client for the faster-whisper sidecar (services/stt/server.py):
//   POST {STT_URL}/transcribe?langs=en,nl&hotwords=a,b,c   body: raw PCM16LE mono 16 kHz
//   GET  {STT_URL}/health
// Node's fetch keeps the connection alive (the sidecar speaks HTTP/1.1 keep-alive). Never logs transcripts.

export interface SttResult {
  text: string;
  lang: string | null;
  langProb?: number;
  avgLogprob?: number | null;
  durationMs?: number;
  speechMs?: number;
  ms?: number;
  queueMs?: number;
  dropped?: number;
}

export type SttOutcome = { ok: true; res: SttResult; ms: number } | { ok: false; reason: 'timeout' | 'busy' | 'http' | 'network' | 'parse'; status?: number; ms: number };

export async function transcribe(url: string, pcm: Uint8Array<ArrayBuffer>, langs: string, hotwords: string[], timeoutMs: number): Promise<SttOutcome> {
  const q = new URLSearchParams({ langs });
  if (hotwords.length) q.set('hotwords', hotwords.join(','));
  const t0 = performance.now();
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/transcribe?${q.toString()}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: pcm,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    const ms = performance.now() - t0;
    if (!res.ok) return { ok: false, reason: res.status === 503 ? 'busy' : 'http', status: res.status, ms };
    try {
      const j = JSON.parse(text) as SttResult;
      return { ok: true, res: { ...j, text: typeof j.text === 'string' ? j.text : '' }, ms };
    } catch {
      return { ok: false, reason: 'parse', ms };
    }
  } catch (e) {
    const ms = performance.now() - t0;
    return { ok: false, reason: e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'network', ms };
  }
}

export async function health(url: string, timeoutMs = 1500): Promise<{ ok: boolean; warm: boolean; device: string | null }> {
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { ok: false, warm: false, device: null };
    const j = (await res.json()) as { ok?: boolean; warm?: boolean; device?: string | null };
    return { ok: !!j.ok, warm: !!j.warm, device: j.device ?? null };
  } catch {
    return { ok: false, warm: false, device: null };
  }
}
