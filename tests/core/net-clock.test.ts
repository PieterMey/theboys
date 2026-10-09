// v1.3 P8 (client core/net.ts): pongs no longer feed the render clock, and STT voice chunks are skipped while the socket
// is backed up. Drives the REAL createNet + createWorld + ① Net's adaptive interpolation (net/stats.ts) through a fake
// WebSocket and a simulated clock: the perf-server-net clocksim (14 fps friend, 45 ms one way) as a test, comparing
// against the old behaviour (pong midpoint fed to observeServerTime, re-applied here by the test itself).
//   node --test tests/core/net-clock.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROTOCOL_VERSION, decodeMsg, encodeMsg } from '../../packages/shared/src/envelope.ts';
import type { ClientMsg, ServerMsg } from '../../packages/shared/src/envelope.ts';
import type { Snapshot } from '../../packages/shared/src/state.ts';

// ---------------------------------------------------------------- browser stand-ins (before the client modules load)
let T = 1000; // simulated performance.now()
(globalThis.performance as unknown as { now: () => number }).now = () => T;

class FakeWS {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static last: FakeWS | null = null;
  url: string;
  readyState = 0;
  binaryType = 'blob';
  bufferedAmount = 0;
  sent: ClientMsg[] = [];
  rawSent = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onSend: ((m: ClientMsg) => void) | null = null;
  constructor(url: string) { this.url = url; FakeWS.last = this; }
  send(d: Uint8Array): void {
    this.rawSent++;
    if (d[0] !== 0) return; // FRAME.msg only (voice chunks, FRAME 1, are only counted)
    const m = decodeMsg<ClientMsg>(d);
    this.sent.push(m);
    this.onSend?.(m);
  }
  close(): void { this.readyState = 3; }
  open(): void { this.readyState = 1; this.onopen?.(); }
  deliver(m: ServerMsg): void {
    const u = encodeMsg(m);
    this.onmessage?.({ data: u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer });
  }
}
Object.defineProperty(globalThis, 'WebSocket', { value: FakeWS, configurable: true, writable: true });
Object.assign(globalThis, { location: { protocol: 'http:', host: 'sim', search: '', hash: '' }, document: { hidden: false }, __BUILD_ID__: 'sim' });

const { createNet } = await import('../../apps/client/src/core/net.ts');
const { createWorld } = await import('../../apps/client/src/core/world.ts');
const { createBus } = await import('../../apps/client/src/core/bus.ts');
const { createNetStats } = await import('../../apps/client/src/net/stats.ts');

const snap = (t: number, tick: number): Snapshot => ({ t, tick, players: [], monsters: [], dyn: [], aud: {} });

/** a joined client on a fake socket; `frame()` runs ① Net's frame clock like the rAF loop does */
async function joined(serverNow: number) {
  const world = createWorld();
  const errors: string[] = [];
  const bus = createBus((m) => errors.push(m));
  const net = createNet(world, bus, (m) => errors.push(m));
  let frameSys: { update(dt: number): void } | null = null;
  const ctx = {
    balance: { net: {} }, params: new URLSearchParams(), world, net,
    registerSystem: (s: { update(dt: number): void }) => { frameSys = s; },
  };
  createNetStats(ctx as never);
  const p = net.join('SIM', 'Sim');
  const ws = FakeWS.last!;
  ws.open();
  const crew = { code: 'SIM', phase: 'hub' as const, players: [], maxPlayers: 6 };
  ws.deliver({ op: 'welcome', v: PROTOCOL_VERSION, you: 'p1', resume: 'r', crew, state: { phase: 'hub', layout: null, workOrders: [], activeOrder: null, clockMin: -1, objectives: null, interaction: null, meta: null as never, snap: null }, iceServers: [], serverTime: serverNow, build: 'dev' });
  await p;
  return { world, net, ws, errors, frame: () => frameSys?.update(0) };
}

test('a pong never moves the render clock; snapshots still do (and the RTT median still updates)', async () => {
  T = 5000;
  const { world, net, ws } = await joined(5000 - 40); // the welcome landed 40 ms after the server stamped it
  const off0 = world.clockOffset();
  ws.deliver({ op: 'snap', s: snap(T - 30, 1) }); // a faster sample raises the offset
  assert.ok(world.clockOffset() > off0);
  const off1 = world.clockOffset();
  // a pong whose midpoint is 500 ms "ahead": the old code jumped the clock forward by it
  T += 200;
  ws.deliver({ op: 'pong', c: T - 120, s: T + 500 });
  assert.equal(world.clockOffset(), off1, 'pong midpoint ignored');
  assert.equal(net.rtt, 120);
  net.leave();
});

test('STT voice chunks are skipped while more than 32 KB wait in the send buffer', async () => {
  T = 9000;
  const { net, ws } = await joined(9000);
  const h = { segId: 1, seq: 0, start: true, end: false, maxBand: 2 };
  const pcm = new Int16Array(1600);
  const before = ws.rawSent;
  net.sendVoiceChunk(h, pcm);
  assert.equal(ws.rawSent, before + 1, 'sent when the buffer is empty');
  ws.bufferedAmount = 40 * 1024;
  net.sendVoiceChunk(h, pcm);
  net.sendVoiceChunk(h, pcm);
  assert.equal(ws.rawSent, before + 1, 'skipped while backed up');
  assert.equal(net.voiceSkipped, 2);
  assert.equal(net.bufferedAmount, 40 * 1024);
  ws.bufferedAmount = 1000;
  net.sendVoiceChunk(h, pcm);
  assert.equal(ws.rawSent, before + 2, 'sent again once drained');
  net.leave();
});

// ---------------------------------------------------------------- the clock simulation (perf-server-net clocksim.mts)

/** deterministic exponential jitter (LCG, seed 7: the simulation's own numbers, not gameplay) */
function jitterGen() {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  return (mean: number) => -Math.log(1 - rnd()) * mean;
}

async function simulate(o: { frameMs: number; oneWay: number; jitter: number; upExtra: number; feedPongs: boolean }) {
  T = 100_000;
  const expo = jitterGen();
  const { world, ws, frame, net } = await joined(T - o.oneWay);
  const queue: { at: number; m: ServerMsg; c?: number; s?: number }[] = [];
  const pattern = [46.875, 46.875, 46.875, 46.875, 62.5]; // Windows 15.625 ms timer: measured snapshot gaps
  let nextSnap = T;
  let pi = 0;
  let tick = 0;
  let nextPing = T + 1000;
  const rts: number[] = [];
  for (let f = 0; f < 4000; f++) {
    const end = T + o.frameMs;
    while (nextSnap <= end) {
      queue.push({ at: nextSnap + o.oneWay + expo(o.jitter), m: { op: 'snap', s: snap(nextSnap, ++tick) } });
      nextSnap += pattern[pi++ % pattern.length];
    }
    if (T >= nextPing) { // a ping from a timer between frames; the server answers on arrival
      const c = T;
      const srvAt = T + o.oneWay + o.upExtra + expo(o.jitter);
      queue.push({ at: srvAt + o.oneWay + expo(o.jitter), m: { op: 'pong', c, s: srvAt }, c, s: srvAt });
      nextPing = T + 2000;
    }
    T = end;
    queue.sort((a, b) => a.at - b.at);
    while (queue.length && queue[0].at <= T) {
      const q = queue.shift()!;
      ws.deliver(q.m);
      // the v1.2 behaviour, re-applied by the test: the pong midpoint into the same max-filter
      if (o.feedPongs && q.m.op === 'pong') world.observeServerTime(q.s! + (T - q.c!) / 2);
    }
    frame(); // ① Net's frame clock (stall samples are skipped against it)
    if (f > 1000) rts.push(world.renderTime());
  }
  net.leave();
  const jumps = rts.slice(1).map((rt, i) => Math.abs(rt - rts[i] - o.frameMs)).sort((a, b) => a - b);
  return { interp: Math.round(world.interpDelayMs), jumpP95: +jumps[Math.floor(jumps.length * 0.95)].toFixed(1), jumpMax: +jumps[jumps.length - 1].toFixed(1) };
}

test('clock simulation: a 14 fps friend 45 ms away gets a lower interpolation delay and no 2 s clock jumps', async () => {
  const cases = [
    { name: 'host-like (240 fps, 1 ms)', frameMs: 4.2, oneWay: 1, jitter: 1, upExtra: 0 },
    { name: 'friend afternoon (19 fps, 8 ms)', frameMs: 52, oneWay: 8, jitter: 3, upExtra: 0 },
    { name: 'friend evening (14 fps, 45 ms)', frameMs: 70, oneWay: 45, jitter: 8, upExtra: 0 },
    { name: 'friend evening + 40 ms upload queue', frameMs: 70, oneWay: 45, jitter: 8, upExtra: 40 },
  ];
  const out: Record<string, { old: Awaited<ReturnType<typeof simulate>>; now: Awaited<ReturnType<typeof simulate>> }> = {};
  for (const c of cases) {
    const old = await simulate({ ...c, feedPongs: true });
    const now = await simulate({ ...c, feedPongs: false });
    out[c.name] = { old, now };
    console.log(`  ${c.name}: v1.2 interp ${old.interp} ms, jump p95/max ${old.jumpP95}/${old.jumpMax} ms -> now ${now.interp} ms, ${now.jumpP95}/${now.jumpMax} ms`);
  }
  const host = out['host-like (240 fps, 1 ms)'];
  assert.ok(Math.abs(host.now.interp - host.old.interp) <= 5, 'host unchanged');
  for (const k of ['friend evening (14 fps, 45 ms)', 'friend evening + 40 ms upload queue']) {
    const { old, now } = out[k];
    assert.ok(now.interp <= old.interp - 20, `${k}: interpolation delay ${old.interp} -> ${now.interp}`);
    assert.ok(old.jumpMax >= 40, `${k}: the simulation reproduces the old clock jumps (${old.jumpMax})`);
    assert.ok(now.jumpMax <= 30, `${k}: no big clock jumps any more (${now.jumpMax})`);
  }
});
