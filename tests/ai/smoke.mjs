#!/usr/bin/env node
// Track (e) LIVE smoke test: proves the three AI routes and their schemas end-to-end with real providers.
// Makes AT MOST 1 JEV call + 1 Haiku 4.5 call + 1 Opus 5.5 brief call (expected total well under $0.05).
// AI_MODE=record: provider responses (never the requests/transcripts) are saved under tests/ai/fixtures/<route>/.
//   node --env-file=C:\Users\Pieter\repos\theboys\.env tests/ai/smoke.mjs
// Prints numbers and validation results only (no keys, no prompts; the Opus flavour text is shown, it is fiction).
import { configureGateway, routeStatus, spentUsd, jevHealthCheck } from '../../apps/server/src/ai/gateway.ts';
import { prepare, runJev, runHaiku } from '../../apps/server/src/ai/listener.ts';
import { briefOnce, placeholdersIn } from '../../apps/server/src/ai/brief.ts';
import { readBalance, readFlags } from '../../apps/server/src/core/config.ts';
import { templateOrder } from './helpers.ts';

const balance = readBalance();
const flags = readFlags();
const log = { debug() {}, info: (...a) => console.log('[gw]', ...a), warn: (...a) => console.log('[gw] WARN', ...a), error: (...a) => console.log('[gw] ERROR', ...a) };
configureGateway({ mode: 'record', flags, bal: () => balance.ai ?? {}, budgetUsd: () => Number(balance.core.aiBudgetUsdPerSession ?? 3), log });
const before = spentUsd();
const haikuOnly = process.argv.includes('--haiku-only'); // re-prove only the Haiku route (1 call)
const FAST = process.env.MODEL_FAST || 'claude-haiku-4-5';
const WRITER = process.env.MODEL_WRITER || 'claude-opus-5-5';
let bad = 0;
const check = (what, ok) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) bad++; };

const input = {
  crew: 'SMOKE', listenerRoom: 'PUMPS', knownRooms: ['BOILER', 'CHAPEL', 'COLDROOM', 'VAULT', 'PUMPS'],
  players: [{ id: 'p1', name: 'Sam' }, { id: 'p2', name: 'Noor' }],
  heard: [
    { speaker: 'p2', text: 'haha did you hear that', room: 'CHAPEL', agoSec: 5 },
    { speaker: 'p1', text: 'okay everyone, meet me in the cold room, then we do the levers', room: 'CHAPEL', agoSec: 1.2, band: 2 },
  ],
};
const p = prepare(input);
check(`prepared: newest meaningful line -> room ${p?.room}, player ${p?.player}`, p?.room === 'COLDROOM' && p?.player === 'p1');

if (!haikuOnly) {
  console.log(`JEV health (free GET /v1/models): ${await jevHealthCheck()}`);
  // 1) JEV: action only (target derived in code)
  const t0 = performance.now();
  const j = await runJev(input, p);
  console.log(`JEV listener.jev: ${Math.round(performance.now() - t0)} ms -> ${j.intent ? `${j.intent.action} @ ${j.intent.target_room ?? j.intent.target_player} (confidence ${j.confidence.toFixed(2)})` : 'no answer'}`);
  check('JEV returned an allowed action', !!j.intent && p.allowed.includes(j.intent.action));
}

// 2) Haiku 4.5: structured fallback decision
const t1 = performance.now();
const h = await runHaiku(input, p, FAST);
console.log(`Haiku listener.haiku: ${Math.round(performance.now() - t1)} ms -> ${h ? `${h.action} room=${h.target_room} player=${h.target_player} note="${h.note}"` : 'null'}`);
check('Haiku decision validated (allowed action, heard targets, note <= 8 words)', !!h && p.allowed.includes(h.action) && h.note.split(' ').length <= 8);

// 3) Opus 5.5 brief (effort low): placeholders exactly once in the same notes
if (!haikuOnly) {
const order = templateOrder('smoke');
const t2 = performance.now();
const b = await briefOnce(order, WRITER);
console.log(`Opus brief.opus: ${Math.round(performance.now() - t2)} ms -> ${b.res.ok ? 'end_turn' : b.res.reason}${!b.res.ok && b.res.category ? ` (${b.res.category})` : ''}`);
if (b.merged) {
  console.log(`  site: ${b.merged.siteName}\n  memo: ${b.merged.memo}\n  note 1: ${b.merged.notes[0].title}: ${b.merged.notes[0].body}\n  note 2: ${b.merged.notes[1].title}: ${b.merged.notes[1].body}`);
}
check('brief merged with source ai', b.merged?.source === 'ai');
check('placeholders kept exactly once in the same notes', !!b.merged && placeholdersIn(b.merged.notes[0].body).join() === 'CODE_A' && placeholdersIn(b.merged.notes[1].body).sort().join() === 'CODE_B,ROOM_1');
}

const st = routeStatus();
console.log(`calls: ${Object.entries(st).map(([k, v]) => `${k}=${v.calls}`).join(' ')}`);
const spent = spentUsd() - before;
console.log(`live spend this run: $${spent.toFixed(4)}`);
check('spend under $0.05', spent < 0.05);
process.exitCode = bad ? 1 : 0;
setTimeout(() => process.exit(process.exitCode), 500).unref(); // let sockets close (libuv assert on Windows)
