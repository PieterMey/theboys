#!/usr/bin/env node
// Gate P helper (integrator): serve a temp production client build (vite build --outDir <tmp>) in front of a DEV game
// server, so a built client can use the dev server's dbg.* requests (dev mode always serves Vite, never a dist).
//   node tests/gates/p-proxy.mjs --port 3894 --dist <tmp-dist> --target http://127.0.0.1:3893
// Static files come from --dist (index.html for '/'); everything else (/ws upgrades, /assets/, /api/, /healthz) is
// passed through to --target unchanged. Never point it at the live ports.
import { createServer, request } from 'node:http';
import { connect } from 'node:net';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const PORT = Number(arg('port', '0'));
const DIST = arg('dist', '');
const TARGET = new URL(arg('target', ''));
if (!PORT || !DIST || !existsSync(join(DIST, 'index.html'))) { console.error('usage: --port N --dist <dir with index.html> --target http://127.0.0.1:N'); process.exit(2); }
if ([3000, 3100, 20241].includes(PORT) || [3000, 3100, 20241].includes(Number(TARGET.port))) { console.error('refusing the live ports'); process.exit(2); }

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.map': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.onnx': 'application/octet-stream' };

function staticFile(p) {
  if (p === '/' || p === '/index.html') return join(DIST, 'index.html');
  if (p.startsWith('/assets/') || p.startsWith('/api/') || p === '/ws' || p === '/healthz') return null;
  const f = normalize(join(DIST, decodeURIComponent(p)));
  if (!f.startsWith(normalize(DIST))) return null;
  try { return statSync(f).isFile() ? f : null; } catch { return null; }
}

const server = createServer((req, res) => {
  const p = new URL(req.url ?? '/', 'http://x').pathname;
  const f = staticFile(p);
  if (f) {
    res.setHeader('Content-Type', TYPES[extname(f)] ?? 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(readFileSync(f));
    return;
  }
  const up = request({ host: TARGET.hostname, port: TARGET.port, method: req.method, path: req.url, headers: req.headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on('error', (e) => { res.statusCode = 502; res.end(String(e)); });
  req.pipe(up);
});
// websocket (and any other upgrade): raw TCP pass-through with the original request head
server.on('upgrade', (req, sock, head) => {
  const up = connect(Number(TARGET.port), TARGET.hostname, () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    up.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head?.length) up.write(head);
    sock.pipe(up).pipe(sock);
  });
  const end = () => { sock.destroy(); up.destroy(); };
  up.on('error', end);
  sock.on('error', end);
});
server.listen(PORT, '127.0.0.1', () => console.log(`p-proxy :${PORT} -> dist ${DIST} + ${TARGET.origin}`));
