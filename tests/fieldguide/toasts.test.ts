// Owner: fieldguide (v1.2). Unit test for apps/client/src/fieldguide/toasts.ts (no browser): our toasts never sit over
// the booklet or the reader (gate R), they are held while a sheet is open and shown when it closes, the reader's own
// page gets none, other packages' toasts are never touched.   node --test tests/fieldguide/toasts.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signal } from '@preact/signals';
import type { Toast } from '../../apps/client/src/core/ui/api.ts';
import { fgToasts } from '../../apps/client/src/fieldguide/toasts.ts';

const BOOK = 'fieldguide', READER = 'fieldguide-bulletin';

/** the core ui's toast lane + screen router, as apps/client/src/core/ui/api.ts implements them */
function fakeUi() {
  const screen = signal<{ name: string; props: Record<string, unknown> }>({ name: 'none', props: {} });
  const toasts = signal<Toast[]>([]);
  let id = 1;
  return {
    screen, toasts,
    toast(text: string, kind: Toast['kind'] = 'info', ms = 3500) {
      const t: Toast = { id: id++, text, kind };
      toasts.value = [...toasts.value.slice(-4), t];
      setTimeout(() => { toasts.value = toasts.value.filter((x) => x !== t); }, ms).unref();
    },
    setScreen(name: string, props: Record<string, unknown> = {}) { screen.value = { name, props }; },
    texts: () => toasts.value.map((t) => t.text),
  };
}
function setup(o: { ms?: number; flushMax?: number; canFlush?: () => boolean } = {}) {
  const ui = fakeUi();
  const fg = fgToasts(ui, { sheets: [BOOK, READER], reader: READER, ms: o.ms ?? 60_000, flushMax: o.flushMax ?? 3, canFlush: o.canFlush ?? (() => true) });
  return { ui, fg };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('shown right away while no sheet is open', () => {
  const { ui, fg } = setup();
  fg.announce('hound:NEW ENTRY: THE HOUND', 'NEW ENTRY: THE HOUND  [J]');
  assert.deepEqual(ui.texts(), ['NEW ENTRY: THE HOUND  [J]']);
  assert.deepEqual(fg.peek(), { held: [], up: ['NEW ENTRY: THE HOUND  [J]'] });
  fg.dispose();
});

test('opening the booklet takes ours down and leaves other toasts alone (the gate R a60 case)', () => {
  const { ui, fg } = setup();
  ui.toast('Ann joined the crew');
  fg.announce('hound:NEW ENTRY: THE HOUND', 'NEW ENTRY: THE HOUND  [J]');
  fg.announce('listener:NEW ENTRY: THE LISTENER', 'NEW ENTRY: THE LISTENER  [J]');
  fg.announce('page:hound.1', 'FIELD GUIDE · PAGE FILED: THE HOUND 1/5  [J]');
  fg.announce('anomaly:NEW ENTRY: COLD SPOT', 'NEW ENTRY: COLD SPOT  [J]');
  assert.equal(ui.texts().length, 5);
  ui.setScreen(BOOK);
  assert.deepEqual(ui.texts(), ['Ann joined the crew']);
  assert.deepEqual(fg.peek().up, []);
  fg.dispose();
});

test('held while the booklet is open (one per key), shown in order when it closes', () => {
  const { ui, fg } = setup();
  ui.setScreen(BOOK);
  fg.announce('anomaly:NEW ENTRY: A RINGING PHONE', 'NEW ENTRY: A RINGING PHONE  [J]');
  fg.announce('mannequin:NEW ENTRY: THE MANNEQUIN', 'NEW ENTRY: THE MANNEQUIN  [J]');
  fg.announce('anomaly:NEW ENTRY: A RINGING PHONE', 'NEW ENTRY: A RINGING PHONE  [J]');
  assert.deepEqual(ui.texts(), []);
  assert.deepEqual(fg.peek().held, ['NEW ENTRY: THE MANNEQUIN  [J]', 'NEW ENTRY: A RINGING PHONE  [J]']);
  ui.setScreen('none');
  assert.deepEqual(ui.texts(), ['NEW ENTRY: THE MANNEQUIN  [J]', 'NEW ENTRY: A RINGING PHONE  [J]']);
  assert.deepEqual(fg.peek(), { held: [], up: ['NEW ENTRY: THE MANNEQUIN  [J]', 'NEW ENTRY: A RINGING PHONE  [J]'] });
  fg.dispose();
});

test("the reader's own page gets no toast, whether it was up or held", () => {
  const { ui, fg } = setup();
  // a bulletin read: the server sends 'fieldguide.filed' first, then 'fieldguide.read' opens the reader
  fg.announce('page:listener.1', 'FIELD GUIDE · PAGE FILED: THE LISTENER 1/6  [J]');
  ui.setScreen(READER, { pageId: 'listener.1', filed: true });
  assert.deepEqual(ui.texts(), []);
  ui.setScreen('none');
  assert.deepEqual(ui.texts(), []);
  // filed while the booklet is open, then the reader opens on that page straight from the booklet
  ui.setScreen(BOOK);
  fg.announce('page:hound.3', 'FIELD GUIDE · PAGE FILED: THE HOUND 2/5  [J]');
  fg.announce('anomaly:NEW ENTRY: KNOCKING', 'NEW ENTRY: KNOCKING  [J]');
  ui.setScreen(READER, { pageId: 'hound.3' });
  assert.deepEqual(fg.peek().held, ['NEW ENTRY: KNOCKING  [J]']);
  ui.setScreen('none');
  assert.deepEqual(ui.texts(), ['NEW ENTRY: KNOCKING  [J]']);
  fg.dispose();
});

test('booklet -> reader -> booklet keeps holding; nothing flashes up between two sheets', () => {
  const { ui, fg } = setup();
  ui.setScreen(BOOK);
  fg.announce('snatcher:NEW ENTRY: THE SNATCHER', 'NEW ENTRY: THE SNATCHER  [J]');
  ui.setScreen(READER, { pageId: 'hound.2' });
  assert.deepEqual(ui.texts(), []);
  ui.setScreen(BOOK, { tab: 'hound' });
  assert.deepEqual(ui.texts(), []);
  assert.equal(fg.peek().held.length, 1);
  ui.setScreen('none');
  assert.deepEqual(ui.texts(), ['NEW ENTRY: THE SNATCHER  [J]']);
  fg.dispose();
});

test('more than flushMax held: the newest ones plus one summary, never a tall stack', () => {
  const { ui, fg } = setup({ flushMax: 3 });
  ui.setScreen(BOOK);
  for (const k of ['A', 'B', 'C', 'D', 'E']) fg.announce(`anomaly:${k}`, `NEW ENTRY: ${k}  [J]`);
  ui.setScreen('none');
  assert.deepEqual(ui.texts(), ['FIELD GUIDE · 3 MORE NEW ENTRIES  [J]', 'NEW ENTRY: D  [J]', 'NEW ENTRY: E  [J]']);
  fg.dispose();
});

test('held ones are dropped when the sheet closes because the van left (drive / results)', () => {
  let phase = 'contract';
  const { ui, fg } = setup({ canFlush: () => phase === 'hub' || phase === 'contract' });
  ui.setScreen(BOOK);
  fg.announce('anomaly:NEW ENTRY: BROWNOUT', 'NEW ENTRY: BROWNOUT  [J]');
  phase = 'drive';
  ui.setScreen('none');
  assert.deepEqual(ui.texts(), []);
  assert.deepEqual(fg.peek(), { held: [], up: [] });
  fg.dispose();
});

test('other screens (pause menu, workbench) do not hold or take down our toasts', () => {
  const { ui, fg } = setup();
  fg.announce('hound:NEW ENTRY: THE HOUND', 'NEW ENTRY: THE HOUND  [J]');
  ui.setScreen('menu');
  fg.announce('page:hound.1', 'FIELD GUIDE · PAGE FILED: THE HOUND 1/5  [J]');
  assert.deepEqual(ui.texts(), ['NEW ENTRY: THE HOUND  [J]', 'FIELD GUIDE · PAGE FILED: THE HOUND 1/5  [J]']);
  ui.setScreen('none');
  assert.equal(ui.texts().length, 2);
  fg.dispose();
});

test('toasts that expire on their own are forgotten; dispose stops reacting to screens', async () => {
  const { ui, fg } = setup({ ms: 20 });
  fg.announce('hound:NEW ENTRY: THE HOUND', 'NEW ENTRY: THE HOUND  [J]');
  assert.equal(fg.peek().up.length, 1);
  await sleep(50);
  assert.deepEqual(ui.texts(), []);
  assert.deepEqual(fg.peek().up, []);
  fg.dispose();
  fg.announce('listener:NEW ENTRY: THE LISTENER', 'NEW ENTRY: THE LISTENER  [J]');
  ui.setScreen(BOOK);
  assert.deepEqual(ui.texts(), ['NEW ENTRY: THE LISTENER  [J]']); // no longer taken down after dispose
});
