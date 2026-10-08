// Owner: fieldguide (v1.2). ONE batched browser run, always through the GPU guard (software rendering since 2026-10-08):
//   node tools/gpu-guard.mjs --max-sec 120 --label "G6 fieldguide shots" -- node tests/fieldguide/shots.e2e.ts
// FG_PLAN = which views at which sizes, e.g. "1024x576:all;1280x720:mannequin,reader" (all = the five tabs + the reader;
// default "1280x720:all;1024x576:all;1600x900:all"). The booklet shows a seen Hound with pages, a heard-only Listener,
// a seen Mannequin with one page (the longest tab label), an unknown Snatcher and ANOMALIES. Every view is screenshotted
// AND measured in the page; a layout problem fails the run:
//  - the sketch stays inside its photo, the photo keeps >= 100 px, the left-page blocks keep their order without
//    overlapping and all stay on the page (gate R: the Listener silhouette covered its caption and FIRST CONTACT)
//  - the booklet footer, the reader's stamp and its key hint keep one line each (gate R: 'guide' wrapped at 1024x576)
//  - tabs on screen and on the book with their labels inside, no sideways overflow on the right page, none of our
//    toasts over a sheet
// FG_FLOW=1 (default) also checks, at the first size: our toasts are taken down when the booklet opens, held while a
// sheet is open and shown when it closes, the reader's own page gets none; J toggles, J is ignored while typing, Esc
// closes. FG_LORE=1 adds a bulletin on a lore frame in a generated facility (needs E3's level.setLorePage; slow).
// FG_MAXFPS (default 6) caps the 3D draw behind the sheets so software rendering leaves time for the checks.
// Writes tests/artifacts/fieldguide/fg-<WxH>-<view>.png + layout.json. A hard deadline keeps the run under the limit.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { launchPlayer, waitForGame } from '../lib/launch.ts';
import type { Player } from '../lib/launch.ts';
import { REPO, crewCode, sleep, startServer } from './lib.ts';
import type { FgDbgState } from './lib.ts';

const T0 = Date.now();
const DEADLINE = T0 + Number(process.env.FG_DEADLINE_SEC ?? 110) * 1000;
const left = () => DEADLINE - Date.now();
const OUT = join(REPO, 'tests/artifacts/fieldguide');
mkdirSync(OUT, { recursive: true });
const log = (...a: unknown[]) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a);
const TABS = ['hound', 'listener', 'mannequin', 'snatcher', 'anomalies'] as const;
type Tab = (typeof TABS)[number];
const PLAN = (process.env.FG_PLAN ?? '1280x720:all;1024x576:all;1600x900:all').split(';').map((entry) => {
  const [size, views = 'all'] = entry.trim().split(':');
  const [w, h] = (size ?? '').split('x').map(Number);
  const list = views.split(',').map((v) => v.trim()).flatMap((v) => (v === 'all' ? [...TABS, 'reader'] : [v]));
  return { w: w!, h: h!, tabs: TABS.filter((t) => list.includes(t)), reader: list.includes('reader') };
}).filter((p) => p.w > 0 && p.h > 0);
const FLOW = process.env.FG_FLOW !== '0';

/** Other agents edit the shared tree: stub Vite's HMR client so no full reload lands mid-run (same trick as tests/meta). */
const VITE_STUB = `
import '/@vite/env';
export function createHotContext() { return { data: {}, accept() {}, acceptExports() {}, dispose() {}, prune() {}, invalidate() {}, decline() {}, on() {}, off() {}, send() {} }; }
const sheets = new Map();
export function updateStyle(id, css) { let el = sheets.get(id); if (!el) { el = document.createElement('style'); el.setAttribute('type', 'text/css'); el.setAttribute('data-vite-dev-id', id); document.head.appendChild(el); sheets.set(id, el); } el.textContent = css; }
export function removeStyle(id) { const el = sheets.get(id); if (el) { el.remove(); sheets.delete(id); } }
export function injectQuery(url) { return url; }
export class ErrorOverlay extends HTMLElement {}
`;

const failures: string[] = [];
const fail = (msg: string) => { failures.push(msg); console.error(`FAIL: ${msg}`); };
const layout: Record<string, unknown> = {};
/** views not reached before the deadline (reported, not failed) */
const skipped: string[] = [];

async function shot(page: Page, name: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const r = (await Promise.race([
      cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('capture timeout')), Math.max(3000, Math.min(20000, left() - 2000)))),
    ])) as { data: string };
    const p = join(OUT, `${name}.png`);
    writeFileSync(p, Buffer.from(r.data, 'base64'));
    log('shot', p);
  } finally {
    await cdp.detach().catch(() => {});
  }
}

type W = { __game: { dbg(r: string, a?: unknown): Promise<unknown>; state(): { net?: string; phase?: string }; me(): string | null; teleport(x: number, z: number, yaw?: number): void; look(y: number, p: number): void; errors(): string[] };
  __fieldguide: { open(t?: string): void; close(): void; screen(): string; view(): { monsters: { kind: string; pages: { id: string; title: string; text: string }[] }[] } | null; reader(d: unknown): void; sync(): void; lorePages(): Record<string, unknown>; levelLore(): { setLorePage: boolean; loreSpots: boolean }; toasts(): { held: string[]; up: string[] } } };
const dbg = (page: Page, r: string, a?: unknown) => page.evaluate(([rr, aa]) => (window as unknown as W).__game.dbg(rr as string, aa), [r, a] as const);
const fgScreen = (page: Page) => page.evaluate(() => (window as unknown as W).__fieldguide.screen());
const fgToasts = (page: Page) => page.evaluate(() => (window as unknown as W).__fieldguide.toasts());
/** texts of every toast in the core lane right now */
const domToasts = (page: Page) => page.evaluate(() => [...document.querySelectorAll('.toasts .toast')].map((e) => e.textContent ?? ''));
const ours = (texts: string[]) => texts.filter((t) => t.includes('[J]'));
const frames = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))));

/** in-page layout checks for the open booklet (layout boxes via offset*, so the paper's small rotations do not count) */
function measureBooklet(): { problems: string[]; warnings: string[]; info: Record<string, unknown> } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const info: Record<string, unknown> = {};
  const book = document.querySelector('.fg-book') as HTMLElement | null;
  const lp = document.querySelector('.fg-left') as HTMLElement | null;
  const rp = document.querySelector('.fg-right') as HTMLElement | null;
  if (!book || !lp || !rp) return { problems: ['booklet not rendered'], warnings, info };
  const vw = innerWidth, vh = innerHeight;
  const br = book.getBoundingClientRect();
  info.book = [Math.round(br.left), Math.round(br.top), Math.round(br.width), Math.round(br.height)];
  if (br.top < -1 || br.bottom > vh + 1 || br.left < -1 || br.right > vw + 1) problems.push(`book off screen (${info.book})`);
  // left page: blocks in order, none overlapping, all on the page
  const padB = parseFloat(getComputedStyle(lp).paddingBottom) || 0;
  const end = lp.clientHeight - padB;
  const sels = ['.fg-formline', '.fg-name', '.fg-photo', '.fg-caption', '.fg-contact', '.fg-counts', '.fg-sounds', '.fg-hint', '.fg-issued'];
  const boxes: { s: string; top: number; bottom: number }[] = [];
  for (const s of sels) {
    const e = lp.querySelector(s) as HTMLElement | null;
    if (e) boxes.push({ s, top: e.offsetTop, bottom: e.offsetTop + e.offsetHeight });
  }
  info.left = boxes.map((b) => `${b.s.slice(4)} ${b.top}-${b.bottom}`).join(', ');
  info.pageEnd = end;
  for (let i = 1; i < boxes.length; i++) {
    const a = boxes[i - 1]!, b = boxes[i]!;
    if (b.top < a.bottom - 1) problems.push(`${b.s} (${b.top}) overlaps ${a.s} (ends ${a.bottom})`);
  }
  const last = boxes[boxes.length - 1];
  if (last && last.bottom > end + 1) problems.push(`${last.s} ends at ${last.bottom}, past the page (${end})`);
  // the sketch is inside its photo (both rotate together, so bounding boxes nest when the layout boxes do)
  const photo = lp.querySelector('.fg-photo') as HTMLElement | null;
  if (photo) {
    info.photo = photo.clientHeight;
    if (photo.clientHeight < 100) problems.push(`photo only ${photo.clientHeight}px tall`);
    const art = photo.querySelector('.fg-svg svg, .fg-blank');
    if (art) {
      const a = art.getBoundingClientRect(), p = photo.getBoundingClientRect();
      info.art = [Math.round(a.width), Math.round(a.height)];
      if (a.top < p.top - 1 || a.bottom > p.bottom + 1 || a.left < p.left - 1 || a.right > p.right + 1) problems.push(`sketch ${Math.round(a.top)}-${Math.round(a.bottom)} outside its photo ${Math.round(p.top)}-${Math.round(p.bottom)}`);
      if (a.height < 40) problems.push(`sketch only ${Math.round(a.height)}px tall`);
    } else problems.push('photo has no sketch / blank');
  }
  // the name and the sound lines keep one line each
  const name = lp.querySelector('.fg-name') as HTMLElement | null;
  if (name) {
    const lh = parseFloat(getComputedStyle(name).lineHeight) || 0;
    if (lh && name.clientHeight > lh * 1.5) warnings.push(`name wraps (${name.clientHeight}px, line ${lh}px)`);
  }
  for (const s of lp.querySelectorAll('.fg-sounds .fg-pencil')) {
    const e = s as HTMLElement;
    const lh = parseFloat(getComputedStyle(e).lineHeight) || 0;
    if (lh && e.clientHeight > lh * 1.5) warnings.push(`sound line wraps: '${e.textContent}'`);
  }
  // right page: scrolls down, never sideways
  if (rp.scrollWidth > rp.clientWidth + 1) problems.push(`right page overflows sideways (${rp.scrollWidth} > ${rp.clientWidth})`);
  info.rightScroll = rp.scrollHeight > rp.clientHeight + 1;
  // tabs: on the screen, alongside the book, label + count inside the tab
  const tabFit: string[] = [];
  for (const t of document.querySelectorAll('.fg-tab')) {
    const el = t as HTMLElement;
    const r = el.getBoundingClientRect();
    if (r.right > vw + 0.5 || r.bottom > br.bottom + 2 || r.top < br.top - 2) problems.push(`tab ${el.dataset.tab} (${Math.round(r.top)}-${Math.round(r.bottom)}, right ${Math.round(r.right)}) off the book or screen`);
    const kids = [...el.children] as HTMLElement[];
    const need = kids.reduce((n, k) => n + k.offsetHeight, 0) + Math.max(0, kids.length - 1) * (parseFloat(getComputedStyle(el).rowGap) || 0);
    tabFit.push(`${el.dataset.tab} ${need}/${el.clientHeight}`);
    if (need > el.clientHeight - 2) problems.push(`tab ${el.dataset.tab}: label needs ${need}px of ${el.clientHeight}px`);
  }
  info.tabs = tabFit.join(', ');
  // footer: one line, under the book, on screen
  const foot = document.querySelector('.fg-footer') as HTMLElement | null;
  if (foot) {
    const fr = foot.getBoundingClientRect();
    info.footer = [Math.round(fr.top), Math.round(fr.height)];
    if (fr.height > 24) problems.push(`footer wraps (${Math.round(fr.height)}px)`);
    if (fr.bottom > vh + 0.5) problems.push('footer off screen');
    if (fr.top < br.bottom - 2) problems.push('footer overlaps the book');
  }
  // toasts over the book: ours fail, other packages' are reported
  for (const t of document.querySelectorAll('.toasts .toast')) {
    const r = t.getBoundingClientRect();
    if (r.bottom > br.top && r.top < br.bottom && r.right > br.left && r.left < br.right) {
      const txt = t.textContent ?? '';
      (txt.includes('[J]') ? problems : warnings).push(`toast over the booklet: '${txt}'`);
    }
  }
  return { problems, warnings, info };
}

/** in-page layout checks for the hazard bulletin reader */
function measureReader(): { problems: string[]; warnings: string[]; info: Record<string, unknown> } {
  const problems: string[] = [];
  const warnings: string[] = [];
  const info: Record<string, unknown> = {};
  const sheet = document.querySelector('.fg-bulletin') as HTMLElement | null;
  const stamp = document.querySelector('.fg-bul-foot .fg-stamp') as HTMLElement | null;
  const keys = document.querySelector('.fg-bul-keys') as HTMLElement | null;
  if (!sheet || !stamp || !keys) return { problems: ['reader not rendered'], warnings, info };
  const r = sheet.getBoundingClientRect();
  info.sheet = [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)];
  info.scrolls = sheet.scrollHeight > sheet.clientHeight + 1;
  if (r.top < -1 || r.bottom > innerHeight + 1) problems.push(`reader off screen (${info.sheet})`);
  info.keys = [keys.offsetLeft, keys.offsetTop, keys.offsetWidth, keys.offsetHeight];
  info.stamp = [stamp.offsetLeft, stamp.offsetTop, stamp.offsetWidth, stamp.offsetHeight];
  if (keys.offsetHeight > 22) problems.push(`key hint wraps (${keys.offsetHeight}px)`);
  if (stamp.offsetHeight > 44) problems.push(`stamp wraps (${stamp.offsetHeight}px)`);
  const oneRow = keys.offsetTop < stamp.offsetTop + stamp.offsetHeight && stamp.offsetTop < keys.offsetTop + keys.offsetHeight;
  info.oneRow = oneRow;
  if (oneRow && keys.offsetLeft < stamp.offsetLeft + stamp.offsetWidth) problems.push('key hint overlaps the stamp');
  const padR = parseFloat(getComputedStyle(sheet).paddingRight) || 0;
  if (keys.offsetLeft + keys.offsetWidth > sheet.clientWidth - padR + 1) problems.push('key hint past the sheet edge');
  for (const t of document.querySelectorAll('.toasts .toast')) {
    const tr = t.getBoundingClientRect();
    if (tr.bottom > r.top && tr.top < r.bottom && tr.right > r.left && tr.left < r.right) {
      const txt = t.textContent ?? '';
      (txt.includes('[J]') ? problems : warnings).push(`toast over the reader: '${txt}'`);
    }
  }
  return { problems, warnings, info };
}

const record = (key: string, m: { problems: string[]; warnings: string[]; info: Record<string, unknown> }) => {
  layout[key] = m;
  for (const p of m.problems) fail(`${key}: ${p}`);
  for (const w of m.warnings) log(`  warn ${key}: ${w}`);
  log(`  ${key}: ${m.problems.length ? `${m.problems.length} problem(s)` : 'layout ok'} ${JSON.stringify(m.info)}`);
};

/** the seeded booklet, sent in order in one round trip (the server handles one socket's requests in order) */
const SEED: [string, Record<string, unknown>][] = [
  ['fieldguide.event', { monster: 'hound', event: 'seen', id: 'kennel' }],
  ['fieldguide.event', { monster: 'hound', event: 'heard', id: 'kennel' }],
  ['fieldguide.file', { pageId: 'hound.1' }], ['fieldguide.file', { pageId: 'hound.2' }], ['fieldguide.file', { pageId: 'hound.4' }],
  ['fieldguide.event', { monster: 'hound', event: 'kill', id: 'hound0' }],
  ['fieldguide.event', { monster: 'listener', event: 'heard', id: 'listener0' }],
  ['fieldguide.file', { pageId: 'listener.1' }],
  ['fieldguide.event', { monster: 'mannequin', event: 'seen', id: 'mannequin0' }],
  ['fieldguide.file', { pageId: 'mannequin.2' }],
  ...(['cold_spot', 'cold_spot', 'cold_spot', 'knock', 'knock', 'footprints', 'mirror_writing'].map((kind) => ['fieldguide.phenomenon', { kind }] as [string, Record<string, unknown>])),
];

const srv = await startServer({ dir: mkdtempSync(join(process.env.FG_SCRATCH ?? tmpdir(), 'fg-shots-')) });
let pl: Player | null = null;
try {
  const crew = crewCode();
  const first = PLAN[0] ?? { w: 1280, h: 720, tabs: [...TABS], reader: true };
  pl = await launchPlayer({
    name: 'Halvorsen', baseUrl: srv.base, crew, viewport: { width: first.w, height: first.h },
    query: { autojoin: '1', nobright: '1', maxfps: String(process.env.FG_MAXFPS ?? 6) },
  });
  const page = pl.page;
  await page.route('**/@vite/client', (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: VITE_STUB }));
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForGame(page, Math.max(20_000, Math.min(75_000, left() - 35_000)));
  await page.waitForFunction(() => (window as unknown as W).__game.state().net === 'joined', undefined, { timeout: 20_000, polling: 200 });
  await page.evaluate(() => document.fonts.ready.then(() => true));
  log(`joined, game ready; plan ${JSON.stringify(PLAN)}, flow ${FLOW}`);

  await page.evaluate((calls) => Promise.all(calls.map(([r, a]) => (window as unknown as W).__game.dbg(r, a))).then(() => true), SEED);
  await sleep(400);
  log('seeded');
  const view = await page.evaluate(() => (window as unknown as W).__fieldguide.view());
  const pg = view?.monsters.find((m) => m.kind === 'listener')?.pages.find((p) => p.id === 'listener.1') ?? null;
  if (!pg) fail('listener.1 missing from the view');

  const tabShots = async (tag: string, tabs: readonly Tab[]) => {
    await page.waitForSelector('[data-testid="fieldguide"] .fg-photo', { timeout: 8000 });
    await frames(page);
    for (const tab of tabs) {
      if (left() < 9_000) { log(`out of time: ${tag} ${tab} skipped`); skipped.push(`${tag} ${tab}`); continue; }
      await page.click(`.fg-tab[data-tab="${tab}"]`);
      await page.waitForFunction((t) => document.querySelector('[data-testid="fieldguide"]')?.getAttribute('data-tab') === t, tab, { timeout: 3000 });
      await frames(page);
      await sleep(150);
      record(`${tag} ${tab}`, await page.evaluate(measureBooklet));
      await shot(page, `fg-${tag}-${tab}`);
    }
  };
  const readerShots = async (tag: string, toastFlow: boolean) => {
    if (!pg) return;
    const variants = [
      { key: 'filed', d: { spot: 'prop:0', monster: 'listener', name: 'THE LISTENER', title: pg.title, text: pg.text, pageId: pg.id, filed: true, n: 1, of: 6 } },
      { key: 'longest', d: { spot: 'prop:0', monster: 'mannequin', name: 'THE MANNEQUIN', title: pg.title, text: pg.text, pageId: pg.id, filed: true, n: 4, of: 4 } },
      { key: 'already', d: { spot: 'prop:0', monster: 'listener', name: 'THE LISTENER', title: pg.title, text: pg.text, pageId: pg.id, filed: false, n: 1, of: 6 } },
    ];
    for (const [i, v] of variants.entries()) {
      if (left() < 7_000) { log(`out of time: ${tag} reader ${v.key} skipped`); skipped.push(`${tag} reader ${v.key}`); continue; }
      await page.evaluate((d) => (window as unknown as W).__fieldguide.reader(d), v.d);
      await frames(page);
      await sleep(i === 0 ? 300 : 100);
      if (i === 0 && toastFlow) {
        const dom = ours(await domToasts(page));
        if (dom.length) fail(`our toasts stayed over the reader: ${dom.join(' | ')}`);
        await dbg(page, 'fieldguide.phenomenon', { kind: 'radio_on' });
        await sleep(350);
        const t = await fgToasts(page);
        if (!t.held.some((x) => x.includes('A RADIO SWITCHING ON'))) fail('a new entry while the reader is open was not held');
        if (ours(await domToasts(page)).length) fail('a toast was shown over the reader');
      }
      record(`${tag} reader ${v.key}`, await page.evaluate(measureReader));
      if (i === 0) await shot(page, `fg-${tag}-reader`);
    }
    await page.keyboard.press('Escape');
    await sleep(250);
    if ((await fgScreen(page)) !== 'none') fail('Esc did not close the reader');
  };

  // ---------------------------------------------------------------- toasts + keys (the gate R case: J pressed while NEW ENTRY toasts are up)
  if (FLOW) {
    const tag = `${first.w}x${first.h}`;
    const before = ours(await domToasts(page));
    if (!before.length) fail('no fieldguide toast up after seeding');
    await page.keyboard.press('KeyJ');
    await sleep(300);
    const jOpen = await fgScreen(page);
    const afterOpen = ours(await domToasts(page));
    log(`toasts: ${before.length} up before J, ${afterOpen.length} after the booklet opened (${jOpen})`);
    if (jOpen !== 'fieldguide') fail(`J did not open the booklet (${jOpen})`);
    if (afterOpen.length) fail(`our toasts stayed over the open booklet: ${afterOpen.join(' | ')}`);
    await dbg(page, 'fieldguide.phenomenon', { kind: 'phone_ring' });
    await sleep(400);
    const whileOpen = await fgToasts(page);
    const domOpen = ours(await domToasts(page));
    log(`while open: held ${JSON.stringify(whileOpen.held)}, on screen ${JSON.stringify(domOpen)}`);
    if (!whileOpen.held.some((t) => t.includes('A RINGING PHONE'))) fail('a new entry while the booklet is open was not held');
    if (domOpen.length) fail(`a toast was shown over the open booklet: ${domOpen.join(' | ')}`);
    await tabShots(tag, first.tabs);
    await page.keyboard.press('KeyJ');
    await sleep(300);
    const jClosed = await fgScreen(page);
    const afterClose = ours(await domToasts(page));
    log(`J again: ${jClosed}; toasts after close: ${JSON.stringify(afterClose)}`);
    if (jClosed !== 'none') fail(`J did not close the booklet (${jClosed})`);
    if (!afterClose.some((t) => t.includes('A RINGING PHONE'))) fail('the entry held while the booklet was open did not show after it closed');
    await shot(page, `fg-${tag}-toast-after-close`);
    await page.evaluate(() => { const i = document.createElement('input'); i.id = 'fg-typing'; document.body.appendChild(i); i.focus(); });
    await page.keyboard.press('KeyJ');
    await sleep(250);
    const jTyping = await fgScreen(page);
    await page.evaluate(() => document.getElementById('fg-typing')?.remove());
    await page.evaluate(() => (window as unknown as W).__fieldguide.open('hound'));
    await sleep(200);
    await page.keyboard.press('Escape');
    await sleep(250);
    const escClosed = await fgScreen(page);
    log(`J while typing: ${jTyping}; Esc: ${escClosed}`);
    if (jTyping !== 'none') fail('J opened the booklet while typing');
    if (escClosed !== 'none') fail('Esc did not close the booklet');
    // the reader: its own page needs no toast; entries while it is open wait
    if (first.reader) {
      await dbg(page, 'fieldguide.file', { pageId: 'hound.5' });
      await sleep(300);
      if (!ours(await domToasts(page)).some((t) => t.includes('THE HOUND 4/5'))) fail('no PAGE FILED toast for hound.5');
      await readerShots(tag, true);
      const after = ours(await domToasts(page));
      log(`toasts after the reader closed: ${JSON.stringify(after)}`);
      if (!after.some((t) => t.includes('A RADIO SWITCHING ON'))) fail('the entry held while the reader was open did not show after it closed');
    }
  }

  // ---------------------------------------------------------------- the planned views
  for (const [i, p] of PLAN.entries()) {
    if (i === 0 && FLOW) continue; // done above
    const tag = `${p.w}x${p.h}`;
    if (left() < 12_000) { log(`out of time: ${tag} skipped`); skipped.push(tag); continue; }
    await page.setViewportSize({ width: p.w, height: p.h });
    await sleep(300);
    if (p.tabs.length) {
      await page.evaluate((t) => (window as unknown as W).__fieldguide.open(t), p.tabs[0]);
      await tabShots(tag, p.tabs);
      await page.evaluate(() => (window as unknown as W).__fieldguide.close());
      await sleep(150);
    }
    if (p.reader) await readerShots(tag, false);
  }

  // ---------------------------------------------------------------- a bulletin on a lore frame (opt-in: FG_LORE=1; needs E3's setLorePage)
  const lore = await page.evaluate(() => (window as unknown as W).__fieldguide.levelLore());
  log(`level lore API: setLorePage ${lore.setLorePage}, loreSpots ${lore.loreSpots}`);
  if (process.env.FG_LORE === '1' && lore.setLorePage && left() > 45_000) {
    await dbg(page, 'level.generate', { seed: 'fg-shots-1', players: 1, risk: 2 });
    const st = await dbg(page, 'fieldguide.state') as FgDbgState;
    const b = st.bulletins[0];
    if (b) {
      const yaw = Math.atan2(b.p[0] - b.front[0], b.p[2] - b.front[1]);
      const t1 = Date.now();
      let applied = false;
      while (!applied && Date.now() - t1 < Math.min(40_000, left() - 15_000)) {
        await sleep(1000);
        applied = await page.evaluate((spot) => { const fg = (window as unknown as W).__fieldguide; fg.sync(); return spot in fg.lorePages(); }, b.spot);
      }
      if (applied) {
        await page.evaluate(([x, z, y]) => { const g = (window as unknown as W).__game; g.teleport(x, z, y); g.look(y, -0.05); }, [b.front[0], b.front[1], yaw] as const);
        await sleep(2500);
        await shot(page, 'fg-lore-frame');
      } else log('lore frame: frame not built in time');
    } else log('lore frame: no bulletin on fg-shots-1');
  }
  const errs = await page.evaluate(() => (window as unknown as W).__game.errors());
  const mine = errs.filter((e) => /fieldguide/i.test(e));
  log(`client errors: ${errs.length} total, ${mine.length} fieldguide${mine.length ? `: ${mine.join(' | ')}` : ''}`);
  if (mine.length) fail(`fieldguide client errors: ${mine.join(' | ')}`);
  log('SHOTS DONE');
} catch (e) {
  console.error(e);
  console.error(srv.log().slice(-3000));
  failures.push(`crashed: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  writeFileSync(join(OUT, 'layout.json'), JSON.stringify({ at: new Date().toISOString(), plan: PLAN, flow: FLOW, failures, skipped, layout }, null, 1));
  await pl?.close().catch(() => {});
  await srv.stop();
  if (skipped.length) console.log(`skipped (out of time): ${skipped.join(', ')}`);
  console.log(failures.length ? `${failures.length} FAILURE(S):\n  ${failures.join('\n  ')}` : 'ALL CHECKS PASSED');
  process.exitCode = failures.length ? 1 : 0;
}
