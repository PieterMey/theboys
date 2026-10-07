// GPU-safe launch probe for the packed desktop app, under the rules that followed the 2026-10-07 host crashes:
// ONE instance, its own --profile (never the default one), off every screen (--offscreen-window: inactive,
// unfocusable, no taskbar button, never focused), at most 20 s of app lifetime, nvlddmkm events polled throughout
// (the first one kills the app and aborts), nvidia-smi + the app's GPU-process 3D engine load sampled (before/after).
//
//   node apps/desktop/scripts/probe.mjs --server http://127.0.0.1:3901 [--exe <DeadAir.exe>] [--profile probe]
//     [--ms 18000] [--minimize-at 9000] [--query test=1&preset=low] [--host-token HEX --host-crew CODE]
//     [--extra "--no-menu-throttle"] [--out DIR]
// --minimize-at: ms after launch; minimizes with SW_SHOWMINNOACTIVE (no window is activated, focus stays put).
// --host-token writes <profile userData>\host.json for --server (the shell's host-rights path); the probe checks that
// the page got HOST rights and that the token is in no log / report / marker. The token is never printed.
// Output: <out>/probe-summary.json (+ a compact copy on stdout). Exit 2 = aborted on a driver event.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DESKTOP = resolve(import.meta.dirname, '..');
const argv = process.argv.slice(2);
/** @param {string} n */
const opt = (n) => {
  const i = argv.indexOf(`--${n}`);
  if (i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${n}=`));
  return eq ? eq.slice(n.length + 3) : undefined;
};
const server = new URL(opt('server') ?? 'http://127.0.0.1:3901').origin;
const exe = resolve(opt('exe') ?? join(DESKTOP, 'out/win-unpacked/DeadAir.exe'));
const profile = (opt('profile') ?? 'probe').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'probe';
const MS = Number(opt('ms') ?? 18_000);
const minimizeAt = Number(opt('minimize-at') ?? 0);
const query = opt('query') ?? 'test=1';
const hostToken = opt('host-token') ?? '';
const hostCrew = opt('host-crew') ?? '';
const extra = (opt('extra') ?? '').split(/\s+/).filter(Boolean); // pass as --extra="--a --b"
const outDir = resolve(opt('out') ?? join(DESKTOP, 'out/probe'));
// --gpu-loss-at MS: the game page logs three.js's device-lost error (no real GPU fault) -> the shell's GPU-failure path
// (park on about:blank, static error screen); --reload-after MS (after the loss): press RELOAD on that screen
const gpuLossAt = Number(opt('gpu-loss-at') ?? 0);
const reloadAfter = Number(opt('reload-after') ?? 0);
if (!(MS >= 6000 && MS <= 20_000)) throw new Error('--ms must be 6000..20000 (GPU test rule: an Electron run lasts at most 20 s)');
const srvU = new URL(server);
if (/dead-air\.io$/i.test(srvU.hostname) || srvU.port === '3000' || srvU.port === '3100') throw new Error('never against the live server');
if (!existsSync(exe)) throw new Error(`not found: ${exe}`);
mkdirSync(outDir, { recursive: true });

const SYS32 = join(process.env.SystemRoot || 'C:\\Windows', 'System32');
const PS = join(SYS32, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
/** PowerShell arguments for a script (-EncodedCommand: no quoting surprises) @param {string} script */
const psArgs = (script) => ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
/** @param {string} script */
const psRun = (script) => spawnSync(PS, psArgs(script), { encoding: 'utf8', windowsHide: true }).stdout?.trim() ?? '';
const T0 = Date.now();
const t = () => Date.now() - T0;
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** @type {Record<string, any>} */
const summary = { exe, server, profile, ms: MS, minimizeAt, query, extra, startedAt: new Date(T0).toISOString(), samples: [], gpu: { app3d: [], smi: [] }, nvlddmkm: [], checks: {} };
/** @type {import('node:child_process').ChildProcess[]} */
const mine = [];
const killTree = (/** @type {number | undefined} */ pid) => {
  if (pid) spawnSync(join(SYS32, 'taskkill.exe'), ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
};

// ---------------------------------------------------------------- one GPU instance at a time
const others = psRun("Get-CimInstance Win32_Process -Filter \"Name='DeadAir.exe' OR Name='electron.exe' OR Name='chrome.exe' OR Name='chrome-headless-shell.exe'\" | Where-Object { $_.CommandLine -match '--profile=|--headless|playwright|remote-debugging-pipe' -and $_.CommandLine -notmatch '--type=' } | ForEach-Object { $_.ProcessId }");
if (others) throw new Error(`another GPU test instance is running (pids ${others.split(/\s+/).join(', ')}): one GPU test at a time`);

// ---------------------------------------------------------------- the test profile
const appData = process.env.APPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Roaming');
const userData = join(appData, 'DEAD AIR', 'profiles', profile);
mkdirSync(userData, { recursive: true });
// fresh page storage + logs every run (the GPU shader caches stay: later runs are warm, like a user's second launch)
for (const d of ['Local Storage', 'Session Storage', 'logs', 'running.json', 'window-state.json', 'host.json']) rmSync(join(userData, d), { recursive: true, force: true });
if (hostToken) {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(hostToken)) throw new Error('--host-token: 16..128 of [A-Za-z0-9_-]');
  writeFileSync(join(userData, 'host.json'), JSON.stringify({ v: 1, adminToken: hostToken, crew: hostCrew, server, writtenAt: new Date().toISOString() }));
}
const cfgFile = join(outDir, 'probe-config.json');
writeFileSync(cfgFile, JSON.stringify({ window: { width: 1280, height: 720 } }));
const reportFile = join(outDir, 'report.json');
rmSync(reportFile, { force: true });

// ---------------------------------------------------------------- watchers: nvlddmkm, nvidia-smi
let aborted = '';
/** @type {import('node:child_process').ChildProcess | null} */
let app = null;
const abort = (/** @type {string} */ why) => {
  if (aborted) return;
  aborted = why;
  summary.abort = why;
  summary.abortAt = t();
  killTree(app?.pid);
};
const startIso = new Date(T0 - 1000).toISOString();
const nvWatch = spawn(PS, psArgs(`$t0 = [datetime]::Parse('${startIso}'); while ($true) { $e = Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='nvlddmkm'; StartTime=$t0} -MaxEvents 5 -ErrorAction SilentlyContinue; if ($e) { foreach ($x in $e) { 'NVLDDMKM ' + $x.TimeCreated.ToString('o') + ' id=' + $x.Id } } else { 'ok' }; Start-Sleep -Milliseconds 400 }`), { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
mine.push(nvWatch);
let nvPolls = 0;
nvWatch.stdout?.on('data', (d) => {
  for (const l of String(d).split(/\r?\n/).filter(Boolean)) {
    if (l.startsWith('NVLDDMKM')) {
      if (!summary.nvlddmkm.includes(l)) summary.nvlddmkm.push(l);
      abort(`nvlddmkm event during the test: ${l}`);
    } else if (l === 'ok') nvPolls++;
  }
});
const smi = spawn(join(SYS32, 'nvidia-smi.exe'), ['--query-gpu=utilization.gpu,power.draw,memory.used', '--format=csv,noheader,nounits', '-lms', '500'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
mine.push(smi);
smi.stdout?.on('data', (d) => {
  for (const l of String(d).split(/\r?\n/).filter(Boolean)) {
    const [u, p, m] = l.split(',').map((x) => Number(x.trim()));
    if (Number.isFinite(u)) summary.gpu.smi.push({ t: t(), util: u, watts: p, memMiB: m });
  }
});
// a clean first nvlddmkm poll before any GPU work, then 2 s of baseline GPU numbers (Civ7 etc. without the app)
for (let i = 0; i < 80 && !nvPolls && !aborted; i++) await sleep(100);
if (!nvPolls) abort('the nvlddmkm watcher did not start');
await sleep(2000);

// ---------------------------------------------------------------- the app
const port = 9300 + (process.pid % 500);
const appArgs = [
  `--profile=${profile}`, `--server=${server}`, '--offscreen-window', '--windowed', '--no-steam', `--config=${cfgFile}`,
  `--url-query=${query}`, `--report=${reportFile}`, `--remote-debugging-port=${port}`, ...extra,
];
summary.args = appArgs.filter((a) => !a.startsWith('--report='));
/** @type {NodeJS.ProcessEnv} */
const env = { ...process.env, DEADAIR_BEAT_MS: '4000' };
delete env.ELECTRON_RUN_AS_NODE;
let launchTs = 0;
if (!aborted) {
  launchTs = Date.now();
  summary.launchedAt = t();
  app = spawn(exe, appArgs, { env, windowsHide: false, stdio: ['ignore', 'ignore', 'ignore'] });
}
let exited = /** @type {number | null} */ (null);
app?.on('exit', (c) => { exited = c ?? -1; });
// sampling ends 4.5 s before the 20 s budget: closing waits <= 4 s, then the tree is killed
const deadline = launchTs + MS - 4500;

/** GPU process of the app -> its 3D engine utilization (Windows GPU Engine counters, ~1 sample/s) */
let gpuPid = 0;
const findGpuPid = () => Number(psRun(`Get-CimInstance Win32_Process -Filter "ParentProcessId=${app?.pid}" | Where-Object { $_.CommandLine -match '--type=gpu-process' } | ForEach-Object { $_.ProcessId }`).split(/\s+/)[0]) || 0;
const startEngWatch = () => {
  const engWatch = spawn(PS, psArgs(`while ($true) { $s = (Get-Counter -Counter '\\GPU Engine(pid_${gpuPid}_*engtype_3D)\\Utilization Percentage' -ErrorAction SilentlyContinue).CounterSamples; if ($s) { 'ENG ' + [math]::Round((($s | Measure-Object CookedValue -Sum).Sum), 2) } else { 'GONE'; Start-Sleep -Milliseconds 1000 } }`), { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  mine.push(engWatch);
  engWatch.stdout?.on('data', (d) => {
    for (const l of String(d).split(/\r?\n/).filter((x) => x.startsWith('ENG '))) summary.gpu.app3d.push({ t: t(), pct: Number(l.slice(4)) || 0 });
  });
};

/** minimize WITHOUT activating anything (SW_SHOWMINNOACTIVE = 7): the user's foreground window keeps focus */
const minimizeApp = () => psRun(`Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public class PW { public delegate bool EnumProc(IntPtr h, IntPtr l);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int cmd); }
"@
$hs = New-Object System.Collections.ArrayList
$cb = [PW+EnumProc]{ param($h, $l) $p = [uint32]0; [void][PW]::GetWindowThreadProcessId($h, [ref]$p); if ($p -eq ${app?.pid} -and [PW]::IsWindowVisible($h)) { $sb = New-Object Text.StringBuilder 64; [void][PW]::GetWindowText($h, $sb, 64); if ($sb.ToString() -eq 'DEAD AIR') { [void]$hs.Add($h) } }; return $true }
[void][PW]::EnumWindows($cb, [IntPtr]::Zero)
foreach ($h in $hs) { [void][PW]::ShowWindowAsync($h, 7) }
"minimized=$($hs.Count)"`);

/** raw CDP to one target (Playwright's connectOverCDP waits on pages that may be hidden on purpose here) */
async function cdp(/** @type {string} */ wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  /** @type {Map<number, (v: any) => void>} */
  const waiting = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(String(m.data));
    if (d.id && waiting.has(d.id)) { waiting.get(d.id)?.(d); waiting.delete(d.id); }
  };
  /** @param {string} method @param {Record<string, unknown>} [params] @returns {Promise<any>} */
  const send = (method, params = {}) => new Promise((res) => {
    const n = ++id;
    waiting.set(n, res);
    try { ws.send(JSON.stringify({ id: n, method, params })); } catch { res({ error: 'closed' }); }
    setTimeout(() => { if (waiting.delete(n)) res({ error: 'timeout' }); }, 3000);
  });
  return {
    /** @param {string} expression */
    evaluate: async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))?.result?.result?.value,
    send,
    close: () => { try { ws.close(); } catch { /* closed */ } },
  };
}

const TOKEN_JSON = JSON.stringify(hostToken);
const STATE = `(async () => {
  const q = (s) => !!document.querySelector(s);
  let frames = 0; const t0 = performance.now();
  await new Promise((done) => { const f = () => { frames++; if (performance.now() - t0 < 500) requestAnimationFrame(f); }; requestAnimationFrame(f); setTimeout(done, 500); });
  const dt = Math.max(1, performance.now() - t0);
  let stored = null; try { stored = localStorage.getItem('deadair.admin'); } catch {}
  const d = window.deadAirDesktop;
  if (!window.__visLog) { window.__visLog = []; document.addEventListener('visibilitychange', () => window.__visLog.push([Math.round(performance.now()), document.visibilityState])); }
  return {
    visLog: window.__visLog.slice(-4), now: Math.round(performance.now()),
    url: location.href.split('#')[0], hashCrew: location.hash.split('&')[0].replace('#', '').replace(/^admin=.*/, ''),
    hashHasAdmin: /admin=/.test(location.hash),
    vis: document.visibilityState, focus: document.hasFocus(), raf: Math.round(frames * 1000 / dt),
    menu: q('[data-testid="main-menu"]'), join: q('[data-testid="join-panel"]'), hostTab: q('[data-view="host"]'),
    createCrew: [...document.querySelectorAll('button')].some((b) => /CREATE CREW/.test(b.textContent || '')),
    admin: stored == null ? 'none' : (${TOKEN_JSON} && stored === ${TOKEN_JSON} ? 'match' : 'other'),
    ready: window.__game?.ready?.() ?? null, errors: (window.__game?.errors?.() ?? []).slice(0, 5).map((e) => String(e).slice(0, 200)),
    desk: d ? { fns: Object.keys(d).filter((k) => typeof d[k] === 'function'), win: d.windowState?.(), safe: d.safeGraphics } : null,
    canvas: (() => { const c = document.querySelector('#game canvas'); return c ? [c.width, c.height] : null; })(),
    draw: document.querySelector('#game canvas')?.dataset?.drawFps ?? null, view: document.querySelector('#game canvas')?.dataset?.view ?? null,
  };
})()`;

/**
 * the app's CDP targets (page URLs without the fragment), e.g. to see that the splash view is gone after ready
 * @returns {Promise<{ url: string, ws: string }[]>}
 */
const targets = async () => {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(800) })).json();
    return list.filter((/** @type {any} */ x) => x.type === 'page').map((/** @type {any} */ x) => ({ url: String(x.url).split('#')[0], ws: String(x.webSocketDebuggerUrl) }));
  } catch {
    return [];
  }
};
/** the splash (static/splash.html) as the shell shows it: phase, visible buttons, running CSS animations */
const SPLASH_STATE = `(() => ({ error: document.getElementById('root')?.classList.contains('is-error') ?? null,
  reload: !document.getElementById('b-reload')?.hidden, retry: !document.getElementById('b-retry')?.hidden,
  code: document.getElementById('err-code')?.textContent ?? '', meta: document.getElementById('meta')?.textContent ?? '',
  animations: document.getAnimations().filter((a) => a.playState === 'running').length }))()`;
/** @type {Awaited<ReturnType<typeof cdp>> | null} */
let page = null;
try {
  let minimized = false;
  let lostAt = 0;
  let reloaded = false;
  let splashChecked = false;
  summary.events = [];
  while (!aborted && Date.now() < deadline && exited === null) {
    if (!gpuPid && app?.pid) {
      gpuPid = findGpuPid();
      if (gpuPid) { summary.gpuPid = gpuPid; startEngWatch(); }
    }
    if (!page) {
      const tgt = (await targets()).find((x) => x.url.startsWith(server));
      if (tgt) { page = await cdp(tgt.ws).catch(() => null); if (page) summary.pageAt ??= t(); }
    }
    if (minimizeAt && !minimized && Date.now() - launchTs >= minimizeAt) {
      minimized = true;
      summary.minimizedAt = t();
      summary.minimize = minimizeApp();
    }
    const s = page ? await page.evaluate(STATE).catch(() => null) : null;
    if (s) summary.samples.push({ t: t(), phase: lostAt ? (reloaded ? 'reloaded' : 'parked') : minimized ? 'minimized' : 'offscreen', ...s });
    // 1.5 s after the shell's ready the splash view must be gone (its renderer closed)
    if (!splashChecked && s?.ready && summary.samples.filter((/** @type {any} */ x) => x.ready).length >= 6) {
      splashChecked = true;
      summary.targetsAfterReady = (await targets()).map((x) => x.url);
    }
    if (gpuLossAt && !lostAt && page && Date.now() - launchTs >= gpuLossAt) {
      lostAt = t();
      summary.events.push(`${lostAt} inject device-lost console error`);
      await page.evaluate(`console.error('THREE.WebGPURenderer: WebGPU Device Lost:\\n\\nMessage: probe.mjs test (no GPU fault)\\nReason: unknown'); true`).catch(() => null);
      page.close();
      page = null; // the shell parks the page on about:blank: re-attach to whatever comes next
      await sleep(900);
      const ts = await targets();
      summary.targetsAfterLoss = ts.map((x) => x.url);
      const sp = ts.find((x) => x.url.endsWith('splash.html'));
      const view = sp ? await cdp(sp.ws).catch(() => null) : null;
      summary.splashAfterLoss = view ? await view.evaluate(SPLASH_STATE).catch(() => null) : null;
      if (reloadAfter && view) {
        await sleep(reloadAfter);
        summary.splashBeforeReload = await view.evaluate(SPLASH_STATE).catch(() => null);
        summary.events.push(`${t()} press RELOAD`);
        await view.evaluate(`document.getElementById('b-reload').click(); true`).catch(() => null);
        reloaded = true;
      }
      view?.close();
      continue;
    }
    if (reloaded && !page) {
      const tgt = (await targets()).find((x) => x.url.startsWith(server));
      if (tgt) {
        page = await cdp(tgt.ws).catch(() => null);
        if (page) summary.events.push(`${t()} game page back: ${tgt.url}`);
      }
    }
    await sleep(page ? 250 : 300);
  }
  summary.targetsAtEnd = (await targets()).map((x) => x.url);
} catch (e) {
  summary.error = e instanceof Error ? e.message : String(e);
} finally {
  // close like a user would (the app quits cleanly and removes its marker); kill only if it does not go
  summary.closingAt = t();
  if (exited === null && !aborted) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(800) })).json();
      const b = await cdp(v.webSocketDebuggerUrl);
      void b.send('Browser.close');
      await sleep(200);
      b.close();
    } catch { /* already gone */ }
  }
  page?.close();
  for (let i = 0; i < 40 && exited === null; i++) await sleep(100);
  if (exited === null) { killTree(app?.pid); summary.killed = true; }
  summary.exitCode = exited;
  summary.endedAt = t();
  summary.appLifetimeMs = launchTs ? Date.now() - launchTs : 0;
  await sleep(1200); // one more nvlddmkm poll after the app is gone
  for (const c of mine) killTree(c.pid);
}

// ---------------------------------------------------------------- after: one more event check, logs, numbers
const after = psRun(`$e = Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='nvlddmkm'; StartTime=[datetime]::Parse('${startIso}')} -ErrorAction SilentlyContinue; if ($e) { $e | ForEach-Object { 'NVLDDMKM ' + $_.TimeCreated.ToString('o') + ' id=' + $_.Id } } else { 'none' }`);
summary.nvlddmkmAfter = after;
if (after !== 'none' && !summary.abort) summary.abort = `nvlddmkm event(s) after the test: ${after}`;

const logFile = join(userData, 'logs', 'desktop.log');
const logText = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
summary.log = logText.split(/\r?\n/).filter(Boolean).map((l) => l.slice(24, 420));
/** every file the run left in the profile's logs + the report + the marker must be free of the token */
const files = [reportFile, join(userData, 'running.json')];
if (existsSync(join(userData, 'logs'))) for (const f of readdirSync(join(userData, 'logs'))) files.push(join(userData, 'logs', f));
if (hostToken) {
  summary.checks.tokenInFiles = files.filter((f) => existsSync(f) && statSync(f).isFile() && readFileSync(f, 'utf8').includes(hostToken)).map((f) => f.replace(userData, '<profile>'));
  summary.checks.hostRightsOn = /host rights: on/.test(logText);
  summary.checks.clientHasToken = /host rights: the client has the host token/.test(logText);
  summary.checks.adminStoredInPage = summary.samples.some((/** @type {any} */ s) => s.admin === 'match');
  summary.checks.hostTab = summary.samples.some((/** @type {any} */ s) => s.hostTab);
  summary.checks.createCrew = summary.samples.some((/** @type {any} */ s) => s.createCrew);
  summary.checks.hashEverHadAdmin = summary.samples.some((/** @type {any} */ s) => s.hashHasAdmin);
}
summary.checks.reachedMenu = summary.samples.some((/** @type {any} */ s) => s.menu);
if (summary.targetsAfterReady) summary.checks.splashGoneAfterReady = !summary.targetsAfterReady.some((/** @type {string} */ u) => u.endsWith('splash.html'));
if (gpuLossAt) {
  const sp = summary.splashAfterLoss;
  summary.checks.parkedOnBlank = (summary.targetsAfterLoss ?? []).includes('about:blank') && !(summary.targetsAfterLoss ?? []).some((/** @type {string} */ u) => u.startsWith(server));
  summary.checks.errorScreen = !!sp && sp.error === true && sp.reload === true && sp.retry === false;
  summary.checks.errorScreenStatic = !!sp && sp.animations === 0 && (!summary.splashBeforeReload || summary.splashBeforeReload.animations === 0);
  summary.checks.gpuFailureLogged = /gpu: WebGPU device lost: the game page is stopped until RELOAD/.test(logText);
  if (reloadAfter) {
    summary.checks.reloadedToMenu = summary.samples.some((/** @type {any} */ s) => s.phase === 'reloaded' && s.menu);
    summary.checks.reloadUrlSafe = summary.samples.filter((/** @type {any} */ s) => s.phase === 'reloaded').every((/** @type {any} */ s) => !s.hashHasAdmin);
  }
}
summary.checks.markerRemovedOnQuit = !existsSync(join(userData, 'running.json'));
summary.checks.lastSample = summary.samples.at(-1) ?? null;
/** @param {number[]} xs */
const avg = (xs) => {
  const v = xs.filter(Number.isFinite);
  return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : null;
};
/** @param {number} tt */
const phaseOf = (tt) => (tt < (summary.launchedAt ?? 0) ? 'baseline'
  : summary.minimizedAt && tt >= summary.minimizedAt + 1500 ? (tt <= (summary.closingAt ?? Infinity) ? 'minimized' : 'closing')
  : summary.minimizedAt && tt >= summary.minimizedAt ? 'transition'
  : tt >= (summary.pageAt ?? Infinity) + 3000 ? (tt <= (summary.closingAt ?? Infinity) ? 'offscreen' : 'closing') : 'boot');
summary.gpuByPhase = {};
for (const ph of ['baseline', 'boot', 'offscreen', 'minimized']) {
  summary.gpuByPhase[ph] = {
    app3dPct: avg(summary.gpu.app3d.filter((/** @type {any} */ x) => phaseOf(x.t) === ph).map((/** @type {any} */ x) => x.pct)),
    totalUtil: avg(summary.gpu.smi.filter((/** @type {any} */ x) => phaseOf(x.t) === ph).map((/** @type {any} */ x) => x.util)),
    watts: avg(summary.gpu.smi.filter((/** @type {any} */ x) => phaseOf(x.t) === ph).map((/** @type {any} */ x) => x.watts)),
    raf: avg(summary.samples.filter((/** @type {any} */ x) => phaseOf(x.t) === ph).map((/** @type {any} */ x) => x.raf)),
    vis: [...new Set(summary.samples.filter((/** @type {any} */ x) => phaseOf(x.t) === ph).map((/** @type {any} */ x) => x.vis))].join('/'),
    n: summary.samples.filter((/** @type {any} */ x) => phaseOf(x.t) === ph).length,
  };
}
writeFileSync(join(outDir, 'probe-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
const compact = { ...summary, samples: `${summary.samples.length} samples`, gpu: `${summary.gpu.app3d.length} app3d / ${summary.gpu.smi.length} smi samples` };
console.log(JSON.stringify(compact, null, 2));
process.exitCode = summary.abort ? 2 : summary.error ? 1 : 0;
