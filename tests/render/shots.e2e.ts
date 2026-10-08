// Owner: env-render (v1.2). Batched render pass: named views on one or more cfgs (preset + backend) in ONE browser
// process, with per-view frame stats, GPU ms, draws, pipeline counts and screenshot luminance stats. Built for the
// integrator's gate-R pass and for E2's own GPU runs (each run goes through tools/gpu-guard.mjs).
//   node tools/gpu-guard.mjs --max-sec 120 -- node tests/render/shots.e2e.ts --base http://127.0.0.1:3812 \
//     --cfgs ultra,low-webgl --views corridor,room,blackout,six --w 2560 --h 1440 --tag after [--perf 1500] [--lum 1]
// cfg = <preset>[-webgl] (preset low|medium|high|ultra; -webgl = ?webgl=1). Views are test-scene views
// (?scene=test: corridor, room, crossing, blackout, six, core, exit, mist, mirror, beams, nv, ...); a view may carry
// modifiers after ':' (e.g. 'room:nv' = night vision on, 'blackout:volonly' needs rdebug, see VIEW_MODS below).
// --q 'rdebug=volonly' adds query params to every page. Output: tests/artifacts/render/v12/<tag>/<cfg>_<view>.png
// and tests/artifacts/render/v12/<tag>.json. Exit 1 on page/console/WebGPU errors or a failed assertion.
// --warm 1 (default) calls render.warmup() (the loading flow's warm set) before the views; --warm auto only waits for
// the automatic mirror warm (no loading flow: what ?test=1 pages get); --warm 0 neither.
// Software lane: tools/gpu-guard.mjs sets DEADAIR_RENDER=swiftshader while hardware rendering is off for agent tests;
// Chrome then runs SwiftShader (CPU) WebGL2 for every cfg (the cfg's preset is kept: logic, counts and layout, not
// lighting quality or perf).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Page } from 'playwright-core';
import sharp from 'sharp';
import { REPO, VOICE_DIR } from '../lib/launch.ts';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', process.env.BASE_URL ?? 'http://127.0.0.1:3812').replace(/\/$/, '');
if (/:(3000|20241|3100)$/.test(BASE)) throw new Error('refusing to run against the live/shared ports');
const CFGS = arg('cfgs', 'ultra').split(',').filter(Boolean);
const VIEWS = arg('views', 'corridor,room,crossing,blackout,six').split(',').filter(Boolean);
const W = Number(arg('w', '1600'));
const H = Number(arg('h', '900'));
const TAG = arg('tag', 'look');
const PERF_MS = Number(arg('perf', '1500'));
const SETTLE_MS = Number(arg('settle', '700'));
const LUM = arg('lum', '1') !== '0';
const EXTRA = Object.fromEntries(new URLSearchParams(arg('q', '')));
/** CPU-profile these views' perf windows (CDP): --profile mirrorlit,room -> top self-time functions in the log */
const PROFILE = new Set(arg('profile', '').split(',').filter(Boolean));
/** '1' = call render.warmup() (the v1.2 warm set) before the views; 'auto' = wait for the automatic mirror warm; '0' */
const WARM_MODE = arg('warm', '1');
const WARM = WARM_MODE === '1';
/** set by tools/gpu-guard.mjs while hardware rendering is off for agent tests */
const SOFTWARE = process.env.DEADAIR_RENDER === 'swiftshader';
const READY_MS = Number(arg('ready', '45000'));
/** after a cfg's views: resize and run more views (perf comparable to another resolution): --then 2560x1440:six,room */
const THEN = (() => { const t = arg('then', ''); if (!t) return null; const [wh, vs] = t.split(':'); const [tw, th] = wh.split('x').map(Number); return { w: tw, h: th, views: (vs ?? '').split(',').filter(Boolean) }; })();
/** per-cfg view lists: --cfgviews 'ultra-volonly=six,six:widebox;low-webgl=room,mirror' (default: --views) */
const CFG_VIEWS: Record<string, string[]> = Object.fromEntries(arg('cfgviews', '').split(';').filter(Boolean).map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1).split(',').filter(Boolean)]; }));
/** per-cfg overrides: --cfgq 'ultra-volonly=rdebug=volonly;low-webgl=w=1280' (extra query per cfg name) */
const CFG_Q: Record<string, Record<string, string>> = Object.fromEntries(arg('cfgq', '').split(';').filter(Boolean).map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), Object.fromEntries(new URLSearchParams(kv.slice(i + 1).replace(/,/g, '&')))]; }));
const OUT = join(REPO, 'tests/artifacts/render/v12', TAG);
mkdirSync(OUT, { recursive: true });
const T0 = performance.now();
const log = (s: string) => console.log(`[${((performance.now() - T0) / 1000).toFixed(1).padStart(6)}s] ${s}`);

interface Lum { p10: number; p50: number; p90: number; black: number; clip: number; top: number; mid: number; bottom: number }
interface ViewResult {
  cfg: string; view: string; ok: boolean; fps: number; p50: number; p95: number; max: number; gpuMs: number | null; draws: number | null;
  pipelines: number | null; pipelinesBefore?: number | null; info?: Record<string, unknown>; lum?: Lum; shot?: string; note?: string;
}

/** luminance stats of a PNG (sRGB 0..255 luma): percentiles, % near-black / clipped, mean of the top/middle/bottom 15 % bands */
async function lumStats(file: string): Promise<Lum> {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) lum[i] = 0.2126 * data[i * 3] + 0.7152 * data[i * 3 + 1] + 0.0722 * data[i * 3 + 2];
  const band = (y0: number, y1: number) => {
    let s = 0, c = 0;
    for (let y = Math.floor(y0 * info.height); y < Math.floor(y1 * info.height); y++) for (let x = 0; x < info.width; x++) { s += lum[y * info.width + x]; c++; }
    return c ? +(s / c).toFixed(1) : 0;
  };
  const s = Array.from(lum).sort((a, b) => a - b);
  const q = (p: number) => +s[Math.min(n - 1, Math.floor(p * n))].toFixed(1);
  let black = 0, clip = 0;
  for (const v of lum) { if (v < 6) black++; if (v > 250) clip++; }
  return { p10: q(0.1), p50: q(0.5), p90: q(0.9), black: +(100 * black / n).toFixed(1), clip: +(100 * clip / n).toFixed(2), top: band(0, 0.15), mid: band(0.425, 0.575), bottom: band(0.85, 1) };
}

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${join(VOICE_DIR, 'silence.wav')}`, '--autoplay-policy=no-user-gesture-required',
    ...(SOFTWARE ? ['--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [])],
});
if (SOFTWARE) console.log('[shots] software lane (DEADAIR_RENDER=swiftshader): SwiftShader WebGL2 for every cfg');
const results: ViewResult[] = [];
let failed = 0;
const allErrors: string[] = [];

type W8 = Window & { __ft?: { iv: number[]; mark: number } };

type Prof = { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[]; samples: number[]; timeDeltas: number[]; startTime: number; endTime: number };
const summarize = (profile: Prof, n = 18): string[] => {
  const byId = new Map(profile.nodes.map((x) => [x.id, x]));
  const self = new Map<string, number>();
  for (let i = 0; i < profile.samples.length; i++) {
    const node = byId.get(profile.samples[i]);
    if (!node) continue;
    const cf = node.callFrame;
    const k = `${cf.functionName || '(anon)'} ${cf.url.replace(/^.*\/(src|node_modules|deps)\//, '$1/').replace(/\?.*$/, '')}:${cf.lineNumber + 1}`;
    self.set(k, (self.get(k) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
  }
  const total = (profile.endTime - profile.startTime) / 1000;
  return [...self].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${v.toFixed(0)}ms ${(v / total * 100).toFixed(1)}% ${k}`);
};

async function openCfg(cfg: string): Promise<{ page: Page; errors: string[]; close(): Promise<void> }> {
  // cfg = <preset>[-webgl][-<tag>] (the tag only names a CFG_Q override set, e.g. ultra-volonly)
  const webgl = SOFTWARE || /-webgl(-|$)/.test(cfg);
  const preset = cfg.split('-')[0];
  const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await context.grantPermissions(['microphone']).catch(() => {});
  // other agents edit the shared tree all night: refuse Vite's HMR socket (a reload mid-pass drops window.__render)
  await context.routeWebSocket((u) => !u.pathname.endsWith('/ws'), (ws) => { ws.close(); });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/vite|websocket|\[hmr\]|favicon/i.test(m.text())) errors.push(`console: ${m.text().slice(0, 400)}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 400)}`));
  page.on('response', (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push(`http ${r.status()}: ${r.url().replace(/^https?:\/\/[^/]+/, '').slice(0, 160)}`); });
  await page.addInitScript(() => {
    try { for (const k of ['deadair.render.preset', 'deadair.render.exposure', 'deadair.render.autoq', 'deadair.render.maxFps']) localStorage.removeItem(k); } catch { /* ignore */ }
    const w = window as unknown as W8;
    w.__ft = { iv: [], mark: 0 };
    let last = 0;
    const loop = (now: number) => { if (last) w.__ft!.iv.push(now - last); last = now; if (w.__ft!.iv.length > 40000) { w.__ft!.iv.splice(0, 20000); w.__ft!.mark = Math.max(0, w.__ft!.mark - 20000); } requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  });
  const q = new URLSearchParams({ test: '1', scene: 'test', preset, autoq: '0', ...(webgl ? { webgl: '1' } : {}), ...EXTRA, ...(CFG_Q[cfg] ?? {}) });
  await page.goto(`${BASE}/?${q}`, { waitUntil: 'domcontentloaded' });
  return { page, errors, close: () => context.close() };
}

const frameStats = (page: Page) => page.evaluate(() => {
  const w = window as unknown as W8;
  const iv = w.__ft!.iv.slice(w.__ft!.mark);
  const s = [...iv].sort((a, b) => a - b);
  const pick = (k: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(s.length * k))] : 0);
  const sum = iv.reduce((a, b) => a + b, 0);
  return { n: iv.length, fps: sum ? +(iv.length / (sum / 1000)).toFixed(1) : 0, p50: +pick(0.5).toFixed(2), p95: +pick(0.95).toFixed(2), max: +(s[s.length - 1] ?? 0).toFixed(1) };
});
const markFrames = (page: Page) => page.evaluate(() => { const w = window as unknown as W8; w.__ft!.mark = w.__ft!.iv.length; });
/** render pipelines compiled so far (three r186 Pipelines.caches) */
const pipelineCount = (page: Page) => page.evaluate(() => {
  const r = window.__render as unknown as { pipelines?: () => { pipelines: number }; three?: () => { renderer: unknown } } | undefined;
  if (r?.pipelines) return r.pipelines().pipelines;
  const rr = r?.three?.().renderer as { _pipelines?: { caches?: Map<unknown, unknown> } } | undefined;
  return rr?._pipelines?.caches?.size ?? null;
});

const mdbg = (p: Page, o: Record<string, boolean>) => p.evaluate((oo) => (window.__render as unknown as { mirrorDebug?: (x: Record<string, boolean>) => unknown }).mirrorDebug?.(oo), o);
/** view modifiers: applied after selecting the view, undone after the shot */
const VIEW_MODS: Record<string, { on: (p: Page) => Promise<unknown>; off: (p: Page) => Promise<unknown> }> = {
  // the beam march must not depend on where the level bounds are (v1.1: the box back face fogged it)
  widebox: {
    on: (p) => p.evaluate(() => (window.__render as unknown as { volBounds?: (a: number[], b: number[]) => void }).volBounds?.([-60, -2, -60], [120, 30, 120])),
    off: (p) => p.evaluate(() => (window.__render as unknown as { volBounds?: (a: number[] | null, b: number[] | null) => void }).volBounds?.(null, null)),
  },
  // mirror path diagnostics (render: reflection off; nested: the stock nested reflector; noctx: no GI-only context)
  norefl: { on: (p) => mdbg(p, { render: false }), off: (p) => mdbg(p, { render: true }) },
  nested: { on: (p) => mdbg(p, { explicit: false }), off: (p) => mdbg(p, { explicit: true }) },
  noctx: { on: (p) => mdbg(p, { ctx: false }), off: (p) => mdbg(p, { ctx: true }) },
  norim: { on: (p) => mdbg(p, { rim: false }), off: (p) => mdbg(p, { rim: true }) },
  // parked batched fixture lights hidden (one sentinel per type): the pipeline count must stay flat
  hide: {
    on: (p) => p.evaluate(() => (window.__render as unknown as { hideParked?: (on: boolean) => void }).hideParked?.(true)),
    off: (p) => p.evaluate(() => (window.__render as unknown as { hideParked?: (on: boolean) => void }).hideParked?.(false)),
  },
  nv: {
    on: (p) => p.evaluate(() => (window.__render as unknown as { nightVision?: (on: boolean) => void }).nightVision?.(true)),
    off: (p) => p.evaluate(() => (window.__render as unknown as { nightVision?: (on: boolean) => void }).nightVision?.(false)),
  },
};

for (const cfg of CFGS) {
  log(`cfg ${cfg}: ${W}x${H}`);
  const o = await openCfg(cfg);
  const { page } = o;
  try {
    await page.waitForFunction(() => !!window.__render && window.__game?.ready() === true, undefined, { timeout: READY_MS, polling: 100 });
    await page.waitForFunction(() => Number(window.__render!.info().frames) > 30, undefined, { timeout: 20_000, polling: 100 });
    await page.addStyleTag({ content: '#overlay{display:none!important} .hud-chip{display:none!important}' });
    const info0 = await page.evaluate(() => window.__render!.info());
    log(`  info ${JSON.stringify(info0)}`);
    const names = await page.evaluate(() => window.__render!.views());
    if (WARM) {
      const t0 = Date.now();
      await page.evaluate(() => Promise.race([(window.__render as unknown as { v12(): { warmup(): Promise<void> } }).v12().warmup(), new Promise((r) => setTimeout(r, 8000))]));
      log(`  warm set: ${Date.now() - t0} ms, ${JSON.stringify(await page.evaluate(() => (window.__render!.info() as { warmSet?: unknown }).warmSet))} proxies`);
      // the GPU process may still be finishing the warm set's pipelines: settle before the first measured view
      await page.waitForTimeout(Number(arg('afterwarm', '1500')));
    } else if (WARM_MODE === 'auto') {
      // no loading flow: the automatic mirror warm (render: on a mirror-registry change) must have run by itself
      const t0 = Date.now();
      await page.waitForFunction(() => { const m = (window.__render!.info() as { mirrorWarm?: { state?: string; frames?: number } }).mirrorWarm; return !!m && (m.state === 'done' || m.state === 'early') && !m.frames; }, undefined, { timeout: 20_000, polling: 100 }).catch(() => {});
      log(`  auto mirror warm: ${Date.now() - t0} ms ${JSON.stringify(await page.evaluate(() => (window.__render!.info() as { mirrorWarm?: unknown }).mirrorWarm))}`);
      await page.waitForTimeout(Number(arg('afterwarm', '1500')));
    }
    const plan: { spec: string; tag: string }[] = (CFG_VIEWS[cfg] ?? VIEWS).map((v) => ({ spec: v, tag: '' }));
    if (THEN) plan.push({ spec: '@resize', tag: '' }, ...THEN.views.map((v) => ({ spec: v, tag: `@${THEN.w}` })));
    for (const { spec: spec0, tag: vtag } of plan) {
      if (spec0 === '@resize') {
        await page.setViewportSize({ width: THEN!.w, height: THEN!.h });
        await page.waitForTimeout(1500);
        log(`  resized to ${THEN!.w}x${THEN!.h}: ${JSON.stringify((await page.evaluate(() => window.__render!.info())).size)}`);
        continue;
      }
      const spec = spec0;
      const [view, ...mods] = spec.split(':');
      if (!names.includes(view)) { log(`  skip ${spec} (views: ${names.join(',')})`); continue; }
      const pBefore = await pipelineCount(page);
      await page.evaluate((n) => window.__render!.view(n), view);
      for (const m of mods) await VIEW_MODS[m]?.on(page);
      await page.waitForTimeout(SETTLE_MS);
      await page.evaluate(() => window.__render!.hitch());
      await markFrames(page);
      const cdp = PROFILE.has(spec) ? await page.context().newCDPSession(page) : null;
      if (cdp) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 }); await cdp.send('Profiler.start'); }
      await page.waitForTimeout(PERF_MS);
      if (cdp) {
        const { profile } = await cdp.send('Profiler.stop') as { profile: Prof };
        log(`  CPU profile ${spec}:\n      ${summarize(profile).join('\n      ')}`);
        await cdp.detach().catch(() => {});
      }
      const hitch = await page.evaluate(() => window.__render!.hitch());
      const fs = await frameStats(page);
      const st = await page.evaluate(() => window.__render!.stats());
      const info = await page.evaluate(() => window.__render!.info());
      const pAfter = await pipelineCount(page);
      const diagC = await page.evaluate(() => (window.__render!.info() as { compile?: unknown }).compile);
      if (diagC && (diagC as { ok?: boolean }).ok === false) log(`  compile check: ${JSON.stringify(diagC)}`);
      const shot = join(OUT, `${cfg}_${spec.replace(/:/g, '-')}${vtag.replace('@', '_')}.png`);
      await page.screenshot({ path: shot });
      for (const m of mods) await VIEW_MODS[m]?.off(page);
      const lum = LUM ? await lumStats(shot) : undefined;
      const r: ViewResult = {
        cfg, view: spec + vtag, ok: true, fps: fs.fps, p50: fs.p50, p95: fs.p95, max: fs.max, gpuMs: st.gpuMs !== undefined ? +st.gpuMs.toFixed(2) : null,
        draws: st.drawCalls ?? null, pipelines: pAfter, pipelinesBefore: pBefore, lum, shot, info: { mode: info.mode, fixturesLit: info.fixturesLit, usedShadowed: info.usedShadowed, parkedShadows: info.parkedShadows, mirrorsLive: info.mirrorsLive, mirrors: info.mirrors, shadowRenders: info.shadowRenders, pipelines: info.pipelines, hitch, grid: info.grid },
      };
      // 'first' modifier: the pipeline count must not change on this view's first appearance (after the warm set)
      if (mods.includes('first') && pBefore !== null && pAfter !== null && pAfter !== pBefore) { r.ok = false; r.note = `pipelines ${pBefore} -> ${pAfter} on first view`; failed++; log(`  FAIL ${spec}: ${r.note}`); }
      results.push(r);
      writeFileSync(join(REPO, 'tests/artifacts/render/v12', `${TAG}.json`), JSON.stringify({ tag: TAG, w: W, h: H, cfgs: CFGS, views: VIEWS, results, errors: allErrors, partial: true }, null, 1));
      log(`  ${spec.padEnd(16)} fps ${fs.fps} p50 ${fs.p50} p95 ${fs.p95} max ${fs.max} hitch ${hitch.toFixed(0)} gpu ${r.gpuMs} draws ${r.draws} pipes ${pBefore}->${pAfter} mirror ${JSON.stringify(info.mirrors ?? '')}${lum ? ` lum p10 ${lum.p10} p50 ${lum.p50} p90 ${lum.p90} top ${lum.top} mid ${lum.mid} bottom ${lum.bottom} black ${lum.black}%` : ''}`);
    }
    const gameErrs = await page.evaluate(() => window.__game!.errors());
    const errs = [...o.errors, ...gameErrs];
    if (errs.length) { failed++; log(`  FAIL ${cfg}: ${errs.length} errors\n    ${errs.slice(0, 10).join('\n    ')}`); allErrors.push(...errs.map((e) => `${cfg}: ${e}`)); }
    else log(`  PASS ${cfg}: 0 console/page/WebGPU errors`);
  } catch (e) {
    failed++;
    const msg = e instanceof Error ? e.message.split('\n')[0] : String(e);
    log(`  FAIL ${cfg}: ${msg}\n    ${o.errors.slice(0, 10).join('\n    ')}`);
    allErrors.push(`${cfg}: ${msg}`, ...o.errors.map((x) => `${cfg}: ${x}`));
    await page.screenshot({ path: join(OUT, `${cfg}_failure.png`) }).catch(() => {});
  } finally {
    await o.close();
  }
}
await browser.close();
writeFileSync(join(REPO, 'tests/artifacts/render/v12', `${TAG}.json`), JSON.stringify({ tag: TAG, w: W, h: H, cfgs: CFGS, views: VIEWS, results, errors: allErrors }, null, 1));
log(`report -> tests/artifacts/render/v12/${TAG}.json`);
log(failed ? `render shots FAILED (${failed})` : 'render shots PASSED');
process.exitCode = failed ? 1 : 0;
