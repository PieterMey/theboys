// Owner: track ④ Voice (apps/server/src/voice/**). Server side of the voice mesh:
//  - ICE servers for the WebRTC mesh: Cloudflare TURN credentials (env CF_TURN_KEY_ID + CF_TURN_API_TOKEN), cached
//    ~12 h, port-53 URLs dropped, stun:stun.cloudflare.com:3478 always included. Delivered in Welcome (msg.iceServers)
//    and via the 'voice.ice' request. NEVER log the token or the minted credentials.
//  - 'voice.consent' request (transcription consent, PLAN §4.12).
//  - dev-only test helpers: dbg.voice.pin (pin a player's pose; client poses are ignored while pinned).
// Signalling itself is relayed by core (client 'sig' -> ctx.sendSig).
import type { RTCIceServerLike } from '@dead-air/shared/envelope.ts';
import type { PlayerPose, ServerContext } from '../core/types.ts';

const STUN_FALLBACK: RTCIceServerLike = { urls: ['stun:stun.cloudflare.com:3478'] };
const CF_URL = (keyId: string) => `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`;
/** port 53 exactly (browsers block it); keeps :5349 */
const PORT53 = /:53(?![0-9])/;

interface IceCache { servers: RTCIceServerLike[]; relay: boolean; at: number }

interface VoiceSlice {
  pin?: { x: number; y: number; z: number; yaw: number };
  /** STT chunk stream stats (debug; the ai track consumes the chunks via its own ctx.onVoiceChunk) */
  chunks?: { segs: number; chunks: number; samples: number; open: boolean; lastSeg: number; lastMaxBand: number; badSeq: number; lastSeq: number };
}

export function sanitizeServers(list: unknown): RTCIceServerLike[] {
  const out: RTCIceServerLike[] = [];
  if (!Array.isArray(list)) return out;
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    const o = s as { urls?: unknown; username?: unknown; credential?: unknown };
    const urls = (Array.isArray(o.urls) ? o.urls : [o.urls]).filter((u): u is string => typeof u === 'string' && !PORT53.test(u));
    if (!urls.length) continue;
    const e: RTCIceServerLike = { urls };
    if (typeof o.username === 'string') e.username = o.username;
    if (typeof o.credential === 'string') e.credential = o.credential;
    out.push(e);
  }
  return out;
}

export function withFallback(list: RTCIceServerLike[]): RTCIceServerLike[] {
  const has = list.some((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]).includes('stun:stun.cloudflare.com:3478'));
  return has ? list : [STUN_FALLBACK, ...list];
}

export function install(ctx: ServerContext): void {
  const log = ctx.log('voice');
  const vb = () => (ctx.balance.voice ?? {}) as Record<string, unknown>;
  const cacheMs = () => Number(vb().turnCacheHours ?? 12) * 3600_000;
  let cache: IceCache | null = null;
  let inflight: Promise<IceCache> | null = null;
  let warned = false;

  const fetchIce = async (): Promise<IceCache> => {
    const keyId = process.env.CF_TURN_KEY_ID;
    const token = process.env.CF_TURN_API_TOKEN;
    if (!keyId || !token) {
      if (!warned) {
        warned = true;
        log.warn('CF_TURN_KEY_ID / CF_TURN_API_TOKEN not set: voice uses STUN only (about 1 in 5 friend pairs may fail to connect)');
      }
      return { servers: [STUN_FALLBACK], relay: false, at: performance.now() };
    }
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 6000);
      const res = await fetch(CF_URL(keyId), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 86400 }),
        signal: ac.signal,
      }).finally(() => clearTimeout(timer));
      if (res.status !== 201 && res.status !== 200) {
        log.warn(`TURN credential request failed: HTTP ${res.status}; falling back to STUN`);
        return { servers: [STUN_FALLBACK], relay: false, at: performance.now() - cacheMs() + 60_000 }; // retry in ~1 min
      }
      const body = (await res.json()) as { iceServers?: unknown };
      const servers = withFallback(sanitizeServers(body.iceServers));
      const relay = servers.some((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]).some((u) => u.startsWith('turn')));
      log.info(`TURN credentials minted (${servers.length} ice server entries, relay=${relay})`);
      return { servers, relay, at: performance.now() };
    } catch (e) {
      log.warn(`TURN credential request error (${e instanceof Error ? e.name : 'error'}); falling back to STUN`);
      return { servers: [STUN_FALLBACK], relay: false, at: performance.now() - cacheMs() + 60_000 };
    }
  };

  const getIce = (): Promise<IceCache> => {
    if (cache && performance.now() - cache.at < cacheMs()) return Promise.resolve(cache);
    inflight ??= fetchIce().then((c) => {
      cache = c;
      inflight = null;
      return c;
    });
    return inflight;
  };
  // warm the cache at boot so the first Welcome already carries TURN
  void getIce();

  ctx.hooks.welcome.push((_crew, _player, msg) => {
    msg.iceServers = cache ? cache.servers : [STUN_FALLBACK];
    if (!cache || performance.now() - cache.at >= cacheMs()) void getIce();
  });

  ctx.registerReq('voice.ice', async () => {
    const c = await getIce();
    return { iceServers: c.servers, relay: c.relay };
  });

  ctx.registerReq('voice.consent', (crew, player, args) => {
    const t = !!(args && (args as { transcribe?: unknown }).transcribe);
    if (player.consent.transcribe !== t) {
      player.consent.transcribe = t;
      ctx.crews.broadcastRoster(crew);
    }
    return { transcribe: t };
  });

  // ---- dev-only test helpers ----
  const slice = (p: { slices: Record<string, unknown> }): VoiceSlice => (p.slices.voice ??= {}) as VoiceSlice;
  ctx.onVoiceChunk((_crew, player, h, pcm) => {
    const s = slice(player);
    const c = (s.chunks ??= { segs: 0, chunks: 0, samples: 0, open: false, lastSeg: -1, lastMaxBand: 0, badSeq: 0, lastSeq: -1 });
    if (h.start) { c.segs++; c.open = true; c.lastSeq = -1; }
    if (h.segId === c.lastSeg && h.seq !== c.lastSeq + 1 && !h.start) c.badSeq++;
    c.lastSeg = h.segId;
    c.lastSeq = h.seq;
    c.chunks++;
    c.samples += pcm.length;
    c.lastMaxBand = h.maxBand;
    if (h.end) c.open = false;
  });
  ctx.hooks.pose.push((_crew, player) => {
    if (slice(player).pin) return false; // pinned by a test: ignore client poses
  });
  // a resume (page reload) runs the players track's spawn: keep a test pin (voice installs after players)
  ctx.hooks.join.push((_crew, player) => {
    const pin = slice(player).pin;
    if (pin) player.pose = { ...player.pose, p: [pin.x, pin.y, pin.z], yaw: pin.yaw };
  });
  ctx.registerDbg('voice.pin', (crew, player, args) => {
    const a = (args ?? {}) as { id?: string; x?: number; y?: number; z?: number; yaw?: number; off?: boolean };
    const target = a.id ? crew.players.get(a.id) : player;
    if (!target) throw new Error('no such player');
    const s = slice(target);
    if (a.off) {
      delete s.pin;
      return { pinned: false };
    }
    const pin = { x: Number(a.x ?? 0), y: Number(a.y ?? 0), z: Number(a.z ?? 0), yaw: Number(a.yaw ?? 0) };
    s.pin = pin;
    const pose: PlayerPose = { ...target.pose, p: [pin.x, pin.y, pin.z], yaw: pin.yaw };
    target.pose = pose;
    target.poseAt = performance.now();
    return { pinned: true, pin };
  });
  ctx.registerDbg('voice.state', (crew) => ({
    ice: cache ? { relay: cache.relay, entries: cache.servers.length, ageSec: Math.round((performance.now() - cache.at) / 1000) } : null,
    players: [...crew.players.values()].map((p) => ({ id: p.id, name: p.name, band: p.band, radio: p.radio, alive: p.alive, consent: p.consent, pin: slice(p).pin ?? null, chunks: slice(p).chunks ?? null })),
  }));
}
