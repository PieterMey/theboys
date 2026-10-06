// Track ④ Voice e2e: cold-start band detection (FINDINGS HIGH 'normal speech reads SHOUT / whisper reads TALK'
// and MEDIUM 'adaptive baseline unbounded'). Three FRESH profiles (no calibration, no saved baseline) with
// talk_en.wav (~-21 dBFS), whisper.wav (~-35) and shout.wav (~-8); band histogram per 5 s window.
//   BASE_URL=http://127.0.0.1:3401 node tests/voice/bands.e2e.ts   (SECS=30 by default)
import { launchPlayer } from '../lib/launch.ts';
import type { Player } from '../lib/launch.ts';
import type { Page } from 'playwright-core';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3004';
const SECS = Number(process.env.SECS ?? 30);
const ALPHA = 'BCDFGHJKLMNPQRSTVWXZ';
const crew = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => ALPHA[b % ALPHA.length]).join('');
let fails = 0;
const check = (name: string, ok: boolean, info: string) => { if (!ok) fails++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${info}`); };
type Win = { base: number; h: Record<string, number> };

async function record(page: Page, secs: number): Promise<Win[]> {
  for (let i = 0; ; i++) {
    try { return await record1(page, secs); } catch (e) { if (i >= 2) throw e; } // a page reload (HMR) restarts the window
  }
}
async function record1(page: Page, secs: number): Promise<Win[]> {
  await page.waitForFunction(() => {
    const d = window.__voiceDebug as unknown as { level?(): { db: number } | null } | undefined;
    const l = d?.level?.();
    return !!l && l.db > -90;
  }, undefined, { timeout: 60_000, polling: 200 });
  return page.evaluate(async (n) => {
    const names = ['silent', 'whisper', 'talk', 'shout', 'scream'];
    const d = window.__voiceDebug as unknown as { band(): number; level(): { base: number } };
    const out: { base: number; h: Record<string, number> }[] = [];
    for (let s = 0; s < n / 5; s++) {
      const h: Record<string, number> = {};
      const t0 = performance.now();
      while (performance.now() - t0 < 5000) { const b = d.band(); h[names[b]] = (h[names[b]] ?? 0) + 1; await new Promise((r) => setTimeout(r, 100)); }
      out.push({ base: Math.round(d.level().base * 10) / 10, h });
    }
    return out;
  }, secs);
}
const fmt = (w: Win[]) => w.map((x, i) => `[${i * 5}-${i * 5 + 5}s base ${x.base}: ${Object.entries(x.h).map(([k, v]) => `${k} ${v}`).join(' ')}]`).join(' ');
const c = (w: Win, k: string) => w.h[k] ?? 0;

async function main(): Promise<void> {
  const query = { autojoin: '1', voiceListener: 'server' };
  const players: Player[] = [];
  try {
    const ps = await Promise.all([
      launchPlayer({ name: 'FreshTalk', wav: 'talk_en.wav', baseUrl: BASE, crew, query }),
      launchPlayer({ name: 'FreshWhisper', wav: 'whisper.wav', baseUrl: BASE, crew, query }),
      launchPlayer({ name: 'FreshShout', wav: 'shout.wav', baseUrl: BASE, crew, query }),
    ]);
    players.push(...ps);
    for (const p of players) await p.page.routeWebSocket(/token=/, () => {});
    const [talk, whisper, shout] = await Promise.all(ps.map((p) => record(p.page, SECS)));
    console.log('talk   ', fmt(talk));
    console.log('whisper', fmt(whisper));
    console.log('shout  ', fmt(shout));
    check('talk reads TALK, not SHOUT, in every window', talk.every((w) => c(w, 'talk') > c(w, 'shout') + c(w, 'scream')), '');
    check('whisper reads WHISPER more than TALK in every window', whisper.every((w) => c(w, 'whisper') > c(w, 'talk')), '');
    check('shout stays SHOUT/SCREAM (more than TALK) in every window', shout.every((w) => c(w, 'shout') + c(w, 'scream') > c(w, 'talk')), '');
    const bases = [...talk, ...whisper, ...shout].map((w) => w.base);
    check('baselines stay inside [-38, -18] dBFS', bases.every((b) => b >= -38.05 && b <= -17.95), bases.join(','));
  } finally {
    for (const p of players) await p.close().catch(() => {});
  }
  console.log(fails ? `${fails} FAILED` : 'ALL PASS');
  process.exit(fails ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
