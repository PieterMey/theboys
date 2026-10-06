// Track ② Level: furnished-room + door screenshots on a generated facility, plus draw-call / build-time numbers.
//   PORT=3503 ... node apps/server/src/index.ts --dev     then
//   BASE_URL=http://127.0.0.1:3503 node tests/level/rooms.e2e.ts
// Env: SEED (default rooms6), PLAYERS (6), LIGHT=0 (real dark rendering + a flashlight-ish camera; default debug fill),
//      ONLY=rooms|doors|perf, OUT (default tests/artifacts/rooms).
// Writes <OUT>/<type>_<n>.png (several rooms per type), door_<kind>_<closed|half|open>.png and prints perf JSON.
import { launchPlayer, screenshot, waitForGame } from '../lib/launch.ts';
import type { LevelLayout, LayoutSpace } from '../../packages/shared/src/layout.ts';

type V3 = [number, number, number];
interface Dbg {
  camera(p: V3 | null, t?: V3): void; info(): Record<string, unknown>; texturesReady(): boolean;
  setDoorOpen(id: number, open: boolean, instant?: boolean): void; ceilings(on: boolean): void; cull(on: boolean): void;
  doorPose(id: number, t: number): boolean; renderInfo(): Record<string, unknown>;
}
type WinDbg = { __levelDebug?: Dbg };

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3503';
const LIGHT = process.env.LIGHT !== '0';
const SEED = process.env.SEED ?? 'rooms6';
const PLAYERS = Number(process.env.PLAYERS ?? 6);
const ONLY = process.env.ONLY ?? '';
const OUT = process.env.OUT ?? `tests/artifacts/rooms${LIGHT ? '' : '_dark'}`;
const CREW = process.env.CREW ?? 'LVRM';
const TYPES = (process.env.TYPES ?? 'canteen,chapel,server,boiler,morgue,storage,library,office,kitchen,laundry,infirmary,garage,dock,tanks,archive,lobby').split(',');

const player = await launchPlayer({ name: 'RoomCam', baseUrl: BASE, crew: CREW, viewport: { width: 1280, height: 720 }, query: LIGHT ? { levelLight: '1', nobright: '1' } : { nobright: '1' } });
const page = player.page;
await page.routeWebSocket(/token=/, () => {}); // no Vite HMR reloads while other agents edit
await page.reload({ waitUntil: 'domcontentloaded' });

async function ensure(): Promise<LevelLayout> {
  await waitForGame(page, 90_000);
  if (!(await page.evaluate(() => window.__game!.me()))) {
    await page.evaluate((c) => window.__game!.join(c), CREW);
    await page.waitForFunction(() => window.__game?.me() != null, undefined, { timeout: 60_000 });
  }
  const t0 = Date.now();
  const gen = await page.evaluate((a) => window.__game!.dbg('level.generate', a), { seed: SEED, players: PLAYERS, risk: 1 });
  console.log('generated', JSON.stringify(gen).slice(0, 300));
  await page.waitForFunction((w) => {
    const i = (window as unknown as WinDbg).__levelDebug?.info() as { kind?: string; seed?: string } | undefined;
    return !!i && i.kind === 'facility' && i.seed === w && (window as unknown as WinDbg).__levelDebug!.texturesReady();
  }, SEED, { timeout: 90_000, polling: 200 });
  console.log('level ready after', Date.now() - t0, 'ms; info', JSON.stringify(await page.evaluate(() => (window as unknown as WinDbg).__levelDebug!.info())));
  await page.waitForTimeout(2500);
  return (await page.evaluate(() => (window as unknown as { __netDebug?: { layout(): unknown } }).__netDebug?.layout() ?? null)) as LevelLayout;
}

async function shot(name: string, p: V3, t: V3): Promise<void> {
  await page.evaluate(([pp, tt]) => { const d = (window as unknown as WinDbg).__levelDebug!; d.ceilings(true); d.cull(true); d.camera(pp, tt); }, [p, t] as [V3, V3]);
  await page.waitForTimeout(700);
  console.log('wrote', await screenshot(page, `${OUT}/${name}.png`));
}

/** camera in a room corner (inset 0.9 m), eye height, looking across the room */
function roomViews(s: LayoutSpace): { p: V3; t: V3 }[] {
  const r = s.rect;
  const cx = r.x + r.w / 2, cz = r.y + r.h / 2;
  const v: { p: V3; t: V3 }[] = [];
  v.push({ p: [r.x + 0.9, 1.65, r.y + 0.9], t: [cx + r.w * 0.2, 1.0, cz + r.h * 0.2] });
  v.push({ p: [r.x + r.w - 0.9, 1.7, r.y + r.h - 0.9], t: [cx - r.w * 0.2, 0.9, cz - r.h * 0.2] });
  return v;
}

try {
  const L = await ensure();
  if (!ONLY || ONLY === 'perf') {
    // draw calls: from the lot looking at the facade, and inside the biggest hall
    const exit = L.doors.find((d) => d.kind === 'exit')!;
    const ex = exit.x + exit.len / 2, ez = exit.y;
    await page.evaluate((id) => (window as unknown as WinDbg).__levelDebug!.setDoorOpen(id, true, true), exit.id);
    const perf: Record<string, unknown> = {};
    for (const [name, p, t] of [
      ['lot', [ex + 3.5, 1.7, ez + 9.5], [ex, 1.8, ez]],
      ['lobby', [ex, 1.65, ez - 1.2], [ex, 1.4, ez - 6]],
      ...L.spaces.filter((s) => s.kind === 'hall').sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h).slice(0, 2)
        .map((s, i) => [`hall${i}:${s.callsign}`, [s.rect.x + 1, 1.65, s.rect.y + 1], [s.rect.x + s.rect.w / 2, 1.0, s.rect.y + s.rect.h / 2]]),
    ] as [string, V3, V3][]) {
      await page.evaluate(([pp, tt]) => (window as unknown as WinDbg).__levelDebug!.camera(pp, tt), [p, t] as [V3, V3]);
      await page.waitForTimeout(900);
      perf[name] = await page.evaluate(() => {
        const g = window.__game as unknown as { diag?: () => Record<string, unknown> };
        return { ...(window as unknown as WinDbg).__levelDebug!.renderInfo(), fps: (g.diag?.() as { fps?: number } | undefined)?.fps };
      });
      await screenshot(page, `${OUT}/perf_${name.replace(/[:]/g, '_')}.png`);
    }
    console.log('PERF', JSON.stringify(perf));
  }
  if (!ONLY || ONLY === 'rooms') {
    for (const type of TYPES) {
      const rooms = L.spaces.filter((s) => (s.kind === 'room' || s.kind === 'hall') && s.type === type).slice(0, 2);
      let n = 1;
      for (const s of rooms) for (const v of roomViews(s).slice(0, rooms.length > 1 ? 1 : 2)) await shot(`${type}_${s.callsign}_${n++}`, v.p, v.t);
    }
    const cor = L.spaces.filter((s) => s.kind === 'corridor' && s.type !== 'junction').sort((a, b) => Math.max(b.rect.w, b.rect.h) - Math.max(a.rect.w, a.rect.h)).slice(0, 2);
    let k = 1;
    for (const c of cor) {
      const r = c.rect;
      if (r.w >= r.h) await shot(`corridor_${k++}`, [r.x + 0.6, 1.62, r.y + r.h / 2], [r.x + r.w, 1.7, r.y + r.h / 2]);
      else await shot(`corridor_${k++}`, [r.x + r.w / 2, 1.62, r.y + 0.6], [r.x + r.w / 2, 1.7, r.y + r.h]);
    }
  }
  if (!ONLY || ONLY === 'doors') {
    for (const kind of ['door', 'fire', 'exit', 'security', 'locked', 'vault', 'blocked']) {
      const d = L.doors.find((dd) => dd.kind === kind && (kind !== 'door' || dd.len >= 1));
      if (!d) { console.log('no door of kind', kind); continue; }
      const cx = d.dir === 'h' ? d.x + d.len / 2 : d.x, cz = d.dir === 'h' ? d.y : d.y + d.len / 2;
      // look from the side the door swings into AND from the other side (diagonal, 2.4 m off)
      for (const side of [1, -1]) {
        const lat = Math.min(1.3, d.len / 2 - 0.45);
        // stay inside the space on that side: 1.4 m into a corridor (2 m wide), 2.4 m into a room
        const sx = d.dir === 'h' ? Math.floor(cx + lat) : Math.floor(cx + side * 0.5), sz = d.dir === 'h' ? Math.floor(cz + side * 0.5) : Math.floor(cz + lat);
        const sp = L.spaces[L.owner[sz * L.W + sx]];
        const off = sp && sp.kind === 'corridor' ? 1.4 : 2.4;
        const p: V3 = d.dir === 'h' ? [cx + lat, 1.6, cz + side * off] : [cx + side * off, 1.6, cz + lat];
        for (const [label, t] of [['closed', 0], ['half', 0.5], ['open', 1]] as const) {
          await page.evaluate(([id, tt]) => (window as unknown as WinDbg).__levelDebug!.doorPose(id, tt), [d.id, t] as [number, number]);
          await shot(`door_${kind}_${side > 0 ? 'A' : 'B'}_${label}`, p, [cx, 0.8, cz]);
        }
      }
    }
  }
  console.log('client errors:', JSON.stringify((await page.evaluate(() => window.__game!.errors())).slice(0, 10)));
  console.log('page errors:', JSON.stringify(player.errors.filter((e) => !e.includes('http 404')).slice(0, 10)));
} finally {
  await player.close();
}
