// players (v1.3 F4 dead pokes) browser e2e: where the spectator's poke bar sits. ONE guarded run on the SwiftShader
// lane (tools/gpu-guard.mjs sets DEADAIR_RENDER, tests/lib/launch.ts then starts Chrome in software), one browser (Cam,
// who dies) + one ws bot (Ann, alive, followed). Flag deadPokes goes on before the page loads (the client reads the
// flags at boot). Judge layout and logic here, not lighting.
//   - 1280x720: four buttons while spectating Ann; the bar in the bottom 80 px (the inventory hotbar's place), under
//     interaction's revive line (.ix-spec) with a gap, >= 8 px clear of the corner HUD (band meter, chat, render chip),
//     and below Ann's knees on screen (her avatar projected through the render camera): the v1.3 verify run found the
//     bar over her legs
//   - 960x540 (the paranormal lane's size): still at the bottom edge, still clear of everything
//   - 900x540 (narrower than 960 px): the bar steps up above the revive line, clear of it and of the corners
// Screenshots + report.json: tests/artifacts/players/pokebar_*.png. Needs a --dev server (Vite middleware) on PORT
// (default 3801), started outside the guard:
//   node tools/gpu-guard.mjs --max-sec 120 --label g1-pokebar -- node tests/players/pokebar.e2e.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import { REPO, launchPlayer, screenshot, waitForGame } from '../lib/launch.ts';
import { Bot, sleep } from '../stealth/bot.ts';

const PORT = Number(process.env.PORT ?? 3801);
const BASE = (process.env.BASE_URL ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, '');
if (PORT === 3000 || PORT === 3100 || /:(3000|3100)(\/|$)|dead-air\.io/.test(BASE)) throw new Error(`refusing the live server (${BASE})`);
const OUT = 'tests/artifacts/players';
const tail = Date.now().toString(36).slice(-3).toUpperCase().replace(/[^BCDFGHJKLMNPQRSTVWXZ]/g, 'K');
const CREW = `PKB${tail}`.slice(0, 6);
const t0 = Date.now();
const lap = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)} s] ${m}`);
let failed = false;
const check = (cond: unknown, msg: string) => {
  if (!cond) { failed = true; console.log(`FAIL: ${msg}`); } else console.log(`ok: ${msg}`);
};

interface Box { x: number; y: number; w: number; h: number }
interface Scene {
  vw: number; vh: number; bottom: string; line: Box | null; lineText: string; buttons: Box[]; spec: Box | null;
  corners: { id: string; box: Box }[];
}
interface ScreenPt { x: number; y: number; z: number }
interface BodyOnScreen { visible: boolean; feet: ScreenPt; knees: ScreenPt; hips: ScreenPt; head: ScreenPt }
type W = Window & {
  __paranormal?: { levelReady?(): boolean };
  __render?: { three?(): { camera: { updateMatrixWorld(): void }; THREE: { Vector3: new (x: number, y: number, z: number) => { project(c: unknown): ScreenPt } } } };
};

/** the gap between two boxes along the axis that separates them (negative: they overlap) */
const clearance = (a: Box, b: Box) => Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.h), a.y - (b.y + b.h));
const report: Record<string, unknown> = { crew: CREW, software: process.env.DEADAIR_RENDER === 'swiftshader' };

const ann = new Bot('Ann');
await ann.connect(`${BASE.replace(/^http/, 'ws')}/ws`, CREW);
await ann.dbg('setFlags', { set: { deadPokes: true } });
const p = await launchPlayer({ name: 'Cam', baseUrl: BASE, crew: CREW, query: { autojoin: '1', nobright: '1', autoq: '0' } });
const page = p.page;
try {
  await page.routeWebSocket((u) => !u.pathname.endsWith('/ws'), () => { /* mute Vite HMR: other fixers edit the tree right now */ });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForGame(page, 60_000);
  await page.waitForFunction(() => !!window.__game?.me() && !!window.__players, undefined, { timeout: 20_000, polling: 200 });
  const camId = await page.evaluate(() => window.__game!.me()!);
  lap('booted');

  // ---- a contract; Ann in the middle of a big room, facing +z, with 2.4 m of the room behind her (the camera) ----
  await ann.dbg('objectives.start', { seed: 'pokebar-1', players: 2, realSec: 900 });
  let L: LevelLayout | null = null;
  for (let i = 0; i < 80 && !L; i++) {
    // the contract's phase event (never an earlier hub one)
    const ph = ann.events.filter((e) => e.e === 'phase').map((e) => e.d as { phase?: string; state?: { layout?: LevelLayout } })
      .filter((d) => d.phase === 'contract' && d.state?.layout?.kind === 'facility').pop();
    L = ph?.state?.layout ?? null;
    if (!L) await sleep(100);
  }
  if (!L) throw new Error('no contract layout');
  const layout = L;
  await page.waitForFunction(() => {
    const w = window as unknown as W;
    const st = window.__game!.state() as { phase?: string };
    return st.phase === 'contract' && (w.__paranormal?.levelReady ? w.__paranormal.levelReady() : true);
  }, undefined, { timeout: 40_000, polling: 250 });
  await sleep(2600); // the monsters start 2.5 s in: then freeze and park them
  await ann.dbg('monsters.freeze', { on: true }).catch(() => null);
  const ms = await ann.dbg<{ agents?: { id: string }[] }>('monsters.state').catch(() => ({ agents: [] }));
  for (const ag of ms.agents ?? []) await ann.dbg('monsters.place', { id: ag.id, active: false, x: 0.5, z: 0.5 }).catch(() => null);
  for (let z = 0; z <= (layout.zones ?? 1); z++) await ann.dbg('interaction.power', { zone: z, on: true }).catch(() => null);
  await ann.dbg('interaction.setLights', { space: 'all', on: true }).catch(() => null);
  const spaceAt = (x: number, z: number) => layout.owner[Math.floor(z) * layout.W + Math.floor(x)] ?? -1;
  const room = layout.spaces
    .filter((s) => s.kind !== 'corridor' && !s.open && s.rect.w >= 5 && s.rect.h >= 6)
    .map((s) => ({ s, x: Math.floor(s.rect.x + s.rect.w / 2) + 0.5, z: Math.floor(s.rect.y + s.rect.h / 2) + 1.5 }))
    .find((c) => spaceAt(c.x, c.z) === c.s.id && spaceAt(c.x, c.z - 2.4) === c.s.id);
  check(!!room, `a big room for the scene (${room ? `${room.s.callsign ?? room.s.id} ${room.s.rect.w}x${room.s.rect.h}` : 'none'})`);
  if (room) await ann.dbg('interaction.pose', { pid: ann.id, x: room.x, z: room.z, yaw: 0, light: 1 });
  lap('contract');

  // ---- Cam dies: spectating Ann, the bar is up ----
  await ann.dbg('interaction.kill', { pid: camId, killer: 'HOUND', reason: 'heard your SPRINT (9 m)' });
  const up = await page.waitForFunction(() => window.__players?.pokeUi().on === true, undefined, { timeout: 10_000, polling: 100 }).then(() => true, () => false);
  check(up, 'dead: the poke bar is up');
  await page.waitForFunction(() => !document.querySelector('[data-testid="ix-deathcard"]'), undefined, { timeout: 15_000, polling: 250 }).catch(() => null);
  await sleep(800);
  const spec = await page.evaluate(() => window.__players!.spectating());
  check(spec.on && spec.target === ann.id, `spectating Ann (${JSON.stringify(spec)})`);
  lap('spectating');

  const measure = (): Promise<Scene> => page.evaluate((): Scene => {
    const box = (b: DOMRect): Box | null => (b.width > 0 && b.height > 0 ? { x: b.left, y: b.top, w: b.width, h: b.height } : null);
    const line = document.querySelector('[data-testid="poke-line"]');
    let lineBox: Box | null = null;
    if (line) {
      // the text itself (the line's box is as wide as its longest row)
      const r = document.createRange();
      r.selectNodeContents(line);
      lineBox = box(r.getBoundingClientRect());
    }
    const bar = document.querySelector('[data-testid="poke-bar"]');
    const buttons: Box[] = [];
    for (const b of [...document.querySelectorAll('[data-testid="poke-bar"] button')]) {
      const bb = box(b.getBoundingClientRect());
      if (bb) buttons.push(bb);
    }
    const corners: { id: string; box: Box }[] = [];
    for (const el of [...document.querySelectorAll('.hud-slot.hud-bottom-left > *, .hud-slot.hud-bottom-right > *')]) {
      const bb = box(el.getBoundingClientRect());
      if (bb) corners.push({ id: el.getAttribute('data-testid') ?? ((el.textContent ?? '').trim().slice(0, 24) || el.tagName), box: bb });
    }
    const specEl = document.querySelector('[data-testid="ix-spec"]');
    return {
      vw: innerWidth, vh: innerHeight, bottom: bar ? getComputedStyle(bar).bottom : '', line: lineBox, lineText: (line?.textContent ?? '').trim(),
      buttons, spec: specEl ? box(specEl.getBoundingClientRect()) : null, corners,
    };
  });
  const bodyOnScreen = (): Promise<BodyOnScreen | null> => page.evaluate((id) => {
    const w = window as unknown as W;
    const av = window.__players?.avatars().find((a) => a.id === id);
    const three = w.__render?.three?.();
    if (!av || !three) return null;
    three.camera.updateMatrixWorld();
    const at = (h: number) => {
      const v = new three.THREE.Vector3(av.p[0], av.p[1] + h, av.p[2]).project(three.camera);
      return { x: ((v.x + 1) / 2) * innerWidth, y: ((1 - v.y) / 2) * innerHeight, z: v.z };
    };
    return { visible: av.visible, feet: at(0), knees: at(0.5), hips: at(0.95), head: at(1.8) };
  }, ann.id);

  const scenes: Record<string, unknown> = {};
  const scene = async (vw: number, vh: number, narrow: boolean) => {
    await page.setViewportSize({ width: vw, height: vh });
    await sleep(700);
    const m = await measure();
    const body = await bodyOnScreen();
    const shot = await screenshot(page, `${OUT}/pokebar_${vw}x${vh}.png`);
    const parts = [...(m.line ? [m.line] : []), ...m.buttons];
    const top = Math.min(...parts.map((b) => b.y));
    const bottom = Math.max(...parts.map((b) => b.y + b.h));
    const tag = `${vw}x${vh}`;
    scenes[tag] = { ...m, barTop: top, barBottom: bottom, body, shot };
    check(m.buttons.length === 4 && !!m.line, `${tag}: one line + four buttons (${m.buttons.length}; "${m.lineText}")`);
    check(!!m.spec, `${tag}: the revive line is on screen`);
    for (const c of m.corners) {
      const gap = Math.min(...parts.map((b) => clearance(b, c.box)));
      check(gap >= 8, `${tag}: clear of the corner HUD "${c.id}" (${gap.toFixed(0)} px)`);
    }
    check(parts.every((b) => b.x >= 0 && b.x + b.w <= vw), `${tag}: inside the window`);
    if (!narrow) {
      check(vh - bottom >= 8 && vh - bottom <= 22, `${tag}: at the bottom edge (${(vh - bottom).toFixed(1)} px up, computed bottom ${m.bottom})`);
      check(vh - top <= 80, `${tag}: within the bottom 80 px (top ${(vh - top).toFixed(1)} px up)`);
      if (m.spec) check(top - (m.spec.y + m.spec.h) >= 8, `${tag}: under the revive line with a gap (${(top - (m.spec.y + m.spec.h)).toFixed(1)} px)`);
      if (body?.visible) {
        check(top >= body.knees.y, `${tag}: below Ann's knees on screen (bar top ${top.toFixed(0)}, knees ${body.knees.y.toFixed(0)}, feet ${body.feet.y.toFixed(0)}, head ${body.head.y.toFixed(0)})`);
      } else console.log(`note: ${tag}: Ann's avatar not projected (${JSON.stringify(body)})`);
    } else {
      check(vh - bottom >= 118, `${tag}: stepped up (${(vh - bottom).toFixed(1)} px up, computed bottom ${m.bottom})`);
      if (m.spec) check(m.spec.y - bottom >= 8, `${tag}: above the revive line with a gap (${(m.spec.y - bottom).toFixed(1)} px)`);
    }
  };
  await scene(1280, 720, false);
  await scene(960, 540, false);
  await scene(900, 540, true);
  report.scenes = scenes;
  lap('scenes');
  const errs = p.errors.filter((e) => !/favicon|ERR_ABORTED|net::|404/.test(e));
  report.errors = errs.slice(0, 20);
  check(errs.length === 0, `no page errors (${errs.slice(0, 3).join(' | ')})`);
} catch (e) {
  failed = true;
  console.log(`FAIL: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
} finally {
  try {
    mkdirSync(join(REPO, OUT), { recursive: true });
    writeFileSync(join(REPO, OUT, 'pokebar_report.json'), JSON.stringify(report, null, 1));
  } catch { /* report only */ }
  await p.close().catch(() => null);
  await ann.dbg('setFlags', { set: { deadPokes: false } }).catch(() => null);
  ann.close();
}
lap(failed ? 'pokebar.e2e: FAIL' : 'pokebar.e2e: PASS');
process.exit(failed ? 1 : 0);
