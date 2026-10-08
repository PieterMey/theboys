// Owner: track (a) Objectives. Rule checks with 2 ws bots (monsters off):
//   keypad dead without power, twin breakers (single pull -> alarm + cooldown), keypad wrong/right, Core lift,
//   leash break -> drop -15%, leave lever refused while someone is outside, clock: 03:00 blackout, 03:30 horn,
//   04:00 departure (the one outside is left behind), result + requests.
//   node tests/objectives/rules.e2e.ts
import { connectBot } from '../bots/bot-client.ts';
import type { Bot } from '../bots/bot-client.ts';
import { ensureServer } from './server.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const results: { name: string; ok: boolean; info: string }[] = [];
const check = (name: string, ok: boolean, info = '') => {
  results.push({ name, ok, info });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`);
};

const srv = await ensureServer();
const crew = 'RULZ';
let A: Bot | null = null, B: Bot | null = null;
try {
  A = await connectBot({ url: srv.ws, crew, name: 'Rule-A' });
  B = await connectBot({ url: srv.ws, crew, name: 'Rule-B' });
  const a = A, b = B;
  const start = async () => {
    await a.dbg('objectives.start', { fixture: 'facility_s1_p2', realSec: 600, monsters: false, openDoors: true });
    await a.waitFor(() => !!a.obj?.active && a.full?.phase === 'contract', 8000, 'contract');
    await sleep(2700); // spawn lock / pose grace
    // 'monsters: false' does not stop (c): its contract runtime starts ~2.5 s in, unfrozen. Freeze THAT one ("monsters
    // off"), or a bot that walks out of the vault meets the Hound.
    for (let i = 0; i < 50; i++) {
      const m = (await a.dbg('monsters.state').catch(() => null)) as { mode?: string; frozen?: boolean } | null;
      if (!m || m.mode === 'off') break; // no monsters track
      if (m.mode === 'contract' && m.frozen) break;
      if (m.mode === 'contract') await a.dbg('monsters.freeze', { on: true }).catch(() => undefined);
      await sleep(100);
    }
  };
  const front = (p: [number, number, number], rot: number, d = 0.9): [number, number] => [p[0] + Math.sin(rot) * d, p[2] + Math.cos(rot) * d];
  /** the walkable cell centre minM..minM+4 m (straight line) from `from` that `bot` reaches by the shortest path:
   *  out through the vault door when the vault is too small for the leash (layout-independent, no fixed coordinates) */
  const farSpot = (bot: Bot, from: [number, number], minM: number): [number, number] | null => {
    const L = bot.layout;
    if (!L) return null;
    let best: [number, number] | null = null, cost = Infinity;
    for (let z = 0; z < L.H; z++) for (let x = 0; x < L.W; x++) {
      const px = x + 0.5, pz = z + 0.5, d = Math.hypot(px - from[0], pz - from[1]);
      if (d < minM || d > minM + 4 || L.owner[z * L.W + x] < 0) continue;
      const k = bot.pathCost(px, pz);
      if (k < cost) { cost = k; best = [px, pz]; }
    }
    return best;
  };

  // ---------- contract 1: breaker failure ----------
  await start();
  const st = () => a.obj!;
  const [l0, l1] = st().levers;
  const kp = st().keypad!;
  await a.teleport(...front(kp.p, kp.rot));
  await sleep(300);
  const dead = await a.req('objectives.keypad', { code: st().code });
  check('keypad is dead without power', !dead.ok && /power/i.test(dead.msg ?? ''), dead.msg);
  await a.teleport(...front(l0.p, l0.rot));
  await sleep(300);
  const failEv = a.waitEvent('objectives.lever', (d) => d.result === 'fail', 3000);
  const single = await a.req('objectives.lever', { id: l0.id });
  check('single breaker pull waits for the partner', single.result === 'waiting', single.msg);
  const fe = await failEv.catch(() => null);
  check('partner misses the 1 s window -> alarm + 20 s cooldown', !!fe && !!fe.cooldownUntil && fe.cooldownUntil - Date.now() > 15000, fe ? `cooldown ${Math.round(((fe.cooldownUntil ?? 0) - Date.now()) / 1000)} s` : 'no fail event');
  const cool = await a.req('objectives.lever', { id: l0.id });
  check('breakers refuse during the cooldown', cool.result === 'cooldown', cool.msg);

  // ---------- contract 2: power, vault, Core, leash ----------
  await start();
  const [m0, m1] = st().levers;
  await Promise.all([a.teleport(...front(m0.p, m0.rot)), b.teleport(...front(m1.p, m1.rot))]);
  await sleep(400);
  const [r0, r1] = await Promise.all([a.req('objectives.lever', { id: m0.id }), b.req('objectives.lever', { id: m1.id })]);
  await sleep(300);
  check('twin pull within 1 s -> power', !!st().power[m0.zone] && (r0.result === 'success' || r1.result === 'success'), `${r0.result}/${r1.result}`);
  const k2 = st().keypad!;
  await a.teleport(...front(k2.p, k2.rot));
  await sleep(300);
  const wrong = await a.req('objectives.keypad', { code: st().code === '0000' ? '1111' : '0000' });
  check('wrong code is refused', !wrong.ok, wrong.msg);
  const right = await a.req('objectives.keypad', { code: st().code });
  await sleep(250);
  check('right code opens the vault', right.ok && st().vaultOpen, right.msg);
  const c = st().core!;
  await Promise.all([a.teleport(c.p[0] - 0.9, c.p[2]), b.teleport(c.p[0] + 0.9, c.p[2])]);
  await sleep(400);
  await a.req('objectives.core', { action: 'grab' });
  const one = st().coreState;
  await b.req('objectives.core', { action: 'grab' });
  await sleep(250);
  check('one handle does not lift; two do', one === 'vault' && st().coreState === 'carried', `${one} -> ${st().coreState}`);
  const before = st().core!.value;
  // B walks away from A: leash breaks. A real path to a spot > leash + 1.5 m from A (a straight +x walk can end at the
  // vault wall inside the leash); the server slows stretched carriers, hence the longer windows.
  const dropEv = a.waitEvent('objectives.core', (d) => d.state === 'dropped', 15000);
  const away = farSpot(b, [c.p[0] - 0.9, c.p[2]], 6);
  if (away) void b.goTo(away[0], away[1], { speed: 2.5, timeoutMs: 14000 }).catch(() => undefined);
  const de = await dropEv.catch(() => null);
  b.stop();
  await sleep(250);
  check('carriers separating > leash drops the Core (-15%)', !!de && st().core!.value === before - Math.round(before * 0.15), de ? `${before} -> ${st().core!.value} (lost ${de.lost})` : 'no drop');

  // ---------- leave lever + clock ----------
  const v = st().van!;
  const ll = st().leaveLever!;
  await a.teleport(v.x + v.w / 2, v.y + v.h / 2);
  await sleep(400);
  const refuse = await a.req('objectives.leave', {});
  check('leave lever refused while a living player is outside', !refuse.ok && /Rule-B/.test(refuse.msg ?? ''), refuse.msg);
  void ll;
  const blk = a.waitEvent('objectives.blackout', undefined, 4000);
  await a.dbg('objectives.clock', { min: 299.7 });
  const be = await blk.catch(() => null);
  await sleep(300);
  check('03:00 blackout event + state', !!be && st().blackout, be ? `clockMin ${be.clockMin}` : 'none');
  const ix = a.full?.interaction as { lights?: Record<number, boolean> } | null | undefined;
  const litAfter = ix?.lights ? Object.entries(ix.lights).filter(([k, on]) => on && a.layout!.spaces[Number(k)]?.kind !== 'outside' && a.layout!.spaces[Number(k)]?.type !== 'van').length : -1;
  check('(b) lights follow the blackout', litAfter === 0 || litAfter === -1, litAfter === -1 ? 'no (b) state' : `${litAfter} lit indoor spaces`);
  const horn = a.waitEvent('objectives.horn', undefined, 4000);
  await a.dbg('objectives.clock', { min: 329.7 });
  check('03:30 horn', !!(await horn.catch(() => null)));
  const dep = a.waitEvent('objectives.departure', undefined, 5000);
  const end = a.waitEvent('objectives.end', undefined, 6000);
  await a.dbg('objectives.clock', { min: 359.7 });
  const dd = await dep.catch(() => null);
  const ee = await end.catch(() => null);
  check('04:00 departure: the player outside is left behind', !!dd && dd.lost.includes(b.id) && !dd.lost.includes(a.id), dd ? `lost ${dd.lost.length}` : 'none');
  const r = ee?.result;
  check('result: departure, 1 survivor, ALL_SURVIVE failed', !!r && r.reason === 'departure' && r.survivors.length === 1 && r.survivors[0] === a.id && !r.requestsMet.includes('ALL_SURVIVE'),
    r ? `reason ${r.reason}, survivors ${r.survivors.length}, deaths ${JSON.stringify(r.deaths)}, requests ${r.requestsMet.join(',') || '-'}` : 'no result');
} catch (e) {
  check('rules run', false, e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  A?.close();
  B?.close();
  const errs = srv.log().split('\n').filter((l) => /ERROR|threw/.test(l));
  if (errs.length) console.log('server errors:\n' + errs.slice(-15).join('\n'));
  srv.stop();
  const failed = results.filter((x) => !x.ok).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
  setTimeout(() => process.exit(process.exitCode ?? 0), 400).unref();
}
