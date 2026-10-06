// P3 QA repro: a Chrome player joins a crew whose contract is already running (late joiner).
//   BASE_URL=http://127.0.0.1:3097 node tests/qa/late-repro.e2e.ts [--lobby]
import { WS_URL, connectBot, log, qaPlayer, randomCrew, req, sleep, st } from './lib.ts';
import { launchPlayer } from '../lib/launch.ts';
import { BASE } from './lib.ts';

const crew = randomCrew();
const L = await connectBot({ url: WS_URL, crew, name: 'Lead' });
const early = await qaPlayer('Ann', 'silence.wav', crew);
try {
  if (process.argv.includes('--lobby')) {
    await L.dbg('meta.contractSec', { sec: 600 });
    const ms = (await L.req('meta.state' as never, {} as never)) as unknown as { workOrders: { id: string; available: boolean }[] };
    await L.req('meta.pick', { orderId: ms.workOrders.find((o) => o.available)!.id });
    await L.req('meta.ready', { ready: true });
    await req(early.page, 'meta.ready', { ready: true });
    await L.waitFor(() => L.full?.phase === 'drive', 10_000, 'drive');
    await L.dbg('meta.skipDrive');
  } else {
    await L.dbg('objectives.start', { realSec: 600 });
  }
  await L.waitFor(() => L.full?.phase === 'contract', 20_000, 'contract');
  await sleep(3000);
  log('contract running; launching the late joiner');
  const p = await launchPlayer({ name: 'Dax', wav: 'silence.wav', baseUrl: BASE, crew, query: { autojoin: '1', nobright: '1' }, viewport: { width: 480, height: 270 } });
  const lines: string[] = [];
  p.page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') lines.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
  await p.page.routeWebSocket((u) => !u.pathname.endsWith('/ws'), () => {});
  await p.page.reload({ waitUntil: 'domcontentloaded' });
  for (let i = 0; i < 40; i++) {
    await sleep(2000);
    const s = await p.page.evaluate(() => {
      const g = window.__game;
      if (!g) return null;
      const st = g.state() as { net: string; phase: string; screen: string; pending: string[]; layout: { seed: string } | null };
      return { ready: g.ready(), net: st.net, phase: st.phase, screen: st.screen, pending: st.pending, layout: st.layout?.seed ?? null, frames: (window.__render?.info?.() as { frames?: number } | undefined)?.frames };
    }).catch((e) => ({ err: String(e).slice(0, 120) }));
    log(`late joiner t+${(i + 1) * 2}s: ${JSON.stringify(s)}`);
    if (s && 'ready' in s && s.ready) break;
  }
  log(`console:\n  ${lines.slice(0, 20).join('\n  ')}`);
  void st;
  await p.close();
} finally {
  L.close();
  await early.close();
  setTimeout(() => process.exit(0), 300).unref();
}
