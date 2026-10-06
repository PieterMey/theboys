// P3 QA diagnostics: N Chrome players join one crew (same join path as the soak: load -> HMR mute -> reload),
// full console capture (incl. [voice] info + WebGPU warnings), voice peer states over time, then a dbg contract.
//   BASE_URL=http://127.0.0.1:3096 node tests/qa/probe.e2e.ts [--n 2] [--low 1] [--contract] [--secs 40]
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUT, WS_URL, connectBot, dbg, log, probe, qaPlayer, randomCrew, sleep } from './lib.ts';
import type { Bot } from './lib.ts';
import type { QaPlayer } from './lib.ts';

const arg = (k: string, d?: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 ? process.argv[i + 1] : d;
};
const N = Number(arg('n', '2'));
const PRESET = arg('preset', arg('low', '') === '1' ? 'low' : '');
const WEBGL = process.argv.includes('--webgl');
const SECS = Number(arg('secs', '40'));
const CREW = arg('crew') ?? randomCrew();
const WAVS = ['talk_en.wav', 'whisper.wav', 'shout.wav', 'silence.wav'];
const players: QaPlayer[] = [];
const bots: Bot[] = [];
const NBOTS = Number(arg('bots', '0'));
const consoleLog: Record<string, string[]> = {};
try {
  for (let i = 0; i < N; i++) {
    const name = `P${i + 1}`;
    consoleLog[name] = [];
    const p = await qaPlayer(name, WAVS[i % WAVS.length], CREW, { query: i > 0 ? { ...(PRESET ? { preset: PRESET } : {}), ...(WEBGL ? { webgl: '1' } : {}) } : {} });
    consoleLog[name] = p.console;
    players.push(p);
    log(`${name} joined`);
  }
  for (let i = 0; i < NBOTS; i++) bots.push(await connectBot({ url: WS_URL, crew: CREW, name: `Bot-${i + 1}` }));
  const t0 = performance.now();
  while (performance.now() - t0 < SECS * 1000) {
    await sleep(5000);
    const pr = await Promise.all(players.map(probe));
    log(pr.map((x) => `${x.name} voice ${x.voice.connected}/${x.voice.peers} [${x.voice.states.join(' ')}] err ${x.errors}`).join(' | '));
  }
  if (process.argv.includes('--contract')) {
    log(`dbg contract: ${JSON.stringify(await dbg(players[0].page, 'objectives.start', { realSec: 120 }))}`);
    await sleep(15_000);
    const pr = await Promise.all(players.map(probe));
    log(pr.map((x) => `${x.name} ${x.phase} ${x.fps}fps voice ${x.voice.connected}/${x.voice.peers} err ${x.errors}`).join(' | '));
  }
  for (const p of players) {
    const errs = await p.page.evaluate(() => window.__game!.errors());
    log(`${p.name}: ${errs.length} __game.errors(); first: ${errs.slice(0, 3).join(' || ').slice(0, 1200)}`);
    const vlog = await p.page.evaluate(() => (window as unknown as { __voiceDebug?: { logs?: () => string[] } }).__voiceDebug?.logs?.() ?? null);
    if (vlog) log(`${p.name} voice log:\n    ${vlog.join('\n    ')}`);
  }
} finally {
  const file = join(OUT, `probe-${CREW}.json`);
  writeFileSync(file, JSON.stringify(consoleLog, null, 1));
  log(`console capture: ${file}`);
  for (const b of bots) b.close();
  for (const p of players) await p.close().catch(() => {});
  setTimeout(() => process.exit(0), 500).unref();
}
