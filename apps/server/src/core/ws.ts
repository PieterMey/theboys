// WebSocket endpoint on /ws: binary frames only, byte 0 = FRAME kind. Dispatches hello/pose/loud/req/sig/ping
// and voice chunks; pings every NET.pingMs (self-rescheduling setTimeout, never setInterval).
import type { Server as HttpServer, IncomingMessage, ServerResponse } from 'node:http';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { FRAME, decodeMsg, decodeVoiceChunk, encodeMsg } from '@dead-air/shared/envelope.ts';
import type { ClientMsg } from '@dead-air/shared/envelope.ts';
import { BAND, NET } from '@dead-air/shared/constants.ts';
import type { ServerContext, PlayerPose, PoseMsg } from './types.ts';
import type { Internals } from './context.ts';
import type { Conn, CrewCore } from './crews.ts';
import { LEAVE_CLOSE_CODE } from './crews.ts';
import { rateLimited } from './log.ts';

const fin = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);

// ---- v1.3 P8: protocol-level ping RTT per socket. A WebSocket ping is answered by the browser's network stack (not
// the page's main thread), so it is network time; the app-level 'ping' op waits for the page's frame. Every RTT_PING_MS
// each joined socket gets a ping carrying its send time; one '[ws] ping rtt' line per crew per RTT_LOG_MS (player ids
// only, never names). core/diag.ts puts the same numbers next to the client's app RTT.
const RTT_PING_MS = 5000;
const RTT_LOG_MS = 60_000;
const RTT_KEEP = 12;
/** a socket's ping round trips over the last minute (null before the first pong) */
export interface PingRtt { p50: number; max: number; n: number }
const rttSamples = new WeakMap<WebSocket, { ms: number; at: number }[]>();

function noteRtt(ws: WebSocket, ms: number): void {
  let s = rttSamples.get(ws);
  if (!s) rttSamples.set(ws, (s = []));
  s.push({ ms, at: performance.now() });
  if (s.length > RTT_KEEP) s.shift();
}

/** ping round trips of this socket in the last `windowMs` (default one minute) */
export function pingRttOf(ws: WebSocket | null | undefined, windowMs = RTT_LOG_MS): PingRtt | null {
  const s = ws ? rttSamples.get(ws) : undefined;
  if (!s) return null;
  const since = performance.now() - windowMs;
  const ms = s.filter((x) => x.at >= since).map((x) => x.ms).sort((a, b) => a - b);
  if (!ms.length) return null;
  return { p50: Math.round(ms[ms.length >> 1]), max: Math.round(ms[ms.length - 1]), n: ms.length };
}

// ---- additive (track ① Net): tiny GET/HEAD route table for JSON APIs (e.g. /api/invite), checked before
// the static/Vite handlers. Register at track install time (before the server listens).
export type HttpRoute = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
const httpRoutes = new Map<string, HttpRoute>();
export function registerHttpRoute(path: string, handler: HttpRoute): void {
  httpRoutes.set(path, handler);
}

function attachRoutes(http: HttpServer, warn: (key: string, ...a: unknown[]) => void): void {
  const prev = http.listeners('request') as ((req: IncomingMessage, res: ServerResponse) => void)[];
  http.removeAllListeners('request');
  http.on('request', (req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? '/').split('?')[0].split('#')[0];
    const route = (req.method === 'GET' || req.method === 'HEAD') ? httpRoutes.get(path) : undefined;
    if (route) {
      Promise.resolve()
        .then(() => route(req, res))
        .catch((e: unknown) => {
          warn(`route ${path} threw`, e instanceof Error ? e.message : e);
          if (!res.headersSent) { res.statusCode = 500; res.end('error'); }
        });
      return;
    }
    for (const l of prev) l.call(http, req, res);
  });
}

export function attachWs(http: HttpServer, ctx: ServerContext, internals: Internals, crews: CrewCore): { close(): void } {
  const log = ctx.log('ws');
  const warn = rateLimited(log);
  const wss = new WebSocketServer({ noServer: true, maxPayload: NET.maxPayload, perMessageDeflate: false });
  const conns = new Map<WebSocket, Conn>();
  attachRoutes(http, warn);

  http.on('upgrade', (req, socket, head) => {
    const path = (req.url ?? '').split('?')[0];
    if (path === '/ws') wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    else if (!ctx.env.dev) socket.destroy(); // dev: Vite's HMR listener handles its own upgrades
  });

  const handlePose = (conn: Conn, m: PoseMsg) => {
    const { crew, player } = conn;
    if (!crew || !player || !Array.isArray(m.p)) return;
    const pose: PlayerPose = {
      seq: fin(m.seq) | 0,
      p: [fin(m.p[0]), fin(m.p[1]), fin(m.p[2])],
      yaw: fin(m.yaw),
      pitch: fin(m.pitch),
      stance: fin(m.stance) | 0,
      anim: fin(m.anim) | 0,
      light: m.light ? 1 : 0,
    };
    for (const h of ctx.hooks.pose) {
      try {
        if (h(crew, player, pose) === false) return;
      } catch (e) {
        warn('hook pose threw', e instanceof Error ? e.message : e);
      }
    }
    player.pose = pose;
    player.poseAt = performance.now();
  };

  const handleReq = async (conn: Conn, id: number, r: string, a: unknown) => {
    const { crew, player } = conn;
    if (!crew || !player) return;
    const h = internals.reqs.get(r);
    if (!h) {
      ctx.send(player, { op: 'rep', id, ok: false, err: `unknown request ${r}` });
      return;
    }
    try {
      const d = await h(crew, player, a);
      ctx.send(player, d === undefined ? { op: 'rep', id, ok: true } : { op: 'rep', id, ok: true, d });
    } catch (e) {
      ctx.send(player, { op: 'rep', id, ok: false, err: e instanceof Error ? e.message : String(e) });
    }
  };

  const handleMsg = (conn: Conn, m: ClientMsg) => {
    if (m.op === 'hello') return crews.handleHello(conn, m);
    if (m.op === 'ping') {
      conn.ws.send(encodeMsg({ op: 'pong', c: m.c, s: ctx.now() }));
      return;
    }
    const { crew, player } = conn;
    if (!crew || !player) return; // nothing but hello/ping before Welcome
    switch (m.op) {
      case 'pose':
        return handlePose(conn, m);
      case 'loud': {
        const prev = player.band;
        player.band = Math.max(BAND.silent, Math.min(BAND.scream, fin(m.band) | 0));
        player.radio = m.radio ? 1 : 0;
        for (const h of ctx.hooks.loud) {
          try { h(crew, player, prev); } catch (e) { warn('hook loud threw', e instanceof Error ? e.message : e); }
        }
        return;
      }
      case 'req':
        void handleReq(conn, fin(m.id), String(m.r), m.a);
        return;
      case 'sig':
        if (typeof m.to === 'string') ctx.sendSig(crew, player.id, m.to, m.d);
        return;
    }
  };

  wss.on('connection', (ws: WebSocket) => {
    const conn: Conn = { ws, isAlive: true, crew: null, player: null };
    conns.set(ws, conn);
    const helloTimer = setTimeout(() => { if (!conn.player) ws.close(4002, 'no hello'); }, 10_000);
    ws.on('pong', (data: Buffer) => {
      conn.isAlive = true;
      // our pings carry their send time (8 bytes); a pong echoes it (RFC 6455)
      if (data?.length === 8) {
        const ms = performance.now() - data.readDoubleLE(0);
        if (ms >= 0 && ms < 120_000) noteRtt(ws, ms);
      }
    });
    ws.on('message', (data, isBinary) => {
      conn.isAlive = true;
      if (!isBinary || !(data instanceof Uint8Array) || data.length < 1) return;
      try {
        if (data[0] === FRAME.msg) handleMsg(conn, decodeMsg<ClientMsg>(data));
        else if (data[0] === FRAME.voiceChunk && conn.crew && conn.player) {
          const { h, pcm } = decodeVoiceChunk(data);
          for (const fn of internals.voice) {
            try { fn(conn.crew, conn.player, h, pcm); } catch (e) { warn('voice handler threw', e instanceof Error ? e.message : e); }
          }
        }
      } catch (e) {
        warn('bad frame', e instanceof Error ? e.message : e);
      }
    });
    ws.on('close', (code: number) => {
      clearTimeout(helloTimer);
      conns.delete(ws);
      crews.handleClose(conn, code === LEAVE_CLOSE_CODE);
    });
    ws.on('error', (e) => warn('socket error', e.message));
  });

  /** a ping that carries its send time (performance.now(), float64) for the RTT */
  const stamped = (): Buffer => {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(performance.now(), 0);
    return b;
  };
  let pingTimer: NodeJS.Timeout | null = null;
  const pingAll = () => {
    for (const [ws, conn] of conns) {
      if (!conn.isAlive) { ws.terminate(); continue; }
      conn.isAlive = false;
      try { ws.ping(stamped()); } catch { /* closing */ }
    }
    pingTimer = setTimeout(pingAll, NET.pingMs);
  };
  pingTimer = setTimeout(pingAll, NET.pingMs);

  // v1.3 P8: RTT pings between the liveness pings (a pong also counts as alive, as before)
  let rttTimer: NodeJS.Timeout | null = null;
  let lastRttLog = performance.now();
  const logRtt = () => {
    for (const crew of ctx.crews.list()) {
      const parts: string[] = [];
      for (const p of crew.players.values()) {
        const r = p.connected ? pingRttOf(p.socket) : null;
        if (r) parts.push(`${p.id} ${r.p50}/${r.max} ms (n ${r.n})`);
      }
      if (parts.length) log.info(`ping rtt crew ${crew.code} (p50/max): ${parts.join(', ')}`);
    }
  };
  const rttPing = () => {
    for (const [ws, conn] of conns) {
      if (!conn.player || ws.readyState !== 1) continue;
      try { ws.ping(stamped()); } catch { /* closing */ }
    }
    if (performance.now() - lastRttLog >= RTT_LOG_MS) {
      lastRttLog = performance.now();
      try { logRtt(); } catch (e) { warn('rtt log failed', e instanceof Error ? e.message : e); }
    }
    rttTimer = setTimeout(rttPing, RTT_PING_MS);
  };
  rttTimer = setTimeout(rttPing, RTT_PING_MS);

  return {
    close() {
      if (pingTimer) clearTimeout(pingTimer);
      if (rttTimer) clearTimeout(rttTimer);
      for (const ws of conns.keys()) ws.terminate();
      wss.close();
    },
  };
}
