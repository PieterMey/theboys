// Owner: track (a) Objectives. Visual check in real Chrome (WebGPU): HUD checklist + clock, breaker pull with a ws bot
// partner (power banner), keypad modal (wrong + right code), clue note, Core on its pedestal / carried, blackout.
// Screenshots -> tests/artifacts/objectives/*.png.  node tests/objectives/visual.e2e.ts [--keep]
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { launchPlayer, screenshot, waitForGame } from '../lib/launch.ts';
import { connectBot } from '../bots/bot-client.ts';
import type { ObjectivesState } from '@dead-air/shared/messages/objectives.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const PORT = Number(process.env.PORT ?? 3011);
const BASE = process.env.BASE_URL ?? `http://127.0.0.1:${PORT}`;
const OUT = 'tests/artifacts/objectives';
const CREW = 'OBJV';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function up(): Promise<boolean> {
  try { return (await fetch(`${BASE}/healthz`)).ok; } catch { return false; }
}
let server: ChildProcess | null = null;
let serverLog = '';
if (!(await up())) {
  server = spawn(process.execPath, ['--env-file-if-exists=C:/Users/Pieter/repos/theboys/.env', 'apps/server/src/index.ts', '--dev'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', AI_MODE: 'mock' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (d: Buffer) => { serverLog += d.toString(); });
  server.stderr?.on('data', (d: Buffer) => { serverLog += d.toString(); });
  const t0 = Date.now();
  while (Date.now() - t0 < 40_000 && !(await up())) await sleep(250);
}

type Obj = { state(): ObjectivesState | null; open(ui: string, id: string): void; close(): void; interact(id: string): Promise<unknown>; req(r: string, a: unknown): Promise<unknown> };
const results: string[] = [];
const p = await launchPlayer({ name: 'Viewer', baseUrl: BASE, crew: CREW });
p.page.on('framenavigated', (f) => { if (f === p.page.mainFrame()) results.push(`navigated: ${f.url()}`); });
p.page.on('console', (m) => { if (/vite|reload|lost/i.test(m.text())) results.push(`console: ${m.text().slice(0, 200)}`); });
// other tracks keep saving files: block Vite's HMR socket so the page never full-reloads / shows the error overlay
await p.page.routeWebSocket((u) => !u.pathname.startsWith('/ws'), (ws) => {
  // keep Vite's HMR socket alive (pings) but drop reload/update/error pushes caused by other tracks' saves
  const server = ws.connectToServer();
  server.onMessage((m) => {
    const t = String(m);
    if (process.argv.includes('--hmrlog')) console.log(`[hmr] ${t.slice(0, 160)}`);
    if (/"type"\s*:\s*"(full-reload|update|error|prune)"/.test(t)) return;
    ws.send(m);
  });
});
await p.page.goto(`${BASE}/?test=1#${CREW}`, { waitUntil: 'domcontentloaded' });
const tp = (x: number, z: number, yaw: number, pitch = 0) => p.page.evaluate(async ([x, z, yaw, pitch]) => {
  await window.__game!.dbg('net.teleport', { x, z, yaw }).catch(() => undefined);
  window.__game!.teleport(x, z, yaw);
  window.__game!.look(yaw, pitch);
}, [x, z, yaw, pitch] as const);
try {
  await p.page.waitForFunction(() => !!window.__game, undefined, { timeout: 15000 }).catch(() => undefined);
  if (!(await p.page.evaluate(() => !!window.__game))) {
    // another track's client module is mid-edit (main.ts imports every track statically): use (b)'s resilient entry
    results.push('main entry broken -> /src/interaction/dev.html');
    await p.page.goto(`${BASE}/src/interaction/dev.html?test=1#${CREW}`, { waitUntil: 'domcontentloaded' });
    await p.page.waitForFunction(() => !!window.__game, undefined, { timeout: 30000 });
  }
  await waitForGame(p.page, 60_000).catch(() => undefined);
  await p.page.evaluate((c) => window.__game!.join(c), CREW);
  await sleep(800);
  const bot = await connectBot({ url: BASE.replace(/^http/, 'ws') + '/ws', crew: CREW, name: 'Bot-B' });
  const start = await p.page.evaluate(() => window.__game!.dbg('objectives.start', { fixture: 'facility_s1_p2', realSec: 900, monsters: false, openDoors: true }));
  results.push(`start: ${JSON.stringify(start)}`);
  await p.page.waitForFunction(() => (window as unknown as { __objectives?: Obj }).__objectives?.state()?.active === true, undefined, { timeout: 15000 });
  await sleep(2800);
  await p.page.evaluate(() => window.__game!.dbg('monsters.freeze', { on: true })).catch(() => undefined);
  const st = await p.page.evaluate(() => (window as unknown as { __objectives: Obj }).__objectives.state()) as ObjectivesState;
  const [l0, l1] = st.levers;
  // stand in front of breaker 0 (lever faces +rot direction), look at it
  const face = (x: number, z: number, rot: number, dist = 1.3) => [x + Math.sin(rot) * dist, z + Math.cos(rot) * dist, rot + Math.PI] as const;
  const [x0, z0, y0] = face(l0.p[0], l0.p[2], l0.rot);
  await tp(x0, z0, y0, -0.15);
  await sleep(1200);
  results.push(`shot ${await screenshot(p.page, `${OUT}/01-breaker.png`)}`);
  // bot partner at breaker 1 (server reach check uses the pose)
  await bot.teleport(l1.p[0] + Math.sin(l1.rot) * 0.9, l1.p[2] + Math.cos(l1.rot) * 0.9);
  await sleep(600);
  const [ra, rb] = await Promise.all([
    p.page.evaluate((id) => (window as unknown as { __objectives: Obj }).__objectives.interact(id), l0.id),
    bot.req('objectives.lever', { id: l1.id }),
  ]);
  results.push(`levers: ${JSON.stringify(ra)} / ${JSON.stringify(rb)}`);
  await sleep(500);
  results.push(`banner after power: ${JSON.stringify(await p.page.evaluate(() => (window as unknown as { __objectives: { banner(): unknown } }).__objectives.banner()))}`);
  results.push(`shot ${await screenshot(p.page, `${OUT}/02-power.png`)}`);
  // keypad
  const kp = st.keypad!;
  const [kx, kz, ky] = face(kp.p[0], kp.p[2], kp.rot, 1.0);
  await tp(kx, kz, ky, 0);
  await sleep(900);
  await p.page.evaluate((id) => (window as unknown as { __objectives: Obj }).__objectives.interact(id), kp.id);
  await sleep(500);
  for (const k of ['1', '2', '3', '4']) { await p.page.keyboard.press(`Digit${k}`); await sleep(80); }
  await p.page.keyboard.press('Enter');
  await sleep(250);
  results.push(`shot ${await screenshot(p.page, `${OUT}/03-keypad-wrong.png`)}`);
  await sleep(500);
  for (const k of st.code) { await p.page.keyboard.press(`Digit${k}`); await sleep(80); }
  await sleep(150);
  results.push(`shot ${await screenshot(p.page, `${OUT}/04-keypad-typed.png`)}`);
  await p.page.keyboard.press('Enter');
  await sleep(350);
  results.push(`shot ${await screenshot(p.page, `${OUT}/05-keypad-ok.png`)}`);
  await sleep(1200);
  // a clue note
  const note = st.notes.find((n) => n.codeHalf === 'A') ?? st.notes[0];
  await p.page.evaluate((id) => (window as unknown as { __objectives: Obj }).__objectives.open('note', id), note.id);
  await sleep(2200);
  results.push(`shot ${await screenshot(p.page, `${OUT}/06-note.png`)}`);
  await p.page.keyboard.press('Escape');
  await sleep(300);
  // Core on its pedestal
  const c = st.core!;
  await tp(c.p[0], c.p[2] + 2.2, Math.PI, -0.3);
  await sleep(1500);
  results.push(`shot ${await screenshot(p.page, `${OUT}/07-core.png`)}`);
  // lift it with the bot (me at one handle, bot at the other)
  await tp(c.p[0] - 0.9, c.p[2], Math.PI / 2);
  await bot.teleport(c.p[0] + 0.9, c.p[2]);
  await sleep(700);
  const g1 = await p.page.evaluate(() => (window as unknown as { __objectives: Obj }).__objectives.req('objectives.core', { action: 'grab' }));
  const g2 = await bot.req('objectives.core', { action: 'grab' });
  results.push(`grab: ${JSON.stringify(g1)} / ${JSON.stringify(g2)}`);
  // walk both carriers a little (poses must stay within the leash and the speed budget)
  for (let i = 0; i < 20; i++) {
    await p.page.evaluate(([x, z]) => { window.__game!.teleport(x, z, Math.PI / 2); window.__game!.look(Math.PI / 2, -0.55); }, [c.p[0] - 0.9, c.p[2] + i * 0.06] as const);
    bot.setPos(c.p[0] + 0.9, c.p[2] + i * 0.06);
    await sleep(60);
  }
  await sleep(1400);
  results.push(`shot ${await screenshot(p.page, `${OUT}/08-core-carried.png`)}`);
  // blackout
  await p.page.evaluate(() => window.__game!.dbg('objectives.clock', { min: 299.5 }));
  await sleep(2600);
  results.push(`shot ${await screenshot(p.page, `${OUT}/09-blackout.png`)}`);
  // release the Core (E path) so the carriers are free
  await p.page.evaluate(() => (window as unknown as { __objectives: Obj }).__objectives.req('objectives.core', { action: 'release' }));
  // salvage deposit in the van: "+$" floating text
  const v = st.van!;
  const dep = st.deposit!;
  await tp(v.x + v.w / 2, v.y + v.h - 0.6, Math.PI, -0.35);
  await sleep(900);
  await p.page.evaluate(() => window.__game!.dbg('interaction.give', { type: 'loot.medium', value: 64, name: 'Typewriter' }));
  await sleep(300);
  const d1 = await p.page.evaluate(() => (window as unknown as { __objectives: Obj }).__objectives.req('interaction.use', { id: 'deposit:0' }));
  results.push(`deposit: ${JSON.stringify(d1)} (deposit at ${dep.p.map((n) => n.toFixed(1)).join(',')})`);
  await sleep(450);
  results.push(`shot ${await screenshot(p.page, `${OUT}/10-deposit.png`)}`);
  // leave lever: refused while the bot is outside, then everyone in -> the van leaves
  const ll = st.leaveLever!;
  const refused = await p.page.evaluate((id) => (window as unknown as { __objectives: Obj }).__objectives.interact(id), ll.id);
  results.push(`leave (bot outside): ${JSON.stringify(refused)}`);
  await bot.teleport(v.x + v.w / 2, v.y + 0.8);
  await sleep(500);
  const left = await p.page.evaluate((id) => (window as unknown as { __objectives: Obj }).__objectives.interact(id), ll.id);
  results.push(`leave (all in): ${JSON.stringify(left)}`);
  await sleep(700);
  results.push(`shot ${await screenshot(p.page, `${OUT}/11-leave.png`)}`);
  results.push(`result: ${JSON.stringify(await p.page.evaluate(() => (window as unknown as { __objectives: { result(): unknown } }).__objectives.result()))}`);
  const errs = await p.page.evaluate(() => window.__game!.errors());
  results.push(`client errors: ${errs.length ? errs.join(' | ').slice(0, 1500) : 'none'}`);
  bot.close();
} catch (e) {
  results.push(`ERROR ${e instanceof Error ? e.stack : e}`);
  results.push(`diag: ${JSON.stringify(await p.page.evaluate(() => ({ href: location.href, game: typeof window.__game, obj: typeof (window as unknown as Record<string, unknown>).__objectives, t0: performance.timeOrigin, up: performance.now() })).catch((x) => String(x)))}`);
  await screenshot(p.page, `${OUT}/error.png`).catch(() => undefined);
} finally {
  results.push(`page errors: ${p.errors.filter((x) => !/favicon/.test(x)).slice(0, 12).join(' | ') || 'none'}`);
  await p.close();
  console.log(results.join('\n'));
  const errs = serverLog.split('\n').filter((l) => /ERROR|threw/.test(l));
  if (errs.length) console.log('server errors:\n' + errs.slice(-20).join('\n'));
  if (server && !process.argv.includes('--keep')) server.kill();
  setTimeout(() => process.exit(0), 300).unref();
}
