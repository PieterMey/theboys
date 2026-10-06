// Owner: track (a) Objectives. G2a-style e2e: boots the dev server on PORT (default 3011) unless BASE_URL points at a
// running one, then two ws bots finish a 3-minute contract with monsters off (tests/bots/contract-bot.ts).
//   node tests/objectives/contract.e2e.ts [--seed s1] [--fixture facility_s1_p2] [--keep]
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { runContractBot } from '../bots/contract-bot.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const PORT = Number(process.env.PORT ?? 3011);
const BASE = process.env.BASE_URL ?? `http://127.0.0.1:${PORT}`;

async function up(): Promise<boolean> {
  try { return (await fetch(`${BASE}/healthz`)).ok; } catch { return false; }
}

let server: ChildProcess | null = null;
let serverLog = '';
if (!(await up())) {
  server = spawn(process.execPath, ['--env-file-if-exists=C:/Users/Pieter/repos/theboys/.env', 'apps/server/src/index.ts', '--dev'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', AI_MODE: 'mock' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (d: Buffer) => { serverLog += d.toString(); });
  server.stderr?.on('data', (d: Buffer) => { serverLog += d.toString(); });
  const t0 = Date.now();
  while (Date.now() - t0 < 30_000 && !(await up())) await new Promise((r) => setTimeout(r, 200));
  if (!(await up())) {
    console.error('server did not come up:\n' + serverLog.split('\n').slice(-40).join('\n'));
    server.kill();
    process.exit(1);
  }
}

const runs = Number(arg('runs') ?? 1);
let allOk = true;
let rep = null as Awaited<ReturnType<typeof runContractBot>> | null;
for (let i = 0; i < runs; i++) {
  rep = await runContractBot({
    url: BASE.replace(/^http/, 'ws') + '/ws',
    seed: arg('seed'),
    fixture: arg('fixture'),
    realSec: Number(arg('realSec') ?? 180),
    log: runs > 1 ? () => {} : undefined,
  });
  allOk &&= rep.ok;
  console.log(JSON.stringify({ run: i + 1, ok: rep.ok, crew: rep.crew, seed: rep.seed, hauled: rep.hauled, saveHasHaul: rep.saveHasHaul, ms: rep.ms, error: rep.error }, null, runs > 1 ? 0 : 2));
  if (runs === 1 || !rep.ok) for (const s of rep.steps) console.log(`${s.ok ? 'PASS' : 'FAIL'}  ${s.name}  ${s.ms} ms  ${s.info ?? ''}`);
}
const errs = serverLog.split('\n').filter((l) => /ERROR|WARN|threw/.test(l));
if (errs.length) console.log(`server warnings/errors (${errs.length}):\n` + errs.slice(-25).join('\n'));
if (process.argv.includes('--log')) console.log(serverLog.split('\n').filter((l) => /objectives|ERROR|WARN|interaction|monsters|meta|died|kill|dead/.test(l)).join('\n'));
if (server && !process.argv.includes('--keep')) server.kill();
process.exitCode = allOk ? 0 : 1;
setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
