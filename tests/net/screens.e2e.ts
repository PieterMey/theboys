// Track ① Net e2e: error screens in a real Chrome against a prod server (free port, HOST_CREW pinned crew):
//  1. the host (admin bot) kicks the browser player -> 'DISCONNECTED' screen
//  2. after a rebuild + server restart the reconnecting page gets stale_build -> 'NEW VERSION / RELOAD' screen,
//     and RELOAD brings it back into the same crew with the same player id.
// Run: node tests/net/screens.e2e.ts   (screenshots in tests/artifacts/net/)
import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { launchPlayer, screenshot } from '../lib/launch.ts';
import { Bot } from './bot.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const ADMIN = randomBytes(12).toString('hex');
const CREW = 'SCRN';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const port = await new Promise<number>((res) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
const BASE = `http://127.0.0.1:${port}`;
let pass = 0, fail = 0;
const check = (n: string, ok: boolean, info = '') => { ok ? pass++ : fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${info ? `  (${info})` : ''}`); };

async function start(): Promise<ChildProcess> {
  const c = spawn(process.execPath, ['apps/server/src/index.ts', '--prod'], { cwd: ROOT, env: { ...process.env, PORT: String(port), NODE_ENV: 'production', ADMIN_TOKEN: ADMIN, HOST_CREW: CREW, NET_SESSION: '0' }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) return c; } catch { /* */ } await sleep(150); }
  throw new Error('server down');
}
const stop = async (c: ChildProcess) => { const d = new Promise((r) => c.once('exit', r)); c.kill(); await Promise.race([d, sleep(4000)]); };

let srv = await start();
const p = await launchPlayer({ name: 'Kim', baseUrl: BASE, crew: CREW, query: { autojoin: '1' } });
try {
  await p.page.waitForFunction(() => window.__game?.me() != null, undefined, { timeout: 30_000 });
  const me = await p.page.evaluate(() => window.__game!.me());
  check('browser joined the pinned host crew in prod', !!me);
  const host = new Bot({ url: `ws://127.0.0.1:${port}/ws`, name: 'Host', crew: CREW, admin: ADMIN });
  await host.connect();
  await host.req('crew.kick', { id: me });
  await p.page.waitForSelector('[data-testid=net-error][data-code=kicked]', { timeout: 5000 }).then(() => check('kicked -> DISCONNECTED screen', true), () => check('kicked -> DISCONNECTED screen', false));
  await screenshot(p.page, 'tests/artifacts/net/screen-kicked.png');
  host.close();

  // back in: reload, rejoin, then rebuild + restart => stale build prompt
  await p.page.reload({ waitUntil: 'domcontentloaded' });
  await p.page.waitForFunction(() => window.__game?.me() != null, undefined, { timeout: 30_000 });
  const me2 = await p.page.evaluate(() => window.__game!.me());
  check('rejoin after reload keeps the player id', me2 === me);
  const b = spawnSync('npm run build', { cwd: ROOT, shell: true, stdio: 'ignore' });
  check('rebuild', b.status === 0);
  await stop(srv);
  srv = await start();
  await p.page.waitForSelector('[data-testid=net-error][data-code=stale_build]', { timeout: 15_000 }).then(() => check('new build -> NEW VERSION / RELOAD screen', true), () => check('new build -> NEW VERSION / RELOAD screen', false));
  await screenshot(p.page, 'tests/artifacts/net/screen-stale.png');
  await Promise.all([p.page.waitForNavigation({ waitUntil: 'domcontentloaded' }), p.page.click('[data-testid=net-error] .btn.primary')]);
  await p.page.waitForFunction(() => window.__game?.me() != null, undefined, { timeout: 30_000 }).catch(() => {});
  const me3 = await p.page.evaluate(() => window.__game?.me() ?? null);
  check('RELOAD rejoins the same crew with the same id', me3 === me, String(me3));
  const errs = [...p.errors.filter((e) => !/stale_build|kicked|ERR_CONNECTION_REFUSED/.test(e)), ...(await p.page.evaluate(() => window.__game!.errors()))];
  check('no unexpected console errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
  check('screens e2e', false, e instanceof Error ? e.message.split('\n')[0] : String(e));
} finally {
  await p.close();
  await stop(srv);
}
console.log(`\nscreens.e2e: ${fail ? 'FAIL' : 'PASS'} (${pass} pass, ${fail} fail)`);
process.exitCode = fail ? 1 : 0;
setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
