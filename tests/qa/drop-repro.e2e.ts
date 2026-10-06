// P3 QA repro: drop a Chrome player's game socket mid-contract, then check reconnect + movement.
//   BASE_URL=http://127.0.0.1:3097 node tests/qa/drop-repro.e2e.ts
import { WS_URL, connectBot, dropSocket, log, qaPlayer, randomCrew, req, sleep, st } from './lib.ts';

const crew = randomCrew();
const L = await connectBot({ url: WS_URL, crew, name: 'Lead' });
const bea = await qaPlayer('Bea', 'silence.wav', crew, { proxyWs: true });
try {
  await L.dbg('meta.contractSec', { sec: 600 });
  const ms = (await L.req('meta.state' as never, {} as never)) as unknown as { workOrders: { id: string; available: boolean }[] };
  await L.req('meta.pick', { orderId: ms.workOrders.find((o) => o.available)!.id });
  await L.req('meta.ready', { ready: true });
  await req(bea.page, 'meta.ready', { ready: true });
  await L.waitFor(() => L.full?.phase === 'drive', 10_000, 'drive');
  await L.dbg('meta.skipDrive');
  await L.waitFor(() => L.full?.phase === 'contract', 20_000, 'contract');
  await L.dbg('monsters.freeze', { on: true });
  await sleep(4000);
  const id = (await st(bea.page)).me;
  const pose = async () => ((await L.dbg('players.pose', { id })) as { pose: { p: number[] } }).pose.p.map((v) => Math.round(v * 10) / 10);
  const move = async (label: string) => {
    const a = await pose();
    const la = await bea.page.evaluate(() => window.__players!.local().p);
    await bea.page.evaluate(() => { window.__game!.look(Math.PI, 0); window.__game!.setInput({ forward: 1 }); });
    await sleep(1500);
    await bea.page.evaluate(() => window.__game!.setInput({ forward: 0 }));
    await sleep(500);
    const b = await pose();
    const lb = await bea.page.evaluate(() => window.__players!.local().p);
    const d = (await st(bea.page)).diag as { players?: unknown; net?: unknown };
    log(`${label}: server ${a} -> ${b} | local ${la.map((v) => v.toFixed(1))} -> ${lb.map((v) => v.toFixed(1))} | diag.players ${JSON.stringify(d.players)} net ${JSON.stringify(d.net)}`);
  };
  await move('before drop');
  log(`sockets seen: ${bea.sockets.length}`);
  const n = await dropSocket(bea);
  log(`dropped ${n}`);
  for (let i = 0; i < 12; i++) {
    const s = await st(bea.page);
    const r = ((await L.dbg('state')) as { players: { id: string; connected: boolean }[] }).players.find((p) => p.id === id);
    log(`t+${i * 250}ms client net=${s.net} server connected=${r?.connected} sockets=${bea.sockets.length}`);
    await sleep(250);
  }
  await sleep(2000);
  await move('after drop');
  await sleep(16_000);
  await move('after 16 s more');
  log(`console tail:\n  ${bea.console.slice(-15).join('\n  ')}`);
} finally {
  L.close();
  await bea.close();
  setTimeout(() => process.exit(0), 300).unref();
}
