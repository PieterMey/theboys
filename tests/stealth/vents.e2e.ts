// players-stealth (v1.2, stretch) e2e with ws bots: crawl vents (flag crawlVents).
//   - flag off (per-crew dev override) = no crawl interactables; on = one per grate, never the vault
//   - deny: standing, dead, Core carrier (dev stand-in), heavy salvage, ducts busy (dev stand-in for ventInUse),
//     cross-zone before the keycard door is unlocked (plan check #1), already crawling, the 10 s cooldown
//   - a crawl through the real interactable (hold E): hidden meanwhile (silent, stance hidden), 3-7 s, ductThump 4 m at
//     the entry and 6 m at the exit, out at the twin grate's front; cross-zone allowed once the keycard opened the door
// Run: PORT=3801 (a dev server there, else the test starts one) node tests/stealth/vents.e2e.ts
import { STANCE } from '../../packages/shared/src/state.ts';
import { Bot, assert, crewCode, ensureServer, idle, noises, sleep } from './bot.ts';

interface Side { x: number; z: number; space: number; zone: number }
interface PairInfo { a: { id: string; space: number; front: [number, number]; yaw: number }; b: { id: string; space: number; front: [number, number]; yaw: number }; zones: [number, number]; len: number; open: boolean }
interface Vents { on: boolean; registeredFor: string; ids: string[]; lockDoor: number; lockDoorSides: Side[]; lockDoorLocked: boolean | null; pairs: PairInfo[]; crawls: { pid: string; leftMs: number }[]; denial: Record<string, string> }
interface Probe { stance: number; hidden: boolean; surface: string }

const srv = await ensureServer();
const b = new Bot('Crawler');
const h = new Bot('Hauler');
const results: Record<string, unknown> = {};
const stubs: string[] = [];
let failed = false;
const check = (cond: unknown, msg: string) => {
  if (!cond) { failed = true; console.log(`FAIL: ${msg}`); }
};
try {
  const crew = crewCode('VNT');
  await b.connect(srv.ws, crew);
  await h.connect(srv.ws, crew);
  // a layout with a cross-zone pair (nearly all: plan check #1) and, if the seed has one, a same-zone pair
  let v: Vents | null = null;
  let seed = '';
  for (const s of ['vents-e2e-1', 'vents-e2e-2', 'vents-e2e-3', 'vents-e2e-4', 'vents-e2e-5']) {
    await b.dbg('players.testLevel', { seed: s, players: 2, risk: 1 });
    await b.dbg('monsters.freeze', { on: true }).catch(() => null);
    await sleep(400);
    v = await b.dbg<Vents>('players.vents');
    seed = s;
    if (v.pairs.some((p) => p.zones[0] !== p.zones[1]) && v.lockDoor >= 0 && v.lockDoorSides.length === 2) break;
  }
  assert(v && v.pairs.length > 0, 'a layout with vent pairs');
  results.seed = seed;
  results.pairs = v.pairs.map((p) => ({ a: p.a.id, b: p.b.id, zones: p.zones, len: p.len, open: p.open }));
  check(v.on && v.ids.length === v.pairs.length * 2, `one crawl interactable per grate (${v.ids.length} for ${v.pairs.length} pairs)`);
  check(v.ids.every((id) => id.startsWith('crawl:')), 'ids use the catalog prefix crawl:');
  const ixState = async () => (await b.dbg<{ ints?: Record<string, { kind: string; holdMs?: number; r?: number }> }>('interaction.state')).ints ?? {};
  const ints = await ixState();
  const crawlInts = Object.entries(ints).filter(([id]) => id.startsWith('crawl:'));
  check(crawlInts.length === v.ids.length && crawlInts.every(([, i]) => i.kind === 'vent' && i.holdMs === 1200 && i.r === 0.45), `interaction holds the crawl interactables (kind vent, hold 1200 ms, r 0.45): ${crawlInts.length}`);
  await sleep(2600); // spawn lock + net grace

  // ---- flag off: no vents ----
  await b.dbg('players.stealth', { vents: false });
  await sleep(200);
  const off = await b.dbg<Vents>('players.vents');
  const offInts = Object.keys(await ixState()).filter((id) => id.startsWith('crawl:'));
  results.flagOff = { ids: off.ids.length, ints: offInts.length };
  check(!off.on && off.ids.length === 0 && offInts.length === 0, `flag off: no crawl interactables (${off.ids.length}, ${offInts.length})`);
  await b.dbg('players.stealth', { vents: null });
  await sleep(200);
  v = await b.dbg<Vents>('players.vents');
  check(v.ids.length === v.pairs.length * 2, 'flag back on: re-registered');

  const cross = v.pairs.find((p) => p.zones[0] !== p.zones[1]);
  const same = v.pairs.find((p) => p.zones[0] === p.zones[1]);
  const pair = cross ?? same!;
  // the grate on the zone-0 side (the side the crew starts on)
  const from = pair.zones[0] <= pair.zones[1] ? pair.a : pair.b;
  const to = from === pair.a ? pair.b : pair.a;
  const goTo = async (bot: Bot, x: number, z: number, stance: number, ms = 500) => {
    await bot.dbg('net.teleport', { x, z });
    await idle(bot, x, z, ms, stance);
  };
  const tryCrawl = async (bot: Bot, ventId: string) => {
    const id = `crawl:${ventId}`;
    try {
      const r = await bot.req<{ ok: boolean; msg?: string }>('interaction.use', { id, hold: true });
      return r;
    } catch (e) {
      return { ok: false, msg: e instanceof Error ? e.message : String(e) };
    }
  };

  // ---- deny cases ----
  const deny: Record<string, string> = {};
  await goTo(b, from.front[0], from.front[1], STANCE.stand);
  deny.standing = (await tryCrawl(b, from.id)).msg ?? 'ok';
  check(/Crouch/.test(deny.standing), `standing is denied (${deny.standing})`);
  await idle(b, from.front[0], from.front[1], 300, STANCE.crouch);
  if (cross) {
    const r = await tryCrawl(b, from.id);
    deny.crossZoneLocked = r.msg ?? (r.ok ? 'ok' : '?');
    check(!r.ok && /keycard door/.test(deny.crossZoneLocked), `cross-zone before the keycard is denied (${deny.crossZoneLocked})`);
  } else stubs.push('no cross-zone pair in these seeds');
  // dead
  await b.dbg('interaction.kill', {});
  deny.dead = (await tryCrawl(b, from.id)).msg ?? 'ok';
  check(/dead/i.test(deny.dead), `dead is denied (${deny.dead})`);
  await b.dbg('interaction.revive', {});
  await goTo(b, from.front[0], from.front[1], STANCE.crouch, 700);
  // Core carrier (dev stand-in for objectives' carriers) and busy ducts (dev stand-in for monsters' ventInUse)
  await b.dbg('players.vents', { carrier: b.id });
  deny.coreCarrier = (await tryCrawl(b, from.id)).msg ?? 'ok';
  await b.dbg('players.vents', { carrier: null });
  check(/Core/.test(deny.coreCarrier), `a Core carrier is denied (${deny.coreCarrier})`);
  await b.dbg('players.vents', { busy: true });
  deny.ventInUse = (await tryCrawl(b, from.id)).msg ?? 'ok';
  await b.dbg('players.vents', { busy: false });
  check(/ducts/.test(deny.ventInUse), `busy ducts are denied (${deny.ventInUse})`);
  stubs.push('Core carrier + ventInUse via dbg stand-ins (objectives carriers / monsters ventInUse are read live as well)');
  // heavy salvage (the second bot, so the crawler keeps its hands free)
  await h.dbg('interaction.give', { type: 'loot.heavy', value: 100 });
  await goTo(h, from.front[0] + 0.2, from.front[1], STANCE.crouch, 700);
  deny.heavy = (await tryCrawl(h, from.id)).msg ?? 'ok';
  check(/heavy salvage/.test(deny.heavy), `heavy salvage is denied (${deny.heavy})`);
  await h.dbg('net.teleport', { x: to.front[0], z: to.front[1] }).catch(() => null);

  // ---- open the keycard door (cross-zone pairs crawl once it is unlocked) ----
  if (cross) {
    const side0 = v.lockDoorSides.find((s) => s.zone === 0) ?? v.lockDoorSides[0];
    await b.dbg('interaction.give', { type: 'keycard', lock: 1 });
    await goTo(b, side0.x, side0.z, STANCE.stand, 600);
    const u = await b.req<{ ok: boolean; msg?: string }>('interaction.use', { id: `door:${v.lockDoor}` }).catch((e: Error) => ({ ok: false, msg: e.message }));
    await sleep(150);
    const v2 = await b.dbg<Vents>('players.vents');
    results.keycard = { use: u, locked: v2.lockDoorLocked };
    check(v2.lockDoorLocked === false, `the keycard unlocked door ${v.lockDoor} (${JSON.stringify(u)})`);
    check(v2.pairs.find((p) => p.a.id === pair.a.id)?.open === true, 'the cross-zone pair is crawlable now');
    await goTo(b, from.front[0], from.front[1], STANCE.crouch, 700);
  }

  // ---- the crawl ----
  const t0 = Math.max(0, ...(await noises(b)).map((n) => n.t));
  const evAt = b.events.length;
  const started = performance.now();
  const r = await tryCrawl(b, from.id);
  check(r.ok, `the crawl starts through the interactable (${JSON.stringify(r)})`);
  await sleep(600);
  const mid = await b.dbg<Probe>('players.stealth');
  const midVents = await b.dbg<Vents>('players.vents');
  const midPose = await b.dbg<{ pose: { stance: number } }>('players.pose');
  // while crawling, interaction blocks every E (a programmatic hiding spot is left through players only)
  const again = await tryCrawl(b, to.id);
  deny.alreadyCrawling = again.ok ? 'ok' : again.msg ?? 'blocked';
  // keep sending crouched poses from the entry (a frozen client) while crawling: no steps may come of them
  const crawlMs = (midVents.crawls[0]?.leftMs ?? 0) + 600;
  let exited = false;
  const tEnd = performance.now() + Math.max(2000, crawlMs + 2500);
  while (performance.now() < tEnd) {
    await idle(b, from.front[0], from.front[1], 200, STANCE.crouch);
    if (b.events.slice(evAt).some((e) => e.e === 'players.crawl' && (e.d as { phase: string }).phase === 'exit')) { exited = true; break; }
  }
  type CrawlEv = { pid: string; phase: string; p: [number, number, number]; yaw: number; until: number };
  const crawlRecs = b.events.slice(evAt).filter((e) => e.e === 'players.crawl');
  const enterRec = crawlRecs.find((e) => (e.d as CrawlEv).phase === 'enter');
  const enter = enterRec?.d as CrawlEv | undefined;
  const exit = crawlRecs.map((e) => e.d as CrawlEv).find((e) => e.phase === 'exit');
  // server-side duration: the enter event's until minus its own server timestamp
  const serverSec = enter && enterRec ? (enter.until - enterRec.t) / 1000 : 0;
  const wantSec = Math.max(3, Math.min(7, pair.len / 1.5));
  const measuredSec = (performance.now() - started) / 1000;
  await idle(b, to.front[0], to.front[1], 400, STANCE.crouch);
  const end = await b.serverPos();
  const after = await b.dbg<Probe>('players.stealth');
  const thumps = (await noises(b)).filter((n) => n.t > t0 && n.kind === 'ductThump');
  const steps = (await noises(b)).filter((n) => n.t > t0 && /Step$/.test(n.kind) && n.source === b.id);
  results.crawl = {
    from: from.id, to: to.id, len: pair.len, wantSec: Math.round(wantSec * 100) / 100, serverSec: Math.round(serverSec * 100) / 100, measuredSec: Math.round(measuredSec * 100) / 100,
    midHidden: mid.hidden, midStance: midPose.pose.stance, enter, exit, end, afterHidden: after.hidden,
    thumps: thumps.map((n) => `${n.radiusM}m@${n.x.toFixed(1)},${n.z.toFixed(1)}`), stepsWhileCrawling: steps.length,
  };
  check(mid.hidden === true && midPose.pose.stance === STANCE.hidden, `hidden while crawling (${mid.hidden}, stance ${midPose.pose.stance})`);
  check(!again.ok, `no second crawl while crawling (${deny.alreadyCrawling})`);
  check(!!enter && enter.pid === b.id, 'players.crawl enter event');
  check(exited && !!exit, 'players.crawl exit event');
  // (until and the envelope stamp are rounded ms apart: allow 50 ms on the clamp bounds too)
  check(Math.abs(serverSec - wantSec) < 0.05 && serverSec >= 2.95 && serverSec <= 7.05, `crawl lasts clamp(len / 1.5, 3, 7) s (${serverSec.toFixed(3)} s, want ${wantSec.toFixed(2)})`);
  check(!!exit && !!enter && Math.abs(exit.until - enter.until) < 150, 'the exit comes on schedule');
  check(measuredSec >= 3 && measuredSec <= 7 + 1.5, `wall-clock crawl 3-7 s (${measuredSec.toFixed(2)} s)`);
  check(Math.hypot(end[0] - to.front[0], end[2] - to.front[1]) < 0.3, `out at the twin grate front (${end} vs ${to.front})`);
  check(after.hidden === false, 'not hidden after the crawl');
  check(thumps.some((n) => n.radiusM === 4) && thumps.some((n) => n.radiusM === 6), `ductThump 4 m in, 6 m out (${results.crawl && (results.crawl as { thumps: string[] }).thumps})`);
  check(steps.length === 0, `no footsteps while crawling (${steps.length})`);

  // ---- cooldown ----
  await idle(b, to.front[0], to.front[1], 300, STANCE.crouch);
  deny.cooldown = (await tryCrawl(b, to.id)).msg ?? 'ok';
  check(/Catch your breath/.test(deny.cooldown), `the 10 s cooldown (${deny.cooldown})`);
  results.deny = deny;

  // ---- never the vault ----
  const vaultSpaces = new Set<number>();
  for (const s of await b.dbg<{ space: number; kind: string }[]>('players.surfaces')) if (s.kind === 'vault') vaultSpaces.add(s.space);
  results.vaultSpaces = [...vaultSpaces];
  check(v.pairs.every((p) => !vaultSpaces.has(p.a.space) && !vaultSpaces.has(p.b.space)), 'no crawl pair touches the vault');

  results.stubs = stubs;
  console.log(JSON.stringify(results, null, 1));
  if (failed) throw new Error('stealth/vents: failures above');
  console.log('PASS stealth/vents');
} finally {
  b.close();
  h.close();
  await srv.stop();
}
