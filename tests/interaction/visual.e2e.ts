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
  // room lights: biggest lit zone-0 room, flashlight off, switch its lights off via the API (render.setPower)
  const room = await ev<{ id: number; rect: { x: number; y: number; w: number; h: number } } | undefined>(page, `(() => { const L = __ix.layout(); const st = __ix.state(); const rs = L.spaces.filter(s => s.kind !== 'corridor' && s.kind !== 'outside' && s.type !== 'van' && s.powerZone === 0 && st.lights[s.id]); rs.sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h); return rs[0]; })()`);
  if (room) {
    const r = room.rect;
    await ev(page, `__game.teleport(${r.x + 0.8}, ${r.y + 0.8}, 0)`);
    await sleep(400);
    await ev(page, `__ix.aim(${r.x + r.w - 0.5}, 1.0, ${r.y + r.h - 0.5})`);
    await ev(page, '__ix.flashlight(false)');
    await sleep(1200);
    await screenshot(page, `${OUT}/v3-room-lights-on.png`);
    await ev(page, `__game.dbg('interaction.setLights', { space: ${room.id}, on: false })`);
    await sleep(1500);
    await screenshot(page, `${OUT}/v4-room-lights-off.png`);
    const lit = await ev<boolean>(page, `__ix.state().lights[${room.id}]`);
    console.log(`room ${room.id} lights after switch-off: ${lit}`);
    if (lit !== false) ok = false;
  }
  clearInterval(keep);
  // teammate down: corpse + revive ring + prompt, then a medkit revive with E
  await ev(page, `__game.teleport(${sp[0]}, ${sp[2] - 1.6}, 0)`);
  await sleep(400);
  await ev(page, `__game.dbg('interaction.kill', { pid: '${mate.me}', killer: 'MANNEQUIN', reason: 'moved while nobody was watching' })`);
  await sleep(800);
  await ev(page, `__ix.aim(${sp[0]}, 0.2, ${sp[2]})`);
  await sleep(600);
  const tb = await ev<{ id: string; view?: { text: string } } | null>(page, '__ix.target()');
  console.log('body target:', JSON.stringify(tb?.view ?? tb));
  await screenshot(page, `${OUT}/v5-teammate-down.png`);
  await ev(page, `__game.dbg('interaction.give', { type: 'medkit' })`);
  await sleep(500);
  const tb2 = await ev<{ id: string; view?: { text: string } } | null>(page, '__ix.target()');
  await ev(page, `__game.setInput({ interact: true })`);
  await sleep(900);
  const stR = await ev<{ dead: string[] }>(page, '__ix.state()');
  console.log(`medkit revive via E (${tb2?.view?.text}): ${!stR.dead.includes(mate.me)}`);
  if (stR.dead.includes(mate.me)) ok = false;
  // glowstick dropped in the darkened room (emissive marker + floor halo, no light source)
  if (room) {
    const r = room.rect;
    await ev(page, `__game.dbg('interaction.give', { type: 'glowstick' })`);
    await sleep(400);
    const slot = (await ev<(string | null)[]>(page, '__ix.inventory()')).indexOf('glowstick');
    await ev(page, `__game.setInput({ slot: ${slot} })`);
    await ev(page, `__game.teleport(${r.x + r.w / 2}, ${r.y + 1.0}, 0)`);
    await sleep(400);
    await ev(page, `__ix.aim(${r.x + r.w / 2}, 0, ${r.y + 2.2})`);
    await ev(page, '__ix.flashlight(false)');
    await sleep(300);
    await ev(page, `__game.setInput({ use: true })`);
    await sleep(900);
    const glows = Object.keys((await ev<{ glows: Record<string, unknown> }>(page, '__ix.state()')).glows).length;
    console.log(`glowsticks on the floor: ${glows}`);
    if (glows < 1) ok = false;
    await screenshot(page, `${OUT}/v6-glowstick-dark-room.png`);
  }
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
