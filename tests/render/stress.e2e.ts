// Track ③ Render stress/look test: ?scene=test (fixture layout corridors + rooms, 6 flashlights, fixtures, fog,
// full post stack) on BOTH backends. Asserts 0 console/page/WebGPU errors, measures fps/gpuMs, and saves
// screenshots tests/artifacts/render_<backend>_<view>.png. Needs a dev server: PORT=3003 npm run dev
//   node tests/render/stress.e2e.ts [--base http://127.0.0.1:3003] [--preset high] [--only webgpu] [--views a,b]
import { launchPlayer, screenshot } from '../lib/launch.ts';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const BASE = arg('base', process.env.BASE_URL ?? 'http://127.0.0.1:3003');
const PRESET = arg('preset', '');
const ONLY = arg('only', '');
const VIEWS = arg('views', 'corridor,room,crossing,blackout,six,core').split(',');
const W = Number(arg('w', '1280'));
const H = Number(arg('h', '720'));

interface Result { backend: string; view: string; fps: number; gpuMs?: number; drawCalls?: number; shot: string }
const results: Result[] = [];
let failed = 0;

for (const webgl of [false, true]) {
  const label = webgl ? 'webgl2' : 'webgpu';
  if (ONLY && ONLY !== label) continue;
  const p = await launchPlayer({ baseUrl: BASE, webgl, query: { scene: 'test', ...(PRESET ? { preset: PRESET } : {}) }, viewport: { width: W, height: H } });
  try {
    await p.page.waitForFunction(() => !!window.__render && window.__game?.ready() === true, undefined, { timeout: 60_000, polling: 100 });
    // the core loop starts only after every track's install: wait until frames advance
    await p.page.waitForFunction(() => Number(window.__render!.info().frames) > 60, undefined, { timeout: 60_000, polling: 100 });
    await p.page.addStyleTag({ content: '#overlay{display:none!important}' });
    const info = await p.page.evaluate(() => window.__render!.info());
    console.log(`[${label}] info`, JSON.stringify(info));
    const backend = await p.page.evaluate(() => window.__game!.backend());
    if (backend !== label) { console.log(`FAIL backend ${backend} != ${label}`); failed++; }
    const names = await p.page.evaluate(() => window.__render!.views());
    for (const v of VIEWS) {
      if (!names.includes(v)) { console.log(`skip view ${v} (not in layout)`); continue; }
      await p.page.evaluate((n) => window.__render!.view(n), v);
      await p.page.waitForTimeout(400);
      await p.page.evaluate(() => window.__render!.hitch()); // view switch itself excluded
      await p.page.waitForTimeout(1200); // TRAA history settles, fps EMA converges
      const st = await p.page.evaluate(() => window.__render!.stats());
      const hitch = await p.page.evaluate(() => window.__render!.hitch());
      if (hitch > 100) { console.log(`WARN [${label}] ${v}: ${hitch.toFixed(0)} ms frame hitch after warm-up`); }
      const shot = await screenshot(p.page, `tests/artifacts/render_${label}_${v}.png`);
      results.push({ backend: label, view: v, fps: Math.round(st.fps), gpuMs: st.gpuMs !== undefined ? Math.round(st.gpuMs * 100) / 100 : undefined, drawCalls: st.drawCalls, shot });
      console.log(`[${label}] ${v}: fps=${st.fps.toFixed(0)} gpuMs=${st.gpuMs?.toFixed(2) ?? '-'} draws=${st.drawCalls} maxFrame=${hitch.toFixed(0)}ms -> ${shot}`);
    }
    // preset sweep (live switch) must not error
    for (const pr of ['low', 'medium', 'ultra', 'high']) {
      await p.page.evaluate((n) => window.__render!.setPreset(n), pr);
      await p.page.waitForTimeout(400);
    }
    const errs = [...p.errors, ...(await p.page.evaluate(() => window.__game!.errors()))].filter((e) => !/favicon/.test(e));
    if (errs.length) { failed++; console.log(`FAIL [${label}] ${errs.length} errors:\n  ${errs.slice(0, 8).join('\n  ')}`); }
    else console.log(`PASS [${label}] 0 console/page/WebGPU errors`);
  } catch (e) {
    failed++;
    console.log(`FAIL [${label}]`, e instanceof Error ? e.message.split('\n')[0] : e);
    console.log(p.errors.slice(0, 8).join('\n'));
  } finally {
    await p.close();
  }
}
console.table(results.map(({ shot, ...r }) => ({ ...r, shot: shot.split(/[\\/]/).pop() })));
console.log(failed ? `render stress FAILED (${failed})` : 'render stress PASSED');
process.exitCode = failed ? 1 : 0;
