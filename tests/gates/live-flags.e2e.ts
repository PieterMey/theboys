// Gate (integrator): a server flag switch reaches the client at its next page load, without a client rebuild.
// The client merges the server's live flags (/healthz `flags`) over its build-time copy BEFORE the tracks install
// (apps/client/src/core/flags.ts + main.ts), so install-time kill switches (paranormal, mirrors, fieldGuide,
// containers) follow the server. One browser; the dev server runs OUTSIDE the GPU guard (CLAUDE.md v1.2):
//   NODE_ENV=development AI_MODE=mock SAVES_DIR=<scratch>/saves SESSION_FILE=<scratch>/session.json PORT=<p> \
//     node apps/server/src/index.ts --dev
//   BASE_URL=http://127.0.0.1:<p> node tools/gpu-guard.mjs --max-sec 120 -- node tests/gates/live-flags.e2e.ts
// Checks: with paranormal/mirrors/fieldGuide switched off in memory (dbg.setFlags) the page boots with
// diag.flags.source 'server', those 3 listed as changed and the paranormal client not installed; after
// dbg.reloadConfig (back to config/flags.json) a page reload installs it again with nothing changed. Exit 0 = all pass.
import { launchPlayer } from '../lib/launch.ts';
import type { Player } from '../lib/launch.ts';
import { Bot, sleep } from './p-lib.ts';

const BASE = (process.env.BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3897}`).replace(/\/$/, '');
const OFF = ['paranormal', 'mirrors', 'fieldGuide'];
let fails = 0;
const check = (name: string, ok: boolean, info: unknown = '') => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info === '' ? '' : `  (${typeof info === 'string' ? info : JSON.stringify(info)})`}`);
};

interface Diag { flags?: { source: string; changed: string[] }; paranormal?: unknown; renderPreset?: string }
type W = { __game?: { perf(): { fps: number }; state(): { diag: unknown } }; __flagsOld?: boolean };
/** the client's diag once every track installed (the loop runs after the last install: fps > 0), on a page that is
 *  not the one marked old. Other builders' edits make Vite reload the page at any time (dev server): just wait. */
async function bootedDiag(p: Player, ms = 60_000): Promise<Diag | null> {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    try {
      await p.page.waitForFunction(() => {
        const w = window as unknown as W;
        return !w.__flagsOld && !!w.__game && w.__game.perf().fps > 0;
      }, undefined, { timeout: Math.max(1000, end - performance.now()), polling: 250 });
      return await p.page.evaluate(() => (window as unknown as W).__game!.state().diag as Diag);
    } catch { await sleep(250); } // navigation in flight (context destroyed): retry until the deadline
  }
  return null;
}

const t0 = performance.now();
const healthz = (await (await fetch(`${BASE}/healthz`)).json()) as { ok: boolean; flags?: Record<string, boolean> };
check('server /healthz carries the live flags', !!healthz.flags && typeof healthz.flags.paranormal === 'boolean', Object.keys(healthz.flags ?? {}).length);
if (!healthz.flags) process.exit(1);

const bot = new Bot('Flags-Bot');
await bot.connect(`${BASE.replace(/^http/, 'ws')}/ws`, 'FLGZ');
let p: Player | null = null;
try {
  const set = await bot.dbg<{ applied: Record<string, boolean> }>('setFlags', { set: Object.fromEntries(OFF.map((k) => [k, false])) });
  check('dbg.setFlags switches the flags off in memory', OFF.every((k) => set.applied[k] === false), set.applied);
  const h1 = (await (await fetch(`${BASE}/healthz`)).json()) as { flags: Record<string, boolean> };
  check('/healthz follows at once', OFF.every((k) => h1.flags[k] === false));

  p = await launchPlayer({ name: 'Flags', baseUrl: BASE });
  const a = await bootedDiag(p);
  check('client booted (loop running)', !!a, a?.renderPreset ?? 'timeout');
  check("client flags came from the server (diag.flags.source 'server')", a?.flags?.source === 'server', a?.flags);
  check('the 3 switched flags are listed as server overrides', OFF.every((k) => a?.flags?.changed.includes(k)), a?.flags?.changed);
  check('paranormal client NOT installed (install-time kill switch honoured)', !!a && a.paranormal === undefined);

  await bot.dbg('reloadConfig');
  await p.page.evaluate(() => { (window as unknown as W).__flagsOld = true; });
  await p.page.reload({ waitUntil: 'domcontentloaded' }).catch((e: unknown) => console.log(`(reload: ${String(e).split(/\r?\n/)[0]}; waiting for the new page)`));
  const b = await bootedDiag(p);
  check('after dbg.reloadConfig + page reload: no overrides', !!b && b.flags?.source === 'server' && (b.flags?.changed.length ?? -1) === 0, b?.flags);
  check('after the reload the paranormal client is installed again', !!b && b.paranormal !== undefined && b.paranormal !== null);
  const flagErrors = p.errors.filter((e) => /healthz|\[flags\]/i.test(e));
  check('no errors from the flags fetch', flagErrors.length === 0, flagErrors.slice(0, 3));
} catch (e) {
  check('run', false, e instanceof Error ? e.message : String(e));
} finally {
  try { await bot.dbg('reloadConfig'); } catch { /* server gone */ }
  bot.close();
  await p?.close();
}
console.log(`${fails ? 'FAILED' : 'OK'}: live flags e2e, ${fails} failing check(s), ${((performance.now() - t0) / 1000).toFixed(1)} s`);
await sleep(100);
process.exit(fails ? 1 : 0);
