// Gate R (v1.2) runs C/D, THEMED SITES (software lane): an optional WebGL2 Medium boot check (menu only, its own Chrome),
// then one Chrome + one ws bot on themed contracts: per site the layout's themed prop keys and the level's material
// set, a corridor, a room overview and up to two themed kits; on the first site optionally the Listener notice tell,
// the grab HUD (victim) and the crew alert, and a hazard bulletin on its lore frame + the reader.
//   node tools/gpu-guard.mjs --max-sec 120 --label "gate R sites" -- node tests/gates/v12r-sites.e2e.ts \
//     --themes hospital,waterworks --parts listener,lore [--medium] --tag sites1
// Needs the dev backend + tests/gates/v12r-proxy.mjs (BASE_URL, default :3898). Shots: tests/artifacts/gate-r/<tag>/.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { V3 } from './v12r-lib.ts';
import { BASE, REPO, camera, dbg, errorTally, ev, frames, launch, mkRun, shot, sleep, until } from './v12r-lib.ts';
import { Bot } from '../monsters/bot.ts';
import { THEME_PROP_KEYS, THEME_GLB_KEYS } from '../../packages/shared/src/procgen/decor.ts';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const run = mkRun(arg('tag', 'sites'), Number(arg('budget', '113')));
const THEMES = arg('themes', 'hospital,waterworks').split(',').filter(Boolean);
const PARTS = new Set(arg('parts', '').split(',').filter(Boolean));
const MEDIUM = process.argv.includes('--medium');
const SEED = arg('seed', 'gate-r-c1');
const CREW = `GS${(Date.now() % 9000 + 1000).toString(36).toUpperCase()}`.replace(/[^A-Z0-9]/g, 'K').slice(0, 6);
type Rect = { x: number; y: number; w: number; h: number };
type Space = { id: number; kind: string; type?: string; rect: Rect; light: string; powerZone: number; callsign: string | null };
type Item = { id: string; kind: string; x: number; y?: number; z: number; rot?: number; space: number; data?: Record<string, unknown> };
type Layout = { W: number; theme?: string; seed: string; spaces: Space[]; items: Item[]; van: { cab: Rect } };

// ------------------------------------------------------------------ 0) WebGL2 Medium boot (menu only; the boot compile check runs on test pages)
if (MEDIUM) {
  const m = await launch({ name: 'Med', query: { preset: 'medium' } });
  try {
    await m.page.waitForSelector('[data-testid="main-menu"]', { timeout: 15_000 }).catch(() => null);
    const compiled = await until(m.page, (w) => !!w.__render?.info?.().compile, null, 15_000);
    await frames(m.page, 3);
    const info = await ev(m.page, (w) => { const i = w.__render?.info?.(); return i ? { backend: i.backend, preset: i.preset, compile: i.compile, warmSet: i.warmSet, pipelines: i.pipelines, features: i.features, mist: i.mist, frames: i.frames } : null; });
    run.notes.medium = info;
    run.check('WebGL2 Medium boot: backend webgl2, preset medium', compiled && (info as { backend?: string } | null)?.backend === 'webgl2' && (info as { preset?: string }).preset === 'medium', info);
    run.check('WebGL2 Medium boot compile ok', (info as { compile?: { ok?: boolean } } | null)?.compile?.ok === true, (info as { compile?: unknown } | null)?.compile);
    await shot(run, m.page, 'm01-medium-menu');
    const errs = await errorTally(m.page, m);
    run.notes.mediumErrors = errs;
    run.check('Medium boot: zero client + page errors', errs.game.length === 0 && errs.page.length === 0, [...errs.game, ...errs.page].slice(0, 6));
  } catch (e) {
    run.check('medium boot ran', false, String(e).split('\n')[0]);
  } finally {
    await m.close().catch(() => {});
  }
}

// ------------------------------------------------------------------ 1) the first themed contract, set up before the browser loads
const bob = new Bot('Bob');
await bob.connect(BASE.replace(/^http/, 'ws') + '/ws', CREW);
const gen0 = await bob.dbg<Record<string, unknown>>('level.generate', { seed: SEED, players: 2, risk: 2, theme: THEMES[0] });
run.notes[`gen:${THEMES[0]}`] = { seed: gen0.seed, theme: gen0.theme, hash: gen0.hash, errors: gen0.errors, genMs: gen0.genMs };
if (PARTS.has('listener') || PARTS.has('crew')) {
  await bob.dbg('monsters.flag', { name: 'director', on: false }).catch(() => null);
  await bob.dbg('monsters.flag', { name: 'listenerFairV12', on: true }).catch(() => null);
  const st = await bob.dbg<{ agents: { id: string }[] }>('monsters.start', { risk: 2 });
  for (const a of st.agents) await bob.dbg('monsters.place', { id: a.id, outSec: 9999 }).catch(() => null);
  await bob.dbg('monsters.wake').catch(() => null);
  await bob.dbg('monsters.place', { id: 'listener0', outSec: 9999 }).catch(() => null);
}
run.log(`crew ${CREW}: ${THEMES[0]} contract ready (${String(gen0.hash)})`);

const VW = Number(arg('w', '1280')), VH = Number(arg('h', '720'));
const p = await launch({ name: 'Ann', crew: CREW, query: { autojoin: '1', levelLight: '1' }, viewport: { width: VW, height: VH } });
const page = p.page;
const step = async (name: string, fn: () => Promise<void>, minLeft = 6): Promise<void> => {
  if (run.left() < minLeft) { run.log(`skip ${name} (budget)`); run.notes[`skipped:${name}`] = true; return; }
  try { await fn(); } catch (e) { run.check(`${name} ran`, false, String(e).split('\n')[0]); await shot(run, page, `fail-${name}`); }
};
const tp = (x: number, z: number, yaw: number, pitch = -0.05) => ev(page, (w, a: [number, number, number, number]) => { w.__game.teleport(a[0], a[1], a[2]); w.__game.look(a[2], a[3]); }, [x, z, yaw, pitch] as [number, number, number, number]);
const siteReady = (theme: string, ms: number) => until(page, (w, t: string) => w.__game?.ready() === true && w.__game.state().phase === 'contract' && w.__levelDebug?.info?.()?.theme === t && w.__levelDebug.texturesReady(), theme, ms);
let L: Layout | null = null;

const listener = async () => {
  const c = L!.spaces.filter((s) => (s.kind === 'room' || s.kind === 'hall') && s.rect.w >= 6 && s.rect.h >= 5);
  c.sort((a, b) => a.powerZone - b.powerZone || b.rect.w * b.rect.h - a.rect.w * a.rect.h);
  const room = c[0];
  if (!room) { run.check('a room for the Listener', false); return; }
  await bob.dbg('interaction.setLights', { space: room.id, on: true }).catch(() => null);
  const r = room.rect;
  const cam: [number, number] = [r.x + 1.0, r.y + r.h / 2];
  const lis: [number, number] = [r.x + 4.4, r.y + r.h / 2];
  const yaw = Math.atan2(lis[0] - cam[0], lis[1] - cam[1]);
  await tp(cam[0], cam[1], yaw, -0.04);
  await sleep(500);
  const me = await ev<string>(page, (w) => w.__game.me());
  await bob.dbg('monsters.place', { id: 'listener0', x: lis[0], z: lis[1], yaw: yaw + Math.PI, state: 'ambush', active: true });
  const sp = await until(page, (w) => (w.__monsters?.hud?.().spotted ?? 0) > 0.3, null, 3000);
  await bob.dbg('monsters.freeze', { on: true });
  run.check('Listener notice: the victim-only spotted tell', sp, await ev(page, (w) => w.__monsters?.hud?.()));
  await shot(run, page, 'c10-listener-notice', { room: room.callsign });
  run.notes.noticeText = await page.evaluate(() => (document.getElementById('overlay')?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 300));
  await bob.dbg('monsters.place', { id: 'listener0', outSec: 9999 });
  await bob.dbg('monsters.freeze', { on: false });
  await sleep(1000);
  await bob.dbg('monsters.tune', { section: 'listener', set: { grabSec: 40, soloGrabSec: 40 } });
  await bob.dbg('monsters.grab', { id: me, knockdown: false });
  const g = await until(page, (w) => !!w.__monsters?.hud?.().grab, null, 3000);
  run.check('grab HUD state (victim)', g);
  await sleep(600);
  await shot(run, page, 'c11-grab-victim', await ev(page, (w) => w.__monsters?.hud?.().grab));
  run.notes.grabText = await page.evaluate(() => (document.getElementById('overlay')?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 400));
  for (let i = 0; i < 3; i++) { await page.keyboard.press('KeyE'); await sleep(120); }
  await shot(run, page, 'c12-grab-struggle', await ev(page, (w) => w.__monsters?.hud?.().grab));
  for (let i = 0; i < 6; i++) {
    for (let k = 0; k < 5; k++) { await page.keyboard.press('KeyE'); await sleep(110); }
    if (!(await ev(page, (w) => !!w.__monsters?.hud?.().grab))) break;
  }
  run.check('mashing E frees the victim', !(await ev(page, (w) => !!w.__monsters?.hud?.().grab)));
  await sleep(2800);
  await bob.dbg('monsters.tp', { id: bob.id, x: lis[0] + 0.5, z: lis[1] + (r.h / 2 - 1 > 1.5 ? 1.5 : 0), light: 0 });
  await bob.dbg('monsters.grab', { id: bob.id, knockdown: false });
  const cg = await until(page, (w) => !!w.__monsters?.hud?.().grab, null, 3000);
  await sleep(800);
  const line = await page.evaluate(() => (document.getElementById('overlay')?.innerText ?? '').replace(/\s+/g, ' '));
  const crewLine = /BOB IS GRABBED[^·]*·[^·]*·\s*\d+\s*s/i.exec(line)?.[0] ?? null;
  run.check('crew alert: "BOB IS GRABBED · ROOM · Ns"', cg && !!crewLine, crewLine ?? line.slice(0, 200));
  await shot(run, page, 'c13-grab-crew', crewLine);
  for (let i = 0; i < 30; i++) { const rr = await bob.req<{ escaped?: boolean }>('monsters.struggle', {}).catch(() => null); if (rr?.escaped) break; await sleep(120); }
  const lb = (JSON.parse(readFileSync(join(REPO, 'config/balance/monsters.json'), 'utf8')) as { listener: Record<string, number> }).listener;
  await bob.dbg('monsters.tune', { section: 'listener', set: { grabSec: Number(lb.grabSec ?? 5), soloGrabSec: Number(lb.soloGrabSec ?? 6) } });
  await bob.dbg('monsters.tp', { id: bob.id, x: L!.van.cab.x + 1, z: L!.van.cab.y + 1.5, light: 0 }).catch(() => null);
};

/** a teammate grabbed elsewhere: the crew alert line on Ann's HUD (Ann stays free) */
const crewAlert = async () => {
  const rooms = L!.spaces.filter((s) => (s.kind === 'room' || s.kind === 'hall') && s.rect.w >= 5 && s.rect.h >= 4 && s.callsign);
  const room = rooms[rooms.length - 1];
  if (!room) { run.check('a room for the crew alert', false); return; }
  const r = room.rect;
  await bob.dbg('monsters.tp', { id: bob.id, x: r.x + r.w / 2, z: r.y + r.h / 2, light: 0 });
  await bob.dbg('monsters.place', { id: 'listener0', x: r.x + r.w / 2 + 1.2, z: r.y + r.h / 2, active: true }).catch(() => null);
  const gr = await bob.dbg<{ ok: boolean }>('monsters.grab', { id: bob.id, knockdown: false });
  const cg = await until(page, (w) => !!w.__monsters?.hud?.().grab, null, 3000);
  await until(page, () => /IS GRABBED/i.test(document.getElementById('overlay')?.innerText ?? ''), null, 2500);
  const line = await page.evaluate(() => (document.getElementById('overlay')?.innerText ?? '').replace(/\s+/g, ' '));
  const crewLine = /BOB IS GRABBED[^·]*·[^·]*·\s*\d+\s*s/i.exec(line)?.[0] ?? null;
  run.check('crew alert: "BOB IS GRABBED · ROOM · Ns" on a teammate\'s HUD', gr.ok && cg && !!crewLine, crewLine ?? line.slice(0, 240));
  await shot(run, page, 'c05-crew-alert', { crewLine, room: room.callsign });
  for (let i = 0; i < 30; i++) { const rr = await bob.req<{ escaped?: boolean }>('monsters.struggle', {}).catch(() => null); if (rr?.escaped) break; await sleep(120); }
  await bob.dbg('monsters.place', { id: 'listener0', outSec: 9999 }).catch(() => null);
  await bob.dbg('monsters.tp', { id: bob.id, x: L!.van.cab.x + 1, z: L!.van.cab.y + 1.5, light: 0 }).catch(() => null);
};

const lore = async () => {
  const st = await bob.dbg<{ bulletins: { spot: string; space: number; monster: string; p: V3; front: [number, number] }[] }>('fieldguide.state');
  run.notes.bulletins = st.bulletins.map((b) => ({ spot: b.spot, monster: b.monster, space: b.space }));
  const b = st.bulletins[0];
  if (!b) { run.check('a bulletin on this site', false); return; }
  await bob.dbg('interaction.setLights', { space: b.space, on: true }).catch(() => null);
  const applied = await until(page, (w, spot: string) => { const fg = w.__fieldguide; fg.sync?.(); return spot in (fg.lorePages?.() ?? {}); }, b.spot, 8000);
  run.check('bulletin page drawn on its lore frame (E3 setLorePage)', applied, { spot: b.spot, lore: await ev(page, (w) => w.__fieldguide.levelLore?.()) });
  const holder = L!.items.find((i) => i.id === b.spot);
  run.notes.loreHolder = holder ? { prop: holder.data?.prop, lore: holder.data?.lore } : null;
  const yaw = Math.atan2(b.p[0] - b.front[0], b.p[2] - b.front[1]);
  await tp(b.front[0], b.front[1], yaw, -0.05);
  await frames(page, 2);
  await ev(page, (w, q: V3) => w.__ix.aim(q[0], q[1], q[2]), b.p);
  await until(page, (w) => /^(lore|bulletin|fg|rec):/.test(w.__ix.target()?.id ?? ''), null, 2500);
  const t = await ev<{ id?: string; view?: { text?: string; sub?: string } } | null>(page, (w) => w.__ix.target());
  run.notes.lorePrompt = { id: t?.id, text: t?.view?.text, sub: t?.view?.sub };
  run.check('a prompt on the bulletin', !!t?.id && /bulletin|read|notice|lore/i.test(`${t?.id} ${t?.view?.text}`), run.notes.lorePrompt);
  await shot(run, page, 'c20-lore-frame', { spot: b.spot, holder: run.notes.loreHolder, prompt: run.notes.lorePrompt });
  if (t?.id) {
    await ev(page, (w, id: string) => w.__ix.use(id), t.id);
    const rd = await until(page, (w) => ['fieldguide', 'fieldguide-bulletin'].includes(w.__fieldguide.screen()), null, 4000);
    run.check('E on the bulletin opens the reader', rd, t.id);
    if (rd) { await sleep(400); await shot(run, page, 'c21-lore-reader'); }
    await ev(page, (w) => w.__fieldguide.close());
    await until(page, (w) => w.__fieldguide.screen() === 'none', null, 2000);
  }
};

const siteViews = async (theme: string, n: number) => {
  const keys = THEME_PROP_KEYS[theme] ?? [];
  const hist: Record<string, number> = {};
  for (const it of L!.items) if (it.kind === 'prop') { const k = String(it.data?.prop ?? '?'); hist[k] = (hist[k] ?? 0) + 1; }
  const themed = Object.fromEntries(keys.map((k) => [k, hist[k] ?? 0]));
  const glb = Object.fromEntries(THEME_GLB_KEYS.filter((k) => hist[k]).map((k) => [k, hist[k]]));
  const mats = await ev<string[]>(page, (w) => {
    const s = new Set<string>();
    w.__render.three().scene.traverse((o: any) => { if (o.isMesh && o.visible !== false) for (const m of [].concat(o.material)) if ((m as any)?.name) s.add((m as any).name); });
    return [...s].sort();
  }).catch(() => [] as string[]);
  const info = await ev(page, (w) => { const i = w.__levelDebug.info(); const r = w.__levelDebug.renderInfo(); return { theme: i.theme, props: i.props, fixtures: i.fixtures, buildMs: i.buildMs, drawCalls: r.drawCalls, propStats: r.props, containers: r.containers, mirrors: r.mirrors, lorePages: r.lorePages }; });
  const callsigns = L!.spaces.map((s) => s.callsign).filter(Boolean);
  run.notes[`site:${theme}`] = { info, themedKeys: themed, glbKeys: glb, materials: mats.slice(0, 80), materialCount: mats.length, callsigns };
  run.check(`${theme}: themed prop keys present`, keys.length === 0 || Object.values(themed).some((v) => v > 0), themed);
  const cor = L!.spaces.filter((s) => s.kind === 'corridor' && s.type !== 'junction').sort((a, b) => Math.max(b.rect.w, b.rect.h) - Math.max(a.rect.w, a.rect.h))[0];
  if (cor) {
    const r = cor.rect;
    await camera(page, r.w >= r.h ? [r.x + 0.6, 1.62, r.y + r.h / 2] : [r.x + r.w / 2, 1.62, r.y + 0.6], r.w >= r.h ? [r.x + r.w, 1.45, r.y + r.h / 2] : [r.x + r.w / 2, 1.45, r.y + r.h]);
    await frames(page, 3);
    await shot(run, page, `c${n}0-${theme}-corridor`, { callsign: cor.callsign });
  }
  // the room holding the most themed props, from its corner
  const counts = new Map<number, number>();
  for (const it of L!.items) if (it.kind === 'prop' && keys.includes(String(it.data?.prop))) counts.set(it.space, (counts.get(it.space) ?? 0) + 1);
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  const room = best ? L!.spaces[best[0]] : L!.spaces.filter((s) => s.kind === 'room').sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h)[0];
  if (room && run.left() > 5) {
    const r = room.rect;
    await camera(page, [r.x + 0.45, 2.25, r.y + 0.45], [r.x + r.w * 0.65, 0.5, r.y + r.h * 0.65]);
    await frames(page, 3);
    await shot(run, page, `c${n}1-${theme}-room`, { callsign: room.callsign, type: room.type, themedHere: best?.[1] ?? 0 });
  }
  const kits = L!.items.filter((i) => i.kind === 'prop' && keys.includes(String(i.data?.prop)));
  const seen = new Set<string>();
  for (const it of kits) {
    const key = String(it.data?.prop);
    if (seen.has(key) || seen.size >= 2 || run.left() < 5) continue;
    seen.add(key);
    const nx = Math.sin(it.rot ?? 0), nz = Math.cos(it.rot ?? 0);
    const dd = 1.6 + Number(it.data?.d ?? 0.6) / 2;
    await camera(page, [it.x + nx * dd + nz * 0.6, 1.55, it.z + nz * dd - nx * 0.6], [it.x, (it.y ?? 0) + 0.7, it.z]);
    await frames(page, 3);
    await shot(run, page, `c${n}${1 + seen.size}-${theme}-kit-${key}`);
  }
  await camera(page, null);
};

try {
  await step('ready', async () => {
    const ok = await siteReady(THEMES[0]!, 70_000);
    run.check(`${THEMES[0]} contract ready`, ok, await ev(page, (w) => ({ phase: w.__game.state().phase, pending: w.__game.state().pending, level: w.__levelDebug?.info?.() })));
    run.notes.readyAt = run.el();
    L = await ev(page, (w) => w.__netDebug.layout());
    await bob.dbg('monsters.tp', { id: bob.id, x: L!.van.cab.x + 1, z: L!.van.cab.y + 1.5, light: 0 }).catch(() => null);
    run.notes.render = await ev(page, (w) => { const i = w.__render?.info?.(); return i ? { backend: i.backend, preset: i.preset, compile: i.compile, pipelines: i.pipelines } : null; });
  }, 40);
  if (PARTS.has('crew')) await step('crew', crewAlert, 12);
  if (PARTS.has('listener')) await step('listener', listener, 28);
  if (PARTS.has('lore')) await step('lore', lore, 14);
  for (const [i, theme] of THEMES.entries()) {
    if (i > 0) {
      if (run.left() < 28) { run.log(`skip site ${theme} (budget)`); run.notes[`skipped:site:${theme}`] = true; continue; }
      const t0 = run.el();
      const g = await dbg<Record<string, unknown>>(page, 'level.generate', { seed: SEED, players: 2, risk: 2, theme });
      run.notes[`gen:${theme}`] = { seed: g.seed, theme: g.theme, hash: g.hash, errors: g.errors, genMs: g.genMs };
      const ok = await siteReady(theme, Math.max(5000, (run.left() - 12) * 1000));
      run.check(`${theme} site rebuilt and ready`, ok, { sec: +(run.el() - t0).toFixed(1) });
      if (!ok) continue;
      L = await ev(page, (w) => w.__netDebug.layout());
    }
    await step(`views:${theme}`, () => siteViews(theme, i + 3), 5);
  }
} catch (e) {
  run.check('run', false, e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  const errs = await errorTally(page, p).catch(() => ({ game: ['(tally failed)'], page: [], http: [] }));
  run.notes.errors = errs;
  run.check('zero client errors (__game.errors: console + uncaptured)', errs.game.length === 0, errs.game.slice(0, 6));
  run.check('zero page errors', errs.page.length === 0, errs.page.slice(0, 6));
  run.write();
  bob.close();
  await p.close().catch(() => {});
  run.log(`done: ${run.checks.filter((c) => !c.ok).length} failed checks, ${run.views.length} shots`);
  setTimeout(() => process.exit(0), 300).unref();
}
