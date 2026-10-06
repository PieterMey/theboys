// Playtest driver (report-only): MONSTERS, DEATH, SPECTATING, REVIVE with 3 real Chrome players on :3203.
//   node tests/playtest/monsters-death/play.ts [phases]   phases: comma list of hound,death,listener,mannequin (default all)
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CDPSession, Page } from 'playwright-core';
import { REPO, launchPlayer, waitForGame } from '../../lib/launch.ts';
import { decodeMsg } from '../../../packages/shared/src/envelope.ts';

const BASE = process.env.BASE_URL ?? 'http://127.0.0.1:3203';
const CREW = process.env.CREW ?? 'MDTN';
const OUT = join(REPO, 'tests/playtest/monsters-death');
const SHOTS = join(OUT, 'shots');
mkdirSync(SHOTS, { recursive: true });
const LOG = join(OUT, 'play.log');
const PHASES = new Set((process.argv[2] ?? 'hound,death,listener,mannequin').split(','));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const T0 = Date.now();
const log = (...a: unknown[]) => {
  const s = `[${((Date.now() - T0) / 1000).toFixed(1)}] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}`;
  console.log(s);
  appendFileSync(LOG, s + '\n');
};

interface Ev { t: number; e: string; d: any }
interface P { name: string; page: Page; cdp: CDPSession; ev: Ev[]; errors: string[]; id: string; close(): Promise<void> }

async function launch(name: string, wav: string): Promise<P> {
  const pl = await launchPlayer({ name, wav, baseUrl: BASE, crew: CREW, query: { autojoin: '1', nobright: '1' }, viewport: { width: 1600, height: 900 } });
  const page = pl.page;
  await page.routeWebSocket(/token=/, () => {});
  // a player who calibrated in the van (talk ~-21 dBFS) and uses push-to-talk (V) from the settings
  await page.addInitScript(() => {
    try {
      localStorage.setItem('deadair.voice.ptt', '1');
      localStorage.setItem('deadair.meta.settings', JSON.stringify({ ptt: true, brightnessDone: true, hints: true }));
      localStorage.setItem('deadair.voice.base', '-21');
      localStorage.setItem('deadair.voice.cal', JSON.stringify({ noiseDb: -75, talkDb: -21, whisperDb: -35, shoutDb: -8, at: Date.now() }));
    } catch { /* ignore */ }
  });
  const ev: Ev[] = [];
  page.on('websocket', (ws) => {
    if (!/\/ws(\?|$)/.test(ws.url())) return;
    ws.on('framereceived', (f) => {
      const b = f.payload as unknown;
      if (typeof b === 'string') return;
      const u = new Uint8Array(b as Buffer);
      if (u[0] !== 0) return;
      try {
        const m = decodeMsg(u) as { op: string; e?: string; d?: unknown };
        if (m.op === 'ev' && m.e && /^(monsters|interaction|players|objectives\.(alarm|horn))/.test(m.e) && m.e !== 'interaction.patch') ev.push({ t: Date.now(), e: m.e, d: m.d });
      } catch { /* ignore */ }
    });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  const cdp = await page.context().newCDPSession(page);
  return { name, page, cdp, ev, errors: pl.errors, id: '', close: pl.close };
}

async function shot(p: P, name: string): Promise<string> {
  try {
    const r = (await p.cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string };
    const f = join(SHOTS, `${name}.png`);
    writeFileSync(f, Buffer.from(r.data, 'base64'));
    log(`shot ${name}.png (${p.name})`);
    return f;
  } catch (e) {
    log(`shot ${name} FAILED: ${e}`);
    return '';
  }
}
const ev = <T>(p: P, fn: string, ...args: unknown[]): Promise<T> =>
  p.page.evaluate(([f, a]) => (window.__game as unknown as Record<string, (...x: unknown[]) => unknown>)[f as string](...(a as unknown[])), [fn, args] as const) as Promise<T>;
const dbg = <T = any>(p: P, r: string, a: unknown = {}): Promise<T> => p.page.evaluate(([r2, a2]) => window.__game!.dbg(r2 as string, a2), [r, a] as const) as Promise<T>;
const req = <T = any>(p: P, r: string, a: unknown = {}): Promise<T> => p.page.evaluate(([r2, a2]) => window.__game!.req!(r2 as string, a2), [r, a] as const) as Promise<T>;
const ms = (p: P) => dbg<any>(p, 'monsters.state');
const agent = async (p: P, id: string) => { const m = await ms(p); if (!m.agents) { log('monsters runtime OFF (mode ' + m.mode + ')'); return { id, state: 'OFF', x: 0, z: 0 }; } return (m.agents as any[]).find((a) => a.id === id); };
const hold = async (p: P, key: string, msec: number) => { await p.page.keyboard.down(key); await sleep(msec); await p.page.keyboard.up(key); };
const evalJs = <T = any>(p: P, body: string): Promise<T> => p.page.evaluate((b) => (new Function(b))(), body) as Promise<T>;
const hud = (p: P) => evalJs<string>(p, `return [...document.querySelectorAll('[data-testid], .hud-chip, .ix-prompt, .ix-spec, .ix-death')].filter(e => e.offsetParent !== null || getComputedStyle(e).position==='fixed').map(e => (e.getAttribute('data-testid')||e.className)+': '+e.innerText.replace(/\\s+/g,' ').slice(0,160)).join(' | ')`);
const band = (p: P) => evalJs<number>(p, 'return window.__voiceDebug ? window.__voiceDebug.band() : -1');
const tp = (p: P, x: number, z: number, yaw = 0) => ev(p, 'teleport', x, z, yaw);
const look = (p: P, yaw: number, pitch = 0) => ev(p, 'look', yaw, pitch);
const yawTo = (x: number, z: number, tx: number, tz: number) => Math.atan2(tx - x, tz - z);
const alive = async (p: P, id: string) => { const s = await ev<any>(p, 'state'); return s.crew?.players?.find((q: any) => q.id === id)?.alive; };

/** poll a monster's state for ms, logging transitions */
async function watch(p: P, id: string, msec: number, label: string): Promise<string[]> {
  const seq: string[] = [];
  const t = Date.now();
  let last = '';
  while (Date.now() - t < msec) {
    const a = await agent(p, id).catch(() => null);
    if (a && a.state !== last) { last = a.state; seq.push(`${((Date.now() - t) / 1000).toFixed(1)}s:${a.state}@${a.x},${a.z}`); }
    await sleep(120);
  }
  log(`${label} ${id} states: ${seq.join(' -> ')}`);
  return seq;
}
const evSince = (p: P, t: number, re: RegExp) => p.ev.filter((e) => e.t >= t && re.test(e.e));
const brief = (e: Ev) => `${e.e}:${JSON.stringify(e.d).slice(0, 220)}`;

async function waitSmooth(p: P, msec = 40_000): Promise<number> {
  const t = Date.now();
  let worst = 999;
  while (Date.now() - t < msec) {
    worst = await evalJs<number>(p, 'return new Promise((res) => { const ts = []; const f = (t) => { ts.push(t); if (ts.length < 12) requestAnimationFrame(f); else { let m = 0; for (let i = 1; i < ts.length; i++) m = Math.max(m, ts[i] - ts[i - 1]); res(m); } }; requestAnimationFrame(f); })');
    if (worst < 60) break;
  }
  return worst;
}

// ---------------------------------------------------------------- run
const players: P[] = [];
const findings: string[] = [];
const note = (s: string) => { findings.push(s); log(`NOTE: ${s}`); };
try {
  const ann = await launch('Ann', 'shout.wav');
  const bob = await launch('Bob', 'whisper.wav');
  const cat = await launch('Cat', 'callsign_boiler.wav');
  players.push(ann, bob, cat);
  for (const p of players) {
    await waitForGame(p.page, 90_000);
    await p.page.waitForFunction(() => window.__game?.me(), undefined, { timeout: 30_000 });
    p.id = (await ev<string>(p, 'me'))!;
    log(`${p.name} joined as ${p.id} backend=${await ev(p, 'backend')}`);
  }
  for (const p of players) log(p.name + ' band without V', await band(p), 'meta ptt', await evalJs(p, 'return JSON.parse(localStorage.getItem("deadair.meta.settings")||"{}").ptt'));
  await sleep(1500);
  // click the canvas (pointer lock attempt) like a player
  for (const p of players) { await p.page.mouse.click(800, 450).catch(() => null); }
  await shot(ann, '00-hub-ann');
  // ---- contract via the board (leader picks the risk-1 order; everyone readies), drive skipped
  const meta = await dbg<any>(ann, 'meta.state');
  log('orders', meta.orders, 'shift', meta.shift);
  const order = meta.orders.find((o: any) => o.available && o.risk === 1) ?? meta.orders[0];
  log('pick', await req(ann, 'meta.pick', { orderId: order.id }).catch((e) => String(e)));
  for (const p of players) log(`${p.name} ready`, await req(p, 'meta.ready', { ready: true }).catch((e) => String(e)));
  await sleep(1500);
  await shot(ann, '01-drive-ann');
  log('skipDrive', await dbg(ann, 'meta.skipDrive'));
  for (const p of players) await p.page.waitForFunction(() => (window.__game?.state() as { phase?: string }).phase === 'contract', undefined, { timeout: 30_000 });
  log('contract phase on all; smooth worst-frame', await waitSmooth(ann));
  await shot(ann, '02-contract-spawn-ann');
  const L = await evalJs<any>(ann, 'return window.__monstersLayout()');
  log(`layout ${L.W}x${L.H} seed ${L.seed} spaces ${L.spaces.length} van ${JSON.stringify(L.van)}`);
  const callsigns = L.spaces.filter((s: any) => s.callsign).map((s: any) => `${s.id}:${s.callsign}:${s.kind}:${s.light}`);
  log('callsigns', callsigns.join(' '));
  let M = await ms(ann);
  log('monsters', M.agents.map((a: any) => `${a.id} ${a.state} ${a.x},${a.z} act=${a.active} dorm=${a.dormant ?? ''}`));
  // pick the biggest lit room/hall
  const rooms = L.spaces.filter((s: any) => (s.kind === 'room' || s.kind === 'hall') && s.rect.w >= 7 && s.rect.h >= 5);
  rooms.sort((a: any, b: any) => (b.light === 'on' ? 1 : 0) - (a.light === 'on' ? 1 : 0) || b.rect.w * b.rect.h - a.rect.w * a.rect.h);
  const R = rooms[0];
  log('power zone', R.powerZone, await dbg(ann, 'interaction.power', { zone: R.powerZone, on: true }).then((x) => JSON.stringify(x).slice(0, 200)).catch((e) => String(e)));
  log('lights on', await dbg(ann, 'interaction.setLights', { space: R.id, on: true }).then((x) => JSON.stringify(x).slice(0, 200)).catch((e) => String(e)));
  await sleep(500);
  const lit = await dbg(ann, 'interaction.litAt', { x: R.rect.x + R.rect.w / 2, z: R.rect.y + R.rect.h / 2 }).catch(() => null);
  log(`test room ${R.id} ${R.callsign} ${R.kind} light=${R.light} rect ${JSON.stringify(R.rect)} litAt=${JSON.stringify(lit)}`);
  const r = R.rect;
  const horiz = r.w >= r.h;
  // three spots along the long axis
  const at = (f: number, g = 0.5): [number, number] => (horiz ? [r.x + r.w * f, r.y + r.h * g] : [r.x + r.w * g, r.y + r.h * f]);

  // =================================================================== HOUND
  if (PHASES.has('hound')) {
    log('================ HOUND');
    const hc = at(0.5);
    // Ann at one end, Bob near the hound, Cat at the far end
    const [ax, az] = at(0.05), [cx, cz] = at(0.95, 0.3);
    await tp(ann, ax, az, yawTo(ax, az, hc[0], hc[1]));
    await tp(cat, cx, cz, yawTo(cx, cz, hc[0], hc[1]));
    const bx = hc[0] + (horiz ? -2.4 : 0.3), bz = hc[1] + (horiz ? 0.3 : -2.4);
    await tp(bob, bx, bz, yawTo(bx, bz, hc[0], hc[1]));
    await sleep(800);
    log('place hound', await dbg(ann, 'monsters.place', { id: 'hound0', x: hc[0], z: hc[1], yaw: 0, state: 'idle', active: true }));
    await sleep(1500);
    await shot(bob, '10-hound-close-lit-bob');
    await look(ann, yawTo(ax, az, hc[0], hc[1]), -0.05);
    await shot(ann, '10-hound-far-lit-ann');
    // H1: Bob crouches and whispers 2.4 m from it (push-to-talk held)
    let t = Date.now();
    await bob.page.keyboard.down('KeyC');
    await sleep(400);
    await bob.page.keyboard.down('KeyV');
    const bands: number[] = [];
    for (let i = 0; i < 12; i++) { await sleep(250); bands.push(await band(bob)); }
    await bob.page.keyboard.up('KeyV');
    // crouch-walk a little toward it
    await hold(bob, 'KeyW', 700);
    await bob.page.keyboard.up('KeyC');
    log(`H1 bob whisper bands: ${bands.join(',')}`);
    const h1 = await agent(ann, 'hound0');
    const growl1 = evSince(bob, t, /monsters\.cue/).map(brief);
    log(`H1 after whisper+crouch: hound ${h1.state} cues: ${growl1.join(' ; ')}`);
    if (h1.state === 'alert' || h1.state === 'investigate' || h1.state === 'windup' || h1.state === 'charge') note(`HOUND reacted to whisper/crouch (state ${h1.state})`);
    // H2: Cat walks toward the hound (walk noise 5 m)
    await dbg(ann, 'monsters.place', { id: 'hound0', x: hc[0], z: hc[1], state: 'idle', active: true });
    await tp(bob, at(0.3, 0.85)[0], at(0.3, 0.85)[1], 0); // Bob steps away, quietly
    await sleep(600);
    t = Date.now();
    await look(cat, yawTo(cx, cz, hc[0], hc[1]), 0);
    const wp = watch(ann, 'hound0', 5000, 'H2 cat walks toward it');
    await hold(cat, 'KeyW', 1800);
    await wp;
    log('H2 cues', evSince(cat, t, /monsters\.cue/).map(brief).join(' ; '));
    await shot(cat, '11-hound-alert-on-walk-cat');
    // stand still: does it lose interest after ~10 s?
    await watch(ann, 'hound0', 13000, 'H2b everyone freezes (quiet)');
    // H3: bottle lure — Bob gets bottles, throws one away from everyone
    log('give bottle', await dbg(bob, 'interaction.give', { type: 'bottle', count: 3 }));
    await sleep(400);
    const inv = await evalJs<any>(bob, 'return window.__ix ? window.__ix.inventory() : null');
    log('bob inventory', inv);
    const slot = Array.isArray(inv) ? inv.findIndex((x: string | null) => x === 'bottle') : 0;
    await bob.page.keyboard.press(`Digit${slot + 1}`);
    await sleep(300);
    const [bx2, bz2] = at(0.3, 0.85);
    await look(bob, yawTo(bx2, bz2, at(0.9, 0.9)[0], at(0.9, 0.9)[1]), 0.25);
    t = Date.now();
    const wb = watch(ann, 'hound0', 7000, 'H3 bottle thrown');
    await bob.page.mouse.down();
    await sleep(120);
    await bob.page.mouse.up();
    await sleep(900);
    await shot(ann, '12-hound-bottle-ann');
    await wb;
    log('H3 events', evSince(bob, t, /monsters\.cue|interaction\.(fx|thrown|noise)/).map(brief).join(' ; '));
  }

  // =================================================================== DEATH + SPECTATE + REVIVE
  if (PHASES.has('death')) {
    log('================ DEATH');
    const hc = at(0.55);
    const [ax, az] = at(0.12);
    await tp(ann, ax, az, yawTo(ax, az, hc[0], hc[1]));
    await tp(bob, at(0.3, 0.15)[0], at(0.3, 0.15)[1], 0);
    await tp(cat, at(0.3, 0.85)[0], at(0.3, 0.85)[1], 0);
    await sleep(500);
    await dbg(ann, 'monsters.place', { id: 'hound0', x: hc[0], z: hc[1], state: 'idle', active: true });
    await sleep(1200);
    await look(ann, yawTo(ax, az, hc[0], hc[1]), -0.05);
    // Ann shouts (PTT) once
    let t = Date.now();
    await ann.page.keyboard.down('KeyV');
    const sb: number[] = [];
    for (let i = 0; i < 5; i++) { await sleep(200); sb.push(await band(ann)); }
    await ann.page.keyboard.up('KeyV');
    log(`D1 ann shout bands ${sb.join(',')}`);
    await sleep(500);
    const a1 = await agent(ann, 'hound0');
    log(`D1 after 1st shout: hound ${a1.state} tdoor=${a1.tdoor} lastNoise=${a1.lastNoiseKind}/${a1.lastNoiseDist}`);
    await shot(ann, '20-hound-alert-after-shout-ann');
    await sleep(1200);
    await shot(ann, '21-hound-investigating-ann');
    // second shout -> charge
    const t2 = Date.now();
    await ann.page.keyboard.down('KeyV');
    await sleep(300);
    await shot(ann, '22-hound-second-shout-ann');
    await sleep(500);
    await ann.page.keyboard.up('KeyV');
    const wc = await watch(ann, 'hound0', 3500, 'D2 after 2nd shout');
    const dead = !(await alive(bob, ann.id));
    log(`D2 ann dead=${dead}; kill events: ${evSince(ann, t2, /monsters\.kill|interaction\.death/).map(brief).join(' ; ')}`);
    await shot(ann, '23-death-card-ann');
    log('D2 ann HUD:', await hud(ann));
    await shot(bob, '23b-bob-sees-death');
    if (!dead) note(`hound did not kill Ann after 2 shouts (${wc.join(' ')})`);
    // retreat check over 22 s while spectating
    const tDeath = Date.now();
    await sleep(2500);
    await shot(ann, '24-death-card-late-ann');
    await sleep(2500);
    await shot(ann, '25-spectate-follow-ann');
    log('S1 ann HUD:', await hud(ann), 'spec:', await evalJs(ann, 'return window.__players ? window.__players.spectating() : null'));
    // click to cycle
    await ann.page.mouse.down(); await sleep(80); await ann.page.mouse.up();
    await sleep(1500);
    await shot(ann, '26-spectate-cycled-ann');
    log('S2 after click spec:', await evalJs(ann, 'return window.__players ? window.__players.spectating() : null'));
    // dead voice: Ann shouts while dead; Bob (alive, ~5 m) must not hear
    await ann.page.keyboard.down('KeyV');
    await sleep(1200);
    const bobPeers = await evalJs<any>(bob, 'return window.__voiceDebug ? window.__voiceDebug.peers() : null');
    const catPeers = await evalJs<any>(cat, 'return window.__voiceDebug ? window.__voiceDebug.peers() : null');
    await ann.page.keyboard.up('KeyV');
    log('S3 dead Ann shouting: bob hears', bobPeers?.[ann.id], 'cat hears', catPeers?.[ann.id]);
    if ((bobPeers?.[ann.id]?.gain ?? 0) > 0.05) note(`living Bob hears dead Ann (gain ${bobPeers[ann.id].gain})`);
    // monsters retreat?
    const m1 = await ms(ann);
    log('R0 monsters after death', m1.agents.map((a: any) => `${a.id} ${a.state} act=${a.active} ${a.x},${a.z}`));
    // revive: Bob gets a medkit and walks to the body
    log('give medkit', await dbg(bob, 'interaction.give', { type: 'medkit' }));
    const ist = await dbg<any>(ann, 'interaction.state');
    const body = (ist.deaths ?? []).find((d: any) => d.pid === ann.id);
    log('death record', body);
    const bp = body?.p ?? [ax, 0, az];
    const sx = bp[0] + (horiz ? 1.1 : 0), sz = bp[2] + (horiz ? 0 : 1.1);
    await tp(bob, sx, sz, yawTo(sx, sz, bp[0], bp[2]));
    await sleep(400);
    await look(bob, yawTo(sx, sz, bp[0], bp[2]), -0.6);
    await sleep(500);
    log('R1 bob target', await evalJs(bob, 'return window.__ix ? window.__ix.target() : null'), 'HUD', await hud(bob));
    await shot(bob, '27-bob-at-body-prompt');
    await bob.page.keyboard.press('KeyE');
    await sleep(1200);
    const revived = await alive(bob, ann.id);
    log(`R1 revive by medkit at +${((Date.now() - tDeath) / 1000).toFixed(1)} s: alive=${revived}`, evSince(bob, tDeath, /interaction\.(revive|fx|msg)|players/).map(brief).join(' ; '));
    if (!revived) note('medkit revive via E at the body failed');
    await sleep(800);
    await shot(ann, '28-ann-after-revive');
    log('R1 ann HUD', await hud(ann));
    // monsters after the death: back off ~20 s?
    await watch(ann, 'hound0', Math.max(0, 21000 - (Date.now() - tDeath)), 'R2 hound during post-death window');
    const m2 = await ms(ann);
    log('R2 monsters ~21 s after death', m2.agents.map((a: any) => `${a.id} ${a.state} act=${a.active} ${a.x},${a.z}`));
    // ---- badge to the van: kill Cat (dbg), wait out the medkit window, Bob carries the badge into the van
    t = Date.now();
    log('kill cat (dbg)', await dbg(cat, 'interaction.kill', { killer: 'HOUND', reason: 'heard your SPRINT', detail: '9 m' }));
    await sleep(1500);
    await shot(cat, '29-cat-death-card-dbg');
    await sleep(30500);
    log('B0 cat HUD after 32 s', await hud(cat));
    await shot(cat, '30-cat-spectate-after-window');
    const ist2 = await dbg<any>(ann, 'interaction.state');
    const badge = Object.values(ist2.items as Record<string, any>).find((it) => it.type === 'badge' && it.owner === cat.id);
    log('cat badge', badge);
    if (badge?.p) {
      const [gx, , gz] = badge.p;
      await tp(bob, gx + 0.9, gz, yawTo(gx + 0.9, gz, gx, gz));
      await sleep(400);
      await look(bob, yawTo(gx + 0.9, gz, gx, gz), -0.7);
      await sleep(400);
      log('B1 bob target', await evalJs(bob, 'return window.__ix ? window.__ix.target() : null'));
      await shot(bob, '31-bob-at-badge');
      await bob.page.keyboard.press('KeyE');
      await sleep(700);
      log('B1 bob inventory', await evalJs(bob, 'return window.__ix ? window.__ix.inventory() : null'), 'HUD', await hud(bob));
      // walk into the van: teleport to the van door outside, then walk in
      const van = L.van;
      log('van', van);
      const cab = van.cab ?? van;
      await tp(bob, (cab.x ?? van.x) + (cab.w ? cab.w / 2 : 0), (cab.y ?? van.z) + (cab.h ? cab.h / 2 : 0), 0);
      await sleep(1500);
      log('B2 bob in van: HUD', await hud(bob), 'target', await evalJs(bob, 'return window.__ix ? window.__ix.target() : null'));
      await shot(bob, '32-bob-in-van');
      await bob.page.keyboard.press('KeyE');
      await sleep(1500);
      log('B3 cat HUD', await hud(cat), 'events', evSince(cat, t, /interaction\.(revive|respawn|deposit|fx)/).map(brief).join(' ; '));
      await shot(cat, '33-cat-badge-filed');
      await sleep(21000);
      log(`B4 cat alive after 21 s: ${await alive(bob, cat.id)} HUD: ${await hud(cat)}`);
      await shot(cat, '34-cat-respawned');
    }
  }

  // =================================================================== LISTENER
  if (PHASES.has('listener')) {
    log('================ LISTENER');
    M = await ms(ann);
    const Lm = M.agents.find((a: any) => a.kind === 'listener');
    log('listener before', Lm && { state: Lm.state, dormant: Lm.dormant, wakeAt: Lm.wakeAt, memory: Lm.memory });
    // Cat says the BOILER line near... put Cat and Ann in the test room, Cat holds V (talk band)
    const [cx, cz] = at(0.5, 0.5);
    await tp(cat, cx, cz, 0);
    await tp(ann, at(0.2)[0], at(0.2)[1], 0);
    await tp(bob, at(0.8)[0], at(0.8)[1], 0);
    await dbg(ann, 'monsters.place', { id: 'hound0', x: 0.5, z: 0.5, state: 'out', active: false, outSec: 999 });
    // put the (dormant) listener within talk range of Cat
    await dbg(ann, 'monsters.place', { id: 'listener0', x: at(0.5, 0.9)[0], z: at(0.5, 0.9)[1] });
    let t = Date.now();
    await cat.page.keyboard.down('KeyV');
    const cb: number[] = [];
    for (let i = 0; i < 14; i++) { await sleep(250); cb.push(await band(cat)); }
    await cat.page.keyboard.up('KeyV');
    log(`L1 cat callsign bands ${cb.join(',')}`);
    await sleep(4000);
    const utt = await dbg<any>(ann, 'ai.utterances').catch((e) => String(e));
    log('L1 utterances', JSON.stringify(utt).slice(0, 800));
    M = await ms(ann);
    const L1 = M.agents.find((a: any) => a.kind === 'listener');
    log('L1 listener memory', L1?.memory, 'log', M.log?.slice(-5));
    // wake it (shortcut instead of waiting 3 min)
    t = Date.now();
    log('wake', await dbg(ann, 'monsters.wake'));
    await sleep(300);
    await shot(ann, '40-listener-wake-flicker-ann');
    await sleep(1500);
    M = await ms(ann);
    const L2 = M.agents.find((a: any) => a.kind === 'listener');
    log('L2 listener after wake', { state: L2.state, intent: L2.intent, targetSpace: L2.targetSpace, x: L2.x, z: L2.z }, 'log', M.log?.slice(-4));
    log('L2 events', evSince(ann, t, /monsters\.(wake|telegraph|led|lure|cue|intercept)/).map(brief).join(' ; '));
    const consoleTxt = await evalJs(ann, `return [...document.querySelectorAll('*')].filter(e => /INTERCEPT/.test(e.textContent||'') && e.children.length===0).map(e=>e.textContent).slice(0,5)`);
    log('L2 INTERCEPT text on Ann page', consoleTxt);
    // grab: Bob alone far from the others, listener right next to him
    const [gx, gz] = at(0.92, 0.5);
    await tp(bob, gx, gz, 0);
    await tp(ann, at(0.6)[0], at(0.6)[1], yawTo(at(0.6)[0], at(0.6)[1], gx, gz));
    await tp(cat, at(0.05)[0], at(0.05)[1], 0);
    await sleep(600);
    t = Date.now();
    log('place listener next to Bob', await dbg(ann, 'monsters.place', { id: 'listener0', x: gx + (horiz ? -0.8 : 0), z: gz + (horiz ? 0 : -0.8), state: 'patrol', active: true }));
    await sleep(700);
    const grabEv = evSince(bob, t, /monsters\.grab/).map(brief);
    log('G1 grab events', grabEv.join(' ; '));
    await shot(bob, '41-listener-grab-victim-bob');
    log('G1 bob HUD', await hud(bob));
    await look(ann, yawTo(at(0.6)[0], at(0.6)[1], gx, gz), 0);
    await shot(ann, '42-listener-grab-teammate-ann');
    // Ann runs over (sprint W) and presses E
    await ann.page.keyboard.down('ShiftLeft');
    await ann.page.keyboard.down('KeyW');
    let freed = false;
    for (let i = 0; i < 16 && !freed; i++) {
      await sleep(100);
      if (i > 4) await ann.page.keyboard.press('KeyE');
      freed = evSince(bob, t, /monsters\.grab/).some((e) => e.d.state === 'freed' || e.d.state === 'killed');
    }
    await ann.page.keyboard.up('KeyW');
    await ann.page.keyboard.up('ShiftLeft');
    log('G2 ann HUD', await hud(ann));
    await sleep(600);
    log('G2 grab outcome', evSince(bob, t, /monsters\.(grab|kill)/).map(brief).join(' ; '), `bob alive=${await alive(ann, bob.id)}`);
    await shot(ann, '43-listener-after-shove-ann');
    // second grab: nobody helps -> 3 s -> death card text
    await sleep(800);
    const [g2x, g2z] = at(0.05, 0.5);
    await tp(cat, g2x, g2z, 0);
    await tp(ann, at(0.9)[0], at(0.9)[1], 0);
    await tp(bob, at(0.9, 0.2)[0], at(0.9, 0.2)[1], 0);
    await sleep(600);
    t = Date.now();
    await dbg(ann, 'monsters.place', { id: 'listener0', x: g2x + (horiz ? 0.8 : 0), z: g2z + (horiz ? 0 : 0.8), state: 'patrol', active: true });
    await sleep(4200);
    log('G3 cat grab->kill', evSince(cat, t, /monsters\.(grab|kill)|interaction\.death/).map(brief).join(' ; '), `cat alive=${await alive(ann, cat.id)}`);
    await shot(cat, '44-listener-kill-card-cat');
    log('G3 cat HUD', await hud(cat));
    await watch(ann, 'listener0', 6000, 'G4 listener after kill');
    // listener screenshots dark vs lit
    const [lx, lz] = at(0.5);
    await tp(ann, at(0.15)[0], at(0.15)[1], yawTo(at(0.15)[0], at(0.15)[1], lx, lz));
    await dbg(ann, 'monsters.freeze', { on: true });
    await dbg(ann, 'monsters.place', { id: 'listener0', x: lx, z: lz, yaw: yawTo(lx, lz, at(0.15)[0], at(0.15)[1]), state: 'ambush', active: true });
    await look(ann, yawTo(at(0.15)[0], at(0.15)[1], lx, lz), 0.05);
    await sleep(1500);
    await shot(ann, '45-listener-lit-ann');
    await dbg(ann, 'interaction.setLights', { space: R.id, on: false });
    await sleep(1000);
    await shot(ann, '46-listener-dark-noflash-ann');
    await ann.page.keyboard.press('KeyF');
    await sleep(800);
    await shot(ann, '47-listener-dark-flashlight-ann');
    await ann.page.keyboard.press('KeyF');
    await dbg(ann, 'interaction.setLights', { space: R.id, on: true });
    await dbg(ann, 'monsters.freeze', { on: false });
  }

  // =================================================================== MANNEQUIN
  if (PHASES.has('mannequin')) {
    log('================ MANNEQUIN');
    for (const p of players) if (!(await alive(ann, p.id))) await dbg(ann, 'interaction.revive', { pid: p.id });
    log('restart monsters at risk 2', JSON.stringify(await dbg(ann, 'monsters.start', { risk: 2 })).slice(0, 400));
    await sleep(800);
    await dbg(ann, 'monsters.place', { id: 'hound0', x: 0.5, z: 0.5, state: 'out', active: false, outSec: 999 });
    await dbg(ann, 'monsters.place', { id: 'listener0', x: 0.5, z: 0.5, state: 'out', active: false, outSec: 999 });
    const [mx, mz] = at(0.85);
    const [ax, az] = at(0.1, 0.3), [bx, bz] = at(0.1, 0.7), [cx, cz] = at(0.15, 0.5);
    await tp(ann, ax, az, yawTo(ax, az, mx, mz));
    await tp(bob, bx, bz, yawTo(bx, bz, mx, mz));
    await tp(cat, cx, cz, yawTo(cx, cz, mx, mz) + Math.PI);
    await look(ann, yawTo(ax, az, mx, mz), 0);
    await look(bob, yawTo(bx, bz, mx, mz), 0);
    await look(cat, yawTo(cx, cz, mx, mz) + Math.PI, 0);
    await sleep(600);
    log('spawn mannequin', await dbg(ann, 'monsters.spawnMannequin', { x: mx, z: mz, blinkIn: 6 }));
    await sleep(1500);
    await shot(ann, '50-mannequin-watched-lit-ann');
    // both watching: should stay frozen through Ann's blink (Bob still watching)
    let w = await watch(ann, 'mannequin0', 9000, 'M1 two watchers (blinks scheduled at ~6 s)');
    let m = await agent(ann, 'mannequin0');
    log('M1 mannequin', { state: m.state, x: m.x, z: m.z, observed: m.observed, lit: m.lit });
    const blinkEv = evSince(ann, Date.now() - 12000, /monsters\.blink/).map(brief);
    log('M1 blink events (ann)', blinkEv.join(' ; '));
    // force a blink on Ann and catch the overlay
    await dbg(ann, 'monsters.blink', { id: ann.id, inSec: 0.6 });
    await sleep(650);
    await shot(ann, '51-visor-blink-ann');
    await sleep(500);
    // Ann looks away, Bob keeps watching
    await look(ann, yawTo(ax, az, mx, mz) + Math.PI, 0);
    w = await watch(ann, 'mannequin0', 3000, 'M2 only Bob watching');
    // both look away
    const t = Date.now();
    await look(bob, yawTo(bx, bz, mx, mz) + Math.PI, 0);
    w = await watch(ann, 'mannequin0', 4000, 'M3 nobody watching');
    m = await agent(ann, 'mannequin0');
    log('M3 mannequin', { state: m.state, x: m.x, z: m.z }, 'kills', evSince(ann, t, /monsters\.kill|interaction\.death/).map(brief).join(' ; '));
    await look(ann, yawTo(ax, az, m.x, m.z), 0);
    await sleep(300);
    await shot(ann, '52-mannequin-after-lookaway-ann');
    // dark: lights off, mannequin far, flashlight on/off
    for (const p of players) if (!(await alive(ann, p.id))) await dbg(ann, 'interaction.revive', { pid: p.id });
    await sleep(800);
    await tp(ann, ax, az, yawTo(ax, az, mx, mz));
    await tp(bob, bx, bz, yawTo(bx, bz, mx, mz));
    await look(ann, yawTo(ax, az, mx, mz), 0);
    await look(bob, yawTo(bx, bz, mx, mz), 0);
    await dbg(ann, 'monsters.spawnMannequin', { x: mx, z: mz, blinkIn: 30 });
    await dbg(ann, 'interaction.setLights', { space: R.id, on: false });
    await sleep(1200);
    m = await agent(ann, 'mannequin0');
    log('M4 dark room, watched, no flashlight', { state: m.state, x: m.x, z: m.z, lit: m.lit });
    await shot(ann, '53-mannequin-dark-noflash-ann');
    await ann.page.keyboard.press('KeyF');
    await sleep(900);
    m = await agent(ann, 'mannequin0');
    log('M5 dark room + Ann flashlight', { state: m.state, x: m.x, z: m.z, lit: m.lit });
    await shot(ann, '54-mannequin-dark-flashlight-ann');
    await ann.page.keyboard.press('KeyF');
    await dbg(ann, 'interaction.setLights', { space: R.id, on: true });
  }
} catch (e) {
  log(`RUN ERROR ${e instanceof Error ? e.stack : e}`);
} finally {
  for (const p of players) {
    try {
      const errs = await ev<string[]>(p, 'errors');
      log(`${p.name} client errors (${errs.length + p.errors.length}):`, [...p.errors, ...errs].slice(0, 15));
      log(`${p.name} perf`, await ev(p, 'perf'));
    } catch { /* ignore */ }
  }
  log('NOTES', findings);
  for (const p of players) await p.close().catch(() => null);
  setTimeout(() => process.exit(0), 300).unref();
}
