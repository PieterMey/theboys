#!/usr/bin/env node
// Restart ONLY the game server (track ① Net). Never touches cloudflared or the STT sidecar, so the invite link
// stays the same; clients reconnect on their own and land back in the van (saves/session.json restore).
//   node tools/server-restart.mjs            restart with the current build
//   node tools/server-restart.mjs --build    npm run build first (clients get a 'new version: reload' prompt)
import { spawnSync } from 'node:child_process';
import { ROOT, PORT, ensureHostSecrets, getJson, printInvite, readState, serverHealthy, startGameServer, stopGameServer, tunnelHost, writeState } from './host.mjs';

const state = ensureHostSecrets(readState());
writeState(state);
if (process.argv.includes('--build')) {
  console.log('[restart] npm run build ...');
  const r = spawnSync('npm run build', { cwd: ROOT, shell: true, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error('[restart] build failed: the running server was NOT touched');
    process.exit(1);
  }
}
const port = state.serverPort ?? PORT;
const was = await serverHealthy(port);
console.log(`[restart] stopping the game server on :${port}${was ? '' : ' (was not healthy)'} ...`);
await stopGameServer(state, port);
const t0 = Date.now();
const pid = await startGameServer(state, port);
console.log(`[restart] game server up again in ${((Date.now() - t0) / 1000).toFixed(1)} s (pid ${pid}); cloudflared untouched`);
const h = await getJson(`http://127.0.0.1:${port}/healthz`);
if (h) console.log(`[restart] healthz: mode=${h.mode} crews=${h.crews}`);
printInvite(state, await tunnelHost());
