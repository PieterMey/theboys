// Owner: track (c) Monsters. Browser test of the CLIENT-side mannequin sighting reports: a mannequin in front of the
// camera (in frustum, LOS clear, <= 30 m) stays frozen; when the player looks away it moves. Also the hub's chained
// kennel hound renders in its pen. Real Chrome/WebGPU; screenshots in tests/artifacts/monsters/.
//   node tests/monsters/sight.e2e.ts
import { waitForGame } from '../lib/launch.ts';
import { launchStable as launchPlayer, shot as screenshot } from './browser.ts';
import { refuseLive, startServer, sleep } from './bot.ts';

const PORT = Number(process.env.PORT ?? 3013);
refuseLive(PORT, process.env.BASE_URL); // never the live server, before reusing BASE_URL or spawning one
const srv = process.env.BASE_URL ? null : await startServer(PORT);
const base = process.env.BASE_URL ?? srv!.base;
const results: { name: string; pass: boolean; info: string }[] = [];
const check = (name: string, pass: boolean, info = '') => {
  results.push({ name, pass, info });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`);
};
const p = await launchPlayer({ name: 'Eye', baseUrl: base, crew: 'SGHT', query: { autojoin: '1' } });
interface Ag { id: string; kind: string; x: number; z: number; state: string; active: boolean }
try {
  await waitForGame(p.page, 60_000);
  await p.page.waitForFunction(() => window.__game?.me(), undefined, { timeout: 20_000 });
  const dbg = async <T = unknown>(r: string, a: unknown = {}): Promise<T> => {
    for (let i = 0; ; i++) {
      try { return (await p.page.evaluate(([r2, a2]) => window.__game!.dbg(r2 as string, a2), [r, a] as const)) as T; } catch (e) {
        if (i > 40) throw e;
        await sleep(250);
        await p.page.waitForFunction(() => window.__game?.me(), undefined, { timeout: 20_000 }).catch(() => null);
      }
    }
  };
  // ---- hub: kennel hound ----
  await dbg('monsters.hub');
  await sleep(2500);
  const hub = await dbg<{ agents: Ag[] }>('monsters.state');
  const k = hub.agents.find((a) => a.id === 'kennel');
  check('hub: kennel hound exists', !!k, k ? `${k.state} at ${k.x},${k.z}` : '');
  if (k) {
    await p.page.evaluate(([x, z]) => { const y = Math.atan2(x - 6, z - 10.5) + Math.PI; window.__game!.teleport(6, 10.5, Math.atan2(x - 6, z - 10.5)); void y; }, [k.x, k.z] as const);
    await p.page.evaluate(([x, z]) => window.__game!.look(Math.atan2(x - 6, z - 10.5), -0.2), [k.x, k.z] as const);
    await sleep(2000);
    await screenshot(p.page, 'tests/artifacts/monsters/hub-kennel.png');
    const v = await p.page.evaluate(() => (window as unknown as { __monsters?: { views(): { id: string; model: boolean; visible: boolean }[] } }).__monsters?.views() ?? []);
    check('hub: kennel hound rendered with its model', v.some((x) => x.id === 'kennel' && x.model && x.visible), JSON.stringify(v));
  }
  // ---- contract: mannequin sight reports ----
  await dbg('monsters.start', { seed: 'sight-1', players: 1, risk: 2 });
  await p.page.waitForFunction(() => (window.__game?.state() as { phase?: string }).phase === 'contract', undefined, { timeout: 20_000 });
  await p.page.waitForFunction(() => (window as unknown as { __monsters?: { loaded(): boolean } }).__monsters?.loaded() === true, undefined, { timeout: 30_000 }).catch(() => null);
  const room = await p.page.evaluate(() => {
    const L = (window as unknown as { __monstersLayout?: () => { spaces: { id: number; kind: string; rect: { x: number; y: number; w: number; h: number }; light: string; powerZone: number }[] } | null }).__monstersLayout?.();
    if (!L) return null;
    const c = L.spaces.filter((s) => (s.kind === 'room' || s.kind === 'hall' || s.kind === 'corridor') && Math.max(s.rect.w, s.rect.h) >= 10 && s.light === 'on');
    c.sort((a, b) => a.powerZone - b.powerZone);
    return c[0] ?? null;
  });
  if (!room) throw new Error('no long lit space');
  const r = room.rect;
  const along = r.w >= r.h;
  const cam: [number, number] = along ? [r.x + 0.6, r.y + r.h / 2] : [r.x + r.w / 2, r.y + 0.6];
  const man: [number, number] = along ? [r.x + 8.6, r.y + r.h / 2] : [r.x + r.w / 2, r.y + 8.6];
  const yaw = Math.atan2(man[0] - cam[0], man[1] - cam[1]);
  await dbg('monsters.place', { id: 'hound0', outSec: 999 });
  await dbg('monsters.place', { id: 'listener0', outSec: 999 });
  await p.page.evaluate(([x, z, y]) => { window.__game!.teleport(x, z, y); window.__game!.look(y, -0.05); }, [cam[0], cam[1], yaw] as const);
  // let the new level finish its first (shader-compiling) frames before the mannequin appears
  await p.page.waitForFunction(() => window.__game!.perf().frameMs < 40, undefined, { timeout: 30_000, polling: 250 }).catch(() => null);
  await sleep(1200);
  await dbg('monsters.spawnMannequin', { x: man[0], z: man[1], blinkIn: 120 });
  await sleep(1500);
  const m1 = (await dbg<{ agents: Ag[] }>('monsters.state')).agents.find((a) => a.kind === 'mannequin')!;
  check('mannequin in view (client reports + lit) -> frozen', m1.state === 'frozen' && Math.hypot(m1.x - man[0], m1.z - man[1]) < 0.3, `${m1.state} ${m1.x},${m1.z}`);
  await screenshot(p.page, 'tests/artifacts/monsters/sight-watching.png');
  await p.page.evaluate(([y]) => window.__game!.look(y + Math.PI, -0.05), [yaw] as const);
  await sleep(700);
  const m2 = (await dbg<{ agents: Ag[] }>('monsters.state')).agents.find((a) => a.kind === 'mannequin')!;
  const moved = Math.hypot(m2.x - m1.x, m2.z - m1.z);
  check('look away -> it moves toward you', moved > 1, `${m2.state} moved ${moved.toFixed(2)} m`);
  await p.page.evaluate(([y]) => window.__game!.look(y, -0.05), [yaw] as const);
  await sleep(500);
  await screenshot(p.page, 'tests/artifacts/monsters/sight-closer.png');
  const m3 = (await dbg<{ agents: Ag[] }>('monsters.state')).agents.find((a) => a.kind === 'mannequin')!;
  check('look back -> frozen again (closer)', m3.state === 'frozen' && Math.hypot(m3.x - cam[0], m3.z - cam[1]) < Math.hypot(man[0] - cam[0], man[1] - cam[1]), `${m3.state} at ${Math.hypot(m3.x - cam[0], m3.z - cam[1]).toFixed(1)} m`);
  const errs = [...p.errors, ...(await p.page.evaluate(() => window.__game!.errors()))].filter((e) => /monsters/i.test(e));
  check('no monsters errors in the page', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) {
  check('run', false, e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  await p.close();
  await srv?.stop();
}
const failed = results.filter((x) => !x.pass);
if (failed.length && srv) console.log(srv.log().split('\n').filter((l) => /phase|monsters|objectives|meta/i.test(l)).slice(-25).join('\n'));
console.log(`\nclient sight: ${failed.length ? 'FAILED' : 'PASSED'} ${results.length - failed.length}/${results.length}`);
process.exitCode = failed.length ? 1 : 0;
setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
