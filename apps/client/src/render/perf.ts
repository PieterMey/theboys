// Owner: track ③ Render (v1.1). Frame-time statistics, internal-resolution policy (DPR clamp + per-preset cap),
// AUTO QUALITY (resolution scale first, then the preset; never pool sizes / castShadow / lights) and the F3 perf panel.
import type { Preset } from './presets.ts';

// ---------------------------------------------------------------- frame-time sampler

/** ring buffer of rAF intervals with their timestamps (ms, performance.now()) */
export class FrameTimes {
  private iv = new Float32Array(4096);
  private at = new Float64Array(4096);
  private n = 0;
  private head = 0;
  push(intervalMs: number, now: number): void {
    this.iv[this.head] = intervalMs;
    this.at[this.head] = now;
    this.head = (this.head + 1) % this.iv.length;
    if (this.n < this.iv.length) this.n++;
  }
  /** stats over the frames that ended within the last `spanMs` (or since `since`) */
  stats(spanMs: number, now: number, since = -Infinity): FrameStats {
    const from = Math.max(now - spanMs, since);
    const list: number[] = [];
    let sum = 0;
    let long = 0;
    for (let k = 0; k < this.n; k++) {
      const i = (this.head - 1 - k + this.iv.length) % this.iv.length;
      if (this.at[i] < from) break;
      const v = this.iv[i];
      list.push(v);
      sum += v;
      if (v > 100) long++;
    }
    list.sort((a, b) => a - b);
    const q = (p: number) => (list.length ? list[Math.min(list.length - 1, Math.floor(list.length * p))] : 0);
    return { n: list.length, fps: sum > 0 ? (list.length * 1000) / sum : 0, p50: q(0.5), p95: q(0.95), p05: q(0.05), max: list.length ? list[list.length - 1] : 0, long };
  }
}

export interface FrameStats { n: number; fps: number; p50: number; p95: number; p05: number; max: number; long: number }

// ---------------------------------------------------------------- resolution policy

export interface PerfCfg {
  /** canvas CSS width at/above which the device pixel ratio is clamped to 1 */
  dprClampWidth: number;
  /** per-preset internal resolution cap [w, h] (physical render pixels) */
  resCap: Record<string, [number, number]>;
  /** auto quality: resolution scale rungs tried before the preset drops */
  scales: number[];
  minScale: number;
  /** measurement window (ms) and warm-up before the first window (ms) */
  windowMs: number;
  warmupMs: number;
  /** step down when the median frame is slower than this (ms) */
  slowP50Ms: number;
  /** frames > 100 ms in one window that count as hitching */
  longFrames: number;
  /** Ultra is kept only while it sustains this many fps (or the display caps lower and the GPU has headroom) */
  ultraMinFps: number;
  /** step up only when p95 is below this (ms) for two windows in a row */
  fastP95Ms: number;
  telemetrySec: number;
}

export const PERF_DEFAULTS: PerfCfg = {
  dprClampWidth: 2560,
  resCap: { low: [1600, 900], medium: [1920, 1080], high: [2560, 1440], ultra: [2560, 1440] },
  scales: [1, 0.85, 0.72, 0.6],
  minScale: 0.5,
  windowMs: 5000,
  warmupMs: 3000,
  slowP50Ms: 20,
  longFrames: 2,
  ultraMinFps: 90,
  fastP95Ms: 9,
  telemetrySec: 10,
};

export function readPerfCfg(raw: unknown): PerfCfg {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<PerfCfg>;
  return { ...PERF_DEFAULTS, ...r, resCap: { ...PERF_DEFAULTS.resCap, ...(r.resCap ?? {}) } };
}

/** pixel ratio for the renderer: DPR (clamped on wide canvases) x per-preset cap x preset res x auto scale */
export function pixelRatioFor(cssW: number, cssH: number, devDpr: number, p: Preset, cfg: PerfCfg, autoScale: number, opts: { clamp: boolean; cap: boolean }): { pr: number; w: number; h: number; dpr: number } {
  let dpr = Math.min(devDpr || 1, 2);
  if (opts.clamp && cssW >= cfg.dprClampWidth) dpr = Math.min(dpr, 1);
  let pr = dpr * p.res;
  const cap = cfg.resCap[p.name];
  if (opts.cap && cap) {
    const k = Math.min(1, cap[0] / Math.max(1, cssW * pr), cap[1] / Math.max(1, cssH * pr));
    pr *= k;
  }
  pr *= autoScale;
  // never below ~640 px wide (unreadable)
  pr = Math.max(pr, Math.min(dpr, 640 / Math.max(1, cssW)));
  return { pr, w: Math.round(cssW * pr), h: Math.round(cssH * pr), dpr };
}

// ---------------------------------------------------------------- auto quality

export interface AutoState {
  enabled: boolean;
  /** the preset may be changed (false when forced by ?preset= or ?autoq=scale) */
  presetFree: boolean;
  scale: number;
  /** last decision, for the F3 panel / telemetry */
  last: string;
  steps: number;
}

export interface AutoHooks {
  preset(): string;
  presets: readonly string[];
  setPreset(name: string): void;
  setScale(s: number): void;
  gpuMs(): number | undefined;
  /** measuring makes sense now (in game, visible, no loading screen) */
  steady(): boolean;
}

/** Auto quality controller: call tick(now) every frame; measures windowMs windows after warmupMs of steady frames. */
export function createAutoQuality(cfg: PerfCfg, times: FrameTimes, hooks: AutoHooks, state: AutoState): { tick(now: number): void; busy(now: number): void } {
  const ceiling = hooks.presets.indexOf(hooks.preset());
  let steadySince = -1;
  let windowStart = -1;
  let fastWindows = 0;
  let longBefore = false;
  let upLocked = false;
  let lastUpAt = -Infinity;
  const rungs = cfg.scales.filter((s) => s >= cfg.minScale);
  const scaleIdx = () => { let i = rungs.findIndex((s) => Math.abs(s - state.scale) < 0.01); if (i < 0) i = 0; return i; };
  const stepDown = (why: string, now: number) => {
    const i = scaleIdx();
    const pi = hooks.presets.indexOf(hooks.preset());
    // a fresh step-down right after a step-up: the faster rung is not sustainable, stay down for good
    if (now - lastUpAt < cfg.windowMs * 3) upLocked = true;
    if (state.presetFree && hooks.preset() === 'ultra' && why.startsWith('ultra')) {
      hooks.setPreset(hooks.presets[pi - 1] ?? 'high');
    } else if (i < rungs.length - 1) {
      state.scale = rungs[i + 1];
      hooks.setScale(state.scale);
    } else if (state.presetFree && pi > 0) {
      hooks.setPreset(hooks.presets[pi - 1]);
    } else { state.last = `${why} (at the lowest rung)`; return; }
    state.steps++;
    state.last = `down: ${why} -> ${hooks.preset()} x${state.scale.toFixed(2)}`;
    console.info(`[render] auto quality ${state.last}`);
  };
  const stepUp = (why: string, now: number) => {
    const i = scaleIdx();
    const pi = hooks.presets.indexOf(hooks.preset());
    if (i > 0) { state.scale = rungs[i - 1]; hooks.setScale(state.scale); }
    else if (state.presetFree && pi < ceiling && hooks.presets[pi + 1] !== 'ultra') hooks.setPreset(hooks.presets[pi + 1]);
    else return;
    lastUpAt = now;
    state.steps++;
    state.last = `up: ${why} -> ${hooks.preset()} x${state.scale.toFixed(2)}`;
    console.info(`[render] auto quality ${state.last}`);
  };
  return {
    /** something just changed the scene (level rebuild, preset/scale change, loading): restart the warm-up */
    busy(now) { steadySince = now; windowStart = -1; longBefore = false; },
    tick(now) {
      if (!state.enabled) return;
      if (!hooks.steady()) { steadySince = -1; windowStart = -1; return; }
      if (steadySince < 0) steadySince = now;
      if (now - steadySince < cfg.warmupMs) return;
      if (windowStart < 0) { windowStart = now; return; }
      if (now - windowStart < cfg.windowMs) return;
      const s = times.stats(now - windowStart, now);
      windowStart = now;
      if (s.n < 10) return;
      const gpu = hooks.gpuMs();
      // refresh period estimate: the fastest 5 % of frames (a 60 Hz display never shows < 16.6 ms)
      const refresh = Math.max(4, s.p05);
      const displayCapped = refresh > 1000 / cfg.ultraMinFps + 0.5 && s.p50 <= refresh * 1.1;
      if (s.p50 > cfg.slowP50Ms * 2) { stepDown(`p50 ${s.p50.toFixed(1)} ms`, now); if (scaleIdx() < rungs.length - 1) stepDown('very slow', now); fastWindows = 0; return; }
      // long frames step down only when they persist over two windows (one-off shader compiles / GC are not fixed by
      // a lower resolution)
      const hitching = s.long >= cfg.longFrames && longBefore;
      longBefore = s.long >= cfg.longFrames;
      if (s.p50 > cfg.slowP50Ms || hitching) { stepDown(hitching ? `${s.long} long frames` : `p50 ${s.p50.toFixed(1)} ms`, now); fastWindows = 0; return; }
      if (hooks.preset() === 'ultra' && state.presetFree) {
        // sustained = the typical frame (median), so a one-off compile hitch does not cost Ultra
        const typical = 1000 / Math.max(0.1, s.p50);
        const ok = displayCapped ? (gpu === undefined || gpu < 1000 / cfg.ultraMinFps * 0.8) : typical >= cfg.ultraMinFps * 0.97;
        if (!ok) { stepDown(`ultra needs ${cfg.ultraMinFps} fps (${typical.toFixed(0)} fps typical, gpu ${gpu?.toFixed(1) ?? '-'} ms)`, now); fastWindows = 0; return; }
      }
      const fast = s.p95 < cfg.fastP95Ms && s.long === 0 && (gpu === undefined || gpu < cfg.fastP95Ms * 0.6);
      fastWindows = fast ? fastWindows + 1 : 0;
      if (fastWindows >= 2 && !upLocked) { fastWindows = 0; stepUp(`p95 ${s.p95.toFixed(1)} ms`, now); return; }
      state.last = `ok: ${s.fps.toFixed(0)} fps p50 ${s.p50.toFixed(1)} p95 ${s.p95.toFixed(1)}${displayCapped ? ' (display-capped)' : ''}`;
    },
  };
}

// ---------------------------------------------------------------- F3 panel

export function createPerfPanel(read: () => string[]): { toggle(): void; tick(now: number): void; readonly open: boolean } {
  let el: HTMLDivElement | null = null;
  let open = false;
  let next = 0;
  try { open = localStorage.getItem('deadair.render.perfPanel') === '1'; } catch { /* ignore */ }
  const ensure = () => {
    if (el) return el;
    el = document.createElement('div');
    el.setAttribute('data-testid', 'perf-panel');
    el.style.cssText = 'position:fixed;left:8px;top:calc(env(safe-area-inset-top,0px) + 8px);z-index:9999;pointer-events:none;'
      + 'font:11px/1.35 ui-monospace,Consolas,monospace;color:#cfe8d0;background:rgba(4,8,6,.78);border:1px solid rgba(140,200,150,.35);'
      + 'padding:6px 8px;white-space:pre;letter-spacing:.02em;text-shadow:0 1px 0 #000;max-width:46ch';
    document.body.appendChild(el);
    return el;
  };
  return {
    get open() { return open; },
    toggle() {
      open = !open;
      try { localStorage.setItem('deadair.render.perfPanel', open ? '1' : '0'); } catch { /* ignore */ }
      if (el) el.hidden = !open;
      next = 0;
    },
    tick(now) {
      if (!open) return;
      if (now < next) return;
      next = now + 250;
      const e = ensure();
      e.hidden = false;
      e.textContent = read().join('\n');
    },
  };
}
