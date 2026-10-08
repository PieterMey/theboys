// v1.2 (G3) gear visuals in Chrome (one batched pass): the new item models + world materials (instanced, with a plain-
// mesh A/B shot and a probe of where each instance projects) in a close-up, the v1.1 item models in a second close-up
// (every model is one merged draw since the gate-P fix), the pre-warm ending and world items culled to the visible
// spaces, the inventory icons / status chips / pouch chips and a view model, a thrown bottle, night vision on
// (render.setNightVision or the CSS fallback), a drawer tapped open with its contents, a drawer and a door mid-ease with
// the ring, the death-card creeping tip. A ws bot keeps the crew alive (a lone death would end the contract before the
// card shows); it waits in the van, out of every shot.
// Every check polls (SwiftShader frames are slow; a fixed sleep raced the HUD in an earlier run).
// Needs a dev server: PORT=3803 NODE_ENV=development AI_MODE=mock ... node apps/server/src/index.ts --dev
//   node tools/gpu-guard.mjs --max-sec 120 -- node tests/gear/visual.e2e.ts 3803 [--flat]
//   --flat = ?levelLight=1 (flat debug fill: readable model / drawer close-ups; night vision is then skipped)
// Screenshots: tests/artifacts/gear-v12/*.png (look at them).
import { launchPlayer, screenshot, waitForGame } from '../lib/launch.ts';
import { Bot } from '../interaction/bot.ts';
import { doorSpot } from '../interaction/spots.ts';
import { containersOf } from '../../packages/shared/src/procgen/containers.ts';
import type { ContainerInfo } from '../../packages/shared/src/procgen/containers.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';

const port = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? process.env.PORT ?? 3803);
const flat = process.argv.includes('--flat');
const BASE = `http://127.0.0.1:${port}`;
const CREW = `GV${Date.now() % 100000}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (cond: unknown, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
  if (!cond) fails++;
};
const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;
// the SwiftShader lane (tools/gpu-guard.mjs) renders on the CPU: a smaller viewport keeps frames and screenshots quick
const soft = process.env.DEADAIR_RENDER === 'swiftshader';
const p = await launchPlayer({ baseUrl: BASE, crew: CREW, name: 'Vis', query: { autojoin: '1', ...(flat ? { levelLight: '1' } : {}) }, ...(soft ? { viewport: { width: 960, height: 540 } } : {}) });
const page = p.page;
const ev = <T = unknown>(js: string) => page.evaluate(js) as Promise<T>;
/** poll a page expression until truthy (false on timeout) */
const until = (js: string, ms: number) => page.waitForFunction(js, undefined, { timeout: ms, polling: 100 }).then(() => true, () => false);
/** let the render loop draw n more frames */
const frames = (n: number) => ev(`new Promise((r) => { let k = ${n}; const f = () => (--k <= 0 ? r(0) : requestAnimationFrame(f)); requestAnimationFrame(f); })`);
const tag = flat ? 'flat-' : '';
const shot = async (name: string) => {
  await frames(3);
  console.log('shot', await screenshot(page, `tests/artifacts/gear-v12/${tag}${name}.png`), secs());
};
const dbg = (r: string, a: unknown = {}) => ev(`__game.dbg(${JSON.stringify(r)}, ${JSON.stringify(a)})`);
const camera = (pos: number[] | null, at?: number[]) => ev(`window.__levelDebug && __levelDebug.camera(${JSON.stringify(pos)}, ${JSON.stringify(at ?? null) === 'null' ? 'undefined' : JSON.stringify(at)})`);
const mate = new Bot('Mate');
try {
  // no Vite HMR socket: other builders' edits must not reload this page mid-run
  await page.routeWebSocket(/token=/, () => {});
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForGame(page, 75_000);
  await page.waitForFunction(() => !!(window as unknown as { __game?: { me(): string | null } }).__game?.me(), undefined, { timeout: 15_000 });
  console.log('game ready', secs());
  await mate.connect(`ws://127.0.0.1:${port}/ws`, CREW);
  await dbg('level.generate', { seed: 'g3-visual-1', players: 2 });
  await dbg('monsters.freeze', { on: true }).catch(() => undefined);
  await dbg('paranormal.tune', { nextInSec: 9999 }).catch(() => undefined);
  await page.waitForFunction(() => (window as unknown as { __ix?: { layout(): { seed?: string } | null } }).__ix?.layout()?.seed === 'g3-visual-1', undefined, { timeout: 25_000 });
  await sleep(1500);
  await frames(5);
  console.log('level ready', secs());
  // ---------------- 0) gate-P fix: the pre-warm ends (3 drawn frames + 0.5 s), world items are one mesh each and culled
  interface DS { items: number; shown: number; draws: number; casters: number; warm: boolean; warmFrames: number; maxMeshesPerItem: number; thrown: number; held: number }
  const warmDone = await until(`(() => { const d = __ix.drawStats(); return !!d && !d.warm; })()`, 10_000);
  const ds0 = await ev<DS | null>('__ix.drawStats()');
  ok(warmDone, `pre-warm ended (${ds0?.warmFrames} drawn frames)`);
  ok(!!ds0 && ds0.maxMeshesPerItem <= 2, `world items merged: ${JSON.stringify(ds0)}`);
  const L = await ev<LevelLayout>('__ix.layout()');
  const conts = containersOf(L);
  ok(conts.length > 0, `${conts.length} containers (E1)`);
  const pickC = (): ContainerInfo | undefined => conts.find((c) => L.spaces[c.space]?.kind !== 'corridor' && L.spaces[c.space]!.rect.w >= 4 && L.spaces[c.space]!.rect.h >= 4) ?? conts[0];
  const c0 = pickC()!;
  const sx = c0.front[0] + 0.5, sz = c0.front[1] + 0.5;
  const yawTo = (x: number, z: number) => Math.atan2(x - sx, z - sz);
  await dbg('interaction.setLights', { on: true });
  await ev(`__game.teleport(${sx}, ${sz}, ${yawTo(c0.p[0], c0.p[2])})`);
  // the mate waits in the van: out of every shot (standing on our spot put its body in front of the camera)
  await mate.dbg('interaction.pose', { pid: mate.me, x: L.van.x, z: L.van.z });
  await sleep(300);
  await frames(3);
  // inside a room: the items of rooms the camera cannot see are not drawn
  const dsIn = await ev<DS | null>('__ix.drawStats()');
  ok(!!dsIn && (dsIn.items < 6 || dsIn.shown < dsIn.items), `items outside the visible spaces are culled (${dsIn?.shown}/${dsIn?.items} shown, ${dsIn?.draws} draws, ${dsIn?.casters} casters)`);

  // ---------------- 1) item models + instanced materials, a close-up (instanced, then the same as plain meshes)
  const awayYaw = yawTo(c0.p[0], c0.p[2]) + Math.PI;
  const fx = Math.sin(awayYaw), fz = Math.cos(awayYaw), rx = Math.cos(awayYaw), rz = -Math.sin(awayYaw);
  const rows = [
    ['battery', 'lockpick', 'masterkey', 'soles', 'nvg'],
    ['flashbulb', 'loot.curio', 'page', 'mat.pouch', 'mat.relic'],
    ['mat.scrap', 'mat.wiring', 'mat.chem', 'mat.optics', 'mat.cells'],
  ];
  const D0 = 0.75, DR = 0.22, DC = 0.19;
  for (const [ri, row] of rows.entries()) {
    for (const [ci, type] of row.entries()) {
      const d = D0 + ri * DR, o = (ci - 2) * DC;
      const x = sx + fx * d + rx * o, z = sz + fz * d + rz * o;
      await dbg('interaction.spawn', { type, x, z, ...(type === 'mat.pouch' ? { mats: { 'mat.scrap': 2 }, name: 'A salvage pouch' } : {}), ...(type === 'loot.curio' ? { value: 99, name: 'Music box' } : {}), ...(type.startsWith('mat.') && type !== 'mat.pouch' ? { count: 2 } : {}) });
    }
  }
  await ev(`__ix.flashlight(true)`);
  const mid = D0 + DR;
  await camera([sx + fx * (mid - 0.42), 0.72, sz + fz * (mid - 0.42)], [sx + fx * mid, 0.02, sz + fz * mid]);
  await until(`(() => { const s = __ix.matStats(); return !!s && s.draws >= 6; })()`, 8000);
  await frames(4);
  const ms = await ev<{ draws: number; instances: number } | null>('__ix.matStats()');
  ok(!!ms && ms.draws >= 6 && ms.draws <= 7, `materials instanced: ${JSON.stringify(ms)} (<= 7 draws)`);
  const probe = await ev<{ type: string; count: number; ndc: number[]; visible: boolean; inScene: boolean }[] | null>('__ix.matProbe()');
  for (const pr of probe ?? []) console.log('probe', JSON.stringify(pr));
  // instance 0 of a type can be a level-spawned material elsewhere (scrap, cells): every mesh must be visible and in the
  // scene, and the types only this test spawned must project inside the close-up
  const inFrame = (q: { ndc: number[] }) => Math.abs(q.ndc[0]!) < 1 && Math.abs(q.ndc[1]!) < 1 && q.ndc[2]! < 1;
  ok(!!probe && probe.length >= 6 && probe.every((q) => q.visible && q.inScene) && probe.filter((q) => q.count === 1).every(inFrame),
    'every material mesh is visible and in the scene; the test-spawned ones project inside the close-up');
  await shot('1-items');
  await ev('__ix.matPlain(true)');
  await shot('1b-items-plain');
  await ev('__ix.matPlain(false)');
  // the v1.1 models (merged since the gate-P fix), further into the room
  const rows11 = [
    ['bottle', 'medkit', 'walkie', 'keycard', 'badge'],
    ['flare', 'sensor', 'syringe', 'charm', 'loot.idol'],
    ['airhorn', 'glowstick', 'flashlight_pro', 'loot.small', 'crowbar'],
  ];
  const E0 = 1.65, ER = 0.3, EC = 0.24;
  const before11 = (await ev<DS | null>('__ix.drawStats()'))?.items ?? 0;
  for (const [ri, row] of rows11.entries()) {
    for (const [ci, type] of row.entries()) {
      const d = E0 + ri * ER, o = (ci - 2) * EC;
      await dbg('interaction.spawn', { type, x: sx + fx * d + rx * o, z: sz + fz * d + rz * o });
    }
  }
  const mid11 = E0 + ER;
  await camera([sx + fx * (mid11 - 0.55), 0.85, sz + fz * (mid11 - 0.55)], [sx + fx * mid11, 0.03, sz + fz * mid11]);
  await until(`(() => { const d = __ix.drawStats(); return !!d && d.items >= ${before11 + 15}; })()`, 6000);
  await frames(4);
  const ds1 = await ev<DS | null>('__ix.drawStats()');
  ok(!!ds1 && ds1.maxMeshesPerItem <= 2, `v1.1 models merged too: ${JSON.stringify(ds1)}`);
  await shot('1c-items-v11');
  await camera(null);

  // ---------------- 2) a thrown bottle flies as one merged model (pooled thrown views); before the HUD gear fills the
  // four slots
  await ev(`__game.teleport(${sx}, ${sz}, ${awayYaw})`);
  await dbg('interaction.give', { type: 'bottle' });
  ok(await until(`__ix.inventory().includes('bottle')`, 3000), 'bottle in hand');
  await ev(`__ix.slot(__ix.inventory().indexOf('bottle'))`);
  await ev(`__ix.aim(${sx + fx * 4}, 2.1, ${sz + fz * 4})`); // a high lob into the room: a longer flight to sample
  await sleep(200);
  await ev('__ix.act()');
  ok(await until(`(() => { const d = __ix.drawStats(); return !!d && d.thrown > 0; })()`, 3000), 'thrown bottle drawn in flight');
  ok(await until(`(() => { const d = __ix.drawStats(); return !!d && d.thrown === 0; })()`, 5000), 'and gone when it smashed');

  // ---------------- 2b) HUD: icons, chips (soft soles, NV ready), the pouch, a view model
  for (const t of ['nvg', 'soles', 'masterkey', 'lockpick']) await dbg('interaction.give', { type: t });
  for (const [t, n] of [['mat.scrap', 3], ['mat.wiring', 1], ['mat.optics', 2]] as const) await dbg('interaction.give', { type: t, count: n });
  await ev('__ix.slot(2)');
  await ev(`__game.look(${awayYaw}, -0.15)`);
  const chipsOk = await until(`(() => { const s = __ix.status(); return s.some((x) => /SOFT SOLES/.test(x)) && s.some((x) => /NIGHT VISION/.test(x)); })()`, 6000);
  const status = await ev<string[]>('__ix.status()');
  ok(chipsOk, `status chips: ${status.join(' | ')}`);
  await until(`(() => { const q = __ix.pouch(); return q['mat.scrap'] === 3 && q['mat.optics'] === 2; })()`, 4000);
  const pouch = await ev<Record<string, number>>('__ix.pouch()');
  ok(pouch['mat.scrap'] === 3 && pouch['mat.optics'] === 2, `pouch ${JSON.stringify(pouch)}`);
  ok(await until(`!!document.querySelector('[data-testid="ix-pouch"]')`, 4000), 'pouch chips in the HUD');
  await shot('2-hud');

  // ---------------- 3) night vision in the dark (skipped with the flat debug fill)
  if (!flat) {
    await dbg('interaction.setLights', { on: false });
    await ev(`__ix.flashlight(false)`);
    await ev(`__game.look(${awayYaw}, -0.35)`);
    await shot('3a-dark');
    await ev('__ix.nv()');
    ok(await until('__ix.nightVision()', 4000), 'night vision on');
    await sleep(400);
    await shot('3b-nv-on');
    await ev('__ix.nv()');
    ok(await until('!__ix.nightVision()', 4000), 'night vision off');
    await dbg('interaction.setLights', { on: true });
    await ev(`__ix.flashlight(true)`);
  }

  // ---------------- 4) a drawer tapped open, its contents
  await dbg('interaction.stock', { id: c0.id, type: 'page', name: 'hound.1' });
  await ev(`__game.teleport(${sx}, ${sz}, ${yawTo(c0.p[0], c0.p[2])})`);
  await frames(3);
  await ev(`__ix.aim(${c0.p[0]}, ${c0.p[1]}, ${c0.p[2]})`);
  await until(`__ix.target()?.id === ${JSON.stringify(`cont:${c0.id}`)}`, 4000);
  const tgt = await ev<{ id: string; view?: { text: string; sub?: string } } | null>('__ix.target()');
  ok(tgt?.id === `cont:${c0.id}`, `aiming at ${tgt?.id}: "${tgt?.view?.text}" / "${tgt?.view?.sub}"`);
  if (!soft) await shot('4a-drawer-prompt');
  await ev(`__ix.use('cont:${c0.id}')`);
  ok(await until(`(__ix.state().containers?.[${JSON.stringify(c0.id)}]?.open ?? 0) > 0`, 4000), 'container open in the mirrored state');
  ok(await until(`Object.values(__ix.state().items).some((it) => it.type === 'page' && it.name === 'hound.1')`, 4000), 'stocked page in the drawer');
  const slot = (c0.parts.find((q) => q.idx === c0.main) ?? c0.parts[0])!.slot;
  await ev(`__ix.aim(${slot[0]}, ${slot[1]}, ${slot[2]})`);
  await frames(3);
  const pv = await ev<{ view?: { text: string } } | null>('__ix.target()');
  ok(!pv?.view || !/hound\.1/.test(pv.view.text), `the page never shows its id ("${pv?.view?.text ?? ''}")`);
  await camera([sx + (sx - c0.p[0]) * 0.15, 1.45, sz + (sz - c0.p[2]) * 0.15], [slot[0], slot[1], slot[2]]);
  await sleep(400);
  await shot('4b-drawer-open');
  await camera(null);

  // ---------------- 5) another drawer mid-ease (ring + label + the part creeping open)
  const c1 = conts.filter((c) => c.id !== c0.id).sort((a, b) => Math.hypot(a.x - c0.x, a.z - c0.z) - Math.hypot(b.x - c0.x, b.z - c0.z))[0];
  if (c1) {
    const x1 = c1.front[0] + 0.5, z1 = c1.front[1] + 0.5;
    await ev(`__game.teleport(${x1}, ${z1}, ${Math.atan2(c1.p[0] - x1, c1.p[2] - z1)})`);
    await frames(3);
    await ev(`__ix.aim(${c1.p[0]}, ${c1.p[1]}, ${c1.p[2]})`);
    await until(`__ix.target()?.id === ${JSON.stringify(`cont:${c1.id}`)}`, 3000);
    void ev('__ix.easeE(2200)');
    const ringOk = await until(`(() => { const h = __ix.hold(); return h.label === 'Easing it open… (quiet)' && (h.k ?? 0) > 0.25; })()`, 1900);
    const h = await ev<{ k: number | null; label: string | null }>('__ix.hold()');
    ok(ringOk && (h.k ?? 0) < 1, `ease ring ${JSON.stringify(h)}`);
    await shot('5-drawer-ease');
    ok(await until(`(__ix.state().containers?.[${JSON.stringify(c1.id)}]?.open ?? 0) > 0`, 4000), 'eased open');
  }

  // ---------------- 6) a door mid-ease: the ring, the door creeping open
  const ds = L.doors.filter((d) => d.kind === 'door' && !d.initiallyOpen).map((d) => doorSpot(L, 'door', d.id)).find((x) => !!x);
  if (ds) {
    await ev(`__game.teleport(${ds.stand[0]}, ${ds.stand[1]}, 0)`);
    // the teleport lands before we aim (a slow frame after the drawer ease once left the camera at the drawer)
    await until(`(() => { const c = __ix.camera(); return !!c && Math.hypot(c.o[0] - ${ds.stand[0]}, c.o[2] - ${ds.stand[1]}) < 0.35; })()`, 4000);
    await frames(3);
    await ev(`__ix.aim(${ds.look[0]}, 1.1, ${ds.look[2]})`);
    ok(await until(`__ix.target()?.id === ${JSON.stringify(`door:${ds.door.id}`)}`, 4000), `aiming at door ${ds.door.id}`);
    const wasOpen = await ev<boolean>(`!!__ix.state().doors[${ds.door.id}]?.open`);
    void ev('__ix.easeE(2600)');
    const ringOk = await until(`(() => { const h = __ix.hold(); return /Easing it (open|shut)/.test(h.label ?? '') && (h.k ?? 0) > 0.3; })()`, 2300);
    const h = await ev<{ k: number | null; label: string | null }>('__ix.hold()');
    ok(ringOk, `door ease ring ${JSON.stringify(h)}`);
    await shot('6-door-ease');
    ok(await until(`__ix.state().doors[${ds.door.id}]?.open === ${!wasOpen}`, 4000), `door eased ${wasOpen ? 'shut' : 'open'}`);
    const fx2 = await ev<Record<string, number>>('__ix.fx()');
    ok((fx2.doorSoft ?? 0) >= 1, `soft door fx (${JSON.stringify(fx2)})`);
  }

  // ---------------- 7) the death card's creeping tip (the mate keeps the crew alive)
  await dbg('interaction.kill', { killer: 'HOUND', reason: 'heard your FOOTSTEPS (5 m)', detail: 'You walked past it at 3 m.' });
  ok(await until(`!!document.querySelector('[data-testid="ix-death-tip"]')`, 4000), 'death card: "Creeping (C) is silent to the Hound."');
  await shot('7-deathcard');
  const errs = await ev<string[]>('__game.errors()');
  ok(errs.length === 0, `no client errors ${JSON.stringify(errs.slice(0, 4))}`);
  const pe = p.errors.filter((e) => !/http 4\d\d|favicon/.test(e));
  ok(pe.length === 0, `no page errors ${JSON.stringify(pe.slice(0, 4))}`);
} catch (e) {
  console.log('FAIL', e instanceof Error ? (e.stack ?? e.message) : e);
  await screenshot(page, `tests/artifacts/gear-v12/${tag}fail.png`).catch(() => undefined);
  fails++;
} finally {
  mate.close();
  await p.close();
}
console.log(fails ? `FAILED (${fails})` : 'ALL PASS', secs());
process.exit(fails ? 1 : 0);
