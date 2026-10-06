// P3 QA: server cost under a busy contract (N Chrome players walking + talking, 2 bots, monsters awake).
// Prints dbg.perf (ms of CPU per wall second per system/hook + event-loop delay) and the snapshot rate.
//   BASE_URL=http://127.0.0.1:3096 node tests/qa/perf.e2e.ts [--n 4] [--secs 60]
import { WS_URL, connectBot, dbg, log, probe, qaPlayer, randomCrew, sleep } from './lib.ts';
import type { Bot, QaPlayer } from './lib.ts';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? process.argv[i + 1] : d; };
const N = Number(arg('n', '4'));
const SECS = Number(arg('secs', '60'));
const crew = randomCrew();
const WAVS = ['talk_en.wav', 'whisper.wav', 'shout.wav', 'silence.wav'];
const players: QaPlayer[] = [];
const bots: Bot[] = [];
try {
  for (let i = 0; i < N; i++) players.push(await qaPlayer(`P${i + 1}`, WAVS[i % 4], crew, { viewport: { width: 320, height: 180 }, query: { preset: 'high' } }));
  for (let i = 0; i < 2; i++) bots.push(await connectBot({ url: WS_URL, crew, name: `Bot-${i + 1}` }));
  await bots[0].dbg('objectives.start', { realSec: 900 });
  await bots[0].waitFor(() => bots[0].full?.phase === 'contract', 20_000, 'contract');
  await sleep(4000);
  await bots[0].dbg('objectives.doors', { open: true });
  await bots[0].dbg('monsters.wake').catch(() => undefined);
  for (const [i, p] of players.entries()) await p.page.evaluate((k) => { window.__game!.setInput({ flashlight: true }); window.__game!.look(k * 1.3, 0); window.__game!.setInput({ forward: 1 }); }, i);
  // bots wander between random walkable cells
  const wander = async (b: Bot) => {
    const L = b.layout!;
    for (let k = 0; k < 40; k++) {
      const x = 1 + Math.floor(Math.random() * (L.W - 2)) + 0.5, z = 1 + Math.floor(Math.random() * (L.H - 2)) + 0.5;
      if (L.owner[Math.floor(z) * L.W + Math.floor(x)] < 0) continue;
      await b.goTo(x, z, { speed: 3, timeoutMs: 15_000 }).catch(() => undefined);
    }
  };
  for (const b of bots) void wander(b);
  await dbg(players[0].page, 'perf');
  const s0 = (await dbg<{ snaps: number; ticks: number }>(players[0].page, 'stats'));
  const t0 = performance.now();
  let prev = { snaps: s0.snaps, ticks: s0.ticks, at: t0 };
  while (performance.now() - t0 < SECS * 1000) {
    await sleep(10_000);
    for (const [i, p] of players.entries()) await p.page.evaluate((k) => { window.__game!.look(Math.random() * 6.28, 0); window.__game!.setInput({ forward: 1, sprint: k % 2 === 0 }); }, i).catch(() => {});
    const perf = await dbg<{ sec: number; msPerSec: Record<string, number>; eventLoopDelayMs: Record<string, number> }>(players[0].page, 'perf');
    const s = await dbg<{ snaps: number; ticks: number }>(players[0].page, 'stats');
    const now = performance.now();
    const dt = (now - prev.at) / 1000;
    const pr = await Promise.all(players.map(probe));
    log(`snap ${((s.snaps - prev.snaps) / dt).toFixed(1)} Hz tick ${((s.ticks - prev.ticks) / dt).toFixed(1)} Hz | eld ${JSON.stringify(perf.eventLoopDelayMs)} | clients ${pr.map((x) => `${x.snapHz}Hz/${x.fps}fps`).join(' ')}`);
    log(`  cost ms/s: ${Object.entries(perf.msPerSec).slice(0, 12).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    prev = { snaps: s.snaps, ticks: s.ticks, at: now };
  }
} finally {
  for (const b of bots) b.close();
  for (const p of players) await p.close().catch(() => {});
  setTimeout(() => process.exit(0), 300).unref();
}
