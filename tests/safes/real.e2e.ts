// Safes end to end in real Chrome with REAL input (no dbg.safes.open, no ?safes=1: the client module is server-driven).
// Dev server with the safes flag on (or SAFES_FORCE=1 + --dev):
//   PORT=3504 SAFES_FORCE=1 node apps/server/src/index.ts --dev   then   node tests/safes/real.e2e.ts [port]
// find the safe -> crosshair prompt -> pointer lock + E key -> dial opens (pointer released, no pause menu) -> A/D and the
// mouse wheel turn it -> the server's clicks play at each number -> a wrong E = CLUNK (crew fx) -> 3 right numbers ->
// the safe swings open and the bearer bonds are in your hands. Screenshots: tests/artifacts/safes/real-*.png
import { launchPlayer, screenshot, waitForGame } from '../lib/launch.ts';

const port = Number(process.argv[2] ?? process.env.PORT ?? 3504);
const BASE = `http://127.0.0.1:${port}`;
const CREW = `SAFR${Date.now() % 10000}`;
const N = 40;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (cond: unknown, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
  if (!cond) fails++;
};

interface PeekSafe { id: string; x: number; z: number; face: [number, number]; combo: number[]; open: boolean; stage: number }

const p = await launchPlayer({ baseUrl: BASE, crew: CREW, name: 'Cracker', query: { autojoin: '1' } });
const page = p.page;
const ev = <T = unknown>(js: string) => page.evaluate(js) as Promise<T>;
const log = () => ev<string[]>('window.__safes ? window.__safes.log() : []');
const dialOpen = () => ev<boolean>(`!!document.querySelector('[data-testid="safe-dial"]')`);
let pos = 0;
/** turn the dial to `to` with A/D (or the wheel), shortest way round, like a player would */
const turnTo = async (to: number, wheel = false) => {
  let d = ((to - pos) % N + N) % N;
  if (d > N / 2) d -= N;
  for (let i = 0; i < Math.abs(d); i++) {
    if (wheel) await page.mouse.wheel(0, d > 0 ? 100 : -100);
    else await page.keyboard.press(d > 0 ? 'KeyD' : 'KeyA');
    await sleep(45);
  }
  pos = to;
  await sleep(260); // let the ~10 Hz dial stream deliver the last position
};
try {
  await page.routeWebSocket(/token=/, () => {});
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForGame(page, 60_000);
  await page.waitForFunction(() => !!(window as unknown as { __game?: { me(): string | null } }).__game?.me(), undefined, { timeout: 15_000 });
  await ev(`__game.dbg('level.generate', { seed: 'safes-test-1', players: 1 })`);
  await sleep(3000);
  const peek = await ev<{ safes: PeekSafe[] }>(`__game.dbg('safes.peek')`);
  ok(peek.safes.length >= 1, `server placed ${peek.safes.length} safe(s)`);
  const s = peek.safes[0]!;
  ok(await ev<boolean>(`!!window.__safes && window.__safes.count() >= 1`), 'client draws the safe props without ?safes=1 (server-driven)');
  // stand 1.2 m in front of it and look at the dial, as a player walking up would
  const fx = s.x + s.face[0] * 1.2, fz = s.z + s.face[1] * 1.2;
  await ev(`__game.teleport(${fx}, ${fz}, ${Math.atan2(-s.face[0], -s.face[1])})`);
  await sleep(800);
  // a player looks around with the pointer locked (look overrides are ignored before the first lock): click first
  await page.mouse.click(640, 360);
  await sleep(400);
  await ev(`__ix.aim(${s.x}, 0.85, ${s.z})`);
  // the GPU is shared with other sessions: frames can be slow, so poll for the crosshair target
  let tgt: { id: string; view?: { text: string; key: string | null } } | null = null;
  for (let i = 0; i < 30 && tgt?.id !== s.id; i++) {
    await sleep(100);
    tgt = await ev<{ id: string; view?: { text: string; key: string | null } } | null>(`__ix.target()`);
  }
  ok(tgt?.id === s.id, `crosshair targets the safe (${tgt?.id} "${tgt?.view?.text ?? ''}" key ${tgt?.view?.key ?? '-'})`);
  console.log('shot', await screenshot(page, 'tests/artifacts/safes/real-1-prompt.png'));
  // real input: pointer lock (already taken above), then the E key
  if (!(await ev<boolean>('!!document.pointerLockElement'))) { await page.mouse.click(640, 360); await sleep(400); }
  const locked = await ev<boolean>('!!document.pointerLockElement');
  console.log(`pointer lock before E: ${locked}`);
  await ev(`__ix.aim(${s.x}, 0.85, ${s.z})`);
  await sleep(300);
  await page.keyboard.down('KeyE');
  await sleep(90);
  await page.keyboard.up('KeyE');
  await page.waitForSelector('[data-testid="safe-dial"]', { timeout: 4000 }).catch(() => null);
  ok(await dialOpen(), 'E opens the safe dial');
  await sleep(500);
  const scr = await ev<string>('__game.state ? (window.__game.state().screen ?? "") : ""').catch(() => '');
  ok(!(await ev<boolean>('!!document.pointerLockElement')), 'pointer lock released for the dial');
  ok(await dialOpen(), `dial still open after the pointer-lock change (no pause menu) ${scr}`);
  console.log('shot', await screenshot(page, 'tests/artifacts/safes/real-2-dial.png'));
  // number 1 with D/A: the click plays when crossing it
  await ev('window.__safes.clearLog()');
  await turnTo(s.combo[0]!);
  let l = await log();
  ok(l.some((x) => x.startsWith('click')), `heard the click at the first number (${l.filter((x) => x.startsWith('click')).join(',')}; ${l.filter((x) => x === 'tick').length} ticks)`);
  await page.keyboard.press('KeyE');
  await sleep(500);
  l = await log();
  ok(l.includes('ok'), 'first number holds');
  console.log('shot', await screenshot(page, 'tests/artifacts/safes/real-3-first.png'));
  // a wrong number: CLUNK, reset
  await turnTo((s.combo[1]! + 7) % N);
  await page.keyboard.press('KeyE');
  await sleep(700);
  l = await log();
  const msg = await ev<string>(`document.querySelector('[data-testid="safe-dial"]')?.textContent ?? ''`);
  ok(l.includes('clunk') && /CLUNK/.test(msg), `wrong number = clunk (${l.slice(-3).join(',')})`);
  console.log('shot', await screenshot(page, 'tests/artifacts/safes/real-4-clunk.png'));
  // all three, number 2 with the mouse wheel
  await ev('window.__safes.clearLog()');
  for (let i = 0; i < 3; i++) {
    await turnTo(s.combo[i]!, i === 1);
    await page.keyboard.press('KeyE');
    await sleep(600);
  }
  l = await log();
  ok(l.filter((x) => x === 'ok').length >= 2 && l.includes('open'), `three numbers open it (${l.filter((x) => x !== 'tick').join(',')})`);
  console.log('shot', await screenshot(page, 'tests/artifacts/safes/real-5-open.png'));
  await sleep(1800);
  ok(!(await dialOpen()), 'dial closes itself after the safe opens');
  const inv = await ev<{ type: string; name?: string; value?: number }[]>(`(() => { const st = __ix.state(); const me = __game.me(); return (st.inventories[me] || []).filter(Boolean).map((id) => st.items[id]); })()`);
  const bonds = inv.find((it) => it?.name === 'Company bearer bonds');
  ok(!!bonds && (bonds.value ?? 0) >= 120, `reward in your hands (${JSON.stringify(bonds)})`);
  await ev(`__ix.aim(${s.x}, 0.85, ${s.z})`);
  await sleep(400);
  console.log('shot', await screenshot(page, 'tests/artifacts/safes/real-6-after.png'));
  const t2 = await ev<{ view?: { text: string; enabled: boolean } } | null>(`__ix.target()`);
  ok(t2?.view && t2.view.enabled === false, `opened safe reads empty ("${t2?.view?.text ?? ''}")`);
  const errs = await ev<string[]>(`__game.errors()`);
  ok(errs.length === 0, `no client errors ${JSON.stringify(errs.slice(0, 4))}`);
} catch (e) {
  console.log('FAIL', e instanceof Error ? e.message : e);
  await screenshot(page, 'tests/artifacts/safes/real-fail.png').catch(() => undefined);
  fails++;
} finally {
  await p.close();
}
console.log(fails ? `FAILED (${fails})` : 'ALL PASS');
process.exit(fails ? 1 : 0);
