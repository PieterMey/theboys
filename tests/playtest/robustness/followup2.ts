// Follow-up 2: inventory kept across a mid-contract reload (no CPU throttle), join panel timing, drone after a
// reconnect that crosses a phase change (socket dropped by the server while the crew goes contract -> hub).
//   node tests/playtest/robustness/followup2.ts
import { Bot } from '../../net/bot.ts';
import { WS, chrome, dbg, note, screen, shot, sleep, st, startServer, uiJoin, waitReady } from './lib.ts';
import type { Srv } from './lib.ts';

let srv: Srv | null = null;
const all: Bot[] = [];

async function main(): Promise<void> {
  srv = await startServer('followup2');
  const gus = await chrome('Hal', 'silence.wav', {}, 'HALL');
  await waitReady(gus.page, 90_000);
  await uiJoin(gus);
  const mate = new Bot({ url: WS, name: 'HalMate', crew: 'HALL' });
  await mate.connect(); all.push(mate);
  const t0 = Date.now();
  while ((await screen(gus.page)) !== 'none' && Date.now() - t0 < 30_000) await sleep(200);
  note(`I: first join panel closed after ${Date.now() - t0} ms, fps ${Math.round(await gus.page.evaluate(() => window.__game!.perf().fps))}`);
  const meId = await gus.page.evaluate(() => window.__game!.me());
  const ms = await dbg(gus.page, 'meta.state');
  await gus.page.evaluate((id) => window.__game!.req!('meta.pick', { orderId: id }), ms.orders.find((x: any) => x.available).id);
  await gus.page.keyboard.press('r');
  await mate.req('meta.ready', { ready: true });
  const t1 = Date.now();
  while ((await st(gus.page)).phase !== 'contract' && Date.now() - t1 < 30_000) { await sleep(300); await dbg(gus.page, 'meta.skipDrive').catch(() => {}); }
  await dbg(gus.page, 'monsters.freeze', { on: true }).catch(() => {});
  await sleep(4000);
  await dbg(gus.page, 'interaction.give', { type: 'crowbar' });
  await dbg(gus.page, 'interaction.give', { type: 'bottle', count: 3 });
  await sleep(800);
  const inv = async () => {
    const s = await dbg(gus.page, 'interaction.state');
    return (s.inventories?.[meId] ?? []).map((id: string | null) => (id ? `${s.items?.[id]?.type}${s.items?.[id]?.count ? `x${s.items[id].count}` : ''}` : '-')).join(',');
  };
  note('E2: inventory before reload:', await inv());
  await gus.page.reload({ waitUntil: 'domcontentloaded' });
  await waitReady(gus.page, 90_000);
  await uiJoin(gus);
  const t2 = Date.now();
  let frozenFor = 0;
  while ((await screen(gus.page)) !== 'none' && Date.now() - t2 < 30_000) await sleep(200);
  frozenFor = Date.now() - t2;
  note(`E2: rejoined mid-contract, join panel closed after ${frozenFor} ms; inventory after reload:`, await inv(), 'phase', (await st(gus.page)).phase);
  await shot(gus.page, '33-hal-after-reload-inventory');
  // J: socket dropped while the phase changes (contract -> hub via dbg.setPhase from the mate) -> welcome without 'phase'
  note('J: drone before:', await gus.page.evaluate(() => (window as any).__audioDebug?.ambience?.()));
  const cdp = await gus.page.context().newCDPSession(gus.page);
  await cdp.send('Network.enable');
  await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await sleep(1500);
  const stOff = await st(gus.page);
  note('J: net while offline:', stOff.net);
  await mate.req('dbg.meta.endContract', { outcome: 'voided' }).catch((e: Error) => note('endContract:', e.message));
  await sleep(1000);
  await mate.req('dbg.meta.resultsNow').catch(() => {});
  await sleep(1500);
  note('J: server phase now:', (await mate.req<any>('dbg.state')).phase);
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  const t3 = Date.now();
  while ((await st(gus.page)).net !== 'joined' && Date.now() - t3 < 20_000) await sleep(300);
  await sleep(3000);
  const s3 = await st(gus.page);
  note('J: after reconnect: net', s3.net, 'phase', s3.phase, 'screen', s3.screen, 'drone', JSON.stringify(await gus.page.evaluate(() => (window as any).__audioDebug?.ambience?.())));
  await shot(gus.page, '34-hal-after-offline-phase-change');
  await gus.close();
}

main()
  .catch((e) => note('FATAL followup2', e instanceof Error ? e.stack : e))
  .finally(async () => {
    for (const b of all) b.close();
    await srv?.stop();
    note('followup2 done');
    process.exit(0);
  });
