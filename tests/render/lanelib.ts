// Owner: env-render (v1.3). Shared software-lane helpers for tests/render/*.e2e.ts: page.evaluate with a timeout, the
// in-page counters (draws per pass per drawn frame, pipelines created per drawn frame tagged with the test's phase and
// whether a site warm was pending, renderer JS per frame) and the median-frame draw sampler. No browser here.
import type { Page } from 'playwright-core';
import { sleep } from '../gates/p-lib.ts';

export async function ev<T>(page: Page, fn: string, ms = 20_000): Promise<T> {
  return Promise.race([page.evaluate(fn) as Promise<T>, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`evaluate timed out (${ms} ms): ${fn.slice(0, 70)}`)), ms))]);
}

/** in-page counters (window.__bx) */
export const INSTALL = `(() => {
  if (window.__bx) return 'already';
  const t = window.__render && window.__render.three && window.__render.three();
  if (!t) return 'no __render.three';
  const { scene, renderer, camera, THREE } = t;
  const info = renderer.info;
  const pp = renderer._pipelines;
  const bx = { count: false, pass: new Map(), frames: [], phase: 'boot', log: [], renderMs: [] };
  let shadowCams = new Set();
  bx.refresh = () => { shadowCams = new Set(); scene.traverse((o) => { if (o.isLight && o.castShadow && o.shadow && o.shadow.camera) shadowCams.add(o.shadow.camera); }); };
  bx.refresh();
  const passOf = (cam, object) => { const rc = renderer._currentRenderContext; return !rc ? '?' : cam === camera ? 'main' : shadowCams.has(cam) ? 'shadow' : (object && object.isQuadMesh) ? 'post' : 'other'; };
  const up = info.update.bind(info);
  info.update = function (object, count, instanceCount) {
    up(object, count, instanceCount);
    if (!bx.count) return;
    const rc = renderer._currentRenderContext;
    const k = passOf(rc && rc.camera, object);
    bx.pass.set(k, (bx.pass.get(k) || 0) + 1);
  };
  const rs = info.reset.bind(info);
  info.reset = function () {
    // only frames counted from their first draw (every draw attributed to a pass)
    let sum = 0; for (const v of bx.pass.values()) sum += v;
    if (bx.count && info.render.drawCalls > 0 && sum === info.render.drawCalls) { bx.frames.push({ draws: info.render.drawCalls, pass: Object.fromEntries(bx.pass) }); if (bx.frames.length > 40) bx.frames.shift(); }
    bx.pass = new Map(); rs();
  };
  bx.pipelines = () => ({ pipelines: pp && pp.caches ? pp.caches.size : -1, vs: pp && pp.programs ? pp.programs.vertex.size : -1, fs: pp && pp.programs ? pp.programs.fragment.size : -1 });
  const P = THREE.RenderPipeline.prototype;
  const origRender = P.render;
  P.render = function () {
    const n0 = pp.caches.size;
    const t0 = performance.now();
    origRender.call(this);
    const ms = performance.now() - t0;
    const made = pp.caches.size - n0;
    bx.renderMs.push(ms); if (bx.renderMs.length > 2000) bx.renderMs.splice(0, 1000);
    if (made > 0) {
      let warm = false;
      try { const w = window.__render.siteWarm(); warm = (w && w.pending > 0) || false; } catch (e) { /* old build */ }
      bx.log.push({ phase: bx.phase, made, warm, ms: Math.round(ms) });
      if (bx.log.length > 3000) bx.log.splice(0, 1000);
    }
  };
  window.__bx = bx;
  return 'ok';
})()`;

export const q = (a: number[], p: number) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(s.length * p))].toFixed(2); };

/** the median drawn frame (by draws) over ms of counting */
export async function draws(page: Page, ms = 1500): Promise<{ draws: number; pass: Record<string, number> } | null> {
  await ev(page, '(window.__bx.frames.length = 0, window.__bx.count = true, 1)');
  await sleep(ms);
  const fr = await ev<{ draws: number; pass: Record<string, number> }[]>(page, '(window.__bx.count = false, window.__bx.frames.slice())');
  return fr.sort((a, b) => b.draws - a.draws)[Math.floor(fr.length / 2)] ?? null;
}


/** fragment program sizes of the page so far (KB of shader source) */
export const PROGRAM_STATS = `(() => {
  const pp = window.__render.three().renderer._pipelines;
  const lens = [...pp.programs.fragment.values()].map((p) => String(p.code || '').length).sort((a, b) => a - b);
  const kb = (n) => +(n / 1024).toFixed(1);
  return { n: lens.length, p50KB: kb(lens[Math.floor(lens.length / 2)] || 0), maxKB: kb(lens[lens.length - 1] || 0), totalKB: Math.round(lens.reduce((a, b) => a + b, 0) / 1024), over20KB: lens.filter((n) => n > 20480).length };
})()`;
