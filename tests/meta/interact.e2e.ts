// Owner: track (d) Meta. ws-bot check of the cross-track wiring in the van hub:
//   (b) interaction routes E on board/shop/mirror/console to meta -> 'meta.open'; shop gear is handed out via
//   (b) giveItem at contract start (2 free company walkies + bought items); (a) real contract end -> results.
// Run: node tests/meta/interact.e2e.ts
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bot } from './bot.ts';
import type { FullState } from '../../packages/shared/src/state.ts';

process.env.SAVES_DIR = mkdtempSync(join(process.env.META_SAVES ?? tmpdir(), 'deadair-meta-ix-'));
process.env.SESSION_FILE = join(process.env.SAVES_DIR, 'session.json'); // never <repo>/saves/session-<port>.json (the live server's folder)
process.env.NODE_ENV = 'development';
const { boot } = await import('../../apps/server/src/core/boot.ts');
const { setQuiet } = await import('../../apps/server/src/core/log.ts');
const tracks = await Promise.all(
  ['net', 'level', 'players', 'voice', 'objectives', 'interaction', 'monsters', 'meta', 'ai'].map(async (n) => {
    const m = (await import(`../../apps/server/src/${n}/index.ts`)) as { install: (ctx: never) => unknown };
    return [n, m.install] as [string, (ctx: never) => unknown];
  }),
);
if (!process.env.VERBOSE) setQuiet(true);
const srv = await boot({ mode: 'development', port: Number(process.env.PORT ?? 0), tracks: tracks as never });
const url = `ws://127.0.0.1:${srv.port}/ws`;
let code = 0;
const bots: Bot[] = [];
try {
  const a = new Bot('Ann');
  const b = new Bot('Bob');
  bots.push(a, b);
  await a.join(url, 'IXTS');
  await b.join(url, 'IXTS');
  await new Promise((r) => setTimeout(r, 400));
  const L = a.state!.layout!;
  for (const kind of ['board', 'shop', 'mirror', 'console']) {
    const it = L.items.find((i) => i.kind === kind)!;
    // stand in front of it, towards the van centre for the console (it sits inside the sealed cab)
    const toward = kind === 'console' ? [L.van.x - it.x, L.van.z - it.z] : [0.6, 0.6];
    const n = Math.hypot(toward[0], toward[1]) || 1;
    await a.req('dbg.interaction.pose', { x: it.x + (toward[0] / n) * 0.7, z: it.z + (toward[1] / n) * 0.7 });
    const open = a.next((e) => e.e === 'meta.open', 3000, `meta.open ${kind}`);
    const r = await a.req<{ ok: boolean; msg?: string }>('interaction.use', { id: it.id }).catch((e: Error) => ({ ok: false, msg: e.message }));
    const ev = await open.catch((e: Error) => { throw new Error(`${kind}: no meta.open (use -> ${JSON.stringify(r)}): ${e.message}`); });
    assert.equal((ev.d as { screen: string }).screen, kind);
    console.log(`E at ${it.id} -> meta.open ${(ev.d as { screen: string }).screen} (use ok=${r.ok})`);
  }

  // kennel: (b) may or may not route it (InteractableKind has no 'kennel'); the client handles E there either way
  {
    const it = L.items.find((i) => i.kind === 'kennel')!;
    await a.req('dbg.interaction.pose', { x: it.x, z: it.z - 0.8 });
    const open = a.next((e) => e.e === 'meta.open', 1500, 'meta.open kennel').catch(() => null);
    const r = await a.req<{ ok: boolean; msg?: string }>('interaction.use', { id: it.id }).catch((e: Error) => ({ ok: false, msg: e.message }));
    const ev = await open;
    console.log(`E at ${it.id} -> ${ev ? `meta.open ${(ev.d as { screen: string }).screen}` : `not routed by (b) (${r.msg ?? r.ok}); client-side fallback opens it`}`);
  }

  // shop -> gear handed out at contract start via (b) giveItem
  await b.req('meta.buy', { item: 'crowbar' });
  await b.req('meta.buy', { item: 'bottles' });
  const order = a.state!.workOrders[0];
  await a.req('meta.pick', { orderId: order.id });
  const contract = a.nextPhase('contract', 12000);
  await a.req('meta.ready', { ready: true });
  await b.req('meta.ready', { ready: true });
  await a.nextPhase('drive');
  await a.req('dbg.meta.skipDrive');
  const cs = ((await contract).d as { state: FullState }).state;
  await new Promise((r) => setTimeout(r, 400));
  const ix = (await a.req<{ inventories?: Record<string, (string | null)[]>; items?: Record<string, { type: string }> }>('dbg.interaction.state')) ?? {};
  const inv = (pid: string) => (ix.inventories?.[pid] ?? []).filter(Boolean).map((id) => ix.items?.[id as string]?.type ?? id);
  console.log(`inventories: Ann=${JSON.stringify(inv(a.me))} Bob=${JSON.stringify(inv(b.me))}`);
  const all = [...inv(a.me), ...inv(b.me)];
  assert.equal(all.filter((t) => t === 'walkie').length, 2, '2 free company walkies handed out');
  assert.ok(inv(b.me).includes('crowbar'), 'Bob got his crowbar');
  assert.ok(inv(b.me).filter((t) => t === 'bottle').length >= 1, 'Bob got bottles');
  void cs;
  const objEv = a.events.filter((e) => e.e === 'objectives.state').pop();
  assert.ok(objEv && (objEv.d as { active?: boolean }).active === true, '(a) objectives contract running after startContract');
  console.log(`(a) objectives running: code ${(objEv!.d as { code?: string }).code}, ${(objEv!.d as { loot?: unknown[] }).loot?.length ?? 0} loot`);

  // real end through (a): leave-now path via objectives.endContract
  const results = a.nextPhase('results', 8000);
  await a.req('dbg.meta.endContract', { real: true });
  const rs = ((await results).d as { state: FullState }).state.meta.results!;
  console.log(`(a) ended the contract: outcome=${rs.outcome} hauled=${rs.hauled} deaths=${rs.deaths.length} xp=${rs.xp.map((x) => x.gained).join('/')}`);
  assert.ok(rs.outcome === 'left_early' || rs.outcome === 'extracted' || rs.outcome === 'wiped', `outcome ${rs.outcome}`);
  assert.equal(rs.contract, 1);
  const hub = a.nextPhase('hub', 8000);
  await a.req('meta.continue');
  await hub;
  const st = (await a.req<{ gear: Record<string, Record<string, number>> }>('dbg.meta.state'));
  console.log(`gear after contract (survivors keep theirs): ${JSON.stringify(st.gear)}`);
  console.log('META INTERACT E2E PASS');
} catch (e) {
  code = 1;
  console.error('META INTERACT E2E FAIL:', e instanceof Error ? (e.stack ?? e.message) : e);
} finally {
  for (const b of bots) b.close();
  await srv.close().catch(() => {});
  process.exitCode = code;
  setTimeout(() => process.exit(code), 800).unref();
}
