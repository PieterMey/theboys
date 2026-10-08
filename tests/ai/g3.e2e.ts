// Track (e) G3-style end-to-end: REAL sidecar + REAL dev server + the REAL (c) Listener.
//   node tests/ai/g3.e2e.ts      (spawns the dev server on PORT 3015, AI_MODE=mock; needs npm run stt)
// A contract on facility_s1_p2 with monsters; the Listener is woken, frozen and placed ~8 m (path) from the speaker.
// callsign_boiler.wav at talk level -> STT -> onUtterance (hearers.listener = true) -> (c) memory -> after unfreezing,
// (c) asks the AI brain (listenerIntent, mock JEV) -> a decision targeting BOILER is logged and acted on.
// Then the Listener is placed ~15 m away and talk_en.wav ("...chapel...") is spoken: hearers.listener = false and
// the line never reaches its memory.
import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { BAND } from '../../packages/shared/src/constants.ts';
import type { Utterance } from '../../packages/shared/src/messages/ai.ts';
import { initialDoorOpen } from '../../packages/shared/src/nav/index.ts';
import { Hearing } from '../../apps/server/src/stt/hearing.ts';
import { REPO, loadLayout } from './helpers.ts';
import { Bot, startDevServer, waitHttp, wav16k } from './bot.ts';

const PORT = Number(process.env.PORT ?? 3015);
const BASE = `http://127.0.0.1:${PORT}`;
const STT = process.env.STT_URL ?? 'http://127.0.0.1:3100';
let server: ChildProcess | null = null;

interface MState { mode: string; agents: { kind: string; x: number; z: number; dormant?: boolean; intent?: string; memory?: { text: string; callsigns: string[] }[] }[]; log: { line: string; action: string; target: string | null; source: string; valid: boolean }[] }

function fail(msg: string): never {
  console.error(`g3.e2e FAILED: ${msg}`);
  server?.kill(); // process.exit skips the finally below: never leave the spawned dev server running
  process.exit(1);
}

async function main(): Promise<void> {
  if (!(await waitHttp(`${STT}/health`, 60_000, async (r) => r.ok && ((await r.json()) as { warm?: boolean }).warm === true))) fail('STT sidecar not warm (npm run stt)');
  server = startDevServer(PORT, STT);
  try {
    if (!(await waitHttp(`${BASE}/healthz`, 30_000))) fail('server not up');
    const crew = `G${randomBytes(3).toString('hex').toUpperCase().replace(/[^A-Z]/g, 'X')}`.slice(0, 4);
    const bot = new Bot(`ws://127.0.0.1:${PORT}/ws`, crew, 'Sam');
    await bot.ready();
    await bot.req('voice.consent', { transcribe: true });
    const started = await bot.req<{ seed: string; hash: string }>('dbg.objectives.start', { fixture: 'facility_s1_p2', realSec: 900 });
    // the fixture the server now runs: the speaker stands in the middle of SHOWERS, looked up by callsign (no fixed
    // coordinates: tests/fixtures/layouts gets regenerated); the Hound gets parked on its spawn slot farthest from there
    const L = loadLayout('facility_s1_p2');
    if (started.hash !== L.hash) fail(`the server runs layout ${started.hash}, the fixture file is ${L.hash}`);
    const showers = L.spaces.find((sp) => sp.callsign === 'SHOWERS');
    if (!showers) fail('facility_s1_p2 has no SHOWERS room');
    const SPK: [number, number] = [showers.rect.x + showers.rect.w / 2, showers.rect.y + showers.rect.h / 2];
    const houndSlots = L.items.filter((i) => i.kind === 'spawn_hound');
    if (!houndSlots.length) fail('facility_s1_p2 has no spawn_hound slot');
    const away = (i: { x: number; z: number }) => Math.hypot(i.x - SPK[0], i.z - SPK[1]);
    const park = houndSlots.reduce((p, i) => (away(i) > away(p) ? i : p));
    console.log(`layout ${started.seed} (${started.hash}): speaker in SHOWERS at ${SPK.join(',')}, Hound parked at ${park.x},${park.z}`);
    await new Promise((r) => setTimeout(r, 500));
    let ms = await bot.req<MState>('dbg.monsters.state');
    if (!ms.agents?.some((a) => a.kind === 'listener')) {
      await bot.req('dbg.monsters.start', { risk: 1 });
      ms = await bot.req<MState>('dbg.monsters.state');
    }
    if (!ms.agents?.some((a) => a.kind === 'listener')) fail(`no Listener agent (mode ${ms.mode})`);
    console.log(`monsters: mode ${ms.mode}, agents ${ms.agents.map((x) => x.kind).join(',')}`);
    const lis = () => bot.req<MState>('dbg.monsters.state').then(async (s) => {
      if (!s.agents) {
        const st = await bot.req<{ phase: string; players: { alive: boolean }[] }>('dbg.state');
        throw new Error(`monsters stopped (mode ${s.mode}); phase ${st.phase}, alive ${st.players.map((p) => p.alive)}; last log: ${JSON.stringify(s.log?.slice(-3))}`);
      }
      return s;
    });
    // park the Hound out of play (it would hear the talking at ~11 m and end the test with a kill)
    await bot.req('dbg.monsters.place', { id: 'hound', x: park.x, z: park.z, active: false });
    await bot.req('dbg.monsters.wake');
    await bot.req('dbg.ai.fakeListener', { off: true });
    await bot.req('dbg.ai.place', { x: SPK[0], z: SPK[1] });

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
    const utterances = async () => (await bot.req<{ utterances: Utterance[] }>('dbg.ai.utterances')).utterances;
    const say = async (wav: string, segId: number, at: [number, number]): Promise<Utterance> => {
      await bot.req('dbg.monsters.freeze', { on: true });
      await bot.req('dbg.monsters.place', { id: 'listener', x: at[0], z: at[1], active: true });
      await bot.req('dbg.ai.place', { x: SPK[0], z: SPK[1] });
      const n = (await utterances()).length;
      await bot.speak(wav16k(join(REPO, 'tests/fixtures/voice', wav)), segId, BAND.talk);
      for (let i = 0; i < 100; i++) {
        const list = await utterances();
        if (list.length > n) return list[list.length - 1];
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`no utterance for ${wav}`);
    };

    // ---- 8 m: heard, remembered, decided ----
    const logBefore = (await lis()).log.length;
    const a = await say('callsign_boiler.wav', 1, near);
    const memA = (await lis()).agents.find((x) => x.kind === 'listener')?.memory ?? [];
    await bot.req('dbg.monsters.freeze', { on: false });
    let decision: MState['log'][number] | null = null;
    const t0 = performance.now();
    for (let i = 0; i < 80 && !decision; i++) {
      const st = await lis();
      decision = st.log.slice(logBefore).find((e) => e.source !== 'rule' && /BOILER/i.test(`${e.target} ${e.line}`)) ?? null;
      if (!decision) await new Promise((r) => setTimeout(r, 100));
    }
    const decideMs = Math.round(performance.now() - t0);
    const after = (await lis()).agents.find((x) => x.kind === 'listener');

    // ---- 15 m: not heard, not remembered ----
    const b = await say('talk_en.wav', 2, far);
    const memB = (await lis()).agents.find((x) => x.kind === 'listener')?.memory ?? [];
    await bot.req('dbg.monsters.freeze', { on: false });
    const status = await bot.req<{ listener: unknown; routes: Record<string, { calls: number }> }>('dbg.ai.status');

    const checks: [string, boolean][] = [
      [`8 m utterance "${a.text}" callsigns ${JSON.stringify(a.callsigns)} hearers.listener=${a.hearers.listener} (${a.hearers.listenerDistM} m)`, a.hearers.listener && a.callsigns.includes('BOILER')],
      [`reached the Listener's memory (${memA.length} lines: ${memA.map((m) => m.text).join(' | ')})`, memA.some((m) => /boiler/i.test(m.text))],
      [`AI brain decision logged + acted on in ${decideMs} ms after unfreeze: ${decision ? `${decision.source}: ${decision.line}` : 'none'}`, !!decision && decision.valid],
      [`Listener intent now: ${after?.intent}`, !!after?.intent && after.intent !== 'patrol'],
      [`15 m utterance "${b.text.slice(0, 60)}..." hearers.listener=${b.hearers.listener}`, b.hearers.listener === false],
      [`15 m line NOT in memory (${memB.length} lines)`, !memB.some((m) => /chapel/i.test(m.text))],
    ];
    let bad = 0;
    for (const [what, pass] of checks) {
      console.log(`${pass ? 'ok  ' : 'FAIL'} ${what}`);
      if (!pass) bad++;
    }
    console.log(`ai status: listener ${JSON.stringify(status.listener)} routes ${JSON.stringify(Object.fromEntries(Object.entries(status.routes).map(([k, v]) => [k, v.calls])))}`);
    bot.ws.close();
    if (bad) fail(`${bad} check(s) failed`);
    console.log('g3.e2e OK');
  } finally {
    server?.kill();
  }
}

main().then(() => setTimeout(() => process.exit(0), 300), (e) => fail(e instanceof Error ? e.message : String(e)));
