// v1.3 (G3) 4b + F3 in Chrome, ONE software-lane run (counts, JS logic and layout; GPU time means nothing here):
// - 4b: a parked flare / flashbulb light leaves the batched light loop (visible = false, the SpotLight count uniform drops)
//   and turning it on and off again creates no render pipeline;
// - F3 (flags noiseLure / fieldReceiver switched on in memory by a ws bot before the page loads: the client reads the
//   server's live flags at page load): the lure fuse chip, a thrown lure lying armed (blinking LED), its three rattles
//   reaching the client; the receiver: the listening chip, a Hound cue beyond its own radius put on the air, the 1 s
//   ear-to-door hold (ring + label) and the tells of the Hound in the room behind the door.
// Needs a dev server: PORT=3803 NODE_ENV=development AI_MODE=mock SAVES_DIR=... SESSION_FILE=... ASSETS_DIR=<stage>
//   node apps/server/src/index.ts --dev     then
//   node tools/gpu-guard.mjs --max-sec 120 -- node tests/gear/f3.e2e.ts 3803
// Screenshots: tests/artifacts/gear-v13/*.png (look at them).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launchPlayer, screenshot, waitForGame, REPO } from '../lib/launch.ts';
import { Bot } from '../interaction/bot.ts';
import type { LevelLayout, LayoutDoor } from '../../packages/shared/src/layout.ts';

const port = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? process.env.PORT ?? 3803);
if ([3000, 3100].includes(port)) throw new Error('refusing the live ports');
const soft = process.env.DEADAIR_RENDER === 'swiftshader';
if (!soft) throw new Error('run me through tools/gpu-guard.mjs (software lane only)');
const BASE = `http://127.0.0.1:${port}`;
const CREW = `GF${Date.now() % 100000}`;
const ART = 'tests/artifacts/gear-v13';
const t0 = Date.now();
const secs = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;
const left = () => 114_000 - (Date.now() - t0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (cond: unknown, msg: string) => { console.log(`${cond ? 'PASS' : 'FAIL'} ${msg}`); if (!cond) fails++; return !!cond; };
const report: Record<string, unknown> = {};
type XZ = [number, number];

// the flags first (in memory, server-wide): the page takes the server's live flags when it loads
const bot = new Bot('Mate');
await bot.connect(`ws://127.0.0.1:${port}/ws`, CREW);
await bot.dbg('setFlags', { set: { noiseLure: true, fieldReceiver: true } });
// short windows so one run covers everything (balance is read live on the server)
await bot.dbg('interaction.tune', { flareBurnSec: 3, receiverListenSec: 3, lureSpanSec: 1 });

const p = await launchPlayer({ baseUrl: BASE, crew: CREW, name: 'Lane', query: { autojoin: '1', nobright: '1' }, viewport: { width: 960, height: 540 } });
const page = p.page;
const ev = <T = unknown>(js: string) => page.evaluate(js) as Promise<T>;
const until = (js: string, ms: number) => page.waitForFunction(js, undefined, { timeout: Math.max(300, Math.min(ms, left() - 1500)), polling: 100 }).then(() => true, () => false);
const frames = (n: number) => ev(`new Promise((r) => { let k = ${n}; const f = () => (--k <= 0 ? r(0) : requestAnimationFrame(f)); requestAnimationFrame(f); })`);
const dbg = (r: string, a: unknown = {}) => ev(`__game.dbg(${JSON.stringify(r)}, ${JSON.stringify(a)})`);
const shots: string[] = [];
const shot = async (name: string, waitFrames = 2) => {
  if (left() < 4000) { console.log('skip shot (time)', name); return; }
  if (waitFrames > 0) await frames(waitFrames);
  const f = await screenshot(page, `${ART}/${name}.png`);
  shots.push(f);
  console.log('shot', f, secs());
};
const pipelines = () => ev<number>('__render.pipelines().pipelines');
/** the batched SpotLight count uniform of the scene's lights node (DynamicLighting) and the pooled lights' states */
const lightState = () => ev<{ spots: number | null; list: { name: string; visible: boolean; intensity: number }[]; settled: boolean }>(`(() => {
  const t = __render.three();
  const node = t.renderer.lighting && t.renderer.lighting.getNode ? t.renderer.lighting.getNode(t.scene) : null;
  const dn = node && node._dataNodes ? node._dataNodes.get('SpotLight') : null;
  const d = t.scene.getObjectByName('interaction').userData.ixDebug.lights();
  return { spots: dn && dn.countNode ? dn.countNode.value : null, list: d.list, settled: d.settled };
})()`);
const give = async (type: string, count?: number) => {
  await dbg('interaction.give', { type, ...(count !== undefined ? { count } : {}) });
  await sleep(150);
  const slot = await ev<number>(`(() => { const st = __ix.state(); const me = __game.me(); return (st.inventories[me] || []).findIndex((id) => id && st.items[id] && st.items[id].type === ${JSON.stringify(type)}); })()`);
  if (slot >= 0) await ev(`__ix.slot(${slot})`);
  await sleep(250);
  return slot;
};
const look = async (x: number, z: number, yaw: number, pitch: number) => {
  await ev(`__game.teleport(${x}, ${z}, ${yaw})`);
  await sleep(150);
  await ev(`__game.look(${yaw}, ${pitch})`);
  await frames(2);
};

try {
  await page.routeWebSocket(/token=/, () => {});
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForGame(page, 70_000);
  await page.waitForFunction(() => !!(window as unknown as { __game?: { me(): string | null } }).__game?.me(), undefined, { timeout: 15_000 });
  console.log('game ready', secs());
  const rc0 = await ev<{ on: boolean; lure: boolean }>('__ix.receiver()');
  ok(rc0.on && rc0.lure, `the page took the live flags (noiseLure ${rc0.lure}, fieldReceiver ${rc0.on})`);
  const SEED = 'g3-f3-lane-1';
  await dbg('net.validate', { on: false }).catch(() => undefined); // the test teleports
  await dbg('level.generate', { seed: SEED, players: 2 });
  await dbg('monsters.freeze', { on: true }).catch(() => undefined);
  await dbg('paranormal.tune', { nextInSec: 9999 }).catch(() => undefined);
  await page.waitForFunction((s) => (window as unknown as { __ix?: { layout(): { seed?: string } | null } }).__ix?.layout()?.seed === s, SEED, { timeout: 25_000 });
  await until('!!window.__levelDebug && __levelDebug.texturesReady()', 25_000);
  // empty hands (a hand-out may have filled slots): every give below lands in a slot
  for (let i = 0; i < 4; i++) await page.evaluate((s) => (window as unknown as { __ix: { drop(): Promise<unknown>; slot(n: number): Promise<unknown> } }).__ix.slot(s).then(() => (window as unknown as { __ix: { drop(): Promise<unknown> } }).__ix.drop()), i).catch(() => undefined);
  const warmDone = await until('(() => { const d = __ix.drawStats(); return !!d && !d.warm; })()', 15_000);
  ok(warmDone, `the item warm-up ended (${secs()})`);
  const L = await ev<LevelLayout>('__ix.layout()');
  // a long corridor / room: the player 1.2 m in, looking down it
  const run = [...L.spaces].filter((s) => s.kind !== 'outside' && s.type !== 'van').sort((a, b) => Math.max(b.rect.w, b.rect.h) - Math.max(a.rect.w, a.rect.h))[0]!;
  const r = run.rect, alongX = r.w >= r.h, runLen = Math.max(r.w, r.h);
  const from: XZ = alongX ? [r.x + 1.2, r.y + r.h / 2] : [r.x + r.w / 2, r.y + 1.2];
  const axis: XZ = alongX ? [1, 0] : [0, 1];
  const at = (k: number): XZ => [from[0] + axis[0] * k, from[1] + axis[1] * k];
  const yaw = Math.atan2(axis[0], axis[1]);
  console.log(`run: ${run.kind} ${run.type} ${runLen} m`);
  await look(from[0], from[1], yaw, -0.3);

  // ---------------- 4b: the pooled lights leave the loop while dark; toggling them makes no pipeline
  const l0 = await lightState();
  ok(l0.settled && l0.list.every((l) => !l.visible), `after the warm-up every pooled light is out of the loop: ${JSON.stringify(l0.list)}`);
  ok(l0.spots !== null, `DynamicLighting batches SpotLights (count uniform ${l0.spots})`);
  const pA = await pipelines();
  await give('flare', 2);
  await ev('__ix.act()');
  const lit = await until(`(() => { const d = __render.three().scene.getObjectByName('interaction').userData.ixDebug.lights(); return d.list.some((l) => l.name.startsWith('flare-light') && l.visible && l.intensity > 0); })()`, 6000);
  const l1 = await lightState();
  const pB = await pipelines();
  ok(lit, `a burning flare: one flare light in the loop (${JSON.stringify(l1.list.filter((l) => l.visible))})`);
  ok(l0.spots !== null && l1.spots === l0.spots + 1, `SpotLight count ${l0.spots} -> ${l1.spots}`);
  await shot('1-flare-lit');
  const out1 = await until(`(() => { const d = __render.three().scene.getObjectByName('interaction').userData.ixDebug.lights(); return d.list.every((l) => !l.visible); })()`, 6000);
  const l2 = await lightState();
  const pC = await pipelines();
  ok(out1 && l2.spots === l0.spots, `burnt out: back out of the loop (count ${l2.spots})`);
  // the second flare: the light joins again
  await sleep(450);
  await ev('__ix.act()');
  await until(`(() => { const d = __render.three().scene.getObjectByName('interaction').userData.ixDebug.lights(); return d.list.some((l) => l.name.startsWith('flare-light') && l.visible); })()`, 6000);
  const pD = await pipelines();
  // the flashbulb: in the loop for its pop only (a ~0.35 s pop can fall between two polls: a frame hook records it)
  await ev(`(() => {
    const d = __render.three().scene.getObjectByName('interaction').userData.ixDebug;
    window.__f3pop = 0;
    const tick = () => { const f = d.lights().list.find((l) => l.name === 'flashbulb-light'); if (f && f.visible && f.intensity > 0) window.__f3pop++; if (window.__f3pop >= 0) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  })()`);
  await give('flashbulb', 1);
  await ev('__ix.act()');
  const popped = await until('(__ix.fx().flash || 0) >= 1 && window.__f3pop > 0', 4000);
  const pE = await pipelines();
  const gone = await until(`(() => { const d = __render.three().scene.getObjectByName('interaction').userData.ixDebug.lights(); const f = d.list.find((l) => l.name === 'flashbulb-light'); return !!f && !f.visible; })()`, 4000);
  const popFrames = await ev<number>('window.__f3pop');
  await ev('window.__f3pop = -1');
  const pF = await pipelines();
  ok(popped && gone, `the flashbulb light: in the loop for its pop (${popFrames} frame(s) seen lit), out after it`);
  report.pipelines = { warmEnd: pA, flareLit: pB, flareOut: pC, flare2: pD, flash: pE, flashOut: pF };
  ok(pB === pC && pC === pD && pD === pE && pE === pF, `light visibility toggles create no pipeline: ${JSON.stringify(report.pipelines)}`);
  console.log(`  (warm-up end -> first flare: +${pB - pA}: the burning flare's own first sight)`);

  // ---------------- F3: the noise lure
  await give('lure', 2);
  await ev('__ix.fuse(5)');
  await frames(2);
  const chips = await ev<string[]>('__ix.status()');
  ok(chips.some((c) => c === 'LURE FUSE: 5 S · RMB'), `fuse chip: ${JSON.stringify(chips)}`);
  const hint = await ev<string>(`(document.querySelector('.ix-hint') || {}).textContent || ''`);
  ok(/RMB sets the fuse/.test(hint), `the lure's hint line: ${hint}`);
  await look(from[0], from[1], yaw, -0.45);
  const fx0 = await ev<Record<string, number>>('__ix.fx()');
  await ev('__ix.act()');
  const landed = await until(`Object.values(__ix.state().items).some((it) => it.type === 'lure' && it.where === 'world' && it.armed)`, 5000);
  ok(landed, 'the lure lies armed in the world');
  const lp = await ev<[number, number, number] | null>(`(() => { const it = Object.values(__ix.state().items).find((x) => x.type === 'lure' && x.where === 'world'); return it ? it.p : null; })()`);
  if (lp) {
    // stand 1.4 m back from it, looking down at it
    const bx = lp[0] - axis[0] * 1.4, bz = lp[2] - axis[1] * 1.4;
    await look(bx, bz, yaw, -0.62);
    const tg = await ev<{ view?: { text?: string; sub?: string } } | null>('__ix.target()');
    console.log('  target:', JSON.stringify(tg?.view ?? null));
    await shot('2-lure-armed');
  }
  const rattled = await until(`(__ix.fx().lure || 0) - ${fx0.lure ?? 0} >= 3`, 9000);
  ok(rattled, `three rattles reached the client (fx lure ${((await ev<Record<string, number>>('__ix.fx()')).lure ?? 0) - (fx0.lure ?? 0)})`);
  ok(await until(`!Object.values(__ix.state().items).some((it) => it.type === 'lure' && it.where === 'world')`, 3000), 'used up by its last rattle');

  // ---------------- F3: the receiver on the air (a Hound cue beyond its own radius)
  let ms = await dbg('monsters.state') as { mode?: string; agents?: { id: string; kind: string }[] };
  if (!(ms.agents ?? []).some((a) => a.kind === 'hound')) {
    await dbg('monsters.start', { risk: 1 });
    await dbg('monsters.freeze', { on: true });
    ms = await dbg('monsters.state') as typeof ms;
  }
  const hound = (ms.agents ?? []).find((a) => a.kind === 'hound');
  console.log(`  monsters: ${ms.mode}, ${(ms.agents ?? []).map((a) => a.kind).join(',')}`);
  await give('receiver', 5);
  if (hound && runLen >= 10) {
    const hk = Math.min(15, runLen - 2.2);
    await look(from[0], from[1], yaw, -0.1);
    await dbg('monsters.place', { id: hound.id, x: at(hk)[0], z: at(hk)[1], state: 'idle', active: true });
    await dbg('monsters.freeze', { on: false });
    await ev('__ix.listen()');
    const on = await until('__ix.receiver().listening', 3000);
    await frames(2);
    const chips2 = await ev<string[]>('__ix.status()');
    ok(on && chips2.some((c) => /^RECEIVER · LISTENING \d S · YOU HEAR LESS$/.test(c)), `listening: ${JSON.stringify(chips2)}`);
    await shot('3-receiver-listening');
    // bait it where it stands: it huffs (an 8 m cue) about hk m away
    await dbg('monsters.noise', { x: at(hk)[0] + axis[0] * 0.5, z: at(hk)[1] + axis[1] * 0.5, radiusM: 6, kind: 'bottle' });
    const heard = await until(`__ix.receiver().log.some((l) => l.why.startsWith('cue:') && l.why.endsWith(':hound'))`, 3500);
    await dbg('monsters.freeze', { on: true });
    const log = (await ev<{ log: { key: string; why: string; gain: number; pan: number; played: boolean }[] }>('__ix.receiver()')).log;
    ok(heard, `a Hound cue ${hk.toFixed(1)} m off on the air: ${JSON.stringify(log.filter((l) => l.why.startsWith('cue:')))}`);
    report.cueLog = log;
    await until('!__ix.receiver().listening', 4000);
  } else ok(false, `no Hound (${(ms.agents ?? []).map((a) => a.kind).join(',')}) or no 10 m run`);

  // ---------------- F3: ear to a closed door (the 1 s hold), the Hound in the room behind it
  const owner = (x: number, z: number) => { const cx = Math.floor(x), cz = Math.floor(z); return cx < 0 || cz < 0 || cx >= L.W || cz >= L.H ? -1 : L.owner[cz * L.W + cx]!; };
  const st = await ev<{ doors: Record<number, { open: boolean }> }>('__ix.state()');
  let pickDoor: { d: LayoutDoor; stand: XZ; far: XZ; yawD: number } | null = null;
  for (const d of L.doors) {
    if (d.kind !== 'door' || st.doors[d.id]?.open || d.a === d.b) continue;
    const cx = d.dir === 'v' ? d.x : d.x + d.len / 2, cz = d.dir === 'v' ? d.y + d.len / 2 : d.y;
    const nx = d.dir === 'v' ? 1 : 0, nz = 1 - nx;
    for (const sgn of [-1, 1]) {
      // the Hound 0.9 m past the door: inside the cell right behind it (the space behind the door, always on the open floor there)
      const stand: XZ = [cx + sgn * nx * 0.75, cz + sgn * nz * 0.75], far: XZ = [cx - sgn * nx * 0.9, cz - sgn * nz * 0.9];
      if (owner(...stand) >= 0 && owner(...far) >= 0 && owner(...stand) !== owner(...far)) { pickDoor = { d, stand, far, yawD: Math.atan2(cx - stand[0], cz - stand[1]) }; break; }
    }
    if (pickDoor) break;
  }
  if (pickDoor && hound) {
    const { d, stand, far, yawD } = pickDoor;
    await dbg('monsters.place', { id: hound.id, x: far[0], z: far[1], state: 'idle', active: true });
    await look(stand[0], stand[1], yawD, -0.05);
    const cx = d.dir === 'v' ? d.x : d.x + d.len / 2, cz = d.dir === 'v' ? d.y + d.len / 2 : d.y;
    await ev(`__ix.aim(${cx}, 1.1, ${cz})`);
    await frames(3);
    const tv = await ev<{ kind?: string; view?: { text: string; key: string; sub?: string } } | null>('__ix.target()');
    ok(tv?.kind === 'door' && /listen through it/.test(tv.view?.sub ?? ''), `the door prompt offers the ear: ${JSON.stringify(tv?.view ?? null)}`);
    const n0 = (await ev<{ log: unknown[] }>('__ix.receiver()')).log.length;
    // hold E 2 s (slow software frames: the 1 s hold completes on the first frame past it); the ring + label mid-hold
    const hold = ev('__ix.holdE(2000)');
    await until('__ix.hold().k !== null && __ix.hold().k > 0', 900);
    const mid = await ev<{ k: number | null; label: string | null }>('__ix.hold()');
    await shot('4-ear-hold', 0);
    await hold;
    ok(mid.k !== null && mid.k > 0.2 && mid.k < 1 && mid.label === 'Ear to the door…', `the 1 s ear hold: ring ${mid.k?.toFixed(2)}, '${mid.label}'`);
    const ear = await until('__ix.receiver().listening && __ix.receiver().door !== null', 3000);
    const rcv = await ev<{ door: number | null; space: number; log: { why: string }[] }>('__ix.receiver()');
    ok(ear && rcv.door === d.id && rcv.space === owner(...far), `ear to door ${d.id}: listening to space ${rcv.space} (the Hound's ${owner(...far)})`);
    const tells = await until(`__ix.receiver().log.slice(${n0}).some((l) => l.why === 'tell:hound')`, 3500);
    const after = (await ev<{ log: { why: string }[] }>('__ix.receiver()')).log.slice(n0);
    ok(tells, `the Hound behind the door gives itself away: ${JSON.stringify(after)}`);
  } else ok(false, 'no closed door between two spaces (or no Hound)');

  const errs = await ev<string[]>('__game.errors()');
  ok(errs.length === 0, `no client errors ${JSON.stringify(errs.slice(0, 4))}`);
  const pe = p.errors.filter((e) => !/http 4\d\d|favicon/.test(e));
  ok(pe.length === 0, `no page errors ${JSON.stringify(pe.slice(0, 4))}`);
} catch (e) {
  console.log('FAIL', e instanceof Error ? (e.stack ?? e.message) : e);
  await screenshot(page, `${ART}/fail.png`).catch(() => undefined);
  fails++;
} finally {
  report.shots = shots;
  report.elapsed = secs();
  try { mkdirSync(join(REPO, ART), { recursive: true }); writeFileSync(join(REPO, ART, 'f3-report.json'), JSON.stringify(report, null, 1)); } catch { /* best effort */ }
  try { await bot.dbg('setFlags', { set: { noiseLure: false, fieldReceiver: false } }); await bot.dbg('interaction.tune', { flareBurnSec: 60, receiverListenSec: 6, lureSpanSec: 8 }); } catch { /* gone */ }
  bot.close();
  await p.close();
}
console.log(fails ? `FAILED (${fails})` : 'ALL PASS', secs());
process.exit(fails ? 1 : 0);
