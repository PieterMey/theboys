// v1.2 (G3) containers, ws bots against a full dev server: the interactables are exactly containersOf (or the test
// double while E1's containersOf is a stub); a tap = contents + a 4-6 m 'drawer' noise; an ease = 1 m 'drawerSoft';
// a second open is denied; a stocked page appears and is filed on pickup; contents are never in a patch before the
// opening.
// Run: node tests/interaction/containers.e2e.ts [port]   (no port: spawns a temporary dev server)
import { Bot } from './bot.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import { containerStand, ensureContainers, noisesSince, place, reporter, serverNow, sleep, testServer } from './v12lib.ts';

const srv = await testServer();
const { ok, fails } = reporter();
const url = `ws://127.0.0.1:${srv.port}/ws`;
const crew = `CONT${Date.now() % 100000}`;
const a = new Bot('Searcher');
try {
  await a.connect(url, crew);
  await a.dbg('level.generate', { seed: 'g3-containers-e2e', players: 2 });
  await a.settle(600);
  await a.dbg('monsters.freeze', { on: true }).catch(() => undefined);
  const L = a.full!.layout as LevelLayout;
  const { list, real } = await ensureContainers(a, L);
  console.log(`containersOf: ${real ? 'E1 (real)' : 'stub -> test double'}, ${list.length} containers`);
  ok(list.length >= 3, `${list.length} containers on ${L.seed}`);
  const ints = Object.values(a.ix.ints).filter((i) => i.kind === 'container');
  ok(JSON.stringify(ints.map((i) => i.id).sort()) === JSON.stringify(list.map((c) => `cont:${c.id}`).sort()), 'interactables = containersOf');
  ok(ints.every((i) => i.ref && list.some((c) => c.id === i.ref) && i.r === 0.32), 'ref = container id, r 0.32');
  const peek = await a.dbg<{ contents: Record<string, { type: string; name?: string }[]> }>('interaction.peek');
  const filled = list.filter((c) => (peek.contents[c.id] ?? []).length > 0);
  ok(filled.length > 0, `${filled.length}/${list.length} hold something (rolled once, private)`);

  // stock a unique page into a closed container (fieldguide path) and open it with a tap
  const c0 = filled[0] ?? list[0]!;
  const pageId = `g3.e2e.${Date.now() % 100000}`;
  // stockContainer is a server API (fieldguide); the dev server exposes it as dbg.interaction.stock
  const st = await a.dbg<{ ok: boolean }>('interaction.stock', { id: c0.id, type: 'page', name: pageId });
  ok(st.ok, 'stockContainer(page) on a closed container');
  await place(a, ...containerStand(c0));
  await a.settle(250);
  // everything this client received so far (stringified now: the bot's mirror shares objects with old events)
  const preText = a.events.filter((ev) => ev.e === 'interaction.patch' || ev.e === 'phase').map((ev) => JSON.stringify(ev.d)).join('') + JSON.stringify(a.ix);
  let t = serverNow(a);
  let r = await a.req<{ ok: boolean; msg?: string }>('interaction.use', { id: `cont:${c0.id}` });
  ok(r.ok, `tap opened ${c0.kind} ${c0.id} ${r.msg ?? ''}`);
  await sleep(500);
  const ns = (await noisesSince(a, t)).filter((n) => Math.hypot(n.x - c0.p[0], n.z - c0.p[2]) < 1.5);
  ok(ns.length === 1 && ns[0]!.kind === 'drawer' && ns[0]!.radiusM >= 4 && ns[0]!.radiusM <= 6, `tap noise ${JSON.stringify(ns.map((n) => [n.kind, n.radiusM]))}`);
  ok(a.ix.containers?.[c0.id]?.open === 1 << c0.main, 'main part open in the patch');
  const page = Object.values(a.ix.items).find((it) => it.type === 'page' && it.name === pageId);
  ok(!!page && page.where === 'world', 'the stocked page is in the drawer');
  ok(!preText.includes(pageId), 'contents never in a patch (or the mirrored state) before the opening');
  const others = (peek.contents[c0.id] ?? []).length;
  const spawned = Object.values(a.ix.items).filter((it) => it.where === 'world' && it.p && Math.hypot(it.p[0] - c0.p[0], it.p[2] - c0.p[2]) < 1);
  ok(spawned.length >= others + 1, `contents spawned in the open part (${spawned.length} items)`);
  r = await a.req('interaction.use', { id: `cont:${c0.id}` });
  ok(!r.ok, `a second open is denied (${r.msg})`);
  // the page is filed on pickup (no slot)
  if (page) {
    r = await a.req('interaction.use', { id: page.id });
    await a.settle(120);
    ok(r.ok && !a.ix.items[page.id] && !(a.ix.inventories[a.me] ?? []).some((id) => id && a.ix.items[id]?.type === 'page'), 'page picked up without a slot');
  }

  // ease another container: 1 m drawerSoft, contents at once
  const c1 = list.find((c) => c.id !== c0.id && Math.hypot(containerStand(c)[0] - containerStand(c0)[0], containerStand(c)[1] - containerStand(c0)[1]) > 0.1);
  if (c1) {
    await place(a, ...containerStand(c1));
    await a.settle(300);
    t = serverNow(a);
    r = await a.req<{ ok: boolean; ms?: number }>('interaction.ease', { id: `cont:${c1.id}`, on: true });
    ok(r.ok && (r as { ms?: number }).ms === 1200, `ease ${c1.kind}: ${(r as { ms?: number }).ms} ms`);
    await sleep(1400);
    const ns1 = (await noisesSince(a, t)).filter((n) => Math.hypot(n.x - c1.p[0], n.z - c1.p[2]) < 1.5);
    ok(a.ix.containers?.[c1.id]?.open === 1 << c1.main, 'eased open');
    ok(ns1.length === 1 && ns1[0]!.kind === 'drawerSoft' && ns1[0]!.radiusM === 1, `ease noise ${JSON.stringify(ns1.map((n) => [n.kind, n.radiusM]))}`);
  } else ok(false, 'a second container to ease');
} catch (e) {
  ok(false, `threw: ${e instanceof Error ? (e.stack ?? e.message) : e}`);
} finally {
  a.close();
  srv.stop();
}
console.log(fails() ? `FAILED (${fails()})` : 'ALL PASS');
process.exit(fails() ? 1 : 0);
