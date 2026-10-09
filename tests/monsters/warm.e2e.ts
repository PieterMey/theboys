// Owner: track (c) Monsters (v1.3 P2d + F6 client). ONE browser (software lane through the GPU guard):
//   node tools/gpu-guard.mjs --max-sec 120 -- node tests/monsters/warm.e2e.ts
// against a dev server you started on BASE_URL (default http://127.0.0.1:3802; NODE_ENV=development, AI_MODE=mock)
// with the earwigs flag on IN MEMORY before the page loads (OUT/flags step below asks a bot to flip it).
// Measures three r186 pipelines + node builds per scene root (the render backend's createRenderPipeline and the node
// manager's builder, hooked before the monsters' warm-up):
//  - P2d: the monster warm-up runs ONCE per page, is drawn by the real scene pass (2 frames), compiles the REAL dust +
//    trail pools (roots 'monsters:dust' / 'monsters:trail', no InstancedMesh proxies), and a phase change (hub ->
//    contract -> hub) creates 0 pipelines for monster objects; first sight of the Hound / the Listener: 0
//  - F6: the ears arrive in the contract (dyn), are drawn, and their first sight creates 0 pipelines (warmed with the
//    templates); a screenshot of an ear under the flashlight
// Writes OUT_DIR (default tests/artifacts/monsters/v13-warm): report.json + screenshots.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchStable, shot } from './browser.ts';
import { Bot, refuseLive, sleep } from './bot.ts';

const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:3802').replace(/\/$/, '');
refuseLive(Number(new URL(BASE).port || 80), BASE);
if (process.env.DEADAIR_RENDER !== 'swiftshader') throw new Error('run through tools/gpu-guard.mjs (software lane)');
const OUT = process.env.OUT_DIR ?? join(import.meta.dirname, '../artifacts/monsters/v13-warm');
mkdirSync(OUT, { recursive: true });
const T0 = performance.now();
const el = () => Math.round((performance.now() - T0) / 100) / 10;
const BUDGET = Number(process.env.BUDGET_SEC ?? 108);
const left = () => BUDGET - el();
const log = (s: string) => console.log(`[warm ${String(el()).padStart(5)}s] ${s}`);
const results: { name: string; pass: boolean; info: string }[] = [];
const check = (name: string, pass: boolean, info = '') => { results.push({ name, pass, info }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`); return pass; };

// in-page instrumentation: hooks three's backend + node manager as soon as __render.three() exists (before the
// monsters' warm-up, which waits for the model files)
const INIT = `(() => {
  const W = window.__wp = { phase: 'boot', marks: [], pipes: [], nbs: [], progs: 0, hooked: false };
  W.mark = (n) => { W.phase = n; W.marks.push({ n, t: Math.round(performance.now()) }); };
  const hook = () => {
    const T = window.__render && window.__render.three && window.__render.three();
    if (!T || !T.renderer || !T.renderer.backend) return false;
    const { renderer, scene, camera } = T;
    const be = renderer.backend;
    const rootOf = (o) => { let p = o; while (p && p.parent && p.parent !== scene) p = p.parent; return p ? String(p.name || p.type) : '?'; };
    const info = (ro) => { try { const o = ro.object, m = ro.material; return { o: String(o.name || o.type).slice(0, 40), root: rootOf(o).slice(0, 40), im: o.isInstancedMesh ? 1 : 0, sk: o.isSkinnedMesh ? 1 : 0, m: String(m.name || m.type).slice(0, 40), cam: ro.camera === camera ? 'main' : 'other', phase: W.phase, t: Math.round(performance.now()) }; } catch (e) { return { o: 'err', root: '?', phase: W.phase }; } };
    const f = be.createRenderPipeline;
    if (typeof f === 'function') be.createRenderPipeline = function (ro) { W.pipes.push(info(ro)); return f.apply(this, arguments); };
    const fp = be.createProgram;
    if (typeof fp === 'function') be.createProgram = function () { W.progs++; return fp.apply(this, arguments); };
    const nm = renderer._nodes;
    if (nm && typeof nm._createNodeBuilder === 'function') { const g = nm._createNodeBuilder; nm._createNodeBuilder = function (ro) { W.nbs.push(info(ro)); return g.apply(this, arguments); }; }
    W.hooked = { pipe: typeof f === 'function', prog: typeof fp === 'function', nb: !!nm, at: Math.round(performance.now()) };
    return true;
  };
  const iv = setInterval(() => { try { if (hook()) clearInterval(iv); } catch (e) { W.err = String(e); clearInterval(iv); } }, 4);
})()`;

interface Rec { o: string; root: string; im: number; sk: number; m: string; cam: string; phase: string; t: number }
interface WarmStat { warms: number; lastMs: number; lastTicks: number; lastDraws: number; phaseSkips: number; rewarms: number; warming: boolean; earsFlag: boolean; renderPreset: string | null }
const isMonster = (r: Rec) => r.root.startsWith('monster');

// the earwigs flag ON in the server's memory before the page loads (the client reads the live flags at boot)
const flagBot = new Bot('Flags');
await flagBot.connect(`${BASE.replace(/^http/, 'ws')}/ws`, 'WFLG');
await flagBot.dbg('monsters.flag', { name: 'earwigs', on: true });
await flagBot.dbg('monsters.flag', { name: 'director', on: false });
flagBot.close();

const crew = 'WRM1';
const p = await launchStable({ name: 'Warm', baseUrl: BASE, crew, query: { autojoin: '1', autoq: '0' }, viewport: { width: 960, height: 540 }, init: INIT });
const page = p.page;
const ev = <T>(fn: string): Promise<T> => page.evaluate(fn) as Promise<T>;
const dbg = (r: string, a: unknown = {}) => page.evaluate(([r2, a2]) => window.__game!.dbg(r2 as string, a2), [r, a] as const);
const report: Record<string, unknown> = { base: BASE };
try {
  await page.waitForFunction(() => window.__game?.ready() === true && !!window.__game?.me(), undefined, { timeout: 70_000, polling: 100 });
  log('game ready');
  await page.waitForFunction(() => { const m = (window as unknown as { __monsters?: { warm(): WarmStat } }).__monsters; const w = m?.warm(); return !!w && w.warms >= 1 && !w.warming; }, undefined, { timeout: 20_000, polling: 100 });
  const w0 = await ev<WarmStat>('window.__monsters.warm()');
  report.warmBoot = w0;
  report.hooked = await ev('window.__wp.hooked');
  log(`warm-up: ${JSON.stringify(w0)}`);
  check('P2d warm-up drawn by the scene pass in 2 frames', w0.lastDraws >= 2, `${w0.lastDraws} draws in ${w0.lastMs} ms, ${w0.lastTicks} ticks`);
  check('P2d the client read the earwigs flag (the ear mesh is in the warm set)', w0.earsFlag === true);
  const bootPipes = await ev<Rec[]>('window.__wp.pipes');
  const warmRoots = [...new Set(bootPipes.filter(isMonster).map((r) => r.root))];
  report.warmPipes = bootPipes.filter(isMonster);
  check('P2d the warm compiled the REAL dust + trail pools (no proxies)', warmRoots.includes('monsters:dust') && warmRoots.includes('monsters:trail'), warmRoots.join(', '));
  check('P2d ... and the templates + ear mesh in the warm set', warmRoots.includes('monsters:warmup'), `${bootPipes.filter((r) => r.root === 'monsters:warmup').length} warm-set pipelines: ${[...new Set(bootPipes.filter((r) => r.root === 'monsters:warmup').map((r) => r.o))].join(', ')}`);
  const phaseNow = () => ev<string>('window.__game.state().phase');
  log(`phase ${await phaseNow()}; hub settle`);
  await sleep(1500);
  const mark = (n: string) => ev(`window.__wp.mark(${JSON.stringify(n)})`);
  const since = async (n: string): Promise<{ pipes: Rec[]; nbs: Rec[] }> => ev(`(() => { const W = window.__wp; return { pipes: W.pipes.filter((r) => r.phase === ${JSON.stringify(n)}), nbs: W.nbs.filter((r) => r.phase === ${JSON.stringify(n)}) }; })()`);
  const sum = (x: { pipes: Rec[]; nbs: Rec[] }) => `${x.pipes.length} pipelines (${x.pipes.filter(isMonster).length} monster), ${x.nbs.length} node builds (${x.nbs.filter(isMonster).length} monster)`;
  const hub0 = await since('boot');
  report.boot = { pipes: hub0.pipes.length, nbs: hub0.nbs.length };

  // ---- phase change 1: hub -> contract (risk 2: Hound, Listener, Mannequin, Snatcher; ears on) ----
  await mark('phase1');
  const st = await dbg('monsters.start', { seed: 'v13-warm', players: 1, risk: 2, contractIndex: 2 }) as { ok: boolean; agents: { kind: string }[] };
  log(`monsters.start ${JSON.stringify(st.agents.map((a) => a.kind))}`);
  await page.waitForFunction(() => (window.__game!.state() as { phase?: string }).phase === 'contract', undefined, { timeout: 20_000 });
  await page.waitForFunction(() => ((window as unknown as { __monsters?: { ears(): unknown[] } }).__monsters?.ears().length ?? 0) >= 2, undefined, { timeout: 15_000 }).catch(() => null);
  await sleep(Math.min(6000, Math.max(1500, (left() - 70) * 1000)));
  const ph1 = await since('phase1');
  report.phase1 = { summary: sum(ph1), monster: ph1.pipes.filter(isMonster), monsterNb: ph1.nbs.filter(isMonster) };
  log(`phase1: ${sum(ph1)}`);
  check('P2d hub -> contract: 0 new pipelines for monster objects (the Hound is in view at once)', ph1.pipes.filter(isMonster).length === 0, JSON.stringify(ph1.pipes.filter(isMonster).map((r) => `${r.root}/${r.o}/${r.cam}`)));
  check('P2d hub -> contract: 0 node builds for monster objects', ph1.nbs.filter(isMonster).length === 0, JSON.stringify(ph1.nbs.filter(isMonster).map((r) => `${r.root}/${r.o}/${r.cam}`)));
  const views = await ev<{ id: string; kind: string; model: boolean; visible: boolean }[]>('window.__monsters.views()');
  report.views = views;
  const ears = await ev<{ id: string; p: [number, number, number]; yaw: number; visible: boolean }[]>('window.__monsters.ears()');
  report.ears = ears;
  check('F6 the ears arrived (dyn entries -> meshes)', ears.length === 2 && ears.every((e) => e.visible), JSON.stringify(ears));

  // ---- the ear's first sight, under the flashlight ----
  if (ears.length) {
    await mark('ears');
    const e = ears[0];
    const nx = Math.sin(e.yaw), nz = Math.cos(e.yaw);
    const cx = e.p[0] + nx * 1.3, cz = e.p[2] + nz * 1.3;
    const yaw = Math.atan2(-nx, -nz);
    await page.evaluate(([x, z, y]) => { window.__game!.teleport(x, z, y); window.__game!.look(y, -0.08); }, [cx, cz, yaw] as const);
    await sleep(600);
    const lightOn = async () => ((await dbg('monsters.state')) as { poses: { light: number }[] }).poses[0]?.light === 1;
    for (let i = 0; i < 3 && !(await lightOn()); i++) { await page.evaluate(() => window.__game!.setInput({ flashlight: true })); await sleep(500); }
    await page.evaluate(([x, z, y]) => { window.__game!.teleport(x, z, y); window.__game!.look(y, -0.08); }, [cx, cz, yaw] as const);
    await sleep(1800);
    report.earShot = await shot(page, join(OUT, 'ear-lit.png'));
    const ec = await ev<{ id: string; curl: number }[]>('window.__monsters.ears()');
    report.earCurl = ec;
    check('F6 your beam on an ear: it curls shut (client tell for the deaf ear)', (ec.find((x) => x.id === e.id)?.curl ?? 0) > 0.5, JSON.stringify(ec));
    const sd = (await dbg('monsters.state')) as { ears: { id: string; deaf: boolean }[] };
    check('F6 ... and the server made it deaf', !!sd.ears.find((x) => x.id === e.id)?.deaf, JSON.stringify(sd.ears));
    const pe = await since('ears');
    report.earsWindow = { summary: sum(pe), monster: pe.pipes.filter(isMonster) };
    log(`ears: ${sum(pe)}`);
    check('F6 the ear in view: 0 new pipelines for it (warmed with the templates)', pe.pipes.filter((r) => r.root.startsWith('monsters:ear')).length === 0, JSON.stringify(pe.pipes.filter(isMonster).map((r) => `${r.root}/${r.o}/${r.cam}`)));

    // ---- the Listener's first sight (frozen, next to the ear) ----
    if (left() > 30) {
      await mark('listener');
      await dbg('monsters.freeze', { on: true });
      const tx = e.p[0] + nx * 0.8 + nz * 1.4, tz = e.p[2] + nz * 0.8 - nx * 1.4;
      await dbg('monsters.place', { id: 'listener0', x: tx, z: tz, yaw: Math.atan2(cx - tx, cz - tz), state: 'ambush', active: true });
      await page.evaluate(([x, z, y]) => { window.__game!.teleport(x, z, y); window.__game!.look(y, -0.05); }, [cx, cz, Math.atan2(tx - cx, tz - cz)] as const);
      await sleep(2200);
      report.listenerShot = await shot(page, join(OUT, 'listener-ear.png'));
      const pl = await since('listener');
      report.listenerWindow = { summary: sum(pl), monster: pl.pipes.filter(isMonster), monsterNb: pl.nbs.filter(isMonster) };
      log(`listener: ${sum(pl)}`);
      const mainL = pl.pipes.filter((r) => isMonster(r) && r.cam === 'main');
      check('P2d the Listener\'s first sight: 0 new scene-pass pipelines for monster objects', mainL.length === 0, JSON.stringify(pl.pipes.filter(isMonster).map((r) => `${r.root}/${r.o}/${r.cam}`)));
      await dbg('monsters.freeze', { on: false });
    }
  }

  // ---- phase change 2: contract -> hub ----
  if (left() > 18) {
    await mark('phase2');
    await dbg('monsters.hub');
    await page.waitForFunction(() => (window.__game!.state() as { phase?: string }).phase === 'hub', undefined, { timeout: 15_000 }).catch(() => null);
    await sleep(Math.min(5000, Math.max(1500, (left() - 10) * 1000)));
    const ph2 = await since('phase2');
    report.phase2 = { summary: sum(ph2), monster: ph2.pipes.filter(isMonster) };
    log(`phase2: ${sum(ph2)}`);
    check('P2d contract -> hub: 0 new pipelines for monster objects', ph2.pipes.filter(isMonster).length === 0, JSON.stringify(ph2.pipes.filter(isMonster).map((r) => `${r.root}/${r.o}/${r.cam}`)));
  } else log('skipped phase 2 (time)');
  const w1 = await ev<WarmStat>('window.__monsters.warm()');
  report.warmEnd = w1;
  check('P2d once per page: 1 warm-up, no re-warm, every phase change skipped', w1.warms === 1 && w1.rewarms === 0 && w1.phaseSkips >= 1, JSON.stringify(w1));
  const all = await ev<{ pipes: number; nbs: number; progs: number }>('({ pipes: window.__wp.pipes.length, nbs: window.__wp.nbs.length, progs: window.__wp.progs })');
  report.totals = all;
  report.errors = [...p.errors, ...(await page.evaluate(() => window.__game!.errors()).catch(() => []))].slice(0, 30);
} catch (e) {
  results.push({ name: 'run', pass: false, info: e instanceof Error ? e.stack ?? e.message : String(e) });
  console.log(`FAIL  run: ${e instanceof Error ? e.message : e}`);
  try { report.failShot = await shot(page, join(OUT, 'fail.png')); } catch { /* ignore */ }
} finally {
  report.results = results;
  report.sec = el();
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 1));
  await p.close();
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed in ${el()} s; report ${join(OUT, 'report.json')}`);
process.exitCode = failed.length ? 1 : 0;
setTimeout(() => process.exit(process.exitCode ?? 0), 300).unref();
