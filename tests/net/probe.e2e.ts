// Track ① Net: quick load probe (one Chrome, autojoin) printing errors + net diag; BASE_URL default http://127.0.0.1:3001
import { launchPlayer, screenshot } from '../lib/launch.ts';
const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3001';
const p = await launchPlayer({ name: 'Probe', baseUrl: BASE, crew: 'PRBE', query: { autojoin: '1' } });
await p.page.waitForFunction(() => (window.__game?.state() as { net?: string } | undefined)?.net === 'joined', undefined, { timeout: 20_000 }).catch(() => {});
await p.page.waitForTimeout(4000);
const g = await p.page.evaluate(() => {
  const s = window.__game?.state() as { net: string; pending: string[]; diag: Record<string, unknown> } | undefined;
  const nd = (window as unknown as { __netDebug?: { stat(): unknown; services(): unknown } }).__netDebug;
  return { ready: window.__game?.ready(), net: s?.net, pending: s?.pending, diagKeys: Object.keys(s?.diag ?? {}), diagNet: s?.diag?.net, stat: nd?.stat(), services: nd?.services(), perf: window.__game?.perf(), errs: window.__game?.errors() ?? [] };
});
console.log(JSON.stringify(g, null, 1).slice(0, 3000));
console.log('page errors:', JSON.stringify(p.errors.slice(0, 6)).slice(0, 2000));
await screenshot(p.page, 'tests/artifacts/net/probe.png');
await p.close();
