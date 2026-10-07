// Covered-view frame caps (2026-10-07 host crashes: the title menu drew the full Ultra backdrop at 240 Hz).
// Draw gate cadence on common refresh rates, cover-mode decisions, the menu resolution cap, config validation.
//   node --test tests/render/cover.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PERF_DEFAULTS, coverMode, drawInterval, gateDraw, pixelRatioFor, readPerfCfg } from '../../apps/client/src/render/perf.ts';
import type { CoverInputs, DrawGate } from '../../apps/client/src/render/perf.ts';
import type { Preset } from '../../apps/client/src/render/presets.ts';

const P = (name: string, res = 1): Preset => ({ name, shadowed: 6, unshadowed: 0, shadowMap: 2048, volumetric: true, volScale: 0.5, volSteps: 16, gtao: true, aoScale: 1, res, fixtures: 32, traa: true });

/** simulated rAF loop: `hz` refresh with optional deterministic jitter; returns draw timestamps */
function run(hz: number, secs: number, intervalMs: number, jitterMs = 0, start = 1000): number[] {
  const g: DrawGate = { last: 0 };
  const period = 1000 / hz;
  const draws: number[] = [];
  let seed = 12345;
  const jit = () => { seed = (seed * 1103515245 + 12345) >>> 0; return ((seed / 4294967296) * 2 - 1) * jitterMs; };
  for (let i = 0; i < hz * secs; i++) {
    const now = start + i * period + jit();
    if (gateDraw(g, now, intervalMs)) draws.push(now);
  }
  return draws;
}
const rate = (d: number[], secs: number) => d.length / secs;

test('30 fps on a 240 Hz display: every 8th frame, an even cadence', () => {
  const d = run(240, 10, 1000 / 30);
  assert.ok(Math.abs(rate(d, 10) - 30) <= 0.2, `rate ${rate(d, 10)}`);
  const gaps = d.slice(1).map((t, i) => t - d[i]);
  assert.ok(gaps.every((g) => Math.abs(g - 33.33) < 0.1), `gaps ${[...new Set(gaps.map((g) => g.toFixed(2)))]}`);
});

test('30 fps on 60 Hz (with rAF jitter) draws every 2nd frame, never drops to 20', () => {
  const d = run(60, 10, 1000 / 30, 0.8);
  assert.ok(Math.abs(rate(d, 10) - 30) <= 0.2, `rate ${rate(d, 10)}`);
});

test('30 fps on 144 Hz and 165 Hz averages 30 (alternating 4/5 or 5/6 frame gaps)', () => {
  for (const hz of [144, 165, 120, 75]) {
    const d = run(hz, 10, 1000 / 30, 0.3);
    assert.ok(Math.abs(rate(d, 10) - 30) <= 0.5, `${hz} Hz: rate ${rate(d, 10)}`);
  }
});

test('10 fps (unfocused menu) and the 1 s hold', () => {
  assert.ok(Math.abs(rate(run(240, 10, 100), 10) - 10) <= 0.2);
  assert.ok(Math.abs(rate(run(240, 10, 1000), 10) - 1) <= 0.11);
});

test('interval 0 draws every frame, Infinity never', () => {
  assert.equal(run(240, 2, 0).length, 480);
  assert.equal(run(240, 2, Infinity).length, 0);
});

test('a long stall resyncs instead of bursting to catch up', () => {
  const g: DrawGate = { last: 0 };
  const iv = 1000 / 30;
  const period = 1000 / 240;
  let t = 1000;
  for (let i = 0; i < 240; i++, t += period) gateDraw(g, t, iv);
  t += 600; // a 600 ms compile stall
  const after: number[] = [];
  for (let i = 0; i < 48; i++, t += period) if (gateDraw(g, t, iv)) after.push(t);
  const gaps = after.slice(1).map((x, i) => x - after[i]);
  assert.ok(gaps.every((x) => x > iv - 2), `burst after the stall: ${gaps.map((x) => x.toFixed(1))}`);
});

test('drawInterval per cover mode', () => {
  const cfg = { menuFps: 30, menuBlurFps: 10, coverFps: 60, maxFps: 0 };
  assert.equal(drawInterval('game', cfg, true), 0);
  assert.equal(drawInterval('hidden', cfg, true), Infinity);
  assert.equal(drawInterval('hold', cfg, true), 1000);
  assert.ok(Math.abs(drawInterval('cover', cfg, true) - 16.67) < 0.01);
  assert.ok(Math.abs(drawInterval('menu', cfg, true) - 33.33) < 0.01);
  assert.equal(drawInterval('menu', cfg, false), 100);
  // ?menufps=0&menublurfps=0 = the old uncapped behaviour (A/B measurements)
  assert.equal(drawInterval('menu', { ...cfg, menuFps: 0, menuBlurFps: 0 }, false), 0);
  // the blur cap never raises the rate above the focused one
  assert.ok(Math.abs(drawInterval('menu', { ...cfg, menuFps: 5 }, false) - 200) < 0.01);
  assert.ok(Math.abs(drawInterval('game', { ...cfg, maxFps: 144 }, true) - 6.94) < 0.01);
});

const base: CoverInputs = { testScene: false, hidden: false, hold: false, loadingVisible: false, loadingCovering: false, backdrop: false, screen: 'none' };

test('coverMode: the title menu, pre-join screens over the backdrop, and the menu after leaving a crew', () => {
  assert.equal(coverMode({ ...base, backdrop: true, screen: 'join' }), 'menu');
  assert.equal(coverMode({ ...base, backdrop: true, screen: 'brightness' }), 'menu');
  assert.equal(coverMode({ ...base, backdrop: false, screen: 'join' }), 'menu');
  assert.equal(coverMode({ ...base }), 'game');
  assert.equal(coverMode({ ...base, screen: 'board' }), 'game');
});

test('coverMode: the loading screen owns the view while it is up (warm-up needs the real preset + resolution)', () => {
  assert.equal(coverMode({ ...base, backdrop: true, screen: 'join', loadingVisible: true, loadingCovering: true }), 'cover');
  assert.equal(coverMode({ ...base, backdrop: true, screen: 'join', loadingVisible: true, loadingCovering: true, hold: true }), 'hold');
  // fading out over the game: full rate, never the menu cap
  assert.equal(coverMode({ ...base, screen: 'join', loadingVisible: true, loadingCovering: false }), 'game');
});

test('coverMode: ?scene=test look-dev is never throttled; hidden beats everything', () => {
  assert.equal(coverMode({ ...base, testScene: true, backdrop: true, screen: 'join' }), 'game');
  assert.equal(coverMode({ ...base, testScene: true, hidden: true }), 'hidden');
  assert.equal(coverMode({ ...base, hidden: true, hold: true, loadingCovering: true, loadingVisible: true }), 'hidden');
});

test('menu resolution cap: the desktop window (1615x939 CSS at DPR 1.5) and 4K', () => {
  const ON = { clamp: true, cap: true };
  const full = pixelRatioFor(1615, 939, 1.5, P('ultra'), PERF_DEFAULTS, 1, ON);
  assert.equal(full.w, 2423);
  const menu = pixelRatioFor(1615, 939, 1.5, P('ultra'), PERF_DEFAULTS, 1, { ...ON, extraCap: PERF_DEFAULTS.menuResCap });
  assert.ok(menu.w <= 1920 && menu.h <= 1080, `${menu.w}x${menu.h}`);
  assert.ok(menu.h >= 1078, `${menu.w}x${menu.h}`);
  const k4 = pixelRatioFor(2560, 1440, 1.5, P('ultra'), PERF_DEFAULTS, 1, { ...ON, extraCap: PERF_DEFAULTS.menuResCap });
  assert.equal(k4.w, 1920);
  assert.equal(k4.h, 1080);
  assert.equal(pixelRatioFor(2560, 1440, 1, P('ultra'), PERF_DEFAULTS, 1, { ...ON, extraCap: [1600, 900] }).w, 1600);
  // below the cap nothing changes
  assert.equal(pixelRatioFor(1280, 720, 1, P('low', 0.75), PERF_DEFAULTS, 1, { ...ON, extraCap: PERF_DEFAULTS.menuResCap }).w, 960);
});

test('readPerfCfg: covered-view defaults, validation', () => {
  const d = readPerfCfg({});
  assert.equal(d.menuFps, 30);
  assert.equal(d.menuBlurFps, 10);
  assert.equal(d.coverFps, 60);
  assert.equal(d.maxFps, 0);
  assert.deepEqual(d.menuResCap, [1920, 1080]);
  const bad = readPerfCfg({ menuFps: -3, coverFps: 'x', menuResCap: [0, 5] });
  assert.equal(bad.menuFps, 0);
  assert.equal(bad.coverFps, 0);
  assert.deepEqual(bad.menuResCap, [1920, 1080]);
});
