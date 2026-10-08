// Owner: env-paranormal (v1.2). Screenshots of every MUST paranormal kind, fired via dbg.paranormal.fire in one browser
// session (one guarded run): the mirror figure, mirror writing, the silhouette, the dark walk mid-sequence, the beam
// shadow (presence), wet footprints and a cold spot; draw-call deltas and client diagnostics. Under the guard's
// software lane (DEADAIR_RENDER=swiftshader: ?webgl=1&preset=low, 960x540) it judges logic and layout, not lighting.
//   BASE_URL=http://127.0.0.1:3814 node tools/gpu-guard.mjs --max-sec 120 -- node tests/paranormal/shots.e2e.ts
// Output: $PARA_SHOTS (default <os tmp>/dead-air-paranormal-shots)/*.png + report.json
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import type { ParanormalEvent } from '../../packages/shared/src/messages/paranormal.ts';
import { mirrorsOf } from '../../packages/shared/src/procgen/mirrors.ts';
import { buildEdgeGrid, initialDoorOpen, los } from '../../packages/shared/src/nav/index.ts';
import { doorCenter, doorNormal, fixturesOf, indoor, spaceAtXZ } from '../../apps/server/src/paranormal/gates.ts';
import { SOFTWARE, launchPlayer, shot } from './browser.ts';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3814';
const OUT = process.env.PARA_SHOTS ?? join(tmpdir(), 'dead-air-paranormal-shots');
const T0 = performance.now();
const elapsed = () => (performance.now() - T0) / 1000;
const BUDGET = Number(process.env.PARA_BUDGET_SEC ?? 108);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.max(0, ms)));
const report: Record<string, unknown> = { views: {} as Record<string, unknown> };
const views = report.views as Record<string, Record<string, unknown>>;

type W = Window & {
  __game?: { dbg(r: string, a?: unknown): Promise<unknown>; req?(r: string, a?: unknown): Promise<unknown>; me(): string | null; ready(): boolean; backend(): string; teleport(x: number, z: number, yaw?: number): void; look(y: number, p: number): void; state(): unknown; perf(): { drawCalls?: number; fps: number }; errors(): string[] };
  __paranormal?: { diag(): Record<string, unknown>; effects(): { id: number; kind: string }[]; setFlashlight(on: boolean): void; flashlightOn(): boolean | null; mirrors(): { item: string; live: boolean }[]; levelReady(): boolean; contentReady(): boolean | null };
};

const p = await launchPlayer({ baseUrl: BASE, crew: 'PSHOT', name: 'Cam', query: { autojoin: '1', autoq: '0', preset: 'ultra' }, viewport: SOFTWARE ? { width: 960, height: 540 } : undefined });
report.software = SOFTWARE;
const page = p.page;
const dbg = <T = unknown,>(r: string, a: unknown = {}) => page.evaluate(([r2, a2]) => (window as unknown as W).__game!.dbg(r2 as string, a2), [r, a] as const) as Promise<T>;
const hook = <T,>(name: 'diag' | 'effects' | 'flashlightOn' | 'mirrors' | 'levelReady' | 'contentReady') => page.evaluate((n) => ((window as unknown as W).__paranormal as unknown as Record<string, () => unknown>)[n](), name) as Promise<T>;
const draws = () => page.evaluate(() => (window as unknown as W).__game!.perf().drawCalls ?? -1);
const serverNow = async () => (await dbg<{ pong: number }>('ping')).pong;
const myPos = () => page.evaluate(() => {
  const s = (window as unknown as W).__game!.state() as { me: string; players: { id: string; p: number[] }[] };
  return s.players.find((q) => q.id === s.me)?.p ?? [0, 0, 0];
});

try {
  await page.waitForFunction(() => (window as unknown as W).__game?.ready() === true && !!(window as unknown as W).__game?.me(), undefined, { timeout: 45_000, polling: 200 });
  report.backend = await page.evaluate(() => (window as unknown as W).__game!.backend());
  report.joinedSec = +elapsed().toFixed(1);
  report.layout = await dbg('objectives.start', { seed: 'para-shots-2', players: 2, realSec: 900 });
  await page.waitForFunction(() => (window as unknown as W).__paranormal?.levelReady() === true, undefined, { timeout: 40_000, polling: 200 });
  await page.waitForFunction(() => (window as unknown as W).__paranormal?.contentReady() !== false, undefined, { timeout: 15_000, polling: 250 }).catch(() => null);
  report.levelSec = +elapsed().toFixed(1);
  await dbg('net.validate', { on: false }).catch(() => null);
  await sleep(2600); // the monsters auto-start after 2.5 s
  await dbg('monsters.freeze', { on: true }).catch(() => null);
  const ms0 = await dbg<{ agents?: { id: string }[] }>('monsters.state').catch(() => ({ agents: [] }));
  for (const a of ms0.agents ?? []) await dbg('monsters.place', { id: a.id, active: false, x: 0.5, z: 0.5 }).catch(() => null);
  const lay = ((await page.evaluate(() => (window as unknown as W).__game!.req!('level.get', {}))) as { layout: LevelLayout }).layout;
  const g = buildEdgeGrid(lay);
  const open0 = initialDoorOpen(lay);
  const me = await page.evaluate(() => (window as unknown as W).__game!.me());

  const look = (yaw: number, pitch: number) => page.evaluate(([y, p2]) => (window as unknown as W).__game!.look(y, p2), [yaw, pitch] as const);
  const go = async (x: number, z: number, yaw: number, pitch = 0) => {
    await page.evaluate(([x2, z2, y2, p2]) => { const gg = (window as unknown as W).__game!; gg.teleport(x2, z2, y2); gg.look(y2, p2); }, [x, z, yaw, pitch] as const);
    await dbg('net.teleport', { x, z, yaw }).catch(() => null);
  };
  /** teleport through the spots until the server places `kind` for us; returns the event and the draws before it */
  const fire = async (kind: string, spots: [number, number, number, number?][], patch?: Record<string, unknown>, max = 50): Promise<{ e: ParanormalEvent; before: number } | null> => {
    for (const [x, z, yaw, pitch] of spots.slice(0, max)) {
      if (elapsed() > BUDGET) return null;
      await go(x, z, yaw, pitch ?? 0);
      await sleep(130);
      await dbg('paranormal.tune', { clearBudgets: true, lastAgoSec: 60 });
      const before = await draws();
      const r = await dbg<{ ok: boolean; ev?: ParanormalEvent; reason?: string }>('paranormal.fire', { kind, target: me, force: true, patch });
      if (r.ok && r.ev) return { e: r.ev, before };
      const why = (views[viewOf[kind] ?? kind] ??= {}) as Record<string, unknown>;
      why.tries = Number(why.tries ?? 0) + 1;
      why.why = r.reason ?? '?';
    }
    return null;
  };
  const viewOf: Record<string, string> = { mirror_figure: 'figure', mirror_writing: 'writing', dark_walk: 'darkwalk', cold_spot: 'cold' };
  const sp = (x: number, z: number) => lay.spaces[spaceAtXZ(lay, x, z)];
  const cells: [number, number][] = [];
  for (let c = 0; c < lay.owner.length; c++) {
    const s = lay.owner[c];
    if (s >= 0 && indoor(lay, s)) cells.push([(c % lay.W) + 0.5, Math.floor(c / lay.W) + 0.5]);
  }
  const spread = (n: number, filter: (x: number, z: number) => boolean): [number, number, number][] => {
    const ok = cells.filter(([x, z]) => filter(x, z));
    const out: [number, number, number][] = [];
    const step = Math.max(1, Math.floor(ok.length / n));
    for (let i = 0; i < ok.length && out.length < n; i += step) out.push([ok[i][0], ok[i][1], (i % 4) * (Math.PI / 2)]);
    return out;
  };
  const yawTo = (x: number, z: number, tx: number, tz: number) => Math.atan2(tx - x, tz - z);
  const litSp = (x: number, z: number) => { const s = sp(x, z); return !!s && s.powerZone === 0 && (s.light === 'on' || s.light === 'flicker'); };
  const darkSp = (x: number, z: number) => { const s = sp(x, z); return !!s && (s.powerZone !== 0 || s.light === 'off' || s.light === 'broken'); };
  const view = async (name: string, fn: () => Promise<void>) => {
    views[name] ??= {};
    if (elapsed() > BUDGET) { views[name].skipped = 'time'; return; }
    const t = elapsed();
    try { await fn(); } catch (e) { views[name].error = String(e); }
    views[name].sec = +(elapsed() - t).toFixed(1);
  };
  const ms = mirrorsOf(lay).filter((m) => m.kind !== 'van' && indoor(lay, m.space));
  report.mirrors = ms.map((m) => `${m.id}:${m.kind}`);

  // ---------------- mirror figure (live mirror: ?autoq=0 keeps the live reflection; Low: fog + a handprint) ----------------
  let figMirror = '';
  await view('figure', async () => {
    const spots = ms.flatMap((m) => [1.8, 2.5].map((d) => [m.x + Math.sin(m.rot) * d, m.z + Math.cos(m.rot) * d, m.rot + Math.PI, -0.03] as [number, number, number, number]));
    const f = await fire('mirror_figure', spots, { holdMs: 7000 });
    if (!f) { views.figure.error = 'no placement'; return; }
    figMirror = String(f.e.ref ?? '');
    await sleep(f.e.at - (await serverNow()) + 900);
    views.figure.live = await hook('mirrors');
    await shot(page, join(OUT, 'figure.png'));
    await sleep(1400);
    await shot(page, join(OUT, 'figure-print.png'));
    await look(f.e.yaw! + Math.PI + 0.06, -0.06);
    await sleep(500);
    await shot(page, join(OUT, 'figure-b.png'));
    Object.assign(views.figure, { id: f.e.id, mirrors: f.e.data!.mirrors, effects: await hook('effects'), before: f.before, during: await draws() });
  });

  // ---------------- mirror writing ----------------
  await view('writing', async () => {
    // another glass than the figure's handprint when there is one
    const order = [...ms.filter((m) => m.id !== figMirror), ...ms.filter((m) => m.id === figMirror)];
    const spots = order.flatMap((m) => [2.4, 3.2].map((d) => [m.x + Math.sin(m.rot) * d, m.z + Math.cos(m.rot) * d, m.rot] as [number, number, number]));
    const f = await fire('mirror_writing', spots);
    if (!f) { views.writing.error = 'no placement'; return; }
    const m = ms.find((q) => q.id === f.e.ref)!;
    const mp = await myPos();
    await look(yawTo(mp[0], mp[2], m.x, m.z), -0.05);
    const t0 = await serverNow();
    await sleep(2400);
    views.writing.diagEarly = await hook('diag');
    await sleep(Math.max(0, f.e.at + 4300 - (await serverNow())));
    await shot(page, join(OUT, 'writing.png'));
    await sleep(800);
    await shot(page, join(OUT, 'writing-b.png'));
    Object.assign(views.writing, { id: f.e.id, text: f.e.data!.text, mirror: f.e.ref, kind: m.kind, firedAt: f.e.at, lookAt: t0, live: await hook('mirrors') });
  });

  // ---------------- silhouette (far end of a lit corridor, looking down it) ----------------
  await view('silhouette', async () => {
    // corridor cells looking along an axis with a 9-20 m line of sight that ends where the corridor does
    const spots: [number, number, number, number][] = [];
    const axes: [number, number][] = [[0, 1], [1, 0], [0, -1], [-1, 0]];
    for (let i = 0; i < cells.length; i += 2) {
      const [x, z] = cells[i];
      const s0 = spaceAtXZ(lay, x, z);
      if (lay.spaces[s0]?.kind !== 'corridor' || !litSp(x, z)) continue;
      for (const [ax, az] of axes) {
        for (let k = 9; k <= 20; k++) {
          const ex = x + ax * k, ez = z + az * k;
          const se = spaceAtXZ(lay, ex, ez);
          if (se < 0 || lay.spaces[se]?.kind !== 'corridor' || !litSp(ex, ez)) continue;
          if (spaceAtXZ(lay, ex + ax, ez + az) === se) continue;
          if (!los(g, x, z, ex, ez, open0)) break;
          spots.push([x, z, Math.atan2(ax, az), 0.02]);
          break;
        }
      }
    }
    views.silhouette.candidates = spots.length;
    const f = await fire('silhouette', spots.filter((_, i) => i % Math.max(1, Math.floor(spots.length / 20)) === 0), { holdMs: 8000, approachM: 1.0 }, 20);
    if (!f) { views.silhouette.error = 'no placement'; return; }
    const mp = await myPos();
    await look(yawTo(mp[0], mp[2], f.e.p![0], f.e.p![2]), 0.02);
    await sleep(f.e.at - (await serverNow()) + 450);
    await shot(page, join(OUT, 'silhouette.png'));
    Object.assign(views.silhouette, { id: f.e.id, room: f.e.data!.room, dist: +Math.hypot(f.e.p![0] - mp[0], f.e.p![2] - mp[2]).toFixed(1), before: f.before, during: await draws() });
  });

  // ---------------- dark walk mid-sequence ----------------
  await view('darkwalk', async () => {
    const corr = spread(30, (x, z) => litSp(x, z) && sp(x, z)?.kind === 'corridor');
    const halls = spread(30, (x, z) => litSp(x, z) && sp(x, z)?.kind !== 'corridor');
    const f = await fire('dark_walk', [...corr, ...halls], { interf: false });
    if (!f) { views.darkwalk.error = 'no placement'; return; }
    const e = f.e;
    const ids = e.data!.lights as string[];
    const fx = new Map(fixturesOf(lay).map((q) => [q.id, q]));
    const mp = await myPos();
    // look at the fixtures that die during the shots and that we can see
    const seenFx = ids.map((id, k) => ({ f: fx.get(id)!, k })).filter((q) => q.f && los(g, mp[0], mp[2], q.f.x, q.f.z, open0));
    const pick = seenFx.length ? seenFx[Math.floor(seenFx.length / 2)].f : { x: e.p![0], z: e.p![2] };
    const d = Math.hypot(pick.x - mp[0], pick.z - mp[2]);
    await look(yawTo(mp[0], mp[2], pick.x, pick.z), Math.max(0.06, Math.min(0.4, Math.atan2(1.3, Math.max(1, d)))));
    const step = Number(e.data!.stepMs), T = (ids.length - 1) * step;
    const at = (k: number) => e.at + T * k;
    for (const [k, name] of [[0.05, 'darkwalk-00'], [0.35, 'darkwalk-35'], [0.65, 'darkwalk-65'], [1.05, 'darkwalk-100']] as [number, string][]) {
      await sleep(at(k) - (await serverNow()));
      await shot(page, join(OUT, `${name}.png`));
    }
    Object.assign(views.darkwalk, { id: e.id, fixtures: ids.length, visible: seenFx.length, stepMs: step, spaces: e.data!.spaces, before: f.before, during: await draws() });
  });

  // ---------------- the beam shadow (presence) ----------------
  await view('presence', async () => {
    await page.evaluate(() => (window as unknown as W).__paranormal?.setFlashlight(true));
    const f = await fire('presence', spread(60, darkSp), { litMs: 9000, approachM: 1.0 });
    if (!f) { views.presence.error = 'no placement'; return; }
    const mp = await myPos();
    await look(yawTo(mp[0], mp[2], f.e.p![0], f.e.p![2]), -0.16);
    await sleep(f.e.at - (await serverNow()) + 500);
    await shot(page, join(OUT, 'presence.png'));
    Object.assign(views.presence, { id: f.e.id, tier: f.e.tier, light: await hook('flashlightOn'), before: f.before, during: await draws() });
  });

  // ---------------- footprints ----------------
  await view('footprints', async () => {
    await page.evaluate(() => (window as unknown as W).__paranormal?.setFlashlight(true));
    const f = await fire('footprints', spread(40, litSp));
    if (!f) { views.footprints.error = 'no placement'; return; }
    const pts = f.e.data!.pts as number[][];
    const mp = await myPos();
    const near = pts[Math.max(0, pts.length - 4)];
    const dd = Math.hypot(near[0] - mp[0], near[1] - mp[2]);
    await look(yawTo(mp[0], mp[2], near[0], near[1]), -Math.atan2(1.6, Math.max(0.8, dd)));
    await sleep(f.e.at + pts.length * Number(f.e.data!.stepMs) - (await serverNow()) + 300);
    await shot(page, join(OUT, 'footprints.png'));
    Object.assign(views.footprints, { id: f.e.id, prints: pts.length, before: f.before, during: await draws() });
  });

  // ---------------- cold spot ----------------
  await view('cold', async () => {
    const f = await fire('cold_spot', spread(30, litSp));
    if (!f) { views.cold.error = 'no placement'; return; }
    const mp = await myPos();
    await look(yawTo(mp[0], mp[2], f.e.p![0], f.e.p![2]), -0.22);
    await sleep(2800);
    await shot(page, join(OUT, 'cold.png'));
    Object.assign(views.cold, { id: f.e.id, r: f.e.data!.r, before: f.before, during: await draws() });
  });

  // ---------------- SHOULD: a prop falls / slides ----------------
  for (const kind of ['object_fall', 'poltergeist'] as const) {
    await view(kind, async () => {
      const f = await fire(kind, spread(40, litSp), undefined, 30);
      if (!f) { views[kind].error = 'no placement'; return; }
      const mp = await myPos();
      const from = f.e.data!.from as number[];
      const dd = Math.hypot(from[0] - mp[0], from[2] - mp[2]);
      await look(yawTo(mp[0], mp[2], from[0], from[2]), -Math.atan2(1.3, Math.max(1, dd)));
      await sleep(f.e.at - (await serverNow()) + f.e.ms * 0.45);
      await shot(page, join(OUT, `${kind}-mid.png`));
      await sleep(f.e.ms * 0.8 + 400);
      await shot(page, join(OUT, `${kind}-end.png`));
      Object.assign(views[kind], { id: f.e.id, key: f.e.data!.key, before: f.before, during: await draws() });
    });
  }

  report.diag = await hook('diag');
  report.gameErrors = await page.evaluate(() => (window as unknown as W).__game!.errors());
} catch (e) {
  report.fatal = String(e instanceof Error ? (e.stack ?? e.message) : e);
} finally {
  report.pageErrors = p.errors.slice(0, 40);
  report.logs = p.logs.slice(0, 40);
  report.sec = +elapsed().toFixed(1);
  try { writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2)); } catch { /* out dir missing */ }
  console.log(JSON.stringify(report, null, 2).slice(0, 8000));
  await p.close();
}
