// Follow-up checks for the robustness playtest (bots + one Chrome), on the same :3205 dev server.
//   node tests/playtest/robustness/followup.ts
import { Bot } from '../../net/bot.ts';
import { CREW, WS, chrome, dbg, note, screen, shot, sleep, st, startServer, uiJoin, waitReady } from './lib.ts';
import type { Srv } from './lib.ts';

let srv: Srv | null = null;
const all: Bot[] = [];
const mk = async (name: string, crew: string) => { const b = new Bot({ url: WS, name, crew }); await b.connect(); all.push(b); b.pose(b.pos); return b; };

async function intoContract(lead: Bot, crewBots: Bot[]): Promise<void> {
  const ms = await lead.req<any>('dbg.meta.state');
  const o = ms.orders.find((x: any) => x.available);
  const r = await lead.req<any>('meta.pick', { orderId: o.id });
  if (!r.ok) throw new Error(`pick failed: ${r.reason}`);
  for (const b of crewBots) await b.req('meta.ready', { ready: true });
  await lead.waitEvent('phase', (d: any) => d.phase === 'drive', 10_000);
  await lead.req('dbg.meta.skipDrive').catch(() => {});
  await lead.waitEvent('phase', (d: any) => d.phase === 'contract', 20_000);
}

async function main(): Promise<void> {
  srv = await startServer('followup');

  // ---------- H: a player whose connection dies mid-shout keeps 'shouting' on the server (monsters hear a ghost)
  {
    note('---- H: stale voice band after a disconnect');
    const x = await mk('LoudX', 'LOUD'), y = await mk('QuietY', 'LOUD');
    await intoContract(x, [x, y]);
    await sleep(1500);
    const L = (x.lastSnap ? (await x.req<any>('dbg.state')) : null);
    const lay = x.events.slice().reverse().find((e) => e.e === 'phase' && (e.d as any).phase === 'contract')?.d as any;
    const layout = lay?.state?.layout;
    const me = (await x.req<any>('dbg.state')).players.find((p: any) => p.id === x.me);
    const [px, , pz] = me.pose.p;
    x.pos = [px, 0, pz];
    // QuietY goes and sits in the sealed van cab
    const cab = layout?.van?.cab;
    if (cab) await y.req('dbg.monsters.tp', { x: cab.x + cab.w / 2, z: cab.y + cab.h / 2 });
    // hound 6-9 m from LoudX in the same open space
    let spot: [number, number] | null = null;
    if (layout) {
      const own = (cx: number, cz: number) => layout.owner[Math.floor(cz) * layout.W + Math.floor(cx)];
      const mine = own(px, pz);
      for (let r = 6; r <= 9 && !spot; r++) for (let a = 0; a < 16 && !spot; a++) {
        const cx = px + Math.cos((a / 16) * Math.PI * 2) * r, cz = pz + Math.sin((a / 16) * Math.PI * 2) * r;
        if (cx > 1 && cz > 1 && cx < layout.W - 1 && cz < layout.H - 1 && own(cx, cz) === mine) spot = [cx, cz];
      }
    }
    note('H: LoudX at', [px.toFixed(1), pz.toFixed(1)], 'hound spot', spot, 'L', !!L);
    if (spot) note('H: place hound:', JSON.stringify(await x.req('dbg.monsters.place', { id: 'hound', x: spot[0], z: spot[1], active: true, state: 'idle' })).slice(0, 300));
    await sleep(1000);
    x.loud(3); // LoudX shouts...
    await sleep(300);
    x.drop(); // ...and their Wi-Fi dies mid-shout
    const t0 = Date.now();
    for (let i = 0; i < 12; i++) {
      await sleep(1000);
      const ds = await y.req<any>('dbg.state');
      const gx = ds.players.find((p: any) => p.id === x.me);
      const ms = await y.req<any>('dbg.monsters.state');
      const h = (ms.agents ?? []).find((a: any) => a.kind === 'hound');
      note(`H: +${((Date.now() - t0) / 1000).toFixed(0)}s LoudX connected=${gx?.connected} band=${gx?.band} alive=${gx?.alive} | hound ${JSON.stringify(h ? { state: h.state, x: h.x, z: h.z, target: h.target ?? h.goal ?? null } : null).slice(0, 200)}`);
    }
    y.close();
  }

  // ---------- A: a disconnected (alive) player holds the wipe for the 90 s resume hold
  {
    note('---- A: wipe while one crewmate is disconnected');
    const a = await mk('WipeA', 'WIPE'), b = await mk('WipeB', 'WIPE'), c = await mk('WipeC', 'WIPE');
    await intoContract(a, [a, b, c]);
    await a.req('dbg.monsters.freeze', { on: true }).catch((e: Error) => note('freeze:', e.message));
    for (const x of [a, b, c]) x.pose(x.pos);
    await sleep(1500);
    c.drop(); // WipeC's internet dies (or tab crashed)
    await sleep(1500);
    const t0 = Date.now();
    await a.req('dbg.interaction.kill', { pid: a.me, killer: 'HOUND', reason: 'test' });
    await a.req('dbg.interaction.kill', { pid: b.me, killer: 'HOUND', reason: 'test' });
    note('A: both connected players dead at', new Date().toISOString().slice(11, 19));
    const res = await a.waitEvent('phase', (d: any) => d.phase === 'results', 120_000).then(() => 'results', () => 'still contract after 120 s');
    note(`A: ${res} ${((Date.now() - t0) / 1000).toFixed(1)} s after the last connected player died`);
    for (const x of [a, b]) x.close();
  }

  // ---------- B: a held slot blocks a new friend while the HUD shows 5/6
  {
    note('---- B: held slot vs crew cap');
    const bs: Bot[] = [];
    for (let i = 1; i <= 6; i++) bs.push(await mk(`Full${i}`, 'FULL'));
    bs[5].drop();
    await sleep(1500);
    const crewEv = [...bs[0].events].reverse().find((e) => e.e === 'crew')?.d as any;
    note('B: roster after Full6 dropped:', crewEv?.players?.map((p: any) => `${p.name}${p.connected ? '' : '(away)'}`).join(' '), `connected ${crewEv?.players?.filter((p: any) => p.connected).length}/${crewEv?.maxPlayers}`);
    const late = new Bot({ url: WS, name: 'LateFriend', crew: 'FULL' });
    note('B: new friend joins:', await late.connect().then(() => 'joined', (e: Error) => e.message));
    late.close();
    for (const x of bs) x.close();
  }

  // ---------- C/D/E: one Chrome player
  {
    note('---- C/D/E: Gus (Chrome)');
    const gus = await chrome('Gus', 'silence.wav', {}, 'GUSS');
    const m1 = await mk('GusMate1', 'GUSS');
    await waitReady(gus.page, 90_000);
    // join first so Gus is the leader
    m1.close();
    await uiJoin(gus);
    const m2 = await mk('GusMate2', 'GUSS');
    const tJoin = Date.now();
    while ((await screen(gus.page)) !== 'none' && Date.now() - tJoin < 30_000) await sleep(200);
    note(`D: join panel ("ENTERING THE LOT") closed after ${Date.now() - tJoin} ms (single Chrome, fps ${Math.round(await gus.page.evaluate(() => window.__game!.perf().fps))})`);
    await sleep(1500);
    // G: can the leader kick someone in the van? (roster/KICK lives in the net HUD)
    const kickUi = await gus.page.evaluate(() => ({ count: document.querySelectorAll('.nethud-count').length, kick: [...document.querySelectorAll('button')].filter((b) => /KICK/.test(b.textContent ?? '')).length, nethud: (document.querySelector('.nethud') as HTMLElement | null)?.innerText.replace(/\s+/g, ' ') ?? '' }));
    note('G: hub kick UI for the leader:', kickUi);
    await shot(gus.page, '29-gus-hub-leader-view');
    // C: R on the board screen
    await gus.page.keyboard.press('b');
    await sleep(800);
    const sc = await screen(gus.page);
    const meId = await gus.page.evaluate(() => window.__game!.me());
    const ready0 = (await st(gus.page)).crew.players.find((p: any) => p.id === meId)?.ready;
    await gus.page.keyboard.press('r');
    await sleep(1000);
    const ready1 = (await st(gus.page)).crew.players.find((p: any) => p.id === meId)?.ready;
    const foot = await gus.page.evaluate(() => (document.querySelector('.m-board-foot') as HTMLElement | null)?.innerText ?? '');
    note(`C: screen=${sc} ready before R=${ready0} after R=${ready1}; footer: ${foot.replace(/\s+/g, ' ').slice(0, 160)}`);
    await shot(gus.page, '30-gus-board-press-R');
    await gus.page.keyboard.press('Escape');
    await sleep(500);
    // E: inventory kept across a reload mid-contract
    const lead = new Bot({ url: WS, name: 'GusMate3', crew: 'GUSS' });
    await lead.connect(); all.push(lead);
    const ms = await dbg(gus.page, 'meta.state');
    const o = ms.orders.find((x: any) => x.available);
    await gus.page.evaluate((id) => window.__game!.req!('meta.pick', { orderId: id }), o.id);
    await gus.page.keyboard.press('r');
    for (const b of [m2, lead]) await b.req('meta.ready', { ready: true });
    const t1 = Date.now();
    while ((await st(gus.page)).phase !== 'contract' && Date.now() - t1 < 30_000) { await sleep(300); await dbg(gus.page, 'meta.skipDrive').catch(() => {}); }
    await dbg(gus.page, 'monsters.freeze', { on: true }).catch(() => {});
    await sleep(3000);
    await dbg(gus.page, 'interaction.give', { type: 'crowbar' });
    await dbg(gus.page, 'interaction.give', { type: 'bottle', count: 3 });
    await sleep(800);
    const inv = async () => {
      const s = await dbg(gus.page, 'interaction.state');
      return (s.inventories?.[meId] ?? []).map((id: string | null) => (id ? `${s.items?.[id]?.type}${s.items?.[id]?.count ? `x${s.items[id].count}` : ''}` : '-')).join(',');
    };
    note('E: Gus inventory before reload:', await inv());
    // a slower friend PC: 4x CPU throttling for the reload + rejoin
    const cdp = await gus.page.context().newCDPSession(gus.page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await gus.page.reload({ waitUntil: 'domcontentloaded' });
    await waitReady(gus.page, 90_000);
    await uiJoin(gus);
    const t2 = Date.now();
    while ((await screen(gus.page)) !== 'none' && Date.now() - t2 < 30_000) await sleep(200);
    note(`E: rejoined with 4x CPU throttle (panel closed after ${Date.now() - t2} ms, fps ${Math.round(await gus.page.evaluate(() => window.__game!.perf().fps))}); inventory after reload:`, await inv(), 'phase', (await st(gus.page)).phase);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {});
    const hud = await gus.page.evaluate(() => [...document.querySelectorAll('[class*="slot"]')].map((e) => (e as HTMLElement).innerText.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | '));
    note('E: slot HUD after reload:', hud.slice(0, 200));
    await shot(gus.page, '31-gus-after-reload-inventory');
    // F: Leave the shift from the pause menu -> slot held, shown as AWAY; rejoin works
    await gus.page.keyboard.press('Escape');
    await sleep(800);
    const leaveBtn = gus.page.locator('button:has-text("Leave the shift")');
    if (await leaveBtn.count()) {
      await leaveBtn.click();
      await sleep(400);
      await gus.page.locator('button:has-text("LEAVE")').first().click();
      await sleep(1500);
      const cr = [...lead.events].reverse().find((e) => e.e === 'crew')?.d as any;
      note('F: after Leave the shift, mates see:', cr?.players?.map((p: any) => `${p.name}${p.connected ? '' : '(away)'}`).join(' '), 'Gus screen:', await screen(gus.page));
      await shot(gus.page, '32-gus-after-leave-shift');
    } else note('F: no Leave the shift button; screen', await screen(gus.page));
    await gus.close();
  }
}

main()
  .catch((e) => note('FATAL followup', e instanceof Error ? e.stack : e))
  .finally(async () => {
    for (const b of all) b.close();
    await srv?.stop();
    note('followup done');
    process.exit(0);
  });
