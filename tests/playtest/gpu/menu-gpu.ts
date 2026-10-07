// MENU-GPU investigation (2026-10-07 host crashes): what does the main menu cost the GPU, and who pays it
// (3D backdrop render loop vs the menu's full-screen CSS layers)?
//
// SAFETY (the host PC really crashes): ONE headless Chrome, hard-killed 30 s after launch; nvlddmkm events polled
// every ~1.5 s from the test start and the run ABORTS on the first one; only PIDs this script started are killed.
// Never :3000 / play.dead-air.io: pass your own test server (ports 3901-3906).
//
//   node tests/playtest/gpu/menu-gpu.ts --base=http://127.0.0.1:3901 --name=A --phases=normal:10,nocss:9
//   phases: normal | nocss (menu CSS layers + animations off) | pause3d (renderer.render = no-op: no 3D GPU work)
//           | both (pause3d + nocss) | calm (the menu's own reduce-flicker class mm-calm)
// Output: tests/artifacts/gpu/menu-<name>.json (per-second page stats, nvidia-smi 500 ms samples, per-process GPU
// engine % + dedicated VRAM of this Chrome's GPU process, per-phase averages).
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { REPO, launchPlayer } from '../../lib/launch.ts';
import type { Player } from '../../lib/launch.ts';

const arg = (k: string, d: string): string => {
  const a = process.argv.find((x) => x.startsWith(`--${k}=`));
  return a ? a.slice(k.length + 3) : d;
};
const BASE = arg('base', 'http://127.0.0.1:3901');
if (/:3000\b|dead-air\.io/i.test(BASE)) throw new Error('never test against the live server');
const NAME = arg('name', 'run');
const PHASES = arg('phases', 'normal:10,nocss:9').split(',').map((p) => { const [m, s] = p.split(':'); return { mode: m, secs: Number(s) || 8 }; });
const VW = Number(arg('w', '2560'));
const VH = Number(arg('h', '1440'));
const HARD_CAP_MS = 30_000;
const OUT_DIR = join(REPO, 'tests/artifacts/gpu');
mkdirSync(OUT_DIR, { recursive: true });

const t0 = new Date();
const startIso = t0.toISOString();
const log = (m: string) => console.log(`[${((Date.now() - t0.getTime()) / 1000).toFixed(1).padStart(5)} s] ${m}`);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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
    if (Number.isFinite(u)) smiRows.push({ t: Date.now() - t0.getTime(), util: u, powerW: p, memMiB: m, clockMHz: c });
  }
});

// ---------------------------------------------------------------- PowerShell poller: nvlddmkm events (+ per-process GPU counters once the GPU pid is known)
const pidFile = join(OUT_DIR, `.gpupid-${NAME}.txt`);
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
      procRows.push({ t: Date.now() - t0.getTime(), eng3d: a, engOther: b, vramMB: c });
    }
  }
});

// ---------------------------------------------------------------- browser
let player: Player | null = null;
const pageRows: Record<string, unknown>[] = [];
const phaseMarks: { mode: string; from: number; to: number }[] = [];
let cur: { mode: string; from: number } | null = null;
let done = false;
const killTree = (cp: ChildProcess | null) => { if (cp?.pid) spawnSync('taskkill', ['/PID', String(cp.pid), '/T', '/F'], { stdio: 'ignore' }); };

async function shutdown(code: number): Promise<never> {
  if (!done) {
    done = true;
    if (cur) phaseMarks.push({ mode: cur.mode, from: cur.from, to: Date.now() - t0.getTime() });
    cur = null;
    log(aborted ? `ABORT: ${aborted}` : 'closing');
    try { await Promise.race([player?.close(), sleep(4000)]); } catch { /* ignore */ }
    killTree(smi);
    killTree(poller);
    write();
  }
  process.exit(code);
}
const hardCap = setTimeout(() => { aborted ||= ''; log('hard cap 30 s reached'); void shutdown(0); }, HARD_CAP_MS);
hardCap.unref();

function avg(xs: number[]): number { return xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : NaN; }
function write(): void {
  const phases = phaseMarks.map((p) => {
    const inP = <T extends { t: number }>(rows: T[]) => rows.filter((r) => r.t >= p.from + 1500 && r.t <= p.to); // skip the 1.5 s transition
    const pr = inP(pageRows as unknown as { t: number; fps: number; gpuMs: number | null; draws: number }[]);
    return {
      mode: p.mode, secs: +((p.to - p.from) / 1000).toFixed(1),
      smiUtil: avg(inP(smiRows).map((r) => r.util)), smiPowerW: avg(inP(smiRows).map((r) => r.powerW)), smiMemMiB: avg(inP(smiRows).map((r) => r.memMiB)),
      chromeGpu3dPct: avg(inP(procRows).map((r) => r.eng3d)), chromeGpuOtherPct: avg(inP(procRows).map((r) => r.engOther)), chromeVramMB: avg(inP(procRows).map((r) => r.vramMB)),
      pageFps: avg(pr.map((r) => r.fps)), gpuMsTimestamp: avg(pr.map((r) => r.gpuMs ?? NaN).filter(Number.isFinite)), draws: avg(pr.map((r) => r.draws)),
    };
  });
  const out = { name: NAME, base: BASE, viewport: [VW, VH], start: startIso, aborted: aborted || null, nvlddmkmEvents: events, phases, pageRows, smiRows, procRows, errors: player?.errors.slice(0, 20) ?? [] };
  const f = join(OUT_DIR, `menu-${NAME}.json`);
  writeFileSync(f, JSON.stringify(out, null, 1));
  console.log(JSON.stringify({ phases, aborted: out.aborted, events }, null, 1));
  console.log(`wrote ${f}`);
}

const NOCSS = `.mm-grain,.mm-scan,.mm-roll{display:none!important}.mm-title::before,.mm-title::after{display:none!important}
.mm-root,.mm-root *,.mm-root *::before,.mm-root *::after{animation:none!important;transition:none!important}`;

async function apply(mode: string): Promise<void> {
  const page = player!.page;
  await page.evaluate(([m, css]) => {
    const w = window as unknown as { __render?: { three(): { renderer: { render: (...a: unknown[]) => unknown; __origRender?: (...a: unknown[]) => unknown } } } };
    const r = w.__render?.three().renderer;
    const wantPause = m === 'pause3d' || m === 'both';
    const wantNoCss = m === 'nocss' || m === 'both';
    if (r) {
      if (wantPause && !r.__origRender) { r.__origRender = r.render; r.render = () => undefined; }
      if (!wantPause && r.__origRender) { r.render = r.__origRender; delete r.__origRender; }
    }
    let st = document.getElementById('gpu-nocss');
    if (wantNoCss && !st) { st = document.createElement('style'); st.id = 'gpu-nocss'; st.textContent = css; document.head.appendChild(st); }
    if (!wantNoCss && st) st.remove();
    const root = document.querySelector('.mm-root');
    if (root) root.classList.toggle('mm-calm', m === 'calm');
  }, [mode, NOCSS] as const);
}

async function samplePage(): Promise<void> {
  const page = player!.page;
  const s = await page.evaluate(() => {
    const w = window as unknown as { __render?: { stats(): { fps: number; gpuMs?: number; drawCalls: number }; info(): Record<string, unknown> } };
    const st = w.__render?.stats();
    const inf = w.__render?.info() ?? {};
    const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
    return {
      fps: +(st?.fps ?? 0).toFixed(1), gpuMs: st?.gpuMs !== undefined ? +st.gpuMs.toFixed(3) : null, draws: st?.drawCalls ?? 0,
      frames: inf.frames, size: inf.size, preset: inf.preset, backdrop: inf.backdrop, pixelRatio: inf.pixelRatio,
      menu: !!document.querySelector('[data-testid="main-menu"]'), heapMB: +(mem / 1048576).toFixed(1),
      canvases: document.querySelectorAll('canvas').length,
    };
  });
  pageRows.push({ t: Date.now() - t0.getTime(), ...s });
}

async function main(): Promise<void> {
  log(`launch headless Chrome ${VW}x${VH} -> ${BASE} phases ${PHASES.map((p) => `${p.mode}:${p.secs}`).join(',')}`);
  // nobright: a fresh profile would show meta's brightness check before the menu (the host's profile already passed it)
  const PERSIST = arg('persist', '');
  if (PERSIST) {
    // persistent profile (same flags as tests/lib/launch.ts): the GPU shader cache survives between runs, like the
    // host's desktop profile (a fresh profile spends the whole 30 s budget compiling the Ultra backdrop's pipelines)
    const ctxP = await chromium.launchPersistentContext(PERSIST, {
      channel: 'chrome', headless: true, viewport: { width: VW, height: VH },
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${join(REPO, 'tests/fixtures/voice/silence.wav')}`, '--autoplay-policy=no-user-gesture-required'],
    });
    const page = ctxP.pages()[0] ?? await ctxP.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
    await page.goto(`${BASE.replace(/\/$/, '')}/?test=1&nobright=1`, { waitUntil: 'domcontentloaded' });
    player = { browser: null as unknown as Player['browser'], page, errors, close: () => ctxP.close() };
  } else {
    player = await launchPlayer({ baseUrl: BASE, viewport: { width: VW, height: VH }, query: { nobright: '1' } });
  }
  // this Chrome's GPU process: the newest chrome.exe --type=gpu-process whose parent cmdline has playwright's profile dir
  const q = spawnSync('powershell.exe', ['-NoProfile', '-Command',
    `$m = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -match '${PERSIST ? 'gpuprof' : 'playwright_chromium'}' -and $_.CommandLine -notmatch '--type=' } | Sort-Object CreationDate -Descending | Select-Object -First 1; ` +
    "if ($m) { $g = Get-CimInstance Win32_Process -Filter \"ParentProcessId=$($m.ProcessId)\" | Where-Object { $_.CommandLine -match '--type=gpu-process' } | Select-Object -First 1; \"$($m.ProcessId) $($g.ProcessId)\" }"], { encoding: 'utf8' });
  const [mainPid, gpuPid] = String(q.stdout ?? '').trim().split(/\s+/).map(Number);
  log(`chrome main pid ${mainPid || '?'} gpu pid ${gpuPid || '?'}`);
  if (gpuPid) writeFileSync(pidFile, String(gpuPid));
  await player.page.waitForFunction(() => {
    const w = window as unknown as { __render?: { info(): { frames?: number } } };
    return !!document.querySelector('[data-testid="main-menu"]') && Number(w.__render?.info().frames ?? 0) > 5;
  }, undefined, { timeout: 18_000, polling: 200 }).catch(async (e: unknown) => {
    const why = await player!.page.evaluate(() => ({
      menu: !!document.querySelector('[data-testid="main-menu"]'),
      screens: [...document.querySelectorAll('[data-testid]')].map((x) => x.getAttribute('data-testid')).slice(0, 12),
      render: !!(window as unknown as { __render?: unknown }).__render,
      frames: (window as unknown as { __render?: { info(): { frames?: number } } }).__render?.info().frames ?? null,
    })).catch(() => null);
    log(`not ready: ${JSON.stringify(why)}`);
    throw e;
  });
  log('main menu up, 3D backdrop rendering');
  for (const p of PHASES) {
    if (done) return;
    await apply(p.mode);
    const from = Date.now() - t0.getTime();
    cur = { mode: p.mode, from };
    log(`phase ${p.mode} (${p.secs} s)`);
    const end = Date.now() + p.secs * 1000;
    while (Date.now() < end && !done) {
      await samplePage().catch(() => {});
      await sleep(1000);
    }
    if (done) return;
    cur = null;
    phaseMarks.push({ mode: p.mode, from, to: Date.now() - t0.getTime() });
  }
  await shutdown(0);
}

main().catch(async (e) => { log(`error: ${e instanceof Error ? e.message : e}`); await shutdown(1); });
