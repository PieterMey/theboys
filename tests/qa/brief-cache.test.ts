// P3 QA: a brief the gateway never sent (route busy / breaker open / AI off) must not pin the template to that order
// for the rest of the night: the next briefFor() for the same order tries again. A brief that WAS sent and failed
// stays cached (no repeated spend). AI_MODE=replay with temp fixtures: never the network.
//   node --test tests/qa/brief-cache.test.ts
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureGateway, resetGateway, routeStatus } from '../../apps/server/src/ai/gateway.ts';
import { resetBriefs } from '../../apps/server/src/ai/brief.ts';
import { briefFor } from '../../apps/server/src/ai/api.ts';
import { REPO, quietLog, templateOrder } from '../ai/helpers.ts';

const tmp = mkdtempSync(join(tmpdir(), 'qa-brief-fx-'));
const good = JSON.parse((await import('node:fs')).readFileSync(join(REPO, 'tests/ai/fixtures/brief.opus/default.json'), 'utf8')) as { raw: unknown };
function setFixture(error: boolean): void {
  rmSync(join(tmp, 'brief.opus'), { recursive: true, force: true });
  mkdirSync(join(tmp, 'brief.opus'), { recursive: true });
  writeFileSync(join(tmp, 'brief.opus', 'default.json'), JSON.stringify(error
    ? { route: 'brief.opus', key: 'default', provider: 'anthropic', raw: null, error: { kind: 'http', status: 500 } }
    : { route: 'brief.opus', key: 'default', provider: 'anthropic', raw: good.raw }));
}

beforeEach(() => {
  resetGateway();
  resetBriefs();
  configureGateway({ mode: 'replay', flags: {}, bal: () => ({ breakerFailures: 1, breakerOpenMs: 60_000 }), budgetUsd: () => 3, log: quietLog, fixturesDir: tmp });
});

test('breaker-blocked brief is retried later; a failed (sent) brief stays the template', async () => {
  setFixture(true);
  const failed = await briefFor(templateOrder('sent-fail'));
  assert.equal(failed.source, 'template', 'HTTP 500 -> template');
  assert.equal(routeStatus()['brief.opus']?.breaker, 'open', 'one failure opens the breaker (test balance)');
  const blocked = await briefFor(templateOrder('blocked'));
  assert.equal(blocked.source, 'template', 'breaker open -> nothing sent -> template');
  const calls = routeStatus()['brief.opus']?.calls ?? 0;
  // the provider recovers and the breaker closes
  setFixture(false);
  resetGateway();
  configureGateway({ mode: 'replay', flags: {}, bal: () => ({}), budgetUsd: () => 3, log: quietLog, fixturesDir: tmp });
  const retried = await briefFor(templateOrder('blocked'));
  assert.equal(retried.source, 'ai', 'the order blocked by the breaker gets its AI text on the next request');
  const again = await briefFor(templateOrder('sent-fail'));
  assert.equal(again.source, 'template', 'the order whose call was sent and failed stays cached (no repeated spend)');
  assert.ok(calls >= 1);
});
