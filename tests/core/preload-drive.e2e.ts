// v1.3 P2a + P2b on a real dev server (its own process on port 3890, scratch saves; no browser, no GPU):
//  - a client that sends 'net.preload' the moment the drive event arrives (what apps/client/src/loading now does) is
//    held for while its page is frozen: here a 4 s busy-wait right after the ask. The server answered it and listed
//    it in 'net.loading' DURING the freeze (event server times), so the van cannot leave without it;
//  - the van leaves when that client reports 'net.loaded' after the drive timer (not at the timer, not at the 30 s
//    cap), and a hello-build 'bot' crewmate that never preloads is never waited for.
// Run: node tests/core/preload-drive.e2e.ts   [PORT=3890]   exit 0 = pass
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { FullState } from '../../packages/shared/src/state.ts';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import { TestClient, sleep, startServer } from './lib.ts';
import type { Ev } from './lib.ts';

const PORT = Number(process.env.PORT ?? 3890);
const SCRATCH = process.env.SCRATCH ?? join(tmpdir(), 'dead-air-core-preload');
mkdirSync(join(SCRATCH, 'saves'), { recursive: true });
const FREEZE_MS = 4000;
const busyWait = (ms: number) => { const end = performance.now() + ms; while (performance.now() < end) { /* frozen page */ } };

const srv = await startServer(PORT, SCRATCH);
const ann = new TestClient('Ann', { build: 'dev' }); // a browser (human)
const bot = new TestClient('Botty', { build: 'bot' }); // a scripted bot: never waited for
let code = 1;
try {
  const crew = `PRE${Math.floor(Math.random() * 900 + 100)}`;
  await ann.connect(PORT, crew);
  await bot.connect(PORT, crew);

  // the page's drive handler: ask at once, then the main thread freezes (shader compiles in the real client)
  let askAt = 0;
  let freezeEnd = 0;
  let reply: Promise<{ layout: LevelLayout | null; hash: string | null }> | null = null;
  ann.onEv = (ev: Ev) => {
    if (ev.e !== 'phase' || (ev.d as { phase: string }).phase !== 'drive' || reply) return;
    askAt = Date.now();
    reply = ann.req('net.preload', {}, 45_000);
    busyWait(FREEZE_MS);
    freezeEnd = Date.now();
  };

  let started = false;
  for (let i = 0; i < 40 && !started; i++) {
    const r = await ann.req<{ ok: boolean; reason?: string }>('meta.drive', {}).catch(() => ({ ok: false }));
    started = r.ok;
    if (!started) await sleep(250);
  }
  assert.ok(started, 'the drive started');
  const driveEv = await ann.waitEvent((ev) => ev.e === 'phase' && (ev.d as { phase: string }).phase === 'drive', 10_000);
  const endsAt = ((driveEv.d as { state: FullState }).state.meta as { drive?: { endsAt?: number } | null }).drive?.endsAt ?? 0;
  assert.ok(endsAt > 0, 'drive timer known');
  assert.ok(reply, 'the preload was asked inside the drive event handler');
  const rep = await reply!;
  assert.equal(rep.layout?.kind, 'facility', 'the reply carries the facility');
  const hash = rep.layout!.hash;
  console.log(`asked ${askAt - driveEv.t | 0} ms after the drive event was sent; page frozen ${freezeEnd - askAt} ms`);

  // the crew saw Ann on the van's waiting list while her page was frozen (server-side event times; the bot's socket
  // shares this frozen process, so let its queued frames drain first)
  await sleep(300);
  const during = bot.events.filter((e) => e.e === 'net.loading' && (e.d as { waiting?: string[] }).waiting?.includes('Ann') && e.t >= askAt - 50 && e.t <= freezeEnd);
  assert.ok(during.length > 0, `'net.loading' listed Ann during the freeze (${bot.events.filter((e) => e.e === 'net.loading').map((e) => e.t - askAt).join(', ')} ms after the ask)`);

  // Ann "builds and warms" until 3 s past the drive timer, then reports loaded
  const loadAt = endsAt + 3000;
  while (Date.now() < loadAt) {
    assert.ok(!ann.events.some((e) => e.e === 'phase' && (e.d as { phase: string }).phase === 'contract'), 'the van left before Ann reported loaded');
    await sleep(100);
  }
  const loadedSent = Date.now();
  await ann.req('net.loaded', { hash, ok: true, ms: loadedSent - askAt });
  const contract = await ann.waitEvent((ev) => ev.e === 'phase' && (ev.d as { phase: string }).phase === 'contract', 8000);
  const after = contract.t - loadedSent;
  console.log(`van left ${(contract.t - endsAt) / 1000} s after the drive timer, ${after} ms after Ann's net.loaded (the bot never preloaded)`);
  assert.ok(contract.t >= endsAt + 2900, 'held past the drive timer for the preloading human');
  assert.ok(after < 2000, 'left right after the human was loaded (the bot was not waited for)');
  console.log('preload-drive e2e: PASS');
  code = 0;
} catch (e) {
  console.error('preload-drive e2e: FAIL', e instanceof Error ? e.message : e);
  console.error(srv.log.filter((l) => /loading|meta|crews|ERROR|WARN/.test(l)).slice(-25).join('\n'));
} finally {
  await ann.close();
  await bot.close();
  await srv.stop();
  process.exitCode = code;
  setTimeout(() => process.exit(code), 500).unref();
}
