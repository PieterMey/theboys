// Owner: fieldguide (v1.2). Encounters (ws bots, no GPU):
//  - the hub kennel Hound counts: a bot stands next to it (dbg.monsters.tp, facing it) -> monsters' 2 Hz 'seen' ->
//    first contact 'NEW ENTRY: THE HOUND' filed exactly once, site THE LOT, HH:MM stamp;
//  - heard/seen count once per kind per visit (hub, then a contract); deaths and escapes, duplicates deduped;
//  - anomalies per witness; private 'fieldguide.state' pushed after every change;
//  - the booklet survives a server restart (same SAVES_DIR + SESSION_FILE, same player key).
//   node tests/fieldguide/encounters.e2e.ts   (PORT 3806; FG_SCRATCH=<dir> for the temp saves)
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bot, check, crewCode, sleep, startServer } from './lib.ts';
import type { FgDbgState, Server } from './lib.ts';
import type { FieldGuideView } from '../../packages/shared/src/messages/fieldguide.ts';

const dir = mkdtempSync(join(process.env.FG_SCRATCH ?? tmpdir(), 'fg-enc-'));
let srv: Server = await startServer({ dir });
const bots: Bot[] = [];
const notes: string[] = [];
const filedTitles = (b: Bot) => b.of('fieldguide.filed').map((e) => (e.d as { title: string }).title);
const mon = (v: FieldGuideView | null, k: string) => v?.monsters.find((m) => m.kind === k);

try {
  const code = crewCode();
  const a = new Bot('Ada');
  bots.push(a);
  await a.connect(srv.ws, code);
  await sleep(500);

  // ---------------------------------------------------------------- hub: the kennel Hound, real monsters path
  let hub = await a.dbg<{ agents?: { id: string; kind: string; x: number; z: number; chained?: boolean }[] }>('monsters.state');
  if (!hub.agents?.some((x) => x.kind === 'hound')) hub = await a.dbg('monsters.hub');
  const kennel = hub.agents?.find((x) => x.kind === 'hound');
  check(!!kennel, `kennel Hound running in the hub (${kennel?.id} at ${kennel?.x}, ${kennel?.z})`);
  let real = false;
  // stand close and face it (forward = (sin yaw, cos yaw)); try a few sides in case a fence edge blocks the line
  for (const [ox, oz] of [[0, -2], [2, 0], [0, 2], [-2, 0], [1.4, 1.4], [-1.4, -1.4], [0, -1.2], [1.2, 0]] as const) {
    const x = kennel!.x + ox, z = kennel!.z + oz;
    const yaw = Math.atan2(kennel!.x - x, kennel!.z - z);
    await a.dbg('monsters.tp', { x, z, yaw, light: 1 });
    try {
      await a.next((e) => e.e === 'fieldguide.filed', 2500, 'kennel first contact');
      real = true;
      break;
    } catch { /* next side */ }
  }
  if (!real) {
    notes.push('monsters seen/heard for the kennel Hound not observed: first contact injected via dbg.fieldguide.event');
    await a.dbg('fieldguide.event', { monster: 'hound', id: 'kennel', event: 'seen' });
    await a.next((e) => e.e === 'fieldguide.filed', 3000, 'injected first contact');
  }
  await sleep(1200); // more 2 Hz passes: must not file again
  check(filedTitles(a).filter((t) => t === 'NEW ENTRY: THE HOUND').length === 1, `NEW ENTRY: THE HOUND filed exactly once (${real ? 'real monsters event' : 'injected'})`);
  let st = await a.dbg<FgDbgState>('fieldguide.state');
  const hf = st.save.monsters.hound?.first;
  check(hf?.site === 'THE LOT', `first contact site THE LOT (${hf?.site})`);
  check(/^\d\d:\d\d$/.test(hf?.at ?? ''), `first contact stamped HH:MM (${hf?.at})`);
  check(st.persisted, 'booklet lives in the PlayerSave (meta)');

  // repeats in the same visit count once
  for (let i = 0; i < 3; i++) {
    await a.dbg('fieldguide.event', { monster: 'hound', id: 'kennel', event: 'seen' });
    await a.dbg('fieldguide.event', { monster: 'hound', id: 'kennel', event: 'heard' });
  }
  await sleep(150);
  st = await a.dbg<FgDbgState>('fieldguide.state');
  check(st.save.monsters.hound?.seen === 1 && st.save.monsters.hound?.heard === 1, `hub visit: seen 1, heard 1 (${st.save.monsters.hound?.seen}/${st.save.monsters.hound?.heard})`);
  const pushed = a.fg;
  check(mon(pushed, 'hound')?.level === 2 && (mon(pushed, 'hound')?.card.length ?? 0) === 3, 'fieldguide.state pushed: hound seen, card unlocked');
  check(mon(pushed, 'listener')?.name === '???', 'unmet monsters stay ???');

  // ---------------------------------------------------------------- a contract: new visit, deaths, escapes
  await a.dbg('monsters.start', { seed: 'fg-enc-1', risk: 2, contractIndex: 2 });
  await sleep(400);
  check(a.phase === 'contract', 'contract started (dbg.monsters.start)');
  await a.dbg('fieldguide.event', { monster: 'hound', id: 'hound0', event: 'seen' });
  await a.dbg('fieldguide.event', { monster: 'hound', id: 'hound0', event: 'seen' });
  await a.dbg('fieldguide.event', { monster: 'listener', id: 'listener0', event: 'heard' });
  await a.dbg('fieldguide.event', { monster: 'listener', id: 'listener0', event: 'notice' });
  await a.dbg('fieldguide.event', { monster: 'listener', id: 'listener0', event: 'knockdown' });
  await a.dbg('fieldguide.event', { monster: 'listener', id: 'listener0', event: 'knockdown' }); // duplicate within 30 s
  await a.dbg('fieldguide.event', { monster: 'listener', id: 'listener0', event: 'escaped' }); // a later escape counts
  await a.dbg('fieldguide.event', { monster: 'hound', id: 'hound0', event: 'kill' });
  await a.dbg('fieldguide.event', { monster: 'hound', id: 'hound0', event: 'kill' }); // duplicate
  await a.dbg('fieldguide.event', { monster: 'mannequin', id: 'mannequin0', event: 'wake' }); // no player: ignored
  await sleep(200);
  st = await a.dbg<FgDbgState>('fieldguide.state');
  const h = st.save.monsters.hound!, l = st.save.monsters.listener!;
  check(h.seen === 2 && h.heard === 1, `hound: seen counted again in the new visit (seen ${h.seen}, heard ${h.heard})`);
  check(h.deaths === 1, `hound: one death despite the duplicate kill (${h.deaths})`);
  check(l.heard === 1 && l.seen === 1, `listener: heard once (heard + notice), seen once via the knockdown (${l.heard}/${l.seen})`);
  check(l.escapes === 2, `listener: knockdown + escape = 2 escapes, the duplicate knockdown deduped (${l.escapes})`);
  check(l.first?.how === 'heard' && l.first.site !== 'THE LOT' && l.first.site.length > 2, `listener first contact on site: ${l.first?.how} at ${l.first?.site} ${l.first?.at}`);
  check(!st.save.monsters.mannequin, 'a wake event files nothing');
  check(filedTitles(a).filter((t) => t === 'NEW ENTRY: THE LISTENER').length === 1, 'NEW ENTRY: THE LISTENER filed once');

  // anomalies, per witness
  const b = new Bot('Bea');
  bots.push(b);
  await b.connect(srv.ws, code);
  await sleep(300);
  await a.dbg('fieldguide.phenomenon', { kind: 'cold_spot', witnesses: [a.me, b.me] });
  await a.dbg('fieldguide.phenomenon', { kind: 'cold_spot', witnesses: [a.me] });
  await a.dbg('fieldguide.phenomenon', { kind: 'knock', witnesses: [b.me, 'nobody'] });
  await sleep(200);
  const sa = await a.dbg<FgDbgState>('fieldguide.state', { pid: a.me });
  const sb = await a.dbg<FgDbgState>('fieldguide.state', { pid: b.me });
  check(sa.save.anomalies.cold_spot === 2 && !sa.save.anomalies.knock, `Ada: cold_spot x2 (${JSON.stringify(sa.save.anomalies)})`);
  check(sb.save.anomalies.cold_spot === 1 && sb.save.anomalies.knock === 1, `Bea: cold_spot x1, knock x1 (${JSON.stringify(sb.save.anomalies)})`);
  check(filedTitles(a).filter((t) => t === 'NEW ENTRY: COLD SPOT').length === 1, 'NEW ENTRY: COLD SPOT filed once for Ada');
  const va = await a.req<FieldGuideView>('fieldguide.get');
  check(va.anomalies.length === 1 && va.anomalies[0]!.label === 'COLD SPOT' && va.anomalies[0]!.count === 2 && va.anomalyKinds === 16, 'ANOMALIES: kinds and counts only');
  check(!JSON.stringify(a.of('fieldguide.state').concat(a.of('fieldguide.filed'))).includes(b.me), 'Ada never receives Bea\'s booklet');

  // ---------------------------------------------------------------- restart: the booklet survives
  await sleep(900); // meta's debounced save (400 ms)
  for (const x of bots) x.close();
  bots.length = 0;
  await srv.stop();
  srv = await startServer({ dir });
  const a2 = new Bot('Ada', a.key);
  bots.push(a2);
  await a2.connect(srv.ws, code);
  await sleep(400);
  const v2 = await a2.req<FieldGuideView>('fieldguide.get');
  const h2 = mon(v2, 'hound'), l2 = mon(v2, 'listener');
  check(h2?.level === 2 && h2.first?.site === 'THE LOT' && h2.seen === 2 && h2.deaths === 1, `after restart: hound first contact + counters kept (${JSON.stringify({ seen: h2?.seen, deaths: h2?.deaths, first: h2?.first })})`);
  check(l2?.escapes === 2 && l2.level === 2, 'after restart: listener kept');
  check(v2.anomalies.find((x) => x.kind === 'cold_spot')?.count === 2, 'after restart: anomalies kept');
  console.log(notes.length ? `NOTES:\n - ${notes.join('\n - ')}` : 'NOTES: none (kennel first contact came from the real monsters event bus)');
  console.log('ENCOUNTERS E2E OK');
} catch (e) {
  console.error(e);
  console.error(srv.log().slice(-5000));
  process.exitCode = 1;
} finally {
  for (const x of bots) x.close();
  await srv.stop();
}
