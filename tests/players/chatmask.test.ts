// Owner: players (v1.3 P1d, paranormal-players-audio). Proximity text through names.ts: masked on the way out and on
// display, the speaker shown as names.ts shows them. Blocked words come from ROT13 codes decoded at run time (the
// names.ts test convention: no slur or swear word is typed in this file).
//   node --test tests/players/chatmask.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contractorName, rot13 } from '../../packages/shared/src/names.ts';
import { outgoingChat, shownChat } from '../../apps/client/src/players/chatmask.ts';

const BAD = rot13('onfgneq');

test('outgoing proximity text: blocked words masked per character, everything else untouched', () => {
  assert.equal(outgoingChat('meet me at the BOILER, hound is near'), 'meet me at the BOILER, hound is near');
  assert.equal(outgoingChat('code is 4 7 1 9'), 'code is 4 7 1 9');
  const masked = outgoingChat(`you ${BAD} get back here`);
  assert.equal(masked, `you ${'*'.repeat(BAD.length)} get back here`);
  assert.ok(!masked.toLowerCase().includes(BAD));
  // spaced-out letters are masked too
  const spaced = outgoingChat(`go ${[...BAD].join(' ')} now`);
  assert.ok(!spaced.replace(/[^a-z]/gi, '').toLowerCase().includes(BAD), 'letter runs masked');
  assert.equal(outgoingChat(''), '');
});

test('a received line: masked, and the speaker shown as names.ts shows them', () => {
  const a = shownChat({ id: 'p7', name: 'Ann', text: 'the LISTENER is in DOCK' });
  assert.deepEqual(a, { name: 'Ann', text: 'the LISTENER is in DOCK' }, 'game words like LISTENER stay in a sentence');
  const b = shownChat({ id: 'p7', name: `xX${BAD}Xx`, text: `${BAD}!` });
  assert.equal(b.name, contractorName('p7'), 'a blocked name shows as its Contractor-NNNN');
  assert.ok(!b.text.toLowerCase().includes(BAD));
});
