// Track (e): AI gateway in AI_MODE=replay (fixtures, no network): stop_reason branching, JSON validation,
// circuit breaker, budget from the usage log, committed default fixtures for every route.
//   node --test tests/ai/gateway.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeJson, configureGateway, jevChoose, resetGateway, routeStatus, spentUsd, fixtureKey } from '../../apps/server/src/ai/gateway.ts';
import type { MockMessage } from '../../apps/server/src/ai/gateway.ts';
import { resetListenerMemo } from '../../apps/server/src/ai/listener.ts';
import { resetBriefs } from '../../apps/server/src/ai/brief.ts';
import { briefFor, listenerIntent, directorPick } from '../../apps/server/src/ai/api.ts';
import { REPO, quietLog, templateOrder } from './helpers.ts';

const tmp = mkdtempSync(join(tmpdir(), 'ai-fx-'));
const msg = (stop: string, text: string, category?: string): MockMessage => ({
  stop_reason: stop, content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 10 }, stop_details: category ? { category } : null,
});
function fixture(route: string, key: string, raw: unknown, error?: { kind: string; status?: number }): void {
  mkdirSync(join(tmp, route), { recursive: true });
  writeFileSync(join(tmp, route, `${key}.json`), JSON.stringify({ route, key, provider: 'anthropic', raw, error }));
}
const req = (route: string, user = 'u') => ({
  route, model: 'claude-haiku-4-5', system: 's', user, schema: { type: 'object' }, maxTokens: 50, timeoutMs: 100,
  fixtureInput: { user }, mock: () => msg('end_turn', '{}'),
});

beforeEach(() => {
  resetGateway();
  resetListenerMemo();
  resetBriefs();
  configureGateway({ mode: 'replay', flags: {}, bal: () => ({}), budgetUsd: () => 3, log: quietLog, fixturesDir: tmp });
});

test('end_turn -> parsed JSON; refusal / max_tokens / bad JSON -> typed failure (no throw)', async () => {
  fixture('t.ok', fixtureKey({ user: 'a' }), msg('end_turn', '{"x":1}'));
  fixture('t.ok', fixtureKey({ user: 'b' }), msg('refusal', '', 'bio'));
  fixture('t.ok', fixtureKey({ user: 'c' }), msg('max_tokens', '{"x":'));
  fixture('t.ok', fixtureKey({ user: 'd' }), msg('end_turn', 'not json'));
  const a = await claudeJson(req('t.ok', 'a'));
  assert.deepEqual(a.ok ? a.data : null, { x: 1 });
  const b = await claudeJson(req('t.ok', 'b'));
  assert.equal(!b.ok && b.reason, 'refusal');
  assert.equal(!b.ok && b.category, 'bio');
  const c = await claudeJson(req('t.ok', 'c'));
  assert.equal(!c.ok && c.reason, 'max_tokens');
  const d = await claudeJson(req('t.ok', 'd'));
  assert.equal(!d.ok && d.reason, 'parse');
  const miss = await claudeJson(req('t.none', 'zzz'));
  assert.equal(!miss.ok && miss.reason, 'replay_miss');
  assert.equal(spentUsd(), 0, 'replay costs nothing');
});

test('circuit breaker opens after 2 failures and short-circuits the route', async () => {
  fixture('t.brk', 'default', null, { kind: 'timeout' });
  const r1 = await claudeJson(req('t.brk', '1'));
  const r2 = await claudeJson(req('t.brk', '2'));
  assert.equal(!r1.ok && r1.reason, 'timeout');
  assert.equal(!r2.ok && r2.reason, 'timeout');
  const r3 = await claudeJson(req('t.brk', '3'));
  assert.equal(!r3.ok && r3.reason, 'breaker');
  assert.equal(routeStatus()['t.brk'].breaker, 'open');
  assert.ok(routeStatus()['t.brk'].openForSec > 50);
});

test('JEV replay: answers validated against the offered options', async () => {
  mkdirSync(join(tmp, 't.jev'), { recursive: true });
  writeFileSync(join(tmp, 't.jev', 'default.json'), JSON.stringify({ provider: 'jev', raw: { answers: { q: { choice: 'b', confidence: 0.8, probabilities: { a: 0.2, b: 0.8 } } }, usage: { input_tokens: 500 } } }));
  const ok = await jevChoose({ route: 't.jev', state: {}, questions: { q: { instructions: 'pick', criteria: { a: 'A', b: 'B' } } }, timeoutMs: 100, mock: () => ({ answers: {} }) });
  assert.equal(ok.ok && ok.answers.q.choice, 'b');
  const bad = await jevChoose({ route: 't.jev', state: {}, questions: { q: { instructions: 'pick', criteria: { a: 'A', c: 'C' } } }, timeoutMs: 100, mock: () => ({ answers: {} }) });
  assert.equal(!bad.ok && bad.reason, 'invalid', 'choice outside the offered options is rejected');
});

test('budget: spend in the usage log window counts; over budget -> calls refused before any network', async () => {
  const log = join(tmp, 'usage.jsonl');
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 48 * 3600_000).toISOString();
  writeFileSync(log, [JSON.stringify({ t: now, usd: 1.25 }), JSON.stringify({ t: now, usd: 1.0 }), JSON.stringify({ t: old, usd: 50 }), 'garbage'].join('\n'));
  const saved = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = saved ?? 'test-key-not-used';
  try {
    configureGateway({ mode: 'live', flags: {}, bal: () => ({}), budgetUsd: () => 2, log: quietLog, usageLog: log, fixturesDir: tmp });
    assert.equal(Math.round(spentUsd() * 100) / 100, 2.25, 'only the last 12 h count');
    const r = await claudeJson(req('t.budget'));
    assert.equal(!r.ok && r.reason, 'budget');
    const j = await jevChoose({ route: 't.jbudget', state: {}, questions: { q: { instructions: 'x', criteria: { a: 'A', b: 'B' } } }, timeoutMs: 50, mock: () => ({ answers: {} }) });
    assert.equal(!j.ok && (j.reason === 'budget' || j.reason === 'nokey'), true);
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
});

test('committed replay fixtures: listener (JEV low confidence -> Haiku), director, brief all parse', async () => {
  configureGateway({ mode: 'replay', flags: {}, bal: () => ({}), budgetUsd: () => 3, log: quietLog, fixturesDir: join(REPO, 'tests/ai/fixtures') });
  const r = await listenerIntent({
    crew: 'RPL', listenerRoom: 'PUMPS', knownRooms: ['BOILER', 'CHAPEL', 'PUMPS'], players: [{ id: 'p1', name: 'Sam' }],
    heard: [{ speaker: 'p1', text: 'meet me in the chapel', room: 'BOILER', agoSec: 1 }],
  });
  assert.ok(r, 'intent from fixtures');
  assert.equal(r.source, 'haiku', 'default JEV fixture has confidence < 0.5 -> Haiku fixture');
  assert.equal(r.target_room, 'CHAPEL');
  const d = await directorPick({ tension: 0.2 }, ['flicker', 'door_slam', 'quiet']);
  assert.equal(d, 'flicker');
  const o = await briefFor(templateOrder('rpl'));
  assert.equal(o.source, 'ai');
  assert.equal(o.notes.length, 2);
});
