// Gate P (integrator): server CPU per system with 6 ws bots in a fixed-seed facility (no browser, no GPU).
//   node tests/gates/p-server.e2e.ts --ws ws://127.0.0.1:3895/ws --seed gp-6 [--theme records] [--sec 20] [--freeze 0]
// Prints dbg.perf (ms of CPU per wall second per system tick / snapshot hook, event-loop delay) as JSON.
import { Bot, sleep } from './p-lib.ts';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const WS = arg('ws', 'ws://127.0.0.1:3895/ws');
if (/:(3000|3100)\//.test(WS)) throw new Error('refusing the live ports');
const SEED = arg('seed', 'gp-6');
const THEME = arg('theme', '');
const SEC = Number(arg('sec', '20'));
const FREEZE = arg('freeze', '0') === '1';
const crew = `PS${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const bots = Array.from({ length: 6 }, (_, i) => new Bot(`Srv${i}`));
const out: Record<string, unknown> = { ws: WS, seed: SEED, theme: THEME || null, sec: SEC, crew };
try {
  await bots[0].connect(WS, crew);
  for (const b of bots.slice(1)) await b.connect(WS, crew);
  const gen = await bots[0].dbg<Record<string, unknown>>('level.generate', { seed: SEED, players: 6, risk: 2, ...(THEME ? { theme: THEME } : {}) });
  out.layout = { hash: gen.hash, theme: gen.theme ?? null, genMs: gen.genMs };
  await bots[0].dbg('net.validate', { on: false });
  if (FREEZE) await bots[0].dbg('monsters.freeze', { on: true }).catch(() => null);
  const L = (await bots[0].req<{ layout: { items: { kind: string; x: number; z: number }[] } }>('level.get', {})).layout;
  const spawns = L.items.filter((i) => i.kind === 'spawn_player');
  const t0 = performance.now();
  let stop = false;
  // walk 1.4 m circles at ~2 m/s around each spawn, flashlights on
  const walk = (async () => {
    while (!stop) {
      const t = (performance.now() - t0) / 1000;
      bots.forEach((b, i) => {
        const s = spawns[i % spawns.length];
        const a = t * 1.4 + i;
        b.target = { x: s.x + Math.cos(a) * 1.4, z: s.z - 2 + Math.sin(a) * 1.4, yaw: a + Math.PI / 2, pitch: 0, light: 1, anim: 1 };
      });
      await sleep(50);
    }
  })();
  await sleep(3000);
  await bots[0].dbg('perf');
  await sleep(SEC * 1000);
  out.perf = await bots[0].dbg('perf');
  out.stats = await bots[0].dbg('stats');
  out.paranormal = await bots[0].dbg<Record<string, unknown>>('paranormal.state').then((s) => ({ running: s.running, avgTickMs: s.avgTickMs }), () => null);
  stop = true;
  await walk;
} catch (e) {
  out.error = String(e);
} finally {
  for (const b of bots) b.close();
}
console.log(JSON.stringify(out, null, 1));
process.exit(0);
