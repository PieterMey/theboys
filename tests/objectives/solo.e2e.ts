// Owner: track (a) Objectives. Solo assist (one living player, balance.objectives.soloAssist): one breaker powers the
// zone and one person can lift the Core, so the host can test the whole loop alone. node tests/objectives/solo.e2e.ts
import { connectBot } from '../bots/bot-client.ts';
import type { Bot } from '../bots/bot-client.ts';
import { ensureServer } from './server.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const srv = await ensureServer();
let A: Bot | null = null;
const out: string[] = [];
let ok = true;
const check = (name: string, pass: boolean, info = '') => { ok &&= pass; out.push(`${pass ? 'PASS' : 'FAIL'}  ${name}${info ? `  (${info})` : ''}`); };
try {
  A = await connectBot({ url: srv.ws, crew: 'SOLO', name: 'Solo' });
  const a = A;
  await a.dbg('objectives.start', { fixture: 'facility_s1_p2', realSec: 900, openDoors: true });
  await a.waitFor(() => !!a.obj?.active, 8000, 'contract');
  await sleep(2700);
  await a.dbg('monsters.freeze', { on: true }).catch(() => undefined);
  const st = () => a.obj!;
  const front = (p: [number, number, number], rot: number, d = 0.9): [number, number] => [p[0] + Math.sin(rot) * d, p[2] + Math.cos(rot) * d];
  const l0 = st().levers[0];
  await a.teleport(...front(l0.p, l0.rot));
  const r = await a.req('objectives.lever', { id: l0.id });
  await sleep(300);
  check('solo: one breaker restores power', r.result === 'success' && !!st().power[l0.zone], r.msg);
  const kp = st().keypad!;
  await a.teleport(...front(kp.p, kp.rot));
  const k = await a.req('objectives.keypad', { code: st().code });
  await sleep(250);
  check('keypad opens the vault', k.ok && st().vaultOpen, k.msg);
  const c = st().core!;
  await a.teleport(c.p[0] - 0.9, c.p[2]);
  await a.dbg('monsters.freeze', { on: true }).catch(() => undefined);
  const g = await a.req('objectives.core', { action: 'grab' });
  await sleep(250);
  check('solo: one person lifts the Core', g.ok && st().coreState === 'carried', `${g.state}`);
  const v = st().van!;
  await a.goTo(v.x + v.w / 2, v.y + v.h / 2, { speed: 2.5, timeoutMs: 60000 });
  await a.waitFor(() => st().coreState === 'van', 5000, 'core in van').catch(() => undefined);
  check('solo carry into the van extracts the Core', st().coreState === 'van', `hauled ${st().hauled}`);
  const end = a.waitEvent('objectives.end', undefined, 6000);
  const lv = await a.req('objectives.leave', {});
  const e = await end.catch(() => null);
  check('leave lever ends the contract', lv.ok && !!e && e.result.coreExtracted, e ? `hauled ${e.result.hauled}` : lv.msg);
} catch (e) {
  check('solo run', false, e instanceof Error ? e.message : String(e));
} finally {
  console.log(out.join('\n'));
  A?.close();
  srv.stop();
  process.exitCode = ok ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode ?? 0), 400).unref();
}
