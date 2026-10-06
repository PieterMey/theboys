// P3 QA: does a test player actually move with setInput (hub, then contract)? prints fps + local/server pose.
//   BASE_URL=http://127.0.0.1:3096 node tests/qa/move-probe.e2e.ts
import { WS_URL, connectBot, log, qaPlayer, randomCrew, sleep, st } from './lib.ts';

const crew = randomCrew();
const L = await connectBot({ url: WS_URL, crew, name: 'Lead' });
const p = await qaPlayer('Ann', 'silence.wav', crew);
const id = (await st(p.page)).me;
const pose = async () => ((await L.dbg('players.pose', { id })) as { pose: { p: number[] } }).pose.p.map((v) => +v.toFixed(2));
const walk = async (label: string, yaw: number) => {
  const a = await pose();
  const la = await p.page.evaluate(() => window.__players!.local());
  const f0 = await p.page.evaluate(() => window.__game!.perf());
  await p.page.evaluate((y) => { window.__game!.look(y, 0); window.__game!.setInput({ forward: 1 }); }, yaw);
  const samples: string[] = [];
  for (let i = 0; i < 6; i++) {
    await sleep(300);
    samples.push(await p.page.evaluate(() => { const l = window.__players!.local(); const d = (window.__game!.state() as { diag: { players?: { st?: unknown; frozen?: unknown; vel?: unknown } } }).diag.players; return `${l.p.map((v) => v.toFixed(2))} spd ${l.speed.toFixed(2)} st ${JSON.stringify(d?.st)} frozen ${JSON.stringify(d?.frozen)}`; }));
  }
  await p.page.evaluate(() => window.__game!.setInput({ forward: 0 }));
  await sleep(500);
  const b = await pose();
  const f1 = await p.page.evaluate(() => window.__game!.perf());
  log(`${label}: fps ${f0.fps.toFixed(0)}->${f1.fps.toFixed(0)} frameMs ${f1.frameMs.toFixed(1)} | server ${a} -> ${b} | local start ${la.p.map((v) => v.toFixed(2))} dead=${la.dead}\n    ${samples.join('\n    ')}`);
};
try {
  await sleep(2000);
  await walk('hub', Math.PI);
  await L.dbg('objectives.start', { realSec: 600 });
  await p.page.waitForFunction(() => (window.__game!.state() as { phase: string }).phase === 'contract', undefined, { timeout: 20_000 });
  await sleep(5000);
  await walk('contract', Math.PI);
  await sleep(5000);
  await walk('contract +5s', 0);
} finally {
  L.close();
  await p.close();
  setTimeout(() => process.exit(0), 300).unref();
}
