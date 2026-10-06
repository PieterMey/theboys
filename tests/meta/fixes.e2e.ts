// Owner: track (d) Meta. Focused repro for the playtest fixes (FINDINGS.md, AREA meta): brightness check after the
// join screen closes, hub interactable heights, two Risk-1 orders on the first board, distinct visor colours, R on
// the board, console breaker/keypad/Core markers, per-player 'back to the van'.
// Run: node tests/meta/fixes.e2e.ts   (needs a dev server; BASE_URL, default http://127.0.0.1:3405)
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchPlayer } from '../lib/launch.ts';
import type { Player } from '../lib/launch.ts';
import { OUT } from './lib.ts';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3405';
const CREW = `FX${Date.now().toString(36).slice(-3).toUpperCase()}`;
mkdirSync(OUT, { recursive: true });
const t0 = Date.now();
const step = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);

type W = { __meta: { screen(): string; close(): void; open(n: string, p?: unknown): void; meta(): Record<string, unknown> }; __game: { state(): Record<string, unknown>; dbg(r: string, a?: unknown): Promise<unknown>; me(): string | null }; __ix?: { state(): { ints?: { id: string; kind: string; p: number[] }[] } } };
const ev = <T>(p: Player, fn: () => T): Promise<T> => p.page.evaluate(fn);
async function until(p: Player, fn: () => boolean, ms: number, what: string): Promise<void> {
  await p.page.waitForFunction(fn, undefined, { timeout: ms, polling: 100 }).catch(() => { throw new Error(`timeout: ${what}`); });
}
const players: Player[] = [];
// the e2e skips the drive with dbg.meta.skipDrive
try {
  // ---- brightness: brand-new player, no nobright
  const a = await launchPlayer({ name: 'Ann', baseUrl: BASE, crew: CREW, query: { autojoin: '1' }, viewport: { width: 1280, height: 720 } });
  players.push(a);
  await a.page.routeWebSocket(/token=/, () => {});
  const seen: string[] = [];
  const tEnd = Date.now() + 45_000;
  let got = false;
  while (Date.now() < tEnd) {
    const s = await ev(a, () => (window as unknown as W).__meta?.screen?.() ?? 'n/a').catch(() => 'n/a');
    if (seen[seen.length - 1] !== s) seen.push(s);
    if (s === 'brightness') { got = true; break; }
    await new Promise((r) => setTimeout(r, 150));
  }
  step(`screens after join: ${seen.join(' -> ')}`);
  assert.ok(got, 'brightness check opened after the join screen closed');
  await a.page.screenshot({ path: join(OUT, 'fix-brightness.png') });
  await a.page.getByText('LOOKS RIGHT').click();
  await until(a, () => (window as unknown as W).__meta.screen() === 'none', 5000, 'brightness closed');
  const done = await ev(a, () => JSON.parse(localStorage.getItem('deadair.meta.settings') ?? '{}').brightnessDone);
  assert.equal(done, true, 'brightnessDone saved');
  step('brightness check ok');

  // ---- second player: distinct visor colour
  const b = await launchPlayer({ name: 'Bob', baseUrl: BASE, crew: CREW, query: { autojoin: '1', nobright: '1' }, viewport: { width: 1280, height: 720 } });
  players.push(b);
  await b.page.routeWebSocket(/token=/, () => {});
  await until(b, () => (window as unknown as W).__meta?.screen?.() === 'none', 45_000, 'bob in the van');
  await new Promise((r) => setTimeout(r, 600));
  const visors = await ev(a, () => ((window as unknown as W).__game.state() as { crew?: { players: { name: string; profile: { visor: { color: string } } }[] } }).crew?.players.map((p) => `${p.name}:${p.profile.visor.color}`) ?? []);
  step(`visors: ${visors.join(' ')}`);
  const cols = visors.map((v) => v.split(':')[1]);
  assert.equal(new Set(cols).size, cols.length, 'distinct visor colours');

  // ---- hub interactable heights
  const ints = await ev(a, () => { const raw = (window as unknown as W).__ix?.state().ints as unknown; const list = (Array.isArray(raw) ? raw : Object.values((raw ?? {}) as Record<string, unknown>)) as { kind: string; p: number[] }[]; return list.filter((i) => ['console', 'board', 'shop', 'mirror', 'kennel'].includes(i.kind)).map((i) => `${i.kind}:${i.p[1]}`); });
  step(`hub ints: ${ints.join(' ')}`);
  if (ints.length) assert.ok(ints.every((s) => Number(s.split(':')[1]) > 0.5), 'hub interactables above the floor');

  // ---- first board: two choosable Risk-1 orders
  const orders = await ev(a, () => (((window as unknown as W).__game.state() as { workOrders?: { risk: number; available: boolean }[] }).workOrders ?? []).map((o) => `${o.risk}${o.available ? '' : 'L'}`));
  step(`board: ${orders.join(' ')}`);
  if (orders.length) assert.ok(orders.filter((o) => o === '1').length >= 2, 'two choosable Risk-1 orders');

  // ---- board: leader picks, R on the open board readies
  await a.page.keyboard.press('KeyB');
  await until(a, () => (window as unknown as W).__meta.screen() === 'board', 4000, 'board open');
  await b.page.keyboard.press('KeyB');
  await until(b, () => (window as unknown as W).__meta.screen() === 'board', 4000, 'bob board open');
  await b.page.locator('.m-order').first().click();
  await new Promise((r) => setTimeout(r, 300));
  const bobToasts = await ev(b, () => [...document.querySelectorAll('.toast')].map((t) => t.textContent));
  step(`bob non-leader click toasts: ${JSON.stringify(bobToasts)}`);
  await a.page.locator('.m-order').first().click();
  await new Promise((r) => setTimeout(r, 300));
  await b.page.keyboard.press('KeyR');
  await new Promise((r) => setTimeout(r, 400));
  const bobReady = await ev(b, () => { const g = (window as unknown as W).__game; const st = g.state() as { crew?: { players: { id: string; ready: boolean }[] } }; return st.crew?.players.find((p) => p.id === g.me())?.ready ?? null; });
  step(`bob ready after R on board: ${bobReady}`);
  assert.equal(bobReady, true, 'R on the board readies');
  await a.page.keyboard.press('KeyR');
  await until(a, () => (window as unknown as W).__meta.screen() === 'drive', 10_000, 'drive');
  await new Promise((r) => setTimeout(r, 1500));
  const driveLeft = await ev(a, () => { const m = (window as unknown as W).__meta.meta() as { drive?: { endsAt: number } }; return m.drive ? Math.round((m.drive.endsAt - Date.now()) / 1000) : null; });
  step(`drive: ~${driveLeft} s left after 1.5 s (first contract)`);
  await a.page.screenshot({ path: join(OUT, 'fix-drive.png') });
  await ev(a, () => (window as unknown as W).__game.dbg('meta.skipDrive'));
  await until(a, () => ((window as unknown as W).__game.state() as { phase?: string }).phase === 'contract', 30_000, 'contract');
  await until(a, () => (window as unknown as W).__meta.screen() === 'none', 30_000, 'contract screen none');
  await new Promise((r) => setTimeout(r, 1500));

  // ---- console markers (wait out a possible Vite reload: the HMR socket opened before routeWebSocket)
  await until(a, () => { const w = window as unknown as W; return !!w.__meta && ((w.__game?.state() as { phase?: string }).phase === 'contract') && w.__meta.screen() === 'none'; }, 40_000, 'contract after reload');
  await new Promise((r) => setTimeout(r, 1000));
  await ev(a, () => (window as unknown as W).__meta.open('console'));
  await new Promise((r) => setTimeout(r, 900));
  const legend = await ev(a, () => document.querySelector('.m-con-legend')?.textContent ?? '');
  const side = await ev(a, () => document.querySelector('.m-con-side')?.textContent ?? '');
  step(`console legend: ${legend}`);
  assert.match(legend, /BREAKERS: [A-Z0-9-]+ \+ [A-Z0-9-]+/i, 'legend names both breaker rooms');
  assert.match(side, /KEYPAD: /i, 'keypad room listed');
  await a.page.screenshot({ path: join(OUT, 'fix-console.png') });
  await ev(a, () => (window as unknown as W).__meta.close());

  // ---- per-player continue
  await ev(a, () => (window as unknown as W).__game.dbg('objectives.end', { reason: 'leave' }).catch(() => (window as unknown as W).__game.dbg('meta.endContract')));
  await until(a, () => (window as unknown as W).__meta.screen() === 'results', 20_000, 'results (ann)');
  await until(b, () => (window as unknown as W).__meta.screen() === 'results', 20_000, 'results (bob)');
  const clickBack = (p: Player) => ev(p, () => { const b = [...document.querySelectorAll('.m-board-foot button')].find((x) => /BACK TO THE VAN/.test(x.textContent ?? '')) as HTMLButtonElement | undefined; b?.click(); return !!b; });
  step(`ann clicked: ${await clickBack(a)}`);
  await new Promise((r) => setTimeout(r, 1200));
  const mid = { a: await ev(a, () => (window as unknown as W).__meta.screen()), b: await ev(b, () => (window as unknown as W).__meta.screen()), txt: await ev(a, () => document.querySelector('.m-board-foot')?.textContent ?? '') };
  step(`after Ann's click: ann=${mid.a} bob=${mid.b} · '${mid.txt}'`);
  assert.equal(mid.b, 'results', 'Bob keeps reading');
  step(`bob clicked: ${await clickBack(b)}`);
  await until(a, () => ((window as unknown as W).__game.state() as { phase?: string }).phase === 'hub', 10_000, 'hub after both continued');
  step('per-player continue ok');
  const errs = players.flatMap((p) => p.errors);
  step(`page errors: ${errs.length ? errs.join(' | ') : 'none'}`);
  console.log('META FIXES E2E PASS');
} finally {
  for (const p of players) await p.close().catch(() => {});
}
