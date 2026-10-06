// DEAD AIR game server entry (integrator-owned).
//   npm run dev       -> --dev  (NODE_ENV=development: Vite middleware + HMR, dbg.* requests, auto-created crews)
//   npm run preview   -> --prod (serves apps/client/dist + .assets/dist; unknown crews need the admin token)
//   npm run selftest  -> --selftest (random port, 2 ws clients, exit code)
// Run: node --env-file=C:\Users\Pieter\repos\theboys\.env apps/server/src/index.ts [--dev|--prod|--selftest]
import type { Mode } from './core/config.ts';
import type { TrackInstall } from './core/boot.ts';
import { boot } from './core/boot.ts';
import { runSelftest } from './core/selftest.ts';
import { makeLogger } from './core/log.ts';
import { install as net } from './net/index.ts';
import { install as level } from './level/index.ts';
import { install as players } from './players/index.ts';
import { install as voice } from './voice/index.ts';
import { install as objectives } from './objectives/index.ts';
import { install as interaction } from './interaction/index.ts';
import { install as monsters } from './monsters/index.ts';
import { install as meta } from './meta/index.ts';
import { install as safes } from './safes/index.ts';
import { install as ai } from './ai/index.ts';

// .env aliases: the host's .env uses the Cloudflare dashboard's names for the TURN key (Token ID + API token)
if (!process.env.CF_TURN_KEY_ID && process.env.CLOUDFLARE_TURN_TOKEN_ID) process.env.CF_TURN_KEY_ID = process.env.CLOUDFLARE_TURN_TOKEN_ID;
if (!process.env.CF_TURN_API_TOKEN && process.env.CLOUDFLARE_TURN_KEY) process.env.CF_TURN_API_TOKEN = process.env.CLOUDFLARE_TURN_KEY;

/** Install order = dependency order. Tracks must not rely on later tracks at install time. */
const TRACKS: [string, TrackInstall][] = [
  ['net', net], ['level', level], ['players', players], ['voice', voice], ['objectives', objectives],
  ['interaction', interaction], ['monsters', monsters], ['meta', meta], ['safes', safes], ['ai', ai],
];

const args = process.argv.slice(2);

if (args.includes('--selftest')) {
  await runSelftest(TRACKS);
} else {
  const envMode = process.env.NODE_ENV;
  const mode: Mode = args.includes('--dev') ? 'development' : args.includes('--prod') ? 'production'
    : envMode === 'development' || envMode === 'test' ? envMode : 'production';
  process.env.NODE_ENV = mode;
  const log = makeLogger('server');
  const srv = await boot({ mode, tracks: TRACKS });
  const env = srv.ctx.env;
  log.info(`DEAD AIR server (${mode}) on http://${env.HOST}:${srv.port}  ws: /ws  AI_MODE=${env.AI_MODE}  STT_URL=${env.STT_URL}`);
  if (process.env.ADMIN_TOKEN) log.info('admin token: (from env ADMIN_TOKEN)');
  else log.info(`admin token: ${env.ADMIN_TOKEN}  (host tab: http://127.0.0.1:${srv.port}/#admin=${env.ADMIN_TOKEN})`);
  if (srv.installErrors.length) log.error(`${srv.installErrors.length} track install(s) failed; see above`);
  process.on('SIGHUP', () => srv.ctx.reloadConfig());
  const stop = async () => {
    log.info('shutting down');
    await srv.close();
    process.exitCode = 0;
    setTimeout(() => process.exit(0), 1000).unref(); // let sockets finish closing (libuv assert on Windows)
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}
