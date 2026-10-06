// Robustness playtest helpers (scenario: chaotic friend group). Own dev server on :3205, HMR-proof pages,
// CDP screenshots, server log capture. Report-only: never touches apps/, packages/, config/, tools/, services/.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { appendFileSync, createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { REPO, launchPlayer } from '../../lib/launch.ts';
import type { Player } from '../../lib/launch.ts';

export const PORT = 3205;
export const BASE = `http://127.0.0.1:${PORT}`;
export const WS = `ws://127.0.0.1:${PORT}/ws`;
export const OUT = join(REPO, 'tests/playtest/robustness');
export const SHOTS = join(OUT, 'shots');
export const TMP = 'C:/Users/Pieter/AppData/Local/Temp/dead-air-playtest-3205';
export const CREW = 'RBST';
mkdirSync(SHOTS, { recursive: true });

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LOG = join(OUT, 'run.log');
export function note(...a: unknown[]): void {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
  console.log(line);
  appendFileSync(LOG, line + '\n');
}

// ---------------------------------------------------------------- server
export interface Srv { proc: ChildProcess; pid: number; stop(): Promise<void> }
export async function startServer(tag: string): Promise<Srv> {
  const out = createWriteStream(join(OUT, 'server.log'), { flags: 'a' });
  out.write(`\n===== server start (${tag}) ${new Date().toISOString()} =====\n`);
  const proc = spawn(process.execPath, ['--env-file-if-exists=C:/Users/Pieter/repos/theboys/.env', 'apps/server/src/index.ts', '--dev'], {
    cwd: REPO,
    env: {
      ...process.env, PORT: String(PORT), SAVES_DIR: TMP, SESSION_FILE: `${TMP}/session.json`, HOST_CREW: CREW,
      AI_MODE: 'mock', NODE_ENV: 'development',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout?.pipe(out, { end: false });
  proc.stderr?.pipe(out, { end: false });
  writeFileSync(join(OUT, 'server.pid'), String(proc.pid));
  for (let i = 0; i < 160; i++) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) break;
    } catch { /* booting */ }
    await sleep(250);
  }
  note(`server up pid ${proc.pid} (${tag})`);
  return {
    proc, pid: proc.pid!,
    stop: () => new Promise<void>((res) => {
      if (proc.exitCode !== null) return res();
      proc.once('exit', () => res());
      // hard kill (like a crash / taskkill /F): what a mid-contract restart looks like to the clients
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    }),
  };
}

// ---------------------------------------------------------------- browsers
export interface P extends Player { name: string }
export async function chrome(name: string, wav = 'silence.wav', query: Record<string, string> = {}, crew: string = CREW): Promise<P> {
  const p = await launchPlayer({ name, wav, baseUrl: BASE, crew, query: { nobright: '1', ...query }, viewport: { width: 1600, height: 900 } });
  // other agents edit files all night: swallow Vite's HMR socket so the page never full-reloads mid-run
  await p.page.routeWebSocket(/token=/, () => {});
  await p.page.reload({ waitUntil: 'domcontentloaded' });
  return Object.assign(p, { name });
}

export async function waitReady(page: Page, ms = 60_000): Promise<void> {
  await page.waitForFunction(() => window.__game?.ready() === true, undefined, { timeout: ms, polling: 200 });
}

/** real UI join: click JOIN CREW on the Join screen (name + code are prefilled from storage + URL hash) */
export async function uiJoin(p: P, ms = 60_000): Promise<void> {
  const btn = p.page.locator('button:has-text("JOIN CREW")');
  await btn.waitFor({ state: 'visible', timeout: ms });
  await btn.click();
  await p.page.waitForFunction(() => window.__game?.me() != null, undefined, { timeout: ms, polling: 200 });
}

export async function st<T = Record<string, any>>(page: Page): Promise<T> {
  return page.evaluate(() => window.__game!.state()) as Promise<T>;
}
export async function dbg<T = any>(page: Page, r: string, a: unknown = {}): Promise<T> {
  return page.evaluate(([r, a]) => window.__game!.dbg(r as string, a), [r, a] as const) as Promise<T>;
}
export async function req<T = any>(page: Page, r: string, a: unknown = {}): Promise<T> {
  return page.evaluate(([r, a]) => window.__game!.req!(r as string, a), [r, a] as const) as Promise<T>;
}
export async function screen(page: Page): Promise<string> {
  return page.evaluate(() => (window.__game!.state() as { screen: string }).screen);
}

export async function shot(page: Page, name: string): Promise<string> {
  const p = join(SHOTS, `${name}.png`);
  const cdp = await page.context().newCDPSession(page);
  try {
    const r = (await Promise.race([
      cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('cdp capture timeout')), 45_000)),
    ])) as { data: string };
    writeFileSync(p, Buffer.from(r.data, 'base64'));
  } catch (e) {
    note(`screenshot ${name} failed: ${e instanceof Error ? e.message : e}`);
  } finally {
    await cdp.detach().catch(() => {});
  }
  return p;
}

/** hold a key for ms (real keyboard input) */
export async function hold(page: Page, key: string, ms: number): Promise<void> {
  await page.keyboard.down(key);
  await sleep(ms);
  await page.keyboard.up(key);
}

/** visible text of toasts / notices currently on screen */
export async function toasts(page: Page): Promise<string[]> {
  return page.evaluate(() => [...document.querySelectorAll('.toast, [class*="toast"], [class*="notice"]')].map((e) => (e.textContent ?? '').trim()).filter(Boolean));
}

export async function errorsOf(p: P): Promise<string[]> {
  const inPage = await p.page.evaluate(() => window.__game?.errors() ?? []).catch(() => [] as string[]);
  return [...p.errors, ...inPage.map((e) => `game: ${e}`)];
}
