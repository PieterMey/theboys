// HTTP: dev = Vite middleware (HMR on the same server); prod/test = sirv for apps/client/dist + <ASSETS_DIR>/dist at
// /assets/, SPA fallback for extension-less routes, 404 for everything else. Dotfiles, saves, logs, .git: always 404.
// Every mode: /healthz {ok, mode, crews, uptimeSec, flags} (flags: the live flags clients merge at page load).
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import sirv from 'sirv';
import type { ServerContext } from './types.ts';

type Handler = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

const DENY_FIRST = new Set(['saves', 'logs', 'config', 'tools', 'services', 'node_modules', 'apps', 'packages', 'docs', 'tests']);
const VITE_HASHED = /-[A-Za-z0-9_-]{8}\.(?:js|css|wasm|map)$/;
const HEX_HASHED = /[.-][a-f0-9]{8,}\.[a-z0-9]+$/i;

function pathOf(req: IncomingMessage): string {
  const raw = (req.url ?? '/').split('?')[0].split('#')[0];
  try {
    return decodeURIComponent(raw).replace(/\\/g, '/');
  } catch {
    return raw;
  }
}

/** Never served, in any mode. */
function alwaysDenied(p: string): boolean {
  return /(^|\/)\.(env|git)(\/|$|\.)/i.test(p) || /(^|\/)(saves|logs)(\/|$)/i.test(p);
}

/** Prod: any dot segment or a repo-internal top-level folder. */
function prodDenied(p: string): boolean {
  if (alwaysDenied(p) || /(^|\/)\./.test(p)) return true;
  const first = p.split('/').filter(Boolean)[0] ?? '';
  return DENY_FIRST.has(first.toLowerCase());
}

function notFound(res: ServerResponse): void {
  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('not found');
}

function cacheHeaders(res: ServerResponse, pathname: string): void {
  if (pathname.endsWith('.html') || pathname.endsWith('/')) res.setHeader('Cache-Control', 'no-cache');
  else if (VITE_HASHED.test(pathname) || HEX_HASHED.test(pathname)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  else res.setHeader('Cache-Control', 'no-cache');
}

function mount(prefix: string, handler: Handler): Handler {
  return (req, res, next) => {
    const orig = req.url ?? '/';
    req.url = orig.slice(prefix.length) || '/';
    handler(req, res, () => {
      req.url = orig;
      next();
    });
  };
}

export async function createHttp(ctx: ServerContext): Promise<{ server: Server; close(): Promise<void> }> {
  const env = ctx.env;
  const log = ctx.log('http');
  const server = createServer();
  const assetsDir = join(env.ASSETS_DIR, 'dist');
  // dev:true = live lookups (assets keep landing during the night); setHeaders overrides its no-store
  const assets = mount('/assets', sirv(assetsDir, { dev: true, etag: true, dotfiles: false, setHeaders: cacheHeaders }) as Handler);
  let closeVite: () => Promise<void> = async () => {};

  // flags = the LIVE flags (ctx.flags, updated in place by SIGHUP / dbg.reloadConfig). The client merges them over its
  // build-time copy before its tracks install (apps/client/src/core/flags.ts), so a kill switch reaches clients on
  // their next page load without a client rebuild. /healthz because every proxy in front of the server already
  // forwards it (desktop bundled mode, the gate proxies). Flags are public (the client bundle carries them anyway).
  const health = (res: ServerResponse) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ ok: true, mode: env.mode, crews: ctx.crews.list().length, uptimeSec: Math.round(process.uptime()), flags: ctx.flags }));
  };

  if (env.dev) {
    const { createServer: createVite } = await import('vite');
    const vite = await createVite({
      configFile: join(env.ROOT, 'apps/client/vite.config.ts'),
      server: { middlewareMode: true, ws: { server } },
      appType: 'spa',
    });
    closeVite = () => vite.close();
    server.on('request', (req, res) => {
      const p = pathOf(req);
      if (alwaysDenied(p)) return notFound(res);
      if (p === '/healthz') return health(res);
      if (p.startsWith('/assets/')) return assets(req, res, () => notFound(res));
      vite.middlewares(req, res, () => notFound(res));
    });
    log.info('dev: Vite middleware + HMR on the game server');
  } else {
    const dist = env.CLIENT_DIST;
    const hasDist = existsSync(join(dist, 'index.html'));
    if (!hasDist) log.warn(`client not built (${dist}); run: npm run build`);
    const client = hasDist ? (sirv(dist, { dev: false, etag: true, dotfiles: false, setHeaders: cacheHeaders }) as Handler) : null;
    let indexHtml: Buffer | null = null;
    const serveIndex = (res: ServerResponse) => {
      indexHtml ??= readFileSync(join(dist, 'index.html'));
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      res.end(indexHtml);
    };
    server.on('request', (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res);
      const p = pathOf(req);
      if (prodDenied(p)) return notFound(res);
      if (p === '/healthz') return health(res);
      if (p.startsWith('/assets/')) return assets(req, res, () => notFound(res));
      if (!client) {
        res.statusCode = 503;
        return res.end('client not built: npm run build');
      }
      client(req, res, () => {
        const last = p.split('/').pop() ?? '';
        if (!last.includes('.')) serveIndex(res); // SPA route
        else notFound(res);
      });
    });
  }

  return {
    server,
    close: async () => {
      await closeVite();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
