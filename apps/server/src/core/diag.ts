// v1.3 telemetry v2 (P5, integrator): the 'core.diag' request. Clients report; the server writes one compact line,
// WITHOUT names (the player id only; the join line in [crews] maps an id to a name for the host).
//  - join: GPU vendor + tier bucket (never the renderer string), backend + the WebGPU fallback reason, browser brand +
//    major version, OS, desktop app or browser, cores, device memory, KHR_parallel_shader_compile, the preset and where
//    it came from (url / stored / auto / safe mode). Logged for a player's first report, then only for a changed preset
//    or backend (or the same again after 10 min), at most one per 5 s and 10 per 10 min (createJoinLimiter): a modified
//    client cannot write a line per request
//  - window (~30 s): largest rAF gap, hidden time, Long Animation Frames (count, blocked ms, longest, top script),
//    pipelines and node builds created, draw calls, the app RTT next to the protocol ping RTT (core/ws.ts), skipped
//    voice chunks, and the last drive preload's timings once it finished
// Every field is checked against a closed set or clamped; the only free text (the LoAF top script) is cut to a short
// [A-Za-z0-9_.:@#/-] token with long runs redacted. Rate-limited per player; answers { ok } only. net/telemetry.ts
// (track ① Net, frozen this round) is untouched: this is a separate, integrator-owned request.
import type { CoreDiagJoin, CoreDiagWindow } from '@dead-air/shared/messages/index.ts';
import type { ServerContext, ServerPlayer } from './types.ts';
import { pingRttOf } from './ws.ts';
import type { PingRtt } from './ws.ts';

const VENDORS = ['nvidia', 'amd', 'intel', 'apple', 'qualcomm', 'arm', 'imagination', 'microsoft', 'google', 'mesa', 'other', 'unknown'] as const;
const TIERS = ['high', 'mid', 'low', 'igpu', 'software', 'unknown'] as const;
const FALLBACKS = ['', 'forced', 'no-api', 'no-adapter', 'device-error', 'init-error', 'unknown'] as const;
const OSES = ['windows', 'mac', 'linux', 'android', 'ios', 'chromeos', 'other'] as const;
const SOURCES = ['url', 'stored', 'auto', 'safe'] as const;
const PHASES = ['hub', 'drive', 'contract', 'results'] as const;
/** a join line repeats at most this often per player when its preset and backend did not change */
const JOIN_REPEAT_MS = 10 * 60_000;
/** join lines at most this often per player (a change inside the gap is dropped: the next window line shows the preset) */
const JOIN_MIN_MS = 5_000;
/** join lines at most this many per player per JOIN_REPEAT_MS */
const JOIN_BUDGET = 10;
/** window lines at most this often per player */
const WINDOW_MIN_MS = 20_000;

/** Per-player join-line limits (pure; `now` = performance.now()). */
export interface JoinLimiter {
  /** true = write this player's join line now. `change` = what makes a later line news (backend + preset). */
  allow(id: string, change: string, now: number): boolean;
  /** forget players whose last line is older than JOIN_REPEAT_MS (their limits have lapsed) */
  prune(now: number): void;
  readonly size: number;
}

/**
 * The first join line of a player is written. After that only a new backend / preset is (cores, memory, GPU or
 * browser do not change within a session; a client that says they do is noise), or the same again once
 * JOIN_REPEAT_MS passed; never two within JOIN_MIN_MS, never more than JOIN_BUDGET within JOIN_REPEAT_MS.
 */
export function createJoinLimiter(): JoinLimiter {
  const st = new Map<string, { change: string; at: number; times: number[] }>();
  return {
    allow(id, change, now) {
      const prev = st.get(id);
      if (!prev) {
        st.set(id, { change, at: now, times: [now] });
        return true;
      }
      if (change === prev.change && now - prev.at < JOIN_REPEAT_MS) return false;
      if (now - prev.at < JOIN_MIN_MS) return false;
      prev.times = prev.times.filter((t) => now - t < JOIN_REPEAT_MS);
      if (prev.times.length >= JOIN_BUDGET) return false;
      prev.times.push(now);
      prev.change = change;
      prev.at = now;
      return true;
    },
    prune(now) {
      for (const [id, s] of st) if (now - s.at >= JOIN_REPEAT_MS) st.delete(id);
    },
    get size() { return st.size; },
  };
}

const pick = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : d);
const num = (v: unknown, lo: number, hi: number): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : null);
const int = (v: unknown, lo: number, hi: number, d = 0): number => Math.round(num(v, lo, hi) ?? d);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
/** a short safe token: no spaces beyond single ones, no long id-like runs */
export function diagToken(v: unknown, max: number): string {
  return String(v ?? '')
    .replace(/[^A-Za-z0-9_.:@#/ -]+/g, '')
    .replace(/[A-Za-z0-9_-]{28,}/g, '<redacted>')
    .replace(/\s+/g, ' ')
    .slice(0, max)
    .trim();
}

/** a validated join report (anything unknown -> 'unknown' / '?' / null) */
export function parseDiagJoin(a: Record<string, unknown>): CoreDiagJoin {
  const browser = typeof a.browser === 'string' && /^[a-z]{2,12} \d{1,4}$/.test(a.browser) ? a.browser : '?';
  const preset = typeof a.preset === 'string' && /^[a-z0-9-]{1,12}$/.test(a.preset) ? a.preset : '?';
  return {
    kind: 'join',
    why: pick(a.why, ['join', 'preset', 'backend'] as const, 'join'),
    gpuVendor: pick(a.gpuVendor, VENDORS, 'unknown'),
    gpuTier: pick(a.gpuTier, TIERS, 'unknown'),
    backend: pick(a.backend, ['webgpu', 'webgl2', 'none'] as const, 'none'),
    fallback: pick(a.fallback, FALLBACKS, 'unknown'),
    browser,
    os: pick(a.os, OSES, 'other'),
    shell: pick(a.shell, ['desktop', 'browser'] as const, 'browser'),
    cores: num(a.cores, 1, 256),
    memGB: num(a.memGB, 0.1, 1024),
    parallel: bool(a.parallel),
    preset,
    presetSource: pick(a.presetSource, SOURCES, 'auto'),
  };
}

/** a validated window report */
export function parseDiagWindow(a: Record<string, unknown>): CoreDiagWindow {
  const loaf = a.loaf && typeof a.loaf === 'object' ? (a.loaf as Record<string, unknown>) : null;
  const pipes = a.pipes && typeof a.pipes === 'object' ? (a.pipes as Record<string, unknown>) : null;
  const draws = a.draws && typeof a.draws === 'object' ? (a.draws as Record<string, unknown>) : null;
  const pre = a.preload && typeof a.preload === 'object' ? (a.preload as Record<string, unknown>) : null;
  const ms = (v: unknown) => int(v, -1, 600_000, -1);
  return {
    kind: 'window',
    sec: int(a.sec, 0, 3600),
    frames: int(a.frames, 0, 1_000_000),
    gapMax: int(a.gapMax, 0, 3_600_000),
    hiddenMs: int(a.hiddenMs, 0, 3_600_000),
    loaf: loaf ? { n: int(loaf.n, 0, 100_000), blockMs: int(loaf.blockMs, 0, 3_600_000), maxMs: int(loaf.maxMs, 0, 3_600_000), top: diagToken(loaf.top, 80) } : null,
    pipes: pipes ? { total: int(pipes.total, 0, 1e6), created: int(pipes.created, 0, 1e6), nodes: int(pipes.nodes, 0, 1e6), nodesNew: int(pipes.nodesNew, 0, 1e6) } : null,
    draws: draws ? { p50: int(draws.p50, 0, 1e6), max: int(draws.max, 0, 1e6) } : null,
    rtt: int(a.rtt, 0, 120_000),
    voiceSkipped: int(a.voiceSkipped, 0, 1e7),
    preset: typeof a.preset === 'string' && /^[a-z0-9-]{1,12}$/.test(a.preset) ? a.preset : '?',
    phase: pick(a.phase, PHASES, 'hub'),
    preload: pre ? { asked: ms(pre.asked), reply: ms(pre.reply), built: ms(pre.built), done: ms(pre.done), ok: pre.ok === true, early: pre.early === true } : null,
  };
}

export function formatDiagJoin(id: string, j: CoreDiagJoin): string {
  const fb = j.backend === 'webgpu' ? '' : ` (no webgpu: ${j.fallback || 'unknown'})`;
  const par = j.parallel === null ? '-' : j.parallel ? 'yes' : 'no';
  return `${id} ${j.why}: gpu ${j.gpuVendor}/${j.gpuTier} ${j.backend}${fb} | ${j.browser} ${j.os} ${j.shell} | cores ${j.cores ?? '?'} mem ${j.memGB ?? '?'} GB | parallel-compile ${par} | preset ${j.preset} (${j.presetSource})`;
}

export function formatDiagWindow(id: string, w: CoreDiagWindow, ws: PingRtt | null): string {
  const loaf = w.loaf ? `loaf ${w.loaf.n} blocked ${w.loaf.blockMs} ms max ${w.loaf.maxMs} ms${w.loaf.top ? ` top ${w.loaf.top}` : ''}` : 'loaf -';
  const pipes = w.pipes ? `pipes +${w.pipes.created} (=${w.pipes.total}) nodes +${w.pipes.nodesNew} (=${w.pipes.nodes})` : 'pipes -';
  const draws = w.draws ? `draws ${w.draws.p50}/${w.draws.max}` : 'draws -';
  const rtt = `rtt app ${w.rtt} ws ${ws ? `${ws.p50}/${ws.max}` : '-'} ms`;
  const p = w.preload;
  const pre = p ? ` | preload ${p.early ? 'early' : 'late'} ask ${p.asked} reply ${p.reply} build ${p.built} done ${p.done} ms${p.ok ? '' : ' (partial)'}` : '';
  return `${id} ${w.sec}s ${w.phase}/${w.preset}: frames ${w.frames} gapMax ${w.gapMax} ms${w.hiddenMs ? ` hidden ${w.hiddenMs} ms` : ''} | ${loaf} | ${pipes} | ${draws} | ${rtt} | voice skipped ${w.voiceSkipped}${pre}`;
}

export function installCoreDiag(ctx: ServerContext): void {
  const log = ctx.log('diag');
  const joins = createJoinLimiter();
  const lastWindow = new Map<string, number>();
  const handle = (player: ServerPlayer, args: unknown): { ok: boolean } => {
    const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
    const now = performance.now();
    if (a.kind === 'join') {
      const j = parseDiagJoin(a);
      if (joins.allow(player.id, `${j.backend}/${j.preset}`, now)) log.info(formatDiagJoin(player.id, j));
      return { ok: true };
    }
    if (a.kind === 'window') {
      if (now - (lastWindow.get(player.id) ?? -Infinity) < WINDOW_MIN_MS) return { ok: false };
      lastWindow.set(player.id, now);
      log.info(formatDiagWindow(player.id, parseDiagWindow(a), pingRttOf(player.socket, Math.max(30_000, int(a.sec, 0, 3600) * 1000))));
      return { ok: true };
    }
    return { ok: false };
  };
  ctx.registerReq('core.diag', (_crew, player, args) => handle(player, args));
  // a player removed for good keeps its limits until they lapse (a leave + rejoin loop cannot reset them); every final
  // leave drops the lapsed state of everyone
  ctx.hooks.leave.push(function diagLeave(_crew, _player, info) {
    if (!info.final) return;
    const now = performance.now();
    joins.prune(now);
    for (const [id, at] of lastWindow) if (now - at >= WINDOW_MIN_MS) lastWindow.delete(id);
  });
}
