// Track ③ Render host-performance probe (v1.1): reproduces the host's setup (4K canvas, deviceScaleFactor 1.0/1.5,
// Ultra), enters through the real main menu (PLAY -> CREATE CREW), measures the join, the hub, the drive, the first
// in-game facility frames and a walk (frame intervals p50/p95/max/long frames, GPU ms, internal resolution,
// Long-Animation-Frame attribution, optional CDP CPU profile). Screenshots to tests/artifacts/render/hostperf/.
// Needs a dev server on its own port (never :3000):
//   node tests/render/hostperf.e2e.ts --base http://127.0.0.1:3502 --w 3840 --h 2160 --dsf 1.5 --preset ultra
//     [--profile 1] [--uncapped 1] [--query autoq=0,rescap=0] [--tag before] [--walk 10]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Page } from 'playwright-core';
import { REPO, VOICE_DIR } from '../lib/launch.ts';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', process.env.BASE_URL ?? 'http://127.0.0.1:3502').replace(/\/$/, '');
if (/:(3000|20241|3100)$/.test(BASE)) throw new Error('refusing to run against the live/shared ports');
const W = Number(arg('w', '3840'));
const H = Number(arg('h', '2160'));
const DSF = Number(arg('dsf', '1'));
const PRESET = arg('preset', 'ultra');
const PROFILE = arg('profile', '0') === '1';
const UNCAPPED = arg('uncapped', '0') === '1';
const WALK = Number(arg('walk', '10'));
const TAG = arg('tag', 'run');
const EXTRA = Object.fromEntries(arg('query', '').split(',').filter(Boolean).map((kv) => kv.split('=') as [string, string]));
const OUT = join(REPO, 'tests/artifacts/render/hostperf');
mkdirSync(OUT, { recursive: true });
const label = `${TAG}_${W}x${H}@${DSF}_${PRESET}${UNCAPPED ? '_uncapped' : ''}`;
const T0 = performance.now();
const log = (s: string) => console.log(`[${((performance.now() - T0) / 1000).toFixed(1).padStart(6)}s] ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface FrameStats { n: number; fps: number; p50: number; p95: number; max: number; long: number }
type W8 = Window & { __ft: { iv: number[]; mark: number }; __loaf: { start: number; dur: number; block: number; scripts: { dur: number; src: string; fn: string; inv: string }[] }[]; __render?: { stats(): { gpuMs?: number; drawCalls?: number; fps: number }; info(): Record<string, unknown> }; __meta?: { screen(): string } };

const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: [
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${join(VOICE_DIR, 'silence.wav')}`,
    '--autoplay-policy=no-user-gesture-required',
    ...(UNCAPPED ? ['--disable-frame-rate-limit', '--disable-gpu-vsync'] : []),
    // tools/gpu-guard.mjs software lane (hardware GPU off for agent tests): SwiftShader WebGL2, counts only
    ...(process.env.DEADAIR_RENDER === 'swiftshader' ? ['--disable-gpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : []),
  ],
});
const context = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: DSF });
await context.grantPermissions(['microphone']).catch(() => {});
const page = await context.newPage();
const errors: string[] = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 300)); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
// other agents edit the shared tree: never let Vite's HMR socket reload this page
await page.routeWebSocket(/token=/, () => { /* swallowed */ });
await page.addInitScript(() => {
  try { localStorage.setItem('deadair.name', 'Host'); localStorage.removeItem('deadair.render.preset'); } catch { /* ignore */ }
  const w = window as unknown as W8;
  w.__ft = { iv: [], mark: 0 };
  let last = 0;
  const loop = (now: number) => {
    if (last) w.__ft.iv.push(now - last);
    last = now;
    if (w.__ft.iv.length > 60000) { w.__ft.iv.splice(0, 30000); w.__ft.mark = Math.max(0, w.__ft.mark - 30000); }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  w.__loaf = [];
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries() as unknown as { startTime: number; duration: number; blockingDuration: number; scripts?: { duration: number; sourceURL: string; sourceFunctionName: string; invoker: string }[] }[]) {
        if (w.__loaf.length < 4000) w.__loaf.push({ start: e.startTime, dur: e.duration, block: e.blockingDuration, scripts: (e.scripts ?? []).map((s) => ({ dur: s.duration, src: s.sourceURL, fn: s.sourceFunctionName, inv: s.invoker })) });
      }
    }).observe({ type: 'long-animation-frame', buffered: true });
  } catch { /* no LoAF */ }
});

const q = new URLSearchParams({ test: '1', nobright: '1', ...(PRESET ? { preset: PRESET } : {}), ...EXTRA, ...(process.env.DEADAIR_RENDER === 'swiftshader' ? { webgl: '1' } : {}) });
const url = `${BASE}/?${q}`;
log(`${label}: ${url}`);
await page.goto(url, { waitUntil: 'domcontentloaded' });

const mark = () => page.evaluate(() => { const w = window as unknown as W8; w.__ft.mark = w.__ft.iv.length; return performance.now(); });
const stats = (): Promise<FrameStats> => page.evaluate(() => {
  const w = window as unknown as W8;
  const iv = w.__ft.iv.slice(w.__ft.mark);
  const s = [...iv].sort((a, b) => a - b);
  const pick = (k: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(s.length * k))] : 0);
  const sum = iv.reduce((a, b) => a + b, 0);
  return { n: iv.length, fps: sum ? +(iv.length / (sum / 1000)).toFixed(1) : 0, p50: +pick(0.5).toFixed(1), p95: +pick(0.95).toFixed(1), max: +(s[s.length - 1] ?? 0).toFixed(0), long: iv.filter((x) => x > 100).length };
});
const renderInfo = () => page.evaluate(() => {
  const w = window as unknown as W8;
  const st = w.__render?.stats();
  const info = w.__render?.info() ?? {};
  const g = (window.__game?.state() ?? {}) as { phase?: string; screen?: string; diag?: Record<string, unknown> };
  return { gpuMs: st?.gpuMs !== undefined ? +st.gpuMs.toFixed(2) : null, draws: st?.drawCalls, size: info.size, preset: info.preset, scale: info.scale ?? null, dpr: devicePixelRatio, phase: g.phase, screen: g.screen, auto: (g.diag?.autoQuality ?? null) };
});
const shot = async (name: string) => { const p = join(OUT, `${label}_${name}.png`); await page.screenshot({ path: p }); return p; };
const fmt = (s: FrameStats) => `fps ${s.fps} p50 ${s.p50} p95 ${s.p95} max ${s.max} long ${s.long} (n ${s.n})`;
const report: Record<string, unknown> = { label, url };
type Prof = { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[]; samples: number[]; timeDeltas: number[]; startTime: number; endTime: number };
const summarize = (profile: Prof, n = 28): string[] => {
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
const cdpJoin = PROFILE ? await context.newCDPSession(page) : null;

try {
  await page.waitForFunction(() => !!window.__game, undefined, { timeout: 60_000 });
  await page.waitForSelector('[data-testid="menu-play"]', { timeout: 60_000 });
  await sleep(1500);
  await mark();
  await sleep(3000);
  report.menu = { ...(await stats()), ...(await renderInfo()) };
  log(`menu backdrop: ${fmt(report.menu as FrameStats)} ${JSON.stringify(await renderInfo())}`);

  // ---- join through the real menu: PLAY -> CREATE CREW (dev)
  await page.click('[data-testid="menu-play"]');
  await page.waitForSelector('[data-testid="join-panel"]', { timeout: 10_000 });
  if (cdpJoin) { await cdpJoin.send('Profiler.enable'); await cdpJoin.send('Profiler.setSamplingInterval', { interval: 1000 }); await cdpJoin.send('Profiler.start'); }
  await page.evaluate(() => { (window as unknown as W8).__loaf.length = 0; });
  const tJoin = await mark();
  await page.click('[data-testid="join-panel"] button.btn:not(.primary):not(.join-back)');
  let shotLoading = '';
  const samples: string[] = [];
  for (let i = 0; i < 240; i++) {
    const st = await page.evaluate(() => {
      const g = (window.__game?.state() ?? {}) as { screen?: string; net?: string };
      const ld = document.querySelector('[data-testid="loading-screen"]');
      return { screen: g.screen, net: g.net, now: performance.now(), loading: ld ? (ld.querySelector('[data-testid="loading-step"]')?.textContent ?? 'on') : '', pct: ld?.getAttribute('data-pct') ?? '' };
    });
    samples.push(`${((st.now - tJoin) / 1000).toFixed(1)}s ${st.screen}/${st.net} ${st.loading} ${st.pct}`);
    if (!shotLoading && st.loading && (st.now - tJoin) > 600) shotLoading = await shot('loading_join');
    if (st.screen === 'none' && !st.loading) break;
    await sleep(250);
  }
  const tIn = await page.evaluate(() => performance.now());
  const joinStats = await stats();
  report.join = { ms: Math.round(tIn - tJoin), ...joinStats, samples: samples.filter((_, i) => i % 4 === 0 || i === samples.length - 1) };
  log(`join -> in game: ${Math.round(tIn - tJoin)} ms; frames during join ${fmt(joinStats)}`);
  log(`  ${samples.filter((_, i) => i % 4 === 0 || i === samples.length - 1).join(' | ')}`);
  if (cdpJoin) {
    const { profile } = await cdpJoin.send('Profiler.stop') as { profile: Prof };
    writeFileSync(join(OUT, `${label}_join.cpuprofile`), JSON.stringify(profile));
    report.cpuTopJoin = summarize(profile, 22);
    log(`CPU profile JOIN self time:\n    ${(report.cpuTopJoin as string[]).join('\n    ')}`);
  }
  const loafJoin = await page.evaluate(() => (window as unknown as W8).__loaf.filter((f) => f.dur > 400).map((f) => `${Math.round(f.start)}+${Math.round(f.dur)}ms: ${f.scripts.sort((a, b) => b.dur - a.dur).slice(0, 3).map((x) => `${Math.round(x.dur)}ms ${x.inv} ${String(x.src).replace(/^.*\/(src|node_modules)\//, '$1/').replace(/\?.*$/, '')}`).join(' ; ')}`));
  report.loafJoin = loafJoin;
  log(`LoAF > 400 ms during join:\n    ${loafJoin.join('\n    ')}`);
  // first visible in-game frames (hub)
  await mark();
  await sleep(3000);
  report.hubFirst3s = { ...(await stats()), ...(await renderInfo()) };
  log(`hub first 3 s: ${fmt(report.hubFirst3s as FrameStats)} ${JSON.stringify(await renderInfo())}`);
  await shot('hub');
  await mark();
  await page.evaluate(() => { window.__game!.setInput({ forward: 0 }); });
  for (let i = 0; i < 12; i++) { await page.evaluate((k) => window.__game!.look(k * 0.5, 0), i); await sleep(500); }
  report.hub = { ...(await stats()), ...(await renderInfo()) };
  log(`hub 6 s look-around: ${fmt(report.hub as FrameStats)} ${JSON.stringify(await renderInfo())}`);

  // ---- real lobby flow: leader drives the first work order -> drive -> facility
  const dr = await page.evaluate(() => window.__game!.req!('meta.drive', {}));
  log(`meta.drive -> ${JSON.stringify(dr)}`);
  await page.waitForFunction(() => (window.__game!.state() as { phase: string }).phase === 'drive', undefined, { timeout: 15_000, polling: 100 });
  const tDrive = await mark();
  await sleep(2500);
  await shot('drive');
  const driveSamples: string[] = [];
  let tContract = 0;
  for (let i = 0; i < 400; i++) {
    const st = await page.evaluate(() => {
      const g = (window.__game?.state() ?? {}) as { screen?: string; phase?: string };
      const ld = document.querySelector('[data-testid="loading-screen"]');
      return { screen: g.screen, phase: g.phase, now: performance.now(), loading: ld ? (ld.querySelector('[data-testid="loading-step"]')?.textContent ?? 'on') : '' };
    });
    if (!tContract && st.phase === 'contract') tContract = st.now;
    driveSamples.push(`${((st.now - tDrive) / 1000).toFixed(1)}s ${st.phase}/${st.screen} ${st.loading}`);
    if (st.phase === 'contract' && st.screen === 'none' && !st.loading) break;
    await sleep(250);
  }
  const tArrive = await page.evaluate(() => performance.now());
  const driveStats = await stats();
  report.drive = { driveToContractMs: Math.round(tContract - tDrive), driveToVisibleMs: Math.round(tArrive - tDrive), ...driveStats, samples: driveSamples.filter((_, i) => i % 6 === 0 || i === driveSamples.length - 1) };
  log(`drive: contract phase after ${Math.round(tContract - tDrive)} ms, visible after ${Math.round(tArrive - tDrive)} ms; frames ${fmt(driveStats)}`);
  log(`  ${driveSamples.filter((_, i) => i % 6 === 0 || i === driveSamples.length - 1).join(' | ')}`);
  // first visible facility frames
  await mark();
  // (screenshots stall a 4K page for up to ~1 s: taken after the measurement windows)
  await sleep(1000);
  const first1 = await stats();
  await sleep(2000);
  report.arriveFirst3s = { first1s: first1, ...(await stats()), ...(await renderInfo()) };
  log(`facility first 1 s: ${fmt(first1)}; first 3 s: ${fmt(report.arriveFirst3s as FrameStats)} ${JSON.stringify(await renderInfo())}`);
  await shot('arrive_3s');
  await page.evaluate(() => { (window as unknown as W8).__render; });

  // ---- walk the facility (CPU profile optional)
  const cdp = PROFILE ? await context.newCDPSession(page) : null;
  if (cdp) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 400 }); await cdp.send('Profiler.start'); }
  await page.evaluate(() => { (window as unknown as W8).__loaf.length = 0; window.__game!.setInput({ flashlight: true }); });
  await mark();
  for (let i = 0; i < WALK * 2; i++) {
    await page.evaluate((k) => { window.__game!.look(k * 0.35, Math.sin(k) * 0.15); window.__game!.setInput({ forward: 1, sprint: k % 4 < 2 }); }, i);
    await sleep(500);
  }
  await page.evaluate(() => window.__game!.setInput({ forward: 0, sprint: false }));
  report.walk = { ...(await stats()), ...(await renderInfo()) };
  log(`walk ${WALK} s: ${fmt(report.walk as FrameStats)} ${JSON.stringify(await renderInfo())}`);
  await shot('walk');
  // F3 perf panel
  await page.keyboard.press('F3');
  await sleep(700);
  report.perfPanel = await page.evaluate(() => document.querySelector('[data-testid="perf-panel"]')?.textContent ?? null);
  log(`F3 panel: ${String(report.perfPanel).replace(/\n/g, ' | ')}`);
  await shot('perfpanel');
  await page.keyboard.press('F3');
  const loaf = await page.evaluate(() => {
    const w = window as unknown as W8;
    const agg = new Map<string, { n: number; ms: number }>();
    for (const f of w.__loaf) for (const s of f.scripts) {
      const k = `${s.inv} ${s.fn || '?'} ${String(s.src).replace(/^.*\/(src|node_modules)\//, '$1/').replace(/\?.*$/, '')}`;
      const a = agg.get(k) ?? { n: 0, ms: 0 };
      a.n++; a.ms += s.dur;
      agg.set(k, a);
    }
    return { frames: w.__loaf.length, blockMs: Math.round(w.__loaf.reduce((a, f) => a + f.block, 0)), top: [...agg].sort((a, b) => b[1].ms - a[1].ms).slice(0, 10).map(([k, v]) => `${Math.round(v.ms)}ms x${v.n} ${k}`) };
  });
  report.loafWalk = loaf;
  log(`LoAF during walk: ${loaf.frames} long frames, blocking ${loaf.blockMs} ms\n    ${loaf.top.join('\n    ')}`);
  if (cdp) {
    const { profile } = await cdp.send('Profiler.stop') as { profile: { nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number }; hitCount?: number }[]; samples: number[]; timeDeltas: number[]; startTime: number; endTime: number } };
    writeFileSync(join(OUT, `${label}.cpuprofile`), JSON.stringify(profile));
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const self = new Map<string, number>();
    for (let i = 0; i < profile.samples.length; i++) {
      const n = byId.get(profile.samples[i]);
      if (!n) continue;
      const cf = n.callFrame;
      const k = `${cf.functionName || '(anon)'} ${cf.url.replace(/^.*\/(src|node_modules|deps)\//, '$1/').replace(/\?.*$/, '')}:${cf.lineNumber + 1}`;
      self.set(k, (self.get(k) ?? 0) + (profile.timeDeltas[i] ?? 0) / 1000);
    }
    const total = (profile.endTime - profile.startTime) / 1000;
    const top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 28);
    report.cpuTop = top.map(([k, v]) => `${v.toFixed(0)}ms ${(v / total * 100).toFixed(1)}% ${k}`);
    log(`CPU profile (${total.toFixed(0)} ms wall) self time:\n    ${(report.cpuTop as string[]).join('\n    ')}`);
  }
  const gameErrors = await page.evaluate(() => window.__game!.errors());
  report.errors = [...errors, ...gameErrors].slice(0, 20);
  log(`errors: ${(report.errors as string[]).length ? (report.errors as string[]).join('\n  ') : 'none'}`);
} catch (e) {
  log(`FAILED: ${e instanceof Error ? e.stack : e}`);
  await shot('failure').catch(() => {});
  report.failed = String(e);
} finally {
  writeFileSync(join(OUT, `${label}.json`), JSON.stringify(report, null, 1));
  log(`report -> ${join(OUT, `${label}.json`)}`);
  await browser.close();
}
