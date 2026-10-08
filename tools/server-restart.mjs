#!/usr/bin/env node
// Restart ONLY the game server (track ① Net). Never touches cloudflared or the STT sidecar, so the invite link
// stays the same; clients reconnect on their own and land back in the van (saves/session.json restore).
//   node tools/server-restart.mjs            restart with the current build
//   node tools/server-restart.mjs --build    npm run build first (clients get a 'new version: reload' prompt)
// Holds the restart lock (saves/host.restart.lock, see tools/host.mjs) from start to finish, so the hang watchdog in
// the `npm run host` window never restarts the server at the same time; it waits (60 s max) while the watchdog is
// mid-restart. The new server is recorded as started by this flow, so the watchdog covers it (and re-arms if it
// had given up).
import { spawnSync } from 'node:child_process';
import { ROOT, PORT, TEST_SERVER_ENTRY, ensureHostSecrets, getJson, lockText, printInvite, readRestartLock, readState, serverHealthy, startGameServer, stopGameServer, tunnelHost, waitForRestartLock, writeState } from './host.mjs';

async function main() {
  const lock = await waitForRestartLock('server-restart', 60_000, (h) => console.log(`[restart] waiting for ${lockText(h)} to finish ...`));
  if (!lock) {
    console.error(`[restart] another restart is still running (${lockText(readRestartLock())}): the game server was NOT touched; try again in a minute`);
    return 1;
  }
  let state;
  try {
    state = ensureHostSecrets(readState()); // read under the lock: a watchdog restart may just have replaced the server
    writeState(state);
    if (process.argv.includes('--build')) {
      if (TEST_SERVER_ENTRY) console.log('[restart] build: skipped (HOST_SERVER_ENTRY: test stand-in server)');
      else {
        console.log('[restart] npm run build ...');
        const r = spawnSync('npm run build', { cwd: ROOT, shell: true, stdio: 'inherit' });
        if (r.status !== 0) {
          console.error('[restart] build failed: the running server was NOT touched');
          return 1;
        }
      }
    }
    const port = state.serverPort ?? PORT;
    const was = await serverHealthy(port);
    console.log(`[restart] stopping the game server on :${port}${was ? '' : ' (was not healthy)'} ...`);
    await stopGameServer(state, port);
    const t0 = Date.now();
    const pid = await startGameServer(state, port);
    console.log(`[restart] game server up again in ${((Date.now() - t0) / 1000).toFixed(1)} s (pid ${pid}); cloudflared untouched`);
  } catch (e) {
    console.error('[restart] FAILED:', e instanceof Error ? e.message : e);
    return 1;
  } finally {
    lock.release();
  }
  const port = state.serverPort ?? PORT;
  const h = await getJson(`http://127.0.0.1:${port}/healthz`);
  if (h) console.log(`[restart] healthz: mode=${h.mode} crews=${h.crews}`);
  printInvite(state, await tunnelHost());
  return 0;
}

process.exitCode = await main();
