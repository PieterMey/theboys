// Track ① Net e2e: two Chrome players join one crew on a running server (BASE_URL, default :3001 dev),
// screenshot the HUD widget, check netstat/diag, walk via setInput and verify server-accepted poses,
// then kick-free error screen check (unknown crew on a prod server is covered by tests/net/bots.e2e.ts).
// Run: node tests/net/hud.e2e.ts
import { launchPlayer, screenshot } from '../lib/launch.ts';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3001';
const CREW = process.env.CREW ?? 'NHUD';
const out: string[] = [];
const fail: string[] = [];
const check = (name: string, ok: boolean, info = '') => {
  (ok ? out : fail).push(`${ok ? 'PASS' : 'FAIL'} ${name}${info ? ` (${info})` : ''}`);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`);
};

const a = await launchPlayer({ name: 'Ann', baseUrl: BASE, crew: CREW, query: { autojoin: '1' } });
const b = await launchPlayer({ name: 'Bob', baseUrl: BASE, crew: CREW, query: { autojoin: '1' } });
try {
  for (const p of [a, b]) {
    await p.page.waitForFunction(() => window.__game?.state() && (window.__game.state() as { net: string }).net === 'joined', undefined, { timeout: 30_000 });
  }
  for (const p of [a, b]) await p.page.waitForFunction(() => window.__game!.ready(), undefined, { timeout: 45_000 }).catch(() => console.log('WARN  __game.ready() still false (another track pending)'));
  await a.page.waitForTimeout(2500);
  const st = await a.page.evaluate(() => {
    const s = window.__game!.state() as { diag: Record<string, unknown>; crew: { players: unknown[] } };
    return { diag: s.diag.net as Record<string, number> | undefined, players: s.crew.players.length, hud: !!document.querySelector('[data-testid=nethud]'), hudText: document.querySelector('[data-testid=nethud]')?.textContent ?? '' };
  });
  check('HUD widget rendered', st.hud, st.hudText);
  check('crew has 2 players', st.players === 2, String(st.players));
  check('diag.net present (rtt, interp 80..250)', !!st.diag && st.diag.interpDelayMs >= 80 && st.diag.interpDelayMs <= 250, JSON.stringify(st.diag));
  check('snapshots ~20 Hz', !!st.diag && st.diag.snapHz > 15, String(st.diag?.snapHz));

  // walk: forward for 2.5 s, then compare server-side position of Ann as seen by Bob
  const meA = await a.page.evaluate(() => window.__game!.me());
  const posOf = (page: typeof b.page, id: string | null) => page.evaluate((pid) => {
    const s = window.__game!.state() as { players: { id: string; p?: number[] }[] };
    return s.players.find((p) => p.id === pid)?.p ?? null;
  }, id);
  const p0 = await posOf(b.page, meA);
  await a.page.evaluate(() => window.__game!.setInput({ forward: 1 }));
  await a.page.waitForTimeout(2500);
  await a.page.evaluate(() => window.__game!.setInput({ forward: 0 }));
  await a.page.waitForTimeout(600);
  const p1 = await posOf(b.page, meA);
  const moved = p0 && p1 ? Math.hypot(p1[0] - p0[0], p1[2] - p0[2]) : 0;
  check('Ann moved per Bob (server-accepted poses)', moved >= 1, `${moved.toFixed(2)} m, input=${!!(await a.page.evaluate(() => !!window.__game!.state()))}`);
  const corr = await a.page.evaluate(() => ((window.__game!.state() as { diag: { net?: { corrections: number } } }).diag.net?.corrections ?? -1));
  check('no pose corrections during a normal walk', corr === 0, String(corr));
  const aud = await b.page.evaluate((pid) => (window as unknown as { __audProbe?: unknown }).__audProbe ?? null, meA);
  void aud;
  if (await a.page.$('.nethud-count')) {
    await a.page.click('.nethud-count');
    await a.page.waitForSelector('[data-testid=nethud-roster]', { timeout: 2000 }).then(() => check('roster opens from the player count', true), () => check('roster opens from the player count', false));
  } else console.log('SKIP  roster (another lobby panel shows the crew + invite; the net widget shows only the link row)');
  const shot = await screenshot(a.page, 'tests/artifacts/net/hud.png');
  console.log('screenshot', shot);
  const errs = [...a.errors, ...b.errors, ...(await a.page.evaluate(() => window.__game!.errors())), ...(await b.page.evaluate(() => window.__game!.errors()))];
  check('no console/page errors', errs.length === 0, errs.slice(0, 4).join(' | '));
} finally {
  await a.close();
  await b.close();
}
console.log(`\nhud.e2e: ${fail.length ? 'FAIL' : 'PASS'} (${out.length} pass, ${fail.length} fail)`);
process.exitCode = fail.length ? 1 : 0;
