// Tiny scoped logger. DEBUG=scope1,scope2 (or *) enables debug lines. Never log secrets or transcripts.
import type { Logger } from './types.ts';

const debugScopes = new Set((process.env.DEBUG ?? '').split(',').map((s) => s.trim()).filter(Boolean));
let quiet = false;

export function setQuiet(q: boolean): void {
  quiet = q;
}

function stamp(): string {
  const d = new Date();
  return d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

export function makeLogger(scope: string): Logger {
  const tag = `[${scope}]`;
  const dbg = debugScopes.has('*') || debugScopes.has(scope);
  return {
    debug: (...a) => { if (dbg && !quiet) console.log(stamp(), tag, ...a); },
    info: (...a) => { if (!quiet) console.log(stamp(), tag, ...a); },
    warn: (...a) => console.warn(stamp(), tag, 'WARN', ...a),
    error: (...a) => console.error(stamp(), tag, 'ERROR', ...a),
  };
}

/** Logs at most once per `ms` per key (for per-message errors). */
export function rateLimited(log: Logger, ms = 5000): (key: string, ...a: unknown[]) => void {
  const last = new Map<string, number>();
  return (key, ...a) => {
    const now = performance.now();
    if ((last.get(key) ?? -Infinity) + ms > now) return;
    last.set(key, now);
    log.warn(key, ...a);
  };
}
