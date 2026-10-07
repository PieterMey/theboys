// Smoke test for the desktop shell: launches DeadAir.exe (or the dev app), attaches over CDP, screenshots the loading
// screen and the game, checks WebGPU + the preload API, optionally Steam, then closes the app.
//
//   node apps/desktop/scripts/smoke.mjs --server http://127.0.0.1:3601 [--exe <DeadAir.exe> | --dev]
//     [--bundled] [--steam] [--steam-selftest] [--overlay] [--screen] [--crew CODE] [--profile NAME]
//     [--out DIR] [--hold MS] [--timeout MS] [--offscreen]
// The page gets ?test=1 (window.__game) and a fake microphone. Output: <out>/{splash,game,...}.png + summary.json.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';

const DESKTOP = resolve(import.meta.dirname, '..');
const require = createRequire(join(DESKTOP, 'package.json'));
const argv = process.argv.slice(2);
const flag = (/** @type {string} */ n) => argv.includes(`--${n}`);
const opt = (/** @type {string} */ n) => {
  const i = argv.indexOf(`--${n}`);
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${n}=`));
  return eq ? eq.slice(n.length + 3) : undefined;
};

const server = opt('server') ?? 'http://127.0.0.1:3601';
const outDir = resolve(opt('out') ?? join(DESKTOP, 'out/smoke'));
const profile = opt('profile') ?? 'smoke';
const timeout = Number(opt('timeout') ?? 120_000);
const hold = Number(opt('hold') ?? 1500);
const dev = flag('dev');
const exe = resolve(opt('exe') ?? join(DESKTOP, 'out/win-unpacked/DeadAir.exe'));
const port = 9300 + Math.floor(Math.random() * 600);
const reportFile = join(outDir, 'report.json');
mkdirSync(outDir, { recursive: true });
rmSync(reportFile, { force: true });

const appArgs = [
  `--remote-debugging-port=${port}`, `--profile=${profile}`, `--server=${server}`, '--url-query=test=1',
  `--report=${reportFile}`, '--windowed', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  flag('steam') || flag('steam-selftest') ? '--steam' : '--no-steam',
];
if (flag('bundled')) appArgs.push('--bundled');
// --offscreen: the window opens off every display, inactive and unfocusable (GPU tests next to someone's session;
// see scripts/probe.mjs for the 20 s, driver-event-watched variant)
if (flag('offscreen')) appArgs.push('--offscreen-window');
if (flag('steam-selftest')) appArgs.push('--steam-selftest');
if (flag('overlay')) appArgs.push('--steam-overlay');
if (opt('crew')) appArgs.push(`--crew=${opt('crew')}`);
// extra Chromium / shell switches for experiments, e.g. --extra "--enable-features=Foo --disable-features=Bar"
for (const a of (opt('extra') ?? '').split(/\s+/).filter(Boolean)) appArgs.push(a);

/** @type {[string, string[]]} */
const cmd = dev
  ? [join(resolve(require.resolve('electron/package.json'), '..'), 'dist/electron.exe'), [DESKTOP, ...appArgs]]
  : [exe, appArgs];
if (!existsSync(cmd[0])) throw new Error(`not found: ${cmd[0]}`);

const T0 = Date.now();
const t = () => Date.now() - T0;
/** @type {Record<string, any>} */
const summary = { exe: cmd[0], dev, server, args: appArgs.filter((a) => !a.startsWith('--report=')), shots: {}, timeline: {} };
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** @template T @param {() => Promise<T | undefined | null | false>} fn @param {number} ms @param {string} what @returns {Promise<T>} */
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch { /* retry */ }
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await sleep(100);
  }
}
const readReport = () => {
  try { return JSON.parse(readFileSync(reportFile, 'utf8')); } catch { return null; }
};

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; // set by VS Code / Claude Code terminals; makes electron.exe a plain Node (dev only:
// the packaged exe has the runAsNode fuse off)
const child = spawn(cmd[0], cmd[1], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false, env });
let stderr = '';
child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-20_000); });
child.stdout.on('data', () => {});
let exited = /** @type {number | null} */ (null);
child.on('exit', (c) => { exited = c ?? -1; });

/**
 * Minimal CDP client for one page target (Node's global WebSocket). The loading screen is driven through this, not
 * Playwright: Playwright's connectOverCDP waits for every page, and the game page is stalled while it compiles.
 * @param {string} wsUrl
 */
async function rawTarget(wsUrl) {
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
    ws.send(JSON.stringify({ id: n, method, params }));
    setTimeout(() => { if (waiting.delete(n)) res({ error: 'timeout' }); }, 5000);
  });
  /** @param {string} expression */
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))?.result?.result?.value;
  /** @param {string} file */
  const screenshot = async (file) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    if (!r?.result?.data) return false;
    writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    return true;
  };
  return { evaluate, screenshot, close: () => ws.close() };
}
const GAPS = `(() => { const g = window.__gaps ?? []; const s = [...g].sort((a, b) => a - b);
  return { frames: g.length, maxMs: Math.round(s[s.length - 1] ?? 0), p95Ms: Math.round(s[Math.floor(s.length * 0.95)] ?? 0),
    over50: g.filter((x) => x > 50).length, over100: g.filter((x) => x > 100).length,
    font: document.fonts.check('900 40px "Big Shoulders Stencil Display"') }; })()`;

try {
  await until(async () => (await fetch(`http://127.0.0.1:${port}/json/version`)).ok, 30_000, 'CDP endpoint');
  summary.timeline.cdp = t();
  // the loading screen, as early as possible (raw CDP)
  /** @type {Awaited<ReturnType<typeof rawTarget>> | null} */
  let splash = null;
  try {
    const target = await until(async () => {
      const list = /** @type {{ type: string, url: string, webSocketDebuggerUrl: string }[]} */ (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json());
      return list.find((x) => x.type === 'page' && x.url.endsWith('splash.html'));
    }, 15_000, 'splash target');
    splash = await rawTarget(target.webSocketDebuggerUrl);
    await splash.evaluate(`(() => { window.__gaps = []; let last = 0; const f = (now) => { if (last) window.__gaps.push(now - last); last = now; requestAnimationFrame(f); }; requestAnimationFrame(f); return true; })()`);
    await sleep(400);
    if (await splash.screenshot(join(outDir, 'splash.png'))) summary.shots.splash = t();
  } catch (e) {
    summary.splashError = e instanceof Error ? e.message : String(e);
  }
  /** frame pacing of the loading screen itself while the game warms up underneath */
  const splashStats = async () => (splash ? splash.evaluate(GAPS).catch(() => null) : null);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 120_000 });
  summary.timeline.playwright = t();
  const pages = () => browser.contexts().flatMap((c) => c.pages());
  const isGame = (/** @type {import('playwright-core').Page} */ p) => !p.url().startsWith('devtools:') && (p.url().startsWith(server) || /^http:\/\/127\.0\.0\.1:43\d{3}\//.test(p.url()));
  const game = await until(async () => pages().find(isGame), 30_000, 'game page');
  summary.timeline.gamePage = t();
  // filmstrip of what the game page shows UNDER the loading screen (what a player would see without it)
  const strip = [];
  for (let i = 0; i < (flag('no-strip') ? 0 : 8); i++) {
    const r = readReport();
    if (r?.timings?.ready) break;
    const f = join(outDir, `under-${i}.png`);
    const ok = await game.screenshot({ path: f, timeout: 4000 }).then(() => true, () => false);
    strip.push({ file: ok ? f : null, t: t(), note: ok ? 'captured' : 'page too busy to capture (main thread / GPU stalled)' });
    summary.splashFrames = (await splashStats()) ?? summary.splashFrames;
    await sleep(700);
  }
  summary.under = strip;
  if (splash && !readReport()?.timings?.ready) await splash.screenshot(join(outDir, 'splash-late.png')).catch(() => false);
  const rep = await until(async () => {
    const r = readReport();
    if (!r?.timings?.ready) summary.splashFrames = (await splashStats()) ?? summary.splashFrames;
    return r?.timings?.ready ? r : null;
  }, timeout, 'shell ready (loading screen hidden)');
  summary.timeline.shellReady = t();
  try { splash?.close(); } catch { /* closed with the view */ }
  await until(() => game.evaluate(() => /** @type {any} */ (window).__game?.ready?.() === true), timeout, '__game.ready()');
  summary.timeline.gameReady = t();
  await sleep(hold);
  await game.screenshot({ path: join(outDir, 'game.png') });
  summary.shots.game = t();
  summary.page = await game.evaluate(async () => {
    const w = /** @type {any} */ (window);
    const d = w.deadAirDesktop;
    let adapter = null;
    try {
      const a = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
      adapter = a ? { vendor: a.info?.vendor, architecture: a.info?.architecture, description: a.info?.description, f16: a.features.has('shader-f16') } : null;
    } catch (e) { adapter = String(e); }
    return {
      url: location.href.split('#')[0],
      backend: w.__game?.backend?.(),
      perf: w.__game?.perf?.(),
      errors: (w.__game?.errors?.() ?? []).slice(0, 10),
      screen: w.__game?.state?.().screen,
      menu: !!document.querySelector('[data-testid="main-menu"]'),
      visibility: document.visibilityState,
      secure: isSecureContext,
      userAgent: navigator.userAgent,
      adapter,
      desktop: d ? { version: d.version, mode: d.mode, electron: d.electron, chrome: d.chrome, steam: { available: d.steam.available, personaName: d.steam.personaName ? `(${d.steam.personaName.length} chars)` : null, appId: d.steam.appId, overlay: d.steam.overlay, fns: ['inviteFriends', 'setPresence'].filter((k) => typeof d.steam[k] === 'function') }, fns: Object.keys(d).filter((k) => typeof d[k] === 'function') } : null,
      nodeLeak: typeof w.require !== 'undefined' || typeof w.process !== 'undefined',
    };
  });
  if (flag('steam-selftest')) {
    await until(async () => readReport()?.steamSelftest, 20_000, 'steam selftest').catch(() => null);
  }
  if (flag('overlay') || flag('steam') || flag('steam-selftest')) {
    try {
      const pid = rep.pid;
      const mods = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).Modules | Where-Object { $_.ModuleName -match 'GameOverlayRenderer|steam_api|steamclient|d3d11|dxgi|dawn|vulkan' } | ForEach-Object { $_.ModuleName }`], { encoding: 'utf8' });
      summary.mainProcessModules = mods.split(/\r?\n/).filter(Boolean);
    } catch (e) {
      summary.mainProcessModules = String(e);
    }
  }
  if (flag('screen')) {
    // the composed window as DWM shows it (all views, plus anything hooked into the swap chain such as the Steam
    // overlay toast), captured with PrintWindow(PW_RENDERFULLCONTENT): ONLY this window, never other apps on screen
    const f = join(outDir, 'window.png');
    const ps = `Add-Type -AssemblyName System.Drawing; Add-Type @"
using System; using System.Runtime.InteropServices;
public class W { [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r); [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint f); [DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); public struct R { public int L, T, Rr, B; } }
"@; [void][W]::SetProcessDPIAware(); $p = Get-Process -Id ${rep.pid}; $h = $p.MainWindowHandle; $r = New-Object W+R; [W]::GetWindowRect($h, [ref]$r) | Out-Null; $bmp = New-Object System.Drawing.Bitmap ($r.Rr - $r.L), ($r.B - $r.T); $g = [System.Drawing.Graphics]::FromImage($bmp); $hdc = $g.GetHdc(); $ok = [W]::PrintWindow($h, $hdc, 2); $g.ReleaseHdc($hdc); $bmp.Save('${f.replace(/\\/g, '/')}'); "ok=$ok $($r.Rr - $r.L)x$($r.B - $r.T)"`;
    try {
      summary.screen = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
      summary.shots.screen = t();
    } catch (e) {
      summary.screen = String(e).slice(0, 300);
    }
  }
  summary.report = readReport();
  // close like a user would (all windows closed -> app quits)
  const cdp = await browser.newBrowserCDPSession();
  // the reply never arrives when the app quits first: do not wait on it
  await Promise.race([cdp.send('Browser.close').catch(() => {}), sleep(3000)]);
} catch (e) {
  summary.error = e instanceof Error ? e.message : String(e);
  summary.report ??= readReport();
} finally {
  await until(async () => exited !== null, 8000, 'app exit').catch(() => {
    try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
    summary.killed = true;
  });
  summary.exitCode = exited;
  if (summary.error) summary.stderr = stderr.slice(-4000);
  writeFileSync(join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  process.exitCode = summary.error ? 1 : 0;
}
