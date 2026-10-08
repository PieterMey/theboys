// players-stealth (v1.2) browser e2e, one player, on the SwiftShader lane (tools/gpu-guard.mjs sets DEADAIR_RENDER):
//   - the stance HUD (bottom-left): WALKING 5 m, SPRINTING 12 m, CROUCHED via the desktop app's Left-Ctrl bridge
//     (a fake window.deadAirDesktop.onHotkey, exactly what the shell's preload exposes)
//   - settings().ctrlCrouch defaults on when the bridge exists
//   - setFlashlightEnabled ref-counted per reason (a knockdown ending never relights a dead battery)
//   - setMirrorSelf: meshes only on RENDER_LAYERS.self (13), no shadows, no nameplate; false removes it
//   - a stealth hint, and the crawl-vent duct view (CrawlHud, frozen, out at the twin grate)
//   - the toggled crouch latch resets on a phase change
// Screenshots: tests/artifacts/stealth/hud_*.png. Needs a --dev server (Vite middleware) on PORT (default 3801):
//   node tools/gpu-guard.mjs --max-sec 120 --label g1 -- node tests/stealth/hud.e2e.ts
import { launchPlayer, screenshot, waitForGame } from '../lib/launch.ts';

const PORT = Number(process.env.PORT ?? 3801);
if (PORT === 3000) throw new Error('never on the live port 3000');
const BASE = process.env.BASE_URL ?? `http://127.0.0.1:${PORT}`;
const OUT = 'tests/artifacts/stealth';
const tail = Date.now().toString(36).slice(-3).toUpperCase().replace(/[^BCDFGHJKLMNPQRSTVWXZ]/g, 'K');
const CREW = `HUD${tail}`.slice(0, 6);
const t0 = Date.now();
const lap = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${m}`);

interface HudRead { mode: string | null; radius: string | null; text: string; visible: boolean }
interface PairInfo { a: { id: string; front: [number, number]; yaw: number }; b: { id: string; front: [number, number]; yaw: number }; zones: [number, number]; open: boolean }
interface Vents { pairs: PairInfo[]; lockDoor: number; lockDoorSides: { x: number; z: number; zone: number }[] }

const results: Record<string, unknown> = {};
let failed = false;
const check = (cond: unknown, msg: string) => {
  if (!cond) { failed = true; console.log(`FAIL: ${msg}`); } else console.log(`ok: ${msg}`);
};

const p = await launchPlayer({ name: 'Creeper', baseUrl: BASE, crew: CREW, query: { autojoin: '1', nobright: '1' } });
const page = p.page;
try {
  // the desktop shell's preload bridge (apps/desktop/src/preload.cjs onHotkey), faked before the game boots
  await page.addInitScript(() => {
    const subs: ((ev: { action: string; down: boolean }) => void)[] = [];
    (window as unknown as Record<string, unknown>).deadAirDesktop = {
      onHotkey(cb: (ev: { action: string; down: boolean }) => void) { subs.push(cb); return () => { subs.splice(subs.indexOf(cb), 1); }; },
    };
    (window as unknown as Record<string, unknown>).__hk = (down: boolean) => { for (const f of subs) f({ action: 'crouch', down }); };
  });
  await page.routeWebSocket((u) => !u.pathname.endsWith('/ws'), () => { /* mute Vite HMR: other builders edit all night */ });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForGame(page, 70_000);
  await page.waitForFunction(() => !!window.__game?.me() && !!window.__players, undefined, { timeout: 30_000 });
  lap('booted');
  const dbg = (r: string, a: unknown = {}) => page.evaluate(([r, a]) => window.__game!.dbg(r as string, a), [r, a] as const);
  await dbg('players.testLevel', { seed: 'vents-e2e-1', players: 2, risk: 1 });
  await page.waitForFunction(() => (window.__game!.state() as { phase: string; layout: unknown }).phase === 'contract' && !!(window.__game!.state() as { layout: unknown }).layout, undefined, { timeout: 20_000 });
  await dbg('monsters.freeze', { on: true }).catch(() => null);
  await dbg('net.validate', { on: false }).catch(() => null);
  await page.waitForTimeout(2500); // spawn lock + arrival screen
  lap('contract');

  const hud = (): Promise<HudRead> => page.evaluate(() => {
    const el = document.querySelector('[data-testid="stance-hud"]') as HTMLElement | null;
    return { mode: el?.dataset.mode ?? null, radius: el?.dataset.radius ?? null, text: el?.innerText.replace(/\s+/g, ' ').trim() ?? '', visible: !!el && el.offsetParent !== null };
  });
  // the longest wall- and prop-free run along +X inside a closed space: walk it from its first cell
  const lane = await page.evaluate(() => window.__players!.lane());
  results.lane = lane;
  check(lane && lane.len >= 5, `a walk lane (${JSON.stringify(lane)})`);
  const lx = lane?.x ?? 0, lz = lane?.z ?? 0;
  const goLane = async () => {
    await page.evaluate(([x, z]) => { window.__game!.teleport(x, z, Math.PI / 2); window.__game!.look(Math.PI / 2, -0.05); }, [lx, lz] as const);
    await page.waitForTimeout(250);
  };

  // ---- walking ----
  await goLane();
  await page.evaluate(() => window.__game!.setInput({ forward: 1 }));
  await page.waitForTimeout(550);
  const walk = await hud();
  await screenshot(page, `${OUT}/hud_walk.png`);
  await page.evaluate(() => window.__game!.setInput({ forward: 0 }));
  results.walk = walk;
  check(walk.mode === 'walk' && /WALKING/.test(walk.text), `walking HUD (${JSON.stringify(walk)})`);

  // ---- sprinting ----
  await goLane();
  await page.evaluate(() => window.__game!.setInput({ forward: 1, sprint: true }));
  await page.waitForTimeout(500);
  const sprint = await hud();
  await screenshot(page, `${OUT}/hud_sprint.png`);
  await page.evaluate(() => window.__game!.setInput({ forward: 0, sprint: false }));
  results.sprint = sprint;
  check(sprint.mode === 'sprint' && /SPRINTING/.test(sprint.text), `sprinting HUD (${JSON.stringify(sprint)})`);

  // ---- still: hidden ----
  await page.waitForTimeout(500);
  const still = await hud();
  check(!still.visible || still.mode === null || still.mode === '', `the stance HUD hides when standing still (${JSON.stringify(still)})`);

  // ---- crouch through the desktop bridge (held mode) ----
  const sv0 = await page.evaluate(() => ({ ctrl: window.__players!.svc().settings().ctrlCrouch, stealth: window.__players!.stealth() }));
  check(sv0.ctrl === true && sv0.stealth.ctrlCrouch === true, `ctrlCrouch defaults on with the desktop bridge (${JSON.stringify(sv0.ctrl)})`);
  await goLane();
  await page.evaluate(() => { (window as unknown as { __hk(d: boolean): void }).__hk(true); window.__game!.setInput({ forward: 1 }); });
  await page.waitForTimeout(700);
  const crouch = await hud();
  const crouchLocal = await page.evaluate(() => window.__players!.local());
  await screenshot(page, `${OUT}/hud_crouch.png`);
  await page.evaluate(() => { window.__game!.setInput({ forward: 0 }); (window as unknown as { __hk(d: boolean): void }).__hk(false); });
  results.crouch = { hud: crouch, stance: crouchLocal.stance, eye: crouchLocal.eye };
  check(crouch.mode === 'crouch' && /CROUCHED/.test(crouch.text) && crouchLocal.stance === 1, `Left Ctrl (desktop hotkey) crouches: ${JSON.stringify(crouch)} stance ${crouchLocal.stance}`);
  await page.waitForTimeout(300);
  const released = await page.evaluate(() => window.__players!.local().stance);
  check(released !== 1, `hotkey release stands up (stance ${released})`);
  lap('stance HUD');

  // ---- flashlight ref-count ----
  const fl = await page.evaluate(async () => {
    const s = window.__players!.svc();
    const on = () => window.__players!.flashlights().find((f) => f.local)?.on ?? null;
    s.setFlashlight(true);
    const a = on();
    s.setFlashlightEnabled(false, 'battery');
    s.setFlashlightEnabled(false, 'knockdown');
    s.setFlashlightEnabled(true, 'knockdown'); // the knockdown ends: the battery is still dead
    const b = { on: on(), off: window.__players!.stealth().lightOff };
    s.setFlashlight(true);
    const c = on();
    s.setFlashlightEnabled(true, 'battery');
    s.setFlashlight(true);
    return { start: a, afterKnockdown: b, retry: c, end: on(), off: window.__players!.stealth().lightOff };
  });
  results.flashlight = fl;
  check(fl.afterKnockdown.on === false && fl.retry === false && fl.afterKnockdown.off.join() === 'battery' && fl.end === true && fl.off.length === 0, `flashlight ref-count per reason (${JSON.stringify(fl)})`);

  // ---- mirror self ----
  await page.waitForFunction(() => window.__players!.rigReady(), undefined, { timeout: 15_000 }).catch(() => null);
  const ms = await page.evaluate(() => {
    const root = window.__players!.svc().setMirrorSelf!(true);
    return { root: !!root, info: window.__players!.mirrorSelf() };
  });
  await page.waitForTimeout(200);
  const ms2 = await page.evaluate(() => window.__players!.mirrorSelf());
  const msOff = await page.evaluate(() => { window.__players!.svc().setMirrorSelf!(false); return window.__players!.mirrorSelf(); });
  results.mirrorSelf = { on: ms, later: ms2, off: msOff };
  const info = ms2 ?? ms.info;
  check(ms.root && info && info.layers.length === 1 && info.layers[0] === 13 && !info.castShadow && !info.nameplate && info.meshes > 0, `mirror self only on layer 13, no shadows, no nameplate (${JSON.stringify(info)})`);
  check(msOff === null, 'setMirrorSelf(false) removes it');

  // ---- a stealth hint ----
  await page.evaluate(() => window.__players!.showHint('spotted'));
  await page.waitForTimeout(450);
  const hint = await page.evaluate(() => window.__players!.stealth().hint);
  await screenshot(page, `${OUT}/hud_hint.png`);
  check(hint === 'spotted', `hint shown (${hint})`);
  lap('flashlight, mirror, hint');

  // ---- crawl vent: the duct view ----
  let v = (await dbg('players.vents')) as Vents;
  let pair = v.pairs.find((x) => x.open);
  if (!pair && v.lockDoor >= 0 && v.lockDoorSides.length) {
    const side0 = v.lockDoorSides.find((s) => s.zone === 0) ?? v.lockDoorSides[0];
    await dbg('interaction.give', { type: 'keycard', lock: 1 }).catch(() => null);
    await page.evaluate(([x, z]) => window.__game!.teleport(x, z), [side0.x, side0.z] as const);
    await page.waitForTimeout(500);
    const u = await page.evaluate((id) => window.__game!.req!('interaction.use', { id }).catch((e: Error) => ({ ok: false, msg: e.message })), `door:${v.lockDoor}`);
    results.keycard = u;
    await page.waitForTimeout(200);
    v = (await dbg('players.vents')) as Vents;
    pair = v.pairs.find((x) => x.open);
  }
  check(!!pair, 'a crawlable vent pair');
  if (pair) {
    const from = pair.zones[0] <= pair.zones[1] ? pair.a : pair.b;
    const to = from === pair.a ? pair.b : pair.a;
    await page.evaluate(([x, z, yaw]) => window.__game!.teleport(x, z, yaw), [from.front[0], from.front[1], from.yaw + Math.PI] as const);
    await page.evaluate(() => (window as unknown as { __hk(d: boolean): void }).__hk(true));
    await page.waitForTimeout(800);
    const r = await dbg('players.crawl', { vent: from.id });
    await page.evaluate(() => (window as unknown as { __hk(d: boolean): void }).__hk(false));
    await page.waitForTimeout(1300);
    const mid = await page.evaluate(() => ({ crawling: window.__players!.stealth().crawling, hud: !!document.querySelector('[data-testid="crawl-hud"]'), p: window.__players!.local().p }));
    await screenshot(page, `${OUT}/hud_crawl.png`);
    await page.waitForFunction(() => !window.__players!.stealth().crawling, undefined, { timeout: 9000 }).catch(() => null);
    await page.waitForTimeout(400);
    const end = await page.evaluate(() => ({ crawling: window.__players!.stealth().crawling, hud: !!document.querySelector('[data-testid="crawl-hud"]'), p: window.__players!.local().p }));
    const dEnd = Math.hypot(end.p[0] - to.front[0], end.p[2] - to.front[1]);
    results.crawl = { start: r, from: from.id, to: to.id, mid, end, dEndM: Math.round(dEnd * 100) / 100 };
    check((r as { ok?: boolean })?.ok === true, `crawl started (${JSON.stringify(r)})`);
    check(mid.crawling && mid.hud, `in the duct: frozen camera + CrawlHud (${JSON.stringify(mid)})`);
    check(!end.crawling && !end.hud && dEnd < 1.2, `out at the twin grate (${dEnd.toFixed(2)} m from its front)`);
    await screenshot(page, `${OUT}/hud_crawl_exit.png`);
  }
  lap('crawl');

  // ---- toggled crouch latch resets on a phase change ----
  const latch = await page.evaluate(async () => {
    const s = window.__players!.svc();
    s.setSettings({ crouchToggle: true });
    (window as unknown as { __hk(d: boolean): void }).__hk(true);
    (window as unknown as { __hk(d: boolean): void }).__hk(false);
    const before = window.__players!.stealth().latched;
    await window.__game!.dbg('players.testLevel', { hub: true });
    const t = performance.now();
    while (performance.now() - t < 6000 && (window.__game!.state() as { phase: string }).phase !== 'hub') await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 300));
    const after = window.__players!.stealth().latched;
    s.setSettings({ crouchToggle: false });
    return { before, after, phase: (window.__game!.state() as { phase: string }).phase };
  });
  results.latch = latch;
  check(latch.before === true && latch.after === false, `the toggled crouch resets on a phase change (${JSON.stringify(latch)})`);

  const errs = await page.evaluate(() => window.__game!.errors());
  results.errors = { game: errs.slice(0, 8), page: p.errors.filter((e) => !/favicon|404/.test(e)).slice(0, 8) };
  lap('done');
} catch (e) {
  failed = true;
  console.log(`ERROR: ${e instanceof Error ? e.stack : e}`);
  await screenshot(page, `${OUT}/hud_error.png`).catch(() => null);
} finally {
  console.log(JSON.stringify(results, null, 1));
  await p.close();
}
console.log(failed ? 'FAIL stealth/hud' : 'PASS stealth/hud');
process.exit(failed ? 1 : 0);
