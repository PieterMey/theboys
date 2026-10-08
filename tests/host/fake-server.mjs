#!/usr/bin/env node
// Stand-in for the game server in the host watchdog tests (tests/host/watchdog.e2e.ts), started through tools/host.mjs's
// real startGameServer via HOST_SERVER_ENTRY. Answers GET /healthz like apps/server/src/core/http.ts, on 127.0.0.1
// like the real server, until GET /hang: then it spins one core forever, like the 2026-10-08 Listener path loop
// (process alive, 100% of a core, /healthz silent). FAKE_EXIT_AT_START=1 makes it die at boot (a failed restart).
// Only ever on the test ports 3820-3822; it never reads saves, the .env file or anything else.
import { createServer } from 'node:http';

const port = Number(process.env.PORT);
if (!(port >= 3820 && port <= 3822)) {
  console.error(`fake server: PORT=${process.env.PORT} is not a test port (3820-3822); refusing to start`);
  process.exit(2);
}
if (process.env.FAKE_EXIT_AT_START === '1') {
  console.error(`fake server pid ${process.pid}: exiting at start (FAKE_EXIT_AT_START=1)`);
  process.exit(3);
}

const t0 = Date.now();
const server = createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (path === '/healthz') {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ ok: true, mode: 'fake', crews: 0, uptimeSec: Math.round((Date.now() - t0) / 1000), pid: process.pid }));
    return;
  }
  if (path === '/hang') {
    res.end(`hanging pid ${process.pid}\n`);
    console.log(`fake server pid ${process.pid}: hanging now (busy loop)`);
    setTimeout(() => {
      for (;;) { /* the freeze: never returns, never yields to the event loop */ }
    }, 20);
    return;
  }
  res.statusCode = 404;
  res.end();
});
server.listen(port, '127.0.0.1', () => {
  console.log(`fake server pid ${process.pid} on http://127.0.0.1:${port} (NODE_ENV=${process.env.NODE_ENV}, AI_MODE=${process.env.AI_MODE}, args ${process.argv.slice(2).join(' ')})`);
});
