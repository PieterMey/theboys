// env-audio (v1.2) GPU e2e, ONE guarded run (real Chrome, WebGPU, ?preset=low):
//   node tools/gpu-guard.mjs --max-sec 120 -- node tests/audio/audio.e2e.ts
// against a dev server (BASE_URL, default http://127.0.0.1:3815) started with NODE_ENV=development AI_MODE=mock
// SAVES_DIR=<scratch>/saves SESSION_FILE=<scratch>/session.json. Checks: hums audible in a lit room; a switched-off
// room and a full switch-off are silent (exactly 0 hum gain / hum bus RMS); every synth kind plays with no exceptions
// and the node count returns to the baseline; every kind's real Web Audio level (OfflineAudioContext) is sane;
// fear sources, a theme bed, occlusion of a far sound; no audio errors. One screenshot.
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Page } from 'playwright-core';
import { REPO, launchPlayer as launchRaw, screenshot } from '../lib/launch.ts';
import type { LaunchOpts, Player } from '../lib/launch.ts';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3815';
const OUT = process.env.AUDIO_E2E_OUT ?? join(REPO, 'tests/artifacts/audio');
const SEED = `e5-audio-${Date.now() % 100000}`;
const t0 = Date.now();
const log = (m: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { name: string; ok: boolean; info: string }[] = [];
const check = (name: string, ok: boolean, info: unknown = '') => {
  const s = typeof info === 'string' ? info : JSON.stringify(info);
  results.push({ name, ok, info: s.slice(0, 600) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${s.slice(0, 300)}`);
};

/** launch + swallow Vite's HMR socket (other agents edit the shared tree: a full reload mid-test loses state) */
async function launchPlayer(o: LaunchOpts): Promise<Player> {
  const p = await launchRaw(o);
  await p.page.routeWebSocket(/token=/, () => {});
  await p.page.reload({ waitUntil: 'domcontentloaded' });
  return p;
}

interface FixRow { i: number; space: number; kind: string; voice: string | null; pos: [number, number, number]; state: string; level: number }
interface HumRow { i: number; space: number; kind: string; voice: string; target: number; gain: number }
interface AD {
  fixtures(): FixRow[];
  hums(): HumRow[];
  humRms(ms?: number): Promise<number>;
  levelSource(): string;
  nodes(): { sfx: number; live: number; synth: number; liveSynth: number; assets: number; liveAssets: number; hums: number; beds: number; total: number };
  kinds(): string[];
  synthAll(pos?: number[] | null): { kind: string; ok: boolean; err?: string }[];
  renderOffline(kind: string, o?: Record<string, unknown>): Promise<{ kind: string; peak: number; rmsDb: number; dur: number; voices: number; bad: number } | null>;
  fearSrc(s: string, v: number, ms?: number): void;
  fearState(): { value: number; target: number; sources: Record<string, number> };
  bedTheme(t: string | null | undefined): void;
  beds(): { active: string[]; layers: string[]; nodes: number } | null;
  reverb(): { mix: number; wet: number; room: { space: number; volume: number; surface: string } | null };
  probe(p: number[]): { walls: number; gain: number; freq: number; send: number; legacyHz: number } | null;
}
/** run fn(window.__audioDebug, arg) in the page (string expression: evaluated by CDP, promises awaited) */
const ad = <T>(page: Page, fn: (a: AD, arg: unknown) => T | Promise<T>, arg: unknown = null): Promise<T> =>
  page.evaluate(`(${fn.toString()})(window.__audioDebug, ${JSON.stringify(arg)})`) as Promise<T>;
const dbg = (page: Page, r: string, a: unknown) => page.evaluate(({ r: rr, a: aa }) => window.__game!.dbg(rr, aa), { r, a });
/** rAF callbacks in one second of the page (a fresh level compiles its pipelines first: frames stall for seconds) */
const fps = (page: Page) => page.evaluate(() => new Promise<number>((res) => {
  let n = 0;
  let done = false;
  const t = performance.now();
  const end = () => { if (!done) { done = true; res(n); } };
  const f = () => { n++; if (performance.now() - t < 1000) requestAnimationFrame(f); else end(); };
  requestAnimationFrame(f);
  setTimeout(end, 1500); // a stalled compositor never calls rAF back: report what we got
}));
/** poll fn until ok(value) or timeout; returns the last value and the ms it took */
async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs: number, stepMs = 100): Promise<{ v: T; ms: number; ok: boolean }> {
  const s = Date.now();
  let v = await fn();
  while (!ok(v) && Date.now() - s < timeoutMs) { await sleep(stepMs); v = await fn(); }
  return { v, ms: Date.now() - s, ok: ok(v) };
}

const ALPHA = 'BCDFGHJKLMNPQRSTVWXZ';
const crew = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => ALPHA[b % ALPHA.length]).join('');
const p = await launchPlayer({ name: 'AudioE5', baseUrl: BASE, crew, query: { autojoin: '1', preset: 'low' } });
let summary: Record<string, unknown> = {};
try {
  await p.page.waitForFunction(() => !!window.__game?.me() && !!(window as unknown as { __audioDebug?: unknown }).__audioDebug, undefined, { timeout: 45_000, polling: 250 });
  log(`joined ${crew}`);
  const gen = await dbg(p.page, 'level.generate', { seed: SEED, players: 2 });
  log(`level.generate ${JSON.stringify(gen).slice(0, 160)}`);
  await p.page.waitForFunction((s) => (window as unknown as { __levelDebug?: { info(): { seed?: string } | null } }).__levelDebug?.info()?.seed === s, SEED, { timeout: 30_000, polling: 250 });
  // no monster sounds / deaths during the checks (they are unit-tested: tests/audio/sfx.test.ts)
  await dbg(p.page, 'monsters.stop', {}).catch((e: unknown) => log(`monsters.stop: ${e}`));
  // the fresh level compiles its pipelines first (no loading overlay under ?test=1): wait for steady frames, or every
  // frame-driven check below would read stale state (the first v1.2 run lost its hum checks to an ~12 s stall)
  const steady = await until(() => fps(p.page), (n) => n >= 20, 40_000, 0);
  log(`frames steady: ${steady.v}/s after ${steady.ms} ms`);
  check('frame loop running before the checks', steady.ok, { fps: steady.v, waitedMs: steady.ms });

  // ---- the lit room with the most tube fixtures
  const fx = await ad(p.page, (a) => a.fixtures());
  const source = await ad(p.page, (a) => a.levelSource());
  const by = new Map<number, FixRow[]>();
  for (const f of fx) if (f.voice === 'tube' && f.level > 0.5) by.set(f.space, [...(by.get(f.space) ?? []), f]);
  const best = [...by.entries()].sort((x, y) => y[1].length - x[1].length)[0];
  check('layout has lit tube fixtures', !!best, { fixtures: fx.length, kinds: [...new Set(fx.map((f) => f.kind))], source });
  if (!best) throw new Error('no lit room');
  const [S, roomFx] = best;
  const at = roomFx[0].pos;
  // server-authoritative teleport (movement validation would snap a client-only one back) + the local pose
  await dbg(p.page, 'net.teleport', { x: at[0], z: at[2], yaw: 0 }).catch((e: unknown) => log(`net.teleport: ${e}`));
  await p.page.evaluate(([x, z]) => window.__game!.teleport(x, z, 0), [at[0], at[2]]);
  const inRoom = await until(() => ad(p.page, (a) => a.reverb()), (r) => r.room?.space === S, 10_000);
  const rv = inRoom.v;
  check('listener room drives the reverb blend (small room <-> hall)', inRoom.ok && rv.mix >= 0 && rv.mix <= 1, { ...rv, ms: inRoom.ms });
  const lit = await until(() => ad(p.page, (a) => a.hums()), (hs) => hs.some((h) => h.space === S && h.voice === 'tube' && h.gain > 0.3), 5_000);
  const mine = lit.v.filter((h) => h.space === S);
  const rmsOn = await ad(p.page, (a) => a.humRms(500));
  check('lit room hums (tube voices, audible on the hum bus)', lit.ok && rmsOn > -80, { space: S, hums: mine, rmsDb: +rmsOn.toFixed(1), source });

  // ---- a switched-off room is silent (the client-side 0.3 s bound is unit-tested; here: it happens, and exactly)
  await dbg(p.page, 'interaction.setLights', { space: S, on: false });
  const off = await until(() => ad(p.page, (a) => a.hums()), (hs) => { const m = hs.filter((h) => h.space === S); return m.length > 0 && m.every((h) => h.target === 0 && h.gain === 0); }, 4_000, 50);
  check('switched-off room: its hums are exactly 0', off.ok, { ms: off.ms, hums: off.v.filter((h) => h.space === S) });
  await dbg(p.page, 'interaction.setLights', { space: 'all', on: false });
  const allOff = await until(() => ad(p.page, (a) => a.hums()), (hs) => hs.every((h) => h.gain === 0), 4_000, 50);
  const rmsOff = await ad(p.page, (a) => a.humRms(400));
  check('every light off: the hum bus is silent', allOff.ok && rmsOff < -100, { rmsDb: rmsOff, ms: allOff.ms, hums: allOff.v.length });
  await dbg(p.page, 'interaction.setLights', { space: 'all', on: true });
  const back = await until(() => ad(p.page, (a) => a.hums()), (hs) => hs.some((h) => h.space === S && h.gain > 0.3), 5_000);
  const rmsBack = await ad(p.page, (a) => a.humRms(400));
  check('lights back on: the hum returns', back.ok && rmsBack > -80, { rmsDb: +rmsBack.toFixed(1), ms: back.ms });

  // ---- every synth kind: plays, no exceptions, node count back to the baseline
  await sleep(2500); // switch tinks done
  const base = await ad(p.page, (a) => a.nodes());
  const rows = await ad(p.page, (a, pos) => a.synthAll(pos as number[]), [at[0] + 1, 1.2, at[2] + 1]);
  check('synthAll: every kind plays without an exception', rows.length === 16 && rows.every((r) => r.ok), rows.filter((r) => !r.ok));
  const during = await ad(p.page, (a) => a.nodes());
  check('synth voices are live while playing', during.liveSynth >= 16 && during.synth > base.synth, { base, during });
  // real Web Audio levels of every kind (OfflineAudioContext) while the live ones play out
  const kinds = await ad(p.page, (a) => a.kinds());
  const levels: { kind: string; peak: number; rmsDb: number; bad: number }[] = [];
  for (const k of kinds) {
    const r = await ad(p.page, (a, kk) => a.renderOffline(kk as string, { seed: 7 }), k);
    if (r) levels.push({ kind: r.kind, peak: +r.peak.toFixed(3), rmsDb: +r.rmsDb.toFixed(1), bad: r.bad });
  }
  check('offline Web Audio render: every kind audible, finite, not clipping', levels.length === kinds.length && levels.every((l) => l.bad === 0 && l.peak > 0.05 && l.peak < 1), levels);
  // (other systems may play asset sounds meanwhile: the synth voices have their own count; an emergency light's tick
  // is a synth voice too, so wait for a moment with none live)
  let after = await ad(p.page, (a) => a.nodes());
  for (let i = 0; i < 30 && !(after.liveSynth === 0 && after.synth <= base.synth); i++) { await sleep(500); after = await ad(p.page, (a) => a.nodes()); }
  check('node count returns to the baseline after the synth sounds end', after.liveSynth === 0 && after.synth === base.synth, { base, after });

  // ---- fear: max over sources, expiry
  await ad(p.page, (a) => { a.fearSrc('spotted', 1, 1500); a.fearSrc('paranormal', 0.4, 4000); });
  await sleep(900);
  const f1 = await ad(p.page, (a) => a.fearState());
  await sleep(1200);
  const f2 = await ad(p.page, (a) => a.fearState());
  check('fear(source, v, ms): max over sources, spotted expires', f1.value > 0.6 && f1.sources.spotted === 1 && f2.target === 0.4 && !('spotted' in f2.sources), { f1, f2 });
  await ad(p.page, (a) => a.fearSrc('paranormal', 0));

  // ---- a theme bed (forced: the dbg generator builds facility layouts)
  await ad(p.page, (a) => a.bedTheme('waterworks'));
  await sleep(1500);
  const bed = await ad(p.page, (a) => a.beds());
  const bedNodes = (await ad(p.page, (a) => a.nodes())).beds;
  check('waterworks bed plays (water + air layers)', !!bed && bed.layers.includes('waterworks:water') && bedNodes > 0, { bed, bedNodes });
  await ad(p.page, (a) => a.bedTheme(undefined));

  // ---- occlusion of a far sound (opts.occlude) vs the v1.1 lowpass
  const far = fx.filter((f) => f.space !== S).map((f) => ({ f, d: Math.hypot(f.pos[0] - at[0], f.pos[2] - at[2]) })).filter((x) => x.d > 6 && x.d < 16).sort((x, y) => x.d - y.d)[0];
  if (far) {
    const pr = await ad(p.page, (a, pos) => a.probe(pos as number[]), [far.f.pos[0], 1.2, far.f.pos[2]]);
    check('a sound in another room is occluded (gain < 1, send > 0)', !!pr && pr.walls > 0 && pr.gain < 1 && pr.send >= 0, pr);
  }
  // the bed fades over fadeSec and its nodes are reaped after ~2 x fadeSec
  const freed = await until(() => ad(p.page, (a) => a.nodes()), (n) => n.beds === 0, 8_000, 250);
  check('the forced bed fades out and frees its nodes', freed.ok, { beds: freed.v.beds, ms: freed.ms });

  // ---- errors
  const gameErr = await p.page.evaluate(() => window.__game!.errors());
  const audioErr = [...gameErr, ...p.errors].filter((e) => /audio|sfx|synth|AudioParam|AudioNode|hum|bed|reverb/i.test(e));
  check('no audio errors (game + console + page)', audioErr.length === 0, audioErr.slice(0, 6));
  mkdirSync(OUT, { recursive: true });
  log(`screenshot ${await screenshot(p.page, join(OUT, 'audio-e2e.png'))}`);
  summary = { crew, seed: SEED, space: S, levelSource: source, rmsOn, rmsOff, rmsBack, levels, backend: await p.page.evaluate(() => window.__game!.backend()) };
} catch (e) {
  check('e2e ran to the end', false, e instanceof Error ? e.message : String(e));
} finally {
  await p.close();
}
const failed = results.filter((r) => !r.ok).length;
const file = process.env.AUDIO_E2E_JSON;
if (file) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify({ results, summary, sec: (Date.now() - t0) / 1000 }, null, 2)); }
console.log(failed ? `${failed} FAILED` : 'all passed', `(${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exitCode = failed ? 1 : 0;
