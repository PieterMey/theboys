// Owner: v1.1 loading screen (apps/client/src/loading/**). Provides services.loading and installs core telemetry.
// (a) JOIN: the full-screen loading screen replaces the plain 'ENTERING THE LOT…' wait. It opens inside the JOIN
//     click and stays until the hub is built, its assets are in, every pipeline is warmed (render.warmupAll) and
//     frames have been stable for ~1 s (cap 45 s; progress + step + elapsed, so it never looks hung).
// (b) DRIVE: at drive start the client fetches the facility layout ('net.preload'), builds it behind the drive
//     screen, warms it and reports 'net.loaded'; the server ends the drive only when every preloading client is done
//     (meta/flow.ts, max +30 s). On arrival ('contract') a short overlay stays until THIS client's frames are stable.
// Tests: with ?test=1 the overlays and the preload are off unless ?loading=1 (other tracks' tests screenshot right
// after joining); the JOIN-click flow through the menu always uses it.
import './loading.css';
import { render, h } from 'preact';
import { signal } from '@preact/signals';
import type { Signal } from '@preact/signals';
import type { LevelLayout } from '@dead-air/shared/layout.ts';
import type { ClientContext } from '../core/context.ts';
import { installTelemetry } from '../core/telemetry.ts';
import { propsPending } from '../level/assets.ts';
import type { RenderService } from '../render/types.ts';
import { LoadingScreen } from './LoadingScreen.tsx';
import type { LoadingView, StepId } from './LoadingScreen.tsx';
import { assetProgress, fmtMB, installTracker } from './tracker.ts';

export interface DriveLoad {
  /** 'idle' | 'loading' (building the site) | 'done' */
  state: 'idle' | 'loading' | 'done' | 'failed';
  pct: number;
  label: string;
  /** names the van is still waiting for (server 'net.loading') */
  waiting: string[];
}

export interface LoadingService {
  /** show the join loading screen now (call synchronously inside the JOIN click) */
  begin(kind: 'join'): void;
  /** the join succeeded: resolves once the scene is built, warmed and stable (or the 45 s cap) */
  untilReady(): Promise<void>;
  /** the join failed: hide the screen (the menu shows the error) */
  cancel(): void;
  readonly active: boolean;
  /** the overlay is up and fully opaque (not fading out): the 3D view under it draws capped (render perf.coverFps) */
  readonly covering: boolean;
  /** drive-time preload status (drive screen) */
  readonly drive: Signal<DriveLoad>;
}

declare module '../core/services.ts' {
  interface ServiceMap { loading: LoadingService }
}

const STEP_RANGE: Record<StepId, [number, number]> = {
  connecting: [0, 8], assets: [8, 58], level: [58, 70], shaders: [70, 92], stable: [92, 99], ready: [100, 100],
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function install(ctx: ClientContext): void {
  installTracker();
  installTelemetry(ctx);
  const testGate = !ctx.testMode || ctx.params.get('loading') === '1';
  const preloadOn = ctx.params.get('preload') !== '0' && testGate;
  const freezeOn = !ctx.testMode || ctx.params.get('loadfreeze') === '1';
  const warmAll = ctx.params.get('warmall') === '1';

  const view = signal<LoadingView>({ visible: false, kind: 'join', step: 'connecting', pct: 0, detail: '', t0: 0, site: '', crew: '', fading: false });
  const drive = signal<DriveLoad>({ state: 'idle', pct: 0, label: '', waiting: [] });
  const root = document.createElement('div');
  root.id = 'loading-root';
  document.body.appendChild(root);
  render(h(LoadingScreen, { view }), root);

  const renderSvc = () => ctx.services.use('render') as RenderService | undefined;
  const level = () => ctx.services.use('level');
  const freeze = (on: boolean) => {
    if (!freezeOn) return;
    try { (ctx.services.use('players' as never) as { freeze?(r: string, on: boolean): void } | undefined)?.freeze?.('loading', on); } catch { /* optional */ }
  };
  const patch = (p: Partial<LoadingView>) => { view.value = { ...view.value, ...p }; };
  /** monotonic progress inside the current step's range */
  const setStep = (step: StepId, k = 0, detail?: string) => {
    const [a, b] = STEP_RANGE[step];
    const pct = Math.max(view.value.pct, a + (b - a) * Math.max(0, Math.min(1, k)));
    patch({ step, pct, ...(detail !== undefined ? { detail } : {}) });
  };
  let session = 0;

  const levelBuilt = () => {
    const L = ctx.world.layout;
    const lv = level();
    return !!L && !!lv && !!lv.layout && lv.layout.hash === L.hash;
  };
  const assetsIdle = () => {
    const a = assetProgress();
    const lv = level();
    return a.pending === 0 && propsPending() === 0 && (!lv || lv.texturesReady()) && performance.now() - a.lastChange > 350;
  };
  /** the 3D view may pause while an opaque screen covers it (not under the drive screen: its scene is warming) */
  const holdOk = () => view.value.visible && !view.value.fading;
  const stable = () => {
    const r = renderSvc();
    if (!r?.frameStats) return true;
    const s = r.frameStats(1000);
    return s.n >= 8 && s.max < Math.max(110, s.p50 * 3);
  };

  /** assets -> level -> shaders -> stable. `report` gets (step, 0..1, detail). Never throws. */
  const prepare = async (capMs: number, report: (step: StepId, k: number, detail: string) => void, my: () => boolean, minMs = 0): Promise<boolean> => {
    const t0 = performance.now();
    const deadline = t0 + capMs;
    const a0 = assetProgress();
    const held = holdOk();
    if (held) renderSvc()?.hold?.(true);
    try {
      return await prepareSteps(t0, deadline, capMs, a0, report, my, minMs);
    } finally {
      if (held) renderSvc()?.hold?.(false);
    }
  };
  const prepareSteps = async (t0: number, deadline: number, capMs: number, a0: ReturnType<typeof assetProgress>, report: (step: StepId, k: number, detail: string) => void, my: () => boolean, minMs: number): Promise<boolean> => {
    // downloads (props, textures, sounds): real counts/bytes of what this scene asked for. Loads already in flight
    // when this wait began (the scene starts fetching before the screen measures) are this scene's work too: count
    // them in the totals, or 'done' outruns 'files' ("75/3 files · 37 MB / 1.3 MB") and k passes 1
    while (performance.now() < deadline - capMs * 0.35 && my()) {
      const a = assetProgress();
      const files = a.started - a0.started + a0.pending;
      const done = Math.max(0, Math.min(files, a.done - a0.done));
      const bt = a.bytesTotal - a0.bytesTotal + Math.max(0, a0.bytesTotal - a0.bytesDone);
      const bd = Math.max(0, Math.min(bt, a.bytesDone - a0.bytesDone));
      const k = Math.min(1, bt > 0 ? bd / bt : files > 0 ? done / files : 1);
      report('assets', k, files > 0 ? `${done}/${files} files${bt > 0 ? ` · ${fmtMB(bd)} / ${fmtMB(bt)}` : ''}` : 'cached');
      if (assetsIdle() && levelBuilt()) break;
      await sleep(120);
    }
    if (!my()) return false;
    report('level', 0.5, levelBuilt() ? 'site geometry ready' : 'waiting for the site');
    while (!levelBuilt() && performance.now() < deadline - capMs * 0.3 && my()) await sleep(100);
    report('level', 1, '');
    // warm-up frames with all six flashlight slots on (shadow + volume pipelines) over the real scene; the frames
    // that follow compile whatever else is in view, behind this screen. (?warmall=1: compile every material of the
    // whole scene via proxies, measured slower overall on a fresh shader cache: 20-45 s vs ~10 s.)
    const r = renderSvc();
    r?.hold?.(false);
    report('shaders', 0.1, 'compiling materials');
    if (r) {
      const left = Math.max(1500, deadline - performance.now() - 2000);
      await Promise.race([warmAll && r.warmupAll ? r.warmupAll(2) : r.warmup(), sleep(left)]);
    }
    if (!my()) return false;
    report('shaders', 1, '');
    // frames stable for ~1 s (relative to this machine's own frame time)
    const tStable = performance.now();
    let good = 0;
    while (performance.now() < deadline && my()) {
      const s = renderSvc()?.frameStats?.(1000);
      report('stable', Math.min(1, (performance.now() - tStable) / 1200), s ? `${s.fps.toFixed(0)} fps` : '');
      good = stable() ? good + 1 : 0;
      if (good >= 3 && performance.now() - tStable > 700 && performance.now() - t0 > minMs) break;
      await sleep(150);
    }
    return true;
  };

  const show = (kind: LoadingView['kind']) => {
    const site = kind === 'arrive' ? siteName() : '';
    view.value = { visible: true, kind, step: kind === 'join' ? 'connecting' : 'assets', pct: kind === 'join' ? 2 : 10, detail: '', t0: performance.now(), site, crew: ctx.world.crew?.code ?? ctx.net.crewCode ?? '', fading: false };
    freeze(true);
    renderSvc()?.busy?.();
  };
  const hide = async () => {
    renderSvc()?.hold?.(false);
    if (!view.value.visible) return;
    patch({ step: 'ready', pct: 100, detail: '' });
    await sleep(120);
    patch({ fading: true });
    freeze(false);
    await sleep(440);
    view.value = { ...view.value, visible: false, fading: false };
  };
  const siteName = (): string => {
    const m = (ctx.world.full as { meta?: { drive?: { siteName?: string } | null } | null; activeOrder?: { siteName?: string } | null } | null);
    return m?.activeOrder?.siteName ?? m?.meta?.drive?.siteName ?? '';
  };

  // ---------------- (a) join ----------------
  let joinWaiter: Promise<void> | null = null;
  const service: LoadingService = {
    begin() {
      session++;
      show('join');
    },
    untilReady() {
      if (joinWaiter) return joinWaiter;
      const my = session;
      if (!view.value.visible) show('join');
      patch({ crew: ctx.world.crew?.code ?? '' });
      // resolves when the scene is ready; the screen then fades out over the game (the caller closes the menu
      // underneath while the overlay is still opaque)
      joinWaiter = prepare(45_000, (step, k, detail) => { if (session === my) setStep(step, k, detail); }, () => session === my)
        .catch(() => false)
        .then(() => { if (session === my) void hide(); })
        .finally(() => { joinWaiter = null; });
      return joinWaiter;
    },
    cancel() {
      renderSvc()?.hold?.(false);
      session++;
      joinWaiter = null;
      freeze(false);
      view.value = { ...view.value, visible: false, fading: false };
    },
    get active() { return view.value.visible; },
    get covering() { return view.value.visible && !view.value.fading; },
    drive,
  };
  ctx.services.provide('loading', service);
  // the JOIN click (user gesture): open the screen at once so nothing else flashes in between
  ctx.bus.on('join:click', () => { if (ctx.ui.screen.value.name === 'join') service.begin('join'); });
  ctx.bus.on('net:status', ({ status }) => {
    if (view.value.visible && view.value.kind === 'join' && view.value.step === 'connecting') patch({ detail: status === 'open' ? 'signal acquired' : status === 'reconnecting' ? 'retrying…' : '' });
  });

  // ---------------- (b) drive preload ----------------
  let preloadFor = '';
  const runPreload = async () => {
    if (!preloadOn || ctx.world.phase !== 'drive') return;
    const d = (ctx.world.full as { meta?: { drive?: { orderId?: string; endsAt?: number } | null } | null } | null)?.meta?.drive;
    const key = `${d?.orderId ?? '?'}:${d?.endsAt ?? 0}`;
    if (key === preloadFor) return;
    preloadFor = key;
    const t0 = performance.now();
    drive.value = { state: 'loading', pct: 5, label: 'receiving site data', waiting: drive.value.waiting };
    // let the drive screen paint (cards + typewriter) before the main thread builds the site
    await sleep(1200);
    if (ctx.world.phase !== 'drive') return;
    let L: LevelLayout | null = null;
    try {
      const rep = await (ctx.net as unknown as { req(r: string, a: unknown, t?: number): Promise<{ layout: LevelLayout | null }> }).req('net.preload', {}, 15_000);
      L = rep?.layout ?? null;
    } catch { L = null; }
    if (!L || ctx.world.phase !== 'drive') { drive.value = { ...drive.value, state: 'idle', label: '' }; return; }
    const hash = L.hash;
    drive.value = { ...drive.value, pct: 15, label: 'building the site' };
    // the level track rebuilds from world.layout (content-compared); the 'contract' phase event later carries the
    // same layout, so it does not rebuild again at arrival
    ctx.world.layout = L;
    ctx.world.notify();
    let ok = true;
    try {
      ok = await prepare(25_000, (step, k) => {
        const [a, b] = STEP_RANGE[step];
        const pct = Math.max(drive.value.pct, 15 + (a + (b - a) * k) * 0.85);
        drive.value = { ...drive.value, pct, label: step === 'assets' ? 'downloading site assets' : step === 'level' ? 'building the site' : step === 'shaders' ? 'warming shaders' : 'settling' };
      }, () => ctx.world.phase === 'drive');
    } catch { ok = false; }
    if (ctx.world.phase !== 'drive' && ctx.world.phase !== 'contract') return;
    drive.value = { ...drive.value, state: ok ? 'done' : 'failed', pct: 100, label: ok ? 'site ready' : 'site partly loaded' };
    try {
      await (ctx.net as unknown as { req(r: string, a: unknown, t?: number): Promise<unknown> }).req('net.loaded', { hash, ok, ms: performance.now() - t0 }, 10_000);
    } catch { /* the server's cap covers it */ }
  };
  (ctx.net.on as unknown as (e: string, fn: (d: unknown) => void) => () => void)('net.loading', (d) => {
    const w = (d as { waiting?: unknown } | null)?.waiting;
    drive.value = { ...drive.value, waiting: Array.isArray(w) ? w.map(String).slice(0, 6) : [] };
  });

  // ---------------- (c) arrival on site / mid-contract rejoin ----------------
  let arriveSession = 0;
  const arrive = () => {
    if (!testGate) return;
    if (view.value.visible && view.value.kind === 'join') return; // the join screen already covers it
    const my = ++arriveSession;
    show('arrive');
    // at least 2.6 s: other tracks build per-contract visuals right after the phase change (monster models re-warm
    // 1.5 s in, objectives' levers / Core), and those compiles must happen behind this screen too
    void prepare(12_000, (step, k, detail) => { if (arriveSession === my) setStep(step, k, detail); }, () => arriveSession === my && ctx.world.phase === 'contract', 2600)
      .then(() => { if (arriveSession === my) return hide(); })
      .catch(() => hide());
  };

  ctx.bus.on('world:phase', ({ from, to }) => {
    if (to === 'drive') { drive.value = { state: 'idle', pct: 0, label: '', waiting: [] }; preloadFor = ''; void runPreload(); }
    if (to === 'contract' && from !== 'contract') arrive();
    if (to !== 'contract' && view.value.visible && view.value.kind === 'arrive') { arriveSession++; void hide(); }
  });
  ctx.bus.on('net:welcome', ({ resumed }) => {
    if (ctx.world.phase === 'drive') void runPreload();
    // a reconnect straight into a running contract (page reload mid-contract): cover the rebuild too
    if (ctx.world.phase === 'contract' && resumed) arrive();
  });

  if (ctx.testMode) {
    (window as unknown as { __loading?: unknown }).__loading = {
      view: () => ({ ...view.value }),
      drive: () => ({ ...drive.value }),
      assets: () => assetProgress(),
    };
  }
}
