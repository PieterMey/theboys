// Track ④ Voice e2e: signalling-storm regression (FINDINGS BLOCKER 'new remote session -> rebuilding' loop).
//   BASE_URL=http://127.0.0.1:3401 node tests/voice/storm.e2e.ts
// Two connected players; the impolite one (larger id) toggles relay-only on, waits until its new PC is in
// have-local-offer, blocks its main thread 400 ms (a long frame) and toggles relay-only off again. The pair must
// reconnect within 15 s with only a handful of rebuilds (the old code looped ~4 rebuilds/s forever).
import { launchPlayer } from '../lib/launch.ts';
import type { Player } from '../lib/launch.ts';
import type { Page } from 'playwright-core';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3004';
const ALPHA = 'BCDFGHJKLMNPQRSTVWXZ';
const code = () => Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => ALPHA[b % ALPHA.length]).join('');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name: string, ok: boolean, info: string) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${info}`); };

async function me(page: Page): Promise<string> {
  await page.waitForFunction(() => !!window.__game?.me() && !!window.__voiceDebug, undefined, { timeout: 30_000 });
  return (await page.evaluate(() => window.__game!.me()))!;
}
const state = (page: Page, id: string) => page.evaluate((pid) => window.__voiceDebug?.peers()[pid]?.state ?? '-', id);
type Dbg = { logs(): string[]; service(): unknown; mesh(): Record<string, { sig: string }> };
const rebuilds = (page: Page) => page.evaluate(() => ((window.__voiceDebug as unknown as Dbg | undefined)?.logs() ?? []).filter((l: string) => /rebuilding/.test(l)).length);
async function waitBoth(a: Page, aId: string, b: Page, bId: string, ms: number): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if ((await state(a, bId)) === 'connected' && (await state(b, aId)) === 'connected') return Date.now() - t0;
    await sleep(250);
  }
  return -1;
}

async function main(): Promise<void> {
  const crew = code();
  const query = { autojoin: '1', voiceListener: 'server' };
  console.log(`crew ${crew} @ ${BASE}`);
  const players: Player[] = [];
  try {
    const [p1, p2] = await Promise.all([
      launchPlayer({ name: 'Talker', wav: 'talk_en.wav', baseUrl: BASE, crew, query }),
      launchPlayer({ name: 'Quiet', wav: 'tone440.wav', baseUrl: BASE, crew, query }),
    ]);
    players.push(p1, p2);
    // keep other agents' Vite HMR reloads away from these pages
    for (const p of players) await p.page.routeWebSocket(/token=/, () => {});
    const [id1, id2] = await Promise.all([me(p1.page), me(p2.page)]);
    const first = await waitBoth(p1.page, id1, p2.page, id2, 30_000);
    check('initial connect', first >= 0, `${first} ms`);
    // impolite = larger id
    const [imp, pol, impId, polId] = id1 > id2 ? [p1.page, p2.page, id1, id2] : [p2.page, p1.page, id2, id1];
    const r0 = [await rebuilds(imp), await rebuilds(pol)];
    const storm = await imp.evaluate((tid) => new Promise<{ ok: boolean; ms: number }>((res) => {
      const s = (window.__voiceDebug as unknown as Dbg).service() as { setRelayOnly(on: boolean): void };
      s.setRelayOnly(true);
      const t0 = performance.now();
      const poll = () => {
        const m = (window.__voiceDebug as unknown as Dbg).mesh()[tid];
        if (m && m.sig === 'have-local-offer') {
          const t = performance.now(); while (performance.now() - t < 400) { /* long frame */ }
          s.setRelayOnly(false);
          res({ ok: true, ms: Math.round(performance.now() - t0) });
        } else if (performance.now() - t0 > 5000) { s.setRelayOnly(false); res({ ok: false, ms: -1 }); }
        else setTimeout(poll, 0);
      };
      poll();
    }), polId);
    check('storm trigger reached have-local-offer', storm.ok, JSON.stringify(storm));
    const again = await waitBoth(imp, impId, pol, polId, 20_000);
    const r1 = [(await rebuilds(imp)) - r0[0], (await rebuilds(pol)) - r0[1]];
    check('reconnect after the storm trigger (< 15 s)', again >= 0 && again < 15_000, `${again} ms`);
    // stays connected and quiet afterwards
    await sleep(6000);
    const r2 = [(await rebuilds(imp)) - r0[0], (await rebuilds(pol)) - r0[1]];
    const s2 = [await state(imp, polId), await state(pol, impId)];
    check('few rebuilds (<= 4 per side) and no loop afterwards', r2[0] <= 4 && r2[1] <= 4 && r2[0] === r1[0] && r2[1] === r1[1], `rebuilds imp ${r1[0]}->${r2[0]} pol ${r1[1]}->${r2[1]}`);
    check('still connected 6 s later', s2[0] === 'connected' && s2[1] === 'connected', s2.join(' / '));
    if (fails) {
      const logs = await imp.evaluate(() => ((window.__voiceDebug as unknown as Dbg | undefined)?.logs() ?? []).slice(-25));
      console.log('impolite logs:\n  ' + logs.join('\n  '));
      const logs2 = await pol.evaluate(() => ((window.__voiceDebug as unknown as Dbg | undefined)?.logs() ?? []).slice(-25));
      console.log('polite logs:\n  ' + logs2.join('\n  '));
    }
  } finally {
    for (const p of players) await p.close().catch(() => {});
  }
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
