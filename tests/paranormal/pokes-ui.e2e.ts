// Owner: env-paranormal (v1.3 F4 dead pokes). ONE guarded browser run (software lane): the spectator's poke bar.
//   BASE_URL=http://127.0.0.1:3814 node tools/gpu-guard.mjs --max-sec 120 -- node tests/paranormal/pokes-ui.e2e.ts
// A dev server must already run on BASE_URL (outside the guard). One browser (Cam, who dies) + one ws bot (Ann, alive):
//  - flag deadPokes set live before the page loads (the client takes the /healthz flags at boot)
//  - Cam dies: spectating Ann, the poke bar shows [1]-[3] KNOCK and [4] FLICKER <room> (screenshot)
//  - key 2 knocks twice: Ann gets the dead_poke knock (count 2), the knock buttons cool down (screenshot)
//  - key 4 flickers the watched room: Ann gets the flicker, the client runs the effect (screenshot)
//  - a revive takes the bar away
// Output: $PARA_SHOTS (default <os tmp>/dead-air-poke-shots)/*.png + report.json. Judge layout and logic, not lighting.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import type { ParanormalEvent } from '../../packages/shared/src/messages/paranormal.ts';
import { fixturesBySpace, glowing, indoor, nearVan, spaceAtXZ } from '../../apps/server/src/paranormal/gates.ts';
import { SOFTWARE, launchPlayer, shot } from './browser.ts';
import { Bot, waitFor } from './bot.ts';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3814';
const OUT = process.env.PARA_SHOTS ?? join(tmpdir(), 'dead-air-poke-shots');
const T0 = performance.now();
const elapsed = () => +((performance.now() - T0) / 1000).toFixed(1);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const results: { name: string; pass: boolean; info: string }[] = [];
const check = (name: string, pass: boolean, info = ''): boolean => {
  results.push({ name, pass, info });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${elapsed()} s] ${name}${info ? `  (${info})` : ''}`);
  return pass;
};
const report: Record<string, unknown> = { software: SOFTWARE, shots: [] as string[] };

type W = Window & {
  __game?: { ready(): boolean; me(): string | null; dbg(r: string, a?: unknown): Promise<unknown> };
  __players?: { pokeUi(): { on: boolean; room: string | null; knockInMs: number; flickerInMs: number; msg: string | null; pending: boolean }; spectating(): { on: boolean; target: string | null } };
  __paranormal?: { effects(): { id: number; kind: string }[]; levelReady(): boolean; contentReady(): boolean | null; diag(): Record<string, unknown> };
};

const crew = 'PKBX';
const ann = new Bot('Ann');
await ann.connect(`${BASE.replace(/^http/, 'ws')}/ws`, crew);
await ann.dbg('setFlags', { set: { deadPokes: true } });
const p = await launchPlayer({ baseUrl: BASE, crew, name: 'Cam', query: { autojoin: '1', autoq: '0' }, viewport: SOFTWARE ? { width: 960, height: 540 } : undefined });
const page = p.page;
const pokeUi = () => page.evaluate(() => (window as unknown as W).__players!.pokeUi());
const shots = report.shots as string[];
try {
  await page.waitForFunction(() => (window as unknown as W).__game?.ready() === true && !!(window as unknown as W).__game?.me(), undefined, { timeout: 45_000, polling: 200 });
  const camId = await page.evaluate(() => (window as unknown as W).__game!.me());
  check('browser joined the crew', !!camId, `${elapsed()} s`);
  await ann.dbg('objectives.start', { seed: 'poke-ui-1', players: 2, realSec: 900 });
  const L = await waitFor(() => ann.eventsOf<{ state?: { layout?: LevelLayout } }>('phase').pop()?.d.state?.layout, 8000, 'layout');
  await page.waitForFunction(() => (window as unknown as W).__paranormal?.levelReady() === true, undefined, { timeout: 45_000, polling: 250 });
  check('contract level built in the browser', true, `${L.W}x${L.H}`);
  await sleep(2600); // the monsters auto-start after 2.5 s
  await ann.dbg('monsters.freeze', { on: true });
  const ms0 = await ann.dbg<{ agents?: { id: string }[] }>('monsters.state');
  for (const ag of ms0.agents ?? []) await ann.dbg('monsters.place', { id: ag.id, active: false, x: 0.5, z: 0.5 });
  for (let z = 0; z <= (L.zones ?? 1); z++) await ann.dbg('interaction.power', { zone: z, on: true }).catch(() => null);
  await ann.dbg('interaction.setLights', { space: 'all', on: true }).catch(() => null);
  // Ann in the middle of a big lit room, facing +z: Cam's follow camera hangs 2.2 m behind her, inside the room
  const room = L.spaces.find((s) => indoor(L, s.id) && s.kind !== 'corridor' && s.rect.w >= 5 && s.rect.h >= 6 && !!s.callsign
    && (fixturesBySpace(L).get(s.id) ?? []).some(glowing) && !nearVan(L, s.rect.x + s.rect.w / 2, s.rect.y + s.rect.h / 2, 6));
  if (!check('a big lit room for the scene', !!room, room ? `${room.callsign} ${room.rect.w}x${room.rect.h}` : '')) throw new Error('no room');
  const ax = Math.floor(room!.rect.x + room!.rect.w / 2) + 0.5, az = Math.floor(room!.rect.y + room!.rect.h / 2) + 1.5;
  check('Ann stands inside the room', spaceAtXZ(L, ax, az) === room!.id && spaceAtXZ(L, ax, az - 2.4) === room!.id);
  await ann.dbg('interaction.pose', { pid: ann.id, x: ax, z: az, yaw: 0, light: 1 });
  await sleep(400);
  // ---------------- Cam dies ----------------
  await ann.dbg('interaction.kill', { pid: camId, killer: 'HOUND', reason: 'heard your SPRINT (9 m)' });
  const on = await page.waitForFunction(() => (window as unknown as W).__players?.pokeUi().on === true, undefined, { timeout: 10_000, polling: 100 }).then(() => true, () => false);
  check('dead: the poke bar is up', on);
  // the death card fades, the follow camera settles behind Ann
  await page.waitForFunction(() => !document.querySelector('[data-testid="ix-deathcard"]'), undefined, { timeout: 14_000, polling: 250 }).catch(() => null);
  await sleep(700);
  const spec = await page.evaluate(() => (window as unknown as W).__players!.spectating());
  check('spectating Ann', spec.on && spec.target === ann.id, JSON.stringify(spec));
  const ui0 = await pokeUi();
  const btns = await page.evaluate(() => [...document.querySelectorAll('[data-testid="poke-bar"] button')].map((b) => ({ id: b.getAttribute('data-testid'), text: (b.textContent ?? '').trim(), ready: b.getAttribute('data-ready') })));
  report.buttons = btns;
  check('four buttons, all ready: [1]-[3] KNOCK, [4] FLICKER <room>', btns.length === 4 && btns.every((b) => b.ready === '1') && btns[3].text.includes('FLICKER'), btns.map((b) => b.text).join(' | '));
  check('the bar names the watched room', ui0.room === room!.callsign, `${ui0.room}`);
  shots.push(await shot(page, join(OUT, 'pokebar-ready.png')));
  // ---------------- key 2: knock twice ----------------
  const before = ann.events.length;
  await page.keyboard.press('Digit2');
  const kev = await waitFor(() => ann.events.slice(before).find((e) => e.e === 'paranormal.event' && (e.d as ParanormalEvent).kind === 'dead_poke' && (e.d as ParanormalEvent).data?.poke === 'knock'),
    4000, 'knock at Ann').catch(() => null);
  check('key 2: Ann hears a dead_poke knock x2', !!kev && (kev.d as ParanormalEvent).data?.count === 2, kev ? `door ${String((kev.d as ParanormalEvent).data?.door)}` : (await pokeUi()).msg ?? 'none');
  const ui1 = await waitFor(async () => { const u = await pokeUi(); return u.knockInMs > 0 && !u.pending ? u : null; }, 3000, 'cooldown').catch(() => null);
  check('the knock buttons cool down (~8 s), the flicker stays ready', !!ui1 && ui1.knockInMs > 6000 && ui1.knockInMs <= 8000 && ui1.flickerInMs === 0, ui1 ? `${ui1.knockInMs} ms, msg ${ui1.msg}` : 'no cooldown');
  const fx = await page.evaluate(() => (window as unknown as W).__paranormal!.effects().filter((e) => e.kind === 'dead_poke').length);
  check('the dead client renders its own knock', fx >= 1, `${fx}`);
  await sleep(250);
  shots.push(await shot(page, join(OUT, 'pokebar-cooling.png')));
  report.cooling = await page.evaluate(() => [...document.querySelectorAll('[data-testid="poke-bar"] button')].map((b) => `${(b.textContent ?? '').trim()} ${b.getAttribute('data-ready')}`));
  // ---------------- key 4: flicker ----------------
  await sleep(1300); // crew-wide gap
  const before2 = ann.events.length;
  await page.keyboard.press('Digit4');
  const fev = await waitFor(() => ann.events.slice(before2).find((e) => e.e === 'paranormal.event' && (e.d as ParanormalEvent).kind === 'dead_poke' && (e.d as ParanormalEvent).data?.poke === 'flicker'),
    4000, 'flicker at Ann').catch(() => null);
  check('key 4: the watched room flickers (Ann gets it)', !!fev && (fev.d as ParanormalEvent).space === room!.id, fev ? `${((fev.d as ParanormalEvent).data?.lights as string[]).length} lights` : (await pokeUi()).msg ?? 'none');
  await sleep(900);
  shots.push(await shot(page, join(OUT, 'pokebar-flicker.png')));
  const ui2 = await pokeUi();
  check('flicker cools down (~20 s)', ui2.flickerInMs > 15_000, `${ui2.flickerInMs} ms`);
  // an early knock is answered locally, without a request
  const sentBefore = ann.events.length;
  await page.keyboard.press('Digit1');
  await sleep(300);
  const ui3 = await pokeUi();
  check('an early knock says NOT YET', /NOT YET/.test(ui3.msg ?? ''), `${ui3.msg}`);
  check('no knock went out early', !ann.events.slice(sentBefore).some((e) => e.e === 'paranormal.event' && (e.d as ParanormalEvent).kind === 'dead_poke'));
  // ---------------- revive ----------------
  await ann.dbg('interaction.revive', { pid: camId });
  const off = await page.waitForFunction(() => (window as unknown as W).__players?.pokeUi().on === false, undefined, { timeout: 8000, polling: 100 }).then(() => true, () => false);
  check('revived: the bar is gone', off);
  const errs = p.errors.filter((e) => !/favicon|ERR_ABORTED|net::|404/.test(e));
  report.errors = errs.slice(0, 20);
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
  check('run', false, e instanceof Error ? e.message : String(e));
} finally {
  report.results = results;
  report.sec = elapsed();
  try { writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2)); } catch { /* out dir missing */ }
  await p.close().catch(() => null);
  await ann.close().catch(() => null);
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed in ${elapsed()} s; shots in ${OUT}`);
process.exit(failed.length ? 1 : 0);
