// Owner: track (c) Monsters. Integration through the REAL phase flow (meta): hub (kennel hound) -> work order ->
// drive -> contract (meta calls startMonsters: hound + dormant Listener) -> director events -> contract end ->
// monsters stopped, decision log still readable. ws bots only.
//   node tests/monsters/flow.e2e.ts
import { Bot, sleep, startServer, waitFor } from './bot.ts';

const PORT = Number(process.env.PORT ?? 3013);
const results: { name: string; pass: boolean; info: string }[] = [];
const check = (name: string, pass: boolean, info = '') => {
  results.push({ name, pass, info });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`);
};
interface Ag { id: string; kind: string; state: string; active: boolean; dormant?: boolean }
interface Dump { mode: string; agents?: Ag[]; log?: unknown[]; director?: { phase: string; events: { kind: string }[] } | null }

const srv = await startServer(PORT);
const a = new Bot('Ann');
try {
  await a.connect(`ws://127.0.0.1:${PORT}/ws`, 'FLOW');
  const hub = await waitFor(async () => { const d = await a.dbg<Dump>('monsters.state'); return d.mode === 'hub' ? d : null; }, 5000, 'hub mode').catch(() => null);
  check('hub: kennel hound running (meta/startHub or auto)', !!hub && !!hub.agents?.some((x) => x.id === 'kennel'), hub?.mode ?? 'off');
  const st = await a.req<{ workOrders: { id: string; available: boolean; risk: number }[] }>('meta.state', {});
  const order = st.workOrders.find((o) => o.available) ?? st.workOrders[0];
  check('meta offers work orders', !!order, `${st.workOrders.length} orders`);
  const dr = await a.req<{ ok: boolean; reason?: string }>('meta.drive', { orderId: order.id });
  check('leader drives', dr.ok, dr.reason ?? '');
  await a.dbg('meta.skipDrive').catch(() => null);
  const t0 = performance.now();
  const con = await waitFor(async () => { const d = await a.dbg<Dump>('monsters.state'); return d.mode === 'contract' ? d : null; }, 15000, 'contract mode').catch(() => null);
  check('contract: monsters started by the flow', !!con && !!con.agents?.some((x) => x.kind === 'hound') && !!con.agents?.some((x) => x.kind === 'listener' && x.dormant), con ? `${Math.round(performance.now() - t0)} ms, ${con.agents?.map((x) => x.id).join(',')}` : 'never');
  const snapM = await waitFor(() => a.snap?.monsters.find((m) => m.kind === 'hound'), 2000, 'hound in snapshot').catch(() => null);
  check('snapshot carries monsters during the contract', !!snapM);
  // director events (forced) reach the client
  const kinds = ['flicker', 'door_slam', 'radio_static', 'quiet'];
  for (const k of kinds) {
    const t1 = performance.now();
    const r = await a.dbg<{ ok: boolean }>('monsters.director', { kind: k });
    const ev = k === 'quiet' ? true : await waitFor(() => a.eventsOf('monsters.director', t1).find((e) => (e.d as { kind: string }).kind === k), 1500, `director ${k}`).catch(() => null);
    check(`director event '${k}'`, r.ok && !!ev, r.ok ? '' : 'not allowed here');
  }
  const d1 = await a.dbg<Dump>('monsters.state');
  check('director state tracked (phase + events)', !!d1.director && typeof d1.director.phase === 'string' && d1.director.events.length >= 3, d1.director ? `${d1.director.phase}, ${d1.director.events.length} events` : 'none');
  // end the contract through meta -> monsters stop, log still readable
  await a.dbg('meta.endContract', {}).catch(() => null);
  const off = await waitFor(async () => { const d = await a.dbg<Dump>('monsters.state'); return d.mode !== 'contract' ? d : null; }, 5000, 'monsters stopped').catch(() => null);
  check('contract end -> monsters stopped', !!off, off?.mode ?? 'still running');
  const lines = await a.req<{ lines: string[] }>('monsters.log', {});
  check('decision log readable after the contract (monsters.log)', Array.isArray(lines.lines));
  await sleep(200);
} catch (e) {
  check('run', false, e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  a.close();
  await srv.stop();
}
const failed = results.filter((x) => !x.pass);
if (failed.length) console.log(srv.log().split('\n').filter((l) => /phase|monsters|meta|error/i.test(l)).slice(-25).join('\n'));
console.log(`\nflow: ${failed.length ? 'FAILED' : 'PASSED'} ${results.length - failed.length}/${results.length}`);
process.exitCode = failed.length ? 1 : 0;
setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
