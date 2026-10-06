// Owner: track (a) Objectives. Test helper: reuse a running dev server on PORT (default 3011) or spawn one.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');

export interface TestServer { base: string; ws: string; log(): string; stop(): void }

export async function ensureServer(port = Number(process.env.PORT ?? 3011)): Promise<TestServer> {
  const base = process.env.BASE_URL ?? `http://127.0.0.1:${port}`;
  const up = async () => { try { return (await fetch(`${base}/healthz`)).ok; } catch { return false; } };
  let child: ChildProcess | null = null;
  let out = '';
  if (!(await up())) {
    child = spawn(process.execPath, ['--env-file-if-exists=C:/Users/Pieter/repos/theboys/.env', 'apps/server/src/index.ts', '--dev'], {
      cwd: ROOT, env: { ...process.env, PORT: String(port), NODE_ENV: 'development', AI_MODE: 'mock' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (d: Buffer) => { out += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { out += d.toString(); });
    const t0 = Date.now();
    while (Date.now() - t0 < 40_000 && !(await up())) await new Promise((r) => setTimeout(r, 200));
    if (!(await up())) throw new Error('server did not come up:\n' + out.split('\n').slice(-30).join('\n'));
  }
  return { base, ws: base.replace(/^http/, 'ws') + '/ws', log: () => out, stop: () => child?.kill() };
}
