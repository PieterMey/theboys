// Live voice -> STT -> Listener pipeline, end to end with REAL Chrome players (the way friends play):
//   node tests/ai/live-pipeline.e2e.ts           (BASE_URL default http://127.0.0.1:3501: a --dev server; needs npm run stt)
//   node tests/ai/live-pipeline.e2e.ts --spawn   (spawns its own dev server on PORT (default 3501), NET_SESSION=0, temp saves)
// Three Chrome processes with fake mics: Ann talk_en.wav, Bob callsign_boiler.wav, Cat silence.wav. Fresh profiles, so
// every default is a new player's: the invite link (#CODE) opens the main menu on PLAY, a real click on JOIN CREW (the
// user gesture that unlocks audio + starts the mic), the brightness check, transcription consent left at its default.
// Real lobby: the leader picks a work order (meta.pick), everyone readies (meta.ready), the drive is waited out.
// Every hop is checked:
//   client voice frames on the game socket (WebSocket.send hook) -> server onVoiceChunk (dbg.voice.state)
//   -> STT bridge segments (dbg.ai.sttState run counters; none in the hub: sttPhases = contract)
//   -> POSTs to the sidecar (its /health encoderReuseHits grows; bridge lastMs set) -> transcripts (dbg.ai.utterances)
//   -> the dormant, frozen Listener placed next to Bob remembers his "boiler" line (hearers.listener = true);
//      moved back to its far spawn it hears none of the later lines.
// The Hound is frozen with the rest of the monsters so nobody dies mid-test. Transcripts stay in this process' stdout.
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { REPO, launchPlayer, screenshot } from '../lib/launch.ts';
import type { Player } from '../lib/launch.ts';

const SPAWN = process.argv.includes('--spawn');
const PORT = Number(process.env.PORT ?? 3501);
const BASE = process.env.BASE_URL ?? `http://127.0.0.1:${PORT}`;
const STT = process.env.STT_URL ?? 'http://127.0.0.1:3100';
const ALPHA = 'BCDFGHJKLMNPQRSTVWXZ';
const CREW = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => ALPHA[b % ALPHA.length]).join('');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const results: { name: string; ok: boolean; info: string }[] = [];
const check = (name: string, ok: boolean, info = '') => {
  results.push({ name, ok, info });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${info}`);
};

interface VoiceFrames { frames: number; starts: number; ends: number }
interface Utt { segId: number; speaker: string; speakerName: string; text: string; band: number; hearers: { players: string[]; listener: boolean; listenerDistM?: number }; sttMs: number; startedAt: number }
interface RunPlayer { name: string; chunks: number; consentChunks: number; segments: number; dropped: number; utterances: number; empty: number; failed: number; heard: number; maxBand: number }
interface SttState { run: { phase: string; listenerNearestM: number | null; players: Record<string, RunPlayer> } | null; players: { id: string; open: { segId: number } | null }[] }
interface VState { players: { id: string; name: string; band: number; consent: { transcribe: boolean }; chunks: { segs: number; chunks: number; samples: number; badSeq: number } | null }[] }
interface MAgent { id: string; kind: string; x: number; z: number; dormant?: boolean; memory?: { text: string; speaker?: string | null; segId?: string }[] }
interface MState { mode: string; frozen?: boolean; agents?: MAgent[]; poses?: { id: string; p: number[] }[] }
interface AiStatus { stt: { segments: number; utterances: number; dropped: number; lastMs: number | null; healthy: boolean | null } }
type W = {
  __game: { me(): string | null; state(): { phase?: string } | null; dbg(r: string, a?: unknown): Promise<unknown>; req?(r: string, a?: unknown): Promise<unknown> };
  __meta?: { screen(): string };
  __voiceDebug?: { logs(): string[]; level(): unknown; service(): { transcribe(): boolean; pushToTalk(): boolean; transmitting(): boolean; hasMic(): boolean } };
  __vc?: VoiceFrames;
};

/** init script: count voice frames (0x01 + 9-byte header + PCM) the page sends on the GAME socket (not Vite's) */
function frameCounter(): void {
  const w = window as unknown as W;
  w.__vc = { frames: 0, starts: 0, ends: 0 };
  const orig = WebSocket.prototype.send;
  WebSocket.prototype.send = function (this: WebSocket, d: string | ArrayBufferLike | Blob | ArrayBufferView) {
    try {
      const u8 = d instanceof Uint8Array ? d : d instanceof ArrayBuffer ? new Uint8Array(d) : null;
      if (u8 && u8.length > 9 && u8[0] === 1 && /\/ws/.test(this.url)) {
        w.__vc!.frames++;
        if (u8[7] & 1) w.__vc!.starts++;
        if (u8[7] & 2) w.__vc!.ends++;
      }
    } catch { /* never break the game socket */ }
    return orig.call(this, d as never);
  };
}

async function ev<T, A>(page: Page, fn: (a: A) => T | Promise<T>, arg: A, tries = 6): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return (await page.evaluate(fn as never, arg)) as T;
    } catch (e) {
      if (i >= tries) throw e;
      await sleep(500);
    }
  }
}
const dbg = <T>(p: Player, r: string, a?: unknown) => ev(p.page, ({ r, a }: { r: string; a?: unknown }) => (window as unknown as W).__game.dbg(r, a), { r, a }) as Promise<T>;
const req = <T>(p: Player, r: string, a?: unknown) => ev(p.page, ({ r, a }: { r: string; a?: unknown }) => (window as unknown as W).__game.req!(r, a), { r, a }) as Promise<T>;
const frames = (p: Player) => ev(p.page, () => ({ ...(window as unknown as W).__vc! }), null);
const sidecarHits = async (): Promise<number> => ((await (await fetch(`${STT}/health`, { signal: AbortSignal.timeout(3000) })).json()) as { encoderReuseHits?: number }).encoderReuseHits ?? 0;

/** the real join: main menu (invite link -> PLAY panel), click JOIN CREW, then the new-player brightness check */
async function joinLikeAFriend(p: Player): Promise<string> {
  await p.page.addInitScript(frameCounter);
  await p.page.routeWebSocket(/token=/, () => {}); // swallow Vite HMR: other agents edit the tree mid-test
  await p.page.reload({ waitUntil: 'domcontentloaded' });
  const btn = '[data-testid=join-panel] button[type=submit]:not([disabled])';
  await p.page.waitForSelector(btn, { timeout: 90_000 });
  await p.page.click(btn);
  await p.page.waitForFunction(() => !!(window as unknown as W).__game?.me(), undefined, { timeout: 90_000, polling: 200 });
  return (await ev(p.page, () => (window as unknown as W).__game.me(), null))!;
}

async function settleScreens(ps: Player[]): Promise<string[]> {
  let scr: string[] = [];
  for (let i = 0; i < 40; i++) {
    scr = await Promise.all(ps.map((p) => ev(p.page, () => (window as unknown as W).__meta?.screen?.() ?? 'n/a', null)));
    for (const [k, p] of ps.entries()) if (scr[k] === 'brightness') await p.page.getByText('LOOKS RIGHT').click({ timeout: 3000 }).catch(() => {});
    if (scr.every((s) => s === 'none')) break;
    await sleep(750);
  }
  return scr;
}

async function main(): Promise<void> {
  let server: ChildProcess | null = null;
  const srvOut: string[] = [];
  if (SPAWN) {
    const saves = mkdtempSync(join(tmpdir(), 'dead-air-live-pipeline-'));
    server = spawn(process.execPath, ['--env-file-if-exists=C:/Users/Pieter/repos/theboys/.env', join(REPO, 'apps/server/src/index.ts'), '--dev'], {
      env: { ...process.env, PORT: String(PORT), AI_MODE: 'mock', STT_URL: STT, NODE_ENV: 'development', NET_SESSION: '0', SAVES_DIR: saves },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const keep = (d: Buffer) => { for (const l of String(d).split('\n')) if (/\[stt\]/.test(l)) srvOut.push(l); };
    server.stdout?.on('data', keep);
    server.stderr?.on('data', keep);
  }
  const players: Player[] = [];
  try {
    const health = await fetch(`${STT}/health`, { signal: AbortSignal.timeout(3000) }).then((r) => r.json() as Promise<{ warm?: boolean }>).catch(() => null);
    if (!health?.warm) throw new Error(`STT sidecar not warm at ${STT} (start it: npm run stt)`);
    for (let i = 0; i < 120; i++) {
      if (await fetch(`${BASE}/healthz`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok).catch(() => false)) break;
      await sleep(500);
    }
    console.log(`crew ${CREW} @ ${BASE}, sidecar ${STT}`);

    // ---------------- join like three friends (one after another, as they did tonight)
    const ann = await launchPlayer({ name: 'Ann', wav: 'talk_en.wav', baseUrl: BASE, crew: CREW });
    players.push(ann);
    const idA = await joinLikeAFriend(ann);
    const bob = await launchPlayer({ name: 'Bob', wav: 'callsign_boiler.wav', baseUrl: BASE, crew: CREW });
    players.push(bob);
    const idB = await joinLikeAFriend(bob);
    const cat = await launchPlayer({ name: 'Cat', wav: 'silence.wav', baseUrl: BASE, crew: CREW });
    players.push(cat);
    const idC = await joinLikeAFriend(cat);
    const scr = await settleScreens(players);
    console.log(`joined: Ann ${idA}, Bob ${idB}, Cat ${idC}; screens ${scr.join('/')}`);
    const status0 = await dbg<AiStatus>(ann, 'ai.status');
    const hits0 = await sidecarHits();

    // ---------------- hub: consent defaults synced, PCM streams, nothing transcribed outside the contract
    await sleep(6000);
    const vs = await dbg<VState>(ann, 'voice.state');
    const vp = (id: string) => vs.players.find((p) => p.id === id);
    check('new players: transcription consent defaults ON and reaches the server', [idA, idB, idC].every((id) => vp(id)?.consent.transcribe === true),
      JSON.stringify(vs.players.map((p) => `${p.name}:${p.consent.transcribe}`)));
    const fA0 = await frames(ann), fB0 = await frames(bob), fC0 = await frames(cat);
    check('hub: talkers send voice frames on the game socket, the silent mic sends none', fA0.frames > 10 && fB0.frames > 10 && fC0.frames === 0,
      `Ann ${JSON.stringify(fA0)} Bob ${JSON.stringify(fB0)} Cat ${JSON.stringify(fC0)}`);
    check('hub: server onVoiceChunk receives them (dbg.voice.state)', (vp(idA)?.chunks?.chunks ?? 0) > 10 && (vp(idB)?.chunks?.chunks ?? 0) > 10 && (vp(idA)?.chunks?.badSeq ?? 1) === 0,
      `Ann ${JSON.stringify(vp(idA)?.chunks)} Bob ${JSON.stringify(vp(idB)?.chunks)}`);
    const hubStt = await dbg<SttState>(ann, 'ai.sttState');
    const status1 = await dbg<AiStatus>(ann, 'ai.status');
    check('hub: the bridge transcribes nothing (sttPhases = contract)', !hubStt.run && status1.stt.segments === status0.stt.segments, `segments ${status0.stt.segments} -> ${status1.stt.segments}`);

    // ---------------- lobby: pick + ready -> drive -> contract (the real flow)
    const ms = await dbg<{ orders: { id: string; available: boolean }[] }>(ann, 'meta.state');
    const order = ms.orders.find((o) => o.available);
    const pk = await req<{ ok: boolean; reason?: string }>(ann, 'meta.pick', { orderId: order?.id });
    check('leader picks a work order', pk.ok === true, JSON.stringify(pk));
    for (const p of players) await req(p, 'meta.ready', { ready: true });
    let phase = '';
    const tDrive = Date.now();
    for (let i = 0; i < 180 && phase !== 'contract'; i++) {
      phase = (await ev(ann.page, () => (window as unknown as W).__game.state()?.phase ?? '', null)) as string;
      if (phase === 'drive' && Date.now() - tDrive > 45_000) await dbg(ann, 'meta.skipDrive').catch(() => {});
      if (phase !== 'contract') await sleep(500);
    }
    check('all ready -> drive -> contract', phase === 'contract', `phase ${phase} after ${Math.round((Date.now() - tDrive) / 1000)} s`);
    if (phase !== 'contract') throw new Error('no contract');
    // nobody dies mid-test: freeze the monsters (memory intake keeps working while frozen and dormant)
    await dbg(ann, 'monsters.freeze', { on: true });
    const m0 = await dbg<MState>(ann, 'monsters.state');
    const lis0 = m0.agents?.find((a) => a.kind === 'listener');
    const bobPos = m0.poses?.find((p) => p.id === idB)?.p;
    check('contract: a Listener exists (dormant at its spawn)', !!lis0 && !!bobPos, lis0 ? `listener at ${lis0.x.toFixed(1)},${lis0.z.toFixed(1)} dormant=${lis0.dormant}; Bob at ${bobPos?.[0]},${bobPos?.[2]}` : JSON.stringify(m0.mode));
    if (!lis0 || !bobPos) throw new Error('no listener');
    const fA1 = await frames(ann), fB1 = await frames(bob);
    const hits1 = await sidecarHits();

    // ---------------- the Listener stands next to Bob: his transcribed lines must reach its memory
    await dbg(ann, 'monsters.place', { id: 'listener', x: bobPos[0], z: bobPos[2] });
    const tNear = Date.now();
    let bobHeard: Utt | null = null, annUtt: Utt | null = null;
    let all: Utt[] = [];
    while (Date.now() - tNear < 45_000 && !(bobHeard && annUtt)) {
      await sleep(1000);
      all = (await dbg<{ utterances: Utt[] }>(ann, 'ai.utterances')).utterances;
      bobHeard = all.find((u) => u.speaker === idB && /boil/i.test(u.text) && u.hearers.listener) ?? null;
      annUtt = all.find((u) => u.speaker === idA && u.text.trim().length > 0) ?? null;
    }
    console.log(`transcripts so far: ${all.map((u) => `${u.speakerName}: "${u.text}" (band ${u.band}, ${u.sttMs} ms, listener ${u.hearers.listener})`).join(' | ')}`);
    const fA2 = await frames(ann), fB2 = await frames(bob), fC2 = await frames(cat);
    check('contract: clients keep streaming voice frames (Ann, Bob), the silent mic none', fA2.frames > fA1.frames && fB2.frames > fB1.frames && fC2.frames === 0,
      `Ann +${fA2.frames - fA1.frames}, Bob +${fB2.frames - fB1.frames}, Cat ${fC2.frames}`);
    const run = (await dbg<SttState>(ann, 'ai.sttState')).run;
    const rp = (id: string) => run?.players[id];
    check('bridge: chunks -> segments for both talkers, none for the silent player (run counters)',
      !!run && (rp(idA)?.segments ?? 0) > 0 && (rp(idB)?.segments ?? 0) > 0 && (rp(idC)?.chunks ?? 0) === 0 && (rp(idA)?.consentChunks ?? 1) === 0,
      JSON.stringify(run?.players));
    const hits2 = await sidecarHits();
    const status2 = await dbg<AiStatus>(ann, 'ai.status');
    check('bridge POSTs reach the sidecar (/health encoderReuseHits grows, bridge has a latency)', hits2 > hits1 && status2.stt.lastMs !== null && status2.stt.utterances > status1.stt.utterances,
      `sidecar hits +${hits2 - hits1} (hub +${hits1 - hits0}), bridge ${JSON.stringify(status2.stt)}`);
    check('transcript from Ann (talk_en.wav)', !!annUtt, annUtt ? `"${annUtt.text}" ${annUtt.sttMs} ms` : 'none');
    check('transcript from Bob mentions boiler and was heard by the Listener next to him', !!bobHeard, bobHeard ? `"${bobHeard.text}" listener ${bobHeard.hearers.listenerDistM} m` : 'none');
    const m1 = await dbg<MState>(ann, 'monsters.state');
    const mem1 = m1.agents?.find((a) => a.kind === 'listener')?.memory ?? [];
    check("Bob's line reached the dormant Listener's memory", mem1.some((l) => /boil/i.test(l.text)), `${mem1.length} lines: ${mem1.map((l) => l.text).join(' | ').slice(0, 200)}`);

    // ---------------- back at its far spawn: later lines are transcribed but not heard
    // mute both talkers first (open segments end at once), let in-flight transcripts land, then move + unmute: every
    // line after that started with the Listener far away
    const mute = (p: Player, on: boolean) => ev(p.page, (v: boolean) => (window as unknown as { __voiceDebug: { service(): { setMuted(on: boolean): void } } }).__voiceDebug.service().setMuted(v), on);
    await mute(ann, true);
    await mute(bob, true);
    await sleep(2500);
    const memMid = (await dbg<MState>(ann, 'monsters.state')).agents?.find((a) => a.kind === 'listener')?.memory ?? [];
    const seen = new Set((await dbg<{ utterances: Utt[] }>(ann, 'ai.utterances')).utterances.map((u) => `${u.speaker}:${u.segId}`));
    await dbg(ann, 'monsters.place', { id: 'listener', x: lis0.x, z: lis0.z });
    await mute(ann, false);
    await mute(bob, false);
    let later: Utt[] = [];
    const tFar = Date.now();
    while (Date.now() - tFar < 30_000 && later.length < 2) {
      await sleep(1000);
      const list = (await dbg<{ utterances: Utt[] }>(ann, 'ai.utterances')).utterances;
      later = list.filter((u) => !seen.has(`${u.speaker}:${u.segId}`));
    }
    const memEnd = (await dbg<MState>(ann, 'monsters.state')).agents?.find((a) => a.kind === 'listener')?.memory ?? [];
    check('Listener at its far spawn: later lines transcribed but not heard, memory unchanged', later.length > 0 && later.every((u) => !u.hearers.listener) && memEnd.length === memMid.length,
      `${later.length} later lines (${later.map((u) => `${u.speakerName}:${u.hearers.listener}`).join(', ')}), memory ${memMid.length} -> ${memEnd.length}`);

    await Promise.race([screenshot(bob.page, 'tests/artifacts/ai/live-pipeline-contract.png').then((s) => console.log('screenshot', s)), sleep(15_000)]).catch((e) => console.log('screenshot skipped', String(e).slice(0, 80)));
    // end the contract: the bridge logs its per-contract summary (counts only) at info level
    await dbg(ann, 'monsters.freeze', { on: false }).catch(() => {});
    await dbg(ann, 'meta.endContract', { hauled: 0 }).catch(() => {});
    await sleep(1500);
    if (SPAWN) {
      const sum = srvOut.find((l) => l.includes(`crew ${CREW}: STT contract summary`));
      check('server log: per-contract STT summary line', !!sum, sum ?? srvOut.slice(-3).join(' / '));
      for (const l of srvOut.filter((x) => x.includes(CREW) || /^\s+\d|^\S+ \[stt\]\s{3}/.test(x))) console.log(`  log: ${l.trim()}`);
    }
    const errs = players.flatMap((p) => p.errors).filter((e) => /voice|audio|RTC|worklet|stt|mic/i.test(e));
    check('no voice/audio console errors', errs.length === 0, errs.slice(0, 4).join(' | '));
  } finally {
    await Promise.all(players.map((p) => p.close().catch(() => {})));
    server?.kill();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => {
  console.error(`live-pipeline.e2e FAILED: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
});
