// Owner: fieldguide (v1.2). Pure logic: presence rules, bulletin placement, monster/page choice, the private view.
//   node --test tests/fieldguide/logic.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeRng } from '../../packages/shared/src/rng.ts';
import { emptyFieldGuide } from '../../packages/shared/src/progress.ts';
import type { FieldGuideSave } from '../../packages/shared/src/progress.ts';
import type { LayoutSpace } from '../../packages/shared/src/layout.ts';
import {
  assignMonsters, buildView, choosePage, clockText, filePage, levelOf, nextMissing, pickBulletinSpots, pickPageContainers, presentMonsters,
  recordContact, sanitize,
} from '../../apps/server/src/fieldguide/logic.ts';
import type { SpotLike } from '../../apps/server/src/fieldguide/logic.ts';
import { PAGES, pageIdsOf } from '../../apps/server/src/fieldguide/content.ts';

const balance = { monsters: { mannequin: { minRisk: 2, minContractIndex: 2 }, snatcher: { minRisk: 2, minContractIndex: 1 }, listener: { grabAloneM: 6, sightLitM: 6, sightDarkM: 3, grabSec: 5, shoveRangeM: 3 } } };

test('presence follows the monsters runtime rules', () => {
  const p = (risk: number, contractIndex: number, hasVents = true, flags = { mannequin: true, snatcher: true }) =>
    presentMonsters({ risk, contractIndex, hasVents, ...flags, balance });
  assert.deepEqual(p(1, 0), ['hound', 'listener']);
  assert.deepEqual(p(1, 1), ['hound', 'listener', 'snatcher']);
  assert.deepEqual(p(1, 1, false), ['hound', 'listener'], 'no vents, no Snatcher');
  assert.deepEqual(p(1, 2), ['hound', 'listener', 'mannequin', 'snatcher']);
  assert.deepEqual(p(2, 0), ['hound', 'listener', 'mannequin', 'snatcher']);
  assert.deepEqual(p(3, 0, true, { mannequin: false, snatcher: false }), ['hound', 'listener'], 'flags off');
});

// a toy facility: lobby (entrance) + 8 rooms at increasing distance, 2 spots per room, 2 drawer spots
function toy(): { L: { spaces: LayoutSpace[]; entrance: number }; spots: SpotLike[] } {
  const spaces: LayoutSpace[] = [];
  const spots: SpotLike[] = [];
  for (let i = 0; i < 9; i++) {
    spaces.push({ id: i, kind: 'room', rect: { x: i * 10, y: 0, w: 8, h: 8 }, zone: 0, type: i === 0 ? 'lobby' : 'office', callsign: `R${i}`, dist: i * 10, light: 'on', open: false, powerZone: 0 });
    for (let k = 0; k < 2; k++) spots.push({ id: `prop:${i * 10 + k}`, style: 'board', space: i, roomType: i === 0 ? 'lobby' : 'office', x: i * 10 + 2 + k * 3, z: 1 });
  }
  spots.push({ id: 'prop:900', style: 'drawer', space: 8, roomType: 'office', x: 84, z: 4 }, { id: 'prop:901', style: 'drawer', space: 7, roomType: 'office', x: 74, z: 4 });
  return { L: { spaces, entrance: 0 }, spots };
}

test('bulletins: deterministic, one per room, never the lobby or a drawer, deep first', () => {
  const { L, spots } = toy();
  const a = pickBulletinSpots(L, spots, makeRng('s1|FGCR', 'fieldguide.bulletins'), 4, 0.35);
  const b = pickBulletinSpots(L, spots, makeRng('s1|FGCR', 'fieldguide.bulletins'), 4, 0.35);
  assert.deepEqual(a.map((s) => s.id), b.map((s) => s.id), 'same seed + crew -> same spots');
  assert.equal(a.length, 4);
  assert.equal(new Set(a.map((s) => s.space)).size, 4, 'at most one per room');
  assert.ok(a.every((s) => s.space !== 0 && s.style !== 'drawer'), 'never the lobby, never a drawer');
  assert.ok(a.every((s) => s.space >= 3), `all at >= 0.35 of max depth (80 m -> 28 m): ${a.map((s) => s.space)}`);
  assert.ok([6, 7, 8].includes(a[0]!.space), 'the first pick is one of the deepest rooms');
  const other = pickBulletinSpots(L, spots, makeRng('s1|ZZZZ', 'fieldguide.bulletins'), 4, 0.35);
  assert.ok(other.every((s) => s.space >= 3 && s.space !== 0));
  // too few deep rooms: the depth rule relaxes, the room and lobby rules never do
  const six = pickBulletinSpots(L, spots, makeRng('s2|FGCR', 'fieldguide.bulletins'), 8, 0.9);
  assert.equal(six.length, 8, 'relaxed depth fills from shallower rooms');
  assert.equal(new Set(six.map((s) => s.space)).size, 8);
  assert.ok(six.every((s) => s.space !== 0));
  assert.deepEqual(pickBulletinSpots(L, [], makeRng('x', 'y'), 3, 0.35), []);
});

test('drawer page containers: drawer spots, one per room, lobby never', () => {
  const { L, spots } = toy();
  const drawers = spots.filter((s) => s.style === 'drawer');
  const c = pickPageContainers(L, drawers, makeRng('s1|FGCR', 'fieldguide.pages'), 2);
  assert.equal(c.length, 2);
  assert.equal(new Set(c.map((s) => s.space)).size, 2);
  const lobbyOnly = pickPageContainers(L, [{ id: 'prop:1', style: 'drawer', space: 0, roomType: 'lobby', x: 1, z: 1 }], makeRng('a', 'b'), 2);
  assert.equal(lobbyOnly.length, 0);
});

const save = (pages: string[] = []): FieldGuideSave => ({ ...emptyFieldGuide(), pages: [...pages] });

test('assignMonsters prefers the monster the crew owns least, then spreads', () => {
  const rng = () => makeRng('seed|CREW', 'fieldguide.assign');
  const none = assignMonsters(['hound', 'listener'], [save(), save()], 4, rng());
  assert.equal(none.filter((m) => m === 'hound').length, 2, `spread over both: ${none}`);
  const houndDone = save(pageIdsOf('hound'));
  const got = assignMonsters(['hound', 'listener', 'mannequin'], [houndDone, houndDone], 3, rng());
  assert.ok(!got.includes('hound'), `hound fully owned -> never picked: ${got}`);
  assert.deepEqual(assignMonsters(['hound'], [], 2, rng()), ['hound', 'hound']);
  assert.deepEqual(assignMonsters([], [save()], 2, rng()), []);
});

test('choosePage: least-owned page of the least-owned monster, skipping used pages', () => {
  const a = save(['hound.1', 'hound.2', 'listener.1']);
  const b = save(['hound.1']);
  const p = choosePage(['hound', 'listener'], [a, b], new Set(), makeRng('x', 'fieldguide.pages'));
  assert.ok(p === 'listener.2' || p === 'listener.3', `listener (less owned), an unowned page: ${p}`);
  const q = choosePage(['hound'], [a, b], new Set(['hound.3']), makeRng('x', 'fieldguide.pages'));
  assert.equal(q, 'hound.4');
  assert.equal(choosePage(['hound'], [save()], new Set(pageIdsOf('hound')), makeRng('x', 'y')), null);
});

test('contact, levels and page filing', () => {
  const s = save();
  assert.equal(levelOf(s.monsters.hound), 0);
  assert.equal(recordContact(s, 'hound', 'heard', '23:41', 'Halvorsen Cold Storage'), true);
  assert.equal(recordContact(s, 'hound', 'seen', '23:50', 'Elsewhere'), false, 'first contact is filed once');
  assert.deepEqual(s.monsters.hound!.first, { at: '23:41', site: 'Halvorsen Cold Storage', how: 'heard' });
  assert.equal(levelOf(s.monsters.hound), 1);
  s.monsters.hound!.seen = 1;
  assert.equal(levelOf(s.monsters.hound), 2);
  assert.equal(levelOf({ heard: 0, seen: 0, deaths: 0, escapes: 1 }), 2, 'an escape means it was face to face');
  assert.equal(nextMissing(s, 'hound'), 'hound.1');
  assert.equal(filePage(s, 'hound.1'), true);
  assert.equal(filePage(s, 'hound.1'), false);
  assert.equal(filePage(s, 'nope.9'), false);
  assert.equal(nextMissing(s, 'hound'), 'hound.2');
});

test('view: page text only for owned pages, card only once seen, sounds once heard', () => {
  const s = save(['listener.2']);
  recordContact(s, 'hound', 'heard', '22:10', 'THE LOT');
  s.monsters.hound!.heard = 1;
  const v = buildView(s, { balance, v12: true });
  const hound = v.monsters.find((m) => m.kind === 'hound')!;
  const listener = v.monsters.find((m) => m.kind === 'listener')!;
  const mann = v.monsters.find((m) => m.kind === 'mannequin')!;
  assert.equal(hound.level, 1);
  assert.equal(hound.name, 'THE HOUND');
  assert.equal(hound.card.length, 0, 'no card while only heard');
  assert.ok((hound.sounds?.length ?? 0) > 0, 'heard-only shows its sounds');
  assert.equal(listener.level, 0);
  assert.equal(listener.name, 'THE LISTENER', 'a filed page reveals the name');
  assert.deepEqual(listener.pages.map((p) => p.id), ['listener.2']);
  assert.equal(mann.name, '???');
  assert.equal(mann.pages.length, 0);
  assert.equal(v.pagesFound, 1);
  assert.equal(v.pagesTotal, PAGES.length);
  const json = JSON.stringify(v);
  for (const p of PAGES) if (p.id !== 'listener.2') assert.ok(!json.includes(p.title), `unowned page title ${p.id} never sent`);
  s.monsters.hound!.seen = 1;
  const v2 = buildView(s, { balance, v12: true });
  assert.equal(v2.monsters[0]!.card.length, 3);
  assert.ok(!JSON.stringify(v2).includes('{{'), 'placeholders filled');
});

test('Listener copy follows listenerFairV12', () => {
  const s = save(['listener.2', 'listener.5']);
  s.monsters.listener = { heard: 1, seen: 1, deaths: 0, escapes: 0 };
  const on = buildView(s, { balance, v12: true }).monsters.find((m) => m.kind === 'listener')!;
  const off = buildView(s, { balance, v12: false }).monsters.find((m) => m.kind === 'listener')!;
  assert.equal(on.pages[0]!.title, 'IT LOOKS BEFORE IT HUNTS');
  assert.equal(off.pages[0]!.title, 'IT SEES FURTHER IN THE LIGHT');
  assert.ok(/knocks you down/.test(on.pages[1]!.text) && !/knocks you down/.test(off.pages[1]!.text), 'knockdown only with the flag on');
  assert.ok(on.card.join(' ').includes('Sprint') && !off.card.join(' ').includes('Sprint'));
});

test('sanitize repairs whatever a save file holds', () => {
  assert.deepEqual(sanitize(null), emptyFieldGuide());
  const s = sanitize({ v: 0, monsters: { hound: { heard: '3', seen: 2.7, deaths: -1 }, dragon: { heard: 1 } }, pages: ['hound.1', 'hound.1', 'x.1', 5], anomalies: { cold_spot: 2, knock: 'a' } });
  assert.equal(s.v, 1);
  assert.deepEqual(Object.keys(s.monsters), ['hound']);
  assert.deepEqual(s.monsters.hound, { heard: 0, seen: 2, deaths: 0, escapes: 0 });
  assert.deepEqual(s.pages, ['hound.1']);
  assert.deepEqual(s.anomalies, { cold_spot: 2 });
});

test('clock text', () => {
  assert.equal(clockText(0), '22:00');
  assert.equal(clockText(101), '23:41');
  assert.equal(clockText(359.6), '04:00');
});
