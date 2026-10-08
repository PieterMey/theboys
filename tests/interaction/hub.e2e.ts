// Full-stack ws-bot check against a running dev server (BASE_URL, default http://127.0.0.1:3012): the hub's
// interactables exist, E on the work-order board / shop / mirror routes to meta's onInteract handlers (meta.open),
// and the interaction slice is present in Welcome. Run: node tests/interaction/hub.e2e.ts
import { Bot } from './bot.ts';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3012';
const WS = BASE.replace(/^http/, 'ws') + '/ws';
const CREW = `HB${'BCDFGHJKLM'[Math.floor(Date.now() / 1000) % 10]}${'BCDFGHJKLM'[Math.floor(Date.now() / 10000) % 10]}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (step: string, ok: boolean, info?: unknown) => {
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step}${info !== undefined ? ` :: ${JSON.stringify(info)}` : ''}`);
};

/** walk a bot in small steps (server-side movement validation clamps speed) */
async function walkTo(b: Bot, from: [number, number], to: [number, number], yaw: number): Promise<void> {
  const d = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const n = Math.max(1, Math.ceil(d / 0.12));
  for (let i = 1; i <= n; i++) {
    b.pose(from[0] + ((to[0] - from[0]) * i) / n, from[1] + ((to[1] - from[1]) * i) / n, yaw);
    await sleep(30);
  }
  await sleep(150);
}

const b = new Bot('HubBot');
await b.connect(WS, CREW);
await sleep(800);
check('welcome carries the interaction slice', !!b.full?.interaction, Object.keys(b.full?.interaction ?? {}));
check('phase hub', b.full?.phase === 'hub', b.full?.phase);
const ints = Object.values(b.ix.ints);
check('hub interactables registered', ints.length >= 5, ints.map((i) => `${i.id}:${i.enabled ? 'on' : 'off'}`));
const pos = b.lastSnap?.players.find((p) => p.id === b.me)?.p ?? [15, 0, 8.6];
let at: [number, number] = [pos[0], pos[2]];
for (const id of ['board:0', 'shop:0', 'mirror:0']) {
  const it = b.full?.layout?.items.find((i) => i.id === id);
  if (!it) { check(`${id} in the hub layout`, false); continue; }
  const rot = it.rot ?? 0;
  const stand: [number, number] = [it.x + Math.sin(rot) * 0.9, it.z + Math.cos(rot) * 0.9];
  await walkTo(b, at, stand, rot + Math.PI);
  at = stand;
  // v1.2 hub: a straight walk can end against a wall (the stations moved); place the server pose on the spot
  await b.dbg('interaction.pose', { pid: b.me, x: stand[0], z: stand[1], yaw: rot + Math.PI }).catch(() => undefined);
  const evP = b.waitEvent('meta.open', () => true, 2500).catch(() => null);
  const r = await b.req<{ ok: boolean; msg?: string }>('interaction.use', { id });
  const ev = await evP;
  check(`E on ${id} routes to meta`, r.ok && !!ev, { r, ev: ev?.d });
  b.clearEvents();
}
b.close();
console.log(fails ? `${fails} check(s) failed` : 'all hub checks passed');
process.exitCode = fails ? 1 : 0;
setTimeout(() => process.exit(process.exitCode ?? 0), 200).unref();
