// Owner: track (a) Objectives. LURE_IT_WITH_A_LIE: a bot names an empty room where the Listener can hear it; the
// Listener's (c) decision to go there completes the Company Request. node tests/objectives/lure.e2e.ts
import { connectBot } from '../bots/bot-client.ts';
import type { Bot } from '../bots/bot-client.ts';
import { ensureServer } from './server.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const srv = await ensureServer();
let A: Bot | null = null;
let ok = false;
try {
  A = await connectBot({ url: srv.ws, crew: 'LURE', name: 'Liar' });
  const a = A;
  await a.dbg('objectives.start', {
    fixture: 'facility_s1_p2', realSec: 900, openDoors: true,
    order: { requests: [{ kind: 'LURE_IT_WITH_A_LIE', reward: 150, text: 'lie to it' }] },
  });
  await a.waitFor(() => !!a.obj?.active, 8000, 'contract');
  await sleep(3000); // (c) auto-starts its runtime ~2.5 s in
  const L = a.layout!;
  const room = L.spaces.find((s) => s.callsign && s.kind === 'room' && s.type !== 'van' && s.zone === 0 && !s.open);
  if (!room) throw new Error('no named room');
  console.log(`naming ${room.callsign} (space ${room.id}); requests: ${JSON.stringify(a.obj!.requests)}`);
  console.log('wake:', JSON.stringify(await a.dbg('monsters.wake', {}).catch((e) => String(e))));
  const done = a.waitEvent('objectives.request', (d) => d.kind === 'LURE_IT_WITH_A_LIE' && d.done, 15000);
  for (let i = 0; i < 4; i++) {
    const r = await a.dbg('monsters.utter', { text: `everyone meet in the ${room.callsign!.toLowerCase()} right now, ${room.callsign} go go`, listener: true, room: a.layout!.spaces[0].id }).catch((e) => String(e));
    console.log('utter:', JSON.stringify(r));
    const got = await Promise.race([done.then(() => true), sleep(3500).then(() => false)]);
    if (got) { ok = true; break; }
  }
  const dl = await a.dbg('monsters.state', {}).catch(() => null) as { log?: string[] } | null;
  console.log('listener log:', JSON.stringify(dl?.log?.slice(-4) ?? dl).slice(0, 600));
  console.log(`${ok ? 'PASS' : 'FAIL'}  LURE_IT_WITH_A_LIE completes when it goes for a named empty room  (requests ${JSON.stringify(a.obj!.requests)})`);
} catch (e) {
  console.log('FAIL  lure run', e instanceof Error ? e.message : e);
} finally {
  A?.close();
  srv.stop();
  process.exitCode = ok ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode ?? 0), 400).unref();
}
