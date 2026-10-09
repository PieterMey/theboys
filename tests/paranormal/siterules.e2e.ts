// Owner: env-paranormal (v1.3 F7 Site Rules v0). Two raw ws bots against a real dev server (no browser, no STT, no AI):
// typed proximity text (players.chat -> the players noise bus -> siterules.ts) sets the house rules off.
//  - flag siteRules (dbg.setFlags) gates it; the crew's rule is forced with dbg.paranormal.siteRule (dbg contracts have
//    no work order)
//  - bell_digits: "the code is four seven one nine" -> both bots get 'paranormal.rule' (4 strikes at the bell, no
//    text); 'bell' noises (25 m) come due one per strike; a whisper-level dbg line passes
//  - phone_callsign: typing a room's callsign rings that room's phone (2 rings, 'phone' noises)
//   node tests/paranormal/siterules.e2e.ts   (PORT default 3814; PARA_SCRATCH = scratch dir for saves/session)
import { join } from 'node:path';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import type { SiteRuleEvent } from '../../packages/shared/src/messages/paranormal.ts';
import { indoor, nearVan, spaceAtXZ } from '../../apps/server/src/paranormal/gates.ts';
import { Bot, SCRATCH, sleep, startServer, waitFor } from './bot.ts';

const PORT = Number(process.env.PORT ?? 3814);
const results: { name: string; pass: boolean; info: string }[] = [];
const check = (name: string, pass: boolean, info = ''): boolean => {
  results.push({ name, pass, info });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`);
  return pass;
};

const srv = await startServer(PORT, { SESSION_FILE: join(SCRATCH, 'session.json') });
const url = `ws://127.0.0.1:${PORT}/ws`;
const A = new Bot('Ann'), B = new Bot('Bob');
type Noise = { kind: string; radiusM: number; source: string; x: number; z: number; t: number };
try {
  await A.connect(url, 'RULE');
  await B.connect(url, 'RULE');
  await A.dbg('objectives.start', { seed: 'varga-e2e-1', players: 2, realSec: 900 });
  const L = await waitFor(() => A.eventsOf<{ state?: { layout?: LevelLayout } }>('phase').pop()?.d.state?.layout, 5000, 'layout');
  await sleep(3000);
  await A.dbg('monsters.freeze', { on: true });
  // Ann and Bob together in a room away from the van
  const room = L.spaces.find((s) => indoor(L, s.id) && s.kind !== 'corridor' && !!s.callsign && s.rect.w >= 4 && !nearVan(L, s.rect.x + s.rect.w / 2, s.rect.y + s.rect.h / 2, 6))!;
  const x = Math.floor(room.rect.x + room.rect.w / 2) + 0.5, z = Math.floor(room.rect.y + room.rect.h / 2) + 0.5;
  await A.dbg('interaction.pose', { pid: A.id, x, z, yaw: 0, light: 1 });
  await A.dbg('interaction.pose', { pid: B.id, x: x + 1, z, yaw: 0, light: 1 });
  check('both in a room', spaceAtXZ(L, x, z) === room.id, `${room.callsign}`);

  // ---------------- flag off: nothing ----------------
  await A.dbg('paranormal.siteRule', { rule: 'bell_digits' });
  await A.dbg('setFlags', { set: { siteRules: false } });
  const c0 = await A.req<{ ok: boolean }>('players.chat', { text: 'three' });
  await sleep(400);
  check('flag siteRules off: typed numbers ring nothing', c0.ok && A.eventsOf('paranormal.rule').length === 0);
  await A.dbg('setFlags', { set: { siteRules: true } });

  // ---------------- the bell ----------------
  const st = await A.dbg<{ on: boolean; rule: string; bell: { space: number; x: number; z: number } | null }>('paranormal.siteRule', {});
  check('rule bell_digits, a bell spot', st.on && st.rule === 'bell_digits' && !!st.bell, st.bell ? `${L.spaces[st.bell.space].callsign}` : 'none');
  const n0 = (await A.dbg<Noise[]>('players.noise')).length;
  await A.req('players.chat', { text: 'the code is four seven one nine' });
  const evs = await waitFor(() => {
    const a = A.eventsOf<SiteRuleEvent>('paranormal.rule').at(-1);
    const b = B.eventsOf<SiteRuleEvent>('paranormal.rule').at(-1);
    return a && b ? [a, b] : null;
  }, 3000, 'bell event').catch(() => null);
  if (check('typed "four seven one nine": the bell answers both bots', !!evs)) {
    const ev = evs![0].d;
    check('4 strikes at the bell, identical for both, no text', ev.rule === 'bell_digits' && ev.data.strikes === 4 && ev.space === st.bell!.space
      && JSON.stringify(evs![0].d) === JSON.stringify(evs![1].d) && !JSON.stringify(ev).includes('nine') && !JSON.stringify(ev).includes('Ann'),
    `at +${Math.round(ev.at - evs![0].t)} ms`);
    // the strikes' noises come due one by one (2.2 s apart)
    await sleep(Math.max(0, ev.at - evs![0].t) + 2200 * 3 + 400);
    const bells = (await A.dbg<Noise[]>('players.noise')).slice(n0).filter((n) => n.kind === 'bell');
    const gaps = bells.slice(1).map((n, i) => Math.round(n.t - bells[i].t));
    check('4 bell noises (25 m) at the bell, ~2.2 s apart', bells.length === 4 && bells.every((n) => n.radiusM === 25 && n.source === '' && n.x === st.bell!.x) && gaps.every((g) => g >= 2100 && g <= 2400),
      `${bells.length} noises, gaps ${gaps.join('/')}`);
  }
  // a whisper (dbg line at band 1) passes after the rest
  await sleep(3200);
  const before = A.eventsOf('paranormal.rule').length;
  const w = await A.dbg<{ heard: boolean }>('paranormal.say', { text: 'two', band: 1 });
  await sleep(300);
  check('a whispered number passes', w.heard && A.eventsOf('paranormal.rule').length === before);

  // ---------------- the phones ----------------
  await A.dbg('paranormal.siteRule', { rule: 'phone_callsign' });
  const target = L.spaces.find((s) => s.callsign && s.id !== room.id && indoor(L, s.id) && s.type !== 'van')!;
  const n1 = (await A.dbg<Noise[]>('players.noise')).length;
  await A.req('players.chat', { text: `go to the ${target.callsign!.toLowerCase()} now` });
  const pev = await waitFor(() => B.eventsOf<SiteRuleEvent>('paranormal.rule').map((e) => e.d).find((e) => e.rule === 'phone_callsign'), 3000, 'phone event').catch(() => null);
  check(`typed "${target.callsign}": that room's phone rings (2 rings)`, !!pev && pev.space === target.id && pev.data.rings === 2 && pev.data.callsign === target.callsign, pev ? `${String(pev.data.callsign)}` : 'none');
  if (pev) {
    const rec = B.eventsOf<SiteRuleEvent>('paranormal.rule').find((e) => e.d.id === pev.id)!;
    await sleep(Math.max(0, rec.d.at - rec.t) + 4600);
    const phones = (await A.dbg<Noise[]>('players.noise')).slice(n1).filter((n) => n.kind === 'phone');
    check('2 phone noises (25 m) in that room', phones.length === 2 && phones.every((n) => n.radiusM === 25 && spaceAtXZ(L, n.x, n.z) === target.id), `${phones.length}`);
  }
  const errs = srv.log().split('\n').filter((l) => /\[(paranormal|siterules)\].*(error|threw|failed)/i.test(l));
  check('no paranormal / siterules errors in the server log', errs.length === 0, errs.slice(0, 2).join(' | '));
} catch (e) {
  check('run', false, e instanceof Error ? e.message : String(e));
} finally {
  await A.close().catch(() => null);
  await B.close().catch(() => null);
  await srv.stop();
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
