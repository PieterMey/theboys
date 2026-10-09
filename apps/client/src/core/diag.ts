// v1.3 telemetry v2 (P5, integrator): the client half of 'core.diag' (server: apps/server/src/core/diag.ts, logged
// there without names). Buckets only: the GPU renderer string never leaves the page (vendor + tier), and no names.
//  - join report on every welcome (the server drops repeats) and again when the preset changes: GPU vendor / tier,
//    backend + why WebGPU is not in use (forced / no API / no adapter / device error / init error), browser brand +
//    major, OS, desktop app or browser, cores, device memory, KHR_parallel_shader_compile, preset + its source
//  - window report every WINDOW_MS while joined: largest rAF gap (hidden time excluded), hidden ms, Long Animation
//    Frames (count, blocked ms, longest, its top script), pipelines / node builds created (three r186 renderer maps,
//    read-only), draw calls, app RTT, skipped voice chunks, and the last drive preload's timings once it finished
// Installed by apps/client/src/loading/index.ts next to the v1.1 telemetry. Never throws into the page.
import type { CoreDiagJoin, CoreDiagWindow } from '@dead-air/shared/messages/index.ts';
import type { ClientContext } from './context.ts';

const WINDOW_MS = 30_000;

/** GPU vendor + tier from a WebGL renderer string or WebGPU adapter info (never sent itself) */
export function gpuBucket(desc: string): { vendor: string; tier: string } {
  const n = String(desc ?? '').toUpperCase();
  if (!n.trim()) return { vendor: 'unknown', tier: 'unknown' };
  if (/SWIFTSHADER/.test(n)) return { vendor: 'google', tier: 'software' };
  if (/LLVMPIPE|SOFTPIPE|LAVAPIPE/.test(n)) return { vendor: 'mesa', tier: 'software' };
  if (/MICROSOFT BASIC|\bWARP\b|SOFTWARE ADAPTER/.test(n)) return { vendor: 'microsoft', tier: 'software' };
  if (/NVIDIA|GEFORCE|QUADRO|\bRTX\b|\bGTX\b|TESLA/.test(n)) {
    let tier = 'unknown';
    if (/RTX\s*(?:50|40)\d0|RTX\s*30[6-9]0|BLACKWELL|LOVELACE|AMPERE|RTX\s*PRO/.test(n)) tier = 'high';
    else if (/RTX\s*20\d0|RTX\s*30[05]0|GTX\s*16\d0|GTX\s*10[78]0|TURING|RTX\s*A\d{3,4}/.test(n)) tier = 'mid';
    else if (/GTX\s*10[35]0|GTX\s*10[56]0|GTX\s*9\d0|GTX\s*7\d0|\bMX\s*\d{3}|\bGT\s*\d{3,4}|PASCAL|MAXWELL|KEPLER/.test(n)) tier = 'low';
    return { vendor: 'nvidia', tier };
  }
  if (/\bAMD\b|RADEON|\bATI\b/.test(n)) {
    let tier = 'unknown';
    if (/\bRX\s*(?:9\d{3}|[67]\d{3})\b/.test(n)) tier = 'high';
    else if (/\bRX\s*5\d{3}\b|VEGA\s*(?:56|64)|RADEON VII/.test(n)) tier = 'mid';
    else if (/\bRX\s*[45]\d{2}\b|\bR[579]\s*\d{3}\b/.test(n)) tier = 'low';
    else if (/RADEON\(TM\)\s*GRAPHICS|RADEON GRAPHICS|VEGA\s*\d\b|\b[678]\d0M\b/.test(n)) tier = 'igpu';
    return { vendor: 'amd', tier };
  }
  if (/INTEL/.test(n)) return { vendor: 'intel', tier: /ARC\(TM\)\s*[AB]\d{3}|\bARC\s+[AB]\d{3}|XE2?-HPG|ALCHEMIST|BATTLEMAGE/.test(n) ? 'mid' : 'igpu' };
  if (/APPLE|\bM[1-9]\b/.test(n)) return { vendor: 'apple', tier: 'igpu' };
  if (/ADRENO|QUALCOMM/.test(n)) return { vendor: 'qualcomm', tier: 'igpu' };
  if (/MALI|\bARM\b/.test(n)) return { vendor: 'arm', tier: 'igpu' };
  if (/POWERVR|IMAGINATION/.test(n)) return { vendor: 'imagination', tier: 'igpu' };
  return { vendor: 'other', tier: 'unknown' };
}

type Brand = { brand: string; version: string };

/** browser brand + major version ('chrome 141', 'edge 140', 'firefox 143', 'safari 18', 'electron 44') */
export function browserOf(ua: string, brands?: readonly Brand[] | null): string {
  const s = String(ua ?? '');
  const electron = /Electron\/(\d+)/.exec(s);
  if (electron) return `electron ${electron[1]}`;
  const named: [string, string][] = [['Microsoft Edge', 'edge'], ['Opera', 'opera'], ['Brave', 'brave'], ['Vivaldi', 'vivaldi'], ['Google Chrome', 'chrome'], ['Chromium', 'chromium']];
  for (const [b, short] of named) {
    const hit = brands?.find((x) => x.brand === b);
    const v = hit ? parseInt(hit.version, 10) : NaN;
    if (Number.isFinite(v)) return `${short} ${v}`;
  }
  const re: [RegExp, string][] = [[/Edg\/(\d+)/, 'edge'], [/OPR\/(\d+)/, 'opera'], [/Firefox\/(\d+)/, 'firefox'], [/Chrome\/(\d+)/, 'chrome'], [/Version\/(\d+)[\d.]*.*Safari/, 'safari']];
  for (const [r, short] of re) {
    const m = r.exec(s);
    if (m) return `${short} ${m[1]}`;
  }
  return 'other 0';
}

/** coarse OS ('windows' | 'mac' | 'linux' | 'android' | 'ios' | 'chromeos' | 'other') */
export function osOf(ua: string, platform?: string | null): string {
  const p = String(platform ?? '').toLowerCase();
  if (p.includes('win')) return 'windows';
  if (p.includes('android')) return 'android';
  if (p.includes('chrome os') || p.includes('chromeos')) return 'chromeos';
  if (p.includes('mac')) return 'mac';
  if (p.includes('ios')) return 'ios';
  if (p.includes('linux')) return 'linux';
  const s = String(ua ?? '');
  if (/Windows/.test(s)) return 'windows';
  if (/Android/.test(s)) return 'android';
  if (/iPhone|iPad|iPod/.test(s)) return 'ios';
  if (/CrOS/.test(s)) return 'chromeos';
  if (/Mac OS X|Macintosh/.test(s)) return 'mac';
  if (/Linux/.test(s)) return 'linux';
  return 'other';
}

/**
 * The longest script of a Long Animation Frame as a short token: invoker type:invoker@file:function. A build chunk's
 * content hash is cut ('core-AbCd12_-.js' -> 'core.js'; vite.config.ts names the chunk with the frame loop 'core'), so
 * the token reads the same across deploys.
 */
export function loafTop(e: { scripts?: readonly { duration?: number; invokerType?: string; invoker?: string; sourceURL?: string; sourceFunctionName?: string }[] }): string {
  const s = [...(e.scripts ?? [])].sort((a, b) => (b.duration ?? 0) - (a.duration ?? 0))[0];
  if (!s) return 'no-script';
  const file = (String(s.sourceURL ?? '').split(/[?#]/)[0].split('/').pop() ?? '').replace(/-[A-Za-z0-9_-]{8}(\.m?js)$/, '$1');
  const out = `${s.invokerType ?? '?'}:${s.invoker ?? '?'}@${file}${s.sourceFunctionName ? `:${s.sourceFunctionName}` : ''}`;
  return out.replace(/[^A-Za-z0-9_.:@#/-]+/g, '').slice(0, 80);
}

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => Promise.race([p, new Promise<T>((_r, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

type GpuAdapterLike = { info?: { vendor?: string; architecture?: string; description?: string; isFallbackAdapter?: boolean }; requestDevice(): Promise<{ destroy?(): void }> };

/** why WebGPU is not in use on this page ('' when it is). Probes once (an adapter + a throwaway device) on WebGL2 only. */
async function webgpuFallback(backend: string, forced: boolean): Promise<string> {
  if (backend === 'webgpu') return '';
  if (forced) return 'forced';
  const gpu = (navigator as unknown as { gpu?: { requestAdapter(o?: unknown): Promise<GpuAdapterLike | null> } }).gpu;
  if (!gpu) return 'no-api';
  try {
    const adapter = await withTimeout(gpu.requestAdapter({ featureLevel: 'compatibility' }), 3000);
    if (!adapter) return 'no-adapter';
    try {
      const dev = await withTimeout(adapter.requestDevice(), 3000);
      try { dev?.destroy?.(); } catch { /* ignore */ }
      return 'init-error';
    } catch { return 'device-error'; }
  } catch { return 'unknown'; }
}

type RendererLike = {
  backend?: {
    gl?: WebGL2RenderingContext;
    parallel?: unknown;
    device?: { adapterInfo?: { vendor?: string; architecture?: string; description?: string } };
  };
  _pipelines?: { caches?: Map<unknown, unknown> };
  _nodes?: { nodeBuilderCache?: Map<unknown, unknown> };
};

/** GPU description for the bucket (read from three's own context / device; nothing is created) */
function gpuDescription(r: RendererLike | undefined): string {
  try {
    const gl = r?.backend?.gl;
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const ren = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
      const ven = ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
      return `${String(ven ?? '')} ${String(ren ?? '')}`;
    }
    const i = r?.backend?.device?.adapterInfo;
    if (i) return [i.vendor, i.architecture, i.description].filter(Boolean).join(' ');
  } catch { /* ignore */ }
  return '';
}

export function installDiag(ctx: ClientContext): void {
  const loose = ctx.net as unknown as { req(r: string, a: unknown, timeoutMs?: number): Promise<unknown> };
  const send = (a: CoreDiagJoin | CoreDiagWindow) => { void loose.req('core.diag', a, 8000).catch(() => { /* an older server */ }); };
  const renderer = () => ctx.services.use('three')?.renderer as unknown as RendererLike | undefined;
  const render = () => ctx.services.use('render');
  let fallback: Promise<string> | null = null;
  let lastPreset = '';

  const presetSource = (): CoreDiagJoin['presetSource'] => {
    const desk = (window as unknown as { deadAirDesktop?: { safeGraphics?: unknown } }).deadAirDesktop;
    if (desk && typeof desk.safeGraphics === 'string' && desk.safeGraphics) return 'safe';
    const names = render()?.presets ?? [];
    const url = ctx.params.get('preset');
    if (url && names.includes(url)) return 'url';
    let stored: string | null = null;
    try { stored = localStorage.getItem('deadair.render.preset'); } catch { stored = null; }
    return stored && names.includes(stored) ? 'stored' : 'auto';
  };

  const joinReport = async (why: CoreDiagJoin['why']) => {
    const three = ctx.services.use('three');
    const backend: CoreDiagJoin['backend'] = three?.backend ?? 'none';
    fallback ??= webgpuFallback(backend, ctx.params.get('webgl') === '1');
    const r = renderer();
    const g = gpuBucket(gpuDescription(r));
    const nav = navigator as unknown as { userAgentData?: { brands?: Brand[]; platform?: string }; deviceMemory?: number };
    const preset = render()?.preset ?? '?';
    lastPreset = preset;
    send({
      kind: 'join', why, gpuVendor: g.vendor, gpuTier: g.tier, backend, fallback: await fallback,
      browser: browserOf(navigator.userAgent, nav.userAgentData?.brands), os: osOf(navigator.userAgent, nav.userAgentData?.platform),
      shell: (window as unknown as { deadAirDesktop?: unknown }).deadAirDesktop ? 'desktop' : 'browser',
      cores: typeof navigator.hardwareConcurrency === 'number' ? navigator.hardwareConcurrency : null,
      memGB: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
      parallel: backend === 'webgl2' ? !!r?.backend?.parallel : null,
      preset, presetSource: presetSource(),
    });
  };

  // ---- per-window counters
  let frames = 0;
  let gapMax = 0;
  let lastFrame = 0;
  let hiddenMs = 0;
  let hiddenSince = document.hidden ? performance.now() : 0;
  let draws: number[] = [];
  let lastDrawSample = 0;
  const loafOn = typeof PerformanceObserver !== 'undefined' && (PerformanceObserver.supportedEntryTypes ?? []).includes('long-animation-frame');
  let loaf = { n: 0, blockMs: 0, maxMs: 0, top: '' };
  if (loafOn) {
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries() as unknown as { duration: number; blockingDuration?: number; scripts?: [] }[]) {
          loaf.n++;
          loaf.blockMs += e.blockingDuration ?? 0;
          if (e.duration > loaf.maxMs) { loaf.maxMs = e.duration; loaf.top = loafTop(e); }
        }
      }).observe({ type: 'long-animation-frame', buffered: true });
    } catch { /* not supported after all */ }
  }
  document.addEventListener('visibilitychange', () => {
    const now = performance.now();
    if (document.hidden) hiddenSince = now;
    else if (hiddenSince) { hiddenMs += now - hiddenSince; hiddenSince = 0; }
    lastFrame = 0; // a hidden page draws no frames: that gap is not a freeze
  });
  ctx.registerSystem({
    name: 'core.diag',
    order: 0,
    update() {
      const now = performance.now();
      if (document.hidden) { lastFrame = 0; return; }
      if (lastFrame) gapMax = Math.max(gapMax, now - lastFrame);
      lastFrame = now;
      frames++;
      if (now - lastDrawSample >= 500) {
        lastDrawSample = now;
        const d = render()?.stats?.().drawCalls;
        if (typeof d === 'number' && Number.isFinite(d)) draws.push(d);
      }
    },
  });

  let lastPipes = -1;
  let lastNodes = -1;
  let lastSkipped = ctx.net.voiceSkipped;
  let lastPreloadDone = -1;
  let windowStart = performance.now();
  const windowReport = (): CoreDiagWindow => {
    const now = performance.now();
    if (hiddenSince) { hiddenMs += now - hiddenSince; hiddenSince = now; }
    const r = renderer();
    const total = r?._pipelines?.caches?.size;
    const nodes = r?._nodes?.nodeBuilderCache?.size;
    const pipes = typeof total === 'number' && typeof nodes === 'number'
      ? { total, created: lastPipes < 0 ? 0 : Math.max(0, total - lastPipes), nodes, nodesNew: lastNodes < 0 ? 0 : Math.max(0, nodes - lastNodes) }
      : null;
    if (pipes) { lastPipes = pipes.total; lastNodes = pipes.nodes; }
    const sorted = [...draws].sort((a, b) => a - b);
    const tr = ctx.diag.preload as { incomingAt?: number; askedAt?: number; phaseAt?: number; replyAt?: number; buildAt?: number; doneAt?: number; ok?: boolean | null; from?: string } | undefined;
    let preload: CoreDiagWindow['preload'] = null;
    if (tr && typeof tr.doneAt === 'number' && tr.doneAt > lastPreloadDone) {
      lastPreloadDone = tr.doneAt;
      const base = tr.from === 'early' && (tr.incomingAt ?? -1) >= 0 ? tr.incomingAt! : (tr.phaseAt ?? 0);
      const rel = (v: number | undefined) => (typeof v === 'number' && v >= 0 ? Math.round(v - base) : -1);
      preload = { asked: rel(tr.askedAt), reply: rel(tr.replyAt), built: rel(tr.buildAt), done: rel(tr.doneAt), ok: tr.ok === true, early: tr.from === 'early' };
    }
    const skipped = ctx.net.voiceSkipped;
    const out: CoreDiagWindow = {
      kind: 'window', sec: Math.round((now - windowStart) / 1000), frames, gapMax: Math.round(gapMax), hiddenMs: Math.round(hiddenMs),
      loaf: loafOn ? { n: loaf.n, blockMs: Math.round(loaf.blockMs), maxMs: Math.round(loaf.maxMs), top: loaf.top } : null,
      pipes, draws: sorted.length ? { p50: sorted[sorted.length >> 1], max: sorted[sorted.length - 1] } : null,
      rtt: Math.round(ctx.net.rtt), voiceSkipped: Math.max(0, skipped - lastSkipped), preset: render()?.preset ?? '?', phase: ctx.world.phase,
      preload,
    };
    lastSkipped = skipped;
    frames = 0; gapMax = 0; hiddenMs = 0; draws = []; loaf = { n: 0, blockMs: 0, maxMs: 0, top: '' };
    windowStart = now;
    return out;
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  const loop = () => {
    timer = setTimeout(() => {
      try {
        if (ctx.net.status === 'joined') {
          const w = windowReport();
          send(w);
          if (w.preset !== lastPreset && w.preset !== '?') void joinReport('preset').catch(() => {});
        }
      } catch { /* never break the page */ }
      loop();
    }, WINDOW_MS);
  };
  ctx.bus.on('net:welcome', () => {
    void joinReport('join').catch(() => {});
    if (!timer) { windowReport(); loop(); } // the first window starts at the welcome (the join's own frames count)
  });
}
