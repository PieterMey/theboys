// Track ⑤ Players test helpers (E2E): launch + join + test level.
import type { Page } from 'playwright-core';
import { launchPlayer, waitForGame } from '../lib/launch.ts';
import type { Player } from '../lib/launch.ts';

export const BASE = process.env.BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3005}`;
export const OUT = 'tests/artifacts/players';

export async function joinPlayer(name: string, crew: string, opts: { viewport?: { width: number; height: number }; query?: Record<string, string> } = {}): Promise<Player> {
  const p = await launchPlayer({ name, baseUrl: BASE, crew, query: { autojoin: '1', nobright: '1', ...(opts.query ?? {}) }, viewport: opts.viewport });
  // other tracks edit the shared tree all night: mute Vite's HMR socket so their edits don't full-reload this page
  await p.page.routeWebSocket((u) => !u.pathname.endsWith('/ws'), () => { /* swallow (never connects to the server) */ });
  await p.page.reload({ waitUntil: 'domcontentloaded' });
  await waitForGame(p.page, 60_000);
  await p.page.waitForFunction(() => !!window.__game?.me() && !!window.__players, undefined, { timeout: 30_000 });
  return p;
}

/** switch the crew into a contract on a fresh facility (② dbg.level.generate if present, else ⑤ dbg.players.testLevel) */
export async function testLevel(page: Page, seed = 'players-e2e', players = 2): Promise<{ hash: string }> {
  const r = await page.evaluate(async ({ seed, players }) => {
    try {
      const x = (await window.__game!.dbg('level.generate', { seed, players, risk: 1 })) as { hash?: string } | null;
      if (x && typeof x === 'object') return { via: 'level', hash: String(x.hash ?? '') };
    } catch { /* not available */ }
    const y = (await window.__game!.dbg('players.testLevel', { seed, players, risk: 1 })) as { hash: string };
    return { via: 'players', hash: y.hash };
  }, { seed, players });
  await page.waitForFunction(() => (window.__game!.state() as { phase: string; layout: unknown }).phase === 'contract' && !!(window.__game!.state() as { layout: unknown }).layout, undefined, { timeout: 20_000 });
  await page.waitForTimeout(600);
  return r;
}

export async function local(page: Page) {
  return page.evaluate(() => window.__players!.local());
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}
