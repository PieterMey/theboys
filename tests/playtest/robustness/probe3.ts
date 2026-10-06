// Probe 3: what does a player see right after joining / after a mid-contract reload (new main menu + entering overlay)?
//   node tests/playtest/robustness/probe3.ts
import { Bot } from '../../net/bot.ts';
import { WS, chrome, dbg, note, screen, shot, sleep, st, startServer, uiJoin, waitReady } from './lib.ts';
import type { Srv } from './lib.ts';
import type { Page } from 'playwright-core';

let srv: Srv | null = null;
const all: Bot[] = [];

async function sample(page: Page, tag: string, ms: number): Promise<void> {
  const t0 = Date.now();
  let i = 0;
  while (Date.now() - t0 < ms) {
    const info = await page.evaluate(() => {
      const ent = document.querySelector('[data-testid="menu-entering"]') as HTMLElement | null;
      const fade = document.querySelector('.mm-fadein');
      const s = window.__game!.state() as { screen: string; net: string; phase: string };
      return { screen: s.screen, net: s.net, phase: s.phase, entering: ent ? ent.innerText.replace(/\s+/g, ' ').slice(0, 60) : null, fade: !!fade, fps: Math.round(window.__game!.perf().fps), frameMs: Math.round(window.__game!.perf().frameMs) };
    }).catch((e: Error) => ({ err: e.message }));
    note(`${tag} +${((Date.now() - t0) / 1000).toFixed(1)}s`, info);
    if (i % 2 === 0) await shot(page, `${tag}-${String(i).padStart(2, '0')}`);
    i++;
    if ((info as { screen?: string }).screen === 'none' && i > 2) break;
    await sleep(2500);
  }
}

async function main(): Promise<void> {
  srv = await startServer('probe3');
  const p = await chrome('Ivy', 'silence.wav', {}, 'IVYY');
  await waitReady(p.page, 90_000);
  await shot(p.page, '40-ivy-menu-before-join');
  await uiJoin(p);
  const mate = new Bot({ url: WS, name: 'IvyMate', crew: 'IVYY' });
  await mate.connect(); all.push(mate);
  await sample(p.page, '41-ivy-first-join', 40_000);
  const ms = await dbg(p.page, 'meta.state');
  await p.page.evaluate((id) => window.__game!.req!('meta.pick', { orderId: id }), ms.orders.find((x: any) => x.available).id);
  await p.page.keyboard.press('r');
  await mate.req('meta.ready', { ready: true });
  const t1 = Date.now();
  while ((await st(p.page)).phase !== 'contract' && Date.now() - t1 < 30_000) { await sleep(300); await dbg(p.page, 'meta.skipDrive').catch(() => {}); }
  await dbg(p.page, 'monsters.freeze', { on: true }).catch(() => {});
  await sleep(5000);
  await shot(p.page, '42-ivy-in-contract');
  await p.page.reload({ waitUntil: 'domcontentloaded' });
  await waitReady(p.page, 90_000);
  await shot(p.page, '43-ivy-menu-after-reload');
  await uiJoin(p);
  await sample(p.page, '44-ivy-rejoin-mid-contract', 45_000);
  await p.close();
}

main()
  .catch((e) => note('FATAL probe3', e instanceof Error ? e.stack : e))
  .finally(async () => {
    for (const b of all) b.close();
    await srv?.stop();
    note('probe3 done');
    process.exit(0);
  });
