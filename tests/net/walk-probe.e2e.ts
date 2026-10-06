// Track ① Net: walk probe: one Chrome, autojoin, setInput forward 2 s; prints local diag + server view.
import { launchPlayer, screenshot } from '../lib/launch.ts';
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3001';
const p = await launchPlayer({ name: 'Walker', baseUrl: BASE, crew: 'WALK', query: { autojoin: '1' } });
await p.page.waitForFunction(() => window.__game?.ready() === true, undefined, { timeout: 45_000 }).catch(() => console.log('not ready'));
const view = () => p.page.evaluate(() => {
  const s = window.__game!.state() as { diag: Record<string, unknown>; screen: string };
  const nd = (window as unknown as { __netDebug: { self(): { p: number[] } | null; stat(): unknown } }).__netDebug;
  return { server: nd.self()?.p, diagPlayers: s.diag.players, screen: s.screen, stat: nd.stat() };
});
console.log('before', JSON.stringify(await view()).slice(0, 600));
await p.page.evaluate(() => { window.__game!.look(0, 0); window.__game!.setInput({ forward: 1 }); });
await p.page.waitForTimeout(2000);
console.log('after ', JSON.stringify(await view()).slice(0, 600));
await p.page.evaluate(() => window.__game!.setInput({ forward: 0 }));
console.log('errors', JSON.stringify([...p.errors, ...(await p.page.evaluate(() => window.__game!.errors()))]).slice(0, 800));
await screenshot(p.page, 'tests/artifacts/net/walk-probe.png');
await p.close();
