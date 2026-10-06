// Track ② Level: geometry screenshots. Needs a dev server: PORT=3002 npm run dev, then
//   node tests/level/screens.e2e.ts            (BASE_URL defaults to http://127.0.0.1:3002)
// Writes tests/artifacts/level_<fixture>_<n>.png (3 camera positions for the hub + 2 facilities).
// LIGHT=0 skips the debug fill light (shows the real ③ lighting); SEEDS='s2:4,s3:6' picks facilities.
// Resilient to Vite page reloads (other tracks editing): re-joins and retries each shot.
import type { Page } from 'playwright-core';
import { launchPlayer, screenshot, waitForGame } from '../lib/launch.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';

type V3 = [number, number, number];
interface Dbg {
  camera(p: V3 | null, t?: V3): void; info(): Record<string, unknown>; texturesReady(): boolean;
  setDoorOpen(id: number, open: boolean, instant?: boolean): void; ceilings(on: boolean): void; cull(on: boolean): void;
}
declare global { interface Window { __levelDebug?: Dbg } }

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3002';
const LIGHT = process.env.LIGHT !== '0';
const CREW = process.env.CREW ?? 'LVLS';
const SETTLE = Number(process.env.SETTLE ?? 3000);
const FAC = (process.env.SEEDS ?? 's2:4,s3:6').split(',').map((s) => { const [seed, p] = s.split(':'); return { seed, players: Number(p ?? 4) }; });

interface View { p: V3; t: V3; open?: number[] }

/** camera views for a facility: lot -> facade + entrance, the longest corridor, the vault door */
function facilityViews(L: LevelLayout): View[] {
  const views: View[] = [];
  const exit = L.doors.find((d) => d.kind === 'exit')!;
  const ex = exit.x + exit.len / 2, ez = exit.y;
  views.push({ p: [ex + 3.5, 1.7, ez + 9.5], t: [ex, 1.8, ez], open: [exit.id] });
  const cor = L.spaces.filter((s) => s.kind === 'corridor' && s.type !== 'junction').sort((a, b) => Math.max(b.rect.w, b.rect.h) - Math.max(a.rect.w, a.rect.h))[0];
  if (cor) {
    const r = cor.rect;
    views.push(r.w >= r.h
      ? { p: [r.x + 0.6, 1.62, r.y + r.h / 2], t: [r.x + r.w, 1.5, r.y + r.h / 2] }
      : { p: [r.x + r.w / 2, 1.62, r.y + 0.6], t: [r.x + r.w / 2, 1.5, r.y + r.h] });
  }
  const vd = L.doors.find((d) => d.kind === 'vault')!;
  const vault = L.spaces.find((s) => s.kind === 'vault')!;
  const vx = vd.dir === 'h' ? vd.x + vd.len / 2 : vd.x, vz = vd.dir === 'h' ? vd.y : vd.y + vd.len / 2;
  const inVault = (x: number, z: number) => x >= vault.rect.x && z >= vault.rect.y && x < vault.rect.x + vault.rect.w && z < vault.rect.y + vault.rect.h;
  const dirs: [number, number][] = vd.dir === 'h' ? [[0, 1], [0, -1]] : [[1, 0], [-1, 0]];
  const [dx, dz] = dirs.find(([a, b]) => !inVault(vx + a * 0.5, vz + b * 0.5))!;
  // stand in the corridor 1.5 m off the wall, a little to the side, looking at the round door
  views.push({ p: [vx + dx * 1.5 + dz * 2.6, 1.6, vz + dz * 1.5 + dx * 2.6], t: [vx, 1.15, vz] });
  return views;
}

function hubViews(L: LevelLayout): View[] {
  const v = L.van;
  const k = L.spaces.find((s) => s.type === 'kennel')!.rect;
  return [
    { p: [v.x - 2.5, 1.65, v.cab.y - 4.8], t: [v.x, 1.2, v.z] },
    { p: [k.x + k.w + 1, 1.7, k.y - 3.5], t: [k.x + k.w / 2, 0.8, k.y + k.h / 2] },
    { p: [v.x + 4.5, 1.65, v.cab.y - 1], t: [v.x + 1.3, 1.3, v.cab.y + 1.8] },
  ];
}

const player = await launchPlayer({ name: 'LevelCam', baseUrl: BASE, crew: CREW, query: LIGHT ? { levelLight: '1', nobright: '1' } : { nobright: '1' } });
const page = player.page;

/** joined + showing the wanted layout (hub, or facility seed) with textures and prop models loaded */
async function ensure(want: { seed: string; players: number } | null): Promise<LevelLayout> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await waitForGame(page, 60_000);
      if (!(await page.evaluate(() => window.__game!.me()))) {
        await page.evaluate((c) => window.__game!.join(c), CREW);
        await page.waitForFunction(() => window.__game?.me() != null, undefined, { timeout: 30_000 });
      }
      const info = await page.evaluate(() => window.__levelDebug?.info() as { kind?: string; seed?: string } | undefined);
      const ok = want ? info?.kind === 'facility' && info.seed === want.seed : info?.kind === 'hub';
      if (!ok) {
        if (want) console.log('generated', JSON.stringify(await page.evaluate((a) => window.__game!.dbg('level.generate', a), { ...want, risk: 1 })).slice(0, 160));
        else await page.evaluate(() => window.__game!.dbg('level.hub', {}));
      }
      await page.waitForFunction((w) => {
        const i = window.__levelDebug?.info() as { kind?: string; seed?: string } | undefined;
        return !!i && (w ? i.kind === 'facility' && i.seed === w : i.kind === 'hub') && window.__levelDebug!.texturesReady();
      }, want?.seed ?? null, { timeout: 60_000, polling: 200 });
      await page.waitForTimeout(SETTLE);
      return (await page.evaluate(() => (window as unknown as { __netDebug?: { layout(): unknown } }).__netDebug?.layout() ?? null)) as LevelLayout;
    } catch (e) {
      console.log('ensure retry', attempt, String(e).slice(0, 140));
      await page.waitForTimeout(2000);
    }
  }
  throw new Error(`could not establish ${want?.seed ?? 'hub'}`);
}

async function shoot(want: { seed: string; players: number } | null, name: string, v: View): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await ensure(want);
      await page.evaluate((vv) => {
        const d = window.__levelDebug!;
        d.ceilings(true); d.cull(true);
        for (const id of vv.open ?? []) d.setDoorOpen(id, true, true);
        d.camera(vv.p, vv.t);
      }, v);
      await page.waitForTimeout(500);
      console.log('wrote', await screenshotOnce(name));
      return;
    } catch (e) { console.log('shot retry', name, String(e).slice(0, 140)); }
  }
  console.log('FAILED', name);
}

async function screenshotOnce(name: string): Promise<string> {
  return screenshot(page, `tests/artifacts/${name}.png`);
}

try {
  const hub = await ensure(null);
  let n = 1;
  for (const v of hubViews(hub)) await shoot(null, `level_hub_${n++}`, v);
  for (const f of FAC) {
    const L = await ensure(f);
    n = 1;
    for (const v of facilityViews(L)) await shoot(f, `level_${f.seed}_p${f.players}_${n++}`, v);
  }
  console.log('client errors:', JSON.stringify((await page.evaluate(() => window.__game!.errors())).slice(0, 10)));
  console.log('page errors:', JSON.stringify(player.errors.filter((e) => !e.includes('http 404')).slice(0, 10)));
} finally {
  await player.close();
}
void (null as unknown as Page);
