// P3 QA: keys 1-4 while the emote wheel (hold T) is open pick an emote and must NOT switch the inventory slot;
// without the wheel they still switch slots.
//   BASE_URL=http://127.0.0.1:3096 node tests/qa/wheel.e2e.ts
import { WS_URL, connectBot, log, qaPlayer, randomCrew, sleep, st } from './lib.ts';

const crew = randomCrew();
const L = await connectBot({ url: WS_URL, crew, name: 'Lead' });
const p = await qaPlayer('Ann', 'silence.wav', crew);
let ok = true;
const check = (c: unknown, what: string) => { log(`${c ? 'ok  ' : 'FAIL'} ${what}`); if (!c) ok = false; };
try {
  await L.dbg('objectives.start', { realSec: 600 });
  await p.page.waitForFunction(() => (window.__game!.state() as { phase: string }).phase === 'contract', undefined, { timeout: 20_000 });
  await sleep(4000);
  const me = (await st(p.page)).me;
  for (const type of ['bottle', 'crowbar', 'medkit']) await L.dbg('interaction.give', { pid: me, type });
  await sleep(800);
  const active = async () => p.page.evaluate((id) => ((window.__game!.state() as { interaction: { active?: Record<string, number> } }).interaction?.active ?? {})[id] ?? 0, me);
  await p.page.click('canvas').catch(() => {});
  await p.page.keyboard.press('Digit1');
  await sleep(400);
  const a0 = await active();
  check(a0 === 0, `slot 1 selected without the wheel (${a0})`);
  // hold T (wheel), press 3, release T
  await p.page.keyboard.down('KeyT');
  await sleep(250);
  const open = await p.page.evaluate(() => !!document.querySelector('[style*="radial-gradient(circle"]'));
  check(open, 'emote wheel open while T is held');
  await p.page.keyboard.press('Digit3');
  await sleep(250);
  const sel = await p.page.evaluate(() => [...document.querySelectorAll('div')].find((d) => d.style.background === 'rgb(232, 201, 90)')?.textContent ?? null);
  check(sel?.startsWith('3 '), `key 3 highlights wheel entry 3 (${sel})`);
  await p.page.keyboard.up('KeyT');
  await sleep(600);
  const a1 = await active();
  check(a1 === 0, `inventory slot unchanged after 3 on the open wheel (${a1})`);
  const emoted = L.events.some((e) => e.e === 'players.emote' && (e.d as { id?: string }).id === me);
  check(emoted, 'the picked emote was played (players.emote event)');
  await p.page.keyboard.press('Digit3');
  await sleep(500);
  const a2 = await active();
  check(a2 === 2, `without the wheel, 3 still selects slot 3 (${a2})`);
  const errs = await p.page.evaluate(() => window.__game!.errors());
  check(errs.length === 0, `no client errors (${errs.slice(0, 2).join(' | ').slice(0, 200)})`);
} finally {
  L.close();
  await p.close();
  log(ok ? 'QA WHEEL PASS' : 'QA WHEEL FAIL');
  process.exitCode = ok ? 0 : 1;
  setTimeout(() => process.exit(ok ? 0 : 1), 300).unref();
}
