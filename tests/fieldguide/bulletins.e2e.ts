// Owner: fieldguide (v1.2). Hazard bulletins (ws bots, no GPU):
//  - placed after interaction's rebuild on a dbg relayout: kind 'bulletin' interactables (ref = lore spot), 2/3/4 by risk,
//    at most one per room, never the entrance, deep first;
//  - deterministic per (seed, crew code): the same site again gives the same spots;
//  - reading files the next missing page of its monster for the reader only, once per player ('fieldguide.read' +
//    'fieldguide.filed'), re-reads show the same page without filing; footprints targets follow who still lacks a page;
//  - the van shelf ('fg:' + booklet station) opens the booklet ('fieldguide.open').
// Uses E1's real loreSpotsOf when the generated site has lore spots; otherwise dbg.fieldguide.fakeSpots (noted).
//   node tests/fieldguide/bulletins.e2e.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bot, check, crewCode, sleep, startServer } from './lib.ts';
import type { FgDbgState } from './lib.ts';
import type { FieldGuideView } from '../../packages/shared/src/messages/fieldguide.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import { loreSpotsOf } from '../../packages/shared/src/procgen/lore.ts';

const srv = await startServer({ dir: mkdtempSync(join(process.env.FG_SCRATCH ?? tmpdir(), 'fg-bul-')) });
const bots: Bot[] = [];
const notes: string[] = [];

async function load(b: Bot, seed: string, risk: number): Promise<FgDbgState> {
  // E1's generator with the level tuning (dbg.interaction.loadLayout falls back to a v1.1 fixture without lore spots)
  await b.dbg('level.generate', { seed, players: 2, risk });
  await sleep(250);
  let st = await b.dbg<FgDbgState>('fieldguide.state');
  if (!st.bulletins.length) {
    notes.push(`seed ${seed}: no lore spots from loreSpotsOf -> dbg.fieldguide.fakeSpots`);
    await b.dbg('fieldguide.fakeSpots', { on: true });
    await sleep(100);
    st = await b.dbg<FgDbgState>('fieldguide.state');
  }
  return st;
}

try {
  const code = crewCode();
  const a = new Bot('Ada'), b = new Bot('Bea');
  bots.push(a, b);
  await a.connect(srv.ws, code);
  await b.connect(srv.ws, code);
  await sleep(400);

  // ---------------------------------------------------------------- the van shelf (hub)
  const hub = await a.dbg<FgDbgState>('fieldguide.state');
  check(!!hub.shelf && !!a.ix.ints[hub.shelf.id], `van shelf registered in the hub (${hub.shelf?.id})`);
  await a.pose(hub.shelf!.p[0] - 0.8, hub.shelf!.p[2], -Math.PI / 2);
  const shelfUse = await a.req<{ ok: boolean; msg?: string }>('interaction.use', { id: hub.shelf!.id });
  const opened = a.of('fieldguide.open').length > 0 || (await a.next((e) => e.e === 'fieldguide.open', 1500, 'fieldguide.open').then(() => true, () => false));
  check(shelfUse.ok && opened, `E on the shelf -> fieldguide.open (${JSON.stringify(shelfUse)})`);

  // ---------------------------------------------------------------- placement on a contract (risk 2 -> 3 bulletins)
  const s1 = await load(a, 'fg-bul-1', 2);
  const L = (a.full?.layout ?? null) as LevelLayout | null;
  check(a.phase === 'contract' && !!L, 'dbg relayout -> contract phase');
  const want = 3;
  const dist = (sp: number) => L!.spaces.find((s) => s.id === sp)!.dist;
  const maxD = Math.max(...L!.spaces.map((s) => s.dist));
  const cand = s1.fake ? null : loreSpotsOf(L!).filter((x) => x.style !== 'drawer' && x.space !== L!.entrance && x.roomType !== 'lobby');
  const rooms = cand ? new Set(cand.map((x) => x.space)).size : want;
  check(s1.bulletins.length === Math.min(want, rooms), `risk 2 -> min(3, ${rooms} lore rooms) bulletins (got ${s1.bulletins.length})`);
  const spaces = s1.bulletins.map((x) => x.space);
  check(new Set(spaces).size === spaces.length, `one bulletin per room (${spaces.join(', ')})`);
  check(!spaces.includes(L!.entrance), 'never the entrance / lobby');
  const depths = spaces.map(dist);
  if (cand) {
    const deepRooms = new Set(cand.filter((x) => dist(x.space) >= 0.35 * maxD).map((x) => x.space)).size;
    const deepPicked = depths.filter((d) => d >= 0.35 * maxD).length;
    check(deepPicked === Math.min(want, deepRooms), `deep first: ${deepPicked} of ${deepRooms} deep lore rooms used (>= 0.35 of ${maxD} m: ${depths.join(', ')})`);
    check(s1.bulletins.every((x) => cand.some((c) => c.id === x.spot)), 'bulletins sit on E1 lore spots (wall styles, not drawers)');
  }
  for (const x of s1.bulletins) {
    const int = a.ix.ints[x.id];
    check(!!int && int.kind === 'bulletin' && int.ref === x.spot && int.prompt === 'Read the hazard bulletin' && int.r === 0.6 && x.id === `lore:${x.spot}`,
      `${x.id} registered after the rebuild (kind bulletin, ref ${x.spot}, monster ${x.monster})`);
  }
  check(s1.bulletins.every((x) => s1.present.includes(x.monster)), `monsters present this contract (${s1.present.join('/')})`);
  await sleep(1200);
  const mons = await a.dbg<{ agents?: { id: string; kind: string }[] }>('monsters.state');
  const started = new Set((mons.agents ?? []).filter((x) => x.id !== 'kennel').map((x) => x.kind));
  const s1b = await a.dbg<FgDbgState>('fieldguide.state');
  check(!started.size || s1b.bulletins.every((x) => started.has(x.monster)), `bulletin monsters are ones that started (${[...started].join('/')}: ${s1b.bulletins.map((x) => x.monster).join(', ')})`);
  const drawerSpots = s1.stocked.filter((x) => x.spot).map((x) => x.spot!);
  check(s1.bulletins.every((x) => s1.targets.includes(x.spot)) && s1.targets.length === s1.bulletins.length + new Set(drawerSpots).size,
    `footprints target every unread bulletin + drawer lore spots holding a page (${s1.targets.join(', ')})`);
  const view = await a.req<FieldGuideView>('fieldguide.get');
  check(view.bulletins?.length === s1.bulletins.length && view.bulletins.every((x) => !x.read), 'view lists the site bulletins (unread)');

  // ---------------------------------------------------------------- determinism: another site, then the same one again
  const sOther = await load(a, 'fg-bul-2', 1);
  check(sOther.bulletins.length > 0 && sOther.bulletins.length <= 2, `risk 1 -> up to 2 bulletins (got ${sOther.bulletins.length})`);
  const again = await load(a, 'fg-bul-1', 2);
  check(JSON.stringify(again.bulletins.map((x) => x.spot)) === JSON.stringify(s1.bulletins.map((x) => x.spot)), `same seed + crew -> same spots (${again.bulletins.map((x) => x.spot).join(', ')})`);

  // ---------------------------------------------------------------- reading: once per player
  const bul = again.bulletins[0]!;
  await a.pose(bul.front[0], bul.front[1]);
  await b.pose(bul.front[0], bul.front[1]);
  const r1 = await a.req<{ ok: boolean; msg?: string }>('interaction.use', { id: bul.id });
  check(r1.ok, `Ada reads ${bul.id} (${JSON.stringify(r1)})`);
  const readA = await a.next((e) => e.e === 'fieldguide.read', 3000, 'fieldguide.read').catch(() => null) ?? a.of('fieldguide.read').at(-1)!;
  const dA = readA.d as { spot: string; monster: string; title: string; text: string; filed: boolean; pageId: string; n: number; of: number };
  check(dA.spot === bul.spot && dA.monster === bul.monster && dA.filed && dA.title.length > 3 && dA.text.length > 60, `fieldguide.read: ${dA.pageId} "${dA.title}" (${dA.n}/${dA.of})`);
  await sleep(150);
  const filedA = a.of('fieldguide.filed').filter((e) => (e.d as { pageId?: string }).pageId === dA.pageId);
  check(filedA.length === 1, 'fieldguide.filed for the reader');
  check(!b.of('fieldguide.read').length && !b.of('fieldguide.filed').some((e) => (e.d as { pageId?: string }).pageId), 'nothing sent to Bea');
  const r2 = await a.req<{ ok: boolean }>('interaction.use', { id: bul.id });
  await sleep(200);
  const reads = a.of('fieldguide.read');
  const dA2 = reads.at(-1)!.d as { pageId: string; filed: boolean };
  check(r2.ok && dA2.pageId === dA.pageId && dA2.filed === false, 're-read shows the same page, files nothing');
  check(a.of('fieldguide.filed').filter((e) => (e.d as { pageId?: string }).pageId).length === 1, 'filed once per player');
  const rb = await b.req<{ ok: boolean }>('interaction.use', { id: bul.id });
  const readB = await b.next((e) => e.e === 'fieldguide.read', 3000, 'Bea fieldguide.read').catch(() => null) ?? b.of('fieldguide.read').at(-1)!;
  check(rb.ok && (readB.d as { filed: boolean }).filed === true, 'Bea gets her own page from the same bulletin');
  await sleep(200);
  const st2 = await a.dbg<FgDbgState>('fieldguide.state', { pid: a.me });
  check(st2.save.pages.includes(dA.pageId), 'page in Ada\'s save');
  check(!st2.targets.includes(bul.spot), 'footprints no longer lead to a bulletin both have read');
  const vA = await a.req<FieldGuideView>('fieldguide.get');
  const m = vA.monsters.find((x) => x.kind === bul.monster)!;
  check(m.pages.some((p) => p.id === dA.pageId && p.text.length > 60), 'the booklet carries the owned page text');
  check(m.pages.length === 1 && !JSON.stringify(vA).includes('{{'), 'only owned pages, placeholders filled');
  check(vA.bulletins?.find((x) => x.spot === bul.spot)?.read === true, 'view marks the bulletin read (lore frame dims)');
  // a second bulletin of the same monster gives the NEXT page
  const same = again.bulletins.find((x) => x !== bul && x.monster === bul.monster);
  if (same) {
    await a.pose(same.front[0], same.front[1]);
    await a.req('interaction.use', { id: same.id });
    const r = await a.next((e) => e.e === 'fieldguide.read', 3000, 'second bulletin').catch(() => null) ?? a.of('fieldguide.read').at(-1)!;
    const d = r.d as { pageId: string; filed: boolean };
    check(d.filed && d.pageId !== dA.pageId, `a second ${bul.monster} bulletin files the next page (${d.pageId})`);
  } else notes.push(`no second ${bul.monster} bulletin on this site: next-page case covered by logic.test.ts`);
  // ---------------------------------------------------------------- the van shelf on site too
  const sc = await a.dbg<FgDbgState>('fieldguide.state');
  check(!!sc.shelf && a.ix.ints[sc.shelf.id]?.kind === 'fieldguide', `van shelf registered in the contract van (${sc.shelf?.id})`);
  // ---------------------------------------------------------------- flag off: everything comes out, events are ignored; on: back
  await a.dbg('fieldguide.flag', { on: false });
  await sleep(200);
  const off = await a.dbg<FgDbgState>('fieldguide.state');
  const ints = Object.values(a.ix.ints).filter((x) => x && (x.kind === 'bulletin' || x.kind === 'fieldguide'));
  check(!off.enabled && ints.length === 0 && off.bulletins.length === 0, `flag off: no shelf or bulletin interactables (${ints.length})`);
  const filedBefore = a.of('fieldguide.filed').length;
  await a.dbg('fieldguide.event', { monster: 'snatcher', event: 'seen' });
  await sleep(150);
  check(a.of('fieldguide.filed').length === filedBefore && !(await a.dbg<FgDbgState>('fieldguide.state')).save.monsters.snatcher, 'flag off: encounters are not recorded');
  await a.dbg('fieldguide.flag', { on: true });
  await sleep(300);
  const on = await a.dbg<FgDbgState>('fieldguide.state');
  check(on.enabled && on.bulletins.length === again.bulletins.length && !!a.ix.ints[on.bulletins[0]!.id] && !!a.ix.ints[on.shelf!.id], 'flag on again: shelf + bulletins re-registered');
  const keep = on.bulletins.find((x) => x.spot === bul.spot);
  check(!!keep && keep.reads[a.me] === dA.pageId && keep.monster === bul.monster, 'same site re-placed: who read which bulletin is kept');
  await a.pose(bul.front[0], bul.front[1]);
  const filedN = a.of('fieldguide.filed').filter((e) => (e.d as { pageId?: string }).pageId).length;
  await a.req('interaction.use', { id: bul.id });
  await sleep(250);
  check(a.of('fieldguide.filed').filter((e) => (e.d as { pageId?: string }).pageId).length === filedN, 'no extra page from a re-placed bulletin');
  console.log(notes.length ? `NOTES:\n - ${notes.join('\n - ')}` : 'NOTES: none (E1 loreSpotsOf real)');
  console.log('BULLETINS E2E OK');
} catch (e) {
  console.error(e);
  console.error(srv.log().slice(-5000));
  process.exitCode = 1;
} finally {
  for (const x of bots) x.close();
  await srv.stop();
}
