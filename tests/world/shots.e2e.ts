// env-world GPU shots: the van (hub exterior from the spawn, rear / front / side, the furnished interior, upgrades,
// the live mirror), facility props (drawers opening, a lore page, a decorative mirror) and the dressed themes. ONE
// browser process, real lighting, a hard time budget; every run goes through the GPU guard:
//   node tools/gpu-guard.mjs --max-sec 120 -- node tests/world/shots.e2e.ts --base http://127.0.0.1:3813 --tag r1 \
//     --parts hub,props,themes:hospital+waterworks
// Writes tests/artifacts/world/<tag>/<name>.png + <tag>.json (renderInfo per view). Resilient to Vite reloads.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { REPO, launchPlayer, waitForGame } from '../lib/launch.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import { clutterFor } from '../../packages/shared/src/procgen/clutter.ts';

type V3 = [number, number, number];
const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const BASE = arg('base', process.env.BASE_URL ?? 'http://127.0.0.1:3813').replace(/\/$/, '');
if (/:(3000|3100)$/.test(BASE)) throw new Error('refusing the live ports');
const TAG = arg('tag', 'look');
const PARTS = arg('parts', 'hub,props,themes:hospital+waterworks+records+cold_storage').split(',');
const BUDGET_S = Number(arg('budget', '108'));
const SEED = arg('seed', 'w1');
const OUT = join(REPO, 'tests/artifacts/world', TAG);
mkdirSync(OUT, { recursive: true });
const T0 = performance.now();
const el = () => (performance.now() - T0) / 1000;
const log = (s: string) => console.log(`[${el().toFixed(1).padStart(6)}s] ${s}`);
const results: Record<string, unknown>[] = [];

interface Dbg {
  camera(p: V3 | null, t?: V3): void; info(): Record<string, unknown>; texturesReady(): boolean; cull(on: boolean): void;
  renderInfo(): Record<string, unknown>; theme(name: string | null): unknown; slotMarkers(on: boolean): number;
  level(): {
    setVanUpgrades(ids: string[]): void; stationObject(k: string): { getObjectByName(n: string): { userData: Record<string, (k: number) => void> } | null } | null;
    containers(): { id: string; prop: string; space: number; p: V3; front: [number, number]; main: number; rot: number; parts: { idx: number; slot: V3 }[] }[];
    setContainerOpen(id: string, mask: number, instant?: boolean): void;
    loreSpots(): { id: string; style: string; p: V3; rot: number; space: number }[];
    setLorePage(id: string, page: unknown): void;
  };
}
/** the page's window as these tests see it (no global augmentation: other e2e files declare their own) */
type WW = { __levelDebug?: Dbg; __netDebug?: { layout(): unknown }; __game?: { me(): string | null; join(c: string): Promise<void>; dbg(r: string, a?: unknown): Promise<unknown>; errors(): string[] } };

// screenshots must not wait on document.fonts (a lore page can trigger a font load mid-run)
process.env.PW_TEST_SCREENSHOT_NO_FONTS_READY = '1';
/** --order props-first: the facility props run (decals, EXIT signs, lore, drawers) before the hub van */
const PROPS_FIRST = arg('order', '') === 'props-first';
const VW = Number(arg('w', '1280')), VH = Number(arg('h', '720'));
/** --flat: the level's debug fill light (?levelLight=1): geometry reads without the light pools (software runs) */
const FLAT = process.argv.includes('--flat');
/** facility seed for the 'slots' part (w14: every container kind, drawer lore pages in a counter and a cabinet) */
const SLOT_SEED = arg('slot-seed', 'w14');
const player = await launchPlayer({ name: 'WorldCam', baseUrl: BASE, crew: 'WRLD', query: { nobright: '1', ...(FLAT ? { levelLight: '1' } : {}) }, viewport: { width: VW, height: VH } });
const page: Page = player.page;

async function ready(want: { kind: 'hub' | 'facility'; theme?: string }, timeout = 45_000): Promise<LevelLayout> {
  await page.waitForFunction((w) => {
    const d = (window as unknown as WW).__levelDebug;
    const i = d?.info() as { kind?: string; theme?: string } | undefined;
    return !!d && !!i && i.kind === w.kind && (!w.theme || i.theme === w.theme) && d.texturesReady();
  }, want, { timeout, polling: 200 });
  return (await page.evaluate(() => (window as unknown as WW).__netDebug?.layout() ?? null)) as LevelLayout;
}

/** what the page should show (re-established after a Vite reload: other builders edit the shared tree) */
let want: { kind: 'hub' | 'facility'; theme?: string } = { kind: 'hub' };
async function recover(): Promise<void> {
  log('recovering after a page reload');
  await waitForGame(page, 45_000);
  if (!(await page.evaluate(() => (window as unknown as WW).__game!.me()))) {
    await page.evaluate(() => (window as unknown as WW).__game!.join('WRLD'));
    await page.waitForFunction(() => (window as unknown as WW).__game?.me() != null, undefined, { timeout: 20_000 });
  }
  try { await ready(want, 15_000); } catch {
    if (want.kind === 'hub') await page.evaluate(() => (window as unknown as WW).__game!.dbg('level.hub', {}));
    else await page.evaluate((a) => (window as unknown as WW).__game!.dbg('level.generate', a), { seed: SEED, players: 4, risk: 1, theme: want.theme });
    await ready(want, 30_000);
  }
}

async function shot(name: string, p: V3, t: V3, settle = 450, before?: () => Promise<void>, retry = true): Promise<void> {
  if (el() > BUDGET_S) { log(`skip ${name} (budget)`); return; }
  try {
    if (before) await before();
    await page.evaluate(([pp, tt]) => { (window as unknown as WW).__levelDebug!.cull(true); (window as unknown as WW).__levelDebug!.camera(pp, tt); }, [p, t] as [V3, V3]);
    await page.waitForTimeout(settle);
    const file = join(OUT, `${name}.png`);
    await page.screenshot({ path: file, timeout: 10_000 });
    const info = await page.evaluate(() => (window as unknown as WW).__levelDebug!.renderInfo());
    results.push({ name, p, t, info });
    log(`wrote ${name}  draws ${(info as { drawCalls?: number }).drawCalls} vis ${(info as { levelMeshesVisible?: number }).levelMeshesVisible}`);
  } catch (e) {
    log(`FAILED ${name}: ${String(e).slice(0, 160)}`);
    if (retry && el() < BUDGET_S - 20) { try { await recover(); await shot(name, p, t, settle, before, false); } catch (e2) { log(`recover failed: ${String(e2).slice(0, 120)}`); } }
  }
}

const centre = (r: { x: number; y: number; w: number; h: number }): [number, number] => [r.x + r.w / 2, r.y + r.h / 2];

try {
  // join (twice at most: a Vite full reload from another builder's edit can land during the first attempt)
  for (let attempt = 0; ; attempt++) {
    try {
      await waitForGame(page, 60_000);
      log('game ready');
      if (!(await page.evaluate(() => (window as unknown as WW).__game!.me()))) {
        await page.evaluate(() => (window as unknown as WW).__game!.join('WRLD'));
        await page.waitForFunction(() => (window as unknown as WW).__game?.me() != null, undefined, { timeout: 30_000 });
      }
      break;
    } catch (e) {
      if (attempt >= 1) throw e;
      log(`join interrupted (${String(e).slice(0, 80)}): once more`);
    }
  }
  const hubShots = async () => {
    want = { kind: 'hub' };
    const cur = await page.evaluate(() => ((window as unknown as WW).__levelDebug?.info() as { kind?: string } | undefined)?.kind ?? null);
    if (cur !== 'hub') await page.evaluate(() => (window as unknown as WW).__game!.dbg('level.hub', {}));
    let L = await ready({ kind: 'hub' }).catch(async () => { await page.evaluate(() => (window as unknown as WW).__game!.dbg('level.hub', {})); return ready({ kind: 'hub' }); });
    log('hub ready');
    const c = L.van.cab;
    const vx = c.x + c.w / 2;
    const sp = L.items.find((i) => i.kind === 'spawn_player')!;
    if (PROPS_FIRST) {
      // short pass (software rendering): the furnished interior, the mirror wall and the truck from the spawn
      await shot('van_interior', [vx, 1.62, c.y + 0.2], [vx, 1.15, c.y + c.h - 0.4], 900);
      await shot('van_mirror', [c.x + 1.35, 1.58, c.y + 0.95], [c.x + 0.08, 1.5, c.y + 0.95], 700);
      await shot('hub_spawn_van', [sp.x, 1.65, sp.z], [vx, 1.3, c.y + 1.5], 900);
      return;
    }
    await shot('hub_spawn_van', [sp.x, 1.65, sp.z], [vx, 1.3, c.y + 1.5], 1500);
    await shot('van_rear34', [vx - 3.4, 1.75, c.y - 4.4], [vx, 1.2, c.y + 1.4]);
    await shot('van_front34', [c.x + c.w + 3.6, 1.6, c.y + c.h + 5.2], [vx, 1.0, c.y + c.h + 1.0]);
    await shot('van_side_left', [c.x - 4.6, 1.5, c.y + 3.2], [c.x + 1, 1.3, c.y + 3.2]);
    await shot('van_interior', [vx, 1.62, c.y + 0.2], [vx, 1.15, c.y + c.h - 0.4]);
    await shot('van_right_wall', [c.x + 0.42, 1.55, c.y + 0.75], [c.x + 1.92, 1.25, c.y + 2.3]);
    await shot('van_left_wall', [c.x + 1.58, 1.55, c.y + 0.5], [c.x + 0.08, 1.3, c.y + 2.0]);
    await shot('van_mirror', [c.x + 1.35, 1.58, c.y + 0.95], [c.x + 0.08, 1.5, c.y + 0.95], 900);
    await shot('van_upgrades', [c.x + 0.55, 1.72, c.y + 0.35], [c.x + 1.55, 1.15, c.y + 2.7], 600, async () => {
      await page.evaluate(() => {
        const lv = (window as unknown as WW).__levelDebug!.level();
        lv.setVanUpgrades(['bench_tools', 'charging_rack', 'scanner', 'stretcher']);
        lv.stationObject('stash')?.getObjectByName('door')?.userData.setOpen?.(1);
        lv.stationObject('workbench')?.getObjectByName('lamp')?.userData.on?.(1);
      });
    });
    await shot('van_roof_scanner', [vx + 3.5, 4.2, c.y + c.h + 2.5], [vx, 2.4, c.y + c.h - 0.5]);
    L = L;
  };
  if (PARTS.includes('hub') && !PROPS_FIRST) await hubShots();
  // v1.2 fix round: every container kind opened, seen from a standing player in its front cell; a bright marker sits
  // at env-layout's slot (where searched items lie); then the counter bay without markers, close up, with a page
  if (PARTS.includes('slots') && el() < BUDGET_S - 10) {
    want = { kind: 'facility', theme: 'facility' };
    await page.evaluate((a) => (window as unknown as WW).__game!.dbg('level.generate', a), { seed: SLOT_SEED, players: 4, risk: 1 });
    await ready({ kind: 'facility', theme: 'facility' }, 40_000);
    await page.evaluate(() => (window as unknown as WW).__game!.dbg('interaction.setLights', { on: true })).catch(() => null);
    log(`slot markers: ${await page.evaluate(() => (window as unknown as WW).__levelDebug!.slotMarkers(true))}`);
    const conts = await page.evaluate(() => (window as unknown as WW).__levelDebug!.level().containers());
    const open = (ci: { id: string; main: number }) => page.evaluate(([id, m]) => (window as unknown as WW).__levelDebug!.level().setContainerOpen(id, m, true), [ci.id, 1 << ci.main] as [string, number]);
    for (const kind of arg('slot-kinds', 'counter,filing,morgue_drawers,cabinet,tool_chest,desk').split(',').filter(Boolean)) {
      const ci = conts.find((k) => k.prop === kind);
      if (!ci) { log(`no ${kind} container on ${SLOT_SEED}`); continue; }
      const slot = ci.parts.find((pp) => pp.idx === ci.main)?.slot ?? ci.p;
      const eye: V3 = [ci.front[0] + 0.5, 1.6, ci.front[1] + 0.5];
      const bx = eye[0] - ci.p[0], bz = eye[2] - ci.p[2], bl = Math.hypot(bx, bz) || 1;
      eye[0] += (bx / bl) * 0.3; eye[2] += (bz / bl) * 0.3;
      await shot(`slot_${kind}`, eye, [slot[0], slot[1] + 0.05, slot[2]], 700, async () => { await open(ci); });
    }
    // close-ups (no markers): every container holding a drawer lore page (the page lies at the slot / measured floor),
    // then a morgue drawer (its door swung aside, the tray out)
    await page.evaluate(() => (window as unknown as WW).__levelDebug!.slotMarkers(false));
    const drawerSpots = (await page.evaluate(() => (window as unknown as WW).__levelDebug!.level().loreSpots())).filter((sp) => sp.style === 'drawer') as unknown as { id: string; container?: string }[];
    const closeUps = [...drawerSpots.map((sp) => ({ ci: conts.find((k) => k.id === sp.container), page: sp.id })), { ci: conts.find((k) => k.prop === 'morgue_drawers'), page: null as string | null }];
    for (const { ci, page: pid } of closeUps) {
      if (!ci) continue;
      if (pid) await page.evaluate((id) => (window as unknown as WW).__levelDebug!.level().setLorePage(id, { visible: true, title: 'SHIFT LOG', text: 'Night shift. The tap in the cold room runs by itself again. Logged it. Nobody answers on the intercom.', glow: 0.3 }), pid);
      const slot = ci.parts.find((pp) => pp.idx === ci.main)?.slot ?? ci.p;
      const nx = Math.sin(ci.rot), nz = Math.cos(ci.rot);
      const far = ci.prop === 'morgue_drawers' ? 1.25 : 0.85;
      await shot(`close_${ci.prop}${pid ? '_page' : ''}`, [slot[0] + nx * far, Math.max(1.2, slot[1] + 0.75), slot[2] + nz * far], [slot[0], slot[1] + 0.03, slot[2]], 700, async () => { await open(ci); });
    }
  }
  const props = PARTS.includes('props');
  const themes = (PARTS.find((p) => p.startsWith('themes:')) ?? 'themes:').slice(7).split('+').filter(Boolean);
  const facilityRuns: { theme: string; props: boolean }[] = [];
  for (const t of themes) facilityRuns.push({ theme: t, props: false });
  if (props) facilityRuns.push({ theme: 'facility', props: true });
  /** themed furniture keys (kits) to frame per theme */
  const KITS = ['ward_bed', 'curtain_rail', 'iv_stand', 'sink_row', 'pump_flywheel', 'pipe_bank', 'card_catalogue', 'display_case', 'meat_rail', 'strip_curtain', 'crucible', 'mould_rack', 'round_table', 'linen_cart', 'bunk', 'switchboard', 'phone_booth'];
  for (const run of facilityRuns) {
    if (el() > BUDGET_S - 8) { log(`skip theme ${run.theme} (budget)`); continue; }
    want = { kind: 'facility', theme: run.theme };
    const res = await page.evaluate((a) => (window as unknown as WW).__game!.dbg('level.generate', a), { seed: SEED, players: 4, risk: 1, theme: run.theme });
    log(`generated ${run.theme}: ${JSON.stringify(res).slice(0, 100)}`);
    const L = await ready({ kind: 'facility', theme: run.theme }, 40_000);
    await page.evaluate(() => (window as unknown as WW).__game!.dbg('interaction.setLights', { on: true })).catch(() => null);
    if (run.props) {
      // v1.2 decals (env-layout's clutter 'decal' items, same derivation as the client) + EXIT signs + a lore page
      const decals = clutterFor(L).filter((c) => c.kind === 'decal');
      const lit = new Set(L.items.filter((i) => i.kind === 'light' && String(i.data?.state ?? 'on') === 'on').map((i) => i.space));
      const wallPick = (cells: number[]) => decals.find((d) => d.tip !== 1 && cells.includes(d.a) && lit.has(d.space)) ?? decals.find((d) => d.tip !== 1 && cells.includes(d.a));
      for (const [name, cells] of [['decal_sign', [12, 13, 14]], ['decal_leak', [0, 1, 2, 3, 8, 9, 10]], ['decal_hand', [4, 5]]] as const) {
        const d = wallPick([...cells]);
        if (!d) continue;
        const nx = Math.sin(d.rot), nz = Math.cos(d.rot);
        await shot(`${name}_${d.a}`, [d.x + nx * 1.7, 1.6, d.z + nz * 1.7], [d.x, d.y, d.z], 500);
      }
      const fd = decals.find((d) => d.tip === 1 && lit.has(d.space)) ?? decals.find((d) => d.tip === 1);
      if (fd) await shot(`decal_floor_${fd.a}`, [fd.x - Math.sin(fd.rot) * 1.4, 1.65, fd.z - Math.cos(fd.rot) * 1.4], [fd.x, 0, fd.z], 500);
      const ex = L.doors.find((d) => d.kind === 'exit');
      const lobby = ex ? [ex.a, ex.b].find((s) => s >= 0 && !L.spaces[s]?.open) : undefined;
      if (ex && lobby !== undefined) {
        const mx = ex.dir === 'v' ? ex.x : ex.x + ex.len / 2, mz = ex.dir === 'v' ? ex.y + ex.len / 2 : ex.y;
        const inPlus = ex.dir === 'v' ? L.owner[Math.floor(mz) * L.W + ex.x] === lobby : L.owner[ex.y * L.W + Math.floor(mx)] === lobby;
        const sx = ex.dir === 'v' ? (inPlus ? 1 : -1) : 0, sz = ex.dir === 'h' ? (inPlus ? 1 : -1) : 0;
        await shot('exit_sign', [mx + sx * 3.2, 1.6, mz + sz * 3.2], [mx, 2.0, mz], 600);
      }
      const spots0 = await page.evaluate(() => (window as unknown as WW).__levelDebug!.level().loreSpots());
      const ls0 = spots0.find((s) => s.style !== 'drawer');
      if (ls0) {
        const nx = Math.sin(ls0.rot), nz = Math.cos(ls0.rot);
        await shot(`lore_${ls0.style}`, [ls0.p[0] + nx * 0.8, ls0.p[1] + 0.05, ls0.p[2] + nz * 0.8], ls0.p, 700, async () => {
          await page.evaluate((id) => (window as unknown as WW).__levelDebug!.level().setLorePage(id, { visible: true, title: 'HAZARD BULLETIN', text: 'THE LISTENER. It hunts by sound. If you hear it breathe, stop talking. Do not run. Count to ten, then move away from the voice. FORM FG-1', glow: 0.4 }), ls0.id);
        });
      }
    }
    const cor = L.spaces.filter((s) => s.kind === 'corridor' && s.type !== 'junction').sort((a, b) => Math.max(b.rect.w, b.rect.h) - Math.max(a.rect.w, a.rect.h))[0];
    if (cor) {
      const r = cor.rect;
      await shot(`${run.theme}_corridor`, r.w >= r.h ? [r.x + 0.6, 1.62, r.y + r.h / 2] : [r.x + r.w / 2, 1.62, r.y + 0.6], r.w >= r.h ? [r.x + r.w, 1.45, r.y + r.h / 2] : [r.x + r.w / 2, 1.45, r.y + r.h], 1200);
      if (run.props && el() < BUDGET_S) {
        // draw-call delta of the decals at this camera (budget: <= 3 per furnished space)
        const delta = await page.evaluate(async () => {
          const d = (window as unknown as WW).__levelDebug! as unknown as { decals(on: boolean): number; renderInfo(): { drawCalls?: number } };
          const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
          await frame();
          const on = d.renderInfo().drawCalls ?? 0;
          const n = d.decals(false);
          await frame();
          const off = d.renderInfo().drawCalls ?? 0;
          d.decals(true);
          return { on, off, meshes: n };
        });
        results.push({ name: 'decal_draw_delta', info: delta });
        log(`decal draw delta at the corridor camera: ${JSON.stringify(delta)}`);
      }
    }
    // themed kits (largest first, two keys per theme) framed from in front of them
    const kit = L.items.filter((i) => i.kind === 'prop' && KITS.includes(String(i.data?.prop))).sort((a, b) => Number(b.data?.w ?? 1) * Number(b.data?.d ?? 1) - Number(a.data?.w ?? 1) * Number(a.data?.d ?? 1));
    const seen = new Set<string>();
    for (const it of kit) {
      const key = String(it.data?.prop);
      if (seen.has(key) || seen.size >= 2) continue;
      seen.add(key);
      const nx = Math.sin(it.rot ?? 0), nz = Math.cos(it.rot ?? 0);
      const dd = 1.6 + Number(it.data?.d ?? 0.6) / 2;
      await shot(`${run.theme}_kit_${key}`, [it.x + nx * dd + nz * 0.6, 1.55, it.z + nz * dd - nx * 0.6], [it.x, (it.y ?? 0) + 0.7, it.z], 500);
    }
    if (!run.props) continue;
    // drawers: a GLB host and a procedural one, framed from the walkable front cell, closed then open
    const conts = await page.evaluate(() => (window as unknown as WW).__levelDebug!.level().containers());
    for (const kinds of [['cabinet', 'desk', 'tool_chest'], ['filing', 'morgue_drawers', 'counter']]) {
      const ci = conts.find((k) => kinds.includes(k.prop));
      if (!ci) continue;
      const eye: V3 = [ci.front[0] + 0.5, 1.3, ci.front[1] + 0.5];
      const bx = eye[0] - ci.p[0], bz = eye[2] - ci.p[2];
      const bl = Math.hypot(bx, bz) || 1;
      eye[0] += (bx / bl) * 0.35; eye[2] += (bz / bl) * 0.35;
      await shot(`drawer_${ci.prop}_closed`, eye, [ci.p[0], ci.p[1] - 0.15, ci.p[2]], 500);
      await shot(`drawer_${ci.prop}_open`, eye, [ci.p[0], ci.p[1] - 0.15, ci.p[2]], 700, async () => {
        await page.evaluate(([id, m]) => (window as unknown as WW).__levelDebug!.level().setContainerOpen(id, m), [ci.id, 1 << ci.main] as [string, number]);
      });
    }
    const spots = await page.evaluate(() => (window as unknown as WW).__levelDebug!.level().loreSpots());
    const ls = results.some((r) => String(r.name).startsWith('lore_')) ? undefined : spots.find((s) => s.style !== 'drawer');
    if (ls) {
      const nx = Math.sin(ls.rot), nz = Math.cos(ls.rot);
      await shot(`lore_${ls.style}`, [ls.p[0] + nx * 0.8, ls.p[1] + 0.05, ls.p[2] + nz * 0.8], ls.p, 700, async () => {
        await page.evaluate((id) => (window as unknown as WW).__levelDebug!.level().setLorePage(id, { visible: true, title: 'HAZARD BULLETIN', text: 'THE LISTENER. It hunts by sound. If you hear it breathe, stop talking. Do not run. Count to ten, then move away from the voice. FORM FG-1', glow: 0.4 }), ls.id);
      });
    }
    const mirs = L.items.filter((i) => i.kind === 'prop' && typeof i.data?.mirror === 'string' && i.data.mirror !== 'van');
    for (const mir of mirs.slice(0, 2)) {
      const nx = Math.sin(mir.rot ?? 0), nz = Math.cos(mir.rot ?? 0);
      await shot(`mirror_${mir.data!.mirror}`, [mir.x + nx * 1.7 + nz * 0.5, 1.6, mir.z + nz * 1.7 - nx * 0.5], [mir.x, mir.y ?? 1.5, mir.z], 900);
    }
  }
  if (PARTS.includes('hub') && PROPS_FIRST && el() < BUDGET_S - 10) await hubShots();
  const errs = await page.evaluate(() => (window as unknown as WW).__game!.errors());
  log(`client errors: ${JSON.stringify(errs).slice(0, 600)}`);
  log(`page errors: ${JSON.stringify(player.errors.filter((e) => !e.includes('http 404')).slice(0, 12)).slice(0, 900)}`);
  writeFileSync(join(OUT, `${TAG}.json`), JSON.stringify({ base: BASE, parts: PARTS, results, clientErrors: errs, pageErrors: player.errors }, null, 1));
} finally {
  await player.close();
  log('done');
}
