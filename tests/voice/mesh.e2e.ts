// Track ④ Voice e2e: 3 separate Chrome processes (talk_en.wav, tone440.wav, tone880.wav) in one crew.
//   node tests/voice/mesh.e2e.ts            (BASE_URL default http://127.0.0.1:3004, server started with --dev)
// Asserts: mesh connects, bytesReceived grows, audible peers RMS > 0.01, HRTF L/R panning >= 6 dB for a speaker
// on the listener's left, distance gating (< 0.001 beyond the band radius), mic settings (EC on, AGC off),
// keep-alive control (no <audio> element -> silent = Chrome bug 40094084 still present), relay-only variant
// (only when CF_TURN_KEY_ID is configured, else SKIP).
import { launchPlayer, screenshot } from '../lib/launch.ts';
import type { Player } from '../lib/launch.ts';
import type { Page } from 'playwright-core';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3004';
const ALPHA = 'BCDFGHJKLMNPQRSTVWXZ';
const code = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => ALPHA[b % ALPHA.length]).join('');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { name: string; ok: boolean; info: string }[] = [];
const check = (name: string, ok: boolean, info: string) => {
  results.push({ name, ok, info });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${info}`);
};
const dB = (x: number) => 20 * Math.log10(Math.max(1e-9, x));

interface PeerDbg { state: string; candidate: string; bytesReceived: number; rmsL: number; rmsR: number; gain: number; band: number }

async function me(page: Page): Promise<string> {
  await page.waitForFunction(() => !!window.__game?.me() && !!window.__voiceDebug, undefined, { timeout: 30_000 });
  return (await page.evaluate(() => window.__game!.me()))!;
}
/** evaluate with retries: Vite HMR (other tracks editing the shared tree) can reload a page mid-test */
async function ev<T, A>(page: Page, fn: (a: A) => T | Promise<T>, arg: A, tries = 20): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      await page.waitForFunction(() => !!window.__voiceDebug && !!window.__game?.me(), undefined, { timeout: 30_000 });
      return await page.evaluate(fn as never, arg) as T;
    } catch (e) {
      if (i >= tries) throw e;
      await sleep(500);
    }
  }
}
const peers = (page: Page) => ev(page, () => window.__voiceDebug?.peers() ?? {}, null) as Promise<Record<string, PeerDbg>>;

async function waitConnected(page: Page, ids: string[], timeoutMs = 25_000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const p = await peers(page);
    if (ids.every((id) => p[id]?.state === 'connected')) return true;
    await sleep(300);
  }
  return false;
}

/** mean-square RMS of a peer's output over a window (both channels) */
async function measure(page: Page, id: string, ms: number): Promise<{ l: number; r: number; max: number; gain: number; band: number }> {
  await waitConnected(page, [id]);
  return ev(page, async ({ id, ms }: { id: string; ms: number }) => {
    let sl = 0, sr = 0, n = 0, mx = 0, gain = 0, band = -1;
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      const p = window.__voiceDebug?.peers()[id];
      if (p) { sl += p.rmsL * p.rmsL; sr += p.rmsR * p.rmsR; n++; mx = Math.max(mx, p.rmsL, p.rmsR); gain = p.gain; band = p.band; }
      await new Promise((r) => setTimeout(r, 50));
    }
    return { l: Math.sqrt(sl / Math.max(1, n)), r: Math.sqrt(sr / Math.max(1, n)), max: mx, gain, band };
  }, { id, ms });
}

const pin = (page: Page, x: number, z: number, yaw = 0) => ev(page, ({ x, z, yaw }: { x: number; z: number; yaw: number }) => window.__game!.dbg('voice.pin', { x, z, yaw }), { x, z, yaw });

async function main(): Promise<void> {
  const crew = code();
  const query = { autojoin: '1', voiceListener: 'server', walkies: '1', voiceAud: 'euclid' };
  console.log(`crew ${crew} @ ${BASE}`);
  const players: Player[] = [];
  try {
    const [p1, p2, p3] = await Promise.all([
      launchPlayer({ name: 'Talker', wav: 'talk_en.wav', baseUrl: BASE, crew, query }),
      launchPlayer({ name: 'Tone440', wav: 'tone440.wav', baseUrl: BASE, crew, query }),
      launchPlayer({ name: 'Tone880', wav: 'tone880.wav', baseUrl: BASE, crew, query }),
    ]);
    players.push(p1, p2, p3);
    const ids = await Promise.all([me(p1.page), me(p2.page), me(p3.page)]);
    const [id1, id2, id3] = ids;
    console.log('ids', ids.join(' '));
    // mic settings (EC on, AGC off)
    await p2.page.waitForFunction(() => !!window.__voiceDebug?.micSettings(), undefined, { timeout: 15_000 });
    const ms = (await p2.page.evaluate(() => window.__voiceDebug!.micSettings())) as Record<string, unknown>;
    check('mic settings EC on / AGC off', ms.echoCancellation === true && ms.autoGainControl === false, JSON.stringify({ ec: ms.echoCancellation, agc: ms.autoGainControl, ns: ms.noiseSuppression, ch: ms.channelCount }));
    // mesh connects
    const conn = await Promise.all([
      waitConnected(p1.page, [id2, id3]), waitConnected(p2.page, [id1, id3]), waitConnected(p3.page, [id1, id2]),
    ]);
    const states = await Promise.all([p1, p2, p3].map(async (p) => Object.fromEntries(Object.entries(await peers(p.page)).map(([k, v]) => [k, `${v.state}/${v.candidate}`]))));
    check('mesh: 3 peers fully connected', conn.every(Boolean), JSON.stringify(states));
    if (!conn.every(Boolean)) {
      for (const [i, p] of [p1, p2, p3].entries()) {
        console.log(`P${i + 1} logs`, JSON.stringify(await p.page.evaluate(() => (window.__voiceDebug as unknown as { logs(): string[] }).logs())));
      }
    }
    // place everyone: listener P2 at origin-ish facing +Z, P1 2 m to its LEFT (+X), P3 60 m away
    const base = { x: 10.5, z: 10.5 };
    await pin(p2.page, base.x, base.z, 0);
    await pin(p1.page, base.x + 2, base.z, 0);
    await pin(p3.page, base.x, base.z + 60, 0);
    await sleep(2500);
    let grew = false, info = '';
    for (let tries = 0; tries < 4 && !grew; tries++) {
      await waitConnected(p2.page, [id1, id3]);
      const b0 = await peers(p2.page);
      await sleep(2000);
      const b1 = await peers(p2.page);
      const by = (b: Record<string, PeerDbg>, id: string) => b[id]?.bytesReceived ?? 0;
      grew = by(b1, id1) > by(b0, id1) + 2000 && by(b1, id3) > by(b0, id3) + 2000;
      info = `P1 ${by(b0, id1)}->${by(b1, id1)}, P3 ${by(b0, id3)}->${by(b1, id3)}; cand ${b1[id1]?.candidate}/${b1[id3]?.candidate}`;
    }
    check('bytesReceived grows (P2 <- P1, P3)', grew, info);
    const left = await measure(p2.page, id1, 4000);
    check('audible peer RMS > 0.01 (P1 talking at 2 m)', left.max > 0.01, `max ${left.max.toFixed(4)} gain ${left.gain.toFixed(2)} band ${left.band}`);
    check('HRTF panning: speaker on the left => rmsL - rmsR >= 6 dB', dB(left.l) - dB(left.r) >= 6, `L ${dB(left.l).toFixed(1)} dB, R ${dB(left.r).toFixed(1)} dB, diff ${(dB(left.l) - dB(left.r)).toFixed(1)} dB`);
    const far = await measure(p2.page, id3, 2500);
    check('distance gating: P3 at 60 m (beyond band radius) < 0.001', far.max < 0.001, `max ${far.max.toExponential(2)} band ${far.band}`);
    // bring P3 in front (3 m) -> audible; also check P1 on the right after turning the listener around
    await pin(p3.page, base.x, base.z + 3, 0);
    await pin(p2.page, base.x, base.z, Math.PI);
    await sleep(1500);
    const near = await measure(p2.page, id3, 2500);
    check('P3 moved to 3 m => audible (RMS > 0.01)', near.max > 0.01, `max ${near.max.toFixed(4)} band ${near.band}`);
    const right = await measure(p2.page, id1, 3000);
    check('listener turned 180 deg => P1 now on the right (rmsR > rmsL)', dB(right.r) - dB(right.l) >= 3, `L ${dB(right.l).toFixed(1)} R ${dB(right.r).toFixed(1)}`);
    // walkie: P3 back at 60 m (gated), then holds Q -> heard over the 2D radio chain; release -> gated again
    // (retried: an HMR reload of a page mid-phase loses the held key)
    let pre = { max: 1, l: 0, r: 0 }, tx = { max: 0, l: 0, r: 0 }, post = { max: 1, l: 0, r: 0 };
    for (let attempt = 0; attempt < 3; attempt++) {
      await pin(p3.page, base.x, base.z + 60, 0);
      await sleep(2500);
      await waitConnected(p2.page, [id3]);
      pre = await measure(p2.page, id3, 1200);
      await p3.page.bringToFront();
      await p3.page.keyboard.down('q');
      await sleep(900);
      tx = await measure(p2.page, id3, 2000);
      await p3.page.keyboard.up('q');
      await sleep(2500);
      post = await measure(p2.page, id3, 1500);
      if (pre.max < 0.001 && tx.max > 0.01 && post.max < 0.001) break;
      console.log('walkie attempt', attempt + 1, 'inconclusive, retrying');
    }
    check('walkie (Q held, ?walkies=1): far speaker audible over radio, gated again after release',
      pre.max < 0.001 && tx.max > 0.01 && post.max < 0.001, `before ${pre.max.toExponential(1)}, TX ${tx.max.toFixed(4)}, after ${post.max.toExponential(1)}`);
    check('radio is 2D (balanced L/R)', Math.abs(dB(tx.l) - dB(tx.r)) < 3, `L ${dB(tx.l).toFixed(1)} R ${dB(tx.r).toFixed(1)}`);
    // bands seen by peers over the data channel
    await sleep(1500);
    const bands = await ev(p2.page, () => Object.fromEntries(Object.entries(window.__voiceDebug!.peers()).map(([k, v]) => [k, v.band])), null);
    check('data channel delivers bands', Object.values(bands).every((b) => b >= 0), JSON.stringify(bands));
    // HUD screenshot (band meter bottom-left)
    // screenshots of a WebGPU page can stall under load (4 Chrome processes on one GPU): never fail the run on it
    await Promise.race([screenshot(p1.page, 'tests/artifacts/voice/talker-hud.png').then((s) => console.log('screenshot', s)), sleep(15_000)]).catch((e) => console.log('screenshot skipped', String(e).slice(0, 80)));
    // keep-alive control: a 4th process without the <audio> element should hear NOTHING via Web Audio
    const p4 = await launchPlayer({ name: 'NoKeep', wav: 'silence.wav', baseUrl: BASE, crew, query: { ...query, voiceNoKeepAlive: '1' } });
    players.push(p4);
    const id4 = await me(p4.page);
    await pin(p4.page, base.x - 1, base.z + 1, 0);
    const c4 = await waitConnected(p4.page, [id1, id2, id3]);
    // the control is only meaningful once RTP actually arrives
    for (let i = 0; i < 40; i++) {
      const pk = await peers(p4.page);
      if ((pk[id1]?.bytesReceived ?? 0) > 5000 && (pk[id3]?.bytesReceived ?? 0) > 5000) break;
      await sleep(500);
    }
    await sleep(1000);
    const k1 = await measure(p4.page, id1, 2500);
    const k3 = await measure(p4.page, id3, 1500);
    const kb = await peers(p4.page);
    const silent = k1.max < 1e-4 && k3.max < 1e-4;
    console.log(`keep-alive control: connected=${c4} bytes P1=${kb[id1]?.bytesReceived} rms P1=${k1.max.toExponential(2)} P3=${k3.max.toExponential(2)}`);
    if (silent) check('keep-alive control: without the element Web Audio is silent (bug 40094084 still present)', true, 'element is still required');
    else console.log('INFO  keep-alive control: audio flows WITHOUT the element: Chrome may have fixed bug 40094084 (keep the element anyway)');
    // relay-only variant
    if (process.env.CF_TURN_KEY_ID) {
      const rq = { ...query, relay: '1' };
      const r1 = await launchPlayer({ name: 'RelayA', wav: 'talk_en.wav', baseUrl: BASE, crew: crew + '', query: rq });
      players.push(r1);
      await me(r1.page);
      await sleep(8000);
      const rp = await peers(r1.page);
      const relayed = Object.values(rp).filter((p) => p.state === 'connected' && p.candidate === 'relay');
      check('relay-only: connects through TURN', relayed.length > 0, JSON.stringify(rp));
    } else console.log('SKIP  relay-only variant (CF_TURN_KEY_ID not configured)');
    const errs = players.flatMap((p) => p.errors).filter((e) => /voice|audio|RTC/i.test(e));
    check('no voice/audio console errors', errs.length === 0, errs.slice(0, 5).join(' | '));
  } finally {
    await Promise.all(players.map((p) => p.close().catch(() => {})));
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exitCode = failed.length ? 1 : 0;
}

await main();
