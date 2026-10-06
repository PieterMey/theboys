// Visual check (screenshots) for track (b): a teammate (ws bot) holding a crowbar, a world crowbar / medkit prop,
// the battery + radio HUD. Needs a running dev server (BASE_URL, default http://127.0.0.1:3012).
//   node tests/interaction/visual.e2e.ts   -> tests/artifacts/interaction/v*.png
import { launchPlayer, screenshot, waitForGame } from '../lib/launch.ts';
import type { Page } from 'playwright-core';
import { Bot } from './bot.ts';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3012';
const CREW = `VX${'BCDFGHJKLM'[Math.floor(Date.now() / 1000) % 10]}${'BCDFGHJKLM'[Math.floor(Date.now() / 10000) % 10]}`;
const OUT = 'tests/artifacts/interaction';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ev = <T>(page: Page, js: string): Promise<T> => page.evaluate(js) as Promise<T>;

const p = await launchPlayer({ name: 'Viewer', baseUrl: BASE, crew: CREW, query: { autojoin: '1' } });
const page = p.page;
await page.routeWebSocket(/token=/, () => {});
await page.reload({ waitUntil: 'domcontentloaded' });
let ok = true;
try {
  await waitForGame(page, 60_000);
  await page.waitForFunction(() => !!(window as unknown as { __game?: { me(): string | null } }).__game?.me(), undefined, { timeout: 15_000 });
  const mate = new Bot('Sam');
  await mate.connect(BASE.replace(/^http/, 'ws') + '/ws', CREW);
  await ev(page, `__game.dbg('objectives.start', { fixture: 'facility_s1_p2', monsters: false })`);
  await sleep(1500);
  // smooth frames (facility shaders compile on first view)
  for (let i = 0; i < 40; i++) {
    const worst = await ev<number>(page, `new Promise((res) => { const ts = []; const f = (t) => { ts.push(t); if (ts.length < 10) requestAnimationFrame(f); else { let m = 0; for (let i = 1; i < ts.length; i++) m = Math.max(m, ts[i] - ts[i - 1]); res(m); } }; requestAnimationFrame(f); })`);
    if (worst < 80) break;
  }
  // the mate holds a crowbar where it spawned; keep its pose alive
  const sp = mate.lastSnap?.players.find((x) => x.id === mate.me)?.p ?? [19, 0, 26];
  await ev(page, `__game.dbg('interaction.give', { type: 'crowbar', pid: '${mate.me}' })`);
  const keep = setInterval(() => mate.pose(sp[0], sp[2], Math.PI), 100);
  await sleep(600);
  // me: 2 m in front of it (it faces -Z), looking at its hands
  await ev(page, `__game.teleport(${sp[0]}, ${sp[2] - 2.0}, 0)`);
  await sleep(400);
  await ev(page, `__ix.aim(${sp[0]}, 1.0, ${sp[2]})`);
  await sleep(900);
  await screenshot(page, `${OUT}/v1-teammate-holds-crowbar.png`);
  // a world crowbar / medkit prop
  const st = await ev<{ items: Record<string, { type: string; where: string; p?: number[] }> }>(page, '__ix.state()');
  for (const type of ['crowbar', 'medkit']) {
    const it = Object.values(st.items).find((i) => i.type === type && i.where === 'world' && i.p);
    if (!it) { console.log(`no world ${type}`); continue; }
    const L = await ev<{ owner: number[]; W: number }>(page, '(() => { const l = __ix.layout(); return { owner: l.owner, W: l.W }; })()');
    const own = (x: number, z: number) => L.owner[Math.floor(z) * L.W + Math.floor(x)];
    let best: [number, number] | null = null;
    for (let k = 0; k < 8 && !best; k++) {
      const a = (k / 8) * Math.PI * 2;
      const x = it.p![0] + Math.sin(a) * 1.1, z = it.p![2] + Math.cos(a) * 1.1;
      if (own(x, z) === own(it.p![0], it.p![2])) best = [x, z];
    }
    if (!best) continue;
    await ev(page, `__game.teleport(${best[0]}, ${best[1]}, 0)`);
    await sleep(400);
    await ev(page, `__ix.aim(${it.p![0]}, 0.05, ${it.p![2]})`);
    await sleep(1500);
    await screenshot(page, `${OUT}/v2-world-${type}.png`);
  }
  clearInterval(keep);
  const errs = (await ev<string[]>(page, '__game.errors()')).filter((e) => /interaction|\bix\b/i.test(e));
  console.log('interaction client errors:', JSON.stringify(errs.slice(0, 5)));
  ok = errs.length === 0;
  mate.close();
} catch (e) {
  ok = false;
  console.log('visual e2e failed:', e instanceof Error ? e.stack : e);
  await screenshot(page, `${OUT}/v99-crash.png`).catch(() => {});
} finally {
  await p.close();
}
process.exitCode = ok ? 0 : 1;
