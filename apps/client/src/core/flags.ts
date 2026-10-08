// Live feature flags (integrator). The server's /healthz carries its current flags (`flags`: the same object SIGHUP /
// dbg.reloadConfig update in place). main.ts fetches it BEFORE any track installs and merges it over the copy bundled
// at build time, so a kill switch (mirrors, paranormal, containers, ...) reaches a production client on its next page
// load without a client rebuild. /healthz because every proxy in front of the server already forwards it (desktop
// bundled mode, the gate proxies) and older servers answer it too (no `flags` -> bundled copy, never a 404). Any
// failure (timeout, offline, no flags) keeps the bundled copy. Pure + DOM-free: apps/server/src/core/flags.test.ts.

/** Same-origin path whose JSON body carries `flags` (apps/server/src/core/http.ts). */
export const FLAGS_PATH = '/healthz';

/** Bundled flags overlaid with every boolean the server sent; anything else in `server` is ignored. */
export function mergeFlags(bundled: Record<string, boolean>, server: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = { ...bundled };
  if (server && typeof server === 'object' && !Array.isArray(server)) {
    for (const [k, v] of Object.entries(server as Record<string, unknown>)) if (typeof v === 'boolean') out[k] = v;
  }
  return out;
}

/** Keys whose value differs between two flag sets (for diagnostics). */
export function changedFlags(a: Record<string, boolean>, b: Record<string, boolean>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => a[k] !== b[k]).sort();
}

export interface FetchFlagsOpts {
  /** default FLAGS_PATH (same origin as the page) */
  url?: string;
  /** give up and keep the bundled flags after this long (default 1500 ms) */
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** The server's live flags, or null on any failure (the caller keeps its bundled copy). Never throws. */
export async function fetchServerFlags(opts: FetchFlagsOpts = {}): Promise<Record<string, boolean> | null> {
  const f = opts.fetchImpl ?? (typeof fetch === 'function' ? fetch : null);
  if (!f) return null;
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = setTimeout(() => ac?.abort(), opts.timeoutMs ?? 1500);
  try {
    const r = await f(opts.url ?? FLAGS_PATH, { cache: 'no-store', headers: { accept: 'application/json' }, signal: ac?.signal });
    if (!r.ok || !(r.headers.get('content-type') ?? '').includes('json')) return null;
    const body: unknown = await r.json();
    const flags = body && typeof body === 'object' ? (body as { flags?: unknown }).flags : null;
    if (!flags || typeof flags !== 'object' || Array.isArray(flags)) return null;
    return mergeFlags({}, flags);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
