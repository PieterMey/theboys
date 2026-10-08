// Gate R (v1.2) run A, the HUB layout (software lane, one Chrome): the main menu (title, Personnel file, Settings, How to
// play), the loading screen on join, the van exterior from the hub spawn and the van interior with every station
// (workbench, stash, booklet shelf, charger, mirror spot, records board on the facade), the station prompts, the
// workbench, personnel-file (records board) and field-guide screens, and the error tally.
//   node tools/gpu-guard.mjs --max-sec 120 --label "gate R hub" -- node tests/gates/v12r-hub.e2e.ts --saves <dir>
// Needs the dev backend + tests/gates/v12r-proxy.mjs (BASE_URL, default :3898) and saves seeded by
// `node tests/meta/records-shots.e2e.ts --seed <dir>` (crew SHOT, player Ann). Shots: tests/artifacts/gate-r/hub/.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { V3 } from './v12r-lib.ts';
import { camera, dbg, errorTally, ev, frames, launch, mkRun, shot, sleep, until } from './v12r-lib.ts';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const SAVES = arg('saves', '');
const keys = JSON.parse(readFileSync(join(SAVES, 'shot-keys.json'), 'utf8')) as { ann: string; annProfile: unknown };
const run = mkRun(arg('tag', 'hub'), Number(arg('budget', '112')));
const CREW = 'SHOT';
const p = await launch({
  name: 'Ann', crew: CREW, query: { levelLight: '1', loading: '1' },
  storage: { 'deadair.key': keys.ann, 'deadair.profile': JSON.stringify(keys.annProfile), 'deadair.meta.settings': JSON.stringify({ brightnessDone: true, hints: true }) },
});
const page = p.page;
const step = async (name: string, fn: () => Promise<void>, minLeft = 6): Promise<void> => {
  if (run.left() < minLeft) { run.log(`skip ${name} (budget)`); run.notes[`skipped:${name}`] = true; return; }
  try { await fn(); } catch (e) { run.check(`${name} ran`, false, String(e).split('\n')[0]); await shot(run, page, `fail-${name}`); }
};

interface Station { kind: string; itemId: string; x: number; y: number; z: number; rot: number; p: V3; virtual?: boolean }
let stations: Station[] = [];
try {
  // ------------------------------------------------------------------ main menu (before joining)
  await step('menu', async () => {
    await page.waitForSelector('[data-testid="main-menu"]', { timeout: 40_000 });
    await sleep(1200);
    run.notes.menuReadyAt = run.el();
    await shot(run, page, 'a01-main-menu');
    await page.$eval('[data-testid="menu-file"]', (b) => (b as HTMLButtonElement).click());
    const pf = await page.waitForSelector('[data-testid="personnel-file"][data-save]', { timeout: 12_000 }).then(() => true, () => false);
    run.check('main menu Personnel file loads Ann\'s save (GET /api/stats)', pf);
    await sleep(500);
    await shot(run, page, 'a02-menu-personnel-file');
    await page.$eval('[data-testid="menu-settings"]', (b) => (b as HTMLButtonElement).click());
    await sleep(600);
    const settingsText = await page.$eval('[data-testid="menu-panel-settings"]', (e) => (e as HTMLElement).innerText).catch(() => '');
    run.notes.settingsText = settingsText.replace(/\s+/g, ' ').slice(0, 1500);
    run.check('settings: hints toggle present', /hint/i.test(settingsText));
    run.check('settings: paranormal Full/Subtle selector present (E4 client service)', /subtle/i.test(settingsText), /paranormal|subtle|full/i.exec(settingsText)?.[0] ?? null);
    run.check('settings: no Left Ctrl toggle in the browser (desktop only)', !/left ctrl/i.test(settingsText));
    await shot(run, page, 'a03-menu-settings');
    await page.$eval('[data-testid="menu-howto"]', (b) => (b as HTMLButtonElement).click());
    await sleep(600);
    const howto = await page.$eval('[data-testid="menu-panel-howto"]', (e) => (e as HTMLElement).innerText).catch(() => '');
    run.notes.howtoText = howto.replace(/\s+/g, ' ').slice(0, 3000);
    run.check('how to play: crouch is C', /\bC\b/.test(howto) && /crouch/i.test(howto));
    run.check('how to play: never says Ctrl crouches in the browser', !/ctrl/i.test(howto) || /desktop/i.test(howto));
    await shot(run, page, 'a04-menu-howto');
  });

  // ------------------------------------------------------------------ join: the loading screen
  await step('loading', async () => {
    // the menu's JOIN CREW (bus 'join:click' opens the join loading screen; __game.join() would bypass it)
    await page.$eval('[data-testid="menu-play"]', (b) => (b as HTMLButtonElement).click());
    await page.waitForSelector('[data-testid="menu-panel-play"] button[type="submit"]', { timeout: 8000 });
    await page.$eval('[data-testid="menu-panel-play"] button[type="submit"]', (b) => (b as HTMLButtonElement).click());
    const vis = await until(page, (w) => w.__loading?.view?.().visible === true, null, 15_000);
    run.check('loading screen shows on join (?loading=1)', vis);
    if (vis) {
      await sleep(400);
      const v = await ev(page, (w) => w.__loading.view());
      await shot(run, page, 'a05-loading', v);
      const tip = await page.evaluate(() => (document.getElementById('loading-root')?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 600));
      run.notes.loadingText = tip;
    }
    const ready = await until(page, (w) => w.__game?.ready() === true && w.__game.state().phase === 'hub' && w.__levelDebug?.texturesReady?.(), null, 60_000);
    run.check('hub ready after join', ready, await ev(page, (w) => ({ phase: w.__game.state().phase, pending: w.__game.state().pending })));
    await until(page, (w) => !w.__loading?.view?.().visible, null, 15_000);
    run.notes.hubReadyAt = run.el();
    run.notes.render = await ev(page, (w) => { const i = w.__render?.info?.(); return i ? { backend: i.backend, preset: i.preset, compile: i.compile, warmSet: i.warmSet, pipelines: i.pipelines, features: i.features, mirrorsLive: i.mirrorsLive } : null; });
    run.check('WebGL2 backend on Low', (run.notes.render as { backend?: string } | null)?.backend === 'webgl2' && (run.notes.render as { preset?: string }).preset === 'low', run.notes.render);
    run.check('render boot compile ok (Low, WebGL2)', (run.notes.render as { compile?: { ok?: boolean } } | null)?.compile?.ok === true, (run.notes.render as { compile?: unknown } | null)?.compile);
  }, 30);

  // ------------------------------------------------------------------ the van: exterior + interior, every station
  await step('van', async () => {
    const L = await ev<{ van: { cab: { x: number; y: number; w: number; h: number } }; items: { kind: string; x: number; z: number; data?: Record<string, unknown> }[] }>(page, (w) => w.__netDebug.layout());
    stations = await ev<Station[]>(page, (w) => JSON.parse(JSON.stringify(w.__levelDebug.level().stations())));
    const info = await ev<{ stations: { kind: string; id: string; virtual: boolean; object: boolean }[]; van: unknown; upgrades: string[]; mirrors: number }>(page, (w) => w.__levelDebug.renderInfo());
    run.notes.stations = info.stations;
    run.notes.van = info.van;
    for (const k of ['workbench', 'stash', 'booklet', 'charger', 'mirror', 'records', 'console', 'leave_lever', 'deposit']) {
      const s = info.stations.find((x) => x.kind === k);
      run.check(`station ${k}: real (not virtual) with a 3D object`, !!s && !s.virtual && s.object, s ?? null);
    }
    const c = L.van.cab;
    const vx = c.x + c.w / 2;
    const sp = L.items.find((i) => i.kind === 'spawn_player');
    if (sp) { await camera(page, [sp.x, 1.65, sp.z], [vx, 1.3, c.y + 1.5]); await frames(page, 4); await sleep(500); await shot(run, page, 'a10-hub-spawn-van'); }
    await camera(page, [vx - 3.4, 1.75, c.y - 4.4], [vx, 1.2, c.y + 1.4]); await frames(page, 3); await shot(run, page, 'a11-van-rear34');
    await camera(page, [c.x + c.w + 3.6, 1.6, c.y + c.h + 5.2], [vx, 1.0, c.y + c.h + 1.0]); await frames(page, 3); await shot(run, page, 'a12-van-front34');
    await camera(page, [vx, 1.62, c.y + 0.2], [vx, 1.15, c.y + c.h - 0.4]); await frames(page, 3); await shot(run, page, 'a13-van-interior');
    // one framed view per van station (from 1.1 m in front of it, eye height)
    for (const k of ['workbench', 'stash', 'booklet', 'charger', 'mirror']) {
      if (run.left() < 30) break;
      const s = stations.find((x) => x.kind === k);
      if (!s) continue;
      const nx = Math.sin(s.rot), nz = Math.cos(s.rot);
      const d = k === 'mirror' ? 1.3 : 1.05;
      await camera(page, [s.p[0] + nx * d, 1.55, s.p[2] + nz * d], [s.p[0], Math.min(1.4, Math.max(0.6, s.p[1])), s.p[2]]);
      await frames(page, 3);
      await shot(run, page, `a2x-station-${k}`, { itemId: s.itemId, p: s.p, rot: s.rot, virtual: !!s.virtual });
    }
    const rec = stations.find((x) => x.kind === 'records');
    if (rec && run.left() > 40) {
      const nx = Math.sin(rec.rot), nz = Math.cos(rec.rot);
      await camera(page, [rec.p[0] + nx * 2.2, 1.6, rec.p[2] + nz * 2.2], [rec.p[0], rec.p[1], rec.p[2]]);
      await frames(page, 3);
      await shot(run, page, 'a2x-station-records', { itemId: rec.itemId, p: rec.p });
    }
    await camera(page, null);
  }, 40);

  // ------------------------------------------------------------------ station prompts (the interactables are registered)
  await step('prompts', async () => {
    const want: Record<string, RegExp> = { workbench: /^wb:/, stash: /^stash:/, booklet: /^fg:/, records: /^rec:/ };
    const got: Record<string, unknown> = {};
    for (const [k, re] of Object.entries(want)) {
      if (run.left() < 30) break;
      const s = stations.find((x) => x.kind === k);
      if (!s) { got[k] = 'no station'; continue; }
      const nx = Math.sin(s.rot), nz = Math.cos(s.rot);
      await ev(page, (w, a: [number, number, number]) => w.__game.teleport(a[0], a[1], a[2]), [s.p[0] + nx * 0.95, s.p[2] + nz * 0.95, s.rot + Math.PI] as [number, number, number]);
      await frames(page, 2);
      await ev(page, (w, q: V3) => w.__ix.aim(q[0], q[1], q[2]), s.p);
      const hit = await until(page, (w, src: string) => new RegExp(src).test(w.__ix.target()?.id ?? ''), re.source, 2500);
      const t = await ev<{ id?: string; view?: { text?: string; sub?: string } } | null>(page, (w) => w.__ix.target());
      got[k] = { id: t?.id ?? null, text: t?.view?.text ?? null, sub: t?.view?.sub ?? null };
      run.check(`prompt on the ${k} station`, hit, got[k]);
      if (k === 'workbench' && hit) await shot(run, page, 'a30-prompt-workbench');
    }
    run.notes.prompts = got;
  }, 30);

  // ------------------------------------------------------------------ screens: workbench, personnel file (records board), field guide
  await step('workbench', async () => {
    await dbg(page, 'workshop.give', { mats: { 'mat.scrap': 9, 'mat.wiring': 5, 'mat.chem': 4, 'mat.optics': 2, 'mat.cells': 1 } }).catch(() => null);
    await ev(page, (w) => w.__workshop.open('craft'));
    const ok = await page.waitForSelector('.wb-card', { timeout: 6000 }).then(() => true, () => false);
    run.check('workbench screen renders recipe cards', ok, await ev(page, (w) => w.__meta?.screen?.()));
    await sleep(500);
    await shot(run, page, 'a40-workbench-craft');
    await page.click('.wb-tab[data-tab="upgrades"]').catch(() => null);
    await sleep(500);
    await shot(run, page, 'a41-workbench-upgrades');
    await page.click('.wb-tab[data-tab="locker"]').catch(() => null);
    await sleep(500);
    await shot(run, page, 'a42-workbench-locker');
    await page.keyboard.press('Escape');
    await sleep(300);
  }, 15);
  await step('stats', async () => {
    await ev(page, (w) => w.__meta.open('stats'));
    const ok = await page.waitForSelector('.m-pf-screen [data-testid="personnel-file"][data-save]', { timeout: 8000, state: 'attached' }).then(() => true, () => false);
    run.check('records board: personnel file screen with Ann\'s save', ok);
    await sleep(500);
    await shot(run, page, 'a50-records-personnel-file');
    await ev(page, (w) => w.__meta.close());
    await sleep(300);
  }, 12);
  await step('fieldguide', async () => {
    for (const [m, e, id] of [['hound', 'seen', 'kennel'], ['hound', 'heard', 'kennel'], ['listener', 'heard', 'listener0']] as const) await dbg(page, 'fieldguide.event', { monster: m, event: e, id }).catch(() => null);
    await dbg(page, 'fieldguide.file', { pageId: 'hound.1' }).catch(() => null);
    await dbg(page, 'fieldguide.phenomenon', { kind: 'cold_spot' }).catch(() => null);
    await sleep(800);
    await ev(page, (w) => w.__fieldguide.open('hound'));
    const ok = await page.waitForSelector('[data-testid="fieldguide"]', { timeout: 6000 }).then(() => true, () => false);
    run.check('field guide screen opens', ok, await ev(page, (w) => w.__fieldguide.screen()));
    await frames(page, 2);
    await sleep(700);
    await shot(run, page, 'a60-fieldguide-hound');
    await page.click('.fg-tab[data-tab="listener"]').catch(() => null);
    await sleep(500);
    await shot(run, page, 'a61-fieldguide-listener');
    await ev(page, (w) => w.__fieldguide.close());
    await sleep(300);
  }, 10);
  await step('hubhud', async () => {
    await camera(page, null);
    await frames(page, 2);
    await shot(run, page, 'a70-hub-hud');
    run.notes.hudText = await page.evaluate(() => (document.getElementById('overlay')?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 800));
  }, 5);
} catch (e) {
  run.check('run', false, e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  const errs = await errorTally(page, p).catch(() => ({ game: ['(tally failed)'], page: [], http: [] }));
  run.notes.errors = errs;
  run.check('zero client errors (__game.errors: console + uncaptured)', errs.game.length === 0, errs.game.slice(0, 6));
  run.check('zero page errors', errs.page.length === 0, errs.page.slice(0, 6));
  run.notes.perf = await ev(page, (w) => w.__game.perf()).catch(() => null);
  run.write();
  await p.close().catch(() => {});
  run.log(`done: ${run.checks.filter((c) => !c.ok).length} failed checks, ${run.views.length} shots`);
  setTimeout(() => process.exit(0), 300).unref();
}
