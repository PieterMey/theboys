// Owner: fieldguide (v1.2). Drawer pages (ws bots, no GPU):
//  - at contract start up to drawerPagesMax (2) PAGE_TYPE items go into closed containers (interaction stockContainer):
//    private until opened (never in a patch), then a world item in the drawer;
//  - picking it up files that page for the picker only (no inventory slot), 'fieldguide.filed', and the item is gone;
//  - a page the picker already owns files the next missing page of that monster instead.
// Falls back to a world-spawned page (dbg.fieldguide.spawnPage) when the site has no containers (noted).
//   node tests/fieldguide/pages.e2e.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bot, check, crewCode, sleep, startServer } from './lib.ts';
import type { FgDbgState } from './lib.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import type { ItemState } from '../../packages/shared/src/messages/interaction.ts';
import { containersOf } from '../../packages/shared/src/procgen/containers.ts';
import { PAGE_TYPE } from '../../packages/shared/src/catalog.ts';

const srv = await startServer({ dir: mkdtempSync(join(process.env.FG_SCRATCH ?? tmpdir(), 'fg-pages-')) });
const bots: Bot[] = [];
const notes: string[] = [];
const pagesOf = (b: Bot) => Object.values(b.ix.items).filter((it): it is ItemState => !!it && it.type === PAGE_TYPE);
const filedPage = (b: Bot) => b.of('fieldguide.filed').map((e) => (e.d as { pageId?: string }).pageId).filter(Boolean) as string[];

try {
  const code = crewCode();
  const a = new Bot('Ada'), b = new Bot('Bea');
  bots.push(a, b);
  await a.connect(srv.ws, code);
  await b.connect(srv.ws, code);
  await sleep(300);
  await a.dbg('level.generate', { seed: 'fg-pages-1', players: 2, risk: 2 });
  await sleep(400);
  const L = a.full?.layout as LevelLayout;
  check(a.phase === 'contract' && L?.kind === 'facility', 'contract on a generated facility');
  const st = await a.dbg<FgDbgState>('fieldguide.state');
  const conts = containersOf(L);
  check(st.stocked.length <= 2, `at most drawerPagesMax (2) pages stocked (${st.stocked.length})`);
  check(new Set(st.stocked.map((x) => x.pageId)).size === st.stocked.length, 'no page id stocked twice');

  let item: ItemState | null = null;
  let pageId = '';
  if (st.stocked.length && conts.length) {
    const s0 = st.stocked[0]!;
    pageId = s0.pageId;
    const peek = (await a.dbg<{ contents: Record<string, { type: string; name?: string }[]> }>('interaction.peek')).contents;
    check((peek[s0.container] ?? []).some((x) => x.type === PAGE_TYPE && x.name === pageId), `${pageId} is private inside ${s0.container} (interaction peek)`);
    check(!pagesOf(a).length && !pagesOf(b).length, 'never in a patch before the container is opened');
    const c = conts.find((x) => x.id === s0.container)!;
    await a.pose(c.front[0], c.front[1]);
    const r = await a.req<{ ok: boolean; msg?: string }>('interaction.use', { id: `cont:${c.id}` });
    check(r.ok, `Ada searches ${c.kind} ${c.id} (${JSON.stringify(r)})`);
    for (let i = 0; i < 20 && !item; i++) { await sleep(100); item = pagesOf(a).find((x) => x.name === pageId) ?? null; }
    check(!!item && item.where === 'world', `a stocked page appears in the open drawer (${item?.id} ${item?.name})`);
  } else {
    notes.push(`no stocked page on this site (containers ${conts.length}, stocked ${st.stocked.length}): world-spawned page instead`);
    pageId = 'hound.3';
    const p = a.full?.snap?.players?.find((x) => x.id === a.me)?.p ?? [0, 0, 0];
    item = await a.dbg<ItemState>('fieldguide.spawnPage', { pageId, x: p[0] + 0.4, z: p[2] });
    await sleep(150);
  }

  // ---------------------------------------------------------------- pickup files it for the picker, no slot, item gone
  const before = await a.dbg<FgDbgState>('fieldguide.state', { pid: a.me });
  check(!before.save.pages.includes(pageId), `${pageId} not in Ada's booklet yet`);
  const pr = await a.req<{ ok: boolean; msg?: string }>('interaction.use', { id: item!.id });
  check(pr.ok, `Ada picks up the page (${JSON.stringify(pr)})`);
  await a.next((e) => e.e === 'fieldguide.filed' && (e.d as { pageId?: string }).pageId === pageId, 3000, 'filed').catch(() => null);
  await sleep(200);
  const after = await a.dbg<FgDbgState>('fieldguide.state', { pid: a.me });
  check(after.save.pages.includes(pageId) && filedPage(a).includes(pageId), `${pageId} filed for Ada ('fieldguide.filed')`);
  check(!a.ix.items[item!.id], 'the page item is gone from the world');
  const inv = (a.ix.inventories[a.me] ?? []).filter(Boolean);
  check(!inv.some((id) => a.ix.items[id!]?.type === PAGE_TYPE), 'no inventory slot used');
  const sb = await a.dbg<FgDbgState>('fieldguide.state', { pid: b.me });
  check(!sb.save.pages.includes(pageId) && !filedPage(b).length, 'Bea gets nothing from Ada\'s pickup');
  if (st.stocked.length) {
    const st2 = await a.dbg<FgDbgState>('fieldguide.state');
    check(st2.stocked.find((x) => x.pageId === pageId)?.taken === true, 'stocked page marked taken');
  }

  // ---------------------------------------------------------------- the same page again: the next one of that monster
  const pa = a.full?.snap?.players?.find((x) => x.id === a.me)?.p;
  const pos = (await a.dbg<{ p?: [number, number, number] }>('interaction.pose', {})).p ?? pa ?? [0, 0, 0];
  const dup = await a.dbg<ItemState>('fieldguide.spawnPage', { pageId, x: pos[0] + 0.5, z: pos[2] });
  await sleep(150);
  await a.req('interaction.use', { id: dup.id });
  await sleep(300);
  const st3 = await a.dbg<FgDbgState>('fieldguide.state', { pid: a.me });
  const mk = pageId.split('.')[0]!;
  check(st3.save.pages.filter((x) => x.startsWith(`${mk}.`)).length === 2, `an owned page files the next ${mk} page instead (${st3.save.pages.join(', ')})`);
  check(!a.ix.items[dup.id], 'duplicate page item removed too');

  // ---------------------------------------------------------------- a re-place on the same site never stocks twice
  const countPrivatePages = async () => {
    const pk = (await a.dbg<{ contents: Record<string, { type: string }[]> }>('interaction.peek')).contents;
    return Object.values(pk).reduce((n, l) => n + l.filter((x) => x.type === PAGE_TYPE).length, 0);
  };
  const privBefore = await countPrivatePages();
  const stockedBefore = JSON.stringify((await a.dbg<FgDbgState>('fieldguide.state')).stocked.map((x) => x.pageId));
  await a.dbg('fieldguide.flag', { on: false });
  await sleep(150);
  await a.dbg('fieldguide.flag', { on: true });
  await sleep(250);
  check(await countPrivatePages() === privBefore, `flag off/on on the same site: no extra drawer pages (${privBefore} private)`);
  check(JSON.stringify((await a.dbg<FgDbgState>('fieldguide.state')).stocked.map((x) => x.pageId)) === stockedBefore, 'stocked list kept');
  console.log(notes.length ? `NOTES:\n - ${notes.join('\n - ')}` : 'NOTES: none (real stockContainer + container search + pickup event)');
  console.log('PAGES E2E OK');
} catch (e) {
  console.error(e);
  console.error(srv.log().slice(-5000));
  process.exitCode = 1;
} finally {
  for (const x of bots) x.close();
  await srv.stop();
}
