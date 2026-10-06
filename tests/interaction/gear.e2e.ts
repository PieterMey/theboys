// v1.1 gear pack in real Chrome (real pointer lock + LMB): Pro Flashlight, Flares, Motion sensor (+ van console blips),
// Adrenaline syringe, Lucky charm, Cursed idol, special-find placement. Dev server (--dev) on its own port:
//   PORT=3504 node apps/server/src/index.ts --dev   then   node tests/interaction/gear.e2e.ts [port]
// Screenshots: tests/artifacts/gear/*.png (look at them).
import { launchPlayer, screenshot, waitForGame } from '../lib/launch.ts';
import { Bot } from './bot.ts';

const port = Number(process.argv[2] ?? process.env.PORT ?? 3504);
const BASE = `http://127.0.0.1:${port}`;
const CREW = `GEAR${Date.now() % 10000}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (cond: unknown, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
  if (!cond) fails++;
};
type V3 = [number, number, number];
interface Item { id: string; type: string; count?: number; value?: number; where: string; p?: V3; armed?: boolean; bonus?: number; name?: string }
interface IxState { items: Record<string, Item>; inventories: Record<string, (string | null)[]>; flares?: Record<string, { p: V3; until: number }>; ints: Record<string, { id: string; kind: string; p: V3 }> }
interface Layout { W: number; H: number; owner: number[]; spaces: { id: number; kind: string; dist: number; rect: { x: number; y: number; w: number; h: number } }[]; items: { id: string; kind: string; x: number; z: number; space: number }[]; van: { x: number; z: number; cab: { x: number; y: number; w: number; h: number } } }

const p = await launchPlayer({ baseUrl: BASE, crew: CREW, name: 'Ann', query: { autojoin: '1' } });
const page = p.page;
const ev = <T = unknown>(js: string) => page.evaluate(js) as Promise<T>;
const ix = () => ev<IxState>('__ix.state()');
const me = () => ev<string>('__game.me()');
const inv = async (): Promise<Item[]> => {
  const st = await ix();
  const id = await me();
  return (st.inventories[id] ?? []).map((x) => (x ? st.items[x] : null)).filter((x): x is Item => !!x);
};
const selectType = async (type: string) => {
  const st = await ix();
  const slots = st.inventories[await me()] ?? [];
  const i = slots.findIndex((x) => !!x && st.items[x]?.type === type);
  if (i >= 0) { await ev(`__ix.slot(${i})`); await sleep(250); }
  return i;
};
const lmb = async () => {
  if (!(await ev<boolean>('!!document.pointerLockElement'))) { await page.mouse.click(640, 360); await sleep(350); }
  await page.mouse.down();
  await sleep(60);
  await page.mouse.up();
};
const give = (type: string, extra = '') => ev(`__game.dbg('interaction.give', { type: '${type}'${extra} })`);
const shot = async (name: string) => console.log('shot', await screenshot(page, `tests/artifacts/gear/${name}.png`));

const bot = new Bot('Bob');
try {
  await page.routeWebSocket(/token=/, () => {});
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForGame(page, 60_000);
  await page.waitForFunction(() => !!(window as unknown as { __game?: { me(): string | null } }).__game?.me(), undefined, { timeout: 15_000 });
  await ev(`__game.dbg('level.generate', { seed: 'gear-test-2', players: 2 })`);
  await sleep(3000);
  await bot.connect(`ws://127.0.0.1:${port}/ws`, CREW);
  await bot.settle(600);
  const L = await ev<Layout>('__ix.layout()');
  ok(L && L.items.length > 0, 'contract layout loaded');
  await ev(`__game.dbg('monsters.freeze', { on: true })`).catch(() => undefined);

  // a dark room spot: the deepest room's centre, lights off
  const deep = [...L.spaces].filter((s) => s.kind === 'room' && s.rect.w >= 4 && s.rect.h >= 4).sort((a, b) => b.dist - a.dist)[0]!;
  const cx = deep.rect.x + deep.rect.w / 2, cz = deep.rect.y + deep.rect.h / 2;
  await ev(`__game.dbg('interaction.setLights', { on: false })`);
  await ev(`__game.teleport(${deep.rect.x + 1}, ${cz}, ${Math.PI / 2})`);
  await sleep(900);
  await ev(`__game.look(${Math.PI / 2}, -0.12)`);
  await sleep(800);

  // ---------------- Pro Flashlight
  ok((await ev<number>('__ix.tier()')) === 1, 'standard flashlight = tier 1');
  await shot('1-flashlight-tier1');
  await give('pro-flashlight');
  await sleep(500);
  const hasPro = (await inv()).some((it) => it.type === 'flashlight_pro');
  ok(hasPro, 'shop pack "pro-flashlight" becomes a Pro Flashlight item');
  ok((await ev<number>('__ix.tier()')) === 2, 'carrying it = tier 2 beam (players.flashlights)');
  const fl = await ev<{ tier: number; battery?: number }[]>('window.__players ? window.__players.flashlights() : []');
  ok(fl[0]?.tier === 2 && typeof fl[0]?.battery === 'number', `render gets tier ${fl[0]?.tier} + battery ${fl[0]?.battery}`);
  ok((await ev<string[]>('__ix.status()')).some((t) => /PRO FLASHLIGHT/.test(t)), 'status chip: PRO FLASHLIGHT');
  await sleep(400);
  await shot('2-flashlight-tier2');

  // ---------------- Flares
  await give('flares');
  await give('flares');
  await sleep(400);
  const flares = (await inv()).filter((it) => it.type === 'flare');
  ok(flares.length === 1 && flares[0]!.count === 6, `two flare packs merge into one slot (${flares.map((f) => f.count).join(',')})`);
  await selectType('flare');
  await ev(`__ix.flashlight(false)`);
  await ev(`__game.look(${Math.PI / 2}, -0.25)`);
  await sleep(300);
  await lmb();
  await sleep(1800);
  let st = await ix();
  const fls = Object.values(st.flares ?? {});
  ok(fls.length === 1, `LMB threw a flare that burns on the floor (${JSON.stringify(fls[0]?.p)})`);
  ok((await inv()).find((it) => it.type === 'flare')?.count === 5, 'one flare used');
  if (fls[0]) {
    // 1.5 m from the flare towards where it was thrown from (same room), and a point 9 m away (not lit)
    const lp = await ev<{ p: V3 }>('window.__players.local()');
    const dx = lp.p[0] - fls[0].p[0], dz = lp.p[2] - fls[0].p[2], dl = Math.hypot(dx, dz) || 1;
    const lit = await ev<{ lit: boolean }>(`__game.dbg('interaction.litAt', { x: ${fls[0].p[0] + (dx / dl) * 1.5}, z: ${fls[0].p[2] + (dz / dl) * 1.5} })`);
    ok(lit.lit, 'litAt: 1.5 m from a burning flare is lit (lights off, flashlight off) -> Mannequin rule');
    const far = await ev<{ lit: boolean }>(`__game.dbg('interaction.litAt', { x: ${fls[0].p[0] + (dx / dl) * 9}, z: ${fls[0].p[2] + (dz / dl) * 9} })`);
    ok(!far.lit, 'litAt: 9 m away is not lit by the flare');
    const left = (fls[0].until - (await ev<number>('Date.now()'))) / 1000;
    ok(left > 50 && left <= 61, `burns ~60 s (${left.toFixed(1)} s left)`);
  }
  if (fls[0]) {
    // step back and look at it
    const lp = await ev<{ p: V3 }>('window.__players.local()');
    const yaw = Math.atan2(fls[0].p[0] - lp.p[0], fls[0].p[2] - lp.p[2]);
    await ev(`__game.look(${yaw}, -0.32)`);
  }
  await sleep(700);
  await shot('3-flare-dark-room');

  // ---------------- Adrenaline syringe (baseline sprint first)
  await ev(`__game.look(${-Math.PI / 2}, 0)`);
  await ev(`__game.teleport(${deep.rect.x + deep.rect.w - 1}, ${cz}, ${-Math.PI / 2})`);
  await sleep(500);
  const sprintCircle = async (ms: number) => {
    await ev(`__game.setInput({ forward: 1, sprint: true })`);
    let yaw = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { yaw += 0.22; await ev(`__game.look(${yaw}, 0)`); await sleep(50); }
    await ev(`__game.setInput({ forward: 0, sprint: false })`);
    return ev<number>('window.__players.local().stamina');
  };
  await ev(`__game.teleport(${cx}, ${cz}, 0)`);
  await sleep(400);
  const base = await sprintCircle(3000);
  ok(base < 0.9, `baseline: 2.5 s of sprint drains stamina (${base.toFixed(2)})`);
  await give('syringe');
  await sleep(300);
  await selectType('syringe');
  await lmb();
  await sleep(500);
  ok((await ev<string[]>('__ix.status()')).some((t) => /ADRENALINE/.test(t)), 'status chip: ADRENALINE countdown');
  await shot('4-adrenaline-hud');
  ok(!(await inv()).some((it) => it.type === 'syringe'), 'syringe used up');
  await ev(`__game.teleport(${cx}, ${cz}, 0)`);
  await sleep(300);
  const boosted = await sprintCircle(3000);
  ok(boosted > 0.99, `with adrenaline 3 s of sprint costs nothing (${boosted.toFixed(2)})`);

  // ---------------- Motion sensor + van console
  await give('motion-sensors');
  await sleep(300);
  ok((await inv()).find((it) => it.type === 'sensor')?.count === 2, 'motion sensors x2');
  await ev(`__game.teleport(${cx}, ${cz}, 0)`);
  await sleep(500);
  await selectType('sensor');
  await lmb();
  await sleep(600);
  st = await ix();
  const armed = Object.values(st.items).find((it) => it.type === 'sensor' && it.armed && it.where === 'world');
  ok(!!armed, `LMB placed an armed sensor (${JSON.stringify(armed?.p)})`);
  ok((await inv()).find((it) => it.type === 'sensor')?.count === 1, 'one sensor left in the stack');
  if (armed?.p) {
    await ev(`__ix.aim(${armed.p[0]}, 0.05, ${armed.p[2]})`);
    await sleep(500);
    const t = await ev<{ view?: { text: string } } | null>('__ix.target()');
    ok(/Motion sensor \(armed\)/.test(t?.view?.text ?? ''), `armed sensor prompt ("${t?.view?.text ?? ''}")`);
    await ev(`__ix.flashlight(true)`);
    await sleep(300);
    await shot('5-sensor-placed');
  }
  // operator at the van console; Bob walks past the sensor
  const con = L.items.find((i) => i.kind === 'console');
  if (con && armed?.p) {
    await ev(`__game.teleport(${con.x}, ${con.z - 0.8}, 0)`);
    await sleep(700);
    const consoleId = (await ix()).ints[con.id] ? con.id : Object.values((await ix()).ints).find((i) => i.kind === 'console')?.id;
    await ev(`__ix.use('${consoleId}')`);
    await sleep(800);
    let t0 = Date.now();
    let k = 0;
    while (Date.now() - t0 < 2500) {
      bot.pose(armed.p[0] + 3 + Math.sin(k / 5) * 1.5, armed.p[2] + Math.cos(k / 7), k / 10, 0, 0);
      k++;
      await sleep(100);
    }
    await shot('6-console-motion');
    const onConsole = await ev<string>('document.body.innerText.slice(0, 200)');
    console.log('console text:', onConsole.replace(/\s+/g, ' ').slice(0, 120));
    await page.keyboard.press('Escape');
    await sleep(400);
    t0 = Date.now();
    void t0;
  } else ok(false, 'no van console in the layout');

  // ---------------- Lucky charm at the deposit (free the hands first: 4 slots)
  for (const t of ['flare', 'sensor']) { if ((await selectType(t)) >= 0) { await ev('__ix.drop()'); await sleep(300); } }
  await give('charm');
  await give('loot.small', ', value: 50, name: "Brass key ring"');
  await sleep(400);
  ok((await ev<string[]>('__ix.status()')).some((t) => /LUCKY CHARM/.test(t)), 'status chip: LUCKY CHARM');
  st = await ix();
  const dep = Object.values(st.ints).find((i) => i.kind === 'deposit');
  if (dep) {
    await ev(`__game.teleport(${dep.p[0]}, ${dep.p[2] + 0.6}, ${Math.PI})`);
    await sleep(700);
    const r = await ev<{ ok: boolean; msg?: string }>(`__ix.use('${dep.id}')`);
    await sleep(400);
    st = await ix();
    const ring = Object.values(st.items).find((it) => it.name === 'Brass key ring');
    ok(ring?.where === 'van' && ring.value === 55 && ring.bonus === 5, `deposit with the charm: $50 -> $${ring?.value} (${JSON.stringify(r)})`);
  } else ok(false, 'no deposit interactable');

  // ---------------- Cursed idol: whispers, the Hound comes
  if ((await selectType('charm')) >= 0) { await ev('__ix.drop()'); await sleep(300); }
  await give('loot.idol', ', value: 420, name: "Cursed idol"');
  await sleep(300);
  const idol = (await inv()).find((it) => it.type === 'loot.idol');
  ok(!!idol && idol.value === 420, `cursed idol held ($${idol?.value})`);
  ok((await ev<string[]>('__ix.status()')).some((t) => /CURSED IDOL/.test(t)), 'status chip: CURSED IDOL');
  await ev(`__game.teleport(${cx}, ${cz}, 0)`);
  await ev(`__game.dbg('monsters.freeze', { on: false })`).catch(() => undefined);
  await ev(`__game.dbg('monsters.place', { id: 'hound', x: ${cx + Math.min(1.6, deep.rect.w / 2 - 0.6)}, z: ${cz + Math.min(1.2, deep.rect.h / 2 - 0.6)}, state: 'idle', active: true })`).catch(() => undefined);
  const fx0 = (await ev<Record<string, number>>('__ix.fx()')).whisper ?? 0;
  await sleep(10500);
  const fx1 = (await ev<Record<string, number>>('__ix.fx()')).whisper ?? 0;
  ok(fx1 > fx0, `the idol whispered ${fx1 - fx0}x in 10 s`);
  const ms = await ev<{ agents?: { kind: string; state: string; lastNoiseKind?: string; tx?: number; tz?: number }[] }>(`__game.dbg('monsters.state')`).catch(() => ({ agents: [] }));
  const hound = ms.agents?.find((a) => a.kind === 'hound');
  console.log('hound after the whispers:', JSON.stringify(hound));
  ok(!!hound && /^idol/.test(hound.lastNoiseKind ?? ''), `the Hound heard the idol and came to look (${hound?.lastNoiseKind}, target ${hound?.tx},${hound?.tz}, now ${hound?.state})`);
  await shot('7-idol-hud');

  // ---------------- special finds: rare, deep rooms only (server placement across seeds)
  let finds = 0, deepOk = 0;
  const found: Record<string, number> = {};
  for (let i = 0; i < 8; i++) {
    await bot.dbg('level.generate', { seed: `finds-${i}`, players: 2 });
    await bot.settle(2200);
    const s2 = await bot.dbg<{ items: Record<string, Item> }>('interaction.state');
    const L2 = bot.full?.layout as unknown as Layout | undefined;
    for (const it of Object.values(s2.items)) {
      if (!['syringe', 'charm', 'loot.idol'].includes(it.type) || !it.p || !L2) continue;
      finds++;
      found[it.type] = (found[it.type] ?? 0) + 1;
      const sp = L2.spaces[L2.owner[Math.floor(it.p[2]) * L2.W + Math.floor(it.p[0])]!];
      const maxD = Math.max(...L2.spaces.map((x) => x.dist));
      if (sp && sp.dist >= maxD * 0.6 - 1e-6) deepOk++;
    }
  }
  ok(finds >= 3 && deepOk === finds, `special finds over 8 seeds: ${JSON.stringify(found)} (all ${deepOk}/${finds} in deep rooms)`);
  const errs = await ev<string[]>('__game.errors()');
  ok(errs.length === 0, `no client errors ${JSON.stringify(errs.slice(0, 4))}`);
  const pe = p.errors.filter((e) => !/http 4\d\d|favicon/.test(e));
  ok(pe.length === 0, `no page errors ${JSON.stringify(pe.slice(0, 4))}`);
} catch (e) {
  console.log('FAIL', e instanceof Error ? (e.stack ?? e.message) : e);
  await screenshot(page, 'tests/artifacts/gear/fail.png').catch(() => undefined);
  fails++;
} finally {
  bot.close();
  await p.close();
}
console.log(fails ? `FAILED (${fails})` : 'ALL PASS');
process.exit(fails ? 1 : 0);
