// v1.3 SIGNAL look: the bodycam OSD's text and when it shows (render/osd.ts).
//   node --test tests/render/osd.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { battBars, osdStamp, osdVisible, sigBars } from '../../apps/client/src/render/osd.ts';

test('OSD text: camcorder timestamp, battery cells, signal bars', () => {
  assert.equal(osdStamp(new Date(2026, 9, 9, 2, 13, 44)), 'OCT 09  02:13:44');
  assert.equal(battBars(1), '▮▮▮▮');
  assert.equal(battBars(0.5), '▮▮▯▯');
  assert.equal(battBars(0.1), '▮▯▯▯');
  assert.equal(battBars(0), '▯▯▯▯');
  assert.equal(battBars(null), '▯▯▯▯');
  assert.equal(sigBars(20), '▂▄▆█');
  assert.equal(sigBars(90), '▂▄▆_');
  assert.equal(sigBars(180), '▂▄__');
  assert.equal(sigBars(900), '▂___');
  assert.equal(sigBars(null), '____');
});

test('OSD shows on the job only: the contract with the game view up (never the van, the menus or the drive)', () => {
  // osdVisible(signal, cover mode, world phase, ui screen, title backdrop / still up)
  assert.equal(osdVisible(true, 'game', 'contract', 'none', false), true, 'a contract, nothing over the view');
  // the van: the HUD's CREW panel sits in the same top-left corner (verify r2, l3-hub-signal)
  assert.equal(osdVisible(true, 'game', 'hub', 'none', false), false, 'the van (hub)');
  assert.equal(osdVisible(true, 'game', 'hub', 'board', false), false, 'the van, work order board');
  // the drive (its opaque screen holds the canvas) and the results
  assert.equal(osdVisible(true, 'hold', 'drive', 'drive', false), false, 'the drive screen');
  assert.equal(osdVisible(true, 'game', 'drive', 'none', false), false, 'the drive phase, no screen');
  assert.equal(osdVisible(true, 'game', 'results', 'results', false), false, 'the results');
  // menus: the title (backdrop / still, join screen) and any screen over a contract
  assert.equal(osdVisible(true, 'menu', 'hub', 'join', true), false, 'the title menu');
  assert.equal(osdVisible(true, 'menu', 'contract', 'join', false), false, 'left the crew mid-contract: the title');
  assert.equal(osdVisible(true, 'game', 'contract', 'menu', false), false, 'the Esc menu in a contract');
  assert.equal(osdVisible(true, 'game', 'contract', 'obj-note', false), false, 'a note over the view');
  // covered / hidden views and SIGNAL inactive (off, or a preset other than Lite / Low)
  assert.equal(osdVisible(true, 'cover', 'contract', 'none', false), false, 'the arrival loading cover');
  assert.equal(osdVisible(true, 'hidden', 'contract', 'none', false), false, 'a hidden tab');
  assert.equal(osdVisible(true, 'game', 'contract', 'none', true), false, 'the title backdrop still up');
  assert.equal(osdVisible(false, 'game', 'contract', 'none', false), false, 'SIGNAL inactive');
});
