// Owner: track ① Net. Invite link: the cloudflared quick-tunnel hostname from its metrics endpoint
// (http://127.0.0.1:20241/quicktunnel -> {"hostname":"<words>.trycloudflare.com"}), cached ~3 s.
// INVITE_BASE (e.g. a Tailscale Funnel URL) overrides it; TUNNEL_METRICS (URL) or CF_METRICS (host:port) move the metrics address.
//   GET /api/invite?code=ABCD -> { url: 'https://<host>/#ABCD' | null, base: 'https://<host>' | null }
import type { ServerContext } from '../core/types.ts';
import { registerHttpRoute } from '../core/ws.ts';
import { netBalance } from './balance.ts';

let cache: { base: string | null; at: number } = { base: null, at: -Infinity };
let inflight: Promise<string | null> | null = null;

export const METRICS = process.env.TUNNEL_METRICS ?? `http://${process.env.CF_METRICS ?? '127.0.0.1:20241'}`;

export async function tunnelBase(ctx: ServerContext): Promise<string | null> {
  const fixed = process.env.INVITE_BASE;
  if (fixed) return fixed.replace(/\/+$/, '');
  const ttl = netBalance(ctx).invitePollMs;
  if (performance.now() - cache.at < ttl) return cache.base;
  inflight ??= (async () => {
    let base: string | null = null;
    try {
      const r = await fetch(`${METRICS}/quicktunnel`, { signal: AbortSignal.timeout(800) });
      if (r.ok) {
        const j = (await r.json()) as { hostname?: unknown };
        if (typeof j.hostname === 'string' && /^[a-z0-9.-]+$/i.test(j.hostname) && j.hostname.includes('.')) base = `https://${j.hostname}`;
      }
    } catch {
      base = null; // no tunnel running
    }
    cache = { base, at: performance.now() };
    inflight = null;
    return base;
  })();
  return inflight;
}

export function inviteUrl(base: string | null, code: string): string | null {
  return base ? `${base}/#${code}` : null;
}

export function installInvite(ctx: ServerContext): void {
  registerHttpRoute('/api/invite', async (req, res) => {
    const q = new URL(req.url ?? '/', 'http://x').searchParams;
    const code = String(q.get('code') ?? q.get('crew') ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    const base = await tunnelBase(ctx);
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ url: base ? (code ? inviteUrl(base, code) : `${base}/`) : null, base }));
  });
  ctx.registerReq('net.invite', async (crew) => {
    const base = await tunnelBase(ctx);
    return { url: inviteUrl(base, crew.code), base };
  });
}
