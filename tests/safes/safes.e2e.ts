// Safes ws-bot test (server logic). Needs a dev server with the safes flag on (or SAFES_FORCE=1 + --dev):
//   PORT=3407 SAFES_FORCE=1 node apps/server/src/index.ts --dev   then   node tests/safes/safes.e2e.ts [port]
import { Bot } from '../interaction/bot.ts';

const port = Number(process.argv[2] ?? process.env.PORT ?? 3407);
const url = `ws://127.0.0.1:${port}/ws`;
const crew = `SAFE${Date.now() % 10000}`;
let fails = 0;
const ok = (cond: unknown, msg: string) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`);
  if (!cond) fails++;
};

interface Peek { safes: { id: string; x: number; z: number; face: [number, number]; combo: number[]; open: boolean; cracker: string | null; stage: number }[] }

const a = new Bot('Cracker');
const b = new Bot('Mate');
await a.connect(url, crew);
await b.connect(url, crew);
const gen = await a.dbg<{ seed: string }>('level.generate', { seed: 'safes-test-1', players: 2 });
await a.settle(300);
const L = a.full?.layout;
ok(L && L.kind === 'facility', `contract layout ${gen.seed}`);
const peek = await a.dbg<Peek>('safes.peek');
ok(peek.safes.length >= 1 && peek.safes.length <= 2, `placed ${peek.safes.length} safe(s)`);
const s = peek.safes[0]!;
if (L) {
  const sp = L.spaces[L.owner[Math.floor(s.z) * L.W + Math.floor(s.x)]!]!;
  const maxD = Math.max(...L.spaces.filter((x) => x.kind !== 'corridor' && x.kind !== 'outside').map((x) => x.dist));
  ok(sp && sp.kind !== 'corridor' && sp.dist >= maxD * 0.5, `safe in deep ${sp?.kind} ${sp?.type} (dist ${sp?.dist} / max ${maxD})`);
  const minItem = Math.min(...L.items.map((it) => Math.hypot(it.x - s.x, it.z - s.z)));
  // 1.2 m on roomy sites; crowded sites fall back to relaxed clearances (>= 0.55 x 1.2 m) rather than no safe at all
  ok(minItem >= 0.65, `clear of layout items (nearest ${minItem.toFixed(2)} m)`);
}
ok(s.combo.length === 3 && s.combo.every((c) => c >= 0 && c < 40), `combo shape ok`);
const list = await b.req<{ safes: { id: string; combo?: unknown }[] }>('safes.list', {});
ok(list.safes.length === peek.safes.length && list.safes.every((x) => x.combo === undefined), 'safes.list has no combination');

// stand in front of the safe and press E on it
const fx = s.x + s.face[0] * 0.9, fz = s.z + s.face[1] * 0.9;
const yaw = Math.atan2(-s.face[0], -s.face[1]);
await a.dbg('interaction.pose', { x: fx, z: fz, yaw });
await b.dbg('interaction.pose', { x: fx + s.face[0] * 0.6, z: fz + s.face[1] * 0.6, yaw });
await a.settle(200);
const use = await a.req<{ ok?: boolean; msg?: string }>('interaction.use', { id: s.id });
const open = await a.waitEvent('safes.open', () => true, 3000).catch(() => null);
ok(open && (open.d as { id: string }).id === s.id, `E opens the dial (${JSON.stringify(use)})`);
const busy = await b.req<{ ok?: boolean; msg?: string }>('interaction.use', { id: s.id });
ok(!busy.ok && /working this safe/.test(String(busy.msg ?? '')), `second player is turned away (${JSON.stringify(busy)})`);
const steal = await b.req<{ click: boolean; closed?: boolean }>('safes.dial', { id: s.id, pos: s.combo[0] });
ok(steal.closed === true && steal.click === false, 'non-cracker cannot probe the dial');

// sweep 0 -> combo[0] one step at a time: exactly one click, at the right number
const n = 40;
const clicksAt: number[] = [];
const sweep = async (from: number, to: number) => {
  let p = from;
  const dir = ((to - from + n) % n) <= n / 2 ? 1 : -1;
  while (p !== to) {
    p = (p + dir + n) % n;
    const r = await a.req<{ click: boolean }>('safes.dial', { id: s.id, pos: p });
    if (r.click) clicksAt.push(p);
  }
};
await sweep(0, s.combo[0]!);
ok(clicksAt.length === 1 && clicksAt[0] === s.combo[0], `click only at the first number (${clicksAt.join(',')})`);
// fast jump across the number in one update still clicks
clicksAt.length = 0;
const back = (s.combo[0]! - 5 + n) % n;
await a.req('safes.dial', { id: s.id, pos: back });
const jump = await a.req<{ click: boolean }>('safes.dial', { id: s.id, pos: (s.combo[0]! + 3) % n });
ok(jump.click, 'a fast turn across the number clicks');

// wrong confirm: clunk event to the crew (teammate hears it) + reset
b.clearEvents();
const wrong = await a.req<{ ok: boolean; stage: number }>('safes.confirm', { id: s.id, pos: (s.combo[0]! + 3) % n });
ok(!wrong.ok && wrong.stage === 0, 'wrong number resets');
const clunk = await b.waitEvent('safes.fx', (d: { fx: string }) => d.fx === 'clunk', 2000).catch(() => null);
ok(!!clunk, 'teammate gets the clunk fx');

// right numbers
let r1 = await a.req<{ ok: boolean; stage: number; open: boolean; value?: number; name?: string }>('safes.confirm', { id: s.id, pos: s.combo[0] });
ok(r1.ok && r1.stage === 1, 'first number holds');
r1 = await a.req('safes.confirm', { id: s.id, pos: s.combo[1] });
ok(r1.ok && r1.stage === 2, 'second number holds');
r1 = await a.req('safes.confirm', { id: s.id, pos: s.combo[2] });
ok(r1.ok && r1.open && (r1.value ?? 0) >= 120 && (r1.value ?? 0) <= 200, `third number opens (${r1.value} scrip, ${r1.name})`);
await a.settle(200);
const items = Object.values((a.ix as unknown as { items: Record<string, { type: string; value?: number; name?: string; where?: string; owner?: string }> }).items ?? {});
const loot = items.find((it) => it.name === 'Company bearer bonds');
ok(!!loot && loot.value === r1.value, `reward item exists (${JSON.stringify(loot)})`);
const again = await a.req<{ ok?: boolean; msg?: string }>('interaction.use', { id: s.id });
ok(!again.ok, `opened safe is empty (${JSON.stringify(again)})`);
const after = await a.req<{ safes: { id: string; open: boolean }[] }>('safes.list', {});
ok(after.safes.find((x) => x.id === s.id)?.open === true, 'safes.list shows it open');

a.close();
b.close();
console.log(fails ? `FAILED (${fails})` : 'ALL PASS');
process.exit(fails ? 1 : 0);
