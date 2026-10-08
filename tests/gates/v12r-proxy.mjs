#!/usr/bin/env node
// Gate R (v1.2) helper: serve a TEMP production client build (vite build --outDir <tmp>) in front of a dev-mode game
// server, so the visual pass runs the bundled client (no Vite module waterfall, no HMR reloads) while the backend keeps
// its dbg.* requests (they exist only with NODE_ENV=development, which also turns on Vite middleware there).
//   node tests/gates/v12r-proxy.mjs --port 3898 --backend 3897 --dist <tmp build dir>
// Routing: /assets/*, /api/*, /healthz and every websocket upgrade (/ws) go to the backend; files present in <dist> are
// served from it; extension-less paths get <dist>/index.html (SPA); anything else is proxied. Never the live ports.
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sirv from 'sirv';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const PORT = Number(arg('port', '3898'));
const BACK = Number(arg('backend', '3897'));
const DIST = arg('dist', '');
if ([3000, 3100].includes(PORT) || [3000, 3100].includes(BACK)) throw new Error('refusing the live ports');
if (!DIST || !existsSync(join(DIST, 'index.html'))) throw new Error(`no build at --dist ${DIST}`);
const index = readFileSync(join(DIST, 'index.html'));
const files = sirv(DIST, { dev: false, etag: true, dotfiles: false });

function proxy(req, res) {
  const up = request({ host: '127.0.0.1', port: BACK, method: req.method, path: req.url, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on('error', (e) => { res.statusCode = 502; res.end(`backend: ${e.message}`); });
  req.pipe(up);
}

const server = createServer((req, res) => {
  const p = (req.url ?? '/').split('?')[0];
  if (p.startsWith('/assets/') || p.startsWith('/api/') || p === '/healthz') return proxy(req, res);
  if (p === '/' || p === '/index.html') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    return res.end(index);
  }
  files(req, res, () => {
    const last = p.split('/').pop() ?? '';
    if (!last.includes('.')) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); return res.end(index); }
    proxy(req, res);
  });
});

// websocket (and any other) upgrade: a raw TCP pipe to the backend
server.on('upgrade', (req, sock, head) => {
  const up = connect(BACK, '127.0.0.1', () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    up.write(lines.join('\r\n') + '\r\n\r\n');
    if (head?.length) up.write(head);
    sock.pipe(up).pipe(sock);
  });
  const end = () => { sock.destroy(); up.destroy(); };
  up.on('error', end);
  sock.on('error', end);
  up.on('close', () => sock.destroy());
  sock.on('close', () => up.destroy());
});

server.listen(PORT, '127.0.0.1', () => console.log(`v12r proxy on http://127.0.0.1:${PORT} -> backend :${BACK}, dist ${DIST}`));
