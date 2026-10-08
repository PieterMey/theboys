// Owner: track (c) Monsters. Screenshots of each monster in a test room (lit, then lights off + flashlight) with real
// Chrome/WebGPU. Starts its own dev server on PORT (default 3013) unless BASE_URL is given.
//   node tests/monsters/shots.e2e.ts        -> tests/artifacts/monsters/*.png
import { ANIM } from '../../packages/shared/src/anim.ts';
import { waitForGame } from '../lib/launch.ts';
import { launchStable as launchPlayer, shot as screenshot } from './browser.ts';
import { refuseLive, startServer, sleep } from './bot.ts';

const PORT = Number(process.env.PORT ?? 3013);
refuseLive(PORT, process.env.BASE_URL); // never the live server, before reusing BASE_URL or spawning one
const srv = process.env.BASE_URL ? null : await startServer(PORT);
const base = process.env.BASE_URL ?? srv!.base;
const crew = 'SHOT';
const p = await launchPlayer({ name: 'Cam', baseUrl: base, crew, query: { autojoin: '1' } });
const errors: string[] = [];
try {
  await waitForGame(p.page, 60_000);
  await p.page.waitForFunction(() => window.__game?.me(), undefined, { timeout: 20_000 });
  const dbg = async (r: string, a: unknown = {}): Promise<unknown> => {
    for (let i = 0; ; i++) {
      try {
        return await p.page.evaluate(([r2, a2]) => window.__game!.dbg(r2 as string, a2), [r, a] as const);
      } catch (e) {
        if (i > 40) throw e;
        await sleep(250); // page reloaded by Vite HMR (other tracks editing) or reconnecting
        await p.page.waitForFunction(() => window.__game?.me(), undefined, { timeout: 20_000 }).catch(() => null);
      }
    }
  };
  await dbg('monsters.start', { seed: 'shots-1', players: 2, risk: 2 });
  await p.page.waitForFunction(() => (window.__game?.state() as { phase?: string }).phase === 'contract', undefined, { timeout: 20_000 });
  // the layout is on the client world; read it through a tiny injected accessor
  const pick = await p.page.evaluate(() => {
    const L2 = (window as unknown as { __monstersLayout?: () => unknown }).__monstersLayout?.() as { spaces: { id: number; kind: string; rect: { x: number; y: number; w: number; h: number }; light: string; powerZone: number; callsign: string | null }[] } | null;
    if (!L2) return null;
    const cands = L2.spaces.filter((s) => (s.kind === 'room' || s.kind === 'hall') && s.rect.w >= 6 && s.rect.h >= 5 && s.light === 'on');
    cands.sort((a, b) => a.powerZone - b.powerZone || b.rect.w * b.rect.h - a.rect.w * a.rect.h);
    return cands[0] ?? null;
  });
  if (!pick) throw new Error('no lit test room found (is __monstersLayout exposed?)');
  const r = pick.rect;
  const camX = r.x + 1.0, camZ = r.y + r.h / 2;
  const tx = r.x + 4.2, tz = camZ;
  const yaw = Math.atan2(tx - camX, tz - camZ);
  console.log(`test room ${pick.callsign ?? pick.id} rect ${JSON.stringify(r)}`);
  const far = { x: 0.5, z: 0.5 };
  const setup = async (show: string, anim: number, state: string, myaw: number) => {
    await dbg('monsters.freeze', { on: true });
    for (const id of ['hound0', 'listener0', 'mannequin0']) {
      if (id === show) await dbg('monsters.place', { id, x: tx, z: tz, yaw: myaw, state, active: true, anim });
      else await dbg('monsters.place', { id, x: far.x, z: far.z, active: false, state: 'out', outSec: 999 });
    }
    await sleep(150);
  };
  await p.page.evaluate(([x, z, y]) => { window.__game!.teleport(x, z, y); window.__game!.look(y, -0.12); }, [camX, camZ, yaw] as const);
  await p.page.waitForFunction(() => (window as unknown as { __monsters?: { loaded(): boolean } }).__monsters?.loaded() === true, undefined, { timeout: 30_000 }).catch(() => null);
  await sleep(2500);
  const shots: [string, string, number, string, number][] = [
    ['hound', 'hound0', ANIM.mAlert, 'alert', yaw + Math.PI * 0.75],
    ['hound-walk', 'hound0', ANIM.mWalk, 'investigate', yaw + Math.PI * 0.6],
    ['hound-charge', 'hound0', ANIM.mAttack, 'windup', yaw + Math.PI],
    ['mannequin', 'mannequin0', ANIM.mFrozen, 'frozen', yaw + Math.PI],
    ['mannequin-run', 'mannequin0', ANIM.mRun, 'move', yaw + Math.PI],
    ['listener', 'listener0', ANIM.mIdle, 'ambush', yaw + Math.PI * 0.9],
  ];
  for (const [name, id, anim, state, myaw] of shots) {
    await setup(id, anim, state, myaw);
    await p.page.evaluate(([x, z, y]) => { window.__game!.teleport(x, z, y); window.__game!.look(y, -0.12); }, [camX, camZ, yaw] as const);
    await sleep(1800);
    console.log(`  ${name}: ${JSON.stringify(await p.page.evaluate(() => (window as unknown as { __monsters?: { views(): unknown } }).__monsters?.views()))} snap=${JSON.stringify((await p.page.evaluate(() => (window.__game!.state() as { monsters: unknown[] }).monsters)).length)}`);
    await screenshot(p.page, `tests/artifacts/monsters/${name}-lit.png`);
    await p.page.evaluate((sp) => (window as unknown as { __render?: { setPower(s: number, on: boolean): void } }).__render?.setPower(sp, false), pick.id);
    await sleep(700);
    await screenshot(p.page, `tests/artifacts/monsters/${name}-dark.png`);
    await p.page.evaluate((sp) => (window as unknown as { __render?: { setPower(s: number | 'all', on: boolean): void } }).__render?.setPower('all', true), pick.id);
  }
  errors.push(...p.errors, ...(await p.page.evaluate(() => window.__game!.errors())));
} catch (e) {
  errors.push(`run: ${e instanceof Error ? e.stack ?? e.message : e}`);
} finally {
  await p.close();
  await srv?.stop();
}
console.log(errors.length ? `errors:\n${errors.slice(0, 20).join('\n')}` : 'no errors');
process.exitCode = errors.some((e) => e.startsWith('run:')) ? 1 : 0;
setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
