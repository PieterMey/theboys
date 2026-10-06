// Robustness playtest: chaotic friend group (4 Chrome + 2 ws bots, then joiners/leavers/reloads/restarts).
//   node tests/playtest/robustness/run.ts
// Writes tests/playtest/robustness/{run.log,server.log,monitor.jsonl,shots/*.png}
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { Bot } from '../../net/bot.ts';
import {
  BASE, CREW, OUT, TMP, WS, chrome, dbg, errorsOf, hold, note, req, screen, shot, sleep, st, startServer, toasts, uiJoin, waitReady,
} from './lib.ts';
import type { P, Srv } from './lib.ts';

const only = (process.env.STAGES ?? 'all').split(',');
const want = (s: string) => only.includes('all') || only.includes(s);

let srv: Srv;
const players: Record<string, P> = {};
const bots: Record<string, Bot> = {};
let monitorOn = true;

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  note(`---- ${name}`);
  const t0 = Date.now();
  try {
    await fn();
  } catch (e) {
    note(`!! ${name} FAILED: ${e instanceof Error ? (e.stack ?? e.message).split('\n').slice(0, 4).join(' | ') : e}`);
  }
  note(`---- ${name} done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

function memOf(pid: number): number | null {
  const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
  const m = /"([\d.,]+) K"/.exec(r.stdout ?? '');
  return m ? Number(m[1].replace(/[.,]/g, '')) / 1024 : null;
}

// a monitor bot in its own crew (does not take a slot in the test crew); dbg.stats is process-wide
let mon: Bot | null = null;
async function monitorLoop(): Promise<void> {
  const file = join(OUT, 'monitor.jsonl');
  let lastSnaps: Record<string, number> = {};
  let lastT = Date.now();
  while (monitorOn) {
    await sleep(15_000);
    try {
      if (!mon || !mon.ws || mon.ws.readyState !== 1) {
        mon = new Bot({ url: WS, name: 'Monitor', crew: 'MONI' });
        await mon.connect().catch(() => { mon = null; });
      }
      const stats = mon ? await mon.req('dbg.stats', {}, 4000).catch((e: Error) => ({ err: e.message })) : null;
      const perf = mon ? await mon.req('dbg.perf', {}, 4000).catch((e: Error) => ({ err: e.message })) : null;
      const now = Date.now();
      const botRates: Record<string, number> = {};
      for (const [n, b] of Object.entries(bots)) {
        botRates[n] = Math.round(((b.snaps - (lastSnaps[n] ?? 0)) / ((now - lastT) / 1000)) * 10) / 10;
        lastSnaps[n] = b.snaps;
      }
      lastT = now;
      const chromeHz: Record<string, unknown> = {};
      for (const [n, p] of Object.entries(players)) {
        if (p.page.isClosed()) continue;
        chromeHz[n] = await p.page.evaluate(() => {
          const s = window.__game?.state() as { diag?: { net?: { snapHz?: number; rtt?: number } }; phase?: string } | undefined;
          return { hz: s?.diag?.net?.snapHz, rtt: s?.diag?.net?.rtt, phase: s?.phase, fps: Math.round(window.__game?.perf().fps ?? 0) };
        }).catch(() => 'n/a');
      }
      const rec = { t: new Date().toISOString(), pid: srv?.pid, memMB: srv ? memOf(srv.pid) : null, stats, perf, botSnapHz: botRates, chrome: chromeHz };
      appendFileSync(file, JSON.stringify(rec) + '\n');
    } catch (e) {
      appendFileSync(file, JSON.stringify({ t: new Date().toISOString(), err: String(e) }) + '\n');
    }
  }
}

async function roster(page: Page): Promise<{ name: string; connected: boolean; isLeader: boolean; ready: boolean; alive: boolean; id: string }[]> {
  const s = await st(page);
  return (s.crew?.players ?? []).map((p: any) => ({ id: p.id, name: p.name, connected: p.connected, isLeader: p.isLeader, ready: p.ready, alive: p.alive }));
}
const rosterLine = (r: Awaited<ReturnType<typeof roster>>) => r.map((p) => `${p.isLeader ? '*' : ''}${p.name}${p.connected ? '' : '(away)'}${p.ready ? '+R' : ''}${p.alive ? '' : '(dead)'}`).join(' ');

async function metaState(page: Page): Promise<any> { return dbg(page, 'meta.state'); }

async function visibleText(page: Page, sel: string): Promise<string> {
  return page.evaluate((s) => [...document.querySelectorAll(s)].map((e) => (e as HTMLElement).innerText.trim()).filter(Boolean).join(' | '), sel);
}

async function main(): Promise<void> {
  for (const f of ['session.json']) { const p = `${TMP}/${f}`; if (existsSync(p)) rmSync(p); }
  srv = await startServer('initial');
  void monitorLoop();

  // ============================================================ 1. six join, a seventh is refused
  await step('join 4 chrome + 2 bots', async () => {
    const names: [string, string, Record<string, string>][] = [['Ann', 'talk_en.wav', {}], ['Bob', 'whisper.wav', {}], ['Cat', 'shout.wav', {}], ['Dan', 'silence.wav', { guard: '1' }]];
    const launched = await Promise.all(names.map(([n, w, q]) => chrome(n, w, q)));
    for (const p of launched) players[p.name] = p;
    for (const p of launched) {
      await waitReady(p.page, 90_000);
      await uiJoin(p);
      note(`${p.name} joined as ${await p.page.evaluate(() => window.__game!.me())}`);
      await sleep(400);
    }
    for (const n of ['Bot5', 'Bot6']) {
      const b = new Bot({ url: WS, name: n, crew: CREW });
      await b.connect();
      bots[n] = b;
      b.pose(b.pos);
    }
    await sleep(3000);
    note('roster after 6:', rosterLine(await roster(players.Ann.page)));
    await shot(players.Ann.page, '01-ann-hub-6-players');
  });

  await step('7th player refused', async () => {
    const eve = await chrome('Eve', 'silence.wav');
    await waitReady(eve.page, 90_000);
    await eve.page.locator('button:has-text("JOIN CREW")').click();
    await sleep(3500);
    const err = await visibleText(eve.page, '.error, [data-testid="net-error"]');
    note('Eve (7th) sees:', err || '(nothing)', 'screen=', await screen(eve.page), 'net=', (await st(eve.page)).net);
    await shot(eve.page, '02-eve-7th-player');
    note('Eve errors:', await errorsOf(eve));
    await eve.close();
    const b7 = new Bot({ url: WS, name: 'Bot7', crew: CREW });
    const r = await b7.connect().then(() => 'JOINED (BUG)', (e: Error) => e.message);
    note('Bot7 (7th) result:', r);
    b7.close();
  });

  // ============================================================ 2. hub chaos
  await step('hub: spam keys on Cat', async () => {
    const pg = players.Cat.page;
    await pg.mouse.click(800, 450);
    await sleep(300);
    const t0 = Date.now();
    let i = 0;
    while (Date.now() - t0 < 6000) {
      const k = ['e', 'q', 'r', 'b', 'Escape', 't', '1', '2', 'g', 'f', 'c', 'Tab'][i++ % 12];
      await pg.keyboard.press(k);
      await pg.mouse.down(); await pg.mouse.up();
      await sleep(40);
    }
    await sleep(800);
    note('Cat after spam: screen=', await screen(pg), 'ready=', (await roster(pg)).find((p) => p.name === 'Cat')?.ready, 'errors=', await errorsOf(players.Cat));
    await shot(pg, '03-cat-after-hub-spam');
    // close whatever is open
    for (let k = 0; k < 3 && (await screen(pg)) !== 'none'; k++) { await pg.keyboard.press('Escape'); await sleep(300); }
    // undo ready if spam left Cat ready
    const me = (await roster(pg)).find((p) => p.name === 'Cat');
    if (me?.ready) { await pg.keyboard.press('r'); await sleep(500); }
    note('Cat cleaned: screen=', await screen(pg), 'ready=', (await roster(pg)).find((p) => p.name === 'Cat')?.ready);
  });

  await step('hub: R toggles ready once (double handler?)', async () => {
    const pg = players.Dan.page;
    await pg.keyboard.press('r');
    await sleep(800);
    const r1 = (await roster(pg)).find((p) => p.name === 'Dan')?.ready;
    await pg.keyboard.press('r');
    await sleep(800);
    const r2 = (await roster(pg)).find((p) => p.name === 'Dan')?.ready;
    note(`Dan ready after R: ${r1}, after 2nd R: ${r2}`);
  });

  await step('hub: two players pick different orders at once', async () => {
    const A = players.Ann.page, B = players.Bob.page;
    await Promise.all([A.keyboard.press('b'), B.keyboard.press('b')]);
    await sleep(1200);
    note('screens:', await screen(A), await screen(B));
    const cardsA = A.locator('.m-order'), cardsB = B.locator('.m-order');
    note('orders visible: Ann', await cardsA.count(), 'Bob', await cardsB.count());
    await Promise.all([cardsA.nth(0).click(), cardsB.nth(1).click()]);
    await sleep(1200);
    const ms = await metaState(A);
    note('picked:', ms.picked, 'orders:', ms.orders.map((o: any) => `${o.id}:${o.siteName}:r${o.risk}:${o.available ? 'ok' : 'locked'}`).join(', '));
    note('Bob toasts:', await toasts(B), 'Ann toasts:', await toasts(A));
    await shot(B, '04-bob-board-nonleader-click');
    await shot(A, '04-ann-board-leader-pick');
  });

  await step('hub: leader leaves (closes tab)', async () => {
    const annCtx = players.Ann.page.context();
    await players.Ann.page.close();
    await sleep(2500);
    const r = await roster(players.Bob.page);
    note('roster after Ann left:', rosterLine(r));
    await shot(players.Bob.page, '05-bob-board-after-leader-left');
    const footer = await visibleText(players.Bob.page, '.m-board-foot');
    note('Bob board footer:', footer.slice(0, 200));
    // Bob picks the 2nd order now
    await players.Bob.page.locator('.m-order').nth(1).click();
    await sleep(1000);
    const ms = await metaState(players.Bob.page);
    note('after Bob click as new leader: picked=', ms.picked);
    // Ann comes back in the same browser profile (new tab), within the 90 s hold
    const pg = await annCtx.newPage();
    pg.on('pageerror', (e) => players.Ann.errors.push(`pageerror: ${e.message}`));
    pg.on('console', (m) => { if (m.type() === 'error') players.Ann.errors.push(`console: ${m.text()}`); });
    await pg.routeWebSocket(/token=/, () => {});
    await pg.goto(`${BASE}/?test=1&nobright=1#${CREW}`, { waitUntil: 'domcontentloaded' });
    players.Ann.page = pg;
    await waitReady(pg, 90_000);
    await uiJoin(players.Ann);
    await sleep(2500);
    note('roster after Ann returned:', rosterLine(await roster(pg)));
    const ms2 = await metaState(pg);
    note('picked after Ann returned:', ms2.picked);
    await shot(pg, '06-ann-returned-hub');
    // close boards
    for (const n of ['Bob']) { for (let k = 0; k < 3 && (await screen(players[n].page)) !== 'none'; k++) { await players[n].page.keyboard.press('Escape'); await sleep(300); } }
  });

  await step('hub: C crouches (no Ctrl needed)', async () => {
    const pg = players.Dan.page;
    await pg.keyboard.down('c');
    await sleep(700);
    const me = await pg.evaluate(() => window.__game!.me());
    const s1 = await st(pg);
    const stance = s1.players.find((p: any) => p.id === me)?.stance;
    await pg.keyboard.up('c');
    note('Dan stance while holding C:', stance);
  });

  // ============================================================ 3. hub restart
  if (want('restart-hub')) await step('server restart mid-hub', async () => {
    const before = await metaState(players.Bob.page);
    note('before restart: picked', before.picked, 'shift', before.shift);
    await srv.stop();
    note('server killed');
    await sleep(3000);
    srv = await startServer('restart mid-hub');
    // clients retry with backoff up to 4 s
    const t0 = Date.now();
    for (;;) {
      const sts = await Promise.all(Object.values(players).map((p) => st(p.page).then((s) => s.net).catch(() => 'n/a')));
      if (sts.every((s) => s === 'joined') || Date.now() - t0 > 30_000) { note('client net after restart:', sts.join(','), `in ${Date.now() - t0} ms`); break; }
      await sleep(500);
    }
    for (const [n, b] of Object.entries(bots)) {
      const r = await b.connect().then((w) => `rejoined ${w.crew.code} as ${w.you}`, (e: Error) => `FAILED ${e.message}`);
      note(`${n} reconnect:`, r);
    }
    await sleep(2500);
    note('roster after hub restart:', rosterLine(await roster(players.Bob.page)));
    const after = await metaState(players.Bob.page);
    note('after restart: picked', after.picked, 'shift', after.shift);
    await shot(players.Bob.page, '07-bob-after-hub-restart');
    for (const p of Object.values(players)) note(`${p.name} screen=${await screen(p.page)} errors=`, (await errorsOf(p)).slice(-3));
  });

  // ============================================================ 4. into a contract
  await step('ready up -> drive -> contract', async () => {
    const A = players.Ann.page;
    let ms = await metaState(A);
    if (!ms.picked) {
      await A.keyboard.press('b');
      await sleep(1000);
      const n = ms.orders.findIndex((o: any) => o.available && o.risk === 1);
      await A.locator('.m-order').nth(Math.max(0, n)).click();
      await sleep(800);
      await A.keyboard.press('Escape');
      ms = await metaState(A);
    }
    note('picked:', ms.picked);
    for (const p of Object.values(players)) {
      const me = (await roster(p.page)).find((q) => q.name === p.name);
      if (!me?.ready) await p.page.keyboard.press('r');
      await sleep(200);
    }
    for (const b of Object.values(bots)) await b.req('meta.ready', { ready: true }).catch((e: Error) => note('bot ready failed', e.message));
    const t0 = Date.now();
    while ((await st(A)).phase === 'hub' && Date.now() - t0 < 15_000) await sleep(300);
    note('phase:', (await st(A)).phase);
    await sleep(1500);
    await shot(players.Bob.page, '08-bob-drive');
    while ((await st(A)).phase !== 'contract' && Date.now() - t0 < 40_000) await sleep(500);
    note('phase:', (await st(A)).phase, `after ${Date.now() - t0} ms`);
    await sleep(6000);
    for (const p of Object.values(players)) {
      const s = await st(p.page);
      const me = s.players.find((q: any) => q.id === s.me);
      note(`${p.name} in contract: screen=${s.screen} pos=${me?.p?.map((v: number) => v.toFixed(1))} fps=${Math.round((await p.page.evaluate(() => window.__game!.perf().fps)))}`);
    }
    await shot(players.Cat.page, '09-cat-contract-start');
  });

  await step('contract: leader kicks Bot6 from the roster UI', async () => {
    const A = players.Ann.page;
    const count = A.locator('.nethud-count');
    note('nethud count visible:', await count.count(), await count.first().innerText().catch(() => '-'));
    if (await count.count()) {
      await count.first().click();
      await sleep(600);
      await shot(A, '10-ann-roster-open');
      const row = A.locator('.nethud-player', { hasText: 'Bot6' }).locator('button:has-text("KICK")');
      if (await row.count()) { await row.click(); await sleep(1000); }
      else note('no KICK button for Bot6');
    }
    note('roster after kick:', rosterLine(await roster(A)));
    note('Bot6 errors:', bots.Bot6.errors);
    delete bots.Bot6;
  });

  await step('contract: Fay joins mid-contract', async () => {
    const fay = await chrome('Fay', 'talk_en.wav');
    players.Fay = fay;
    await waitReady(fay.page, 90_000);
    await uiJoin(fay);
    await sleep(8000);
    const s = await st(fay.page);
    const me = s.players.find((q: any) => q.id === s.me);
    const L = await fay.page.evaluate(() => { const l = (window as any).__netDebug?.layout(); return l ? { van: l.van, kind: l.kind } : null; });
    note('Fay mid-contract: phase', s.phase, 'screen', s.screen, 'pos', me?.p, 'van', L, 'alive', s.crew.players.find((p: any) => p.id === s.me)?.alive);
    const inv = await dbg(fay.page, 'interaction.state');
    const mine = (inv.inventories?.[s.me] ?? []).map((id: string) => inv.items?.[id]?.type ?? id);
    note('Fay items:', mine);
    await shot(fay.page, '11-fay-joined-mid-contract');
    note('Fay errors:', await errorsOf(fay));
  });

  await step('contract: Cat reloads the page', async () => {
    const pg = players.Cat.page;
    const s0 = await st(pg);
    const inv0 = await dbg(pg, 'interaction.state');
    const held0 = (inv0.inventories?.[s0.me] ?? []).map((id: string) => `${id}:${inv0.items?.[id]?.type}`);
    const me0 = s0.players.find((q: any) => q.id === s0.me);
    note('Cat before reload: id', s0.me, 'held', held0, 'pos', me0?.p?.map((v: number) => v.toFixed(1)));
    await pg.reload({ waitUntil: 'domcontentloaded' });
    await waitReady(pg, 90_000);
    await shot(pg, '12a-cat-after-reload-joinscreen');
    await uiJoin(players.Cat);
    await sleep(6000);
    const s1 = await st(pg);
    const inv1 = await dbg(pg, 'interaction.state');
    const held1 = (inv1.inventories?.[s1.me] ?? []).map((id: string) => `${id}:${inv1.items?.[id]?.type}`);
    const me1 = s1.players.find((q: any) => q.id === s1.me);
    note('Cat after reload: id', s1.me, 'same id', s1.me === s0.me, 'held', held1, 'phase', s1.phase, 'pos', me1?.p?.map((v: number) => v.toFixed(1)));
    await shot(pg, '12b-cat-after-reload-ingame');
    note('Cat errors:', (await errorsOf(players.Cat)).slice(-5));
  });

  await step('contract: Dan tries to close the tab (beforeunload guard)', async () => {
    const pg = players.Dan.page;
    let dialog = '';
    pg.once('dialog', async (d) => { dialog = `${d.type()}: ${d.message()}`; await d.dismiss(); });
    await pg.mouse.click(800, 450); // a user gesture is needed for beforeunload prompts
    await pg.close({ runBeforeUnload: true });
    await sleep(1500);
    note('Dan close: dialog=', dialog || '(none)', 'page closed?', pg.isClosed());
  });

  await step('contract: spam E/LMB/Q/G/1-4 on Bob', async () => {
    const pg = players.Bob.page;
    await pg.mouse.click(800, 450);
    const locked = await pg.evaluate(() => document.pointerLockElement !== null);
    note('Bob pointer lock engaged:', locked);
    const t0 = Date.now();
    let i = 0;
    while (Date.now() - t0 < 8000) {
      const k = ['e', 'q', 'g', '1', '2', '3', '4', 'f', 't', 'e', 'e'][i++ % 11];
      if (k === 'q') await hold(pg, 'q', 60); else await pg.keyboard.press(k);
      await pg.mouse.down(); await pg.mouse.up();
      await sleep(30);
    }
    await sleep(1000);
    note('Bob after spam: screen', await screen(pg), 'errors', (await errorsOf(players.Bob)).slice(-5));
    await shot(pg, '13-bob-after-contract-spam');
    for (let k = 0; k < 3 && (await screen(pg)) !== 'none'; k++) { await pg.keyboard.press('Escape'); await sleep(300); }
  });

  await step('contract: Bob hides the tab for 60 s', async () => {
    const pg = players.Bob.page;
    const other = await pg.context().newPage();
    await other.goto('about:blank');
    await other.bringToFront();
    await sleep(1000);
    const vis = await pg.evaluate(() => document.visibilityState);
    note('Bob visibility after switching tab:', vis);
    let froze = false;
    let cdp: any = null;
    if (vis === 'visible') {
      // headless keeps every tab visible: freeze the page instead (what Chrome does to a background tab)
      cdp = await pg.context().newCDPSession(pg);
      await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
      froze = true;
      note('Bob page frozen via CDP');
    }
    const b5 = bots.Bot5;
    const seen0 = b5.seen(await (async () => (await roster(players.Ann.page)).find((p) => p.name === 'Bob')!.id)());
    await sleep(60_000);
    const bobId = (await roster(players.Ann.page)).find((p) => p.name === 'Bob');
    note('during hide, roster says Bob:', bobId);
    if (froze) await cdp.send('Page.setWebLifecycleState', { state: 'active' });
    await pg.bringToFront();
    await other.close();
    await sleep(3000);
    const s = await st(pg);
    note('Bob after return: net', s.net, 'phase', s.phase, 'snapHz', s.diag?.net?.snapHz, 'rtt', s.diag?.net?.rtt, 'screen', s.screen, 'seen0', seen0);
    await sleep(3000);
    const s2 = await st(pg);
    note('Bob +3s: net', s2.net, 'snapHz', s2.diag?.net?.snapHz, 'rtt', s2.diag?.net?.rtt, 'interp', s2.diag?.net?.interpDelayMs, 'jitter', s2.diag?.net?.jitterMs);
    await shot(pg, '14-bob-after-60s-hidden');
    note('Bob errors:', (await errorsOf(players.Bob)).slice(-5));
  });

  await step('contract: leader leaves mid-contract', async () => {
    await players.Ann.page.close();
    await sleep(2500);
    note('roster after Ann left mid-contract:', rosterLine(await roster(players.Bob.page)));
  });

  await step('contract: everyone dies (wipe -> results)', async () => {
    const pg = players.Bob.page;
    const r = await roster(pg);
    for (const p of r.filter((q) => q.connected && q.alive)) {
      const res = await dbg(pg, 'interaction.kill', { pid: p.id, killer: 'HOUND', reason: 'heard you (robustness test)' }).catch((e: Error) => e.message);
      note(`kill ${p.name}:`, res);
      await sleep(700);
      if (p.name === 'Cat') await shot(players.Cat.page, '15-cat-death-card');
    }
    await sleep(3000);
    note('phase after all connected dead:', (await st(pg)).phase, 'roster', rosterLine(await roster(pg)));
    await shot(pg, '16-bob-all-connected-dead');
    // Ann (disconnected, alive) is still in the roster for 90 s: does the wipe wait for her?
    const t0 = Date.now();
    while ((await st(pg)).phase === 'contract' && Date.now() - t0 < 100_000) await sleep(2000);
    note(`phase ${(await st(pg)).phase} after ${((Date.now() - t0) / 1000).toFixed(0)} s more`);
    await sleep(2500);
    await shot(pg, '17-bob-results');
    note('results text:', (await visibleText(pg, '.m-screen')).slice(0, 400));
    note('drone after results (Bob):', await pg.evaluate(() => (window as any).__audioDebug?.ambience?.()));
  });

  await step('results: new leader continues', async () => {
    const pg = players.Bob.page;
    const btn = pg.locator('.m-btn.primary').first();
    note('results buttons:', await visibleText(pg, '.m-screen button'));
    if (await btn.count()) { await btn.click(); await sleep(2500); }
    note('phase after continue:', (await st(pg)).phase, 'toasts', await toasts(pg));
    await shot(pg, '18-bob-after-continue');
  });

  // ============================================================ 5. restart mid-contract
  if (want('restart-contract')) await step('server restart mid-contract', async () => {
    const pg = players.Bob.page;
    // get back into a contract quickly: pick + everyone ready
    if ((await st(pg)).phase === 'results') { await sleep(16_000); }
    let ms = await metaState(pg);
    if (!ms.picked) {
      await pg.keyboard.press('b'); await sleep(1000);
      const n = ms.orders.findIndex((o: any) => o.available);
      await pg.locator('.m-order').nth(Math.max(0, n)).click(); await sleep(800);
      await pg.keyboard.press('Escape');
    }
    for (const p of Object.values(players)) {
      if (p.page.isClosed()) continue;
      const me = (await roster(p.page)).find((q) => q.name === p.name);
      if (me && !me.ready) await p.page.keyboard.press('r');
    }
    for (const b of Object.values(bots)) await b.req('meta.ready', { ready: true }).catch(() => {});
    const t0 = Date.now();
    while ((await st(pg)).phase !== 'contract' && Date.now() - t0 < 45_000) await sleep(500);
    note('phase before restart:', (await st(pg)).phase);
    await sleep(12_000);
    note('drone in contract (Bob):', await pg.evaluate(() => (window as any).__audioDebug?.ambience?.()));
    await shot(pg, '19-bob-contract-before-restart');
    await srv.stop();
    note('server killed mid-contract');
    await sleep(2000);
    await shot(pg, '20-bob-during-outage');
    note('Bob net during outage:', (await st(pg)).net, 'nethud', await visibleText(pg, '.nethud'));
    srv = await startServer('restart mid-contract');
    const t1 = Date.now();
    for (;;) {
      const sts = await Promise.all(Object.values(players).filter((p) => !p.page.isClosed()).map((p) => st(p.page).then((s) => `${p.name}:${s.net}:${s.phase}`).catch(() => 'n/a')));
      if (sts.every((s) => s.includes(':joined:')) || Date.now() - t1 > 30_000) { note('clients after restart:', sts.join(' '), `in ${Date.now() - t1} ms`); break; }
      await sleep(500);
    }
    for (const [n, b] of Object.entries(bots)) note(`${n} reconnect:`, await b.connect().then((w) => `ok ${w.crew.phase}`, (e: Error) => `FAILED ${e.message}`));
    await sleep(5000);
    const s = await st(pg);
    note('Bob after contract restart: phase', s.phase, 'screen', s.screen, 'layout', s.layout, 'objectives', !!s.objectives);
    note('drone after restart (Bob):', await pg.evaluate(() => (window as any).__audioDebug?.ambience?.()));
    note('HUD text:', (await visibleText(pg, '#overlay')).slice(0, 600));
    await shot(pg, '21-bob-after-contract-restart');
    note('roster:', rosterLine(await roster(pg)));
    for (const p of Object.values(players)) if (!p.page.isClosed()) note(`${p.name} errors:`, (await errorsOf(p)).slice(-4));
  });

  // ============================================================ 6. soak
  if (want('soak')) await step('soak: 8 min of activity', async () => {
    const t0 = Date.now();
    const walkers = Object.values(players).filter((p) => !p.page.isClosed());
    let k = 0;
    while (Date.now() - t0 < 8 * 60_000) {
      for (const p of walkers) {
        const key = ['w', 'a', 's', 'd'][(k + walkers.indexOf(p)) % 4];
        void hold(p.page, key, 900).catch(() => {});
      }
      for (const b of Object.values(bots)) { b.pose([b.pos[0] + Math.sin(k) * 0.5, b.pos[1], b.pos[2] + Math.cos(k) * 0.5]); b.loud(k % 3); }
      k++;
      await sleep(1200);
    }
  });
}

main()
  .catch((e) => note('FATAL', e instanceof Error ? e.stack : e))
  .finally(async () => {
    monitorOn = false;
    for (const p of Object.values(players)) {
      note(`${p.name} final errors:`, (await errorsOf(p).catch(() => [])).slice(-8));
      await p.close().catch(() => {});
    }
    for (const b of Object.values(bots)) b.close();
    mon?.close();
    await srv?.stop();
    note('done');
    process.exit(0);
  });
