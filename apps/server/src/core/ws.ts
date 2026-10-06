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
    ws.on('pong', () => { conn.isAlive = true; });
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

  let pingTimer: NodeJS.Timeout | null = null;
  const pingAll = () => {
    for (const [ws, conn] of conns) {
      if (!conn.isAlive) { ws.terminate(); continue; }
      conn.isAlive = false;
      try { ws.ping(); } catch { /* closing */ }
    }
    pingTimer = setTimeout(pingAll, NET.pingMs);
  };
  pingTimer = setTimeout(pingAll, NET.pingMs);

  return {
    close() {
      if (pingTimer) clearTimeout(pingTimer);
      for (const ws of conns.keys()) ws.terminate();
      wss.close();
    },
  };
}
