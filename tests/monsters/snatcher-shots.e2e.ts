// Owner: track (c) Monsters. v1.1 Snatcher screenshots with real Chrome/WebGPU: the creature at a vent grate and in a
// corridor (lit + lights off with the flashlight), then a real snatch of the browser player (a ws bot is the faraway
// teammate): the victim's camera during the drag, inside the duct, and after the bot pulls them out.
//   node tests/monsters/snatcher-shots.e2e.ts   -> tests/artifacts/monsters/snatcher-*.png
import { ANIM } from '../../packages/shared/src/anim.ts';
import { waitForGame } from '../lib/launch.ts';
import { launchStable, shot } from './browser.ts';
import { Bot, refuseLive, sleep, startServer, waitFor } from './bot.ts';

const PORT = Number(process.env.PORT ?? 3013);
refuseLive(PORT, process.env.BASE_URL); // never the live server, before reusing BASE_URL or spawning one
const srv = process.env.BASE_URL ? null : await startServer(PORT);
const base = process.env.BASE_URL ?? srv!.base;
const crew = 'SNSH';
const p = await launchStable({ name: 'Cam', baseUrl: base, crew, query: { autojoin: '1' } });
const bot = new Bot('Bob');
const errors: string[] = [];
interface GrateDump { id: string; x: number; z: number; n: [number, number]; front: [number, number]; space: number }
try {
  await waitForGame(p.page, 60_000);
  await p.page.waitForFunction(() => window.__game?.me(), undefined, { timeout: 20_000 });
  await bot.connect(base.replace(/^http/, 'ws') + '/ws', crew);
  const dbg = <T = unknown>(r: string, a: unknown = {}): Promise<T> => p.page.evaluate(([r2, a2]) => window.__game!.dbg(r2 as string, a2), [r, a] as const) as Promise<T>;
  await dbg('monsters.start', { seed: 'snatch-shots', players: 2, risk: 2 });
  await p.page.waitForFunction(() => (window.__game?.state() as { phase?: string }).phase === 'contract', undefined, { timeout: 20_000 });
  await p.page.waitForFunction(() => (window as unknown as { __monsters?: { loaded(): boolean } }).__monsters?.loaded() === true, undefined, { timeout: 30_000 }).catch(() => null);
  const st = await dbg<{ agents: { kind: string; grates?: GrateDump[] }[] }>('monsters.state');
  const grates = st.agents.find((a) => a.kind === 'snatcher')?.grates ?? [];
  if (!grates.length) throw new Error('no snatcher / grates');
  for (const id of ['hound0', 'listener0', 'mannequin0']) await dbg('monsters.place', { id, outSec: 9999 }).catch(() => null);
  const L = await p.page.evaluate(() => (window as unknown as { __monstersLayout?: () => unknown }).__monstersLayout?.()) as { spaces: { id: number; kind: string; rect: { x: number; y: number; w: number; h: number } }[]; owner: number[]; W: number };
  const tp = (x: number, z: number, yaw: number, pitch = -0.1) => p.page.evaluate(([x2, z2, y2, p2]) => { window.__game!.teleport(x2, z2, y2); window.__game!.look(y2, p2); }, [x, z, yaw, pitch] as const);
  const power = (on: boolean) => p.page.evaluate((o) => (window as unknown as { __render?: { setPower(s: number | 'all', on: boolean): void } }).__render?.setPower('all', o), on);

  // ---------------- 1. the creature at a vent grate + in a corridor (frozen pose) ----------------
  await dbg('monsters.freeze', { on: true });
  const g = grates[0];
  const sx = g.front[0] + g.n[0] * 0.5, sz = g.front[1] + g.n[1] * 0.5;
  const cx = g.front[0] + g.n[0] * 2.6 + g.n[1] * 0.8, cz = g.front[1] + g.n[1] * 2.6 - g.n[0] * 0.8;
  const camYaw = Math.atan2(sx - cx, sz - cz);
  await dbg('monsters.place', { id: 'snatcher0', x: sx, z: sz, yaw: Math.atan2(g.n[0], g.n[1]), state: 'lurk', active: true, anim: ANIM.mWalk });
  await tp(cx, cz, camYaw, -0.3);
  await p.page.waitForFunction(() => ((window as unknown as { __monsters?: { views(): { kind: string; model: boolean; visible: boolean }[] } }).__monsters?.views() ?? []).some((v) => v.kind === 'snatcher' && v.model && v.visible), undefined, { timeout: 20_000 });
  await sleep(1500);
  console.log(`  views: ${JSON.stringify(await p.page.evaluate(() => (window as unknown as { __monsters?: { views(): unknown } }).__monsters?.views()))}`);
  await shot(p.page, 'tests/artifacts/monsters/snatcher-vent-lit.png');
  await power(false);
  await sleep(700);
  await shot(p.page, 'tests/artifacts/monsters/snatcher-vent-dark.png');
  await power(true);
  // corridor: the longest corridor, creature crawling toward the camera
  const cor = L.spaces.filter((s) => s.kind === 'corridor').sort((a, b) => Math.max(b.rect.w, b.rect.h) - Math.max(a.rect.w, a.rect.h))[0];
  if (cor) {
    const horiz = cor.rect.w >= cor.rect.h;
    const mx = cor.rect.x + cor.rect.w / 2, mz = cor.rect.y + cor.rect.h / 2;
    const ax = horiz ? mx - 1 : mx, az = horiz ? mz : mz - 1;
    const bx = horiz ? mx + 1.6 : mx, bz = horiz ? mz : mz + 1.6;
    await dbg('monsters.place', { id: 'snatcher0', x: ax, z: az, yaw: Math.atan2(bx - ax, bz - az), state: 'lurk', active: true, anim: ANIM.mWalk });
    await tp(bx, bz, Math.atan2(ax - bx, az - bz), -0.38);
    await sleep(1800);
    await shot(p.page, 'tests/artifacts/monsters/snatcher-corridor-lit.png');
    await power(false);
    await sleep(700);
    await shot(p.page, 'tests/artifacts/monsters/snatcher-corridor-dark.png');
    await power(true);
  }

  // ---------------- 2. a real snatch of the browser player (victim camera), the bot pulls them out ----------------
  await dbg('monsters.place', { id: 'snatcher0', active: false, state: 'lurk' });
  await dbg('monsters.freeze', { on: false });
  await dbg('monsters.snatcher', { op: 'ready' });
  const far = grates.slice(1).map((q) => [q.front[0] + q.n[0], q.front[1] + q.n[1]] as [number, number]).sort((a, b) => Math.hypot(b[0] - g.x, b[1] - g.z) - Math.hypot(a[0] - g.x, a[1] - g.z))[0];
  await bot.dbg('monsters.tp', { id: bot.id, x: far[0], z: far[1] });
  const vx = g.front[0] + g.n[0] * 2.2, vz = g.front[1] + g.n[1] * 2.2;
  await tp(vx, vz, Math.atan2(g.n[0], g.n[1]), 0);
  const t0 = performance.now();
  const start = await waitFor(() => bot.eventsOf('monsters.snatch', t0).find((e) => (e.d as { state: string }).state === 'start'), 25_000, 'snatch start');
  console.log(`  snatched after ${((start.at - t0) / 1000).toFixed(1)} s`);
  await sleep(500);
  await shot(p.page, 'tests/artifacts/monsters/snatcher-victim-drop.png');
  await sleep(700);
  await shot(p.page, 'tests/artifacts/monsters/snatcher-victim-drag.png');
  await waitFor(() => bot.eventsOf('monsters.snatch', start.at).find((e) => (e.d as { phase?: string }).phase === 'duct'), 15_000, 'duct');
  await sleep(900);
  await shot(p.page, 'tests/artifacts/monsters/snatcher-victim-duct.png');
  await bot.dbg('monsters.tp', { id: bot.id, x: g.front[0] + g.n[0] * 0.7, z: g.front[1] + g.n[1] * 0.7 });
  let freed = false;
  for (let i = 0; i < 40 && !freed; i++) {
    await bot.req('monsters.pull', { on: true });
    await sleep(120);
    freed = bot.eventsOf('monsters.snatch', start.at).some((e) => (e.d as { state: string }).state === 'freed');
  }
  console.log(`  freed: ${freed}`);
  await sleep(1200);
  await shot(p.page, 'tests/artifacts/monsters/snatcher-victim-freed.png');
  // the wet drag trail on the floor, from where it dropped to the grate
  await tp(vx + g.n[0] * 1.8, vz + g.n[1] * 1.8, Math.atan2(-g.n[0], -g.n[1]), -0.75);
  await sleep(600);
  await shot(p.page, 'tests/artifacts/monsters/snatcher-trail.png');
  console.log(`  local after rescue: ${JSON.stringify(await p.page.evaluate(() => (window as unknown as { __players?: { local(): unknown } }).__players?.local()))}`);
  errors.push(...p.errors, ...(await p.page.evaluate(() => window.__game!.errors())));
} catch (e) {
  errors.push(`run: ${e instanceof Error ? e.stack ?? e.message : e}`, ...p.errors);
  console.log(`  views at failure: ${JSON.stringify(await p.page.evaluate(() => (window as unknown as { __monsters?: { views(): unknown } }).__monsters?.views()).catch(() => null))}`);
} finally {
  bot.close();
  await p.close();
  await srv?.stop();
}
console.log(errors.length ? `errors:\n${errors.slice(0, 20).join('\n')}` : 'no errors');
process.exitCode = errors.some((e) => e.startsWith('run:')) ? 1 : 0;
setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
