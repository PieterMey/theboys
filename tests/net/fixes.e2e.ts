// Track ① Net (playtest fixes): ghost voice after a drop, stale 'loud', held-slot capacity, deliberate leave,
// /voicetest observer, van rear-door voice path. Needs a dev server: PORT=3402 node ... apps/server/src/index.ts --dev
//   node tests/net/fixes.e2e.ts            (BASE_URL defaults to http://127.0.0.1:3402)
import { Bot } from './bot.ts';

const base = (process.env.BASE_URL ?? `http://127.0.0.1:${process.env.PORT ?? 3402}`).replace(/\/$/, '');
const url = base.replace(/^http/, 'ws') + '/ws';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tag = Math.random().toString(36).slice(2, 5).toUpperCase();
let fails = 0;
const check = (ok: boolean, what: string, extra?: unknown) => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${what}${extra !== undefined ? ' ' + JSON.stringify(extra) : ''}`);
};
interface DbgPlayer { id: string; name: string; connected: boolean; alive: boolean; isLeader: boolean; band: number; radio: number }
const state = async (b: Bot) => (await b.req<{ players: DbgPlayer[] }>('dbg.state')).players;

async function ghostVoice(): Promise<void> {
  const crew = 'G' + tag;
  const a = new Bot({ url, name: 'LoudX', crew });
  const b = new Bot({ url, name: 'QuietY', crew });
  await a.connect();
  await b.connect();
  a.loud(3);
  await sleep(300);
  let pa = (await state(b)).find((p) => p.id === a.me);
  check(pa?.band === 3, 'band 3 while shouting', pa?.band);
  a.drop();
  await sleep(600);
  pa = (await state(b)).find((p) => p.id === a.me);
  check(pa?.connected === false && pa?.band === 0, 'dropped socket -> band 0 at once', { c: pa?.connected, band: pa?.band });

  // a connected client that stops sending 'loud' (frozen tab) goes silent after loudStaleMs
  b.loud(2);
  await sleep(300);
  check((await state(b)).find((p) => p.id === b.me)?.band === 2, 'band 2 right after loud');
  await sleep(2000);
  check((await state(b)).find((p) => p.id === b.me)?.band === 0, 'no loud for 2.3 s -> band 0');
  // the real client resends every 500 ms: the band holds
  for (let i = 0; i < 6; i++) { b.loud(2); await sleep(450); }
  check((await state(b)).find((p) => p.id === b.me)?.band === 2, 'resent every 450 ms -> band holds');
  b.close();
}

async function capacity(): Promise<void> {
  const crew = 'F' + tag;
  const bots: Bot[] = [];
  for (let i = 1; i <= 6; i++) { const x = new Bot({ url, name: `Full${i}`, crew }); await x.connect(); bots.push(x); }
  bots[5].drop();
  await sleep(500);
  const late = new Bot({ url, name: 'LateFriend', crew });
  let ok = true;
  try { await late.connect(); } catch (e) { ok = false; console.log(String(e)); }
  check(ok, '7th friend joins when one of 6 is away (held slot released)');
  const ps = await state(bots[0]);
  check(ps.length === 6 && !ps.some((p) => p.name === 'Full6'), 'roster: 6 players, Full6 slot released', ps.map((p) => p.name));
  // a really full crew (6 connected) still refuses
  const eve = new Bot({ url, name: 'Eve', crew });
  let code = '';
  try { await eve.connect(); } catch (e) { code = (e as { code?: string }).code ?? String(e); }
  check(code === 'crew_full', '7th with 6 connected -> crew_full', code);

  // deliberate leave (close code 4100) releases the slot at once
  const leaverId = bots[4].me;
  bots[4].ws?.close(4100, 'leave');
  await sleep(500);
  const after = await state(bots[0]);
  check(!after.some((p) => p.id === leaverId), "'Leave the shift' (close 4100) releases the slot immediately", after.map((p) => p.name));
  // a plain close still holds the slot
  const holdId = bots[3].me;
  bots[3].close();
  await sleep(500);
  const held = (await state(bots[0])).find((p) => p.id === holdId);
  check(!!held && held.connected === false, 'plain close keeps the held slot (resume)', held);
  for (const x of [...bots, late]) x.close();
}

async function observer(): Promise<void> {
  const crew = 'V' + tag;
  const vt = new Bot({ url, name: 'voicetest', crew });
  await vt.connect(); // the phone created the crew first
  const ann = new Bot({ url, name: 'Ann', crew });
  await ann.connect();
  vt.loud(2);
  await sleep(400);
  const ps = await state(ann);
  const v = ps.find((p) => p.id === vt.me);
  const a = ps.find((p) => p.id === ann.me);
  check(v?.alive === false, 'voicetest is not alive (observer)', v);
  check(a?.isLeader === true && v?.isLeader === false, 'a real player is leader, not the observer');
  check(!(ann.lastSnap?.players ?? []).some((p) => p.id === vt.me), 'observer not in the snapshot (no avatar)');
  check(ann.welcome?.crew.players.some((p) => p.id === vt.me) === true || ps.some((p) => p.id === vt.me), 'observer stays in the roster (voice mesh)');
  // alive stays false even if a track revives everyone
  await ann.req('dbg.setPhase', { phase: 'hub' }).catch(() => undefined);
  await sleep(200);
  check((await state(ann)).find((p) => p.id === vt.me)?.alive === false, 'observer stays dead after a phase change');
  vt.close();
  ann.close();
}

async function vanDoor(): Promise<void> {
  const crew = 'D' + tag;
  const a = new Bot({ url, name: 'Inside', crew });
  const b = new Bot({ url, name: 'Outside', crew });
  await a.connect();
  await b.connect();
  const lay = a.welcome?.state.layout as { van?: { cab: { x: number; y: number; w: number; h: number } } } | null;
  const cab = lay?.van?.cab;
  if (!cab) { check(false, 'hub layout has a van cab'); return; }
  const cx = cab.x + cab.w / 2;
  await a.req('dbg.net.teleport', { x: cx, z: cab.y + 1.6 });
  await b.req('dbg.net.teleport', { x: cx, z: cab.y - 0.6 });
  await sleep(400);
  const aud = await a.req<Record<string, Record<string, number>>>('dbg.net.aud');
  const ab = aud[a.me!]?.[b.me!], ba = aud[b.me!]?.[a.me!];
  check(ab !== undefined && ab < 10 && ba < 10, 'inside <-> just outside the open rear doors: audible path distance', { ab, ba });
  a.close();
  b.close();
}

await ghostVoice();
await capacity();
await observer();
await vanDoor();
console.log(fails ? `${fails} FAILED` : 'ALL PASS');
process.exit(fails ? 1 : 0);
