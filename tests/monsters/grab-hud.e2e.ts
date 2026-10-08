// Owner: track (c) Monsters (v1.2 G2). Browser screenshots of the Listener tells and the grab HUD (real Chrome):
//   listener-notice.png         the victim-only 'spotted' tell: red vignette pulse (+ heartbeat), the Listener's head snap
//   listener-grab-victim.png    grabbed: the camera turned to it, MASH [E], the struggle bar + countdown
//   listener-grab-struggle.png  after a few E presses (the bar rises)
//   listener-grab-crew.png      a teammate grabbed elsewhere: '<NAME> IS GRABBED · <ROOM> · Ns'
//   listener-knockdown.png      the first grab of a contract: KNOCKED DOWN (flashlight out)
// Run it through the GPU guard against a warmed dev server (the guard forces SwiftShader: judge layout, not lighting):
//   BASE_URL=http://127.0.0.1:3802 node tools/gpu-guard.mjs --max-sec 120 -- node tests/monsters/grab-hud.e2e.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { waitForGame } from '../lib/launch.ts';
import { launchStable, shot } from './browser.ts';
import { Bot, REPO, refuseLive, sleep, startServer, waitFor } from './bot.ts';

const PORT = Number(process.env.PORT ?? 3802);
const LB = (JSON.parse(readFileSync(join(REPO, 'config/balance/monsters.json'), 'utf8')) as { listener: Record<string, number> }).listener;
refuseLive(PORT, process.env.BASE_URL); // never the live server, before reusing BASE_URL or spawning one
const srv = process.env.BASE_URL ? null : await startServer(PORT);
const base = process.env.BASE_URL ?? srv!.base;
const wsUrl = base.replace(/^http/, 'ws') + '/ws';
const CREW = 'GHUD';
const OUT = 'tests/artifacts/monsters';
const t00 = performance.now();
const log = (m: string) => console.log(`[${((performance.now() - t00) / 1000).toFixed(1)}s] ${m}`);
const errors: string[] = [];
const B = new Bot('Bob');
type Hud = { grab: { victim: string; room: string | null } | null; knock: unknown; spotted: number; vignette: number };
type W = { __monsters?: { hud(): Hud; layout(): unknown; loaded(): boolean }; __monstersLayout?: () => unknown };

let p: Awaited<ReturnType<typeof launchStable>> | null = null;
try {
  // the bot sets the contract up first: the browser loads straight into it (one level build)
  await B.connect(wsUrl, CREW);
  await B.dbg('monsters.flag', { name: 'director', on: false });
  await B.dbg('monsters.flag', { name: 'listenerFairV12', on: true });
  await B.dbg('monsters.start', { seed: 'g2-hud-1', players: 2, risk: 1 });
  for (const id of ['hound0', 'hound1', 'mannequin0', 'snatcher0']) await B.dbg('monsters.place', { id, outSec: 9999 }).catch(() => null);
  await B.dbg('monsters.wake');
  await B.dbg('monsters.place', { id: 'listener0', outSec: 9999 });
  log('contract ready');
  p = await launchStable({ name: 'Ann', baseUrl: base, crew: CREW, query: { autojoin: '1' }, viewport: { width: 1280, height: 720 } });
  const page = p.page;
  await waitForGame(page, 75_000);
  await page.waitForFunction(() => (window as unknown as { __game?: { me(): string | null } }).__game?.me(), undefined, { timeout: 15_000 });
  await page.waitForFunction(() => (window as unknown as { __game?: { state(): { phase?: string } } }).__game?.state().phase === 'contract', undefined, { timeout: 15_000 });
  const me = await page.evaluate(() => (window as unknown as { __game: { me(): string } }).__game.me());
  log(`game ready, me=${me}`);
  await page.waitForFunction(() => (window as unknown as W).__monsters?.loaded() === true, undefined, { timeout: 15_000 }).catch(() => null);
  // a lit room with space in front of the camera
  const room = await page.evaluate(() => {
    const L = (window as unknown as W).__monstersLayout?.() as { spaces: { id: number; kind: string; rect: { x: number; y: number; w: number; h: number }; light: string; powerZone: number; callsign: string | null }[] } | null;
    if (!L) return null;
    const c = L.spaces.filter((s) => (s.kind === 'room' || s.kind === 'hall') && s.rect.w >= 6 && s.rect.h >= 5 && s.light === 'on');
    c.sort((a, b) => a.powerZone - b.powerZone || b.rect.w * b.rect.h - a.rect.w * a.rect.h);
    return c[0] ?? null;
  });
  if (!room) throw new Error('no lit room');
  await B.dbg('interaction.setLights', { space: room.id, on: true }).catch(() => null);
  const r = room.rect;
  const cam: [number, number] = [r.x + 1.0, r.y + r.h / 2];
  const lis: [number, number] = [r.x + 4.4, r.y + r.h / 2];
  const yaw = Math.atan2(lis[0] - cam[0], lis[1] - cam[1]);
  await page.evaluate(([x, z, y]) => { const g = (window as unknown as { __game: { teleport(x: number, z: number, y: number): void; look(y: number, p: number): void } }).__game; g.teleport(x, z, y); g.look(y, -0.04); }, [cam[0], cam[1], yaw] as const);
  // B stays in the van cab (Ann is alone)
  const cab = await page.evaluate(() => ((window as unknown as W).__monstersLayout?.() as { van: { cab: { x: number; y: number } } }).van.cab);
  const cabSpot: [number, number] = [cab.x + 1, cab.y + 1.5];
  await B.dbg('monsters.tp', { id: B.id, x: cabSpot[0], z: cabSpot[1], light: 0 }).catch(() => null);
  await page.waitForFunction(() => (window as unknown as { __game: { perf(): { frameMs: number } } }).__game.perf().frameMs < 40, undefined, { timeout: process.env.DEADAIR_RENDER === 'swiftshader' ? 4000 : 12_000, polling: 250 }).catch(() => null);
  await sleep(900);
  log(`room ${room.callsign ?? room.id}`);

  // ---- 1. notice: the spotted tell (red vignette pulse) while it snaps its head round ----
  await B.dbg('monsters.place', { id: 'listener0', x: lis[0], z: lis[1], yaw: yaw + Math.PI, state: 'ambush', active: true });
  const sp = await page.waitForFunction(() => ((window as unknown as W).__monsters?.hud().spotted ?? 0) > 0.3, undefined, { timeout: 2500, polling: 20 }).then(() => true, () => false);
  // monsters frozen in the notice pose: a software-rendered screenshot takes 1-3 s (it would catch the hunt + knockdown)
  await B.dbg('monsters.freeze', { on: true });
  await sleep(300);
  await shot(page, `${OUT}/listener-notice.png`);
  await B.dbg('monsters.place', { id: 'listener0', outSec: 9999 });
  await B.dbg('monsters.freeze', { on: false });
  log(`notice shot (spotted ${sp})`);
  if (!sp) errors.push('notice: no spotted vignette');

  // ---- 2. grabbed: camera turns to it, MASH [E], struggle bar + countdown ----
  await sleep(1500);
  await B.dbg('monsters.tune', { section: 'listener', set: { grabSec: 40, soloGrabSec: 40 } }); // slow frames: no timer death mid-shot
  await B.dbg('monsters.grab', { id: me, knockdown: false });
  await page.waitForFunction(() => !!(window as unknown as W).__monsters?.hud().grab, undefined, { timeout: 2000, polling: 30 }).catch(() => errors.push('grab: no HUD state'));
  await sleep(900);
  await shot(page, `${OUT}/listener-grab-victim.png`);
  for (let i = 0; i < 3; i++) { await page.keyboard.press('KeyE'); await sleep(140); }
  await sleep(60);
  await shot(page, `${OUT}/listener-grab-struggle.png`);
  for (let i = 0; i < 14; i++) {
    await page.keyboard.press('KeyE');
    await sleep(130);
    if (!(await page.evaluate(() => !!(window as unknown as W).__monsters?.hud().grab))) break;
  }
  const aliveA = async () => !!(await B.dbg<{ poses: { id: string; alive: boolean }[] }>('monsters.state')).poses.find((q) => q.id === me)?.alive;
  const freed = !(await page.evaluate(() => !!(window as unknown as W).__monsters?.hud().grab)) && (await aliveA());
  log(`grab shots (escaped by mashing E: ${freed})`);
  if (!freed) errors.push('grab: E presses did not free the victim');

  // ---- 3. a teammate grabbed elsewhere: the crew HUD line ----
  await sleep(3400); // its stagger + retreat
  await B.dbg('monsters.tp', { id: B.id, x: lis[0] + 0.5, z: lis[1] + (r.h / 2 - 1 > 1.5 ? 1.5 : 0), light: 0 });
  await B.dbg('monsters.grab', { id: B.id, knockdown: false });
  await page.waitForFunction(() => !!(window as unknown as W).__monsters?.hud().grab, undefined, { timeout: 2000, polling: 30 }).catch(() => errors.push('crew line: no HUD state'));
  await sleep(1300);
  await shot(page, `${OUT}/listener-grab-crew.png`);
  const hud = await page.evaluate(() => (window as unknown as W).__monsters?.hud());
  log(`crew shot: ${JSON.stringify(hud?.grab)}`);
  for (let i = 0; i < 30; i++) { const rr = await B.req<{ escaped?: boolean }>('monsters.struggle', {}).catch(() => null); if (rr?.escaped) break; await sleep(130); }

  // ---- 4. the first grab of a contract: knocked down ----
  await sleep(3400);
  await B.dbg('monsters.tp', { id: B.id, x: cabSpot[0], z: cabSpot[1] });
  await B.dbg('monsters.tune', { section: 'listener', set: { grabSec: Number(LB.grabSec ?? 5), soloGrabSec: Number(LB.soloGrabSec ?? 6) } });
  await B.dbg('monsters.grab', { id: me, knockdown: true });
  await sleep(450);
  await shot(page, `${OUT}/listener-knockdown.png`);
  log('knockdown shot');
  const pageErr = [...p.errors, ...(await page.evaluate(() => (window as unknown as { __game: { errors(): string[] } }).__game.errors()))].filter((e) => /monsters/i.test(e));
  errors.push(...pageErr);
} catch (e) {
  errors.push(`run: ${e instanceof Error ? e.stack ?? e.message : e}`);
} finally {
  B.close();
  await p?.close().catch(() => null);
  await srv?.stop();
}
console.log(errors.length ? `errors:\n${errors.slice(0, 12).join('\n')}` : 'no errors');
process.exitCode = errors.some((e) => e.startsWith('run:')) ? 1 : 0;
setTimeout(() => process.exit(process.exitCode ?? 0), 400).unref();
