#!/usr/bin/env node
// GPU guard (integrator). EVERY test that drives a browser or the desktop app (headless or not) runs through this,
// because the host's RTX 5090 has a GPU-side PCIe fault (driver-logged SRAM ECC errors -> TDR -> BSOD):
//   node tools/gpu-guard.mjs [--max-sec 30] [--wait-sec 900] [--label text] -- <command> [args...]
// - one GPU job at a time across ALL agents: a global lock directory (%TEMP%\dead-air-gpu.lock, atomic mkdir);
//   others wait (default up to 15 min) and print who holds it; a stale lock (dead owner / past its deadline) is taken
// - refuses to start within 10 min of any nvlddmkm driver event (cool-down after an incident), exit 98
// - kills the whole command tree on the first new nvlddmkm event (exit 99) or at --max-sec (default 30, max 120)
// Exit code = the command's, or 97 (lock wait timed out), 98 (cool-down), 99 (driver event), 124 (time limit).
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep < 0 || sep === argv.length - 1) {
  console.error('usage: node tools/gpu-guard.mjs [--max-sec 30] [--wait-sec 900] [--label text] -- <command> [args...]');
  process.exit(2);
}
const opts = argv.slice(0, sep);
const cmd = argv.slice(sep + 1);
const opt = (name, def) => {
  const i = opts.indexOf(`--${name}`);
  return i >= 0 && opts[i + 1] !== undefined ? opts[i + 1] : def;
};
const maxSec = Math.min(120, Math.max(1, Number(opt('max-sec', 30)) || 30));
const waitSec = Math.max(0, Number(opt('wait-sec', 900)) || 0);
const label = String(opt('label', cmd.join(' '))).slice(0, 160);
const COOLDOWN_MIN = 10;
const LOCK = join(tmpdir(), 'dead-air-gpu.lock');
const say = (...a) => console.error('[gpu-guard]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** count of nvlddmkm (NVIDIA driver) events in the System log since `since` */
function driverEventsSince(since) {
  const r = spawnSync('powershell', ['-NoProfile', '-Command',
    `@(Get-WinEvent -FilterHashtable @{LogName='System'; ProviderName='nvlddmkm'; StartTime=[datetime]'${since.toISOString()}'} -ErrorAction SilentlyContinue).Count`,
  ], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  return Number(String(r.stdout ?? '0').trim()) || 0;
}

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function readOwner() {
  try { return JSON.parse(readFileSync(join(LOCK, 'owner.json'), 'utf8')); } catch { return null; }
}

async function acquire() {
  const t0 = Date.now();
  let lastMsg = 0;
  for (;;) {
    try {
      mkdirSync(LOCK);
      writeFileSync(join(LOCK, 'owner.json'), JSON.stringify({ pid: process.pid, label, started: new Date().toISOString(), deadline: Date.now() + (maxSec + 30) * 1000 }));
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const o = readOwner();
    if (!o || !pidAlive(o.pid) || Date.now() > Number(o.deadline ?? 0)) {
      say(`taking a stale lock${o ? ` (pid ${o.pid}, '${o.label}')` : ''}`);
      try { rmSync(LOCK, { recursive: true, force: true }); } catch { /* raced */ }
      continue;
    }
    if (Date.now() - t0 > waitSec * 1000) return false;
    if (Date.now() - lastMsg > 15000) { lastMsg = Date.now(); say(`waiting for the GPU: held by pid ${o.pid} '${o.label}' since ${o.started}`); }
    await sleep(1000);
  }
}

function release() {
  const o = readOwner();
  if (o && o.pid === process.pid) { try { rmSync(LOCK, { recursive: true, force: true }); } catch { /* gone */ } }
}

function killTree(pid) {
  if (pid) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
}

const recent = driverEventsSince(new Date(Date.now() - COOLDOWN_MIN * 60_000));
if (recent > 0) {
  say(`REFUSED: ${recent} NVIDIA driver event(s) in the last ${COOLDOWN_MIN} min; the GPU needs a cool-down. Tell the integrator; do not retry in a loop.`);
  process.exit(98);
}
if (!(await acquire())) {
  say(`gave up waiting ${waitSec} s for the GPU lock (held by ${JSON.stringify(readOwner())})`);
  process.exit(97);
}
const start = new Date();
let outcome = null;
// HARDWARE GPU POLICY: since the 2026-10-08 00:50 crash (a guarded agent test set off the GPU fault and the PC
// bugchecked anyway), agent tests run in SOFTWARE rendering only. The child gets DEADAIR_RENDER=swiftshader
// (tests/lib/launch.ts then adds --disable-gpu --use-angle=swiftshader --enable-unsafe-swiftshader, ?webgl=1,
// ?preset=low), and a watchdog kills the run (exit 95) if any process in its tree uses the NVIDIA 3D engine.
// Only the integrator, with the user's explicit OK, sets DEADAIR_HW_GPU_OK=1 for a real-GPU pass.
const hardware = process.env.DEADAIR_HW_GPU_OK === '1';
const childEnv = { ...process.env };
if (!hardware) {
  childEnv.DEADAIR_RENDER = 'swiftshader';
  say(`SOFTWARE RENDERING ONLY (hardware GPU is off for agent tests since the 00:50 crash). Launch Chrome with --disable-gpu --use-angle=swiftshader --enable-unsafe-swiftshader and ?webgl=1&preset=low (tests/lib/launch.ts does this when DEADAIR_RENDER=swiftshader). Judge layout and logic, not lighting quality or perf; never launch the desktop app. Any NVIDIA 3D-engine use kills the run (exit 95).`);
}
const needsShell = process.platform === 'win32' && (/\.(cmd|bat)$/i.test(cmd[0]) || /^(npm|npx|pnpm|yarn)$/i.test(cmd[0]));
const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', shell: needsShell, env: childEnv });
const onSignal = () => { killTree(child.pid); release(); process.exit(130); };
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);
const deadline = setTimeout(() => { outcome = 124; say(`time limit ${maxSec} s reached: stopping '${label}'`); killTree(child.pid); }, maxSec * 1000);

/** NVIDIA 3D-engine utilisation (%) summed over the child's process tree (Windows GPU Engine counters) */
function treeGpu3d(rootPid) {
  const ps = `$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId; $tree = @{ ${rootPid} = $true }; ` +
    `do { $n = $tree.Count; foreach ($p in $all) { if ($tree.ContainsKey([int]$p.ParentProcessId)) { $tree[[int]$p.ProcessId] = $true } } } while ($tree.Count -gt $n); ` +
    `$sum = 0; foreach ($s in (Get-Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage' -ErrorAction SilentlyContinue).CounterSamples) { if ($s.InstanceName -match '^pid_(\\d+)_' -and $tree.ContainsKey([int]$Matches[1])) { $sum += $s.CookedValue } }; [math]::Round($sum, 1)`;
  const r = spawnSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  return Number(String(r.stdout ?? '0').trim().split(/\s+/).pop()) || 0;
}
let hotSamples = 0;
const watch = setInterval(() => {
  if (outcome !== null) return;
  const n = driverEventsSince(start);
  if (n > 0) {
    outcome = 99;
    say(`ABORT: ${n} NVIDIA driver event(s) during '${label}': killed it. Do not retry; report it to the integrator.`);
    killTree(child.pid);
    return;
  }
  if (!hardware) {
    const g = treeGpu3d(child.pid);
    hotSamples = g > 5 ? hotSamples + 1 : 0;
    if (hotSamples >= 2) {
      outcome = 95;
      say(`ABORT: '${label}' used the NVIDIA GPU (${g}% of the 3D engine) while hardware rendering is off: killed it. Launch Chrome in the software lane (see above) and re-run once.`);
      killTree(child.pid);
    }
  }
}, 3000);
child.on('exit', (code) => {
  clearTimeout(deadline);
  clearInterval(watch);
  const late = outcome === null ? driverEventsSince(start) : 0;
  release();
  if (late > 0) { say(`ABORT (after exit): ${late} NVIDIA driver event(s) during '${label}'.`); process.exit(99); }
  process.exit(outcome ?? code ?? 0);
});
child.on('error', (e) => { clearTimeout(deadline); clearInterval(watch); release(); say(`could not start: ${e.message}`); process.exit(2); });
