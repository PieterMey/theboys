// Playwright e2e for track (b) Interaction against a running dev server (BASE_URL, default http://127.0.0.1:3012):
// pick up an item, throw a bottle, open a door, hide in a locker, flip a light switch, die (death card), get revived.
// Screenshots: tests/artifacts/interaction/*.png
//   PORT=3012 npm run dev   (separate terminal)   then:   node tests/interaction/ix.e2e.ts
import { launchPlayer, screenshot, waitForGame } from '../lib/launch.ts';
import type { Page } from 'playwright-core';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import { corridorRun, doorSpot, firstItem, itemFront, switchSpot } from './spots.ts';
import { Bot } from './bot.ts';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3012';
const CREW = process.env.CREW ?? `IX${String(Math.floor(Date.now() / 1000) % 100).padStart(2, '0')}`.replace(/[0-9]/g, (d) => 'BCDFGHJKLM'[Number(d)]);
const OUT = 'tests/artifacts/interaction';
const results: { step: string; ok: boolean; info?: unknown }[] = [];

interface IxItem { id: string; type: string; where: string; p?: number[]; holder?: string; count?: number }
interface IxState { items: Record<string, IxItem>; doors: Record<number, { open: boolean }>; hidden: Record<string, string>; inventories: Record<string, (string | null)[]>; dead: string[]; lights: Record<number, boolean> }
interface IxApi {
  state(): IxState;
  target(): { id: string; kind: string; view?: { text: string } | null } | null;
  aim(x: number, y: number, z: number): [number, number] | null;
  inventory(): (string | null)[];
  ui(): { death: boolean; hidden: boolean; target: unknown };
  layout(): LevelLayout | null;
}

const ixEval = <T>(page: Page, body: string, arg?: unknown): Promise<T> =>
  page.evaluate(([b, a]) => {
    const api = (window as unknown as { __ix: IxApi }).__ix;
    return (new Function('api', 'arg', b as string))(api, a);
  }, [body, arg] as const) as Promise<T>;

const ixState = (page: Page) => ixEval<IxState>(page, 'return api.state()');
const ixTarget = (page: Page) => ixEval<{ id: string; kind: string; view?: { text: string } | null } | null>(page, 'return api.target()');
const ixInv = (page: Page) => ixEval<(string | null)[]>(page, 'return api.inventory()');

const game = <T>(page: Page, fn: string, ...args: unknown[]): Promise<T> =>
  page.evaluate(([f, a]) => {
    const g = (window as unknown as { __game: Record<string, (...x: unknown[]) => unknown> }).__game;
    return g[f as string](...(a as unknown[]));
  }, [fn, args] as const) as Promise<T>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function check(step: string, ok: boolean, info?: unknown): void {
  results.push({ step, ok, info });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step}${info !== undefined ? ` :: ${JSON.stringify(info)}` : ''}`);
}

async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, ms = 4000): Promise<T> {
  const t0 = Date.now();
  let v = await fn();
  while (!pred(v) && Date.now() - t0 < ms) {
    await sleep(100);
    v = await fn();
  }
  return v;
}

/** stand at (x, z) and look at (tx, ty, tz) */
async function stand(page: Page, x: number, z: number, tx: number, ty: number, tz: number): Promise<void> {
  await game(page, 'teleport', x, z, Math.atan2(tx - x, tz - z));
  await sleep(300);
  await ixEval(page, 'return api.aim(arg[0], arg[1], arg[2])', [tx, ty, tz]);
  await sleep(300);
}


/** wait until the render loop is smooth (the facility's first frames compile shaders for ~10 s) */
async function waitSmooth(page: Page, ms = 40_000): Promise<number> {
  const probe = 'return new Promise((res) => { const ts = []; const f = (t) => { ts.push(t); if (ts.length < 12) requestAnimationFrame(f); else { let m = 0; for (let i = 1; i < ts.length; i++) m = Math.max(m, ts[i] - ts[i - 1]); res(m); } }; requestAnimationFrame(f); })';
  const t0 = Date.now();
  let worst = Infinity;
  while (Date.now() - t0 < ms) {
    worst = await ixEval<number>(page, probe);
    if (worst < 80) break;
  }
  return worst;
}

const heldBottles = (st: IxState) => Object.values(st.items).filter((it) => it.type === 'bottle' && it.where === 'held').reduce((a, it) => a + (it.count ?? 1), 0);

let mate: Bot | null = null;

async function main(): Promise<void> {
  console.log(`e2e interaction: ${BASE} crew ${CREW}`);
  const p = await launchPlayer({ name: 'Tester', baseUrl: BASE, crew: CREW, query: { autojoin: '1' } });
  const page = p.page;
  // other tracks keep saving files: swallow Vite's HMR socket so the page never full-reloads mid-test
  await page.routeWebSocket(/token=/, () => {});
  await page.reload({ waitUntil: 'domcontentloaded' });
  try {
    try {
      await waitForGame(page, Number(process.env.MAIN_WAIT_MS ?? 30_000));
    } catch {
      // another track's client module is mid-edit and broke the main bundle: use the resilient test entry
      console.log('main client not ready; falling back to /src/interaction/dev.html (guarded track imports)');
      await page.goto(`${BASE}/src/interaction/dev.html?test=1&autojoin=1#${CREW}`, { waitUntil: 'domcontentloaded' });
      await waitForGame(page, 90_000);
    }
    await waitFor(() => game<string | null>(page, 'me'), (v) => !!v, 15_000);
    const me = await game<string>(page, 'me');
    check('joined', !!me, me);
    // a ws teammate parked in the van, so the death test is not a crew wipe
    mate = new Bot('Mate');
    await mate.connect(BASE.replace(/^http/, 'ws') + '/ws', CREW);
    let started: unknown = null;
    try {
      started = await game(page, 'dbg', 'objectives.start', { fixture: 'facility_s1_p2', monsters: false, realSec: 900 });
    } catch (e) {
      console.log('objectives.start unavailable, using interaction.loadLayout:', String(e));
      started = await game(page, 'dbg', 'interaction.loadLayout', { name: 'facility_s1_p2' });
    }
    check('contract started', !!started, started);
    await waitFor(() => game<{ phase: string }>(page, 'state'), (s) => s.phase === 'contract', 8000);
    const van = (await ixEval<LevelLayout | null>(page, 'return api.layout()'))!.van;
    const park = setInterval(() => mate?.pose(van.x, van.z, 0), 250);
    park.unref();
    await sleep(1500);
    check('render loop smooth after facility load', (await waitSmooth(page)) < 80);
    const L = (await ixEval<LevelLayout | null>(page, 'return api.layout()'))!;
    const own = (x: number, z: number) => L.owner[Math.floor(z) * L.W + Math.floor(x)] ?? -1;
    const st0 = await ixState(page);
    const world = Object.values(st0.items).filter((it) => it.where === 'world' && it.p && it.type !== 'keycard');
    check('items in the world', world.length > 0, world.map((w) => `${w.type}@${w.p!.map((v) => v.toFixed(1)).join(',')}`));

    // 1) pick up a tool lying on the floor
    const tools = world.filter((w) => !w.type.startsWith('loot.'));
    const target = tools[0] ?? world[0];
    const tp = target.p!;
    let aimed = false;
    for (let k = 0; k < 8 && !aimed; k++) {
      const a = (k / 8) * Math.PI * 2;
      const sx = tp[0] + Math.sin(a) * 1.0, sz = tp[2] + Math.cos(a) * 1.0;
      if (own(sx, sz) !== own(tp[0], tp[2])) continue;
      await stand(page, sx, sz, tp[0], tp[1] + 0.08, tp[2]);
      const t = await ixTarget(page);
      aimed = !!t && t.id === target.id;
    }
    check(`crosshair targets the ${target.type}`, aimed, await ixTarget(page));
    await screenshot(page, `${OUT}/01-prompt-pickup.png`);
    await game(page, 'setInput', { interact: true });
    const inv1 = await waitFor(() => ixInv(page), (v) => v.includes(target.type), 3000);
    check(`picked up ${target.type} with E`, inv1.includes(target.type), inv1);

    // 2) bottle: give 3 (+ a walkie for the LED), select the slot, throw down the longest corridor
    await game(page, 'dbg', 'interaction.give', { type: 'bottle', count: 3 });
    await game(page, 'dbg', 'interaction.give', { type: 'walkie' });
    await sleep(300);
    const inv2 = await ixInv(page);
    await game(page, 'setInput', { slot: inv2.indexOf('bottle') });
    await sleep(300);
    const run = corridorRun(L)!;
    await stand(page, run.from[0], run.from[1], run.to[0], 1.9, run.to[1]);
    await screenshot(page, `${OUT}/02-inventory-bottle.png`);
    const before = heldBottles(await ixState(page));
    await game(page, 'setInput', { use: true });
    await sleep(160);
    await screenshot(page, `${OUT}/03-bottle-in-flight.png`);
    const afterSt = await waitFor(() => ixState(page), (st) => heldBottles(st) === before - 1, 3000);
    check(`LMB threw a bottle (${before} -> ${heldBottles(afterSt)})`, heldBottles(afterSt) === before - 1);

    // 3) a normal door: stand beside it, E toggles it
    const ds = doorSpot(L, 'door')!;
    const d0 = (await ixState(page)).doors[ds.door.id]?.open;
    await stand(page, ds.stand[0], ds.stand[1], ds.look[0], ds.look[1], ds.look[2]);
    const tdoor = await ixTarget(page);
    check(`crosshair targets ${ds.id}`, tdoor?.id === ds.id, tdoor);
    await screenshot(page, `${OUT}/04-prompt-door.png`);
    await game(page, 'setInput', { interact: true });
    const d1 = await waitFor(async () => (await ixState(page)).doors[ds.door.id]?.open, (v) => v !== d0, 3000);
    check(`E toggled ${ds.id}`, d1 !== d0, { before: d0, after: d1 });
    await sleep(900);
    await screenshot(page, `${OUT}/05-door-toggled.png`);

    // 3b) a security door: a tap is refused, holding E for 2 s forces it
    const sd = doorSpot(L, 'security');
    if (sd) {
      const s0 = (await ixState(page)).doors[sd.door.id]?.open;
      await stand(page, sd.stand[0], sd.stand[1], sd.look[0], sd.look[1], sd.look[2]);
      const tsd = await ixTarget(page);
      check(`crosshair targets ${sd.id} (HOLD E)`, tsd?.id === sd.id && tsd?.view?.text?.includes('security') === true, tsd);
      await game(page, 'setInput', { interact: true });
      await sleep(500);
      check('tap does not move the security door', (await ixState(page)).doors[sd.door.id]?.open === s0);
      const hold = ixEval(page, 'return api.holdE(2300)');
      await sleep(1100);
      await screenshot(page, `${OUT}/05b-hold-security-door.png`);
      await hold;
      const s1 = await waitFor(async () => (await ixState(page)).doors[sd.door.id]?.open, (v) => v !== s0, 3000);
      check(`2 s hold toggled ${sd.id}`, s1 !== s0, { before: s0, after: s1 });
    }

    // 4) hide in the first locker, then leave
    const lk = firstItem(L, 'hiding')!;
    const ls = itemFront(lk, 0.85, 1.0);
    await stand(page, ls.stand[0], ls.stand[1], ls.look[0], ls.look[1], ls.look[2]);
    const tl = await ixTarget(page);
    check(`crosshair targets ${lk.id}`, tl?.id === lk.id, tl);
    await screenshot(page, `${OUT}/06a-prompt-locker.png`);
    await game(page, 'setInput', { interact: true });
    const hid = await waitFor(async () => (await ixState(page)).hidden, (h) => !!h[me], 3000);
    check('hidden in the locker', hid[me] === lk.id, hid);
    await sleep(700);
    await screenshot(page, `${OUT}/06-locker-slats.png`);
    await game(page, 'setInput', { interact: true });
    const unhid = await waitFor(async () => (await ixState(page)).hidden, (h) => !h[me], 3000);
    check('left the locker with E', !unhid[me]);

    // 4b) light switch in a powered room
    const sw = switchSpot(L);
    if (sw) {
      await stand(page, sw.stand[0], sw.stand[1], sw.look[0], sw.look[1], sw.look[2]);
      const ts = await ixTarget(page);
      const space = Number(L.items.find((i) => i.id === sw.id)?.data?.space);
      const l0 = (await ixState(page)).lights[space];
      await game(page, 'setInput', { interact: true });
      const l1 = await waitFor(async () => (await ixState(page)).lights[space], (v) => v !== l0, 3000);
      check(`switch ${sw.id} toggles room ${space} lights`, ts?.id === sw.id && l1 !== l0, { target: ts?.id, before: l0, after: l1 });
      await sleep(500);
      await screenshot(page, `${OUT}/06b-lights-toggled.png`);
    }

    // 5) death card
    await stand(page, run.from[0] + 2, run.from[1], run.to[0], 1.4, run.to[1]);
    await game(page, 'dbg', 'interaction.kill', { killer: 'HOUND', reason: 'heard your SPRINT (9 m)', detail: 'It was 9 m away, one door over. You were carrying two bottles and a walkie.' });
    await sleep(900);
    const uiDead = await ixEval<{ death: boolean }>(page, 'return api.ui()');
    check('death card shown', uiDead.death === true, uiDead);
    await screenshot(page, `${OUT}/07-death-card.png`);
    await sleep(4300);
    await screenshot(page, `${OUT}/08-spectating.png`);
    const st5 = await ixState(page);
    check('dead + inventory dropped at the body', st5.dead.includes(me) && (st5.inventories[me] ?? []).every((x) => !x));
    await game(page, 'dbg', 'interaction.revive', {});
    await sleep(900);
    check('revived', !(await ixState(page)).dead.includes(me));
    const errs = (await game<string[]>(page, 'errors')).filter((e) => /interaction|\bix\b/i.test(e));
    check('no interaction client errors', errs.length === 0, errs.slice(0, 5));
  } catch (e) {
    check('e2e crashed', false, e instanceof Error ? e.stack : String(e));
    await screenshot(page, `${OUT}/99-crash.png`).catch(() => {});
  } finally {
    const allErr = await game<string[]>(page, 'errors').catch(() => [] as string[]);
    if (allErr.length) console.log('client errors (all tracks):', JSON.stringify(allErr.slice(0, 12), null, 1));
    await p.close();
    mate?.close();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exitCode = failed.length ? 1 : 0;
}

await main();
