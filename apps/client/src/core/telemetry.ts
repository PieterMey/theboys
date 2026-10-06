// v1.1 client telemetry (server side: apps/server/src/net/telemetry.ts). Every telemetrySec (10 s) while joined:
// render perf (fps, frame ms p50/p95, long frames, GPU ms, preset, internal resolution, DPR, backend) + RTT, tab
// hidden, JS heap; plus new client errors and, after a reconnect, the close code/reason of the dropped socket.
// The server logs one line per player per 30 s and keeps the latest for the host ('net.perf').
import type { ClientContext } from './context.ts';
import type { RenderPerf } from '../render/types.ts';

/** strip anything token-like before an error message leaves the page */
function scrub(s: string): string {
  return s.replace(/(admin|resume|token|key)=[^&\s'"]+/gi, '$1=<redacted>').replace(/[A-Za-z0-9_-]{24,}/g, '<redacted>').slice(0, 300);
}

export function installTelemetry(ctx: ClientContext): void {
  const everyMs = Math.max(3, Number((ctx.balance.render as { perf?: { telemetrySec?: number } } | undefined)?.perf?.telemetrySec ?? 10)) * 1000;
  let sentErrors = ctx.errors().length;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const loose = ctx.net as unknown as { req(r: string, a: unknown, timeoutMs?: number): Promise<unknown> };

  const send = () => {
    if (ctx.net.status !== 'joined') return;
    const render = ctx.services.use('render') as { perf?: () => RenderPerf } | undefined;
    let perf: Record<string, unknown> = {};
    try { perf = { ...(render?.perf?.() ?? {}) }; } catch { /* render not ready */ }
    const mem = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory?.usedJSHeapSize;
    perf.rtt = Math.round(ctx.net.rtt);
    perf.hidden = document.hidden;
    perf.heapMB = typeof mem === 'number' ? Math.round(mem / 1048576) : null;
    perf.screen = ctx.ui.screen.value.name;
    perf.phase = ctx.world.phase;
    const all = ctx.errors();
    if (sentErrors > all.length) sentErrors = 0;
    const errors = all.slice(sentErrors, sentErrors + 3).map(scrub);
    sentErrors = all.length;
    const drop = ctx.net.consumeDrop();
    void loose.req('net.telemetry', { perf, errors: errors.length ? errors : undefined, drop: drop ?? undefined }, 8000).catch(() => { /* old server */ });
  };
  const loop = () => {
    timer = setTimeout(() => {
      try { send(); } catch { /* never break the page */ }
      loop();
    }, everyMs);
  };
  ctx.bus.on('net:welcome', () => {
    // a reconnect: report the drop right away (not 10 s later)
    if (ctx.net.lastDrop) setTimeout(() => { try { send(); } catch { /* ignore */ } }, 1500);
    if (!timer) loop();
  });
}
