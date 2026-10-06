// Track (e) end-to-end STT test: REAL faster-whisper sidecar + REAL dev server (all tracks) + a ws bot.
//   node tests/ai/stt.e2e.ts            (starts the dev server on PORT 3015 itself; needs the sidecar: npm run stt)
//   node tests/ai/stt.e2e.ts --external (use an already running server at BASE_URL / PORT)
// The bot joins a crew, consents to transcription, swaps in the facility_s1_p2 fixture layout (dbg.ai.layout),
// stands in SHOWERS and streams tests/fixtures/voice/callsign_boiler.wav ("boiler, meet in boiler", resampled
// 48 kHz -> 16 kHz) as 100 ms voice chunks at talk band, in real time. A fake Listener (dbg.ai.fakeListener) is
// placed at an ~8 m path distance (heard at talk radius 10 m), then at ~15 m (not heard).
// Asserts: utterance arrives, callsign normalized to BOILER, speaker room SHOWERS, hearers.listener true/false.
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { BAND } from '../../packages/shared/src/constants.ts';
import { Bot, startDevServer, waitHttp, wav16k } from './bot.ts';
import { initialDoorOpen } from '../../packages/shared/src/nav/index.ts';
import type { Utterance } from '../../packages/shared/src/messages/ai.ts';
import { Hearing } from '../../apps/server/src/stt/hearing.ts';
import { REPO, loadLayout } from './helpers.ts';

const external = process.argv.includes('--external');
const PORT = Number(process.env.PORT ?? 3015);
const BASE = process.env.BASE_URL ?? `http://127.0.0.1:${PORT}`;
const STT = process.env.STT_URL ?? 'http://127.0.0.1:3100';
const SPK: [number, number] = [7.5, 3.5]; // SHOWERS in facility_s1_p2

function fail(msg: string): never {
  console.error(`stt.e2e FAILED: ${msg}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const ok = await waitHttp(`${STT}/health`, 60_000, async (r) => r.ok && ((await r.json()) as { warm?: boolean }).warm === true);
  if (!ok) fail(`STT sidecar not warm at ${STT} (start it: npm run stt)`);
  let server: ChildProcess | null = null;
  if (!external) {
    server = startDevServer(PORT, STT);
  }
  try {
    if (!(await waitHttp(`${BASE}/healthz`, 30_000))) fail(`server not up at ${BASE}`);
    const crew = `E${randomBytes(2).toString('hex').toUpperCase().replace(/[^A-Z]/g, 'K')}`.slice(0, 4);
    const bot = new Bot(`${BASE.replace(/^http/, 'ws')}/ws`, crew, 'Sam');
    await bot.ready();
    await bot.req('voice.consent', { transcribe: true }).catch(() => bot.req('consent.set', { transcribe: true, mimic: false }));
    // a real contract on the fixture layout (objectives' dbg hook; meta adopts it), monsters off: a fake Listener
    try {
      await bot.req('dbg.objectives.start', { fixture: 'facility_s1_p2', monsters: false, realSec: 600 });
    } catch (err) {
      console.log(`objectives.start unavailable (${err instanceof Error ? err.message : err}); using dbg.ai.layout`);
      await bot.req('dbg.ai.layout', { fixture: 'facility_s1_p2', phase: 'contract' });
    }
    await new Promise((r) => setTimeout(r, 400));
    await bot.req('dbg.ai.place', { x: SPK[0], z: SPK[1] });
    const st = await bot.req<{ phase: string; layout: { seed: string } | null }>('dbg.state');
    console.log(`crew ${crew}: phase ${st.phase}, layout ${st.layout?.seed}`);

    // fake Listener positions at ~8 m and ~15 m path distance (same metric as the server)
    const L = loadLayout('facility_s1_p2');
    const H = new Hearing(L);
    const open = initialDoorOpen(L);
    const pick = (lo: number, hi: number): [number, number] => {
      for (let z = 0; z < L.H; z++) for (let x = 0; x < L.W; x++) {
        if (L.owner[z * L.W + x] < 0) continue;
        const d = H.dist(SPK[0], SPK[1], x + 0.5, z + 0.5, open);
        if (d >= lo && d <= hi) return [x + 0.5, z + 0.5];
      }
      throw new Error(`no cell ${lo}-${hi}`);
    };
    const near = pick(7.6, 8.4);
    const far = pick(14.6, 15.4);
    const pcm = wav16k(join(REPO, 'tests/fixtures/voice/callsign_boiler.wav'));

    const run = async (segId: number, at: [number, number]): Promise<{ u: Utterance; latencyMs: number }> => {
      await bot.req('dbg.ai.fakeListener', { x: at[0], z: at[1] });
      const before = (await bot.req<{ utterances: Utterance[] }>('dbg.ai.utterances')).utterances.length;
      const endAt = await bot.speak(pcm, segId, BAND.talk);
      for (let i = 0; i < 80; i++) {
        const list = (await bot.req<{ utterances: Utterance[] }>('dbg.ai.utterances')).utterances;
        if (list.length > before) return { u: list[list.length - 1], latencyMs: Math.round(performance.now() - endAt) };
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`no utterance for seg ${segId} (sidecar transcribed nothing?)`);
    };

    const a = await run(1, near);
    const b = await run(2, far);
    const checks: [string, boolean][] = [
      [`transcript mentions boiler: "${a.u.text}"`, /boiler/i.test(a.u.text)],
      [`callsign normalized: ${JSON.stringify(a.u.callsigns)}`, a.u.callsigns.includes('BOILER')],
      [`speaker room at onset: ${a.u.room}`, a.u.room === 'SHOWERS'],
      [`lang: ${a.u.lang}`, a.u.lang === 'en'],
      [`meaningful: ${a.u.meaningful}`, a.u.meaningful],
      [`Listener at ${near.join(',')} (~8 m) heard: ${a.u.hearers.listener} (${a.u.hearers.listenerDistM} m)`, a.u.hearers.listener === true],
      [`Listener at ${far.join(',')} (~15 m) not heard: ${b.u.hearers.listener}`, b.u.hearers.listener === false],
      [`second utterance callsign: ${JSON.stringify(b.u.callsigns)}`, b.u.callsigns.includes('BOILER')],
    ];
    let bad = 0;
    for (const [what, pass] of checks) {
      console.log(`${pass ? 'ok  ' : 'FAIL'} ${what}`);
      if (!pass) bad++;
    }
    console.log(`speech end -> utterance on the server: ${a.latencyMs} ms, ${b.latencyMs} ms (STT ${a.u.sttMs} / ${b.u.sttMs} ms)`);
    const status = await bot.req<{ stt: unknown }>('dbg.ai.status');
    console.log(`stt status: ${JSON.stringify(status.stt)}`);
    bot.ws.close();
    if (bad) fail(`${bad} check(s) failed`);
    console.log('stt.e2e OK');
  } finally {
    if (server) server.kill();
  }
}

main().then(() => setTimeout(() => process.exit(0), 300), (e) => fail(e instanceof Error ? e.message : String(e)));
