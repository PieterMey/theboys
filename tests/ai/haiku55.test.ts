// Integrator (v1.2 model update): Claude Haiku 5.5 as MODEL_FAST. Haiku 5.5 thinks adaptively by default and its
// thinking counts toward max_tokens, so fast routes get effort 'low' and a max_tokens floor; Haiku 4.5 (the refusal
// retry model) rejects effort and must keep its request unchanged.
//   node --test tests/ai/haiku55.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configureGateway, costUsd, haikuOpts } from '../../apps/server/src/ai/gateway.ts';

const quietLog = { info() {}, warn() {}, error() {}, debug() {} };

test('Haiku 5.5: effort low and max_tokens >= 1024 (room for adaptive thinking)', () => {
  configureGateway({ mode: 'mock', flags: {}, bal: () => ({}), budgetUsd: () => 3, log: quietLog });
  assert.deepEqual(haikuOpts('claude-haiku-5-5', undefined, 80), { effort: 'low', maxTokens: 1024 });
  assert.deepEqual(haikuOpts('claude-haiku-5-5', undefined, 2500), { effort: 'low', maxTokens: 2500 });
  assert.deepEqual(haikuOpts('claude-haiku-5-5', 'medium', 120), { effort: 'medium', maxTokens: 1024 }, 'an explicit effort wins');
});

test('balance knobs: haikuEffort and haikuMinMaxTokens', () => {
  configureGateway({ mode: 'mock', flags: {}, bal: () => ({ haikuEffort: 'high', haikuMinMaxTokens: 2048 }), budgetUsd: () => 3, log: quietLog });
  assert.deepEqual(haikuOpts('claude-haiku-5-5', undefined, 100), { effort: 'high', maxTokens: 2048 });
});

test('Haiku 4.5 and other models are untouched (Haiku 4.5 rejects effort)', () => {
  configureGateway({ mode: 'mock', flags: {}, bal: () => ({}), budgetUsd: () => 3, log: quietLog });
  assert.deepEqual(haikuOpts('claude-haiku-4-5', undefined, 2500), { effort: undefined, maxTokens: 2500 });
  assert.deepEqual(haikuOpts('claude-opus-5-5', 'low', 16000), { effort: 'low', maxTokens: 16000 });
});

test('prices: Haiku 5.5 is $0.10 / $0.50 per MTok, Haiku 4.5 stays $1 / $5', () => {
  configureGateway({ mode: 'mock', flags: {}, bal: () => ({}), budgetUsd: () => 3, log: quietLog });
  assert.equal(costUsd('claude-haiku-5-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 }).toFixed(2), '0.60');
  assert.equal(costUsd('claude-haiku-4-5', { input_tokens: 1_000_000, output_tokens: 1_000_000 }).toFixed(2), '6.00');
});
