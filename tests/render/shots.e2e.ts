// Track ③ quick look tool: screenshots of test-scene views with extra query params (debug toggles, presets).
//   node tests/render/shots.e2e.ts --views blackout,room --q "rdebug=novol" --tag novol [--webgl]
import { launchPlayer, screenshot } from '../lib/launch.ts';

const arg = (k: string, d: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const BASE = arg('base', process.env.BASE_URL ?? 'http://127.0.0.1:3003');
const views = arg('views', 'corridor,room,crossing,blackout,six').split(',');
const tag = arg('tag', 'look');
const extra = Object.fromEntries(new URLSearchParams(arg('q', '')));
const webgl = process.argv.includes('--webgl');
const out = arg('out', 'tests/artifacts');
const p = await launchPlayer({ baseUrl: BASE, webgl, query: { scene: 'test', ...extra }, viewport: { width: 1280, height: 720 } });
try {
  await p.page.waitForFunction(() => !!window.__render && window.__game?.ready() === true, undefined, { timeout: 60_000, polling: 100 });
  await p.page.waitForFunction(() => Number(window.__render!.info().frames) > 60, undefined, { timeout: 60_000, polling: 100 });
  await p.page.addStyleTag({ content: '#overlay{display:none!important}' });
  for (const v of views) {
    await p.page.evaluate((n) => window.__render!.view(n), v);
    await p.page.waitForTimeout(900);
    const st = await p.page.evaluate(() => window.__render!.stats());
    const f = await screenshot(p.page, `${out}/render_${tag}_${v}.png`);
    console.log(`${v} fps=${st.fps.toFixed(0)} gpu=${st.gpuMs?.toFixed(2)} draws=${st.drawCalls} ${f}`);
  }
  const errs = [...p.errors, ...(await p.page.evaluate(() => window.__game!.errors()))];
  console.log(errs.length ? `ERRORS:\n${errs.slice(0, 6).join('\n')}` : 'no errors');
} finally {
  await p.close();
}
