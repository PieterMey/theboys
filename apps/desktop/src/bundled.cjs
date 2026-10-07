// @ts-check
'use strict';
// BUNDLED mode: the client build ships inside the app (resources/app.asar/client) and is served from
// http://127.0.0.1:<port>/ (a secure context, like localhost). The client assumes same-origin for /ws, /assets/
// and /api/, so this tiny server reverse-proxies exactly those to the game server (serverUrl):
//   /ws (WebSocket upgrade) -> raw TCP/TLS pipe   /assets/* /api/* /healthz -> streamed HTTP proxy
// The port is fixed (config bundled.port) because localStorage (player key, callsign, settings) is per origin.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');

/** @type {Record<string, string>} */
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.ktx2': 'image/ktx2', '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream', '.onnx': 'application/octet-stream', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
const PROXIED = /^\/(?:assets\/|api\/|healthz(?:$|\?))/;
const HASHED = /-[A-Za-z0-9_-]{8}\.(?:js|css|wasm)$/;
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer']);

/**
 * @param {{ root: string, upstream: string, port: number, log: { info(m: string): void, warn(m: string): void } }} opts
 * @returns {Promise<{ origin: string, port: number, close(): Promise<void> }>}
 */
async function startBundled({ root, upstream, port, log }) {
  const up = new URL(upstream);
  const secure = up.protocol === 'https:';
  const upPort = Number(up.port) || (secure ? 443 : 80);
  const agent = secure ? new https.Agent({ keepAlive: true }) : new http.Agent({ keepAlive: true });
  const rootAbs = path.resolve(root);
  const indexFile = path.join(rootAbs, 'index.html');
  if (!fs.existsSync(indexFile)) throw new Error(`bundled client missing: ${indexFile}`);
  /** @type {Set<net.Socket>} */
  const sockets = new Set();

  /** @param {http.IncomingHttpHeaders} h */
  const forwardHeaders = (h) => {
    /** @type {http.OutgoingHttpHeaders} */
    const out = {};
    for (const [k, v] of Object.entries(h)) if (!HOP.has(k) && v !== undefined) out[k] = v;
    out.host = up.host;
    if (out.origin) out.origin = up.origin;
    delete out.referer;
    return out;
  };

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  const proxy = (req, res) => {
    const r = (secure ? https : http).request({
      protocol: up.protocol, hostname: up.hostname, port: upPort, method: req.method, path: req.url, agent,
      headers: forwardHeaders(req.headers), servername: secure ? up.hostname : undefined,
    }, (ur) => {
      /** @type {http.OutgoingHttpHeaders} */
      const h = {};
      for (const [k, v] of Object.entries(ur.headers)) if (!HOP.has(k) && v !== undefined) h[k] = v;
      res.writeHead(ur.statusCode ?? 502, h);
      ur.pipe(res);
    });
    r.setTimeout(30_000, () => r.destroy(new Error('upstream timeout')));
    r.on('error', (e) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`upstream error: ${e.message}`);
    });
    req.pipe(r);
  };

  /** @param {http.IncomingMessage} req @param {http.ServerResponse} res */
  const serveStatic = (req, res) => {
    let p;
    try {
      p = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (p.includes('\0') || /(^|\/)\./.test(p)) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
      return;
    }
    let file = path.resolve(rootAbs, `.${path.posix.normalize(`/${p}`)}`);
    if (file !== rootAbs && !file.startsWith(rootAbs + path.sep)) {
      res.writeHead(404).end();
      return;
    }
    let st = null;
    try { st = fs.statSync(file); } catch { st = null; }
    if (st?.isDirectory()) {
      file = path.join(file, 'index.html');
      try { st = fs.statSync(file); } catch { st = null; }
    }
    if (!st) {
      const last = p.split('/').pop() ?? '';
      if (last.includes('.')) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
        return;
      }
      file = indexFile; // SPA route
      st = fs.statSync(file);
    }
    const ext = path.extname(file).toLowerCase();
    const rel = path.relative(rootAbs, file).split(path.sep).join('/');
    res.writeHead(200, {
      'content-type': TYPES[ext] ?? 'application/octet-stream',
      'content-length': st.size,
      'last-modified': st.mtime.toUTCString(),
      // hashed build files: immutable (keeps the V8 code cache valid across launches)
      'cache-control': rel.startsWith('app/') && HASHED.test(rel) ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  };

  const server = http.createServer((req, res) => {
    const url = req.url ?? '/';
    if (PROXIED.test(url)) return proxy(req, res);
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    serveStatic(req, res);
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  // WebSocket: replay the upgrade request upstream, then pipe both ways (no frame parsing, no added latency)
  server.on('upgrade', (req, duplex, head) => {
    const socket = /** @type {net.Socket} */ (duplex);
    const path0 = (req.url ?? '').split('?')[0];
    if (path0 !== '/ws') {
      socket.destroy();
      return;
    }
    const upSock = secure
      ? tls.connect({ host: up.hostname, port: upPort, servername: up.hostname, ALPNProtocols: ['http/1.1'] })
      : net.connect({ host: up.hostname, port: upPort });
    const kill = () => { socket.destroy(); upSock.destroy(); };
    upSock.on('error', (e) => { log.warn(`bundled: ws upstream error: ${e.message}`); kill(); });
    socket.on('error', kill);
    upSock.on('close', () => socket.destroy());
    socket.on('close', () => upSock.destroy());
    upSock.once(secure ? 'secureConnect' : 'connect', () => {
      let raw = `GET ${req.url} HTTP/1.1\r\n`;
      const h = req.rawHeaders;
      for (let i = 0; i + 1 < h.length; i += 2) {
        const k = h[i].toLowerCase();
        if (k === 'host') raw += `Host: ${up.host}\r\n`;
        else if (k === 'origin') raw += `Origin: ${up.origin}\r\n`;
        else if (k === 'referer') continue;
        else raw += `${h[i]}: ${h[i + 1]}\r\n`;
      }
      upSock.setNoDelay(true);
      socket.setNoDelay(true);
      upSock.write(`${raw}\r\n`);
      if (head?.length) upSock.write(head);
      upSock.pipe(socket);
      socket.pipe(upSock);
    });
  });

  /** @param {number} p @returns {Promise<number>} */
  const listen = (p) => new Promise((resolve, reject) => {
    const onErr = (/** @type {NodeJS.ErrnoException} */ e) => { server.off('listening', onOk); reject(e); };
    const onOk = () => { server.off('error', onErr); resolve(p); };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(p, '127.0.0.1');
  });
  let bound = 0;
  for (let i = 0; i < 6 && !bound; i++) {
    try {
      bound = await listen(port + i);
    } catch (e) {
      const code = /** @type {NodeJS.ErrnoException} */ (e).code;
      if (code !== 'EADDRINUSE' || i === 5) throw e;
      log.warn(`bundled: port ${port + i} busy, trying ${port + i + 1} (a different port = separate local storage)`);
    }
  }
  const origin = `http://127.0.0.1:${bound}`;
  log.info(`bundled: serving ${rootAbs} on ${origin}, proxying /ws /assets/ /api/ to ${up.origin}`);
  return {
    origin,
    port: bound,
    close: () => new Promise((resolve) => {
      for (const s of sockets) s.destroy();
      agent.destroy();
      server.close(() => resolve());
    }),
  };
}

/** build id of a client build folder (dist/build.json), or null */
/** @param {string} root */
function localBuild(root) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(root, 'build.json'), 'utf8'));
    return typeof j.build === 'string' && j.build ? j.build : null;
  } catch {
    return null;
  }
}

module.exports = { startBundled, localBuild };
