// CLIENT FIX verification (2026-10-07 host crashes): GPU cost of the title menu (and optionally the join flow) of a
// given client build, for before/after comparisons. One headless Chrome, hard-killed 28 s after launch.
//
// SAFETY (the host PC really crashes): refuses to start while another test browser / Electron test instance runs
// (waits up to 90 s); nvlddmkm events polled ~every 1.5 s from the test start, ABORT (kill only this script's PIDs)
// on the first one; only PIDs this script started are killed. Never :3000 / play.dead-air.io (ports 3901-3906).
//
//   node tests/playtest/gpu/client-fix-gpu.ts --base=http://127.0.0.1:3903 --name=after --phases=title:16
//   phases: title (menu idle) | play (PLAY panel open) | join (PLAY -> CREATE CREW, dev server: loading screen,
//           warm-up, hub) | wait (no interaction)
//   --query=k=v,k=v extra URL params (e.g. menufps=0,menublurfps=0,menures=0 = the old uncapped menu)
//   --w / --h / --dsf viewport, --persist=<profile dir> (warm shader cache; must contain 'gpuprof')
//   --fakedesk=1: a stand-in window.deadAirDesktop (windowState / onWindowState) so the phases 'minimize' /
//           'restore' can play the desktop shell's window events
//   --adminfile=<test server log>: the test server's per-process admin token (prod servers: CREATE CREW), passed in
//           the URL hash and never printed
// Output: tests/artifacts/gpu/client-<name>.json (per-second page stats, nvidia-smi 500 ms samples, per-process GPU
// engine % + dedicated VRAM of this Chrome's GPU process, per-phase averages).
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { BrowserContext, Page } from 'playwright-core';
import { REPO, VOICE_DIR } from '../../lib/launch.ts';

const arg = (k: string, d: string): string => {
  const a = process.argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const BASE = arg('base', 'http://127.0.0.1:3903').replace(/\/$/, '');
if (/:3000\b|dead-air\.io|:3100\b/i.test(BASE)) throw new Error('never test against the live server');
if (!/:390[1-6]\b/.test(BASE)) throw new Error('test servers only on ports 3901-3906');
const NAME = arg('name', 'run');
const PHASES = arg('phases', 'title:16').split(',').map((p) => { const [m, s] = p.split(':'); return { mode: m, secs: Number(s) || 8 }; });
const VW = Number(arg('w', '2560'));
const VH = Number(arg('h', '1440'));
const DSF = Number(arg('dsf', '1'));
const PERSIST = arg('persist', '');
if (PERSIST && !/gpuprof/i.test(PERSIST)) throw new Error('--persist dir must contain "gpuprof" (GPU pid lookup)');
const ADMIN_FILE = arg('adminfile', '');
const FAKE_DESK = arg('fakedesk', '0') === '1';
const EXTRA = Object.fromEntries(arg('query', '').split(',').filter(Boolean).map((kv) => kv.split('=') as [string, string]));
const HARD_CAP_MS = 28_000;
const OUT_DIR = join(REPO, 'tests/artifacts/gpu');
mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let t0 = Date.now();
const redact = (m: string) => m.replace(/admin=[0-9a-f]+/gi, 'admin=<redacted>');
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} s] ${redact(m)}`);

// ---------------------------------------------------------------- pre-flight: one GPU test instance at a time
function otherTestBrowsers(): string[] {
  const q = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'chrome.exe' -and $_.CommandLine -match '--headless|--remote-debugging-pipe|playwright|gpuprof') -or ($_.Name -match '^(electron|DeadAir)\\.exe$' -and $_.CommandLine -match '--profile=|--remote-debugging|--headless') } | Where-Object { $_.CommandLine -notmatch '--type=' } | ForEach-Object { \"$($_.ProcessId) $($_.Name)\" }"], { encoding: 'utf8' });
  return String(q.stdout ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}
{
  const until = Date.now() + 90_000;
  let others = otherTestBrowsers();
  while (others.length && Date.now() < until) {
    console.log(`waiting: another test browser is running (${others.join(', ')})`);
    await sleep(3000);
    others = otherTestBrowsers();
  }
  if (others.length) { console.log(`ABORT before launch: other test browsers still running (${others.join(', ')})`); process.exit(3); }
}

t0 = Date.now();
const startIso = new Date(t0).toISOString();

// ---------------------------------------------------------------- nvidia-smi (500 ms)
const smiRows: { t: number; util: number; powerW: number; memMiB: number; clockMHz: number }[] = [];
const smi = spawn('C:\\Windows\\System32\\nvidia-smi.exe', ['--query-gpu=utilization.gpu,power.draw,memory.used,clocks.gr', '--format=csv,noheader,nounits', '-lms', '500'], { stdio: ['ignore', 'pipe', 'ignore'] });
let smiBuf = '';
smi.stdout!.on('data', (d: Buffer) => {
  smiBuf += d.toString();
  let i: number;
  while ((i = smiBuf.indexOf('\n')) >= 0) {
    const line = smiBuf.slice(0, i).trim();
    smiBuf = smiBuf.slice(i + 1);
    const [u, p, m, c] = line.split(',').map((x) => Number(x.trim()));
    if (Number.isFinite(u)) smiRows.push({ t: Date.now() - t0, util: u, powerW: p, memMiB: m, clockMHz: c });
  }
});

// ---------------------------------------------------------------- nvlddmkm poller (+ per-process GPU counters)
const pidFile = join(OUT_DIR, `.gpupid-client-${NAME}.txt`);
writeFileSync(pidFile, '0');
const ps = `
$ErrorActionPreference='SilentlyContinue'
$start=[datetime]::Parse('${startIso}').ToLocalTime()
while ($true) {
  $n=(Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='nvlddmkm'; StartTime=$start} | Measure-Object).Count
  [Console]::Out.WriteLine("E $n"); [Console]::Out.Flush()
  $gp=[int](Get-Content '${pidFile}' -Raw)
  if ($gp -gt 0) {
    $s=Get-Counter -Counter "\\GPU Engine(pid_$($gp)_*)\\Utilization Percentage","\\GPU Process Memory(pid_$($gp)_*)\\Dedicated Usage" -SampleInterval 1 -MaxSamples 1
    $u3=0; $uo=0; $vm=0
    foreach ($c in $s.CounterSamples) { if ($c.Path -match 'dedicated usage') { $vm+=$c.CookedValue } elseif ($c.InstanceName -match 'engtype_3d$') { $u3+=$c.CookedValue } else { $uo+=$c.CookedValue } }
    [Console]::Out.WriteLine(("S {0:F2} {1:F2} {2:F0}" -f $u3, $uo, ($vm/1MB))); [Console]::Out.Flush()
  } else { Start-Sleep -Milliseconds 700 }
}`;
const poller = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: ['ignore', 'pipe', 'ignore'] });
const procRows: { t: number; eng3d: number; engOther: number; vramMB: number }[] = [];
let events = 0;
let aborted = '';
let pBuf = '';
poller.stdout!.on('data', (d: Buffer) => {
  pBuf += d.toString();
  let i: number;
  while ((i = pBuf.indexOf('\n')) >= 0) {
    const line = pBuf.slice(0, i).trim();
    pBuf = pBuf.slice(i + 1);
    if (line.startsWith('E ')) {
      events = Number(line.slice(2)) || 0;
      if (events > 0 && !aborted) { aborted = `nvlddmkm event(s) appeared: ${events}`; void shutdown(2); }
    } else if (line.startsWith('S ')) {
      const [a, b, c] = line.slice(2).split(' ').map(Number);
      procRows.push({ t: Date.now() - t0, eng3d: a, engOther: b, vramMB: c });
    }
  }
});

// ---------------------------------------------------------------- browser
let bctx: BrowserContext | null = null;
let page: Page | null = null;
let mainPid = 0;
const errors: string[] = [];
const pageRows: Record<string, unknown>[] = [];
const phaseMarks: { mode: string; from: number; to: number }[] = [];
const notes: string[] = [];
let cur: { mode: string; from: number } | null = null;
let joinAt = 0;
let readyAt = 0;
let done = false;
const killTree = (pid: number | undefined) => { if (pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); };
const killCp = (cp: ChildProcess | null) => killTree(cp?.pid);

async function shutdown(code: number): Promise<never> {
  if (!done) {
    done = true;
    if (cur) phaseMarks.push({ mode: cur.mode, from: cur.from, to: Date.now() - t0 });
    cur = null;
    log(aborted ? `ABORT: ${aborted}` : 'closing');
    let closed = !bctx;
    try { closed = await Promise.race([bctx ? bctx.close().then(() => true) : Promise.resolve(true), sleep(3000).then(() => false)]); } catch { /* ignore */ }
    if (!closed) killTree(mainPid); // only this script's browser, only when a clean close hung
    killCp(smi);
    killCp(poller);
    try { rmSync(pidFile, { force: true }); } catch { /* ignore */ }
    write();
  }
  process.exit(code);
}
const hardCap = setTimeout(() => { log('hard cap 28 s reached'); void shutdown(0); }, HARD_CAP_MS);
hardCap.unref();

function avg(xs: number[]): number { return xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : NaN; }
function write(): void {
  const phases = phaseMarks.map((p) => {
    const inP = <T extends { t: number }>(rows: T[]) => rows.filter((r) => r.t >= p.from + 1500 && r.t <= p.to); // skip the 1.5 s transition
    const pr = inP(pageRows as unknown as { t: number; rafFps: number; drawFps: number; gpuMs: number | null; draws: number; heapMB: number }[]);
    return {
      mode: p.mode, secs: +((p.to - p.from) / 1000).toFixed(1),
      smiUtil: avg(inP(smiRows).map((r) => r.util)), smiPowerW: avg(inP(smiRows).map((r) => r.powerW)), smiMemMiB: avg(inP(smiRows).map((r) => r.memMiB)),
      chromeGpu3dPct: avg(inP(procRows).map((r) => r.eng3d)), chromeGpuOtherPct: avg(inP(procRows).map((r) => r.engOther)), chromeVramMB: avg(inP(procRows).map((r) => r.vramMB)),
      rafFps: avg(pr.map((r) => r.rafFps)), drawFps: avg(pr.map((r) => r.drawFps)), gpuMsTimestamp: avg(pr.map((r) => r.gpuMs ?? NaN).filter(Number.isFinite)),
      drawCalls: avg(pr.map((r) => r.draws)), heapMB: avg(pr.map((r) => r.heapMB)),
    };
  });
  const vr = procRows.filter((r) => r.vramMB > 0);
  const out = {
    name: NAME, base: BASE, viewport: [VW, VH, DSF], query: EXTRA, start: startIso, aborted: aborted || null, nvlddmkmEvents: events,
    vramFirstLastMB: vr.length ? [vr[0].vramMB, vr[vr.length - 1].vramMB] : null, phases, notes, pageRows, smiRows, procRows, errors: errors.slice(0, 30),
  };
  const f = join(OUT_DIR, `client-${NAME}.json`);
  writeFileSync(f, JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ phases, aborted: out.aborted, events, vramFirstLastMB: out.vramFirstLastMB, notes, errors: out.errors.slice(0, 8) }, null, 1));
  console.log(`wrote ${f}`);
}

/** in-page probe: rAF fps + drawn frames per second (distinct three frame ids with >= 1 renderer.render call) */
const PROBE = () => {
  const w = window as unknown as { __probe?: { raf: number; drawn: number; at: number; pause: boolean }; __render?: { three(): { renderer: { render: (...a: unknown[]) => unknown; info: { frame: number } } } } };
  if (w.__probe) return true;
  const r = w.__render?.three().renderer;
  if (!r) return false;
  const p = { raf: 0, drawn: 0, at: performance.now(), pause: false };
  w.__probe = p;
  const orig = r.render.bind(r);
  let lastF = -1;
  // pause = diagnostics: no 3D GPU work at all (what is left is the compositor + the CSS layers)
  r.render = (...a: unknown[]) => { if (p.pause) return undefined; const f = r.info.frame; if (f !== lastF) { lastF = f; p.drawn++; } return orig(...a); };
  const tick = () => { p.raf++; requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  return true;
};

async function samplePage(): Promise<void> {
  const s = await page!.evaluate(() => {
    const w = window as unknown as { __probe?: { raf: number; drawn: number; at: number }; __render?: { stats(): { gpuMs?: number; drawCalls: number }; info(): Record<string, unknown> }; __game?: { state(): { screen?: string } } };
    const p = w.__probe;
    const now = performance.now();
    let rafFps = 0, drawFps = 0;
    if (p) { const dt = (now - p.at) / 1000; rafFps = p.raf / dt; drawFps = p.drawn / dt; p.raf = 0; p.drawn = 0; p.at = now; }
    const st = w.__render?.stats();
    const inf = w.__render?.info() ?? {};
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
    const ld = document.querySelector('[data-testid="loading-screen"]');
    return {
      rafFps: +rafFps.toFixed(1), drawFps: +drawFps.toFixed(1), gpuMs: st?.gpuMs !== undefined ? +st.gpuMs.toFixed(3) : null, draws: st?.drawCalls ?? 0,
      size: inf.size, preset: inf.preset, canvasView: document.querySelector('#game canvas')?.getAttribute('data-view') ?? null,
      canvasDrawFps: document.querySelector('#game canvas')?.getAttribute('data-draw-fps') ?? null, backdrop: inf.backdrop, mode: inf.mode ?? null, menuRes: inf.menuRes ?? null, parked: inf.parkedShadows ?? null,
      screen: w.__game?.state().screen ?? null, loading: ld ? (ld.getAttribute('data-step') ?? 'on') : '', heapMB: +(mem / 1048576).toFixed(1),
    };
  });
  pageRows.push({ t: Date.now() - t0, ...s });
}

async function main(): Promise<void> {
  const q = new URLSearchParams({ test: '1', nobright: '1', preset: 'ultra', ...EXTRA });
  const url = `${BASE}/?${q}`;
  const token = ADMIN_FILE ? (/admin token: ([0-9a-f]{16,64})/.exec(readFileSync(ADMIN_FILE, 'utf8'))?.[1] ?? '') : '';
  if (ADMIN_FILE && !token) throw new Error('no admin token in --adminfile');
  log(`launch headless Chrome ${VW}x${VH}@${DSF} -> ${url} phases ${PHASES.map((p) => `${p.mode}:${p.secs}`).join(',')}`);
  const args = ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${join(VOICE_DIR, 'silence.wav')}`, '--autoplay-policy=no-user-gesture-required'];
  if (PERSIST) {
    bctx = await chromium.launchPersistentContext(PERSIST, { channel: 'chrome', headless: true, viewport: { width: VW, height: VH }, deviceScaleFactor: DSF, args });
    page = bctx.pages()[0] ?? await bctx.newPage();
  } else {
    const b = await chromium.launch({ channel: 'chrome', headless: true, args });
    bctx = await b.newContext({ viewport: { width: VW, height: VH }, deviceScaleFactor: DSF });
    page = await bctx.newPage();
  }
  page.on('pageerror', (e) => errors.push(redact(`pageerror: ${e.message}`)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(redact(`console: ${m.text().slice(0, 300)}`)); });
  await page.addInitScript(() => { try { localStorage.setItem('deadair.name', 'GpuProbe'); localStorage.removeItem('deadair.render.preset'); } catch { /* ignore */ } });
  if (FAKE_DESK) {
    await page.addInitScript(() => {
      type S = { minimized: boolean; visible: boolean; focused: boolean; fullscreen: boolean };
      let st: S = { minimized: false, visible: true, focused: true, fullscreen: false };
      const hs = new Set<(s: S) => unknown>();
      const w = window as unknown as Record<string, unknown>;
      w.deadAirDesktop = Object.freeze({
        windowState: () => ({ ...st }),
        onWindowState: (cb: (s: S) => unknown) => { hs.add(cb); return () => hs.delete(cb); },
      });
      w.__fakeDesk = { set(p: Partial<S>) { st = { ...st, ...p }; for (const h of hs) h({ ...st }); } };
    });
  }
  // this Chrome's main + GPU process (newest top-level chrome.exe of a Playwright / gpuprof profile)
  const qp = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `$m = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match '${PERSIST ? 'gpuprof' : 'playwright_chromiumdev_profile'}' -and $_.CommandLine -notmatch '--type=' } | Sort-Object CreationDate -Descending | Select-Object -First 1; ` +
    "if ($m) { $g = Get-CimInstance Win32_Process -Filter \"ParentProcessId=$($m.ProcessId)\" | Where-Object { $_.CommandLine -match '--type=gpu-process' } | Select-Object -First 1; \"$($m.ProcessId) $($g.ProcessId)\" }"], { encoding: 'utf8' });
  const [mp, gpuPid] = String(qp.stdout ?? '').trim().split(/\s+/).map(Number);
  mainPid = mp || 0;
  log(`chrome main pid ${mainPid || '?'} gpu pid ${gpuPid || '?'}`);
  if (gpuPid) writeFileSync(pidFile, String(gpuPid));
  await page.goto(token ? `${url}#admin=${token}` : url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    const w = window as unknown as { __render?: { info(): { frames?: number } } };
    return !!document.querySelector('[data-testid="main-menu"]') && Number(w.__render?.info().frames ?? 0) > 5;
  }, undefined, { timeout: 18_000, polling: 200 });
  await page.waitForFunction(PROBE, undefined, { timeout: 4000, polling: 100 });
  log('main menu up, probe installed');
  for (const p of PHASES) {
    if (done) return;
    if (p.mode === 'play') {
      await page.click('[data-testid="menu-play"]');
      await page.waitForSelector('[data-testid="join-panel"]', { timeout: 4000 });
    } else if (p.mode === 'join') {
      if (!(await page.$('[data-testid="join-panel"]'))) {
        await page.click('[data-testid="menu-play"]');
        await page.waitForSelector('[data-testid="join-panel"]', { timeout: 4000 });
      }
      await page.click('[data-testid="join-panel"] button.btn:not(.primary):not(.join-back)'); // CREATE CREW (dev / admin)
      joinAt = Date.now() - t0;
    } else if (p.mode === 'pause3d' || p.mode === 'both') {
      // diagnostics: 3D off (pause3d), + the menu's CSS layers and animations off (both)
      await page.evaluate((noCss) => {
        const w = window as unknown as { __probe?: { pause: boolean } };
        if (w.__probe) w.__probe.pause = true;
        if (noCss && !document.getElementById('gpu-nocss')) {
          const st = document.createElement('style');
          st.id = 'gpu-nocss';
          st.textContent = '.mm-grain,.mm-scan,.mm-roll{display:none!important}.mm-title::before,.mm-title::after{display:none!important}.mm-root,.mm-root *,.mm-root *::before,.mm-root *::after{animation:none!important;transition:none!important}';
          document.head.appendChild(st);
        }
      }, p.mode === 'both');
    } else if (p.mode === 'minimize' || p.mode === 'restore') {
      await page.evaluate((min) => {
        (window as unknown as { __fakeDesk?: { set(p: Record<string, boolean>): void } }).__fakeDesk?.set({ minimized: min, visible: !min, focused: !min });
      }, p.mode === 'minimize');
    } else if (p.mode === 'blur') {
      // the window lost focus (another app in front / minimized desktop shell): Playwright emulates focus, so fake it
      await page.evaluate(() => { document.hasFocus = () => false; window.dispatchEvent(new Event('blur')); });
    } else if (p.mode === 'glitch' || p.mode === 'calm') {
      // look check: freeze the title animations at the first glitch moment (42 % of the 9 s cycle) / reduce flicker
      await page.evaluate((calm) => {
        document.querySelector('.mm-root')?.classList.toggle('mm-calm', calm);
        for (const a of document.getAnimations()) {
          const n = (a as unknown as { animationName?: string }).animationName ?? '';
          a.pause();
          a.currentTime = /^mm-(glitch|flicker)/.test(n) ? 9000 * 0.42 : 0;
        }
      }, p.mode === 'calm');
      await sleep(400);
      await page.screenshot({ path: join(OUT_DIR, `client-${NAME}-${p.mode}.png`), clip: { x: 150, y: 400, width: 900, height: 330 } }).catch(() => {});
    }
    const from = Date.now() - t0;
    cur = { mode: p.mode, from };
    log(`phase ${p.mode} (${p.secs} s)`);
    const end = Date.now() + p.secs * 1000;
    let lastStep = '';
    while (Date.now() < end && !done) {
      await samplePage().catch(() => {});
      const last = pageRows[pageRows.length - 1] as { loading?: string; screen?: string; mode?: string; size?: unknown } | undefined;
      const step = `${last?.screen}/${last?.loading || '-'}/${last?.mode} ${JSON.stringify(last?.size)}`;
      if (step !== lastStep) { lastStep = step; notes.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${step}`); }
      if (p.mode === 'join' && !readyAt && joinAt && last?.screen === 'none' && !last?.loading) { readyAt = Date.now() - t0; notes.push(`join ready after ${((readyAt - joinAt) / 1000).toFixed(1)} s`); }
      await sleep(p.mode === 'join' ? 500 : 1000);
    }
    if (done) return;
    cur = null;
    phaseMarks.push({ mode: p.mode, from, to: Date.now() - t0 });
  }
  if (PHASES.some((p) => p.mode === 'title' || p.mode === 'play' || p.mode === 'join')) {
    await page.screenshot({ path: join(OUT_DIR, `client-${NAME}.png`) }).catch(() => {});
  }
  await shutdown(0);
}

main().catch(async (e) => { log(`error: ${e instanceof Error ? e.message.split('\n')[0] : e}`); await shutdown(1); });
