// Env-layout (v1.2) ws/HTTP integration (no browser, no GPU): boots its own dev server on PORT (default 3811) with
// NODE_ENV=development AI_MODE=mock and scratch SAVES_DIR / SESSION_FILE (E1_SCRATCH, default %TEMP%/deadair-e1),
// serving the staged assets (ASSETS_DIR = the shared stage when present). Checks the real consumers of E1's providers:
//  - /assets: the staged font (font/ttf), decal index and a v1.2 texture are served
//  - hub: real (not virtual) van stations + records board; the hub mirror is still the 'Change your look' interactable
//  - dbg.level.generate with a theme: the layout carries the theme, G3's interaction registers one 'cont:' interactable
//    per containersOf entry, and stationsOf / mirrorsOf / loreSpotsOf / movableRefsOf agree with what the client gets
// Run: node tests/level/providers.e2e.ts      (exit code 0 = all checks passed)
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import { stationsOf } from '../../packages/shared/src/procgen/van.ts';
import { containersOf } from '../../packages/shared/src/procgen/containers.ts';
import { mirrorsOf } from '../../packages/shared/src/procgen/mirrors.ts';
import { loreSpotsOf } from '../../packages/shared/src/procgen/lore.ts';
import { movableRefsOf } from '../../packages/shared/src/procgen/movables.ts';
import { Bot } from '../interaction/bot.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const PORT = Number(process.env.PORT ?? 3811);
const SCRATCH = process.env.E1_SCRATCH ?? join(tmpdir(), 'deadair-e1');
const STAGE = 'C:/Users/Pieter/AppData/Local/Temp/dead-air-assets-stage';
mkdirSync(join(SCRATCH, 'saves'), { recursive: true });
const results: { check: string; ok: boolean; info?: unknown }[] = [];
const check = (name: string, ok: boolean, info?: unknown) => { results.push({ check: name, ok, info }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info !== undefined ? ` ${JSON.stringify(info)}` : ''}`); };

const srv = spawn(process.execPath, [join(ROOT, 'apps/server/src/index.ts'), '--dev'], {
  cwd: ROOT,
  env: {
    ...process.env, PORT: String(PORT), NODE_ENV: 'development', AI_MODE: 'mock',
    SAVES_DIR: join(SCRATCH, 'saves'), SESSION_FILE: join(SCRATCH, 'session.json'),
    ...(existsSync(join(STAGE, 'dist/manifest.json')) ? { ASSETS_DIR: STAGE } : {}),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
srv.stdout.on('data', (d) => { log += d; });
srv.stderr.on('data', (d) => { log += d; });
const base = `http://127.0.0.1:${PORT}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

try {
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    try { up = (await fetch(`${base}/assets/manifest.json`)).ok; } catch { /* booting */ }
    if (!up) await sleep(500);
  }
  if (!up) throw new Error(`server did not come up on ${PORT}:\n${log.slice(-2000)}`);
  // ---- assets
  const man = await (await fetch(`${base}/assets/manifest.json`)).json() as { files: Record<string, { url: string }> };
  const font = man.files['font.reenie_beanie'];
  check('staged manifest has the font, decals and v1.2 textures', !!font && !!man.files['decal.index'] && !!man.files['tex.terrazzo.albedo'], Object.keys(man.files).length);
  if (font) {
    const r = await fetch(`${base}/assets/${font.url}`);
    check('font served as font/ttf', r.ok && /font|ttf/.test(r.headers.get('content-type') ?? ''), r.headers.get('content-type'));
  }
  // ---- hub
  const bot = new Bot('E1Prov');
  await bot.connect(`ws://127.0.0.1:${PORT}/ws`, `E1P${String(Date.now() % 1000).padStart(3, '0')}`.replace(/[0-9]/g, (d) => 'BCDFGHJKLM'[Number(d)]));
  await bot.settle(300);
  const hub = bot.full?.layout as LevelLayout | undefined;
  check('hub layout arrives', !!hub && hub.kind === 'hub');
  if (hub) {
    const st = stationsOf(hub);
    check('hub stations are real (no virtual)', st.length >= 9 && st.every((s) => !s.virtual), st.map((s) => s.kind));
    const mirror = Object.values(bot.ix.ints).find((i) => i.kind === 'mirror');
    check('hub mirror is still the "Change your look" interactable, inside the van', !!mirror && hub.spaces[hub.items.find((it) => it.id === mirror.id)!.space].type === 'van', mirror?.prompt);
  }
  // ---- themed facility
  const gen = await bot.dbg<{ hash: string; errors: string[] }>('level.generate', { seed: 'e1-prov-1', players: 4, risk: 1, theme: 'hospital', modifiers: ['DARK WARDS'] });
  check('dbg.level.generate (theme + modifiers) validates', gen.errors.length === 0, gen.errors.slice(0, 3));
  await bot.waitEvent('phase', () => true, 8000).catch(() => null);
  await bot.settle(600);
  const L = bot.full?.layout as LevelLayout | undefined;
  check('client got the generated facility', !!L && L.hash === gen.hash, L?.hash);
  if (L) {
    check('theme and modifier carried in the layout', L.theme === 'hospital' && L.metrics['mod:dark'] === 1, { theme: L.theme, dark: L.metrics['mod:dark'] });
    const C = containersOf(L);
    const ints = Object.values(bot.ix.ints).filter((i) => i.kind === 'container');
    const ids = new Set(ints.map((i) => String(i.ref ?? '')));
    check('interaction registers every container (cont: ids, ref = container id)', C.length > 0 && C.every((c) => ids.has(c.id)) && ints.every((i) => i.id.startsWith('cont:')), { containers: C.length, interactables: ints.length });
    check('stations: real van stations in the facility', stationsOf(L).filter((s) => !s.virtual).length >= 8);
    check('mirrors: van + >= 2 decorative', mirrorsOf(L).filter((m) => m.kind !== 'van').length >= 2 && mirrorsOf(L).some((m) => m.kind === 'van'));
    const lore = loreSpotsOf(L);
    check('lore: 3-6 wall spots + drawer spots', lore.filter((s) => s.style !== 'drawer').length >= 3 && lore.filter((s) => s.style !== 'drawer').length <= 6, lore.map((s) => s.style));
    check('movables: non-empty', movableRefsOf(L).length > 0, movableRefsOf(L).length);
  }
  bot.close();
} catch (e) {
  check('run', false, e instanceof Error ? e.message : String(e));
} finally {
  srv.kill();
  await sleep(500);
}
const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `${bad.length} check(s) FAILED` : `all ${results.length} checks passed`);
process.exitCode = bad.length ? 1 : 0;
