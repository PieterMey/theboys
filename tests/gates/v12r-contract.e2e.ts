// Gate R (v1.2) run B, one PLAIN FACILITY contract (software lane, one Chrome + one ws bot): the join loading screen
// (menu JOIN CREW click), the stance HUD (walk / crouch), a drawer opened with loot in it, a hazard bulletin on a lore
// frame + its reader, the Listener notice tell, the grab HUD (victim) and the crew alert (a teammate grabbed), and two
// parity views of the plain facility. The bot sets the contract up first so the browser builds one level only.
//   node tools/gpu-guard.mjs --max-sec 120 --label "gate R contract" -- node tests/gates/v12r-contract.e2e.ts
// Needs the dev backend + tests/gates/v12r-proxy.mjs (BASE_URL, default :3898). Shots: tests/artifacts/gate-r/contract/.
import type { V3 } from './v12r-lib.ts';
import { BASE, camera, dbg, errorTally, ev, frames, launch, mkRun, shot, sleep, until } from './v12r-lib.ts';
import { Bot } from '../monsters/bot.ts';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const run = mkRun(arg('tag', 'contract'), Number(arg('budget', '112')));
const CREW = arg('crew', `GR${(Date.now() % 9000 + 1000).toString(36).toUpperCase()}`.replace(/[^A-Z0-9]/g, 'K').slice(0, 6));
const SEED = arg('seed', 'gate-r-b1');
const bob = new Bot('Bob');
await bob.connect(BASE.replace(/^http/, 'ws') + '/ws', CREW);
const gen = await bob.dbg<Record<string, unknown>>('level.generate', { seed: SEED, players: 2, risk: 2, theme: 'facility' });
run.notes.generated = { seed: gen.seed, theme: gen.theme, hash: gen.hash, errors: gen.errors };
await bob.dbg('monsters.flag', { name: 'director', on: false }).catch(() => null);
await bob.dbg('monsters.flag', { name: 'listenerFairV12', on: true }).catch(() => null);
const started = await bob.dbg<{ ok: boolean; agents: { id: string }[] }>('monsters.start', { risk: 2 });
run.notes.monsters = started.agents.map((a) => a.id);
for (const a of started.agents) await bob.dbg('monsters.place', { id: a.id, outSec: 9999 }).catch(() => null);
await bob.dbg('monsters.wake').catch(() => null);
await bob.dbg('monsters.place', { id: 'listener0', outSec: 9999 }).catch(() => null);
run.log(`crew ${CREW} contract ready (${String(gen.seed)} ${String(gen.theme)}), monsters ${run.notes.monsters}`);

const p = await launch({ name: 'Ann', crew: CREW, query: { levelLight: '1', loading: '1' } });
const page = p.page;
const step = async (name: string, fn: () => Promise<void>, minLeft = 6): Promise<void> => {
  if (run.left() < minLeft) { run.log(`skip ${name} (budget)`); run.notes[`skipped:${name}`] = true; return; }
  try { await fn(); } catch (e) { run.check(`${name} ran`, false, String(e).split('\n')[0]); await shot(run, page, `fail-${name}`); }
};
const tp = (x: number, z: number, yaw: number, pitch = -0.05) => ev(page, (w, a: [number, number, number, number]) => { w.__game.teleport(a[0], a[1], a[2]); w.__game.look(a[2], a[3]); }, [x, z, yaw, pitch] as [number, number, number, number]);
type Rect = { x: number; y: number; w: number; h: number };
type Space = { id: number; kind: string; type?: string; rect: Rect; light: string; powerZone: number; callsign: string | null };
let L: { W: number; spaces: Space[]; van: { cab: Rect } } | null = null;

try {
  // ------------------------------------------------------------------ menu JOIN CREW: the join loading screen covers the contract build
  await step('join', async () => {
    await page.waitForSelector('[data-testid="menu-panel-play"] button[type="submit"]', { timeout: 40_000 });
    run.notes.menuAt = run.el();
    await page.$eval('[data-testid="menu-panel-play"] button[type="submit"]', (b) => (b as HTMLButtonElement).click());
    const vis = await until(page, (w) => w.__loading?.view?.().visible === true, null, 8000);
    run.check('join loading screen shows (menu JOIN CREW)', vis);
    if (vis) {
      await until(page, (w) => ['assets', 'level', 'shaders'].includes(w.__loading.view().step), null, 8000);
      await shot(run, page, 'b01-loading-join', await ev(page, (w) => w.__loading.view()));
      run.notes.loadingText = await page.evaluate(() => (document.getElementById('loading-root')?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 500));
    }
    const ready = await until(page, (w) => w.__game?.ready() === true && w.__game.state().phase === 'contract' && w.__levelDebug?.texturesReady?.() && !w.__loading?.view?.().visible, null, 60_000);
    run.check('contract ready (plain facility)', ready, await ev(page, (w) => ({ phase: w.__game.state().phase, pending: w.__game.state().pending, loading: w.__loading?.view?.() })));
    run.notes.readyAt = run.el();
    L = await ev(page, (w) => w.__netDebug.layout());
    const cab = L!.van.cab;
    await bob.dbg('monsters.tp', { id: bob.id, x: cab.x + 1, z: cab.y + 1.5, light: 0 }).catch(() => null);
    run.notes.render = await ev(page, (w) => { const i = w.__render?.info?.(); return i ? { backend: i.backend, preset: i.preset, compile: i.compile, pipelines: i.pipelines, mirrorsLive: i.mirrorsLive, theme: w.__levelDebug.info()?.theme } : null; });
  }, 60);

  // ------------------------------------------------------------------ stance HUD
  await step('stance', async () => {
    const lane = await ev<{ x: number; z: number; len: number } | null>(page, (w) => w.__players?.lane?.() ?? null);
    if (!lane) { run.check('a walk lane', false); return; }
    const hud = () => ev<{ mode: string | null; radius: string | null; text: string }>(page, () => {
      const el = document.querySelector('[data-testid="stance-hud"]') as HTMLElement | null;
      return { mode: el?.dataset.mode ?? null, radius: el?.dataset.radius ?? null, text: el?.innerText.replace(/\s+/g, ' ').trim() ?? '' };
    });
    await tp(lane.x, lane.z, Math.PI / 2);
    await ev(page, (w) => w.__game.setInput({ forward: 1 }));
    await until(page, () => (document.querySelector('[data-testid="stance-hud"]') as HTMLElement | null)?.dataset.mode === 'walk', null, 2500);
    const walk = await hud();
    await shot(run, page, 'b10-stance-walk', walk);
    run.check('stance HUD: WALKING with a radius and the floor', walk.mode === 'walk' && /WALKING/.test(walk.text), walk);
    await tp(lane.x, lane.z, Math.PI / 2);
    await ev(page, (w) => w.__game.setInput({ forward: 1, crouch: true }));
    await until(page, () => (document.querySelector('[data-testid="stance-hud"]') as HTMLElement | null)?.dataset.mode === 'crouch', null, 2500);
    const crouch = await hud();
    await shot(run, page, 'b11-stance-crouch', crouch);
    run.check('stance HUD: CROUCHED · STEPS SILENT (C)', crouch.mode === 'crouch' && /CROUCHED/.test(crouch.text), crouch);
    await ev(page, (w) => w.__game.setInput({ forward: 0, crouch: false }));
  }, 20);

  // ------------------------------------------------------------------ a drawer / cabinet opened, its loot inside
  await step('drawer', async () => {
    type Cont = { id: string; prop: string; space: number; p: V3; front: [number, number]; main: number; parts?: { idx: number; slot: V3 }[] };
    const conts = await ev<Cont[]>(page, (w) => JSON.parse(JSON.stringify(w.__levelDebug.level().containers())));
    const peek = await bob.dbg<{ contents: Record<string, { type: string; name?: string }[]> }>('interaction.peek').catch(() => ({ contents: {} as Record<string, { type: string; name?: string }[]> }));
    run.notes.containers = { count: conts.length, withLoot: Object.values(peek.contents).filter((x) => x.length).length };
    const inRoom = (c: Cont) => { const s = L!.spaces[c.space]; return !!s && s.kind !== 'corridor' && s.rect.w >= 4 && s.rect.h >= 4; };
    const loot = (c: Cont) => (peek.contents[c.id] ?? []).some((x) => x.type.startsWith('loot.'));
    const pick = conts.find((c) => inRoom(c) && loot(c) && ['cabinet', 'desk', 'tool_chest', 'filing', 'counter'].includes(c.prop))
      ?? conts.find((c) => inRoom(c) && loot(c)) ?? conts.find((c) => inRoom(c) && (peek.contents[c.id]?.length ?? 0) > 0) ?? conts.find(inRoom) ?? conts[0];
    if (!pick) { run.check('a container in the level', false); return; }
    if (!(peek.contents[pick.id]?.length)) await bob.dbg('interaction.stock', { id: pick.id, type: 'loot.small', name: 'Pocket watch', value: 40 }).catch(() => null);
    run.notes.drawer = { id: pick.id, prop: pick.prop, contents: peek.contents[pick.id] ?? 'stocked: Pocket watch' };
    await bob.dbg('interaction.setLights', { space: pick.space, on: true }).catch(() => null);
    const sx = pick.front[0] + 0.5, sz = pick.front[1] + 0.5;
    await tp(sx, sz, Math.atan2(pick.p[0] - sx, pick.p[2] - sz), -0.3);
    await frames(page, 2);
    await ev(page, (w, q: V3) => w.__ix.aim(q[0], q[1], q[2]), pick.p);
    const tgt = await until(page, (w, id: string) => w.__ix.target()?.id === `cont:${id}`, pick.id, 3000);
    const t = await ev<{ id?: string; view?: { text?: string; sub?: string } } | null>(page, (w) => w.__ix.target());
    run.check(`drawer prompt (${pick.prop})`, tgt, { id: t?.id, text: t?.view?.text, sub: t?.view?.sub });
    await shot(run, page, 'b20-drawer-prompt', t);
    await ev(page, (w, id: string) => w.__ix.use(`cont:${id}`), pick.id);
    const open = await until(page, (w, id: string) => (w.__ix.state().containers?.[id]?.open ?? 0) > 0, pick.id, 4000);
    run.check('drawer opens (server state mirrored)', open);
    const items = await ev<{ id: string; type: string; name?: string; p?: number[]; container?: string }[]>(page, (w) => Object.entries(w.__ix.state().items ?? {}).map(([id, it]: [string, any]) => ({ id, type: it.type, name: it.name, p: it.p ?? it.pos, container: it.container ?? it.in })));
    const near = items.filter((it) => it.p && Math.hypot(it.p[0]! - pick.p[0], it.p[2]! - pick.p[2]) < 1.2);
    run.check('loot item revealed in the open drawer', near.length > 0, near.slice(0, 4));
    const part = (pick.parts ?? []).find((q) => q.idx === pick.main) ?? (pick.parts ?? [])[0];
    const slot: V3 = part ? part.slot : [pick.p[0], pick.p[1], pick.p[2]];
    await sleep(500);
    await shot(run, page, 'b21-drawer-open-player', { near });
    await camera(page, [sx + (sx - pick.p[0]) * 0.1, Math.max(1.25, slot[1] + 0.75), sz + (sz - pick.p[2]) * 0.1], slot);
    await frames(page, 3);
    await shot(run, page, 'b22-drawer-open-closeup', { slot });
    await camera(page, null);
    if (near[0]?.p) {
      await ev(page, (w, q: number[]) => w.__ix.aim(q[0], q[1], q[2]), near[0].p);
      await frames(page, 2);
      const pt = await ev<{ id?: string; view?: { text?: string } } | null>(page, (w) => w.__ix.target());
      run.notes.lootPrompt = { id: pt?.id, text: pt?.view?.text };
    }
  }, 20);

  // ------------------------------------------------------------------ a hazard bulletin on its lore frame + the reader
  await step('lore', async () => {
    const st = await bob.dbg<{ bulletins: { id: string; spot: string; space: number; monster: string; p: V3; front: [number, number] }[] }>('fieldguide.state');
    run.notes.bulletins = st.bulletins.map((b) => ({ spot: b.spot, monster: b.monster, space: b.space }));
    const b = st.bulletins[0];
    if (!b) { run.check('a bulletin on this site', false); return; }
    await bob.dbg('interaction.setLights', { space: b.space, on: true }).catch(() => null);
    const applied = await until(page, (w, spot: string) => { const fg = w.__fieldguide; fg.sync?.(); return spot in (fg.lorePages?.() ?? {}); }, b.spot, 8000);
    run.check('bulletin page drawn on its lore frame (E3 setLorePage)', applied, { spot: b.spot, lore: await ev(page, (w) => w.__fieldguide.levelLore?.()) });
    const yaw = Math.atan2(b.p[0] - b.front[0], b.p[2] - b.front[1]);
    await tp(b.front[0], b.front[1], yaw, Math.atan2(b.p[1] - 1.6, Math.hypot(b.p[0] - b.front[0], b.p[2] - b.front[1])));
    await frames(page, 3);
    await ev(page, (w, q: V3) => w.__ix.aim(q[0], q[1], q[2]), b.p);
    await until(page, (w) => /^lore:|^bulletin|^fg/.test(w.__ix.target()?.id ?? ''), null, 2500);
    const t = await ev<{ id?: string; view?: { text?: string } } | null>(page, (w) => w.__ix.target());
    run.notes.lorePrompt = { id: t?.id, text: t?.view?.text };
    await shot(run, page, 'b30-lore-frame', { spot: b.spot, prompt: run.notes.lorePrompt });
    if (t?.id) {
      await ev(page, (w, id: string) => w.__ix.use(id), t.id);
      const rd = await until(page, (w) => ['fieldguide', 'fieldguide-bulletin'].includes(w.__fieldguide.screen()), null, 4000);
      run.check('E on the bulletin opens the reader', rd, t.id);
      if (rd) { await sleep(400); await shot(run, page, 'b31-lore-reader'); await ev(page, (w) => w.__fieldguide.close()); await sleep(300); }
    }
  }, 22);

  // ------------------------------------------------------------------ the Listener: notice, grab HUD, crew alert
  await step('listener', async () => {
    const c = L!.spaces.filter((s) => (s.kind === 'room' || s.kind === 'hall') && s.rect.w >= 6 && s.rect.h >= 5);
    c.sort((a, b) => a.powerZone - b.powerZone || b.rect.w * b.rect.h - a.rect.w * a.rect.h);
    const room = c[0];
    if (!room) { run.check('a lit room for the Listener', false); return; }
    await bob.dbg('interaction.setLights', { space: room.id, on: true }).catch(() => null);
    const r = room.rect;
    const cam: [number, number] = [r.x + 1.0, r.y + r.h / 2];
    const lis: [number, number] = [r.x + 4.4, r.y + r.h / 2];
    const yaw = Math.atan2(lis[0] - cam[0], lis[1] - cam[1]);
    await tp(cam[0], cam[1], yaw, -0.04);
    await sleep(600);
    const me = await ev<string>(page, (w) => w.__game.me());
    await bob.dbg('monsters.place', { id: 'listener0', x: lis[0], z: lis[1], yaw: yaw + Math.PI, state: 'ambush', active: true });
    const sp = await until(page, (w) => (w.__monsters?.hud?.().spotted ?? 0) > 0.3, null, 3000);
    await bob.dbg('monsters.freeze', { on: true });
    await sleep(200);
    run.check('Listener notice: the victim-only spotted tell', sp, await ev(page, (w) => w.__monsters?.hud?.()));
    await shot(run, page, 'b40-listener-notice', { room: room.callsign });
    await bob.dbg('monsters.place', { id: 'listener0', outSec: 9999 });
    await bob.dbg('monsters.freeze', { on: false });
    await sleep(1200);
    await bob.dbg('monsters.tune', { section: 'listener', set: { grabSec: 40, soloGrabSec: 40 } });
    await bob.dbg('monsters.grab', { id: me, knockdown: false });
    const g = await until(page, (w) => !!w.__monsters?.hud?.().grab, null, 3000);
    run.check('grab HUD state (victim)', g);
    await sleep(700);
    await shot(run, page, 'b41-grab-victim', await ev(page, (w) => w.__monsters?.hud?.().grab));
    run.notes.grabText = await page.evaluate(() => (document.getElementById('overlay')?.innerText ?? '').replace(/\s+/g, ' ').slice(0, 400));
    for (let i = 0; i < 6; i++) {
      for (let k = 0; k < 5; k++) { await page.keyboard.press('KeyE'); await sleep(110); }
      if (!(await ev(page, (w) => !!w.__monsters?.hud?.().grab))) break;
    }
    run.check('mashing E frees the victim', !(await ev(page, (w) => !!w.__monsters?.hud?.().grab)));
    await sleep(3000);
    await bob.dbg('monsters.tp', { id: bob.id, x: lis[0] + 0.5, z: lis[1] + (r.h / 2 - 1 > 1.5 ? 1.5 : 0), light: 0 });
    await bob.dbg('monsters.grab', { id: bob.id, knockdown: false });
    const cg = await until(page, (w) => !!w.__monsters?.hud?.().grab, null, 3000);
    await sleep(900);
    const line = await page.evaluate(() => (document.getElementById('overlay')?.innerText ?? '').replace(/\s+/g, ' '));
    const crewLine = /BOB IS GRABBED[^·]*·[^·]*·\s*\d+\s*s/i.exec(line)?.[0] ?? null;
    run.check('crew alert: "BOB IS GRABBED · ROOM · Ns"', cg && !!crewLine, crewLine);
    await shot(run, page, 'b42-grab-crew', crewLine);
    for (let i = 0; i < 30; i++) { const rr = await bob.req<{ escaped?: boolean }>('monsters.struggle', {}).catch(() => null); if (rr?.escaped) break; await sleep(120); }
    const B = (await import('node:fs')).readFileSync(new URL('../../config/balance/monsters.json', import.meta.url), 'utf8');
    const lb = (JSON.parse(B) as { listener: Record<string, number> }).listener;
    await bob.dbg('monsters.tune', { section: 'listener', set: { grabSec: Number(lb.grabSec ?? 5), soloGrabSec: Number(lb.soloGrabSec ?? 6) } });
  }, 30);

  // ------------------------------------------------------------------ plain facility parity (free camera)
  await step('parity', async () => {
    const cor = L!.spaces.filter((s) => s.kind === 'corridor' && s.type !== 'junction').sort((a, b) => Math.max(b.rect.w, b.rect.h) - Math.max(a.rect.w, a.rect.h))[0];
    if (cor) {
      const r = cor.rect;
      await camera(page, r.w >= r.h ? [r.x + 0.6, 1.62, r.y + r.h / 2] : [r.x + r.w / 2, 1.62, r.y + 0.6], r.w >= r.h ? [r.x + r.w, 1.45, r.y + r.h / 2] : [r.x + r.w / 2, 1.45, r.y + r.h]);
      await frames(page, 3);
      await shot(run, page, 'b50-facility-corridor', { space: cor.id, callsign: cor.callsign });
    }
    const room = L!.spaces.filter((s) => s.kind === 'room').sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h)[0];
    if (room && run.left() > 4) {
      const r = room.rect;
      await camera(page, [r.x + 0.5, 2.2, r.y + 0.5], [r.x + r.w * 0.7, 0.6, r.y + r.h * 0.7]);
      await frames(page, 3);
      await shot(run, page, 'b51-facility-room', { space: room.id, callsign: room.callsign });
    }
    await camera(page, null);
    run.notes.renderInfo = await ev(page, (w) => { const i = w.__levelDebug.renderInfo(); return { drawCalls: i.drawCalls, props: i.props, containers: i.containers, lorePages: i.lorePages, mirrors: i.mirrors, decals: i.decals }; });
  }, 6);
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
