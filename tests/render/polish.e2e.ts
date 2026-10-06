// Owner: track ③ Render (visual polish pass). Plays the night like a player and screenshots every look-critical spot:
// hub (lot, van rear + interior, kennel, facade), the drive, 3 facility seeds (entrance lobby, dark corridor with the
// flashlight only, a fixture-lit room, the vault + Core, the 03:00 blackout), each monster in view (lit + flashlight)
// and teammate suits. Own dev server (BASE_URL, default http://127.0.0.1:3098); Vite HMR is blocked in the page.
//   node tests/render/polish.e2e.ts --tag before --cfg ultra      (cfg: ultra | medium | low = ?webgl=1 Low)
//   -> tests/artifacts/polish/<tag>/<cfg>/<shot>.png + tests/artifacts/polish/<tag>_<cfg>.png (contact sheet)
//   --only hub,drive,facility,monsters,suits   --seeds polish-a,polish-b,polish-c
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import type { Page } from 'playwright-core';
import sharp from 'sharp';
import { REPO } from '../lib/launch.ts';
import type { LevelLayout, LayoutSpace } from '../../packages/shared/src/layout.ts';
import { ANIM } from '../../packages/shared/src/anim.ts';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const BASE = arg('base', process.env.BASE_URL ?? 'http://127.0.0.1:3098');
const TAG = arg('tag', 'look');
const CFG = arg('cfg', 'ultra');
const ONLY = new Set(arg('only', 'hub,drive,facility,monsters,suits').split(','));
const SEEDS = arg('seeds', 'polish-a,polish-b,polish-c').split(',');
const VIEW = { width: 1600, height: 900 };
const OUT = join(REPO, 'tests/artifacts/polish', TAG, CFG);
mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// cfg: ultra | medium | high (WebGPU), low (= ?webgl=1 Low), <preset>-webgl (that preset on the WebGL2 backend)
const webglCfg = CFG === 'low' || CFG.endsWith('-webgl');
const query: Record<string, string> = { test: '1', autojoin: '1', preset: CFG.replace(/-webgl$/, ''), ...(webglCfg ? { webgl: '1' } : {}) };
const crew = `PL${'BCDFGHJKLMNPQRSTVWXZ'[Date.now() % 20]}${'BCDFGHJKLMNPQRSTVWXZ'[Math.floor(Date.now() / 20) % 20]}`;

const wav = join(REPO, 'tests/fixtures/voice/silence.wav');
const browser = await chromium.launch({
  channel: 'chrome', headless: true,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`, '--autoplay-policy=no-user-gesture-required',
    '--disable-gpu-vsync', '--disable-frame-rate-limit'],
});
const context = await browser.newContext({ viewport: VIEW });
await context.grantPermissions(['microphone']).catch(() => {});
// game socket = /ws; everything else is Vite's HMR channel (other agents save files all night) -> refuse it
await context.routeWebSocket((url) => !url.pathname.endsWith('/ws'), (ws) => { ws.close(); });
const page = await context.newPage();
const errors: string[] = [];
page.on('console', (m) => { if (m.type() === 'error' && !/vite|websocket|\[hmr\]/i.test(m.text())) errors.push(`console: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
await page.addInitScript(() => { try { localStorage.setItem('deadair.name', 'Polish'); localStorage.removeItem('deadair.render.preset'); localStorage.removeItem('deadair.render.exposure'); } catch { /* ignore */ } });
await page.goto(`${BASE}/?${new URLSearchParams(query)}#${crew}`, { waitUntil: 'domcontentloaded' });

type V3 = [number, number, number];
const ev = <T>(js: string): Promise<T> => page.evaluate(js) as Promise<T>;
const dbg = (r: string, a: unknown = {}) => page.evaluate(([rr, aa]) => window.__game!.dbg(rr as string, aa), [r, a] as const);
const req = (r: string, a: unknown = {}) => page.evaluate(([rr, aa]) => window.__game!.req!(rr as string, aa), [r, a] as const);
const phase = () => ev<string>('__game.state().phase');
const waitPhase = (p: string, ms = 30_000) => page.waitForFunction((pp) => (window.__game!.state() as { phase: string }).phase === pp, p, { timeout: ms, polling: 100 });
const layout = () => ev<LevelLayout>('__monstersLayout()');
const perfLog: string[] = [];
const shotNames: string[] = [];

/** smooth frames: wait until rAF intervals settle (new pipelines compile on first view) */
async function settle(minMs = 900): Promise<void> {
  await sleep(minMs);
  for (let i = 0; i < 25; i++) {
    const worst = await ev<number>(`new Promise((res) => { const ts = []; const f = (t) => { ts.push(t); if (ts.length < 12) requestAnimationFrame(f); else { let m = 0; for (let i = 1; i < ts.length; i++) m = Math.max(m, ts[i] - ts[i - 1]); res(m); } }; requestAnimationFrame(f); })`);
    if (worst < 50) return;
  }
}

async function shot(name: string): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const r = (await Promise.race([
      cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('cdp capture timeout')), 60_000)),
    ])) as { data: string };
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'));
  } finally {
    await cdp.detach().catch(() => {});
  }
  const pf = await ev<{ fps: number; frameMs: number; gpuMs?: number; drawCalls?: number }>('window.__render ? window.__render.stats() : __game.perf()');
  const info = await ev<Record<string, unknown>>('window.__render ? window.__render.info() : {}');
  const line = `${name.padEnd(22)} fps ${pf.fps.toFixed(0).padStart(4)} frame ${pf.frameMs.toFixed(2)} ms gpu ${pf.gpuMs?.toFixed(2) ?? '-'} ms draws ${pf.drawCalls ?? '-'} shadowed ${info.usedShadowed ?? '-'} fixtures ${info.fixturesLit ?? '-'}`;
  perfLog.push(line);
  shotNames.push(name);
  console.log(line);
}

/** stand at (x, z) facing the point (tx, ty, tz) (player camera; flashlight + view model follow) */
async function stand(x: number, z: number, tx: number, ty: number, tz: number): Promise<void> {
  const eye = 1.62;
  const yaw = Math.atan2(tx - x, tz - z);
  const pitch = Math.atan2(ty - eye, Math.hypot(tx - x, tz - z));
  await page.evaluate(([a, b, c, d]) => { window.__game!.teleport(a, b, c); window.__game!.look(c, d); }, [x, z, yaw, pitch] as const);
  await sleep(120);
  await page.evaluate(([c, d]) => window.__game!.look(c, d), [yaw, pitch] as const);
}

const lights = async (): Promise<Record<string, boolean>> => ((await ev<{ interaction?: { lights?: Record<string, boolean> } }>('__game.state()')).interaction?.lights ?? {});
const centre = (s: LayoutSpace): [number, number] => [s.rect.x + s.rect.w / 2, s.rect.y + s.rect.h / 2];

async function hub(): Promise<void> {
  const L = await layout();
  const van = L.van.cab;
  const vx = van.x + van.w / 2;
  // lot at night: from the far corner towards the van + facade
  await stand(L.W - 6, L.H - 3.5, vx - 1, 2.2, van.y - 1);
  await settle(1500);
  await shot('hub_lot');
  // behind the van: its open rear doors, the lit cargo area
  await stand(vx + 0.4, van.y - 3.2, vx, 1.2, van.y + 2);
  await settle();
  await shot('hub_van_rear');
  // inside the van, looking at the console
  await stand(vx, van.y + 0.35, vx, 1.15, van.y + 3);
  await settle();
  await shot('hub_van_inside');
  // kennel pen
  const ken = L.spaces.find((s) => s.type === 'kennel');
  if (ken) {
    const [kx, kz] = centre(ken);
    await stand(kx + 3.2, ken.rect.y - 2.4, kx, 0.6, kz + 0.5);
    await settle();
    await shot('hub_kennel');
  }
  // the facade + entrance canopy
  const door = L.items.find((i) => i.kind === 'prop' && i.data?.prop === 'entrance_door');
  if (door) {
    await stand(door.x + 3.5, door.z + 5.5, door.x, 2.4, door.z);
    await settle();
    await shot('hub_facade');
  }
}

async function drive(): Promise<boolean> {
  const st = (await req('meta.state')) as { workOrders?: { id: string; available: boolean }[] };
  const order = st.workOrders?.find((o) => o.available);
  if (!order) { console.log('no work order'); return false; }
  await req('meta.pick', { orderId: order.id });
  await req('meta.ready', { ready: true });
  await waitPhase('drive', 60_000);
  // the crew rides in the cargo area: look at the console from the rear doors
  const L = await layout();
  const van = L.van.cab;
  await stand(van.x + van.w / 2 - 0.3, van.y + 0.4, van.x + van.w / 2 + 0.2, 1.1, van.y + 3);
  await settle(2500);
  await shot('drive');
  await dbg('meta.skipDrive');
  await waitPhase('contract', 60_000);
  return true;
}

interface Spots { lobby: LayoutSpace | null; corridor: LayoutSpace | null; room: LayoutSpace | null; vault: LayoutSpace | null }

async function pickSpots(L: LevelLayout): Promise<Spots> {
  const lit = await lights();
  const isLit = (s: LayoutSpace) => lit[String(s.id)] !== false && (s.light === 'on');
  const lobby = L.spaces[L.entrance] ?? null;
  const cors = L.spaces.filter((s) => s.kind === 'corridor' && Math.max(s.rect.w, s.rect.h) >= 8).sort((a, b) => Math.max(b.rect.w, b.rect.h) - Math.max(a.rect.w, a.rect.h));
  const corridor = cors[0] ?? null;
  const rooms = L.spaces.filter((s) => (s.kind === 'room' || s.kind === 'hall') && s.id !== L.entrance && s.type !== 'van' && s.rect.w >= 5 && s.rect.h >= 5 && isLit(s));
  rooms.sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h);
  let room = rooms[0] ?? null;
  if (!room) {
    // nothing lit yet (unpowered zone): take the biggest room and switch it on server-side
    const any = L.spaces.filter((s) => (s.kind === 'room' || s.kind === 'hall') && s.id !== L.entrance && s.type !== 'van' && s.rect.w >= 5 && s.rect.h >= 5 && s.light === 'on');
    any.sort((a, b) => b.rect.w * b.rect.h - a.rect.w * a.rect.h);
    room = any[0] ?? null;
    if (room) { await dbg('interaction.power', { zone: room.powerZone, on: true }); await dbg('interaction.setLights', { space: room.id, on: true }); }
  }
  const vault = L.spaces.find((s) => s.kind === 'vault') ?? null;
  return { lobby, corridor, room, vault };
}

async function facility(tag: string): Promise<void> {
  const L = await layout();
  await dbg('monsters.freeze', { on: true });
  for (const id of ['hound0', 'hound1', 'listener0', 'mannequin0']) await dbg('monsters.place', { id, x: 0.5, z: 0.5, active: false, state: 'out', outSec: 999 }).catch(() => null);
  await page.waitForFunction(() => (window as unknown as { __levelDebug?: { texturesReady(): boolean } }).__levelDebug?.texturesReady() === true, undefined, { timeout: 30_000, polling: 250 }).catch(() => null);
  const sp = await pickSpots(L);
  console.log(`[${tag}] seed ${L.seed}: lobby ${sp.lobby?.callsign} corridor ${sp.corridor?.id} room ${sp.room?.callsign} vault ${sp.vault?.id}`);
  if (sp.lobby) {
    const exit = L.doors.find((d) => d.kind === 'exit' && (d.a === sp.lobby!.id || d.b === sp.lobby!.id));
    const [cx, cz] = centre(sp.lobby);
    if (exit) {
      const dx = exit.dir === 'h' ? exit.x + exit.len / 2 : exit.x;
      const dz = exit.dir === 'h' ? exit.y : exit.y + exit.len / 2;
      const inX = exit.dir === 'v' ? Math.sign(cx - dx) : 0, inZ = exit.dir === 'h' ? Math.sign(cz - dz) : 0;
      await stand(dx + inX * 0.9 + (exit.dir === 'h' ? 0.6 : 0), dz + inZ * 0.9 + (exit.dir === 'v' ? 0.6 : 0), cx - inX * 0.5 * sp.lobby.rect.w, 1.3, cz - inZ * 0.5 * sp.lobby.rect.h);
    } else await stand(sp.lobby.rect.x + 0.8, sp.lobby.rect.y + 0.8, cx + 1, 1.2, cz + 1);
    await settle(1500);
    await shot(`${tag}_lobby`);
  }
  if (sp.corridor) {
    const r = sp.corridor.rect;
    await dbg('interaction.setLights', { space: sp.corridor.id, on: false });
    const horiz = r.w >= r.h;
    if (horiz) await stand(r.x + 0.7, r.y + r.h / 2, r.x + r.w, 1.3, r.y + r.h / 2 + 0.15);
    else await stand(r.x + r.w / 2, r.y + 0.7, r.x + r.w / 2 + 0.15, 1.3, r.y + r.h);
    await settle(1200);
    await shot(`${tag}_corridor_dark`);
    await dbg('interaction.setLights', { space: sp.corridor.id, on: true });
  }
  if (sp.room) {
    const r = sp.room.rect;
    await stand(r.x + 0.8, r.y + 0.8, r.x + r.w - 1, 1.0, r.y + r.h - 1);
    await settle(1200);
    await shot(`${tag}_room_lit`);
  }
  if (sp.vault) {
    const core = L.items.find((i) => i.kind === 'core');
    const r = sp.vault.rect;
    const [cx, cz] = core ? [core.x, core.z] : centre(sp.vault);
    // stand on the far side of the vault from the Core
    const fx = cx < r.x + r.w / 2 ? r.x + r.w - 0.8 : r.x + 0.8;
    const fz = cz < r.y + r.h / 2 ? r.y + r.h - 0.8 : r.y + 0.8;
    await stand(fx, fz, cx, 0.75, cz);
    await settle(1200);
    await shot(`${tag}_vault_core`);
  }
}

/** 03:00 grid failure (last: the server keeps the facility dark afterwards) */
async function blackout(tag: string): Promise<void> {
  const L = await layout();
  const sp = await pickSpots(L);
  {
    await dbg('objectives.clock', { min: 302 });
    await sleep(5000); // banner fades
    if (sp.room) {
      const r = sp.room.rect;
      await stand(r.x + 0.8, r.y + 0.8, r.x + r.w - 1, 1.0, r.y + r.h - 1);
      await settle(1200);
      await shot(`${tag}_blackout_room`);
    }
    if (sp.lobby) {
      const [cx, cz] = centre(sp.lobby);
      await stand(sp.lobby.rect.x + 0.8, sp.lobby.rect.y + 0.8, cx + 1.5, 1.1, cz + 1.5);
      await settle(1000);
      await shot(`${tag}_blackout_lobby`);
    }
    await dbg('objectives.clock', { min: 60 });
    await page.evaluate(() => (window as unknown as { __render?: { setPower(s: 'all', on: boolean): void } }).__render?.setPower('all', true));
  }
}

async function monsters(tag: string): Promise<void> {
  const L = await layout();
  const sp = await pickSpots(L);
  const room = sp.room;
  if (!room) { console.log('no room for monsters'); return; }
  const r = room.rect;
  const camX = r.x + 0.9, camZ = r.y + r.h / 2;
  const tx = Math.min(r.x + r.w - 0.8, r.x + 3.9), tz = camZ;
  await page.waitForFunction(() => (window as unknown as { __monsters?: { loaded(): boolean } }).__monsters?.loaded() === true, undefined, { timeout: 30_000 }).catch(() => null);
  const kinds: [string, string, number, number][] = [['hound', 'hound0', ANIM.mAlert, Math.PI * 0.7], ['mannequin', 'mannequin0', ANIM.mFrozen, Math.PI * 1.05], ['listener', 'listener0', ANIM.mIdle, Math.PI * 0.85]];
  for (const [name, id, anim, yawOff] of kinds) {
    await dbg('monsters.freeze', { on: true });
    for (const other of ['hound0', 'hound1', 'listener0', 'mannequin0']) {
      if (other === id) {
        const yaw = Math.atan2(camX - tx, camZ - tz) + (yawOff - Math.PI);
        await dbg('monsters.place', { id, x: tx, z: tz, yaw, state: name === 'mannequin' ? 'frozen' : name === 'listener' ? 'ambush' : 'alert', active: true, anim });
      } else await dbg('monsters.place', { id: other, x: 0.5, z: 0.5, active: false, state: 'out', outSec: 999 }).catch(() => null);
    }
    await stand(camX, camZ, tx, name === 'hound' ? 0.55 : 1.2, tz);
    await settle(1800);
    await shot(`${tag}_${name}_lit`);
    await dbg('interaction.setLights', { space: room.id, on: false });
    await settle(900);
    await shot(`${tag}_${name}_dark`);
    await dbg('interaction.setLights', { space: room.id, on: true });
  }
  for (const other of ['hound0', 'hound1', 'listener0', 'mannequin0']) await dbg('monsters.place', { id: other, x: 0.5, z: 0.5, active: false, state: 'out', outSec: 999 }).catch(() => null);
}

async function suits(tag: string): Promise<void> {
  const L = await layout();
  const sp = await pickSpots(L);
  const room = sp.room;
  if (!room) return;
  const r = room.rect;
  const camX = r.x + 0.9, camZ = r.y + r.h / 2;
  const profiles = [
    { name: 'Ann', body: 'f', suit: ['#d4a017', '#2c3e50'], helmet: 'dome', visor: { glyphs: 'A', color: '#7dfcff' }, badge: 117 },
    { name: 'Bo', body: 'm', suit: ['#c0392b', '#ecf0f1'], helmet: 'box', visor: { glyphs: 'B0', color: '#ff4d4d' }, badge: 204 },
    { name: 'Cy', body: 'm', suit: ['#2e86c1', '#e67e22'], helmet: 'diver', visor: { glyphs: 'C', color: '#ffd84d' }, badge: 381 },
  ];
  await page.evaluate(({ profiles, camX, camZ }) => {
    const P = (window as unknown as { __players: { dummy(id: string, p: number[], yaw: number, pr: unknown, o?: unknown): void } }).__players;
    profiles.forEach((pr, i) => P.dummy(`suit${i}`, [camX + 2.6 + (i === 1 ? 0.6 : 0), 0, camZ - 1.1 + i * 1.1], -Math.PI / 2 + (i - 1) * 0.35, pr, { anim: 0, light: i === 2 ? 1 : 0 }));
  }, { profiles, camX, camZ });
  await stand(camX, camZ, camX + 3, 1.25, camZ);
  await settle(1800);
  await shot(`${tag}_suits_lit`);
  await dbg('interaction.setLights', { space: room.id, on: false });
  await settle(900);
  await shot(`${tag}_suits_dark`);
  await dbg('interaction.setLights', { space: room.id, on: true });
  await page.evaluate(() => (window as unknown as { __players: { clearDummies(): void } }).__players.clearDummies());
}

async function contactSheet(): Promise<void> {
  const cols = 4, tw = 800, th = 450, pad = 6, label = 26;
  const rows = Math.ceil(shotNames.length / cols);
  const W = cols * (tw + pad) + pad, H = rows * (th + label + pad) + pad;
  const comps: { input: Buffer; left: number; top: number }[] = [];
  for (let i = 0; i < shotNames.length; i++) {
    const x = pad + (i % cols) * (tw + pad), y = pad + Math.floor(i / cols) * (th + label + pad);
    comps.push({ input: await sharp(join(OUT, `${shotNames[i]}.png`)).resize(tw, th).toBuffer(), left: x, top: y + label });
    const svg = `<svg width="${tw}" height="${label}"><text x="4" y="19" font-family="Consolas, monospace" font-size="17" fill="#e8e4d8">${TAG} · ${CFG} · ${shotNames[i]}</text></svg>`;
    comps.push({ input: Buffer.from(svg), left: x, top: y });
  }
  const file = join(REPO, 'tests/artifacts/polish', `${TAG}_${CFG}.png`);
  await sharp({ create: { width: W, height: H, channels: 3, background: '#111214' } }).composite(comps).png().toFile(file);
  console.log(`contact sheet ${file}`);
}

let failed = false;
try {
  await page.waitForFunction(() => window.__game?.ready() === true && !!window.__game?.me(), undefined, { timeout: 90_000, polling: 200 });
  await page.addStyleTag({ content: '#overlay{display:none!important}' }).catch(() => null);
  await page.waitForFunction(() => (window as unknown as { __levelDebug?: { texturesReady(): boolean } }).__levelDebug?.texturesReady() === true, undefined, { timeout: 30_000, polling: 250 }).catch(() => null);
  console.log(`backend ${await ev<string>('__game.backend()')} preset ${await ev<string>('window.__render?.info().preset')} crew ${crew}`);
  if ((await phase()) === 'hub' && ONLY.has('hub')) await hub();
  let first = false;
  if (ONLY.has('drive') && (await phase()) === 'hub') first = await drive();
  if (first && ONLY.has('facility')) await facility('f0');
  for (let i = 0; i < SEEDS.length; i++) {
    if (!ONLY.has('facility') && !ONLY.has('monsters') && !ONLY.has('suits')) break;
    if (first && i === 0) continue; // the real flow's facility already covered slot 0
    await dbg('monsters.start', { seed: SEEDS[i], players: 2, risk: 2 });
    await waitPhase('contract', 60_000);
    await sleep(1500);
    if (ONLY.has('facility')) await facility(`f${i}`);
    if (ONLY.has('monsters') && i === SEEDS.length - 1) await monsters(`f${i}`);
    if (ONLY.has('suits') && i === SEEDS.length - 1) await suits(`f${i}`);
    if (ONLY.has('facility') && i === SEEDS.length - 1) await blackout(`f${i}`);
  }
  const errs = await ev<string[]>('__game.errors()');
  errors.push(...errs);
} catch (e) {
  failed = true;
  errors.push(`run: ${e instanceof Error ? e.stack ?? e.message : e}`);
} finally {
  if (shotNames.length) await contactSheet().catch((e) => console.log(`contact sheet failed: ${e}`));
  writeFileSync(join(OUT, 'perf.txt'), perfLog.join('\n') + '\n');
  await browser.close();
}
const webgpuErr = errors.filter((e) => /WebGPU|GPUValidation|validation/i.test(e));
console.log(`WebGPU/validation errors: ${webgpuErr.length}`);
console.log(errors.length ? `errors:\n${errors.slice(0, 30).join('\n')}` : 'no errors');
process.exitCode = failed ? 1 : 0;
setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
