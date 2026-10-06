// Runs a hook list, isolating track failures (logged, rate-limited) so one buggy plugin can't break core.
import type { ServerContext } from './types.ts';
import { makeLogger, rateLimited } from './log.ts';

const warn = rateLimited(makeLogger('hooks'));

export function runHooks<A extends unknown[]>(
  _ctx: ServerContext,
  name: string,
  list: readonly ((...a: A) => unknown)[],
  ...args: A
): void {
  for (const fn of list) {
    try {
      fn(...args);
    } catch (e) {
      warn(`hook ${name} (${fn.name || 'anonymous'}) threw:`, e instanceof Error ? (e.stack ?? e.message) : e);
    }
  }
}
