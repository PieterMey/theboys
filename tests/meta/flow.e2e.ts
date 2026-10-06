// Owner: track (d) Meta. ws-bot test of the whole meta loop (no browser):
//   hub -> pick + ready -> drive -> contract -> (dbg end) -> results -> hub, shop, creator locks, claim code,
//   3 contracts -> shift review (promoted) -> next shift; saves written atomically.
// Run: node tests/meta/flow.e2e.ts   (boots its own dev server on a random port with a temp SAVES_DIR)
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bot } from './bot.ts';
import type { MetaState } from '../../packages/shared/src/messages/meta.ts';
import type { FullState } from '../../packages/shared/src/state.ts';

const saves = mkdtempSync(join(tmpdir(), 'deadair-meta-'));
process.env.SAVES_DIR = saves;
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
const srv = await boot({ mode: 'development', port: 0, tracks: tracks as never });
const url = `ws://127.0.0.1:${srv.port}/ws`;
const t0 = performance.now();
const step = (s: string) => console.log(`[${((performance.now() - t0) / 1000).toFixed(1)}s] ${s}`);
const meta = (b: Bot): MetaState => (b.state as FullState).meta;

let code = 0;
const bots: Bot[] = [];
try {
  const crew = 'MTST';
  const a = new Bot('Ann');
  const b = new Bot('Bob');
  bots.push(a, b);
  await a.join(url, crew);
  await b.join(url, crew);
  await new Promise((r) => setTimeout(r, 150));
  step(`joined: ${a.me} ${b.me}; install errors: ${srv.installErrors.length}`);

  // ---------- hub
  assert.equal(b.state!.phase, 'hub');
  assert.equal(b.state!.layout?.kind, 'hub', 'hub layout from generateHub');
  assert.equal(b.state!.workOrders.length, 3, '3 work orders on the board');
  for (const o of b.state!.workOrders) {
    assert.ok(o.siteName && o.history && o.memo, 'order text');
    assert.ok(o.notes.length >= 4 && o.notes.length <= 6, 'notes 4..6');
    assert.ok(o.notes.some((n) => n.body.includes('{{CODE_A}}')) && o.notes.some((n) => n.body.includes('{{CODE_B}}')), 'code placeholders');
    assert.ok(o.source === 'template' || o.source === 'ai', 'source');
  }
  assert.ok(b.state!.workOrders[2].risk === 2 && !b.state!.workOrders[2].available, 'risk 2 locked at level 1');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(meta(a).shift.quota, 375, 'first quota 500 x 0.75 (2 players)');
  assert.equal(meta(a).shift.balance, 150, 'start scrip 150');
  assert.ok(meta(a).you?.claim && /^\d+-\d{4}$/.test(meta(a).you!.claim!), 'claim code shown');
  const annClaim = meta(a).you!.claim!;
  step(`hub ok: quota ${meta(a).shift.quota}, claim ${annClaim}`);

  // non-leader cannot pick
  const order = a.state!.workOrders[0];
  const bp = await b.req<{ ok: boolean; reason?: string }>('meta.pick', { orderId: order.id });
  assert.equal(bp.ok, false, 'only the leader picks');
  // locked order cannot be picked
  const lp = await a.req<{ ok: boolean }>('meta.pick', { orderId: a.state!.workOrders[2].id });
  assert.equal(lp.ok, false, 'risk 2 locked');

  // ---------- shop
  const buy = await b.req<{ ok: boolean; balance: number }>('meta.buy', { item: 'walkie' });
  assert.deepEqual(buy, { ok: true, balance: 110 });
  const poor = await b.req<{ ok: boolean; reason?: string }>('meta.buy', { item: 'medkit' });
  assert.equal(poor.ok, true, 'medkit 45 <= 110');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(meta(a).shift.balance, 65);
  assert.equal(meta(a).gear?.[b.me]?.walkie, 1, 'walkie in the gear pool');
  assert.equal(meta(a).gear?.crew?.walkie, 2, '2 free company walkies');
  step('shop ok');

  // ---------- creator: helmet locks
  const prof = { ...a.welcome!.crew.players.find((p) => p.id === a.me)!.profile, helmet: 'diver' as const, suit: ['#c0392b', '#2c3e50'] as [string, string], visor: { glyphs: 'ANN', color: '#9dff6b' } };
  const pr = await a.req<{ ok: boolean; profile: { helmet: string; suit: string[] }; reason?: string }>('meta.profile', { profile: prof });
  assert.equal(pr.ok, false);
  assert.equal(pr.profile.helmet, 'dome', 'diver locked at level 1');
  assert.equal(pr.profile.suit[0], '#c0392b', 'suit applied');
  step(`creator ok (${pr.reason})`);

  // ---------- pick + ready -> drive -> contract
  const pk = await a.req<{ ok: boolean }>('meta.pick', { orderId: order.id });
  assert.equal(pk.ok, true);
  const drive = a.nextPhase('drive');
  await a.req('meta.ready', { ready: true });
  await b.req('meta.ready', { ready: true });
  const dv = await drive;
  const dstate = (dv.d as { state: FullState }).state;
  assert.equal(dstate.meta.drive?.rules.length, 3, '3 rule cards');
  assert.ok((dstate.meta.drive?.chatter.length ?? 0) >= 4, 'radio chatter');
  assert.equal(dstate.activeOrder?.id, order.id);
  step(`drive ok: ${dstate.meta.drive?.siteName}`);
  const contract = a.nextPhase('contract', 10_000);
  await a.req('dbg.meta.skipDrive');
  const cv = await contract;
  const cstate = (cv.d as { state: FullState }).state;
  assert.equal(cstate.layout?.kind, 'facility');
  assert.equal(cstate.layout?.seed.startsWith(order.seed), true, 'facility from order seed');
  step(`contract ok: layout ${cstate.layout?.W}x${cstate.layout?.H}, ${cstate.layout?.spaces.length} spaces`);

  // ---------- end contract -> results
  const results = a.nextPhase('results');
  const end = await a.req<{ ok: boolean }>('dbg.meta.endContract', {
    hauled: 420, lootTotal: 900, coreExtracted: true, requestsMet: [order.requests[0].kind],
    deaths: [{ player: b.me, killer: 'HOUND', reason: 'heard your SPRINT, 9 m' }],
  });
  assert.equal(end.ok, true);
  const rv = await results;
  const r = (rv.d as { state: FullState }).state.meta.results!;
  assert.equal(r.hauled, 420);
  assert.equal(r.deaths.length, 1);
  assert.equal(r.deaths[0].killer, 'HOUND');
  assert.equal(r.xp.length, 2, 'xp for both');
  assert.ok(r.xp.find((x) => x.player === a.me)!.levelUp, 'Ann levels up');
  assert.equal(r.fines.length, 1, 'badge fine for Bob');
  const reqScrip = order.requests[0].reward;
  const expectBefore = 65 + 420 + reqScrip;
  assert.equal(r.balanceAfter, expectBefore - Math.round(expectBefore * 0.1), 'balance = 65 + haul + request - 10% fine');
  assert.equal(r.shiftEnd, false);
  step(`results ok: +${r.hauled} scrip, req +${r.requestScrip}, fine ${r.fines[0].amount}, xp ${r.xp.map((x) => `${x.name}+${x.gained}(L${x.level})`).join(' ')}`);

  const hub = a.nextPhase('hub');
  const cont = await a.req<{ ok: boolean }>('meta.continue');
  assert.equal(cont.ok, true);
  const hv = await hub;
  const hstate = (hv.d as { state: FullState }).state;
  assert.equal(hstate.layout?.kind, 'hub');
  assert.equal(hstate.meta.shift.contract, 1);
  assert.equal(hstate.workOrders.length, 3);
  assert.notEqual(hstate.workOrders[0].id, order.id, 'fresh board');
  assert.ok(hstate.workOrders[2].available, 'risk 2 unlocked by Core Business');
  step('back in hub ok');

  // diver still locked (level 2), box unlocked
  const pr2 = await a.req<{ ok: boolean; profile: { helmet: string } }>('meta.profile', { profile: { ...prof, helmet: 'box' } });
  assert.equal(pr2.ok, true);
  assert.equal(pr2.profile.helmet, 'box', 'box unlocked at level 2');

  // ---------- claim from a new browser key (a returning player on a new tunnel origin)
  const c = new Bot('Cat');
  bots.push(c);
  const cw = await c.join(url, crew);
  const catClaim = cw.state.meta.you!.claim!;
  await c.req('meta.profile', { profile: { ...cw.crew.players.find((p) => p.id === c.me)!.profile, suit: ['#8e44ad', '#ecf0f1'] } });
  c.close();
  await new Promise((r) => setTimeout(r, 200));
  const e2 = new Bot('Cat-newlaptop');
  bots.push(e2);
  await e2.join(url, crew);
  const [badge, pin] = catClaim.split('-');
  await assert.rejects(e2.req('claim', { name: badge, pin: pin === '0000' ? '1111' : '0000' }), /no profile/);
  const [aBadge, aPin] = annClaim.split('-');
  await assert.rejects(e2.req('claim', { name: aBadge, pin: aPin }), /in use/, 'cannot steal a live profile');
  const cl = await e2.req<{ ok: boolean; level?: number }>('claim', { name: badge, pin });
  assert.equal(cl.ok, true);
  await new Promise((r) => setTimeout(r, 150));
  const me2 = e2.events.filter((ev) => ev.e === 'crew').pop()!.d as { players: { id: string; name: string; profile: { suit: string[]; badge: number } }[] };
  const mine = me2.players.find((p) => p.id === e2.me)!;
  assert.equal(mine.name, 'Cat', 'claimed name');
  assert.equal(mine.profile.suit[0], '#8e44ad', 'claimed suit');
  assert.equal(String(mine.profile.badge), badge, 'claimed badge');
  const byName = await e2.req<{ ok: boolean }>('claim', { name: 'cat', pin });
  assert.equal(byName.ok, true, 'name + PIN works too');
  e2.close();
  await new Promise((r) => setTimeout(r, 200));
  step('claim ok');

  // ---------- contracts 2 and 3 -> shift end
  for (let k = 2; k <= 3; k++) {
    const o = a.state!.workOrders[0];
    await a.req('meta.pick', { orderId: o.id });
    const dr = a.nextPhase('drive');
    await a.req('meta.ready', { ready: true });
    await b.req('meta.ready', { ready: true });
    await dr;
    const ct = a.nextPhase('contract', 10_000);
    await a.req('dbg.meta.skipDrive');
    await ct;
    const rs = a.nextPhase('results');
    await a.req('dbg.meta.endContract', { hauled: 260, coreExtracted: false });
    const rr = (await rs).d as { state: FullState };
    if (k === 3) {
      const rev = rr.state.meta.review;
      assert.ok(rr.state.meta.results?.shiftEnd, 'shift end flagged');
      assert.ok(rev, 'HR review present');
      assert.equal(rev!.hauled, 420 + 260 + 260);
      assert.equal(rev!.verdict, 'promoted', 'quota met (940 >= 375)');
      assert.equal(rev!.memos.length, 2, 'one memo per player');
      assert.ok(rev!.memos.every((m) => m.body.length > 40));
      step(`shift review ok: ${rev!.verdict}, overtime ${rev!.overtime}, next quota ${rev!.nextQuota}`);
    }
    const hb = a.nextPhase('hub');
    await a.req('meta.continue');
    await hb;
  }
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(meta(a).shift.index, 1, 'promoted to shift 2');
  assert.equal(meta(a).shift.contract, 0);
  assert.equal(meta(a).shift.hauled, 0);
  assert.ok(meta(a).shift.quota > 375, 'higher quota');
  step(`next shift ok: quota ${meta(a).shift.quota}, balance ${meta(a).shift.balance}`);

  // ---------- fired path: force a missed quota on contract 3
  await a.req('dbg.meta.shift', { contract: 2, hauled: 0 });
  const o3 = a.state!.workOrders[0];
  await a.req('meta.drive', { orderId: o3.id });
  const ct3 = a.nextPhase('contract', 10_000);
  await a.req('dbg.meta.skipDrive');
  await ct3;
  const rs3 = a.nextPhase('results');
  await a.req('dbg.meta.endContract', { hauled: 10 });
  const r3 = ((await rs3).d as { state: FullState }).state.meta;
  assert.equal(r3.review?.verdict, 'fired');
  assert.ok(r3.review?.letter && r3.review.letter.length > 100, 'termination letter');
  const hb3 = a.nextPhase('hub');
  await a.req('meta.continue');
  await hb3;
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(meta(a).shift.index, 0, 'run reset');
  assert.equal(meta(a).shift.balance, 150, 'balance reset');
  assert.ok((meta(a).you?.level ?? 0) >= 2, 'levels kept');
  step('fired path ok');

  // ---------- saves
  await a.req('dbg.meta.flush');
  const crewFile = join(saves, 'crews', `${crew}.json`);
  assert.ok(existsSync(crewFile), 'crew save written');
  const cs = JSON.parse(readFileSync(crewFile, 'utf8'));
  assert.equal(cs.history.length, 4, '4 contracts in history');
  const pfiles = readdirSync(join(saves, 'players'));
  assert.ok(pfiles.length >= 2, 'player saves');
  const ann = JSON.parse(readFileSync(join(saves, 'players', `${a.me}.json`), 'utf8'));
  assert.ok(ann.xp > 150 && ann.achievements.includes('Core Business') && /^[0-9a-f]{64}$/.test(ann.pinHash), 'player save fields');
  assert.ok(!JSON.stringify(ann).includes(`"${annClaim.split('-')[1]}"`), 'PIN not stored in plain text');
  step(`saves ok: ${crewFile} + ${pfiles.length} player files (xp ${ann.xp}, L${ann.level})`);
  console.log(`META FLOW E2E PASS (${((performance.now() - t0) / 1000).toFixed(1)} s) saves=${saves}`);
} catch (e) {
  code = 1;
  console.error('META FLOW E2E FAIL:', e instanceof Error ? (e.stack ?? e.message) : e);
} finally {
  for (const b of bots) b.close();
  await srv.close().catch(() => {});
  process.exitCode = code;
  setTimeout(() => process.exit(code), 800).unref();
}
