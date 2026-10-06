// Owner: track (a) Objectives. Clue notes: work-order notes (template or AI, with placeholders) are resolved here
// with the real secrets and placed into the layout's note slots. Two notes always carry the vault code halves.
// Placeholders: {{CODE}} {{CODE_A}} {{CODE_B}} {{CODE_1}}..{{CODE_4}} {{LEVER_A}} {{LEVER_B}} {{VAULT}} {{CORE_ROOM}}
//               {{KEYPAD_ROOM}} {{ROOM_1}}..{{ROOM_6}} {{SITE}} {{VAN_TIME}}
import type { LevelLayout, LayoutItem, LayoutSpace } from '@dead-air/shared/layout.ts';
import type { ClueNote } from '@dead-air/shared/workorder.ts';
import type { ObjNote } from '@dead-air/shared/messages/objectives.ts';
import { makeRng } from '@dead-air/shared/rng.ts';

const DIGIT_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

const CODE_A_TEMPLATES: ClueNote[] = [
  { title: 'Facilities memo', body: 'To all night staff:\n\nThe vault keypad was reset after the incident. The first two digits are {{CODE_A}}.\nThe rest of the code is with the other shift lead.\n\nDo not write codes on walls.\n\n- R. Hale, Facilities' },
  { title: 'Torn notebook page', body: 'vault code changed AGAIN.\nstarts with {{CODE_A}}\n\nask Dee for the end of it. she wrote it near {{ROOM_2}} i think' },
];
const CODE_B_TEMPLATES: ClueNote[] = [
  { title: 'Sticky note', body: '...and it ENDS in {{CODE_B}}.\n\nDon\'t tell Hale I wrote this down.\n-Dee' },
  { title: 'Shift handover', body: 'Handover, 02:10:\n- breakers tripped again\n- vault code, second half: {{CODE_B}}\n- something keeps answering the intercom. Ignore it.' },
];
const FLAVOUR: ClueNote[] = [
  { title: 'BREAKER PROCEDURE', body: 'Vault wing power is restored by throwing BOTH breakers ({{LEVER_A}} and {{LEVER_B}}) within ONE SECOND of each other.\n\nA single throw trips the alarm. Bring a colleague.\nThe Company does not provide colleagues.' },
  { title: 'Kennel log', body: 'Dog is blind. Does not care about whispers or tiptoeing.\nTalk near it and it turns. Shout and it RUNS.\nThrow something. Anything. Then be quiet.' },
  { title: 'Incident report #44', body: 'Employee reported "a voice" repeating room names back over the radio.\nEmployee said {{ROOM_1}} on channel 2 and was later found in {{ROOM_1}}.\n\nRecommendation: stop saying where you are.' },
  { title: 'Company notice', body: 'The van departs at {{VAN_TIME}} SHARP.\nStaff not inside the vehicle are considered to have resigned.\n\nThank you for choosing night shift.' },
  { title: 'Core handling', body: 'The Core is a TWO-PERSON lift. One handle each.\nDropping it voids 15% of its value and the warranty.\nIt hums. That is normal. Probably.' },
  { title: 'Note to self', body: 'if you hear me on the radio\nand I sound wrong\nit is not me' },
];

export interface NoteInputs {
  layout: LevelLayout;
  code: string;
  seedKey: string;
  siteName?: string;
  orderNotes?: ClueNote[];
}

function callsignNear(L: LevelLayout, spaceId: number): string {
  const s = L.spaces[spaceId];
  if (s?.callsign) return s.callsign;
  // corridor: name a neighbouring room through a door
  for (const d of L.doors) {
    const other = d.a === spaceId ? d.b : d.b === spaceId ? d.a : -2;
    if (other >= 0 && L.spaces[other]?.callsign) return `the corridor by ${L.spaces[other].callsign}`;
  }
  return 'the corridor';
}

export function resolveNotes(inp: NoteInputs): ObjNote[] {
  const L = inp.layout;
  const rng = makeRng(inp.seedKey, 'objectives.notes');
  const slots = L.items.filter((i) => i.kind === 'note').sort((a, b) => Number(a.data?.idx ?? 0) - Number(b.data?.idx ?? 0));
  if (!slots.length) return [];
  const code = inp.code;
  const d = code.split('').map(Number);
  const levers = L.items.filter((i) => i.kind === 'lever');
  const keypad = L.items.find((i) => i.kind === 'keypad');
  const vault = L.spaces.find((s) => s.kind === 'vault');
  const named = rng.shuffle(L.spaces.filter((s: LayoutSpace) => !!s.callsign && s.kind !== 'vault' && s.type !== 'van').map((s) => s.callsign as string));
  const vars: Record<string, string> = {
    CODE: code,
    CODE_A: `${d[0]} and ${d[1]}`,
    CODE_B: `${d[2]} and ${d[3]}`,
    CODE_1: String(d[0]), CODE_2: String(d[1]), CODE_3: String(d[2]), CODE_4: String(d[3]),
    CODE_A_WORDS: `${DIGIT_WORDS[d[0]]}, ${DIGIT_WORDS[d[1]]}`,
    CODE_B_WORDS: `${DIGIT_WORDS[d[2]]}, ${DIGIT_WORDS[d[3]]}`,
    LEVER_A: levers[0] ? callsignNear(L, levers[0].space) : 'the east wing',
    LEVER_B: levers[1] ? callsignNear(L, levers[1].space) : 'the west wing',
    VAULT: vault?.callsign ?? 'VAULT',
    CORE_ROOM: vault?.callsign ?? 'VAULT',
    KEYPAD_ROOM: keypad ? callsignNear(L, keypad.space) : 'the vault door',
    SITE: inp.siteName ?? 'the site',
    VAN_TIME: '04:00',
  };
  for (let i = 1; i <= 6; i++) vars[`ROOM_${i}`] = named[(i - 1) % Math.max(1, named.length)] ?? 'STORAGE';
  const fill = (s: string) => s.replace(/\{\{\s*([A-Z0-9_]+)\s*\}\}/g, (_m, k: string) => vars[k] ?? '???');

  const order = (inp.orderNotes ?? []).filter((n) => n && typeof n.body === 'string');
  const has = (n: ClueNote, k: string) => n.body.includes(`{{${k}}}`) || n.title.includes(`{{${k}}}`);
  let noteA = order.find((n) => has(n, 'CODE_A') || has(n, 'CODE_A_WORDS'));
  let noteB = order.find((n) => n !== noteA && (has(n, 'CODE_B') || has(n, 'CODE_B_WORDS')));
  const full = order.find((n) => has(n, 'CODE'));
  const rest = order.filter((n) => n !== noteA && n !== noteB && n !== full);
  noteA ??= rng.pick(CODE_A_TEMPLATES);
  noteB ??= rng.pick(CODE_B_TEMPLATES);

  // slots for the halves: A = the slot nearest the entrance (by space dist), B = the slot farthest from A
  const distOf = (it: LayoutItem) => L.spaces[it.space]?.dist ?? 0;
  const byDist = slots.slice().sort((a, b) => distOf(a) - distOf(b));
  const slotA = byDist[0];
  let slotB = slots.length > 1 ? slots[0] : null;
  let best = -1;
  for (const s of slots) {
    if (s === slotA) continue;
    const dd = Math.hypot(s.x - slotA.x, s.z - slotA.z) + Math.abs(distOf(s) - distOf(slotA)) * 0.5;
    if (dd > best) { best = dd; slotB = s; }
  }
  const out: ObjNote[] = [];
  const mk = (slot: LayoutItem, n: ClueNote, half?: 'A' | 'B'): ObjNote => ({
    id: slot.id,
    title: fill(n.title).slice(0, 80),
    body: fill(n.body).slice(0, 900),
    p: [slot.x, slot.y ?? 1.45, slot.z],
    rot: slot.rot ?? 0,
    space: slot.space,
    ...(half ? { codeHalf: half } : {}),
  });
  out.push(mk(slotA, noteA, 'A'));
  if (slotB) out.push(mk(slotB, noteB, 'B'));
  const flavour = rng.shuffle(FLAVOUR.slice());
  const extra = [...rest, ...flavour];
  for (const s of slots) {
    if (s === slotA || s === slotB) continue;
    const n = extra.shift();
    if (!n) break;
    out.push(mk(s, n));
  }
  return out;
}

/** 4-digit code; no digit repeated 3+ times, never 0000-style patterns. */
export function makeCode(seedKey: string): string {
  const rng = makeRng(seedKey, 'objectives.code');
  for (;;) {
    const d = [rng.int(0, 9), rng.int(0, 9), rng.int(0, 9), rng.int(0, 9)];
    const counts = new Map<number, number>();
    for (const x of d) counts.set(x, (counts.get(x) ?? 0) + 1);
    if ([...counts.values()].some((c) => c >= 3)) continue;
    const s = d.join('');
    if (s === '1234' || s === '4321') continue;
    return s;
  }
}
