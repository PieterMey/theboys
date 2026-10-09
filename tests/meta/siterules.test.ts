// Owner: track (d) Meta. v1.3 F7: Site Rules v0 rule-card text and the site lookup env-paranormal reads
// (meta/api.ts siteRule). Pure: no server.
//   node --test tests/meta/siterules.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SITES, SITE_RULES, siteRuleCard } from '../../apps/server/src/meta/templates.ts';
import { S, setRuntime, siteRuleOf, templateSiteOf } from '../../apps/server/src/meta/flow.ts';
import type { Crew } from '../../apps/server/src/core/types.ts';
import type { WorkOrder } from '../../packages/shared/src/workorder.ts';

setRuntime({
  ctx: { balance: { meta: {}, core: {} }, flags: { siteRules: true }, log: () => ({ info() {}, warn() {}, error() {} }), now: () => 0 } as never,
  store: { crew: () => null, allPlayers: () => [] } as never,
  shiftEndFns: [],
});

test('every rule site is a template site, and the two v0 sites have their rules', () => {
  const names = new Set(SITES.map((s) => s.name));
  for (const k of Object.keys(SITE_RULES)) assert.ok(names.has(k), `${k} is a template site`);
  assert.equal(SITE_RULES['Varga Brothers Foundry'], 'bell_digits');
  assert.equal(SITE_RULES['Old Quarry Road Telephone Exchange'], 'phone_callsign');
  assert.equal(Object.keys(SITE_RULES).length, 2);
});

test('rule cards: site cards, plain words, no code-ish numbers, short enough for the strip', () => {
  const bell = siteRuleCard('bell_digits');
  const phone = siteRuleCard('phone_callsign');
  for (const c of [bell, phone]) {
    assert.equal(c.monster, 'site');
    assert.match(c.title, /^HOUSE RULE: /);
    assert.ok(c.rule.length <= 200, `rule ${c.rule.length} chars`);
    assert.ok(c.hint.length <= 100, `hint ${c.hint.length} chars`);
    assert.ok(!/\d/.test(c.title + c.rule + c.hint), 'no digits on the card');
  }
  assert.match(bell.rule, /number/i);
  assert.match(bell.rule, /bell/i);
  assert.match(phone.rule, /callsign/i);
  assert.match(phone.rule, /phone/i);
});

test('the rule follows the template site name, not an AI rename', () => {
  const crew = { code: 'SR01', slices: {}, players: new Map(), phase: 'hub' } as unknown as Crew;
  const s = S(crew);
  const order = { id: 'wo1-0-x', siteName: 'Varga Brothers Foundry' } as WorkOrder;
  s.templateSites[order.id] = order.siteName;
  order.siteName = 'The Bellhouse (AI)';
  assert.equal(templateSiteOf(crew, order), 'Varga Brothers Foundry');
  assert.equal(siteRuleOf(crew, order), 'bell_digits');
  assert.equal(siteRuleOf(crew, { id: 'other', siteName: 'Corrigan Shoe Factory' } as WorkOrder), null);
  assert.equal(siteRuleOf(crew, null), null);
  // an order the board never saw falls back to its own name
  assert.equal(siteRuleOf(crew, { id: 'new', siteName: 'Old Quarry Road Telephone Exchange' } as WorkOrder), 'phone_callsign');
});
