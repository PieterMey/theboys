// Safes visual check: one browser on a dev server with safes on (SAFES_FORCE=1 --dev), contract via dbg.level.generate,
// walk up to the safe, press E (test input), turn the dial, screenshot. node tests/safes/dial.e2e.ts [port]
import { launchPlayer, screenshot, waitForGame } from '../lib/launch.ts';

const port = Number(process.argv[2] ?? process.env.PORT ?? 3407);
const BASE = `http://127.0.0.1:${port}`;
const CREW = `SAFV${Date.now() % 10000}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const p = await launchPlayer({ baseUrl: BASE, crew: CREW, name: 'Cracker', query: { autojoin: '1', safes: '1' } });
const page = p.page;
const ev = <T = unknown>(js: string) => page.evaluate(js) as Promise<T>;
let code = 0;
try {
  await page.routeWebSocket(/token=/, () => {});
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForGame(page, 60_000);
  await page.waitForFunction(() => !!(window as unknown as { __game?: { me(): string | null } }).__game?.me(), undefined, { timeout: 15_000 });
  await ev(`__game.dbg('level.generate', { seed: 'safes-test-1', players: 1 })`);
  await sleep(3000);
  const peek = await ev<{ safes: { id: string; x: number; z: number; face: [number, number] }[] }>(`__game.dbg('safes.peek')`);
  const s = peek.safes[0]!;
  console.log('safe', JSON.stringify(s));
  const fx = s.x + s.face[0] * 1.3, fz = s.z + s.face[1] * 1.3;
  await ev(`__game.teleport(${fx}, ${fz}, 0)`);
  await sleep(500);
  await ev(`__ix.aim(${s.x}, 0.7, ${s.z})`);
  await sleep(600);
  const hit = await ev(`(async () => { for (const y of [0, Math.PI, Math.PI / 2, -Math.PI / 2]) { for (const pt of [-0.35, -0.6]) { __game.look(y, pt); await new Promise((r) => setTimeout(r, 350)); const tg = __ix.target(); if (tg && tg.id === '${s.id}') return [y, pt]; } } return null; })()`);
  console.log('aim hit', JSON.stringify(hit));
  console.log('diag', JSON.stringify(await ev(`(async () => ({ safes: window.__safes && [window.__safes.count(), window.__safes.inScene()], target: window.__ix && window.__ix.target(), int: window.__ix && JSON.stringify(window.__ix.state()).includes('safe:0'), pose: await __game.dbg('players.pose') }))()`)));
  console.log('prop shot', await screenshot(page, 'tests/artifacts/safes/safe-prop.png'));
  await ev(`__game.setInput({ interact: true })`);
  await sleep(500);
  if (!(await ev<boolean>(`!!document.querySelector('[data-testid="safe-dial"]')`))) { console.log('NOTE E did not target the safe in-browser; opening via dbg.safes.open'); await ev(`__game.dbg('safes.open', { id: '${s.id}' })`); }
  await page.waitForSelector('[data-testid="safe-dial"]', { timeout: 5000 });
  for (let i = 0; i < 7; i++) {
    await page.keyboard.press('KeyD');
    await sleep(60);
  }
  await page.mouse.wheel(0, 120);
  await sleep(400);
  console.log('dial shot', await screenshot(page, 'tests/artifacts/safes/safe-dial.png'));
  const frozen = await ev<unknown>(`(() => { const s = __game.state(); return s && s.diag ? Object.keys(s.diag).length : 0; })()`);
  console.log('diag keys', frozen);
  await page.keyboard.press('Escape');
  await sleep(300);
  const gone = await ev<boolean>(`!document.querySelector('[data-testid="safe-dial"]')`);
  console.log(gone ? 'PASS Esc closes the dial' : 'FAIL Esc did not close the dial');
  if (!gone) code = 1;
  const errs = await ev<string[]>(`__game.errors()`);
  console.log('client errors:', JSON.stringify(errs.slice(0, 8)), 'page errors:', JSON.stringify(p.errors.filter((e) => !/http 4\d\d/.test(e)).slice(0, 8)));
} catch (e) {
  console.log('FAIL', e instanceof Error ? e.message : e);
  await screenshot(page, 'tests/artifacts/safes/safe-fail.png').catch(() => undefined);
  code = 1;
} finally {
  await p.close();
}
process.exit(code);
