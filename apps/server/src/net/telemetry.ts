// Owner: track ① Net (v1.1 telemetry). Client performance + error + socket-drop reports, so a laggy host or a
// mysterious disconnect is diagnosable from logs/server.log afterwards.
//   'net.telemetry' (each client every ~10 s): fps, frame ms p50/p95, long frames (>100 ms), GPU ms, preset, internal
//     resolution, DPR, backend, RTT, hidden, heap MB (+ new client errors, + the close code of its last socket drop)
//   -> ONE compact line per player per 30 s ('[telemetry] ...'); errors and drops get their own (rate-limited) lines.
//   'net.perf' (host only: admin token, or any player in dev): the latest report of every player in the crew.
// Server side, every game socket's close code/reason is logged too (core only logs 'disconnected').
// Never logs secrets: only the player name, numbers and sanitised short strings.
// Request names are typed in messages/net.ts; registered through a loose cast (the handlers validate args).
import type { WebSocket } from 'ws';
import type { Crew, ServerContext, ServerPlayer } from '../core/types.ts';
import type { CrewCore } from '../core/crews.ts';

/** what a client sends ('net.telemetry' args); every field optional and validated */
export interface TelemetryReport {
  fps: number;
  p50: number;
  p95: number;
  long: number;
  gpuMs: number | null;
  preset: string;
  res: [number, number];
  dpr: number;
  scale: number;
  backend: string;
  rtt: number;
  hidden: boolean;
  heapMB: number | null;
  /** screen name ('none' = in game) */
  screen: string;
  phase: string;
}

export interface TelemetryEntry { id: string; name: string; at: number; report: TelemetryReport }

type LooseReq = (name: string, h: (crew: Crew, player: ServerPlayer, args: unknown) => unknown) => void;

const LOG_EVERY_MS = 30_000;
const CLOSE_NAMES: Record<number, string> = {
  1000: 'normal', 1001: 'going away (tab closed / reload / navigation)', 1005: 'no status', 1006: 'abnormal (no close frame: network drop, crash, tunnel)',
  1009: 'message too big', 1011: 'server error', 4000: 'server err', 4002: 'no hello', 4003: 'crew closed', 4004: 'kicked', 4005: 'replaced by a newer tab',
  4100: 'deliberate leave', 4999: 'test drop',
};

const num = (v: unknown, d: number, lo = -1e9, hi = 1e9): number => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
/** short printable text without anything token-like (hex/base64 runs, admin=, resume=) */
export function cleanText(v: unknown, max: number): string {
  return String(v ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/(admin|resume|token|key)=[^&\s'"]+/gi, '$1=<redacted>')
    .replace(/[A-Za-z0-9_-]{24,}/g, '<redacted>')
    .slice(0, max)
    .trim();
}

function parseReport(a: Record<string, unknown>): TelemetryReport {
  const res = Array.isArray(a.res) ? a.res : [];
  return {
    fps: num(a.fps, 0, 0, 1000),
    p50: num(a.p50, 0, 0, 60_000),
    p95: num(a.p95, 0, 0, 60_000),
    long: Math.round(num(a.long, 0, 0, 100_000)),
    gpuMs: typeof a.gpuMs === 'number' && Number.isFinite(a.gpuMs) ? num(a.gpuMs, 0, 0, 10_000) : null,
    preset: cleanText(a.preset, 12).replace(/[^a-z0-9-]/gi, '') || '?',
    res: [Math.round(num(res[0], 0, 0, 20_000)), Math.round(num(res[1], 0, 0, 20_000))],
    dpr: num(a.dpr, 1, 0, 8),
    scale: num(a.scale, 1, 0, 4),
    backend: a.backend === 'webgl2' ? 'webgl2' : a.backend === 'webgpu' ? 'webgpu' : '?',
    rtt: Math.round(num(a.rtt, 0, 0, 120_000)),
    hidden: !!a.hidden,
    heapMB: typeof a.heapMB === 'number' && Number.isFinite(a.heapMB) ? Math.round(num(a.heapMB, 0, 0, 1e6)) : null,
    screen: cleanText(a.screen, 16).replace(/[^a-z0-9_-]/gi, '') || '?',
    phase: cleanText(a.phase, 12).replace(/[^a-z]/gi, '') || '?',
  };
}

export function formatReport(name: string, r: TelemetryReport): string {
  const gpu = r.gpuMs === null ? 'gpu -' : `gpu ${r.gpuMs.toFixed(1)}ms`;
  return `${name}: ${r.fps.toFixed(0)}fps p50 ${r.p50.toFixed(1)} p95 ${r.p95.toFixed(1)}ms long ${r.long} ${gpu} | ${r.preset} ${r.res[0]}x${r.res[1]} dpr ${r.dpr.toFixed(2)} pr ${r.scale.toFixed(2)} ${r.backend} | rtt ${r.rtt}ms${r.hidden ? ' HIDDEN' : ''}${r.heapMB !== null ? ` heap ${r.heapMB}MB` : ''} | ${r.phase}/${r.screen}`;
}

export function installTelemetry(ctx: ServerContext): { latest(crew: Crew): TelemetryEntry[] } {
  const log = ctx.log('telemetry');
  const reg = ctx.registerReq as unknown as LooseReq;
  const latest = new Map<string, TelemetryEntry>();
  const lastLog = new Map<string, number>();
  const errLog = new Map<string, { at: number; n: number }>();
  const watched = new WeakSet<WebSocket>();
  const lastMsg = new WeakMap<WebSocket, number>();
  const openedAt = new WeakMap<WebSocket, number>();

  // ---- server view of every socket close (code + reason + how long it was quiet before)
  ctx.hooks.join.push(function telemetryJoin(crew, player) {
    const ws = player.socket;
    if (!ws || watched.has(ws)) return;
    watched.add(ws);
    openedAt.set(ws, performance.now());
    lastMsg.set(ws, performance.now());
    ws.on('message', () => { lastMsg.set(ws, performance.now()); });
    ws.once('close', (code: number, reason: Buffer) => {
      const now = performance.now();
      const quiet = (now - (lastMsg.get(ws) ?? now)) / 1000;
      const open = (now - (openedAt.get(ws) ?? now)) / 1000;
      const why = cleanText(reason?.toString?.() ?? '', 80);
      log.info(`${player.name} socket closed: code ${code} ${CLOSE_NAMES[code] ?? ''}${why ? ` '${why}'` : ''} after ${open.toFixed(0)} s open, last msg ${quiet.toFixed(1)} s before, crew ${crew.code} phase ${crew.phase}`);
    });
  });

  reg('net.telemetry', (crew, player, args) => {
    const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
    const now = performance.now();
    if (a.perf && typeof a.perf === 'object') {
      const report = parseReport(a.perf as Record<string, unknown>);
      latest.set(player.id, { id: player.id, name: player.name, at: Date.now(), report });
      if (now - (lastLog.get(player.id) ?? -Infinity) >= LOG_EVERY_MS) {
        lastLog.set(player.id, now);
        log.info(formatReport(player.name, report));
      }
    }
    // the client's view of its last socket drop (sent after it reconnected)
    if (a.drop && typeof a.drop === 'object') {
      const d = a.drop as Record<string, unknown>;
      const code = Math.round(num(d.code, 0, 0, 9999));
      log.info(`${player.name} socket drop (client view): code ${code} ${CLOSE_NAMES[code] ?? ''}${d.reason ? ` '${cleanText(d.reason, 80)}'` : ''} clean=${d.wasClean ? 'yes' : 'no'} after ${num(d.openSec, 0, 0, 1e7).toFixed(0)} s open, tab ${d.hidden ? 'HIDDEN' : 'visible'}, online=${d.online === false ? 'NO' : 'yes'}, back after ${num(d.downSec, 0, 0, 1e7).toFixed(1)} s${d.lastFrameAgoMs !== undefined ? `, last frame ${Math.round(num(d.lastFrameAgoMs, 0, 0, 1e9))} ms before` : ''}`);
    }
    // unhandled client errors (a few per report, rate-limited per player)
    if (Array.isArray(a.errors) && a.errors.length) {
      const e = errLog.get(player.id) ?? { at: now, n: 0 };
      if (now - e.at > 60_000) { e.at = now; e.n = 0; }
      for (const msg of a.errors.slice(0, 3)) {
        if (e.n >= 6) break;
        e.n++;
        log.warn(`${player.name} client error: ${cleanText(msg, 300)}`);
      }
      errLog.set(player.id, e);
    }
    return { ok: true };
  });

  const view = (crew: Crew): TelemetryEntry[] => [...crew.players.values()].map((p) => latest.get(p.id)).filter((x): x is TelemetryEntry => !!x);
  reg('net.perf', (crew, player) => {
    const admin = (ctx.crews as Partial<CrewCore>).isAdmin?.(player.id) === true;
    if (!admin && !ctx.env.dev) throw new Error('host only');
    return { players: view(crew) };
  });
  ctx.registerDbg('net.perf', (crew) => ({ players: view(crew) }));
  ctx.hooks.leave.push(function telemetryLeave(_crew, player, info) {
    if (info.final) { latest.delete(player.id); lastLog.delete(player.id); errLog.delete(player.id); }
  });
  return { latest: view };
}
