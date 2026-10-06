// Track ④ Voice features e2e: VAD chunk streaming to the server, consent, calibration + echo check, server path
// distance (aud) present, SFX manifest + play, heartbeat, Join-screen mic section screenshot.
//   node tests/voice/features.e2e.ts   (BASE_URL default http://127.0.0.1:3004, server with --dev)
import type { Page } from 'playwright-core';
import { launchPlayer as launchRaw, screenshot } from '../lib/launch.ts';
import type { LaunchOpts, Player } from '../lib/launch.ts';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3004';
/** launch + swallow Vite's HMR socket (other agents edit the shared tree: a full reload mid-test loses state) */
async function launchPlayer(o: LaunchOpts): Promise<Player> {
  const p = await launchRaw(o);
  await p.page.routeWebSocket(/token=/, () => {});
  await p.page.reload({ waitUntil: 'domcontentloaded' });
  return p;
}
const ALPHA = 'BCDFGHJKLMNPQRSTVWXZ';
const crew = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => ALPHA[b % ALPHA.length]).join('');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name: string, ok: boolean, info = '') => { if (!ok) failed++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${info}`); };

async function ev<T, A>(page: Page, fn: (a: A) => T | Promise<T>, arg: A, tries = 15): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      await page.waitForFunction(() => !!window.__voiceDebug && !!window.__game?.me(), undefined, { timeout: 30_000 });
      return (await page.evaluate(fn as never, arg)) as T;
    } catch (e) {
      if (i >= tries) throw e;
      await sleep(500);
    }
  }
}

interface VState { players: { id: string; name: string; band: number; consent: { transcribe: boolean }; chunks: { segs: number; chunks: number; samples: number; badSeq: number; lastMaxBand: number } | null }[] }

const talker = await launchPlayer({ name: 'Talker', wav: 'talk_en.wav', baseUrl: BASE, crew, query: { autojoin: '1' } });
const quiet = await launchPlayer({ name: 'Quiet', wav: 'silence.wav', baseUrl: BASE, crew, query: { autojoin: '1' } });
const joinPage = await launchPlayer({ name: 'Joiner', wav: 'silence.wav', baseUrl: BASE, crew });
try {
  const idT = await ev(talker.page, () => window.__game!.me()!, null);
  const idQ = await ev(quiet.page, () => window.__game!.me()!, null);
  await sleep(7000);
  const st = await ev(talker.page, () => window.__game!.dbg('voice.state') as Promise<unknown>, null) as VState;
  const t = st.players.find((p) => p.id === idT);
  const q = st.players.find((p) => p.id === idQ);
  check('consent synced to the server (transcribe default ON)', t?.consent.transcribe === true, JSON.stringify(t?.consent));
  check('talker streams VAD segments (PCM16 16 kHz chunks)', !!t?.chunks && t.chunks.segs >= 1 && t.chunks.samples >= 16000 && t.chunks.badSeq === 0,
    JSON.stringify(t?.chunks));
  check('chunk size = 100 ms (1600 samples)', !!t?.chunks && Math.abs(t.chunks.samples / t.chunks.chunks - 1600) < 200, t?.chunks ? String(t.chunks.samples / t.chunks.chunks) : '');
  let maxBand = t?.band ?? 0;
  for (let i = 0; i < 12 && maxBand === 0; i++) {
    await sleep(250); // talk_en.wav has pauses: poll a few samples
    const s2 = (await ev(talker.page, () => window.__game!.dbg('voice.state') as Promise<unknown>, null)) as VState;
    maxBand = Math.max(maxBand, s2.players.find((p) => p.id === idT)?.band ?? 0);
  }
  check('server sees talker band > 0 (loud messages)', maxBand > 0, `band ${maxBand}`);
  check('silent player sends no segments and band 0', !q?.chunks && q?.band === 0, JSON.stringify({ band: q?.band, chunks: q?.chunks }));
  // opt out -> no more chunks
  await ev(talker.page, () => (window.__voiceDebug as unknown as { service(): { setTranscribe(on: boolean): void } }).service().setTranscribe(false), null);
  await sleep(1500);
  const c0 = ((await ev(talker.page, () => window.__game!.dbg('voice.state') as Promise<unknown>, null)) as VState).players.find((p) => p.id === idT)?.chunks?.chunks ?? 0;
  await sleep(2500);
  const st2 = (await ev(talker.page, () => window.__game!.dbg('voice.state') as Promise<unknown>, null)) as VState;
  const t2 = st2.players.find((p) => p.id === idT);
  check('opt-out stops chunk streaming + consent false on server', (t2?.chunks?.chunks ?? 0) === c0 && t2?.consent.transcribe === false, `${c0} -> ${t2?.chunks?.chunks}`);
  await ev(talker.page, () => (window.__voiceDebug as unknown as { service(): { setTranscribe(on: boolean): void } }).service().setTranscribe(true), null);
  // server path distance (① Net) for the other speaker
  const aud = await ev(quiet.page, () => (window.__voiceDebug as unknown as { aud(): Record<string, number> }).aud(), null);
  check('snapshot aud has a path distance for the other player', typeof aud[idT] === 'number', JSON.stringify(aud));
  // calibration + echo check (fake mic, no acoustic loop => no echo)
  const cal = await ev(talker.page, () => (window.__voiceDebug as unknown as { calibrate(o: unknown): Promise<{ ok: boolean; reason?: string; data?: { noiseDb: number; talkDb: number }; echo?: { echo: boolean; residualDb: number; pickupDb: number } }> }).calibrate({ whisper: false, shout: false, echo: true }), null);
  check('calibration finds a talk baseline', cal.ok && Number.isFinite(cal.data?.talkDb), JSON.stringify(cal));
  check('echo check runs (no echo through a fake mic)', !!cal.echo && cal.echo.echo === false, JSON.stringify(cal.echo));
  // SFX + ambience
  const n = await ev(talker.page, () => (window as unknown as { __audioDebug: { manifest(): Promise<number> } }).__audioDebug.manifest(), null);
  check('sfx manifest loads (sfx.* keys)', n > 0, `${n} keys`);
  const played = await ev(talker.page, () => (window as unknown as { __audioDebug: { play(k: string, p?: number[]): boolean } }).__audioDebug.play('sfx.door_open', [2, 1, 2]), null);
  check('sfx.play(variant family, pos) returns a handle', played === true);
  const missing = await ev(talker.page, () => (window as unknown as { __audioDebug: { play(k: string): boolean } }).__audioDebug.play('sfx.does_not_exist'), null);
  check('sfx.play(missing key) -> null, no throw', missing === false);
  await ev(talker.page, () => (window as unknown as { __audioDebug: { fear(v: number): void } }).__audioDebug.fear(0.8), null);
  await sleep(800);
  // Join screen with the mic section
  await joinPage.page.waitForSelector('.voice-join', { timeout: 20_000 });
  await sleep(1200);
  console.log('screenshot', await screenshot(joinPage.page, 'tests/artifacts/voice/join-mic.png'));
  const errs = [talker, quiet, joinPage].flatMap((p) => p.errors).filter((e) => /voice|audio|sfx|RTC|worklet/i.test(e));
  check('no voice/audio errors', errs.length === 0, errs.slice(0, 4).join(' | '));
} finally {
  await Promise.all([talker.close(), quiet.close(), joinPage.close()]);
}
console.log(failed ? `${failed} FAILED` : 'all passed');
process.exitCode = failed ? 1 : 0;
