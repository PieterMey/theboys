// v1.3 P2a in a real browser (one SwiftShader Chrome + one ws bot; GPU-guarded): the drive preload request leaves the
// page before the facility is built, the van waits for that page's net.loaded, and the arrival cover is the short one
// for a page that finished its preload. Also checks the P5 'core.diag' lines (ids only) and that the page logged no
// errors. Needs a dev server on BASE (default http://127.0.0.1:3890, started OUTSIDE the guard, with ASSETS_DIR set);
// refuses the live server's ports and hosts (refuseLive).
// Run: node tools/gpu-guard.mjs --max-sec 120 -- node tests/core/preload-lane.e2e.ts
//   SERVER_LOG=<the dev server's log file> lets it check the server lines (preloaded / phase / [diag]).
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { launchPlayer, screenshot, waitForGame } from '../lib/launch.ts';
import { TestClient, refuseLive, sleep } from './lib.ts';
import type { Ev } from './lib.ts';

const BASE = process.env.BASE ?? 'http://127.0.0.1:3890';
const PORT = Number(new URL(BASE).port || 80);
refuseLive(PORT, BASE); // never the live server (:3000, :3100, dead-air.io), before the page or the bot touches BASE
const OUT = process.env.OUT ?? join(process.env.TEMP ?? '.', 'dead-air-core-lane');
const SERVER_LOG = process.env.SERVER_LOG ?? '';
const T0 = Date.now();
const el = () => `${((Date.now() - T0) / 1000).toFixed(1)}s`;
const results: { name: string; ok: boolean; info: string }[] = [];
const check = (name: string, ok: boolean, info = '') => { results.push({ name, ok, info }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ` (${info})` : ''}`); };

type Trace = { incomingAt: number; askedAt: number; phaseAt: number; replyAt: number; buildAt: number; rebuiltAt: number; doneAt: number; ok: boolean | null; from: string };
const crew = `LANE${Math.floor(Math.random() * 90 + 10)}`;
const player = await launchPlayer({ name: 'Ann', baseUrl: BASE, crew, query: { loading: '1' } });
const bot = new TestClient('Botty', { build: 'bot' });
let code = 1;
try {
  const { page } = player;
  await waitForGame(page, 60_000);
  console.log(`${el()} game ready`);
  await page.evaluate((c) => window.__game!.join(c), crew);
  const me = await page.evaluate(() => window.__game!.me());
  await bot.connect(PORT, crew);
  console.log(`${el()} joined ${crew} as ${me} (+ bot)`);
  await sleep(1500);

  // the page drives (it is the leader); the bot watches the server's events
  let driveEv: Ev | null = null;
  bot.onEv = (ev) => { if (!driveEv && ev.e === 'phase' && (ev.d as { phase: string }).phase === 'drive') driveEv = ev; };
  const rep = await page.evaluate(() => window.__game!.req!('meta.drive', {})) as { ok?: boolean; reason?: string };
  check('the drive starts', rep?.ok === true, JSON.stringify(rep));
  await page.waitForFunction(() => (window.__game!.state() as { phase: string }).phase === 'drive', undefined, { timeout: 10_000 });
  await sleep(2500);
  await screenshot(page, join(OUT, 'drive.png'));

  // server side: when did the page's net.preload arrive? ('net.loading' is broadcast by the net.preload handler)
  const firstLoading = bot.events.find((e) => e.e === 'net.loading' && (e.d as { waiting?: string[] }).waiting?.length);
  const askMs = driveEv && firstLoading ? firstLoading.t - (driveEv as Ev).t : NaN;
  // server clock: drive event sent -> net.preload handled. In the lane a SwiftShader frame (~0.5 s, up to ~1.5 s) delays
  // the delivery of the page's socket messages, so this bound is loose (runs saw 779 and 1434 ms; v1.2 asked only after
  // the 1.2 s paint sleep plus the site build); the page-side trace below is the exact check (asked in the same task as
  // the event, before any build), and the van waits for the page either way (P2b)
  check('net.preload reached the server within 3 s of the drive event', Number.isFinite(askMs) && askMs < 3000, `${Math.round(askMs)} ms`);

  // the van holds for the page until it reports net.loaded, then the contract starts
  await page.waitForFunction(() => (window.__game!.state() as { phase: string }).phase === 'contract', undefined, { timeout: 75_000, polling: 250 });
  console.log(`${el()} contract`);
  const st = await page.evaluate(() => { const d = (window.__game!.state() as { diag: Record<string, unknown> }).diag; return { preload: d.preload, arrival: d.arrival, level: d.level }; }) as { preload: Trace; arrival: { warm: boolean; capMs: number } | undefined; level: { kind?: string } };
  const p = st.preload;
  console.log(`preload trace (page ms): ${JSON.stringify(p)}`);
  check('the request was sent from the drive event itself (net:phase-incoming)', p.from === 'early' && p.askedAt >= 0 && p.askedAt - p.incomingAt <= 5, `asked ${p.askedAt - p.incomingAt} ms after the event`);
  const firstBuild = p.rebuiltAt >= 0 ? Math.min(p.rebuiltAt, p.buildAt >= 0 ? p.buildAt : Infinity) : p.buildAt;
  check('the request left before the facility was built', firstBuild >= 0 && p.askedAt <= firstBuild, `asked ${p.askedAt}, first facility build ${firstBuild} (${p.rebuiltAt >= 0 ? 'the drive event carried the facility' : 'built by the preload'})`);
  check('the preload build waited for the 1.2 s paint', p.buildAt - p.askedAt >= 1150, `${p.buildAt - p.askedAt} ms`);
  check('the preload finished during the drive', p.ok === true && p.doneAt > p.buildAt, `done after ${p.doneAt - p.askedAt} ms`);
  check('arrival cover: short (12 s) for the preloaded site', st.arrival?.warm === true && st.arrival?.capMs === 12_000, JSON.stringify(st.arrival));
  const contractEv = bot.events.find((e) => e.e === 'phase' && (e.d as { phase: string }).phase === 'contract');
  const endsAt = ((driveEv as Ev | null)?.d as { state?: { meta?: { drive?: { endsAt?: number } } } } | undefined)?.state?.meta?.drive?.endsAt ?? 0;
  check('the contract started after the page reported loaded', !!contractEv, contractEv && endsAt ? `${((contractEv.t - endsAt) / 1000).toFixed(1)} s after the drive timer` : 'no contract event');

  await sleep(4000);
  await screenshot(page, join(OUT, 'arrival.png'));
  // P5: let one diag window go out (every 30 s from the welcome)
  const waitUntil = T0 + 100_000;
  let lines: string[] = [];
  while (Date.now() < waitUntil) {
    lines = SERVER_LOG && existsSync(SERVER_LOG) ? readFileSync(SERVER_LOG, 'utf8').split(/\r?\n/).filter((l) => l.includes('[diag]') || l.includes('[ws]') || l.includes('[loading]')) : [];
    if (!SERVER_LOG || lines.some((l) => l.includes(`${me} `) && /\d+s (hub|drive|contract)\//.test(l))) break;
    await sleep(1000);
  }
  if (SERVER_LOG) {
    const joinLine = lines.find((l) => l.includes(`${me} join:`));
    check('[diag] join line (id only, bucketed GPU, forced WebGL2 on SwiftShader)', !!joinLine && /gpu google\/software webgl2 \(no webgpu: forced\)/.test(joinLine) && !joinLine.includes('Ann'), joinLine ?? 'missing');
    const winLine = lines.find((l) => l.includes(`${me} `) && /\d+s (hub|drive|contract)\//.test(l));
    check('[diag] window line (frames, gap, LoAF, pipelines, draws, rtt app + ws)', !!winLine && /frames \d+ gapMax \d+ ms/.test(winLine) && /pipes \+\d+/.test(winLine) && !winLine.includes('Ann'), winLine ?? 'missing');
    const pre = lines.find((l) => l.includes('Ann preloaded the site'));
    check('[loading] the server logged the preload', !!pre, pre ?? 'missing');
  }
  const errs = player.errors.filter((e) => !/favicon|DevTools/.test(e));
  check('no page errors', errs.length === 0, errs.slice(0, 5).join(' | '));
  code = results.every((r) => r.ok) ? 0 : 1;
} catch (e) {
  console.error('preload-lane: ERROR', e instanceof Error ? e.message : e);
  console.error(player.errors.slice(0, 10).join('\n'));
} finally {
  await bot.close();
  await player.close();
  console.log(`preload-lane: ${results.filter((r) => r.ok).length}/${results.length} checks passed (${el()})`);
  process.exitCode = code;
  setTimeout(() => process.exit(code), 500).unref();
}
