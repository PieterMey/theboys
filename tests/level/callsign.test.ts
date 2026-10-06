// Track ② Level: callsign normalizer + fuzzy matcher (EN/NL). Run: node --test tests/level/callsign.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LevelLayout } from '../../packages/shared/src/layout.ts';
import { DEFAULT_LEVEL_TUNING } from '../../packages/shared/src/procgen/tuning.ts';
import {
  CALLSIGNS, CALLSIGN_INFO, confusable, editDistance, extractDigitRuns, findCallsigns, hotwordsFor, matchCallsigns, normalizeUtterance, withinOneEdit,
} from '../../packages/shared/src/callsign.ts';

const ALL = CALLSIGNS as readonly string[];

const VARIANTS: Record<string, string[]> = {
  BOILER: [
    'boiler', 'BOILER', 'Boiler!', 'the boiler room', 'boilerroom', 'boiler-room', 'go to the boiler', 'meet me in boiler',
    'boyler', 'boilr', 'boilers', 'i am in the boiler room now', 'ga naar de ketel', 'de ketelruimte', 'in het ketelhuis',
    'stookruimte', 'Boiler, two of them!', 'bolier', 'boiler?? hurry', 'he went into the boiler... i think', 'BOILER ROOM.',
    'we zitten in de boiler', 'oké boiler nu',
  ],
  COLDROOM: [
    'coldroom', 'cold room', 'COLD ROOM', 'Cold-Room', 'the cold room', 'kold room', 'cold rooom', 'coldrom', 'cold store',
    'cold storage', 'the freezer', 'freezer', 'koelcel', 'de koelcel', 'koude kamer', 'in de koude kamer', 'koelruimte',
    'vriezer', 'naar de vriezer', 'meet at coldroom', 'cold room, go!', 'is it in the coldroom?', 'koelkamer',
  ],
  CHAPEL: [
    'chapel', 'Chapel', 'the chapel', 'CHAPEL!', 'chapell', 'chappel', 'chaple', 'chapels', 'in the chapel', 'kapel',
    'de kapel', 'naar de kapel', 'chapel now', 'go chapel', 'chapel? yes', 'the old chapel', 'hide in the chapel',
    'kapel snel', 'chapel, chapel', 'meet in chapel', 'chapel.', 'he is in the chapel lol',
  ],
  MORGUE: [
    'morgue', 'the morgue', 'MORGUE', 'morge', 'morgues', 'mortuary', 'the mortuary', 'mortuarium', 'lijkenhuis',
    'het lijkenhuis', 'lijkenkamer', 'go to the morgue', 'morgue now', 'morgue?', 'in de morgue', 'morgue!!!',
    'meet at the morgue', 'is the key in the morgue', 'morgue, hurry', 'Morgue.', 'morgeu',
  ],
  GREENHOUSE: [
    'greenhouse', 'green house', 'Green-House', 'the greenhouse', 'grenhouse', 'greenhous', 'greenhouses', 'glasshouse',
    'broeikas', 'de broeikas', 'kas', 'de kas', 'kassen', 'in the greenhouse', 'GREENHOUSE NOW', 'meet in the green house',
    'greenhouse?', 'naar de kas', 'the greenhouse is dark', 'greanhouse', 'green house!!',
  ],
  VAULT: [
    'vault', 'the vault', 'VAULT', 'Vault!', 'vaults', 'valt', 'vaullt', 'kluis', 'de kluis', 'naar de kluis', 'open the vault',
    'vault code', 'the vault is open', 'meet at the vault', 'vault now', 'vault?', 'in the vault', 'vault, go', 'kluis open',
    'de kluis is open', 'VAULT DOOR',
  ],
  INFIRMARY: [
    'infirmary', 'the infirmary', 'INFIRMARY', 'infirmery', 'infirmar', 'infirmary room', 'sick bay', 'sickbay', 'the sick bay',
    'med bay', 'medbay', 'ziekenboeg', 'de ziekenboeg', 'ziekenzaal', 'go to infirmary', 'infirmary now', 'infirmary?',
    'meet in the infirmary', 'infirmary!', 'naar de ziekenboeg', 'infirmery pls',
  ],
  STORES: [
    'stores', 'the stores', 'store room', 'storeroom', 'the storeroom', 'storage', 'the storage room', 'stockroom',
    'stock room', 'magazijn', 'het magazijn', 'opslag', 'de opslag', 'stores now', 'STORES', 'meet at stores',
    'storeroom?', 'in the store room', 'storres', 'stoers', 'naar het magazijn',
  ],
};

test('>= 20 transcript variants per callsign resolve to that callsign (among all callsigns)', () => {
  for (const [cs, variants] of Object.entries(VARIANTS)) {
    assert.ok(variants.length >= 20, `${cs} has ${variants.length} variants`);
    const misses = variants.filter((v) => !findCallsigns(v, ALL).includes(cs));
    assert.deepEqual(misses, [], `${cs} missed`);
    const wrong = variants.filter((v) => findCallsigns(v, ALL).some((c) => c !== cs));
    assert.deepEqual(wrong, [], `${cs} cross-matched`);
  }
});

test('primary forms of every callsign are mutually unambiguous', () => {
  for (const cs of ALL) {
    for (const f of CALLSIGN_INFO[cs].forms) {
      const hits = findCallsigns(`ok ${f} now`, ALL);
      assert.deepEqual(hits, [cs], `form '${f}' of ${cs} -> ${hits}`);
    }
  }
  // whole-word distinctness: primary words differ by >= 2 edits; pairs at exactly 2 are 'confusable' and the
  // generator never puts both into one layout (validated per layout in validateLayout)
  const close: string[] = [];
  for (let i = 0; i < ALL.length; i++) for (let j = i + 1; j < ALL.length; j++) {
    const a = CALLSIGN_INFO[ALL[i]].forms[0].replace(/ /g, ''), b = CALLSIGN_INFO[ALL[j]].forms[0].replace(/ /g, '');
    assert.ok(editDistance(a, b) >= 2, `${a} ~ ${b}`);
    if (confusable(ALL[i], ALL[j])) close.push(`${ALL[i]}/${ALL[j]}`);
  }
  assert.deepEqual(close, ['LAUNDRY/FOUNDRY']);
});

test('common speech does not trigger callsigns (false-positive guard)', () => {
  const chatter = [
    'thanks man', 'thank you', 'my fault sorry', 'lock the door', 'look over there', 'what is that', 'i need a radio',
    'check your radio', 'get in the locker', 'hide in a locker', 'go back', 'come on', 'run run run', 'shut up',
    'it is so dark in here', 'open the door', 'the code is four seven two one', 'de code is vier zeven twee een',
    'wat is dat', 'kom op', 'ga terug', 'van de deur', 'ik ben bang', 'even wachten', 'over there', 'is it open',
    'later', 'water', 'cold', 'old room', 'mail', 'never mind', 'my power is low', 'i am so pumped',
  ];
  // RADIO / LOCKERS never appear in layouts (they're everyday words in play: walkies, hiding lockers)
  const inPlay = ALL.filter((c) => !DEFAULT_LEVEL_TUNING.avoidCallsigns.includes(c) || c === 'VAULT');
  for (const c of chatter) assert.deepEqual(findCallsigns(c, inPlay), [], `'${c}' -> ${findCallsigns(c, inPlay)}`);
});

test('mixed EN/NL sentences, several callsigns, order of mention', () => {
  assert.deepEqual(findCallsigns('eerst de kapel, then the cold room, dan naar de kluis', ALL), ['CHAPEL', 'COLDROOM', 'VAULT']);
  assert.deepEqual(findCallsigns('BOILER boiler boiler', ALL), ['BOILER']);
  assert.deepEqual(findCallsigns('back to the van guys', ALL), ['VAN']);
  assert.deepEqual(findCallsigns('terug naar het busje', ALL), ['VAN']);
  assert.deepEqual(findCallsigns('meet at the entrance', ALL), ['LOBBY']);
  assert.deepEqual(findCallsigns('the boiler', ['CHAPEL']), [], 'only candidates are matched');
  const hits = matchCallsigns('go to the cold room now', ALL);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].callsign, 'COLDROOM');
  assert.equal(hits[0].exact, true);
  assert.equal(matchCallsigns('kold room', ALL)[0]?.exact, false);
});

test('normalizer: case, punctuation, diacritics, EN + NL number words', () => {
  assert.equal(normalizeUtterance('  Hello,   WORLD!! '), 'hello world');
  assert.equal(normalizeUtterance("Warden's office"), 'wardens office');
  assert.equal(normalizeUtterance('één twee drie'), '1 2 3');
  assert.equal(normalizeUtterance('four seven two one'), '4 7 2 1');
  assert.equal(normalizeUtterance('vier zeven twee een'), '4 7 2 1');
  assert.equal(normalizeUtterance('forty seven twenty one'), '47 21');
  assert.equal(normalizeUtterance('zevenenveertig eenentwintig'), '47 21');
  assert.equal(normalizeUtterance('ga naar een kamer'), 'ga naar een kamer', '"een" stays an article');
  assert.equal(normalizeUtterance('that one over there'), 'that one over there', '"one" stays a pronoun');
  assert.equal(normalizeUtterance('code one two oh nine'), 'code 1 2 0 9');
  assert.deepEqual(extractDigitRuns('the code is four seven two one ok'), ['4721']);
  assert.deepEqual(extractDigitRuns('de code is vier zeven, twee een'), ['4721']);
  assert.deepEqual(extractDigitRuns('room 12 then 3'), ['12', '3']);
  assert.ok(withinOneEdit('boiler', 'boyler'));
  assert.ok(!withinOneEdit('boiler', 'bowler s'));
  assert.equal(editDistance('kitten', 'sitting'), 3);
});

test('hotwordsFor(layout) returns spoken forms of the layout callsigns', () => {
  const L = JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/layouts/facility_s2_p4.json'), 'utf8')) as LevelLayout;
  const hw = hotwordsFor(L);
  const names = L.spaces.map((s) => s.callsign).filter((c): c is string => !!c);
  assert.ok(names.includes('VAULT') && names.includes('LOBBY') && names.includes('VAN'));
  for (const n of names) assert.ok(hw.includes(CALLSIGN_INFO[n].forms[0]), `${n} hotword`);
  assert.ok(hw.length <= names.length * 2);
});
